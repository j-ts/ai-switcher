# Research track: cli-agy

_Research date: 2026-10-07. Claims are marked VERIFIED (evidence gathered during the research) or INFERRED._

## Summary

The Google Antigravity CLI (`agy`, internal codename "jetski"; binary name `antigravity`, v1.3.1) is a single stripped Go binary (go1.28 toolchain, Google's internal `google3` tree). Its credential layer is a two-tier `compositeTokenStorage`: it prefers the OS keyring (via `github.com/zalando/go-keyring` v0) but falls back to a single plaintext JSON file whenever the keyring is unavailable or explicitly bypassed. On Linux, bypass triggers include no `DBUS_SESSION_BUS_ADDRESS`, containers (`/.dockerenv`, cgroup `docker`/`containerd`/`kubepods`), WSL, SSH (`SSH_TTY`/`SSH_CLIENT`/`SSH_CONNECTION`), and a keyring-timeout marker — meaning in the headless/SSH/container contexts where LimitShift drives agy, agy already uses the FILE, not the keyring. The file lives under the per-product app-data dir `~/.gemini/antigravity-cli/` (config is shared at `~/.gemini/config/`); the whole root is redirectable with the global `--gemini_dir` flag (VERIFIED: it moved `config/mcp_config.json`). zalando/go-keyring uses `/usr/bin/security` on macOS (no Security.framework, so acctshift writing the item via the same CLI avoids prompts) and Windows Credential Manager with a hard 2560-byte blob limit (agy's token JSON likely exceeds it, forcing the file path on Windows). The keyring service identifier is the literal "gemini". Tokens are OAuth (consumer client id 884354919052-...apps.googleusercontent.com); the stored JSON carries access/refresh/id tokens plus project/region/tier/email, and agy rewrites it on every refresh (proactive, 5 min before expiry) via a savingTokenSource — so any swap must save the outgoing entry back. Conversations live in a SQLite index (`conversation_summaries.db`) and per-conversation transcripts under `~/.gemini/antigravity-cli/brain/<id>/`, keyed by workspace+appDataDir (NOT by account), resumed with `-c`/`--continue`/`--conversation <id>`; local resume therefore survives an account swap but the server may reject a cross-account resume (confirm on real machines). Login is `agy` with a browser flow or an SSH paste-code loop; there is no `agy login` subcommand and no `ANTIGRAVITY_TOKEN` env var in this build. The quota error is `RESOURCE_EXHAUSTED (code 429): Individual quota reached ... Resets in <rel>` on the agy log, and headless runs print `AGY_ERROR: {...}` on stderr and exit 3. Google OAuth must never be performed by acctshift; the safe swap is file-level (headless) or keyring-item-level (desktop) with save-back + lock + verification.

## Conclusions

