import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AuthStorage, ModelRegistry, loadExtensions } from "@oh-my-pi/pi-coding-agent";

import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
const originalAgentDir = getAgentDir();
const roots: string[] = [];
const stores: AuthStorage[] = [];
afterEach(() => { setAgentDir(originalAgentDir); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function host() {
 const root = mkdtempSync(join(tmpdir(), "omp-mp-native-")); roots.push(root);
 setAgentDir(root);
 writeFileSync(join(root, "multi-pass.json"), JSON.stringify({ subscriptions: [{ provider: "openai-codex", index: 2, label: "test" }], pools: [] }));
 const auth = await AuthStorage.create(join(root, "agent.db")); stores.push(auth);
 await auth.credentials.set("openai-codex-2", { type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3_600_000, accountId: "test-account", orgId: "test-org", orgName: "test-workspace" });
 const registry = new ModelRegistry(auth, join(root, "models.yml"));
 const loaded = await loadExtensions([resolve("extensions/multi-sub.ts")], root);
 // A load failure must be a behavior assertion, not an uncaught import error.
 expect(loaded.errors).toEqual([]);
 for (const { name, config, sourceId } of loaded.runtime.pendingProviderRegistrations) registry.registerProvider(name, config, sourceId);
 return { root, auth, registry, loaded };
}

test("native registration makes the authenticated Codex subscription selectable with image input", async () => {
 const { registry } = await host();
 const models = registry.getAvailable().filter(model => model.provider === "openai-codex-2");
 expect(models.some(model => model.input.includes("image"))).toBe(true);
 expect(models.every(model => model.api === "omp-multi-pass-codex")).toBe(true);
});

test("cancelled native re-login preserves the existing credential", async () => {
 const { auth } = await host();
 const before = auth.credentials.get("openai-codex-2");
 const controller = new AbortController(); controller.abort();
 await expect(auth.oauth.login("openai-codex-2", { signal: controller.signal, onAuth() { throw new Error("aborted login displayed authorization"); }, onPrompt: async () => { throw new Error("aborted login prompted"); }, fetch: async () => { throw new DOMException("Aborted", "AbortError"); } })).rejects.toThrow();
 expect(auth.credentials.get("openai-codex-2")).toEqual(before);
});

test("cancelled initial login stores no credential", async () => {
 const { auth } = await host(); await auth.credentials.remove("openai-codex-2");
 const controller = new AbortController(); controller.abort();
 await expect(auth.oauth.login("openai-codex-2", { signal: controller.signal, onAuth() { throw new Error("aborted login displayed authorization"); }, onPrompt: async () => { throw new Error("aborted login prompted"); }, fetch: async () => { throw new DOMException("Aborted", "AbortError"); } })).rejects.toThrow();
 expect(auth.credentials.get("openai-codex-2")).toBeUndefined();
});
