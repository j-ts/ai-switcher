## 9. Rotation and limit-state engine

The engine is a pure package (`internal/engine`) over `(registry, state, now, request)`. It returns `(decision, newState)`. All IO happens around it, under `state.lock` for writers (§13). accshift is **passive**: it never changes models or CLIs, never probes, polls or proxies, and never sleeps or relaunches inside `pick`, `next` or `mark` (DECISIONS D8, D9).

- **Parse before lock.** `next`, `mark` and `classify --record` parse the evidence and read vendor artifacts (transcript tails, Codex rollouts, codex `auth.json` metadata, §9.5) **before** they take `state.lock`. The parsed result is part of `request`; the engine itself reads no files.
- The lock covers only load, merge, select and write, so it is held for a few milliseconds (§13.1).

### 9.1 Limit records: per (cli, account, scope)

- A record is keyed by **(cli, account, scope)**. The account is the immutable account id; the state key is `<cli>/<id>` (§6.3). Scope is one of:
  - `account`: the whole account is capped, for example Claude's 5-hour `five_hour` window, which every model shares;
  - `model:<bucket>`: only one model bucket is capped, for example Claude `seven_day_opus` (an "Opus limit"), Codex "usage limit for {limit_name}", or Copilot `user_model_rate_limited` [R04 §1e, §2f; R06 §2.6].
- Every record has a **kind**:
  - `limit`: a usage limit;
  - `auth-suspect`: an ambiguous authentication failure (§9.2). It always has scope `account`, tier 1 and limitSource `auth`.
  - An active record of either kind blocks. The merge rule (§9.4) applies only between records of the same kind and scope.
- **Unknown scope is `account`.** The model is therefore never less safe than plain per-account records, and callers that never pass `--model` get exactly per-account behaviour.
- Each adapter maps models to buckets in `facts.go` (Claude: `opus`, `sonnet`, `fable` from `rateLimitType` or the limit text; Codex: `limit_id`/`limit_name`; Copilot: the model of a `user_model_rate_limited` error). Users MAY override the mapping with `accshift config clis.<cli>.buckets.<model> <bucket>` (Appendix D.1).
- **Unmapped model.** A `--model` value that maps to no bucket (neither `facts.go` nor the config) covers every bucket: all `model:` records block it. A new model name therefore never makes a limit less blocking.
- **Active:** a record is active while `now < until + 30 s` (the skew margin, §9.3). Records whose margin has passed are inactive and are pruned on the next write.
- **Blocking:**
  - without `--model`, every active record of the account blocks;
  - with `--model M`, active `account`-scope records and active records whose bucket covers M block (all model records when M is unmapped).

  An account's **effective reset** for a request is the maximum `until` over its blocking records.

