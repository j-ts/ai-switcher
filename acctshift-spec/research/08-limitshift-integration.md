# Research track: limitshift-integration

_Research date: 2026-10-07. Claims are marked VERIFIED (evidence gathered during the research) or INFERRED._

## Summary

I read limitshift 1.3.2 (/home/user/j-ts/limitshift: limitshift.sh, limitshift.ps1, schema, docs, tests) and limitshift-v2 (root runners 1.5.0 plus the modular PowerShell engine in v2/). I then mapped every point where a CLI is launched, where a usage limit is detected, and where the runner decides to wait.

**Recommended integration**
- **Launching:** one wrap in `build_cli_args` (sh) or `Invoke-CliTaskRun` (ps1) turns every launch into `acctshift exec <cli> --account <a> -- <the same args>`. This also covers `--dry-run` and `--show-raw`, because they print the same command.
- **Rotation order:** a new account level goes between model rotation and CLI (runner) rotation: model (inside one account) → account (same CLI, same saved session, resumed) → CLI fallback (fresh session plus handoff note) → wait for the soonest reset across CLIs and accounts.
- **Contract:** single-line JSON plus exit codes. 0 = an account is ready, 75 = every account is capped (the JSON gives the soonest reset as epoch seconds), 69 = no rotation possible, so limitshift keeps today's behaviour, 77 = every account needs re-login. `exec` returns the CLI's own exit code and keeps 125/126/127 for its own failures, the same way `env` and `timeout` do.

**Proofs of concept** (scratch copies only; both repos are unchanged, `git status` clean):
- **Bash:** a stub acctshift plus an account-aware stub claude ran 7/7 scenarios correctly under bash and jq: switch to the next account on the same session, the order a:opus → a:sonnet → b:opus, wait for the soonest account when all are capped, dry-run, opt-out, Ollama bypass, and the fallback CLI path.
- **PowerShell:** the same contract ran 4/4 scenarios in v1 `limitshift.ps1` under pwsh 7.5.3 on Linux.
- **Regression:** the existing bash suite run against the patched script, with acctshift not installed, gave the same results as the unpatched baseline. The only differences were the 2 tests that check the runs.csv header, because I added an `account` column on purpose.

**Is v2 PowerShell-only? Yes.** It needs PowerShell 7 and has no bash version. On Linux with pwsh 7.5.3 its Pester suite passed 313 of 318:
- 3 failures are tests that assume Windows (`powershell.exe`, `cmd /c`, a `C:/` path).
- 2 failures are because `agy`/`copilot` aren't installed here.

So the engine itself runs on Linux; macOS is untested but very likely the same. v2 never resumes a conversation; each call is a fresh one-shot. So switching account there means retrying the same call immediately instead of sleeping, at `Cli.ps1:544`.

**Bugs found**
- **Bash CLI rotation is broken:** in `select_next_runner` (v1 `limitshift.sh:1579`, v2-root `:2043`), jq binds `as $i` only to the term just before it, so a `fallbacks` task in the bash runner fails at once with "all runners exhausted". Wrapping that expression in brackets took the bash suite from 114 to 125 passing on this machine. This must be fixed first, because account rotation inside fallbacks depends on it.
- **v2-root skips the claude `/usage` check:** it passes `task_field "$i" "path"`, but the field is `projectPath`, so the working directory is always empty and the cross-check never runs.
- **Breaks the claimed macOS bash 3.2 support:** `${var,,}` is used and needs bash 4.
- **sh and ps1 disagree on the session file name:** `task-NN.session` versus `task-NN-session-id.txt`.

**Things that change once accounts can switch mid-task**
- The claude `/usage` check must run as the same account.
- The model-capability cache and `agy models` depend on the account.
- runs.csv needs an `account` column, and each task needs a saved account file.
- If a resume fails after an account switch, the new session needs the handoff note, and acctshift should report whether a session can move to another account.
- 401/403 (expired login) should move to the next account rather than kill the whole CLI.

## Conclusions

