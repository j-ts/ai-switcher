### 8.4 gemini (Gemini CLI), tier 2

**Facts (verified against 0.63.0)** [R06 §1]:
- OAuth credentials are plaintext `<home>/.gemini/oauth_creds.json` (0600) on every OS. With `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true`, Gemini instead keeps them in **one** OS keychain item (service `gemini-cli-oauth`, account `main-account`) or an encrypted fallback file whose key is derived from the hostname and username [R06 C1]. That item does not depend on `GEMINI_CLI_HOME`, so encrypted mode would make every overlay share one credential.
- `GEMINI_CLI_HOME` replaces the home directory for all Gemini paths.
- `settings.json`, `projects.json` and `oauth_creds.json` are written with a temp file and rename, so **file symlinks break**; directory links are safe.
- `GEMINI_CLI_AUTH_OVERRIDE` is an auth-type enum, not a path: `oauth-personal`, `gemini-api-key`, `vertex-ai`, `compute-default-credentials` or `gateway`. Gemini reads it once, deletes it from its own environment, and sets `security.auth.selectedType` in memory, including in the copy it saves to `settings.json`. It may therefore persist into `settings.json` (INFERRED, **VERIFY V-G3**) [R06 §1.2].
- Sessions are local JSONL files under `tmp/<slug>/chats/`. `--resume <uuid>` and `--session-id <uuid>` exist.
- Google refresh tokens are not rotated on refresh.
- Note: for personal Google AI Pro/Ultra accounts Google points users to Antigravity, and Gemini CLI remains for enterprise and API-key use [R09 §1.4].

**Kinds:**
- `home` (default): `GEMINI_CLI_HOME=<root>/homes/gemini/<id>` (immutable id, canonical path, as for codex §8.2).
- `api-key`: `GEMINI_API_KEY` from the vault plus `GEMINI_CLI_AUTH_OVERRIDE=gemini-api-key`. It also runs in its own overlay home `<root>/homes/gemini/<id>` (copy-in, never copy-back), so Gemini never saves into the user's real `~/.gemini/settings.json` (V-G3).
- `native`: the user's own `~/.gemini` login, with no override.
  - `add gemini <name> --native` records the user's `GEMINI_CLI_AUTH_OVERRIDE` value, or null when it is not set, as the account's `nativeAuthOverride` (Appendix D.1), as §8.1 does for `CLAUDE_SECURESTORAGE_CONFIG_DIR`.
  - For a `native` run, an inherited `GEMINI_CLI_HOME` whose canonical path resolves inside `<root>/homes/` is acctshift's and is unset (§12.5).
  - An inherited `GEMINI_CLI_AUTH_OVERRIDE` is unset when acctshift removed an inherited `GEMINI_CLI_HOME` under that path rule (it resolved inside `<root>/homes/`), or when its value differs from `nativeAuthOverride`. Otherwise a value equal to `nativeAuthOverride`, such as the user's own `vertex-ai`, reaches the run. A `gemini-api-key` left in a shell by `acctshift env` (which also sets an acctshift `GEMINI_CLI_HOME`) therefore never reaches a native run. The path test never applies to this variable.

**Encrypted storage is not supported for `home` accounts.** acctshift unsets `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE` and `GEMINI_FORCE_FILE_STORAGE` in the child environment for `home` runs and for `add gemini` / `login gemini`, so each overlay uses its own `oauth_creds.json` (0600, inside the 0700 root). `doctor` warns when the user's environment sets either variable.

**Overlay home** (`home` and `api-key`): `<root>/homes/gemini/<id>/.gemini/`. **VERIFY V-G4**: the layout works for the `/auth` login, `-p` and `--resume` on Linux, macOS and Windows.
- **Per-account real files:** `oauth_creds.json` and `google_accounts.json` (`home` only), `projects.json`, `settings.json` (a copy).
- **Directory links** to the user's real `~/.gemini/`: `tmp/`, `history/`, `commands/`, `skills/`, `extensions/`, `policies/`, `agents/`, `acknowledgments/`. Also `<home>/.agents` → `~/.agents`. Junctions on Windows.
- **Never link single files** [R06 C3].
- **Copy-in before each run:** `settings.json`, `GEMINI.md`, `.env` (if present).
- **Copy-back after the run** (`home` only): `settings.json`, if its hash changed and the main copy did not.
  - Until V-G3 shows that `GEMINI_CLI_AUTH_OVERRIDE` is never written into `settings.json`, copy-back is skipped when `security.auth.selectedType` differs between the overlay copy and the main copy. One account's auth type therefore never lands in the user's settings.
  - A skipped, conflicting or failed copy-back is reported only in the status file's `postRunError` and in events.jsonl. It never changes `exec`'s exit status, and `exec` writes nothing to stderr after the child starts (§12.1.1).
  - `api-key` accounts never copy back.