| # | Claim | Status | Confidence | Evidence | What the spec should do |
|---|---|---|---|---|---|
| 1 | agy is a single stripped Go binary (go1.28, Google google3 tree, codename 'jetski'), delivered per-platform from Google's updater manifest; v1.3.1 linux_amd64 sha512 matched the manifest. | VERIFIED | high | .go.buildinfo = 'go1.28-20260921-RC02 cl/985595000 X:fieldtrack,boringcrypto,simd'; manifest linux_amd64 sha512 3b8349d7… recomputed identical; symbols under google3/third_party/jetski/cli. | Vendor agy via the same manifest(version/url/sha512); extract tar on *nix, raw .exe on Windows; musl variants exist (linux_amd64_musl/linux_arm64_musl → HTTP 200). |
| 2 | Credential storage is a two-tier composite: OS keyring (zalando/go-keyring v0) preferred, single plaintext JSON file fallback. | VERIFIED | high | Symbols codeassistclient.compositeTokenStorage{SaveToken,LoadToken,…}, KeyringTokenStorage, fileTokenStorage; log 'Using file-based token storage because …'; zalando/go_keyring/v/v0 symbols + secret_service. | acctshift must handle both backends; swapping either must preserve the single-login model. |
| 3 | On Linux agy bypasses the keyring (uses the file) when there is no D-Bus session bus, inside containers, under WSL, over SSH, or after a keyring timeout. | VERIFIED | high | shouldBypassKeyring runs dbusDetector(DBUS_SESSION_BUS_ADDRESS), containerDetector(/.dockerenv,/proc/1/cgroup docker\|containerd\|kubepods,CLOUD_SHELL), wslDetector(WSL_DISTRO_NAME,/proc/sys/kernel/osrelease microsoft), sshDetector(SSH_TTY/SSH_CLIENT/SSH_CONNECTION); changelog confirms. | In the headless/SSH/container contexts LimitShift uses, agy already uses the FILE — acctshift can swap accounts by swapping one file; can also force file mode by bypassing the keyring. |
| 4 | The whole ~/.gemini root is redirectable with the global --gemini_dir flag; config lives at ~/.gemini/config/ and the CLI app-data dir is ~/.gemini/antigravity-cli/. | VERIFIED | high | Ran `agy --gemini_dir=$D mcp add demo echo hi` → wrote $D/config/mcp_config.json; default wrote ~/.gemini/config/mcp_config.json; changelog/limitshift reference ~/.gemini/antigravity-cli/. | Use per-account --gemini_dir (or HOME) to isolate credentials AND conversation history in one move. |
| 5 | The keyring service identifier is the literal 'gemini'; the account/username component is a fixed string not fully resolvable from the stripped binary. | VERIFIED | medium | 'gemini' (len 6) is the constant passed on every KeyringTokenStorage load/save; zalando Secret Service item uses attributes {username,service} + label "Password for '<user>' on '<service>'". | acctshift keyring code keys off service 'gemini'; the exact account string must be read on a real machine before writing items. |
| 6 | zalando/go-keyring uses /usr/bin/security on macOS (not Security.framework), so acctshift can read/write the keychain item with the same CLI without an access prompt. | VERIFIED | high | keyring_darwin.go source: add/find/delete-generic-password with -s service -a account -w secret, -U update; no ACL/partition code. | On macOS use `security add-generic-password -U -s gemini -a <acct> -w <json>` and the matching find/delete; no partition-list surgery; confirm prompt-free read on a real Mac. |
| 7 | On Windows agy uses Credential Manager via wincred with a hard 2560-byte blob limit and target 'gemini:<user>'; the token JSON likely exceeds it, forcing the file fallback. | VERIFIED | medium | keyring_windows.go source: target service+':'+user, single entry, `if len(password) > 2560 { return ErrSetDataTooBig }`; agy token JSON carries id_token JWT + access + refresh + project/tier/email. | Treat Windows agy as effectively file-based (~/.gemini/antigravity-cli/antigravity-oauth-token); measure a real token blob to confirm it exceeds 2560 B. |
| 8 | The stored credential is OAuth JSON (access/refresh/id tokens + project/region/tier/email) and agy rewrites it on every refresh (proactive, 5 min before expiry). | VERIFIED | high | StoredToken json tags access_token/refresh_token/id_token/expiry/project_id/user_tier/email…; symbols savingTokenSource.Token, RefreshingTokenSource, onTokenChanged; changelog 'proactively refreshing … five minutes before expiration'. | A swap MUST save the outgoing entry back (the entry mutates at runtime); never perform Google OAuth in acctshift. |
| 9 | Conversations are stored locally keyed by dir+workspace (not account): SQLite conversation_summaries.db + brain/<id>/ transcripts; resumed with -c/--continue/--conversation. | VERIFIED | high | conversation_summaries.db(+wal/shm); ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl; cache/last_conversations.json workspace→id map; ConversationSummary struct has AppDataDir/WorkspaceURIs/ProjectID, no email. | Keeping HOME/--gemini_dir constant lets the same conversation continue across a credential swap locally; server-side cross-account resume may be rejected (confirm). |
| 10 | Login is `agy` (browser or SSH paste-code loop); there is no login/logout/whoami subcommand and no ANTIGRAVITY_TOKEN env var in v1.3.1. | VERIFIED | high | --help subcommand list (no login/auth/logout); /login,/logout slash commands; SubmitAuthorizationCode/OpenBrowser symbols; grep ANTIGRAVITY_TOKEN = 0 matches. | To see the account, read the stored token email or `agy -p "/usage" --output-format json`; do not rely on a login subcommand or ANTIGRAVITY_TOKEN. |
| 11 | JETSKI_OAUTH_TOKEN injects an OAuth token from the environment (standalone auth provider), analogous to CLAUDE_CODE_OAUTH_TOKEN. | VERIFIED | medium | NewStandaloneAuthProvider reads os.Getenv('JETSKI_OAUTH_TOKEN') and JETSKI_TEST_GAIA_TOKEN, logs 'Using OAuth token from environment variable'; called by language_server.setUpClients. | Potential per-run token-injection path for acctshift; confirm on-device whether it authenticates agy -p as that account and what token type it expects (likely short-lived access token). |
| 12 | agy has a first-party multi-account concept selectable via AGY_ACCOUNT for sandboxed commands (account-1, account-2, …) managed in the Plugins Manager. | VERIFIED | medium | Binary help: 'prefix it with AGY_ACCOUNT=<account>'; error 'AGY_ACCOUNT=%q matches no signed-in account; available accounts: %s'. | Probe this supported multi-account mechanism on a real install — it may offer a cleaner rotation path than dir/keyring swapping. |
| 13 | The quota/limit error is 'RESOURCE_EXHAUSTED (code 429): Individual quota reached … Resets in <rel>' and headless runs emit AGY_ERROR JSON on stderr and exit 3; daily/plan caps fail fast. | VERIFIED | high | Binary strings RESOURCE_EXHAUSTED/429/AGY_ERROR:{short_error}; changelog exit-code-3 + AGY_ERROR; user's ais-limits.mjs documents the exact agy wording and relative reset parse. | acctshift's agy limit detector matches RESOURCE_EXHAUSTED/429/quota-reached/credits strings + AGY_ERROR+exit3, parsing the relative 'Resets in …' time, then rotates to the next account. |