| # | Claim | Status | Confidence | Evidence | What the spec should do |
|---|---|---|---|---|---|
| 1 | A single wrap in build_cli_args (sh) / after Get-CliExecutable in Invoke-CliTaskRun (ps1) routes every CLI launch, the --dry-run command line and --show-raw through `acctshift exec <cli> --account A -- <args>`, without touching how prompts are passed (stdin or -p). | VERIFIED | high | limitshift.sh launch lines :2306/2308/2311/2321 and dry-run :2275-2283 all use CLI_EXE/CLI_ARGS built in build_cli_args :1890-1996. ps1 uses $exe/$arguments from :2436-2438. POC S4/P3 dry-run printed `Command: …/acctshift exec claude --account a -- -p --session-id …`. S1/P1 showed the stub CLI received the same args and the stdin prompt. | Spec the hook at exactly these two points, plus the v2 Resolve-CliLaunch call (Cli.ps1:506, moved inside the retry loop). acctshift exec must pass argv after `--` through unchanged and must not consume stdin. |
| 2 | Account rotation belongs between model rotation and CLI/runner rotation: model (within the account) → account (same CLI, same saved session id, Resume, no handoff) → runner (fresh session plus handoff) → wait for the soonest reset across runners × accounts. | VERIFIED | high | Existing flow: model rotation sh :2767-2778 / ps1 :3280-3297, then wait :2781 / :3301, or runner limitedUntil :3169 / :3622. POC S2/P2 produced the order a:opus → a:sonnet → b:opus. S1/P1 resumed with `--resume <same uuid>` on account b with no rest. S7 went claude a → claude b → codex fallback. | The default order is 'models first, then accounts'. Reset the model index to 0 on an account switch. On exit 75 (all accounts capped) set the runner's limitedUntil to acctshift's soonest resetAtEpoch. A non-limit error never rotates the account, except 401/403. |
| 3 | The contract should be one line of JSON on stdout plus sysexits-style exit codes. For pick/next: 0 ok, 69 no rotation possible (legacy fallback), 75 all capped with resetAtEpoch of the soonest account, 77 all need re-login, 64/78 for usage/config errors. exec returns the CLI's exit code and keeps 125/126/127 for itself; every timestamp also comes as integer epoch seconds. | VERIFIED | high | Both POCs consumed it trivially. Bash: `out=$(acctshift next … --json); rc=$?; jq -r .account/.resetAtEpoch`. PowerShell (pwsh 7.5.3): Invoke-AcctShift with ConvertFrom-Json and [DateTimeOffset]::FromUnixTimeSeconds. Limitshift sh works in epoch seconds throughout (parse_reset_from_error, select_next_runner). v2.ps1:19 forces ConvertFrom-Json DateKind=String because pwsh auto-converts ISO dates. | Freeze 'contract 1' with these fields: contract, cli, account, previous, switched, available, resetAt, resetAtEpoch, sessionPortable, accounts[]. No keys that differ only by case (PowerShell 5.1). exec must never write to stdout, and any stderr line it writes must start with `acctshift: ` and never with `{`, because sh merges stderr into the output it parses (:2321). |
| 4 | With acctshift absent or LIMITSHIFT_ACCTSHIFT=off, the integrated runner behaves exactly like today except for the deliberate runs.csv 'account' column. | VERIFIED | high | Existing bash suite against the POC-patched script: 123/138, against 125/138 for the jq-fixed baseline. The 2 differences are 'runs.csv header and rows include cli and model columns' and 'state dir gets _README.txt, runs.csv…', which assert the old 8-column header (tests :962, :4181; Pester :1138, :1174, :3472). POC S5/P0 called claude directly when off. | Spec: optional dependency; discovery order LIMITSHIFT_ACCTSHIFT → <limitshift>/bin/acctshift[.exe] → PATH; contract check through `version --json`. Update the 5 runs.csv-header assertions and migrate old 8-column runs.csv files. |
| 5 | Bash CLI rotation (fallbacks) is broken today: select_next_runner's jq binds `as $i` only to `$count`, so it never returns 'Run', and every fallbacks task fails immediately with 'all runners exhausted'. | VERIFIED | high | limitshift.sh:1579 and v2-root limitshift.sh:2043 `range($count) \| ($start + .) % $count as $i \|`. A jq 1.7 probe returned 'Fail' with nothing limited; with `(($start + .) % $count) as $i` it returned 'Run 0'. The suite went from 114 to 125 passing, recovering all 11 fallbacks/rotation tests. | Make this fix a prerequisite of the integration milestone; account rotation inside fallbacks depends on it. Add a macOS and Linux bash CI job, since the bug went unnoticed. |
| 6 | The v2 engine (v2/) is PowerShell 7 only and has no session resume. It runs on Linux under pwsh 7.5.3: 313 of 318 Pester tests pass, and the 5 failures are Windows-only test assumptions (3) or missing CLIs (2). | VERIFIED | high | #requires -Version 7 at v2.ps1:1, run-tests.ps1:1, preflight.ps1:1. Get-CliInvocation Cli.ps1:271-323 has no session flags. The Linux run failed only on powershell.exe (Cli.Tests:211), `cmd /c` (Invoke-Check.Tests:27), `C:/x` (Registry.Tests:70), and PREFLIGHT FAIL 'agy'/'copilot' not found (EntryPoint); SmokePrep passed once stub CLIs were present. macOS was not run. | In v2, account rotation is 'retry the same one-shot call on the next account instead of sleeping', at Cli.ps1:544 before the reset/sleep logic. Make auth-dead tracking per account (Cli.ps1:20-35, :578-582) and relax the same-bucket preflight rule (Preflight.ps1:71-81) for different accounts. CI should run pwsh on macOS and Linux, after fixing the 3 Windows-only tests. |
| 7 | The claude /usage reset cross-check runs `claude -p /usage` directly, so after rotation it would describe the wrong account. | VERIFIED | high | sh get_claude_usage_reset_epoch :1512-1525 (`claude -p "/usage"`). ps1 Get-ClaudeUsageResetTime :2631-2653 (Invoke-NativeProcess -Command 'claude'). POC S1/P1 routed it as `exec claude --account a -- -p /usage`. | Route /usage, `agy models` discovery and --probe-models through `acctshift exec --account <same account>`, and key the capabilities cache as <cli>@<account>. |
| 8 | v2-root limitshift.sh never runs the claude /usage cross-check, because every call site reads the non-existent task field 'path' instead of 'projectPath'. | VERIFIED | high | v2-root limitshift.sh :3150, :3215, :3646, :4103 pass `$(task_field "$i" "path")`. task_field (:734-741) reads `.tasks[i].path`, or `.path` for mission tasks, which are also built with `--arg projectPath` (new_mission_task_object). get_runner_reset_epoch :2014-2036 only calls /usage when working_dir is non-empty. | Fix it as part of integration, since the account-aware /usage routing reuses this path. |
| 9 | After an account switch, resuming the conversation is safe for claude/codex only if acctshift keeps their history directories shared. For agy it is unproven, so acctshift should report sessionPortable per CLI and limitshift should start a fresh session with the handoff note when it is false or when the resume fails. | INFERRED | medium | Session ids: claude uuid from limitshift (:1842-1854), codex thread_id (:2078), agy continues the most recent conversation per project path (`-c`, :1968; transcript via last_conversations.json :2006-2022). ai-switcher's own notes (launcher/ais-run.mjs:10-14) copied the claude jsonl / codex rollout into the next profile and resumed, which implies resume works once the files exist. Existing claude session-lost recovery (:2742-2747) restarts New without a handoff note in the single-runner path. | acctshift contract: sessionPortable per CLI. limitshift: after a switch, a session-lost error (claude), or a resume failure (codex, which needs new detection, and agy) → New plus HANDOFF_NOTE_BASE. Real-account tests are required. |
| 10 | The installation and opt-in surface should be: no automatic download; an optional get-acctshift.sh/.ps1 (or --install-acctshift) that installs a pinned, checksum-verified release into <limitshift>/bin/, which is git-ignored; LIMITSHIFT_ACCTSHIFT overrides the path or disables it; queue settings.accountRotation is auto\|off\|required; per-runner `accounts` is a pool array or false. | VERIFIED | medium | Today limitshift is clone/ZIP and run in place with no installer (README :75, :102, :114-131). The env-var naming convention exists (LIMITSHIFT_PROFILE_PATH sh :1215, LIMITSHIFT_AGY_DATA_DIR :1998-2004). The schema is additionalProperties:false at settings/tasks/fallbacks (schema :6-11, :63, :95), and .gitignore has no bin/. The design itself is a recommendation. | Add the schema fragments and the validate-only checks listed in the report (unknown account with did-you-mean, required-but-missing, ollama, unsupported CLI, pool smaller than 2, doctor warnings). Keep accounts out of the task fingerprint. |
| 11 | v1 limitshift.ps1 also runs on Linux under pwsh 7, and the acctshift hooks can be written with Windows PowerShell 5.1 / StrictMode-2.0-safe constructs. | VERIFIED | medium | POC P0–P3 (pwsh 7.5.3 on Linux) passed: legacy run, switch on the same session, order, dry-run. The hooks avoid $IsWindows, ??, and ternaries, and use a local ErrorActionPreference=Continue around the native call. 5.1 itself was not run (INFERRED); limitshift.ps1:13 sets `Set-StrictMode -Version 2.0`. | Spec explicitly that the ps1 integration code must work under 5.1 with StrictMode 2.0 and under pwsh 7 on all three OSes. Test with Pester on Windows (5.1 and 7) and on pwsh macOS/Linux. |
| 12 | On Windows, acctshift exec must launch npm-shim CLIs (codex.cmd, copilot.cmd, gemini.cmd) without passing argv through cmd.exe. copilot and agy receive the multi-line prompt as the -p argument; today limitshift.ps1 avoids cmd.exe with a powershell wrapper that ferries the arguments in JSON. | INFERRED | medium | Invoke-NativeProcess .ps1/.cmd/.bat wrapper (limitshift.ps1:1771-1808) and the native-exe quoting (:1705-1738). Get-CliArguments puts the prompt in argv for agy/copilot (:2071, :2083-2085). Wrapping with acctshift.exe moves the shim launching into acctshift. | Requirement for the Windows/exec track: resolve npm shims to node+script or to the vendor native binary; use CommandLineToArgvW-compatible quoting; use a job object; never use cmd.exe for argv carrying prompts. |

## Full report

# Track: limitshift-integration — how limitshift (v1 sh/ps1, v2-root, v2 engine) should call `acctshift`

Labels: **VERIFIED** = I saw it now (code read with line numbers, or a command I ran, with output quoted). **INFERRED** = reasoning or memory, not checked.
Repos read: `/home/user/j-ts/limitshift` (HEAD `800228d`, release 1.3.2) and `/home/user/limitshift-v2` (HEAD `f690110`; root runners at CHANGELOG 1.5.0, plus `v2/`).
Allowed ai-switcher files, read for requirements only: `launcher/ais*.mjs`. No agm code was opened. Neither repo was modified: `git status` is clean in both, and all experiments ran on copies under the scratch directory.

---
## 0. TL;DR for the spec

