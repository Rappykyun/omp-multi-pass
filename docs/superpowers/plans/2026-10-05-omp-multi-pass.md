# omp-multi-pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. Steps use checkbox syntax for tracking.

**Goal:** Produce a Codex-only Git fork of pi-multi-pass that works with native omp APIs.

**Architecture:** Keep the upstream subscription and pool management flow in `extensions/multi-sub.ts`. Replace Pi integration with native omp registration, authentication, models, and UI. Move request-level account retry into `extensions/pool-stream.ts` so no agent turn or tool action is replayed.

**Tech Stack:** TypeScript, Bun, native omp packages, Node standard-library file operations, and Bun behavior tests.

**Spec:** `docs/superpowers/specs/2026-10-05-omp-multi-pass-design.md`. The user approved this specification after it was presented. Its draft status line predates that approval.

## Global Constraints

- Target: omp 18.6.1 on Windows.
- The package name is `omp-multi-pass`; its manifest declares `omp.extensions`.
- Do not depend on the Pi compatibility loader for the finished extension.
- Do not change omp itself.
- Keep Codex subscription management, account switching, rotation pools, quota checks, and exact project account restrictions.
- Preserve the upstream Codex pool strategies: round-robin, quota-first, scheduled, and custom.
- Cross-provider fallback chains and model presets are outside this scope.
- Use omp's supported credential storage for subscription providers.
- Do not modify existing account managers, copy their credentials, or enable the fork in the default profile.
- Preserve upstream history, attribution, and applicable license notices.
- Each behavioral change needs a failing-before check and a passing-after check. Do not use source-text assertions.
- Obtain interactive user approval for provider authorization and real-account quota use. Do not approve provider prompts automatically.

## Review Focus

1. Empty or whitespace-only account allow-lists must deny all accounts. Task 2 tests all selection paths.
2. A custom selector can return an unlisted or repeated account. Task 3 tests rejection and bounded attempts.
3. A cancelled re-login must preserve an existing credential. Task 1 tests the host-backed credential transaction.
4. A scheduled window can cross midnight or a weekday boundary. Task 2 tests the retained upstream scheduling logic with fixed dates.
5. A command can change pools while a request is streaming. Task 3 tests request snapshots and unchanged in-flight credentials.

## File Map

- Modify `package.json`: native extension manifest, version `1.5.1-omp.1`, local behavior-test command, and development-only native host dependency.
- Modify `extensions/multi-sub.ts`: retain upstream Codex configuration, commands, quota parsing, pool strategies, and trace logic; replace host integration; remove unsupported features and obsolete retry code.
- Create `extensions/pool-stream.ts`: request-level retry and stream termination safety. This is the only new runtime module.
- Create `tests/native-host.test.ts`: native registration, credential lifecycle, command behavior, model refresh, and profile isolation.
- Create `tests/project-pools.test.ts`: configuration validation, exact account restrictions, pool selection, schedules, custom selector boundaries, and quotas.
- Create `tests/pool-stream.test.ts`: consumer-visible stream results, retry boundaries, cancellation, exhaustion, and request snapshots.
- Modify `README.md`; create `CHANGELOG.md`: tested installation, commands, restrictions, storage, safety, and port changes.
- Retain upstream behavior checks only where they exercise real retained behavior. Remove source-extraction, source-text, and non-Codex checks made obsolete by the port.
- Include the approved specification and this plan in the fork's documentation.

## Execution Order and Workspace

The tasks share `multi-sub.ts` and must run in order. Do not run concurrent edits on this file.

After plan approval, clone upstream at commit `0d9a2113f26d38eb041f7b641d0f517520594872` into a new local `omp-multi-pass` directory. Preserve `upstream` as the source remote. Work on branch `omp-codex-port`. A dedicated clone avoids changes to any existing project. Follow using-git-worktrees; obtain consent before adding a linked worktree if one is needed.

Before product edits, check the native package declarations for the installed version. `@oh-my-pi/pi-coding-agent@18.6.1` is published; local Bun is 1.4.2. Add that host package as a development dependency for native integration checks, not as a bundled runtime copy. Use the host's matching AI and TUI package versions. Do not install a separate Pi runtime.

