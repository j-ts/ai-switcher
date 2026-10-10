# Batch-2 canonical decisions (binding for every editor)

Findings live in `review-rest.md` (same directory). Lenses and numbering:
CI#n = contract-integration, SC#n = state-concurrency, FC#n = fact-check, CP#n = completeness.
Apply every finding's FIX to the parts of it that live in YOUR files. Where findings disagree, or where
this sheet says otherwise, THIS SHEET WINS. Use exactly the names, codes and flags given here so the
files stay consistent with each other.

## 0. Editing rules

- Edit only the files assigned to you in `/home/user/acctshift-spec/parts/`. Do not run `assemble.sh`;
  do not edit SPEC.md or DECISIONS.md. Other editors are changing the other parts files at the same time.
- Batch 1 (77 security and cross-platform findings) is already in the text. Do not undo it. Some batch-2
  items are already partly there: read the current text first, and don't duplicate.
- Style: match the existing prose. Short sentences, bullet lists, normative MUST/SHOULD/MAY, citations
  like `[R04 §1a]`, cross-refs like `§9.3`. Keep section numbers and headings (you may add subsections such
  as §10.4). No model identifiers anywhere.
- Clean room: never open agm or ClaudeCodePortable code. You may read `/home/user/acctshift-spec/research/*.md`
  and the LimitShift sources in `/home/user/j-ts/limitshift/` and `/home/user/limitshift-v2/`.
- Every example timestamp pair (`foo` / `fooEpoch`) MUST agree. Compute them with python, for example
  `python3 -c 'import datetime as d;print(int(d.datetime(2026,10,7,15,0,tzinfo=d.timezone.utc).timestamp()))'`.
  Known-good pairs: 2026-10-07T15:00:00Z=1791385200; 15:00:30Z=1791385230; 09:00:00Z=1791363600;
  10:40:00Z=1791369600; 12:00:00Z (3pm Europe/Kyiv)=1791374400; 15:45:00Z=1791387900;
  2026-10-06T09:00:00Z=1791277200; 2026-10-12T06:00:00Z (9am Kyiv)=1791784800; 2027-10-07T10:05:00Z=1822903500.
  An observedAt must be before the until it produced.
- Use the following words consistently: "control verb" = every command other than `exec` and `run`.

## 1. Account identity

- Every account gets an immutable `id`: 8 lowercase hex characters, random at `add`, never reused in the
  registry. D.1 `Account` gains `id`.
- `id` keys: the overlay home `homes/<cli>/<id>` (already so), the vault secretId `<cli>/<id>` (e.g.
  `claude/3f9a01c2`, `agy/7c41d09e`), and the state.json account key `<cli>/<id>`.
- Reserved agy vault ids: `agy/_unregistered/<email>`, `agy/_unknown/<sha256-8>`, `agy/_unparsed/<store>-<epoch>`,
  `agy/_swap/<startedAt>` (per-swap backup, written in the save-back step, never overwritten by another
  operation). `agy/_last` is dropped (it is never auto-restored; recovery uses `agy/_swap/<startedAt>`).
- `rename <cli> <old> <new>`: changes only `name` in accounts.json, in one atomic write under state.lock.
  It never moves directories, secrets or state. It also rewrites `settings.agyRestoreAfterRun` when that
  names the old account. It refuses while `journal/agy-swap.json` exists (exit 73).
- `remove <cli> <name>`: one transaction under state.lock (plus vault.lock; agy: the exclusive slot lock).
  It deletes the vault entries, overlay dir and state entry, then the registry entry. It refuses with 65
  `account-in-use` while procscan finds a vendor process whose environment or cwd references the overlay
  (POSIX: `/proc/<pid>/environ` or `ps eww`; Windows: best effort, warning only).
  agy: if any slot holds the account's email → 65 `agy-account-live` with the hint `acctshift agy use <other>`,
  unless `--sign-out-slot` is given (journal the slot content, delete those slots, park the bytes as
  `agy/_unregistered/<email>`).
