## 15. LimitShift integration

Applies to:
- **v1** (`limitshift.sh` + `limitshift.ps1`, 1.3.x);
- **v2-root** (the 1.5.0 twins at the root of limitshift-v2);
- the **v2 engine** (`v2/`, PowerShell 7 only).

Every hook point names its function, which is the stable anchor. Line numbers were checked against the v1 and limitshift-v2 snapshots of 2026-10-08 and MUST be re-located before patching.

### 15.1 Prerequisite fixes (land before the integration)

These are existing LimitShift bugs found during the research. Account rotation depends on the first two, and on P7 for agy on Windows.

| # | Bug | Where | Fix |
|---|---|---|---|
| P1 | jq precedence: `range($count) \| ($start + .) % $count as $i` binds `as $i` only to `$count`, so bash `fallbacks` tasks fail at once with "all runners exhausted" | `select_next_runner`: v1 `limitshift.sh:1579`, v2-root `:2043` | `(($start + .) % $count) as $i`. The bash suite went from 114 to 125 passing [R08 C5] |
| P2 | v2-root passes `task_field "$i" "path"`, but the field is `projectPath`, so the Claude `/usage` cross-check never runs | v2-root `limitshift.sh:3150, 3215, 3646, 4103` | use `projectPath` [R08 C8] |
| P3 | `${trimmed_reason,,}` needs bash 4, but macOS ships bash 3.2, so blocked-task recovery crashes | v1 `:2825, 3209`; v2-root `:3759, 4143` | use `tr '[:upper:]' '[:lower:]'`, and add a bash 3.2.57 CI job [R03 C4] |
| P4 | session file name differs: sh uses `task-NN.session`, ps1 uses `task-NN-session-id.txt` | both | pick one name, and read the old one once for migration |
| P5 | Codex limit regex misses `Try again at Oct 9th, 2026 3:45 PM` and the curly `You’ve` | sh `parse_cli_output` / ps1 `ConvertFrom-CliOutput` | extend the regexes, or adopt `accshift classify` (§15.8) [R04 §5] |
| P6 | Copilot JSONL parser reads top-level fields, while 1.0.93 nests them under `.data` | sh/ps1 copilot branch | verify against a real transcript and read `.data.*` [R06 C12] |
| P7 | `Invoke-CliTaskRun` never passes `-Cli` to `Invoke-NativeProcess`, so the `if ($Cli -eq 'agy')` `CreateNoWindow` branch (v1 `:1858`, v2-root `:2217`) is dead code for task runs, and agy runs through `Start-Process -NoNewWindow` | `$invokeParams` in `Invoke-CliTaskRun`: v1 `limitshift.ps1:2462`, v2-root `:2856` | add `Cli = $Task.Cli` to `$invokeParams`. V-L1 covers an agy launch |

### 15.2 Rotation order (decision)

Terms used in §15.2–§15.10:
- A **role** is one launch slot: the task's current runner (runner 0 is the task itself, runner K is `fallbacks[K-1]`), and in v2-root also the task's verifier and the mission planner.
- A role is **routed** when its launches go through `accshift exec`; §15.4 decides which roles are. Unrouted roles run exactly as today.
- The **current account** of a role is the account its next launch uses (§15.3 keeps one per role).
- The **last-run file** holds only the latest run's captured stdout and stderr (§15.5). It is the `--evidence-file` of every accshift call about that run. `T0` is that run's start in epoch seconds.
- `<cli>` is always the CLI of the runner being launched (sh `$task_cli`, `$fb_active_cli`, `$verifier_cli`, `$planner_cli`; ps1 `$task.Cli`, `$activeRunner.Cli`, `$verifierTask.Cli`, `$plannerTask.Cli`; v2 `[string]$roleCfg.Cli`), never a leftover global such as sh `$cli`, which `read_queue_config` leaves holding the last runner's CLI.
- `--pool <a,b>` is the runner's `accounts` array, comma-joined in order. LimitShift passes it to every `pick`, `next` and `mark` for a runner whose `accounts` is an array, including a one-element array. A pinned runner therefore never runs on another account: after a limit, `next` returns 75 naming the pinned account, or 77.

**Before every run** of a routed role:
`accshift pick <cli> --model <model of this run> [--prefer <current account>] [--pool <a,b>] --json`
- `--prefer` is omitted when the current account is empty; a trailing `\r` is stripped from values read from files.
- `pick` is read-only and lock-free (§11.1 rule 8), so it costs milliseconds. Calling it before every run notices an account that another queue limited, or that the user disabled, removed or dropped from the pool, since the last run.
- **0** → `account` becomes the current account; persist it if it changed (§15.5) and apply the session rule below.
- **75** → single runner, verifier or planner: rest until `resetAtEpoch` + resetBufferMinutes, then run on `account` in the same iteration (session rule below). Fallbacks: `limitedUntil[R]` = `resetAtEpoch`, clear the current account, and return to `select_next_runner` without launching or sleeping, so another runner can run. A pick that launches nothing is not charged to maxRunsPerTask.
- Any other exit → the result table below.

