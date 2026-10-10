# Research track: cli-gemini-copilot

_Research date: 2026-10-07. Claims are marked VERIFIED (evidence gathered during the research) or INFERRED._

## Summary

I inspected the current npm releases, Gemini CLI 0.63.0 and Copilot CLI 1.0.93. I ran both under empty HOME/XDG directories with help and version flags only, and checked the results against official docs and GitHub issues. Gemini CLI does not use the OS keychain by default. It keeps Google OAuth credentials in plaintext at $HOME/.gemini/oauth_creds.json (mode 0600) on every OS. The keychain path (service "gemini-cli-oauth", account "main-account", with an AES-GCM encrypted fallback file gemini-credentials.json) is used only when GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true. Every Gemini credential and history path is built from GEMINI_CLI_HOME (default os.homedir()). Sessions are local JSONL files under tmp/<project-slug>/chats and are not tied to an account. --resume accepts a UUID, and --session-id pre-assigns one, so resuming under another account works if the chats directory is shared. Copilot CLI is now a Node single-executable binary with a native runtime. It stores its OAuth token in the OS keychain (service "copilot-cli") or, with consent, in plaintext ~/.copilot/config.json. Its documented order is COPILOT_GITHUB_TOKEN, then GH_TOKEN, GITHUB_TOKEN, the keychain, and finally `gh auth token`. That makes a per-run env token the clean way to pick an account while keeping one shared COPILOT_HOME, and with it one shared session history. Copilot reports limits as structured JSONL session.error events (errorType rate_limit or quota, errorCode such as user_weekly_rate_limited or quota_exceeded, statusCode, and a retryAfterSeconds hint). Gemini reports TerminalQuotaError or RetryableQuotaError with code 429 and server text such as "Your quota will reset after 4h28m20s". Recommended selection: Gemini OAuth accounts get a per-account GEMINI_CLI_HOME that shares directories through symlinks or junctions, never symlinks to single files; Gemini API-key accounts get GEMINI_API_KEY; Copilot gets COPILOT_GITHUB_TOKEN from a fine-grained PAT or from `gh auth token --user`. limitshift's existing regexes mostly catch these errors, but I found gaps in how it parses Copilot JSON and in Gemini and Copilot reset-time wording.

## Conclusions

