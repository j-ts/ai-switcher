# Research track: cli-claude-codex

_Research date: 2026-10-07. Claims are marked VERIFIED (evidence gathered during the research) or INFERRED._

## Summary

Evidence comes from the packages released today: Claude Code 2.1.293 (I inspected the linux-x64, darwin-arm64 and win32-x64 Bun binaries) and Codex CLI 0.161.0 (linux-x64 binary plus the matching Apache-2.0 source at tag rust-v0.161.0). Claude: the current design hypothesis holds. The best primary method is one `claude setup-token` token per account, passed in as CLAUDE_CODE_OAUTH_TOKEN, with the normal ~/.claude kept shared. The token lasts 1 year, has only the `user:inference` scope and no refresh token, and Claude Code never writes it to disk. Transcripts carry no account binding, and the docs say thinking signatures work across platforms, so resuming a session under another account should work (still needs a real-account test). The token cannot show plan utilization (/usage needs the `user:profile` scope). But every API response's rate-limit headers reach stream-json as `rate_limit_event` (status/resetsAt/rateLimitType/utilization), so accshift can still track each account's headroom. Credential storage is confirmed: Linux uses plaintext `.credentials.json` only. macOS uses the Keychain via `security`, with service `Claude Code[-suffix]-credentials[-sha256(dir)[0:8]]` and account $USER, falling back to plaintext. Windows uses `.credentials.json` unless Credential Manager is switched on by a flag (CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1 or GrowthBook `tengu_windows_credman`). CLAUDE_SECURESTORAGE_CONFIG_DIR is real but undocumented: it moves only the credential slot, while `oauthAccount` stays in the shared .claude.json. The documented way to run several accounts is CLAUDE_CONFIG_DIR. Codex: auth.json lives in CODEX_HOME (default store "file"). Keyring entries are keyed by sha256 of the canonical CODEX_HOME path, so a separate CODEX_HOME per account works in every store mode. Refresh tokens are single-use, so accshift must never duplicate an auth.json. Codex has no way to move sessions/ to another directory. Sharing therefore needs a per-account overlay home with links to the main ~/.codex, plus CODEX_SQLITE_HOME pointing at the main home. One part of the hypothesis is wrong: `codex exec --json` carries no structured rate-limit fields, only error/turn.failed messages with the text "You’ve hit your usage limit … Try again at 3:45 PM." (curly apostrophe). Structured windows live in the rollout file's token_count events and in `codex app-server` `account/rateLimits/read`, which reads usage without sending a prompt. Resuming a Codex session under a different account will probably fail, because encrypted reasoning is tied to the organization ("Encrypted content organization_id did not match the target organization"). LimitShift must expect a fallback to a new session plus a handoff prompt for codex. CODEX_ACCESS_TOKEN only covers Business/Enterprise access tokens ("at-…") or Agent Identity JWTs, and OPENAI_API_KEY is not used for Codex auth at all.

## Conclusions