- Login rules (common, §8): `login` compares the new credential's offline identity with the recorded one
  (codex file-store ids, agy email, gemini `google_accounts` active email; claude token: `--label` must equal
  the current label). On a mismatch: restore or delete the new credential and exit 65 `identity-mismatch`,
  unless `--new-identity` is given (runs the add-time dedupe and clears all records). A same-identity login
  clears `relogin`, `authStrikes` and auth-suspect records, and keeps limit records.
  `login` on a `native` account exits 64 with the vendor's own login command as the hint.
  `doctor` compares a native account's current vendor identity (email/label) with the recorded one and warns;
  `doctor --fix` or `mark --clear` clears that account's records.
- `add --replace` does not exist. Use `login` everywhere it was mentioned.

## 2. state.json (D.2, §6.3)

Top level: `{version:1, notice?:{acceptedAt, version}, accounts:{"<cli>/<id>": AccountState},
agySlot?:{owner, store, writtenAt, saveBackPending?}, agyBinary?:{path, size, mtime, version}, updateCheckedAt?}`

`AccountState = {status, reason, records:[Record], relogin?:{reason, since, snippet?}|null, authStrikes,
lastStrikeAt?, attentionCode?, backoff?:{"<scope>":{hits, lastUntil, lastHitAt, rehitMinutes}},
lastUsedAt?, lastOkAt?, utilization?, wrongAccount?:{expected, found, observedAt}}`

`Record = {kind:"limit"|"auth-suspect", scope:"account"|"model:<bucket>", until, tier:1|2|3|4, limitSource:
"structured"|"text"|"caller"|"default"|"user"|"auth", resetConfidence:"exact"|"parsed"|"guess", limitType?,
observedAt, snippet?, clamped?:true}`

- `relogin.reason`: `rejected` | `refresh-dead` | `expired` | `missing`. It is set by definitive evidence
  or by an escalating strike. It is cleared only by `login` or `mark --clear`, never by any counter reset.
  `expired` is derived from accounts.json `expiresAt`; `mark --clear` cannot clear it (65, hint `login`).
- Auth-suspect records: kind `auth-suspect`, scope `account`, tier 1, limitSource `auth`. The merge rule
  applies only between records of the same kind. An active record of either kind blocks.
- `backoff` replaces `Record.hits` and `earlyRehitBackoffMinutes`. Pruning removes expired records but keeps a
  backoff entry until 24 h after its `lastHitAt`. `mark --ok` deletes it.
- Remove "Entries for deleted accounts are removed on the next write": `remove` deletes them (§1).
- `status`/`reason` stay display caches; the engine recomputes them. They are never used for selection.
- No `sessions` map: the codex "returning to the account that created the thread → yes" case is dropped.

## 3. Engine (§9)

- **Usable** (for a request): enabled, `relogin` null, no `attentionCode`, not past `expiresAt`, and no
  active blocking record for the request per §9.1 (30 s skew margin applied here). The account-level
  `state` MUST NOT be used for selection.
- A `--model` value that maps to no bucket covers every bucket: all model records block it.
- **Tiers** are integers. 1 = no vendor-supplied reset (default backoff, auth-suspect, any detector without
  a reset time); 2 = a reset parsed from text (acctshift's own parse or the caller's `--limited-until`);
  3 = a reset from structured vendor data from the failing run; 4 = user override (`mark --override`).
  The tier describes the source of the reset VALUE, not of the detection.
- **Merge rule** (replaces the old one): (1) as above; (2) higher tier replaces; lower tier replaces only if
  newUntil > oldUntil; (3) equal tier: if |new.observedAt − old.observedAt| < 10 min (same incident reported
  by several callers) keep max(until), otherwise the newer observation wins; (4) a caller `--limited-until`
  earlier than now+minCooldown is not tier-2 evidence; it becomes an unknown reset (tier 1, backoff);
  (5) tier-4 records are replaced only by another `mark --override` or removed by `mark --clear`.
