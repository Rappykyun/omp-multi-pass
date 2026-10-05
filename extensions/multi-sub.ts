/** Codex-only omp fork of hjanuschka/pi-multi-pass (MIT). */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ProviderModelConfig,
} from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import {
  getProviderDefinition,
  streamSimple,
  type Api,
  type Model,
} from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import * as z from "@oh-my-pi/omptype/zod";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { openaiCodexUsageProvider, type AuthStorage } from "@oh-my-pi/pi-ai";
import { createPoolStream } from "./pool-stream";
import type { NativeStream } from "./pool-stream";
import { extractRetryHint } from "@oh-my-pi/pi-utils";

export const BASE = "openai-codex";
export const MANAGED_API = "omp-multi-pass-codex";
export interface SubEntry {
  provider: string;
  index: number;
  label?: string;
}
export type PoolStrategy =
  "round-robin" | "quota-first" | "scheduled" | "custom";
export interface ScheduleWindow {
  hours?: [number, number];
  days?: string[];
  dateRange?: { from?: string; to?: string };
}
export interface MemberSchedule {
  windows?: ScheduleWindow[];
  role?: "preferred" | "overflow";
}
export interface PoolConfig {
  name: string;
  baseProvider: string;
  members: string[];
  enabled: boolean;
  strategy?: PoolStrategy;
  memberSchedule?: Record<string, MemberSchedule>;
  selectorScript?: string;
}
export interface MultiPassConfig {
  subscriptions: SubEntry[];
  pools: PoolConfig[];
}
export interface ProjectConfig {
  pools?: PoolConfig[];
  allowedSubs?: string[];
}
export interface EffectiveConfig extends MultiPassConfig {
  allowedProviderNames?: string[];
}
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const providerNameSchema = z
  .string()
  .regex(/^openai-codex(?:-(?:[2-9]|[1-9][0-9]+))?$/);
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value,
    "Invalid calendar date",
  );
const windowSchema = z
  .object({
    hours: z
      .array(z.number().int().min(0).max(24))
      .min(2)
      .max(2)
      .refine((hours) => hours[0] < 24)
      .optional(),
    days: z.array(z.enum(DAYS)).optional(),
    dateRange: z
      .object({ from: dateSchema.optional(), to: dateSchema.optional() })
      .strict()
      .refine((range) => !range.from || !range.to || range.from <= range.to)
      .optional(),
  })
  .strict();