| # | Claim | Status | Confidence | Evidence | What the spec should do |
|---|---|---|---|---|---|
| 1 | Gemini CLI 0.63.0 stores Google OAuth credentials by default as plaintext JSON at <home>/.gemini/oauth_creds.json (mode 0600) on all OSes. The OS keychain (service 'gemini-cli-oauth', account 'main-account') and the encrypted fallback file gemini-credentials.json are used only when GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true. | VERIFIED | high | Bundle code: getUseEncryptedStorageFlag() returns process.env['GEMINI_FORCE_ENCRYPTED_FILE_STORAGE']==='true'; the client.on('tokens') handler calls OAuthCredentialStorage.saveCredentials if that flag is set, else cacheCredentials (tmp file + rename, mode 384); KEYCHAIN_SERVICE_NAME='gemini-cli-oauth', MAIN_ACCOUNT_KEY='main-account'; FileKeychain path <home>/.gemini/gemini-credentials.json with key scrypt('gemini-cli-oauth', '<hostname>-<username>-gemini-cli') | The Gemini adapter manages a per-account file, not a keychain item. No keychain library is needed for Gemini. Support encrypted mode only as a detected edge case (refuse it, or swap the keychain entry under a lock). |
| 2 | GEMINI_CLI_HOME replaces the home directory for every Gemini credential, settings and history path. XDG variables are not used for paths. | VERIFIED | high | paths.js homedir(): process.env['GEMINI_CLI_HOME'] \|\| os.homedir(). Storage.getGlobalGeminiDir/getOAuthCredsPath/getGoogleAccountsPath all build on homedir(). Only XDG_SESSION_TYPE appears among XDG reads. Documented on geminicli.com/docs/reference/configuration | Select the Gemini account per run with GEMINI_CLI_HOME=<vault>/gemini/<acct>/home. Never change HOME, which would also affect agy and the user's tools. |
| 3 | Gemini writes settings.json, projects.json and oauth_creds.json with a temp file and rename. Symlinking individual files into a per-account home therefore breaks: the symlink is replaced by a regular file. Directory symlinks (tmp/, history/, ...) are safe, and projects.json self-heals from .project_root markers in a shared tmp/. | VERIFIED | high | writeAtomicSync (commentJson.ts) uses fs.writeFileSync(tempPath) then fs.renameSync(tempPath, filePath); ProjectRegistry.save uses a tmp file + rename; ProjectRegistry.findExistingSlugForPath scans <base>/<slug>/.project_root in tmp/ and history/ | The spec should require directory links or junctions only (tmp, history, commands, skills, extensions, policies, agents, acknowledgments, ../.agents). settings.json, GEMINI.md and .env are copied before each exec. Set GEMINI_CLI_TRUSTED_FOLDERS_PATH to the canonical file and GEMINI_CLI_AUTH_OVERRIDE=oauth-personal. |
| 4 | Gemini sessions are local JSONL files at <home>/.gemini/tmp/<slug>/chats/session-<ts>-<8hex>.jsonl with no account binding. --resume accepts latest, an index or a full UUID, and --session-id <uuid> sets the ID of a new session. Resuming under a different account works if tmp/ is shared. | VERIFIED | high | SessionSelector.findSession/resolveSession accept a UUID or 1-based index; resolveSessionId errors 'Session ID ... already exists' for --session-id; gemini --help lists -r/--resume, --session-id, --session-file, --list-sessions, --delete-session; sessionRetention defaults to enabled with maxAge 30d | accshift can promise same-conversation continuation for Gemini across accounts. limitshift can pre-assign session UUIDs with --session-id. Warn that 30-day retention deletes old chats. |
| 5 | Gemini quota errors appear as TerminalQuotaError (daily, QUOTA_EXHAUSTED, MODEL_CAPACITY_*, INSUFFICIENT_G1_CREDITS_BALANCE, or long retry) or RetryableQuotaError (per-minute or retry of 300 s or less). In -o json mode they produce {error:{type,message,code:429}} and process.exit(429), which is exit status 173 on POSIX (inferred). Server wording includes 'Your quota will reset after 4h28m20s' and the UI shows 'Usage limit reached for X. Access resets at h:mm AM TZ.' | VERIFIED | high | googleQuotaErrors.js classifyGoogleError; cli/src/utils/errors.ts handleError, extractErrorCode -> error.status; JsonFormatter.formatError; interactive messages in useGeminiStream; GitHub issues #25103 and #22643; the 429->173 exit mapping is inferred from POSIX semantics | The Gemini limit detector should prefer JSON error.type and code, rotate only on TerminalQuotaError, and retry the same account on RetryableQuotaError. Parse reset from 'reset after/in' and 'Access resets at'. Treat ValidationRequiredError (403) as 'account needs attention'. |
| 6 | Google refresh tokens for Gemini are not rotated on refresh: the stored refresh_token is kept and merged. Google invalidates the oldest token once an account has more than 100 refresh tokens for one OAuth client. | VERIFIED | medium | cacheCredentials merges {...existing, ...new}; saveCredentials uses refresh_token ?? existing.refreshToken; Google OAuth2 docs quote: 'limit of 100 refresh tokens per Google Account per OAuth 2.0 client ID ... invalidates the oldest refresh token without warning' | No refresh coordination is needed beyond keeping each account's file separate. Credential swapping on a shared file is unsafe while a gemini process is running, because merging mixes tokens. Discourage repeated re-adding of the same email. |
| 7 | Copilot CLI 1.0.93 stores its OAuth token in the OS keychain under service 'copilot-cli' (Keychain, Credential Manager, libsecret), or in plaintext ~/.copilot/config.json after consent. Auth precedence is COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN > keychain > `gh auth token`. | VERIFIED | high | docs.github.com authenticate-copilot-cli; `copilot help environment` text; `copilot login --help`; binary strings storeTokenPlaintext, needs-plaintext-consent, keyring-core/zbus-secret-service crates | The Copilot adapter injects COPILOT_GITHUB_TOKEN per run and keeps a single shared COPILOT_HOME. No keychain swapping is needed and parallel runs on different accounts are safe. |
| 8 | Copilot silently ignores classic PATs (ghp_) in env vars and falls back to the stored login, which could bill the wrong account. | VERIFIED | high | cli-main.js string: 'Classic Personal Access Tokens (ghp_) are not supported. ${var} contains a classic PAT and will be ignored. Use /login to authenticate, or replace it with a fine-grained PAT.'; docs table lists classic PAT as not supported | accshift add/exec must reject ghp_ tokens, accept only github_pat_ or gho_ (warn on ghu_), and validate the login with GET https://api.github.com/user. |
| 9 | `gh auth token --hostname <h> --user <login>` (gh 2.89.0) prints the token of a specific gh account. Copilot accepts gh OAuth tokens, so gh can act as an external multi-account vault for Copilot. | VERIFIED | high | `gh auth token --help` output under empty HOME: '-u, --user string  The account to output the token for'; Copilot docs: 'OAuth tokens from the GitHub CLI (gh) app' supported | Offer `accshift add copilot --from-gh <login>`, which stores no secret and resolves the token at exec time. |
| 10 | Copilot sessions live in $COPILOT_HOME/session-state/<id>/events.jsonl plus session-store.db. Resume works by ID, 7+ hex prefix, or exact case-insensitive name; --session-id sets the UUID of a new session. Resuming local sessions under a different env token should work. | INFERRED | medium | VERIFIED: docs cli-config-dir-reference; `copilot --help` resume/continue/session-id/name text. INFERRED: no account binding for local sessions (remote steering is user-bound per the binary string 'it belongs to a different GitHub user') | Rotate Copilot accounts with --resume <same name or id>. Forbid --remote with rotation. Test on two real accounts. |
| 11 | Copilot reports limits as structured JSONL session.error events: data.errorType 'rate_limit' or 'quota'; errorCode values user_weekly_rate_limited, user_global_rate_limited, user_model_rate_limited, integration_rate_limited, rate_limited, quota_exceeded, session_quota_exceeded, billing_not_configured, additional_spend_limit_reached. auto_mode_switch.requested.data.retryAfterSeconds carries the reset hint. Copilot now has 5-hour and weekly session rate limits. | VERIFIED | high | copilot-sdk/generated/session-events.d.ts ErrorData and AutoModeSwitchRequestedData; runtime strings 'You've reached your weekly rate limit.', 'You've run out of your included AI credits for the month...', '5hour-session-ratelimits', 'weekly-session-ratelimits' | The Copilot detector should classify by errorType and errorCode. Rotate on rate_limit and quota_exceeded/additional_spend_limit_reached. Do not rotate on session_quota_exceeded (a user cap), billing_not_configured or authentication errors. The monthly reset is the 1st at 00:00 UTC. |
| 12 | limitshift's Copilot JSONL parser reads top-level fields (.content, .interactionId, .error.message), and its tests use synthetic fixtures. The real 1.0.93 event schema nests payloads under .data, so R_TEXT and session-id extraction may be empty with the real CLI. | INFERRED | medium | VERIFIED: limitshift.sh copilot branch jq expressions and tests/test-limitshift.sh fake-copilot fixture; session-events.d.ts envelope {type,data,id,parentId,timestamp}. INFERRED: --output-format json emits the same envelope | Before relying on Copilot rotation, capture a real `copilot -p ... --output-format json` transcript, update the parsers to read .data.content, .data.message and .data.sessionId, and add real fixtures. |
| 13 | The Copilot npm package is a loader for a 181.5 MB Node SEA platform binary that extracts about 190 MB into the cache on first run. Its licence permits redistribution only unmodified, as part of a larger app, and not standalone. | VERIFIED | high | npm view unpackedSize 181541612; extraction to $XDG_CACHE_HOME/copilot/pkg/linux-x64/1.0.93 observed (192M); LICENSE.md sections 1-3 | accshift must invoke the user's installed copilot, never bundle it, and never relocate COPILOT_CACHE_HOME/XDG_CACHE_HOME per account. |
| 14 | limitshift reset parsing handles the Gemini wordings but not the Copilot ones: ' (current limit resets in ~<n>s)' has a tilde, and ' Your quota resets <date>' can be mis-read as a clock time. | INFERRED | medium | VERIFIED: parse_reset_from_error regexes in limitshift.sh lines 1390-1436; Copilot fragments found in the native runtime. INFERRED: exact rendered formats of <X> | accshift should compute limited_until from structured fields (retryAfterSeconds, the monthly rule) and accept --limited-until from limitshift. Extend the regexes to allow '~' and to ignore date-like tokens. |

## Full report

# Track: cli-gemini-copilot: how Gemini CLI and Copilot CLI store accounts and sessions and report limits

Date of research: 2026-10-07. Every claim is labelled **VERIFIED** (I saw the evidence in this session) or **INFERRED** (from memory or reasoning).

## 0. How I checked

Scratch directory: `/tmp/claude-0/-home-user/228bfb4e-0bd0-5413-8490-21fae890d3fa/scratchpad/cli-gemini-copilot/`.

- Each download went into its own empty directory and was deleted afterwards. Only a few small help-text dumps remain.
- Vendor CLIs ran only with `--version` and `--help` (plus `help <topic>` and a few parse-only flag checks next to `--version`).
- They ran under `env -i` with HOME and XDG_* pointing at empty temp directories, no credentials, and `COPILOT_OFFLINE=true` for Copilot.
- I did not log in or send any prompt.
- I did not open agm or ClaudeCodePortable code, and I modified no repository.

