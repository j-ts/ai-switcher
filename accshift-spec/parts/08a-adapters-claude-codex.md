## 8. CLI adapters

Every adapter implements the same interface (Go sketch):

```go
type Adapter interface {
    CLI() string                                   // "claude", ...
    Kinds() []Kind                                 // supported account kinds, default first
    Add(ctx, req AddRequest) (Account, error)      // guided login / import; never performs OAuth itself
    Login(ctx, acct Account, req LoginRequest) (Account, error) // re-authenticate in place; identity check (Login rules below)
    Prepare(ctx, acct Account, args []string) (RunPlan, error)  // env, binary, pre-run hooks, locks
    AfterRun(ctx, acct Account, plan RunPlan, exit int) error   // post-run hooks (save-back, copy-back); spawn path only
    Doctor(ctx, acct *Account) []Finding
    Classify(in ClassifyInput) Classification      // pure: evidence -> class, scope, reset, tier (§9.4)
    Portability(from, to Account) Portability      // yes | likely | possible | unlikely | no
}
```

`RunPlan` holds:
- the resolved binary;
- the caller's args, never modified. The one exception is the secret-isolation argument of §7.6 that `exec` MAY prepend; the plan lists it as `addedArgs`, and the status file reports it;
- the env delta (variables to set and to unset);
- whether execve is allowed (no post-run hook and no lock to hold);
- the locks to hold;
- the post-run hooks. A hook failure never changes the returned exit status: it sets the status file's `postRunError` and logs an event (§12.1.1).

**Portability.** `Portability(from, to)` returns one of five values for one move between two accounts of the cli:
- `sessionPortable` (§3, §11.2) is true for `yes` and `likely`, and false for `possible`, `unlikely` and `no`. For false, LimitShift starts a new session with the handoff note instead of resuming.
- `from` equal to `to` (no switch, for example exit 75 naming `--from`) is always `yes`.
- The adapter decides from the two accounts' recorded kinds and identities only. accshift keeps no record of which account created a session, so no adapter has a "returning to the session's creator" case.