const poolSchema = z
  .object({
    name: z.string().trim().min(1),
    baseProvider: z.literal(BASE),
    members: z.array(providerNameSchema),
    enabled: z.boolean(),
    strategy: z
      .enum(["round-robin", "quota-first", "scheduled", "custom"])
      .optional(),
    memberSchedule: z
      .record(
        z.string(),
        z
          .object({
            windows: z.array(windowSchema).optional(),
            role: z.enum(["preferred", "overflow"]).optional(),
          })
          .strict(),
      )
      .optional(),
    selectorScript: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine(
    (pool) => pool.strategy !== "custom" || !!pool.selectorScript,
    "Custom strategy requires a selector script",
  );
const globalSchema = z
  .object({
    subscriptions: z
      .array(
        z
          .object({
            provider: z.literal(BASE),
            index: z.number().int().min(2),
            label: z.string().optional(),
          })
          .strict(),
      )
      .default(() => []),
    pools: z.array(poolSchema).default(() => []),
  })
  .strict()
  .refine(
    (config) =>
      new Set(config.subscriptions.map((entry) => entry.index)).size ===
      config.subscriptions.length,
    "Duplicate subscription ID",
  )
  .refine(
    (config) =>
      new Set(config.pools.map((pool) => pool.name)).size ===
      config.pools.length,
    "Duplicate pool name",
  );
const projectSchema = z
  .object({
    allowedSubs: z
      .array(
        z
          .string()
          .refine(
            (value) =>
              !value.trim() ||
              providerNameSchema.safeParse(value.trim()).success,
          ),
      )
      .optional(),
    pools: z.array(poolSchema).optional(),
  })
  .strict();

export function subProviderName(entry: SubEntry): string {
  return `${entry.provider}-${entry.index}`;
}
export function globalConfigPath(): string {
  return join(getAgentDir(), "multi-pass.json");
}
export function projectConfigPath(cwd: string): string {
  return join(cwd, ".omp", "multi-pass.json");
}
export function loadGlobalConfig(): MultiPassConfig {
  if (!existsSync(globalConfigPath())) return { subscriptions: [], pools: [] };
  return globalSchema.parse(
    JSON.parse(readFileSync(globalConfigPath(), "utf8")),
  ) as MultiPassConfig;
}
export function loadProjectConfig(cwd: string): ProjectConfig | undefined {
  const path = projectConfigPath(cwd);
  return existsSync(path)
    ? (projectSchema.parse(
        JSON.parse(readFileSync(path, "utf8")),
      ) as ProjectConfig)
    : undefined;
}
export function normalizeAllowedProviderNames(
  allowedSubs: string[] | undefined,
): string[] | undefined {
  if (allowedSubs === undefined) return undefined;
  return [...new Set(allowedSubs.map((value) => value.trim()).filter(Boolean))];
}
export function filterPoolsByAllowedProviders(
  pools: PoolConfig[],
  allowed: string[] | undefined,
): PoolConfig[] {
  if (allowed === undefined) return pools;
  return pools
    .map((pool) => ({
      ...pool,
      members: pool.members.filter((member) => allowed.includes(member)),
    }))
    .filter((pool) => pool.members.length > 0);
}
export function loadEffectiveConfig(cwd: string): EffectiveConfig {
  const config = loadGlobalConfig();
  const project = loadProjectConfig(cwd);
  const allowed = normalizeAllowedProviderNames(project?.allowedSubs);
  return {
    subscriptions: allowed
      ? config.subscriptions.filter((entry) =>
          allowed.includes(subProviderName(entry)),
        )
      : config.subscriptions,
    pools: filterPoolsByAllowedProviders(
      project?.pools ?? config.pools,
      allowed,
    ),
    allowedProviderNames: allowed,
  };
}
export function saveJsonConfig(path: string, config: unknown): void {
  const schema = path === globalConfigPath() ? globalSchema : projectSchema;
  const validated = schema.parse(config);
  if (existsSync(path)) schema.parse(JSON.parse(readFileSync(path, "utf8")));
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    writeFileSync(temp, JSON.stringify(validated, null, 2), "utf8");
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function cloneModels(
  models: readonly Model<Api>[],
  api = MANAGED_API,
): ProviderModelConfig[] {
  return models
    .filter((model) => modelKind(model) === "chat")
    .map((model) => {
      if (model.contextWindow === null || model.maxTokens === null)
        throw new Error(`Missing token limits for ${model.id}`);
      return {
        id: model.id,
        name: model.name,
        api,
        input: [...model.input],
        reasoning: model.reasoning,
        thinking: model.thinking,
        cost: {
          input: model.cost.input ?? 0,
          output: model.cost.output ?? 0,
          cacheRead: model.cost.cacheRead ?? 0,
          cacheWrite: model.cost.cacheWrite ?? 0,
        },
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        preferWebsockets: model.preferWebsockets,
        compat: model.compat,
      };
    });
}

export function registerSub(
  pi: ExtensionAPI,
  entry: SubEntry,
  models: () => readonly Model<Api>[],
  api: string,
  stream: NativeStream,
): void {
  const def = getProviderDefinition(BASE);
  if (!def?.login || !def.refreshToken)
    throw new Error("omp does not expose the required native Codex OAuth API");
  pi.registerProvider(subProviderName(entry), {
    api,
    baseUrl: models()[0]?.baseUrl,
    models: cloneModels(models(), api),
    fetchDynamicModels: async () => cloneModels(models(), api),
    oauth: {
      name: entry.label
        ? `Codex #${entry.index} (${entry.label})`
        : `Codex #${entry.index}`,
      login: (callbacks) => {
        callbacks.signal?.throwIfAborted();
        return def.login!(callbacks);
      },
      refreshToken: (credentials, signal?: AbortSignal) =>
        def.refreshToken!(credentials, signal),
      getApiKey: (credentials) => credentials.access,
    },
    streamSimple: stream,
  });
}

function scopedProviders(ctx: ExtensionContext): string[] {
  const config = loadEffectiveConfig(ctx.cwd);
  const names = [BASE, ...config.subscriptions.map(subProviderName)];
  return names.filter(
    (name) =>
      config.allowedProviderNames === undefined ||
      config.allowedProviderNames.includes(name),
  );
}
async function pickSubscription(
  ctx: ExtensionCommandContext,
): Promise<SubEntry | undefined> {
  const entries = loadEffectiveConfig(ctx.cwd).subscriptions;
  const selected = await ctx.ui.select(
    "Codex subscription",
    entries.map(
      (entry) =>
        `${subProviderName(entry)}${entry.label ? ` (${entry.label})` : ""}`,
    ),
  );
  return entries.find(
    (entry) =>
      selected?.startsWith(subProviderName(entry) + " (") ||
      selected === subProviderName(entry),
  );
}
export async function handleSubsAdd(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  register: (entry: SubEntry) => void,
): Promise<void> {
  const label = await ctx.ui.input("Codex subscription label (optional)");
  if (label === undefined) return;
  const config = loadGlobalConfig();
  const index =
    Math.max(1, ...config.subscriptions.map((entry) => entry.index)) + 1;
  const entry = {
    provider: BASE,
    index,
    ...(label.trim() ? { label: label.trim() } : {}),
  };
  config.subscriptions.push(entry);
  saveJsonConfig(globalConfigPath(), config);
  register(entry);
  ctx.ui.notify(
    `Added ${subProviderName(entry)}. Run /login and select Codex #${index}.`,
    "info",
  );
}
export async function handleSubsRemove(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const entry = await pickSubscription(ctx);
  if (!entry) return;
  const name = subProviderName(entry);
  if (
    !(await ctx.ui.confirm(
      `Remove ${name}?`,
      "This removes the subscription, its login, and its global pool membership.",
    ))
  )
    return;
  const config = loadGlobalConfig();
  config.subscriptions = config.subscriptions.filter(
    (candidate) => subProviderName(candidate) !== name,
  );
  config.pools = config.pools.map((pool) => ({
    ...pool,
    members: pool.members.filter((member) => member !== name),
  }));
  saveJsonConfig(globalConfigPath(), config);
  await ctx.modelRegistry.authStorage.credentials.remove(name);
  pi.unregisterProvider(name);
  ctx.ui.notify(`Removed ${name}.`, "info");
}
export async function handleSubsLogin(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const entry = await pickSubscription(ctx);
  if (!entry) return;
  // Native /login owns browser authorization, cancellation, and credential persistence.
  ctx.ui.notify(
    `Run /login and select Codex #${entry.index}${entry.label ? ` (${entry.label})` : ""}. The saved login stays unchanged until login succeeds.`,
    "info",
  );
}
export async function handleSubsLogout(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const entry = await pickSubscription(ctx);
  if (!entry) return;
  const name = subProviderName(entry);
  if (
    await ctx.ui.confirm(
      `Log out ${name}?`,
      "The saved credential will be removed.",
    )
  ) {
    await ctx.modelRegistry.authStorage.credentials.remove(name);
    ctx.ui.notify(`Logged out ${name}.`, "info");
  }
}
export async function handleSubsSwitch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const permitted = new Set(scopedProviders(ctx));
  const models = ctx.models
    .list()
    .filter((model) => permitted.has(model.provider));
  const names = [...new Set(models.map((model) => model.provider))];
  const selected = await ctx.ui.select("Switch Codex account", names);
  if (!selected) return;
  const target =
    models.find(
      (model) => model.provider === selected && model.id === ctx.model?.id,
    ) ?? models.find((model) => model.provider === selected);
  if (!target || !(await pi.setModel(target)))
    throw new Error("No available model for the selected Codex account");
}
export async function handleSubsStatus(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const names = scopedProviders(ctx);
  ctx.ui.notify(
    names
      .map(
        (name) =>
          `${name}: ${ctx.modelRegistry.authStorage.credentials.hasOAuth(name) ? "logged in" : "not logged in"}`,
      )
      .join("\n") || "No Codex accounts are permitted in this project.",
    "info",
  );
}
export async function handleSubsList(
  ctx: ExtensionCommandContext,
): Promise<void> {
  await handleSubsStatus(ctx);
}

export interface QuotaSnapshot {
  remaining?: number;
  resetAt?: number;
  error?: string;
}
export async function fetchQuota(
  auth: AuthStorage,
  provider: string,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  signal?.throwIfAborted();
  const access = await auth.oauth.access(provider, undefined, { signal });
  signal?.throwIfAborted();
  if (!access) return { error: "No usable OAuth credential" };
  const report = await openaiCodexUsageProvider.fetchUsage(
    { provider: BASE, credential: { type: "oauth", ...access }, signal },
    { fetch },
  );
  signal?.throwIfAborted();
  if (!report)
    return { error: "Quota request failed or returned no usable report" };
  const limits = report.limits.filter(
    (limit) => limit.scope.tier === undefined || limit.scope.tier === "chat",
  );
  const known = limits
    .map((limit) => ({
      remaining:
        limit.amount.remainingFraction !== undefined
          ? limit.amount.remainingFraction * 100
          : limit.amount.usedFraction !== undefined
            ? (1 - limit.amount.usedFraction) * 100
            : undefined,
      resetAt: limit.window?.resetsAt,
    }))
    .filter(
      (limit) =>
        limit.remaining !== undefined &&
        Number.isFinite(limit.remaining) &&
        limit.remaining >= 0 &&
        limit.remaining <= 100,
    );
  if (!known.length) return { error: "Quota remaining is unknown" };
  const remaining = Math.min(...known.map((limit) => limit.remaining!));
  const resets = known
    .filter(
      (limit) => limit.remaining === remaining && limit.resetAt !== undefined,
    )
    .map((limit) => limit.resetAt!);
  return {
    remaining,
    ...(resets.length ? { resetAt: Math.max(...resets) } : {}),
  };
}

// Scheduling rules retain upstream local-day semantics, including wrapping hours.
export function getScheduledMemberOrder(
  pool: PoolConfig,
  available: string[],
  now: Date,
): string[] {
  const states = available.map((provider) => {
    const schedule = pool.memberSchedule?.[provider];
    const role = schedule?.role ?? "default";
    const windows = schedule?.windows ?? [];
    const active = windows.filter((window) => {
      if (window.days?.length && !window.days.includes(DAYS[now.getDay()]))
        return false;
      if (window.hours) {
        const [start, end] = window.hours;
        const hour = now.getHours();
        if (
          !(start <= end
            ? hour >= start && hour < end
            : hour >= start || hour < end)
        )
          return false;
      }
      const date =
        now.getFullYear() +
        "-" +
        String(now.getMonth() + 1).padStart(2, "0") +
        "-" +
        String(now.getDate()).padStart(2, "0");
      return (
        (!window.dateRange?.from || date >= window.dateRange.from) &&
        (!window.dateRange?.to || date <= window.dateRange.to)
      );
    });
    let remaining = Infinity;
    for (const window of active) {
      if (!window.hours) continue;
      const end = new Date(now);
      end.setHours(window.hours[1], 0, 0, 0);
      if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1);
      remaining = Math.min(remaining, end.getTime() - now.getTime());
    }
    return {
      provider,
      role,
      active: !windows.length || !!active.length,
      remaining,
    };
  });
  return [
    ...states
      .filter((state) => state.role === "preferred" && state.active)
      .sort((a, b) => a.remaining - b.remaining),
    ...states.filter((state) => state.role === "default"),
    ...states.filter((state) => state.role === "overflow"),
  ].map((state) => state.provider);
}

export class PoolManager {
  private readonly exhausted = new Map<string, number>();
  private traceEnabled = false;
  private trace: { timestamp: number; message: string }[] = [];
  markExhausted(provider: string, resetAt?: number, now = Date.now()): void {
    this.exhausted.set(
      provider,
      resetAt !== undefined && resetAt > now ? resetAt : now + 5 * 60_000,
    );
    this.recordTrace("cooldown " + provider);
  }
  isExhausted(provider: string, now = Date.now()): boolean {
    const until = this.exhausted.get(provider);
    return until !== undefined && until > now;
  }
  startTrace(): void {
    this.trace = [];
    this.traceEnabled = true;
  }
  stopTrace(): void {
    this.traceEnabled = false;
  }
  clearTrace(): void {
    this.trace = [];
  }
  getRoutingTrace(): { timestamp: number; message: string }[] {
    return this.trace.map((entry) => ({ ...entry }));
  }
  isTraceEnabled(): boolean {
    return this.traceEnabled;
  }
  recordTrace(message: string): void {
    if (!this.traceEnabled) return;
    this.trace.push({ timestamp: Date.now(), message });
    if (this.trace.length > 100) this.trace.shift();
  }
  async order(
    pool: PoolConfig,
    available: string[],
    current: string,
    modelId: string,
    options: {
      now?: Date;
      signal?: AbortSignal;
      prompt?: string;
      quota?: (provider: string) => Promise<QuotaSnapshot>;
    } = {},
  ): Promise<string[]> {
    options.signal?.throwIfAborted();
    const now = options.now ?? new Date();
    const index = pool.members.indexOf(current);
    const rotated =
      index < 0
        ? pool.members
        : [
            ...pool.members.slice(index + 1),
            ...pool.members.slice(0, index + 1),
          ];
    let ordered = [
      ...new Set(
        rotated.filter(
          (member) =>
            available.includes(member) &&
            !this.isExhausted(member, now.getTime()),
        ),
      ),
    ];
    if (pool.strategy === "scheduled")
      ordered = getScheduledMemberOrder(pool, ordered, now);
    if (pool.strategy === "quota-first" && options.quota) {
      const scored: { name: string; remaining?: number }[] = [];
      for (const name of ordered) {
        options.signal?.throwIfAborted();
        const quota = await options.quota(name);
        scored.push({ name, remaining: quota.remaining });
      }
      options.signal?.throwIfAborted();
      ordered = scored
        .sort((a, b) => (b.remaining ?? -1) - (a.remaining ?? -1))
        .map((entry) => entry.name);
    }
    if (pool.strategy === "custom") {
      if (!pool.selectorScript)
        throw new Error("Custom pool has no selector script");
      const path = isAbsolute(pool.selectorScript)
        ? pool.selectorScript
        : pool.selectorScript.startsWith("~/")
          ? join(homedir(), pool.selectorScript.slice(2))
          : join(getAgentDir(), pool.selectorScript);
      const module = await import(pathToFileURL(path).href);
      if (typeof module.default !== "function")
        throw new Error("Pool selector must export a default function");
      const selection: unknown = await module.default({
        members: [...ordered],
        currentProvider: current,
        modelId,
        pool: {
          name: pool.name,
          baseProvider: BASE,
          members: [...pool.members],
        },
        timestamp: now.getTime(),
        hour: now.getHours(),
        day: DAYS[now.getDay()],
        prompt: options.prompt,
      });
      options.signal?.throwIfAborted();
      const preferred = (
        Array.isArray(selection) ? selection : [selection]
      ).filter(
        (name): name is string =>
          typeof name === "string" && ordered.includes(name),
      );
      ordered = [...new Set([...preferred, ...ordered])];
    }
    this.recordTrace("selected " + (ordered[0] ?? "none") + " in " + pool.name);
    return ordered;
  }
}

async function handleSubsLimits(ctx: ExtensionCommandContext): Promise<void> {
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(15_000),
  ]);
  const stop =
    ctx.mode === "tui"
      ? ctx.ui.onTerminalInput((data) => {
          if (data === "\x1b") {
            controller.abort();
            return { consume: true };
          }
        })
      : undefined;
  ctx.ui.notify("Checking Codex quota. Press Escape to cancel.", "info");
  try {
    const rows: string[] = [];
    for (const provider of scopedProviders(ctx)) {
      const quota = await fetchQuota(
        ctx.modelRegistry.authStorage,
        provider,
        signal,
      );
      rows.push(
        provider +
          ": " +
          (quota.remaining === undefined
            ? quota.error
            : Math.round(quota.remaining) + "% remaining"),
      );
    }
    ctx.ui.notify(
      rows.join("\n") || "No Codex accounts are permitted.",
      "info",
    );
  } catch (error) {
    if (controller.signal.aborted)
      ctx.ui.notify("Quota check cancelled.", "info");
    else throw error;
  } finally {
    stop?.();
  }
}