| Command | Result (excerpt) |
|---|---|
| `npm view @google/gemini-cli version time.modified` | `0.63.0`, `2026-10-07T01:37:27.999Z` |
| `npm view @github/copilot version time.modified` | `1.0.93`, `2026-10-07T18:27:50.779Z` |
| `npm pack @google/gemini-cli@0.63.0` | 20,810,043-byte tgz, 96 MB unpacked. `bin: gemini -> bundle/gemini.js`, `engines.node >=20`, license Apache-2.0. Optional deps: `@github/keytar 7.10.6`, `@lydell/node-pty*`, `node-pty` |
| `npm pack @github/copilot@1.0.93` | 5,454-byte stub with only `npm-loader.js`. It has optionalDependencies for 8 platform packages: linux-x64, linux-arm64, linuxmusl-x64, linuxmusl-arm64, darwin-x64, darwin-arm64, win32-x64, win32-arm64 |
| `npm view @github/copilot-linux-x64@1.0.93 dist.unpackedSize` | `181541612`. The package has a single file `copilot`: an ELF x86-64 binary that is a **Node SEA** (contains `../src/node_sea.cc`, `NODE_SEA_BLOB`) |
| `copilot --version` (empty HOME) | `GitHub Copilot CLI 1.0.93.` On first run it **self-extracts about 192 MB** into `$XDG_CACHE_HOME/copilot/pkg/linux-x64/1.0.93/`, which contains `index.js`, `app.js`, `cli-main.js` (8 MB JS), `prebuilds/linux-x64/runtime.node` (128 MB native, Rust: strings reference `keyring-core-1.0.0`, `zbus-secret-service-keyring-store-1.0.1`, `secret-service-5.2.0`), `cli-native.node`, `copilot-runtime`, `copilot-sdk/`, `schemas/session-events.schema.json`, and `.extraction-complete` |
| `node bundle/gemini.js --version` (empty HOME, `GEMINI_CLI_NO_RELAUNCH=true`) | `0.63.0`. Created only `~/.gemini/projects.json.*.tmp` |
| `gh --version`; `gh auth token --help` (empty HOME) | `gh version 2.89.0`. `-u, --user string  The account to output the token for` |

---

## 1. Gemini CLI 0.63.0 (`@google/gemini-cli`)

### 1.1 Credential storage (a)

All findings in this subsection are **VERIFIED** from the bundle (`packages/core/dist/src/code_assist/oauth2.js`, `oauth-credential-storage.js`, `services/keychainService.js`, `services/fileKeychain.js`).

**Default mode** (`GEMINI_FORCE_ENCRYPTED_FILE_STORAGE` is not `"true"`), the same on all OSes:
- Google OAuth tokens are stored in plaintext JSON at `<home>/.gemini/oauth_creds.json`.
- `<home>` is `GEMINI_CLI_HOME`, or `os.homedir()` if that is unset.
- Code: `getUseEncryptedStorageFlag(){ return process.env[FORCE_ENCRYPTED_FILE_ENV_VAR] === "true"; }`, then `useEncryptedStorage ? OAuthCredentialStorage.saveCredentials(tokens) : cacheCredentials(tokens)`.
- `cacheCredentials` reads the existing file, writes `{...existing, ...newTokens}` to `.<name>.<pid>.<ts>.<n>.tmp` with mode `0600` (384), renames it into place, then chmods 0600.

**Opt-in encrypted mode** (`GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true`):
- `HybridTokenStorage("gemini-cli-oauth")` with account key `"main-account"`. Stored value: JSON `{serverName:"main-account", token:{accessToken, refreshToken, tokenType, scope, expiresAt}, updatedAt}`.
- Backend: the native keychain through `@github/keytar` (macOS Keychain, Linux Secret Service, Windows Credential Manager).
- Before use it probes the keychain with a set/get/delete of `__keychain_test__<hex>` and a 2 s timeout.
- On macOS it first runs `security default-keychain`.
- On WSL (`WSL_DISTRO_NAME`, `WSLENV` or `WSL_INTEROP` set) it skips the keychain.
- Fallback is `FileKeychain`: `<home>/.gemini/gemini-credentials.json`, AES-256-GCM, key `scrypt("gemini-cli-oauth", "<hostname>-<username>-gemini-cli", 32)`, file mode 0600.
- `GEMINI_FORCE_FILE_STORAGE=true` forces that file backend.
- On first load in this mode, an existing `oauth_creds.json` is migrated into storage and deleted.

**Other keychain service names in use:**
- `gemini-cli-api-key`: API key entered via `/auth`.
- `gemini-cli-extension-integrity`.
- MCP OAuth tokens: `<home>/.gemini/mcp-oauth-tokens.json`, or the hybrid store.

**`oauth_creds.json` content:** google-auth-library `Credentials` (`access_token`, `refresh_token`, `scope`, `token_type`, `expiry_date`, possibly `id_token`). **INFERRED:** `id_token` is present because of the `userinfo.email` scope.

**OAuth client:** Gemini CLI's own installed-app client (`681255809395-...apps.googleusercontent.com`). Scopes: `cloud-platform`, `userinfo.email`, `userinfo.profile`. accshift must **never** use this client ID or secret itself.

| OS | Default | With `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true` |
|---|---|---|
| macOS | `~/.gemini/oauth_creds.json` (plaintext, 0600) | Keychain generic password, service `gemini-cli-oauth`, account `main-account`, via keytar. Falls back to `~/.gemini/gemini-credentials.json` |
| Linux | same file | Secret Service via keytar (2 s probe). Headless or no D-Bus falls back to the encrypted file |
| Windows | `%USERPROFILE%\.gemini\oauth_creds.json` | Credential Manager via keytar, else the encrypted file |
| WSL | same file | Keychain always skipped, so the encrypted file |

### 1.2 Environment variables that relocate or select credentials (b)

All **VERIFIED** by grepping `process.env` in the bundle unless marked.

| Variable | Effect |
|---|---|
| `GEMINI_CLI_HOME` | Replaces `os.homedir()` in `homedir()` (`packages/core/dist/src/utils/paths.js`). Everything under `.gemini` follows it: creds, `google_accounts.json`, `settings.json`, `tmp/`, `history/`, `projects.json`, `GEMINI.md`, commands, skills, policies, extensions, `.env` lookup. `~/.agents` also follows it. Documented: "Specifies the root directory for Gemini CLI's user-level configuration and storage." Only minor direct `os.homedir()` uses remain (ACP fs service, `~/.gemini/policies/sandbox.toml` default path, `~` expansion in shell-safety checks); none touch credentials |
| `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE` / `GEMINI_FORCE_FILE_STORAGE` | See 1.1 |
| `GEMINI_CLI_TRUSTED_FOLDERS_PATH` | Overrides `<home>/.gemini/trustedFolders.json` |
| `GEMINI_CLI_SYSTEM_SETTINGS_PATH` | Overrides `/etc/gemini-cli/settings.json`, `/Library/Application Support/GeminiCli/settings.json`, or `C:\ProgramData\gemini-cli\settings.json` |
| `GEMINI_API_KEY` (also `GOOGLE_API_KEY`) | Selects API-key auth if no auth type is configured |
| `GOOGLE_GENAI_USE_GCA=true` | Auth type `oauth-personal` |
| `GOOGLE_CLOUD_ACCESS_TOKEN` + `GOOGLE_GENAI_USE_GCA` | Uses a raw access token with no refresh, about 1 h. Would require accshift to mint tokens itself, so **rejected** |
| `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_GEMINI_BASE_URL` (gateway), `GEMINI_CLI_USE_COMPUTE_ADC`, `CLOUD_SHELL` | Other auth types (`getAuthTypeFromEnv`) |
| `GEMINI_CLI_AUTH_OVERRIDE` | Read once, then deleted from env. Sets `security.auth.selectedType` in memory, including the copy used when settings are saved (so it may persist; **INFERRED**). Valid values: `oauth-personal`, `gemini-api-key`, `vertex-ai`, `compute-default-credentials`, `gateway` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Tried *after* `<home>/.gemini/oauth_creds.json` |
| `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_CLOUD_QUOTA_PROJECT`, `GOOGLE_CLOUD_LOCATION` | Needed per account for Workspace and Code Assist Standard/Enterprise licences (docs: "You are using a company, school, or Google Workspace account") |
| `NO_BROWSER`, `OAUTH_CALLBACK_HOST`, `OAUTH_CALLBACK_PORT` | Login flow (user-code flow when no browser) |
| `GEMINI_MODEL`, `GEMINI_SANDBOX`, `SANDBOX`, `GEMINI_CLI_NO_RELAUNCH` | Misc. `SANDBOX=sandbox-exec` moves the runtime dir to `<home>/.cache/.gemini` |
| `XDG_*` | **Not used** for paths. Only `XDG_SESSION_TYPE` is read |
| `HOME` / `USERPROFILE` | Indirectly, through `os.homedir()` when `GEMINI_CLI_HOME` is unset |