**On a usage limit** (LimitShift's own detection: `R_IS_LIMIT` / `$result.IsLimit`) for routed role R, account A, model M:
0. **Copilot confirmation.** LimitShift's copilot limit regex also matches Copilot's `session_quota_exceeded`, the user's own per-session cap (`--max-ai-credits`), which is not a limit [R06 C11]. For a copilot role, a limit match is therefore first confirmed with `accshift classify copilot --exit N --evidence-file <last-run file> --model M --run-started-at T0 --json`.
   - Class `error` (`rotate:false`, §8.5): not a limit. A stays the current account; delete the session file and run New with the handoff note on A. No `next`, no `mark`, no model or account rotation. The run is charged to maxRetriesOnError like an ordinary error.
   - Any other class, or a failed `classify`: the limit stands. A `scope` from this call also serves step 1, which then calls `classify` no second time.
1. **Next model of R on A**: the same session, existing behaviour.
   - **Exception:** when the limit is **account-wide**, LimitShift skips the remaining models on A and goes to step 2 at once. Examples: Claude's 5-hour window, which all models share; a Codex usage limit with no bucket name; Copilot global or weekly limits; agy individual quota.
   - LimitShift learns the scope from `accshift classify <cli> --exit N --evidence-file <last-run file> --model M --run-started-at T0 --json` → `scope`, called only when another model remains. Plain `classify` records nothing (§10.2).
   - Rotating models after an account-wide limit is a guaranteed wasted run. The owner's own `limitshift-profile.json` `limitBuckets` already say so [D8].
2. **Models exhausted on A (or scope = account):** reset the model index to 0, then call
   `accshift next <cli> --from A --model <model of the next run> --limited-model M --evidence-file <last-run file> --exit N --run-started-at T0 [--session ID --cwd DIR] [--pool <a,b>] [--limited-until R] --json`
   - `--model` is the model of the next run (after the reset, the first model of the list); `--limited-model` is M, the model that hit the limit. accshift selects with the first and records the scope with the second (§9.3).
   - `--session` (the saved session or thread id) and `--cwd` (the task's `projectPath`) are passed for claude and codex, so accshift can read the transcript or rollout (§9.5).
   - `--limited-until R` is passed **only** when LimitShift parsed a reset from this run's output (`parse_reset_from_error` → `R_RESET`; `Get-ResetTimeFromErrorText`; v2 `Get-ResetTimeFromText`). Never the limitWaitMinutes fallback, `get_runner_reset_epoch`, `Get-RunnerResetTime` or a `/usage` value: a guess passed as `--limited-until` would become tier-2 evidence and bypass accshift's unknown-reset backoff (§9.4).
   - accshift's single parser (§9.5) reads the evidence file and corrects missing or wrong resets.
3. Depending on the result:
   - **0** → account B becomes the current account. Same CLI, model index 0, no sleep, and the session rule below. A codex refresh race can return B with `recorded.class:"transient"` and nothing recorded on A (§9.2); it is handled the same way.
   - **75** → every candidate waits. Single runner (and verifier, planner): rest until `resetAtEpoch` + resetBufferMinutes, then run on `account`, which may be A (session rule below). Fallbacks: `limitedUntil[R]` = `resetAtEpoch` (the soonest account of R's pool, not just A), clear the current account, then `select_next_runner`.
   - Any other exit → the result table below.
4. **CLI fallback** (another runner) → fresh session plus handoff note (existing behaviour). Clear the current account: the new CLI has its own pool.

**Session rule.** When the current account changes and the next run would Resume:
- the portability is `sessionPortable` from the `next` response (it covers 0 and 75), or, for a change made by `pick`, the cli default `capabilities.<cli>.sessionPortable` from `version --json` (§11.2);
- true → same saved session id, Resume, **no handoff note**;
- false → delete the session file and run New with the handoff note (`build_prompt_with_handoff` / `Get-TaskPromptWithHandoff`). Codex moves report `possible` or `unlikely` and agy moves `no`, so both always start New (§8.2, §8.3).

**Authentication failures.** v1 has no auth detection [R08 §a2], so v1 and v2-root add this hook. After a failed run (R_OK=0) of a routed role that is not a limit:
- call `accshift classify <cli> --exit N --evidence-file <last-run file> --run-started-at T0 --json`;
- on class `auth`, `auth-definitive` or `blocked`, call **once** `accshift next <cli> --from A --reason auth --model <model of the next run> --evidence-file <last-run file> --exit N --run-started-at T0 [--session ID --cwd DIR] [--pool <a,b>] --json`. It records the strike, `relogin` or `attentionCode` and selects in one locked transaction (§9.2, §9.3). Handle 0 and 75 as for a limit, without charging maxRetriesOnError; any other exit goes to the result table;
- on any other class, take LimitShift's existing error path (retry budget).
- LimitShift never also calls `mark --auth-failed` or `classify --record` for the same run, which would count one failure twice (§9.2). The v2 engine's auth branch is in §15.3.

**Success.** After a run of a routed role with R_OK=1 (status Done, NoMarker or Blocked), call `accshift mark <cli> --account A --ok [--pool <a,b>] --json`. It is best effort: its exit status and output are ignored. It is the only success channel; without it, strike and backoff counters survive successful runs for 24 h (§9.2).

**Wrong account (agy).** A status file with `wrongAccount` set means the run did not run as A (§8.3.3). LimitShift then attributes nothing from it to A: no `next`, no `mark --ok`, no auth hook. A run that ended as a limit or an error is re-run (`pick`, then `exec`), not charged to maxRetriesOnError; it still counts toward maxRunsPerTask, which bounds repeated mismatches. A Done or Blocked result stands.

**Legacy (unwrapped) launch.** Running a routed role's CLI unwrapped, as the CLI's own login, is allowed only when:
- the runner has **no `accounts` key** and `accountRotation` is `auto`; and
- the CLI is not agy while accshift has at least one agy account registered (`accshift list agy --json` exits 0 with a non-empty `accounts`). `list` never exits 69: with no agy accounts, or where exec cannot run agy, it returns `accounts:[]` (§10.3). Any non-zero exit from `list` therefore counts as yes.

A legacy outcome applies to that one step:
- before a launch, the run starts unwrapped;
- in a limit branch, LimitShift does today's wait (single runner) or sets today's `limitedUntil[R]` (fallbacks) from its own parsed reset, without `/usage` (§15.6);
- in the auth hook, it takes today's error path.

The next run calls `pick` again. A runner never stays in legacy mode for the rest of the queue (D7). When the legacy rule does not allow it, the same outcome makes the task **needs-human** instead:
- single runner: the existing needs-human markers (`save_task_failed_marker`, `save_task_needs_human_marker` / ps1 equivalents) with the reason `accshift: <error.code>`, then the next task;
- fallbacks: the runner is set aside for this task (`setAside[R]`, reason `accshift: <error.code>`).

LimitShift logs why, and never aborts the queue.

**Result table for `pick` and `next`** (Appendix E):

| Exit | Action |
|---|---|
| 0, 75 | as above |
| 73 (`state-busy`; `next` only, since `pick` takes no lock) | nothing was recorded on A. Wait 60 s and repeat the same `next` call (same arguments, same last-run file), never a `pick` and never a relaunch on A in between; not charged to maxRetriesOnError or maxRunsPerTask. After `accountBusyWaitMinutes` of continuous busy, the busy-limited outcome of the exec busy codes below |
| 69 (`empty-pool`, `unsupported-cli`, `notice-not-accepted`), 70, 77 | legacy outcome under the legacy rule; otherwise needs-human |
| 64, 65, 74, 78, or no parseable JSON | needs-human |

For `notice-not-accepted` (69 here, or exec 125 below), the needs-human reason carries accshift's hint `accshift notice --accept` (§10.2). Implicit `auto` runners may still run unwrapped under the legacy rule.

`classify` is advisory: any exit other than 0 (for example 66 `evidence-unreadable`), or no parseable JSON, counts as no evidence. The limit branch then goes on with models first, and the auth hook takes the existing error path. `mark --ok` ignores every result.

**exec exit 125–127** (accshift failed before the child started, §12.1.1; a CLI can also exit 125–127 on its own). LimitShift reads `launched` and `error.code` from the status file (§15.5), before any `classify`:
- **125:** with `launched:true` it is the CLI's own exit status and gets the normal result handling. Otherwise the code table below applies. If the file is missing or does not parse, LimitShift takes the code from the first captured line matching `^accshift: error ([a-z0-9-]+): `, else `internal`.
- **126** (`not-executable`, `cmd-shim-unsupported`, `wsl-windows-binary`) and **127** (`not-found`): with `launched:false` → needs-human, no retry, no `classify`. With `launched:true`, or with no status file, they are the CLI's own exit status and get the normal result handling (Appendix E).

| `error.code` (exit 125) | Action |
|---|---|
| `slot-busy`, `agy-busy`, `state-busy`, `vault-busy` | transient: not charged to maxRetriesOnError or maxRunsPerTask; wait 60 s, re-pick, retry. After `settings.accountBusyWaitMinutes` (§15.4, default 30) of continuous busy, treat the runner as limited until now + accountBusyWaitMinutes: a single runner rests; fallbacks set the runner aside until then (`limitedUntil[R]`) and run another runner |
| `needs-relogin`, `account-disabled`, `unknown-account` | clear the current account and re-pick: no strike, no retry charge. exec has recorded `relogin(missing)` for an absent credential, and `expired` is derived (§12.1), so `pick` does not return that account again. If it does and exec fails with the same code again → needs-human |
| `keystore-unavailable`, `agy-keyring-locked`, `notice-not-accepted` | legacy outcome under the legacy rule; otherwise needs-human |
| every other code | needs-human, no retry |

Models come before accounts because:
- it keeps today's meaning of a model list (several limit buckets inside one account);
- it uses one account fully before switching, which means fewer agy slot swaps;
- accshift limits stay per (cli, account).

An `accountsFirst` order is reserved for a later contract [R08 §c].

### 15.3 Hook points

**Discovery** runs once per LimitShift run, after the queue is read and before `--validate-only` or the first task:
1. `LIMITSHIFT_ACCSHIFT` (a path, or `off` / `0` / `false` to disable);
2. `<limitshift dir>/bin/accshift[.exe]`;
3. `accshift` on PATH.

Then:
- export `ACCSHIFT_NONINTERACTIVE=1` (sh `export`; ps1 `$env:ACCSHIFT_NONINTERACTIVE = '1'`), so every accshift invocation, `exec` and `doctor` included, is non-interactive (§7.5);
- run `accshift version --json` and require `1 ∈ contracts`;
- keep `supportedClis`, `experimental` and `capabilities`.

On any failure accshift is treated as absent, and **behaviour is byte-identical to today**, except for the runs.csv `account` column (§15.5) and the `required` error (§15.4).

All calls use `--json`. LimitShift reads stdout and the exit status, and discards accshift's stderr for control verbs. LimitShift MUST NOT use `accshift env` (DECISIONS D3), and never uses `classify --record`.

**Globals and helpers** (normative). Every global is initialised unconditionally at script start, so `set -u` and StrictMode 2.0 never see an unset name, even when accshift is absent.

v1 / v2-root `limitshift.sh`, bash 3.2-safe: plain variables (the scripts use no associative arrays), no `${x,,}`, and empty arrays guarded under `set -u` with `${a[@]+"${a[@]}"}`.
```bash
ACCSHIFT_BIN=""                                                      # set by discovery; empty = absent
ACCT_CURRENT_TASK=""; ACCT_CURRENT_VERIFY=""; ACCT_CURRENT_PLANNER=""  # current account per role
ACCT_ROUTED_TASK=""; ACCT_ROUTED_VERIFY=""; ACCT_ROUTED_PLANNER=""     # "" undecided, 1 routed, 0 not (this task)
ACCT_RC=0; ACCT_JSON=""; ACCT_NEXT=""; ACCT_RESET=""; ACCT_PORTABLE=""; ACCT_ROTATION=""; ACCT_SCOPE=""; ACCT_CLASS=""; ACCT_ERR=""
ACCT_LAUNCHED=""; ACCT_WRONG=""; ACCT_BUSY_SINCE=""; ACCT_LEGACY_NEXT=""
ACCT_RUN_ACCOUNT=""                                                   # set by build_cli_args: the account of a wrapped launch, else ""
R_EXIT=""; R_RUN_STARTED_AT=""; R_LAST_RUN_FILE=""; R_ACCT_STATUS_FILE=""   # set by invoke_cli_task_run
```
- `acct_role` prints `task`, `verify` or `planner` (v2-root: from `VERIFY_RUN_ACTIVE` / `PLANNER_RUN_ACTIVE`; v1: always `task`). Those variables are set only while `invoke_cli_task_run` runs (v2-root `:3140-3142`, `:3205-3207`), so only the wrap point uses `acct_role`; every hook outside it passes its role explicitly.
- `acct_runner_accounts <role> <idx> <runner_idx>` prints `none` (no key), `off` (`false`) or the comma-joined list. It reads the runner object with its own jq (`if has("accounts") then …`), because the existing `… // empty` accessors turn `false` into empty. The object is `.tasks[i]`, `.tasks[i].fallbacks[K-1]` or `.tasks[i].verify`; in mission mode it is the dispatched task in `$MISSION_TASK_PATH` (or its `.verify`) and `.mission.roles.planner`. `new_mission_task_object` (ps1 `New-MissionTaskObject`) MUST copy `mission.roles.executor.accounts` to the task's `accounts` and `mission.roles.verifier.accounts` to `verify.accounts`. `pool` is the list, or empty.
- `acct_routable <role> <idx> <runner_idx>` succeeds when `ACCSHIFT_BIN` is set, the role is not opted out (§15.4), and its routing decision (`ACCT_ROUTED_*`) is not 0. `acct_runner_enabled` succeeds only when that decision is 1.
- `acct_decide <role> <idx> <runner_idx>` runs right after every `pick` and does nothing once the role's decision is made. Otherwise it sets `ACCT_ROUTED_<role>` from §15.4 and that first pick: 1 when `accounts` is an array, when the queue sets `required` and the cli is not `experimental`, or when the cli is agy with agy accounts registered; 1 under `auto` when the cli is in `supportedClis`, not `experimental`, and the pick returned 0 or 75 with `ACCT_ROTATION` = `true`; else 0. Under `required`, a 0 makes the task needs-human (§15.4).
- `acct_call <verb> <cli> <args…>` runs `"$ACCSHIFT_BIN" <verb> <cli> <args…> --json 2>/dev/null` and sets `ACCT_RC`, `ACCT_JSON`, and (jq with `// empty`, so nulls stay empty) `ACCT_NEXT` = `.account`, `ACCT_RESET` = `.resetAtEpoch`, `ACCT_PORTABLE` = `.sessionPortable`, `ACCT_ROTATION` = `.rotationPossible`, `ACCT_SCOPE` = `.scope // .recorded.scope`, `ACCT_CLASS` = `.class // .recorded.class`, `ACCT_ERR` = `.error.code`. It returns `ACCT_RC`.
- `acct_current_get <role>` / `acct_current_set <role> <name>` read or write that role's `ACCT_CURRENT_*`. For the task role, `acct_current_set` also writes the account file (§15.5) when the value changes.
- `acct_switch_to <role> <name>` is `acct_current_set` plus the §15.2 session rule. When the account changes and the move is not portable (after `next`: `ACCT_PORTABLE` is not `true`; after `pick`, whose `sessionPortable` is null: the cli's `capabilities.<cli>.sessionPortable` is not true), it deletes the session file (`get_task_session_file_path`) and requests the handoff note through the existing variables: single runner `recoveryReason="account switch"` (so `use_fb_handoff=1`), fallbacks `pendingHandoff=1`. ps1 does the same with `$recoveryReason` and `$pendingHandoff`.
- `acct_read_status` sets `ACCT_LAUNCHED`, `ACCT_ERR` and `ACCT_WRONG` from `R_ACCT_STATUS_FILE`, falling back to the `^accshift: error <code>: ` line (§15.2).
- `acct_busy_wait <code>` starts the busy streak (`ACCT_BUSY_SINCE` = now) unless one is running. While the streak is shorter than `accountBusyWaitMinutes`, it prints the busy wait (§15.5), sleeps 60 s and succeeds; after that it fails. Any launched run clears `ACCT_BUSY_SINCE`.
- `acct_outcome <context> <exit> <code>` applies §15.2's tables for `context` = `pick`, `limit`, `auth` or `exec` (exec: 125 by `error.code`; 126 and 127 → 2), and tells the caller what to do by its return status:
  - 0, go on: before a launch, the current account is empty and the run starts unwrapped; in a limit branch, today's wait or `limitedUntil[R]`; in the auth hook, today's error path;
  - 1, retry: the caller undoes the run-budget tick and `continue`s. A busy code has already waited 60 s through `acct_busy_wait`; a re-pick code has cleared the current account; a legacy outcome after exec 125 has set `ACCT_LEGACY_NEXT=1`, so the next launch skips `pick` and runs unwrapped once;
  - 2, needs-human: single runner, the needs-human markers and `break`; fallbacks, `setAside[R]=true` and `continue`;
  - 3, busy for `accountBusyWaitMinutes` (`acct_busy_wait` failed; for `next`'s 73 in context `limit` or `auth`, always 3, because the caller's repeat loop has already used the busy window): single runner, rest until now + accountBusyWaitMinutes; fallbacks, `limitedUntil[R]` = that time and `continue`.
- `invoke_cli_task_run` (v1 `:2219`, v2-root `:2951`), before `build_cli_args`: clears `ACCT_RUN_ACCOUNT`, `ACCT_LAUNCHED` and `ACCT_WRONG`, sets `R_LAST_RUN_FILE` and `R_ACCT_STATUS_FILE` (§15.5), truncates the first and deletes the second. Around the launch it sets `R_RUN_STARTED_AT` (its existing `run_start`) and `R_EXIT` (its `exit_code`), and writes the raw captured output to `R_LAST_RUN_FILE`. For a wrapped run (`ACCT_RUN_ACCOUNT` non-empty) it then runs `acct_read_status`, and only then drops every line matching `^accshift: ` from the captured text (`grep -v '^accshift: '`), before it is appended to the task output file and before `parse_cli_output` and its JSON extraction.

v1 / v2-root `limitshift.ps1` MUST run under Windows PowerShell 5.1 with `Set-StrictMode -Version 2.0` and under pwsh 7 on all three OSes. That means no `$IsWindows`, no `??`, no ternary; set a local `$ErrorActionPreference='Continue'` around native calls; use `[DateTimeOffset]::FromUnixTimeSeconds` [R08 C11].
```powershell
$script:AccShiftBin = $null; $script:AcctCaps = $null; $script:AcctLegacyNext = $false; $script:AcctBusySince = $null
$script:AcctCurrent = @{}; $script:AcctRouted = @{}        # keyed 'task' | 'verify' | 'planner'
function Invoke-AccShift([string[]]$Arguments) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $out = & $script:AccShiftBin @Arguments '--json' 2>$null; $rc = $LASTEXITCODE }
    finally { $ErrorActionPreference = $prev }
    $j = $null; try { $j = (@($out) -join "`n") | ConvertFrom-Json } catch {}
    [pscustomobject]@{ ExitCode = $rc; Json = $j } }
```
- `Parse-Runner` always adds an `Accounts` property: `$null` (no key), `$false`, or `[string[]]`. v2-root's verifier and planner task objects get it from `verify.accounts` and `mission.roles.<role>.accounts`. `Read-QueueConfig` adds `AccountRotation` (`auto`), `AccountBusyWaitMinutes` (30) and `UseAccShiftClassify` (`$false`) to its `$defaults`.
- `Test-AcctRoutable`, `Test-AcctRunnerEnabled`, `Set-AcctRouting`, `Switch-AcctAccount`, `Wait-AcctBusy` and `Invoke-AcctOutcome` mirror `acct_routable`, `acct_runner_enabled`, `acct_decide`, `acct_switch_to`, `acct_busy_wait` and `acct_outcome`, with an explicit `-Role`; `$script:AcctLegacyNext` is `ACCT_LEGACY_NEXT` and `$script:AcctBusySince` is `ACCT_BUSY_SINCE`.
- `Invoke-CliTaskRun` always adds `AcctAccount` (the account the launch was wrapped with), `AcctLaunched`, `AcctError`, `AcctWrongAccount`, `ExitCode`, `RunStartedAt` and `LastRunFile` to its result object (`$null` when not routed), so StrictMode never meets a missing property. The post-run hooks use `$result.AcctAccount` as A, as the bash ones use `ACCT_RUN_ACCOUNT`. It filters `^accshift: ` lines out of `OutputText` and `StdOut` (`-notmatch '^accshift: '`) after reading the status file and before `ConvertFrom-CliOutput`.

**Per-task reset.** At task start, clear every current account and every routing decision. Then seed the task role from the persisted account file of the runner that resumes (after a restart), or leave it empty. Places:
- v1 sh: the per-task loop in `run_queue`, `:2561`, where the counters reset at `:2607`;
- v2-root sh: `invoke_single_task_execution` `:3426`;
- ps1: the top of the per-task loop (v1 `:3095`; v2-root `Invoke-SingleTaskExecution` `:3656`).

A runner switch also clears the task role's current account and routing decision, because the new runner has its own CLI and pool and decides at its own first pick: v1 sh `:3013-3029`, v2-root `:3947-3962`; ps1 v1 `:3474-3493`, v2-root `:4077-4096`.

**v1 / v2-root `limitshift.sh` hooks.** The verifier and planner (v2-root) use the same code with their own role.
```bash
# end of build_cli_args (v1 :1996, v2-root :2637): the single wrap point (every launch, --dry-run, --show-raw)
local a_role a_cur; a_role=$(acct_role); a_cur=$(acct_current_get "$a_role")
if [ -n "$a_cur" ] && acct_runner_enabled "$a_role" "$idx" "$runner_idx"; then
  # $cli here is build_cli_args's own local, read from the launched runner (not the global of §15.2)
  CLI_ARGS=(exec "$cli" --account "$a_cur" --status-file "$R_ACCT_STATUS_FILE" -- ${CLI_ARGS[@]+"${CLI_ARGS[@]}"})
  CLI_EXE=$ACCSHIFT_BIN; ACCT_RUN_ACCOUNT=$a_cur
fi

# before every run (single: before the invoke at v1 :2690/:2693, v2-root :3554/:3557;
# fallbacks: v1 :3081/:3086, v2-root :4015/:4020; verifier :3141, planner :3206)
if [ -n "$ACCT_LEGACY_NEXT" ]; then acct_current_set "$role" ""; ACCT_LEGACY_NEXT=""   # one unwrapped run (§15.2)
elif acct_routable "$role" "$i" "$r"; then
  args=(pick "$run_cli"); [ -n "$currentModel" ] && args+=(--model "$currentModel")
  cur=$(acct_current_get "$role"); [ -n "$cur" ] && args+=(--prefer "$cur")
  [ -n "$pool" ] && args+=(--pool "$pool")
  acct_call "${args[@]}"; acct_decide "$role" "$i" "$r"     # the role's first pick fixes its routing (§15.4)
  if ! acct_runner_enabled "$role" "$i" "$r"; then acct_current_set "$role" ""   # not routed: run as today
  else case $ACCT_RC in
    0)  acct_switch_to "$role" "$ACCT_NEXT" ;;
    75) if [ "$runnerCount" -eq 1 ]; then        # single runner (verifier, planner too): rest, run on .account
          ui_rest_with_summary "$run_cli" $((ACCT_RESET + RESET_BUFFER_MINUTES * 60)); acct_switch_to "$role" "$ACCT_NEXT"
        else                                    # fallbacks: no sleep; select_next_runner may pick another runner
          limitedUntil[$currentRunnerIndex]=$ACCT_RESET; runnerReasons[$currentRunnerIndex]="limited"
          acct_current_set "$role" ""; runCount=$((runCount - 1)); continue
        fi ;;
    *)  acct_outcome pick "$ACCT_RC" "$ACCT_ERR"
        case $? in 1) runCount=$((runCount - 1)); continue ;; 2) <needs-human> ;; 3) <busy-limited> ;; esac ;;
  esac; fi