async function handlePoolProject(ctx: ExtensionCommandContext): Promise<void> {
  const action = await ctx.ui.select("Project Codex settings", [
    "restrict",
    "pools",
    "info",
    "clear",
  ]);
  if (!action) return;
  const path = projectConfigPath(ctx.cwd);
  const project = loadProjectConfig(ctx.cwd) ?? {};
  if (action === "info") {
    ctx.ui.notify(
      JSON.stringify(loadEffectiveConfig(ctx.cwd), null, 2),
      "info",
    );
    return;
  }
  if (action === "clear") {
    if (
      existsSync(path) &&
      (await ctx.ui.confirm("Clear project settings?", path))
    )
      unlinkSync(path);
    return;
  }
  if (action === "restrict") {
    const names = [
      BASE,
      ...loadGlobalConfig().subscriptions.map(subProviderName),
    ];
    const input = await ctx.ui.input(
      "Allowed accounts: comma-separated; empty permits none; all removes the restriction",
      names.join(", "),
    );
    if (input === undefined) return;
    if (input.trim() === "all") delete project.allowedSubs;
    else {
      const allowed = input
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      if (allowed.some((name) => !names.includes(name)))
        throw new Error("Account is not a configured Codex subscription");
      project.allowedSubs = allowed;
    }
  } else {
    const global = loadGlobalConfig();
    const input = await ctx.ui.input(
      "Project pools: comma-separated names; empty disables all; all inherits global pools",
      global.pools.map((pool) => pool.name).join(", "),
    );
    if (input === undefined) return;
    if (input.trim() === "all") delete project.pools;
    else {
      const names = input
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      if (
        names.some((name) => !global.pools.some((pool) => pool.name === name))
      )
        throw new Error("Unknown pool name");
      project.pools = global.pools.filter((pool) => names.includes(pool.name));
    }
  }
  saveJsonConfig(path, project);
  ctx.ui.notify("Project Codex settings saved.", "info");
}

