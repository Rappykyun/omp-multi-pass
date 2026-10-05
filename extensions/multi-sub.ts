/** Codex-only omp fork of hjanuschka/pi-multi-pass (MIT). */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { getProviderDefinition, streamSimple, type Api, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { modelKind } from "@oh-my-pi/pi-catalog/types";

export const BASE = "openai-codex";
export const MANAGED_API = "omp-multi-pass-codex";
export interface SubEntry { provider: string; index: number; label?: string }
export type PoolStrategy = "round-robin" | "quota-first" | "scheduled" | "custom";
export interface ScheduleWindow { hours?: [number, number]; days?: string[]; dateRange?: { from?: string; to?: string } }
export interface MemberSchedule { windows?: ScheduleWindow[]; role?: "preferred" | "overflow" }
export interface PoolConfig { name: string; baseProvider: string; members: string[]; enabled: boolean; strategy?: PoolStrategy; memberSchedule?: Record<string, MemberSchedule>; selectorScript?: string }
export interface MultiPassConfig { subscriptions: SubEntry[]; pools: PoolConfig[] }
export interface ProjectConfig { pools?: PoolConfig[]; allowedSubs?: string[] }
export interface EffectiveConfig extends MultiPassConfig { allowedProviderNames?: string[] }

export function subProviderName(entry: SubEntry): string { return `${entry.provider}-${entry.index}`; }
export function globalConfigPath(): string { return join(getAgentDir(), "multi-pass.json"); }
export function projectConfigPath(cwd: string): string { return join(cwd, ".omp", "multi-pass.json"); }
export function loadGlobalConfig(): MultiPassConfig {
 if (!existsSync(globalConfigPath())) return { subscriptions: [], pools: [] };
 const raw = JSON.parse(readFileSync(globalConfigPath(), "utf8"));
 return { subscriptions: raw.subscriptions ?? [], pools: raw.pools ?? [] };
}
export function loadProjectConfig(cwd: string): ProjectConfig | undefined {
 const path = projectConfigPath(cwd);
 return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}
export function normalizeAllowedProviderNames(allowedSubs: string[] | undefined): string[] | undefined {
 if (!allowedSubs || allowedSubs.length === 0) return undefined;
 return [...new Set(allowedSubs.map(value => value.trim()).filter(Boolean))];
}
export function filterPoolsByAllowedProviders(pools: PoolConfig[], allowed: string[] | undefined): PoolConfig[] {
 if (!allowed || allowed.length === 0) return pools;
 return pools.map(pool => ({ ...pool, members: pool.members.filter(member => allowed.includes(member)) })).filter(pool => pool.members.length > 0);
}
export function loadEffectiveConfig(cwd: string): EffectiveConfig {
 const config = loadGlobalConfig(); const project = loadProjectConfig(cwd);
 const allowed = normalizeAllowedProviderNames(project?.allowedSubs);
 return { subscriptions: allowed ? config.subscriptions.filter(entry => allowed.includes(subProviderName(entry))) : config.subscriptions,
 pools: filterPoolsByAllowedProviders(project?.pools ?? config.pools, allowed), allowedProviderNames: allowed };
}
export function saveJsonConfig(path: string, config: unknown): void {
 mkdirSync(dirname(path), { recursive: true });
 const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
 try { writeFileSync(temp, JSON.stringify(config, null, 2), "utf8"); renameSync(temp, path); }
 finally { if (existsSync(temp)) unlinkSync(temp); }
}

export function cloneModels(models: readonly Model<Api>[]): ProviderModelConfig[] {
 return models.filter(model => modelKind(model) === "chat").map(model => {
  if (model.contextWindow === null || model.maxTokens === null) throw new Error(`Missing token limits for ${model.id}`);
  return { id: model.id, name: model.name, api: MANAGED_API, input: [...model.input], reasoning: model.reasoning, thinking: model.thinking,
   cost: { input: model.cost.input ?? 0, output: model.cost.output ?? 0, cacheRead: model.cost.cacheRead ?? 0, cacheWrite: model.cost.cacheWrite ?? 0 },
   contextWindow: model.contextWindow, maxTokens: model.maxTokens, preferWebsockets: model.preferWebsockets, compat: model.compat };
 });
}

export function registerSub(pi: ExtensionAPI, entry: SubEntry, models: () => readonly Model<Api>[] = () => getBundledModels(BASE), stream = streamSimple): void {
 const def = getProviderDefinition(BASE);
 if (!def?.login || !def.refreshToken) throw new Error("omp does not expose the required native Codex OAuth API");
 pi.registerProvider(subProviderName(entry), {
  api: MANAGED_API, baseUrl: models()[0]?.baseUrl,
  models: cloneModels(models()), fetchDynamicModels: async () => cloneModels(models()),
  oauth: {
   name: entry.label ? `Codex #${entry.index} (${entry.label})` : `Codex #${entry.index}`,
   login: callbacks => { callbacks.signal?.throwIfAborted(); return def.login!(callbacks); },
   refreshToken: credentials => def.refreshToken!(credentials), getApiKey: credentials => credentials.access,
  },
  streamSimple: (model, context, options) => {
   const native = { ...model, api: "openai-codex-responses" as const, provider: BASE, compat: undefined, compatConfig: model.compatConfig as Model<"openai-codex-responses">["compatConfig"] };
   const policy = resolveModelPolicy({ ...native, compat: native.compatConfig });
   return stream({ ...native, compat: policy.compat, thinking: policy.thinking, identity: policy.identity }, context, options);
  },
 });
}

function scopedProviders(ctx: ExtensionContext): string[] {
 const config = loadEffectiveConfig(ctx.cwd);
 const names = [BASE, ...config.subscriptions.map(subProviderName)];
 return names.filter(name => config.allowedProviderNames === undefined || config.allowedProviderNames.includes(name));
}
async function pickSubscription(ctx: ExtensionCommandContext): Promise<SubEntry | undefined> {
 const entries = loadEffectiveConfig(ctx.cwd).subscriptions;
 const selected = await ctx.ui.select("Codex subscription", entries.map(entry => `${subProviderName(entry)}${entry.label ? ` (${entry.label})` : ""}`));
 return entries.find(entry => selected?.startsWith(subProviderName(entry) + " (") || selected === subProviderName(entry));
}
export async function handleSubsAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext, register: (entry: SubEntry) => void): Promise<void> {
 const label = await ctx.ui.input("Codex subscription label (optional)"); if (label === undefined) return;
 const config = loadGlobalConfig();
 const index = Math.max(1, ...config.subscriptions.map(entry => entry.index)) + 1;
 const entry = { provider: BASE, index, ...(label.trim() ? { label: label.trim() } : {}) };
 config.subscriptions.push(entry); saveJsonConfig(globalConfigPath(), config); register(entry);
 ctx.ui.notify(`Added ${subProviderName(entry)}. Run /login and select Codex #${index}.`, "info");
}
export async function handleSubsRemove(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
 const entry = await pickSubscription(ctx); if (!entry) return;
 const name = subProviderName(entry);
 if (!await ctx.ui.confirm(`Remove ${name}?`, "This removes the subscription, its login, and its global pool membership.")) return;
 const config = loadGlobalConfig(); config.subscriptions = config.subscriptions.filter(candidate => subProviderName(candidate) !== name);
 config.pools = config.pools.map(pool => ({ ...pool, members: pool.members.filter(member => member !== name) }));
 saveJsonConfig(globalConfigPath(), config); await ctx.modelRegistry.authStorage.credentials.remove(name); pi.unregisterProvider(name);
 ctx.ui.notify(`Removed ${name}.`, "info");
}
export async function handleSubsLogin(ctx: ExtensionCommandContext): Promise<void> {
 const entry = await pickSubscription(ctx); if (!entry) return;
 // Native /login owns browser authorization, cancellation, and credential persistence.
 ctx.ui.notify(`Run /login and select Codex #${entry.index}${entry.label ? ` (${entry.label})` : ""}. The saved login stays unchanged until login succeeds.`, "info");
}
export async function handleSubsLogout(ctx: ExtensionCommandContext): Promise<void> {
 const entry = await pickSubscription(ctx); if (!entry) return;
 const name = subProviderName(entry);
 if (await ctx.ui.confirm(`Log out ${name}?`, "The saved credential will be removed.")) {
  await ctx.modelRegistry.authStorage.credentials.remove(name); ctx.ui.notify(`Logged out ${name}.`, "info");
 }
}
export async function handleSubsSwitch(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
 const permitted = new Set(scopedProviders(ctx));
 const models = ctx.models.list().filter(model => permitted.has(model.provider));
 const names = [...new Set(models.map(model => model.provider))];
 const selected = await ctx.ui.select("Switch Codex account", names); if (!selected) return;
 const target = models.find(model => model.provider === selected && model.id === ctx.model?.id) ?? models.find(model => model.provider === selected);
 if (!target || !await pi.setModel(target)) throw new Error("No available model for the selected Codex account");
}
export async function handleSubsStatus(ctx: ExtensionCommandContext): Promise<void> {
 const names = scopedProviders(ctx);
 ctx.ui.notify(names.map(name => `${name}: ${ctx.modelRegistry.authStorage.credentials.hasOAuth(name) ? "logged in" : "not logged in"}`).join("\n") || "No Codex accounts are permitted in this project.", "info");
}
export async function handleSubsList(ctx: ExtensionCommandContext): Promise<void> { await handleSubsStatus(ctx); }