| # | Claim | Status | Confidence | Evidence | What the spec should do |
|---|---|---|---|---|---|
| 1 | On Linux, Claude Code 2.1.293 stores OAuth credentials only in plaintext <dir>/.credentials.json (mode 0600). It never uses libsecret. dir = CLAUDE_SECURESTORAGE_CONFIG_DIR (an empty value means ~/.claude), else CLAUDE_CONFIG_DIR, else ~/.claude. The write lock file is <dir>/.storage-write. | VERIFIED | high | linux-x64 bundle: `var O;function Sbr(){return"file"}function Gn(){if(O)return O;return C}`, where C = {name:"plaintext"}. O is never assigned and nothing exports a setter. The keychain branch is constant-folded to `let s=!1;if(s){...}`. The plaintext backend writes with mode 384 plus chmod 384. | On Linux, accshift can treat each Claude slot as a directory. In token mode Claude writes no credentials at all. |
| 2 | On macOS, Claude stores credentials in the Keychain via the `security` CLI, with service `Claude Code<OAUTH_FILE_SUFFIX>-credentials[-<sha256(dir)[0:8]>]` and account `$USER`. The account falls back to the OS username and then to `claude-code-user`. If a Keychain write fails it falls back to plaintext. The hash suffix is added only when CLAUDE_SECURESTORAGE_CONFIG_DIR is non-empty or CLAUDE_CONFIG_DIR is set. The hash covers the raw NFC string with no path resolution. | VERIFIED | high | darwin-arm64 bundle: `function zn(){if(K)return K;return M(b,T)}` (keychain with plaintext fallback). It calls `security find-generic-password -a <FT()> -w -s <FF(A_e)>` and `add-generic-password -U -a .. -s .. -X <hex>` via `security -i`. `FF()` and `FT()` code as quoted in the report. Docs say the Keychain entry is keyed to CLAUDE_CONFIG_DIR. | accshift must pass the same absolute path string every time, or the Keychain entry changes. Its `remove` can delete the slot with `security delete-generic-password -a $USER -s <name>`. |
| 3 | On Windows, Claude uses %USERPROFILE%\.claude\.credentials.json by default. It uses Credential Manager (via Bun.secrets, service `Claude Code-credentials[-hash]`, name `claude-code-user`, with plaintext fallback) only when CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1 or the GrowthBook flag tengu_windows_credman is cached true. | VERIFIED | high | win32-x64 bundle: `function Gn(){if(z)return z;if(BFn())return K(x,T);return T}`, `function BFn(){if(process.env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN==="1")return!0;...tengu_windows_credman}`, `function TH(){return"claude-code-user"}`, `I(){return{service:cQ(ZNe),name:TH()}}`. | accshift must not assume where Windows credentials live. Token mode avoids the question entirely. |
| 4 | `claude setup-token` creates a 1-year (31536000 s) OAuth access token with only the user:inference scope and no refresh token. It never saves the token, and it does not write oauthAccount. The token starts with `sk-ant-oat`. | VERIFIED | high | `var LQ=31536000`. `startOAuthFlow(..., {inferenceOnly:_==="setup-token", expiresIn:...LQ})`. On setup-token the code does `B({state:"success",token:me.accessToken,...})` and skips persistence. Text strings seen: `Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>` and `(1-year)`. `isAnthropicOAuthToken=e=>e.startsWith("sk-ant-oat")`. Docs: "It does not save the token anywhere." | accshift add (claude) runs setup-token in a TTY, then reads the pasted token and stores it. Track expiry at created+365 days and warn early. |
| 5 | CLAUDE_CODE_OAUTH_TOKEN works for -p, json/stream-json, interactive mode and --resume. It is ignored in --bare/CLAUDE_CODE_SIMPLE mode, and ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY (always in -p), apiKeyHelper and the CLAUDE_CODE_USE_* provider variables all override it. Inference-only tokens get no /usage plan percentages, no Remote Control, no claude.ai connectors and no Claude in Chrome. | VERIFIED | high | Docs authentication precedence list and env-var table. Code `Fl()`, `mCt()`, `nl()`, `iE()`. Help text for --bare. Schema text: `rate_limits_available: False when ... missing profile scope`. Remote Control string `limited to inference-only`. | accshift exec must strip ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY, CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, CLAUDE_CODE_SIMPLE, ANTHROPIC_PROFILE and ANTHROPIC_FEDERATION_RULE_ID. doctor must warn when settings define apiKeyHelper. Never add --bare. |
| 6 | CLAUDE_CODE_RETRY_WATCHDOG makes Claude wait out usage-limit resets internally instead of failing. | VERIFIED | medium | The binary has `function DV(){return a.CLAUDE_CODE_RETRY_WATCHDOG}`, and the 429 retry path uses resetsAt. The docs env text says the watchdog "backs off ... until the limit resets when the response carries a rate-limit reset time, so a session that hits a usage limit waits out the remaining window". | accshift (and limitshift) must unset CLAUDE_CODE_RETRY_WATCHDOG in the child env so a limit surfaces immediately. |
| 7 | CLAUDE_SECURESTORAGE_CONFIG_DIR exists and moves only the credential slot (file, Keychain hash, lock). Config, .claude.json (including oauthAccount) and transcripts stay in the shared CLAUDE_CONFIG_DIR. It is undocumented. | VERIFIED | high | Code for `lw()` and `Oce()`. It is forwarded to teammate subprocess env and kept in the persisted-job env allow-list. It is absent from code.claude.com/docs/en/env-vars (WebFetch). | Use it only as an experimental fallback login-slot mode. Capture `claude auth status --json` right after each login, because the shared oauthAccount shows whichever account logged in last. |
| 8 | Using an env token does not overwrite oauthAccount in the shared .claude.json. The bootstrap merge refuses a different account_uuid, and inference-only tokens get a 403 that skips the bootstrap write. | VERIFIED | medium | `function q(e,n){if(!e\|\|!n)return e;if(n.account_uuid!=null&&n.account_uuid!==e.accountUuid)return e;...}` and the log string `[Bootstrap] Skipped: 403 for OAuth token without profile scope`. | Token rotation is safe for the user's normal login and config. No backup or restore of .claude.json is needed. |
| 9 | Claude transcripts live at <configDir>/projects/<cwd with non-alphanumerics replaced by '-', capped at 200 chars + hash>/<sessionId>.jsonl and carry no account binding. Thinking signatures work across platforms, and Claude Code heals invalid-signature errors, so cross-account --resume is expected to work. | INFERRED | medium | Sanitizer `k(e){return e.replace(/[^a-zA-Z0-9]/g,"-")}` with 200-char truncation (verified). Projects path `join(CLAUDE_CONFIG_DIR??~/.claude,"projects")` (verified). Docs: "signature values are compatible across platforms" (verified). Heal path `thinking_signature`/`rejected_healed` (verified). No local-resume account check found by grep. Runtime behaviour is untested. | limitshift can rotate a Claude account and continue with --resume <session_id>, but needs a real-account test and should keep the handoff-prompt fallback. |
| 10 | Claude usage-limit text has the form `You've hit your <session limit\|weekly limit\|Opus limit\|Sonnet limit\|Fable limit\|usage credit limit> · resets <time> (<TZ>)`, where time is `3pm`/`3:30pm` within 24 h, otherwise `Oct 9, 3pm`. Structured data comes from the stream-json `rate_limit_event` (status/resetsAt in epoch seconds/rateLimitType/utilization) and from assistant `error:"rate_limit"`. | VERIFIED | high | Function `kk()`, map `Bwe`, prefix array `Ibr`, formatter `Ju()`, and `iUo()` building `{type:"rate_limit_event",rate_limit_info,uuid,session_id}` from the anthropic-ratelimit-unified-* headers. The assistant `error` enum was seen in the SDK schema. | Detect limits from rate_limit_event (status rejected → resetsAt) first, then fall back to a text regex. Record per-account utilization from each event so the selector can pick the account with the most headroom. |
| 11 | `claude auth` has the subcommands login (--claudeai, --console, --email, --sso), status (--json default, --text) and logout. status --json is offline and includes email/orgId/orgName/subscriptionType only for claude.ai logins. With an env token it shows authMethod `oauth_token` and no email. An inference-only token's identity cannot be verified without a model call. | VERIFIED | high | `--help` output from 2.1.293 and the `authStatus` function code; endpoint scope notes for /api/oauth/validate, /usage and profile. | accshift records Claude token identity as user-asserted metadata. `accshift status` reports token validity as unknown until the first run. A full login-slot can be verified with `claude auth status --json`. |
| 12 | Codex auth.json lives at $CODEX_HOME/auth.json with fields auth_mode, OPENAI_API_KEY, tokens{id_token,access_token,refresh_token,account_id}, last_refresh, agent_identity, personal_access_token, bedrock_*. cli_auth_credentials_store is file (default), keyring, auto or ephemeral. The keyring service is `Codex Auth` with account `cli\|<sha256(canonical CODEX_HOME)[0:16]>`. On Windows the keyring/auto modes default to an encrypted secrets/codex_auth.age file whose key is in keyring service `codex`, account `secrets\|<16hex>`. | VERIFIED | high | codex-rs/login/src/auth/storage.rs, config/src/types.rs, secrets/src/lib.rs, and features (secret_auth_storage default_enabled cfg!(windows)). The packaged defaults string `cli_auth_credentials_store = "file"` and the strings 'Codex Auth', 'cli\|', 'secrets\|' and 'codex_auth.age' are present in the 0.161.0 binary. | Every store is keyed by CODEX_HOME, so per-account CODEX_HOME isolates credentials in all modes. The swap fallback only supports file mode. |
| 13 | Codex refresh tokens are single-use and rotate on every refresh. auth.json is rewritten non-atomically on login, on refresh (access token within 5 min of exp, or last_refresh older than 8 days, or on 401) and on logout. | VERIFIED | high | manager.rs: CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES=5 and TOKEN_REFRESH_INTERVAL=8. persist_tokens() loads, replaces and saves. Error mapping refresh_token_reused → 'refresh token was already used' (string seen in the binary). FileAuthStorage::save uses truncate+write with mode 0600. | Never duplicate an auth.json. Treat the main ~/.codex as account #0 and make 'import' a move. Retry JSON parse when reading auth.json concurrently. Never swap under a running process. |
| 14 | Codex has no sessions-dir override. The only relocatable state is the sqlite DBs (sqlite_home config, then CODEX_SQLITE_HOME env, then CODEX_HOME) and log_dir. CODEX_HOME must exist and is canonicalized. Config edits follow symlinks, and the rollout code has no symlink checks. | VERIFIED | high | config_toml.rs keys, core/src/config/mod.rs (`cfg.sqlite_home.or(sqlite_home_env).unwrap_or(codex_home)`, SQLITE_HOME_ENV="CODEX_SQLITE_HOME"), utils/home-dir find_codex_home canonicalize, edit.rs resolve_symlink_write_paths, and an empty grep for 'symlink' in rollout/state/history. | Use a per-account overlay home that links shared entries to the main ~/.codex and sets CODEX_SQLITE_HOME to the main home. Keep auth.json, secrets/, models_cache.json, daemon dirs, arg0/, tmp/ and .tmp/ per account. |
| 15 | allow_symlinked_codex_home only lets the macOS Seatbelt sandbox accept symlinked writable roots under CODEX_HOME. It has no effect on Linux or Windows and does not enable symlinked homes in general. | VERIFIED | high | config_toml.rs doc comment: "This setting has no effect on Linux or Windows." Only sandboxing/src/seatbelt.rs consumes it. | On macOS, keep any sandbox-writable dir under CODEX_HOME per-account (unlinked), or document setting allow_symlinked_codex_home=true in the shared config. |
| 16 | The interactive Codex TUI in 0.161 auto-starts a shared app-server daemon per CODEX_HOME (socket at $CODEX_HOME/app-server-control/app-server-control.sock; daemon_auto_start defaults to true). codex exec does not use it, and --no-daemon disables it. | VERIFIED | high | tui/src/startup_orchestration.rs auto_start_daemon, the features list (daemon_auto_start default_enabled true), app-server-transport constants, and no daemon references in exec/src. | Per-account overlays get per-account daemons, so app-server-control/ and app-server-daemon/ must never be linked. Phase-2 interactive runs should pass --no-daemon. The swap fallback must refuse while a daemon is running. |
| 17 | `codex exec --json` emits only thread.started, turn.started, turn.completed{usage}, turn.failed{error.message}, item.*, and error{message}. It has no rate_limits or resets_at fields. Usage limits appear as text such as `You’ve hit your usage limit. ... Try again at 3:45 PM.` (curly apostrophe), and the dated form beyond today is `Oct 9th, 2026 3:45 PM`. Exit code is 1. | VERIFIED | high | exec/src/exec_events.rs and event_processor_with_jsonl_output.rs. protocol/src/error.rs UsageLimitReachedError Display, retry_suffix and format_retry_timestamp. 'You’ve hit your usage limit' found twice in the 0.161.0 binary. | The limit regex must accept ' and ’ and both time formats. For resets_at, read the last token_count.rate_limits in the rollout file (primary/secondary resets_at in epoch seconds) or use app-server account/rateLimits/read. |
| 18 | Codex can report account identity and remaining usage without a prompt. id_token claims give email, plan, user and account ids offline. `codex app-server` JSON-RPC methods `account/read` and `account/rateLimits/read` return email/planType and the rate-limit windows from ChatGPT /wham/usage. `codex login status` prints only `Logged in using ChatGPT` to stderr. | VERIFIED | medium | token_data.rs claim names. app-server-protocol common.rs (GetAccount => "account/read", GetAccountRateLimits => "account/rateLimits/read") and v2/account.rs response types. cli/src/login.rs run_login_status. The app-server is labelled [experimental] in --help, and its runtime behaviour is untested. | accshift add/list decode the id_token locally. An optional `accshift status --probe` uses the app-server for codex utilization and must degrade gracefully if that interface changes. |
| 19 | Resuming a Codex session created under ChatGPT account A while logged in as account B will likely fail with invalid_encrypted_content (`The encrypted content ... could not be verified` / `Encrypted content organization_id did not match the target organization`). Codex always sends encrypted reasoning and compaction items back to the API. | INFERRED | medium | Verified: core/src/client.rs always sets include ["reasoning.encrypted_content"]; the OpenAI community thread (2026-02-22) and issue #3942 report this for ChatGPT→API key; issues #20004 (open), #8145 and #17541. Not verified: the ChatGPT-A to ChatGPT-B case specifically. No stripping logic was found in 0.161 source. | After a Codex rotation, limitshift must expect resume to fail and fall back to a fresh session with a handoff prompt. accshift should report codex `same_conversation_after_rotation: unlikely` until a real-account test proves otherwise. |
| 20 | CODEX_ACCESS_TOKEN is read on every auth load. It ranks above auth.json, below CODEX_API_KEY (exec only) and below the ephemeral host-supplied store. With prefix `at-` it is a Business/Enterprise workspace access token validated via auth.openai.com whoami; otherwise it is decoded as an Agent Identity JWT. OPENAI_API_KEY is not used for Codex auth at runtime. | VERIFIED | high | manager.rs load_auth order, access_token.rs PERSONAL_ACCESS_TOKEN_PREFIX="at-", personal_access_token.rs whoami endpoint, and a grep of OPENAI_API_KEY uses (onboarding/doctor/sandbox only). Docs: access tokens are "currently supported for ChatGPT Business and Enterprise workspaces". | Offer an optional codex account kind `access-token` for Business/Enterprise users (env injection, no CODEX_HOME). Scrub CODEX_API_KEY and CODEX_ACCESS_TOKEN when running a chatgpt-home account. Personal Plus/Pro accounts require the CODEX_HOME approach. |