1. **One wrap point covers every launch.**
   - Bash: at the end of `build_cli_args` (`limitshift.sh:1890-1996`), set `CLI_ARGS=(exec "$CLI_EXE" --account "$ACCT" -- "${CLI_ARGS[@]}"); CLI_EXE=$ACCTSHIFT_BIN`. This covers all 4 launch lines (`:2306/2308/2311/2321`), the `--dry-run` `Command:` line (`:2275-2283`) and `--show-raw` (`:2285-2290`).
   - PowerShell: right after `$exe = Get-CliExecutable` (`limitshift.ps1:2438`).
2. **New rotation level, between models and CLIs:** model (inside the account) → **account** (same CLI, same saved session, Resume, no handoff note) → CLI fallback (fresh session plus handoff note) → wait for the soonest reset across runners × accounts.
3. **Contract:**
   - `version|list|pick|next|mark|status|doctor --json` print one line of JSON and use exit codes: 0 ok, 64 usage, **69 no rotation possible (caller keeps legacy behaviour)**, **75 every account capped (JSON has `account` = soonest, `resetAtEpoch`)**, 77 every account needs re-login, 78 config/state broken.
   - `exec` returns the CLI's own exit code. It keeps 125 (acctshift failed before launch), 126 (not executable) and 127 (not found), like `env(1)`/`timeout(1)`.
   - Every timestamp is given twice: as RFC 3339 UTC and as **integer epoch seconds** (`*Epoch`). Bash works in epochs; pwsh 7 `ConvertFrom-Json` silently turns ISO strings into DateTime.
4. **If acctshift is absent, `LIMITSHIFT_ACCTSHIFT=off` is set, or the CLI is unsupported:** behaviour is byte-identical to today. The only deliberate change is the runs.csv `account` column.
5. **Fix these first:**
   - (a) jq bug in `select_next_runner`: bash `fallbacks` never run.
   - (b) v2-root `task_field ... "path"` bug.
   - (c) the session-file name mismatch between sh and ps1.

---
## (a) How limitshift works today (v1 1.3.2; v2-root is the same unless noted)

### a1. CLI invocation (`build_cli_args` sh `:1890-1996` / `Get-CliArguments` ps1 `:2001-2097`)

| CLI | New run | Resume | Prompt via | Other flags | Session id source |
|---|---|---|---|---|---|
| claude | `-p --session-id <uuid>` (sh `:1910-1912`) | `-p --resume <uuid>` | **stdin** (sh `:2321`; ps1 `StdinText`, `:2468`) | `--output-format json`, `--model`, `--effort`, extraArgs. Ollama: `ollama launch claude --model m --yes -- <args>` (sh `:1934-1941`) | generated by limitshift (`new_task_session_id` sh `:1842-1854`; ps1 `New-TaskSessionId` `:1507-1516`) |
| codex | `exec --json -m m -c model_reasoning_effort=e <extra>` | `exec resume <thread_id> --json …` (sh `:1945-1958`). `--sandbox/-s/--cd/-C/--add-dir` are stripped on resume (`get_codex_resume_extra_args` `:814-831`) | stdin | — | `thread.started.thread_id` from the JSONL (`parse_cli_output` `:2078`) |
| gemini | `--output-format json -m m` | sh `--resume=<id>` (`:1961`), ps1 `--resume <id>` (`:2066`): **the two runners differ** | stdin | — | JSON `.session_id` |
| agy | `-p "<prompt>" --model m` | `-c -p …` (continues the most recent conversation for this project, no id) | **argv** (`-p`) | sh wraps it in `setsid` (`:2304-2306`); ps1 launches it windowless with CreateNoWindow (`:1853-1882`) | none (reply is read from `~/.gemini/antigravity-cli/brain/<cid>/…/transcript.jsonl`, `agy_response_from_transcript` `:2006-2022`; data dir can be overridden with `LIMITSHIFT_AGY_DATA_DIR`) |
| copilot | `--name <uuid> --output-format=json --stream=off --no-ask-user -p "<prompt>"` | sh `--resume <id>` (`:1978`), ps1 `--resume=<id>` (`:2082`) | argv | `--effort` is dropped when the model is `auto` | uuid generated by limitshift |

ps1 launches through `Invoke-NativeProcess` (`:1740-1961`): `.ps1/.cmd/.bat` shims go through a `powershell.exe` wrapper with the arguments ferried in a JSON file (`:1771-1808`); native exes get one CommandLineToArgvW-quoted string (`ConvertTo-WindowsArgString` `:1705-1738`).

### a2. Limit detection

`parse_cli_output` (sh `:2024-2142`) / `ConvertFrom-CliOutput` (ps1 `:2224-2401`, patterns `:2235-2245`). A limit is only considered once the run has already failed.

| CLI | regex (case-insensitive) |
|---|---|
| claude | `you've hit your .{0,40}limit\|usage limit\|out of credits?\|credits? (exceeded\|exhausted\|remaining)\|monthly credit\|insufficient credits\|agent sdk.{0,30}limit\|429\|too many requests` |
| codex | `usage limit\|rate limit\|too many requests\|try again (at\|in)\|quota` |
| gemini | `quota exceeded\|resource_exhausted\|ratelimitexceeded\|model_capacity_exhausted\|no capacity available\|daily quota\|usage limit reached\|rate limit\|429\|too many requests` (or `error.code==429`) |
| agy | `quota (exceeded\|reached)\|resource_exhausted\|…\|increase your limits?\|upgrade your subscription\|usage limit\|rate ?limit\|429\|too many requests\|try again (at\|in)` (only when no reply was recovered) |
| copilot | `usage limit\|rate limit\|too many requests\|quota\|premium requests\|billing\|try again at\|try again in\|429` |

Claude-only extra signals (sh `:2042-2043`):
- `No conversation found with session ID` → `R_SESSION_LOST`: delete the session file, refund the run, start New on the same runner (sh `:2742-2747`).
- `Unknown command:\s*/` → mark needs-human.

v2 engine: `Test-LimitSignal` (`v2/lib/Cli.ps1:37-47`), patterns at `:9-14` (adds `session limit`).

v1 has **no auth (401/403) classification.** v2 has one: `ConvertFrom-ClaudeJsonOutput` `:244-269` (`api_error_status` 401/403 → `AuthFailed`), and then `Set-V2AuthDeadCli` (`:20-35`, `:578-582`) blacklists the **whole CLI** for the rest of the run.

### a3. Reset time

- `parse_reset_from_error` (sh `:1390-1438`) / `Get-ResetTimeFromErrorText` (ps1 `:2570-2614`) recognise:
  - `try again at|resets( at)?|available (again) at <clock>` (a bare clock already past rolls to tomorrow);
  - `try again in|resets in 1h55m24s`;
  - `reset after …`;
  - `"retryDelay":"Ns"`.
- The timezone in parentheses, e.g. `(Europe/London)`, is ignored: the clock is read as local time.
- For claude only, `get_runner_reset_epoch` (sh `:1551-1572`; ps1 `Get-RunnerResetTime` `:2692-2713`) also runs `claude -p /usage` (sh `:1512-1525`; ps1 `:2631-2653`) **directly, not as any particular account**, and keeps the later of the two times.
- If nothing parses, it falls back to `settings.limitWaitMinutes` (default 30). `resetBufferMinutes` (default 2) is added when sleeping.

### a4. Model, runner and CLI rotation; where the wait decision is made

- **Single runner** (sh `:2767-2783`; ps1 `:3280-3302`):
  - On a limit, move to the next entry of the `model` array straight away (same session, saved in `task-NN-model-index.txt`).
  - Once all models are capped, reset the model index to 0 and **wait** with `wait_for_limit_reset` (sh `:2781` → `ui_rest_with_summary` `:624-635`) / `Wait-ForLimitReset` (ps1 `:3301`, `:2738-2749`).