Layout of `<home>/.gemini/`: `oauth_creds.json`, `google_accounts.json`, `gemini-credentials.json` (encrypted mode), `settings.json`, `GEMINI.md`, `projects.json`, `installation_id`, `trustedFolders.json`, `mcp-oauth-tokens.json`, `keybindings.json`, `acknowledgments/`, `commands/`, `skills/`, `agents/`, `policies/`, `extensions/`, `history/<slug>/`, and `tmp/<slug>/{chats,checkpoints,logs,memory,plans,...}`.

### 1.3 Login and offline identity check (c)

- **VERIFIED:** There is no `gemini login` subcommand in 0.63.0 (`--help` lists only `mcp`, `extensions`, `skills`, `hooks`, `gemma`).
  - Login happens in interactive mode: the first-run auth dialog, or `/auth` (subcommands `signin`/`login` and `signout`/`logout`).
  - `/auth signout` deletes creds, clears `google_accounts.json.active`, **and writes `security.auth.selectedType = undefined` into the user settings.json**.
  - Non-interactive runs with no cached creds fail: "Manual authorization is required but the current session is non-interactive. Please run the Gemini CLI in an interactive terminal to log in, provide a GEMINI_API_KEY, or ensure Application Default Credentials are configured." Exit code 41 (`FATAL_AUTHENTICATION_ERROR`).
- **VERIFIED:** Offline identity comes from `<home>/.gemini/google_accounts.json` = `{"active": "<email>|null", "old": ["<email>", ...]}`.
  - It is written by `fetchAndCacheUserInfo` (GET `https://www.googleapis.com/oauth2/v2/userinfo`) after login.
  - To check offline: `oauth_creds.json` has a `refresh_token` and `google_accounts.json.active` is an email. `expiry_date` only describes the 1 h access token.
- **accshift `add gemini` flow:** run `GEMINI_CLI_HOME=<acctdir> gemini` interactively (add `NO_BROWSER=true` when headless). The user does `/auth` and then `/quit`. accshift then reads `google_accounts.json.active` as the account label. accshift never performs OAuth itself.
- **VERIFIED from issue search:** Gemini has no native multi-account support. Issue #16447 ("Support multiple Google accounts for rate limit handling") was closed as a possible duplicate. Issue #14431 asked for a way to view the current account.

### 1.4 Sessions and resume (d)

All **VERIFIED** from the bundle and `--help` unless marked.

- **Storage path:** `<home>/.gemini/tmp/<slug>/chats/session-<timestamp>-<first8ofUUID>.jsonl`. Older sessions are `.json`. Line 1 holds metadata (`sessionId`, `projectHash`, `startTime`, `lastUpdated`); the following lines are messages.
- **Slug:** comes from `<home>/.gemini/projects.json` (`{"projects": {"/abs/path": "slug"}}`, locked with proper-lockfile, written with tmp file plus rename).
  - If the registry is missing it **self-heals** by scanning `tmp/*/.project_root` and `history/*/.project_root` marker files (`findExistingSlugForPath`).
  - So a per-account `projects.json` still resolves the same slug as long as `tmp/` and `history/` are shared.
- **Flags:**
  - `-r, --resume <latest|N|UUID>`: `SessionSelector.findSession` accepts a full UUID or a 1-based index.
  - `--session-id <UUID>`: starts a new session with a chosen UUID. It errors if the ID exists: `Session ID "<id>" already exists. Use --resume to resume it`.
  - `--session-file <json>`: imports a session as a new ID.
  - `--list-sessions`, `--delete-session <N|UUID>`.
  - `-o json|stream-json`. The JSON output includes `session_id`.
- **Retention:** `general.sessionRetention` defaults to `enabled: true` with `maxAge: "30d"`. Chats older than 30 days are deleted automatically.
- **Resume across accounts:** session files carry no account binding, and `resolveSessionId`/`SessionSelector` do no auth check (VERIFIED). The Code Assist API resends the whole history every turn (**INFERRED**: stateless generateContent). Cross-account resume therefore works if the two account homes share `tmp/` (and ideally `history/`).

### 1.5 Usage-limit and quota errors (e)

All **VERIFIED** from `utils/googleQuotaErrors.js`, `cli/src/utils/errors.ts` and `ui/hooks/useGeminiStream`, plus GitHub issues.

**Classification (`classifyGoogleError`):**
- `TerminalQuotaError` (hard limit, has `retryDelayMs`) when:
  - ErrorInfo reason is `QUOTA_EXHAUSTED`, `MODEL_CAPACITY_EXHAUSTED`, `MODEL_CAPACITY_EXCEEDED`, or `INSUFFICIENT_G1_CREDITS_BALANCE`;
  - `RATE_LIMIT_EXCEEDED` with no delay or a delay over 300 s;
  - QuotaFailure `quotaId` contains `PerDay` or `Daily`. The message becomes "You have exhausted your daily quota on this model.";
  - the text matches `/exhausted your capacity|capacity exceeded|MODEL_CAPACITY_EXHAUSTED/i`;
  - the text has `limit: 0`.
- `RetryableQuotaError` (transient, delay of 300 s or less, or PerMinute). The message gets "\nSuggested retry after 60s." or "Suggested retry after <retryDelay>." appended.
- `ValidationRequiredError`: 403 with reason `VALIDATION_REQUIRED`. The account needs verification; show the link.

**Interactive UI text:**
- `Usage limit reached for <model|all Pro models>.` / `Access resets at <h:mm AM/PM TZ>.` / `/stats model for usage details` / `/model to switch models.` / `/auth to switch to API key.`
- `We are currently experiencing high demand for <model>.` (capacity)
- `getResetTimeMessage` formats with `Intl.DateTimeFormat("en-US",{hour:"numeric",minute:"2-digit",timeZoneName:"short"})`.

**Non-interactive `-o json`:**
- `handleError` prints `{"session_id":..., "error":{"type":"TerminalQuotaError"|"RetryableQuotaError"|..., "message":"...", "code":429}}`.
- It then calls `process.exit(code)`, where `code` = `error.code ?? error.status`, which is 429.
- **INFERRED:** on POSIX the exit status is 429 mod 256 = **173**; on Windows it is 429.
- In text mode the error is rethrown and printed. `parseAndFormatApiError` produces `[API Error: <msg> (Status: <status>)]` and appends, for API-key auth, "Please wait and try again later. To increase your limits, request a quota increase through AI Studio, or switch to another /auth method". Other auth types get "Possible quota limitations in place or slow response times detected. Switching to the <flash> model for the rest of this session."