## Full report

# Track `cli-claude-codex`: how Claude Code and Codex CLI store and select accounts, sessions and limits

**Date:** 2026-10-07. Every claim is tagged **[V]** (VERIFIED: I saw the evidence today, cited) or **[I]** (INFERRED: reasoning or memory, said so).

---

## 0. Method and artifacts

| Item | Value |
|---|---|
| Claude Code | `npm view @anthropic-ai/claude-code` gives `latest=2.1.293`, `next=2.1.293`, `stable=2.1.285`, published 2026-10-07T17:18Z. Meta package `bin: claude -> bin/claude.exe`, postinstall `install.cjs`. 8 optionalDependencies: darwin-arm64, darwin-x64, linux-x64, linux-arm64, linux-x64-musl, linux-arm64-musl, win32-x64, win32-arm64 **[V]** |
| Claude binaries inspected | linux-x64 `package/claude` 252,755,128 B (ELF, Bun single-file, JS source embedded); darwin-arm64 `claude` 236,330,608 B; win32-x64 `claude.exe` 256,155,808 B **[V]** |
| Codex CLI | `npm view @openai/codex` gives `latest=0.161.0`, published 2026-10-07T16:05–16:16Z. Platform builds are published as versions of the same package (`@openai/codex@0.161.0-linux-x64`, aliased as `@openai/codex-linux-x64`). The linux-x64 tarball unpacks to 450,401,234 B. `vendor/x86_64-unknown-linux-musl/bin/codex` is 292,309,256 B, plus `codex-code-mode-host` (74 MB), `codex-voice-host` (65 MB), `rg`, `bwrap`, `zsh` **[V]** |
| Codex source | `git clone --depth 1 --branch rust-v0.161.0 https://github.com/openai/codex` gives commit `979011409de0a60b52f179721948e65531d26144` (2026-10-06). I cross-checked key strings against the 0.161.0 binary: `Codex Auth`, `cli\|`, `secrets\|`, `codex_auth.age`, `CODEX_SQLITE_HOME`, `state_5.sqlite`, `app-server-control.sock`, `You’ve hit your usage limit`, `account/rateLimits/read`, `wham/usage`, `refresh token was already used` are all present **[V]** |
| How binaries were run | Only `--version` / `--help`, with `env -i HOME=<empty> XDG_*=<empty> CODEX_HOME=<empty>`, never logged in. Output: `2.1.293 (Claude Code)`, `codex-cli 0.161.0` **[V]** |
| Tool | Small python mmap/regex context extractor run on the binaries (`grep -a`-style). Downloads were deleted afterwards. |

Clean-room: I did not open agm or Hawkynt code. From /home/user/ai-switcher I read only `launcher/ais-run.mjs` (header) and `launcher/ais-limits.mjs` (grep), as requirements context.

---

## 1. Claude Code 2.1.293

### 1a. Credential storage per OS; CLAUDE_CONFIG_DIR and CLAUDE_SECURESTORAGE_CONFIG_DIR

Code from the linux-x64 bundle (minified names). The same logic appears in the darwin and win32 bundles under other names **[V]**:

```js
// config dir
var we=So(()=>(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(),".claude")).normalize("NFC"))
// secure-storage dir
function lw(){let e=process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;if(e!==void 0)return(e||join(homedir(),".claude")).normalize("NFC");return we()}
// keychain / credman service name
function Oce(e=""){let n=process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,t=n!==void 0?!n:!process.env.CLAUDE_CONFIG_DIR,
  r=n!==void 0?n.normalize("NFC"):we(),c=t?"":`-${sha256(r).hex.substring(0,8)}`;return`Claude Code${OAUTH_FILE_SUFFIX}${e}${c}`}  // e = "-credentials"
// keychain account
function fW(){let e;try{e=process.env.USER||os.userInfo().username}catch{e="claude-code-user"}if(!/^[a-zA-Z0-9._-]+$/.test(e))return"claude-code-user";return e}
```

`OAUTH_FILE_SUFFIX` is `""` in prod, `-staging-oauth`, `-local-oauth` or `-custom-oauth` (the last when CLAUDE_CODE_CUSTOM_OAUTH_URL is set) **[V]**.

| OS | Backend actually selected | Location / name |
|---|---|---|
| Linux | **plaintext only**. `function Gn(){if(O)return O;return C}` where C = `{name:"plaintext"}`. `O` is never assigned in the linux build, and the keychain branch is constant-folded to `let s=!1;if(s){...}` **[V]** | `<lw()>/.credentials.json`, mode 0600 (`_n(n,…,384)` + `chmod 384`). Write lock file `<lw()>/.storage-write` (proper-lockfile style, stale 15 s). Warning text: `Warning: Storing credentials in plaintext.` **[V]**. Claude does **not** use libsecret. |
| macOS | `function zn(){if(K)return K;return M(b,T)}`: Keychain (`b`, name `"keychain"`) with plaintext fallback (`T`) **[V]** | `security find-generic-password -a <fW()> -w -s <Oce("-credentials")>`. Writes go through `security -i` on stdin, `add-generic-password -U -a "<acct>" -s "<svc>" -X "<hex(JSON)>"`. If the payload is larger than 4032 chars it falls back to argv. Delete is `security delete-generic-password -a … -s …`. Exit 44 = not found; 36 = locked/interaction not allowed **[V]**. Default service: `Claude Code-credentials`. With a custom dir: `Claude Code-credentials-<8 hex>` **[V]**. Docs agree: Keychain, and when a Keychain write is rejected, `~/.claude/.credentials.json` 0600; "keys the macOS Keychain entry to that directory" **[V docs]** |
| Windows | `function Gn(){if(z)return z;if(BFn())return K(x,T);return T}` **[V]** | Default: `<lw()>\.credentials.json` (`%USERPROFILE%\.claude\.credentials.json`). Credential Manager (`x`, name `"windows-credman"`, uses `Bun.secrets`, payload chunked if large) is used **only if** `CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1` or `.claude.json` has `cachedGrowthBookFeatures.tengu_windows_credman===true`. Then the target is `service="Claude Code-credentials[-hash]"`, `name="claude-code-user"` (constant on Windows), with plaintext fallback **[V]** |

What is stored: a JSON "SecureStorageData" object whose `claudeAiOauth` holds `accessToken, refreshToken, expiresAt, refreshTokenExpiresAt, scopes, subscriptionType, rateLimitTier`. Other keys share the same blob, e.g. MCP OAuth and `coworkRemoteDevice` **[V field names in code]**.