- **Fallbacks** (sh `:2934-3305`; ps1 `:3415-3735`):
  - Each runner has `setAside` and `limitedUntil`.
  - `select_next_runner` (sh `:1574-1593`, jq; ps1 `Select-NextRunner` `:2715-2736`) returns **Run** (the first runnable runner, scanning on from the current one), **Wait** (the soonest `limitedUntil` within 24 h) or **Fail**.
  - On a limit, once the runner's models are exhausted, `limitedUntil[runner]=get_runner_reset_epoch(...)` (sh `:3169`; ps1 `:3622`).
  - Switching runner (sh `:3012-3031`; ps1 `:3473-3495`) deletes the session file, sets the handoff note and saves `task-NN-runner-index.txt`.
  - The Wait branch (sh `:2998-3009`; ps1 `:3461-3470`) sleeps, then clears that runner's limit.
- **v2-root** adds limit/wait loops for the verifier (sh `:3144-3152`; ps1 `:3331-3337`) and the planner (sh `:3209-3217`; ps1 `:3396-3402`); single runner sh `:3632-3648`, ps1 `:3834-3855`; fallbacks sh `:4091-4105`, ps1 `:4212-4225`.
- **v2 engine:** the wait happens *inside* `Invoke-CliRoleOnce` (`Cli.ps1:544-565`): sleep until the reset plus 5 minutes (clamped to the deadline), then retry the same entry. Resets more than 24 h away, or past the deadline, give up and move along the role chain (`Invoke-RoleWithFallback` `:593-702`).

### a5. State folder (named after the queue file, next to it)

```
<queue-dir>/<queue-name>/          _README.txt, .gitignore ('*'), limitshift-log.txt, limitshift.lock, stop-after-step.flag
  runs.csv                          header "timestamp,task,run,mode,exit,status,cli,model" (sh :2479, ps1 :84)
  sessions/ task-NN.session (sh :1691-1695)  vs  task-NN-session-id.txt (ps1 :1346-1351)   <-- MISMATCH
            task-NN-model-index.txt, task-NN-runner-index.txt, task-NN-runner-K-model-index.txt,
            task-NN-recovery-attempts.txt; v2-root adds task-NN-run-state.txt (key=value incl. sessionId,
            sh :2413-2436), task-NN-verify.session / -planner.session (sh :2242-2247)
  outputs/  task-NN-<slug>-output.txt
  status/   task-NN.done ("ts\nfingerprint"), task-NN.failed ("ts\tfp\treason"), task-NN.needs-human
  capabilities/<cli>.json          (validate-only model cache, keyed by CLI only)
  v2-root: verify/<task-key>/round-NNN.json, state/missions/<id>/{state.json,dispatch.json}
```

The fingerprint (`get_task_fingerprint` sh `:1628-1676`) covers name, cli, projectPath, model, effort, prompt, extraArgs and each fallback's cli/model/effort/extra. Unknown keys are ignored by both runners, because each reads only the fields it knows. VERIFIED by reading.

---
## (b) v2

- **The v2 engine (`v2/`) is PowerShell 7 only.** `#requires -Version 7` is at `v2.ps1:1`, `run-tests.ps1:1` and `preflight.ps1:1`; `v2.ps1:20` dot-sources `lib/*.ps1`. There is no bash version, and it is a separate "mission" engine with its own command line (`-MissionDir -SourceRepo`, role CLIs).
- **The v2-root `limitshift.sh/.ps1` are the 1.5.0 runners** (verify loop, mission mode, run-state). They are the bash/ps1 twins of v1, not the v2 engine.
- **How the v2 engine calls CLIs:**
  - `Get-CliInvocation` (`Cli.ps1:271-323`): hard-coded flags per role. claude `-p --permission-mode acceptEdits|plan --output-format json`; codex `exec --sandbox workspace-write|read-only -`; agy `-p … --dangerously-skip-permissions`; copilot `-p … --allow-all`.
  - `Resolve-CliLaunch` (`:353-397`): `.ps1/.cmd` shims are re-hosted in `pwsh`.
  - `Invoke-CliRoleOnce` (`:476-591`): `Start-Process` with a stdin file and redirected stdout/stderr, a watchdog timeout, `Stop-ProcessTree` (`Kill($true)`, then `taskkill` inside a try), and the in-place limit sleep.
  - `Invoke-RoleWithFallback` (`:593-702`) walks the chain; `Invoke-CliCharged` (`Budget.ps1:69-88`) is called by Executor (`:35`), Planner (`:73`) and Verifier (`:19`).
  - **There is no session resume anywhere in v2:** every call is a fresh one-shot (grep for resume/session-id in `lib/` finds only mission-state resume).
- **Does it run on Linux/macOS?** VERIFIED on Linux. I downloaded pwsh 7.5.3 (linux-x64) and Pester 5.7.1 into scratch and ran `v2/run-tests.ps1` on a copy: **313 passed, 5 failed.**
  - Windows-only test assumptions:
    - `Cli.Tests.ps1:211`: `(Get-Command powershell.exe)`
    - `Invoke-Check.Tests.ps1:27`: `cmd /c exit 5`
    - `Registry.Tests.ps1:70`: `C:/x/...` treated as an absolute path
  - Environmental:
    - `SmokePrep` passes once stub `claude`/`codex` are on PATH.
    - `EntryPoint` still exits 2 with `PREFLIGHT FAIL: role 'planner' step 2: CLI 'agy' not found on PATH` (the repo profile chains agy and copilot).
  - macOS is INFERRED to behave the same (same pwsh/.NET).
- I also ran v1 `limitshift.ps1` under pwsh/Linux (scenario P0 below): it works.

---
## (c) Hook points and pseudo-code

### Rotation order (decision)

```
on Limit for (runner R, account A, model M):
  1. next model of R on account A        -> same session (existing)
  2. models exhausted on A -> model index := 0;  acctshift next <cli> --from A --limited-until <reset>
       rc 0  -> account B, same session (Resume); if json.sessionPortable==false -> fresh session + handoff note
       rc 75 -> every account capped; json.resetAtEpoch = soonest account
       rc 69/other -> legacy behaviour
  3. single runner:  rc 75 -> wait until resetAtEpoch(+buffer), then use json.account
     fallbacks:      rc 75 -> limitedUntil[R] := json.resetAtEpoch (soonest account, not just A); select_next_runner
                     -> another CLI (fresh session + handoff) or Wait(soonest) -> re-pick an account for R
  4. non-limit errors never rotate accounts, except auth (401/403/expired token): acctshift mark --auth-failed, then next.
```

Why models before accounts:
- It keeps today's meaning of a model array (different limit buckets inside one account, see `limitBuckets` in `limitshift-profile.json`).
- It uses up one account before switching, so there are fewer switches; this matters most for agy, where each switch means swapping the keychain slot.
- acctshift's limit records can stay per (cli, account).
- An `order: "accountsFirst"` setting can be added later.

POC S2/P2 confirmed the resulting order `a:opus → a:sonnet → b:opus`.

### v1 / v2-root `limitshift.sh`