**Environment** (Appendix A.4):
- `GEMINI_CLI_HOME` (`home`, `api-key`).
- `GEMINI_CLI_AUTH_OVERRIDE=oauth-personal` (`home`) or `gemini-api-key` (`api-key`), so a copied settings file can never switch the auth type.
- `GEMINI_CLI_TRUSTED_FOLDERS_PATH=~/.gemini/trustedFolders.json`, so folder trust stays global.
- **Google Cloud project.** Workspace and Code Assist Standard/Enterprise logins need `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_CLOUD_QUOTA_PROJECT` and `GOOGLE_CLOUD_LOCATION` per account [R06 §1.2]. These four are the only allowlisted `extraEnv` keys in v1 (Appendix D.1).
  - For `home` and `api-key` runs, acctshift unsets all four from the parent environment, then sets those the account's `extraEnv` lists. A project set for one account never leaks into another account's run.
  - `native` runs keep the user's values.
- Unset `GEMINI_API_KEY` and `GOOGLE_API_KEY` for `home` / `native`; unset the Vertex and other auth-type selectors for `api-key` (A.4).
- **Base URL.** For `home` and `api-key` runs, if `GOOGLE_GEMINI_BASE_URL` (name kept in `facts.go`) is set and its host is not a Google endpoint, `exec` exits 125 `base-url-would-receive-token` unless `--allow-base-url`.
- MUST NOT change `HOME`, which would also move agy and the user's other tools.
- **Launch path:**
  - `home` accounts copy `settings.json` back after the run, so they use the spawn path on every OS (§12.3). Their plan has a post-run hook, so `env` exits 69 `requires-exec` for them (§12.7).
  - `api-key` accounts have only the pre-run copy-in, and `native` accounts have no hook, so both use execve on POSIX. For `api-key`, `env` refreshes the overlay and copies in before it prints the environment.

**Add** (`acctshift add gemini <name> [--native | --kind api-key] [--label L] [--token-stdin] [--accept-notice]`; flags in §10.4). Every kind first shows the provider notice when it is required (§8, Appendix F).
- `home` (default):
  - create the overlay, then run `gemini` interactively with the account's `GEMINI_CLI_HOME` (and the encrypted-storage variables unset); the user completes `/auth` and quits;
  - read `google_accounts.json` `active` as `identity.email` and the default label. No active email → exit 65 `no-login-detected`;
  - an active email but no per-home `oauth_creds.json` → exit 65 `gemini-encrypted-storage`;
  - reject an email that another gemini account already has (65 `duplicate-account`).
- `api-key`: read the key from a no-echo prompt or one line of `--token-stdin` into the vault (`secretId` `gemini/<id>`). `--label` is required, because the identity is user-asserted; AI Studio quotas are per project, not per Google account [R06 §1.7].
- `native`: register `~/.gemini` as it is. The label is the active email of its `google_accounts.json`, read offline; `oauth_creds.json` is never opened. Record `nativeAuthOverride` (above).

**Login** (the common rules of §8):
- `home`: runs the `home` add flow in a staging overlay `<root>/homes/gemini/<id>.login/`, built like the account's own, so the current credential is untouched while the user signs in.
  - Same identity (the new active email equals `identity.email`): move the new `oauth_creds.json` and `google_accounts.json` into the account's overlay by rename (§13.2), then delete the staging directory.
  - Mismatch: delete the staging directory, so nothing changed, and exit 65 `identity-mismatch`. With `--new-identity`, the add-time dedupe applies instead, and the new files are moved in.
  - A leftover staging directory (acctshift died) is reported by `doctor` and deleted by the next `login` or by `doctor --fix`.
- `api-key`: reads a new key as `add` does. `--label` must equal the current label; otherwise the new key is discarded and `login` exits 65 `identity-mismatch`.
- `native`: exits 64 `native-account` with the hint to run `gemini` and use `/auth`.
- `doctor` compares a `native` account's `~/.gemini/google_accounts.json` active email with the recorded label, and warns on a change.