Roles of the two variables:
- **CLAUDE_CONFIG_DIR** (documented). It moves everything: settings, `projects/` transcripts, plugins, the global config file `<CLAUDE_CONFIG_DIR>/.claude.json` (`yvr(){return join(process.env.CLAUDE_CONFIG_DIR||homedir(), ".claude"+H4()+".json")}`; the legacy `<configDir>/.config.json` wins if present), and the credential slot. Docs: "Log in with multiple accounts … give each account its own configuration directory … `alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'`" **[V docs]**.
- **CLAUDE_SECURESTORAGE_CONFIG_DIR** (**undocumented**: absent from code.claude.com/docs/en/env-vars **[V]**). It moves **only** the credential slot: `.credentials.json` dir, Keychain/credman service hash, and the write lock. CLAUDE_CONFIG_DIR, `.claude.json` (incl. `oauthAccount`) and transcripts stay shared. It is a deliberate internal feature: it is forwarded to teammate/sub-processes (`CLAUDE_SECURESTORAGE_CONFIG_DIR=${…}` in the spawn env builder), listed in the persisted-job env allow-list, and even an empty value is preserved **[V]**. Edge cases: set but empty gives the default `~/.claude` with no hash suffix. The hash covers the **raw NFC string** with no path resolution, so accshift must always pass the same absolute string (no trailing slash, no `~`) **[V]**.

### 1b. `claude setup-token`

- Help: `setup-token   Set up a long-lived authentication token (requires Claude subscription)`, no options **[V `--help`]**.
- Flow: the same browser OAuth as `/login` with `inferenceOnly: true` and `expiresIn: LQ` where `var LQ=31536000` (365 days). UI text: `This will guide you through long-lived (1-year) auth token setup for your Claude account. Claude subscription required.` On success: `✓ Long-lived authentication token created successfully!`, `Your OAuth token (valid for …):`, `Store this token securely. You won't be able to see it again.`, `Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>` **[V]**.
- **It does not store anything.** For `setup-token` the code does `B({state:"success",token:me.accessToken,expiresAt:me.expiresAt})` and skips `rUe(...)` (persist) and the oauthAccount write. Docs: "It does not save the token anywhere" **[V code + docs]**.
- Token prefix: `isAnthropicOAuthToken = e => e.startsWith("sk-ant-oat")` **[V]**. The token is opaque, not a JWT, so its identity can't be decoded offline **[I]**.
- Scopes: when an env token is used, Claude materialises it as
  ```js
  function BK(){if(a.CLAUDE_CODE_OAUTH_TOKEN)return{accessToken:a.CLAUDE_CODE_OAUTH_TOKEN,refreshToken:null,expiresAt:null,
    scopes:Ik() /* CLAUDE_CODE_OAUTH_SCOPES split, else ["user:inference"] */,
    subscriptionType:a.CLAUDE_CODE_SUBSCRIPTION_TYPE||null, rateLimitTier:a.CLAUDE_CODE_RATE_LIMIT_TIER||null}; …}
  ```
  A full login asks for `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload [user:plugins]` (+ `org:create_api_key` for console) **[V]**.
- Limitation strings **[V]**: `Long-lived tokens (from \`claude setup-token\` or CLAUDE_CODE_OAUTH_TOKEN) are limited to inference-only for security reasons. Run \`claude auth login\` to use Remote Control.`; `env-var and setup-token sessions default to user:inference only` (Claude in Chrome disabled); docs: "It can only make model requests, so it can't establish Remote Control sessions or fetch claude.ai connectors. MCP servers you configure locally still work." `/usage` schema: `rate_limits_available: False when plan rate limits do not apply (API key, Bedrock, Vertex, or missing profile scope) — rate_limits will be null.`

Feature matrix for an env token:

| Use | Works? | Evidence |
|---|---|---|
| `-p` / `--print` | yes | docs ("CI pipelines and scripts") **[V]** |
| `--output-format json` / `stream-json` | yes | output format does not depend on auth **[I]** |
| `--resume <id>`, `-c` | yes | transcripts are local under the config dir; no account binding found (see 1d) **[I, strong]** |
| interactive TUI | yes | docs env table: "Unless you run /login, Claude Code uses the token you set for the whole session" **[V]**. Running `/login` inside the session switches that session to the stored login **[V docs]** |
| `/usage` plan utilization | **no**: `/usage` falls back to session cost. The plan block needs `_t() && (hr()!==null \|\| xf())`; `xf()` = scopes include `user:profile`, and `/api/oauth/usage` needs the profile scope | **[V code]** |
| `--model` | yes. With an env token, `subscriptionType` is null unless `CLAUDE_CODE_SUBSCRIPTION_TYPE` (undocumented) is set, which may change plan-dependent defaults and message wording. **Recommend always passing `--model` explicitly** | **[V code / I effect]** |
| Remote Control, claude.ai connectors, Claude in Chrome, cloud sessions | no | **[V]** |
| `--bare` / `CLAUDE_CODE_SIMPLE=1` | **token ignored** ("OAuth and keychain are never read") | **[V help + docs]** |
| Limited by that account's subscription | yes ("authenticates with your Claude subscription … requires a Pro, Max, Team, or Enterprise plan"); rate-limit headers are per account | **[V docs / I]** |
| Expiry handling | no refresh. On 401: `This session authenticates with the CLAUDE_CODE_OAUTH_TOKEN environment variable, which has no refresh token — it cannot self-heal and has likely expired or been revoked. Mint a fresh token with \`claude setup-token\`…`. `qps()` keeps the user env token rather than silently adopting the stored login (`OAuth 401: keeping the user-supplied CLAUDE_CODE_OAUTH_TOKEN instead of adopting the stored credential`) | **[V]** |

**Precedence.** Docs list: 1 cloud provider (`CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`), 2 `ANTHROPIC_AUTH_TOKEN`, 3 `ANTHROPIC_API_KEY` (in `-p` "always used when present"; interactive only after approval), 4 `apiKeyHelper`, 5 `CLAUDE_CODE_OAUTH_TOKEN`, 6 Anthropic profile / federation (`ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`+`ANTHROPIC_ORGANIZATION_ID`), 7 `/login` credentials **[V docs]**. The code agrees:
- `Fl()` order: bare mode, then `ANTHROPIC_AUTH_TOKEN`, then `CLAUDE_CODE_OAUTH_TOKEN`, then `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`/`CCR_OAUTH_TOKEN_FILE`, then apiKeyHelper, then profile, then stored `claude.ai`.
- `mCt()` drops the OAuth source whenever an API-key source is active. In `-p`, `iE()` returns `ANTHROPIC_API_KEY` directly.
- `nl()` (subscriber auth) is false if `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`apiKeyHelper` is present **[V]**.

Other variables that matter:
- `CLAUDE_CODE_RETRY_WATCHDOG`. With it, Claude retries 429s "indefinitely … until the limit resets when the response carries a rate-limit reset time, so a session that hits a usage limit waits out the remaining window" **[V docs + binary]**. accshift must **unset** it so the CLI fails fast.
- `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` + `CLAUDE_CODE_OAUTH_SCOPES`: `claude auth login` exchanges the refresh token without a browser **[V docs]**.
- `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`: reads the token from an fd (`/proc/self/fd/N` or the inherited pipe). It ranks **below** the stored login in `BK()` unless certain modes apply, so don't rely on it **[V]**.

### 1c. `.claude.json` (global config) and whether a token changes it

Location: `<CLAUDE_CONFIG_DIR or $HOME>/.claude.json` **[V]**. Relevant keys seen in code **[V]**:
- `oauthAccount{accountUuid,emailAddress,organizationUuid,organizationName,organizationRole,workspaceRole,displayName,fullName,billingType,hasExtraUsageEnabled,accountCreatedAt,subscriptionCreatedAt,ccOnboardingFlags,seatTier,planDisplayName,organizationType,organizationRateLimitTier,userRateLimitTier,profileFetchedAt,claudeCodeTrial*}`
- `hasCompletedOnboarding`, `lastOnboardingVersion`, `projects[<path>].hasTrustDialogAccepted`, `hasCompletedProjectOnboarding`
- `customApiKeyResponses{approved,rejected}`, `primaryApiKey`, `subscriptionNoticeCount`, `hasAvailableSubscription`, `userID`
- caches: `additionalModelOptionsCache`, `modelAccessCache`, `orgModelDefaultCache`, `clientDataCacheSlots`, `cachedGrowthBookFeatures`

Effect of using an env token:
- Login writes `oauthAccount` (`_8t({...})`). **setup-token does not.** An env token never writes credentials **[V]**.
- The bootstrap merge `q(old, resp)` refuses to merge a different account: `if(n.account_uuid!=null&&n.account_uuid!==e.accountUuid)return e`. So account B's token cannot overwrite account A's `oauthAccount` **[V]**.
- With an inference-only token the bootstrap call gets 403 and is skipped: `[Bootstrap] Skipped: 403 for OAuth token without profile scope` **[V]**.
- Shared caches (model options/access) may still be refreshed by whichever credential can fetch them **[I]**.
- `Hn()` reads `oauthAccount` from the config, so with an env token the "current account" in telemetry/GrowthBook is the main login's identity. Harmless for personal use **[I]**.

### 1d. Session and transcript storage; resume across accounts

- Path: `<configDir>/projects/<slug(cwd)>/<sessionId>.jsonl`. `slug = cwd.replace(/[^a-zA-Z0-9]/g,"-")`, truncated to 200 chars + `-<base36 hash>` if longer **[V]**. The path depends on CLAUDE_CONFIG_DIR, not on which credential is used, so env-token rotation keeps one shared history **[V]**.
- Account binding: there is no account check on local resume. Account-mismatch strings appear only for cloud features ("cloud session was not found — … signed in to a different account", Remote Control) **[V by grep]**.
- Thinking blocks carry `signature`. Docs: "`signature` values are compatible across platforms (the Claude API, Amazon Bedrock, and Google Cloud). Values generated on one platform work on another." **[V docs]**
- Claude Code also detects `invalid signature in thinking block` (400) and has a heal path that strips thinking blocks and retries (`thinking_signature` / `rejected_healed`) **[V]**.
- So cross-account `--resume` is expected to work **[I, must test]**.
- API-error turns are written as synthetic assistant messages: `isApiErrorMessage:true, error:"rate_limit", apiError:"usage_limit_reached", apiErrorParams.rate_limit_info, quotaLimits` (`Ss({...})`) **[V]**. ai-switcher's detector relied on these transcript lines **[V requirements file]**.

### 1e. Usage-limit messages and fields

**Text.** The builder is `kk(name, suffix)`: `` `You've hit your ${name}${suffix}${progressSaved?" · progress saved":""}` ``. Names: `{five_hour:"session limit", seven_day:"weekly limit", seven_day_opus:"Opus limit", seven_day_sonnet:"Sonnet limit", seven_day_overage_included:"Fable limit", overage:"usage credit limit"}`. The suffix is ` · resets <time>` **[V]**.