async function handlePoolCommand(
  args: string,
  ctx: ExtensionCommandContext,
  manager: PoolManager,
): Promise<void> {
  const [command, argument] = args.trim().split(/\s+/);
  const action =
    command ||
    (await ctx.ui.select("Codex pools", [
      "create",
      "list",
      "toggle",
      "remove",
      "status",
      "project",
      "trace",
    ]));
  if (!action) return;
  if (action === "project") return handlePoolProject(ctx);
  if (action === "trace") {
    const traceAction =
      argument ||
      (await ctx.ui.select("Routing trace", [
        "start",
        "show",
        "status",
        "stop",
        "clear",
      ]));
    switch (traceAction) {
      case undefined:
        return;
      case "start":
        manager.startTrace();
        break;
      case "stop":
        manager.stopTrace();
        break;
      case "clear":
        manager.clearTrace();
        break;
      case "show":
        ctx.ui.notify(
          manager
            .getRoutingTrace()
            .map(
              (entry) =>
                new Date(entry.timestamp).toISOString() + " " + entry.message,
            )
            .join("\n") || "No trace entries.",
          "info",
        );
        return;
      case "status":
        break;
      default:
        throw new Error("Use /pool trace start|show|status|stop|clear");
    }
    ctx.ui.notify(
      "Routing trace " + (manager.isTraceEnabled() ? "active" : "stopped"),
      "info",
    );
    return;
  }
  const global = loadGlobalConfig();
  const project = loadProjectConfig(ctx.cwd);
  const target = project?.pools !== undefined ? project : global;
  const pools = target.pools!;
  const path =
    target === project ? projectConfigPath(ctx.cwd) : globalConfigPath();
  if (action === "status" || action === "list") {
    const effective = loadEffectiveConfig(ctx.cwd);
    ctx.ui.notify(
      effective.pools
        .map(
          (pool) =>
            pool.name +
            ": " +
            (pool.enabled ? "enabled" : "disabled") +
            " | " +
            (pool.strategy ?? "round-robin") +
            " | " +
            pool.members
              .map(
                (member) =>
                  member +
                  (manager.isExhausted(member)
                    ? " (cooldown)"
                    : ctx.modelRegistry.authStorage.credentials.hasOAuth(member)
                      ? " (logged in)"
                      : " (not logged in)"),
              )
              .join(", "),
        )
        .join("\n") || "No Codex pools.",
      "info",
    );
    return;
  }
  if (action === "create") {
    const name = await ctx.ui.input("Codex pool name");
    if (name === undefined) return;
    if (!name.trim() || pools.some((pool) => pool.name === name.trim()))
      throw new Error("Pool name must be non-empty and unique");
    const permitted = scopedProviders(ctx);
    const input = await ctx.ui.input(
      "Pool accounts (comma-separated)",
      permitted.join(", "),
    );
    if (input === undefined) return;
    const members = [
      ...new Set(
        input
          .split(",")
          .map((member) => member.trim())
          .filter(Boolean),
      ),
    ];
    if (
      !members.length ||
      members.some((member) => !permitted.includes(member))
    )
      throw new Error("Choose one or more permitted Codex accounts");
    const strategy = await ctx.ui.select("Pool strategy", [
      "round-robin",
      "quota-first",
      "scheduled",
      "custom",
    ]);
    if (!strategy) return;
    const pool: PoolConfig = {
      name: name.trim(),
      baseProvider: BASE,
      members,
      enabled: true,
      strategy: strategy as PoolStrategy,
    };
    if (strategy === "scheduled") {
      const schedule = await ctx.ui.input(
        "Member schedule JSON",
        '{"openai-codex-2":{"role":"preferred","windows":[{"hours":[22,6],"days":["mon"]}]}}',
      );
      if (schedule === undefined) return;
      pool.memberSchedule = JSON.parse(schedule);
    }
    if (strategy === "custom") {
      const script = await ctx.ui.input(
        "Selector JS module path (relative to active agent directory)",
      );
      if (script === undefined) return;
      pool.selectorScript = script;
    }
    pools.push(pool);
    saveJsonConfig(path, target);
    ctx.ui.notify("Created pool " + pool.name, "info");
    return;
  }
  if (action !== "toggle" && action !== "remove")
    throw new Error("Use /pool create|list|toggle|remove|status|project|trace");
  const selected = await ctx.ui.select(
    "Codex pool",
    pools.map((pool) => pool.name),
  );
  if (!selected) return;
  const index = pools.findIndex((pool) => pool.name === selected);
  if (action === "toggle") pools[index].enabled = !pools[index].enabled;
  else {
    if (
      !(await ctx.ui.confirm(
        "Remove pool " + selected + "?",
        "Subscriptions and their credentials are kept.",
      ))
    )
      return;
    pools.splice(index, 1);
  }
  saveJsonConfig(path, target);
  ctx.ui.notify("Pool settings saved.", "info");
}