**Limits** [R06 §1.5, C5] (Appendix C.4). The `-o json` error object `{error:{type, message, code}}` decides first, then the text, in this order:
1. `ValidationRequiredError` (403, reason `VALIDATION_REQUIRED`) → class `blocked` with attentionCode `ValidationRequiredError` (sticky `needs-attention`, §9.2). The user must verify the account; a re-login does not fix it, and it is never an auth strike.
2. `RetryableQuotaError` (per-minute, or a retry of 300 s or less) → `transient`: retry the same account after `retryDelay`. No record, no rotation.
3. `TerminalQuotaError` whose reason is `MODEL_CAPACITY_EXHAUSTED` or `MODEL_CAPACITY_EXCEEDED`, or whose message says `high demand` → `transient`, as for agy (Appendix C.3). A model-wide capacity event therefore never caps every gemini account.
4. Any other `TerminalQuotaError` → `limit`. Reset: `"retryDelay":"Ns"` (tier 3); else the text `reset after 4h28m20s`, `reset in 192 hours` or `Access resets at h:mm AM TZ` (tier 2); else unknown (tier 1, §9.4).
5. `code` 429 with exit status 429 (Windows) or 173 (POSIX, INFERRED), and no type above → `limit`.

V-G1 captures real output for both the quota and the capacity cases.

**Auth:** Gemini exits 41 (`FATAL_AUTHENTICATION_ERROR`) when authentication fails [R06 §1.5]. Until a corpus fixture exists, this is UNVERIFIED and not used for classification (Appendix C.4).

**Session portability:** `likely` (the shared `tmp/` holds the chats, for `home` and `api-key` overlays alike).

**Subprocess exposure:** for `api-key` accounts, V-G2 records whether Gemini CLI strips `GEMINI_API_KEY` from shell-tool and MCP subprocesses (§7.6).

### 8.5 copilot (GitHub Copilot CLI), tier 2

**Facts (verified against 1.0.93)** [R06 §2]:
- Auth precedence: `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN` > keychain (`copilot-cli`) > `gh auth token`.
- Classic `ghp_` PATs in env vars are **silently ignored**, and Copilot falls back to the stored login, which may be a different account [R06 C8].
- `gh auth token --hostname <h> --user <login>` returns a specific gh account's token (verified with gh 2.89.0; the minimum gh version with `--user` is **VERIFY V-P3**).
- `COPILOT_GH_HOST` (and `GH_HOST`) select the auth and API host, for GitHub Enterprise data residency [R06 §2.3].
- `--secret-env-vars=<names>` keeps the named variables out of the agent's shell and MCP children [R06 §2.8].
- Limits arrive as JSONL `session.error` events with `data.errorType` `rate_limit` / `quota` and `data.errorCode`.
- Sessions live in `$COPILOT_HOME/session-state/<id>/` and are local.
- The ~190 MB package cache MUST NOT be relocated per account.

**Kinds:**
- `token` (default): `COPILOT_GITHUB_TOKEN=<fine-grained github_pat_ or gho_ token from the vault>`.
- `gh`: at exec time run `gh auth token --hostname <identity.host> --user <identity.login>` (5 s timeout) and set `COPILOT_GITHUB_TOKEN` to the result. Nothing is stored.
  - gh runs with `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` removed from **its** environment, so it returns the stored login of `<login>`.
  - The output is trimmed and must match `^(gho_|github_pat_)[A-Za-z0-9_]+$`. A classic `ghp_` token exits 125 `classic-pat-unsupported`; empty or other non-matching output, a non-zero exit or a timeout exits 125 `gh-token-unavailable`.
  - The README recommends a fine-grained PAT (`token` kind) over the `gh` kind, because a `gho_` token has broad scopes and is visible to the agent's subprocesses (§7.6).
- `native`: no injection. Unset `COPILOT_GITHUB_TOKEN`, and leave `GH_TOKEN` / `GITHUB_TOKEN` as the user has them.

**Add** (`acctshift add copilot <name> [--kind token|gh | --native] [--label L] [--expires DATE] [--token-stdin] [--gh-user LOGIN] [--gh-host HOST] [--accept-notice]`; flags in §10.4). Every kind first shows the provider notice when it is required (§8, Appendix F).
- `--gh-host` (default `github.com`) is stored as `identity.host` for `token` and `gh` accounts.
- `token`: read the token from a no-echo prompt or one line of `--token-stdin` and store it in the vault (`secretId` `copilot/<id>`) after the validation below.
  - `--label` is required: the GitHub login the token belongs to is user-asserted, since acctshift makes no GitHub API call.
  - A token whose vault `fingerprint` (Appendix D.3) equals another copilot account's is rejected with 65 `duplicate-account`.
- `gh`: `--gh-user LOGIN` is required and stored as `identity.login`; the label defaults to it.
  - `add` runs the exec-time helper once (same scrubbed environment, timeout and checks) to prove gh holds a token for that login and host. The token is discarded, never stored or printed. A failure exits 65 with the helper's code (`classic-pat-unsupported` or `gh-token-unavailable`).
  - acctshift does not run `gh auth status`, which contacts GitHub.
  - Another `gh` account with the same (host, login) is rejected with 65 `duplicate-account`.