```bash
# globals (near :22)
ACCTSHIFT_BIN=""; ACCTSHIFT_CLIS=""; ACCT_CURRENT=""; ACCT_NEXT=""; ACCT_RESET=""
resolve_acctshift() {          # called once after the queue is read (before --validate-only / run)
  case "${LIMITSHIFT_ACCTSHIFT:-}" in off|0|false) return 1;; esac
  cand=${LIMITSHIFT_ACCTSHIFT:-}; [ -z "$cand" ] && [ -x "$SCRIPT_DIR/bin/acctshift" ] && cand="$SCRIPT_DIR/bin/acctshift"
  [ -z "$cand" ] && cand=$(command -v acctshift) || true
  v=$("$cand" version --json) && [ "$(jq -r .contract <<<"$v")" = 1 ] || return 1
  ACCTSHIFT_BIN=$cand; ACCTSHIFT_CLIS=$(jq -r '.supportedClis|join(" ")' <<<"$v")
}
acct_runner_enabled cli idx r   # bin set && cli in supportedClis && no --oss/ollama in extraArgs && runner.accounts != false
acct_call verb cli args...      # out=$(acctshift "$@" --json); rc=$?; ACCT_NEXT=.account; ACCT_RESET=.resetAtEpoch; return rc
# build_cli_args end (:1995):
[ -n "$ACCT_CURRENT" ] && acct_runner_enabled "$cli" "$idx" "$runner_idx" &&
  { CLI_ARGS=(exec "$CLI_EXE" --account "$ACCT_CURRENT" -- "${CLI_ARGS[@]}"); CLI_EXE=$ACCTSHIFT_BIN; }
# task start (:2611): ACCT_CURRENT=""
# before each run (single :2672 / fallbacks :3068): if empty -> acct_call pick <cli> --prefer "$(cat sessions/task-NN[-runner-K]-account.txt)" [--pool a,b]
#     rc 0|75 -> ACCT_CURRENT=$ACCT_NEXT; persist the account file
# single-runner limit branch, after the model-index reset (:2775-2778), BEFORE mustWaitForFreshSession/wait_for_limit_reset (:2779-2781):
lim=$(get_runner_reset_epoch ...)            # still parsed by limitshift (with /usage routed through the same account)
acct_call next "$cli" --from "$ACCT_CURRENT" --limited-until "$lim"; rc=$?
rc==0  -> write_step "limit on account A; switching to account B"; ACCT_CURRENT=B; persist; continue
rc==75 -> ui_rest_with_summary "$cli" $((ACCT_RESET+RESET_BUFFER_MINUTES*60)); ACCT_CURRENT=$ACCT_NEXT; continue
else   -> legacy wait_for_limit_reset
# fallbacks limit branch (:3169): same next-call before marking the runner; rc 75 -> limitedUntil[R]=$ACCT_RESET; ACCT_CURRENT=""
# runner switch (:3029): ACCT_CURRENT=""     # different CLI, different pool
# runs.csv: header + add_runs_csv_row 9th column "account" (:2403-2414, :2479)
# get_claude_usage_reset_epoch (:1519): run "$ACCTSHIFT_BIN" exec claude --account "$ACCT_CURRENT" -- -p /usage
# fingerprint-invalidation cleanup (:2591-2602): also rm sessions/task-NN*-account.txt
# v2-root extra sites: verifier :3144-3152, planner :3209-3217 (same pattern, own ACCT var per role); run-state file: add account=
```

Keep it bash 3.2-safe: no `${x,,}`, and guard empty arrays under `set -u` with `${a[@]+"${a[@]}"}` (bash below 4.4 treats an empty array as unbound).

### v1 / v2-root `limitshift.ps1` (must also run on Windows PowerShell 5.1 with `Set-StrictMode -Version 2.0`)

```powershell
# no $IsWindows / ?? / ternary under 5.1+StrictMode 2; use $env:OS -eq 'Windows_NT'
function Invoke-AcctShift([string[]]$Arguments) {    # local EAP=Continue: 5.1 turns native stderr into errors
  $prev=$ErrorActionPreference; $ErrorActionPreference='Continue'
  try { $out = & $script:AcctShiftBin @Arguments '--json' 2>$null; $rc=$LASTEXITCODE } finally { $ErrorActionPreference=$prev }
  $j=$null; try { $j = (@($out) -join "`n") | ConvertFrom-Json } catch {}
  [pscustomobject]@{ ExitCode=$rc; Json=$j } }