Read upstream checks and run their declared baseline commands. If the baseline fails, report the failed check and get approval before continuing. Do not discard a meaningful baseline failure to obtain a green result.

### Task 1: Native Codex host, accounts, and commands

**Files:** `package.json`, `extensions/multi-sub.ts`, `tests/native-host.test.ts`.

**Interfaces:**
- Retain `export default function multiSub(pi: ExtensionAPI): void`, using the native `ExtensionAPI` type.
- Retain `registerSub(pi: ExtensionAPI, entry: SubEntry): void`, `subProviderName(entry: SubEntry): string`, and upstream subscription IDs such as `openai-codex-2`.
- Retain the host UI handlers `handleSubsAdd`, `handleSubsRemove`, `handleSubsLogin`, `handleSubsLogout`, `handleSubsSwitch`, `handleSubsList`, and `handleSubsStatus` with native context types.
- Use native `getAgentDir()`, `ctx.modelRegistry.authStorage`, the native Codex provider definition, and the host's documented provider login and refresh interfaces. Check their exact declarations before edits. Delete Pi compatibility fallbacks rather than rename them.
- Produce an extension that registers Codex providers, uses host credentials, refreshes its current model list, and exposes working subscription commands.

- [ ] Read native provider-registration, OAuth, auth-store, model-query, and UI declarations for 18.6.1. Use LSP references before changing exported symbols. Record any difference from this plan before implementation.
- [ ] Add a native host behavior check that loads the unchanged upstream extension in an isolated session and attempts a Codex subscription operation. Run it before edits. The check must show the reported host incompatibility; an import error alone is not the required failing behavior assertion. Use a caught load result and assert successful registration and selectable subscription behavior.
- [ ] Write and run failing checks for: cancelled initial login saves no credential; cancelled replacement login leaves the previous credential usable; refresh preserves account and organization metadata; registration and model refresh preserve image support and model compatibility metadata.
- [ ] Convert imports to native omp packages and change the manifest to `omp.extensions: ["./extensions/multi-sub.ts"]`. Remove non-Codex OAuth and quota integrations, chains, presets, and their menu actions. Do not leave disabled dead code.
- [ ] Replace credential compatibility probing with the native auth-store API. Delegate interactive login to the native flow. Do not delete a previous credential before a replacement login succeeds. Keep confirmation for remove and logout operations.
- [ ] Replace `models-store.json` reading and `refreshModels` assumptions with native model queries and supported dynamic-model registration. Subscription catalogs must follow the live base Codex catalog, not only a hardcoded startup list.
- [ ] Run `bun test tests/native-host.test.ts`. Expected: all checks pass, native load has no errors, and commands operate on the isolated credential store.
- [ ] Run an isolated omp session with `--no-extensions -e ./extensions/multi-sub.ts`; exercise subscription add, list, status, and cancelled login in the actual UI. Gather fresh UI evidence. Do not use real accounts yet.
- [ ] Commit the native host and account-management change with its behavior checks.

### Task 2: Profile-safe configuration and restricted pool selection

**Files:** `extensions/multi-sub.ts`, `tests/project-pools.test.ts`.

**Interfaces:**
- Retain and export existing behavior units needed by the tests: `normalizeAllowedProviderNames(allowedSubs: string[] | undefined): string[] | undefined`, `filterPoolsByAllowedProviders(pools: PoolConfig[], allowedProviderNames: string[] | undefined): PoolConfig[]`, and `loadEffectiveConfig(cwd: string): EffectiveConfig`.
- Retain `globalConfigPath(): string`, `projectConfigPath(cwd: string): string`, `loadGlobalConfig(): MultiPassConfig`, `loadProjectConfig(cwd: string): ProjectConfig | undefined`, and `saveJsonConfig(path: string, config: unknown): void`.
- Reduce `MultiPassConfig` to subscriptions and pools; reduce `ProjectConfig` to pools and `allowedSubs`. Remove chain and preset fields from effective configuration.
- Produce one allow-list rule shared by manual switching, quota collection, active selection, and pool selection. `undefined` means unrestricted; `[]` means no account is permitted.