**Exit codes:** `FATAL_AUTHENTICATION_ERROR=41`, `FATAL_INPUT_ERROR=42`, `FATAL_CONFIG_ERROR=52`, `FATAL_CANCELLATION_ERROR=130`.

**Real server wording (GitHub issues):**
- #25103: "You have exhausted your capacity on this model. Your quota will reset after 4h28m20s." (HTTP 429)
- #22643: "Usage limit reached for gemini-3-flash-preview. Access resets at 10:57 PM GMT-3."
- #21010: "[API Error: Resource has been exhausted (e.g. check quota).]"
- Google forum: "Your quota will reset in 192 hours."

**Model fallback risk (INFERRED):** `handleFallback` can switch silently to a fallback model when the policy action is `silent`. A quota hit may therefore degrade the model instead of raising an error. Detect it via the "Switching to the … model" text or `stats` in the JSON output.

### 1.6 Refresh-token behaviour (f)

- **VERIFIED:** On refresh, `cacheCredentials` and `saveCredentials` merge the new tokens over the existing ones (`refresh_token ?? existing.refreshToken`). Google refresh responses normally omit `refresh_token`, so the stored refresh token is kept, and only the access token (about 1 h) and the expiry change.
- **Concurrency hazard (VERIFIED from code):** if two different accounts ever share one `oauth_creds.json` (credential swap while a gemini process runs), a refresh from process A merges A's access token over B's refresh token.
- **VERIFIED (Google docs):** refresh tokens stop working after 6 months unused, on revocation, or on admin policy. "There is currently a limit of 100 refresh tokens per Google Account per OAuth 2.0 client ID. If the limit is reached, creating a new refresh token automatically invalidates the oldest refresh token without warning." Re-logging into the same Google account more than 100 times invalidates the oldest login, so accshift should discourage repeated `add` for the same email.

### 1.7 Recommended per-run account selection for Gemini (g)

**OAuth (Google sign-in) accounts: per-account `GEMINI_CLI_HOME`.** Set `GEMINI_CLI_HOME=<vault>/gemini/<acct>/home`, never `HOME`, so agy and everything else is untouched.
- The account home holds a real `.gemini/` directory with per-account `oauth_creds.json`, `google_accounts.json`, optionally `gemini-credentials.json`, and `projects.json` (self-healing).
- Share state by **directory** links only, into the real `~/.gemini`: `tmp/`, `history/`, `commands/`, `skills/`, `extensions/`, `policies/`, `agents/`, `acknowledgments/`, plus `<home>/.agents` pointing to `~/.agents`.
  - On Windows use directory junctions (`mklink /J`, no admin needed).
- **Do not symlink individual files.**
  - VERIFIED: `settings.json` is written by `writeAtomicSync` (temp file in the same directory, then `renameSync`), and `projects.json` and `oauth_creds.json` also use tmp file plus rename. A rename replaces the symlink itself with a regular file, so sharing silently breaks.
  - Instead, copy `~/.gemini/settings.json` (and `GEMINI.md` and `.env` if present) into the account home before each `exec`.
  - Set `GEMINI_CLI_TRUSTED_FOLDERS_PATH=~/.gemini/trustedFolders.json` so trust stays global.
  - Set `GEMINI_CLI_AUTH_OVERRIDE=oauth-personal` so a per-account settings copy can never break auth. `/auth signout` would otherwise unset `selectedType`.
- Per-account extra env (for example `GOOGLE_CLOUD_PROJECT` for Workspace or Standard tiers) lives in the account record.

**API-key accounts:** inject `GEMINI_API_KEY` (and `GEMINI_CLI_AUTH_OVERRIDE=gemini-api-key`) per run. No home switch is needed. Note that AI Studio quotas are per project, not per Google account.

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Per-account `GEMINI_CLI_HOME` plus directory links | Separate token files; refresh writes land in the right file; parallel runs on different accounts are safe; no keychain dependence (works headless); history shared | Must manage links and copies; Windows needs junctions; settings edits made during a run are not written back unless accshift copies them back; first login per account is interactive | **Recommended** |
| Swap `~/.gemini/oauth_creds.json` and `google_accounts.json` under a lock | Simplest; one home | Breaks if any gemini process runs during a swap (the merge-on-refresh mixes tokens); no parallel runs; with encrypted mode it must swap the keychain entry `gemini-cli-oauth/main-account` | Fallback only, and only with "no running gemini" detection |
| `GOOGLE_APPLICATION_CREDENTIALS=<acct creds>` | Env-only | VERIFIED: `~/.gemini/oauth_creds.json` is tried **first**, and refreshed tokens are written back into that shared file, so account B can run with account A's access token | **Reject** |
| `GOOGLE_GENAI_USE_GCA` + `GOOGLE_CLOUD_ACCESS_TOKEN` | Env-only | accshift would have to refresh tokens using Gemini's OAuth client itself; tokens last about 1 h | **Reject** (performs OAuth itself) |

---

## 2. GitHub Copilot CLI 1.0.93 (`@github/copilot`)

### 2.1 Packaging and licence (relevant to efficiency and redistribution)

- **VERIFIED:** The npm package is a loader. It picks `@github/copilot-<linux|linuxmusl|darwin|win32>-<arch>` and spawns a 181.5 MB Node SEA binary.
  - On first run the binary extracts about 190 MB into the cache: `~/Library/Caches/copilot` on macOS, `%LOCALAPPDATA%\copilot` on Windows, `$XDG_CACHE_HOME/copilot` or `~/.cache/copilot` on Linux, or `COPILOT_PKG_CACHE_HOME` / `COPILOT_CACHE_HOME`.
  - It auto-updates into that cache unless `COPILOT_AUTO_UPDATE=false` or `--no-auto-update` is set.
  - **Implication:** never relocate the cache per account (that would mean about 190 MB of extraction per account).
- **VERIFIED:** `LICENSE.md` allows redistribution only "in unmodified form", "solely as part of an application or service that provides material functionality beyond the Software", and "not … on a standalone basis".
  - accshift should **call the user's installed `copilot`** and not bundle it. Gemini CLI is Apache-2.0.

### 2.2 Credential storage and precedence (a)

- **VERIFIED (docs, authenticate-copilot-cli):** "stores OAuth tokens in the operating system's keychain under the service name `copilot-cli`": macOS Keychain Access, Windows Credential Manager, Linux "libsecret (GNOME Keyring, KWallet)".
  - Without a keychain, "the CLI prompts you to store the token in a plaintext configuration file at `~/.copilot/config.json`".
  - VERIFIED in the binary: settings key `storeTokenPlaintext` ("Store auth token in plaintext (less secure)"); the login result `needs-plaintext-consent`; and the message "Login succeeded, but the token was not saved. Install a system keychain or rerun login and accept plaintext storage."
  - Linux backend: Rust `keyring-core` plus `zbus-secret-service-keyring-store` (`org.freedesktop.secrets`).