# Invoke-CliTaskRun after $exe = Get-CliExecutable (:2438):
if ($script:AcctCurrent -and (Test-AcctRunnerEnabled $Task)) { $arguments=@('exec',$exe,'--account',$script:AcctCurrent,'--')+@($arguments); $exe=$script:AcctShiftBin }
# single-runner limit branch before $mustWaitForFreshSession=$true (:3299):
$epoch = ([DateTimeOffset](Get-RunnerResetTime ...)).ToUnixTimeSeconds()
$nx = Invoke-AcctShift @('next',$task.Cli,'--from',$script:AcctCurrent,'--limited-until',[string]$epoch)
if ($nx.ExitCode -eq 0) { ...switch; continue }
if ($nx.ExitCode -eq 75) { Invoke-UiRestWithSummary -Cli $task.Cli -WakeTime ([DateTimeOffset]::FromUnixTimeSeconds([long]$nx.Json.resetAtEpoch).LocalDateTime.AddMinutes($buffer)); $script:AcctCurrent=$nx.Json.account; continue }
# fallbacks: before $limitedUntil[...] = Get-RunnerResetTime (:3622); Wait branch :3461-3470; switch :3493; Add-RunsCsvRow -Account (:823/:3238/:3570); $RunsCsvHeader (:84)
# Get-ClaudeUsageResetTime (:2647): Invoke-NativeProcess -Command $AcctShiftBin -Arguments exec claude --account A -- -p /usage
# v2-root extra: Invoke-Verifier :3331-3337, Invoke-Planner :3396-3402, single :3834-3855, fallbacks :4212-4225, Wait :4066
```

### v2 engine (`v2/lib`)

```powershell
# Invoke-CliRoleOnce: move Resolve-CliLaunch (Cli.ps1:506) INSIDE the while loop so the account can change:
$launch = if ($acct) { Resolve-CliLaunch -Command $AcctShiftBin -CliArgs (@('exec',$inv.Exe,'--account',$acct,'--')+$inv.Args) } else { Resolve-CliLaunch -Command $inv.Exe -CliArgs $inv.Args }
# limit branch (Cli.ps1:544) BEFORE the >24h / sleep logic (:548-563):
$nx = Invoke-AcctShift @('next',$cli,'--from',$acct,'--limited-until',$epoch)
if ($nx.ExitCode -eq 0) { $acct=$nx.Json.account; Write-Host "[acct] $cli $old -> $acct"; continue }   # retry now, no sleep
if ($nx.ExitCode -eq 75) { $resetTime = FromUnix($nx.Json.resetAtEpoch).AddMinutes(5); $acct=$nx.Json.account }  # then existing >24h/deadline/sleep logic
# auth branch (:578-582): Invoke-AcctShift mark $cli --account $acct --auth-failed; then next; only call Set-V2AuthDeadCli when next returns 69/77
# Get-V2NextRoleChainCandidate (:427): skip an auth-dead CLI only if acctshift has no usable account left
# Preflight (Preflight.ps1:71-81 rule 3 "consecutive steps share a limit bucket"): same bucket on DIFFERENT accounts is not the same limit -> allow it, or warn only
# v2.ps1 params: -AccountRotation auto|off|required, -AcctShiftPath; Budget: count AccountSwitches; LimitSleepSec unchanged
```

Because v2 never resumes a conversation, switching account there is always safe: the same prompt is simply re-run.

### Fallback when acctshift is absent

- `resolve_acctshift` fails, so `ACCTSHIFT_BIN` is empty. Every hook is skipped, the CLI is called directly, and the legacy waits stay.
- During a run:
  - `next`/`pick` returning 69 (or anything other than 0/75) → legacy path.
  - `exec` returning 125 → handled as a normal CLI error (retry budget), with the `acctshift: …` message shown.

---
## (d) Contract acctshift must provide (contract 1)

- **Output rules:**
  - stdout = exactly one line of UTF-8 JSON, no BOM, ending in a newline. Nothing else goes to stdout when `--json` is given.
  - Keys are camelCase, and no two keys may differ only in case: PowerShell 5.1 `ConvertFrom-Json` rejects that.
  - Every response carries `"contract":1`. Absent values are `null`.
  - Errors still print JSON: `{"contract":1,"error":{"code":"…","message":"…"}}`, plus the exit code.
- **Commands limitshift uses:**
  - `acctshift version --json` → `{"name":"acctshift","version":"x.y.z","contract":1,"supportedClis":["claude","codex","agy"]}`
  - `acctshift list <cli> [--pool a,b] --json` → `{"contract":1,"cli":"claude","accounts":[{"name":"main","native":true,"state":"ready|limited|auth-failed|disabled","limitedUntil":null,"limitedUntilEpoch":null}]}`
  - `acctshift pick <cli> [--prefer A] [--pool a,b] --json`, and `acctshift next <cli> --from A --limited-until <epoch|RFC3339> [--reason limit|auth] [--pool a,b] --json` → `{"contract":1,"cli":"claude","account":"alt1","previous":"main","switched":true,"available":true,"resetAt":null,"resetAtEpoch":null,"sessionPortable":true,"accounts":[…]}`
  - `acctshift mark <cli> --account A (--limited-until T | --auth-failed | --clear) --json`
  - `acctshift status|doctor --json`
- **Exit codes for those commands (sysexits):**

  | code | meaning |
  |---|---|
  | 0 | an available account was chosen |
  | 64 | usage error |
  | **69** | no rotation possible: unsupported CLI, fewer than 2 accounts in the pool, or acctshift disabled; caller keeps legacy behaviour |
  | **75** | every account in the pool is capped; `account` = the soonest one, `resetAtEpoch` = when |
  | 77 | every remaining account needs re-login (flag for a human or fall back) |
  | 78 | config/state corrupt |

  Mixed case: some accounts limited and the rest auth-failed → 75.
- **`acctshift exec <cli> [--account A] -- <args…>`:**
  - Must not print to stdout, and must not read stdin itself: claude, codex and gemini receive the prompt on stdin.
  - On Unix it should `execve` the CLI (keeps the PID, signals and the `setsid` behaviour).
  - On Windows it should spawn the CLI with inherited handles in a job object, so killing acctshift kills the tree.
  - Exit status is the CLI's own; 125 means acctshift failed before launch, 126 not executable, 127 not found; a signal gives 128+n.
  - Diagnostics go to stderr only, prefixed `acctshift: `, and **never start with `{`**: limitshift merges stderr into the parsed output (sh `:2321`), and the claude/gemini parsers start at the first line beginning with `{`.
  - It must pass the environment through and override any competing auth variables for the child.
  - It must not change `HOME`, `CLAUDE_CONFIG_DIR` or the agy data dir: limitshift reads agy transcripts from `~/.gemini/antigravity-cli`. If that ever changes, `exec` must report the data dir.
  - It must take a lock for agy's single OS-credential slot and hold it for the whole run; while it waits it notes this on stderr. On a timeout it returns 125.
  - On Windows it should resolve npm `.cmd` shims to node+script or to the native binary, and never route argv through `cmd.exe`: copilot and agy get the multi-line prompt as `-p` argv.
- **Performance and robustness:**
  - `pick`/`next`/`version` make no network calls and should take about 20 ms or less; `exec` adds about 20 ms or less.
  - State updates are atomic and file-locked: several limitshift queues can run in parallel.
  - `next` applies a minimum cooldown (e.g. 60 s), so a reset parsed as "now" cannot cause a hot loop. limitshift's `maxRunsPerTask` bounds it anyway.
- **`sessionPortable` per CLI:**
  - claude: true when `~/.claude` history is shared.
  - codex: true when `sessions/` (and the sqlite state) are shared.
  - agy: false or unknown until proven otherwise; limitshift then starts a fresh session with the handoff note.

---
## (e) Queue/profile schema additions and `--validate-only` checks

The schema has `additionalProperties:false` on `settings`, `tasks[]` and `fallbacks[]` (schema `:6-11`, `:63`, `:95`), so the new keys must be added to it. The runners ignore unknown keys, so older limitshift versions tolerate the new keys silently.

```json
"settings": { "accountRotation": { "enum": ["auto","off","required"], "default": "auto",
  "description": "auto: use acctshift when found and a runner's pool has >=2 accounts (or lists accounts explicitly); off: never; required: --validate-only fails if acctshift is missing or a used CLI has no account pool." } }
"tasks[] / fallbacks[] / verify / mission.roles.*": { "accounts": { "oneOf": [
  { "const": false },
  { "type": "array", "items": { "type": "string", "minLength": 1 }, "minItems": 1, "uniqueItems": true } ],
  "description": "acctshift account pool for this runner, in preference order. Omit = every account acctshift has for this CLI. false = opt out (run as the CLI's own login). One name = pin this runner to that account." } }
```

- Leave `accounts` and `accountRotation` **out of the fingerprint**, as is already done for `recoveryAttempts`, so changing a pool does not re-run finished tasks.
- In auto mode, do **not** route a CLI through acctshift when it has only one non-native account, unless the runner asks for it explicitly; otherwise a queue could silently run as an account different from the CLI's own login.
- Profile: document that `limitBuckets` apply per account. Optionally add `clis.<cli>.accounts` (agent-facing). In v2, the same-bucket preflight rule should treat (bucket, account) as the unit.

**`--validate-only` (sh `:2484-2499` / ps1 `:3022-3034`) adds these checks:**
1. Find acctshift and check `contract == 1`, printing `INFO: acctshift <ver> at <path> (contract 1)`.
2. With `accountRotation:"required"` and acctshift missing: `ERROR: settings.accountRotation is "required" but acctshift was not found (set LIMITSHIFT_ACCTSHIFT or install it into bin/)`.
3. Each runner's `accounts` names must exist in `acctshift list <cli>`, otherwise `ERROR: Task N: account "x" is not configured in acctshift for claude (did you mean: y?)`. Reuse the existing Levenshtein helpers `_levenshtein`/`suggest_model_corrections` (sh `:1079-1119`) and `Get-ModelSuggestions` (ps1 `:2788`).
4. `accounts` on an Ollama/`--oss` runner → WARNING, ignored.
5. `accounts` on a CLI outside `supportedClis` (gemini/copilot today) → ERROR, or WARNING and ignore.
6. A pool with fewer than 2 usable accounts → INFO "no rotation".
7. `acctshift doctor --json` problems (expired/missing login) → WARNING per account.
8. agy pools while parallel queues are running → WARNING (single credential slot).
9. Model discovery for agy should run `acctshift exec agy --account X -- models` per pool account, cached as `capabilities/<cli>@<account>.json`.

---
## (f) Installation and how to offer acctshift

- **Today:** clone or download the ZIP and run the script in place (README `:102`, `:114-131`). There is no installer, no PATH change and no dependency other than `jq` (README `:75`).
- **Already-used environment-variable convention** (VERIFIED in code): `LIMITSHIFT_PROFILE_PATH`, `LIMITSHIFT_AGY_DATA_DIR`, `LIMITSHIFT_SOURCE_ONLY`.
- **Discovery order:**
  1. `LIMITSHIFT_ACCTSHIFT` (a path, or `off`/`0`/`false`);
  2. `<limitshift dir>/bin/acctshift[.exe]`;
  3. `acctshift` on PATH.
- **Optional installer:** offer `tools/get-acctshift.sh` and `tools/get-acctshift.ps1`, or `--install-acctshift` / `-InstallAcctShift`. It should:
  - be run explicitly by the user, never automatically during a run;
  - pick the asset by OS and architecture: `uname -s`/`uname -m` on Unix; on Windows `[RuntimeInformation]::OSArchitecture`, falling back to `PROCESSOR_ARCHITEW6432`/`PROCESSOR_ARCHITECTURE`;
  - download a pinned version from the j-ts/acctshift GitHub Releases;
  - verify the SHA-256 against `checksums.txt` (optionally a signature);
  - install into `bin/`, which should be added to `.gitignore` (it isn't there now: `.gitignore` VERIFIED).
- **Docs to update:** README, README.uk.md, REFERENCE, AGENTS, and the schema descriptions.

---
## (g) Test strategy (proven with a POC)

**Approach**
- Keep the existing PATH-stub style (e.g. `write_fake_codex` `tests/test-limitshift.sh:160-178`): add a bash stub `acctshift` that implements contract 1 and stores its state under `$ACCTSHIFT_STUB_STATE`.
- Its `exec` exports `FAKE_ACCOUNT` and `exec`s the CLI stub, so CLI stubs can reply per account.

**Tests to add**
1. Absent / `off` gives the legacy result.
2. Same-session switch to account B with no rest.
3. Order: models first, then accounts.
4. All capped (exit 75): wait for the soonest account.
5. Fallbacks: the runner's `limitedUntil` is the soonest account reset.
6. `exec` exit 125 surfaces as an error.
7. A lost session after a switch starts New *with* the handoff note.
8. `/usage` runs as the same account.
9. Dry-run prints the wrapped command.
10. validate-only errors.
11. runs.csv `account` column.
12. Bash 3.2 safety, using macOS CI.

**Pester**
- The current suite is Windows-only: it hard-codes `powershell.exe` (`tests/limitshift.Tests.ps1:8`) and the `;` PATH separator (`:3`, `:64`).
- Write the new tests with `[IO.Path]::PathSeparator` and the current pwsh path, so they run on Windows (5.1 and 7), macOS and Linux.
- For the v2 engine, Mock an `Invoke-AcctShift` wrapper, the same way the existing tests mock `Start-Process` / `Invoke-CliRoleOnce` (`v2/tests/Cli.Tests.ps1:247-268`).

**Contract test:** run the real acctshift binary's `version/list/pick/next` against a temporary `ACCTSHIFT_HOME` with fake accounts and no credentials.

### Evidence I gathered (commands run)

- **Baseline bash suite** on a copy, Linux, bash 5.2, jq 1.7: `passed: 114 failed: 24`. Fallbacks tests failed with `✗ Task 1 failed (all runners exhausted)` and `Got 'Wait 1 1000', wanted 'Run 2 '`.
- **jq probe:**
  - `jq -n '[10,20,30] | . as $s | (1 + 1) % 3 as $i | {i:$i}'` → `error: number (2) and object ({"i":3}) cannot be divided`. This shows `as` binds only to the term just before it.
  - `select_next_runner`'s expression with nothing limited → `Fail`; with `(($start + .) % $count) as $i` → `Run 0`.
  - After that one-line fix: `passed: 125 failed: 13`. The 13 need real `codex`/`gemini` binaries for validate-only, or the profile.
- **POC bash** (`scratchpad/limitshift-integration/poc/runner/limitshift.sh` plus `poc/bin/{acctshift,claude}`, driver `scripts/poc-scenarios.sh`): **7/7 ok.** Key trace:
  ```
  pick claude --prefer  --json
  exec claude --account a -- -p --session-id 04be735c-… --output-format json --model opus
  exec claude --account a -- -p /usage
  next claude --from a --limited-until 1791414486 --json
  exec claude --account b -- -p --resume 04be735c-… --output-format json --model opus
  runs.csv: …,1,New,1,Limit,claude,opus,a / …,2,Resume,0,Done,claude,opus,b
  ```
  - S2 order: `a:opus a:sonnet b:opus`.
  - S3: "rested" until the soonest account, then resumed on b.
  - S4: `Command: …/acctshift exec claude --account a -- -p --session-id …`.
  - S5: `LIMITSHIFT_ACCTSHIFT=off` → `Command: claude -p …`.
  - S6: Ollama → `Command: ollama launch claude …`.
  - S7: claude a → claude b → codex fallback.
- **POC regression:** the existing suite against the POC script with no acctshift on PATH gave `passed: 123 failed: 15`. The only differences from the fixed baseline are 2 tests asserting the 8-column runs.csv header.
- **POC ps1** (v1 `limitshift.ps1` patched, run with pwsh 7.5.3 on Linux, driver `scripts/poc-ps1-scenarios.sh`): **4/4 ok.**
  - P0: legacy mode runs.
  - P1: switch a → b, same session, `/usage` run as account a, runs.csv `account` column.
  - P2: order as above.
  - P3: `-DryRun` shows `acctshift exec claude --account a -- …`.

---
## Other behaviours that break or must change when the account changes mid-task

1. **Claude `/usage` cross-check** (sh `:1512-1525`, ps1 `:2631-2653`) calls `claude` directly. It must run through `acctshift exec claude --account <the limited account>`, or it reports another account's reset. Done in the POC.
2. **Model-capability cache** `capabilities/<cli>.json` (sh `:1171-1203`, ps1 `:2862-2882`) is keyed by CLI. `agy models` depends on the account ("what your account can use", REFERENCE `:41`): key the cache by `<cli>@<account>` and discover per account. `--probe-models` (sh `:1289-1361`, ps1 `:2968-3017`) also calls CLIs directly.
3. **Sessions:**
   - claude/codex resume after a switch depends on shared history (ai-switcher's own approach copied the jsonl/rollout and resumed, `launcher/ais-run.mjs:10-14`).
   - After a switch, a session-lost error (claude `:2742-2747`) currently restarts New **without** the handoff note in the single-runner path. It should add the note.
   - codex has no session-lost detection; add one.
   - agy `-c` after a credential swap is unproven, so use `sessionPortable:false` and start fresh with the handoff note.
4. **Auth:** v1 has no 401/403 handling. v2 kills the whole CLI for the run (`Cli.ps1:20-35`). With accounts, an auth failure should rotate the account (`mark --auth-failed`, then `next`).
5. **Persisted per-task account:** `sessions/task-NN-account.txt` and `task-NN-runner-K-account.txt` (one name in both runners). Delete them on fingerprint invalidation (sh `:2591-2602`, ps1 `:3127-3138`); add `account=` to the v2-root run-state.
6. **runs.csv:** `account` is added as the 9th column. Existing files keep their 8-column header, so rewrite the header once, or rotate to `runs-<ts>.csv`.
7. **UI:** add the account to the task header and the "Hit a usage limit" message; "all N accounts capped" is new wording.
8. **Run budget:** every switch uses one run. Advise raising `maxRunsPerTask` for pools; keep counting so loops stay bounded.
9. **Ollama/`--oss` runners** (codex too, which `is_ollama_runner` does not cover, sh `:764-773`) must bypass acctshift.

## Pre-existing bugs found (not about accounts, but relevant)

- **jq precedence:** `select_next_runner` (v1 `limitshift.sh:1579`, v2-root `:2043`) makes bash `fallbacks` tasks fail immediately. Fix: `(($start + .) % $count) as $i`.
- **v2-root sh** `task_field "$i" "path"` (`:3150`, `:3215`, `:3646`, `:4103`): queue tasks and mission tasks both use `projectPath` (`new_mission_task_object` uses `--arg projectPath`), so `working_dir` is always empty and the claude `/usage` cross-check never runs.
- **`${trimmed_reason,,}`** (v1 sh `:2825`, `:3209`; v2-root `:3759`, `:4143`) needs bash 4, but the header claims bash 3.2+ for macOS (bash 3.2 has no `,,` case conversion: INFERRED, well known). `read -t 0.01` (`:542`, `:611`) is harmless there.
- **Session file name:** sh `task-NN.session` vs ps1 `task-NN-session-id.txt`.
- **Resume flag spelling:** gemini `--resume=<id>` (sh) vs `--resume <id>` (ps1); copilot the other way round.


## Open questions

- Real accounts: does `claude --resume <uuid>` keep working when CLAUDE_CODE_OAUTH_TOKEN switches between two subscriptions while ~/.claude history is shared? Is the transcript ever rejected server-side?
- Real accounts: does `codex exec resume <thread_id>` find the rollout from a per-account CODEX_HOME whose sessions/ links to the shared dir, or does codex 0.161 also need its sqlite state (CODEX_SQLITE_HOME) shared? What exact error text does codex print for an unknown thread id, so limitshift can add 'session lost' detection?
- Real accounts: after an agy keychain-slot swap, does `agy -c` continue the project's last conversation under the new account, or must limitshift start fresh (sessionPortable=false)? Does agy refresh tokens back into the slot during a run? That decides the lock design.
- Exact 401/403 or 'token expired' wording for claude setup-token tokens, codex auth.json refresh failures and agy, so v1 limitshift can classify auth failures and rotate accounts.
- Should the default order become 'accounts before models' (keep the preferred model and use other accounts first) for some users? That needs per-(account, bucket) limit tracking in acctshift; decide whether v1 of the integration exposes settings.accountRotation.order.
- Windows PowerShell 5.1: run the ps1 POC hooks for real (I only ran pwsh 7.5.3 on Linux). Also check that Invoke-NativeProcess launching acctshift.exe → npm codex.cmd/copilot.cmd keeps multi-line -p prompts intact, and that the agy CreateNoWindow path still hides agy's console when acctshift is in between.
- macOS: run the bash suite under /bin/bash 3.2 (expect the `${var,,}` failure at limitshift.sh:2825/3209) and pwsh on Apple Silicon; confirm that a curl-downloaded acctshift arm64 binary runs without Gatekeeper prompts.
- Parallel queues: how should acctshift arbitrate the single agy credential slot between two limitshift processes (block, fail with 125, or pin)? What lock timeout is acceptable for unattended runs?
- runs.csv migration policy for existing 8-column files (rewrite the header in place vs rotate the file); any user tooling parsing runs.csv by column position.
- Should the gemini and copilot CLIs be supported by acctshift at all (e.g., a COPILOT_GITHUB_TOKEN/GH_TOKEN per run, a separate gemini home)? Until then they return exit 69, and limitshift keeps today's wait/fallback behaviour.

## Sources

- limitshift v1 bash runner (build_cli_args, parse_cli_output, reset parsing, select_next_runner bug, run loop): /home/user/j-ts/limitshift/limitshift.sh (lines 22-24, 725-831, 1121-1287, 1363-1604, 1691-1888, 1890-1996, 2006-2142, 2219-2357, 2397-2499, 2527-3314)
- limitshift v1 PowerShell runner (Invoke-NativeProcess, Get-CliArguments, ConvertFrom-CliOutput, reset functions, main loop): /home/user/j-ts/limitshift/limitshift.ps1 (lines 1-118, 823-850, 923-1207, 1346-1516, 1705-1961, 2001-2097, 2224-2515, 2517-2755, 2797-3060, 3100-3760)
- limitshift v1 queue schema (additionalProperties:false at settings/tasks/fallbacks): /home/user/j-ts/limitshift/limitshift-queue.schema.json
- limitshift v1 README/REFERENCE (installation, rotation semantics, state folder): /home/user/j-ts/limitshift/README.md (:75, :102, :114-131, :297-336); /home/user/j-ts/limitshift/REFERENCE.md
- limitshift v1 profile (limitBuckets, routing): /home/user/j-ts/limitshift/limitshift-profile.json; limitshift-profile.example.json
- limitshift v1 tests (PATH stub pattern; runs.csv header assertions): /home/user/j-ts/limitshift/tests/test-limitshift.sh (:160-243, :962, :3489-3547, :3907-3961, :4181); tests/limitshift.Tests.ps1 (:1-80, :1138, :1174, :3472)
- limitshift-v2 root runners (verify/planner limit loops, run-state, 'path' field bug, same jq bug): /home/user/limitshift-v2/limitshift.sh (:734-741, :2014-2058, :2242-2247, :2409-2440, :2528-2637, :3060-3075, :3113-3217, :3632-3648, :3901-3940, :4091-4105); /home/user/limitshift-v2/limitshift.ps1 (:85, :2795-2864, :3293-3402, :3834-3855, :4066, :4212-4225)
- limitshift-v2 modular engine (Cli.ps1 invocation, limit sleep, auth-dead, role fallback; Budget; Preflight; Profile): /home/user/limitshift-v2/v2/v2.ps1; v2/lib/Cli.ps1 (:9-47, :244-323, :353-411, :476-715); v2/lib/Budget.ps1 (:62-102); v2/lib/Preflight.ps1; v2/lib/Profile.ps1; v2/lib/Executor.ps1:35; v2/lib/Planner.ps1:73; v2/lib/Verifier.ps1:19
- limitshift-v2 CHANGELOG (1.3.0 run-state, 1.4.0 verify, 1.5.0 mission): /home/user/limitshift-v2/CHANGELOG.md
- ai-switcher requirements (user-owned files only): limit detectors, rotation state, cross-profile resume approach: /home/user/ai-switcher/launcher/ais-limits.mjs; launcher/ais-state.mjs; launcher/ais-run.mjs (:1-14); launcher/ais.mjs (:1-60)
- POC: stub acctshift (contract 1) + account-aware stub claude + patched bash runner + scenario driver (7/7 ok): /tmp/claude-0/-home-user/228bfb4e-0bd0-5413-8490-21fae890d3fa/scratchpad/limitshift-integration/poc/bin/acctshift; poc/bin/claude; poc/runner/limitshift.sh; scripts/poc-scenarios.sh
- POC: patched v1 limitshift.ps1 under pwsh 7.5.3 on Linux + driver (4/4 ok): /tmp/claude-0/-home-user/228bfb4e-0bd0-5413-8490-21fae890d3fa/scratchpad/limitshift-integration/poc-ps1/limitshift.ps1; scripts/poc-ps1-scenarios.sh
- Test logs: v1 bash baseline (114/24), jq-fixed (125/13), POC regression (123/15), v2 Pester on Linux pwsh (313/5): /tmp/claude-0/-home-user/228bfb4e-0bd0-5413-8490-21fae890d3fa/scratchpad/limitshift-integration/{v1-bash-tests.log,v1-bash-tests-fixed.log,poc-suite-tests.log,v2-pester-linux.log}
- PowerShell 7.5.3 linux-x64 release asset and Pester 5.7.1 (downloaded to scratch for verification, then deleted): https://github.com/PowerShell/PowerShell/releases/download/v7.5.3/powershell-7.5.3-linux-x64.tar.gz ; https://www.powershellgallery.com/api/v2/package/Pester/5.7.1
