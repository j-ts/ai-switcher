# LENS: contract-integration
The core contract is close to implementable. The LimitShift integration in §15.3 is not: as written it would produce wrong-account runs.

Three blockers:
1. The single global ACCT_CURRENT / $script:AcctCurrent is never reset between tasks. In v2-root it is also applied to the verifier and planner, which may be different CLIs.
2. The bash `next` call uses `$cli`. That variable is not defined in run_queue; it leaks from read_queue_config as the CLI of the last runner in the queue. The call also omits `--pool`, so a pinned runner can be switched to an account outside its pool.
3. "Legacy fallback" means running the CLI's own login. That silently runs pinned, required and token-only runners as the wrong account. The `rotationPossible` gating from §15.4 also never appears in the hooks.

Major contract defects:
- Appendix E and §10.3 contradict §12.1.1. They give exec 73, 74, 75, 64, 69 and 78, but exec reserves only 125–127.
- Exit 125 handling contradicts itself, and LimitShift cannot detect the cause. No `--status-file` is passed and no stderr format is defined.
- The stderr catalogue rule does not protect LimitShift's parsers. Lines interpolate PATH, pids and account names (a Nix store hash containing "429" matches the limit regex). Post-run warnings break bash `jq empty`.
- §15.8 uses classify flags and fields that do not exist.
- The contract schemas are underspecified.

Major integration defects:
- The /usage instructions contradict each other.
- The evidence file is the cumulative task output, including handoff prompts. That attributes a previous account's reset to the new account, and a guessed reset is passed as caller evidence.
- The auth path double-counts strikes (mark plus next), and v1 has no auth detection at all.
- `mark --ok` is never called, so counters never reset on success.
- An empty `--prefer` on the first run is undefined.
- The instruction "Keep -Cli agy" rests on a false premise: Invoke-CliTaskRun never passes -Cli, so the CreateNoWindow branch is dead code today.
- The helpers and globals are undefined, which crashes under `set -u` / StrictMode 2.0 even when accshift is absent.
- `pick` returning 75 in fallbacks mode sleeps instead of moving to the next runner.
- The v2 preflight change cannot be implemented: role chain steps carry no account.

Minor: the epoch/RFC 3339 pairs in the examples do not match each other, plus several enum, field and doc inconsistencies.

Files checked: /home/user/accshift-spec/SPEC.md, /home/user/accshift-spec/DECISIONS.md, /home/user/accshift-spec/research/08-limitshift-integration.md, /home/user/j-ts/limitshift/limitshift.sh, /home/user/j-ts/limitshift/limitshift.ps1, /home/user/limitshift-v2/limitshift.sh, /home/user/limitshift-v2/limitshift.ps1, /home/user/limitshift-v2/v2/lib/Cli.ps1, /home/user/limitshift-v2/v2/lib/Preflight.ps1.

## 1. [blocker] §15.3 Hook points (v1 / v2-root limitshift.sh and limitshift.ps1)
PROBLEM: The current account is one global (ACCT_CURRENT / $script:AcctCurrent). It is cleared only on a runner switch, never at task start. v2-root's verifier and planner runs go through the same single wrap point and inherit the main runner's account, which may belong to a different CLI.
EVIDENCE: Spec: "before each run ... when ACCT_CURRENT is empty: acct_call pick" and "runner switch (:3029): ACCT_CURRENT=\"\"" are the only resets. R08 §c had "task start (:2611): ACCT_CURRENT=\"\""; the spec dropped it. In single-runner mode there is no runner switch between tasks, so task 2 (codex) launches as `accshift exec codex --account <task 1's claude account>`.
v2-root sh: invoke_verifier (limitshift.sh:3113-3141) and invoke_planner (:3174-3206) call invoke_cli_task_run with runner_idx 0, which reaches build_cli_args (:2528, called at :3023), the one wrap point.
v2-root ps1: Invoke-Verifier (:3293) calls `Invoke-CliTaskRun -Task $verifierTask` (:3330).
The verifier CLI defaults to codex while the executor is claude (v2.ps1 defaults; verifier must be claude or codex). The verifier therefore runs as `exec codex --account <executor's claude account>`. `acct_runner_enabled "$cli" "$idx" "$runner_idx"` reads runner 0's `accounts`, not tasks[].verify.accounts.
§15.4 adds `accounts` to verify and mission.roles.*, but §15.3 has no hook for those roles. Same-named accounts across CLIs (main/work) make this a silent wrong-account run.
FIX: Add to §15.3:
(1) At task start (v1 sh :2611; ps1 at the top of the per-task loop) clear every current-account variable.
(2) Keep the current account per launch role and runner: sh ACCT_CURRENT_TASK_<K>, ACCT_CURRENT_VERIFY, ACCT_CURRENT_PLANNER; ps1 a hashtable `$script:AcctCurrent['task:K'|'verify'|'planner']`. The build_cli_args / Invoke-CliTaskRun wrap reads the entry for the role being launched (sh: VERIFY_RUN_ACTIVE / PLANNER_RUN_ACTIVE; ps1: -Suffix 'verify'/'planner').
(3) acct_runner_enabled / Test-AcctRunnerEnabled take the role and read tasks[i].verify.accounts or mission.roles.<role>.accounts.
(4) List the v2-root hook points: sh invoke_verifier :3141/:3150 and invoke_planner :3206/:3215; ps1 Invoke-Verifier :3330-3337 and Invoke-Planner :3396-3402. Each does `pick` before its run and `next` in its limit branch.

## 2. [blocker] §15.3 bash single-runner limit branch (and the fallbacks / ps1 mirrors)
PROBLEM: The `next` call passes `$cli`, which run_queue does not define. It is a stale global holding another task's CLI. The call also omits `--pool`, so it can return an account outside a pinned pool, and omits the `--model`, `--evidence-file` and `--exit` flags that §15.2 step 2 requires.
EVIDENCE: Snippet: `acct_call next "$cli" --from "$ACCT_CURRENT" --limited-until "$lim"` and `ui_rest_with_summary "$cli" ...`.
run_queue has no `cli` variable; the task's CLI is `task_cli` (limitshift.sh:2666), or `fb_active_cli` in fallbacks (:3031). read_queue_config assigns `cli=$(get_runner_field ...)` without `local` (limitshift.sh:945; also :1225 and :1338). `$cli` therefore holds the CLI of the last runner validated.
Example: task 1 claude, last task codex. A claude limit calls `next codex --from work`. That records the limit on codex/work and returns a codex account name, which is then used as `exec claude --account <name>`.
Without `--pool`, a runner with `accounts:["work"]` is switched to another account. §15.4 says the pool is "passed as --pool". §15.2 step 1 also needs the scope (`--model M`), which this call never provides.
FIX: Replace the line with `acct_call next "$task_cli" --from "$ACCT_CURRENT" --model "$currentModel" --exit "$R_EXIT" --evidence-file "$R_RUN_OUTPUT_FILE" ${ACCT_POOL:+--pool "$ACCT_POOL"} ${lim_parsed:+--limited-until "$lim_parsed"}`.
- Fallbacks: use `$fb_active_cli`. ps1: use `$task.Cli` / `$activeRunner.Cli`.
- Export R_EXIT and R_RUN_OUTPUT_FILE from invoke_cli_task_run.
- Add to §15.3: "Every pick and next call MUST pass the runner's pool as --pool whenever the runner's `accounts` is a list, and MUST pass the CLI of the runner being launched."

## 3. [blocker] §15.2 step 3, §15.3 (pick handling), §15.4 accountRotation, §7.5
PROBLEM: Every accshift failure path degrades to "legacy behaviour", which means launching the CLI unwrapped as its own login. For a runner pinned to an account, a token-only pool, or `accountRotation:"required"`, that is a silent wrong-account run. The `rotationPossible` gate from §15.4 is never applied in the hooks either.
EVIDENCE: §15.2: "69, 73, 74, 77, 78 or any other code → legacy behaviour" and "exec exit 125 with keystore-unavailable ... switches that runner to legacy mode ...: the CLI's own login".
§15.3 pick: only "rc 0|75 -> ACCT_CURRENT=..." is handled. Any other rc leaves ACCT_CURRENT empty, so build_cli_args does not wrap and the native login runs.
§15.4 says one name pins the runner and that the auto rules prevent "a queue silently running as an account other than the CLI's own login". The opposite case (a pinned account silently replaced by the native login) is unhandled.
The pick snippet never reads `rotationPossible`. With only `claude/work` registered, pick returns work with rc 0 and every claude run is routed through it, contradicting the §15.4 auto rule.
`required` has no runtime meaning anywhere (§15.7 only covers validate-only).
FIX: Add to §15.2: "Running unwrapped is allowed only for a runner with no `accounts` key under accountRotation:auto.
- If the runner lists `accounts` or the queue sets `required`: a pick/next result other than 0/75, or exec 125 keystore-unavailable / needs-relogin / unknown-account, MUST NOT fall back to the native login. Mark the task failed and needs-human with the accshift error code, except 73 / slot-busy / agy-busy / state-busy, which wait and retry.
- In auto mode, a runner is routed only when the first pick of the task returns rotationPossible:true or `accounts` is explicit. That decision is fixed for the rest of the task."
Add matching scenarios to §15.10.

## 4. [major] Appendix E; §10.3; §12.1, §12.1.1; §4.2; §6.1/§6.4; §13.1; §16
PROBLEM: Exit codes for exec contradict each other. Appendix E and §10.3 assign exec the codes 64, 70, 73, 74, 75 and 78 (and §4.2 gives 69), while §12.1 reserves only 125–127 because every other code may be the CLI's own exit.
EVIDENCE: Appendix E:
- 73 "exec (slot wait)", but §13.1 says "then exec exits 125 (slot-busy)";
- 74 "exec for token kinds", but §7.3 / DECISIONS D7 say "exit 125 with keystore-unavailable for exec";
- 75 "pick, next, exec (when picking)", but §12.1 says "on 75 or 77 it exits 125 with error.code all-capped or needs-relogin";
- 64, 70 and 78 are listed for "all".
§10.3 says 64 = "unknown cli or account", but §12.1.1 says unknown-account → 125.
§4.2 ("Unsupported combinations return exit 69"), §6.1 (relative ACCSHIFT_HOME → 64, bad permissions → 78), §6.4 (newer file → 78) and §13.1 (vault.lock → 73) do not exclude exec.
§16 step 5 has `run` exit 75. A child claude exiting 75 or 78 would then be indistinguishable from accshift's own result.
FIX: Appendix E:
- Mark rows 64, 65, 69, 70, 73, 74, 75, 77 and 78 "control verbs only (never exec or run)".
- Remove "exec" from the 73, 74 and 75 rows.
- 125 row: "every exec/run failure before the child starts".
Add to the §12.1.1 table: `usage` (bad flags), `unsupported-cli`, `config-error` (corrupt, newer or permissive files), `internal`, `vault-busy`.
In §10.3 change 64 to "(control verbs; exec/run report 125 unknown-account)".
In §16 step 5, `run` exits 125 with `all-capped`.

## 5. [major] §12.1.1, §15.2 step 3, Appendix E row 125, §15.10 scenario 6
PROBLEM: The caller action for exec exit 125 contradicts itself, and LimitShift has no specified way to learn the 125 reason. Busy and needs-relogin reasons dead-end the task.
EVIDENCE: Appendix E 125: "treat as CLI error charged to the retry budget, never as a limit; never rotate on it". §15.2: keystore-unavailable "switches that runner to legacy mode", detected "from --status-file or the `accshift: keystore-unavailable` stderr line".
The §15.3 wrap (`exec "$CLI_EXE" --account ... --`) never passes `--status-file`. §12.1.1 only says lines start with `accshift: `, so no stderr format carries `error.code`, although Appendix E says "`error.code` on stderr".
slot-busy / agy-busy / state-busy are transient (Appendix E 73 says "retry later"). Treated as CLI errors, they burn MAX_RETRIES_ON_ERROR in seconds and set the runner aside.
needs-relogin / unknown-account never heal, yet LimitShift retries the same account. In LimitShift's claude parser the 125 text is non-JSON, so R_OK=0 and the run goes down the generic error path.
FIX: (1) §12.1.1: "The first stderr line of every pre-launch failure MUST be exactly `accshift: error <error.code>: <catalogue message>`."
(2) §15.3: the wrap MUST add `--status-file <state>/sessions/task-NN[-suffix].acct-exec.json` (deleted before each run). After the run, LimitShift reads `launched` and `error.code`, falling back to the stderr line.
(3) Replace the Appendix E 125 action with a per-code table:
- slot-busy, agy-busy, state-busy: wait settings.slotWaitSeconds, retry, do not charge the error budget (at most 3 times);
- keystore-unavailable: per §15.2 (legacy only for implicit auto runners, else needs-human);
- needs-relogin: `next --from A --reason auth`;
- unknown-account: needs-human;
- bare-ignores-token, apikeyhelper-overrides-token, cmdline-too-long, slot-write-failed, keychain-prompt-required: needs-human, no retry.
(4) Rewrite §15.10 scenario 6 to cover these cases.

