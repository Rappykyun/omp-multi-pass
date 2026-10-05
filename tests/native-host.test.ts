import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  loadExtensions,
} from "@oh-my-pi/pi-coding-agent";

import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { events, token } from "./codex-fixture";
import { getCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import { fetchQuota } from "../extensions/multi-sub";
import {
  handleSubsAdd,
  handleSubsRemove,
  loadGlobalConfig,
  loadProjectConfig,
} from "../extensions/multi-sub";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
const originalAgentDir = getAgentDir();
const roots: string[] = [];
const stores: AuthStorage[] = [];
afterEach(() => {
  setAgentDir(originalAgentDir);
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function host() {
  const root = mkdtempSync(join(tmpdir(), "omp-mp-native-"));
  roots.push(root);
  setAgentDir(root);
  writeFileSync(
    join(root, "multi-pass.json"),
    JSON.stringify({
      subscriptions: [
        { provider: "openai-codex", index: 2, label: "test" },
        { provider: "openai-codex", index: 3 },
      ],
      pools: [
        {
          name: "test",
          baseProvider: "openai-codex",
          members: ["openai-codex-2", "openai-codex-3"],
          enabled: true,
        },
      ],
    }),
  );
  const auth = await AuthStorage.create(join(root, "agent.db"), {
    usageProviderResolver: () => undefined,
  });
  stores.push(auth);
  await auth.credentials.set("openai-codex-2", {
    type: "oauth",
    access: token("first"),
    refresh: "test-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "first",
    orgId: "test-org",
    orgName: "test-workspace",
  });
  await auth.credentials.set("openai-codex-3", {
    type: "oauth",
    access: token("second"),
    refresh: "test-refresh-2",
    expires: Date.now() + 3_600_000,
    accountId: "second",
  });
  const registry = new ModelRegistry(auth, join(root, "models.yml"));
  const loaded = await loadExtensions(
    [resolve("extensions/multi-sub.ts")],
    root,
  );
  // A load failure must be a behavior assertion, not an uncaught import error.
  expect(loaded.errors).toEqual([]);
  for (const { name, config, sourceId } of loaded.runtime
    .pendingProviderRegistrations)
    registry.registerProvider(name, config, sourceId);
  return { root, auth, registry, loaded };
}

test("native registration makes the authenticated Codex subscription selectable with image input", async () => {
  const { registry } = await host();
  const models = registry
    .getAvailable()
    .filter((model) => model.provider === "openai-codex-2");
  expect(models.some((model) => model.input.includes("image"))).toBe(true);
});

test("cancelled native re-login preserves the existing credential", async () => {
  const { auth } = await host();
  const before = auth.credentials.get("openai-codex-2");
  const controller = new AbortController();
  controller.abort();
  await expect(
    auth.oauth.login("openai-codex-2", {
      signal: controller.signal,
      onAuth() {
        throw new Error("aborted login displayed authorization");
      },
      onPrompt: async () => {
        throw new Error("aborted login prompted");
      },
      fetch: async () => {
        throw new DOMException("Aborted", "AbortError");
      },
    }),
  ).rejects.toThrow();
  expect(auth.credentials.get("openai-codex-2")).toEqual(before);
});

test("cancelled initial login stores no credential", async () => {
  const { auth } = await host();
  await auth.credentials.remove("openai-codex-2");
  const controller = new AbortController();
  controller.abort();
  await expect(
    auth.oauth.login("openai-codex-2", {
      signal: controller.signal,
      onAuth() {
        throw new Error("aborted login displayed authorization");
      },
      onPrompt: async () => {
        throw new Error("aborted login prompted");
      },
      fetch: async () => {
        throw new DOMException("Aborted", "AbortError");
      },
    }),
  ).rejects.toThrow();
  expect(auth.credentials.get("openai-codex-2")).toBeUndefined();
});
test("an empty project allow-list prevents native transport dispatch", async () => {
  const { root, registry, loaded } = await host();
  mkdirSync(join(root, ".omp"));
  writeFileSync(join(root, ".omp", "multi-pass.json"), '{"allowedSubs":[]}');
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      requests++;
      return Response.json(
        {
          error: {
            code: "usage_limit_reached",
            message: "Usage limit reached",
          },
        },
        { status: 429 },
      );
    },
  });
  try {
    for (const handler of loaded.extensions[0].handlers.get("session_start") ??
      [])
      await handler({}, { cwd: root, modelRegistry: registry });
    const registration = loaded.runtime.pendingProviderRegistrations.find(
      (entry) => entry.name === "openai-codex-2",
    )!;
    const model = registry.getProviderModels("openai-codex-2")[0];
    const jwt =
      "header." +
      Buffer.from(
        JSON.stringify({
          "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
        }),
      ).toString("base64url") +
      ".signature";
    const stream = registration.config.streamSimple!(
      { ...model, baseUrl: server.url.toString(), preferWebsockets: false },
      { messages: [{ role: "user", content: "test", timestamp: 1 }] },
      { apiKey: jwt, codexSseMaxAttempts: 1 },
    );
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(requests).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("native refresh abort stops the token exchange", async () => {
  const { auth, loaded } = await host();
  const registration = loaded.runtime.pendingProviderRegistrations.find(
    (entry) => entry.name === "openai-codex-2",
  )!;
  const credential = auth.credentials.get("openai-codex-2")!;
  if (credential.type !== "oauth") throw new Error("Fixture must use OAuth");
  const started = Promise.withResolvers<void>();
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      started.resolve();
      await Bun.sleep(2000);
      return Response.json({
        access_token: token("first"),
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      });
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) =>
    originalFetch(server.url, init)) as typeof fetch;
  try {
    const controller = new AbortController();
    const refresh = registration.config.oauth!.refreshToken as (
      credentials: typeof credential,
      signal?: AbortSignal,
    ) => Promise<unknown>;
    const result = refresh(credential, controller.signal).then(
      () => "completed",
      () => "aborted",
    );
    await started.promise;
    controller.abort();
    expect(
      await Promise.race([result, Bun.sleep(100).then(() => "pending")]),
    ).toBe("aborted");
  } finally {
    globalThis.fetch = originalFetch;
    server.stop(true);
  }
});

test("pool fallback snapshots project restrictions until the request ends", async () => {
  const { root, registry, loaded } = await host();
  mkdirSync(join(root, ".omp"));
  const path = join(root, ".omp", "multi-pass.json");
  writeFileSync(path, '{"allowedSubs":["openai-codex-2","openai-codex-3"]}');
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const account = request.headers.get("chatgpt-account-id")!;
      requests.push(account);
      if (account === "first") {
        writeFileSync(path, '{"allowedSubs":["openai-codex-2"]}');
        return Response.json(
          {
            error: {
              code: "usage_limit_reached",
              message: "Usage limit reached",
            },
          },
          { status: 429 },
        );
      }
      return new Response(events("success"), {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  try {
    for (const handler of loaded.extensions[0].handlers.get("session_start") ??
      [])
      await handler({}, { cwd: root, modelRegistry: registry });
    const registration = loaded.runtime.pendingProviderRegistrations.find(
      (entry) => entry.name === "openai-codex-2",
    )!;
    const model = {
      ...registry.getProviderModels("openai-codex-2")[0],
      baseUrl: server.url.toString(),
      preferWebsockets: false,
    };
    const result = await registration.config.streamSimple!(model, {
      messages: [{ role: "user", content: "test", timestamp: 1 }],
    }).result();
    expect(result.stopReason).toBe("stop");
    expect(requests).toEqual(["first", "second"]);
    const next = await registration.config.streamSimple!(model, {
      messages: [{ role: "user", content: "next", timestamp: 2 }],
    }).result();
    expect(next.stopReason).toBe("error");
    expect(requests).toEqual(["first", "second"]);
  } finally {
    server.stop(true);
  }
});

test("two session factories retain separate project restrictions", async () => {
  const first = await host();
  mkdirSync(join(first.root, ".omp"));
  writeFileSync(
    join(first.root, ".omp", "multi-pass.json"),
    '{"allowedSubs":["openai-codex-2"]}',
  );
  for (const handler of first.loaded.extensions[0].handlers.get(
    "session_start",
  ) ?? [])
    await handler({}, { cwd: first.root, modelRegistry: first.registry });
  const second = await host();
  mkdirSync(join(second.root, ".omp"));
  writeFileSync(
    join(second.root, ".omp", "multi-pass.json"),
    '{"allowedSubs":["openai-codex-3"]}',
  );
  for (const handler of second.loaded.extensions[0].handlers.get(
    "session_start",
  ) ?? [])
    await handler({}, { cwd: second.root, modelRegistry: second.registry });
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      requests.push(request.headers.get("chatgpt-account-id")!);
      return new Response(events("success"), {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  try {
    const firstModel = {
      ...first.registry.getProviderModels("openai-codex-2")[0],
      baseUrl: server.url.toString(),
      preferWebsockets: false,
    };
    const secondModel = {
      ...second.registry.getProviderModels("openai-codex-3")[0],
      baseUrl: server.url.toString(),
      preferWebsockets: false,
    };
    const one = await getCustomApi(firstModel.api)!
      .streamSimple(firstModel, {
        messages: [{ role: "user", content: "one", timestamp: 1 }],
      })
      .result();
    const two = await getCustomApi(secondModel.api)!
      .streamSimple(secondModel, {
        messages: [{ role: "user", content: "two", timestamp: 2 }],
      })
      .result();
    expect(one.stopReason).toBe("stop");
    expect(two.stopReason).toBe("stop");
    expect(requests).toEqual(["first", "second"]);
  } finally {
    server.stop(true);
  }
});

test("native quota data stays unknown when the provider omits a percentage", async () => {
  const { auth } = await host();
  let payload: unknown = {
    rate_limit: {
      primary_window: {
        used_percent: 25,
        limit_window_seconds: 18000,
        reset_after_seconds: 3600,
      },
    },
  };
  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      request.url.includes("wham/usage")
        ? Response.json(payload)
        : Response.json({ programs: [] }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    return originalFetch(new URL(url.pathname, server.url), init);
  }) as typeof fetch;
  try {
    const known = await fetchQuota(auth, "openai-codex-2");
    expect(known.remaining).toBe(75);
    expect(known.resetAt! > Date.now()).toBe(true);
    payload = {
      rate_limit: {
        primary_window: {
          limit_window_seconds: 18000,
          reset_after_seconds: 3600,
        },
      },
    };
    const unknown = await fetchQuota(auth, "openai-codex-2");
    expect(unknown.remaining).toBeUndefined();
    expect(unknown.error).toBeDefined();
  } finally {
    globalThis.fetch = originalFetch;
    server.stop(true);
  }
});

test("live subscription catalogs include newly discovered base models with image support", async () => {
  const { root, registry, loaded } = await host();
  registry.registerProvider("openai-codex", {
    baseUrl: "https://chatgpt.com/backend-api",
    api: "openai-codex-responses",
    apiKey: token("base"),
    models: [
      {
        id: "codex-live-fixture",
        name: "Live fixture",
        input: ["text", "image"],
        reasoning: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16000,
      },
    ],
  });
  for (const handler of loaded.extensions[0].handlers.get("session_start") ??
    [])
    await handler({}, { cwd: root, modelRegistry: registry });
  const registration = loaded.runtime.pendingProviderRegistrations.find(
    (entry) => entry.name === "openai-codex-2",
  )!;
  const live = await registration.config.fetchDynamicModels!(undefined);
  const model = live.find((model) => model.id === "codex-live-fixture");
  expect(model?.input).toEqual(["text", "image"]);
  expect(model?.contextWindow).toBe(128000);
  expect(model?.maxTokens).toBe(16000);
});

test("custom failover context names the most recently exhausted account", async () => {
  const { root, auth, registry, loaded } = await host();
  writeFileSync(
    join(root, "selector.mjs"),
    'export default ctx => { if (ctx.members.length === 1 && ctx.currentProvider !== "openai-codex-3") throw new Error("Wrong last failed provider"); return ctx.members[0]; };',
  );
  writeFileSync(
    join(root, "multi-pass.json"),
    JSON.stringify({
      subscriptions: [2, 3, 4].map((index) => ({
        provider: "openai-codex",
        index,
      })),
      pools: [
        {
          name: "test",
          baseProvider: "openai-codex",
          members: ["openai-codex-2", "openai-codex-3", "openai-codex-4"],
          enabled: true,
          strategy: "custom",
          selectorScript: "selector.mjs",
        },
      ],
    }),
  );
  await auth.credentials.set("openai-codex-4", {
    type: "oauth",
    access: token("third"),
    refresh: "synthetic-refresh-3",
    expires: Date.now() + 3_600_000,
    accountId: "third",
  });
  for (const handler of loaded.extensions[0].handlers.get("session_start") ??
    [])
    await handler({}, { cwd: root, modelRegistry: registry });
  for (const { name, config, sourceId } of loaded.runtime
    .pendingProviderRegistrations)
    registry.registerProvider(name, config, sourceId);
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const account = request.headers.get("chatgpt-account-id")!;
      requests.push(account);
      return account === "third"
        ? new Response(events("success"), {
            headers: { "Content-Type": "text/event-stream" },
          })
        : Response.json(
            {
              error: {
                code: "usage_limit_reached",
                message: "Usage limit reached",
              },
            },
            { status: 429 },
          );
    },
  });
  try {
    const model = {
      ...registry.getProviderModels("openai-codex-2")[0],
      baseUrl: server.url.toString(),
      preferWebsockets: false,
    };
    const result = await getCustomApi(model.api)!
      .streamSimple(model, {
        messages: [{ role: "user", content: "test", timestamp: 1 }],
      })
      .result();
    expect(result.stopReason).toBe("stop");
    expect(requests).toEqual(["first", "second", "third"]);
  } finally {
    server.stop(true);
  }
});
test("a checkout without node_modules loads through the installed omp native host", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-mp-standalone-"));
  roots.push(root);
  const extension = join(root, "extensions");
  cpSync(resolve("extensions"), extension, { recursive: true });
  const agent = join(root, "agent");
  mkdirSync(agent);
  writeFileSync(
    join(agent, "config.yml"),
    "setupVersion: 2\nmemory:\n  backend: off\ncheckpoint:\n  enabled: false\nautolearn:\n  enabled: false\n",
  );
  writeFileSync(
    join(agent, "models.yml"),
    JSON.stringify({
      providers: {
        "local-check": {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          auth: "none",
          models: [
            {
              id: "local",
              name: "Local check",
              reasoning: false,
              input: ["text"],
              contextWindow: 8192,
              maxTokens: 256,
            },
          ],
        },
      },
    }),
  );
  const executable = process.env.OMP_TEST_EXECUTABLE ?? Bun.which("omp");
  if (!executable)
    throw new Error(
      "Install omp 18.6.1 or set OMP_TEST_EXECUTABLE for the native host check",
    );
  const child = Bun.spawn(
    [
      executable,
      "--mode",
      "rpc",
      "--no-ui",
      "--no-extensions",
      "-e",
      join(extension, "multi-sub.ts"),
      "--model",
      "local-check/local",
      "--no-skills",
      "--no-rules",
      "--no-tools",
      "--no-lsp",
      "--no-title",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PI_PROFILE: "",
        OMP_PROFILE: "",
        PI_CODING_AGENT_DIR: agent,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write('{"id":"startup","type":"get_state"}\n');
  child.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const frames = stdout
    .trim()
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const commands =
    frames.find((frame) => frame.type === "available_commands_update")
      ?.commands ?? [];
  expect(commands.map((command: { name: string }) => command.name)).toContain(
    "subs",
  );
  expect(commands.map((command: { name: string }) => command.name)).toContain(
    "pool",
  );
  expect(exit).toBe(0);
}, 15000);

test("fallback never adopts credentials introduced after request submission", async () => {
  const { root, auth, registry, loaded } = await host();
  for (const handler of loaded.extensions[0].handlers.get("session_start") ??
    [])
    await handler({}, { cwd: root, modelRegistry: registry });
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const account = request.headers.get("chatgpt-account-id")!;
      requests.push(account);
      if (account === "first") {
        await auth.credentials.set("openai-codex-3", {
          type: "oauth",
          access: token("replacement"),
          refresh: "replacement",
          expires: Date.now() + 3600000,
          accountId: "replacement",
        });
        return Response.json(
          {
            error: {
              code: "usage_limit_reached",
              message: "Usage limit reached",
            },
          },
          { status: 429 },
        );
      }
      return new Response(events("success"), {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  try {
    const model = {
      ...registry.getProviderModels("openai-codex-2")[0],
      baseUrl: server.url.toString(),
      preferWebsockets: false,
    };
    const result = await getCustomApi(model.api)!
      .streamSimple(model, {
        messages: [{ role: "user", content: "private request", timestamp: 1 }],
      })
      .result();
    expect(result.stopReason).toBe("error");
    expect(requests).toEqual(["first"]);
  } finally {
    server.stop(true);
  }
});

test("a post-output quota error cools the account for the next request without replay", async () => {
  const { root, registry, loaded } = await host();
  for (const handler of loaded.extensions[0].handlers.get("session_start") ??
    [])
    await handler({}, { cwd: root, modelRegistry: registry });
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const account = request.headers.get("chatgpt-account-id")!;
      requests.push(account);
      return new Response(
        events(account === "first" ? "text-error" : "success"),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  try {
    const model = {
      ...registry.getProviderModels("openai-codex-2")[0],
      baseUrl: server.url.toString(),
      preferWebsockets: false,
    };
    const api = getCustomApi(model.api)!;
    const first = await api
      .streamSimple(model, {
        messages: [{ role: "user", content: "first", timestamp: 1 }],
      })
      .result();
    expect(first.stopReason).toBe("error");
    expect(requests).toEqual(["first"]);
    const next = await api
      .streamSimple(model, {
        messages: [{ role: "user", content: "next", timestamp: 2 }],
      })
      .result();
    expect(next.stopReason).toBe("stop");
    expect(requests).toEqual(["first", "second"]);
  } finally {
    server.stop(true);
  }
});

test("remove and re-add cannot inherit a deleted subscription's project permission", async () => {
  const { root, registry, loaded } = await host();
  mkdirSync(join(root, ".omp"));
  const project = join(root, ".omp", "multi-pass.json");
  writeFileSync(
    project,
    JSON.stringify({
      allowedSubs: ["openai-codex-3"],
      pools: [
        {
          name: "work",
          baseProvider: "openai-codex",
          members: ["openai-codex-3"],
          enabled: true,
        },
      ],
    }),
  );
  const ui = {
    select: async () => "openai-codex-3",
    confirm: async () => true,
    notify() {},
    input: async () => "replacement",
  };
  const ctx = {
    cwd: root,
    modelRegistry: registry,
    ui,
  } as unknown as ExtensionCommandContext;
  const api = {
    unregisterProvider: (name: string) => registry.unregisterProvider(name),
  } as ExtensionAPI;
  await handleSubsRemove(api, ctx);
  expect(loadProjectConfig(root)?.allowedSubs).toEqual([]);
  expect(
    loadProjectConfig(root)?.pools?.flatMap((pool) => pool.members),
  ).toEqual([]);
  await handleSubsAdd(api, ctx, () => {});
  expect(loadGlobalConfig().subscriptions.map((entry) => entry.index)).toEqual([
    2, 4,
  ]);
});