Record fields (`state.json`, Appendix D.2):
- `kind` (`limit`, `auth-suspect`), `scope`, `until` (epoch s). `until` is the reset as the evidence states it, after the bounds of §9.4; it never includes the skew margin.
- `tier` (integer 1–4, §9.4) and `limitSource`, which names the source of `until` and fixes the tier: `user` = 4; `structured` = 3; `text` (accshift's own parse) and `caller` (`--limited-until`) = 2; `default` (unknown-reset backoff) and `auth` (auth-suspect) = 1.
- `resetConfidence`: `exact` (tiers 3 and 4), `parsed` (tier 2, and the Codex fallback of §9.4), `guess` (tier 1).
- `limitType?` (the vendor's window name, for example `five_hour`), `observedAt` (when accshift recorded the evidence).
- `snippet`: the matched line, at most 200 characters, with token-like strings masked per §14.4. Raw CLI output is never stored.
- `clamped: true` when a bound of §9.4 shortened `until`.
- Backoff memory is **not** part of a record. It lives in the account's `backoff` map (§9.4), so pruning a record never loses it.

`list`, `status` and `accounts[]` report every active record as `limits:[{kind, scope, until, untilEpoch, tier, limitType, limitSource}]`, so concurrent records stay visible. Their summary fields (`limitedUntil`, `limitType`, `limitSource`) describe the record with the latest `until` among those that block a model-less request (§11.2).

### 9.2 Account states

The account **state** is a display summary. The engine recomputes it on every read from the registry (`enabled`, `expiresAt`), the account's state entry (`records`, `relogin`, `attentionCode`) and `now`. `state.json` caches it as `status`/`reason` for humans only. It MUST NOT be used for selection; selection uses usability (§9.3). When several states apply, the first in this order is shown: `disabled`, `needs-relogin`, `needs-attention`, `limited`, `ready`.

| State | Reason values | Derived from | Usable? | Clears |
|---|---|---|---|---|
| `ready` | – | none of the below | yes | – |
| `limited` | `limit`, `auth-suspect` (`limit` when both kinds are active) | at least one active record | per request: only blocking records count (§9.1), so a `model:opus` record leaves the account usable for a Sonnet run | automatically when the records expire (lazily, by wall clock); `mark --clear`; `mark --override` replaces the limit record of its scope; `mark --ok` and a same-identity `login` remove auth-suspect records but keep limit records |
| `needs-relogin` | `rejected`, `refresh-dead`, `missing`, `expired` | `relogin` set; `expired` is derived from `expiresAt` | no (sticky) | `login`; `mark --clear`, except `expired` |
| `needs-attention` | the provider code in `attentionCode`, e.g. `account_on_hold`, `verification_required`, `billing_error`, `oauth_org_not_allowed`, `blocked-org`, `ValidationRequiredError`, `billing_not_configured`, `workspace_owner_credits_depleted` | `attentionCode` set by class `blocked` (§9.4) | no (sticky). A re-login does not fix these | `mark --clear` after the user fixes the account |
| `disabled` | – | `enabled:false` | no | `enable` |

**`relogin`** (`state.json`: `relogin: null | {reason, since, snippet?}`):
- It is set by definitive evidence, by an escalating strike, by exec when a credential is absent (`missing`, §12.1), and by exec's agy post-run check when every slot is empty (`rejected`, §8.3.3).
- It is cleared only by `login` or `mark --clear`. No counter reset, success report or timeout ever clears it.
- `expired` is derived at read time from accounts.json `expiresAt`, whether or not `relogin` is stored. `mark --clear` cannot clear it: only `login` replaces the token (see `mark`, §9.3).

**Login effects** (common login rules, §8):
- A same-identity `login` clears `relogin`, `authStrikes` and auth-suspect records. It keeps limit records, `backoff` and `attentionCode`: a fresh token does not reset a usage window. It also keeps `lastStrikeAt`, so the incident window still sees that strike.
- `login --new-identity` runs the add-time dedupe and clears all records, `authStrikes`, `lastStrikeAt`, backoff, `attentionCode` and `relogin`, as for a newly added account.
- A native account can change identity outside accshift (the user's own vendor login). `doctor` compares its current vendor identity (email or label) with the recorded one and warns. `doctor --fix` or `mark --clear` clears that account's records.

**Definitive evidence** (class `auth-definitive`, Appendix C) sets `relogin` immediately:
- `refresh-dead`: the vendor reports the refresh token dead: `invalid_grant` [R04 §1f], codex `refresh_token_expired` and `refresh_token_invalidated`, and codex `refresh_token_reused` under the rule below;
- `rejected`: the vendor reports the login revoked or replaced: codex `…since logged out or signed in to another account…`; agy's slot emptied by agy itself during the run (agy clears its entry on a definitive server rejection [R05 §d]);
- `missing`: the vault entry or overlay auth file is absent (recorded by exec, §12.1);
- `expired`: a known `expiresAt` in the past (derived, above).

**codex `refresh_token_reused`** ("refresh token was already used"). Two processes that share one Codex home race the single-use refresh token, and the loser reports this text while `auth.json` already holds the winner's valid token [R04 C13]. So:
- It is definitive only if the account's `auth.json` was **not** rewritten after the failing run started. `next` and `mark` check this offline, before the lock: the file counts as rewritten when its mtime or its `last_refresh` field is at or after `--run-started-at`. For a `native` account only the mtime is compared (a stat; the native `auth.json` is never opened, §8.2).
- If it was rewritten, the failure is **transient**: no strike and no record. `recorded.class` is `transient`, and the account stays usable, so the caller MAY retry it once (`pick --prefer A` returns it). `next` itself still never returns A with exit 0 (§9.3).
- If the account's Codex store is not a readable file (keyring or secrets mode), the check cannot run, and the text counts as an ambiguous strike.
- `classify --record --account A` runs the check like `mark`. Plain `classify` has no account, so it reports the text as `auth-definitive` and leaves the decision to `next`/`mark`.

**Ambiguous 401/403** (class `auth`; or `--reason auth` / `mark --auth-failed` when the evidence is not decisive). A strike on account A at `now`, from a run that started at `T` (`--run-started-at`, default now − 60 s), is applied in this order:
1. **Forget stale strikes.** If A's `lastStrikeAt` is more than 24 h old, or later than now + 300 s (§9.4 clock skew), A's `authStrikes` counts as 0.
2. **Incident.** If, counting this strike, at least two accounts of the same cli have a `lastStrikeAt` within the last `authSuspectMinutes` (registered accounts, not only the request's pool), treat it as a provider incident. No account escalates. Every account in that set gets an auth-suspect record until now + `authSuspectMinutes`, and its `authStrikes` is set to 0, so incident strikes never count toward a later escalation. Their `lastStrikeAt` values are kept, so the incident window still sees them.
3. **Refresh.** Otherwise, if A has an active auth-suspect record, the strike only refreshes it: until = now + `authSuspectMinutes`.
4. **Escalate.** Otherwise, if A has a remembered strike (`authStrikes` ≥ 1) and `T` is later than A's previous `lastStrikeAt` + `authSuspectMinutes` (the run started after A's last auth-suspect record expired), set `relogin` = `{reason:"rejected"}`.
5. **First strike.** Otherwise write an auth-suspect record until now + `authSuspectMinutes`. This also covers a strike from a run that started before A's last auth-suspect record expired.

In steps 3–5, `authStrikes` increases by one and `lastStrikeAt` becomes now; in step 2, A's `lastStrikeAt` becomes now. `authSuspectMinutes` defaults to 15.

Further auth rules:
- The caller rotates away in every case (`next --reason auth`).
- Network errors, 5xx, `overloaded`, keychain I/O errors (`errSecIO`) and lock timeouts **never** count as auth strikes [R09 §1.6].
- `classify --record` and `next`/`mark --evidence-file` MUST NOT both be used for one run; each would record the same strike or limit.

**Success** is reported only by `mark --ok`:
- It clears `authStrikes`, the `backoff` map and every auth-suspect record of the account, and sets `lastOkAt` and `lastUsedAt` to now. It keeps limit records, `relogin`, `attentionCode` and `lastStrikeAt` (the incident window of other accounts still sees that strike).
- `exec` never reports success and never changes strike, backoff or `lastUsedAt` state, on any path or OS. Its only state writes are `relogin(missing)` for an absent credential, the agy post-run bookkeeping (`agySlot`, `wrongAccount`, `relogin(rejected)` on an emptied slot, `saveBackPending`) and the `agyBinary` cache (§6.3, §8.3.1, §8.3.3, §12.1).
- Without `mark --ok`, strikes are forgotten 24 h after `lastStrikeAt`, and backoff entries 24 h after the later of their `lastHitAt` and `lastUntil` (§9.4). `relogin` never ages out.

**Expiry** is computed locally:
- Claude setup-tokens: `createdAt + 365 d`;
- Copilot PATs: the user-entered `expiresAt`.

From 30 days before expiry, `expiresSoon:true` appears in `list`/`status`, and `doctor` warns. Past `expiresAt`, the account is `needs-relogin` with reason `expired`.

### 9.3 Selection policy: sticky preference order

**Candidates** are the accounts named by `--pool`, in pool order, or all accounts of the cli in registry (preference) order when no pool is given. Disabled accounts are never candidates.
- `--pool a,b`: unknown names are dropped and listed in the response as `poolDropped:[…]`; a repeated name keeps its first position. If no account remains (including an empty `--pool`), `pick` and `next` exit 69 `empty-pool`; `list`, `status` and `mark` return `accounts:[]`, `poolSize:0` and `rotationPossible:false` and never exit 69 (§10.3).
- Empty `--prefer`, `--model` and `--limited-model` values count as absent.

**Usable.** An account is usable for a request when:
- it is enabled;
- `relogin` is null and `attentionCode` is null;
- it is not past `expiresAt`;
- it has no active blocking record for the request (§9.1). A record still blocks until `until + 30 s`.

The account-level `state` (§9.2) MUST NOT be used for selection.

**Notice gate.** `pick` and `next` first check `state.notice`. Until it holds the binary's current notice version (Appendix F), they exit 69 with `error.code` `notice-not-accepted` and the hint `accshift notice --accept`, and `next` records nothing. `exec` without `--account` exits 125 `notice-not-accepted`; `exec --account` still runs. Every `add` shows the notice and stores the acceptance (§8), and so does `accshift notice --accept` (§10.2); `doctor` reports a missing one.

**`pick <cli> [--prefer P] [--model M] [--pool …]`** (read-only, lock-free). `--model M` is the model of the run about to start.
1. `P` is honoured only if it is a candidate (after `--pool` filtering) and usable for the request. Then return `P`. Stickiness keeps a task on one account, so prompt caches stay warm and there are no needless switches.
   - An unknown, disabled, non-member or unusable `P` is ignored, never an error (never exit 64 `usage` or `unknown-account`). The response then says `preferIgnored:true`.
2. Otherwise return the first usable candidate. Preference order equals priority, for example "main subscription first".
3. **agy** (checked before steps 1 and 2): `pick agy` returns `state.agySlot.owner` whenever it is a usable candidate, even if `--prefer` names another account (and then says `preferIgnored:true`). agy sessions are not portable, so stickiness buys nothing, and staying on the live owner avoids swaps and slot-lock contention [D6].
   - `pick` never opens the keystore; `state.agySlot` is only the hint. exec's lock algorithm reads the slots and is authoritative (§8.3.3).
- `pick` always returns `previous:null` and `switched:false`.

**`next <cli> --from A [--model M] [--limited-model L] [--limited-until T | --reason auth] [--run-started-at T0] [--evidence-file F] [--exit N] [--session ID] [--cwd DIR] [--pool …]`**:
- **Flags:**
  - `--reason limit|auth` defaults to `limit`. `--limited-until` together with `--reason auth` is a usage error (64 `usage`).
  - `--model M` is the model of the **next** run. It is used only for selection.
  - `--limited-model L` is the model that hit the limit. It is used only for the recorded scope, and defaults to `--model`. With models-first rotation in the caller, `--model` after a switch is usually the first model of the list while `--limited-model` is the one that failed.
  - `--run-started-at T0` (epoch s; default now − 60 s) is when the failing run started. It decides strike escalation and the codex refresh race (§9.2), and structured events older than `T0` are not evidence from the failing run (§9.4).
- **What is recorded for A.** The evidence class, when the parser finds one, decides; otherwise `--reason` does:

  | Evidence class | Recorded for A |
  |---|---|
  | `limit` | a limit record merged per §9.4 |
  | `auth` | an ambiguous strike (§9.2) |
  | `auth-definitive` | `relogin` (§9.2, including the codex refresh-race rule) |
  | `blocked` | `attentionCode`; no limit record |
  | `transient`, `error`, `session-lost`, `resume-incompatible`, `config-error` | nothing; `recorded.class` names the class |
  | none, `unknown` or `ok` | `--reason limit`: a limit record from `--limited-until` (tier 2) or an unknown reset (tier 1); `--reason auth`: an ambiguous strike |

  The scope comes from the evidence. When the evidence says the limit is model-scoped but names no bucket, the bucket of `--limited-model` is used; when that is absent or unmapped, the scope is `account`. `--limited-until` without evidence is recorded with scope `account`.
- An unknown A records nothing (`recorded:null`), and `next` still selects.
- Recording and selection happen **in the same locked transaction**; parsing happened before the lock (§9). `next` also sets A's `lastUsedAt`. A `next` that cannot take `state.lock` exits 73 `state-busy` and has recorded nothing; the caller repeats the same `next` call (§15.2).
- It returns the first usable candidate other than A, in preference order, with `previous:A` and `switched:true`. For agy it returns `state.agySlot.owner` when that is a usable candidate other than A, as `pick` would.
- It reports `sessionPortability` for the move from A to the chosen account (adapter `Portability()`, §8) and `sessionPortable`, which is true only for `yes` and `likely`.
- It is **never** cyclic or round-robin. With identical total throughput, preference order keeps `pick` and `next` consistent and needs no more switches [D8].

**`mark <cli> --account A …`** (writer; selects nothing; returns the pick/next shape with `recorded` and `account:null`, §11.2). It takes `--run-started-at`, `--evidence-file` and `--pool` as `next` does. Its `--model M` names the limited model:
- `--limited-until T` records a limit like `next`. `--override --limited-until T` writes a tier-4 record. Both write scope `model:<bucket(M)>` when `--model M` is given and maps to a bucket, else `account`.
- `--auth-failed` records a strike exactly like `next --reason auth`, without selecting.
- `--ok` reports success (§9.2).
- `--clear` removes all records, `authStrikes`, `lastStrikeAt`, `attentionCode`, the `backoff` map and `relogin`. On an account past `expiresAt` it still does so, then exits 65 with `error.code` `expired` and the hint `accshift login <cli> <name>`. `--clear --model M` removes only the records of M's bucket.

**When no candidate is usable** (same rules for `pick` and `next`; for `next`, A never counts as usable). A **waiting** candidate is one that is usable except for its active blocking records. For `next`, A also counts as waiting whenever it is a candidate and not `needs-*`, because `next` never returns A with exit 0. A's wait ends at its effective reset, or now when the evidence left it unblocked.
1. If any candidate is waiting, including A, return exit **75**, with `account` = the waiting candidate with the smallest effective reset (ties broken by candidate order) and `resetAtEpoch` = that reset + 30 s. Mixed "limited plus needs-relogin" → 75.
   - This includes a one-account pool: after `next` records A's limit or auth-suspect strike, it returns 75 naming A, or 77 if A became `needs-*`.
2. Otherwise, if any candidate is `needs-relogin` or `needs-attention` → exit **77**.
3. Otherwise → exit **69**, only for:
   - an empty candidate set: the cli has no accounts, every `--pool` name is unknown, or every remaining account is disabled (`error.code` `empty-pool`);
   - an unsupported cli (`unsupported-cli`);
   - the notice gate above (`notice-not-accepted`).

   `next` records A's evidence before selecting whenever A is a registered account and the notice gate passed, whatever the outcome. What the caller does with 69 is §15.2's business; LimitShift launches a cli unwrapped only under the legacy rule there.

`exec` without `--account` applies the same rules and reports any outcome other than 0 as exit 125 (§12.1.1).

**Skew margin.** Records store the vendor reset unchanged. The 30 s margin is added only when computing usability (a record blocks until `until + 30 s`) and `resetAtEpoch`. `resetAtEpoch` is therefore the first instant accshift itself will return that account as usable. `recorded.untilEpoch`, `limitedUntilEpoch` and `limits[].untilEpoch` show the stored value. Callers add their own sleep buffer.

Every `pick`/`next`/`mark`/`list` response carries `poolSize` and `rotationPossible` (true when at least 2 pool accounts are neither `disabled` nor `needs-*`). LimitShift's auto mode routes a runner through accshift only when the runner names accounts explicitly, or the cli is not `experimental` and `rotationPossible` is true (§15.4). The one exception is agy: while accshift has at least one agy account registered, every agy runner is routed, with or without `accounts`, under `auto` or `required` (§11.2, §15.4).

**Utilization is display-only.** Snapshots (Claude `utilization` / `unifiedWindows`, Codex `used_percent`) are stored with `observedAt` and marked stale once their window's reset has passed. They are **not** used for selection in v1. Idle accounts' values cannot be refreshed without probing, and both Codex `used_percent` and agy quota numbers have proved unreliable [R03 §9, R09 C8].

### 9.4 Evidence tiers and merge rule

The tier describes the source of the reset **value** (`until`), not the source of the detection. A structured detector that carries no reset time gives a tier-1 record.

| Tier | limitSource | Source of `until` |
|---|---|---|
| **4, user** | `user` | `mark --override --limited-until T` |
| **3, structured** (from the failing run only: events at or after `--run-started-at`) | `structured` | Claude `rate_limit_event` / transcript `rate_limit_info` with `status:"rejected"` → `resetsAt`. Codex rollout: only when the thread's last `token_count` has `rate_limit_reached_type == "rate_limit_reached"`; `until` = the latest `resets_at` among windows with `used_percent >= 100`, or, when no window is at 100, the later of the primary and secondary `resets_at` (resetConfidence `parsed`) [R03 §9, R04 §2f]. Copilot `session.error` + `auto_mode_switch.requested.data.retryAfterSeconds` (anchored at the event timestamp); `quota_exceeded` and the other monthly quota codes of Appendix C.5 → the 1st of next month 00:00 UTC. |
| **2, text** | `text`, `caller` | a reset parsed from text: accshift's own parse of `--evidence-file` (Appendix C), or the caller's `--limited-until`. When both exist in one call, take the later |
| **1, default** | `default`, `auth` | no vendor-supplied reset: the unknown-reset backoff (below), auth-suspect records, and any detector without a reset time, for example Claude `is_error` with `api_error_status` 429, Codex `Try again later`, or a Copilot `rate_limit` without `retryAfterSeconds` |

Codex `used_percent` alone, without `rate_limit_reached_type == "rate_limit_reached"`, is never a limit signal [R03 §9].

**Merge rule.** A new record meets the active record of the same account, scope and kind (with no active record, the new one is simply written):
1. Its tier comes from the table above.
2. A higher tier replaces. A lower tier replaces only if `newUntil > oldUntil`.
3. Equal tier: if `|new.observedAt − old.observedAt| < 10 min` (one incident reported by several callers or queues), keep `max(until)`. Otherwise the newer observation wins.
4. A caller `--limited-until` earlier than now + `minCooldownSeconds` is not tier-2 evidence. It becomes an unknown reset (tier 1, backoff).
5. A tier-4 record is replaced only by another `mark --override` and removed only by `mark --clear`. This overrides rule 2: no other evidence replaces or extends it.

Consequences:
- Lower-tier evidence can only lengthen a limit.
- Higher-tier evidence can shorten one, which corrects a bogus text parse [D8].
- A parallel queue cannot shorten a limit with a bad value. If its parser turns `resets in ~3600s` into "now", rule 4 makes that an unknown reset, which cannot shorten another queue's tier-2 "resets 3pm".

**Time parsing** (`internal/classify/timeparse`, embedded tzdata):
- A named IANA zone or GMT offset is honoured; otherwise local time is used.
- A bare clock time up to 15 minutes in the past means "just reset": `now + minCooldown`. A bare clock otherwise means its next occurrence.
- A month and day with no year means the next occurrence.
- Supported forms: relative (`in 4h46m9s`, `after 2 hours 5 minutes`, `reset in 192 hours`, `~37s`), Codex `Oct 9th, 2026 3:45 PM`, and Claude `Oct 9, 3pm`, `Oct 9, 2027, 3pm` (the year appears when it differs) and `3:30pm`.
- Relative resets are anchored at the evidence's own timestamp when it has one (a Copilot event), else at now.
- All times are stored as UTC epoch seconds.

**Bounds and backoff.** The keys live in `settings`, and `clis.<cli>.settings` overrides them per cli (Appendix D.1). Bounds apply to a new record's `until` before the merge rule:
- `minCooldownSeconds` (60): an `until` earlier than now + 60 s becomes now + 60 s.
- **Upper bound:** an `until` more than 32 days ahead becomes now + 32 d, with `clamped:true`.
- **Clock skew** (at read time): a record with `observedAt` > now + 300 s, or `until` > now + 32 d, is treated as `until = min(until, now + (until − observedAt), now + 32 d)` with `clamped:true`, and is rewritten that way on the next write. For example, a record written while the clock ran a year ahead, with `until` = `observedAt` + 4 h, reads after the clock is corrected as now + 4 h, not a year away. Stored timestamps later than now + 300 s are ignored when computing the strike, backoff and early re-hit windows.
- **Backoff memory:** each account keeps `backoff:{"<scope>":{hits, lastUntil, lastHitAt, rehitMinutes}}`:
  - `hits`: consecutive unknown-reset hits of that scope; a hit with a known reset sets it to 0;
  - `lastUntil`: the `until` of the last limit record written for the scope;
  - `lastHitAt`: when that hit was recorded;
  - `rehitMinutes`: the current early re-hit backoff, 0 when none.

  Pruning removes expired records but keeps a backoff entry until 24 h after the later of its `lastHitAt` and `lastUntil`, so a weekly or monthly record keeps its early re-hit memory after it expires. `mark --ok` and `mark --clear` delete the whole map.
- **Unknown reset** (`unknownResetBackoffMinutes`, start 30, max 300): `until` = now + min(start × 2^`hits`, max) minutes, then `hits` increases by one. Example: three unknown-reset hits of one scope, each soon after the previous record expired and with unrelated writes in between, give 30, 60 and 120 minutes.
- **Early re-hit** (`earlyRehitBackoffMinutes`, start 5, max 60): a limit hit while `lastUntil ≤ now < lastUntil + 15 min` (within 15 minutes after the scope's previous record expired) sets `rehitMinutes` to the start value when it is 0, and otherwise doubles it up to the max. It then forces `until ≥ now + rehitMinutes`. A hit outside that window sets `rehitMinutes` to 0.
- Every limit record written updates its scope's entry: `lastUntil` (after bounds, early re-hit and merge), `lastHitAt` = now, and `hits` as above.
- **Auth-suspect** duration: `authSuspectMinutes` (15).
- `hits` and `rehitMinutes` reset on `mark --ok`, or when their backoff entry is pruned. `authStrikes` resets on `mark --ok`, or after 24 h without a new strike (§9.2). `relogin` is never reset this way.

**Not account limits** (no limit record is created):
- agy `MODEL_CAPACITY_EXHAUSTED`, `Overloaded prefill queue` and 502/503/504 → class `transient`. An `AGY_ERROR: {json}` line (exit 3) is classified from its JSON [R05 §f]; only status `RESOURCE_EXHAUSTED` or code 429 with a quota or credits message is a limit (Appendix C.3).
- Copilot `session_quota_exceeded` (a user-set per-session cap [R06 §2.6, C11]) and `context_limit` → class `error`, `rotate:false`, no state change. The caller starts a new session.
- Claude assistant `error` `overloaded` or `server_error` → class `transient`. A numeric `api_error_status` 5xx is UNVERIFIED (Appendix C.1) and classifies as `unknown` until a fixture lands.
- Codex `used_percent >= 100` alone, without `rate_limit_reached_type == "rate_limit_reached"` (above).

**Provider blocks** (class `blocked`) set `attentionCode`, which makes the account `needs-attention` (§9.2), and create no limit record. Examples: Claude `account_on_hold` and the org or seat messages; Codex workspace credit or spend-cap exhaustion (`workspace_owner_credits_depleted`, `workspace_member_credits_depleted`, `workspace_owner_usage_limit_reached`, `workspace_member_usage_limit_reached`, "Your workspace is out of credits", "You hit your spend cap"); Copilot `billing_not_configured` and the multiple-licence error. The class is named `blocked` everywhere (Appendix C, §11.2).

### 9.5 Parsing location

- **One Go parser package** serves `classify`, `next`/`mark --evidence-file`, and the phase-2 `run`. LimitShift's sh and ps1 parsers can then be retired gradually (§15.8).
- **When:** `next`, `mark` and `classify --record` run the parser and every vendor-artifact read before taking `state.lock` (§9).
- **Inputs:**
  - the caller-captured output file (`--evidence-file`, tail-bounded to 256 KB). LimitShift passes a file that holds only the failing run's output (§15.2);
  - `--exit`, `--run-started-at` and `--limited-model`;
  - optionally `--session` and `--cwd`, to read vendor artifacts **read-only**:
    - the Claude `projects/<slug>/<session>.jsonl` tail (slug rule: Appendix B);
    - the Codex rollout for the thread id, searched in the date directories of §8.2 (a full tree walk only in `classify` without `--record`);
    - the agy log tail (path: Appendix B);
  - for codex `refresh_token_reused`, the account's `auth.json` mtime, and its `last_refresh` for non-`native` accounts (§9.2), read offline.
- **Tolerance:**
  - it accepts Copilot fields both top-level and under `.data` [R06 C12], and both `'` and `’`;
  - text patterns apply to decoded message strings (JSON `result`, `message`, `error.message`, after unescaping), and to raw lines only for text-mode output. `^` anchors refer to the decoded string (Appendix C).
- **Failure:** a parse failure degrades to a lower tier and never fails the command.

### 9.6 What the engine never does

- It never acts as a proxy or sits between a cli and its provider.
- It never makes a network call to learn usage, limits or identity. That rules out `/api/oauth/usage`, `/api/oauth/profile`, `wham/usage` and agy quota RPCs [R09 C2].
- It never spawns a vendor cli to probe an account from `pick`, `next`, `mark`, `classify`, `list`, `status` or `doctor`: no `claude auth status`, `claude -p /usage`, `agy -p /usage`, `codex login status`, `codex app-server` or `gh auth status` [R09 C3].
  - `doctor` MAY run `<cli> --version` only when it runs interactively (stdin is a TTY, no `--json`, `ACCSHIFT_NONINTERACTIVE` unset), never in the `doctor --json` that LimitShift calls. The child environment then contains `COPILOT_OFFLINE=true`, `COPILOT_AUTO_UPDATE=false` and `AGY_CLI_DISABLE_AUTO_UPDATE=1`. `copilot --version` can self-extract and auto-update [R06 §0, §2.1], and whether `claude --version` starts an OAuth refresh for a logged-in account is unverified (V-C6). Reading the version from package metadata (the `package.json` next to an npm shim, or Copilot's cached package directory) is preferred.
- It never sends test prompts, sleeps or relaunches inside `pick`, `next` or `mark`, or writes to vendor files outside §8's defined hooks.
- It never returns `--from` with exit 0; with exit 75 the soonest-free account may be `--from`. It never returns a `needs-*` or `disabled` account.
- It never selects by utilization.
- It never re-orders the registry; only `order` changes preference.
- It never deletes accounts or secrets on errors.

**doctor and agy.** `doctor` (read-only) reports pending agy journals of any op, `agy/_unknown/*` entries, lingering agy daemons, the resolved agy slot and whether the keyring is in scope and readable. `doctor --fix` takes the exclusive agy slot lock and runs only §8.3.3 B.1–B.3 to recover a pending journal, fetching the vault key for it (§7.1); it never swaps. A recovery that cannot run (a lock timeout, a foreign agy, a keystore failure) stays an `error` finding with that code (for example `slot-busy`, `agy-busy` or `keystore-unavailable`), and `doctor --fix` then exits non-zero with the code of its first failed repair (§10.2).

**Event log:** `<root>/logs/events.jsonl` (append-only, redacted, rotated at 1 MB) records limit, auth (strike, escalation, incident), clear, ok and switch events, for `status --history`.

---
