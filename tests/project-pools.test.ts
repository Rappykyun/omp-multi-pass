import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import * as mp from "../extensions/multi-sub";

const original = getAgentDir(); const roots: string[] = [];
afterEach(() => { setAgentDir(original); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
 const root = mkdtempSync(join(tmpdir(), "omp-mp-pools-")); roots.push(root); setAgentDir(root);
 const cwd = join(root, "project"); mkdirSync(join(cwd, ".omp"), { recursive: true });
 const config = { subscriptions: [{ provider: "openai-codex", index: 2 }, { provider: "openai-codex", index: 3 }], pools: [{ name: "test", baseProvider: "openai-codex", members: ["openai-codex", "openai-codex-2", "openai-codex-3"], enabled: true }] };
 writeFileSync(mp.globalConfigPath(), JSON.stringify(config)); return { root, cwd, config };
}
for (const [allowedSubs, wanted] of [[undefined, ["openai-codex", "openai-codex-2", "openai-codex-3"]], [[], []], [[" "], []], [["openai-codex-2"], ["openai-codex-2"]]] as const) {
 test(`effective pools enforce exact allow-list ${JSON.stringify(allowedSubs)}`, () => {
  const { cwd } = fixture(); writeFileSync(mp.projectConfigPath(cwd), JSON.stringify({ allowedSubs }));
  expect(mp.loadEffectiveConfig(cwd).pools.flatMap(pool => pool.members)).toEqual([...wanted]);
 });
}
test("invalid configuration cannot replace a valid saved configuration", () => {
 fixture(); const path = mp.globalConfigPath(); const before = readFileSync(path, "utf8");
 expect(() => mp.saveJsonConfig(path, { subscriptions: [{ provider: "anthropic", index: 2 }], pools: [] })).toThrow();
 expect(readFileSync(path, "utf8")).toBe(before);
});
test("invalid field types and malformed files remain errors", () => {
 fixture(); writeFileSync(mp.globalConfigPath(), '{"subscriptions":"wrong","pools":[]}'); expect(() => mp.loadGlobalConfig()).toThrow();
 writeFileSync(mp.globalConfigPath(), '{broken'); expect(() => mp.loadGlobalConfig()).toThrow();
});
test("active agent directories and empty project pool overrides stay isolated", () => {
 const first = fixture(); const firstPath = mp.globalConfigPath();
 const second = fixture(); writeFileSync(mp.projectConfigPath(second.cwd), '{"pools":[]}'); expect(mp.loadEffectiveConfig(second.cwd).pools).toEqual([]);
 setAgentDir(first.root); expect(mp.globalConfigPath()).toBe(firstPath); expect(mp.loadEffectiveConfig(first.cwd).pools[0].members).toEqual(["openai-codex", "openai-codex-2", "openai-codex-3"]);
});
async function manager() {
 const Class = (mp as Record<string, unknown>).PoolManager;
 expect(typeof Class).toBe("function");
 return new (Class as new () => { order(pool: mp.PoolConfig, available: string[], current: string, modelId: string, options?: { now?: Date; signal?: AbortSignal; quota?: (provider: string) => Promise<{ remaining?: number }> }): Promise<string[]>; markExhausted(provider: string, resetAt?: number, now?: number): void; isExhausted(provider: string, now?: number): boolean })();
}
test("round-robin and quota-first choose eligible accounts without inventing unknown quota", async () => {
 const { config } = fixture(); const pool = config.pools[0]; const pm = await manager();
 expect(await pm.order(pool, pool.members, "openai-codex", "gpt-5.5")).toEqual(["openai-codex-2", "openai-codex-3", "openai-codex"]);
 expect(await pm.order({ ...pool, strategy: "quota-first" }, pool.members, "openai-codex", "gpt-5.5", { quota: async name => name === "openai-codex-3" ? { remaining: 70 } : {} })).toEqual(["openai-codex-3", "openai-codex-2", "openai-codex"]);
});
test("scheduled windows preserve local weekday and midnight rules", async () => {
 const { config } = fixture(); const pool = { ...config.pools[0], strategy: "scheduled" as const, memberSchedule: { "openai-codex-2": { role: "preferred" as const, windows: [{ hours: [22, 6] as [number, number], days: ["mon"] }] } } }; const pm = await manager();
 expect((await pm.order(pool, pool.members, "openai-codex", "gpt-5.5", { now: new Date(2026, 9, 5, 1) }))[0]).toBe("openai-codex-2");
 expect(await pm.order(pool, pool.members, "openai-codex", "gpt-5.5", { now: new Date(2026, 9, 4, 23) })).toEqual(["openai-codex-3", "openai-codex"]);
});
test("custom selection cannot introduce an unavailable account", async () => {
 const { root, config } = fixture(); writeFileSync(join(root, "selector.mjs"), 'export default () => ["anthropic-2", "openai-codex-3", "openai-codex-3"];'); const pm = await manager();
 expect(await pm.order({ ...config.pools[0], strategy: "custom", selectorScript: "selector.mjs" }, ["openai-codex-2", "openai-codex-3"], "openai-codex", "gpt-5.5")).toEqual(["openai-codex-3", "openai-codex-2"]);
});
test("cooldown uses the reported reset and expires at its boundary", async () => {
 fixture(); const pm = await manager(); pm.markExhausted("openai-codex-2", 2_000, 1_000);
 expect(pm.isExhausted("openai-codex-2", 1_999)).toBe(true); expect(pm.isExhausted("openai-codex-2", 2_000)).toBe(false);
 pm.markExhausted("openai-codex-3", undefined, 1_000); expect(pm.isExhausted("openai-codex-3", 300_999)).toBe(true); expect(pm.isExhausted("openai-codex-3", 301_000)).toBe(false);
});