Full prefix list used by Claude itself to classify a limit message (`Ibr`) **[V]**: `You've hit your`, `You've reached your`, `You're out of usage credits`, `Your org is out of usage · add funds to continue`, `Your org is out of usage · contact your admin`, `Your seat type doesn't include usage credits`, `Your seat type doesn't include usage`, `Your usage allocation has been disabled by your admin`, `Your group's usage limit is set to $0`, `Fable 5 requires usage credits`, `You're out of extra usage`, `Your seat type doesn't include extra usage`, plus `This service is disabled for your org`. Example: `You've hit your session limit · resets 3pm (Europe/Berlin)`.

**Reset wording** `Ju(epochSec, withTz)`:
- under 24 h away: `toLocaleTimeString("en-US",{hour:"numeric",minute:(m==0?undefined:"2-digit")})` with AM/PM lower-cased and no space, e.g. `3pm` or `3:30pm`
- otherwise: `toLocaleString("en-US",{month:"short",day:"numeric",hour…})`, e.g. `Oct 9, 3pm`, with the year added if different
- then ` (<IANA tz>)` **[V]**

**Structured data.**
- stream-json `{"type":"rate_limit_event","rate_limit_info":{status:"allowed"|"allowed_warning"|"rejected", resetsAt:<epoch s>, rateLimitType:"five_hour"|"seven_day"|"seven_day_opus"|"seven_day_sonnet"|"seven_day_overage_included"|"overage", utilization, overageStatus, overageResetsAt, overageDisabledReason, limitScope, isUsingOverage, …, unifiedWindows{five_hour{utilization,resetsAt},seven_day{…}}}, "uuid","session_id"}`. It is built from the response headers `anthropic-ratelimit-unified-status|-reset|-representative-claim|-overage-status|-overage-reset|-{5h,7d,7d_oi,overage}-{utilization,reset,surpassed-threshold}`, so it also works with inference-only tokens **[V]**.
- Assistant messages carry `error` ∈ `authentication_failed, oauth_org_not_allowed, account_on_hold, verification_required, billing_error, rate_limit, overloaded, invalid_request, model_not_found, server_error, unknown, max_output_tokens, cloud_credential_error` **[V]**.
- The result message on an API error is `subtype:"success"` with `is_error:true`, `api_error_status` (HTTP status), optional `api_error_code`, `api_error` (e.g. `usage_limit_reached`, described as "@internal"), and `result` = the text above **[V code; whether the @internal fields reach stdout is I]**.

### 1f. OAuth refresh (stored logins only)

- Refresh: `POST https://platform.claude.com/v1/oauth/token` with `{grant_type:"refresh_token", refresh_token, client_id, scope}`. The response's `refresh_token` replaces the stored one (`refresh_token:z=e`, i.e. the old one is kept only if none is returned). `refresh_token_expires_in` becomes `refreshTokenExpiresAt` **[V]**.
- On `invalid_grant` the credential is cleared on disk (`tengu_oauth_refresh_token_cleared_on_disk`) **[V]**. So **never copy a `.credentials.json` / Keychain item** between slots. Whether Anthropic rotates on every refresh is **[I]**.
- Writes go to the active secure storage (`lw()` dir / Keychain service) under the `.storage-write` lock **[V]**.
- Setup-token tokens never refresh (`refreshToken:null`) **[V]**.

### 1g. Checking the account without sending a prompt

- `claude auth` subcommands **[V `--help`]**:
  - `login [--claudeai|--console|--email <email>|--sso]`
  - `status [--json (default)|--text]`
  - `logout`
  - plus top-level `setup-token`
- `auth status --json` code **[V]**: `{loggedIn, authMethod: "none"|"third_party"|"claude.ai"|"api_key_helper"|"oauth_token"|"api_key", apiProvider, analyticsDisabled, projectsDirectory, configDirectory, [forcedLoginMethod], [allowedProviders], [apiKeySource], and for claude.ai: email, orgId, orgName, subscriptionType}`. Exit 0 if logged in, else 1. No network in the JSON branch.
  - With an env token it reports `authMethod:"oauth_token"` and **no email**.
  - With a full login it gives email/org from `.claude.json` `oauthAccount`, which under CLAUDE_SECURESTORAGE_CONFIG_DIR is the *last* account that logged in (it is not per slot).
- A setup-token token's identity can't be checked offline, and `/api/oauth/profile`, `/api/oauth/usage` and `/api/oauth/validate` all need non-inference scopes **[V strings]**. accshift must record identity itself at add time.
- For a full-login slot, `claude -p /usage` is a **local** command (`supportsNonInteractive:true`, enabled only when non-interactive) that prints `Current session: N% used · resets …` / `Current week (all models): …` without a model call **[V code]**. LimitShift 1.2.x stopped relying on this **[V limitshift.sh comment]**.

---

## 2. Codex CLI 0.161.0

### 2a. auth.json and credential stores

**Schema** (`login/src/auth/storage.rs`, field names only) **[V]**:
- `auth_mode?` ∈ `apikey | chatgpt | chatgptAuthTokens | headers | agentIdentity | personalAccessToken | bedrockApiKey | bedrockAccessKeys`
- `OPENAI_API_KEY`
- `tokens?{ id_token (JWT string), access_token (JWT), refresh_token, account_id }`
- `last_refresh?`, `agent_identity?`, `personal_access_token?`, `bedrock_api_key?`, `bedrock_access_keys?`

Written with `truncate+write`, mode 0600 on Unix, **not atomic** **[V]**.

**`cli_auth_credentials_store`** values (`config/src/types.rs`) **[V]**:
- `file` (**default**, also in the packaged defaults `cli_auth_credentials_store = "file"`)
- `keyring` (fail if unavailable)
- `auto` (keyring, else file)
- `ephemeral` (in-process memory)

Local dev builds downgrade keyring/auto to file.