- **VERIFIED (docs and `copilot help environment`):** precedence:
  1. `COPILOT_GITHUB_TOKEN`
  2. `GH_TOKEN`
  3. `GITHUB_TOKEN`
  4. keychain OAuth token
  5. `gh auth token` fallback

  `copilot help environment` says: "an authentication token that takes precedence over previously stored credentials. Exception: in Codespaces, the auto-injected `GITHUB_TOKEN` … does not take precedence over a `/login` account."
- **VERIFIED, important trap:** classic PATs (`ghp_`) in an env var are **ignored with a warning**: "Classic Personal Access Tokens (ghp_) are not supported. <VAR> contains a classic PAT and will be ignored. Use /login to authenticate…". Copilot then falls back to the stored login, so the run silently uses a different account. accshift must reject `ghp_` tokens.
- **Supported tokens (docs):** `gho_` OAuth (Copilot CLI app or gh app); `github_pat_` fine-grained PAT, "Must be owned by your personal account … with the Copilot Requests account permission"; `ghu_` GitHub App user-to-server via env.
- **Messages for an invalid env token (VERIFIED strings):** "If using COPILOT_GITHUB_TOKEN, GH_TOKEN or GITHUB_TOKEN environment variable, verify the token is valid and not expired" and "If you set COPILOT_GITHUB_TOKEN, GH_TOKEN or GITHUB_TOKEN, verify it is a user token with Copilot access, or unset it to use your Copilot CLI login".
- **Keychain account-name format** for service `copilot-cli`: not determined (it is inside the native runtime). **INFERRED** to be host plus login. Not needed for the recommended design.

### 2.3 Environment variables and flags that relocate or select (b)

| Variable / flag | Effect (VERIFIED unless noted) |
|---|---|
| `COPILOT_HOME` | "override the directory where configuration and state files are stored; defaults to `$HOME/.copilot`". Covers `config.json` (auth data), `settings.json`, `session-state/`, `session-store.db`, `logs/`, `mcp-config.json`, `permissions-config.json`, `agents/`, `skills/`, `hooks/`, `extensions/`, `installed-plugins/`, `copilot-instructions.md` |
| `--config-dir <dir>` | Hidden flag, accepted by the parser (VERIFIED: `copilot --config-dir X --version` exits 0, while an unknown flag gives `error: unexpected argument`). Same role as `COPILOT_HOME` |
| `COPILOT_CACHE_HOME`, `COPILOT_PKG_CACHE_HOME`, `XDG_CACHE_HOME`, `LOCALAPPDATA` | Cache and extracted package location (from `sea-loader` code) |
| `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` | Token precedence, see 2.2 |
| `COPILOT_GH_HOST`, `GH_HOST` | Auth and API host (GHE data residency) |
| `COPILOT_OFFLINE`, `COPILOT_AUTO_UPDATE`, `COPILOT_MODEL`, `COPILOT_ALLOW_ALL`, `COPILOT_PROVIDER_*` (BYOK, no GitHub auth) | Misc |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME` | Used only for installing shell completions |

### 2.4 Login and identity (c)

- **VERIFIED (`copilot login --help`):** `copilot login [--host URL] [--device-code | --web-flow] [--with-token]`.
  - `--with-token` reads stdin. Login also imports a token from the env vars in precedence order.
  - Device flow is the default on SSH, Codespaces, CI and headless Linux.
- Interactive commands: `/login`, `/logout` ("This removes the locally stored token but does not revoke it on GitHub"), and `/user` ("Manage signed-in accounts"; `/user list`, `/user switch`).
  - Docs: "You can log in with multiple accounts, and the CLI will remember the last-used account." So Copilot has **native multi-account login**, but switching is interactive only.
- Offline identity: `config.json` holds "authentication data". The binary contains keys `loggedInUsers`, `lastLoggedInUser`, `copilotTokens`, `authTokens`. **INFERRED** exact JSON shape.
- For env-token accounts there is no local identity record. accshift should resolve the login once at `add` time with `GET https://api.github.com/user` using that token (plain documented REST, not an OAuth flow), and store the login.
- **VERIFIED:** `gh auth token --hostname github.com --user <login>` (gh 2.89.0) prints the token of a specific gh account. gh supports several accounts per host, and its `gho_` tokens are accepted by Copilot.

### 2.5 Sessions and resume (d)

- **VERIFIED (docs `cli-config-dir-reference` and the JS constant `"session-state"`):** `$COPILOT_HOME/session-state/<sessionId>/events.jsonl` plus workspace artifacts, and `$COPILOT_HOME/session-store.db` (SQLite, cross-session index). Logs go to `~/.copilot/logs/`.
- **VERIFIED (`--help`):**
  - `-r, --resume [<value>]`: session ID, task ID, ID prefix of 7 or more hex characters, or name ("name matching is exact, case-insensitive").
  - `--continue`: most recent session.
  - `-n, --name <name>`.
  - `--session-id <id>`: "Resume an existing session or task by ID, or set the UUID for a new session".
  - `--output-format json`: JSONL. `--stream off`, `--no-ask-user`, `-s`, `--allow-all` / `--yolo`, `--usage-output-file <file>`, `--max-ai-credits`.
  - `--effort <level>`: accepted by the parser (VERIFIED) although `--help` shows `--reasoning-effort`.
- **Cross-account resume (INFERRED):** works for local sessions when `COPILOT_HOME` is shared and only the env token changes. Session files are local, and the model API is per request.
  - Remote or steerable sessions are bound to a user (VERIFIED string: "not authorized to steer this session: it belongs to a different GitHub user"). Do not use `--remote` with rotation.

### 2.6 Limit and quota reporting (e)

**VERIFIED from `copilot-sdk/generated/session-events.d.ts`.** The JSONL events have the envelope `{type, data, id, parentId, timestamp, ephemeral?, agentId?}`.
- `session.start.data.sessionId` carries the session ID.
- `session.error.data` = `{errorType, errorCode?, message, statusCode?, url?, eligibleForAutoSwitch?, providerCallId?, serviceRequestId?}`.
- `errorType` values include `"authentication"`, `"authorization"`, `"quota"`, `"rate_limit"`, `"context_limit"`, `"query"`.
- For `rate_limit`, `errorCode` is one of `user_weekly_rate_limited`, `user_global_rate_limited`, `rate_limited`, `user_model_rate_limited`, `integration_rate_limited`.
- For `quota`, `errorCode` is one of `quota_exceeded`, `session_quota_exceeded`, `billing_not_configured`. The binary also has `additional_spend_limit_reached`, `free_quota_exceeded`, `legacy_cap_reached`.
- The ephemeral `auto_mode_switch.requested.data` = `{errorCode?, requestId, retryAfterSeconds?}`. Docs: "Seconds until the rate limit resets, when known."