export default function multiSub(pi: ExtensionAPI): void {
 pi.setLabel("omp-multi-pass");
 let registry: ExtensionContext["modelRegistry"] | undefined;
 const currentModels = () => registry?.getProviderModels(BASE) ?? getBundledModels(BASE);
 const register = (entry: SubEntry) => registerSub(pi, entry, currentModels);
 for (const entry of loadGlobalConfig().subscriptions) register(entry);
 pi.on("session_start", async (_event, ctx) => { registry = ctx.modelRegistry; });
 pi.registerCommand("subs", {
  description: "Manage Codex subscriptions",
  handler: async (args, ctx) => {
   const action = args.trim() || await ctx.ui.select("Codex subscriptions", ["add", "remove", "login", "logout", "switch", "list", "status"]);
   switch (action) {
    case undefined: return;
    case "add": return handleSubsAdd(pi, ctx, register);
    case "remove": return handleSubsRemove(pi, ctx);
    case "login": return handleSubsLogin(ctx);
    case "logout": return handleSubsLogout(ctx);
    case "switch": return handleSubsSwitch(pi, ctx);
    case "list": return handleSubsList(ctx);
    case "status": return handleSubsStatus(ctx);
    default: throw new Error("Use /subs add|remove|login|logout|switch|list|status");
   }
  },
 });
}