| Backend | Service / account / file |
|---|---|
| file | `$CODEX_HOME/auth.json` |
| keyring "Direct" (default on macOS/Linux) | service **`Codex Auth`**, account **`cli\|<first 16 hex of sha256(canonical CODEX_HOME)>`**; after a successful save the fallback auth.json is deleted **[V]** |
| keyring "Secrets" (default on **Windows**: feature `secret_auth_storage` has `default_enabled: cfg!(windows)`) | encrypted file `$CODEX_HOME/secrets/codex_auth.age`, key in keyring service **`codex`**, account **`secrets\|<16 hex sha256(canonical CODEX_HOME)>`** **[V]** |
| OS keyring crates | Linux `keyring` with `linux-native-async-persistent` + `secret-service` (D-Bus Secret Service / kernel keyutils); macOS `apple-native` (Keychain); Windows `windows-native` (Credential Manager) **[V Cargo.toml]** |
| MCP OAuth (separate) | keyring service `Codex MCP Credentials`, key from server name+url (**not** CODEX_HOME); file fallback `$CODEX_HOME/.credentials.json` **[V]** |

Every store is keyed by the **canonical CODEX_HOME path**, so per-account CODEX_HOME separates credentials in all modes **[V]**.

### 2b. CODEX_HOME contents, sharing, `allow_symlinked_codex_home`

- `find_codex_home()`: `$CODEX_HOME` must exist and be a directory, and it is **canonicalized** (symlinks resolved). The default is `~/.codex` (`%USERPROFILE%\.codex`) **[V]**.
- Entries found in source (non-test):

| Entry | Contents |
|---|---|
| `config.toml` (+ `<name>.config.toml` profiles v2) | user config |
| `auth.json` | credentials |
| `sessions/YYYY/MM/DD/rollout-<ts>-<thread_uuid>[_<rollout_id>].jsonl[.zst]` | rollouts; zstd-compressed in the background |
| `archived_sessions/` | archived rollouts |
| `session_index.jsonl` | thread names |
| `history.jsonl` | message history |
| `state_5.sqlite` (+wal/shm), `logs_2.sqlite` | state DBs; location = `sqlite_home` config key > **`CODEX_SQLITE_HOME`** env > CODEX_HOME (`cfg.sqlite_home.or(env).unwrap_or(codex_home)`) |
| `log/codex-tui.log` | log (`log_dir` key) |
| `memories/`, `memories_v2/`, `skills/`, `rules/`, `AGENTS.md`/`AGENTS.override.md`, `hooks.json`, `plugins/`, `themes/`, `worktrees/` | shared customisations and state |
| `models_cache.json`, `version.json` | caches |
| `secrets/` | encrypted secrets |
| `app-server-control/app-server-control.sock` (+`app-server-startup.lock`, `loaded-threads.json`), `app-server-daemon/`, `packages/` | daemon state |
| `arg0/`, `tmp/`, `.tmp/` | helpers and temp |
| `.sandbox*`, `sandbox_users.json` | Windows sandbox |

  **[V]**
- **No sessions-dir override.** No config key or env var relocates `sessions/`. `experimental_thread_store` only offers `Local{}` / `InMemory` **[V]**.
- Symlinks: rollout/state/history code has no symlink checks (`grep symlink` gives nothing), and listing uses `read_dir(codex_home.join("sessions"))`, so a symlinked or junctioned `sessions/` should work **[V absence / I behaviour]**.
- Config edits follow symlinks (`resolve_symlink_write_paths` then `write_atomically`), so a symlinked `config.toml` keeps its link **[V]**.
- The state DB stores absolute rollout paths but verifies the file and falls back to scanning `<home>/sessions` **[V]**.
- **`allow_symlinked_codex_home`**. Doc comment: "Allow macOS sandbox writable roots at or beneath CODEX_HOME to traverse symlinks. Read only from the host's user config at startup; defaults to false. … This setting has no effect on Linux or Windows." Only Seatbelt preparation uses it. The error otherwise is `writable root … contains symlink component …; set allow_symlinked_codex_home = true …` **[V]**.
- **Shared daemon.** The interactive TUI auto-starts a background app-server daemon **per CODEX_HOME** (feature `daemon_auto_start`, default true). `--no-daemon` opts out. `codex exec` does not use it (no `daemon` reference in `exec/src`) **[V]**.
- SessionMeta (the first rollout line) records `creator_user_id` and `creator_account_id` ("ChatGPT account selected when this thread was created. Never updated on resume"). It is metadata only; I found no resume filter on it **[V]**.

### 2c. Login commands and offline identity

- `codex login` uses browser PKCE with a localhost callback on port **1455**. `codex login --device-auth` uses a device code (`<auth>/deviceauth/usercode`, verify at `<base>/codex/device`). `--with-api-key` reads stdin. `--with-access-token` reads stdin. `codex login status` and `codex logout` (revokes tokens, then deletes from all stores) **[V help + source]**.
- `codex login status` prints to **stderr** only: `Logged in using ChatGPT` / `Logged in using an API key - sk-…` / `Logged in using personal access token` / `Logged in using access token` / … with exit 0, or `Not logged in` with exit 1. **No email** **[V]**.
- Offline identity: base64url-decode the `tokens.id_token` payload **[V claim names]**:
  - `email` (or `["https://api.openai.com/profile"].email`)
  - `["https://api.openai.com/auth"]` → `chatgpt_plan_type` (free/go/plus/pro/team/business/enterprise/edu…), `chatgpt_user_id` / `user_id`, `chatgpt_account_id`, `chatgpt_account_is_fedramp`
  - plus `tokens.account_id`; access-token `exp` gives expiry
- No-prompt online probe: `codex app-server` (stdio JSON-RPC; CLI help labels it `[experimental]`). Send `initialize{clientInfo{name,version}}`, then the `initialized` notification, then:
  - `account/read` → `{account:{type:"chatgpt",email,planType}|{type:"apiKey"}…, requiresOpenaiAuth}`
  - `account/rateLimits/read` → `{rateLimits:RateLimitSnapshot, rateLimitsByLimitId, rateLimitResetCredits, accountId, ordinaryUsageAllowed}`, backed by ChatGPT `…/wham/usage`
  
  **[V protocol source; runtime behaviour I]**

### 2d. Refresh and rotation

- Proactive refresh when the access-token JWT `exp` is within **5 min** (`CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES=5`), or, with no `exp`, when `last_refresh` is older than **8 days**. Reactive on 401 **[V]**.
- Endpoint `https://auth.openai.com/oauth/token` (override `CODEX_REFRESH_TOKEN_URL_OVERRIDE`). `persist_tokens()` loads the store, replaces id/access/refresh, sets `last_refresh=now` and saves **[V]**.
- Refresh tokens are **single-use**. Failure reasons `refresh_token_expired` / `refresh_token_reused` / `refresh_token_invalidated` map to `Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.` etc. **[V]**
- A 401 first does a "guarded reload" from storage. If the stored account_id changed: `…because you have since logged out or signed in to another account. Please sign in again.` **[V]**
- Consequences: never keep two copies of one auth.json, and never swap auth.json under a running process.

### 2e. Resuming a session from account A under account B