- [ ] Write failing behavior checks with `allowedSubs` omitted, `[]`, whitespace-only entries, exact `openai-codex-2`, and a disallowed base `openai-codex`. Assert the actual selectable account IDs and resulting pool members, not only the normalized array.
- [ ] Write failing checks for malformed JSON, invalid field types, invalid provider IDs, two isolated profiles, and a project pool override of `[]`. A rejected save must leave the old file bytes unchanged.
- [ ] Run `bun test tests/project-pools.test.ts`. Expected: the empty allow-list and malformed-configuration checks fail against upstream behavior; checks for retained behavior may already pass.
- [ ] Use the native active agent directory for global configuration and `.omp/multi-pass.json` for project configuration. Only missing files mean no configuration. Parse and validation failures remain errors. Validate before atomic file replacement.
- [ ] Remove duplicate quota and switch allow-list normalization. Route all account selection through the exact shared rule. Filter the base provider too. Block requests if an explicit allow-list has no available target.
- [ ] Preserve pool strategies and five-minute default cooldown. Prefer a supplied quota reset time when available. Validate custom selector paths as explicit configuration, resolve relative paths against the active agent directory, and constrain returned account IDs to eligible pool members.
- [ ] Add retained-strategy checks: ordered round-robin selection, quota-first ranking with an unknown-quota account, fixed-date scheduled windows across midnight and weekdays, configured custom selector results, and cooldown expiry with a controlled clock. Unknown or invalid quota must not become a fabricated percentage.
- [ ] Run `bun test tests/project-pools.test.ts` and the native host checks. Expected: all pass; project overrides and profile storage remain isolated.
- [ ] Exercise `/pool create`, strategy selection, project restrictions, status, and quota cancellation in an isolated actual omp session. Trace remains off by default, retains at most 100 entries when enabled, and contains no prompts or tokens.
- [ ] Commit the configuration and pool change with its checks.

### Task 3: Request-level fallback with no agent replay

**Files:** `extensions/pool-stream.ts`, `extensions/multi-sub.ts`, `tests/pool-stream.test.ts`.

**Interfaces:**
Use native `Model<Api>`, `Context`, and stream types. Let `NativeStream` be `typeof streamSimple` from `@oh-my-pi/pi-ai` and `NativeOptions` be its third parameter type.

Create `createPoolStream(deps: PoolStreamDependencies): NativeStream` in `pool-stream.ts`. `PoolStreamDependencies` contains:

- `stream: NativeStream`: native Codex transport, captured before registering the managed API.
- `select(model: Model<Api>, attempted: ReadonlySet<string>, signal?: AbortSignal): Promise<Model<Api> | undefined>`: choose an eligible model with the same ID under the request's effective configuration snapshot.
- `resolveOptions(model: Model<Api>, options: NativeOptions): Promise<NativeOptions>`: get that provider's host-managed credential and native compatibility options without changing session state.
- `markExhausted(provider: string, errorMessage: string): void`: update the factory's pool cooldown state using reset metadata when supplied.

The wrapper produces a native assistant-message stream. Request attempts are local; pool cooldown state stays in the factory. Bind these operations to the existing `PoolManager` and native auth store. Do not create a second account manager.

