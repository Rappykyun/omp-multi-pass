import {
  createAssistantMessageEventStream,
  isUsageLimitOutcome,
} from "@oh-my-pi/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { untilAborted } from "@oh-my-pi/pi-utils";

export type NativeStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;
export interface PoolStreamDependencies {
  stream: NativeStream;
  select(
    model: Model<Api>,
    attempted: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<Model<Api> | undefined>;
  resolveOptions(
    model: Model<Api>,
    options?: SimpleStreamOptions,
  ): Promise<SimpleStreamOptions | undefined>;
  markExhausted(provider: string, errorMessage: string): void;
}

export function createPoolStream(deps: PoolStreamDependencies): NativeStream {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      const attempted = new Set<string>();
      let partial: AssistantMessage | undefined;
      try {
        while (true) {
          options?.signal?.throwIfAborted();
          const selected = await untilAborted(options?.signal, () =>
            deps.select(model, attempted, options?.signal),
          );
          options?.signal?.throwIfAborted();
          if (!selected)
            throw new Error(
              "No permitted Codex account is available for " + model.id,
            );
          if (selected.id !== model.id)
            throw new Error("Pool selection changed the requested model");
          if (attempted.has(selected.provider))
            throw new Error(
              "Pool selector returned an account already attempted in this request",
            );
          attempted.add(selected.provider);
          const controller = new AbortController();
          const signal = options?.signal
            ? AbortSignal.any([options.signal, controller.signal])
            : controller.signal;
          const resolved = await untilAborted(signal, () =>
            deps.resolveOptions(selected, { ...options, signal }),
          );
          signal.throwIfAborted();
          const inner = deps.stream(selected, context, {
            ...resolved,
            signal,
            codexSseMaxAttempts: 1,
          });
          output.forwardLocalWorkFrom(inner);
          const buffered: AssistantMessageEvent[] = [];
          let visible = false;
          let retry = false;
          try {
            for await (const event of inner) {
              if ("partial" in event) partial = event.partial;
              if (event.type === "error") {
                const quota =
                  !signal.aborted &&
                  isUsageLimitOutcome(
                    event.error.errorStatus,
                    event.error.errorMessage,
                  );
                if (quota)
                  deps.markExhausted(
                    selected.provider,
                    event.error.errorMessage ?? "Quota exhausted",
                  );
                if (quota && !visible) {
                  controller.abort();
                  retry = true;
                  partial = undefined;
                  break;
                }
                for (const pending of buffered) output.push(pending);
                output.push(event);
                return;
              }
              if (event.type === "done") {
                for (const pending of buffered) output.push(pending);
                output.push(event);
                return;
              }
              // Empty text/thinking block starts are safe to buffer. Tool-call metadata is output.
              if (
                event.type.startsWith("toolcall_") ||
                (event.type !== "start" && !event.type.endsWith("_start"))
              )
                visible = true;
              if (!visible) {
                buffered.push(event);
                continue;
              }
              for (const pending of buffered) output.push(pending);
              buffered.length = 0;
              output.push(event);
            }
          } finally {
            controller.abort();
          }
          if (!retry)
            throw new Error("Codex stream ended without a terminal result");
        }
      } catch (error) {
        const aborted = options?.signal?.aborted === true;
        const result: AssistantMessage = {
          ...(partial ?? {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: Date.now(),
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
          }),
          stopReason: aborted ? "aborted" : "error",
          errorMessage: aborted
            ? "Codex request cancelled"
            : error instanceof Error
              ? error.message
              : "Codex account selection failed",
        };
        output.push({
          type: "error",
          reason: result.stopReason as "error" | "aborted",
          error: result,
        });
      }
    })();
    return output;
  };
}