- **No usable candidate:** rule 1 → 75 when any candidate is time-limited, including A; account = smallest
  effective reset (ties by order), `resetAtEpoch` = that reset + 30 s. This includes a one-account pool:
  75 naming A, or 77 if A is needs-*. Rule 2 → 77. Rule 3 → 69 only for: empty pool after filtering
  (`error.code` `empty-pool`), all disabled, cli unsupported, notice not accepted (`notice-not-accepted`).
  §9.6: "never returns `--from` with exit 0; with exit 75 the soonest-free account may be `--from`."
- **`--prefer P`**: honoured only if P is a member of the candidate set (after `--pool` filtering) and
  usable. Empty is absent. Unknown, disabled, non-member or unusable P is ignored, never an error, and the
  response says `preferIgnored:true`.
- **`--pool a,b`**: unknown names are dropped and listed in `poolDropped:[…]`. If none remain → 69 `empty-pool`.
- **`next --from A`** with an unknown A records nothing (`recorded:null`) and still selects.
- **agy:** `pick agy` returns `state.agySlot.owner` whenever it is a usable candidate, even if `--prefer`
  names another account (agy sessions are not portable, so stickiness buys nothing). `pick` never opens
  the keystore; `state.agySlot` is the hint. exec's lock algorithm is authoritative.
- **Flags:** `--reason limit|auth` (default `limit`). `--model M` = the model of the NEXT run (selection);
  `--limited-model L` = the model that hit the limit (recording scope; default = `--model`).
  `--run-started-at T` (epoch s; default now − 60 s) on `next` and `mark`.
- **Strikes:** definitive evidence → `relogin` immediately (except codex `refresh_token_reused`, below).
  An ambiguous 401/403 strike: first → auth-suspect record for `authSuspectMinutes` (15). A strike escalates
  to `relogin(rejected)` only if it comes from a run that started after the account's last auth-suspect
  record expired. Strikes arriving while an auth-suspect record is active only refresh it.
  **Incident rule:** if ≥2 pool accounts of the same cli received strikes within `authSuspectMinutes`,
  treat it as a provider incident: no escalation; back off all of them by `authSuspectMinutes`.
- **codex `refresh_token_reused`** is definitive only if auth.json was not rewritten after the failing run
  started (compare mtime and the refresh-token fingerprint with `--run-started-at`, offline). Otherwise it is
  transient: no strike, retry the same account once.
- **Success channel:** only `mark --ok`. It clears `authStrikes`, `backoff` and auth-suspect records, and
  sets `lastOkAt` and `lastUsedAt`. exec never changes strike, backoff or lastUsedAt state.
  (exec writes only: `relogin(missing)` when a credential is absent, and the agy post-run bookkeeping:
  `agySlot`, `wrongAccount`, `relogin(rejected)` on an emptied slot, `saveBackPending`.)
- **Locking:** next, mark and classify --record parse the evidence and read vendor artifacts BEFORE taking
  state.lock. The lock covers only load, merge, select and write.