- `native`: registers Copilot's own stored login. Nothing is stored; `--label` is user-asserted.

**Validation:**
- `add` and `login` MUST reject `ghp_` tokens (exit 65, `classic-pat-unsupported`) and accept only `github_pat_` or `gho_`.
- Any other `token`-kind secret exits 65 `invalid-token` (for the `gh` kind, other helper output is `gh-token-unavailable`, above). That includes `ghu_`, which is rejected for stored accounts because those tokens expire after 8 h.
- `--expires DATE` (RFC 3339, or `YYYY-MM-DD` for that day at 00:00 UTC, §10.2) records the PAT's `expiresAt`. `doctor` warns from 30 days before, and past it the account is `needs-relogin` with reason `expired` (§9.2).
- acctshift makes no call to the GitHub API. The account label is user-asserted, or for `gh` kind taken from the given login.

**Login** (the common rules of §8):
- `token`: reads a new token with the same validation. `--label` must equal the current label; otherwise the new token is discarded and `login` exits 65 `identity-mismatch`.
- `gh`: re-runs the add-time helper check. The user refreshes gh's own login first (`gh auth login`); acctshift never does.
- `native`: exits 64 `native-account` with the hint `copilot login`. Copilot's stored identity cannot be read offline (the `config.json` shape is unverified [R06 §2.4]), so `doctor` does not compare a native copilot identity.

**Environment** (Appendix A.5):
- Set `COPILOT_GITHUB_TOKEN` (`token`, `gh`). acctshift never launches copilot for a `token` or `gh` account without `COPILOT_GITHUB_TOKEN` set, because Copilot would otherwise fall back to `GH_TOKEN`, `GITHUB_TOKEN` or its stored login.
- **Host.** When `identity.host` is not `github.com`, also set `COPILOT_GH_HOST=<host>` (`token`, `gh`). Otherwise unset an inherited `COPILOT_GH_HOST` that names another host. A github.com token is then never sent to an Enterprise host, nor the reverse [R06 §2.3].
- **Secret isolation.** For `token` and `gh` runs, `exec` prepends `--secret-env-vars=COPILOT_GITHUB_TOKEN` unless the caller's argv already contains it. This is the only argument `exec` ever adds (§7.6, §8; `run` separately appends codex `--no-daemon`, §16), and the status file lists it in `addedArgs`. V-P2 verifies that the flag removes the token from shell-tool and MCP subprocesses in 1.0.93+, and whether it is still needed [R06 §2.8].
- Do not touch `COPILOT_HOME`, `COPILOT_CACHE_HOME` or `XDG_CACHE_HOME`.

**Limits** (Appendix C.5) [R06 §2.6, C11]:

| Signal | Classification |
|---|---|
| `errorType:"rate_limit"` with `user_weekly_rate_limited`, `user_global_rate_limited`, `user_model_rate_limited`, `integration_rate_limited` or `rate_limited` | `limit`. Scope `model:<bucket>` for `user_model_rate_limited` (the error's model, §9.1), else `account` |
| `errorType:"quota"` with `quota_exceeded` or `additional_spend_limit_reached`; also `free_quota_exceeded` and `legacy_cap_reached` (in the binary, no fixture yet: **VERIFY V-P1**) | `limit`, reset on the 1st of next month 00:00 UTC unless `retryAfterSeconds` is given |
| `session_quota_exceeded` (`You've reached the spending limit for this session`: the user's own per-session cap, `--max-ai-credits`) | `error`, `rotate:false`, no state change. The caller starts a new session |
| `billing_not_configured`, the multiple-licence error | `blocked` (sticky `needs-attention`), attentionCode `billing_not_configured` or `multiple-licenses` |
| `context_limit` | `error` |
| `authentication` / `authorization` | `auth` |

`auto_mode_switch.requested.data.retryAfterSeconds` gives the reset when present (tier 3, anchored at the event's timestamp). The text forms `resets in ~<n>s` and `Your quota resets <date>` are parsed as a fallback (tier 2). The format of `<date>` is unverified (V-P1), so a value that does not parse as a full date is ignored and never read as a clock time. A `rate_limit` with no reset gets the unknown-reset backoff (tier 1).

**Session portability:** `likely` for local sessions. acctshift cannot stop a caller from rotating a `--remote` session (bound to the user), but `classify` maps `belongs to a different GitHub user` → `resume-incompatible`.

---
