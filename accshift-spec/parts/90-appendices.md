## Appendix A: environment variables per CLI

**A.0 accshift's own variables**

| Variable | Meaning |
|---|---|
| `ACCSHIFT_HOME` | root directory (§6.1) |
| `ACCSHIFT_<CLI>_BIN` | path to the vendor binary (§12.2) |
| `ACCSHIFT_NONINTERACTIVE=1` | never prompt (§7.5). LimitShift MUST export it for every accshift invocation (§15.3). `exec` never prompts even without it; `run` asks its post-exit question (§16) only when stdin is a TTY and this is not set |
| `ACCSHIFT_JSON=1` | default to `--json` when stdout is not a TTY |
| `ACCSHIFT_DEBUG=1` | as `--debug`: redacted debug log to stderr; only writer commands also write `logs/accshift.log` (§10.1) |
| `ACCSHIFT_KEY_SOURCE` | key source at vault creation: `keychain`, `secret-service`, `dpapi`, `key-file` (§7.3) |
| `ACCSHIFT_KEY_FILE` | key file path for `key-file` at vault creation (CI, containers); afterwards the path recorded in the vault header is used (§7.3) |
| `ACCSHIFT_NO_UPDATE_CHECK=1` | disable update checks |
| `ACCSHIFT_TEST_KEYCHAIN` | test-only macOS keychain path. It exists only in binaries built with the `accshift_test` tag; release builds do not contain it (§17.1) |

Installer variables: `ACCSHIFT_INSTALL_DIR`, `ACCSHIFT_VERSION`, `ACCSHIFT_ARCHIVE`, `ACCSHIFT_SHA256` (required with `ACCSHIFT_ARCHIVE`), `ACCSHIFT_REPO`, `ACCSHIFT_NO_MODIFY_PATH=1`, `ACCSHIFT_NO_INSTALL_RECEIPT=1` (no `install.json`, for copies bundled by LimitShift, §15.9), `ACCSHIFT_GITHUB_TOKEN` (the only token the installers read, §17.6).

**A.1 claude**

| Action | Variables |
|---|---|
| always unset | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, `CCR_OAUTH_TOKEN_FILE`, `CLAUDE_CODE_SIMPLE`, `CLAUDE_CODE_RETRY_WATCHDOG`, `ANTHROPIC_UNIX_SOCKET`, `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`, `CLAUDE_CODE_OAUTH_SCOPES`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_CUSTOM_OAUTH_URL`, `CLAUDE_CODE_SUBSCRIPTION_TYPE`, `CLAUDE_CODE_RATE_LIMIT_TIER`; SHOULD also unset `ANTHROPIC_ORGANIZATION_ID` |
| `token` | set `CLAUDE_CODE_OAUTH_TOKEN`; unset `CLAUDE_SECURESTORAGE_CONFIG_DIR` only if it points into accshift's `homes/` |
| `native` | unset `CLAUDE_CODE_OAUTH_TOKEN`; `CLAUDE_SECURESTORAGE_CONFIG_DIR` passes through exactly as the user had it at `add --native` (including set-but-empty); removed only if it points into accshift's `homes/` |
| `login-slot` | unset `CLAUDE_CODE_OAUTH_TOKEN`; set `CLAUDE_SECURESTORAGE_CONFIG_DIR=<root>/homes/claude/<id>` |
| refuse (exit 125) | `ANTHROPIC_BASE_URL` with a non-Anthropic host for `token` / `login-slot` (`base-url-would-receive-token`); any settings `env` layer that sets an always-unset variable, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR` or `ANTHROPIC_BASE_URL` (`settings-env-overrides-token`) (§8.1) |
| never touch | `CLAUDE_CONFIG_DIR`, `HOME` |

**A.2 codex**

| Action | Variables |
|---|---|
| always unset | `CODEX_REFRESH_TOKEN_URL_OVERRIDE` |
| `home` | set `CODEX_HOME=<overlay>`, `CODEX_SQLITE_HOME=<mainSqliteHome>`; unset `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` |
| `native` | leave `CODEX_HOME` / `CODEX_SQLITE_HOME` as in the caller's environment, unless they point into `<root>/homes/` (then set `CODEX_HOME=<mainHome>` or unset it, §12.5); unset `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` |
| `access-token` | set `CODEX_ACCESS_TOKEN=at-…`; unset `CODEX_API_KEY`; main home (same inherited-home rule as `native`) |
| `api-key` | set `CODEX_API_KEY`; unset `CODEX_ACCESS_TOKEN`; main home (same inherited-home rule as `native`) |
| never touch | `OPENAI_API_KEY` (not used for Codex auth) |

**A.3 agy** (no selection variables: slot mechanism, §8.3). The names live in agy `facts.go`.

| Action | Variables |
|---|---|
| always unset | `AGY_ADC_AUTH`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `JETSKI_OAUTH_TOKEN` and its companion `JETSKI_TEST_GAIA_TOKEN` [R05 §c], so the stored login is used; `GOOGLE_GEMINI_BASE_URL` (the API-key endpoint) |
| refuse (exit 125) | any `AGY_LLM_GATEWAY_*` variable (`_URL`, `_API_KEY`, `_HEADERS`, `_MODELS`, `_PROXY_URL`, `_CA_CERT`, `_WIRE_PROTOCOL`) [R05 §c]: agy's enterprise-gateway auth would decide the account, not the slot. `exec` exits 125 `agy-env-overrides-slot` unless `--allow-settings-env` |
| never touch | `HOME` and `--gemini_dir`; `GOOGLE_APPLICATION_CREDENTIALS` and `GOOGLE_CLOUD_*` (they matter only with `AGY_ADC_AUTH`, which is unset); the variables agy's store detectors read, such as `DBUS_SESSION_BUS_ADDRESS`, `SSH_*`, `WSL_*` and `CLOUD_SHELL` (§8.3.2) |

**A.4 gemini**: out of scope (§8.4).

**A.5 copilot**