- [ ] Write stream behavior checks using a deterministic local HTTP transport that produces a real quota rejection followed by a native Codex-compatible success response. Assert one final reply, its model ID, and the account identities received at the endpoint. This tests selection and output, not a mocked forwarding echo.
- [ ] Run the checks before changing upstream retry behavior. Assert that no extra user prompt or second agent turn is created. Expected: upstream agent-end failover does not meet request-level fallback behavior.
- [ ] Add failing checks for a quota error after text or reasoning starts, a partial tool call followed by an error, unrelated HTTP 400 failure, all accounts exhausted, a repeated or disallowed custom selector result, and cancellation during refresh or streaming.
- [ ] Implement `createPoolStream` with native stream construction and a request-local attempted-provider set. Buffer only non-content start events until the attempt either produces output or terminates. Try another account only for a real pre-output quota error. Any content delta or tool-call output closes the retry window.
- [ ] Resolve native Codex policy and credentials per selected attempt. Preserve request text, images, reasoning configuration, tools, and cancellation. Never alter the original context to recover from account failure.
- [ ] Register the managed stream for every fork-owned Codex subscription. Apply request restrictions to base Codex routing when this extension manages it, so switching the session model cannot bypass an explicit project allow-list. A disabled pool must not block an otherwise permitted direct account request.
- [ ] Remove `agent_end` failover, saved-last-prompt state, Pi retry-status logic, chain cascade state, and every automatic prompt-resubmission caller. No compatibility aliases remain.
- [ ] Snapshot effective configuration at request start. Add a check that modifies the configured pools during a delayed local stream and confirms the current request retains its original account while the next request uses the new configuration.
- [ ] Run `bun test tests/pool-stream.test.ts`, then `bun test`. Expected: all retained behavior checks pass, each attempt is bounded, errors terminate, and no prompt or tool replay occurs.
- [ ] Exercise the actual omp CLI against the local fault-injection server. Observe pre-output account fallback, post-output error, and cancellation. Remove the temporary server script after the smoke check.
- [ ] Commit the request-level retry change with its checks.

### Task 4: Complete delivery, review, and end-to-end evidence

**Files:** `README.md`, `CHANGELOG.md`, approved spec and plan; remove obsolete upstream tests.

**Interfaces:** Deliver the native extension package from Tasks 1–3. No new runtime interface.

- [ ] Use requesting-code-review and verification-before-completion. Obtain an independent whole-branch review. Fix findings with the same failing-before behavior-check process.
- [ ] Run the complete `bun test` suite. Record exact results and any baseline failures still present. Run the package's native type check if provided; otherwise add and run a TypeScript no-emit check using the installed native declarations. Do not use a bundling check as a substitute for type checking.
- [ ] Launch actual omp with an isolated new profile, `--no-extensions`, and the fork's explicit entry. Verify `/subs`, `/pool`, and model selection, including live model refresh. Capture the actual command UI and report the exercised operations.
- [ ] Ask for explicit approval to log in a Codex test account and use quota for one text request and one generated image request. The user must approve provider authorization interactively. Do not import existing manager tokens. If approval is unavailable, stop that check and report it as not run; do not claim complete authenticated verification.
- [ ] Update README and changelog only after observed smoke results. State Codex-only scope, supported omp version, exact install and check commands, profile-specific configuration paths, unknown-quota behavior, and the no-retry-after-output rule. Explain manager cutover without changing the user's default setup.
- [ ] Remove obsolete source-text and non-Codex checks, temporary fault-injection scripts, and unused imports. Retain the deterministic behavior regressions. Do not remove unrelated files or existing user account data.
- [ ] Commit the finished docs and checks. Follow finishing-a-development-branch for branch delivery. Present the local branch and tested installation instructions, without enabling the package globally.
- [ ] For GitHub delivery, check authenticated access and obtain the target account at the publication gate. Create the upstream fork and push the reviewed branch only to the approved target. If access is unavailable, report the exact blocker and retain the complete local fork. Do not describe it as published.

## Plan Self-Review

Specification coverage: Task 1 covers native extension, subscription commands, OAuth, credentials, and models. Task 2 covers configuration, strategies, quotas, restrictions, traces, and profiles. Task 3 covers stream boundaries, request snapshots, cancellation, exhaustion, and no replay. Task 4 covers actual UI and authenticated checks, documentation, review, branch delivery, and GitHub publication.

The tasks are sequential because they share host integration and pool state. Native execution is recommended: one implementer keeps those contracts consistent, followed by independent whole-branch review. No implementation, package installation, Git clone, or external publication is authorized by specification approval alone. This plan needs user approval and an execution-method selection.