**VERIFIED user-facing strings (native runtime):**
- `You've hit your rate limit.` / `Please wait for your limit to reset`
- `You've hit the rate limit for this model.` / `Please switch models or wait for your limit to reset`
- `You've hit your session rate limit.`
- `You've reached your weekly rate limit.`
- `Learn More (https://docs.github.com/copilot/concepts/rate-limits).`
- `You've run out of your included AI credits for the month. Manage budget: https://github.com/settings/copilot/features`
- `You've reached your additional usage limit for your plan. Go to https://github.com/settings/copilot/features for more details.`
- `You've reached the spending limit for this session. Start a new session to continue.` This is a **user-set session cap**, not an account limit.
- `No remaining quota for premium requests`
- `Rate limited. Switching to auto mode to continue.`
- `Rate limit hit (<x>). Switch to the auto model?`
- `Rate limited. Pausing <n> … before continuing.`
- Reset fragments: ` Your limit resets <X>.`, ` Your quota resets <X>.`, `; the limit resets at <X>`, ` (current limit resets in ~<n>s)`. The exact format of X is unknown.
- Internal rate-limit buckets: `5hour-session-ratelimits` and `weekly-session-ratelimits` (VERIFIED strings). Copilot now has five-hour and weekly session limits like Claude and Codex.
- The setting `continueOnAutoMode` (default false): "eligible rate limit errors (per-model, weekly, or integration limits) trigger an automatic switch to auto mode and retry; Does not apply to global rate limits, generic 429s, or BYOK providers."
- `You have multiple GitHub Copilot licenses from organizations or enterprises. Configure which license to use: …` This is a configuration error, not a limit.

**Monthly reset (VERIFIED via web sources):** AI-credit and premium-request allowances reset on the 1st of each month at 00:00:00 UTC.

### 2.7 Token lifetime and rotation (f)

- **VERIFIED:** The Copilot CLI OAuth app client ID `Ov23ctDVkRmgkPke0Mmm` (the `Ov23` prefix marks an OAuth App, **INFERRED**) uses device flow with scopes `read:user,read:org,repo,gist,codespace,write:plugin_gateway_connections`. Docs give the prefix `gho_`. No `ghr_` refresh handling was found in the binary.
- **INFERRED:** these tokens do not expire and do not rotate, unless the app has opted in to expiring tokens (not observed).
- **VERIFIED (GitHub docs):** "There is a limit of ten tokens that are issued per user/application/scope combination". Logging the same account in more than 10 times revokes older tokens, so accshift must not re-login per run.
- Fine-grained PATs expire on their configured date. accshift should record `expires_at` (entered by the user) and warn in `doctor`.
- `ghu_` tokens expire after 8 h. Do not accept them for stored accounts unless refreshed externally.

### 2.8 Recommended per-run account selection for Copilot (g)

**Use the env token `COPILOT_GITHUB_TOKEN`, with one shared `COPILOT_HOME`.** History, settings, MCP config and permissions stay shared; nothing is written to the keychain; parallel runs on different accounts are safe.

Token sources per account:
1. `--token-stdin`: a fine-grained PAT (`github_pat_`) with the Copilot Requests permission, stored in accshift's vault (OS keychain or 0600 file).
2. `--from-gh <login>`: nothing stored. At exec time run `gh auth token -h github.com -u <login>`.
3. A `gho_` token pasted from elsewhere.

Rules:
- Reject `ghp_` tokens.
- Validate once with `GET /user` and check the `login`.
- Also pass `--secret-env-vars=COPILOT_GITHUB_TOKEN` so the agent's shell and MCP children do not inherit it. This is a VERIFIED flag; whether it is still needed is **INFERRED**.
- Leave `GH_TOKEN` and `GITHUB_TOKEN` alone, since `COPILOT_GITHUB_TOKEN` wins.

**Alternatives:**
- Per-account `COPILOT_HOME`/`--config-dir` with `copilot login` inside it. Sessions and settings become per account. Symlinking `session-state/` and the SQLite `session-store.db` is fragile. The keychain entry is shared under service `copilot-cli`.
- Driving native `/user switch`. Interactive only. Not recommended.

---

## 3. Cross-check against limitshift (`/home/user/j-ts/limitshift/limitshift.sh`; `limitshift-v2` has identical regexes)

