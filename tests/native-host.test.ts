import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
