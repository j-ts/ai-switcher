### 8.4 gemini (Gemini CLI): out of scope

Gemini CLI is not supported (owner decision, 2026-10-10; §1.3). accshift has no `gemini` adapter, `gemini` is never in `supportedClis`, and `add gemini` exits 64 `unknown-cli`. The research stays in R06 §1 for a later version. The section number is kept so that references stay stable.

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

**Add** (`accshift add copilot <name> [--kind token|gh | --native] [--label L] [--expires DATE] [--token-stdin] [--gh-user LOGIN] [--gh-host HOST] [--accept-notice]`; flags in §10.4). Every kind first shows the provider notice when it is required (§8, Appendix F).
- `--gh-host` (default `github.com`) is stored as `identity.host` for `token` and `gh` accounts.
- `token`: read the token from a no-echo prompt or one line of `--token-stdin` and store it in the vault (`secretId` `copilot/<id>`) after the validation below.
  - `--label` is required: the GitHub login the token belongs to is user-asserted, since accshift makes no GitHub API call.
  - A token whose vault `fingerprint` (Appendix D.3) equals another copilot account's is rejected with 65 `duplicate-account`.
- `gh`: `--gh-user LOGIN` is required and stored as `identity.login`; the label defaults to it.
  - `add` runs the exec-time helper once (same scrubbed environment, timeout and checks) to prove gh holds a token for that login and host. The token is discarded, never stored or printed. A failure exits 65 with the helper's code (`classic-pat-unsupported` or `gh-token-unavailable`).
  - accshift does not run `gh auth status`, which contacts GitHub.
  - Another `gh` account with the same (host, login) is rejected with 65 `duplicate-account`.
- `native`: registers Copilot's own stored login. Nothing is stored; `--label` is user-asserted.

**Validation:**
- `add` and `login` MUST reject `ghp_` tokens (exit 65, `classic-pat-unsupported`) and accept only `github_pat_` or `gho_`.
- Any other `token`-kind secret exits 65 `invalid-token` (for the `gh` kind, other helper output is `gh-token-unavailable`, above). That includes `ghu_`, which is rejected for stored accounts because those tokens expire after 8 h.
- `--expires DATE` (RFC 3339, or `YYYY-MM-DD` for that day at 00:00 UTC, §10.2) records the PAT's `expiresAt`. `doctor` warns from 30 days before, and past it the account is `needs-relogin` with reason `expired` (§9.2).
- accshift makes no call to the GitHub API. The account label is user-asserted, or for `gh` kind taken from the given login.

**Login** (the common rules of §8):
- `token`: reads a new token with the same validation. `--label` must equal the current label; otherwise the new token is discarded and `login` exits 65 `identity-mismatch`.
- `gh`: re-runs the add-time helper check. The user refreshes gh's own login first (`gh auth login`); accshift never does.
- `native`: exits 64 `native-account` with the hint `copilot login`. Copilot's stored identity cannot be read offline (the `config.json` shape is unverified [R06 §2.4]), so `doctor` does not compare a native copilot identity.

**Environment** (Appendix A.5):
- Set `COPILOT_GITHUB_TOKEN` (`token`, `gh`). accshift never launches copilot for a `token` or `gh` account without `COPILOT_GITHUB_TOKEN` set, because Copilot would otherwise fall back to `GH_TOKEN`, `GITHUB_TOKEN` or its stored login.
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

**Session portability:** `likely` for local sessions. accshift cannot stop a caller from rotating a `--remote` session (bound to the user), but `classify` maps `belongs to a different GitHub user` → `resume-incompatible`.

---
