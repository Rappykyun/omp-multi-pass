import { afterEach, expect, test } from "bun:test";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import {
  streamSimple,
  type Api,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type AssistantMessageEventStream,
} from "@oh-my-pi/pi-ai";
import { createPoolStream } from "../extensions/pool-stream";
import type { PoolStreamDependencies } from "../extensions/pool-stream";
import { events, token } from "./codex-fixture";

const servers: Bun.Server<undefined>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});
const context: Context = {
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "test" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
      timestamp: 1,
    },
  ],
};
async function fixture(
  mode:
    "quota" | "400" | "text-error" | "tool-error" | "thinking-error" = "quota",
) {
  const requests: string[] = [];
  const bodies: unknown[] = [];
  const exhausted: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const account = request.headers.get("chatgpt-account-id") ?? "missing";
      requests.push(account);
      bodies.push(await request.json());
      if (account === "first" && mode === "quota")
        return Response.json(
          {
            error: {
              code: "usage_limit_reached",
              message: "Usage limit reached",
              resets_at: 2_000_000_000,
            },
          },
          { status: 429 },
        );
      if (account === "first" && mode === "400")
        return Response.json(
          { error: { code: "invalid_request", message: "Invalid input" } },
          { status: 400 },
        );
      return new Response(
        events(
          account === "first" && mode.endsWith("error")
            ? (mode as "text-error" | "tool-error" | "thinking-error")
            : "success",
        ),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  servers.push(server);
  const base = getBundledModels("openai-codex")[0];
  const models = ["first", "second"].map((account) => ({
    ...base,
    provider: "openai-codex-" + (account === "first" ? "2" : "3"),
    baseUrl: server.url.toString().replace(/\/$/, ""),
    preferWebsockets: false,
  }));
  const deps: PoolStreamDependencies = {
    stream: (model, ctx, options) =>
      streamSimple({ ...model, provider: "openai-codex" }, ctx, options),
    select: async (_model, attempted, signal) => {
      signal?.throwIfAborted();
      return models.find((model) => !attempted.has(model.provider));
    },
    resolveOptions: async (model, options) => ({
      ...options,
      apiKey: token(model.provider === "openai-codex-2" ? "first" : "second"),
      codexSseMaxAttempts: 1,
    }),
    markExhausted: (provider) => {
      exhausted.push(provider);
    },
  };
  const run = createPoolStream(deps);
  const options = {
    apiKey: token("first"),
    codexSseMaxAttempts: 1,
    providerRetryWait: async () => {},
  };
  return {
    run,
    model: models[0],
    models,
    deps,
    requests,
    bodies,
    exhausted,
    options,
  };
}
async function consume(stream: AssistantMessageEventStream) {
  const emitted = [];
  for await (const event of stream) emitted.push(event);
  return { emitted, result: await stream.result() };
}

test("pre-output quota failure returns one successful reply from the next account", async () => {
  const f = await fixture();
  const { emitted, result } = await consume(f.run(f.model, context, f.options));
  expect(result.stopReason).toBe("stop");
  expect(
    result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join(""),
  ).toBe("OK");
  expect(f.requests).toEqual(["first", "second"]);
  expect(f.exhausted).toEqual(["openai-codex-2"]);
  expect(emitted.filter((event) => event.type === "start")).toHaveLength(1);
  expect(emitted.filter((event) => event.type === "done")).toHaveLength(1);
  const first = f.bodies[0] as { input: unknown; model: string };
  const second = f.bodies[1] as { input: unknown; model: string };
  expect(first.input).toEqual(second.input);
  expect(first.model).toBe(f.model.id);
  expect(second.model).toBe(f.model.id);
});
for (const mode of ["text-error", "thinking-error", "tool-error"] as const)
  test(
    "quota failure after " + mode + " never starts another account",
    async () => {
      const f = await fixture(mode);
      const { result } = await consume(f.run(f.model, context, f.options));
      expect(result.stopReason).toBe("error");
      expect(
        result.content.some(
          (item) =>
            item.type ===
            (mode === "tool-error"
              ? "toolCall"
              : mode === "thinking-error"
                ? "thinking"
                : "text"),
        ),
      ).toBe(true);
      expect(f.requests).toEqual(["first"]);
    },
  );
test("unrelated provider error is not an account quota failure", async () => {
  const f = await fixture("400");
  const { result } = await consume(f.run(f.model, context, f.options));
  expect(result.stopReason).toBe("error");
  expect(f.requests).toEqual(["first"]);
  expect(f.exhausted).toEqual([]);
});
test("repeated selector result terminates rather than retrying an account twice", async () => {
  const f = await fixture();
  f.deps.select = async () => f.model;
  const run = createPoolStream(f.deps);
  const { result } = await consume(run(f.model, context, f.options));
  expect(result.stopReason).toBe("error");
  expect(f.requests).toEqual(["first"]);
});
test("cancellation during credential resolution sends no request", async () => {
  const f = await fixture();
  const controller = new AbortController();
  f.deps.resolveOptions = async () => {
    controller.abort();
    return f.options;
  };
  const run = createPoolStream(f.deps);
  const { result } = await consume(
    run(f.model, context, { ...f.options, signal: controller.signal }),
  );
  expect(result.stopReason).toBe("aborted");
  expect(f.requests).toEqual([]);
});
test("no eligible account returns a terminal error without a transport request", async () => {
  const f = await fixture();
  f.deps.select = async () => undefined;
  const run = createPoolStream(f.deps);
  const { result } = await consume(run(f.model, context, f.options));
  expect(result.stopReason).toBe("error");
  expect(f.requests).toEqual([]);
});
test("cancellation interrupts an asynchronous selector without sending a request", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  f.deps.select = async () => {
    started.resolve();
    return await new Promise<undefined>(() => {});
  };
  const stream = createPoolStream(f.deps)(f.model, context, {
    ...f.options,
    signal: controller.signal,
  });
  await started.promise;
  controller.abort();
  const result = await stream.result();
  expect(result.stopReason).toBe("aborted");
  expect(f.requests).toEqual([]);
});

test("cancellation after a text delta preserves partial content and does not select another account", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const prefix =
    events("text-error").split("\n\n").slice(0, -2).join("\n\n") + "\n\n";
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      f.requests.push(request.headers.get("chatgpt-account-id")!);
      return new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode(prefix));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  servers.push(server);
  const slow = { ...f.model, baseUrl: server.url.toString() };
  f.deps.select = async (_model, attempted) =>
    attempted.size ? f.models[1] : slow;
  const stream = createPoolStream(f.deps)(slow, context, {
    ...f.options,
    signal: controller.signal,
  });
  for await (const event of stream)
    if (event.type === "text_delta") controller.abort();
  const result = await stream.result();
  expect(result.stopReason).toBe("aborted");
  expect(
    result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join(""),
  ).toBe("partial");
  expect(f.requests).toEqual(["first"]);
});
