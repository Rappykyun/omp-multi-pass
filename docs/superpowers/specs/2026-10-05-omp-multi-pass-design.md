# omp-multi-pass: Codex-only fork

Status: Design approved in chat. This specification needs user approval before implementation planning.

## 1. Goal and scope

Fork https://github.com/hjanuschka/pi-multi-pass and make its Codex account features work in omp. The user selected Codex accounts only, then approved the proposed fork design. The deliverable is a real local Git fork, an omp extension, checks, and installation instructions. A GitHub fork is also required when GitHub authentication is available. Do not report a local clone as a published GitHub fork.

Keep Codex subscription management, account switching, rotation pools, quota checks, and exact project account restrictions. Preserve the upstream Codex pool strategies: round-robin, quota-first, scheduled, and custom. Remove other providers from the supported provider list and management menus. Cross-provider fallback chains and model presets are outside this scope. Do not change omp itself.

Target: omp 18.6.1 on Windows. Use native omp packages and runtime APIs. Do not depend on the Pi compatibility loader for the finished extension. The package name is `omp-multi-pass`; its manifest declares `omp.extensions`.

## 2. Evidence and source

Upstream main was inspected at commit `0d9a2113f26d38eb041f7b641d0f517520594872`. Its package version is 1.5.1. Its package manifest declares MIT. The fork must preserve upstream attribution and applicable license notices. The source contains imports from `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui`. It also contains Pi-specific OAuth adaptation and `.pi` storage paths.

The local package at `~/.omp/local-packages/pi-multicodex` contains an existing omp Codex streaming adaptation. Use it as a reference for native streaming, compatibility settings, token refresh, account metadata, and retry boundaries. It is not this fork. Do not modify it or copy its account credentials.

The omp extension guide documents native `@oh-my-pi/*` imports, provider registration, commands, UI contexts, and session lifecycle events. The extension-loading guide documents `omp.extensions`, active-profile storage, and explicit-only loading with `--no-extensions -e`.

## 3. Extension structure

Start from the upstream Git history. Keep the upstream entry file unless a split is needed for behavior tests or native integration. Reuse upstream selection and configuration logic where it remains correct. Do not add a general provider adapter framework.

Replace the Pi host integration with native omp APIs:

- Register Codex subscription providers and their current models through omp.
- Use the native Codex OAuth flow and token refresh operation. Preserve account and organization metadata.
- Use omp command and UI APIs for `/subs` and `/pool`.
- Apply the native model compatibility settings before sending each request.
- Keep text, images, reasoning, and tool-call content unchanged at the stream boundary.
- Keep per-session routing state inside the extension factory. Do not share mutable project restrictions across child sessions.

Provider API signatures must be checked against the installed host before implementation. A missing required host API is an explicit load error, not a silent fallback to Pi or a different account.

## 4. Account management and storage

`/subs` supports add, remove, login, logout, switch, list, status, and limits for Codex accounts. Use native interactive OAuth. The extension must not approve an authorization prompt on the user's behalf. A cancelled login must not leave a partly saved credential.

Global non-secret configuration is `multi-pass.json` in the active omp agent directory. Project configuration is `<cwd>/.omp/multi-pass.json`. Resolve the active agent directory through the host so named profiles stay isolated. Do not silently read or migrate `.pi` configuration.

Use omp's supported credential storage for subscription providers. Do not create a second unmanaged token store, copy tokens from MultiCodex, log tokens, or commit credentials. Validate configuration before replacing saved data. Use atomic replacement for extension-owned configuration. Invalid existing data must produce an error, not an empty configuration that overwrites it.

Adding and removing subscriptions updates their models and menus. Removing a subscription prunes its pool references. A management command must not change an in-flight request's credentials.

## 5. Pools, quotas, and project restrictions

`/pool` supports create, list, toggle, remove, status, trace, and project management for Codex pools. Keep upstream cooldown behavior and reported reset times where applicable. A missing quota report is unknown quota, not zero quota or unlimited quota.

Keep upstream pool strategies. Custom selectors remain explicit user configuration; never execute scripts supplied by model output. Keep upstream opt-in routing traces: memory only, bounded entries, no prompts or tokens, off by default.

Project `allowedSubs` is an exact allow-list. An omitted list allows all configured Codex subscriptions. An empty list permits none. Apply it to manual switching, quota inspection, active routing, and pool selection. Project pool overrides replace global pools. Do not silently use an unlisted core account if the allowed pool is exhausted.

## 6. Retry and stream safety

Keep account fallback inside the provider request path. Do not resubmit the user's whole prompt after an agent turn ends; that can repeat tool actions.

A quota error before output starts may select the next eligible account and retry the same request. Mark the failed account on cooldown. Try each eligible account at most once per request. Respect project restrictions on every attempt.

Once text, reasoning, or tool-call output has started, return an error without an automatic account retry. Never join partial output from different accounts. Preserve cancellation during selection, quota checks, refresh, and streaming. If all permitted accounts are unavailable, return a clear terminal error. Do not hide unrelated provider errors as quota errors.

## 7. Installation and existing account managers

First load the fork in an isolated omp profile with explicit extension loading and no ambient extensions. Do not enable it in the default profile during development. The installation instructions must state that only one Codex account manager can be enabled at a time.

Do not remove or disable the local MultiCodex package or `codex-plus-first` configuration without user approval. Do not migrate existing accounts by default. The user can add accounts through the fork's login command.

The final README must contain the tested local installation command, commands, storage paths, supported omp version, safe manager cutover procedure, and check commands. Keep tokens and private account data out of examples.

## 8. Acceptance checks

Use failing-before and passing-after behavior checks for changed logic. Keep small deterministic regression checks for account restrictions and stream retry safety. Do not retain tests that only match source text or imports.

The port is complete only when these checks pass:

1. An isolated omp profile loads the native extension without Pi import or provider registration errors.
2. `/subs` and `/pool` show only Codex actions and execute management operations correctly.
3. Login cancellation saves no credential; interactive login and refresh preserve account metadata.
4. A quota error before output selects the next permitted account, keeps the model and request content, and cannot loop indefinitely.
5. A quota error after output starts does not retry; tool actions cannot be replayed by prompt resubmission.
6. Cancellation stops selection, refresh, and streaming without a new account attempt.
7. Empty and exact project allow-lists remain enforced for manual and automatic selection. Exhaustion cannot bypass them.
8. Quota failures remain visible and do not become fabricated quota values.
9. Pool strategy behavior, cooldown expiry, malformed configuration, and profile isolation have runnable checks.
10. A real omp session exercises the command UI. A real authenticated Codex request verifies text and image input, subject to explicit user approval for login and quota use. If approval or credentials are unavailable, report that check as not run; do not claim full end-to-end verification.
11. The package has native omp imports and an `omp.extensions` entry, updated documentation, and no unused non-Codex provider integration.

## 9. Approval and delivery gates

Written-spec approval permits creation of the written implementation plan only. The plan needs separate approval and an execution-method selection before product changes begin.

GitHub CLI is currently not authenticated. Creating or publishing the GitHub fork requires authenticated access and the user's target account. Complete local work without claiming external publication. Commit this specification into the local fork once its implementation workspace exists; no Git repository has been created for this draft.