## Full report

# TRACK cli-agy — How the Google Antigravity CLI (`agy`) stores login, conversations and limit errors

**Date:** 2026-10-07. **Subject:** Antigravity CLI **v1.3.1** (binary internal name `antigravity`, codename **"jetski"**; CLI command `agy`). Clean-room: I did **not** read agm or Hawkynt code. All binary facts are from the official Linux x64 build I downloaded, verified and inspected; macOS/Windows facts that I could not run are marked INFERRED and grounded in the library source.

---

## 0. Provenance / how I got the binary (VERIFIED)

Google's updater manifest endpoint (the same one `install.sh` hits), queried live:

`GET https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/<platform>.json`

| platform id | version | artifact | size | sha512 (prefix) |
|---|---|---|---|---|
| `linux_amd64` | 1.3.1 | `.../linux-x64/cli_linux_x64.tar.gz` | 61,780,683 B | `3b8349d72678795b…` |
| `linux_arm64` | 1.3.1 | `.../linux-arm/cli_linux_arm64.tar.gz` | — | `c41b8cd8c526eb04…` |
| `darwin_arm64` | 1.3.1 | `.../darwin-arm/cli_mac_arm64.tar.gz` | 54,461,807 B | `f44ce2b9935c8796…` |
| `darwin_amd64` | 1.3.1 | `.../darwin-x64/cli_mac_x64.tar.gz` | — | `8c45c547b6d1c405…` |
| `windows_amd64` | 1.3.1 | `.../windows-x64/cli_windows_x64.exe` | 190,286,488 B | `f346d2cd9d68e7e5…` |
| `windows_arm64` | 1.3.1 | `.../windows-arm/cli_windows_arm64.exe` | — | `5b1e761a46bdf3b4…` |