- Codex always requests `include: ["reasoning.encrypted_content"]` and replays reasoning / compaction items with `encrypted_content` **[V core/src/client.rs]**.
- Reported errors:
  - `The encrypted content … could not be verified` (type `invalid_encrypted_content`)
  - `Encrypted content organization_id did not match the target organization`

  The second comes from switching ChatGPT login to an API key (OpenAI community thread, 2026-02-22; issue #3942) **[V web]**.
- Related issues: #20004 (open, "preserve local history … across providers/accounts"), #8145, #17541 (model switch), #19661 (`codex exec resume` missing encrypted_content), #15219/#19287 (provider restore) **[V web]**.
- Switching ChatGPT account A to ChatGPT account B: **not directly reported, but very likely to fail the same way** (the encrypted blob is bound to the org/workspace) **[I, must test]**.
- The 0.161 source has no handler that strips encrypted items on account change **[V grep]**.

### 2f. Usage-limit formats

- **`codex exec --json`** (`exec/src/exec_events.rs`) emits:
  - `thread.started{thread_id}`
  - `turn.started{}`
  - `turn.completed{usage{input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens}}`
  - `turn.failed{error{message}}`
  - `item.started/updated/completed{item{id,type,…}}`
  - `error{message}`

  **There are no `rate_limits`, `rate_limit_reached_type` or `resets_at` fields in this stream.** Usage limits arrive only as `{"type":"error","message":…}` and `{"type":"turn.failed","error":{"message":…}}`, with process exit 1 **[V]**.
- **Message text** (`protocol/src/error.rs`, note the **U+2019 `’`**) **[V]**:
  - `You’ve hit your usage limit for {limit_name}. Switch to another model now, or try again at {t}.`
  - Plus: `You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at {t}.`
  - Pro / ProLite / ProMax: `You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at {t}.`
  - Free / Go: `You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at {t}.`
  - Team / Business / Enterprise variants: `…send a request to your admin or try again at {t}.`
  - Unknown plan: `You’ve hit your usage limit. Try again at {t}.` / `Try again later.`
  - Workspace: `Your workspace is out of credits…`, `You hit your spend cap set in your workspace…`
  - `{t}` = local time `%-I:%M %p` if today (e.g. `3:45 PM`), else `%b %-d{st|nd|rd|th}, %Y %-I:%M %p` (e.g. `Oct 9th, 2026 3:45 PM`)
- **Structured data** is persisted in the rollout: `event_msg` `token_count` (persisted by policy) carries `rate_limits{limit_id, limit_name, primary{used_percent, window_minutes, resets_at(epoch s)}, secondary{…}, credits{has_credits,unlimited,balance}, individual_limit, spend_control_reached, plan_type, rate_limit_reached_type ∈ rate_limit_reached|workspace_owner_credits_depleted|workspace_member_credits_depleted|workspace_owner_usage_limit_reached|workspace_member_usage_limit_reached}`. `Error` events are *not* persisted **[V rollout/src/policy.rs]**. Old rollouts may be `.jsonl.zst` **[V]**.

### 2g. CODEX_ACCESS_TOKEN and the other env variables

`load_auth()` order **[V]**:
1. `CODEX_API_KEY` (only when `enable_codex_api_key_env`, which is true in `codex exec`)
2. the ephemeral store (host-supplied `chatgptAuthTokens`)
3. **`CODEX_ACCESS_TOKEN`**
4. the persistent store in CODEX_HOME

`CODEX_ACCESS_TOKEN` handling **[V]**:
- With prefix `at-` it is a **Personal/Workspace Access Token**, validated online at `https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami`, which returns email, chatgpt_user_id, chatgpt_account_id, plan.
- Otherwise it is treated as an **Agent Identity JWT** (decoded and verified via JWKS).
- `codex login --with-access-token` persists it in auth.json.
- Docs: "Codex access tokens are currently supported for ChatGPT Business and Enterprise workspaces." Created in the admin console; expiry from 1 day, default max 90 days **[V docs]**. Not available for personal Plus/Pro.

`OPENAI_API_KEY` is **not** read for Codex auth. It is used only for TUI onboarding prefill, doctor, the realtime feature and sandbox env redaction **[V grep]**.

---

## 3. Recommended account-selection mechanism for accshift

### Claude (`claude`)

**Primary: kind `token`.**
- **add:** run `claude setup-token` attached to the user's TTY; the user approves in a browser profile signed in to that account. Then read the pasted token (hidden input or `--token-stdin`) and validate the `sk-ant-oat` prefix. Store: label/email (user-asserted, can't be verified offline), optional plan (`pro`/`max`, used to set `CLAUDE_CODE_SUBSCRIPTION_TYPE`), `created_at`, `expires_at = created_at + 365 d` (warn from about 30 days before). Keep secrets in accshift's own store (OS keychain or 0600 file).
- **exec:** child env = parent env **minus** `ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX, CLAUDE_CODE_USE_FOUNDRY, CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, CLAUDE_CODE_SIMPLE, CLAUDE_CODE_RETRY_WATCHDOG, ANTHROPIC_UNIX_SOCKET, ANTHROPIC_PROFILE, ANTHROPIC_FEDERATION_RULE_ID`, **plus** `CLAUDE_CODE_OAUTH_TOKEN=<token>`. Never add `--bare`. Keep CLAUDE_CONFIG_DIR as the user has it, so history stays shared.
- **doctor:** warn if any settings layer defines `apiKeyHelper` (it outranks the token), or if managed settings force a login method or org.
- **Limit tracking:** prefer `--output-format stream-json`. Record each account's latest `rate_limit_event` (utilization, resetsAt, rateLimitType). On `status:"rejected"`, or an assistant `error:"rate_limit"`, or `result` matching `^(You've hit your|You've reached your|You're out of …)`, mark the account limited until `resetsAt`. Otherwise parse `resets (Mon D, )?H(:MM)?(am|pm) (TZ)`. Rotation keeps the session: `--resume <id>` under the next token.
- **Concurrency:** unlimited. No files are touched.

**Fallback A: kind `login-slot`** (full scopes, e.g. for `/usage` utilization, Remote Control, connectors).
- Each account gets a dedicated absolute dir `S`; run with `CLAUDE_SECURESTORAGE_CONFIG_DIR=S` (identical string every time).
- Login: `CLAUDE_SECURESTORAGE_CONFIG_DIR=S claude auth login`. Immediately afterwards capture `claude auth status --json` (email/orgId/subscriptionType), because shared `.claude.json` `oauthAccount` is overwritten by the next login.
- Storage: macOS Keychain service `Claude Code-credentials-<sha256(S)[0:8]>`, account `$USER`. Linux/Windows `S/.credentials.json`.
- Mark it **experimental/undocumented**. Never copy slot contents (refresh rotation).

**Fallback B (documented): per-account `CLAUDE_CONFIG_DIR`.**
- Link `projects/` (and settings.json, CLAUDE.md, agents/, commands/, skills/, plugins/) back to `~/.claude`: symlinks on POSIX, junctions on Windows.
- Each dir has its own `.claude.json` (onboarding/trust). Use this when the undocumented variable disappears.

### Codex (`codex`)

**Primary: kind `chatgpt-home`** (per-account CODEX_HOME overlay).
- **Layout:** `<accshift-data>/codex/<id>/home/`. Real per-account files: `auth.json`, `secrets/`, `models_cache.json`, `version.json`, `app-server-control/`, `app-server-daemon/`, `packages/`, `arg0/`, `tmp/`, `.tmp/`, `log/`.
- **Links:** for every other entry of the main `~/.codex`, link into the overlay before each run (new entries appear over time), so `config.toml, sessions/, archived_sessions/, history.jsonl, session_index.jsonl, AGENTS.md, rules/, skills/, memories/, plugins/, hooks.json, .credentials.json…` are shared.
- **exec env:** `CODEX_HOME=<overlay>`, `CODEX_SQLITE_HOME=<main ~/.codex>` (shares `state_5.sqlite`/`logs_2.sqlite`). Unset `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`. Pass `--no-daemon` for interactive runs, or accept one daemon per account.
- **The main home is account #0.** Never copy its auth.json into an overlay. "Import" means move. Codex refresh tokens are single-use.
- **add:** `CODEX_HOME=<overlay> codex login` (or `--device-auth` when headless). Then decode the `id_token` claims and de-duplicate on `chatgpt_account_id` + `chatgpt_user_id`.
- **status (no prompt):** optional `codex app-server` JSON-RPC `account/read` + `account/rateLimits/read`. Otherwise read the last `token_count.rate_limits` from the session's rollout file after each run.
- **Limit detection:** `exec --json` gives `error`/`turn.failed` text. The regex must accept `You['’]ve hit your usage limit` and `Try again at (H:MM AM|PM|Mon Dth, YYYY H:MM AM|PM)`; there is also a `Try again later` variant. Then read the rollout `token_count` for `resets_at`.
- **Rotation:** try `codex exec resume <thread_id>` under the next account. If it fails with `invalid_encrypted_content` / `could not be verified` / `organization_id did not match`, **start a fresh session with a handoff prompt**. Expect this to be the normal case for codex.
- **Windows:** directory junctions need no privilege. File symlinks need Developer Mode or admin. Otherwise copy `config.toml` (and `history.jsonl`, `session_index.jsonl`) in before the run and back afterwards if changed.
- **macOS:** if Seatbelt rejects a symlinked writable root under CODEX_HOME, keep that dir per-account or document `allow_symlinked_codex_home = true`.

**Fallback: kind `chatgpt-swap`.**
- Only for `cli_auth_credentials_store="file"` and when no other codex/IDE process or daemon is using `~/.codex`.
- Under an exclusive lock: save the current `auth.json` to the outgoing account (it may have been refreshed), install the incoming one, run with `--no-daemon`, then copy the post-run `auth.json` back to its account record.
- Unsafe with concurrent runs and the VS Code extension. Refuse if the keyring is used.

**Extra kinds:** `codex-access-token` (Business/Enterprise; env `CODEX_ACCESS_TOKEN=at-…`, no home needed) and `api-key` (`CODEX_API_KEY`, `codex exec` only, API billing).

---

## 4. Checking the current design hypothesis

| Hypothesis | Verdict |
|---|---|
| Claude: setup-token + CLAUDE_CODE_OAUTH_TOKEN, history shared | **Confirmed** as primary. Add the env scrub list, unset CLAUDE_CODE_RETRY_WATCHDOG, no `--bare`, inference-only caveats (no /usage %, no RC/connectors). |
| Claude backup: CLAUDE_SECURESTORAGE_CONFIG_DIR | **Confirmed it exists and works as described** (file + keychain hash + lock). Undocumented. `oauthAccount` is not per-slot. |
| Claude Keychain name / `security` CLI / plaintext on Linux & Windows | **Confirmed.** Nuances: hash of the raw NFC string. Windows can use Credential Manager when flag-gated (account `claude-code-user`). |
| Codex per-account CODEX_HOME with sessions/config linked | **Confirmed with additions:** no sessions override exists, so links are required. Set `CODEX_SQLITE_HOME`. Keep auth/secrets/daemon/caches per account. Single-use refresh tokens. Cross-account resume likely blocked. |
| `allow_symlinked_codex_home` enables symlinked homes | **Refuted.** It only affects macOS Seatbelt writable roots. |
| `codex exec --json` exposes rate_limits/resets_at | **Refuted.** Only text errors. Structured data is in rollout `token_count` and app-server `account/rateLimits/read`. |
| CODEX_ACCESS_TOKEN is "Agent Identity" | **Partly.** `at-` gives a Business/Enterprise access token; anything else is an Agent Identity JWT. |
| OPENAI_API_KEY is a Codex auth env | **Refuted** (not used at runtime for auth). |

## 5. Bugs to fix in LimitShift (found while comparing)
- Its codex regex `(try again at)\s+[0-9]{1,2}(:[0-9]{2})?\s*(am|pm)?` misses the dated form `Try again at Oct 9th, 2026 3:45 PM` **[V both sources]**.
- It must also accept the curly apostrophe in `You’ve`.
- The Claude parsing should handle `resets Oct 9, 3pm (TZ)` and prefer `rate_limit_event.resetsAt`.


## Open questions

- Claude: does `claude -p --resume <id>` work for a transcript created under account A when CLAUDE_CODE_OAUTH_TOKEN belongs to account B (thinking signatures, tool_use history)? Test with two Pro/Max accounts.
- Claude: run each account into a limit and capture the exact `rate_limit_event` and `result` JSON in `--output-format stream-json` and `json`. Do the @internal fields `api_error`, `api_error_status` and `api_error_params.rate_limit_info` actually reach stdout?
- Claude: does a setup-token token count against the same 5-hour/weekly buckets as the interactive login of that account? Do `utilization` values in rate_limit_event match claude.ai's usage page?
- Claude: what happens when CLAUDE_CODE_SUBSCRIPTION_TYPE is unset versus set (max/pro) for an env token: default model, limit message wording, /usage output?
- Claude: does Anthropic rotate the stored-login refresh token on every refresh, i.e. would two copies of one .credentials.json invalidate each other? Also measure the real refreshTokenExpiresAt lifetime.
- Claude: CLAUDE_SECURESTORAGE_CONFIG_DIR login slot on macOS. Does the Keychain item `Claude Code-credentials-<hash>` get created, and does login in slot B disturb slot A or the default item? Does `claude auth login` in slot B log out anything shared?
- Claude: confirm that the bootstrap with an inference-only token really returns 403 and leaves ~/.claude.json oauthAccount and model caches untouched (diff the file before and after).
- Claude: on Windows with CLAUDE_CODE_FORCE_WINDOWS_CREDMAN unset, confirm %USERPROFILE%\.claude\.credentials.json is used. Check whether the GrowthBook flag tengu_windows_credman is currently on for real accounts.
- Codex: resuming a rollout created under ChatGPT account A while logged in as ChatGPT account B (both personal Plus/Pro). Does it fail with invalid_encrypted_content or organization_id mismatch, and what does exec --json print?
- Codex: does a per-account CODEX_HOME overlay with symlinked sessions/, archived_sessions/, config.toml, history.jsonl, session_index.jsonl and CODEX_SQLITE_HOME=~/.codex behave correctly for exec, exec resume, the TUI picker and rollout compression on macOS, Linux and Windows (junctions)?
- Codex on macOS: does the Seatbelt sandbox reject any symlinked dir under CODEX_HOME during workspace-write runs, and which dirs are writable roots?
- Codex: capture a real usage-limit run with `codex exec --json` (error/turn.failed text) and the matching rollout token_count.rate_limits (primary/secondary window_minutes and resets_at; plan_type for Plus versus Pro).
- Codex: does `codex app-server` account/read plus account/rateLimits/read work non-interactively for each overlay home without side effects (no auth.json rewrite unless refresh is due), and how long does it take?
- Codex: how long does the ChatGPT access token live (JWT exp), how often does auth.json get rewritten in practice, and how does refresh-token reuse detection behave if two processes in the same home refresh concurrently?
- Both: per-account plan entitlements (model lists differ by plan). Confirm models_cache.json must stay per-account and that `--model` choices valid for one account are rejected cleanly by another.

## Sources

- npm @anthropic-ai/claude-code 2.1.293 (meta + platform packages darwin-arm64, linux-x64, win32-x64; binaries inspected): https://www.npmjs.com/package/@anthropic-ai/claude-code
- npm @openai/codex 0.161.0 and 0.161.0-linux-x64 (binary inspected): https://www.npmjs.com/package/@openai/codex
- openai/codex source at tag rust-v0.161.0 (commit 979011409de0a60b52f179721948e65531d26144): login/src/auth/storage.rs, manager.rs, token_data.rs, access_token.rs, personal_access_token.rs; config/src/types.rs, config_toml.rs, codex_home_symlink.rs; core/src/config/mod.rs, auth_keyring.rs, client.rs; secrets/src/lib.rs; rollout/src/*.rs; exec/src/exec_events.rs, event_processor_with_jsonl_output.rs; protocol/src/error.rs, protocol.rs; app-server-protocol; utils/home-dir; cli/src/login.rs, main.rs; tui/src/startup_orchestration.rs; features/src/lib.rs: https://github.com/openai/codex/tree/rust-v0.161.0/codex-rs
- Claude Code docs: Authentication (multiple accounts, credential storage, precedence, setup-token): https://code.claude.com/docs/en/authentication
- Claude Code docs: Environment variables (CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_OAUTH_REFRESH_TOKEN/SCOPES, CLAUDE_CODE_SIMPLE, retry watchdog): https://code.claude.com/docs/en/env-vars
- Claude API docs: Thinking (signature compatibility across platforms): https://platform.claude.com/docs/en/build-with-claude/thinking
- Claude API docs: Extended thinking: https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- Codex docs: Authentication and credential storage (redirected from developers.openai.com/codex/auth): https://learn.chatgpt.com/docs/auth
- Codex docs: Access tokens (Business/Enterprise only, CODEX_ACCESS_TOKEN, --with-access-token): https://learn.chatgpt.com/docs/enterprise/access-tokens
- OpenAI community: Cannot resume session after API key switch - encrypted content organization_id mismatch (2026-02-22): https://community.openai.com/t/codex-app-cannot-resume-session-after-api-key-switch-encrypted-content-organization-id-mismatch/1374803
- openai/codex issue #20004: preserve local history visibility and continuation across providers/accounts (open): https://github.com/openai/codex/issues/20004
- openai/codex issue #8145: The encrypted content ... could not be verified: https://github.com/openai/codex/issues/8145
- openai/codex issue #17541: model switch mid-conversation encrypted content could not be decrypted: https://github.com/openai/codex/issues/17541
- openai/codex issue #19661: codex exec resume missing encrypted_content: https://github.com/openai/codex/issues/19661
- openai/codex issue #3942: cannot resume after switching login methods (Plus to API key): https://github.com/openai/codex/issues/3942
- Community docs on rate_limit_event in stream-json (added in Claude Code 2.1.45): https://claudeissues.com/issue/26392-docs-agent-sdk-missing-sdkratelimitinfo-and-sdkratelimitevent-type-documentation
- User's LimitShift v2 (limit regexes, /usage note, resume args): /home/user/limitshift-v2/limitshift.sh
- User's ai-switcher requirements files (allowed): launcher/ais-run.mjs header, launcher/ais-limits.mjs: /home/user/ai-switcher/launcher/ais-limits.mjs