fi

# right after invoke_cli_task_run (v1 :2703/:3096, v2-root :3568/:4030); everything below only when the run was wrapped
run_acct=$ACCT_RUN_ACCOUNT                       # A: the account this run used
case $R_EXIT:$ACCT_LAUNCHED in                   # §15.2 exec 125–127, before any classify
  125:true) ;;                                   # the CLI's own 125: normal handling
  125:*|126:false|127:false)                     # accshift failed before the launch (126/127 only with launched:false)
    acct_outcome exec "$R_EXIT" "$ACCT_ERR"
    case $? in 1) runCount=$((runCount - 1)); continue ;; 2) <needs-human> ;; 3) <busy-limited> ;; esac ;;
esac
# after add_runs_csv_row (v1 :2726/:3116, v2-root :3591/:4050)
if [ -n "$ACCT_WRONG" ]; then                    # agy ran as another account: attribute nothing to A (§15.2)
  [ "$result_ok" -eq 1 ] || continue             # a limit or error is re-run (pick, then exec), no retry charge
elif [ "$result_ok" -eq 1 ]; then
  acct_call mark "$run_cli" --account "$run_acct" --ok ${pool:+--pool "$pool"}   # best effort, result ignored
fi

# top of the limit branch, copilot only (§15.2 step 0; v1 :2767, :3157; v2-root :3632, :4091)
if [ "$run_cli" = copilot ]; then
  acct_call classify copilot --exit "$R_EXIT" --evidence-file "$R_LAST_RUN_FILE" \
    --model "$currentModel" --run-started-at "$R_RUN_STARTED_AT"
  [ "$ACCT_CLASS" = error ] && { <new session on A>; continue; }   # session_quota_exceeded: no next, no rotation