export default function multiSub(pi: ExtensionAPI): void {
  pi.setLabel("omp-multi-pass");
  const poolManager = new PoolManager();
  // The native API registry is process-global. Each factory needs its own request closure.
  const api = MANAGED_API + "-" + crypto.randomUUID();
  let scope: ExtensionContext | undefined;
  const currentModels = () =>
    scope?.modelRegistry.getProviderModels(BASE) ?? getBundledModels(BASE);
  const managedStream: NativeStream = (requested, context, options) => {
    if (!scope)
      throw new Error("omp-multi-pass session context is not initialized");
    const registry = scope.modelRegistry;
    const effective = loadEffectiveConfig(scope.cwd);
    const allowed = effective.allowedProviderNames;
    const pool = effective.pools.find(
      (candidate) =>
        candidate.enabled && candidate.members.includes(requested.provider),
    );
    const names = (pool ? pool.members : [requested.provider]).filter(
      (name) => allowed === undefined || allowed.includes(name),
    );
    const available = registry
      .getAvailableForProviders(new Set(names))
      .filter((model) => model.id === requested.id);
    const nativeModel =
      registry.find(BASE, requested.id) ??
      getBundledModels(BASE).find((model) => model.id === requested.id);
    if (!nativeModel)
      throw new Error("No native Codex model definition for " + requested.id);
    const quotaCache = new Map<string, QuotaSnapshot>();
    let previousProvider = requested.provider;
    const lastUser =
      pool?.strategy === "custom"
        ? context.messages.findLast((message) => message.role === "user")
        : undefined;
    const prompt =
      lastUser?.role === "user"
        ? typeof lastUser.content === "string"
          ? lastUser.content
          : lastUser.content
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join("\n")
        : undefined;
    const quota = async (provider: string, signal?: AbortSignal) => {
      const result = await fetchQuota(registry.authStorage, provider, signal);
      quotaCache.set(provider, result);
      return result;
    };
    return createPoolStream({
      select: async (_model, attempted, signal) => {
        signal?.throwIfAborted();
        const candidates = available.filter(
          (model) =>
            !attempted.has(model.provider) &&
            !poolManager.isExhausted(model.provider),
        );
        if (!attempted.size) {
          const active = candidates.find(
            (model) => model.provider === requested.provider,
          );
          if (active)
            return {
              ...active,
              baseUrl: requested.baseUrl,
              preferWebsockets: requested.preferWebsockets,
            };
        }
        if (!pool) return undefined;
        const order = await poolManager.order(
          pool,
          candidates.map((model) => model.provider),
          previousProvider,
          requested.id,
          { signal, prompt, quota: (provider) => quota(provider, signal) },
        );
        const selected = candidates.find(
          (model) => model.provider === order[0],
        );
        return (
          selected && {
            ...selected,
            baseUrl: requested.baseUrl,
            preferWebsockets: requested.preferWebsockets,
          }
        );
      },
      resolveOptions: async (selected, incoming) => {
        const access = await registry.authStorage.oauth.access(
          selected.provider,
          options?.sessionId,
          {
            signal: incoming?.signal,
            modelId: selected.id,
            baseUrl: selected.baseUrl,
          },
        );
        incoming?.signal?.throwIfAborted();
        if (!access)
          throw new Error(
            selected.provider + " has no usable OAuth login. Run /subs login.",
          );
        const headers = new Headers({
          ...selected.headers,
          ...incoming?.headers,
        });
        headers.set("Authorization", "Bearer " + access.accessToken);
        headers.delete("chatgpt-account-id");
        if (access.accountId)
          headers.set("chatgpt-account-id", access.accountId);
        return {
          ...incoming,
          apiKey: access.accessToken,
          headers: Object.fromEntries(headers),
          oauthIdentity: {
            orgId: access.orgId,
            region: access.region,
            inferenceRegion: access.inferenceRegion,
          },
        };
      },
      stream: (selected, ctx, incoming) => {
        const native = {
          ...nativeModel,
          api: "openai-codex-responses" as const,
          provider: BASE,
          baseUrl: selected.baseUrl,
          preferWebsockets: selected.preferWebsockets,
          compat: undefined,
          compatConfig:
            nativeModel.compatConfig as Model<"openai-codex-responses">["compatConfig"],
        };
        const policy = resolveModelPolicy({
          ...native,
          compat: native.compatConfig,
        });
        return streamSimple(
          {
            ...native,
            compat: policy.compat,
            thinking: policy.thinking,
            identity: policy.identity,
          },
          ctx,
          incoming,
        );
      },
      markExhausted: (provider, message) => {
        previousProvider = provider;
        const delay = extractRetryHint(undefined, message);
        poolManager.markExhausted(
          provider,
          delay === undefined
            ? quotaCache.get(provider)?.resetAt
            : Date.now() + delay,
        );
      },
    })(requested, context, options);
  };
  const register = (entry: SubEntry) =>
    registerSub(pi, entry, currentModels, api, managedStream);
  pi.registerProvider("omp-multi-pass", { api, streamSimple: managedStream });
  for (const entry of loadGlobalConfig().subscriptions) register(entry);
  const routeSelectedModel = async (ctx: ExtensionContext) => {
    scope = ctx;
    if (
      ctx.model &&
      providerNameSchema.safeParse(ctx.model.provider).success &&
      ctx.model.api !== api
    )
      await pi.setModel({ ...ctx.model, api });
  };
  pi.on("session_start", async (_event, ctx) => {
    scope = ctx;
    for (const entry of loadGlobalConfig().subscriptions) register(entry);
    await routeSelectedModel(ctx);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    await routeSelectedModel(ctx);
  });
  pi.on("input", async (event, ctx) => {
    scope = ctx;
    if (
      event.text.trimStart().startsWith("/") ||
      !ctx.model ||
      !providerNameSchema.safeParse(ctx.model.provider).success
    )
      return {};
    const allowed = loadEffectiveConfig(ctx.cwd).allowedProviderNames;
    if (allowed !== undefined && !allowed.includes(ctx.model.provider)) {
      const target = ctx.models
        .list()
        .find(
          (model) =>
            model.id === ctx.model!.id && allowed.includes(model.provider),
        );
      if (!target || !(await pi.setModel(target))) {
        ctx.ui.notify(
          "No permitted Codex account can serve this model in this project.",
          "error",
        );
        return { handled: true };
      }
    }
    await routeSelectedModel(ctx);
    return {};
  });
  pi.registerCommand("subs", {
    description: "Manage Codex subscriptions",
    handler: async (args, ctx) => {
      scope = ctx;
      const action =
        args.trim() ||
        (await ctx.ui.select("Codex subscriptions", [
          "add",
          "remove",
          "login",
          "logout",
          "switch",
          "list",
          "status",
          "limits",
        ]));
      switch (action) {
        case undefined:
          return;
        case "add":
          return handleSubsAdd(pi, ctx, register);
        case "remove":
          return handleSubsRemove(pi, ctx);
        case "login":
          return handleSubsLogin(ctx);
        case "logout":
          return handleSubsLogout(ctx);
        case "switch":
          return handleSubsSwitch(pi, ctx);
        case "list":
          return handleSubsList(ctx);
        case "status":
          return handleSubsStatus(ctx);
        case "limits":
          return handleSubsLimits(ctx);
        default:
          throw new Error(
            "Use /subs add|remove|login|logout|switch|list|status|limits",
          );
      }
    },
  });
  pi.registerCommand("pool", {
    description: "Manage Codex pools and project restrictions",
    handler: (args, ctx) => {
      scope = ctx;
      return handlePoolCommand(args, ctx, poolManager);
    },
  });
}