| Action | Variables |
|---|---|
| `token`, `gh` | set `COPILOT_GITHUB_TOKEN` (never launch without it). When `identity.host` is not `github.com`, set `COPILOT_GH_HOST=<host>`; otherwise unset an inherited `COPILOT_GH_HOST` that names another host [R06 §2.3]. Arguments: `exec` prepends `--secret-env-vars=COPILOT_GITHUB_TOKEN` unless the caller's argv already contains it, and reports it in the status file's `addedArgs` (§8.5) |
| `native` | unset `COPILOT_GITHUB_TOKEN` |
| `gh` helper only | run `gh auth token --hostname <identity.host> --user <identity.login>` with `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` removed from gh's own environment (§8.5) |
| never touch (in copilot's environment) | `COPILOT_HOME`, `COPILOT_CACHE_HOME`, `XDG_CACHE_HOME`, `GH_TOKEN`, `GITHUB_TOKEN` |

## Appendix B: vendor paths and credential slots per OS

| cli | Linux | macOS | Windows |
|---|---|---|---|
| claude credential | `<dir>/.credentials.json` (0600); Claude never uses libsecret | Keychain via `/usr/bin/security`: service `Claude Code-credentials[-<suffix>]`, account `$USER`, else the OS user name, else `claude-code-user`. Plaintext `<dir>/.credentials.json` when the Keychain write failed [R04 C2] | `<dir>\.credentials.json`; Credential Manager (user `claude-code-user`) only when `CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1` or the cached `tengu_windows_credman` flag is true [R04 C3] |
| claude managed settings (**VERIFY V-C4**) | `/etc/claude-code/managed-settings.json` (also WSL) | `/Library/Application Support/ClaudeCode/managed-settings.json` | `C:\Program Files\ClaudeCode\managed-settings.json` |
| claude history | `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<slug>/<sessionId>.jsonl` | same | same |
| codex credential | `$CODEX_HOME/auth.json` (file store default); keyring `Codex Auth` / `cli\|<sha256(home)[0:16]>` if configured | same | same, or `secrets/codex_auth.age` with key in `codex` / `secrets\|…` in keyring/auto mode |
| codex history | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl[.zst]`; sqlite at `CODEX_SQLITE_HOME` | same | same |
| agy credential | Secret Service `{service:gemini, username:antigravity}` in the login collection, **or** the CLI token file (`~/.gemini/antigravity-cli/antigravity-oauth-token`, else `~/.gemini/antigravity-oauth-token`; **VERIFY V-A2**) when a permanent detector fires (no D-Bus, container, Cloud Shell, WSL, SSH, Android) or a timeout marker is younger than 1 h (§8.3.2) | login keychain `-s gemini -a antigravity`, value prefixed `go-keyring-base64:` (via `/usr/bin/security`). The resolved slot is the store recorded in `agySlotUsed`, by default the keychain (§8.3.2). Token-file paths: **VERIFY V-A2** | Credential Manager `gemini:antigravity` (2560-byte cap; the blob size is unmeasured and R05 C7 expects it to exceed the cap, **VERIFY V-A4**), else the CLI token file under `%USERPROFILE%` (**VERIFY V-A2**) |
| agy language-server token (**VERIFY V-A10**) | `~/.gemini/jetski-standalone-oauth-token` (**VERIFY V-A2**) | the Linux path under `~`, unconfirmed (**VERIFY V-A2**) | the Linux path under `%USERPROFILE%`, unconfirmed (**VERIFY V-A2**) |
| agy keyring-timeout markers | `~/.gemini/antigravity-cli/cache/antigravity-keyring-unavailable` (CLI) and `~/.gemini/cache/antigravity-keyring-unavailable` (language server) [R05 §a] | unconfirmed (**VERIFY V-A2**) | unconfirmed (**VERIFY V-A2**) |
| agy history | `~/.gemini/antigravity-cli/{conversation_summaries.db, brain/<id>/, cache/last_conversations.json}` | the Linux path under `~`, unconfirmed (**VERIFY V-A2**) | the Linux path under `%USERPROFILE%`, unconfirmed (**VERIFY V-A2**) |
| agy log | `~/.gemini/antigravity-cli/log/` (**VERIFY V-A2**) | the Linux path under `~`, unconfirmed (**VERIFY V-A2**) | the Linux path under `%USERPROFILE%`, unconfirmed (**VERIFY V-A2**) |
| copilot credential | keychain `copilot-cli`, or `~/.copilot/config.json` (consented plaintext); env tokens outrank both | same | same |
| copilot history | `$COPILOT_HOME/session-state/<id>/` (default `~/.copilot`) | same | same |

Notes:
- **claude credential slot** [R04 §1a]. `<dir>`, `<suffix>` and the account follow the slot derivation in §8.1, kept in claude `facts.go`:
  - no suffix when `CLAUDE_SECURESTORAGE_CONFIG_DIR` is set but empty, or when it is unset and `CLAUDE_CONFIG_DIR` is unset or empty;
  - otherwise `<suffix>` is the first 8 hex digits of the sha256 of the raw NFC string of `CLAUDE_SECURESTORAGE_CONFIG_DIR` when it is set, else of `CLAUDE_CONFIG_DIR` (no symlink resolution, `~` expansion or trailing-slash trimming);
  - an account name that fails `^[a-zA-Z0-9._-]+$` becomes `claude-code-user`.
- **claude `<slug>`** [R04 §1]: the working directory with every UTF-16 code unit outside `[A-Za-z0-9]` replaced by `-` (a character outside the BMP becomes `--`). A slug over 200 characters is truncated and gets a `-<base36 hash>` suffix whose algorithm is unverified, so for such paths accshift locates the transcript by globbing `projects/*/<sessionId>.jsonl`.
- **agy on macOS and Windows.** agy's app-data directory there is unconfirmed (R07 open question), so every macOS and Windows agy path is **VERIFY V-A2**; `facts.go` records the verified paths per OS (§8.3.1).

## Appendix C: limit, auth and session signals per CLI

- Regexes are case-insensitive unless noted. `’` means U+2019. The corpus in `testdata/corpus/` is authoritative; this appendix is the starting set.
- **Where patterns apply.** Text patterns are applied to decoded message strings (the JSON `result`, `message` and `error.message` fields, after unescaping), and to raw lines only for text-mode output. A `^` anchor refers to the start of the decoded string.
- **Classes** (`classify`, §11.2): `limit` (a limit record, tiers per §9.4), `blocked` (sets `attentionCode`: sticky `needs-attention`, no limit record), `auth` (an ambiguous strike, §9.2), `auth-definitive` (sets `relogin`, §9.2), `transient` (retry the same account; no record), `error` (no state change, `rotate:false`), `session-lost` and `resume-incompatible`.
- **UNVERIFIED (no fixture)** marks a string that no research report evidences. It is not used for classification until a verbatim corpus fixture lands (§18.1), or it is removed: evidence that matches only such a string classifies as `unknown`.

**C.1 claude**

| Outcome | Signal |
|---|---|
| limit, tier 3 | stream-json `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":<s>,"rateLimitType":…}}`, or the transcript's `rate_limit_info` with the same fields [R04 §1d, §1e] |
| limit, no reset | assistant `"error":"rate_limit"`; result `is_error:true` + `api_error_status:429`. These detect a limit but carry no reset time, so they are not tier-3 evidence: the reset comes from the text row (tier 2), else the unknown-reset backoff (tier 1) |
| limit (text), tier 2 | `^(You['’]ve hit your\|You['’]ve reached your\|You['’]re out of (usage credits\|extra usage))` on the decoded `result`. Reset: `resets (?:(?P<mon>[A-Z][a-z]{2}) (?P<day>\d{1,2}),? (?:(?P<y>\d{4}),? )?)?(?P<h>\d{1,2})(?::(?P<m>\d{2}))?\s?(?P<ap>am\|pm)(?: \((?P<tz>[^)]+)\))?`, which covers `3pm`, `3:30pm`, `Oct 9, 3pm` and `Oct 9, 2027, 3pm` (the year appears when it differs) [R04 §1e] |
| blocked | assistant `error` `account_on_hold`, `verification_required`, `billing_error` or `oauth_org_not_allowed` (attentionCode = that value); text `Your org is out of usage`, `Your seat type doesn['’]t include`, `Your usage allocation has been disabled`, `Your group['’]s usage limit is set to \$0`, `This service is disabled for your org` (attentionCode `blocked-org`) |
| auth | `has no refresh token — it cannot self-heal`, `authentication_failed`, `Invalid bearer token`, `api_error_status` 401. UNVERIFIED (no fixture): `OAuth token has expired` |
| auth-definitive | `invalid_grant` on a refresh (`native`, `login-slot`) → `relogin` `refresh-dead` [R04 §1f]. Its rendered text is UNVERIFIED (no fixture) |
| session-lost | `No conversation found with session ID` |
| transient | assistant `error` `overloaded` or `server_error` [R04 §1e]. UNVERIFIED (no fixture): `api_error_status` 529 / 500–504 |

**C.2 codex**

| Outcome | Signal |
|---|---|
| limit (text), tier 2 | `You['’]ve hit your usage limit` → scope `account`; `usage limit for (?P<name>.+?)\. Switch to another model` → `model:<bucket(name)>`. Reset `try again at (?:(?P<mon>[A-Z][a-z]{2}) (?P<day>\d{1,2})(?:st\|nd\|rd\|th), (?P<y>\d{4}) )?(?P<h>\d{1,2}):(?P<m>\d{2}) (?P<ap>AM\|PM)` (local time) [R04 §2f] |
| limit, tier 1 | `try again later`: no reset, unknown-reset backoff |
| limit, tier 3 | rollout `token_count.rate_limits` of the thread, from events at or after `--run-started-at`: only when the thread's last `token_count` has `rate_limit_reached_type == "rate_limit_reached"`. Reset = the latest `resets_at` (s) among windows with `used_percent >= 100`; if no window is at 100, the later of the primary and secondary `resets_at` (resetConfidence `parsed`). `used_percent` alone is never a signal [R03 §9, R04 §2f] |
| blocked | `rate_limit_reached_type` `workspace_owner_credits_depleted`, `workspace_member_credits_depleted`, `workspace_owner_usage_limit_reached` or `workspace_member_usage_limit_reached` (attentionCode = that value); text `Your workspace is out of credits` (attentionCode `workspace-out-of-credits`), `You hit your spend cap` (attentionCode `workspace-spend-cap`). No limit record |
| auth-definitive | `since logged out or signed in to another account` → `relogin` `rejected`; `refresh_token_expired`, `refresh_token_invalidated` → `refresh-dead` |
| auth-definitive or transient | `refresh token was already used` (`refresh_token_reused`): `refresh-dead` only if the account's `auth.json` was not rewritten at or after `--run-started-at` (mtime and `last_refresh`; `native`: mtime only); otherwise `transient`, with no strike and no record. In keyring, auto or Windows secrets mode it is an `auth` strike. Plain `classify` reports `auth-definitive` (§8.2, §9.2) |
| auth | a plain 401. UNVERIFIED (no fixture): `401 Unauthorized` |
| resume-incompatible | `invalid_encrypted_content`, `could not be verified`, `organization_id did not match` |
| session-lost | `codex exec resume` of an unknown thread id. Exact text **VERIFY V-X5**; until then UNVERIFIED (no fixture): `no rollout found for thread id`, `thread not found` |

**C.3 agy**

An `AGY_ERROR` line is classified only from its JSON (row below). The other rows apply to the rest of the output.

| Outcome | Signal |
|---|---|
| limit | `RESOURCE_EXHAUSTED`, `code 429`, `Individual quota reached`, `quota (exceeded\|reached)`, `Your AI credits balance is too low`, `Out of credits`. Reset `Resets in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?` (tier 2), else unknown (tier 1) [R05 §f] |
| `AGY_ERROR: {json}` (one stderr line, exit 3) | printed for **any** model or agent failure [R05 §f]. Parse the JSON (key names in agy `facts.go`, from a corpus fixture), then, in this order: a `MODEL_CAPACITY_*` status or `Overloaded prefill queue` message → `transient`; status `RESOURCE_EXHAUSTED` or code 429 with a quota or credits message → `limit` (reset from a `Resets in …` text, else tier 1); status `UNAVAILABLE`, an HTTP 5xx code or retryable true → `transient`; status `UNAUTHENTICATED` or `PERMISSION_DENIED` → `auth` (**VERIFY V-A11**); anything else → `error`. Each branch needs a verbatim fixture before it ships (§18.1) |
| transient | `MODEL_CAPACITY_EXHAUSTED`, `Overloaded prefill queue`, `502` / `503` / `504` |
| auth-definitive | agy emptied every slot during the run. agy clears its entry on a definitive server rejection [R05 §d], so `exec` records `relogin` `rejected` itself (§8.3.3); this is not an output pattern |
| auth | texts for a revoked, expired or disabled login: UNVERIFIED (no fixture), **VERIFY V-A11** |

**C.4 gemini**: out of scope (§8.4).

**C.5 copilot**

Fields are accepted top-level and under `.data` [R06 C12].

| Outcome | Signal |
|---|---|
| limit | `session.error` with `data.errorType == "rate_limit"` (errorCode `user_weekly_rate_limited`, `user_global_rate_limited`, `user_model_rate_limited`, `integration_rate_limited`, `rate_limited`), or `data.errorType == "quota"` with errorCode `quota_exceeded` or `additional_spend_limit_reached`; also `free_quota_exceeded` and `legacy_cap_reached` (in the binary, no fixture yet: **VERIFY V-P1**). Scope `model:<bucket>` for `user_model_rate_limited`, else `account`. Reset: `auto_mode_switch.requested.data.retryAfterSeconds` (tier 3, anchored at the event timestamp); for the quota codes without it, the 1st of next month 00:00 UTC (tier 3); text `resets in ~(\d+)s` and `Your quota resets <date>` (tier 2; a `<date>` that does not parse as a full date is ignored); else tier 1 |
| error (`rotate:false`, no state change) | `session_quota_exceeded` (`You['’]ve reached the spending limit for this session`: the user's own per-session cap [R06 §2.6, C11]); `context_limit` |
| blocked | `billing_not_configured` (attentionCode `billing_not_configured`); `multiple GitHub Copilot licenses` (attentionCode `multiple-licenses`) |
| auth | `errorType ∈ {authentication, authorization}`; `contains a classic PAT and will be ignored` |
| resume-incompatible | `belongs to a different GitHub user` |

## Appendix D: JSON schemas

The schemas ship in `docs/schemas/` (JSON Schema 2020-12) and contract tests validate against them. Normative field lists follow. In D.1–D.3, `?` marks an optional key; all times in state.json are UTC epoch seconds.

- **D.1 `accounts.json`** (§6.2)
  - `{version:1, clis:{<cli>:{mainHome?, mainSqliteHome?, bin?, buckets?:{<model>:<bucket>}, shareExtra?:[name], settings?:Settings, accounts:[Account]}}, settings:Settings}`.
    - `mainHome`, `mainSqliteHome`: the vendor's main homes (codex, §8.2). `bin`: absolute path of the vendor binary (§12.2); a relative value fails validation (§6.4). `buckets`: model → bucket overrides of `facts.go` (§9.1). `shareExtra`: extra overlay link names, validated like the built-in allowlist (§8.2). `settings`: per-cli overrides of the global `settings`.
  - `Account = {id, name, kind, label?, plan?, enabled, createdAt, expiresAt?, secretId?, home?, identity?:{email?, chatgptAccountId?, chatgptUserId?, login?, host?}, extraEnv?:{[k]:string}, agySlotUsed?:{store, path, agyVersion}, notes?}`.
    - `id`: 8 lowercase hex characters, random at `add`, immutable, unique across the registry and never reused (§6.2). It keys the overlay `homes/<cli>/<id>`, the vault `secretId` `<cli>/<id>` and the state.json key `<cli>/<id>`.
    - `name` matches the account-name rule of §3 and is unique per cli. `rename` changes only `name`.
    - `kind`: claude `token` | `native` | `login-slot`; codex `home` | `native` | `access-token` | `api-key`; agy `slot`; copilot `token` | `gh` | `native` (§8).
    - `secretId` is `<cli>/<id>` for the kinds whose secret accshift holds: claude `token`, codex `access-token` and `api-key`, copilot `token`, agy `slot` (§7.1).
    - `home` is the canonical path of `<root>/homes/<cli>/<id>` (codex overlays, claude `login-slot`); only a `native` codex account may adopt a home outside the root (§6.2).
    - `identity.login` and `identity.host` (copilot): the gh login (`gh` kind) and the GitHub host, default `github.com` (§8.5).
    - `agySlotUsed` (agy): the store (`keyring`, `file` or `ls-file`, the language-server token file) and path (null for `keyring`) that agy wrote at the last `add`, `login` or `--capture-current`, with `agyVersion` (§8.3.4). On macOS and Windows it decides the resolved slot until V-A3 is recorded (§8.3.2).
  - `extraEnv` keys MUST be on the per-cli allowlist in `facts.go`. In v1 no cli has entries; the field is kept for later adapters. Any other key makes the registry invalid (exit 78 `config-corrupt`). The child gets `parent − ACCSHIFT_* − scrub + extraEnv + set` (§12.5).
  - `Settings = {minCooldownSeconds=60, unknownResetBackoffMinutes:{start=30, max=300}, earlyRehitBackoffMinutes:{start=5, max=60}, authSuspectMinutes=15, slotWaitSeconds=30, updateCheck:"off"|"daily"="off", agyRestoreAfterRun?:<agy account name>, agyAllowNetworkHome=false, keystoreProbeSeconds=3, keystoreOpSeconds=10}`. Meanings are in the §6.2 table. For a command on cli C, `clis.C.settings.<key>` beats `settings.<key>`, which beats the default; `updateCheck` is read only from the global `settings`.
  - `config` keys are dotted paths from the registry root: `clis.<cli>.mainHome`, `clis.<cli>.mainSqliteHome`, `clis.<cli>.bin`, `clis.<cli>.buckets.<model>`, `clis.<cli>.shareExtra`, `settings.<key>` and `clis.<cli>.settings.<key>` (§6.2).
- **D.2 `state.json`** (§6.3)
  - `{version:1, notice?:{acceptedAt, version}, accounts:{"<cli>/<id>": AccountState}, agySlot?:{owner, store, writtenAt, saveBackPending?}, agyBinary?:{path, size, mtime, version}, updateCheckedAt?}`.
  - `AccountState = {status, reason, records:[Record], relogin:null|{reason:"rejected"|"refresh-dead"|"expired"|"missing", since, snippet?}, authStrikes, lastStrikeAt?, attentionCode?, backoff?:{"<scope>":{hits, lastUntil, lastHitAt, rehitMinutes}}, lastUsedAt?, lastOkAt?, utilization?:{five_hour?, seven_day?, observedAt}, wrongAccount?:{expected, found, observedAt}}`.
  - `Record = {kind:"limit"|"auth-suspect", scope:"account"|"model:<bucket>", until, tier:1|2|3|4, limitSource:"structured"|"text"|"caller"|"default"|"user"|"auth", resetConfidence:"exact"|"parsed"|"guess", limitType?, observedAt, snippet?, clamped?:true}`.
  - Rules:
    - Accounts are keyed by the immutable id, never the name. `remove` deletes the entry (§10.2).
    - `tier` and `limitSource` go together: 4 `user`; 3 `structured`; 2 `text` or `caller`; 1 `default` or `auth` (§9.4). An `auth-suspect` record has scope `account`, tier 1 and limitSource `auth`.
    - `until` is the reset as stored, without the 30 s skew margin (§9.3).
    - `status` and `reason` are display caches, never used for selection (§9.2).
    - `agySlot` is a hint only (§6.3). `agySlot.owner` is an agy account id, or null. `wrongAccount.expected` and `.found` are emails; `found` may be null or belong to no registered account.
    - There is no `Record.hits`, no `earlyRehitBackoffMinutes` and no session map: backoff memory lives in `backoff` (§9.4).
- **D.3 vault plaintext:** `{version:1, entries:{"<secretId>":{type:"token"|"api-key"|"agy-slot"|"agy-swap-backup", value:string, createdAt, updatedAt, fingerprint}}}` (§7.2).
  - `value` is the base64 of the raw secret bytes. `fingerprint` is the first 8 lowercase hex characters of the SHA-256 of those bytes; it serves duplicate detection and `doctor`, and is never logged together with a value.
  - `type` by entry: claude and copilot `token`, codex `access-token` → `token`; codex `api-key` → `api-key`; `agy/<id>`, `agy/_unregistered/<email>`, `agy/_unknown/<sha256-8>` and `agy/_unparsed/<store>-<epoch>` → `agy-slot` (raw slot bytes); `agy/_swap/<startedAt>` → `agy-swap-backup`.
  - An `agy-swap-backup` value is the base64 of the JSON `[{store, path, bytes}]`, one element per slot that held a credential (`bytes` in base64, `path` null for `keyring`) (§8.3.3 B.5).
  - Reserved agy ids (§7.2): `agy/_unregistered/<email>`, `agy/_unknown/<sha256-8>` (the first 8 hex of the SHA-256 of the raw bytes), `agy/_unparsed/<store>-<epoch>` and `agy/_swap/<startedAt>`. There is no `agy/_last`.
- **D.3a vault header:** `magic "ACSV" ‖ version ‖ keySourceId ‖ keyId(16) ‖ keyFilePath? ‖ bodyNonce(24) ‖ wrappedDataKey(72 = wrapNonce(24) ‖ ciphertext(32) ‖ tag(16))` (§7.2).
- **D.3b agy journal:** `{op:"swap"|"add"|"sign-out", from, to, saved:[{secretId, store, path}], backupSecretId, startedAt, pid, startTime}` (§13.3).
  - `op`: `swap` (`exec agy`, `agy use` and the restore-after-run swap, §8.3.3), `add` (`add agy` and `login agy`, §8.3.4), `sign-out` (`remove agy --sign-out-slot`).
  - `from`: the agy account id whose credential the slots held, or null. `to`: the incoming account id (for `add`, the account being added or logged in); null for `sign-out`.
  - `saved`: every slot that held a credential, by store (`keyring`, `file`, `ls-file`) and, for files, exact path (else null), with the vault entry its content was saved to.
  - `backupSecretId` = `agy/_swap/<startedAt>`, the per-operation backup recovery rolls back from. `startedAt` is in epoch seconds. `pid` and `startTime` are diagnostics only; recovery never checks them.
- **D.4 contract responses** (§11.2). Every response is one JSON object with `contract` and follows §11.1: an absent value is `null`, never an omitted key, and every timestamp is given as `foo` (RFC 3339 UTC) and `fooEpoch` (integer seconds). The two forms MUST denote the same instant; a schema test checks every pair in the examples and goldens. `?` below marks a field that is `null` when it does not apply.
  - **Error object:** `error:{code, message, hint?}`. `code` is a kebab-case id (Appendix E, §12.1.1); `message` comes from the fixed catalogue. A response that is only an error is `{contract, error}`.
  - **`version`:** `{contract, name, version, commit, goos, goarch, root, rootSource:"ACCSHIFT_HOME"|"XDG_DATA_HOME"|"default", contracts:[int], supportedClis:[cli], experimental:[cli], capabilities:{<cli>:{sessionPortable, lockScope:"none"|"machine", usageProbe:"per-account"|"none", dataDir?}}, stderrCatalogue:[string]}`. `supportedClis` lists every cli `exec` can run on this OS, and `experimental ⊆ supportedClis`. `stderrCatalogue` lists, verbatim, every line `exec` can write to stderr; lines interpolate nothing and contain no digits, so the list is exhaustive (§12.1.1). Each release also ships it as `testdata/stderr-catalogue.txt`.
  - **Limit:** `{kind:"limit"|"auth-suspect", scope, until, untilEpoch, tier, limitType?, limitSource}`, with the stored `until`.
  - **AccountEntry** (`list`, `status`, `enable`, `disable`, `order`): `{name, id, kind, label?, state:"ready"|"limited"|"needs-relogin"|"needs-attention"|"disabled", reason?, enabled, usageProbe, limitedUntil?, limitedUntilEpoch?, limitType?, limitSource?, limits:[Limit], expiresSoon, expiresAt?, expiresAtEpoch?, lastUsedAt?, lastUsedAtEpoch?}`.
    - The summary fields describe the record with the latest `until` among the records that block a model-less request (§9.1); `limitedUntilEpoch` is the stored value, without the skew margin.
    - `usageProbe` is true only for claude `native`.
    - `id` is the immutable account id (§6.2).
  - **`list <cli>`:** `{contract, cli, poolSize, rotationPossible, poolDropped:[name], accounts:[AccountEntry]}`. Without a cli: `{contract, clis:[<the per-cli object, without contract>]}`. `list` never exits 69: with no accounts or an unsupported cli it returns `accounts:[]`, `poolSize:0`, `rotationPossible:false`.
  - **`status [cli]`:** the `list` shape, plus:
    - top level: `vault:{exists, keySource?, keyId?, keyFilePath?}` (from the header only, as `vault status`) and `notice:{accepted, version?, acceptedAt?, acceptedAtEpoch?}` (`accepted` is true when `version` is the binary's current notice version). Without a cli: `{contract, vault, notice, clis:[…]}`;
    - in the agy per-cli object: `agySlot?:{owner?, store?, writtenAt?, writtenAtEpoch?, saveBackPending}` (the state.json hint with `owner` as the account name; no keystore access);
    - in every AccountEntry: `relogin?:{reason, since, sinceEpoch}`, `attentionCode?`, `authStrikes`, `lastStrikeAt?`, `lastStrikeAtEpoch?`, `lastOkAt?`, `lastOkAtEpoch?`, `utilization?:{<window>:fraction, observedAt, observedAtEpoch}` (display only), and for agy `wrongAccount?:{expected, found?, observedAt, observedAtEpoch}` (emails).
  - **`pick` / `next` / `mark`:** `{contract, cli, account?, previous?, switched, available?, resetAt?, resetAtEpoch?, poolSize, rotationPossible, poolDropped:[name], preferIgnored, sessionPortable?, sessionPortability?:"yes"|"likely"|"possible"|"unlikely"|"no", recorded?, accounts:[{name, state, reason?, limitedUntil?, limitedUntilEpoch?, limits:[Limit]}], error?}`.
    - `accounts[]`: the pool after dropping unknown names (else every account of the cli), in candidate order, disabled ones included. `limits` lists every active record; `state`, `reason` and the summary fields follow the AccountEntry rules.
    - `pick`: `previous:null`, `switched:false`, `recorded:null`, `sessionPortable:null`, `sessionPortability:null`.
    - `next`: `previous` = `--from`; `switched` is true only when `account` and `previous` are both non-null and differ (so false on 69 and 77, and on a 75 that names `--from`).
    - `mark`: selects nothing. `account`, `previous`, `available`, `resetAt`, `resetAtEpoch`, `sessionPortable` and `sessionPortability` are null, `switched` is false, and `recorded` is set.
    - `preferIgnored` is true when `pick` did not honour a given `--prefer` (§9.3); always false for `next` and `mark`. `poolDropped` lists unknown `--pool` names.
    - `sessionPortable` and `sessionPortability` are null whenever `account` is null.
    - `recorded`: null for `pick` and for an unknown `--from`; otherwise `{account, class, kind?, scope?, until?, untilEpoch?, tier?, limitSource?, resetConfidence?, limitType?, relogin?, attentionCode?}`.
      - `class` is the evidence class that decided (§9.3), else `limit` or `auth` from `--reason`, `--limited-until` or `--auth-failed`, and `ok` / `clear` for `mark --ok` / `mark --clear`. When nothing was stored (for example a codex refresh race), `class` still names the evidence class and the record fields are null. `untilEpoch` is the stored value.
      - `relogin` is the reason this call set (`rejected`, `refresh-dead`); `attentionCode` the code this call set; else null.
    - Exit 0: `available:true`, `account` set, `error:null`.
    - Exit 75: `available:false`; `account` = the soonest-free account (it may be `--from`); `resetAt` / `resetAtEpoch` = its effective reset + 30 s; `error:null`.
    - Exit 69 and 77: `available:false`, `account:null`, and `error` set (69: `empty-pool`, `unsupported-cli`, `notice-not-accepted` with the hint `accshift notice --accept`; 77: `needs-relogin`). Only `pick` and `next` exit 69.
    - `mark --clear` on an account past `expiresAt`: the `mark` shape with `error` `expired` (exit 65).
    - Every other non-zero exit returns the plain error response.
  - **`enable` / `disable` / `order`:** `{contract, cli, accounts:[AccountEntry]}`.
  - **`classify`:** `{contract, cli, class, scope?, limitType?, resetAt?, resetAtEpoch?, tier?, limitSource?, resetConfidence?, retrySameAccount, rotate, attentionCode?, snippet?, sessionId?, recorded?}`. `class` is one of the Appendix C classes, `config-error`, `ok` or `unknown` (it may grow). `recorded` is null unless `--record`. `classify` exits 0 for every class, and 66 when the evidence file is unreadable.
  - **`doctor`:** `{contract, ok, root, rootSource, findings:[{severity:"error"|"warn"|"info", cli?, account?, code, message, hint?}]}`. `ok` is false when any finding has severity `error`. `doctor` without `--fix` is read-only and exits 0 whenever it ran; callers read `ok`. `doctor --fix` is a writer: it exits 0 when every fix it attempted succeeded or nothing needed fixing, else 73 (a lock timeout, a foreign agy), 74 (keystore) or 78, and still prints this shape with the findings. LimitShift only calls `doctor --json`, never `--fix`.
  - **`notice`:** `{contract, notice:{accepted, version?, acceptedAt?, acceptedAtEpoch?}}`, the `status` notice object after the command. Without `--accept` (and without `y` at its TTY prompt) `notice` is read-only; `notice --accept` writes `state.notice = {acceptedAt, version}` under `state.lock` (§6.3, Appendix F).
  - **`vault status`:** `{contract, exists, keySource?, keyId?, keyFilePath?}`.
  - **`env --format json`** (diagnostic; LimitShift never uses it): `{contract, cli, account, set:{<name>:<value>}, unset:[name], secretNames:[name]}`. Secret values read `<redacted:<secretId>>` unless `--reveal-secrets`.
  - **Status file** (`exec --status-file PATH`, §12.1.1; one line, same framing; `run` has no status file): `{contract, launched, cli, account, exitCode?, error?:{code, reason?}, addedArgs:[string], foreignAgy, wrongAccount?:{expected, found?, observedAt, observedAtEpoch}, postRunError?:{code, reason?}}`.
    - Pre-launch failure: `launched:false`, `exitCode` 125, 126 or 127, and `error` set. `error.reason` refines the code: `missing` or `expired` for `needs-relogin` with `--account` (null when exec picked the account), `key-file-permissions` for a `keystore-unavailable` from the key-file check (§7.3); else null.
    - execve path: written just before execve with `launched:true` and `exitCode:null`. If execve returns, exec rewrites it with `launched:false`, the error and the exit status (125/126/127).
    - spawn path: rewritten after the child exits, with `exitCode` (the child's status, or 128+n) and the post-run fields.
    - `addedArgs` lists the one argument `exec` may prepend (§8.5); it is `[]` otherwise.
    - `foreignAgy` is true when the agy shared fast path ran while a foreign agy was running (§8.3.3), else false.
    - `postRunError` reports a failed or skipped post-run hook, for example `save-back-failed`, `agy-slot-unregistered` (restore-after-run skipped), `copy-back-conflict`, `copy-back-skipped` or `copy-back-failed`. It never changes `exitCode`.

## Appendix E: exit codes

Codes 64–78 are those of the **control verbs** (every command other than `exec` and `run`). `exec` and `run` never use them for their own failures: every failure before the child starts is 125, whatever code a control verb would use for the same condition, and 126 and 127 cover the binary itself (§12.1.1). A cli can exit 125–127 on its own; `--status-file` (`launched`) tells the two apart.

| Code | Name | Commands | Caller action (LimitShift) |
|---|---|---|---|
| 0 | OK | all | proceed |
| 1–124 | child exit | exec, run | normal CLI result handling |
| 64 | USAGE | control verbs: `usage` (bad, unknown or conflicting flags; input that non-interactive mode cannot get, such as `config edit` without a terminal); `native-account` (`login` on a `native` account, with the vendor's own login command as the hint); `unknown-cli`; `unknown-account` where a command names its target (`mark --account`, `enable`, `disable`, `order`, `login`, `remove`, `rename`, `env`, `agy use`, `doctor --account`, `classify --record --account`; never `--prefer`, `--pool` or `next --from`, §9.3) | bug in caller: needs-human |
| 65 | DATAERR | `add`, `login`, `remove`, `mark --clear`, `config`, `notice`, `vault import`: `invalid-token` (a token or key that fails its format check, §8), `classic-pat-unsupported`, `gh-token-unavailable` (`add`/`login copilot --kind gh`, §8.5), `identity-mismatch`, `duplicate-account`, `no-login-detected`, `securestorage-ignored`, `invalid-import` (codex `--import-home` names `mainHome`, §8.2), `notice-not-accepted` (the notice declined at `add` or `notice`), `account-in-use` and `agy-account-live` (`remove`), `expired` (`mark --clear` past `expiresAt`), `invalid-config` (an invalid `config` value or edit, such as a `clis.codex.mainHome` inside `<root>/homes/` or a relative `clis.<cli>.bin`, §6.2), `invalid-bundle` (`vault import`: a wrong passphrase or a damaged bundle) | needs-human |
| 66 | NOINPUT | `classify`: `evidence-unreadable` (the evidence file cannot be read) | treat as no evidence |
| 69 | UNAVAILABLE | `pick`, `next`: `empty-pool` (no accounts, every `--pool` name unknown, or every remaining account disabled), `unsupported-cli`, `notice-not-accepted` (hint `accshift notice --accept`); `env`: `requires-exec`. No other command exits 69: `list` and `status` with no accounts or an unsupported cli return `accounts:[]`, `poolSize:0`, `rotationPossible:false` | legacy launch only under the §15.2 legacy rule; otherwise needs-human (fallbacks: set the runner aside); for `notice-not-accepted` the needs-human reason carries the hint `accshift notice --accept` |
| 70 | SOFTWARE | control verbs: `internal` (a bug) | as 69, and report the bug |
| 73 | BUSY | control verbs: `state-busy` (`state.lock`, 5 s), `vault-busy` (`vault.lock`, 15 s); `slot-busy` (the agy slot lock) and `agy-busy` (a foreign agy, or an NFS root) for `agy use`, `add agy`, `login agy`, `remove agy` and `doctor --fix`; `overlay-in-use` (`add codex`, `login codex`, or `add codex --import-home`, while a codex process uses the overlay or DIR, §8.2); `agy-journal-pending` (`rename` while `journal/agy-swap.json` exists); `registry-changed` (`config edit` when accounts.json changed meanwhile) | transient: retry later. `next`'s `state-busy` recorded nothing: LimitShift waits 60 s and retries the same `next` call (never a `pick`, and never a relaunch on `--from` in between), up to accountBusyWaitMinutes. `mark --ok` is best effort and ignores it |
| 74 | IOERR | control verbs that need a secret (`add`, `login`, `remove`, `agy use`, `vault migrate`, `vault export`, `vault import`, `env --reveal-secrets`, and `doctor --fix` when it recovers an agy journal): `keystore-unavailable` (a locked, absent or timed-out keystore; a missing key item or key file, or a key file that fails the owner or mode check, §7.3; a passphrase needed in non-interactive mode), `vault-changed`, `agy-keyring-locked` (§8.3.2), `slot-write-failed` (an agy slot write or its verification failed and was rolled back, or a vault write failed for another reason, such as a full disk; §8.3.3, §13.3), `keychain-prompt-required` (§8.3.3 B.8), `keychain-line-too-long` (§7.4), `import-failed` (codex `--import-home` could not remove the source after a cross-filesystem copy, §8.2) | surface the unlock hint: needs-human |
| 75 | TEMPFAIL | `pick`, `next` | single runner: rest until `resetAtEpoch` + resetBufferMinutes, then run on `account`; fallbacks: mark the runner limited until `resetAtEpoch` and select the next runner (§15.2) |
| 77 | NOPERM | `pick`, `next`, `agy use`: every remaining candidate needs a human (`needs-relogin`: re-login, an expired token, missing credentials, or a provider block); the agy slot holds an unregistered login (`agy-slot-unregistered`, non-interactive) | legacy launch only under the §15.2 legacy rule; otherwise needs-human |
| 78 | CONFIG | control verbs: `config-corrupt` (a file that does not parse or fails validation, such as a relative `clis.<cli>.bin`, §6.4), `config-newer-version`, `insecure-permissions` (read-only commands; writers tighten), `unsupported-filesystem` (also a writer that cannot tighten a mode), `wrong-owner`, `vault-corrupt`, `vault-corrupt-present`, `key-item-exists`, `unsupported-config` (`add claude --native` with `CLAUDE_CONFIG_DIR` set but empty, §8.1; a codex `ephemeral` credential store, or a codex `mainHome` inside `<root>/homes/` at its first initialisation, §8.2) | needs-human |
| 125 | exec/run failed before the child started | exec, run | per-code action table in §15.2 (summary below) |
| 126 | found but not executable: `not-executable`, `cmd-shim-unsupported` (§12.4), `wsl-windows-binary` (§12.2) | exec, run | status file `launched:false`: needs-human, no retry. `launched:true`, or no status file: the cli's own status, normal CLI result handling |
| 127 | cli not found: `not-found` (§12.2) | exec, run | as 126 |
| 128+n | child killed by signal n | exec, run | as today |

**Exit 125 `error.code`** (the closed set, §12.1.1; on stderr as `accshift: error <code>: <catalogue message>` and in the status file): `usage`, `unknown-cli`, `unsupported-cli`, `unknown-account`, `account-disabled`, `needs-relogin`, `all-capped` (only when picking), `notice-not-accepted` (only when picking), `empty-pool` (only when picking), `wrong-owner`, `unsupported-filesystem`, `config-corrupt`, `config-newer-version`, `vault-corrupt`, `vault-changed`, `vault-busy`, `state-busy`, `slot-busy`, `agy-busy`, `keystore-unavailable`, `keychain-prompt-required`, `agy-keyring-locked`, `agy-slot-unregistered`, `agy-env-overrides-slot`, `slot-write-failed`, `bare-ignores-token`, `apikeyhelper-overrides-token`, `settings-env-overrides-token`, `base-url-would-receive-token`, `classic-pat-unsupported`, `gh-token-unavailable`, `cmdline-too-long`, `internal`. `run` reports a fully capped pool as 125 `all-capped`, never 75.

LimitShift's action per code (§15.2 is normative):
- `slot-busy`, `agy-busy`, `state-busy`, `vault-busy`: transient. Not charged to maxRetriesOnError or maxRunsPerTask: wait 60 s, re-pick, retry. After `accountBusyWaitMinutes` (default 30) of continuous busy, treat the runner as limited until now + accountBusyWaitMinutes.
- `needs-relogin`, `account-disabled`, `unknown-account`: clear the current account and re-pick (no strike).
- `keystore-unavailable`, `agy-keyring-locked`, `notice-not-accepted`: legacy launch only under the legacy rule, else needs-human.
- Every other code: needs-human, no retry.

## Appendix F: README notice (provider terms)

Shown in the README, by `accshift notice`, and at every `add` (every cli and kind, including `--native` and `--capture-current`) while state.json `notice` is unset or older than this notice's version; `add` requires `y` or `--accept-notice`, and `notice` requires `y` or `--accept` (§8, §6.3, §10.2). **Notice version: 1.** The version is incremented only when the text changes materially. Every user then accepts it again with `accshift notice --accept` or at the next `add`; until then `pick` and `next` exit 69 `notice-not-accepted` (§9.3). EN text below; the UK translation in README.uk.md is drafted in [R09 §3.5].

> **Use at your own risk: read your providers' terms.** accshift is an independent, unofficial tool for personal and educational use. It is not affiliated with or endorsed by Anthropic, OpenAI, Google or GitHub. It runs the official, unmodified CLIs on your own machine. It never signs in on your behalf, never sees your passwords, never proxies requests, and hands your tokens only to the CLI you launch.
>
> **Your agents can read every stored account.** The agents accshift launches run as you, and can read every secret accshift stores, for every account and every CLI, not only the one in use. A compromised or prompt-injected task could take all of them. Per account, accshift is no weaker than the vendors' own storage; in aggregate it is weaker. Tokens placed in a CLI's environment may also be visible to the agent's own tools and scripts.
>
> Each provider's terms govern how you may use your accounts, and they change. As of October 2026:
> - Anthropic says subscription usage limits "assume ordinary, individual usage" and restricts how subscription credentials may be used.
> - OpenAI prohibits attempts to "circumvent any rate limits or restrictions".
> - Google prohibits using third-party software to access Antigravity.
> - GitHub allows one free account per person.
>
> Using several accounts to keep working after one reaches its limit may break these terms and can get your accounts suspended. Only use accounts you own and pay for, never share them, and check the current terms yourself. This is not legal advice. accshift is provided "as is", without warranty (see LICENSE).

Before release, the owner checks every quoted phrase against the primary page linked below. The OpenAI wording was read through a mirror, so its fidelity is INFERRED [R09 §3.4].

Links (from R09 §3.4):
- Claude Code legal: https://code.claude.com/docs/en/legal-and-compliance
- Anthropic Consumer Terms: https://www.anthropic.com/legal/consumer-terms
- OpenAI Terms of Use: https://openai.com/policies/row-terms-of-use
- Antigravity terms: https://antigravity.google/terms
- GitHub Terms of Service: https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