fi
# limit branch, while another model remains (same lines); copilot keeps the result above
[ "$run_cli" = copilot ] || acct_call classify "$run_cli" --exit "$R_EXIT" --evidence-file "$R_LAST_RUN_FILE" \
  --model "$currentModel" --run-started-at "$R_RUN_STARTED_AT"   # ACCT_SCOPE=account: skip the remaining models
# limit branch after the model-index reset, in place of wait_for_limit_reset (v1 :2781, v2-root :3646)
# and of the get_runner_reset_epoch line (v1 :3169, v2-root :4103); verifier :3150, planner :3215
lim_model=$currentModel                          # captured before the reset; next_model = the first model
parse_reset_from_error "$result_error_text"      # R_RESET: a reset parsed from this run's output, or empty
args=(next "$run_cli" --from "$run_acct" --model "$next_model" --limited-model "$lim_model"
      --evidence-file "$R_LAST_RUN_FILE" --exit "$R_EXIT" --run-started-at "$R_RUN_STARTED_AT")
case $run_cli in claude|codex) [ -n "$sid" ] && args+=(--session "$sid" --cwd "$project_path") ;; esac
[ -n "$pool" ] && args+=(--pool "$pool")
[ -n "$R_RESET" ] && args+=(--limited-until "$R_RESET")
acct_call "${args[@]}"
while [ "$ACCT_RC" = 73 ] && acct_busy_wait "$ACCT_ERR"; do   # next recorded nothing: repeat the same call,
  acct_call "${args[@]}"                                        # never a pick, never a relaunch on A (§15.2)