Also present (the user's `agy.mjs` expects them): `linux_amd64_musl` and `linux_arm64_musl` → **HTTP 200** (musl builds exist). Linux/macOS artifacts are `.tar.gz` containing one binary named `antigravity`; Windows artifacts are the raw `.exe`.

Downloaded only `linux_amd64`; **sha512 matched the manifest exactly**. Unpacked binary: `ELF 64-bit x86-64, PIE, dynamically linked, stripped`, 211,026,152 B. Build info section `.go.buildinfo`: **`go1.28-20260921-RC02 cl/985595000 … X:fieldtrack,boringcrypto,simd`** (Google's internal Go toolchain, not a public `go.mod` — so `go version -m` reports "not a Go executable" and there is no module list; I recovered symbols by parsing the Go `pclntab` myself). The symbol namespace is `google3/...` (Google monorepo), the CLI code lives under `google3/third_party/jetski/cli/...` and `.../language_server/...`.

Vendor CLI was run only offline (`unshare -n`), with an empty `HOME`/XDG pointed at a throwaway dir, no credentials, only `--version`/`--help`/`help <sub>`/`mcp list`/`mcp add`. Large downloads deleted afterward.

---

## (b) Login flow, commands, and seeing the signed-in account

### Top-level usage (VERIFIED, from `antigravity --help`)
Global flags: `--add-dir`, `--agent`, `-c`/`--continue`, `--conversation <id>`, `--dangerously-skip-permissions`, `--disable-slash-commands`, `--effort <low|medium|high|xhigh|max>`, `-i`/`--prompt-interactive`, `--input-format <text|stream-json>`, `--json-schema`, `--log-file`, `--mode <accept-edits|plan>`, `--model`, `--new-project`, `--output-format <text|json|stream-json>`, `-p`/`--print`/`--prompt`, `--print-timeout`, `--project`, `--remote-control`, `--sandbox`.

Subcommands: `agent`/`agents`, `changelog`, `help`, `install`, `mcp`, `mic-serve`, `models`, `plugin`/`plugins`, `remote-control`, `update`. **There is no `login`, `auth`, `logout`, `whoami`, or `account` subcommand.** Login/logout are done inside the interactive TUI via `/login` and `/logout` slash commands.

### How you sign in (VERIFIED from binary strings + official docs)
- You authenticate simply by **running `agy`** (interactive). On start it checks the keyring/stored credential; if none, it opens the browser to a Google sign-in page and stores the result. (Official docs: `antigravity.google/docs/cli/install`.)
- **Headless / SSH:** the CLI prints an authorization URL, you sign in in a browser elsewhere and paste back an authorization code. Binary confirms print-mode code entry via the controlling terminal (`/dev/tty` on POSIX, `CONIN$` on Windows) and the symbols `(*oauthMethod).SubmitAuthorizationCode`, `OpenBrowser`, `completeOAuth`, `generateState`. Truly non-interactive runs fail fast with an actionable message.
- Auth method ladder (symbols in `.../cli/backend/auth`): `ChainedAuth` tries, in order, `keyringAuth` (restore stored token) → `oauthMethod`/`newBrowserOAuth` (consumer) → `adcAuth` (Application Default Credentials) → `gatewayAuth` (enterprise gateway) → `geminiAPIKeyAuth` → `wifOAuthMethod` (Workforce Identity Federation, the "Use advanced SSO config" option). Constructors: `NewDefaultChain`, `NewADCChain`, `NewEnterpriseGatewayChain`, `NewGeminiAPIKeyChain`.
- OAuth client (evidence, these are client IDs, not secrets): consumer `884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com`, a second `1071006060591-tmhssin2h21lcre235vtolojh4g403ep...` (business). Uses `client_secret_post`. User identity is fetched from `https://www.googleapis.com/oauth2/v2/userinfo` and from `peopleAPIUserInfo`; the ID-token claims are also parsed locally (`parseIDToken`, `StoredToken.IDTokenClaims`).

### Seeing which account is signed in WITHOUT sending a prompt (VERIFIED)
- Since v1.1.x the signed-in identity is read **from the stored credential**, not a network call, and is shown on the startup banner (email + plan tier; enterprise also shows the GCP project).
- Print-mode answers read-only slash commands with no agent turn / no quota spend / no conversation left behind: `agy -p "/usage"`, `-p "/quota"`, `-p "/credits"`, `-p "/model"`, `-p "/permissions"`, `-p "/help"`, `-p "/config"`, each emitting tab-separated records or, with `--output-format json|stream-json`, a structured payload. `agy -p "/usage"` prints quota reset times (local tz to a terminal, UTC when piped/`--json`).
- `AGY_CLI_HIDE_ACCOUNT_INFO` hides email+tier from the header; `AGY_CLI_HIDE_LOGO` hides the banner art but keeps version+account lines.
- **For acctshift:** the cheapest "who is this" check is to read the `email` field out of the stored token JSON directly (see §a), or parse `agy -p "/usage" --output-format json`.

---

## (a) Credential store, per OS

### Architecture (VERIFIED by disassembly)
Token persistence is `codeassistclient.compositeTokenStorage`, wrapping a **keyring** backend and a **file** backend. `NewCompositeTokenStorage` logs one of: `"Using file-based token storage because the caller requested it"`, `"… because a keyring timeout was recorded within the last %v"`, `"… because %s detected"`. The CLI builds it via `auth.NewCLITokenStorage`; the embedded language-server/remote-control build it via `authclient.NewAuthClient`.

The keyring library is **`github.com/zalando/go-keyring` v0** (symbols: `…/zalando/go_keyring/v/v0/keyring.*`, source files `keyring.go`, `keyring_unix.go`, `keyring_fallback.go`, `secret_service/secret_service.go`). D-Bus is `godbus` (`…/third_party/golang/dbus/dbus`).

The **keyring service identifier is the literal `"gemini"`** (VERIFIED: it is the constant, length-6, passed on every `KeyringTokenStorage.LoadStoredToken`/`updateStoredToken` call alongside a second fixed string). The item is one shared login (consistent with the hypothesis "one login in the OS cred store"). The second string (the account/username component) is a fixed package constant I could **not** fully disambiguate from the stripped binary — **confirm on a real machine** (commands in §h/open-questions).

#### Linux (VERIFIED)
- Primary: **Secret Service** over D-Bus (`secretServiceProvider`). zalando stores into the **login** collection (unlocked first), with an item whose attributes map is `{"username": <user>, "service": "gemini"}` and label `Password for '<user>' on '<service>'` (VERIFIED: these exact literals and the `GetLoginCollection`/`Unlock`/`CreateItem`/`SearchItems` calls are in `secretServiceProvider.Set`). The secret payload is the token **JSON blob** (see format below).
- **Fallback to a plaintext file** when the keyring is bypassed/unavailable. agy decides this up front in `shouldBypassKeyring`, which runs detectors concurrently (2.5 s detection timeout) — VERIFIED env/file checks:
  - `dbusDetector`: `os.Getenv("DBUS_SESSION_BUS_ADDRESS")` empty → bypass (headless hosts, no session bus).
  - `containerDetector`: `/.dockerenv` exists, or `/proc/1/cgroup` contains `docker`/`containerd`/`kubepods`; also `CLOUD_SHELL`.
  - `wslDetector`: `WSL_DISTRO_NAME`/`WSL_INTEROP` set, or `/proc/sys/kernel/osrelease` contains `microsoft`.
  - `sshDetector`: `SSH_TTY`/`SSH_CLIENT`/`SSH_CONNECTION` set.
  - `androidDetector` (termux/android).
  - plus a 1-hour memoized "keyring-unavailable" marker after a prior keyring timeout, and the "caller requested it" flag.
  - Changelog corroboration: *"bypasses the keyring when no D-Bus session bus is present (headless hosts and containers), skips it for an hour after a timeout, and uses longer keyring timeouts."* Keyring op timeout is 5 s.
  - **Consequence for acctshift: in exactly the contexts LimitShift runs agy (SSH / container / no-DBus), agy already uses the FILE, so account swaps there are a one-file operation — no keyring surgery.**
- File path (VERIFIED construction, exact prefix to confirm on a real signed-in tree):
  - CLI: `<appDataDir>/<product>-oauth-token` where `appDataDir = ~/.gemini/antigravity-cli` and `product = "antigravity"` → **`~/.gemini/antigravity-cli/antigravity-oauth-token`**. Keyring-timeout marker: `<appDataDir>/cache/antigravity-keyring-unavailable`.
  - Standalone/language-server default: **`~/.gemini/jetski-standalone-oauth-token`** (`NewFileTokenStorage` joins `$HOME` + `.gemini` + `jetski-standalone-oauth-token`), marker `~/.gemini/cache/antigravity-keyring-unavailable` (`DefaultKeyringMarkerPath`).
  - File write: `os.MkdirAll` the parent then `os.WriteFile` the JSON (the mode byte should be confirmed; expect `0600`).

#### macOS (VERIFIED from zalando/go-keyring source; on-device behavior to confirm)
zalando/go-keyring on darwin **shells out to `/usr/bin/security`** — it does **not** call Security.framework:
- set: `security add-generic-password -U -s <service> -a <account> -w <secret>`
- get: `security find-generic-password -s <service> -wa <account>`
- delete: `security delete-generic-password -s <service> -a <account>`

No ACL/partition-list code. Because the **item is created by `/usr/bin/security`**, the trusted application on the item's ACL is effectively `security` itself, so reading it back later with `/usr/bin/security` does **not** raise an access prompt in steady state. **This is the macOS answer:** acctshift can read and write the item with the very same `/usr/bin/security add/find/delete-generic-password` commands agy uses, so no prompt and no partition-list surgery are needed (confirm on a real Mac that a `security`-written item is read back prompt-free by agy). Service `"gemini"`, account the fixed second string.

#### Windows (VERIFIED from zalando/go-keyring source; on-device behavior to confirm)
zalando/go-keyring on windows uses **Windows Credential Manager** via `wincred`. Target name = **`service + ":" + username`** (i.e. `gemini:<account>`), stored as a **single** credential (no chunking), with a hard limit: **`if len(password) > 2560 { return ErrSetDataTooBig }`**. The agy token JSON (id-token JWT + access + refresh + project/tier/email) very likely exceeds 2560 bytes, so `keyring.Set` would fail and agy would **fall back to the file** `~/.gemini/antigravity-cli/antigravity-oauth-token` (log line *"Failed to save token to keyring, falling back to file"*). **So on Windows the token is effectively always file-based** — confirm by measuring a real token blob. Windows Credential Manager blob limit = 2560 bytes for this library (CRED is 2560 for the secret).

### Payload format (VERIFIED field names; JSON via `encoding/json/v2`)
Both keyring secret and the fallback file hold the same `codeassistclient.StoredToken` JSON. Observed `json:"…"` struct tags include: `access_token`, `refresh_token`, `id_token`, `token`/`token_type`, `expiry`/`expires_in`, `project_id`, `quota_project_id`, `region`/`region_code`, `user_tier`/`user_tier_id`, `tier_display_name`, `wif_provider`, `entitlement`, `email`, `license`/`licenses`, `auth_method`. Methods: `StoredToken.IsEmpty/ApplyToken/RememberIDToken/IDTokenClaims`.

---

## (c) Environment variables (VERIFIED — grepped from the binary)

**Dir / config overrides**
- **`--gemini_dir=<dir>`** (global flag, hidden from `--help`) — redirects the entire `~/.gemini` root. VERIFIED: `agy --gemini_dir=$D mcp add …` wrote `$D/config/mcp_config.json` instead of `~/.gemini/config/mcp_config.json`. There is also a `--app_data_dir=` flag string. **This is the primary isolation knob.**
- `HOME` (Linux/macOS via `os.UserHomeDir`) fully relocates `~/.gemini`. VERIFIED: default writes go to `$HOME/.gemini/config/mcp_config.json`.
- `JETSKI_APP_DATA_DIR` / `ANTIGRAVITY_APP_DATA_DIR` env vars exist but did **NOT** redirect the config dir in my test (still `~/.gemini/config/…`); they relate to sidecars (`ANTIGRAVITY_EXECUTABLE_DATA_DIR` is documented in-binary as a sidecar's data dir). Do not rely on them for isolation.

**Auth / token injection**
- **`JETSKI_OAUTH_TOKEN`** — read by `codeassistclient.NewStandaloneAuthProvider` (called from `language_server.setUpClients`), logging *"Using OAuth token from environment variable"*. This is the closest analog to `CLAUDE_CODE_OAUTH_TOKEN` — a per-run injected OAuth token. **Confirm on a real machine** whether setting it makes `agy -p` authenticate as that token's account without touching the keyring, and whether it expects a raw access/bearer token (short-lived) vs something else.
- `JETSKI_TEST_GAIA_TOKEN` — companion test token (internal).
- `AGY_ADC_AUTH` — toggles Application Default Credentials mode; binary message: *"To log out, please run `unset AGY_ADC_AUTH` … and restart the CLI."* / *"unset AGY_ADC_AUTH env var to use other sign in methods."*
- `GEMINI_API_KEY` (+ `GOOGLE_GEMINI_BASE_URL`, `GOOGLE_API_KEY`) — API-key mode (`modelProvider:"gemini"`); banner shows "Gemini API key". `GOOGLE_APPLICATION_CREDENTIALS` / `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` for ADC/Vertex.
- `AGY_LLM_GATEWAY_URL` / `_API_KEY` / `_HEADERS` / `_MODELS` / `_PROXY_URL` / `_CA_CERT` / `_WIRE_PROTOCOL` — enterprise LLM-gateway bring-your-own-endpoint.
- **`ANTIGRAVITY_TOKEN` does NOT exist in this build** (a third-party blog claims it for CI/CD — not true for v1.3.1).

**Multi-account / sandbox (VERIFIED, important)**
- **`AGY_ACCOUNT=<account>`** — selects which connected account a *sandboxed CLI command* runs as. Binary help text: *"To run a sandboxed CLI command with a specific account, prefix it with AGY_ACCOUNT=<account> (e.g. `AGY_ACCOUNT=account-2 gh api user`). Without the prefix, the default account is used."* and an error *"AGY_ACCOUNT=%q matches no signed-in account; available accounts: %s"*. **agy itself has a notion of multiple connected accounts** (in the Plugins Manager), named `account-1`, `account-2`, …. This is a strong signal there is first-party multi-account support worth probing on a real install (it may obviate per-account dir juggling for some flows).

**Other flags/vars seen:** `AGY_CLI_DISABLE_AUTO_UPDATE`, `AGY_CLI_HIDE_LOGO`, `AGY_CLI_HIDE_ACCOUNT_INFO`, `AGY_CLI_DISABLE_LATEX`, `AGY_CLI_MODEL_API_MAX_RETRIES`, `AGY_ENABLE_HUB`, `AGY_PLUGIN_AUTH_CALLBACK_PORT`, `AGY_ERROR` (output marker), `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_PROJECT_ID`, `ANTIGRAVITY_TRAJECTORY_ID`, `JETSKI_SERVICE_ENDPOINT_URL`, `JETSKI_ALLOW_SANDBOX`, `JETSKI_INTERNAL`.

---

## (d) Refresh-token rotation & write-back on refresh

- **VERIFIED (operative fact):** agy proactively refreshes OAuth tokens **5 minutes before expiry** (changelog) and persists the result — symbols `savingTokenSource.Token`, `RefreshingTokenSource`, `(*CodeAssistClient).onTokenChanged`, `KeyringTokenStorage.updateStoredToken`/`SaveToken`. The stored entry's `access_token`, `expiry`, and `id_token` therefore change frequently at runtime. It also rewrites on project/region/tier changes (`SaveProjectAndRegion`, `SaveUserTier`) and clears the entry on definitive server rejection (revoked account) and on `/logout`.
- **Therefore a swap MUST save the outgoing entry back** before swapping another in — the current hypothesis is correct — because even if the refresh_token is stable, the entry mutates (access token/expiry). Losing the latest write loses the fresh access token and can force a re-login.
- **INFERRED:** Google OAuth *installed-app* clients (which this is) do **not** rotate the refresh_token on each refresh by default, so the refresh_token component is usually stable; but do not depend on it — treat the whole entry as mutable and save-back always.
- **Hard rule honored:** acctshift must never perform Google OAuth itself; it only copies/moves the credential entries agy produces.

---

## (e) Conversation storage & resume (VERIFIED)

- Index: SQLite **`conversation_summaries.db`** (+ `-wal`/`-shm`) under the app-data dir `~/.gemini/antigravity-cli/`. Per-conversation artifacts/transcripts: **`~/.gemini/antigravity-cli/brain/<conversation-id>/`**, with `…/.system_generated/logs/transcript.jsonl` (planner replies are `type == "PLANNER_RESPONSE"`, field `.content`).
- Workspace→conversation map (how a resume picks the right id): **`~/.gemini/antigravity-cli/cache/last_conversations.json`** (also `cache/projects.json` for workspace→project mapping). (Both corroborated by LimitShift's own `agy_response_from_transcript`.)
- Resume flags: **`-c` / `--continue`** (most recent conversation in the workspace, with crash/subdir fallback), **`--conversation <id>`** (by id). `--new-project` forces a new one. `/resume` picker in the TUI.
- **Scoping:** the `ConversationSummary` record is keyed by `AppDataDir`, `WorkspaceURIs`, `ProjectID`, `AgentName`, `GroupID` — **not by account/email**. So the *local* history and `-c`/`--conversation` resume are tied to the dir + workspace, **not** the signed-in account. **For acctshift this is the key enabler: swap only the credential while keeping `HOME`/`--gemini_dir` constant and the same conversation keeps going.** CAVEAT (confirm on real machines): the conversation also exists server-side under the account that created it; resuming it as a *different* Google account may be rejected by the backend even though local resume works.

---

## (f) Quota / limit error text (VERIFIED)

- Primary wording (also the user's own LimitShift note): **`RESOURCE_EXHAUSTED (code 429): Individual quota reached. … Resets in <Hh Mm Ss>.`** — written to the agy log line under `~/.gemini/antigravity-cli/log` (and the `/usage` panel shows reset times). Reset wording is a **relative** duration ("Resets in 4h46m9s"), unlike Claude's absolute wall-clock.
- Other canonical strings: `RESOURCE_EXHAUSTED` / gRPC `resource_exhausted`, HTTP `429`, `MODEL_CAPACITY_EXHAUSTED`/"Overloaded prefill queue", credits: *"Your AI credits balance is too low to continue."*, *"Out of credits"*. G1 "credits" top-up quota exists (`/credits`, `UseG1Credits`).
- Retry behavior (matters for limit detection): per-minute `429` and `502/503/504` are retried in-process with backoff honoring the server's `retry-delay`; **daily/billing/quota caps stop immediately** instead of burning ~2.5 min. So a `RESOURCE_EXHAUSTED` that is a daily/plan cap fails fast — good for fast rotation.
- **Headless signal (best for acctshift):** on a model/agent failure, `agy -p` prints a structured **`AGY_ERROR: {…}`** JSON line on **stderr** (fields: canonical status, HTTP/gRPC code, retryability, error id) and exits with **code 3** (benign tool errors/permission denials do not fail the run; code 1 is config/startup). RPC: `RetrieveUserQuotaSummary` + "Models & Quota" page back the numeric quota.
- **acctshift limit detector for agy should match:** `RESOURCE_EXHAUSTED`/`resource_exhausted`, `code 429`/`429`, "quota reached/exceeded", `MODEL_CAPACITY_EXHAUSTED`, the credits strings, and the `AGY_ERROR` stderr line + exit 3; parse reset from the relative "Resets in …" text.

---

## (g) macOS keychain specifics (answered in §a macOS)

agy's keyring writes/reads go through **`/usr/bin/security`** (zalando/go-keyring darwin), not Security.framework. So reading the item with `/usr/bin/security` is exactly what agy does and will not prompt for an item that `security` created. To hand agy an item it can read prompt-free, **write it with the same `security add-generic-password -U -s gemini -a <account> -w <json>` call** (no `-T`/partition-list management needed; the `-U` updates in place). Confirm on a real Mac: (1) the exact service/account strings via `security find-generic-password -s gemini -g` / `security dump-keychain | grep -iA3 gemini`; (2) that a `security`-written item is read back by agy without a GUI prompt; (3) whether agy ever adds its own binary to the ACL (it should not, since it uses the CLI).

---

## (h) Safest swap procedure (derived)

Two regimes; pick per detected storage.

**Detect first:** decide keyring-vs-file the way agy does — on Linux, file if any of {no `DBUS_SESSION_BUS_ADDRESS`, container, WSL, SSH, marker present}; on Windows, effectively always file (2560-byte limit); on macOS/Linux-desktop, keyring. acctshift can also *force* file mode by running agy with the keyring bypassed (e.g. drop `DBUS_SESSION_BUS_ADDRESS`, or set the keyring-unavailable marker) — the simplest robust design is **"always run agy with file storage + a per-account `--gemini_dir` (or `HOME`)"**, which sidesteps the shared keyring entirely.

### Regime A — file-based (headless/CI/SSH/container, Windows, or forced)
1. Acquire an exclusive lock (per-cli-per-dir).
2. Run agy only after the account's token file is in place at `~/.gemini/antigravity-cli/antigravity-oauth-token` (or `--gemini_dir=<accountDir>/.gemini`).
3. Preferred isolation: give **each account its own `--gemini_dir`** so tokens AND the `brain/`+`conversation_summaries.db` are already per-account; then "rotation" is just choosing which dir to launch with (no copy, no save-back race). If instead you share one dir and swap the single file: copy the current file to the outgoing account's slot (**save-back**, because agy rewrote it on refresh), fsync, then atomically rename the incoming account's file into place.
4. Verify: `agy -p "/usage" --output-format json` returns the expected account's email/tier and non-exhausted quota.
5. Release lock. Rollback = restore the saved-back file.

### Regime B — keyring (desktop)
1. Lock.
2. **Save-back:** read the current item (`security find-generic-password -s gemini -wa <account>` on macOS; `secret-tool lookup service gemini username <account>` on Linux) and store it to the outgoing account's vault/file.
3. Write the incoming account's secret with the same tool agy uses (`security add-generic-password -U …` / `secret-tool store`), so agy reads it prompt-free.
4. Verify as in A (and that the banner/`/usage` shows the new email).
5. Release. Rollback = re-write the saved-back secret.

**Invariants:** never run Google OAuth; keep `HOME`/`--gemini_dir` constant across a same-conversation resume; treat the credential entry as mutable (always save-back); detect limits from `AGY_ERROR`+exit-3 / `RESOURCE_EXHAUSTED` and rotate to the next non-exhausted account.

---

## Design implications for acctshift (summary)
- agy support is cleanest as **per-account `--gemini_dir`** (or `HOME`) dirs, which isolate credentials AND conversation history in one move, and avoid the shared keyring. Because conversations are keyed by dir+workspace (not account), resuming the *same* conversation under a rotated account requires keeping the dir fixed and only swapping the credential — which is the harder case; prefer per-account dirs when a fresh conversation per account is acceptable, and fall back to in-place credential swap (with save-back) when same-conversation continuity across accounts is required (and accept the server-side caveat).
- Force file storage (bypass keyring) in headless contexts to make swaps a single atomic file rename on all three OSes.
- Probe the first-party **`AGY_ACCOUNT` / multi-account** mechanism on a real install — it may provide a supported rotation path.
- Reuse the user's existing manifest-based portable install (version/url/sha512, musl variants, tar for *nix / exe for Windows, chmod + macOS quarantine clear).

## Open questions

- Exact keyring account/username string paired with service 'gemini' (the second fixed component). Confirm on real machines: Linux `secret-tool search --all service gemini`; macOS `security find-generic-password -s gemini -g` and `security dump-keychain | grep -iA3 gemini`; Windows `cmdkey /list | findstr /i gemini`.
- Exact fallback token file name/location after a real consumer login: confirm whether it is ~/.gemini/antigravity-cli/antigravity-oauth-token (CLI) vs ~/.gemini/jetski-standalone-oauth-token (standalone), and the file permission bits (expected 0600).
- Whether JETSKI_OAUTH_TOKEN actually authenticates `agy -p` as the token's account in the normal CLI (not just the language-server path), and what token form it expects (raw access/bearer token, lifetime). If only a short-lived access token, it is unsuitable as the sole rotation mechanism since acctshift must not mint tokens.
- Whether a conversation created under account A can be resumed (`--conversation <id>`/`-c`) under account B with only the credential swapped and the dir kept constant — i.e. does Google's backend accept a cross-account resume, or only the local transcript survives.
- On Windows: measure a real token JSON blob to confirm it exceeds the 2560-byte wincred limit and that agy therefore always uses the file (vs. ever succeeding in Credential Manager).
- On macOS: confirm that an item written by `/usr/bin/security add-generic-password` is read back by agy without a GUI access prompt, and that agy does not register its own binary in the item ACL.
- Behavior of the first-party AGY_ACCOUNT multi-account feature: how accounts are added/named, where the per-account credentials live, and whether `AGY_ACCOUNT=account-N agy -p …` selects the account for a normal (non-sandboxed) run — this could replace dir/keyring swapping entirely.
- Whether the Google refresh_token for this installed-app client rotates on refresh (observe a real ~/.gemini token file across several refreshes); regardless, confirm the entry's access_token/expiry change so save-back is mandatory.
- Exact on-disk schema/filenames of conversation_summaries.db and cache/last_conversations.json on a real signed-in machine, to drive reliable same-conversation resume after rotation.

## Sources

- Antigravity CLI updater manifest, linux_amd64 (version/url/sha512), fetched live 2026-10-07: https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json
- agy v1.3.1 linux_amd64 binary (official GCS), sha512 verified against manifest; inspected offline (strings, objdump, parsed Go pclntab): https://storage.googleapis.com/antigravity-public/antigravity-cli/1.3.1-4582356770750464/linux-x64/cli_linux_x64.tar.gz
- zalando/go-keyring macOS implementation (uses /usr/bin/security add/find/delete-generic-password; -s service -a account): https://raw.githubusercontent.com/zalando/go-keyring/master/keyring_darwin.go
- zalando/go-keyring Windows implementation (wincred; target service+':'+user; 2560-byte password limit): https://raw.githubusercontent.com/zalando/go-keyring/master/keyring_windows.go
- Official Antigravity CLI install/auth docs (install.sh/install.ps1, browser + SSH paste-code login): https://antigravity.google/docs/cli/install
- Embedded CHANGELOG extracted from the agy binary (quota/credits wording, keyring bypass, headless AGY_ERROR/exit-3, refresh-5-min-before-expiry, --continue/--conversation): agy v1.3.1 binary: '# Antigravity CLI Changelog' section (local extract CHANGELOG.agy.md)
- User requirements: ai-switcher launcher/agy.mjs (portable manifest install; agy runs with real HOME; appDataDir ~/.gemini/antigravity-cli): /home/user/ai-switcher/launcher/agy.mjs
- User requirements: ai-switcher launcher/ais-limits.mjs (detectAgyLimit: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached … Resets in 4h46m9s'): /home/user/ai-switcher/launcher/ais-limits.mjs
- User requirements: limitshift.sh agy handling (agy_data_dir ~/.gemini/antigravity-cli, cache/last_conversations.json, brain/<id>/.system_generated/logs/transcript.jsonl, PLANNER_RESPONSE, quota regex): /home/user/j-ts/limitshift/limitshift.sh