- **Clock skew** (SC#27): at read time, a record with observedAt > now+300 s, or until > now+32 d, is treated
  as until = min(until, now + (until − observedAt), now + 32 d) and rewritten on the next write; `clamped:true`.
  Timestamps later than now+300 s are ignored for the strike, backoff and early re-hit windows.
- **Skew margin:** records store the vendor reset unchanged. The 30 s margin is added only when computing
  usability and `resetAtEpoch`. `recorded.untilEpoch` and `limitedUntilEpoch` show the stored value.
- **mark:** `--limited-until` and `--override` write scope `model:<bucket(M)>` when `--model M` is given, else
  `account`. `--clear` removes all records, authStrikes, lastStrikeAt, attentionCode, backoff and relogin
  (except `expired`); `--clear --model M` removes only that bucket's records.
- **Class names:** `blocked` everywhere (rename `blocked-account`). Copilot `session_quota_exceeded` → class
  `error`, no record, `rotate:false`. Gemini `ValidationRequiredError` → class `blocked` with attentionCode
  (sticky needs-attention). Codex `used_percent` alone is never a limit signal. Codex workspace-credits
  exhaustion → `blocked`. Gemini `MODEL_CAPACITY` → `transient`.
- **Notice gate:** until `state.notice` holds the current notice version, `pick` and `next` exit 69
  `notice-not-accepted`, and exec without `--account` exits 125 `notice-not-accepted`. `exec --account` still
  runs. Every `add` (all clis and kinds, including `--native` and `--capture-current`) shows Appendix F when the
  notice is unset or older, and requires `y` or `--accept-notice`. `doctor` reports it.

## 4. exec, run and exit codes (§12, §10.3, Appendix E)

- Control verbs use sysexits 64–78. exec and run report every failure before the child starts as **125**,
  whatever code a control verb would use for the same condition. 126 = found but not executable
  (`not-executable`, `wsl-windows-binary`); 127 = not found.
- 125 `error.code` list (the closed set; keep existing batch-1 codes): `usage`, `unknown-cli`, `unsupported-cli`,
  `unknown-account`, `account-disabled`, `needs-relogin`, `all-capped` (only when picking), `notice-not-accepted`
  (only when picking), `empty-pool` (only when picking), `wrong-owner`, `unsupported-filesystem`,
  `config-corrupt`, `config-newer-version`, `vault-corrupt`, `vault-changed`, `vault-busy`, `state-busy`,
  `slot-busy`, `agy-busy`, `keystore-unavailable`, `keychain-prompt-required`, `agy-keyring-locked`,
  `agy-slot-unregistered`, `agy-env-overrides-slot`, `slot-write-failed`, `bare-ignores-token`,
  `apikeyhelper-overrides-token`, `settings-env-overrides-token`, `base-url-would-receive-token`,
  `classic-pat-unsupported`, `gh-token-unavailable`, `gemini-encrypted-storage`, `cmdline-too-long`, `internal`.
- **`exec --account A`** state table: `limited`, `needs-attention`, and `relogin` with reason `rejected` or
  `refresh-dead` → run (the caller decides). Credential absent (vault entry, overlay auth file) → record
  `relogin(missing)` under state.lock, then 125 `needs-relogin` (status-file `error.reason:"missing"`).
  Past `expiresAt` → 125 `needs-relogin` (`reason:"expired"`). `disabled` → 125 `account-disabled`.
  Unknown name → 125 `unknown-account`. Without `--account`, the pick rules apply.
- **stderr:** each pre-launch failure prints exactly one line: `acctshift: error <code>: <catalogue message>`.
  Messages interpolate nothing: no digits, pids, paths, PATH, labels, account names or durations (those go
  to `--status-file` and `--debug`). **exec writes nothing to stderr after the child starts.** Post-run
  findings (wrongAccount, copy-back conflicts, save-back failures) go only to `--status-file` (`postRunError`,
  `wrongAccount`), state.json and events.jsonl. `--debug` is for humans only; LimitShift never passes it.
  `--verbose` does not exist.
- The catalogue ships: `acctshift version --json` returns `stderrCatalogue:[…]`, and each release includes
  `testdata/stderr-catalogue.txt`. LimitShift's own test suite asserts that its limit/auth regexes never match it.
  No reserved-account-name rule is needed (names never appear on stderr).
- **`--status-file PATH`**: MUST for LimitShift. Shape: `{contract, launched, cli, account, exitCode,
  error?:{code, reason?}, addedArgs:[], foreignAgy?, wrongAccount?, postRunError?}`. On the execve path it is
  written just before execve with `launched:true, exitCode:null`; if execve returns, exec rewrites it with
  `launched:false` and the error, then exits 125/126/127. On the spawn path it is rewritten after the child
  exits with `exitCode` and any post-run fields.
- Post-run hook failures never change the returned exit status; they set `postRunError` and log an event.
- agy: a failed post-run save-back leaves the slot untouched and sets `state.agySlot.saveBackPending=true`; the
  next exclusive run performs that save-back first.
- **Added arguments:** exec MAY prepend exactly the vendor secret-isolation argument listed in facts.go
  (copilot: `--secret-env-vars=COPILOT_GITHUB_TOKEN`) when the caller's argv does not already contain it. This
  is the only exception to "never add arguments". It is reported in status-file `addedArgs`.
- **run:** exits 125 `all-capped` (not 75). For codex TUI launches, `run` appends `--no-daemon` unless the
  caller's args already select daemon behaviour [R04 C16] (a run-only exception; exec never adds it).
- **Non-interactive:** stdin is not a TTY, or `ACCTSHIFT_NONINTERACTIVE=1` (LimitShift MUST export it for every
  acctshift invocation). Delete "or when the caller is LimitShift". exec and run never prompt: any condition
  that needs input takes the non-interactive branch.
- **env** exits 69 `requires-exec` when the plan has a post-run hook or holds a lock for the run (agy slot,
  gemini home, Windows codex copy mode).
- `--track`, `--slot-wait S`, `--status-file P`, `--allow-bare`, `--allow-apikeyhelper`, `--allow-settings-env`,
  `--allow-base-url` are exec flags (add `--sign-out-slot` to `remove`, `--new-identity` to `login`,
  `--accept-notice` to `add`). `--allow-settings-env` also overrides `agy-env-overrides-slot`.

## 5. Contract output (§11, D.4)

- `pick`: `previous:null`, `switched:false` always.
- 69 and 77 return the pick/next object with `available:false`, `account:null` and an `error` member.
  75 returns `available:false`, `account` = the soonest-free account and `resetAtEpoch`/`resetAt`.
- `accounts[]` entries carry `limitedUntil` with `limitedUntilEpoch`. list/status/accounts[] carry
  `limits:[{kind, scope, until, untilEpoch, tier, limitType?, limitSource}]`; the summary fields are the
  maximum over records that block a model-less request.
- `mark` returns the pick/next shape with `recorded` and `account:null`. enable/disable/order return
  `{contract, cli, accounts:[…]}` (the list entries). `vault status --json` is a contract command; vault
  migrate/export/import are not.
- `doctor` exits 0 whenever it ran (callers read `ok` and findings). `classify` exits 0 for every class;
  66 if the evidence file is unreadable. `classify --record` and `next`/`mark --evidence-file` MUST NOT both be
  used for one run.
- `usageProbe` is true only for claude `native`.
- Portability values `yes|likely|possible|unlikely|no`; `sessionPortable` true only for yes and likely.
- `version`: `supportedClis` lists every cli exec can run on this OS; `experimental ⊆ supportedClis`.
- Rule 8: read-only (no lock; no state, vendor or file-system writes, including no rename, migrate, recreate,
  chmod or re-ACL; older versions migrate in memory only): version, list, status, pick, doctor without --fix,
  classify without --record, vault status. Writers: next, mark, enable, disable, order, config, classify
  --record, doctor --fix, exec, add, login, remove, rename, agy use, vault migrate/export/import.
- Corrupt files: only a writer holding state.lock may quarantine or recreate a file, and only after a second
  read 200 ms later fails the same way. Readers that fail to parse exit 78 (exec: 125 `config-corrupt`) and
  change nothing. A missing accounts.json is never recreated while `<name>.corrupt-*` files or vault entries
  exist. Recreating state.json is allowed only from `doctor --fix`.
- `config edit` (copy to a temp file, open $EDITOR, validate, write atomically under state.lock) replaces
  "edit by hand while no acctshift process runs". Config keys are dotted paths from the registry root:
  `clis.<cli>.mainHome`, `clis.<cli>.bin`, `clis.<cli>.buckets.<model>`, `clis.<cli>.shareExtra`,
  `settings.<key>`, `clis.<cli>.settings.<key>`.
- D.1 `clis.<cli>: {mainHome?, mainSqliteHome?, bin?, buckets?:{<model>:<bucket>}, shareExtra?:[name],
  settings?:Settings, accounts:[Account]}`. `Settings: {minCooldownSeconds=60, unknownResetBackoffMinutes:
  {start=30,max=300}, earlyRehitBackoffMinutes:{start=5,max=60}, authSuspectMinutes=15, slotWaitSeconds=30,
  updateCheck:"off"|"daily"="off", agyRestoreAfterRun?, agyAllowNetworkHome=false, keystoreProbeSeconds=3,
  keystoreOpSeconds=10}`; `clis.<cli>.settings` overrides the global settings.
- Account (D.1) also gains `id`, `identity.host?` (copilot), `nativeAuthOverride?` (gemini, recorded at
  `add --native`), `agySlotUsed?:{store, path, agyVersion}` (agy).
- Flag parsing: the dispatcher parses repeatedly (FlagSet.Parse, take one positional, parse the rest) until
  `--` or the end. After `--` (exec, env, run) everything passes through unparsed. Unknown flags are usage
  errors (64; 125 `usage` for exec/run). Add §10.4 "Flags per command" listing every flag, type and default.

## 6. agy (§8.3, §13.1, §13.3)

- Per-OS store resolution (CP#2 + FC#5): Linux uses agy's environment detectors. macOS and Windows: until V-A3
  is recorded in facts.go for that OS and agy version, the resolved slot is the store recorded at `add agy`
  (`agySlotUsed`; default keychain on macOS, Credential Manager on Windows unless the blob exceeds 2560 B).
  A file candidate joins the write set only if it already holds a credential. acctshift MUST NOT create a new
  token file on macOS. Delete "The design does not depend on it".
- Detectors split into permanent (environment) and transient (timeout markers younger than 1 h, both marker
  paths). A locked, unreachable or timing-out keyring is NOT evidence of file mode; when no environment
  detector fires and the keyring cannot be read → refuse (exec 125 `agy-keyring-locked`; control verbs 74).
  Any acctshift keyring call taking longer than 4 s counts as uncertain (agy bounds its own at about 5 s [R05 §a]).
- If the resolved slot cannot accept the blob (size cap), the first file candidate (or the path recorded at add)
  joins the write set (FC#4).
- One fast-path definition everywhere (§5.2, A.4, B.6): "the resolved slot holds a credential, every slot in the
  write set that holds a credential carries the requested email, and the slot copy's expiry is not earlier than
  the vault snapshot's."
- Save-back is a commit point (SC#3), including `agy/_unknown/<sha256-8>` and `agy/_swap/<startedAt>`.
- Recovery per SC#5 (exclusive lock only, after the foreign-process check; rollback to `agy/_swap/<startedAt>`;
  never auto-restore `_last`; read errors → write nothing, 125 `keystore-unavailable` / control verbs 74).
- A foreign agy does not block the shared fast path: one `foreignAgy:true` in the status file (no stderr).
  The foreign-process check gates only the exclusive path. Holder files (batch 1) identify acctshift holders;
  no ppid-ancestry rule. V-A10 covers daemons.
- Intent markers: one per waiter, `locks/agy-slot.intent.d/<pid>`, removed on acquire or timeout. Shared
  requests defer to a live intent for at most min(--slot-wait, 10 s).
- `slot-busy`/`agy-busy` are transient for LimitShift (§7 below).
- add/login: exclusive lock + journal `op:"add"`; `add` requires an unregistered email; `login <name>`
  requires the same email (else 65 `identity-mismatch`); for login of the live account keep the new
  credential live. Signal handling during steps 3–6 (CP#33). doctor reports a pending `op:add` journal.
- After a run: every slot empty → no save-back, `relogin(rejected)` for the requested account,
  `state.agySlot=null`. Mismatch → `wrongAccount={expected, found, observedAt}`, `agySlot.owner` = the observed
  registered account or null, reported in the status file; cleared by the next matching run. LimitShift then
  re-runs the task without calling `next`.
- `AGY_ERROR: {json}` (exit 3) is classified from its JSON (FC#3). A.3: `AGY_LLM_GATEWAY_*` set → 125
  `agy-env-overrides-slot` unless `--allow-settings-env`.
- Mark the macOS and Windows agy paths "VERIFY V-A2"; cite R05 §d in C.3; snapshot size "unmeasured (V-A4)".
- exec identifies the agy version via `state.agyBinary` (realpath, size, mtime); on a miss it runs
  `agy --version` once with a 2 s timeout; an unknown version counts as V-A8 not passed.

## 7. LimitShift (§15)

- Current account per launch role, reset at task start: sh `ACCT_CURRENT_TASK`, `ACCT_CURRENT_VERIFY`,
  `ACCT_CURRENT_PLANNER` (the task variable is also cleared on a runner switch); ps1
  `$script:AcctCurrent = @{}` keyed `'task'|'verify'|'planner'`. At task start, seed the task entry from the
  persisted account file (resume) or leave it empty.
- Always use the CLI of the runner being launched (`$task_cli`, `$fb_active_cli`; ps1 `$task.Cli` /
  `$activeRunner.Cli`), never `$cli`.
- Before EVERY run: `pick <cli> --model <model of this run> [--prefer "$cur"] [--pool a,b]` (omit `--prefer`
  when empty; strip a trailing `\r`). Persist the result if it differs.
- On a limit: `next <cli> --from A --model <model of the next run> --limited-model <model that hit the limit>
  --evidence-file <last-run file> --exit N --run-started-at <epoch> [--session ID --cwd DIR] [--pool a,b]
  [--limited-until R only when parsed from this run's output]`. Never the limitWaitMinutes fallback or /usage.
- Evidence file: `outputs/task-NN[-suffix]-last-run.txt`, truncated before every run, holding only that run's
  stdout+stderr.
- `--pool` is passed to every pick, next and mark for a runner whose `accounts` is an array (one element too).
- Auth: v1 and v2-root add a hook: after a failed non-limit run of a routed runner, `classify <cli> --exit N
  --evidence-file <last-run file> --json`; on class `auth` or `auth-definitive`, one `next --from A --reason auth`
  (handle 0 and 75 as for a limit). v2: the auth branch calls only `next --reason auth`; 0 → `continue`;
  69/77 → Set-V2AuthDeadCli.
- After a run that is neither limit nor auth failure (R_OK=1): `mark <cli> --account A --ok [--pool]`, best
  effort, exit status ignored.
- Every wrap passes `--status-file <state>/sessions/task-NN[-suffix].acct-exec.json` (deleted before each run)
  and LimitShift reads it after the run. Before limit/auth regex matching and JSON extraction, drop every
  line matching `^acctshift: `.
- **Legacy (unwrapped) launch** is allowed only for a runner with no `accounts` key under
  `accountRotation:"auto"`, and never for agy while acctshift has at least one agy account registered.
  Otherwise a pick/next result other than 0/75, or an exec 125 that is not transient, marks the task
  needs-human with the acctshift `error.code` (fallbacks: set the runner aside for this task).
- Auto mode routes a runner only when the task's first pick returns `rotationPossible:true` or `accounts` is
  explicit; the decision is fixed for the rest of the task. An `experimental` cli is routed only with
  explicit `accounts` (validate-only prints a WARNING).
- exec 125 per-code action table: `slot-busy`, `agy-busy`, `state-busy`, `vault-busy` → transient: not charged
  to maxRetriesOnError or maxRunsPerTask; wait 60 s, re-pick, retry; after `settings.accountBusyWaitMinutes`
  (LimitShift queue setting, default 30) of continuous busy, treat the runner as limited until
  now + accountBusyWaitMinutes (single runner: rest; fallbacks: set aside). `needs-relogin`, `account-disabled`,
  `unknown-account` → clear the current account and re-pick (no strike). `keystore-unavailable`,
  `agy-keyring-locked`, `notice-not-accepted` → legacy only under the legacy rule, else needs-human. All other
  codes → needs-human, no retry.
- pick 75: single runner → rest until resetAtEpoch + resetBufferMinutes, then run on `account`; fallbacks →
  `limitedUntil[R]` = resetAtEpoch (ps1 `[DateTimeOffset]::FromUnixTimeSeconds([long]$j.resetAtEpoch).LocalDateTime`),
  continue to select_next_runner without launching.
- sessionPortable false → delete the session file, New + handoff. Model rotation: classify with `--model`;
  scope `account` skips the remaining models.
- `/usage` is never run for routed claude runners (skip in get_runner_reset_epoch / Get-RunnerResetTime).
- P7 (ps1 passes `Cli = $Task.Cli` to Invoke-NativeProcess). Export `ACCTSHIFT_NONINTERACTIVE=1`.
- §15.9 installer knobs: `ACCTSHIFT_INSTALL_DIR`, `ACCTSHIFT_NO_MODIFY_PATH=1`, `ACCTSHIFT_VERSION=<pin>`,
  `ACCTSHIFT_NO_INSTALL_RECEIPT=1` (new knob, define it in §17.6 too).
- agy model discovery runs only for the live owner; `--validate-only` never swaps.
- wrongAccount in the status file → re-run the task without calling `next`.

## 8. Verification items, milestones, other sections

- Existing V-ids: V-A1..A10, V-C1..C5, V-G1..G2, V-K1..K3, V-L1, V-P1..P2, V-W1..W2, V-X1..X4. New ids (do NOT
  reuse existing ones): V-A11 (agy auth-failure texts and exit status in -p mode), V-X5 (codex resume of an
  unknown thread id: exact text), V-X6 (Windows: does Codex's npm JS launcher change env, PATH /
  CODEX_MANAGED_BY_NPM), V-X7 (concurrent refresh in one codex home), V-G3 (does GEMINI_CLI_AUTH_OVERRIDE get
  written into settings.json during a run; skip copy-back if selectedType differs), V-G4 (gemini overlay layout
  works for login, -p and --resume on all three OSes), V-P3 (minimum gh version supporting `auth token --user`),
  V-C6 (does `claude --version` refresh or touch credentials). Reword V-P2 per FC#8; add writable roots to V-X2.
- Milestones per CP#19 (M1 adds `self-update --record-install` offline, install.sh, install.ps1, vault
  status/migrate; M2 adds Windows exec spawn path; M3 npm cmd-shim resolution; M7 networked self-update;
  schedule every V-item; testable exit criteria).
- §19.2: go-keyring is not used at runtime (test-only fixtures at most).
- macOS process path: KERN_PROCARGS2 via `unix.SysctlRaw("kern.procargs2", pid)`; never `proc_pidpath`.
- G3 "≤50 ms per control call, no daemon"; NFR1 exec "SHOULD be under 30 ms excluding the single keystore call";
  NFR2 "≤6 MB uncompressed and ≤3 MB compressed"; §18.4 measures every NFR1 command.
- codex: drop the same-account stagger SHOULD (CP#31 wins over FC#19). doctor runs `<cli> --version` only
  interactively, with COPILOT_OFFLINE=true, COPILOT_AUTO_UPDATE=false, AGY_CLI_DISABLE_AUTO_UPDATE=1.