done
case $ACCT_RC in
  0)  write_step "Task $taskNumber: limit on $run_cli/$run_acct; switching to $run_cli/$ACCT_NEXT"
      acct_switch_to "$role" "$ACCT_NEXT"; continue ;;
  75) if [ "$runnerCount" -eq 1 ]; then
        ui_rest_with_summary "$run_cli" $((ACCT_RESET + RESET_BUFFER_MINUTES * 60)); acct_switch_to "$role" "$ACCT_NEXT"
      else
        limitedUntil[$currentRunnerIndex]=$ACCT_RESET; runnerReasons[$currentRunnerIndex]="limited"; acct_current_set "$role" ""
      fi; continue ;;
  *)  acct_outcome limit "$ACCT_RC" "$ACCT_ERR"
      case $? in 0) <legacy wait>; continue ;; 1) runCount=$((runCount - 1)); continue ;; 2) <needs-human> ;; 3) <busy-limited> ;; esac ;;
esac

# error branch, before the retry budget (v1 :2785/:3174, v2-root :3650/:4108; verifier :3154, planner :3219)
acct_call classify "$run_cli" --exit "$R_EXIT" --evidence-file "$R_LAST_RUN_FILE" --run-started-at "$R_RUN_STARTED_AT"
case $ACCT_CLASS in
  auth|auth-definitive|blocked)
    args=(next "$run_cli" --from "$run_acct" --reason auth --model "$currentModel" --evidence-file "$R_LAST_RUN_FILE"
          --exit "$R_EXIT" --run-started-at "$R_RUN_STARTED_AT")   # plus --session/--cwd and --pool as above
    acct_call "${args[@]}" ;;   # then the 73 repeat, 0 and 75 as in the limit branch; acct_outcome auth for any other exit