## 6. [major] §12.1.1 stderr rules (catalogue vs LimitShift regexes)
PROBLEM: The catalogue rule does not protect LimitShift's parsers. Messages interpolate runtime values; post-run warnings contradict the "pre-launch only" rule; and the CI test lives in the wrong repository.
EVIDENCE: LimitShift regex-matches merged stdout+stderr whenever a run fails (sh parse_cli_output limitshift.sh:2035-2040; ps1 $LimitPatterns :2235-2245; v2 $script:V2LimitPatterns Cli.ps1:9-14, Test-LimitSignal :37-47). The claude, gemini, agy and copilot patterns contain a bare `429`.
§12.2 "Not found → exit 127 with the PATH that was searched": Nix store paths (/nix/store/<32 base32 chars>-…) often contain "429", so a missing claude produces R_IS_LIMIT=1 and LimitShift rotates or waits as if capped. The §13.1 wait line embeds `pid N` (e.g. 14293) and the account name. Account names may legally be `quota` or `credits`.
Post-run lines: §8.3.3 step 9 prints an `accshift:` warning after agy exits, and §8.2 copy mode says "keep main and warn". This contradicts "accshift writes stderr only on a pre-launch failure ...". On the spawn path such a line lands after the child's JSON. Bash claude/gemini parsing does `sed -n '/^{/,$p' | jq empty` (limitshift.sh:2050-2052, :2093-2095), which then fails, so a successful run is marked R_OK=0. ps1 ConvertFrom-JsonTolerant breaks if the line contains `}`.
The CI test runs in the accshift repo and cannot see regexes LimitShift adds later. v1 has no auth regexes at all (R08 §a2), so "limit or auth regexes" names a set that does not exist.
FIX: (a) §12.1.1: "exec MUST NOT write to stderr after the child has started. Post-run findings (wrongAccount, copy-back conflicts) go only to --status-file, state.json and events.jsonl. Messages MUST NOT interpolate PATH, pids, labels, durations or digits; the account name appears only as `account=<name>`, and the 127 message names the binary only (the searched PATH goes to --debug)."
(b) Add to §15.3 a MUST for all three runners: "Before limit/auth regex matching and JSON extraction, drop every line matching `^accshift: ` from the captured text (sh: `grep -v '^accshift: '`; ps1: `-notmatch '^accshift: '`)."
(c) Move the catalogue test to LimitShift: accshift ships `accshift version --json` → `stderrCatalogue:[...]`, or a testdata file in each release, and LimitShift's suite asserts its own regexes never match it.

## 7. [major] §15.3 bash comment, §15.6 item 1, §15.10 scenario 8, §11.2 usageProbe
PROBLEM: The spec gives conflicting instructions about the Claude /usage probe.
EVIDENCE: §15.3: "lim=$(get_runner_reset_epoch ...)  # /usage cross-check now runs via: accshift exec claude --account \"$ACCT_CURRENT\" -- -p /usage". §15.10 scenario 8: "/usage runs as the same account". §15.6.1: "LimitShift SHOULD skip claude -p /usage".
DECISIONS D3: "The Claude /usage cross-check is skipped for token accounts". D8: "LimitShift should skip it for managed claude runners".
In v1, get_runner_reset_epoch (limitshift.sh:1551-1572) always calls get_claude_usage_reset_epoch (:1512-1525), which runs `claude -p "/usage"` directly whenever task_idx is given. The snippet therefore keeps the probe; for a token account it runs as the native login.
§11.2 says usageProbe is true for login-slot, while §15.6.1 says /usage "can spend a login-slot account's refresh token".
FIX: Decide "skip":
- §15.3: "for accshift-routed claude runners, call get_runner_reset_epoch / Get-RunnerResetTime without the task index, or with a new skipUsage flag, so /usage is never run."
- Delete the MUST bullet in §15.6.1.
- Replace §15.10 scenario 8 with "no /usage call for routed claude runners".
- In §11.2, make usageProbe true only for `native`.

## 8. [major] §15.8 Phase 3
PROBLEM: The classify call uses flags and an output field that the contract does not define.
EVIDENCE: §15.8: `accshift classify <cli> --exit-code N --session-id ID --input FILE --json`, and "use `outcome` / `resetAtEpoch`". §10.2 defines `classify <cli> [--exit N] [--session ID] [--cwd DIR] [--evidence-file F|-] [--model M] ...`, and §11.2 returns `class`, not `outcome`. An implementer following §15.8 gets exit 64 on every call.
FIX: Replace with `accshift classify <cli> --exit N --session ID --cwd DIR --evidence-file FILE --model M --json`, and "use `class`, `scope`, `resetAtEpoch`, `retrySameAccount`".

## 9. [major] §15.2 step 2 (`--evidence-file <run output>`, `--limited-until <reset LimitShift parsed>`)
PROBLEM: The evidence file is the cumulative per-task file, which contains prompts, earlier runs and handoff copies of the previous account's limit text. The `--limited-until` value can be LimitShift's guess rather than a parsed reset. Both corrupt the per-account records.
EVIDENCE: invoke_cli_task_run appends the prompt (limitshift.sh:2291) and the output (:2332) to outputs/task-NN-…-output.txt and deletes the file only in New mode (:2232-2233). Handoff prompts embed the previous runner's output tail (:3016, build_prompt_with_handoff).
After a switch A→B with New+handoff, the file starts with A's "resets 3pm". If B is limited, accshift's tier-2 text parse ("When both exist, take the later", §9.4) charges A's reset to B. Prompt text that mentions limits can also match.
get_conservative_reset_epoch (:1540-1549) returns now + limitWaitMinutes when nothing parsed. Passed as --limited-until, that guess becomes tier-2 "caller" evidence and bypasses the 30→300-minute unknown-reset backoff.
FIX: §15.2:
- "LimitShift writes each run's captured stdout+stderr, and only that, to outputs/task-NN[-suffix]-last-run.txt (truncated before every run) and passes that file as --evidence-file."
- "--limited-until is passed only when parse_reset_from_error / Get-ResetTimeFromErrorText (or a /usage value) produced a reset, never the limitWaitMinutes fallback."

## 10. [major] §15.2 step 5; §15.3 v2 auth branch
PROBLEM: The auth path double-counts strikes in v2 and cannot be implemented in v1.
EVIDENCE: §15.2 step 5: `accshift next <cli> --from A --reason auth`. §15.3 v2: "Auth branch (:578-582): `mark --auth-failed`, then `next`".
Per §10.2 both `mark --auth-failed` and `next --reason auth` record a strike. Per §9.2, "a second strike within 24 h → needs-relogin", so one ambiguous 401 becomes sticky needs-relogin. If `next` is instead called without --reason, it records a usage limit.
R08 §a2: "v1 has no auth (401/403) classification". §15.3 gives v1 and v2-root no auth hook, so step 5 has no detection to hang on.
FIX: v2: call only `next <cli> --from $acct --reason auth --evidence-file <stdout+stderr file> --json`.
- 0 → `$acct = account; continue` (retry).
- 75 → sleep per the limit logic.
- 69 or 77 → Set-V2AuthDeadCli.
v1/v2-root: add a hook. On a failed non-limit run of a routed runner, call `accshift classify <cli> --exit N --evidence-file <last-run file> --json`. On class auth or auth-definitive, call `next --from A --reason auth --evidence-file ...` and handle 0 and 75 as for a limit.
Add a §15.10 scenario.

## 11. [major] §15.3 (missing hook) vs §9.2 / §9.4 counters
PROBLEM: LimitShift never reports success, so strike and backoff counters only reset after 24 h without hits. A healthy account can become sticky needs-relogin.
EVIDENCE: §9.2: "Success is reported only by the caller (`mark --ok`), or by `exec` on the spawn path. On POSIX `exec` is execve ... `mark --ok` resets strike and backoff counters. Without it, counters reset after 24 h". §9.4 early re-hit and unknown-reset backoffs likewise reset only "on mark --ok, or after 24 h".
§15.3 and §15.10 never call `mark --ok`. Example: a transient 401 at 09:00 (auth-suspect), hours of successful runs, another transient 401 at 20:00. Result: needs-relogin, and the account is removed until a human runs `mark --clear`.
FIX: Add to §15.3: "After every run of an accshift-routed runner whose status is Done, NoMarker or Blocked (R_OK=1), call `accshift mark <cli> --account <A> --ok --json`, best-effort, ignoring the exit code. v2: after a successful Invoke-CliRoleOnce." Add a §15.10 scenario.

## 12. [major] §15.3 pick call; §9.3 pick
PROBLEM: The first run of every task passes an empty `--prefer`, and the spec does not define what accshift does with it.
EVIDENCE: Snippet: `acct_call pick "$cli" --prefer "$(cat sessions/task-NN[-runner-K]-account.txt 2>/dev/null)"`. On a first run the file is missing, so the call is `--prefer ""`, which Go's flag package sets to "".
§10.3 makes an unknown account a usage error (64), and §15.2 maps 64 to legacy. Every task's first run would then go unwrapped as the native login with no rotation. A stale name (renamed or removed account) has the same effect. R08's POC stub accepted `--prefer  ` silently; the real binary is not specified to.
FIX: §9.3: "pick/next MUST treat an empty --prefer as absent, and an unknown, disabled or unusable --prefer as 'not usable' (fall through to preference order). These are never exit 64." §15.3: "omit --prefer when the account file is missing or empty; strip a trailing \r".

## 13. [major] §15.3 v1 / v2-root limitshift.ps1 ("Keep -Cli agy ... so the CreateNoWindow branch still applies"); §12.4
PROBLEM: The instruction rests on a false premise. Invoke-CliTaskRun never passes -Cli to Invoke-NativeProcess, so the CreateNoWindow branch is dead code today, and §12.4's "child inherits that hidden console" never happens.
EVIDENCE: v1 limitshift.ps1:2462-2470 builds `$invokeParams = @{ Command; Arguments; WorkingDirectory; Spinner }` plus StdinText, with no `Cli`. v2-root does the same at :2856-2864. The only -Cli call site is the /usage probe (`-Cli 'claude'`, :2647).
The `if ($Cli -eq 'agy')` branch (v1 :1857-1882) is therefore unreachable for task runs, and agy runs through Start-Process -NoNewWindow. The code comment "agy now runs windowless" is wrong.
R08 C12 / §a1 assumed the branch was live. V-L1 would test a path that does not run.
FIX: Add P7 to §15.1: "limitshift.ps1 (v1 :2462, v2-root :2856): add `Cli = $Task.Cli` to $invokeParams, so agy launches use the CreateNoWindow branch." Reword §15.3: "pass -Cli with the real cli name (not 'accshift') so accshift.exe is started windowless for agy; accshift then spawns agy into that hidden console." Add an agy case to V-L1.

## 14. [major] §15.3 snippets (bash and ps1)
PROBLEM: The snippets use helpers and globals that the spec never defines: acct_call, acct_runner_enabled, persist, ACCT_NEXT, ACCT_RESET, ACCSHIFT_BIN, $script:AcctCurrent, $script:AccShiftBin, Test-AcctRunnerEnabled. Under `set -u` and StrictMode 2.0, an uninitialised reference crashes the runner even when accshift is absent. The snippets also omit the sessionPortable and scope handling that §15.2 requires.
EVIDENCE: limitshift.sh:7 `set -u`. limitshift.ps1:13 `Set-StrictMode -Version 2.0`, where reading an unset variable such as $script:AcctCurrent, or a missing property such as `$Task.Accounts` on Parse-Runner objects, throws.
R08 §c defined these globals near :22, plus acct_call ("ACCT_NEXT=.account; ACCT_RESET=.resetAtEpoch") and Invoke-AccShift; the spec dropped them while promising "behaviour is byte-identical to today".
The 0 branch never reads `sessionPortable`. §15.2 requires New plus handoff when it is false (codex A→B, every agy switch), and the 75 branch can also switch accounts. The classify call that decides "skip remaining models when scope=account" (§15.2 step 1) is absent.
FIX: Add a normative helper block to §15.3:
- sh: globals `ACCSHIFT_BIN="" ACCT_NEXT="" ACCT_RESET="" ACCT_PORTABLE="" ACCT_SCOPE=""` initialised unconditionally at the top; acct_call sets all four from the JSON and returns rc.
- ps1: `$script:AccShiftBin = $null; $script:AcctCurrent = @{}` at script start; Parse-Runner always adds an `Accounts` property ($null when absent); Invoke-AccShift as in R08 §c.
- Both branches: if `sessionPortable` is false, delete the session file and set the handoff reason so the next run is New with HANDOFF_NOTE_BASE.
- Before rotating models, run `classify ... --model M`; if scope is account, skip to `next`.

## 15. [major] §15.3 "before each run (single :2672 / fallbacks :3068) ... rc 75 -> rest first"
PROBLEM: In fallbacks mode, `pick` returning 75 makes LimitShift sleep, even when another runner (another CLI) is free. That contradicts the fallbacks rule in §15.2 step 3.
EVIDENCE: §15.2 step 3, fallbacks: "limitedUntil[R] := resetAtEpoch, then select_next_runner". The pick hook at :3068 says "rc 75 -> rest first (as below)", and "below" is the single-runner rest (ui_rest_with_summary). A task whose claude pool is fully capped by an earlier task sleeps for hours instead of running its codex fallback.
FIX: Split the rule:
- Single runner: pick rc 75 → rest until resetAtEpoch + resetBufferMinutes, then run on `account`.
- Fallbacks: pick rc 75 → `limitedUntil[R]=$ACCT_RESET` (ps1: `[DateTimeOffset]::FromUnixTimeSeconds(...).LocalDateTime`), leave ACCT_CURRENT empty, `continue` to select_next_runner without launching.

## 16. [major] §15.3 v2 engine (v2/lib/Cli.ps1, Preflight.ps1)
PROBLEM: The v2 changes are incomplete. The preflight relaxation cannot be implemented, `$acct` has no defined source, and the 75 branch never updates `$acct`.
EVIDENCE: Preflight.ps1:71-81 compares consecutive role-chain steps, which are `{Cli, Model}` only. Get-CliInvocation (Cli.ps1:271-323) and v2.ps1 parameters carry no account, and accounts are chosen at run time by pick/next. "The same bucket on different accounts" therefore cannot be evaluated at preflight.
The spec uses `$acct` in Resolve-CliLaunch but never says where it comes from (no pick step for v2). The 75 branch sets only `$resetTime`; R08 also set `$acct = account`.
The auth branch today returns from Invoke-CliRoleOnce (:578-588). A next result of 0 needs a `continue`.
FIX: (1) "In Invoke-CliRoleOnce, before the while loop: `$acct = (pick <cli> --model <model> --json).account` when routed (v2 has no session to keep, so pick each call)."
(2) "75 → `$acct = $nx.Json.account`; `$resetTime = FromUnix(resetAtEpoch).LocalDateTime.AddMinutes(5)`; then the existing >24 h, deadline and sleep logic."
(3) "Auth: next 0 → `continue` the loop."
(4) Preflight rule 3: "downgrade to WARNING only when accshift is active for that CLI and `list <cli> --json` reports rotationPossible:true; otherwise it remains an error."

## 17. [major] Appendix D.4; §11.2 (mark, status, enable/disable/order, doctor, 69/77 bodies)
PROBLEM: The contract schemas cannot be written from the spec. Several responses are shown only as "…" or prose, and two statements contradict each other.
EVIDENCE: D.4 says only "as §11.2".
§11.2 `mark --json` → `{...,"state":"limited","limitedUntilEpoch":1791472800,…}`, while the same section says "In next and mark it [recorded] echoes what accshift stored"; the mark example has no `recorded`.
`status` is "like list plus vault, slot and expiry details", with no field names.
enable, disable and order are contract commands with no response shape.
Nothing says whether 69 and 77 carry the success-shaped object (account:null, accounts[]) or `error`.
The `doctor` exit code for ok:false is unspecified, yet §15.7.6 runs doctor before every run.
§18.2 requires validating "every §11 response shape against the JSON schemas in Appendix D".
FIX: Add normative field lists to D.4 for version, list, status, pick/next, mark, enable/disable/order, classify, doctor, the error object and the status-file. Make `mark` return the pick/next shape with `recorded` and account:null. State that 69 and 77 return the pick/next object with available:false and account:null plus an `error` member. State that doctor exits 0 whenever it ran, with severity carried in findings.

## 18. [minor] §5.2, §6.3, §11.2 examples
PROBLEM: The epoch and RFC 3339 pairs in the examples disagree with each other. Contract or golden tests built from them will fail.
EVIDENCE: - list: `"lastUsedAt":"2026-10-07T09:00:00Z","lastUsedAtEpoch":1791450000`; the epoch is 2026-10-08T09:00Z.
- list: `"limitedUntil":"2026-10-07T15:00:00Z","limitedUntilEpoch":1791472800`; the epoch is 2026-10-08T15:20Z.
- list: `"expiresAt":"2027-10-07T10:05:00Z","expiresAtEpoch":1823000700`; the epoch is 2027-10-08T13:05Z.
- classify: `"resetAt":"2026-10-07T15:45:00Z","resetAtEpoch":1791474300`; the epoch is 2026-10-08T15:45Z.
- next: `"until":"2026-10-07T15:00:30Z","untilEpoch":1791472830`; the epoch is 2026-10-08T15:20:30Z.
- §5.2 and §6.3: "resets 3pm (Europe/Kyiv)" → 1791500400, which is 2026-10-09 02:00 Kyiv.
FIX: Use matching values: 2026-10-07T09:00:00Z=1791363600; 15:00:00Z=1791385200; 15:00:30Z=1791385230; 15:45:00Z=1791387900; 2027-10-07T10:05:00Z=1822903500. 3pm Europe/Kyiv on 2026-10-07 = 12:00Z = 1791374400.

## 19. [minor] §11.2 pick/next field rules; §9.3; §9.6
PROBLEM: Several small field-semantics contradictions in the pick/next contract.
EVIDENCE: - "previous is null for pick" plus "switched is true when account != previous" makes pick always report switched:true.
- `accounts[]` carries `limitedUntilEpoch` without `limitedUntil`, against §11.1 rule 4 ("Every timestamp is given twice").
- `recorded.untilEpoch`/`accounts[].limitedUntilEpoch` 1791472830 includes the 30 s skew, while list and mark show 1791472800 for the same record. Whether the skew lives in the stored record or only in resetAtEpoch is unclear.
- §9.6 "never returns --from from next" contradicts §9.3 "exit 75 ... including A" with account = the soonest, which can be A.
FIX: - "switched is false for pick".
- Add `limitedUntil` to accounts[].
- "The 30 s skew is applied only to resetAtEpoch; stored `until` and limitedUntilEpoch exclude it."
- §9.6: "never returns --from with exit 0".

## 20. [minor] §11.1 rule 8; §6.3 readers and writers
PROBLEM: The read-only and writer lists are incomplete. LimitShift's dry-run and validate-only need the full picture.
EVIDENCE: Rule 8 lists list, status, pick and version as read-only, and next, mark, enable, disable and order as writers. It omits:
- classify --record (a writer per §6.3);
- exec (spawn-path bookkeeping, agy swap, overlay link refresh under state.lock);
- doctor (read-only except --fix, which edits config.toml);
- classify without --record (read-only).
LimitShift calls doctor and classify.
FIX: Rule 8: "Read-only (no lock, no state or vendor writes): version, list, status, pick, doctor without --fix, classify without --record. Writers: next, mark, enable, disable, order, classify --record, doctor --fix, exec."

## 21. [minor] §3 Glossary (session portability); §8 Portability(); §8.2; §11.2
PROBLEM: The portability value `possible` exists, but its sessionPortable mapping is undefined.
EVIDENCE: The glossary lists four values ("yes, likely, unlikely or no") and says sessionPortable is "true for yes and likely". The adapter interface and §8.2 also use `possible` ("the same workspace account → possible"). The LimitShift 0-branch (resume vs New plus handoff) is undefined for codex in that case.
FIX: Add `possible` to the glossary and state "sessionPortable is false for possible, unlikely and no".

## 22. [minor] §11.2 classify `class` enum vs §8.5 / Appendix C
PROBLEM: The same outcome has two names.
EVIDENCE: §11.2 class enum: `blocked`. §8.5's table and Appendix C.1, C.2 and C.5 use `blocked-account`.
FIX: Use `blocked` everywhere, or list `blocked-account` in the enum; Appendix C becomes "blocked (needs-attention)".

## 23. [minor] §15.4 Queue schema additions
PROBLEM: The schema paths do not match the real files.
EVIDENCE: v1's limitshift-queue.schema.json has only settings, tasks.items and tasks.items.fallbacks.items. v2-root additionally has tasks.items.properties.verify and mission.properties.roles.{planner,executor,verifier}, each with additionalProperties:false. The fragment "tasks[] / fallbacks[] / verify / mission.roles.*" does not say which schema gets which, or that settings needs `properties.settings.properties.accountRotation`.
FIX: List the JSON paths:
- v1 and v2-root: properties.settings.properties.accountRotation; properties.tasks.items.properties.accounts; ….fallbacks.items.properties.accounts.
- v2-root only: properties.tasks.items.properties.verify.properties.accounts; properties.mission.properties.roles.properties.{planner,executor,verifier}.properties.accounts.

## 24. [minor] §15.9 Install and offer vs §17.6
PROBLEM: LimitShift's helper would add `<limitshift>/bin` to the user's PATH.
EVIDENCE: §17.6: the installer adds its install dir to the user PATH (Windows registry) unless ACCSHIFT_NO_MODIFY_PATH=1. §15.9 runs it with ACCSHIFT_INSTALL_DIR=<limitshift>/bin and does not set the opt-out. It also writes <root>/install.json with method "script", which then points self-update at LimitShift's private copy.
FIX: §15.9: "run the installer with ACCSHIFT_INSTALL_DIR=<limitshift>/bin, ACCSHIFT_NO_MODIFY_PATH=1 and ACCSHIFT_VERSION=<pin>, and ACCSHIFT_NO_INSTALL_RECEIPT=1 (new knob) so install.json is not written for LimitShift-bundled copies."

## 25. [minor] §11.1 rule 1 / §11.3 PowerShell recipe
PROBLEM: Windows PowerShell 5.1 decodes native stdout with [Console]::OutputEncoding, which defaults to the OEM code page. UTF-8 JSON with non-ASCII arrives garbled.
EVIDENCE: §11.3 `$raw = & $AccShift ... --json`. Labels, `snippet` (Claude's "’" and "·") and error messages are UTF-8, while 5.1 reads them as CP437/CP1251. Go's encoding/json does not escape non-ASCII by default.
FIX: Rule 1: "--json output MUST be pure ASCII: escape every non-ASCII code point as \uXXXX (surrogate pairs above U+FFFF)".

## 26. [minor] §15.5 Capability cache / agy models
PROBLEM: Routing model discovery through `exec agy --account X` turns --validate-only into slot swaps. Which account validates a pool is also unspecified.
EVIDENCE: v1 discover_cli_models (limitshift.sh:1127-1131) runs `agy models` during --validate-only. Through §8.3.3 each non-live account means a journal, a keychain write and save-back, and fails with agy-busy (125) if the user has agy open. probe_cli_model sends real prompts. §15.5 does not say which account X, nor how per-account caches combine for a pool.
FIX: "Discovery runs only for the live slot owner (`pick agy` with no --prefer) and is cached as capabilities/agy@<owner>.json. A pool's model is validated against the union of cached accounts; uncached accounts are a WARNING. --validate-only never swaps. --probe-models may probe each pool account and prints that it swaps the agy slot."

## 27. [minor] §10.2 exec row
PROBLEM: Several exec flags used elsewhere in the spec are missing from the command table.
EVIDENCE: §12.3 uses `--track` (forces the spawn path), §12.1.1 `--verbose`, and §8.1 `--allow-bare` and `--allow-apikeyhelper`. None appear in the §10.2 exec signature or §10.1 global flags, so a strict flag parser built from §10.2 rejects them with a usage error.
FIX: exec row: `exec <cli> [--account A | --prefer A] [--pool a,b] [--slot-wait S] [--status-file P] [--track] [--verbose] [--allow-bare] [--allow-apikeyhelper] -- <args…>`.

## 28. [minor] §15.3 ps1 ("Limit branches mirror the bash ones")
PROBLEM: Mirroring the bash snippet would put epoch integers or DateTimeOffset values into structures that expect [datetime].
EVIDENCE: In the ps1 runners, $limitedUntil[] holds the DateTime that Get-RunnerResetTime returns (:3622). Select-NextRunner (:2715) takes [datetime]$Now, and Wait-ForRunnerReset (:2751) and Invoke-UiRestWithSummary (:517) take [datetime]. The §11.3 recipe yields a DateTimeOffset (`FromUnixTimeSeconds(...)`), and bash stores epochs.
FIX: State for ps1: "`$limitedUntil[$R] = [DateTimeOffset]::FromUnixTimeSeconds([long]$j.resetAtEpoch).LocalDateTime`; WakeTime likewise uses `.LocalDateTime.AddMinutes($Settings.ResetBufferMinutes)`".

## 29. [minor] §11.2 version `supportedClis` / `experimental`; §8.3.5; §15.4 auto
PROBLEM: The relationship between `supportedClis` and `experimental` is undefined, so it is unclear whether LimitShift routes agy where agy is marked experimental.
EVIDENCE: The example shows `experimental` disjoint from `supportedClis`. §8.3.5 says agy rotation "ships marked experimental per OS until that OS's V-A items pass". §15.4 auto routes only when "the CLI is in supportedClis". It is unclear whether agy on an unverified OS is listed, and whether explicit `accounts` overrides the gate.
FIX: "supportedClis lists every cli exec can run on this OS. experimental ⊆ supportedClis marks clis whose rotation is unverified on this OS. LimitShift auto mode routes an experimental cli only when the runner lists `accounts` explicitly, and validate-only prints a WARNING."

# LENS: state-concurrency
The state machine is underspecified at its seams, and several literal readings lead to wrong-account runs or credential loss. I found four blockers.

1. Every pick result other than 0/75 makes LimitShift launch the CLI unwrapped. That is the native login, or for agy whatever is in the slot, with no slot lock. It happens even when the queue pinned an explicit pool.
2. The agy shared/exclusive mode is chosen from `state.agySlot.owner`, which can be stale. There is no re-check, no upgrade rule and no fast-path branch in the numbered steps. A manual re-login by the user therefore leads to a wrong-account run, or to slot writes under a shared lock.
3. A failed or unattributable save-back is not defined as fatal before the slot is overwritten. That can destroy the user's unregistered agy login.
4. `pick --prefer P` returns P even when P is not in the pool. LimitShift's persisted account files outlive pool edits, so an account the user removed from the pool gets billed.

Major issues:
- `state.json` (D.2) cannot represent sticky needs-relogin or auth-suspect records. The 24 h counter reset would un-stick needs-relogin.
- Pruning expired records destroys the backoff memory that the doubling and early re-hit rules need.
- §9.3 contradicts itself on 69 vs 75 for a single-account pool.
- "Usable" is defined through the account-level state, which defeats model scoping.
- The merge rule lets a same-tier bogus caller value shorten a limit, and tier "user" has no order.
- Nothing in the integration ever reports success (`mark --ok`), so strikes only age out.
- Auth strikes are double-counted: v2 calls mark-then-next, parallel queues report the same failure, and provider-wide 401 outages strike every account.
- The §15.3 hooks drop `--model` and `--evidence-file`.
- exec's `needs-relogin` 125 is ambiguous with `--account`.
- §8.5 and §9.4 disagree on Copilot `session_quota_exceeded`; §8.4 and §9.2 disagree on Gemini `ValidationRequiredError`.
- Re-login never checks identity.
- `rename` moves Codex overlays, which orphans keyring credentials and breaks running refreshes.
- Lock-free readers quarantine files they cannot parse.
- A Codex refresh race on the native account marks it needs-relogin.

On the agy side:
- Journal recovery runs before the foreign-process check and may restore the slot over a running agy.
- The foreign-process check blocks even no-swap runs, and it cannot identify other shared holders.
- `slot-busy` is charged to LimitShift's retry budget. With the default `maxRetriesOnError=2`, a parallel agy queue fails tasks after about 90 s.
- §8.3.3 and §9.3 disagree on live-owner preference, which causes swap ping-pong.
- `add agy` and `login agy` take no lock and no journal.
- A locked keyring is treated as file mode even though agy itself may unlock it and read it.

Minor issues: post-run empty-slot and `wrongAccount` semantics; Windows `FILE_SHARE_DELETE` for lock-free readers; evidence parsing inside `state.lock`; clock-skewed records never re-clamped; every epoch/RFC 3339 example pair in §6.3 and §11.2 disagrees, and it is unclear whether the 30 s skew margin is stored.

## 1. [blocker] §15.2 Rotation order step 3, §15.3 Hook points (bash pick line and build_cli_args wrap), §7.5 'What LimitShift does about it'
PROBLEM: Any pick/next/exec outcome other than 0/75 makes LimitShift run the CLI unwrapped as 'the CLI's own login'. This happens even when the runner pinned an explicit pool that excludes that login. For agy, 'own login' is whatever account accshift last swapped in, and the unwrapped run takes no agy-slot.lock.
EVIDENCE: §15.3: 'before each run ... when ACCT_CURRENT is empty: acct_call pick ... rc 0|75 -> ACCT_CURRENT=...'. The wrap only happens 'if [ -n "$ACCT_CURRENT" ]'. So pick exit 77 (every pool account needs-relogin), 69 (pool disabled) or 78 (corrupt accounts.json) leaves ACCT_CURRENT empty and the task runs unwrapped.

§15.2 step 3: '69, 73, 74, 77, 78 or any other code → legacy behaviour'. Also: 'exec exit 125 with keystore-unavailable ... switches that runner to legacy mode for the rest of the run: the CLI's own login'.

§15.4: 'one name = pin the runner to that account'. The same section says the gating 'prevents a queue silently running as an account other than the CLI's own login'. It does not cover the reverse case: running on the native login when the user deliberately excluded it.

Scenario: `accounts:["work","home"]` (claude token accounts). Both go needs-relogin, so pick returns 77 and the next task bills the user's personal `~/.claude` subscription silently.

agy scenario: a single transient 10 s `security` timeout gives 125 keystore-unavailable, and the runner runs bare `agy` for the rest of a multi-day queue. That agy runs as an arbitrary slot account. It can start in the middle of another queue's swap (§8.3.3 steps 5–7), because it holds no lock. Other queues then see it as a foreign process and get agy-busy.
FIX: Add to §15.2 step 3 and §15.3:

'Legacy (unwrapped) launch is allowed only when the runner's `accounts` key is omitted and the cli has no accshift accounts, or its resolved pool contains the `native` account. Otherwise any pick/next result other than 0/75, and any exec 125 other than slot-busy/agy-busy, MUST NOT launch the CLI unwrapped. Single runner: mark the task needs-human with the accshift `error.code` and continue with the next task. Fallbacks: set the runner aside for this task.'

For agy also add: 'LimitShift MUST NOT launch agy without accshift while accshift has at least one agy account registered.'

Replace the D7 'legacy mode for the rest of the run' with: 'retry accshift on the next run; switch a runner to legacy only under the rule above'.

Add a §15.10 test: a pinned pool with all accounts needs-relogin must never invoke the CLI stub without `FAKE_ACCOUNT`.

## 2. [blocker] §8.3.3 'Lock modes', §5.2 'agy run', §13.1 (agy-slot.lock modes), §6.3 agySlot
PROBLEM: The shared/exclusive decision uses the 'live slot owner', and §6.3 defines that as the state.json bookkeeping value, which can be stale. The numbered swap steps never say which mode they run under or where the fast-path branch sits. There is no rule for re-checking after the lock is acquired or for upgrading the lock. Following the text gives either a wrong-account run (the swap is skipped under a shared lock) or slot writes by several shared holders at once.
EVIDENCE: §8.3.3: 'A run whose account already equals the live slot owner takes the lock shared'.

§5.2: 'If b is already the live account, nothing is written and the lock is shared'.

§6.3: 'agySlot records which registered account accshift last put into agy's slot'.

The fast path ('if every slot in the write set already holds the requested account (by email), nothing is written', §8.3.2) is not one of steps 1–9, and step 1 only says 'Take agy-slot.lock'.

Scenario (brief: live owner changed manually):
1. state.agySlot.owner=a. The user runs agy interactively, does /logout and /login as c, then exits.
2. Queue Q1 runs `exec agy --account a`. a equals the recorded owner, so Q1 takes the lock shared and skips writing (§5.2).
3. agy runs as c, while LimitShift charges and limit-records a.

Alternatively, Q1 and Q2 both hold shared locks and both run steps 3–7 (save-back, journal, write) concurrently. They overwrite each other's journal, and Q1's step 9 'clear the journal' deletes Q2's in-flight journal.

There is a further trap. flock(2): 'Converting a lock (shared to exclusive, or vice versa) is not guaranteed to be atomic ... a pending lock request by another process may be granted'. An implementer who downgrades after the swap, to allow 'several queues ... at once', lets a waiting swapper rewrite the slot under a running agy. LockFileEx has no conversion at all.
FIX: Replace 'Lock modes' with an explicit algorithm:

1. Acquire agy-slot.lock SHARED, waiting while a live intent marker exists.
2. If journal/agy-swap.json exists, release and go to step 5.
3. Read every reachable slot without writing. If every slot in the write set holds the requested email, run on this shared lock: spawn, post-run save-back, release. `state.agySlot` MUST NOT influence this decision; it is display-only.
4. Otherwise release the shared lock.
5. Create the intent marker and acquire EXCLUSIVE. Remove the marker when the lock is acquired or on timeout.
6. Run recovery, the foreign-process check, a re-read of the slots, then save-back/journal/write/verify only if the swap is still needed.
7. Hold EXCLUSIVE until the child has exited and post-run save-back is done.

Also state: 'Steps 3–7 MUST only run under the exclusive lock. A held lock is never converted in place.' Update §5.2 and §13.1 to match.

## 3. [blocker] §8.3.3 step 3 (Save-back) and step 4/5 ordering; §13.3 item 1
PROBLEM: There is no rule that a failed save-back aborts the swap, and no rule for slot content whose owner cannot be identified. agy has no `native` kind, so on the first swap the user's own agy login is often unregistered. Step 3 is the only place it is preserved. If the vault write fails, or no email can be derived, the following write destroys that credential.
EVIDENCE: Step 3 says to 'Store the raw bytes under that registered account ... Content for an unregistered email is kept as agy/_unregistered/<email>'. Step 4 'Journal' and step 5 'Write' follow, with no failure branch.

§13.3 only asserts afterwards: 'The outgoing slot content has already been saved to the vault'.

Ways the vault write in step 3 can fail:
- keystore-unavailable: macOS exit 36 after a screen lock, or a Secret Service re-lock (V-K2);
- vault.lock timeout (15 s, exit 73);
- a full disk.

Owner identification falls back only to 'the id_token email claim'. StoredToken also carries `auth_method`/`wif_provider` (R05 §a), and ADC or WIF logins may have neither.

R05 C8: agy 'rewrites the stored token on every refresh'. V-A8 leaves refresh-token rotation open, so overwriting the latest slot bytes can also lose a registered account's only valid refresh token.
FIX: Add to step 3:

'Save-back is a commit point. For every non-empty slot read, the vault update (temp, fsync, rename, under vault.lock) MUST succeed before step 4 begins. On any failure, abort without touching any slot: exec exits 125 `keystore-unavailable` or `slot-write-failed`; control verbs exit 74 or 73.

If the owner cannot be identified (no `email` field and no decodable id_token email), store the bytes as `agy/_unknown/<sha256-8>` and warn. Content is never discarded or overwritten unsaved.'

Add a contract test with a fake keystore that fails on the vault write. Assert the slot bytes are unchanged and exec exits 125.

## 4. [blocker] §9.3 pick step 1 and candidates definition; §15.3 pick call; §15.4/§15.5 account files
PROBLEM: `--prefer P` is returned whenever P is 'usable', and the text never requires P to be in the candidate set (the pool). LimitShift persists P across runs and across pool edits. The spec also leaves undefined what an empty, unknown or removed `--prefer`, `--pool` or `--from` does. On top of that, LimitShift caches ACCT_CURRENT, so an account that another queue limited, or that the user disabled or removed, keeps being launched.
EVIDENCE: §9.3: 'Candidates are the accounts in --pool order ... 1. If P is usable, return P.'

§15.4: 'accounts ... MUST stay out of the task fingerprint, so changing a pool does not re-run finished tasks'.

§15.5: account files are deleted only 'when the fingerprint is invalidated'.

Scenario: a task paused on `work`. The user edits the queue to `accounts:["home"]` to stop billing their employer. On resume, `pick --prefer work --pool home` returns work under the literal rule, so the employer account is billed.

§15.3 passes `--prefer "$(cat ...account.txt 2>/dev/null)"`. That is an empty string on a task's first run, and §10.3 makes an unknown account exit 64. If '' is treated as unknown, every first run returns 64 and runs unwrapped (see the legacy-fallback blocker).

The hook only picks 'when ACCT_CURRENT is empty'. It then runs `exec --account A` even after a parallel queue's `next --from A` recorded A as limited, which wastes a run. After `remove`, the result is 125 unknown-account, which Appendix E says to 'never rotate on'.
FIX: Add to §9.3:

'P is honoured only if it is a member of the candidate set (after --pool filtering) and usable. An empty, unknown, disabled or non-member P is treated as absent, with a stderr note for unknown names. Unknown names in --pool are dropped with a stderr note; if none remain, exit 69 with `error.code` `empty-pool`. `next --from A` with an unknown A records nothing (`recorded:null`) and still selects.'

In §15.3, replace 'when ACCT_CURRENT is empty' with: 'before every run call `pick <cli> --prefer "$ACCT_CURRENT" --model <model of this run> [--pool]`' (lock-free, under 50 ms). Persist the result if it differs.

## 5. [major] §13.3 agy swap journal (Recovery) and §8.3.3 step 1 ordering
PROBLEM: Recovery has several gaps:
- It runs before the foreign-process check.
- It writes to the slot when a read merely failed.
- It restores the global `agy/_last`, whose content depends on timing.
- It reads only 'the slot' even though a swap writes several stores.
- It relies on PID liveness rather than lock ownership.
- It treats an empty slot (agy deliberately clears rejected credentials) as something to undo.
EVIDENCE: §8.3.3 step 1: 'Take agy-slot.lock, then recover from any stale journal'. Step 2 (foreign check) comes after it.

§12.3: on macOS there is no Pdeathsig, and 'recovery after a SIGKILL of accshift goes through the journal'. The lock fd is CLOEXEC, so after accshift is SIGKILLed the lock is free while the orphaned agy keeps running and refreshing.

§13.3: 'If the slot is empty or unreadable, it restores agy/_last'. A locked keychain or a 10 s timeout counts as 'unreadable', and a write then happens under a running agy.

`_last` holds different content at different times: the outgoing account after step 3, and the incoming account after the step-9 save-back. Shared holders overwrite it too.

R05 §d: agy 'clears the entry on definitive server rejection (revoked account)', so an empty slot is a legitimate outcome.

Step 5 writes multiple stores. A crash between the keyring and file writes leaves them disagreeing, and recovery 'reads the slot' (singular).

'its pid is not alive' fails under PID reuse. Holding the exclusive lock already proves the writer is gone.

R07 §8 recommended 're-apply or roll back'; the spec does neither.
FIX: Rewrite §13.3 Recovery:

'Runs only under the EXCLUSIVE lock and only after the foreign-process check passes. If a foreign agy runs, keep the journal and exit 125 agy-busy (control verbs 73). Ignore journal pid liveness.

Read every store in journal.stores plus every reachable slot. On any read error other than not-found, write nothing, keep the journal and exit 125 keystore-unavailable (control verbs 74).

Save each readable credential to its owner as in step 3.

If the stores disagree, roll back by writing the vault snapshot of journal.from to every store, then verify.

If all stores are not-found and the phase was `written`, leave the slot empty, record needs-relogin(reason `rejected`) for journal.to and delete the journal.

Never auto-restore `agy/_last`. The journal names a per-swap backup id `agy/_swap/<startedAt>` written in step 3, which no other operation overwrites.'

## 6. [major] §8.3.3 step 2 (Foreign-process check) and §13.1 lock-file contents
PROBLEM: The check blocks runs that never write the slot. It also cannot tell other accshift holders' children apart from foreign processes, and it gives no rule for detached agy daemons.
EVIDENCE: Step 2 applies to every `exec agy`: 'If any agy, antigravity or agy.exe process not started by an accshift holding the lock is running ... refuse'. Its justification is 'swapping under a running agy would mix accounts', but a shared fast-path run swaps nothing. Today LimitShift runs agy next to the user's interactive agy. With this rule, every agy task fails with 125 agy-busy while the user has agy open, even when no swap is needed.

Identification: §13.1 says 'The holder writes {"pid","account","since"} into the lock file'. With several shared holders there is one file and the last writer wins, so Q2 cannot recognise Q1's agy child and refuses with agy-busy. That contradicts 'several queues can run agy on the same account at once'.

The spec lists 'the remote-control daemon and language server' as processes to check. R07 §1 notes `remotecontrol.(*Daemon).SeedToken`, i.e. the daemon has its own token file. If an accshift-launched agy spawns a daemon that outlives it and is reparented to init/launchd, every later exec is refused permanently.
FIX: Rewrite step 2:

'The foreign-process check gates only the exclusive path (swap and recovery). On the shared fast path a foreign agy produces one stderr warning, not a refusal.

Each holder registers `locks/agy-holders/<pid>.json` = {pid, childPid, account, mode, since}. It deletes the file on exit; entries with a dead pid are ignored.

A vendor process counts as accshift-started if it is a registered childPid or a descendant of one (ppid chain: /proc on Linux, `ps -o pid,ppid` on macOS, Toolhelp32 or job membership on Windows).

A vendor process with no live ancestor that is a daemon (remote-control, language server) is reported as `agy-daemon-running`, with a doctor hint to stop it.'

Add V-A10: does `agy -p` leave a daemon or language server running after it exits?

## 7. [major] §8.3.3 'Lock modes' + §9.3 pick step 3 + §13.1 + §15.2 step 3 / Appendix E (125 handling) + §15.7 item 7
PROBLEM: Parallel agy queues do not degrade to 'runs serialize' as the spec claims; they fail tasks. Waits on the slot surface as exec 125 `slot-busy`/`agy-busy`, which LimitShift charges to its error-retry budget. The live-owner preference contradicts itself between sections, so two queues ping-pong swaps. A single intent file cannot represent several waiting swappers.
EVIDENCE: §13.1: the slot lock waits `--slot-wait` (default 30 s), 'then exec exits 125 (slot-busy)'.

Appendix E 125: 'treat as CLI error charged to the retry budget, never as a limit'.

LimitShift v2-root `limitshift.sh`: `MAX_RETRIES_ON_ERROR=$(jq -r '.settings.maxRetriesOnError // 2'` (:1029). The error branch retries immediately and then reports 'gave up after $MAX_RETRIES_ON_ERROR retries' (:3654-3672). So a 20-minute agy run in queue Q1 makes queue Q2's task fail after about 3×30 s.

§15.7 item 7 calls this only a 'WARNING (single slot; runs serialize)'.

The sections contradict each other:
- §8.3.3: '`pick agy` prefers the live slot owner when it is ready'.
- §9.3 step 3: only 'when no --prefer is given'.
- §15.3 always passes --prefer from the task's account file.
So Q1 (sticky on a) and Q2 (sticky on b) need a swap on every run.

Writer preference makes things worse: Q2's intent makes Q3's shared requests for the live account wait, and they also time out with 125, even though Q2 will time out itself.

§13.1 specifies a single `agy-slot.intent` file. A second swapper overwrites it, and the first one removes it, which cancels the second swapper's preference.
FIX: Make three changes.

(a) §9.3 step 3: 'For agy, pick returns the live slot owner (read from the slots as in the lock algorithm, falling back to state.agySlot) whenever it is a usable candidate, even if --prefer names another account.' agy's sessionPortable is false, so stickiness buys nothing.

(b) §15.2 step 3 and Appendix E: '125 slot-busy and agy-busy are transient. LimitShift MUST NOT count them against maxRetriesOnError or maxRunsPerTask. It re-runs pick and retries after a delay, up to settings.agySlotWaitMinutes (default 30), then treats the runner as Wait/limited for that period.'

(c) §13.1: 'One intent file per waiter (`locks/agy-slot.intent.d/<pid>`), removed on acquire or timeout. Shared requests defer to a live intent for at most min(--slot-wait, 10 s).'

Change §15.7 item 7 to state that tasks wait.

## 8. [major] §8.3.4 Add and login (agy); §13.1 (which verbs take agy-slot.lock); §8.3.2 fast path
PROBLEM: `add agy` changes and restores the live slot with no lock and no journal, and keeps the pre-login snapshot in an unspecified 'temporary vault area'. As written, `login agy` cannot succeed for a re-login. After a re-login of the live account, the stale credential stays in the slot, and the email-only fast path never installs the fresh one.
EVIDENCE: §13.1 says only that 'Control verbs that need the slot (login agy, remove) exit 73'. `add` is not listed, and §8.3.3 says the swap runs 'inside exec agy and login agy'. A queue swap during the user's interactive sign-in corrupts the step-4 diff, or the user's login overwrites the queue's swapped-in account.

Step 2: 'Snapshot every candidate slot ... into a temporary vault area'. If the terminal is closed or accshift is killed after the user signs in but before step 6, the previous live login is overwritten and its only copy is in a temporary area that no recovery reads. If that login was unregistered (agy has no native kind), it is lost.

Step 4: 'Exactly one changed slot must hold a credential whose email is new'. For `login agy a` the email is a's own, not new, so `no-login-detected` follows. An implementer who relaxes the rule then accepts a login to any account.

Step 6 'Restore the previous slot content' puts a's old credential back when a was live. §8.3.2's fast path ('already holds the requested account (by email)') then keeps running the stale copy.
FIX: Rewrite §8.3.4:

'`add agy` and `login agy` take the EXCLUSIVE slot lock and write a journal (kind `capture`). Step 2 uses the step-3 save-back (owner, `_unregistered/<email>`, `_unknown/<fp>`, `_swap/<id>`), never a temporary area.

`add` requires the changed slot to hold an email that is not registered.

`login <name>` requires the changed slot's email to equal identity.email. Otherwise restore and exit 65 `identity-mismatch`.

For `login`, if the pre-login owner is the same account, keep the new credential live and skip the restore.'

Add to §8.3.2's fast path: '... and the slot copy's `expiry` is not earlier than the vault snapshot's; otherwise take the exclusive path and install the vault copy.' Add `add` to the §13.1 verb list.

## 9. [major] §8.3.2 'Which slot agy will read' and 'Write set'
PROBLEM: A keyring that accshift finds locked or unreachable within its 3 s probe is classed as file mode. agy itself (go-keyring) calls Unlock, so on a desktop it can prompt and then read that keyring. The keyring item is outside the write set and cannot be deleted, so the 'fail closed' guarantee does not hold, and agy can start as a stale account.
EVIDENCE: §8.3.2: 'Mode is also file if the keyring is unreachable or locked within a 3 s probe'.

The write set is 'the resolved slot plus every other reachable slot that currently holds an agy credential'. A locked keyring is not 'reachable', so its old credential is neither written nor deleted.

The fail-closed clause covers only a slot that 'cannot accept the incoming blob (Windows keyring over 2560 B)'.

R05 §a Linux: go-keyring uses `GetLoginCollection`/`Unlock`/`CreateItem`. R07 C5: the go-keyring prompt handler blocks. agy only bypasses the keyring on environment detectors or after a recorded timeout. So with no environment detector firing (desktop, DBUS set, not SSH), agy will attempt the keyring.

Scenario: Ubuntu autologin leaves the login keyring locked. accshift predicts file mode and writes b to the file. The user, present, answers agy's unlock prompt, and agy reads the keyring item holding a. That is a wrong-account run, detected only afterwards by the step-9 email check.
FIX: Replace the second paragraph with:

'A keyring that is locked, unreachable or timing out is NOT evidence of file mode. File mode is concluded only from agy's environment-based detectors, or from a timeout marker younger than 1 h. When no environment detector fires and the keyring cannot be read, the swap is refused: exec 125 `keystore-unavailable` with the unlock hint (control verbs 74).'

Add a doctor finding for this state, and a contract test with a fake keystore that reports Locked while the environment has DBUS set.

## 10. [major] §9.2 Account states / Auth transitions; §6.3 state.json; Appendix D.2
PROBLEM: The persisted schema cannot represent several states the spec requires:
- sticky `needs-relogin` (with its reason);
- an auth-suspect limit as distinct from a usage limit;
- the difference between `expired` (registry-derived) and other relogin reasons.
Because the status is recomputed from strikes and the strike counters age out after 24 h, needs-relogin gets un-stuck.
EVIDENCE: §6.3: 'The engine always recomputes them from records, strikes, attentionCode, the registry (enabled, expiresAt) and now'.

D.2 fields: status, reason, records, authStrikes, lastStrikeAt, attentionCode, earlyRehitBackoffMinutes, lastUsedAt, lastOkAt, utilization, wrongAccount. None of them records 'needs-relogin because invalid_grant'.

§9.2: 'a second strike within 24 h → needs-relogin' and 'Without it [mark --ok], counters reset after 24 h with no new hits'. If needs-relogin is derived from authStrikes>=2, it clears itself 24 h later, which contradicts 'no (sticky)'. Definitive evidence (invalid_grant, 'refresh token was already used') has nowhere to be stored at all.

Auth-suspect: '→ limited with reason auth-suspect for 15 minutes'. The D.2 Record has no field saying whether a record is a usage limit or an auth suspicion, so `reason` cannot be recomputed. Its tier is also undefined for the merge rule; a tier-3 assumption would let a 15-minute suspicion replace a 5-hour limit.

The §9.2 table says `mark --clear` clears needs-relogin. For reason `expired` (derived from expiresAt), a recompute would set it again immediately.
FIX: Add to D.2 per account:
`relogin: null | {reason: "rejected"|"refresh-dead"|"expired"|"missing", since, snippet}`
It is set by definitive evidence or by the escalating strike. It is cleared only by `login`, `add --replace` or `mark --clear`, never by the 24 h counter reset.

Add `kind: "limit"|"auth-suspect"` to Record. Auth-suspect records have scope `account`, tier 1 and limitSource `auth`. The merge rule applies only between records of the same kind; an active record of either kind blocks.

In §9.2: 'reason `expired` is derived from accounts.json expiresAt and clears only through login/add --replace. `mark --clear` on it exits 65 with that hint.' Update the §6.3 example to include `relogin:null`.

## 11. [major] §9.4 Bounds and backoff; §6.3 'Expired records are pruned on the next write'
PROBLEM: The unknown-reset doubling and the early re-hit backoff need memory of records that have already expired. The spec prunes that memory on the next write, so the backoff never grows, and the anti-hot-loop protection that D8 relies on does not work.
EVIDENCE: §9.4: 'Unknown reset: start at 30 minutes, double on each consecutive unknown-reset hit of the same (account, scope), cap at 300 minutes.' Also: 'Early re-hit: a limit within 15 minutes after the previous record expired → until >= now + backoff'. And: 'Counters reset on mark --ok, or after 24 h without re-hits'.

§6.3: 'Expired records are pruned on the next write.' D.2 keeps `hits` inside the Record.

An account is not selected while its record is active, so a 'consecutive' hit always arrives after the previous record expired. By then, any write in between (another account's `next`, any `mark`) has pruned the record and its `hits`. The new hit starts again at 30 minutes, and the early re-hit rule has no 'previous record expired at' time to compare.

`earlyRehitBackoffMinutes` exists per account, but there is no per-scope timestamp to compare against.
FIX: Add to D.2 per account:
`backoff: {"<scope>": {hits, lastUntil, lastHitAt, rehitMinutes}}`
Pruning removes expired records but keeps a backoff entry until 24 h after lastHitAt; `mark --ok` deletes it.

In §9.4: 'Unknown-reset doubling reads backoff[scope].hits. The early re-hit rule compares now with backoff[scope].lastUntil.' Move `earlyRehitBackoffMinutes` into this map.

Add an engine table test: three unknown-reset hits, each after the previous record expired, with an unrelated write in between, must give 30, 60 and 120 minutes.

## 12. [major] §9.3 'When no candidate is usable' rules 1–3; §9.6
PROBLEM: The ordered rules make 'the pool contains only A → 69' unreachable, and §9.6 forbids something rule 1 requires. An implementer cannot satisfy both texts.
EVIDENCE: Rule 1: 'If any candidate is time-limited, including A, return exit 75, with account = the one with the smallest effective reset'.

Rule 3: 'Otherwise (pool empty, all disabled, cli unsupported, or the pool contains only A) → exit 69, after A's limit has been recorded'.

After `next` records A's limit (or a first auth strike, which is a 15-minute auth-suspect limit), A is time-limited, so rule 1 always fires first and returns 75. 'Pool contains only A' never reaches rule 3.

This matters because §15.4 routes explicitly pinned single-account runners (`accounts:["work"]`, rotationPossible=false) through accshift, so the pool-of-one case is the normal one for them. R08 §d defines 69 as 'fewer than 2 accounts in the pool'.

§9.6: 'It never returns --from from next'. Yet rule 1 with pool [A,B], A limited until 15:00 and B until 18:00, must return A with exit 75.
FIX: Choose 75. In §9.3 rule 3, delete 'or the pool contains only A'. Add:

'A one-account pool returns 75 naming A (the caller waits for accshift's reset), or 77 if A is needs-*.'

In §9.6: 'It never returns --from with exit 0; with exit 75 the soonest-free account may be --from.'

Align §10.3 69 ('no rotation possible') and Appendix E with this, and add the pool-of-one case to the §18.1 engine table tests.

## 13. [major] §9.3 definition of 'usable'; §9.1 Blocking; §11.2 list/status shape
PROBLEM: 'Usable' is defined through the account-level `state`. That state is `limited` whenever any record is active, including model-scoped ones, which cancels the scope-aware design. A `--model` that maps to no bucket makes model records non-blocking, which contradicts the 'never less safe' claim.
EVIDENCE: §9.3: 'An account is usable for a request when its state is ready and it has no active blocking record for the requested model.'

§9.2 lists `limited` as 'no, until its blocking records expire', and the list output has a single `state`. An account with only a `model:opus` record has state `limited`, so it is unusable even for `--model sonnet`. That is exactly the failure D8 reason 3 says the design prevents ('an Opus-only weekly cap would block Sonnet runners on that account for days').

§9.1: 'with --model M, only account-scope records and records whose bucket covers M block'. With LimitShift passing a model name missing from facts.go (for example a newly released model name), a `model:opus` record no longer blocks it. Yet §9.1 claims 'The model is therefore never less safe than plain per-account records'.

§11.2 list/status gives a single limitedUntil, limitType and limitSource per account, so it cannot show two concurrent records.
FIX: In §9.3: 'An account is usable for a request iff it is enabled, has no relogin or attentionCode, is not past expiresAt, and has no active blocking record for the request per §9.1. The account-level `state` is a display summary and MUST NOT be used for selection.'

In §9.1: 'A --model value that maps to no bucket is treated as covering every bucket, so all model records block it.'

In §11.2 list/status, add `limits:[{scope, untilEpoch, until, limitType, limitSource, kind}]` per account, keeping the summary fields as the maximum over records that block a model-less request.

## 14. [major] §9.4 Evidence tiers and merge rule; Appendix D.2 Record.tier
PROBLEM: Several merge cases are unsafe or undefined:
- Same-tier evidence can shorten an active limit, so a parallel queue's bogus caller value wins.
- The tier is tied to the signal rather than to the source of the reset value.
- 'user' has no defined order against numeric tiers.
EVIDENCE: 'a new record replaces the active record for the same (account, scope) iff newTier >= oldTier or newUntil > oldUntil'. Tier 2 includes 'the caller's --limited-until'.

Scenario: queues Q1 and Q2 both run account A.
1. Q1 records 'resets 3pm' (tier 2, until 15:00).
2. Q2's LimitShift parser turns Copilot `resets in ~3600s` into 'now' (the bug D8 cites). Q2 calls `next --limited-until <now>` at tier 2.
3. 2 >= 2, so the record is replaced by now+60 s (min cooldown). The hot loop D8 meant to prevent returns.

§8.1 lists 'result is_error + api_error_status 429' as structured (tier 3) although it carries no reset. A tier-3 backoff guess would then replace a correct tier-2 'resets 3pm'.

D.2 defines `tier:1|2|3|"user"`. The spec says only that user 'replaces any record unconditionally'; whether later tier-3 evidence can replace a user override is undefined. The mixed int/string type is also awkward for jq and PowerShell consumers.
FIX: Replace the merge rule:

'(1) Tier describes the reset value's source. A record without a vendor-supplied reset time is tier 1, whatever detected the limit.

(2) Higher tier replaces. Lower tier replaces only if newUntil > oldUntil.

(3) Equal tier: if |new.observedAt − old.observedAt| < 10 min (the same incident reported by several callers), keep max(until). Otherwise the newer observation wins.

(4) A caller --limited-until earlier than now+minCooldown is not tier-2 evidence; it becomes an unknown reset (tier 1, backoff).

(5) Overrides are tier 4. They are replaced only by another mark --override or by mark --clear.'

Change D.2 to `tier: 1|2|3|4`.

## 15. [major] §9.2 'Success is reported only by...'; §12.1 'What exec does not do'; §15.3 hooks
PROBLEM: In the integration, nothing ever reports success. Strike and backoff counters therefore only age out after 24 h idle, so two unrelated 401s a day apart, with hundreds of successful runs between them, make the account sticky needs-relogin. The sections also contradict each other about exec reporting success on the spawn path, which would make the state machine differ between Windows and POSIX.
EVIDENCE: §9.2: 'Success is reported only by the caller (mark --ok), or by exec on the spawn path ... mark --ok resets strike and backoff counters. Without it, counters reset after 24 h with no new hits.'

§12.1: exec 'does not classify output' and 'On the spawn path it MAY record lastUsedAt'. Resetting strikes is not mentioned.

§6.3 lists the writers without any exec success write.

The §15.3 bash, ps1 and v2 hooks call pick, next and mark --auth-failed, but never mark --ok.

On Windows (always the spawn path) and for agy, exec might reset strikes on exit 0. On POSIX claude/codex (execve) nothing ever does. The same queue would then behave differently per OS.
FIX: In §9.2: 'Success is reported only by `mark --ok` (exec never changes strike or backoff state). mark --ok clears authStrikes and backoff and any auth-suspect record for that account, and sets lastOkAt.'

In §12.1, drop the spawn-path success implication.

In §15.3, add to all three runners: 'after a run that is neither Limit nor Error on a wrapped runner, call `accshift mark <cli> --account "$ACCT_CURRENT" --ok` (ignore its exit code)'.

Add §15.10 scenario 13: a 401, 20 successes, then a 401 more than 15 minutes later must not produce needs-relogin.

## 16. [major] §9.2 Ambiguous 401/403; §15.2 step 5 vs §15.3 v2 'Auth branch'; §10.2 classify --record
PROBLEM: One authentication failure can be counted as two strikes. Concurrent runs on one account report the same incident several times. A provider-wide 401 outage escalates every account to sticky needs-relogin, after which the legacy-fallback blocker applies.
EVIDENCE: §15.2 step 5 says to call `accshift next <cli> --from A --reason auth`. §15.3 v2 says instead: 'Auth branch: mark --auth-failed, then next'.
- If that `next` passes --reason auth, there are two strikes and needs-relogin follows on the first 401.
- If it passes nothing, it records a strike plus an unknown-reset limit, since 'Every flag except --from is optional'.

`classify --record --account A` followed by `next --evidence-file` for the same run also double-counts hits and strikes.

claude token accounts have 'unlimited' concurrency (§8.1), so N parallel queues hitting one transient 401 give N strikes within seconds, and the second one escalates.

Outage scenario: all accounts get a first strike, go auth-suspect, and exit 75 returns after 15 minutes. If the outage lasts more than 15 minutes, every account gets its second strike and goes sticky needs-relogin. pick then returns 77 for the whole pool.
FIX: In §9.2:

'A strike escalates to relogin only if it comes from a run that started after the account's auth-suspect record expired (`--run-started-at T` on next/mark; default now−60 s). Strikes arriving while an auth-suspect record is active only refresh it.

If at least 2 pool accounts received strikes within authSuspectMinutes, treat it as an incident: no escalation, and back off all of them by authSuspectMinutes.'

In §15.3 v2, replace 'mark --auth-failed, then next' with the single call `next <cli> --from A --reason auth`.

In §10.2: 'classify --record and next/mark --evidence-file MUST NOT both be used for one run.'

## 17. [major] §15.3 Hook points (bash next/pick lines, ps1 and v2 equivalents) vs §15.2 step 2; §9.3 next --model
PROBLEM: The copy-paste integration code drops the flags that make the engine scope-aware and tier-correcting. `next --model` also mixes two meanings: the model that hit the limit (for recording) and the model of the next run (for selection). After the model-index reset these differ.
EVIDENCE: §15.2 step 2 calls `accshift next <cli> --from A --model M --limited-until <reset> --evidence-file <run output> --exit N [--session ID --cwd DIR]`.

The §15.3 bash snippet calls only `acct_call next "$cli" --from "$ACCT_CURRENT" --limited-until "$lim"`. The pick line has no --model, and the v2 snippet is the same.

The consequences:
- Every record is scope `account` ('Unknown scope is account').
- No tier-3 correction happens, so D8's `resets in ~3600s → now` fix never applies.
- needs-attention (blocked) is never detected from evidence; an `account_on_hold` account is retried every 30–300 minutes forever.
- pick without --model treats every model record as blocking.

Model conflation: §15.2 step 2 resets 'the model index to 0' and then calls next --model M, where M is the failing (last) model. next picks B 'usable for M', but the next run on B uses models[0]. If B has an active record for models[0]'s bucket, that run is wasted.
FIX: Make the §15.3 snippets normative and complete. next calls must pass:
`--model <model of the next run> --limited-model "$currentModel" --evidence-file "$output_file" --exit "$exit_code"` (plus `--session`/`--cwd` for claude/codex).

pick must pass `--model <model of this run>`.

In §9.3 and §10.2, split the flags: `--limited-model M` (recording scope hint, default = --model) and `--model M` (selection). Document that with models-first order, --model after a switch is models[0].

Add a §15.10 scenario where an Opus-only weekly record on A must not stop a Sonnet runner from picking A.

## 18. [major] §12.1 'With --account' vs §12.1.1 exit-125 table ('needs-relogin'); Appendix E 125
PROBLEM: It is undefined whether `exec --account A` refuses an account in needs-relogin or with a missing credential. If it refuses, LimitShift charges 125 to the retry budget and 'never rotate[s] on it', so a dead account is retried until the task fails. Because pick never touches the vault, a missing credential is re-selected for every task.
EVIDENCE: §12.1: with --account, exec 'runs exactly that account, even if accshift believes it is limited (the caller decides)'.

§12.1.1 lists 125 `needs-relogin` as 'the account needs a human' without restricting it to the picking path, while the next row, all-capped, is marked 'only when picking'.

Appendix E 125: 'treat as CLI error charged to the retry budget, never as a limit; never rotate on it'.

§7.1: pick and next 'never open the keystore', so a token account whose vault entry is missing (restored from an older export) stays `ready`. Each task does pick, then exec fails 125, then the task fails, then the next task picks the same account from its account file. On the execve path exec writes no state (§12.1), so the failure is never learned.
FIX: In §12.1.1: '`needs-relogin` is produced only when exec picks (no --account). With --account, exec never refuses because of recorded state.

If A's credential is absent (vault entry, overlay auth file), exec records relogin(reason `missing`) under state.lock, then exits 125 `credential-missing`.'

In Appendix E and §15.2 step 3: 'On 125 `credential-missing` or `unknown-account`, LimitShift calls `next <cli> --from A --reason auth` (which rotates) instead of charging the retry budget.'

## 19. [major] §8.5 Copilot limits table vs §9.4 'Not account limits'; §8.4 Gemini limits vs §9.2 and Appendix C.4; §11.2 class enum
PROBLEM: The same vendor signal maps to contradictory states in different sections. One mapping would remove an account from rotation permanently for something that is not account-wide.
EVIDENCE: §8.5 lists '`session_quota_exceeded` (a user-set cap), `billing_not_configured`, the multiple-licence error' as `blocked-account`, which means sticky needs-attention cleared only by mark --clear. §9.4 says 'Not account limits (no limit record created): ... Copilot `session_quota_exceeded`'. Appendix C.5 lists it under blocked-account.

§8.4: '`ValidationRequiredError` (403) → `auth` with reason `needs-attention`'. §9.2 lists it under needs-attention (sticky). Appendix C.4 lists it as `auth`, which is the ambiguous-strike path (auth-suspect for 15 minutes, then needs-relogin). Re-login does not fix that, according to §9.2.

§11.2's class enum has `blocked`; §8.5 and Appendix C use `blocked-account`.
FIX: Decide each case and use it in all four places.

(a) Copilot `session_quota_exceeded` is a per-session user cap: class `error`, no record, no rotation. Remove it from the blocked rows in §8.5 and C.5.

(b) Gemini `ValidationRequiredError`: class `blocked`, with attentionCode `ValidationRequiredError` (sticky needs-attention). Remove it from 'auth' in §8.4 and C.4.

(c) Rename `blocked-account` to `blocked` in §8.5 and Appendix C.

Add a classify golden test for each case.

## 20. [major] §8.1/§8.2/§8.3.4 'Login' flows; §9.2 Clears column (re-login while limited); native accounts
PROBLEM: Re-login never checks identity, and the spec does not say what happens to limit records on login. `login codex work` or `login claude work` with a different account silently re-points the name. The new identity inherits the old limit records, and the add-time dedupe is skipped, so two names can refer to one identity and every rotation between them re-hits the limit. Native accounts can also change identity outside accshift.
EVIDENCE: §8.2: 'Login: re-run codex login --device-auth in the account's overlay'. No identity comparison is required; dedupe on (chatgptAccountId, chatgptUserId) is done only in Add step 5.

§8.1: 'Login: the same flow, replacing the token'. The label is user-asserted, and the uniqueness check exists only at add.

§9.2 lists login only as clearing needs-relogin. It does not say whether limit records, strikes or auth-suspect records survive.

Scenario (re-login while limited): work is limited until 18:00, and the user re-logins `work` with the same identity.
- If an implementer clears records on login, the next pick selects work and the run is wasted.
- If records are kept but the identity changed, a fresh account is wrongly blocked.

Native: the user's own `claude /login` with another account changes what `main` is (the label comes from `.claude.json`), while main's records stay.
FIX: Add a common 'Login rules' paragraph to §8:

'login MUST compare the new credential's offline identity with the recorded one: codex file-store ids, agy email, gemini google_accounts active email. For claude tokens, require --label equal to the current label.

On a mismatch, restore or delete the new credential and exit 65 `identity-mismatch`, unless `--new-identity` is given. That flag runs the add-time dedupe and clears all records.

A same-identity login clears relogin, authStrikes and auth-suspect records, and keeps limit records.'

In §9.2, list these effects in the Clears column. Add: 'list/doctor compare a native account's current vendor email with its label; on a change, warn and clear that account's records.'

## 21. [major] §10.2 rename / remove; §6.3 'Entries for deleted accounts are removed on the next write'; §8.2 overlay canonical path
PROBLEM: `rename` moves the overlay directory. That orphans keyring and secrets-mode Codex credentials, and it pulls the home out from under a running codex whose next single-use refresh write then fails. Lazy state deletion lets a re-added name inherit the removed account's needs-relogin and limits. Renames are not atomic across the two files that lock-free readers read.
EVIDENCE: §10.2: 'rename ... moves the vault entry, home dir and state key'.

§8.2: 'keyring and secrets keys derive from sha256(canonical CODEX_HOME). Moving ACCSHIFT_HOME therefore needs a re-login'. A rename moves the canonical path in the same way.

R04 C13: refresh tokens are single-use and auth.json is rewritten at the CODEX_HOME path. A codex exec started before the rename with CODEX_HOME=.../work writes its refreshed token to a path that no longer exists, so the account is lost and needs re-login.

§6.3: 'Entries for deleted accounts are removed on the next write'. Sequence: `remove claude work` (no state write), then `add claude work` with a new token. The new account inherits the old `relogin` and limits.

Rename writes accounts.json and state.json as two separate renames. A lock-free pick between them sees `new` with no state, so it is shown as ready although it is limited.

LimitShift's persisted account files reference the old name.
FIX: Give each account an immutable `id` (random, assigned at add). Key the overlay path `homes/<cli>/<id>`, the vault secretId and the state.json entry by id.

`rename` changes only `name` in accounts.json, in one atomic write, and never moves directories or secrets.

`remove` deletes the state entry and vault entry in the same state.lock transaction. It refuses while procscan finds a vendor process whose environment or cwd references the overlay (POSIX /proc environ or `ps eww`; on Windows, best effort with a warning).

For agy, `remove` warns that a live slot copy will reappear as `_unregistered` on the next save-back, unless `--clear-slot` is given.

## 22. [major] §6.4 Versioning and migration (corrupt files); §6.2 hand edits; §11.1 rule 8 / §6.3 readers never write
PROBLEM: Lock-free readers are told both that they never write and that they rename unparseable files or recreate state.json. A pick that races a user's non-atomic editor save moves accounts.json aside, and later calls see no registry. A reader that recreates state.json without the lock can clobber a concurrent writer and erase sticky facts.
EVIDENCE: §11.1 rule 8: 'list, status, pick and version are read-only: no lock, no state write'.

§6.4: 'A file that fails to parse is renamed to <name>.corrupt-<epoch> ... except for state.json, which it MAY recreate empty'.

§6.2: users 'MAY edit it by hand while no accshift process runs'. With LimitShift queues running for days, that window does not exist, and many editors write in place, not atomically.

Scenario: a queue's pick reads a half-written accounts.json, renames it to .corrupt and exits 78. LimitShift goes legacy (and runs unwrapped, per the first blocker). The next command finds no accounts.json and may initialise an empty registry. All accounts vanish from rotation and vault entries are orphaned until the user notices the .corrupt file.
FIX: In §6.4:

'Only a writer holding state.lock may quarantine or recreate a file, and only after a second read 200 ms later fails the same way. Readers that fail to parse exit 78 (exec: 125 `state-corrupt`) and change nothing.

A missing accounts.json is never recreated while `<name>.corrupt-*` files or vault entries exist; exit 78 with a hint instead.

Recreating state.json is allowed only from `doctor --fix`.'

In §6.2, replace 'while no accshift process runs' with: 'edit via `accshift config edit` (copies to a temp file, opens $EDITOR, validates, writes atomically under state.lock)'.

## 23. [major] §8.2 Auth ('refresh token was already used' → needs-relogin on first occurrence); §9.2 definitive evidence
PROBLEM: A native or overlay Codex account used by two processes at once makes the losing process report 'refresh token was already used'. Meanwhile auth.json already holds the winner's valid token. The spec makes this sticky needs-relogin on the first occurrence, so a healthy native `main` drops out of rotation until manual `mark --clear`. This is the 'pool with native + home accounts' scenario.
EVIDENCE: §8.2: '`refresh token was already used` ... → needs-relogin on the first occurrence. These never heal by themselves.'

D4/D5 reason 6: the native account exists so that 'The user's interactive tools, the IDE extension and the Codex daemon keep working'. So concurrent use of ~/.codex by the user and a queue is the expected case.

§8.2 Concurrency: the stagger SHOULD covers only 'two accshift-launched runs of one codex account'.

R04 line 404 lists 'how does refresh-token reuse detection behave if two processes in the same home refresh concurrently?' as an open question. R04 §2 notes a 401 'first does a guarded reload from storage'. The spec turns an unverified race outcome into a sticky state.
FIX: In §8.2 Auth:

'For home and native accounts, refresh_token_reused is definitive only if auth.json was not rewritten after the failing run started. Compare mtime and the refresh-token fingerprint against `--run-started-at`; next/mark read them offline. Otherwise treat it as transient: no strike, retry the same account once.'

Extend the stagger SHOULD to native accounts, and have doctor warn when a codex process not started by accshift uses mainHome.

Add V-X4 (concurrent refresh in one home) to §22 and M0.

## 24. [minor] §8.3.3 step 9 (After the child exits); §6.3 wrongAccount / agySlot
PROBLEM: The post-run check treats an empty slot (agy cleared a rejected credential) as a mismatch. `wrongAccount` has no effect on selection or on limit attribution, and nothing ever clears it. `state.agySlot` is not corrected after a mismatch or after recovery.
EVIDENCE: Step 9: 'check that the slot's email still equals the requested account. On a mismatch record wrongAccount in state and print an accshift: warning'.

R05 §d: agy 'clears the entry on definitive server rejection (revoked account)', so an empty slot after a run is a strong needs-relogin signal, not a 'wrong account'.

§6.3 defines wrongAccount only as 'set when the post-run agy check found a different email'. No transition clears it, and next/pick ignore it. If the run actually ran as c, LimitShift's following `next agy --from a` charges c's limit to a.

agySlot.owner is written only in step 7, so after a mismatch or recovery it is stale until the next swap.
FIX: Add to step 9:

'If every slot is empty, do not save back. Record relogin(reason `rejected`) for the requested account and set state.agySlot to null.

On a mismatch, set wrongAccount = {expected, actual, at} and state.agySlot.owner = the observed registered account (or null). Report `wrongAccount` in --status-file.

LimitShift then re-runs the task without calling next for that run. wrongAccount is cleared by the next run whose post-run check matches.'

## 25. [minor] §13.2 Atomic writes (Windows) and lock-free readers
PROBLEM: Lock-free readers on Windows block the writer's replace. Go's os.Open does not pass FILE_SHARE_DELETE, so MoveFileEx(REPLACE_EXISTING) over state.json, accounts.json or vault.v1.bin fails while any pick, list or status (or the exec vault read) has the file open. With several queues polling, the 5×50 ms retry can be exhausted, and next then fails to record a limit.
EVIDENCE: §13.2: 'rename it over the target (on Windows, MoveFileEx with REPLACE_EXISTING, retrying up to 5 times with 50 ms backoff on sharing violations)'. 'Readers never need the lock'.

Go source (`syscall/syscall_windows.go` in 1.24, the tree available here): `sharemode := uint32(FILE_SHARE_READ | FILE_SHARE_WRITE)` with no FILE_SHARE_DELETE. Replacing a file another process has open without delete-sharing fails.
FIX: Add to §13.2: 'On Windows, readers MUST open state, registry and vault files with CreateFile(GENERIC_READ, FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE) through x/sys/windows, not os.Open. Writers use MoveFileEx(MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH). The retry stays as a fallback.'

Add a Windows contract test where a reader holds the file open during a write.

## 26. [minor] §9.3 next ('records ... and selects in the same locked transaction'); §13.1 state.lock row; §8.2 rollout lookup
PROBLEM: Nothing keeps evidence parsing and vendor-artifact reads outside the state.lock critical section. The Codex rollout lookup globs the whole sessions tree. Under parallel queues, the 5 s state.lock timeout then returns 73 and LimitShift falls back to legacy for that limit.
EVIDENCE: §13.1: state.lock is held for 'one read-modify-write, a few ms', with a timeout of '5 s, then exit 73'.

§9.5: inputs are the evidence file ('tail-bounded to 256 KB'), the Claude transcript tail and 'the Codex rollout for the thread id'.

§8.2: classify reads the newest rollout 'under <mainHome>/sessions/**/rollout-*-<thread_id>*.jsonl[.zst]'. That is a recursive walk of a directory that grows daily, and it may involve zstd decompression.

NFR1 sets a 50 ms budget for next.
FIX: In §9.3: 'next, mark and classify --record parse the evidence and read vendor artifacts before taking state.lock. The lock covers only load, merge, select and write.'

In §8.2: 'search sessions/YYYY/MM/DD for the run-start date and the day before; fall back to a full walk only in classify without --record.'

## 27. [minor] §9.4 Bounds and backoff (clamp) and time parsing; §9.2 24 h windows
PROBLEM: The clamp applies only when a record is written, and all windows use wall-clock differences. A record written while the clock was ahead (for example an RTC or VM restore before NTP sync, combined with a relative reset such as agy's 'Resets in 4h') keeps the account blocked long after the clock is corrected. Negative intervals make '24 h' strike and counter checks behave wrongly.
EVIDENCE: §9.4: 'Clamp: an until more than 32 days ahead is clamped and flagged'. This is only evaluated against now at write time, and 'flagged' has no field in D.2.

Relative resets ('Resets in 4h46m9s', `retryDelay`) are anchored at the local now.

Scenario: the machine clock is a year ahead, agy hits a limit and until = clock+4h. After NTP corrects the clock, the record blocks for a year, and exit 75 tells LimitShift v1 to sleep until then.

'a second strike within 24 h' and 'counters reset after 24 h' compute now − lastStrikeAt. That is negative after a backward step, which reads as 'within 24 h'.
FIX: In §9.4:

'At read time, a record with observedAt > now+300 s, or until > now+32 d, is treated as until = min(until, now + (until − observedAt), now + 32 d) and is rewritten on the next write.

Stored timestamps later than now+300 s are ignored when computing the strike, backoff and early re-hit windows.

Add `clamped:true` to D.2 Record.'

Add §18.1 tests with a fake clock that jumps forward and backward.

## 28. [minor] §6.3 example; §11.2 list/next/classify examples; §9.3 resetAtEpoch skew margin
PROBLEM: Every epoch/RFC 3339 pair in the examples disagrees, violating §11.1 rule 4. It is also undefined whether the 30 s skew margin is part of the stored `until`. An AI implementer is likely to copy these examples into golden tests.
EVIDENCE: Examples whose two forms disagree:
- `"limitedUntil":"2026-10-07T15:00:00Z","limitedUntilEpoch":1791472800`: 1791472800 is 2026-10-08T15:20:00Z.
- `lastUsedAt 2026-10-07T09:00:00Z / 1791450000`: that epoch is 2026-10-08T09:00Z.
- `expiresAt 2027-10-07T10:05:00Z / 1823000700`: that epoch is 2027-10-08T13:05Z.
- classify `2026-10-07T15:45:00Z / 1791474300`: that epoch is 2026-10-08T15:45Z.

§6.3: the snippet 'resets 3pm (Europe/Kyiv)' has until 1791500400 (2026-10-08T23:00Z). 3 pm Kyiv (EEST) is 12:00Z, and observedAt 1791482400 is already after it. The opus record 'resets Oct 12, 9am (Europe/Kyiv)' has until 1791900000 (2026-10-13T14:00Z), whereas the correct value is 2026-10-12T06:00Z.

Skew margin: §9.3 says 'resetAtEpoch ... including a 30 s skew margin'. The next example records untilEpoch 1791472830, while list and mark for the same account show 1791472800.
FIX: Correct the pairs:
- 2026-10-07T15:00:00Z = 1791385200
- 15:00:30Z = 1791385230
- 09:00:00Z = 1791363600
- 2027-10-07T10:05:00Z = 1822903500
- 2026-10-07T15:45:00Z = 1791387900
- 3 pm Kyiv on 2026-10-07 = 1791374400, with an observedAt before it
- 2026-10-12 9 am Kyiv = 1791784800

In §9.3, state: 'Records store the vendor reset unchanged. The 30 s margin is added only when computing usability and resetAtEpoch. recorded.untilEpoch and list limitedUntilEpoch show the stored value.'

Add a schema test that each `foo`/`fooEpoch` pair is equal.

# LENS: fact-check
I checked every vendor fact and [Rxx] citation in SPEC.md (and DECISIONS.md where relevant) against research reports R01–R09, and spot-checked the LimitShift line references (limitshift.sh:1579/2043, :2825/:3209, v2-root :3646/:4103 all match). Most facts are quoted correctly: env-var scrub lists, Codex keyring naming, agy slot identity/encodings, `security` exit codes, Copilot precedence, Gemini paths, release tooling and versions.

The defects fall into four groups.

1. Several adapter rules contradict or misquote the research they cite:
   - Claude's native Keychain service/account derivation drops R04's exact conditions: the set-but-empty CLAUDE_SECURESTORAGE_CONFIG_DIR case, the raw NFC string with no path resolution, the os-username fallback, and the plaintext/Credential Manager fallbacks.
   - Codex `used_percent >= 100` is used as a tier-3 limit signal, although R03 §9 says it is not a signal on its own. §9.4 also disagrees with §8.2 and Appendix C.2.
   - agy `AGY_ERROR` with exit 3 is classified as a limit. R05 §f says agy prints it for any model or agent failure.
   - `GEMINI_CLI_AUTH_OVERRIDE` is treated as a path. R06 shows it is an auth-type enum, so the rule can never fire.
   - Copilot `session_quota_exceeded` is mapped to a sticky `needs-attention` state, contradicting both §9.4 and R06.
2. Research findings about agy's own fallback behaviour are ignored:
   - agy falls back to its file when a keyring save fails.
   - agy has a 5 s keyring timeout and a 1-hour timeout marker, not an unbounded Unlock wait.
   - The spec's write-set and mode rules can therefore leave agy signed out, or leave a stale account in the keyring.
3. Two contradictions in the exec rules and the Windows launch path:
   - The spec says exec "sets the switch" that keeps tokens out of agent subprocesses, while also forbidding exec from adding arguments. R06 already verified that Copilot's switch is the argv flag `--secret-env-vars`.
   - The Windows npm shim resolver does not cover the shim npm generates for claude's native `claude.exe` (R04 §0); this is inferred from how npm's cmd-shim works, not shown in R04.
4. Smaller issues:
   - Appendix C regex gaps.
   - Detection strings with no research evidence.
   - Wrong section or V-item cross-references.
   - INFERRED or secondary-source claims stated as facts.

I modified no files.

## 1. [major] §8.1 "add claude main --native" (and §8.1 Facts, Appendix B claude credential row)
PROBLEM: The rule for finding the native Claude credential misquotes R04's derivation. The detection will report 'absent' for real logins, or probe the wrong Keychain item.
EVIDENCE: SPEC: "service `Claude Code-credentials`, with the suffix `-<sha256(dir)[0:8]>` when the user's `CLAUDE_CONFIG_DIR` or `CLAUDE_SECURESTORAGE_CONFIG_DIR` is set; account `$USER`, falling back to `claude-code-user`" [cites R07 §2, which is a simplified summary]. Linux/Windows: "`.credentials.json` exists", with no directory given.

R04 §1a gives the exact code:
- `t = n!==void 0 ? !n : !process.env.CLAUDE_CONFIG_DIR`. When CLAUDE_SECURESTORAGE_CONFIG_DIR is set but empty, there is NO suffix even if CLAUDE_CONFIG_DIR is set. That is exactly the #92252 workaround the spec preserves for native.
- The hashed string is `n.normalize("NFC")` or `(CLAUDE_CONFIG_DIR ?? ~/.claude).normalize("NFC")`, "the raw NFC string with no path resolution" (R04 C2).
- The account is `process.env.USER || os.userInfo().username`, and becomes `claude-code-user` if that throws or fails `^[a-zA-Z0-9._-]+$`.
- OAUTH_FILE_SUFFIX sits between "Claude Code" and "-credentials".
- R04 C2: on macOS, if the Keychain write fails, Claude falls back to plaintext `.credentials.json`.
- R04 C3: on Windows, Credential Manager is used when CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1 or `cachedGrowthBookFeatures.tengu_windows_credman` is true.

Failure cases:
- A user with CLAUDE_CONFIG_DIR=~/.claude and CLAUDE_SECURESTORAGE_CONFIG_DIR="": the spec probes `Claude Code-credentials-<hash>`, gets exit 44, and refuses or misregisters the native account.
- Under launchd or cron with USER unset: the spec probes account `claude-code-user` while Claude uses the OS username.
FIX: Replace the bullet list with R04 §1a's exact algorithm, keeping it in claude `facts.go`:
- `ss = env CLAUDE_SECURESTORAGE_CONFIG_DIR` (distinguish unset from empty).
- `noSuffix = (ss is set) ? (ss == "") : (CLAUDE_CONFIG_DIR unset or empty)`.
- `hashed = (ss is set) ? NFC(ss) : NFC(CLAUDE_CONFIG_DIR ?? $HOME/.claude)`. Use the raw string: no EvalSymlinks, no `~` expansion, no trailing-slash trimming.
- `service = "Claude Code" + "" + "-credentials" + (noSuffix ? "" : "-" + hex(sha256(hashed))[0:8])`.
- `account = $USER, else the OS username` (from the passwd entry via syscall, since os/user needs cgo). Use `claude-code-user` if neither exists or the value fails `^[a-zA-Z0-9._-]+$`.

Also state:
- The credential directory is `ss` (empty means ~/.claude), else CLAUDE_CONFIG_DIR, else ~/.claude.
- On macOS, also accept `<dir>/.credentials.json` (plaintext fallback).
- On Windows, also check Credential Manager target `Claude Code-credentials[-hash]` / `claude-code-user` when CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1 or the GrowthBook flag is cached true.
- Cite R04 §1a/C2/C3, not R07 §2.

## 2. [major] §8.2 Limits "Structured (tier 3)", Appendix C.2 limit row, §9.4 tier table
PROBLEM: The spec treats `used_percent >= 100` as a tier-3 Codex limit signal. Research says this alone is not a signal, and §9.4 itself lists only `rate_limit_reached_type`. The spec also does not define which window's `resets_at` to use, and it treats workspace credit depletion as a time-reset limit.
EVIDENCE: SPEC §8.2: "uses `resets_at` of the reached window (`rate_limit_reached_type` non-null or `used_percent >= 100`)". C.2: "rate_limit_reached_type != null or any window used_percent >= 100". §9.4 tier 3: "Codex rollout token_count.rate_limits with rate_limit_reached_type set → resets_at of the reached window" (no used_percent).

R03 §9 (owner's ai-switcher requirements): "Codex rollout token_count.rate_limits.rate_limit_reached_type (with the note \"used_percent: 100 alone is NOT a signal\")". The spec cites R03 §9 in §9.3 for exactly this unreliability.

R04 §2f: `rate_limit_reached_type ∈ rate_limit_reached|workspace_owner_credits_depleted|workspace_member_credits_depleted|workspace_owner_usage_limit_reached|workspace_member_usage_limit_reached`. No value names primary or secondary.

Tier 3 can SHORTEN an existing record (merge rule), so a stale 100% snapshot can override a correct text reset.
FIX: In §8.2 and C.2, delete "or used_percent >= 100" / "or any window used_percent >= 100". Add:
- "Tier 3 only when the last `token_count` event of that thread has `rate_limit_reached_type == \"rate_limit_reached\"`.
- Reset = the latest `resets_at` among windows whose `used_percent >= 100`. If no window is at 100, use the later of primary and secondary `resets_at` with resetConfidence `parsed`.
- `workspace_*_credits_depleted` and `workspace_*_usage_limit_reached` → class `blocked` (needs-attention), with no limit record."

Make §9.4 use the identical wording.

## 3. [major] §8.3.5 Limits; Appendix C.3 limit row
PROBLEM: The headless `AGY_ERROR: {…}` stderr line with exit 3 is listed as a limit signal. Research says agy prints it for any model or agent failure, so every agy model or server error would record a limit and rotate accounts.
EVIDENCE: SPEC §8.3.5: "Limits (Appendix C.3): `RESOURCE_EXHAUSTED …`, the headless `AGY_ERROR: {…}` stderr line with exit 3, and the credits wording." C.3 limit row: "Headless: stderr line `AGY_ERROR: {…}` with exit 3".

R05 §f: "on a model/agent failure, `agy -p` prints a structured `AGY_ERROR: {…}` JSON line on stderr (fields: canonical status, HTTP/gRPC code, retryability, error id) and exits with code 3".

R05 §f also lists `MODEL_CAPACITY_EXHAUSTED` and 502/503/504 as other failures, and C.3 itself classes these as transient.
FIX: In C.3, move AGY_ERROR out of the limit row and add a structured row: "`AGY_ERROR: {json}` (exit 3): parse the JSON, then classify:
- canonical status RESOURCE_EXHAUSTED or code 429 with a quota or credits message → `limit`;
- UNAVAILABLE, 5xx or retryable=true → `transient`;
- UNAUTHENTICATED or PERMISSION_DENIED → `auth`;
- otherwise → `error`."

Change §8.3.5 to "…and an `AGY_ERROR` line whose status is RESOURCE_EXHAUSTED/429". Require a verbatim corpus fixture (§18.1) before shipping.

## 4. [major] §8.3.2 "Write set" (and §8.3 Facts fallback list)
PROBLEM: When the resolved slot cannot take the blob, the spec deletes it and writes nowhere else. agy itself falls back to its token file when a keyring save fails. As a result, the target account can end up in no slot at all.
EVIDENCE: SPEC: "If a slot that holds a credential cannot accept the incoming blob (Windows keyring over 2560 B, …), accshift snapshots it and then deletes it, failing closed." The write set contains only the resolved slot plus slots that *currently hold* a credential. The Facts list gives fallback triggers as detectors and the timeout marker only.

R05 §a (Windows): "`keyring.Set` would fail and agy would fall back to the file `~/.gemini/antigravity-cli/antigravity-oauth-token` (log line *\"Failed to save token to keyring, falling back to file\"*)". R05 C7: "Treat Windows agy as effectively file-based". DECISIONS D6: the blob is "borderline (about 1.5–2.6 KB)".

Failure case: Windows desktop (no detectors fire, mode keyring). Account a's 2.4 KB blob is in Credential Manager; account b's blob is 2.7 KB; the file slot is empty. The swap deletes the keyring item and writes nothing. agy starts signed out (interactive login prompt, or headless auth failure), and LimitShift charges an auth strike to b. The same happens for `agy use` when every slot is empty.
FIX: Add to §8.3.2: "If the resolved slot cannot accept the incoming blob (size cap), the first CLI token-file candidate (or the file path recorded at `add`) joins the write set, mirroring agy's own save-failure fallback [R05 §a]. V-A4 must also confirm that agy reads the file when the keyring item is absent."

Add to the §8.3 Facts trigger list: "…or a failed keyring save (falls back to the file) [R05 §a]". Extend V-A4 to cover "which slot agy reads after a keyring save failure".

## 5. [major] §8.3.2 "Which slot agy will read" (timeout-marker detector and the locked-keyring rule)
PROBLEM: The 1-hour keyring-timeout marker is treated like a permanent detector. The spec also does not say whether the locked-keyring fail-closed rule overrides detector-based file mode. One reading leaves a stale account in the keyring that agy returns to when the marker expires; the other blocks every SSH/headless run on a desktop whose keyring is locked.
EVIDENCE: SPEC lists "a timeout marker younger than 1 h exists" as a file-mode detector. The write set is the resolved slot "plus every other reachable slot that currently holds an agy credential". The locked-keyring rule says "the run MUST NOT proceed" without saying whether it applies in file mode.

R05 §a: "plus a 1-hour memoized 'keyring-unavailable' marker after a prior keyring timeout"; changelog: "skips it for an hour after a timeout". agy decides storage "up front" per process. The CLI and the language server use different markers: `<appDataDir>/cache/antigravity-keyring-unavailable` vs `~/.gemini/cache/antigravity-keyring-unavailable`.

Failure case:
1. File mode is chosen only because a 50-minute-old marker exists, and the keyring is locked.
2. The keyring is unreadable, so it is not in the write set and keeps account a; b is written to the file.
3. The marker expires. A language server spawned later, or the next agy process, reads the keyring once the user unlocks it, and gets account a.
FIX: Split the detectors in §8.3.2:
- Permanent (env/OS): empty DBUS_SESSION_BUS_ADDRESS, container, CLOUD_SHELL, WSL, SSH vars, Android. File mode; the keyring is out of scope, and the locked-keyring rule does not apply.
- Transient: the timeout marker. File mode for this run, but the keyring stays in scope: it MUST be read and, if it holds a credential, added to the write set. If it is locked, timed out or prompts, fail closed with `agy-keyring-locked`.

State explicitly that the locked-keyring rule applies only when the keyring is in scope. Check both marker paths.

## 6. [major] §8.3.2 "A locked or uncertain keyring fails closed" (rationale); §7.5 / NFR5 timeouts
PROBLEM: The spec says agy's keyring access waits for a human with no timeout. R05 shows agy wraps keyring operations in a 5 s timeout, after which it writes the timeout marker and uses the file slot. accshift's 10 s operation timeout does not match agy's 5 s budget.
EVIDENCE: SPEC: "agy itself may still unlock it (go-keyring calls `Unlock` and waits for a human with no timeout [R05 §a, R07 C5])". R07 C5 is about the go-keyring library alone.

R05 §a: "Keyring op timeout is 5 s"; detection timeout 2.5 s; changelog: "skips it for an hour after a timeout, and uses longer keyring timeouts". R07 §1: log string "keyringAuth: timed out after %v, skipping keyring auth".

NFR5 and §7.4 give accshift a 10 s operation timeout. Failure case: a slow Secret Service that answers accshift in 6 s causes agy to time out, write the marker and run from a file slot that accshift did not write for this account.
FIX: Rewrite the rationale: "go-keyring's prompt wait is unbounded [R07 C5], but agy bounds keyring operations at about 5 s [R05 §a]. After a timeout, agy writes `…-keyring-unavailable` and uses its file slot for an hour. A locked keyring therefore leads either to a GUI unlock within 5 s (agy reads an item accshift could not verify) or to a silent switch to the file."

Add: "For agy slot operations, accshift treats any keyring call that takes longer than 4 s as 'uncertain' (fail closed), so it never relies on a store agy would abandon." Record agy's timeout value in agy `facts.go`.

## 7. [major] §12.5 "Inherited accshift homes"; §8.4 Kinds `native`; Appendix A.4 `native` row
PROBLEM: `GEMINI_CLI_AUTH_OVERRIDE` is treated as a path ("whose canonical path resolves inside <root>/homes/"). It is an auth-type enum, so the rule can never fire, and an inherited override passes into native runs.
EVIDENCE: SPEC §12.5: "An inherited `CODEX_HOME`, `CODEX_SQLITE_HOME`, `GEMINI_CLI_HOME` or `GEMINI_CLI_AUTH_OVERRIDE` whose canonical path resolves inside `<root>/homes/` is accshift's". A.4 native: "unset `GEMINI_CLI_HOME` and `GEMINI_CLI_AUTH_OVERRIDE` if they point into `<root>/homes/`".

R06 §1.2: "`GEMINI_CLI_AUTH_OVERRIDE` … Valid values: `oauth-personal`, `gemini-api-key`, `vertex-ai`, `compute-default-credentials`, `gateway`".

Failure case: a shell that ran `eval "$(accshift env gemini --account k --format sh --reveal-secrets)"` has `GEMINI_CLI_AUTH_OVERRIDE=gemini-api-key`. A later `exec gemini --account main` (native) unsets GEMINI_API_KEY but keeps the override, so the native run fails auth and LimitShift records an auth strike on `main`.
FIX: In §12.5 and A.4, replace the GEMINI_CLI_AUTH_OVERRIDE clause with:
"For gemini `native` runs, `GEMINI_CLI_AUTH_OVERRIDE` is unset when (a) the inherited `GEMINI_CLI_HOME` resolves inside `<root>/homes/`, or (b) its value differs from the value recorded at `add gemini main --native`. Record the user's value (or its absence) at add time, as §8.1 does for CLAUDE_SECURESTORAGE_CONFIG_DIR."

The path test applies only to CODEX_HOME, CODEX_SQLITE_HOME and GEMINI_CLI_HOME.

## 8. [major] §7.6 "Injected tokens reach the agent's subprocesses"; §8 Rules for all adapters; §8.2 Environment; V-P2 / V-X4 in §22
PROBLEM: §7.6 requires exec to set the vendor's "switch" that keeps tokens out of tool subprocesses whenever one exists. The spec also forbids adding arguments. The only switches known from the research are argv flags (Copilot `--secret-env-vars`) or config overrides needing `-c` (Codex `shell_environment_policy`), which the spec also forbids. The research already verified Copilot's flag, but V-P2 asks the question as if it were open.
EVIDENCE: SPEC §7.6: "`exec` sets that switch for secret-bearing kinds whenever one exists." §8 rules: "**Never** add arguments to the caller's command." §12.1: argv "byte-for-byte". §8.2: "accshift never adds `-c` or `--no-daemon`."

R06 §2.8: "Also pass `--secret-env-vars=COPILOT_GITHUB_TOKEN` so the agent's shell and MCP children do not inherit it. This is a VERIFIED flag". R06 §4 adapter table: "Add `--secret-env-vars=COPILOT_GITHUB_TOKEN`".

V-P2: "Does Copilot CLI remove COPILOT_GITHUB_TOKEN from tool subprocesses?" (the flag is not mentioned).
FIX: Pick one rule and state it in §7.6 and §8.

Recommended: "exec MAY prepend exactly the vendor's secret-isolation argument listed in `facts.go` (copilot: `--secret-env-vars=COPILOT_GITHUB_TOKEN`) when the caller's argv does not already contain it. This is the only exception to 'never add arguments'. It is reported in `--status-file` (`addedArgs`) and shown by LimitShift's dry-run."

Reword V-P2: "Copilot's `--secret-env-vars` exists [R06 §2.8]; verify that it removes COPILOT_GITHUB_TOKEN from shell-tool and MCP subprocesses in 1.0.93+, and whether it is still needed."

For Codex, state that V-X4's remedy cannot be applied by exec (it would need `-c`). Document it as a user config.toml setting instead.

## 9. [major] §8.5 Limits table; Appendix C.5 blocked-account row
PROBLEM: Copilot `session_quota_exceeded` is classified as `blocked-account`, which sets a sticky `needs-attention` that removes the account from rotation until `mark --clear`. That contradicts §9.4 and the research, which describe it as a user-set per-session cap. C.5 also omits two quota codes the research found.
EVIDENCE: SPEC §8.5: "`session_quota_exceeded` (a user-set cap), `billing_not_configured`, the multiple-licence error | `blocked-account`". C.5 blocked-account lists `session_quota_exceeded`. §9.4: "Not account limits (no limit record created): … Copilot `session_quota_exceeded` and `context_limit`". §11.2: `blocked` "(sets needs-attention)".

R06 §2.6: "`You've reached the spending limit for this session. Start a new session to continue.` This is a **user-set session cap**, not an account limit." R06 C11: "Do not rotate on session_quota_exceeded (a user cap)".

R06 §2.6 also lists `free_quota_exceeded` and `legacy_cap_reached` among the quota codes; C.5 omits both.
FIX: In §8.5 and C.5, move `session_quota_exceeded` to its own row: "class `error`, `rotate:false`, no state change. The caller should start a new session." Keep `billing_not_configured` and the multiple-licence error as `blocked`.

Add `free_quota_exceeded` and `legacy_cap_reached` to the C.5 limit row (monthly reset rule), marked VERIFY V-P1 until a fixture exists.

## 10. [major] §12.4 argv quoting, step 1 and the sentence "Claude Code (`claude.exe`) and agy (`agy.exe`) are native executables on Windows [R04 §0, R05 §0]"
PROBLEM: On Windows, an npm-installed Claude Code is reached through an npm cmd-shim `claude.cmd`, not `claude.exe`. The spec's shim recogniser handles only the Node/JS shim template, so every prompt-carrying launch would fall through to exit 126 `cmd-shim-unsupported`.
EVIDENCE: R04 §0: "Meta package `bin: claude -> bin/claude.exe`, postinstall `install.cjs`". npm creates `claude.cmd` in the global prefix for every bin entry, and LookPath with PATHEXT finds it.

For a target with no shebang (a native .exe), npm's cmd-shim template is `"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*`, with no `%_prog%` or node.exe probing. (This is inferred from npm cmd-shim behaviour; the research did not test a Windows npm install.)

SPEC step 1 recognises only "`\"%_prog%\" \"…\\node_modules\\…\\<entry>.js\" %*` shapes". Step 3 then fails for any prompt containing characters outside the safe set, giving exit 126.
FIX: Add to step 1: "Also recognise cmd-shim's direct-target template (`\"%dp0%\\<relative path>\" %*` with a `.exe` target and no node invocation). Resolve the target relative to the shim's directory and launch that `.exe` directly with CommandLineToArgvW quoting."

Reword the sentence: "Claude Code's binary is native (`claude.exe`), but an npm install reaches it through a `claude.cmd` shim [R04 §0]; the native installer puts `claude.exe` on PATH directly."

Add a Windows CI fixture with an npm shim that targets an exe.

## 11. [minor] Appendix C.1 limit (text) row; Appendix C.4 limit row
PROBLEM: The regexes miss vendor formats documented in the research. Claude's dated reset can carry a year. The `^` anchor fails on the raw `--output-format json` output LimitShift actually captures. Gemini's 'reset in N hours' wording is missing.
EVIDENCE: R04 §1e: past 24 h, Claude formats the reset with toLocaleString, "e.g. `Oct 9, 3pm`, with the year added if different". The C.1 reset regex has no year group.

C.1 text regex is anchored `^(You['’]ve hit your|…)`. DECISIONS D8 r5: "LimitShift uses `--output-format json`", so the text is inside `\"result\":\"You've hit…\"` on one line and `^` never matches. R04 §3 applies the `^` regex to the `result` field.

R06 §1.5 and §3: observed "Your quota will reset in 192 hours"; C.4 lists only `reset after …`, `Access resets at …` and `retryDelay`.
FIX: C.1 reset: `resets (?:(?P<mon>[A-Z][a-z]{2}) (?P<day>\d{1,2}),? (?:(?P<y>\d{4}),? )?)?(?P<h>\d{1,2})(?::(?P<m>\d{2}))?\s?(?P<ap>am|pm)(?: \((?P<tz>[^)]+)\))?`.

Add to Appendix C: "Text patterns are applied to decoded message strings (JSON `result`, `message`, `error.message`, after unescaping), and to raw lines only for text-mode output. `^` anchors refer to the decoded string."

C.4: add `reset (?:in|after) (\d+) hours?` to the reset forms.

## 12. [minor] Appendix C.1 auth/transient rows; Appendix C.2 auth and session-lost rows; Appendix C.3 auth row
PROBLEM: Appendix C includes detection strings that no research report evidences, despite §18.1's "no invented strings" rule. Some VERIFY references are also wrong or missing.
EVIDENCE: There is no research evidence for:
- C.1 `OAuth token has expired`;
- C.1 transient `api_error_status 529 / 500–504`;
- C.2 auth `401 Unauthorized`;
- C.2 session-lost `no rollout found for thread id` / `thread not found`.
(Checked by grep over research/*.md.)

§18.1: "New patterns MUST arrive with a verbatim fixture from a real session (no invented strings)".

C.2 says "(**VERIFY V-X3** exact text)", but V-X3 is "Real Codex limit transcript" and does not cover unknown-thread text. R08 open questions ask for that text separately.

C.3 auth "(**VERIFY**)" names no V-item.
FIX: Mark each unevidenced string "UNVERIFIED (no fixture)". They are not used for classification until a corpus fixture lands, or they are removed.

Add V-X5: "exact `codex exec resume <unknown id>` error text", and point C.2 session-lost at it.

Add V-A11: "agy text and AGY_ERROR for a revoked or expired login", and point C.3 auth at it.

## 13. [minor] §8.4 Limits; Appendix C.4
PROBLEM: Gemini classifications are inconsistent with the research and with the agy table. `ValidationRequiredError` is put under `auth`, which is an ambiguous strike, although the research says it needs attention. Every `TerminalQuotaError` is treated as an account limit, although that type also covers model-capacity reasons.
EVIDENCE: SPEC §8.4: "`ValidationRequiredError` (403) → `auth` with reason `needs-attention`"; C.4 lists it in the auth row. §11.2 defines `auth` as a strike and `blocked` as "sets needs-attention". R06 C5: "Treat ValidationRequiredError (403) as 'account needs attention'".

R06 §1.5 `classifyGoogleError`: `TerminalQuotaError` when the reason is "`QUOTA_EXHAUSTED`, `MODEL_CAPACITY_EXHAUSTED`, `MODEL_CAPACITY_EXCEEDED`, or `INSUFFICIENT_G1_CREDITS_BALANCE`". C.3 classes agy `MODEL_CAPACITY_EXHAUSTED` as transient. A global capacity event would cap every gemini account and return 75.
FIX: C.4: move `ValidationRequiredError` (403, reason VALIDATION_REQUIRED) to a `blocked` row (needs-attention).

Add: "`TerminalQuotaError` whose message or reason is MODEL_CAPACITY_* or 'high demand' → `transient`, matching C.3; other `TerminalQuotaError` → `limit`."

Add a V-G1 sub-item to capture both cases.

## 14. [minor] §9.6 "doctor MAY run `<cli> --version`, which is offline and touches no credentials"; §8.1 Doctor; §8.3.4 step 5
PROBLEM: The claim that `<cli> --version` is offline and credential-free is unverified for logged-in or online use, and research contradicts it for Copilot. The risk matters because LimitShift runs `doctor --json` at the start of every run (§15.7.6).
EVIDENCE: Research ran --version only with an empty HOME and no credentials (R04 §0, R05 §0, R06 §0), and Copilot only with `COPILOT_OFFLINE=true`.

R06 §0: "`copilot --version` … On first run it **self-extracts about 192 MB**". R06 §2.1: "It auto-updates into that cache unless `COPILOT_AUTO_UPDATE=false`".

R09 C3 / #95822: short-lived claude commands "start an unawaited OAuth refresh at init and `process.exit()` before saving it". The issue covers `auth status` and `--bg`; `--version` is untested.

R05 §c lists `AGY_CLI_DISABLE_AUTO_UPDATE`.
FIX: In §9.6, say "MAY run `<cli> --version` only in interactive `doctor`, never in `doctor --json` called by LimitShift, with the child environment containing `COPILOT_OFFLINE=true`, `COPILOT_AUTO_UPDATE=false` and `AGY_CLI_DISABLE_AUTO_UPDATE=1`".

Prefer reading versions from package metadata (`package.json` next to an npm shim, or the cached copilot pkg directory). Add V-C6: "does `claude --version` start an OAuth refresh for a logged-in native/login-slot account?"

## 15. [minor] §8.4 Overlay home "Copy-back after the run: `settings.json`"; §8.4 `api-key` kind
PROBLEM: R06 flags that `GEMINI_CLI_AUTH_OVERRIDE` may be persisted into `settings.json`. Copy-back would then write one account's auth type into the user's main settings. `api-key` runs use the real home directly, so they could change the user's own settings.json. The spec ignores this open question and has no VERIFY item for it.
EVIDENCE: R06 §1.2: "`GEMINI_CLI_AUTH_OVERRIDE` | Read once, then deleted from env. Sets `security.auth.selectedType` in memory, including the copy used when settings are saved (so it may persist; **INFERRED**)". R06 open question: "Also check whether GEMINI_CLI_AUTH_OVERRIDE gets persisted into the copied settings.json."

SPEC §8.4 copy-back: "settings.json only, if its hash changed and the main copy did not". `api-key` runs set `GEMINI_CLI_AUTH_OVERRIDE=gemini-api-key` in the main home.
FIX: Add V-G3: "Does `GEMINI_CLI_AUTH_OVERRIDE` get written into settings.json during a run?"

Until V-G3 passes:
- skip copy-back when `security.auth.selectedType` differs between the overlay copy and main (warn instead);
- run `api-key` accounts in an overlay home as well (copy-in settings, no copy-back), so the user's real settings.json is never the file Gemini saves into.

## 16. [minor] §8.4 Environment (extraEnv allowlist); Appendix D.1
PROBLEM: The extraEnv allowlist covers only two of the four per-account Google Cloud variables listed in the research. Inherited parent values are not scrubbed, so a Workspace project set for one account leaks into another account's runs.
EVIDENCE: R06 §1.2: "`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_CLOUD_QUOTA_PROJECT`, `GOOGLE_CLOUD_LOCATION` | Needed per account for Workspace and Code Assist Standard/Enterprise licences". SPEC D.1: "In v1 that is gemini `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`". A.4 `home` does not unset any of the four.
FIX: Allowlist all four. In A.4 `home`, add: "unset `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_CLOUD_QUOTA_PROJECT` and `GOOGLE_CLOUD_LOCATION` from the parent environment unless the account's extraEnv sets them; the set-list/extraEnv values then apply."

## 17. [minor] Appendix A.3 agy
PROBLEM: The agy scrub list ignores selector variables found in R05 §c. An enterprise-gateway or ADC setting in the parent environment would route the run to auth that the slot swap does not control.
EVIDENCE: A.3 unsets only `AGY_ADC_AUTH, GEMINI_API_KEY, GOOGLE_API_KEY, JETSKI_OAUTH_TOKEN, JETSKI_TEST_GAIA_TOKEN`.

R05 §c also lists:
- `AGY_LLM_GATEWAY_URL` / `_API_KEY` / `_HEADERS` / `_MODELS` / `_PROXY_URL` / `_CA_CERT` / `_WIRE_PROTOCOL` (enterprise gateway, `gatewayAuth` in the ChainedAuth ladder);
- `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` (ADC/Vertex);
- `GOOGLE_GEMINI_BASE_URL` (API-key endpoint).
FIX: Add to A.3: "refuse with exit 125 `agy-env-overrides-slot` (unless `--allow-settings-env`) when any `AGY_LLM_GATEWAY_*` variable is set; unset `GOOGLE_GEMINI_BASE_URL`; leave `GOOGLE_APPLICATION_CREDENTIALS` and `GOOGLE_CLOUD_*` untouched (they matter only with `AGY_ADC_AUTH`, which is unset)." Keep the variable names in agy `facts.go`.

## 18. [minor] §8.2 Overlay home ("…avoids Codex's Seatbelt `contains symlink component` rejection"); §8.2 shared allowlist
PROBLEM: The spec overstates what canonicalising CODEX_HOME achieves, and it ignores R04 C15's primary recommendation. Canonicalising fixes symlinks above the overlay, not linked children. The allowlist links children that may be sandbox-writable roots, and macOS is mandatory.
EVIDENCE: R04 C15: allow_symlinked_codex_home "only lets the macOS Seatbelt sandbox accept symlinked writable roots under CODEX_HOME"; "keep any sandbox-writable dir under CODEX_HOME per-account (unlinked), or document setting allow_symlinked_codex_home=true". R04 open question: "which dirs are writable roots?"

The allowlist links `sessions/`, `memories/`, `memories_v2/`, `worktrees/`, `skills/` and others.
FIX: Replace the clause with: "Canonicalising avoids rejections caused by symlinks *above* the overlay. Linked children can still be rejected if Codex makes them Seatbelt writable roots."

Add to V-X2: "list the writable roots under CODEX_HOME in workspace-write on macOS." Add: "on macOS, entries V-X2 identifies as writable roots are removed from the allowlist (per-account), unless the user opted into `allow_symlinked_codex_home`."

## 19. [minor] §8.2 Concurrency (same-account SHOULD)
PROBLEM: The proposed wait does not match Codex's refresh triggers, so it cannot observe the rewrite it waits for.
EVIDENCE: SPEC: "when two … runs of one codex account start while that overlay's access-token `exp` … is within 10 minutes, the second waits (at most 60 s) until `auth.json` has been rewritten." R04 C13 and §2d: refresh happens when "access token within 5 min of exp, or last_refresh older than 8 days, or on 401".

A run started 9 minutes before `exp` triggers no refresh for another 4 minutes. The 60 s wait expires, and both runs then reach the 5-minute window together. The `last_refresh` > 8 days trigger is not covered at all.
FIX: Change to: "…while `exp - now <= 5 min + 60 s` or `last_refresh` is older than 8 days − 1 h, the second waits (at most 90 s) until `auth.json`'s `last_refresh` changes. Thresholds live in codex `facts.go` [R04 §2d]."

## 20. [minor] §12.1.1 stderr rules (fixed message catalogue)
PROBLEM: Catalogue messages contain variable parts (pids, account names) that can match LimitShift's unanchored limit regexes. This defeats the R08 C3 requirement the rule exists to meet.
EVIDENCE: SPEC: "no message may match any of LimitShift's limit or auth regexes … a CI test runs the catalogue against the regexes", while messages include "held by pid N, account X" and "using claude/work".

limitshift.sh:2036–2040 and v2/lib/Cli.ps1:10–13 contain unanchored `429`, `quota`, `rate ?limit` and `usage limit`. Pid 14290 contains "429"; an account named `quota` or `ratelimit` is a valid name under §3. R08 C3: stderr is merged into the parsed output.
FIX: Remove pids from stderr messages; keep them in holder files and `doctor`.

At `add` and `rename`, reject account names that match any LimitShift limit or auth regex (exit 64, `account-name-reserved`).

The CI test must check instantiated messages using worst-case values (every digit run, every allowed name pattern), not only the templates.

## 21. [minor] §8.3 / Appendix B agy rows ("same" on macOS, "same under %USERPROFILE%" on Windows); V-A2 procedure
PROBLEM: The spec presents agy's app-data directory on macOS and Windows as fact, but the research left it open. V-A2's procedure searches only ~/.gemini, so it cannot detect a different directory.
EVIDENCE: R07 open question: "Exact agy appDataDir on each OS … (inferred ~/.gemini on Linux; macOS ~/Library and Windows %APPDATA% unconfirmed)". R07 §1: "appDataDir INFERRED `~/.gemini`". R05 verified only the linux_amd64 binary.

V-A2: "`find ~/.gemini -name '*oauth-token*'`".
FIX: Mark the macOS and Windows agy paths in Appendix B and §8.3.1 "VERIFY V-A2".

Extend V-A2: "on macOS and Windows, search the whole user profile (`find ~ -name '*oauth-token*' -newer <stamp>`, or `Get-ChildItem $env:USERPROFILE,$env:APPDATA,$env:LOCALAPPDATA -Recurse -Filter *oauth-token*`) and the location of `conversation_summaries.db`." Record the paths per OS in agy `facts.go`.

## 22. [minor] §8.3.3 C.3; §2.1 (Rust prototype claim); DECISIONS D6 and D7 (agy blob size)
PROBLEM: Some citations point to the wrong section, and some numbers are attributed to a report that does not contain them.
EVIDENCE: - §8.3.3 C.3 cites "agy clears its entry on a definitive server rejection and on /logout [R05 §b]". The statement is in R05 §d ("clears the entry on definitive server rejection (revoked account) and on `/logout`"); §b is the login flow.
- §2.1 cites "Rust's prototype needed 6 `unsafe` blocks in 383 lines [R02 §9]". The count is in R02 §2.1 ("383 lines and 6 `unsafe` sites"); DECISIONS cites §2.1 correctly.
- DECISIONS D7 says "agy snapshots are probably 2–4 KB [R05 C7]", and SPEC §7.1 says "probably 2–4 KB". DECISIONS D6 says "about 1.5–2.6 KB". R05 C7 gives no size, only "likely exceeds" 2560 B, and R07's open question says the size is unknown.
FIX: Cite R05 §d in §8.3.3 C.3, and R02 §2.1 in SPEC §2.1.

Replace both size statements with "unmeasured; R05 C7 expects it to exceed 2560 B (VERIFY V-A4)", and use the same wording in D6, D7 and §7.1.

## 23. [minor] §2.1 (Go vs Rust point 2 and point 1); §2.2; §12.5; §17.5; Appendix F; DECISIONS D1 r3, D6 r1
PROBLEM: Several INFERRED, secondary-source or wrong claims are stated as established facts.
EVIDENCE: - §2.1: "go-keyring v0.2, godbus v5 and x/sys sit under the Go 1 compatibility promise." That promise covers the Go language and standard library, not third-party modules; R01 §3.12 marks its statement INFERRED.
- §2.1: the Rust keychain crate "cannot be linked from Linux at all [R02 C2]". R02 C2 says it fails *without a macOS SDK*, and the cargo-zigbuild README says to set SDKROOT to work around it.
- §2.2: P/Invoke "looks like credential-dumping to AMSI". The R03 scorecard says "(INFERRED; not measured)".
- §12.5: "/proc/<pid>/environ is 0400". R07 §7 says "(INFERRED)".
- §17.5: "Homebrew 6 requires `brew trust j-ts/tap` [R09 C16]". C16 has medium confidence, "syntax comes from secondary summaries", and "Exact UX still to be tested".
- Appendix F quotes OpenAI's "circumvent any rate limits or restrictions". R09 §3.4 read it through a mirror: "**INFERRED** fidelity".
- DECISIONS D6 r1: "verified down to the byte on all three OSes". R05 says macOS and Windows are "VERIFIED from zalando/go-keyring source; on-device behavior to confirm".
FIX: - §2.1: change to "go-keyring, godbus and x/sys have small, slow-moving APIs (go-keyring v0.2.x, godbus v5)", and drop the compatibility-promise claim.
- §2.1: change to "cannot be linked from Linux without a macOS SDK [R02 C2]".
- Prefix the AMSI and /proc claims with "likely (unmeasured)".
- §17.5: "`brew trust j-ts/tap` per secondary summaries of the Homebrew 6 notes; confirm before documenting".
- Appendix F: link to the primary OpenAI terms and ask the owner to confirm the quoted wording before release.
- D6 r1: "verified from source and static analysis on all three OSes; on-device behaviour is V-A1/V-A3/V-A5".

## 24. [minor] §16 Phase 2 `run` (codex relaunch); §8.2 "accshift never adds `-c` or `--no-daemon`"
PROBLEM: The spec drops R04 C16's recommendation to pass `--no-daemon` for interactive runs without giving a reason. `run` relaunches the Codex TUI inside overlays, and each launch leaves a persistent app-server daemon per CODEX_HOME.
EVIDENCE: R04 C16: "The interactive Codex TUI in 0.161 auto-starts a shared app-server daemon per CODEX_HOME … Phase-2 interactive runs should pass --no-daemon." SPEC §8.2: "accshift never adds `-c` or `--no-daemon` … `remove` refuses while one runs". §16 relaunches `codex resume <id>` per account. This leaves an overlay daemon per account that blocks `remove`, and it may hold the account's auth.json concurrently with LimitShift `codex exec` runs (single-use refresh tokens, R04 C13).
FIX: In §16, add: "for codex TUI launches, `run` appends `--no-daemon` unless the caller's args already select daemon behaviour [R04 C16]; this is a documented exception for `run` only (exec still never adds args)." Alternatively, state why the daemon is acceptable, and add a V-X item checking whether the daemon refreshes auth.json while idle.

## 25. [minor] §8.5 `gh` kind; Appendix A.5
PROBLEM: For GitHub Enterprise hosts, the `gh` kind fetches a token for `--hostname <host>` but never tells Copilot which host to use. Copilot would then authenticate against github.com with a GHE token.
EVIDENCE: SPEC: `gh auth token --hostname <host> --user <login>`; A.5 never-touch/set lists do not include a host variable. R06 §2.3: "`COPILOT_GH_HOST`, `GH_HOST` | Auth and API host (GHE data residency)". R06 §4 adapter table: "Optional `COPILOT_GH_HOST`".
FIX: Add to §8.5 and A.5: "when the account's host is not `github.com`, also set `COPILOT_GH_HOST=<host>` for `token` and `gh` kinds (stored in the account record); otherwise unset an inherited `COPILOT_GH_HOST` that differs from the account's host."

# LENS: completeness
The spec is detailed and mostly coherent, but an agent implementing it would still run into real defects. One is a blocker: the normative LimitShift `next` call (§15.2 step 2, §15.3 samples) never passes `--pool`. A task pinned to one account, or limited to a pool, can therefore be switched to an account the user excluded, which is a wrong-account run.

The major defects fall into five groups:
1. **agy store resolution (§8.3.2).** It applies the Linux-only detectors on every OS. `DBUS_SESSION_BUS_ADDRESS` is always empty on macOS, so the mode resolves to `file`. When no slot holds a credential, accshift writes only a plaintext token file that agy on macOS likely never reads, and the spec's claim that "the design does not depend on" V-A3 is false.
2. **Exit codes.** The exit-code contract contradicts itself: Appendix E assigns 73, 74 and 75 to `exec`, and there is no general rule that maps exec's own 64/73/74/78 failures to 125. The §9.3 "pool contains only A → 69" rule can never fire, and the portability enum has an unmapped `possible` value.
3. **LimitShift integration.**
   - The v2 auth branch counts each strike twice.
   - `mark --ok` is never called, so strikes and backoffs persist for 24 h.
   - The `lim` value passed to `next` is LimitShift's 30-minute default guess, recorded as tier-2 evidence.
   - exec error codes never reach LimitShift: there is no `--status-file` in the wrappers and no defined stderr format. As a result, keystore fallback can't be detected and slot-busy burns retries.
   - "Caller is LimitShift" non-interactive detection is undefined. Combined with the interactive prompt inside `exec agy`, this can hang a queue in a hidden Windows console.
4. **Missing behaviour.**
   - `remove`/`rename` of the agy account currently in the slot.
   - Whether `exec --account` refuses disabled, needs-relogin or missing-secret accounts.
   - The merge-rule ordering for the `"user"` tier.
   - Storage and enforcement of the provider-terms opt-in gate.
   - A config key namespace and Settings schema.
   - Many flags that are used but never defined, including the whole copilot add flow and the gh host.
5. **Planning, verification and dependencies.**
   - Milestones are inconsistent: the v0.1 installers call `self-update --record-install`, which isn't built until M7. Windows exec is unassigned, V-A7 is missing from M0, and V-K2, V-X3, V-C5, V-X4 and V-L1 are unassigned.
   - Several VERIFY claims have no §22 item.
   - The go-keyring dependency row contradicts §7.4's `security` rules.

The minor issues:
- **§2.1 "why Go".** The conclusion stands, but some claims are overstated or wrong: the Go 1 compatibility promise does not cover go-keyring v0.2 or godbus; the Security.framework point is not a Rust-specific problem; the byte-compatibility argument is overstated; and one citation is wrong.
- **Efficiency targets.** The figures are inconsistent across G3, NFR1, NFR2 and §18.4.
- **Undefined or incomplete specifics:**
  - commands documented as read-only still rename, migrate or chmod files;
  - several contract response shapes and exit codes are missing;
  - "control verb" is never defined;
  - Go's `flag` package stops at the first positional argument;
  - Claude's slug algorithm and the agy log path are missing from the spec;
  - the macOS `proc_pidpath` call needs cgo;
  - the Codex same-account stagger cannot be implemented on the execve path;
  - status-file and post-run failure handling are unspecified;
  - `add agy` has no signal handling.

All four owner requirements are addressed in principle: macOS and Linux are release-blocking, the app is separate, it is efficient, and it has no ai-switcher or agm dependency. In practice, the agy macOS defect and the integration defects above would stop the macOS path and LimitShift use from working as the owner intends.

## 1. [blocker] §15.2 Rotation order step 2; §15.3 Hook points (bash, ps1 and v2 limit branches); §15.4 accounts key
PROBLEM: The normative `next` call that LimitShift makes never passes `--pool`, so accshift picks from every enabled account of the CLI. It ignores a runner's `accounts` pool, and a one-name pin as well. The result is a wrong-account run on an account the user excluded.
EVIDENCE: §15.2 step 2: "`accshift next <cli> --from A --model M --limited-until <reset LimitShift parsed> --evidence-file <run output> --exit N [--session ID --cwd DIR]`. Every flag except `--from` is optional." §15.3 bash: `acct_call next "$cli" --from "$ACCT_CURRENT" --limited-until "$lim"` (no pool); the ps1 branches "mirror the bash ones"; the v2 bullet says only "call `next`". Only the `pick` sample has `[--pool a,b]`. §15.4: "one name = pin the runner to that account; several names = a pool in preference order (passed as --pool)". §9.3: "Candidates are the accounts in --pool order, or registry order when no pool is given." Example: a task with `accounts:["work"]` hits a limit, and `next` returns `home` or any third registered account.
FIX: In §15.2 step 2 and in every §15.3 `pick`/`next`/`mark` sample (bash, ps1, v2), add: "LimitShift MUST pass `--pool <a,b,…>` (the runner's `accounts` array, comma-joined, in order) to every `pick`, `next` and `mark` call for a runner whose `accounts` is an array, including a one-element array. For a pinned runner, `next` then returns 75/77 and never another account." Add §15.10 scenarios: "pinned runner never runs on another account after a limit" and "pool [a,b] never selects c".

## 2. [major] §8.3.2 Which slot agy will read; §5.2 agy run step 1; §8.3.3 A.4/B.6
PROBLEM: agy's keyring-bypass detectors, which are verified only on Linux, are applied on every OS. `DBUS_SESSION_BUS_ADDRESS` is never set on macOS (or Windows), so the resolved mode is always `file` there. When no slot holds a credential (the first run after `add agy`, or after a refresh-dead clear), accshift writes only a plaintext token file, while agy on macOS reads the keychain and starts signed out. The claim that the design does not depend on V-A3 is therefore false. The two fast-path definitions also differ, so on a Mac B.6 rewrites slots and creates an unmaintained plaintext refresh-token copy where the vendor uses the keychain.
EVIDENCE: §8.3.2: "Mode is file only when accshift can be sure agy will not use the keyring: one of agy's detectors fires…: DBUS_SESSION_BUS_ADDRESS is empty" and "Whether the detectors fire on macOS and Windows is VERIFY V-A3. The design does not depend on it, because of the write set below." Write set = "the resolved slot plus every other reachable slot that currently holds an agy credential". R05 C3 verified the detectors only "On Linux". R05 'Detect first': "on macOS/Linux-desktop, keyring". R07: "Same detector strings appear in the macOS and Windows builds (whether they fire there is open)". §5.2 step 1 fast path: "every slot that holds a credential already carries b's email"; §8.3.2 and B.6: "every slot in the write set already holds the requested account", where the write set includes the possibly empty resolved slot. A signed-out agy run then produces auth errors, and LimitShift's `next --reason auth` strikes every account in turn.
FIX: Rewrite §8.3.2's detector list per OS:
- "Linux: the detectors below."
- "macOS and Windows: until V-A3 is recorded in facts.go for that OS and agy version, the resolved slot is the store recorded at `add agy` step 5 for this agy version (default: the keychain on macOS; Credential Manager on Windows unless the blob exceeds 2560 B). A file candidate joins the write set only if it already holds a credential. accshift MUST NOT create a new token file on macOS."

Delete "The design does not depend on it". Use one fast-path definition in §5.2, A.4 and B.6: "the resolved slot holds a credential and every slot in the write set that holds a credential carries the requested email." Add a §18.2 case: macOS environment with empty slots → the keychain item is written and no file is created.

## 3. [major] §7.5 Non-interactive guarantees; §8.3.3 B.5; §12.1 Contract; §15.3
PROBLEM: One of the three non-interactive triggers, "the caller is LimitShift", has no detection mechanism. Meanwhile `exec agy` contains an interactive prompt (B.5) even though exec must never read stdin. Under limitshift.ps1, agy is launched with CreateNoWindow, so the child's stdin is a hidden-console handle that Go's terminal check reports as a TTY. exec would then prompt in an invisible console and the unattended queue would hang, violating G7.
EVIDENCE: §7.5: "accshift is non-interactive when stdin is not a TTY, when ACCSHIFT_NONINTERACTIVE=1, or when the caller is LimitShift." Nothing defines how the last condition is detected, and §15.3 sets no variable. B.5: "Interactive: ask whether to register it now … or abort." §12.1: "exec MUST NOT read, buffer or close stdin". §12.4: "When LimitShift starts accshift with CreateNoWindow (its agy path), the child inherits that hidden console." LimitShift's `pick`/`next`/`doctor` calls also inherit the user's terminal.
FIX: In §7.5, replace "or when the caller is LimitShift" with "or when ACCSHIFT_NONINTERACTIVE=1, which LimitShift MUST export for every accshift invocation". Add `export ACCSHIFT_NONINTERACTIVE=1` and `$env:ACCSHIFT_NONINTERACTIVE='1'` to §15.3 discovery. Add to §12.1: "exec and run never prompt. Any condition that would need input takes the non-interactive branch (B.5 → 125 agy-slot-unregistered)." Keep the interactive B.5 branch only for `agy use` and `add agy`.

## 4. [major] §15.3 v2 engine auth branch vs §15.2 step 5 and §9.2/§9.3
PROBLEM: The v2 auth branch calls `mark --auth-failed` and then `next`, which double-counts a single 401. With `--reason auth`, the second strike makes the account sticky `needs-relogin` at once. Without it, `next` also records a bogus limit with a 30-minute unknown-reset backoff.
EVIDENCE: §15.3: "Auth branch (`:578-582`): `mark --auth-failed`, then `next`." §15.2 step 5: "`accshift next <cli> --from A --reason auth`". §9.3: next "records A's limit or auth strike … in the same locked transaction". §9.2: "the first strike → limited auth-suspect for 15 minutes; a second strike within 24 h → needs-relogin". The default for `--reason` is never stated.
FIX: Replace the v2 bullet with: "Auth branch: call only `next <cli> --from $acct --reason auth [--pool …] --json`; it records the strike and selects in one transaction. Call Set-V2AuthDeadCli only when it returns 69 or 77." Add to §9.3: "`--reason` defaults to `limit`." Add a §15.10 scenario: a single 401 leaves the account `limited/auth-suspect`, not `needs-relogin`.

## 5. [major] §9.2 Auth transitions / §9.4 backoff vs §15.2–§15.3
PROBLEM: Success is reported only through `mark --ok`, and the LimitShift integration never calls it. On POSIX, claude, codex and copilot use execve and report nothing either. Strike and backoff counters therefore survive successful runs for 24 h. Two unrelated transient 401s within a day make an account sticky `needs-relogin`, unknown-reset backoff keeps doubling to 300 min, and `lastUsedAt` goes stale.
EVIDENCE: §9.2: "Success is reported only by the caller (`mark --ok`), or by exec on the spawn path. On POSIX exec is execve and cannot see the exit status… Without it, counters reset after 24 h with no new hits." §9.4: "Counters reset on mark --ok, or after 24 h without re-hits." §12.3: "On this path lastUsedAt is not recorded; next and mark --ok update it." No `mark --ok` appears anywhere in §15.
FIX: Add §15.2 step 6, and matching lines to all three §15.3 samples: "After every run on an accshift-managed runner that LimitShift does not classify as a limit or auth failure, LimitShift calls `accshift mark <cli> --account A --ok [--pool …] --json`, ignores its exit status, and never blocks on it." Add a §15.10 scenario: "auth-suspect, then a successful run → strikes reset; a later 401 is again a first strike."

## 6. [major] §15.3 bash single-runner limit branch (`lim=$(get_runner_reset_epoch ...)`); §15.2 step 2
PROBLEM: The sample passes LimitShift's fallback guess as caller evidence. `get_runner_reset_epoch` returns now+limitWaitMinutes when nothing was parsed, and for claude it also runs the forbidden `/usage` probe. accshift records that guess as tier-2 evidence with confidence `parsed`, so its tier-1 doubling backoff never applies. The sample also omits `--evidence-file`, `--exit` and `--model`, which §15.2 needs for scope detection.
EVIDENCE: §15.3: `lim=$(get_runner_reset_epoch ...)  # parsed reset only; no /usage probe for managed runners (§15.6)`. LimitShift v1 limitshift.sh:1551-1567: get_runner_reset_epoch calls get_claude_usage_reset_epoch for claude, then `get_conservative_reset_epoch "$parsed" "" "$wait_mins"`, which falls back to settings.limitWaitMinutes. §9.4: "2, text | the caller's --limited-until"; "1, default | unknown reset: backoff". §15.2 step 1 needs the scope from `--evidence-file`/`classify` to skip models after an account-wide limit.
FIX: Replace the sample with:

```bash
parse_reset_from_error "$error_text"
args=(next "$cli" --from "$ACCT_CURRENT" --model "$model" --evidence-file "$out_file" --exit "$exit_code" --json)
[ -n "$pool" ] && args+=(--pool "$pool")
[ -n "$R_RESET" ] && args+=(--limited-until "$R_RESET")
```

Add to §15.2: "LimitShift passes `--limited-until` only for a reset it parsed from the run output, never its limitWaitMinutes default or a /usage value." Apply the same to ps1 and v2.

## 7. [major] §15.2 step 3 (keystore-unavailable fallback); §12.1.1 --status-file and stderr rules; §15.3 wrappers; Appendix E row 125
PROBLEM: The integration has no reliable way to read exec's `error.code`. The wrappers don't pass `--status-file`, and the stderr line format that carries the code is undefined. So the keystore-unavailable legacy fallback can't be implemented. `slot-busy` and `agy-busy`, which are normal with parallel queues (default `--slot-wait` is 30 s while an exclusive hold lasts a whole agy run), are charged to the retry budget and fail tasks.
EVIDENCE: §15.2: "`exec` exit 125 with `keystore-unavailable`, from `--status-file` or the `accshift: keystore-unavailable` stderr line, switches that runner to legacy mode". §12.1.1: "--status-file PATH (SHOULD)"; stderr "comes from a fixed message catalogue", but no format includes the code. §15.3 wrappers: `CLI_ARGS=(exec "$CLI_EXE" --account "$ACCT_CURRENT" -- …)` and `@('exec', $exe, '--account', $script:AcctCurrent, '--')`, neither with `--status-file`. Appendix E 125: "treat as CLI error charged to the retry budget". §13.1: "Several LimitShift queues MAY run in parallel… agy runs serialize on the slot."
FIX: 1. Make `--status-file` a MUST and add `--status-file "<sessions>/task-NN[-runner-K]-acct-status.json"` to all three wrappers. LimitShift reads it after every managed run.
2. Define the stderr format in §12.1.1: "each pre-launch failure prints exactly one line `accshift: error <code>: <message>`".
3. Specify the LimitShift action per code:
   - `keystore-unavailable` / `agy-keyring-locked` → legacy mode for that runner;
   - `slot-busy` / `agy-busy` / `state-busy` → wait 60 s and relaunch without charging the retry budget (bounded by maxRunsPerTask);
   - `needs-relogin` / `unknown-account` / `account-disabled` → clear ACCT_CURRENT and re-`pick`.

## 8. [major] §10.2 remove/rename; §8.3.4 Add, login and use; §13.1
PROBLEM: The spec does not say what happens to agy's slot when the registered account currently in it is removed or renamed. After `remove agy a` while a is live, the slot holds an email no account has, so every later non-interactive `exec agy` fails with 125 agy-slot-unregistered until a human acts. `rename` leaves several stale references: `state.agySlot.owner`, `settings.agyRestoreAfterRun`, the secretIds of an in-flight journal, and LimitShift's persisted per-task account files. `pick --prefer <old>` behaviour is undefined.
EVIDENCE: §10.2 remove: "delete the account and its secret / overlay home"; rename "changes only the registry name, the vault secretId and the state key". §13.1 lists `remove` under the exclusive agy lock but gives no slot behaviour. B.5: "If any slot holds a credential for an email that no agy account has… Non-interactive: refuse… exec exit 125 agy-slot-unregistered". §15.5: "sessions/task-NN-account.txt" is fed to `pick --prefer`.
FIX: Add to §8.3.4: "`remove agy X` runs B.1–B.3. If any slot holds X's email, it refuses with 65 `agy-account-live` and the hint `accshift agy use <other>`, unless `--sign-out-slot` is given. That flag journals the slot content, deletes those slots, and parks the bytes as agy/_unregistered/<email>." Add to §10.2 rename: "also rewrites state.agySlot.owner and settings.agyRestoreAfterRun; refuses while journal/agy-swap.json exists." Add to §9.3: "a `--prefer` naming an unknown, disabled or out-of-pool account is ignored, not an error, and reported as `preferIgnored:true`."

## 9. [major] §12.1 Contract (With --account) vs §12.1.1 needs-relogin
PROBLEM: Which account states make `exec --account` refuse is undefined. §12.1 says exec runs the named account whatever its state, yet the 125 table has `needs-relogin`, and disabled, needs-attention, missing-secret and expired-token cases are unspecified. Because LimitShift keeps ACCT_CURRENT across runs and re-picks only when it is empty, state changes made by other queues or by the user reach this path.
EVIDENCE: §12.1: "it runs exactly that account, even if accshift believes it is limited (the caller decides)". §12.1.1: "needs-relogin | the account needs a human". §9.2 needs-relogin reasons: `rejected`, `refresh-dead`, `expired`, `missing`. §15.3: "before each run…, when ACCT_CURRENT is empty: acct_call pick".
FIX: Add a table to §12.1. With `--account`:

| State | exec behaviour |
|---|---|
| `limited`, `needs-attention`, `needs-relogin` (reason `rejected`/`refresh-dead`) | run |
| `needs-relogin` (reason `missing`, i.e. no vault entry or overlay auth file, or `expired`, i.e. past `expiresAt`) | 125 `needs-relogin` |
| `disabled` | 125 `account-disabled` (add the code to §12.1.1 and Appendix E) |

Without `--account`: the pick rules apply.

## 10. [major] §12.1.1 exec's own failures; §6.1; §6.4; §7.2; §12.2; §13.1
PROBLEM: There is no general rule mapping exec's own failures to 125. Several conditions that the spec assigns to 64, 73, 74 or 78 can occur inside `exec`, and those numbers collide with the child CLI's own exit codes. LimitShift would read them as a CLI result.
EVIDENCE: §6.1: "a relative one is a usage error (64)"; `wrong-owner` and `unsupported-filesystem` exit 78. §6.4: corrupt or newer files exit 78. §7.2: `vault-corrupt` exits 78 and `vault-changed` exits 74. §12.2: a relative BIN "is a usage error (64)". §13.1: vault.lock "15 s, then exit 73". §10.3: 64 covers an "unknown cli". The §12.1.1 125 table is closed and contains none of these. Appendix E: "1–124 | child exit | exec, run | normal CLI result handling".
FIX: Add to §12.1.1: "For exec and run, every failure before launch exits 125, whatever code a control verb would use for the same condition (64, 65, 69, 73, 74, 77, 78)." Extend the error.code list with `usage`, `unknown-cli`, `unsupported-cli`, `wrong-owner`, `unsupported-filesystem`, `config-corrupt`, `config-newer-version`, `vault-corrupt`, `vault-changed`, `vault-busy` and `account-disabled`. Amend §6.1 and §12.2 to read "(64; 125 for exec/run)".

## 11. [major] Appendix E (rows 73, 74, 75) vs §12.1.1 / §13.1 / §12.1
PROBLEM: Appendix E lists `exec` as a command for exit codes 73, 74 and 75, contradicting the rule that exec uses only 125, 126 and 127 for its own failures.
EVIDENCE: Appendix E: "73 | BUSY | exec (slot wait), any (state.lock wait)"; "74 | … | any command needing a secret (exec for token kinds, add, …)"; "75 | TEMPFAIL | pick, next, exec (when picking)". §12.1.1: "Only 125, 126 and 127 are reserved… The control verbs use 73, 74, 75 and 77 for these situations instead. exec cannot". §13.1: "then exec exits 125 (slot-busy)". §12.1: "on 75 or 77 it exits 125 with error.code all-capped or needs-relogin".
FIX: Remove `exec` from Appendix E rows 73, 74 and 75 (75 becomes "pick, next, run"). Add under the table: "exec never exits 64–78 for its own failures; see §12.1.1."

## 12. [major] §9.3 When no candidate is usable
PROBLEM: Rule 3's "pool contains only A → 69" can never fire. `next` always records A's limit, or an auth-suspect strike, which is also time-limited, before it selects, so rule 1 ("including A") always returns 75 first. An implementer must guess which outcome is intended, and the §18.1 table tests are ambiguous.
EVIDENCE: §9.3 rule 1: "If any candidate is time-limited, including A, return exit 75". Rule 3: "Otherwise (pool empty, all disabled, cli unsupported, or the pool contains only A) → exit 69, after A's limit has been recorded." §9.2: the auth-suspect strike → `limited` for 15 minutes.
FIX: Delete "or the pool contains only A" from rule 3 and append to rule 1: "This includes a pool whose only usable member is A: next returns 75 with account=A and A's reset." Mirror this in §15.2 step 3 and add an engine table test.

## 13. [major] §3 Glossary (session portability); §8 Adapter interface; §8.2 Session portability
PROBLEM: The portability enum has five values in the adapter interface but only four in the glossary. `possible` has no `sessionPortable` mapping. The codex rule "returning to the account that created the thread → yes" cannot be implemented, because no state records which account created a session.
EVIDENCE: §3: "`yes`, `likely`, `unlikely` or `no`"; "sessionPortable: … true for yes and likely". §8: `Portability(from, to Account) Portability // yes | likely | possible | unlikely | no`. §8.2: "the same workspace account → possible; returning to the account that created the thread → yes. LimitShift MAY resume it then." The state.json schemas (§6.3, D.2) have no session→account field, and the use of `next --session` for this is not specified.
FIX: Add `possible` to §3: "sessionPortable is true for yes and likely; false for possible, unlikely and no." Then either drop the `yes` case for codex in v1, or add state.json `sessions: {"<cli>/<sessionId>": {account, createdAt}}`, written by `next`/`mark` when `--session` is given and pruned after 30 days, with "next --session ID reports yes when the chosen account equals sessions[ID].account". State that capabilities.sessionPortable is only the default and that next/pick report per move.

## 14. [major] §19.2 Dependencies (go-keyring row) vs §7.4 / §8.3.1
PROBLEM: The dependency table says go-keyring reads and writes agy's slot on macOS, but go-keyring cannot produce the `security` invocation §7.4 requires. It passes no explicit keychain and no `-T`, has no context or timeout (so a timed-out `security` child can't be killed), and doesn't expose the exit statuses that the fail-closed locked-keychain rule depends on.
EVIDENCE: §19.2: "github.com/zalando/go-keyring | MIT | only to read and write agy's slot byte-compatibly on macOS and Windows, inside timeouts". §7.4: "Every security invocation, including each -i line, ends with an explicit keychain path"; slot write "add-generic-password -U -s gemini -a antigravity -T /usr/bin/security -w go-keyring-base64:<…> <keychain>"; exit 36/37/44/45/50/51 mapping; "On timeout accshift kills the security child". R07 (go-keyring v0.2.8): Set pipes "add-generic-password -U -s %s -a %s -w %s". R07 C5: no timeout; gh wraps it in goroutine timeouts, which cannot kill the child process.
FIX: Rewrite the row: "go-keyring: not used at runtime. On macOS accshift drives /usr/bin/security itself with exec.CommandContext (§7.4). On Windows it calls danieljoos/wincred (or x/sys CredWriteW/CredReadW) directly with the §8.3.1 attributes. go-keyring's encodings are reproduced in agy/facts.go." Drop go-keyring from the allowed set, or mark it test-only for byte-compatibility fixtures.

## 15. [major] §9.1 Record fields, §9.4 merge rule, §10.2 mark, Appendix D.2
PROBLEM: The `user` tier is a string in a field that is otherwise an integer, and the merge rule (`newTier >= oldTier`) has no defined ordering against it. `mark` semantics are also incomplete: the scope written by `--override` and `--limited-until`, and what `--clear` resets, are undefined. The pure engine and its table tests can't be written without guessing.
EVIDENCE: §9.1: "tier (3, 2 or 1, see §9.4)". D.2: `tier:1|2|3|"user"`. §9.4: "user | mark --override --limited-until T replaces any record unconditionally"; "a new record replaces the active record … iff newTier >= oldTier or newUntil > oldUntil". §9.2: `mark --clear` clears limited, needs-relogin and needs-attention, without saying which records or counters.
FIX: In §9.1/D.2: "tier is an integer: 1 default, 2 text/caller, 3 structured, 4 user (limitSource \"user\"). A tier-4 record is replaced only by another `mark --override` or by `mark --clear`." In §10.2: "`mark --limited-until` and `--override` write scope `model:<bucket(M)>` when --model M is given, else `account`. `mark --clear` removes all records, authStrikes, lastStrikeAt, attentionCode, hits and early-rehit backoff for the account; `--clear --model M` removes only that bucket's record. A past expiresAt still yields needs-relogin."

## 16. [major] §20.4 Provider terms; §8.1 add step 2; D.1/D.2
PROBLEM: The opt-in gate ("nothing rotates until … accepted the notice") has nowhere to be stored and no point where it is enforced. Several add paths never show the notice, and a hand-edited registry bypasses it entirely. This undermines the owner's personal/educational positioning.
EVIDENCE: §20.4: "Account rotation is opt-in: nothing rotates until the user has registered at least two accounts and accepted the notice." §8.1: "Show the provider notice once per machine (Appendix F), requiring y or --accept-notice." No acceptance field exists in D.1 or D.2. §9.3 pick/next never check it. §6.2: "Users MAY edit it by hand". §8.4 gemini add, §8.5 copilot, `--native` and `--capture-current` never mention the notice.
FIX: Add state.json `notice: {acceptedAt, version}`. Every `add` (all clis and kinds, including --native and --capture-current) shows Appendix F when it is unset or the version is older. Until it is set, `pick` and `next`, and `exec` without --account, return 69 with `error.code notice-not-accepted` (`exec --account` still runs). `doctor` reports it.

## 17. [major] §10.2 config; §8.2 Homes/shareExtra; §9.1 buckets; §12.2; §9.4; Appendix D.1
PROBLEM: There is no config key namespace and no Settings schema. Keys are addressed three different ways, several referenced keys have no place in the D.1 schema, and settings are called per-cli but are modelled as global. The "validate on every load" rule can't be implemented without inventing a schema.
EVIDENCE: §8.2: "accshift config codex.mainHome <dir>". §12.2: "config clis.<cli>.bin". §9.1: "config <cli>.buckets.<model> <bucket>". §8.2: "a user-configurable codex.shareExtra list". D.1 has `clis:{<cli>:{mainHome?, mainSqliteHome?, accounts}}` and `settings:Settings`, with Settings never enumerated (only "also includes agyRestoreAfterRun?, agyAllowNetworkHome?"). §9.4: "all configurable per cli in settings". NFR5: timeouts "by default" with no key. §17.7: an update check "at most once a day" with no stored timestamp.
FIX: Add to D.1:

```
clis.<cli>: {mainHome?, mainSqliteHome?, bin?, buckets?: {<model>: <bucket>}, shareExtra?: [name], settings?: Settings}

Settings: {minCooldownSeconds=60, unknownResetBackoffMinutes:{start=30,max=300},
           earlyRehitBackoffMinutes:{start=5,max=60}, authSuspectMinutes=15,
           slotWaitSeconds=30, updateCheck:"off"|"daily"="off",
           agyRestoreAfterRun?, agyAllowNetworkHome=false,
           keystoreProbeSeconds=3, keystoreOpSeconds=10}
```

`clis.<cli>.settings` overrides the global settings. Define `config` keys as dotted paths from the registry root (`clis.codex.mainHome`, `clis.claude.bin`, `clis.claude.buckets.<model>`, `settings.<key>`) and fix the §8.2 and §9.1 examples. Store `updateCheckedAt` in state.json.

## 18. [major] §10.1 / §10.2 command table; §8.5 copilot
PROBLEM: Many flags are used in the spec but never defined, and copilot has no add flow. The `gh` kind needs a host and a login at exec time, but no flag supplies them and the schema has no host field.
EVIDENCE: Used but not defined in §10:
- `--verbose` (§12.1.1)
- `--yes` (§10.1)
- `add --replace` (§9.2)
- `--key-source` (§7.3)
- `doctor --fix` (§8.2)
- `status --history` (§6.1, §9.6)
- `run --wait` (§16)
- `--accept-notice`, `--label`, `--force`, `--kind`, `--native`, `--experimental` (§8.1)
- `--capture-current` (§8.3.4)
- `--browser`, `--import-home` (§8.2)
- `--expires` (§8.5)
- `self-update --record-install/--path/--version/--allow-downgrade` (§17.7)

§8.5 gh kind: "run `gh auth token --hostname <host> --user <login>`". There is no Add subsection, and D.1 identity has `login?` but no host. `login` for `native` accounts is undefined.
FIX: Add §10.4 "Flags per command", listing every flag with its type and default. Delete `--verbose` (use `--debug`) or define it. Replace `add --replace` in §9.2 with `login`.

Add a §8.5 "Add" subsection:
- syntax: `add copilot <name> [--kind token|gh|native] [--label L] [--expires DATE] [--token-stdin] [--gh-user LOGIN] [--gh-host HOST=github.com]`;
- store `identity.login` and a new `identity.host`;
- validate that `gh auth status --hostname HOST` lists LOGIN, with no token printed.

State: "`login` on a native account exits 64 with the vendor's own login command as the hint."

## 19. [major] §21 Milestones and acceptance criteria
PROBLEM: The milestones contradict other sections, leave §22 items unscheduled, and have untestable exit criteria. The v0.1 installers call a subcommand that isn't built until M7. Windows exec is never assigned, even though Windows CI runs contract tests from M1. M0 omits V-A7 although §8.3.6 places it there.
EVIDENCE: §17.5: "GitHub Releases + install.sh / install.ps1 | v0.1". §17.6: installers "run `<bin>/accshift self-update --record-install script --path <bin>`". M1 publishes v0.1.0, but "self-update" is in M7. M2 says "exec (execve path)", yet Windows has no execve (§12.4) and §18.4 runs contract tests on all six runners on every push. §8.3.6: "One-shot probes in M0 (V-A7)", but the M0 list is "V-C1, V-C2, V-C4, V-X1, V-X2, V-A1…V-A6, V-A8, V-A10".

Unscheduled V-items:
- V-K2 (decides the Linux default key source);
- V-X3 (the codex corpus; §18.1 requires verbatim fixtures);
- V-C3;
- V-C5, V-X4, V-G2 and V-P2 (they decide exec's strip switch, §7.6);
- V-L1.

M0's "V-W*" includes V-W2, which needs signed builds that don't exist before M7. `vault migrate/export/import` are in no milestone. "crash tests pass", "docs complete" and "real-account acceptance" are not testable.
FIX: Milestone scope:
- **M1:** add "`self-update --record-install` (offline), install.sh, install.ps1, vault status/migrate".
- **M2:** add "exec on Windows: spawn path, job object, native .exe launch".
- **M3:** add "npm cmd-shim resolution".
- **M7:** networked self-update.

V-items:
- M0: add V-A7, V-K2, V-C3, V-C5, V-X3 and V-X4; move V-W2 out to M7.
- M5: add V-L1.
- M6: add V-G1, V-G2, V-P1 and V-P2.

Replace the vague criteria with testable ones:
- "crash tests = the §18.2 SIGKILL matrix green on all 6 runners";
- "real-account acceptance = the milestone's V-rows in docs/acceptance.md marked pass with vendor versions";
- "docs complete = README, SECURITY.md containing the §7.6 text, the Appendix F notice and AGENTS.md exist and pass the link check".

## 20. [major] §22 Verification checklist (missing items); Appendix C.3; §12.4 step 2; §8.4
PROBLEM: Several claims marked VERIFY or "to verify", or otherwise unverified, have no §22 item, so they are never settled. The agy auth signals are marked **VERIFY** with no ID, and §18.1 forbids invented patterns. As a result `classify agy` can never return `auth`, and LimitShift step 5 never rotates on an agy auth failure.
EVIDENCE: Appendix C.3: "auth | definitive server rejection / revoked messages (**VERIFY**)", with no V-ID. §18.1: "New patterns MUST arrive with a verbatim fixture from a real session (no invented strings)". §12.4 step 2: "The Codex launcher is understood to prepend its vendored ripgrep directory to PATH and set CODEX_MANAGED_BY_NPM (to verify)". This decides the Windows codex launch path and has no V-item. §8.4's gemini overlay (GEMINI_CLI_HOME relocation, linked tmp/history/… directories, GEMINI_CLI_AUTH_OVERRIDE, GEMINI_CLI_TRUSTED_FOLDERS_PATH) has no V-X2 equivalent. §8.5's `gh auth token --user` depends on gh's multi-account support version, which is unverified.
FIX: Add to §22:
- "V-A11: agy auth-failure texts and exit status in -p mode (revoked, expired, disabled account); save to the corpus | Appendix C.3";
- "V-X5: Windows: does Codex's npm JS launcher change env (PATH, CODEX_MANAGED_BY_NPM)? Diff the native child's environment | §12.4 step 2";
- "V-G3: Gemini overlay layout works for login, -p and --resume on all three OSes | §8.4";
- "V-P3: minimum gh version supporting `auth token --user` | §8.5".

Assign them to M0, M3 and M6.

## 21. [minor] §8.3.1 V-A8 result row; §8.3.3 A; §8.3.4 step 5; Appendix D.1
PROBLEM: Shared mode and the slot facts are keyed by agy version, but nothing says how `exec` learns the installed agy version. `add` records the slot and `agy --version`, but D.1 has no fields to hold them.
EVIDENCE: §8.3.1: "V-A8 result | per OS and agy version". §8.3.3 A: "only when V-A8 has passed for this OS and agy version". §8.3.4 step 5: "record which slot and path this agy version used, together with `agy --version`". The D.1 Account has no such fields.
FIX: Add to §8.3.1: "exec identifies the agy version from the resolved binary's realpath, size and mtime, cached in state.json `agyBinary:{path,size,mtime,version}`. On a cache miss it runs `agy --version` once with a 2 s timeout. An unknown version counts as V-A8 not passed." Add D.1 `agySlotUsed?: {store, path, agyVersion}` on agy accounts.

## 22. [minor] §2.1 Why Go (points 2, 3 and the Security.framework bullet; 'What would flip it')
PROBLEM: Parts of the "why Go and not Rust" answer are overstated or wrong, and the answer to the pwsh+bash question omits a relevant flip condition. The conclusion still stands, but the owner explicitly asked for this answer.
EVIDENCE: §2.1: "go-keyring v0.2, godbus v5 and x/sys sit under the Go 1 compatibility promise." That promise covers the language and standard library only, and go-keyring v0.2 is a pre-v1 module. R01 rates this INFERRED and lists "VERIFIED churn: macOS minimum bumped to 13 in 1.27, encoding/json moved to the v2 backend". "The Rust crate that talks to the macOS keychain (Security.framework) cannot be linked from Linux at all [R02 C2]": R02 C2's own recommendation is "spawn /usr/bin/security", which is exactly what this spec does in Go (§7.4); R01 C8 shows Go's native keychain libraries have the same problem. Point 3 says "reproduces agy's … items exactly", but the spec re-implements Linux Secret Service with its own godbus code and macOS with its own `security -i` lines, which Rust could do equally. DECISIONS D1 reason 4 notes the judges weighted this lower because agy uses its file fallback headless; §2.1 omits that caveat. Citations: "6 unsafe blocks in 383 lines [R02 §9]" is in R02 §2.1 (line 95); binary sizes cite "R01 §2.1" (cross-compilation) instead of §2.2. The 'flip' list omits DECISIONS D1's "Scope shrinks to env-only claude/codex rotation inside LimitShift → small sh + pwsh functions, with no separate app" and the macOS 12 item.
FIX: Replace the item 2 bullet with: "Go's standard library and toolchain are covered by the Go 1 compatibility promise. The third-party credential modules (go-keyring v0.2, godbus v5) have had fewer breaking releases than Rust's keyring and zbus crates, but carry no formal guarantee." Delete the Security.framework bullet, or reword it: "both languages must drive /usr/bin/security on macOS to cross-build from Linux (R01 C8, R02 C2)". Add to item 3: "weighted lower by the judges: accshift re-implements the formats itself and agy often uses its file fallback [R07 C2]". Fix the citations to R02 §2.1 and R01 §2.2. Add the DECISIONS D1 "scope shrinks" and macOS 12 conditions to 'What would flip it'.

## 23. [minor] §1.2 G3; §1.4 NFR1, NFR2; §18.4 CI gates
PROBLEM: The efficiency targets are inconsistent, and some of NFR1's MUSTs are not measured. The exec SHOULD for claude can't be met with the default `token` kind on a macOS keychain vault.
EVIDENCE: G3: "about 20 ms or less overhead per call". NFR1: "under 50 ms cold"; "Commands that touch the vault MUST finish in under 150 ms"; "exec overhead … SHOULD be under 30 ms for claude and codex". The claude `token` kind always fetches the vault key, a `/usr/bin/security` exec. G3: "about 5 MB or less"; NFR2: "under 6 MB each before compression"; §18.4: "at most 6 MB uncompressed and 3 MB compressed per target (NFR2)", although NFR2 has no compressed limit. §18.4 measures only `version`, `pick`, `next` and `status --json`, not list, mark, classify, the 150 ms vault commands or exec overhead.
FIX: Set G3 to "≤50 ms per control call, no daemon". NFR1 exec: "SHOULD be under 30 ms excluding the single keystore call". NFR2: "≤6 MB uncompressed and ≤3 MB compressed". Extend §18.4 to measure every NFR1 command, `exec` with a fake CLI (token kind with the key-file source), and one vault command per key source.

## 24. [minor] §11.1 rule 8; §6.3 Writers/Readers vs §6.1 and §6.4
PROBLEM: Commands declared read-only ("no lock, no state write") are elsewhere required to rename, migrate, recreate, chmod or re-ACL files. The writer list in rule 8 also omits writers named in §6.3. LimitShift's dry-run relies on "without side effects".
EVIDENCE: §11.1 rule 8: "list, status, pick and version are read-only: no lock, no state write, no swap". §6.3: readers "never write". §6.4: corrupt files are "renamed to <name>.corrupt-<epoch>"; older versions "MUST migrate … forward atomically, keeping a .bak-v<N>". §6.1: "tightens it to 0700"; "applies or repairs the DACL whenever the root lacks it". §6.3 writers include "classify --record and exec's spawn-path bookkeeping", which rule 8 omits.
FIX: Add to rule 8: "Read-only commands (version, list, status, pick, doctor without --fix, classify without --record) never rename, migrate, recreate, chmod or re-ACL. They migrate older versions in memory only. A corrupt or loosely-permissioned file gives exit 78 with the hint to run a writing command or `doctor --fix`." List the writers: next, mark, enable, disable, order, config, classify --record, exec (spawn path), add, login, remove, rename, agy use, vault *.

## 25. [minor] §12.7 env vs §8.4 gemini Launch path
PROBLEM: `env` refuses only plans that need a lock or an "argv change". Gemini `home` plans also have pre- and post-run copy hooks that `env` cannot perform, so `env` hands out an overlay without copy-in and silently loses copy-back. Since adapters never change argv, the phrase "argv change" has no meaning.
EVIDENCE: §12.7: "If the plan needs a lock held for the run or an argv change (agy, or Windows copy-back homes), env exits 69". §8.4: "Copy-in before each run: settings.json, GEMINI.md, .env"; "home accounts copy settings.json back after the run, so they use the spawn path on every OS". §8: "Never add arguments to the caller's command."
FIX: Replace the phrase with: "If the plan has a post-run hook or holds a lock for the run (agy slot, gemini home, Windows codex copy mode), env exits 69 `requires-exec`." Update §11.2's note to match.

## 26. [minor] §10.2 / §11.2 contract responses; Appendix D.4
PROBLEM: Some contract command outputs and exit statuses are undefined, yet §18.2 asserts every §11 response against schemas.
EVIDENCE: §10.2 status: "like list plus vault, slot and expiry details", with no field list. §11.2 gives `mark --json` only as `{…,"limitedUntilEpoch":…,…}`. enable/disable/order are "yes (--json result)" with no shape. vault is "partly" with no subcommands named. The exit status of `doctor` when `ok:false` and of `classify` per class are never stated. D.2 has `wrongAccount:{expected, found, observedAt}` while §12.1.1 has `{expected, found}`. §18.2: "Assert every §11 response shape against the JSON schemas in Appendix D".
FIX: Add the full shapes:
- `status`: list fields plus `vault:{exists, keySource, keyId, keyFilePath}` and `agySlot:{owner, store, writtenAt}` (hint, no keystore access);
- `mark` / `enable` / `disable` / `order`: `{contract, cli, account(s), state, …}`;
- vault: `vault status --json` is a contract command; migrate, export and import are not.

State that "doctor exits 0 whenever it ran; callers read `ok`" and "classify exits 0 for every class; 66 if the evidence file is unreadable". Unify wrongAccount as `{expected, found, observedAt}`.

## 27. [minor] §3 Glossary (missing 'control verb'); §7.3; §13.1; Appendix E
PROBLEM: "Control verbs" decides which exit codes apply, but the spec never defines it and uses it with different scopes.
EVIDENCE: §2 D3 and DECISIONS D3 use it for the JSON decision commands (version, list, pick, next, mark, status, doctor). §13.1: "Control verbs that need the slot (add agy, login agy, agy use, remove) exit 73". §7.3: "exit 74 for control verbs, exit 125 … for exec". Appendix E: "agy control verbs".
FIX: Add to §3: "control verb: every command other than `exec` and `run`. Control verbs report failures with the sysexits codes of §10.3 (64–78); exec and run use 125/126/127 (§12.1.1)."

## 28. [minor] §10.1 Global rules (flag parsing)
PROBLEM: Two requirements conflict as written. Flags must be accepted after positional arguments, but Go's standard `flag` package stops parsing at the first non-flag argument, so `accshift pick claude --prefer work` would leave `--prefer work` unparsed.
EVIDENCE: §10.1: "Flags may come before or after positional args" and "Flag parsing uses the Go standard library (flag) with a small subcommand dispatcher". Go flag docs: parsing stops before the first non-flag argument or after `--`.
FIX: Add: "The dispatcher parses repeatedly: FlagSet.Parse, take one positional, Parse the remainder, until `--` or the end. After `--` (exec, env, run) everything is passed through unparsed. Unknown flags are usage errors (64; 125 for exec/run)."

## 29. [minor] §8.1 Transcripts; §9.5 Inputs; §16 step 2; Appendix B
PROBLEM: `slug(cwd)` and the agy log path are used as inputs but defined only in the research reports, so an agent working from the spec alone can't compute them.
EVIDENCE: §8.1: "<configDir>/projects/<slug(cwd)>/<sessionId>.jsonl". §9.5: "the Claude projects/<slug>/<session>.jsonl tail … the agy log tail". §16: "agy ~/.gemini/antigravity-cli/log/*". R04 §1 (line 146): "slug = cwd.replace(/[^a-zA-Z0-9]/g,\"-\"), truncated to 200 chars + -<base36 hash> if longer". The hash algorithm is unspecified even in R04. Appendix B has no agy log row.
FIX: Add to Appendix B the claude slug rule from R04 §1, plus: "for slugs over 200 characters, locate the transcript by globbing projects/*/<sessionId>.jsonl". Add an agy log row, `~/.gemini/antigravity-cli/log/` (all OSes), tagged VERIFY V-A2.

## 30. [minor] §5.1 procscan; §8.3.3 Foreign-process check
PROBLEM: The spec names `proc_pidpath` for macOS, but that function lives in libproc and x/sys/unix doesn't expose it. Calling it under the mandatory CGO_ENABLED=0 needs cgo, which the CI guard would reject, or hand-written libSystem trampolines.
EVIDENCE: §5.1: "macOS sysctl/proc_pidpath". §8.3.3: "macOS proc_pidpath (or sysctl KERN_PROCARGS2)". NFR2/§17.1: CGO_ENABLED=0 with a CI guard against cgo.
FIX: Replace with: "macOS: enumerate with sysctl kern.proc.uid (unix.SysctlKinfoProcSlice) and read the exec path from KERN_PROCARGS2 (unix.SysctlRaw(\"kern.procargs2\", pid)), resolved with filepath.EvalSymlinks. proc_pidpath MUST NOT be used (needs cgo)."

## 31. [minor] §8.2 Concurrency (same-account stagger SHOULD)
PROBLEM: The SHOULD can't be implemented on codex's execve path. Nothing records an in-flight accshift-launched codex run, and the stated pre-launch wait would idle for 60 s whenever no other run is going to rewrite auth.json.
EVIDENCE: §8.2: "SHOULD: when two accshift-launched runs of one codex account start while that overlay's access-token exp … is within 10 minutes, the second waits (at most 60 s) until auth.json has been rewritten." §12.3: codex uses execve with "no lock to hold". §13.1: lock fds are close-on-exec.
FIX: Replace the SHOULD with: "v1 does not stagger same-account codex runs. The race is documented in the README and in doctor (DECISIONS D5 risks). A later version may add a per-overlay holder file on the spawn path."

## 32. [minor] §12.1.1 --status-file; §8.3.3 C.3; §8.4 copy-back (post-run failure handling)
PROBLEM: Several failure paths after launch, or around it, are unspecified. The status file is written before execve, which can still fail, leaving a false record. Post-run hook failures have no defined exit status, catalogue message or follow-up.
EVIDENCE: §12.1.1: the status file is written "just before execve with launched:true and exitCode:null", while `cmdline-too-long` occurs when "execve … returned E2BIG". No rule covers a failed vault save-back after an agy run (keystore locked mid-run, `vault-changed` abort), a failed gemini settings.json copy-back, or a failed holder-file delete. The stderr catalogue allows only the listed notices.
FIX: Add:
- "If execve returns, exec rewrites the status file with launched:false and the error, then exits 125/126/127."
- "Post-run hook failures never change the returned exit status. exec prints the catalogue line `accshift: warning post-run-<code>`, records an event, and sets status-file `postRunError`."
- "For agy, a failed save-back leaves the slot untouched and sets state.agySlot.saveBackPending=true; the next exclusive run performs B.5 first."

## 33. [minor] §8.3.4 add/login agy steps 3–6
PROBLEM: `add agy` and `login agy` delete every slot and then run agy attached to the terminal, but no signal handling is specified. A Ctrl+C or terminal close kills accshift with the slots empty. The user's interactive agy stays signed out until some later exclusive accshift run recovers the journal.
EVIDENCE: §8.3.4 step 3: "Then delete every slot, so that agy starts signed out." Step 4: "Run agy attached to the terminal." §12.3's signal rules apply to exec only. §13.3: recovery runs only under a later exclusive lock.
FIX: Add: "During steps 3–6 accshift installs signal.Notify for SIGINT, SIGTERM and SIGHUP (on Windows, os.Interrupt and SIGTERM). After agy exits, or on any of these signals, it always runs step 6 (restore and verify) before exiting. doctor reports a pending `op:add` journal with the fix command."