| Item | Current limitshift | Finding |
|---|---|---|
| Gemini args | `--resume=<id>` (Resume), `--output-format json`, `-m` | OK. UUID resume is supported (VERIFIED). Could use `--session-id <uuid>` for new sessions to get deterministic IDs |
| Gemini limit regex | `(quota exceeded\|resource_exhausted\|ratelimitexceeded\|model_capacity_exhausted\|no capacity available\|daily quota\|usage limit reached\|rate limit\|429\|too many requests)` plus `.error.code == 429` | Works mainly through code 429. Add `exhausted your capacity`, `resource has been exhausted`, `terminalquotaerror`, `insufficient_g1_credits`, and `.error.type in {TerminalQuotaError, RetryableQuotaError}`. Treat `RetryableQuotaError` (60 s per-minute) as *retry same account*, not rotate. Exit status 173 (POSIX) or 429 (Windows) is a signal (INFERRED) |
| Gemini reset parse | Handles `resets at <clock>`, `reset after XhYmZs`, `resets in N hours`, `"retryDelay":"Ns"` | Covers the observed server texts ("Your quota will reset after 4h28m20s", "reset in 192 hours", "Access resets at 10:57 PM GMT-3"). The TZ suffix is ignored, which is fine |
| Copilot args | `--name <id>` (New), `--resume <id>` (Resume), `--output-format=json --stream=off --no-ask-user -p`, `--model`, `--effort` | `--effort` is accepted (VERIFIED parse). Resume by name is supported (VERIFIED help) |
| Copilot JSON parse | Reads top-level `.content`, `.message`, `.interactionId`, `.sessionId`, `.error.message`. Test fixtures are synthetic (`{"type":"assistant.message","content":...}`) | **Risk:** the 1.0.93 SDK schema nests payloads under `.data` (`session.error.data.message`, `session.start.data.sessionId`). If the CLI's `--output-format json` uses the same envelope (INFERRED likely), `R_TEXT` and `R_ERROR_TEXT` come out empty. Limit detection still works by grepping the raw output, but `[[TASK_COMPLETE]]` marker detection could fail. **Test on a real account** |
| Copilot limit regex | `(usage limit\|rate limit\|too many requests\|quota\|premium requests\|billing\|try again at\|try again in\|429)` | Matches all real strings (`quota` also matches `"errorType":"quota"` in raw JSONL). But `session_quota_exceeded` (the user's own `--max-ai-credits` cap) and `billing_not_configured` or multiple-licence errors are **not** time-reset account limits. Don't rotate or wait for those; fail or start a new session instead |
| Copilot reset parse | No Copilot-specific handling | ` (current limit resets in ~<n>s)` has a tilde, so it is not parsed. ` Your quota resets <date>` risks a mis-parse (`resets 20…` read as a clock). Prefer `auto_mode_switch.requested.data.retryAfterSeconds`. For monthly `quota_exceeded`, use the 1st of next month 00:00 UTC |

---

## 4. Spec-ready adapter summary (tier-2)

| Field | gemini | copilot |
|---|---|---|
| Selection mechanism | `GEMINI_CLI_HOME=<vault>/gemini/<acct>/home` (OAuth) or `GEMINI_API_KEY` (key) | `COPILOT_GITHUB_TOKEN=<token>` (shared `COPILOT_HOME`) |
| Extra env per run | `GEMINI_CLI_AUTH_OVERRIDE=oauth-personal\|gemini-api-key`, `GEMINI_CLI_TRUSTED_FOLDERS_PATH=~/.gemini/trustedFolders.json`, optional `GOOGLE_CLOUD_PROJECT` | Optional `COPILOT_GH_HOST`. Add `--secret-env-vars=COPILOT_GITHUB_TOKEN` |
| Shared state | Directory links: `tmp/`, `history/`, `commands/`, `skills/`, `extensions/`, `policies/`, `agents/`, `acknowledgments/`, `../.agents`. Copy before run: `settings.json`, `GEMINI.md`, `.env` | Everything (single `COPILOT_HOME`) |
| `add` | Interactive `gemini` in the account home (`/auth`), then read `google_accounts.json.active` | `--token-stdin` (`github_pat_`/`gho_`) or `--from-gh <login>`. Validate with `GET /user` |
| Offline `status` | `oauth_creds.json` has `refresh_token`; `google_accounts.json.active` | Stored login and optional PAT expiry. `gh auth status` for gh-backed accounts |
| Limit signal | JSON `.error.type` TerminalQuotaError / RetryableQuotaError, `.error.code==429`, text patterns above | JSONL `session.error.data.errorType in {rate_limit, quota}` plus `errorCode`. Text patterns above |
| Reset source | "reset after XhYmZs", "Access resets at", `retryDelay` | `retryAfterSeconds`. Monthly quota: 1st 00:00 UTC. Weekly or 5-hour: parse `resets in ~` |
| Do NOT rotate on | RetryableQuotaError (per-minute), ValidationRequiredError (account needs action), ModelNotFound | `session_quota_exceeded`, `billing_not_configured`, multiple-licence error, `context_limit`, authentication errors (mark the account broken instead) |
| Concurrency | Safe across different accounts; refresh writes go to the per-account file | Safe; no shared credential writes |

**Language and runtime implications for the overall spec:** tier-2 support needs no native keychain library. Gemini's default storage is a file, and Copilot uses an env token. The only native things needed are directory symlinks or Windows junctions, an HTTPS GET (`/user`), JSON parsing, and spawning `gh`. A single static binary in Go or Rust can do all of this. In bash plus PowerShell, junction creation and JSONL parsing are doable but clumsier.


## Open questions

- Capture a real `copilot -p <prompt> --output-format json --stream=off` transcript on a signed-in account. Confirm the JSONL envelope (is the payload under .data?), the field names of assistant.message, the session id location and the exit code on rate_limit or quota errors.
- Confirm that `copilot --resume <name>` works when the session was created under account A and resumed with a COPILOT_GITHUB_TOKEN for account B (shared COPILOT_HOME), and that no account-specific cache (the 'copilot-user-cache' string) leaks quota or plan info between accounts.
- Exact JSON shape of ~/.copilot/config.json auth fields (loggedInUsers/lastLoggedInUser/copilotTokens) and the account-name format of keychain items under service 'copilot-cli' on macOS, Windows and Linux. Only needed if accshift ever imports existing Copilot logins.
- Whether Copilot automatically strips COPILOT_GITHUB_TOKEN from shell and MCP child environments, or whether --secret-env-vars is required.
- Exact rendered text after Copilot's ' Your limit resets ' / ' Your quota resets ' / '; the limit resets at ' fragments, for reset parsing.
- Whether Copilot CLI OAuth tokens (gho_) expire (OAuth app expiring-token opt-in). No ghr_ refresh handling was seen in the binary.
- Gemini on a real account: confirm that a quota hit in -p -o json mode produces error.type TerminalQuotaError with exit status 173 on Linux/macOS and 429 on Windows, and whether silent model fallback (to Flash) happens instead of an error under the default policy chain.
- Gemini with GEMINI_CLI_HOME on Windows: verify that directory junctions for tmp/ and history/ work with Gemini's proper-lockfile and rename patterns. Also check whether GEMINI_CLI_AUTH_OVERRIDE gets persisted into the copied settings.json.
- Whether GEMINI.md (global memory) and trustedFolders.json are written atomically (rename), which would affect whether they can be shared by link or need copy-back.
- Daily reset time of Gemini Code Assist quotas (midnight Pacific?) for fallback when the error text carries no reset duration.

## Sources

- npm registry: @google/gemini-cli 0.63.0 (npm pack, inspected bundle/*.js): https://www.npmjs.com/package/@google/gemini-cli
- npm registry: @github/copilot 1.0.93 loader and @github/copilot-linux-x64 1.0.93 (SEA binary, self-extracted pkg incl. copilot-sdk/generated/session-events.d.ts): https://www.npmjs.com/package/@github/copilot
- GitHub Docs: Authenticating GitHub Copilot CLI (keychain service copilot-cli, precedence, token types, /user switch): https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli
- GitHub Docs: Copilot CLI config directory reference (~/.copilot layout, COPILOT_HOME, session-state, session-store.db): https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
- GitHub Docs: Copilot rate limits concept page: https://docs.github.com/en/copilot/concepts/rate-limits
- GitHub Docs: Authorizing OAuth apps (10 tokens per user/app/scope limit): https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- GitHub Docs: About premium requests (monthly reset 1st 00:00 UTC): https://docs.github.com/de/copilot/managing-copilot/monitoring-usage-and-entitlements/about-premium-requests
- Gemini CLI configuration reference (GEMINI_CLI_HOME, sessionRetention): https://geminicli.com/docs/reference/configuration.md
- Gemini CLI authentication guide (GOOGLE_CLOUD_PROJECT requirement, headless): https://geminicli.com/docs/get-started/authentication
- Google OAuth2 docs: refresh token expiration and the 100-token limit: https://developers.google.com/identity/protocols/oauth2#expiration
- gemini-cli issue #25103: 'You have exhausted your capacity on this model. Your quota will reset after 4h28m20s.': https://github.com/google-gemini/gemini-cli/issues/25103
- gemini-cli issue #22643: 'Usage limit reached for gemini-3-flash-preview. Access resets at 10:57 PM GMT-3.': https://github.com/google-gemini/gemini-cli/issues/22643
- gemini-cli issue #21010: '[API Error: Resource has been exhausted (e.g. check quota).]': https://github.com/google-gemini/gemini-cli/issues/21010
- gemini-cli issue #16447: feature request for multiple Google accounts (closed): https://github.com/google-gemini/gemini-cli/issues/16447
- Google AI forum: 'Your quota will reset in 192 hours': https://discuss.ai.google.dev/t/got-locked-out-after-running-say-hello-world-prompt/137904
- limitshift (user's repo): gemini/copilot args, limit regexes, reset parser: /home/user/j-ts/limitshift/limitshift.sh (lines ~1390-1436, 1962-1995, 2031-2145, 2725-2737)
- limitshift tests: synthetic copilot JSONL fixtures: /home/user/j-ts/limitshift/tests/test-limitshift.sh (~2099-2190), /home/user/j-ts/limitshift/tests/limitshift.Tests.ps1 (~2505-2545)
- limitshift-v2 (identical limit regexes): /home/user/limitshift-v2/limitshift.sh (lines ~2672-2681, 2556-2626)
- Local help dumps kept from this session: /tmp/claude-0/-home-user/228bfb4e-0bd0-5413-8490-21fae890d3fa/scratchpad/cli-gemini-copilot/{copilot-help.txt,copilot-helptopics.txt,copilot-help-commands.txt,gemini-help.txt,copilot-limit-strings.txt}