esac
```
- The hooks after the launch run only for a wrapped run (`ACCT_RUN_ACCOUNT` non-empty). An unwrapped run is handled exactly as today.
- `role`, `run_cli` and `pool` are the launched role, its CLI and its pool (§15.2). `runnerCount -eq 1` is the existing single-runner / fallbacks split; the verifier and planner take the single-runner side.
- `sid` is the saved session or thread id, and `project_path` the task's `projectPath`.
- `<needs-human>` and `<busy-limited>` stand for the return-2 and return-3 actions of `acct_outcome`. `<new session on A>` keeps the current account, deletes the session file, requests the handoff note as `acct_switch_to` does for a non-portable move, and counts the run against maxRetriesOnError (§15.2 step 0). `<legacy wait>` is today's line that the hook replaced (`wait_for_limit_reset`, or `limitedUntil[R]=$(get_runner_reset_epoch …)` in fallbacks), called so that no `/usage` probe runs (§15.6).

**v1 / v2-root `limitshift.ps1` hooks** mirror the bash ones:
- **Wrap**, right after `$exe = Get-CliExecutable` (v1 `:2438`, v2-root `:2832`). `$statusFile` and the last-run file (§15.5) are computed at the top of `Invoke-CliTaskRun`, next to `$outputFilePath`:
  ```powershell
  $role = 'task'    # v2-root: 'verify' or 'planner' when -Suffix says so
  $acct = $null; if ($script:AcctCurrent.ContainsKey($role)) { $acct = $script:AcctCurrent[$role] }
  if ($acct -and (Test-AcctRunnerEnabled -Task $Task -Role $role)) {
      Remove-Item -LiteralPath $statusFile -Force -ErrorAction SilentlyContinue
      $arguments = @('exec', $Task.Cli, '--account', $acct, '--status-file', $statusFile, '--') + @($arguments)
      $exe = $script:AccShiftBin }
  ```
- `Invoke-NativeProcess` then launches the native `accshift.exe` through its existing native-exe branch (`ConvertTo-WindowsArgString`), the same path that already carries agy's multi-line `-p` intact. accshift resolves npm shims itself (§12.4).
- `$invokeParams` passes `Cli = $Task.Cli`, the real cli name, never `'accshift'` (P7). An agy launch then starts `accshift.exe` through the `CreateNoWindow` branch, and accshift spawns agy into that hidden console (§12.4).
- **Hook points:**
  - single runner: pick before `:3206`/`:3210` (v2-root `:3759`/`:3763`); limit branch `:3280-3303` (v2-root `:3834-3857`); error branch `:3305` (v2-root `:3859`);
  - fallbacks: pick before `:3546`/`:3551` (v2-root `:4149`/`:4154`); limit branch `:3609-3627` (v2-root `:4212-4228`); error branch `:3629` (v2-root `:4230`);
  - v2-root roles: `Invoke-Verifier` `:3293` (run `:3329`, limit `:3331-3339`, error `:3341`) and `Invoke-Planner` `:3353` (run `:3394`, limit `:3396-3404`, error `:3406`);
  - the post-run hooks (the §15.2 exec 125–127 check: 125 unless `AcctLaunched` is true, 126 and 127 only when it is false; then `wrongAccount` and `mark --ok`) follow each `Invoke-CliTaskRun` call above, as in bash;
  - in the limit branch, a copilot role first runs the §15.2 step-0 `classify`, and a `next` that exits 73 is repeated through `Wait-AcctBusy` exactly as in bash (also in the auth hook);
  - the fallbacks Wait branch (`:3461-3470`, v2-root `:4064-4072`) is unchanged: it sleeps until the `$limitedUntil[$R]` that a `pick` or `next` 75 set, plus resetBufferMinutes, and the next iteration picks again.
- **Types.** The ps1 runners keep `[datetime]` values: `$limitedUntil[$R] = [DateTimeOffset]::FromUnixTimeSeconds([long]$j.resetAtEpoch).LocalDateTime`, and a rest is `Invoke-UiRestWithSummary -Cli $task.Cli -WakeTime ([DateTimeOffset]::FromUnixTimeSeconds([long]$j.resetAtEpoch).LocalDateTime.AddMinutes($config.Settings.ResetBufferMinutes))`. The run loops have no `$Settings` and no `$cli` (under StrictMode 2.0 either would throw): they use `$config.Settings` and the launched runner's `.Cli` (`$task.Cli` for a single runner, `$activeRunner.Cli` in fallbacks, `$verifierTask.Cli` / `$plannerTask.Cli` for v2-root roles). `Select-NextRunner`, `Wait-ForRunnerReset` and `Invoke-UiRestWithSummary` take `[datetime]`. `--limited-until` is `([DateTimeOffset]$parsed).ToUnixTimeSeconds()` of `Get-ResetTimeFromErrorText`'s result, and `--run-started-at` is `[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()` taken just before `Invoke-NativeProcess`.

**v2-root roles.** `invoke_verifier` / `Invoke-Verifier` and `invoke_planner` / `Invoke-Planner` call `invoke_cli_task_run` / `Invoke-CliTaskRun` with runner 0. They therefore reach the same wrap point, and the wrap reads the current account of the role being launched, never the task runner's. Each role makes its own routing decision (§15.4), picks before its run, calls `next` in its limit branch, runs the auth hook in its error branch and `mark --ok` after a successful run. The verifier and planner always start New, so they persist no account file.

**v2 engine (`v2/lib/Cli.ps1`):**
- `v2.ps1` gains `-AccountRotation auto|off|required` and `-AccShiftPath`. Discovery and `ACCSHIFT_NONINTERACTIVE` are as above. v2 role chains carry no `accounts`, so every v2 role is a runner without an `accounts` key (§15.4 and the legacy rule apply).
- In `Invoke-CliRoleOnce` (`:476`), set `$acct = $null` before the loop and move `Resolve-CliLaunch` (`:506`) inside the `while` loop (`:511`), so the account can change between attempts. Each attempt removes its own `$launch.Cleanup` files when it ends; today's `finally` (`:588`) only cleans the last launch. Here `<cli>` is `([string]$roleCfg.Cli)` and `<model>` is `[string]$roleCfg.Model` (`--model` omitted when it is empty): `$cli` and `$model` are locals of `Get-CliInvocation` (`:280-281`) and do not exist in `Invoke-CliRoleOnce`. Before each attempt, `pick <cli> --model <model> [--prefer $acct]`; the first pick of the call decides routing for all its attempts (§15.4). For a routed role: 0 → `$acct = $p.Json.account`; 75 → `$acct = $p.Json.account`, then the limit branch's sleep logic; other exits per §15.2 (legacy → `$acct = $null`).
  ```powershell
  $launch = if ($acct) { Resolve-CliLaunch -Command $script:AccShiftBin -CliArgs (@('exec', ([string]$roleCfg.Cli), '--account', $acct, '--status-file', $statusFile, '--') + @($inv.Args)) }
            else       { Resolve-CliLaunch -Command $inv.Exe -CliArgs $inv.Args }
  ```
- Each attempt records `$runStart` (epoch s) before `Start-Process` and writes `"$stdout`n$stderr"` to its last-run file. `$statusFile` (deleted before the launch) and the last-run file are per-attempt temp files like `$outFile` (`:512`), removed once the attempt's accshift calls are done. After the exit it reads the status file and applies the exec 125–127 rules of §15.2. It drops `^accshift: ` lines from `$stdout` and `$stderr` before `Test-LimitSignal` and `ConvertFrom-ClaudeJsonOutput`.
- **Limit branch** (`:544`), before the over-24-hours / deadline / sleep logic (`:548-563`): `next <cli> --from $acct --model <model> --limited-model <model> --evidence-file <last-run file> --exit $exitCode --run-started-at $runStart`. Add `--limited-until` only when `Get-ResetTimeFromText` returned a value, before its `+5 min` and never the 15-minute fallback. A copilot role first runs the §15.2 step-0 confirmation.
  - 0 → `$acct = $nx.Json.account`, log `[acct] <cli> A -> B`, `continue` (retry at once). v2 never resumes sessions, so this is always safe.
  - 75 → `$acct = $nx.Json.account`; `$resetTime = [DateTimeOffset]::FromUnixTimeSeconds([long]$nx.Json.resetAtEpoch).LocalDateTime.AddMinutes(5)`; then the existing >24 h, deadline and sleep logic.
  - other exits per §15.2; a legacy outcome keeps today's logic with `$acct = $null`.
- **Auth branch** (`:578-582`): a routed role calls only `next <cli> --from $acct --reason auth --model <model> --evidence-file <last-run file> --exit $exitCode --run-started-at $runStart`.
  - 0 → `$acct = $nx.Json.account`; `continue`.
  - 75 → as in the limit branch.
  - 69 or 77 → `Set-V2AuthDeadCli`. Today a single 401 blacklists the whole CLI [R08 C6].
  - other exits per §15.2.
- **Success:** after an attempt that is neither a limit nor an auth failure and exits 0, call `mark <cli> --account $acct --ok`, best effort.
- **Preflight rule 3** (same limit bucket on consecutive steps, `Preflight.ps1:81-90`): role-chain steps carry only `{Cli, Model}`, and accounts are chosen at run time, so preflight cannot tell which accounts will run. The rule becomes a WARNING only when accshift is active for that CLI and `list <cli> --json` reports `rotationPossible:true`; otherwise it stays an error.
- The budget (`New-V2Budget`) counts `AccountSwitches`.

### 15.4 Queue schema additions

The schemas have `additionalProperties:false` on every object below, so the keys MUST be added at exactly these JSON paths. Older runners ignore unknown keys.
- v1 and v2-root `limitshift-queue.schema.json`:
  - `properties.settings.properties.accountRotation`: `{"enum":["auto","off","required"],"default":"auto"}`;
  - `properties.settings.properties.accountBusyWaitMinutes`: `{"type":"integer","minimum":1,"default":30}` (§15.2);
  - `properties.settings.properties.useAccShiftClassify`: `{"type":"boolean","default":false}` (§15.8);
  - `properties.tasks.items.properties.accounts` and `properties.tasks.items.properties.fallbacks.items.properties.accounts`.
- v2-root only: `properties.tasks.items.properties.verify.properties.accounts` and `properties.mission.properties.roles.properties.{planner,executor,verifier}.properties.accounts`.

Every `accounts` property has the same schema:
```json
{ "oneOf": [ { "const": false },
             { "type": "array", "items": {"type":"string","minLength":1}, "minItems": 1, "uniqueItems": true } ] }
```

The `accounts` key:
- **omitted** = every enabled accshift account for that CLI;
- **`false`** = opt out (run as the CLI's own login);
- **one name** = pin the runner to that account;
- **several names** = a pool in preference order (passed as `--pool`).

A role is **opted out**, and runs unwrapped exactly as today, when accshift is absent, `accountRotation` is `off`, `accounts` is `false`, or the runner is Ollama / `--oss` (codex included), or the CLI is `gemini`, which accshift does not support (§1.3; this holds under `required` too). The agy rule below overrides this. Any other role is **routed** for the current task when one of these holds:
- `accounts` is an array;
- `accountRotation` is `required`, and the CLI is not `experimental` or the runner lists `accounts`;
- `accountRotation` is `auto`, the CLI is in `supportedClis` and not `experimental` (§11.2), and the role's **first** `pick` of the task returns exit 0 or 75 with `rotationPossible:true`;
- the CLI is agy while accshift has at least one agy account registered, under `auto` or `required` (the agy rule below).

Otherwise the role is not routed. Under `auto` it then runs unwrapped as today and makes no further accshift calls in this task; under `required` the task is needs-human. The decision is made at the role's first pick of the task and fixed for the rest of the task; a fallbacks runner switch starts a new decision for the new runner (§15.3). A routed role whose CLI exec cannot run on this OS gets 69 `unsupported-cli` from `pick`, and the legacy rule (§15.2) decides what follows.

The `rotationPossible` condition prevents a queue silently running as an account other than the CLI's own login [R08 §e]. The reverse also holds: a runner that names accounts, or any runner under `required`, never silently runs as the CLI's own login, because the legacy rule (§15.2) sends its failures to needs-human.

- **`required`**: accshift must be found, else a real run stops with an ERROR before the first task. Every role that is not opted out (`accounts:false`, Ollama / `--oss`) is routed whatever `rotationPossible` says. Its CLI must therefore be in `supportedClis`, and, if `experimental`, the runner must list `accounts` (otherwise a validate-only ERROR, and needs-human at run time). The exception is an agy runner while agy accounts are registered: it is routed without `accounts` (agy rule below).
- **`experimental` clis** (rotation unverified on this OS, §11.2) are routed under `auto` only when the runner lists `accounts` explicitly; `--validate-only` then prints a WARNING. The one exception is agy: while accshift has at least one agy account registered, every agy runner is routed, with or without `accounts`, under `auto` or `required`, because an unwrapped agy would race slot swaps; `--validate-only` then prints a WARNING that agy rotation is experimental on this OS.
- **agy.** While accshift has at least one agy account registered, accshift owns agy's slot:
  - LimitShift checks this with `accshift list agy --json` (exit 0 with a non-empty `accounts`; a non-zero exit also counts as yes, §15.2) at an agy role's first pick of each task;
  - an agy runner without `accounts` counts as listing every agy account, so it is routed even when agy is `experimental` or `rotationPossible` is false (no `--pool` is passed);
  - an agy runner is never launched unwrapped, under any rule;
  - `accounts:false` or `accountRotation:"off"` on an agy runner is a validate-only ERROR, and needs-human at run time.

`accounts`, `accountRotation` and `accountBusyWaitMinutes` MUST stay **out of the task fingerprint**, so changing a pool does not re-run finished tasks.

### 15.5 State, UI and logs in LimitShift

- **Per-task account file:** `sessions/task-NN-account.txt` (runner 0) and `sessions/task-NN-runner-K-account.txt` (fallbacks runner K), with the same names in sh and ps1.
  - It is written when the task role's current account changes, and read only at task start to seed `--prefer` (§15.3).
  - Delete it with the session file when the fingerprint is invalidated (v1 sh `:2592-2605`, v2-root `:3446-3458`).
  - A stale name (renamed, removed, disabled or no longer in the pool) is harmless: `pick` ignores it (`preferIgnored:true`, §9.3), and LimitShift persists the account `pick` returns instead.
- **Last-run file:** `outputs/task-NN[-suffix]-last-run.txt`, where `[-suffix]` is v2-root's role suffix (`-verify`, `-planner`); task runs of every runner use the plain name.
  - It is truncated before every run and then holds only that run's captured stdout and stderr. It is the only file passed as `--evidence-file`.
  - The cumulative `outputs/task-NN-…-output.txt` is never passed to accshift. It holds prompts, earlier runs and handoff copies of a previous account's limit text, which would charge that account's reset to the new one.
- **Status file:** `sessions/task-NN[-suffix].acct-exec.json`, with the same suffix rule. Every wrapped launch passes it as `--status-file`.
  - It is deleted before each run and read after it.
  - LimitShift uses `launched`, `error.code`, `error.reason` and `wrongAccount` (§15.2), and logs `postRunError`, `foreignAgy` and a non-empty `addedArgs` (the one secret-isolation argument exec may prepend, §7.6) as INFO lines. Those never change the run's result (§11.2, §12.1.1).
- **runs.csv** gets a 9th column, `account` (empty for an unrouted run). Existing 8-column files are rotated to `runs-<ts>.csv` on first write. Update `initialize_runs_csv` / `add_runs_csv_row` and ps1 `$RunsCsvHeader` / `Add-RunsCsvRow`, and the 5 header assertions in each repo's tests.
- **UI:** the task header shows `cli · model · account`.
  - The limit message becomes "Hit a usage limit on claude/work; switching to claude/main".
  - New wording: "all N accounts capped; next free: claude/main at 15:00".
  - Busy waits print "waiting for accshift (<error.code>)", for example `slot-busy` while another queue uses agy's slot.
- **Run budget:** every switch uses one run, so docs advise raising `maxRunsPerTask` for pools. Busy waits and picks that launch nothing are not charged (§15.2).
- **Capability cache** is keyed `capabilities/<cli>@<account>.json`. `agy models` and `--probe-models` run through `accshift exec agy --account X` [R08 C7], and `exec` is a writer that may swap agy's slot (§11.1 rule 8, §8.3.3).
  - `--validate-only` never runs `exec` (§15.7): it validates only against cached capabilities.
  - A real run runs agy model discovery before its first agy run, for the account X that `pick` returned for that run: `exec agy --account X -- models` runs when X has no fresh cache entry, then the run itself starts on X. The slot then already holds X, so discovery adds no extra swap. A failed discovery is a WARNING, and the cached capabilities, if any, are used.
  - A pool's model is validated against the union of its cached accounts; an uncached pool account is a WARNING.
  - `--probe-models` (explicit) may probe each pool account and prints first that this swaps agy's slot.
- **Redacted outputs:** an agent's own `env` or debug dump can print an injected token into the run output (§7.6). LimitShift SHOULD pass captured outputs through the same redaction patterns as accshift (§14.4) before writing `outputs/task-NN-…-output.txt` and the last-run file.

### 15.6 Things that change when the account changes mid-task

1. **Claude `/usage` cross-check:** LimitShift MUST NOT run `claude -p /usage` for a routed claude runner, for any account. It relies on `resetAtEpoch` from `next` / `classify`.
   - `token` accounts are inference-only, so `/usage` has no plan data for them [R04 C5].
   - Short-lived Claude commands can spend a login-slot or native account's refresh token [R09 C3], which contradicts the "never probe" rule (§14.2 rule 2).
   - Routed limit branches parse only this run's output (§15.2). A legacy wait for a routed runner skips the probe:
     - v1 sh calls `wait_for_limit_reset` / `get_runner_reset_epoch` without the task index;
     - v2-root sh calls them without the working directory (after P2 the probe would otherwise run);
     - v1 ps1 gives `Get-RunnerResetTime` a new `-SkipUsage` switch, which `Wait-ForLimitReset` passes through for the single runner;
     - v2-root ps1's `Get-RunnerResetTime` has no probe.
   - The existing probe stays only for roles that are not routed (§15.4).
   - accshift itself never runs `/usage` (§9.6).
2. **Session lost / resume incompatible:**
   - after a switch, a Claude `No conversation found with session ID`, a Codex `invalid_encrypted_content` / `organization_id did not match`, or an agy resume failure → New session **with** the handoff note;
   - today's single-runner session-lost path restarts without the note, which must change;
   - Codex gets a new session-lost detection (`codex exec resume` of an unknown thread id; exact text VERIFY V-X5).
   - Codex moves between accounts report `possible` or `unlikely`, so `sessionPortable` is false and LimitShift starts New plus the handoff note directly, without trying a resume (§8.2).
3. **agy** has `sessionPortable:false` until verified (§8.3). LimitShift then starts fresh with the handoff note after an agy switch.
   - `pick agy` returns the live slot owner whenever it is a usable candidate, even when `--prefer` names another account, and `next agy` prefers it too (§9.3). A resumed agy task can therefore move to another account at any run; the session rule (§15.2) then starts it New.
4. **Ollama / `--oss` runners**, codex included, always bypass accshift.

### 15.7 `--validate-only` additions

`--validate-only` calls only read-only commands (`version`, `list`, `status`, `pick`, `doctor --json`; §11.1 rule 8). It never runs `exec`, so it changes no accshift state and never swaps agy's slot; only an explicit `--probe-models` does (item 8).
1. Locate accshift and print `INFO: accshift <ver> at <path> (contract 1)`.
2. With `accountRotation:"required"` and accshift missing → ERROR. A real run stops with the same error before the first task.
3. Unknown account names (from `list <cli> --json`) → `ERROR: Task N: account "x" is not configured in accshift for claude (did you mean: y?)`. Reuse the existing edit-distance helpers (sh `_levenshtein`, ps1 `Get-EditDistance`).
4. `accounts` on an Ollama runner → WARNING (ignored).
   - A CLI outside `supportedClis` → WARNING (not routed), or ERROR when the runner lists `accounts` or the queue sets `required`. A `gemini` runner is INFO "not routed (unsupported)" under every `accountRotation`, and ERROR only when it lists `accounts`.
   - An `experimental` CLI → WARNING when the runner lists `accounts` (rotation unverified on this OS), else INFO "not routed (experimental)"; ERROR under `required` without `accounts` (§15.4).
   - Exception: an agy runner while agy accounts are registered is routed with or without `accounts` (§15.4) → WARNING "agy rotation is experimental on this OS", never INFO "not routed" or ERROR.
   - agy with agy accounts registered and `accounts:false` or `accountRotation:"off"` → ERROR (§15.4).
5. A pool with fewer than 2 usable accounts → INFO "no rotation". A pinned runner waits for its own account.
6. `accshift doctor --json` errors for pool accounts (expired token, missing home) → WARNING per account.
   - LimitShift only ever calls `doctor --json`, never `--fix`. Without `--fix`, `doctor` exits 0 whenever it ran; LimitShift reads `ok` and `findings` (§11.2). `doctor --json` never runs `<cli> --version` (§9.6).
   - LimitShift also runs `doctor --json` at the **start of every real run** (not only `--validate-only`), while the user is still present. It warns when the vault key source cannot be read unattended, for example a locked keychain or a locked Secret Service collection (D7).
   - The provider notice not accepted (`status --json` → `notice.accepted:false`, for example after an upgrade changed the notice version) → ERROR for roles that are routed whatever `rotationPossible` says (runners that list `accounts`, agy while agy accounts exist, every role under `required`), because `pick` exits 69 `notice-not-accepted` until it is accepted (§9.3) and they would be needs-human; WARNING for the others, which then run unrouted. The message gives the fix: `accshift notice --accept` (§10.2).
7. agy pools while other queues may run in parallel → WARNING. There is one slot, so agy runs serialize and **tasks wait**: `slot-busy` and `agy-busy` are transient (§15.2), not failures.
8. agy models are checked only against cached capabilities (§15.5); an agy pool account with no cache entry is a WARNING. `--probe-models` is the one exception: it may probe each pool account through `exec`, and says first that this swaps agy's slot.

### 15.8 Phase 3: one implementation of limit parsing

LimitShift maintains every limit regex and reset parser twice (sh and ps1), and the research found repeated parity bugs [R03 C2]. The integration already calls `classify` for the scope, the copilot limit confirmation and the auth hook (§15.2). Once `accshift classify` is stable, LimitShift MAY also replace its own limit detection:
- call `accshift classify <cli> --exit N --session ID --cwd DIR --evidence-file <last-run file> --model M --run-started-at T0 --json` after every run;
- use `class`, `scope`, `resetAtEpoch`, `retrySameAccount` and `rotate` (§11.2) in place of `R_IS_LIMIT` and the reset parsers.

Plain `classify` records nothing, so it never double-counts with `next` (§9.2). The existing parsers remain the fallback when accshift is absent. This is optional and behind `settings.useAccShiftClassify` (default false until M7).

### 15.9 Install and offer

- No automatic download, ever.
- `tools/get-accshift.sh` and `tools/get-accshift.ps1` (or `--install-accshift` / `-InstallAccShift`) install a **pinned** accshift version into `<limitshift>/bin`. The integrity check must not depend on anything downloaded alongside the archive:
  - the helper embeds a table of the expected SHA-256 values of the pinned version's six archives (and of `install.sh` / `install.ps1`), updated in the same LimitShift commit that bumps the pin;
  - it downloads only from `https://github.com/j-ts/accshift/releases/download/v<pinned>/`;
  - it unsets `ACCSHIFT_REPO`, `ACCSHIFT_ARCHIVE` and `ACCSHIFT_GITHUB_TOKEN` for the installer;
  - it runs the installer with `ACCSHIFT_INSTALL_DIR=<limitshift>/bin`, `ACCSHIFT_VERSION=<pinned>`, `ACCSHIFT_NO_MODIFY_PATH=1` (LimitShift's private copy never lands on the user's PATH) and `ACCSHIFT_NO_INSTALL_RECEIPT=1` (no `install.json`, so `self-update` never targets LimitShift's copy), all defined in §17.6;
  - it verifies the archive against its own table before installing, and also runs the cosign identity check of §17.6 when `cosign` is present.
- Add `bin/` to LimitShift's `.gitignore`.
- Docs to update: README, README.uk.md, REFERENCE, AGENTS.md (queue-building agents learn the `accounts` key), and the schema descriptions.

### 15.10 LimitShift tests

Add a stub `accshift` (bash plus a `.ps1`/`.cmd` twin for Windows Pester) that:
- implements contract 1 over a state file under `$ACCSHIFT_STUB_STATE`: `version` (with `stderrCatalogue`), `list`, `status`, `pick`, `next`, `mark`, `classify`, `doctor` and `exec`;
- has an `exec` that writes the `--status-file`, exports `FAKE_ACCOUNT` and execs the CLI stub, so CLI stubs can answer per account. It can be told to fail with 125, 126 or 127 and a given `error.code` (`launched:false`), or to report `wrongAccount`;
- logs every call with its argv and the value of `ACCSHIFT_NONINTERACTIVE`, so tests can assert flags.

Scenarios. Items 1–12 were proven in the research prototype [R08 §g]; the rest are new.
1. accshift absent or `off` → today's result, byte-identical except the runs.csv `account` column;
2. same-session switch to B with no rest;
3. order: models first, then accounts; an account-wide `scope` skips the remaining models;
4. every account capped → wait for the soonest;
5. fallbacks: the runner's `limitedUntil` is the soonest account reset;
6. exec 125–127 per code (§15.2), read from the status file, and for 125 from the `accshift: error <code>:` line when the status file is missing:
   - `slot-busy`, `agy-busy`, `state-busy` and `vault-busy` do not burn maxRetriesOnError or maxRunsPerTask, and give up after accountBusyWaitMinutes;
   - `needs-relogin` and `unknown-account` re-pick another account;
   - `bare-ignores-token` marks the task needs-human;
   - exec 127 `not-found` (and 126) with `launched:false` marks the task needs-human without calling `classify`; with `launched:true` it is the CLI's own result;
7. a lost session after a switch starts New with the handoff note;
8. no `claude -p /usage` call for a routed claude runner, for any account;
9. dry-run prints the wrapped command only, including `--status-file`; an argument exec adds appears only in the status file's `addedArgs`, which a real run logs (§15.5);
10. validate-only errors and warnings of §15.7;
11. runs.csv `account` column;
12. bash 3.2 (macOS CI, plus a source-built bash 3.2.57 on Linux);
13. a pinned runner (`accounts:["work"]`) never runs on another account after a limit: `next` gets `--pool work` and returns 75;
14. pool `[a,b]` never selects `c`, in `pick`, `next` and `mark`;
15. a pinned pool whose accounts are all needs-relogin never invokes the CLI stub without `FAKE_ACCOUNT`, and marks the task needs-human;
16. an implicit runner with one account (`rotationPossible:false`) runs unwrapped, as today; an agy runner never runs unwrapped while agy accounts exist;
17. task 2 on another CLI does not inherit task 1's account; a v2-root verifier on codex never runs as the executor's claude account;
18. a single 401 leaves the account auth-suspect, not needs-relogin, and makes exactly one `next --reason auth` call (no `mark --auth-failed`);
19. auth-suspect, then a successful run → `mark --ok` is called and strikes reset; a later 401 is again a first strike;
20. a 401, 20 successful runs, then a 401 more than 15 minutes later → not needs-relogin;
21. an Opus-only record on A does not stop a Sonnet runner from picking A; `next` gets `--model` (next run) and `--limited-model` (failed run) separately;
22. the first run of a task passes no `--prefer`; a stale name in the account file is ignored and replaced;
23. fallbacks: `pick` 75 for runner R moves to the next runner without sleeping;
24. the evidence file holds only the last run, and `--limited-until` is passed only for a reset parsed from that run, never the limitWaitMinutes fallback;
25. `sessionPortable:false` (codex, agy) after a switch → New plus the handoff note;
26. `wrongAccount` in the status file → the run is re-run, and `next` and `mark` are not called for it;
27. `^accshift: ` lines are stripped before limit and auth matching and JSON extraction; a post-run `postRunError` does not change the result;
28. LimitShift's own limit and auth regexes match no line of the pinned release's `testdata/stderr-catalogue.txt` (the `stderrCatalogue` of `version --json`, §11.2), copied into LimitShift's tests with each pin bump;
29. every accshift call sees `ACCSHIFT_NONINTERACTIVE=1`;
30. a copilot `session_quota_exceeded` run (`classify` class `error`) never changes the account: no `next`, and the next run starts New with the handoff note on the same account;
31. a `next` that exits 73 is repeated as the same `next` call after 60 s, with no `pick` and no CLI-stub run in between, and gives the busy-limited outcome after accountBusyWaitMinutes;
32. `--validate-only` never calls `exec` (without `--probe-models`), and an uncached agy pool account is a WARNING;
33. pick 69 `notice-not-accepted` on a runner that lists `accounts` marks the task needs-human with the hint `accshift notice --accept`.

Make the Pester suite cross-platform: `[IO.Path]::PathSeparator`, the current pwsh path instead of a hard-coded `powershell.exe`, and no `cmd /c` [R08 C6].

---