**Rules for all adapters** [R09 §1.6, D4, D5]:
- **Never** run vendor logout commands (`codex logout`, `claude auth logout`, `/logout`); they revoke credentials.
- **Never** copy `auth.json`, `.credentials.json`, or Keychain / Credential Manager items between places.
- **Never** perform OAuth or call provider endpoints.
- **Never** add arguments to the caller's command, with exactly one exception: `exec` MAY prepend the vendor's secret-isolation argument listed in `facts.go` (today only copilot's `--secret-env-vars=COPILOT_GITHUB_TOKEN`) when the caller's argv does not already contain it, and reports it in the status file's `addedArgs` (§7.6). A switch that needs any other argument, such as codex `-c`, is never applied by `exec`. `run` has its own documented exception for codex `--no-daemon` (§8.2, §16).
- The user's existing default login of each cli is registered, if the user wants it, as a **`native`** account. That is typically account #0, named `main`, at pool position 0.
  - accshift never reads, copies, moves or rewrites a native credential. Detecting that one exists (`add --native`) uses file existence or keystore attributes only.
  - `remove` on a native account only unregisters it.
  - agy has no `native` kind, because its single slot is swapped; §8.3.3 says how the user's own unregistered agy login is protected.
- **Secrets are never flag values.** Every secret-bearing kind (claude `token`, codex `access-token` / `api-key`, copilot `token`) reads its secret only from a no-echo TTY prompt or from one line on stdin with `--token-stdin`.
- **Overlay-owned vendor keyring items.** When a codex `home` overlay or a claude `login-slot` directory has made the vendor store its credential in the OS keyring under a key derived from that directory's own path, the item is single-owned by the overlay. `remove` deletes it (this is not a logout: no vendor command runs and nothing outside the overlay changes). accshift never touches items derived from `mainHome` or the default config dir. If the delete fails, `remove` prints the exact item name for manual removal.
- **Provider notice at every `add`.** Every `add` (every cli and kind, including `--native` and `--capture-current`) shows the Appendix F notice when state.json `notice` is unset or its `version` is older than this binary's notice version. It requires `y` at the prompt, or `--accept-notice` (the only way without a TTY), before any vendor login runs or anything is stored. On acceptance it writes `notice = {acceptedAt, version}` (§6.3). If the notice is not accepted, nothing is registered and `add` exits 65 `notice-not-accepted`. Until `notice` is current, `pick` and `next` exit 69 `notice-not-accepted` with the hint `accshift notice --accept` (§9.3). `accshift notice --accept` (§10.2) accepts a new notice version without an `add`, for a user whose accounts are all registered.

**Login rules** (`accshift login <cli> <name> [--label L] [--new-identity]`, every adapter):
- `login` re-authenticates an account in place. Its `id`, overlay or slot directory, vault `secretId`, name and pool position stay the same. Like `add`, it runs only the vendor's own login flow attached to the TTY, or reads a new secret for a secret-bearing kind, and never performs OAuth itself.
- It compares the new credential's offline identity with the recorded one:
  - codex file store: (`chatgptAccountId`, `chatgptUserId`) decoded from the `id_token` (§8.2);
  - claude `login-slot`: `oauthAccount.emailAddress` read right after the login (§8.1);
  - agy: the slot's email (§8.3.4);
  - where the identity is user-asserted (claude `token`; codex `home` in keyring or auto store, `access-token` and `api-key`; any kind another adapter marks so): `--label` is required and MUST equal the account's current label.
- On a mismatch, accshift restores the previous credential where the adapter still has it, or deletes or parks the new one (each adapter says which), and exits 65 `identity-mismatch`. `--new-identity` accepts the new identity instead: it runs the add-time dedupe, updates the identity fields, and clears all records, `authStrikes`, `lastStrikeAt`, `backoff`, `attentionCode` and `relogin` (§9.2).
- A same-identity login clears `relogin`, `authStrikes` and auth-suspect records. It keeps limit records, `backoff`, `attentionCode` and `lastStrikeAt`, because a fresh login does not reset a usage window (§9.2).
- `login` on a `native` account exits 64 `native-account` with the vendor's own login command as the hint (claude `claude auth login`, codex `codex login`). accshift never touches a native credential.
- A native account can change identity outside accshift, through the user's own vendor login. Where accshift can read the native identity offline without reading the credential, `doctor` compares it with the recorded one and warns on a change; `doctor --fix` or `mark --clear` clears that account's records (§9.2). Each adapter says what it can compare.

### 8.1 claude (Claude Code), tier 1

**Facts (verified against 2.1.293)** [R04 §1]:
- **Credentials** [R04 §1a, C1–C3]. `<dir>`, the service and the account come from the slot derivation below:
  - Linux: `<dir>/.credentials.json` (0600, plaintext) only. Claude never uses libsecret;
  - macOS: the Keychain through `/usr/bin/security`. If a Keychain write fails, Claude falls back to plaintext `<dir>/.credentials.json` [R04 C2];
  - Windows: `<dir>\.credentials.json`, unless Credential Manager is switched on by `CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1` or by `cachedGrowthBookFeatures.tengu_windows_credman === true` in `.claude.json`. Then Claude uses the Credential Manager entry it writes through Bun.secrets for the derived service and the constant user `claude-code-user`, with the plaintext file as fallback [R04 C3]. The exact target name of that entry is kept in claude `facts.go`.
- **Credential slot derivation.** This is Claude's own code [R04 §1a], kept in claude `facts.go`. `ss` is `CLAUDE_SECURESTORAGE_CONFIG_DIR` and `cd` is `CLAUDE_CONFIG_DIR`; "set" distinguishes an unset variable from a set-but-empty one. `~` is the home directory as Node resolves it: `$HOME` on POSIX, `%USERPROFILE%` on Windows.
  - `<dir>`: `ss` if set (an empty `ss` means `~/.claude`); otherwise `cd` if set and non-empty; otherwise `~/.claude`.
  - No hash suffix when `ss` is set and empty, or when `ss` is unset and `cd` is unset or empty.
  - Otherwise the suffix is `-` plus the first 8 hex digits of sha256 of the hashed string: `NFC(ss)` when `ss` is set, else `NFC(cd)`. The raw string is hashed: no symlink resolution, no `~` expansion, no trailing-slash trimming, no path cleaning.
  - Service = `Claude Code` + `OAUTH_FILE_SUFFIX` + `-credentials` + suffix. `OAUTH_FILE_SUFFIX` is empty in release builds and becomes `-custom-oauth` when `CLAUDE_CODE_CUSTOM_OAUTH_URL` is set. accshift unsets that variable for every run (Appendix A.1), so it always derives with the empty suffix.
  - macOS Keychain account: `$USER` if set and non-empty; else the user name of the current uid (`os/user.Current()`, which on macOS calls `getpwuid_r` through libSystem without cgo; accshift is never built with the `osusergo` tag). If neither yields a name, or the name fails `^[a-zA-Z0-9._-]+$`, the account is `claude-code-user`. Windows always uses `claude-code-user`.
  - This is why setting `CLAUDE_CONFIG_DIR`, even to the default path, selects another Keychain entry [#92252], and why a set-but-empty `CLAUDE_SECURESTORAGE_CONFIG_DIR` pins the default one.
  - With `cd` set but empty (and `ss` unset), Claude resolves `<dir>` relative to its working directory. accshift does not support that state: `add --native` refuses it with exit 78 `unsupported-config` and the hint to unset `CLAUDE_CONFIG_DIR`.
- **`claude setup-token`:** mints a 1-year, inference-only OAuth token (`sk-ant-oat…`). It has no refresh token, and Claude never saves it to disk.
- **`CLAUDE_CODE_OAUTH_TOKEN`:**
  - works for `-p`, `json`/`stream-json`, interactive mode and `--resume`;
  - is ignored in `--bare` mode;
  - is outranked by `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper` and the `CLAUDE_CODE_USE_*` providers;
  - on a 401, Claude keeps the env token and never silently adopts the stored login, so a wrong-account run on the main subscription cannot happen silently.
- **Transcripts:** `<configDir>/projects/<slug(cwd)>/<sessionId>.jsonl`, where `<configDir>` is `CLAUDE_CONFIG_DIR` or `~/.claude`. They carry no account binding [R04 §1d].
  - `slug(cwd)` replaces every UTF-16 code unit outside `[A-Za-z0-9]` with `-`, so a character outside the BMP becomes `--`. A slug longer than 200 characters is truncated and gets a `-<base36 hash>` suffix whose algorithm is unverified. For such paths accshift finds the transcript by globbing `projects/*/<sessionId>.jsonl` (Appendix B).
- **Shared config:** an env token never rewrites `oauthAccount` in the shared `.claude.json` [R04 C8].

**Kinds:**

| Kind | Selection for a run | History | Concurrency | Notes |
|---|---|---|---|---|
| `token` (default) | set `CLAUDE_CODE_OAUTH_TOKEN=<token from vault>` | shared (`~/.claude` or the user's own `CLAUDE_CONFIG_DIR`) | unlimited; no file is touched | inference-only: no `/usage` plan percentages, Remote Control or claude.ai connectors [R04 C5]. `usageProbe:false` |
| `native` (account #0) | unset `CLAUDE_CODE_OAUTH_TOKEN`; the stored `/login` credential is used. `CLAUDE_SECURESTORAGE_CONFIG_DIR` passes through **exactly as the user had it at `add --native`**, including a set-but-empty value (the #92252 workaround). It is removed only if it points into accshift's `homes/` | shared | unlimited | full scopes; `usageProbe:true` (LimitShift still never probes a managed runner, §15.6) |
| `login-slot` (experimental, needs `--experimental`) | `CLAUDE_SECURESTORAGE_CONFIG_DIR=<root>/homes/claude/<id>` (the immutable directory id, §6.2): an absolute NFC path, no trailing slash, the same string every time | shared | unlimited | undocumented. The shared `oauthAccount` shows the last login, so `/status` may name the wrong account [R04 C7, #79222]. `doctor` warns about skills-sync churn (#98526) and suggests users pass `--settings '{"syncClaudeAiSkills":false}'` themselves. `usageProbe:false`: short-lived probes can spend its refresh token [R09 C3] |

Per-account `CLAUDE_CONFIG_DIR` (documented by Anthropic) is **not built in v1**. It is the contingency if `CLAUDE_SECURESTORAGE_CONFIG_DIR` disappears, and would reuse the codex overlay engine with an allowlist (D4).

**Environment for every claude run** (Appendix A.1):
- Unset:
  - `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`;
  - `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`;
  - `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, `CCR_OAUTH_TOKEN_FILE`;
  - `CLAUDE_CODE_SIMPLE`, `CLAUDE_CODE_RETRY_WATCHDOG`;
  - `ANTHROPIC_UNIX_SOCKET`, `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`;
  - `CLAUDE_CODE_OAUTH_SCOPES` (would give an env token false scopes);
  - `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`;
  - `CLAUDE_CODE_CUSTOM_OAUTH_URL` (changes OAuth endpoints and the Keychain suffix);
  - `CLAUDE_CODE_SUBSCRIPTION_TYPE`, `CLAUDE_CODE_RATE_LIMIT_TIER`;
  - SHOULD also unset `ANTHROPIC_ORGANIZATION_ID`.
- Unsetting `CLAUDE_CODE_RETRY_WATCHDOG` is essential: with it set, Claude silently waits out the limit [R04 C6].
- Then set the kind's variable from the table above. accshift does not set `CLAUDE_CODE_SUBSCRIPTION_TYPE` (its effect is unverified).
- accshift MUST NOT set or change `CLAUDE_CONFIG_DIR` or `HOME`. Explicitly setting `CLAUDE_CONFIG_DIR`, even to the default path, selects a different Keychain entry and logs the user out silently [R09 §1.4, #92252].
- `--bare` in the caller's args with a `token` account → exit 125 (`bare-ignores-token`), unless `--allow-bare`.
- **Settings that override the environment.** Claude Code's settings can define `apiKeyHelper` and an `env` block that is applied to every session, so they can re-introduce variables accshift removed. Before every claude run, `exec` scans, offline and cached by mtime:
  - the user layer (`~/.claude/settings.json`, or the one under the user's own `CLAUDE_CONFIG_DIR`);
  - the project layers of exec's working directory and of its git root (`.claude/settings.json`, `.claude/settings.local.json`);
  - the managed layer, at the per-OS paths kept in claude `facts.go` and Appendix B (macOS `/Library/Application Support/ClaudeCode/managed-settings.json`, Linux/WSL `/etc/claude-code/managed-settings.json`, Windows `C:\Program Files\ClaudeCode\managed-settings.json`; **VERIFY V-C4**);
  - any `--settings <json|file>` value in the caller's args, read only (the args are never modified).
  
  If any layer defines `apiKeyHelper`, `exec` exits 125 `apikeyhelper-overrides-token` unless `--allow-apikeyhelper`. If any layer's `env` sets a variable from the A.1 always-unset list, or `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR` or `ANTHROPIC_BASE_URL`, `exec` exits 125 `settings-env-overrides-token` unless `--allow-settings-env`. V-C4 confirms that settings `env` wins over the process environment in the installed version.
- **Base URL.** For `token` and `login-slot` runs, if `ANTHROPIC_BASE_URL` is set in the child environment or in any settings `env` layer and its host is not `api.anthropic.com`, `exec` exits 125 `base-url-would-receive-token` unless `--allow-base-url`: the token would be sent to that host.
- **Credential presence** (exec's `relogin(missing)` check, §12.1): `token` → the vault entry `claude/<id>` exists; `login-slot` → `S/.credentials.json` exists, or on macOS the Keychain item derived from `S` exists (by attributes, as in the login-slot add step 3); `native` → never checked. An absent credential makes exec record `relogin(missing)` and exit 125 `needs-relogin`.

**Add flows:**

Syntax: `accshift add claude <name> [--native | --experimental --kind login-slot] [--label EMAIL] [--force] [--token-stdin] [--accept-notice]`. Without `--native` or `--kind`, the kind is `token`.

**`add claude <name>` (token):**
1. A TTY is required unless `--token-stdin`. With `--token-stdin` the token was minted elsewhere, so steps 3 and 4 are skipped.
2. Show the provider notice when it is not yet accepted (§8 rules), requiring `y` or `--accept-notice`.
3. Tell the user to approve in a private window, or in a browser profile signed in to the intended account.
4. Run `claude setup-token` with stdin, stdout and stderr inherited: no PTY, no output scraping.
5. Read the pasted token with no echo, or one line from stdin with `--token-stdin`.
6. Validate: one line, `^sk-ant-oat[0-9A-Za-z_-]+$`, 40–512 bytes. Any other input exits 65 `invalid-token`, and nothing is stored.
7. Require `--label <email>`. Refuse a label already used by another claude account (65 `duplicate-account`) unless `--force`, because token identity cannot be checked offline.
8. Store the token in the vault under `claude/<id>`, with the account's immutable id (§6.2). Record `createdAt` and `expiresAt = createdAt + 365 d`.
9. Never make a model call, and never spawn `claude auth status`: short-lived Claude commands can spend refresh tokens [R09 C3].
10. The first time `add claude` runs in a TTY, it SHOULD offer to register the native login as `main` at position 0.
11. If `CLAUDE_CODE_OAUTH_TOKEN` is already exported in the user's shell, it SHOULD offer to import it as a token account. `doctor` notes that `exec` overrides it.

**`add claude main --native`:** show the notice (§8 rules), then detect the default login **without reading the secret**. `<dir>`, the service and the account come from the slot derivation above, applied to the environment `add` runs in [R04 §1a, C2, C3]:
- Linux: `<dir>/.credentials.json` exists.
- macOS: `/usr/bin/security find-generic-password -s <service> -a <account> <keychain>` **without** `-w`. Exit 0 means present and 44 means absent; other statuses map as in §7.4. If the item is absent, an existing `<dir>/.credentials.json` (Claude's plaintext fallback) also counts as present.
- Windows: `<dir>\.credentials.json` exists. When Credential Manager is switched on (Facts above), the Credential Manager entry for the derived service and `claude-code-user` also counts. Only its existence is used: the returned blob is zeroed unread.
- If no login is found, `add` exits 65 `no-login-detected` with the hint `claude auth login`.
- `CLAUDE_SECURESTORAGE_CONFIG_DIR` is recorded exactly as set, including set-but-empty, or as absent (kinds table above).
- If the user's environment sets `CLAUDE_CODE_CUSTOM_OAUTH_URL`, `add` warns that the user's own login lives under a `-custom-oauth` item that accshift runs do not use.
- The label comes from `oauthAccount.emailAddress` in the global config, read offline: `$CLAUDE_CONFIG_DIR/.claude.json` when `CLAUDE_CONFIG_DIR` is set and non-empty, else `$HOME/.claude.json`; a legacy `<configDir>/.config.json` wins when present [R04 §1a, §1c].

**`add claude <name> --experimental --kind login-slot`:** after the notice (§8 rules):
1. Record the default slot's state: file mtime, or the Keychain item's modification date, read by attributes only.
2. Create `S = <root>/homes/claude/<id>` (a new immutable id) and run `CLAUDE_SECURESTORAGE_CONFIG_DIR=S claude auth login --claudeai` attached to the TTY.
3. Verify that the new slot exists **and** that the default slot did not change. The new slot is `S/.credentials.json`, or on macOS the Keychain item `Claude Code-credentials-<sha256(NFC(S))[0:8]>` with the derived account, checked by attributes (or the plaintext fallback `S/.credentials.json`).
   - If either check fails, abort with exit 65 `securestorage-ignored` and warn that the default login may have been replaced.
4. Take the identity from `.claude.json` read right after login. Never spawn claude to get it.

**Login** (`accshift login claude <name> [--label EMAIL] [--new-identity] [--token-stdin]`), under the §8 Login rules:
- `token`: steps 1 and 3–6 of the token add flow, then step 9. `--label` is required and MUST equal the account's current label, because a token's identity cannot be read offline [R04 §1g].
  - On a mismatch the new token is discarded without being stored, and `login` exits 65 `identity-mismatch`.
  - On success the token replaces the vault entry `claude/<id>`, and `createdAt` and `expiresAt = createdAt + 365 d` are reset, which also ends an `expired` needs-relogin.
  - With `--new-identity`, the label may change, and step 7's uniqueness check applies.
- `login-slot`: steps 1–4 in the account's existing `S`; the Keychain key derives from `S`, so the slot cannot move. Step 1 also records `S`'s own state, and step 3 requires that `S`'s credential changed (file mtime or Keychain modification date) while the default slot did not. The identity from step 4 MUST equal the recorded label.
  - On a mismatch, accshift deletes the new credential from `S` (the file, or the Keychain item derived from `S`; no vendor command runs), records `relogin(missing)` and exits 65 `identity-mismatch`. The previous slot credential was already replaced by the vendor login and cannot be restored, so `login` warns about this before step 2.
- `native`: exit 64 `native-account` with the hint `claude auth login` (or `/login` inside Claude Code).

**Doctor:**
- token expiry: a warning from 30 days before, an error once expired;
- `apiKeyHelper`, `ANTHROPIC_PROFILE` or an overriding `env` key in any settings layer;
- `ANTHROPIC_BASE_URL` set in the user's environment (exec refuses token runs with it, see above);
- whether Claude Code strips `CLAUDE_CODE_OAUTH_TOKEN` from tool and MCP subprocesses (V-C5, §7.6);
- `.claude.json` missing `hasCompletedOnboarding` (#8938);
- `CLAUDE_CODE_RETRY_WATCHDOG` or `CLAUDE_CODE_CUSTOM_OAUTH_URL` in the user's environment;
- the native account's identity: `oauthAccount.emailAddress` (read offline, as at `add --native`) compared with the recorded label, with a warning on a change (§8 Login rules). The check is skipped once any `login-slot` account exists, because the shared `oauthAccount` then names the last slot login [R04 C7, #79222];
- the `claude` binary path and version. The version is read from package metadata where possible (the `package.json` next to an npm install). `claude --version` runs only in an interactive `doctor`, never in `doctor --json` (§9.6), because whether it starts an OAuth refresh for a logged-in account is unverified (V-C6) [R09 C3].

**Limits** (Appendix C.1):
- Structured, with a reset (tier 3): stream-json `rate_limit_event` with `status:"rejected"` → `resetsAt` and `rateLimitType`; the transcript's `rate_limit_info` carries the same fields [R04 §1d, §1e].
- Structured, without a reset: assistant `error:"rate_limit"` and the result's `is_error` with `api_error_status` 429 detect a limit but carry no reset time. The reset then comes from the text (tier 2) or, failing that, the default backoff (tier 1): the tier describes the reset value's source, not the detection (§9.4).
- Text (tier 2): the `You've hit your … · resets …` family, matched on the decoded `result` string (Appendix C.1). The reset reads `3pm` or `3:30pm` within 24 h, otherwise `Oct 9, 3pm`, with the year added when it differs, followed by ` (<IANA zone>)` [R04 §1e].
- Scope mapping: `five_hour`, `seven_day`, `overage`, "session limit" and "weekly limit" → `account`; `seven_day_opus` / "Opus limit" → `model:opus`; `seven_day_sonnet` → `model:sonnet`; `seven_day_overage_included` / "Fable limit" → `model:fable`.
- `account_on_hold`, `verification_required`, `billing_error`, `oauth_org_not_allowed`, "Your org is out of usage", "Your seat type doesn't include…" → `blocked` (`needs-attention`).

**Auth:**
- `…has no refresh token — it cannot self-heal…`, `authentication_failed`, `Invalid bearer token`, or HTTP 401 → `auth` (ambiguous strike).
- A past `expiresAt` → `needs-relogin` (§9.2).

**Session portability:** `likely`, so the contract reports `sessionPortable:true`. History is shared, transcripts carry no account binding, and thinking signatures are portable [R04 C9]. LimitShift resumes, and falls back to New plus the handoff note on `No conversation found with session ID` (`session-lost`) or a failed first resumed turn. **VERIFY V-C1.**

### 8.2 codex (OpenAI Codex CLI), tier 1

**Facts (verified against 0.161.0)** [R04 §2]:
- `auth.json` lives in `CODEX_HOME`, with `cli_auth_credentials_store` defaulting to `file`.
- Every store is keyed by the canonical `CODEX_HOME`: the keyring entry `Codex Auth` / `cli|sha256[0:16]`, and on Windows `secrets/codex_auth.age`. A per-account home therefore isolates the credential in every store mode [R04 C12].
- Refresh tokens are single-use and rotate. `auth.json` is rewritten non-atomically on refresh [R04 C13].
- There is no sessions-dir override. The sqlite state can be moved with `CODEX_SQLITE_HOME` [R04 C14].
- `codex exec --json` reports limits only as text. Structured windows are in the rollout's `token_count` [R04 C17].
- Resuming a thread under a different ChatGPT account will probably fail (`invalid_encrypted_content`) [R04 C19].

**Kinds:**

| Kind | Selection for a run | Notes |
|---|---|---|
| `home` (default) | `CODEX_HOME=<overlay>`, `CODEX_SQLITE_HOME=<mainSqliteHome>` | per-account `auth.json`, refreshed in place by Codex itself |
| `native` (account #0) | no `CODEX_HOME` change: the user's own `CODEX_HOME` or `~/.codex` | accshift never copies, moves, rewrites or deletes its `auth.json` or keyring item |
| `access-token` | `CODEX_ACCESS_TOKEN=at-…` from the vault, main home | ChatGPT **Business/Enterprise** workspace tokens only. Validate the `at-` prefix and track expiry (at most 90 days). Not available for personal Plus/Pro [R04 C20] |
| `api-key` | `CODEX_API_KEY=…` from the vault, main home | API billing; `codex exec` only |

There is **no swap kind** and **no symlinked-`auth.json` mode**. Both create two owners of a single-use refresh token [R09 §1.4, D5].

**Homes:**
- `mainHome` = the caller's `CODEX_HOME` when the codex registry is first created, else `~/.codex`. It is recorded and can be changed with `accshift config clis.codex.mainHome <dir>` (§10.2).
- A directory whose canonical path is inside `<root>/homes/` MUST never become `mainHome`, so an inherited overlay `CODEX_HOME` can never become the main home. Initialising `mainHome` from such a `CODEX_HOME` refuses with 78 `unsupported-config`; `config clis.codex.mainHome` refuses such a value with 65 `invalid-config` and changes nothing (§10.2).
- `mainSqliteHome` = `sqlite_home` from `<mainHome>/config.toml`, else the user's `CODEX_SQLITE_HOME`, else `mainHome`.

**Overlay home** (`<root>/homes/codex/<id>`, with an immutable id, §6.2):
- The overlay leaf MUST be a **real directory** (0700), not a symlink or junction.
- At `add`, accshift resolves it with `filepath.EvalSymlinks`, records that canonical path, and always exports the canonical path as `CODEX_HOME`. This works when the root's path contains symlinks (macOS `/var` → `/private/var`, `/tmp`, OSTree `/home` → `/var/home`). Canonicalising avoids Seatbelt rejections caused by symlinks **above** the overlay. Linked children can still be rejected if Codex makes them Seatbelt writable roots (macOS Seatbelt, below).
- The path uses the account's immutable id, never its name. `rename` moves nothing, so the canonical path, and the keyring and secrets keys derived from it, stay valid across renames (§6.2, §10.2).
- `doctor` reports an error if `EvalSymlinks(recorded) != recorded`, because keyring and secrets keys derive from `sha256(canonical CODEX_HOME)`. Moving `ACCSHIFT_HOME` therefore needs a re-login of keyring-mode codex accounts.

**What is shared, and what stays per account.** Shared entries come from an **allowlist**, kept in a version-tagged facts table. Everything else stays per account.

| | Entries |
|---|---|
| **Shared by link** | `config.toml`, `*.config.toml`, `sessions/`, `archived_sessions/`, `history.jsonl`, `session_index.jsonl`, `AGENTS.md`, `AGENTS.override.md`, `rules/`, `skills/`, `memories/`, `memories_v2/`, `plugins/`, `hooks.json`, `themes/`, `worktrees/`, `.credentials.json` (MCP OAuth; **only** when it can be a true symlink), plus a user-configurable `clis.codex.shareExtra` list. On macOS, entries recorded as Seatbelt writable roots move to the per-account row (macOS Seatbelt, below) |
| **Per-account, never linked** | `auth.json`, `secrets/`, `models_cache.json`, `version.json`, `app-server-control/`, `app-server-daemon/`, `packages/`, `arg0/`, `tmp/`, `.tmp/`, `log/`, `.sandbox*`, `sandbox_users.json`, and **every top-level entry not on the allowlist** |

`doctor` lists main-home entries that are on neither list as "not shared".

Why an allowlist, not "link everything else" (D5):
- After a switch the sessions cannot move between accounts anyway, so links serve only configuration and history visibility.
- Wrongly sharing an account-bound file (as `models_cache.json` is) risks wrong-account behaviour or token clobbering. Wrongly isolating a file only loses a customisation, visibly.

**Link refresh** (pre-run, under `state.lock`):
- pre-create missing shared directories in `mainHome`;
- create missing links and replace dangling ones;
- **never** delete or overwrite a real file or directory; report any real entry that shadows a shared name.
- **What counts as a link.** An entry is a link if and only if `Lstat` reports `ModeSymlink` or `ModeIrregular` (Go 1.23+ reports junctions as irregular), or, on Windows, its attributes include `FILE_ATTRIBUTE_REPARSE_POINT`.
- **Unlinking and overlay removal** remove a link with a single `os.Remove` (`RemoveDirectory` for a junction), never with a walk, and **never recurse through a symlink or junction**. Directory walks use `Lstat` / `ReadDir` only, never `os.Stat`. Windows CI MUST prove that removing an overlay leaves `mainHome/sessions` intact.

How links are made per OS:

| OS | Directories | Files |
|---|---|---|
| Linux, macOS | symlink | symlink. Codex follows symlinks when editing config [R04 C14] |
| Windows | directory junction (`FSCTL_SET_REPARSE_POINT`, no admin needed) | symlink when `os.Symlink` succeeds (Developer Mode or privilege). Otherwise **copy mode**, described below |

**Windows copy mode** (when file symlinks are unavailable):
- Before the run, copy in `config.toml`, `*.config.toml`, `AGENTS*.md` and `hooks.json`.
- After the run, copy back each file whose hash changed. If `mainHome`'s copy also changed since the copy-in, keep main's version and report the conflict only in the status file's `postRunError` and in events.jsonl. `exec` writes nothing to stderr after the child starts (§12.1.1), and a copy-back failure never changes the returned exit status.
- `history.jsonl` and `session_index.jsonl` stay per-account (a documented loss).
- `.credentials.json` is **never** copied, because MCP OAuth refresh tokens need one owner.
- Hard links are never used for files Codex rewrites by atomic rename: the rename would silently break the link.
- In copy mode, `env` exits 69 (`requires-exec`).

**macOS Seatbelt** [R04 C15]:
- `allow_symlinked_codex_home` only lets the macOS Seatbelt sandbox accept symlinked writable roots at or beneath `CODEX_HOME`. It has no effect on Linux or Windows and does not make symlinked homes work in general.
- If Codex rejects a symlinked writable root (`contains symlink component … allow_symlinked_codex_home`), `classify` reports `config-error` with a hint.
- On macOS, every allowlisted entry that V-X2 records as a Seatbelt writable root under `CODEX_HOME` (in workspace-write mode) is kept per account, unlinked, unless the shared `config.toml` sets `allow_symlinked_codex_home = true`. The list lives in codex `facts.go` per Codex version; until V-X2 has run, it is empty and the `config-error` hint is the fallback.
- `doctor --fix` MAY add `allow_symlinked_codex_home = true` to the shared `config.toml`, but only with explicit consent.

**Environment for every codex run** (Appendix A.2):
- Set `CODEX_HOME` / `CODEX_SQLITE_HOME` as above, for `home` accounts.
- For `native`, `access-token` and `api-key` runs, an inherited `CODEX_HOME` or `CODEX_SQLITE_HOME` whose canonical path is inside `<root>/homes/` belongs to accshift (for example from an `eval "$(accshift env …)"` shell, or an agent that runs accshift again). accshift sets `CODEX_HOME=<mainHome>`, or unsets it when `mainHome` is `~/.codex`, and treats `CODEX_SQLITE_HOME` the same way (§12.5).
- For `home` and `native`, unset `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN`.
- Always unset `CODEX_REFRESH_TOKEN_URL_OVERRIDE`, which would send refresh tokens elsewhere [R04 §2d].
- **Never touch `OPENAI_API_KEY`.** Codex does not use it for auth, and the user's task code may need it [R04 C20].
- `exec` never adds `-c` or `--no-daemon`. The interactive Codex TUI starts one app-server daemon per `CODEX_HOME` (`codex exec` does not use it). `doctor` reports live per-overlay daemons, and `remove` refuses with 65 `account-in-use` while one runs (§10.2) [R04 C16].
- `run` (§16) is the documented exception: for a codex TUI launch it appends `--no-daemon` unless the caller's args already select daemon behaviour, so relaunches do not leave a daemon per overlay [R04 C16]. `exec` never does this.
- **Credential presence** (exec's `relogin(missing)` check, §12.1). The store mode comes from `cli_auth_credentials_store` in the shared `config.toml` (default `file`), read offline:
  - `home`, file store → the overlay's `auth.json` exists;
  - `home`, Windows secrets mode (the Windows default for `keyring` and `auto`) → the overlay's `secrets/codex_auth.age` exists;
  - `home`, `keyring` or `auto` on macOS and Linux → not checked, because accshift never reads Codex's keyring item;
  - `access-token`, `api-key` → the vault entry `codex/<id>` exists;
  - `native` → never checked.

**Add** (`accshift add codex <name> [--native | --kind home|access-token|api-key] [--browser] [--import-home DIR] [--label L] [--token-stdin] [--accept-notice]`). Without `--native` or `--kind`, the kind is `home`; `--browser` and `--import-home` apply to `home` only. The `home` flow:
1. A TTY is required. Show the notice when it is not yet accepted (§8 rules).
2. Print the emails already registered, including `main`, with "do not sign in with these".
3. Create the overlay and run the link refresh.
4. Run `CODEX_HOME=<overlay> codex login --device-auth` attached to the terminal.
   - Device auth is the default, because two ChatGPT accounts signed in to one browser can invalidate fresh refresh tokens [R09 §1.4, #39199].
   - `--browser` uses the PKCE browser flow and tells the user to use a private window.
5. **File-store mode:** decode `tokens.id_token` locally (no signature check, labelling only):
   - `email`;
   - `https://api.openai.com/auth.chatgpt_plan_type`, `chatgpt_account_id`, `chatgpt_user_id`.
   
   Dedupe on (`chatgptAccountId`, `chatgptUserId`). A new sign-in probably invalidates the account's previous refresh token [R09 C7, inferred], so accshift **never deletes the newest credential**. On a duplicate of registered account X:
   - confirm that no codex process or daemon uses X's overlay (procscan, as for `remove`, §10.2); otherwise exit 73 `overlay-in-use` and keep the new overlay for a retry;
   - rename the new `auth.json` over X's `auth.json` (same filesystem), remove the new overlay, and apply the effects of a same-identity login to X (§8 Login rules: `relogin`, `authStrikes` and auth-suspect records are cleared; limit records stay);
   - exit 65 `duplicate-account` with the message "re-authenticated X".
   - If the duplicate is the native `main` account, which accshift cannot inspect, keep the new account and warn that `main` may need `codex login`.
6. **Keyring or auto store mode:** identity is user-asserted (`--label` required), and accshift never reads Codex's keyring item.
7. If the shared config sets `cli_auth_credentials_store = "ephemeral"`, refuse overlays (exit 78 `unsupported-config`).

**Add, `access-token` and `api-key`** (`--kind access-token|api-key`):
1. Show the notice when it is not yet accepted (§8 rules). A TTY is required unless `--token-stdin`.
2. Read the secret from a no-echo TTY prompt, or as one line of stdin with `--token-stdin` (§8 rules).
3. `access-token`: the secret MUST start with `at-`; otherwise `add` exits 65 `invalid-token` and stores nothing. Record `createdAt` and `expiresAt = createdAt + 90 d`, the longest lifetime of such a token (Kinds, above).
4. Require `--label`: the identity is user-asserted, and `login` later requires the same label (§8 Login rules).
5. Store the secret in the vault under `codex/<id>`. Never make a model call.

**Import** (`--import-home DIR`): adopts an existing single-account Codex home by **moving** its `auth.json` into a new overlay. It never leaves two copies, because refresh tokens are single-use [R04 C13]. It refuses with 65 `invalid-import` if DIR is `mainHome`, and with 73 `overlay-in-use` while any codex process or daemon is using DIR.
- If the rename fails with `EXDEV` (another filesystem): copy to a temp file in the overlay, fsync, unlink the source, and only after the unlink succeeds rename the temp file to `auth.json`. If the unlink fails, delete the copy and abort with exit 74 `import-failed`.

**`add codex main --native`** registers `mainHome`, after the notice (§8 rules). Its label is user-asserted (`--label`), because accshift never reads the native `auth.json`.

**Login** (`accshift login codex <name> [--browser] [--label L] [--new-identity] [--token-stdin]`), under the §8 Login rules:
- `home`, file store: run add steps 3 and 4 in a new **temporary** overlay `homes/codex/<new id>`, so the account's own `auth.json` stays untouched until the identity is known. Then decode the new `id_token` as in add step 5.
  - Same (`chatgptAccountId`, `chatgptUserId`) as the account: after add step 5's in-use check (73 `overlay-in-use`, keeping the temporary overlay for a retry), rename the new `auth.json` over the account's own and remove the temporary overlay. Two copies are never kept [R04 C13].
  - A different identity without `--new-identity`: if it is another registered account Y, it is handled as add step 5 (moved over Y's `auth.json`, never deleted). Otherwise the temporary overlay is deleted, with a warning that `main` may need `codex login` if that identity was the native account's [R09 C7]. Either way the account's own `auth.json` is unchanged, and `login` exits 65 `identity-mismatch`.
  - With `--new-identity`: the add-time dedupe runs first (a registered Y is handled as add step 5). Otherwise the new `auth.json` replaces the account's own as above, the identity fields are updated, and all the account's records are cleared.
- `home`, keyring or auto store: the item is keyed by the overlay's own path, so `login` runs `codex login --device-auth` (or `--browser`) directly in the account's overlay, after the same in-use check. The identity is user-asserted: `--label` MUST equal the current label unless `--new-identity` is given.
- `access-token`, `api-key`: read the new secret as at add (no-echo TTY or `--token-stdin`) and replace the vault entry `codex/<id>`. `--label` MUST equal the current label unless `--new-identity` is given. For `access-token`, validate the `at-` prefix (else 65 `invalid-token`, and the vault entry is unchanged) and reset `expiresAt` to now + 90 d.
- `native`: exit 64 `native-account` with the hint `codex login` (run with the user's own `CODEX_HOME`).

**Doctor:**
- auth file present and parseable; the access token's `exp`, for information;
- the store mode;
- link health; entries that are not shared;
- per-overlay daemons;
- codex processes and daemons that use `mainHome`: procscan finds vendor processes whose `CODEX_HOME` is unset or resolves to `mainHome` (POSIX `/proc/<pid>/environ` or `ps eww`; Windows best effort). When a `native` codex account is registered, `doctor` warns that they race accshift's `main` runs for the single-use refresh token (Concurrency, below);
- the Seatbelt hint;
- whether the overlay's canonical path changed;
- whether Codex's `shell_environment_policy` keeps `CODEX_ACCESS_TOKEN` / `CODEX_API_KEY` out of tool subprocesses for secret-bearing kinds (V-X4, §7.6). `exec` cannot apply that setting, since it would need `-c`; the README documents it as a setting in the user's own `config.toml`;
- a `native` codex account's identity is not checked: accshift never reads the native `auth.json`.

**Limits** (Appendix C.2):
- **Text** from `exec --json` `error` / `turn.failed`, matched on the decoded message strings (Appendix C.2):
  - `You[’']ve hit your usage limit` → scope `account`;
  - `…usage limit for {limit_name}. Switch to another model…` → `model:<limit_name>`;
  - reset from `try again at <t>` (tier 2), where `<t>` is `3:45 PM` today or `Oct 9th, 2026 3:45 PM`, in local time [R04 §2f];
  - `Try again later` → no reset: default backoff (tier 1).
- **Structured** (tier 3): with `--session <thread_id>`, `next`, `mark` and `classify` read that thread's rollout [R04 C17, §2f]. Only events at or after `--run-started-at` count (§9.4).
  - **Lookup.** Rollouts live at `<mainHome>/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>[_<rollout_id>].jsonl[.zst]`. accshift searches only the date directories of the run-start date and the day before, each computed in local time and in UTC (at most four directories); the newest matching file wins. Only plain `classify` (without `--record`) falls back to a full walk of `sessions/`. When the thread's rollout lies elsewhere (for example a thread first created days earlier), `next` and `mark` use the text evidence only. The lookup and the parse run before `state.lock` is taken (§9.3).
  - **Signal.** Tier 3 applies only when the thread's last `token_count` event has `rate_limit_reached_type == "rate_limit_reached"`.
  - **Reset.** The latest `resets_at` (epoch s) among the windows (`primary`, `secondary`) whose `used_percent >= 100`. If no window is at 100, the later of the primary and secondary `resets_at`, with resetConfidence `parsed`.
  - `used_percent`, alone, is never a limit signal [R03 §9]. §9.4 uses the same rule.
- **Workspace exhaustion** → class `blocked` (`needs-attention`), with no limit record [R04 §2f]:
  - `rate_limit_reached_type` `workspace_owner_credits_depleted`, `workspace_member_credits_depleted`, `workspace_owner_usage_limit_reached` or `workspace_member_usage_limit_reached`; `attentionCode` is that value;
  - the texts `Your workspace is out of credits…` (`attentionCode` `workspace-out-of-credits`) and `You hit your spend cap set in your workspace…` (`attentionCode` `workspace-spend-cap`).

**Auth:**
- `…since logged out or signed in to another account…` → `relogin` with reason `rejected`; `refresh_token_expired` or `refresh_token_invalidated` → `relogin` with reason `refresh-dead`. Both apply on the first occurrence; these never heal by themselves (§9.2).
- `refresh token was already used` (`refresh_token_reused`) loses a race more often than it reports a dead login [R04 C13]. It is definitive (`refresh-dead`) only if the account's `auth.json` was **not** rewritten after the failing run started: `next` and `mark` read its mtime and `last_refresh` offline, before the lock, and compare them with `--run-started-at`. For a `native` account only the mtime is used (a stat; the native file is never opened). If either value is at or after that time, the failure is transient: no strike and no record, and the caller MAY retry the same account once. This applies to `home` and `native` accounts alike. In keyring, auto or Windows secrets mode there is no `auth.json` to check, so the text counts as an ambiguous strike (§9.2).
- A plain 401 → an ambiguous strike (§9.2).

**Concurrency:**
- Different accounts are fully parallel.
- Two processes that use one Codex home race the single-use refresh rotation [R09 §1.4, #48507, R04 C13]: two accshift runs of the same account, or a `native` run next to the user's own codex, IDE extension or daemon on `mainHome`. The loser may report `refresh token was already used` while `auth.json` already holds the winner's valid token.
- v1 does **not** stagger same-account runs. On the execve path nothing records an in-flight run, and a pre-launch wait cannot observe Codex's refresh triggers (5 minutes before `exp`, `last_refresh` older than 8 days, or a 401 [R04 §2d]). Instead:
  - the `refresh_token_reused` rule above keeps the loser of a race out of needs-relogin;
  - the README and `doctor` document the race (D5 risks), and `doctor` reports other codex processes on `mainHome` (Doctor, above);
  - V-X7 records what Codex does when two processes in one home refresh at once.
- A later version may add a per-overlay holder file on the spawn path.

**Session portability** (`Portability(from, to)` per move, §8, D5):
- a different `chatgptAccountId`, or one accshift does not know (`native`, keyring or auto store, `access-token`, `api-key`) → `unlikely`, so `sessionPortable:false`. LimitShift starts New plus the handoff note directly, without attempting a resume;
- the same `chatgptAccountId` (two users of one workspace) → `possible`, which also gives `sessionPortable:false`;
- there is no `yes` case across codex accounts: accshift keeps no record of which account created a thread. Only `from` = `to` is `yes` (§8).
- As a safety net, `classify` maps `invalid_encrypted_content`, `could not be verified` and `organization_id did not match` to `resume-incompatible`.
- `codex exec resume` of an unknown thread id → `session-lost`. Its exact text is **VERIFY V-X5**.
- **VERIFY V-X1.**

---
