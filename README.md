# omp-multi-pass

Codex subscription pools for native **omp 18.6.1**.

This is a Codex-only fork of [hjanuschka/pi-multi-pass](https://github.com/hjanuschka/pi-multi-pass). It keeps the upstream Git history and MIT license declaration. It does not require Pi or omp's Pi compatibility loader.

## Scope

- Add Codex subscriptions and give them labels.
- Use native omp login, credential storage, and token refresh.
- Switch accounts manually.
- Rotate accounts in a pool when a request reaches a quota limit before output starts.
- Use `round-robin`, `quota-first`, `scheduled`, or `custom` selection.
- Check account quota with the native Codex usage provider.
- Restrict accounts and pools for a project.
- Record an optional, memory-only routing trace.
- Use the current base Codex model catalog, including models with image input.

Other providers, cross-provider fallback chains, and model presets are not included. Image-generation endpoints are not included; image input to chat models is supported.

## Start in an isolated profile

From this checkout, run:

```sh
omp --profile multi-pass --no-extensions -e ./extensions/multi-sub.ts
```

The explicit entry loads this fork. `--no-extensions` excludes other account managers. The profile keeps its credentials and settings separate from the default profile.

If omp shows its first-run setup, complete its steps. Then use the commands below.

No runtime dependency install is required: omp supplies the native packages. Do not install the Pi agent to use this extension.

## Add accounts and a pool

```text
/subs add
/login
/subs add
/login
/pool create
/subs switch
```

`/subs add` asks for a label. It creates an ID such as `openai-codex-2`. Native `/login` shows an entry such as `Codex #2 (work)`.

Choose the matching entry in `/login`. Complete the provider authorization yourself. The extension does not approve authorization prompts.

`/subs login` selects a subscription and shows its native login entry. It does not delete the saved credential before login. A cancelled login keeps the previous credential.

`/pool create` asks for a name, a comma-separated account list, and a strategy. Include only accounts that you want that pool to use. The original `openai-codex` provider can also be a member if it has a login.

## Commands

| Command | Operation |
| --- | --- |
| `/subs` | Open the Codex subscription menu. |
| `/subs add` | Add a subscription with an optional label. |
| `/subs remove` | Remove a subscription and its saved login after confirmation. |
| `/subs login` | Select the subscription to sign in with native `/login`. |
| `/subs logout` | Remove a saved login after confirmation. |
| `/subs switch` | Select a permitted, available Codex account. |
| `/subs list` | Show permitted accounts and login status. |
| `/subs status` | Show permitted accounts and login status. |
| `/subs limits` | Check quota. Press Escape in the terminal UI to cancel. |
| `/pool` | Open the pool menu. |
| `/pool create` | Create a pool in the current configuration scope. |
| `/pool list` | Show effective pools and member status. |
| `/pool status` | Show effective pools and member status. |
| `/pool toggle` | Enable or disable a pool. |
| `/pool remove` | Remove a pool after confirmation; keep its accounts. |
| `/pool project` | Restrict project accounts, choose project pools, inspect settings, or clear the override. |
| `/pool trace start` | Clear old trace entries and start recording. |
| `/pool trace show` | Show retained entries. |
| `/pool trace status` | Show whether recording is active. |
| `/pool trace stop` | Stop recording and keep the retained entries. |
| `/pool trace clear` | Clear retained entries. |

Quota checks have a 15-second limit. A failed or incomplete quota report stays unknown; it is not shown as zero quota or unlimited quota.

## Retry boundaries

The extension retries the provider request, not the user's whole prompt.

- A quota error before output can select another eligible account with the same model ID.
- Each provider member is attempted at most once in that request.
- Text, reasoning, or tool-call output closes the account-retry window.
- A failure after output starts is returned without an account retry.
- Cancellation stops selection, refresh, and streaming.
- Exhausted pools return a terminal error. They do not bypass project restrictions or use an unlisted core account.
- The default cooldown is five minutes. A reported reset time takes precedence when available.
- Account and pool settings are read at request start. Changes apply to the next request.

A disabled pool does not prevent a permitted account from making a direct request.

## Configuration and credentials

Global configuration is `multi-pass.json` in the active omp agent directory:

- Default profile: `~/.omp/agent/multi-pass.json`
- Profile `multi-pass`: `~/.omp/profiles/multi-pass/agent/multi-pass.json`

Project configuration is `<cwd>/.omp/multi-pass.json`.

Credentials stay in omp's supported credential store. The extension does not keep another token JSON file, copy MultiCodex tokens, or import `.pi` credentials.

Configuration is validated before an atomic file replacement. Invalid existing files produce an error and are not replaced with empty configuration. Repair invalid files before you use a management command.

### Exact project account restrictions

Example:

```json
{
  "allowedSubs": ["openai-codex-2"],
  "pools": [
    {
      "name": "work",
      "baseProvider": "openai-codex",
      "members": ["openai-codex-2"],
      "enabled": true,
      "strategy": "round-robin"
    }
  ]
}
```

- Omit `allowedSubs` to allow all configured Codex provider names.
- Set `allowedSubs` to `[]` to permit none.
- Account names are exact. Allowing `openai-codex-2` does not allow `openai-codex` or `openai-codex-3`.
- Restrictions apply to manual switching, quota inspection, and requests handled by this extension.
- Project `pools` replaces the global pool list. An empty project pool list disables inherited pools.
- Other model providers are outside this Codex-only extension's scope.

The UI accepts `all` to remove a restriction or inherit global pools. Empty input creates an explicit empty list.

### Scheduled selection

The schedule uses local time. A wrapping range such as `[22, 6]` permits hours from 22:00 through 05:59. Weekday rules refer to the current local day, as in upstream.

Example member schedule:

```json
{
  "openai-codex-2": {
    "role": "preferred",
    "windows": [{ "hours": [22, 6], "days": ["mon", "tue"] }]
  },
  "openai-codex-3": { "role": "overflow" }
}
```

Active preferred members come first. Default members follow. Overflow members come last. Preferred members outside their windows are skipped during fallback selection.

### Custom selection

A selector is an explicitly configured JavaScript module with a default function. Its path is relative to the active agent directory unless it is absolute or starts with `~/`.

The function receives eligible `members`, `currentProvider`, `modelId`, `pool`, `timestamp`, `hour`, `day`, and optional request text in `prompt`. `currentProvider` names the most recently exhausted member.

Return one member name, an ordered list of member names, or `undefined`. Unknown members and duplicate names cannot add an account to the eligible list.

Only use selector files that you trust. They execute in the omp process, not in a sandbox. Request cancellation stops the selection wait, but it cannot terminate arbitrary JavaScript inside a selector. The trace does not record the prompt or token data.

## Replace an existing account manager

Do not enable two Codex account managers at the same time.

1. Test this fork with the isolated-profile command above.
2. Add accounts with native `/login`. Do not copy refresh tokens from another manager.
3. Check `/subs status`, `/subs limits`, and `/pool status`.
4. Back up your existing settings before you change the default profile.
5. Disable the old Codex manager before you enable this fork in that profile.

This port does not remove MultiCodex, change `codex-plus-first`, or change default-profile credentials.

## Development and verification

Tested on Windows with omp 18.6.1 and Bun 1.4.2.

```sh
bun install
bun run check
bun test
```

The behavior checks use isolated native credential stores and local HTTP/SSE fixtures. They cover registration, login cancellation, refresh cancellation, image-capable catalogs, exact restrictions, pool strategies, cooldowns, request snapshots, separate session contexts, and stream retry boundaries.

The actual omp 18.6.1 binary was exercised against a loopback-only fault-injection server. Pre-output account fallback with image input, post-output failure without automatic retry, and streaming cancellation passed. The native subscription and pool command UI was also exercised.

**Not tested:** real provider authorization and real Codex text/image requests. The user chose to skip those checks. No real account quota was used for the local-server checks.

## Upstream and license

Upstream: [hjanuschka/pi-multi-pass](https://github.com/hjanuschka/pi-multi-pass), version 1.5.1, starting commit `0d9a2113f26d38eb041f7b641d0f517520594872`.

Upstream author: hjanuschka. The upstream package declares the MIT license. This fork retains that declaration and attribution.
