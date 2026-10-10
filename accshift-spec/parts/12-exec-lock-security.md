## 12. Process execution (`exec`)

### 12.1 Contract

`accshift exec <cli> [--account A | --prefer A] [--pool a,b] [--slot-wait S] [--status-file P] [--track] [--allow-bare] [--allow-apikeyhelper] [--allow-settings-env] [--allow-base-url] -- <args…>` (flag types and defaults: §10.4):

- **With `--account` (always the case for LimitShift):**
  - exec MUST NOT pick, rotate, retry, relaunch, or parse the cli's output;
  - it runs exactly that account, even if accshift believes it is limited (the caller decides). It refuses only in the cases of this table:

    | Account `A` | exec |
    |---|---|
    | `ready`, `limited`, `needs-attention`, or `needs-relogin` with reason `rejected` or `refresh-dead` (or `missing` once the credential is back, below) | runs it |
    | no account of this cli has that name | 125 `unknown-account` |
    | `disabled` | 125 `account-disabled` |
    | past `expiresAt` | 125 `needs-relogin`, status-file `error.reason:"expired"`. Nothing is written; the reason is derived (§9.2) |
    | its credential is absent (below) | records `relogin` with reason `missing` under `state.lock`, then 125 `needs-relogin`, `error.reason:"missing"` |

  - **Credential presence** is checked by exec itself on every run, per kind: claude §8.1, codex §8.2, agy §8.3.3 B.6. For the other kinds:
    - copilot `token` needs its vault entry `<cli>/<id>`;
    - copilot `gh` is not checked here; a failing `gh` helper gives `gh-token-unavailable` (§8.5);
    - a `native` account is never checked.
  - A stored `relogin(missing)` does not refuse by itself: once the credential is present again, exec runs. Only `login` or `mark --clear` removes the record (§9.2).
  - The notice gate does not apply: `exec --account` runs even when the provider notice is not accepted (§9.3).
- **Without `--account`:**
  - exec performs `pick <cli> [--prefer P] [--pool …]` (no `--model`), including its notice gate (§9.3), and then runs the picked account under the table above;
  - a pick outcome other than 0 exits 125: 75 → `all-capped`; 77 → `needs-relogin` (`error.reason` null); 69 → `empty-pool`, `unsupported-cli` or `notice-not-accepted`;
  - when stderr is a terminal and accshift is interactive (§7.5), it prints the catalogue line `accshift: note: account picked automatically; the status file and --debug name it`, so a person never bills an unexpected subscription silently. The account name itself never goes to stderr (§12.1.1).
- **argv:** everything after `--` is passed to the cli **byte-for-byte and in order**. accshift's own options appear only before `--`.
  - The one exception is the secret-isolation argument of §7.6. For copilot `token` and `gh` runs, exec prepends `--secret-env-vars=COPILOT_GITHUB_TOKEN` when the caller's argv does not already contain it, and reports it in the status file's `addedArgs`. The list lives in `facts.go`; today it has no other entry.
  - exec adds nothing else. Codex `-c` switches are never applied, and `run`'s codex `--no-daemon` is a `run`-only exception (§8.2, §16).
- **Never prompts.** exec never prompts and never reads the terminal, whatever stdin is (§7.5). Any condition that would need input takes the non-interactive branch: an unregistered agy login in the slot gives 125 `agy-slot-unregistered` (§8.3.3 B.5), and a locked keystore or a missing vault passphrase gives 125 `keystore-unavailable`.
- **Standard streams:**
  - exec MUST NOT read, buffer or close stdin; the cli inherits it directly. claude and codex receive prompts on stdin [R08 §a1].
  - It MUST NOT write to stdout, and it never pipes or copies the cli's stdout or stderr.
- **Exit status:** the cli's own, or `128+n` for a signal death on POSIX. Only 125, 126 and 127 are reserved for accshift itself (§12.1.1).
- **What exec does not do:**
  - it does not classify output; that is the caller's job, or `run`'s (§16);
  - it never reports success, and never changes strikes, backoff, `lastUsedAt` or `lastOkAt`, on any path or OS. Success is reported only by `mark --ok` (§9.2).
  - Its only `state.json` writes are `relogin(missing)` (above), the agy post-run bookkeeping (`agySlot`, `wrongAccount`, `relogin(rejected)` on an emptied slot, `saveBackPending`; §8.3.3 C.3) and the `agyBinary` cache (§8.3.1). Each is one short `state.lock` transaction (§13.1).
- **Order of checks.** exec stops at the first failure, in this order:
  1. flags and the cli (`usage`, including a `--status-file` whose directory does not exist; `unknown-cli`, `unsupported-cli`);
  2. the root (`usage` for a relative root, `wrong-owner`, `unsupported-filesystem`; a loose mode is tightened without a notice, §6.1);
  3. accounts.json and state.json (`config-corrupt`, `config-newer-version`);
  4. the account: its name, `disabled` and `expiresAt` (the table above), or the pick;
  5. the binary (§12.2: 127, 126);
  6. the run plan's refusals (`bare-ignores-token`, `apikeyhelper-overrides-token`, `settings-env-overrides-token`, `base-url-would-receive-token`, `agy-env-overrides-slot`);
  7. the credential: the vault and keystore (§7), the presence check above (which may record `relogin(missing)`), the copilot `gh` helper, and for agy the slot algorithm (§8.3.3);
  8. the status file, then the launch (§12.3, §12.4).

#### 12.1.1 exec's own failures, stderr and the status file

- **Exit codes:**
  - **125:** any failure before the child starts, whatever code a control verb (§10.1) would use for the same condition: 64, 65, 69, 70, 73, 74, 75, 77 or 78 (§10.3). A cli's own exit statuses include those numbers, so exec cannot use them.
  - **126:** the binary was found but cannot be executed: `not-executable` (no execute permission, or not an executable for this OS), `cmd-shim-unsupported` (§12.4) or `wsl-windows-binary` (§12.2).
  - **127:** the binary was not found: `not-found` (§12.2).
  - `run` follows the same rules (§16).
- **Exit 125 reasons** (sent as `error.code`). This is the closed set; Appendix E lists the same codes:

  | `error.code` | Cause |
  |---|---|
  | `usage` | bad, unknown or conflicting flags; a relative `--home`, `ACCSHIFT_HOME` or `ACCSHIFT_<CLI>_BIN`; a `--status-file` path that cannot be written (§10.1, §6.1, §12.2) |
  | `unknown-cli` | the cli name is not one accshift knows |
  | `unsupported-cli` | a known cli that exec cannot run on this OS (§4.2) |
  | `unknown-account` | `--account` names no account of this cli |
  | `account-disabled` | `--account` names a disabled account |
  | `needs-relogin` | with `--account`: the credential is absent (`reason:"missing"`, recorded) or past `expiresAt` (`reason:"expired"`); when picking: every remaining candidate needs a human (pick 77) |
  | `all-capped` | only when picking: every waiting candidate is time-limited (pick 75) |
  | `notice-not-accepted` | only when picking: the provider notice is not accepted (§9.3) |
  | `empty-pool` | only when picking: no candidate remains (§9.3) |
  | `wrong-owner` | the root or a file in it belongs to another user (§6.1) |
  | `unsupported-filesystem` | the root is on a refused filesystem (SMB, drvfs, …), or its permissions cannot be tightened (§6.1) |
  | `config-corrupt` | accounts.json or state.json does not parse or fails validation, for example a relative `clis.<cli>.bin` (§6.4, §12.2) |
  | `config-newer-version` | a file was written by a newer accshift (§6.4) |
  | `vault-corrupt` | the vault fails its integrity check (§7.2) |
  | `vault-changed` | the vault header changed after this process unwrapped the key (§7.2) |
  | `vault-busy` | `vault.lock` could not be taken within 15 s (§13.1) |
  | `state-busy` | `state.lock` could not be taken within 5 s (§13.1) |
  | `slot-busy` | the agy slot lock wait exceeded `--slot-wait` (§13.1) |
  | `agy-busy` | an agy process accshift did not start blocks the agy exclusive path; the root is on NFS without `settings.agyAllowNetworkHome`; or three shared rounds failed (§8.3.3 B.2, B.9) |
  | `keystore-unavailable` | the vault key or keystore cannot be used: locked, timed out, a missing key item or key file, a key file with the wrong owner or mode (`error.reason:"key-file-permissions"`), or a passphrase needed in non-interactive mode (§7.3, §7.5); also a slot read error during agy recovery (§13.3), or an agy save-back that failed for one of these reasons (§8.3.3 B.5) |
  | `keychain-prompt-required` | macOS would need a GUI prompt to read back the agy item; the write was rolled back (§8.3.3 B.8) |
  | `agy-keyring-locked` | agy's keyring is in scope but cannot be read: locked, unreachable or absent, slower than 4 s, or it would prompt (§8.3.2) |
  | `agy-slot-unregistered` | agy's slot holds a login for an email no account has; nothing was written (§8.3.3 B.5) |
  | `agy-env-overrides-slot` | an `AGY_LLM_GATEWAY_*` variable is set, so agy's gateway auth would decide the account (§8.3, Appendix A.3); overridden by `--allow-settings-env` |
  | `slot-write-failed` | the agy slot could not be written or verified and was restored, or the B.5 save-back failed for a reason other than the key or a lock, such as a full disk (§8.3.3) |
  | `bare-ignores-token` | the caller passed `--bare` to claude with a token account (§8.1); overridden by `--allow-bare` |
  | `apikeyhelper-overrides-token` | a claude `apiKeyHelper` setting would outrank the token (§8.1); overridden by `--allow-apikeyhelper` |
  | `settings-env-overrides-token` | a claude settings `env` block would re-introduce a removed or overriding variable (§8.1); overridden by `--allow-settings-env` |
  | `base-url-would-receive-token` | `ANTHROPIC_BASE_URL` points to a non-vendor host that would receive the token (§12.5); overridden by `--allow-base-url` |
  | `classic-pat-unsupported` | the copilot `gh` kind returned a classic `ghp_` token, which Copilot ignores (§8.5) |
  | `gh-token-unavailable` | `gh auth token` returned nothing, failed or timed out (§8.5) |
  | `cmdline-too-long` | Windows: the command line would exceed 32,767 characters; POSIX: `execve` / process start returned `E2BIG` (for example one argument over 128 KiB on Linux, or argv plus env over `ARG_MAX`) |
  | `internal` | a bug (a control verb would exit 70) |

- **Caller actions.** exec itself never retries. LimitShift's action per code is the table in §15.2: the busy codes are transient, `needs-relogin`, `account-disabled` and `unknown-account` lead to a new `pick`, and most others need a human.
- **stderr rules.** LimitShift merges stderr into the output it parses, so a stray phrase would cause a false limit detection [R08 C3].
  - **Before the child starts**, exec writes at most:
    - on a pre-launch failure, exactly one line `accshift: error <code>: <catalogue message>`, for example `accshift: error unknown-account: no such account is registered`. It is the last line exec writes;
    - while it waits for the agy slot lock, `accshift: waiting for the agy slot lock`, at most once every 10 s (§13.1), and the auto-pick notice of §12.1. Both appear only when stderr is a terminal and accshift is interactive (§7.5), so LimitShift never sees them.
  - **After the child has started, exec writes nothing to stderr**, on any path. Post-run findings (a wrong account, lingering agy processes that were stopped, copy-back conflicts, failed save-backs) go only to the status file (`wrongAccount`, `postRunError`), `state.json` and `events.jsonl`. A permission fix is logged with `--debug` only (§6.1).
  - Every line starts with `accshift: `, never starts with `{`, and is copied verbatim from a **fixed message catalogue**. Messages interpolate nothing: no digits, pids, paths, `PATH`, labels, account names or durations. Those go to the status file and to `--debug`. For example, the 127 line names neither the binary nor the directories searched.
  - **No catalogue line may match any of LimitShift's limit or auth regexes** (`usage limit`, `rate limit`, `quota`, `429`, `too many requests`, `try again (at|in)`, `resource_exhausted`, `credits`, …). Because nothing is interpolated, the catalogue is the complete set of lines, and no rule on account names is needed.
  - **The catalogue ships with every release.** `accshift version --json` returns it as `stderrCatalogue` (§11.2), and each release includes `testdata/stderr-catalogue.txt`. LimitShift's own test suite asserts that its regexes, including ones it adds later, match none of these lines (§15.10). accshift's CI checks that every line has the `accshift: ` prefix and contains no digit, and runs it against the regexes of the LimitShift releases it was tested with (`limitshift.sh`, `limitshift.ps1`, `v2/lib/Cli.ps1`).
  - LimitShift also drops every line matching `^accshift: ` before its regex matching and JSON extraction (§15.3).
  - `--debug` output is for people and outside these rules; LimitShift never passes it. There is no `--verbose`.
- **`--status-file PATH`** (LimitShift MUST pass it; the shape is in §11.2 and Appendix D.4): one contract-1 JSON line `{contract, launched, cli, account, exitCode, error, addedArgs, foreignAgy, wrongAccount, postRunError}`. It tells a caller a cli's own exit 125–127 apart from accshift's, and carries the `error.code`.
  - exec writes it atomically (a temp file in the same directory, mode 0600, then rename; §13.2), replacing any earlier file. The caller deletes it before each run.
  - **Pre-launch failure:** `launched:false`, `exitCode` 125, 126 or 127, and `error:{code, reason}`. `reason` is `missing` or `expired` for `needs-relogin` with `--account` (null when exec picked the account), `key-file-permissions` for a `keystore-unavailable` from the key-file check (§7.3), else null.
  - **execve path:** written just before `execve` with `launched:true` and `exitCode:null`. If `execve` returns (for example `E2BIG` or `ENOEXEC`), exec rewrites it with `launched:false` and the error, then exits 125, 126 or 127.
  - **spawn path:** written before the child starts with `launched:true` and `exitCode:null`. If the start fails, it is rewritten as for execve. Otherwise it is rewritten after the child has exited and the post-run hooks have run, with `exitCode` (the child's status, or 128+n) and the post-run fields. `--track` forces the spawn path on POSIX, so that `exitCode` is recorded (§12.3).
  - `account`: the account name exec ran or tried to run (the picked one without `--account`), else null.
  - `addedArgs`: the argument exec prepended (§12.1, §7.6), else `[]`.
  - `foreignAgy`: true when agy's shared fast path ran while an agy process accshift did not start was running (§8.3.3 A.5), else false.
  - `wrongAccount`: null, or `{expected, found, observedAt, observedAtEpoch}`, with emails (agy only, §8.3.3 C.3). LimitShift then re-runs the task without calling `next` (§15.2).
  - `postRunError`: null, or `{code, reason}` for a failed or skipped post-run hook, for example `save-back-failed`, `agy-slot-unregistered` (restore-after-run skipped), `copy-back-conflict`, `copy-back-skipped` or `copy-back-failed` (Appendix D.4).
  - A path that cannot be written before launch is 125 `usage`, reported on stderr only. A failed rewrite after the child has exited is recorded in `events.jsonl` and never changes the exit status.
- **Post-run hook failures** never change the exit status exec returns. Each one sets `postRunError`, records an event, and writes nothing to stderr. A failed agy save-back leaves the slot untouched and sets `state.agySlot.saveBackPending`; the next exclusive slot holder performs it first (§8.3.3 C.3, §7.1).

### 12.2 Resolving the cli binary

Order:
1. `ACCSHIFT_<CLI>_BIN` (for example `ACCSHIFT_CLAUDE_BIN`);
2. `config clis.<cli>.bin`;
3. `PATH` lookup. On Windows this honours `PATHEXT`.

- `ACCSHIFT_<CLI>_BIN` and `clis.<cli>.bin` MUST be absolute paths.
  - A relative `ACCSHIFT_<CLI>_BIN` is a usage error (64 `usage`; 125 `usage` for `exec` and `run`).
  - A relative `clis.<cli>.bin` is rejected by `config` with 65 `invalid-config` (§10.2). Found in accounts.json, it fails registry validation: control verbs exit 78 `config-corrupt`, and `exec` and `run` exit 125 `config-corrupt` (§6.4).
- **The current directory is never searched, on any OS.** A `LookPath` result that errors with `exec.ErrDot` (an empty or relative `PATH` entry, or the Windows implicit current directory) is treated as not found. LimitShift runs inside untrusted project directories, and a repository's own `./claude` must never receive a token.

The binary name per cli: `claude`, `codex`, `agy` (also try `antigravity`), `gemini`, `copilot`.
- Not found → `exec` exits 127 (`not-found`). The directories searched go only to `--debug`, never to stderr (§12.1.1).
- Found but not executable (no execute permission, or not an executable for this OS) → 126 `not-executable`.
- `add` and `doctor` report the same conditions as a finding or hint, with the searched `PATH`.

**WSL interop.** On Linux, if `/proc/sys/fs/binfmt_misc/WSLInterop` (or `WSLInterop-late`) exists and the resolved binary lies on a drvfs/9p mount or starts with the PE magic `MZ`, `exec` refuses with 126 `wsl-windows-binary`. A Windows process started from WSL receives Linux variables only through `WSLENV`, so neither the set list nor the unset list would apply, and agy would read the Windows slot. The hint: install the Linux build inside WSL, or run the Windows accshift from Windows. `add` and `doctor` apply the same check.

### 12.3 POSIX launch (Linux, macOS)

Which path a run takes:

| Path | Used for |
|---|---|
| execve | claude (all kinds), codex (all kinds; Windows copy mode does not exist on POSIX), copilot (all kinds) |
| spawn | agy (always), and any cli when `--track` is given |

Windows always uses the spawn path (§12.4). `--track` exists so that a caller who wants `exitCode` in the status file can get it on POSIX too (§12.1.1); LimitShift does not need it, because it sees the exit status itself.

**Process attributes are restored before launch, on both paths.** accshift never changes its umask (§6.1) and never ignores signals, so the child inherits the caller's umask and signal dispositions. Core dumps of accshift itself are disabled without leaking into the child:
- Linux: `prctl(PR_SET_DUMPABLE, 0)`, which `execve` resets;
- macOS: save `RLIMIT_CORE` at start, set it to 0, and restore the saved value immediately before `syscall.Exec` or `cmd.Start`; on the spawn path re-apply 0 right after `Start`.

A contract test runs a fake CLI that records its umask, `ulimit -c` and ignored-signal mask (Linux `SigIgn` in `/proc/self/status`; macOS through `sigaction`), and all three must equal the caller's.

- **execve path** (no lock to hold and no post-run hook):
  - build the final env and argv (§12.5; the one added argument, §12.1);
  - run pre-run hooks (link refresh);
  - write the status file (`launched:true`, `exitCode:null`);
  - make sure no lock is held: `state.lock` is taken only for the short transactions of §12.1, and every lock fd is close-on-exec (§13.1);
  - `syscall.Exec`. If it returns, rewrite the status file and exit 125, 126 or 127 (§12.1.1).
  
  The cli takes over the PID, signals and controlling terminal, so it behaves exactly as if the caller had launched it (LimitShift's `setsid` wrapping keeps working) [R08 §d]. Cost: about 2 ms [R01 §2.3]. Nothing is recorded after the launch. On no path does exec record success or `lastUsedAt`; `next` and `mark --ok` do (§9.2).
- **spawn path:**
  - start the child in the **same process group**, so the terminal's Ctrl+C reaches it directly (this rule is for `exec`; the phase-2 `run` wrapper uses its own group, §16);
  - accshift catches SIGINT and SIGQUIT with `signal.Notify(ch, syscall.SIGINT, syscall.SIGQUIT)` installed **before** `cmd.Start` and drains the channel; the Go runtime resets caught signals to their defaults in the child. `signal.Ignore` and `SIG_IGN` MUST NOT be used on any OS, because ignored dispositions are inherited and would make Ctrl+C stop working in the agent's tool subprocesses;
  - accshift forwards SIGTERM and SIGHUP to the child;
  - Linux: set `Pdeathsig = SIGTERM`, so the child dies if accshift is SIGKILLed while holding a lock. Pdeathsig fires when the forking OS thread exits, so the goroutine that calls `cmd.Start` MUST call `runtime.LockOSThread()` first and stay locked until `cmd.Wait` returns;
  - macOS has no equivalent: a SIGKILL of accshift leaves the child running with launchd as its parent. Safety then relies on the journal (§13.3) and on the exclusive path's foreign-process check (§8.3.3 B.2), which sees the orphan and refuses every swap and recovery until it exits. (An optional later refinement is a small guard process that watches its parent with kqueue `NOTE_EXIT` and stops the CLI; it is not part of v1.)
  - write the status file (`launched:true`, `exitCode:null`) before `cmd.Start`;
  - wait for the child, run post-run hooks (a failure never changes the exit status, §12.1.1), rewrite the status file, release locks, exit with the mapped status.

### 12.4 Windows launch

- Always the spawn path; Windows has no execve.
- Create a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, explicitly **without** `BREAKAWAY_OK` or `SILENT_BREAKAWAY_OK`. Go's `os/exec` closes the child's primary thread handle, so "start suspended, then resume" cannot be built on it. One of these two mechanisms is used:
  - (a) call `windows.CreateProcess` (x/sys) directly with `CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT` and an explicit handle list for stdio, then `AssignProcessToJobObject`, then `ResumeThread(pi.Thread)`; or
  - (b) assign accshift's own process to the job before `cmd.Start`, so the child inherits membership with no race.
  
  Killing accshift then kills the whole tree. Nested jobs (Windows 8+) are fine when accshift itself runs inside a job (Windows Terminal, CI). Unlike POSIX, daemons the CLI starts (for example a Codex app-server) die when accshift exits; V-W1 records the effect.
- Handles are inherited (stdin, stdout, stderr) and the child shares the console.
- accshift MUST NOT allocate a new console. The child always inherits accshift's console, hidden or not.
  - limitshift.ps1 starts a process with `CreateNoWindow` only in the agy branch of `Invoke-NativeProcess`, which runs only when `-Cli` is passed. Today `Invoke-CliTaskRun` never passes `-Cli`, so that branch is dead code. LimitShift change P7 (§15.1) passes `-Cli` with the real cli name (not `accshift`); accshift.exe is then started windowless for agy, and agy runs in that hidden console.
  - A hidden console handle looks like a TTY to Go's terminal check, which is one reason exec never prompts (§12.1, §7.5). V-L1 includes an agy case.
- **Ctrl+C, Ctrl+Break and console close:** accshift must survive Ctrl+C and return the child's exit code; the child receives the console events natively through the shared console.
  - accshift calls `signal.Notify(ch, os.Interrupt, syscall.SIGTERM)`. Go delivers CTRL_C and CTRL_BREAK as `os.Interrupt`, which accshift drains.
  - Go delivers CTRL_CLOSE, CTRL_LOGOFF and CTRL_SHUTDOWN as SIGTERM. Windows allows only about 5 s after these, so accshift runs the agy post-run save-back at once (§8.3.3) and exits.
  - `SetConsoleCtrlHandler(NULL, TRUE)` is not used: it covers only CTRL_C, so Ctrl+Break would still end accshift and the job would kill the CLI without a save-back.
  - `signal.Ignore(os.Interrupt)` MUST NOT be used. On Windows the Go runtime's console handler then returns FALSE, the default handler calls `ExitProcess`, and the kill-on-close job kills the CLI too (verified in the Go runtime source by the technical judge, DECISIONS.md D1).
- Map the child's exit code straight through.
- **argv quoting:**
  - Native `.exe` targets get one command line built with the CommandLineToArgvW rules (Go `syscall.EscapeArg` semantics), passed via `SysProcAttr.CmdLine` to avoid double escaping.
  - **`.cmd` / `.bat` targets MUST NOT be launched with argument strings through cmd.exe** (BatBadBut class; golang/go#69939 is still open) [R01 C9]. Instead:
    1. **npm cmd-shim resolution:** parse the shim and recognise npm's two `cmd-shim` templates:
       - the JS template, with its `%~dp0`/`%dp0%`, `node.exe` probing and `"%_prog%" "…\node_modules\…\<entry>.js" %*` shapes. Resolve the JS entry and launch `node.exe <entry.js> <args…>` (node from the shim's own directory if present, else PATH);
       - the direct-target template, `"%dp0%\<relative path>.exe" %*` with no node invocation, which npm writes for a bin entry that is a native executable. Resolve the target relative to the shim's directory and launch that `.exe` directly, with the CommandLineToArgvW quoting above. This template is inferred from npm's cmd-shim behaviour, not from a Windows test; a Windows CI fixture with an npm shim that targets an `.exe` covers it (§18).
    2. Launching a package's native binary directly when its shim is the JS template (Codex's `vendor/<triple>/bin/codex.exe`, Copilot's SEA loader) is allowed **only** when that package's `facts.go` entry records that its JS launcher changes no environment. The Codex launcher is understood to prepend its vendored ripgrep directory to `PATH` and set `CODEX_MANAGED_BY_NPM` (**VERIFY V-X6**). Reproducing that would break §12.5's "never change PATH", so Codex always uses step 1.
    3. If neither works:
       - when every argument matches `^[A-Za-z0-9_./:=,+@-]*$` (nothing cmd.exe interprets), run `cmd.exe /d /s /c "<shim> <args>"` with an explicitly built `SysProcAttr.CmdLine`;
       - otherwise exit 126 with `error.code = "cmd-shim-unsupported"` and a hint to set `ACCSHIFT_<CLI>_BIN` to a native executable.

       Prompts always contain other characters, so in practice step 1 (or an allowed step 2) must succeed. `exec.LookPath` resolves bare names to `.cmd` through `PATHEXT`, so accshift MUST inspect the resolved extension before launching.
  - Claude Code's binary is native (`claude.exe`), but an npm install reaches it through a `claude.cmd` shim of the direct-target template [R04 §0]; the native installer puts `claude.exe` on PATH directly. agy (`agy.exe`) is a native executable [R05 §0]. Codex and Copilot installed through npm are JS-template shims.
- Tests MUST cover prompts containing newlines, `"`, `%`, `^`, `&`, `|`, `<`, `>` and non-ASCII text through every shim path (§18).

### 12.5 Environment construction

`final = parent env − ACCSHIFT_* − scrubList(cli, kind) + extraEnv(account) + setList(cli, account)` (Appendix A). Set-list values always win.
- accshift's own variables (`ACCSHIFT_KEY_FILE`, `ACCSHIFT_HOME`, …) are always removed from the child's environment, so they never leak into the agent's shell.
- `extraEnv` keys must be on the per-cli allowlist in `facts.go` (Appendix D.1).
- Variable names compare case-insensitively on Windows.
- accshift MUST NOT change `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR`, `XDG_*` or `PATH`.
- **Inherited accshift homes.** An inherited `CODEX_HOME` or `CODEX_SQLITE_HOME` whose canonical path resolves inside `<root>/homes/` is accshift's, left there by an `eval "$(accshift env …)"` shell or by an agent that runs accshift again. This path test applies only to these three variables.
  - For codex `native`, `access-token` and `api-key` runs accshift sets `CODEX_HOME=<mainHome>`, or unsets it when `mainHome` is `~/.codex`, and treats `CODEX_SQLITE_HOME` the same way (§8.2).
  - claude's `CLAUDE_SECURESTORAGE_CONFIG_DIR` follows the same path rule (§8.1).
- **Base URLs.** For claude `token` / `login-slot` runs, a base-URL variable (`ANTHROPIC_BASE_URL`; names in `facts.go`) that points to a non-vendor host makes `exec` exit 125 `base-url-would-receive-token` unless `--allow-base-url`. For claude the settings `env` layers are checked too (§8.1).
- **agy gateway variables.** Any `AGY_LLM_GATEWAY_*` variable in the environment exec would pass to agy makes it exit 125 `agy-env-overrides-slot` unless `--allow-settings-env`, because agy's gateway auth would then decide the account, not the slot (§8.3, Appendix A.3).
- **argv is not part of the environment plan.** The only argv change is §12.1's single added argument.
- Secrets go only into the child's environment block, never into argv. (On Linux `/proc/<pid>/environ` is likely owner-only, mode 0400 (unmeasured) [R07 §7]; on Windows the environment block is per-process.) The agent's own subprocesses inherit them unless the vendor removes them (§7.6).

### 12.6 Pre- and post-run hooks (summary)

| cli/kind | Pre-run | Post-run | Locks held during run |
|---|---|---|---|
| claude/* (native included: only the scrub list applies, nothing is injected) | none | none | none (execve) |
| codex/home, native | link refresh (Windows copy mode: copy-in) | Windows copy mode only: copy-back (§8.2) | none on POSIX; `state.lock` only briefly |
| agy/slot | slot lock (shared fast path or exclusive); foreign-process check, which gates only the exclusive path; recovery; save-back commit; journal; write; verify (§8.3.3 A–B) | stop lingering agy descendants first; then read the slots; then the empty-slot, match or mismatch handling, with save-back to the vault; then the optional `agyRestoreAfterRun` swap (§8.3.3 C.3) | `agy-slot.lock` for the whole run |
| copilot/token | prepend `--secret-env-vars=COPILOT_GITHUB_TOKEN` (§12.1) | none | none |
| copilot/gh | `gh auth token --hostname <host> --user <login>` with gh's own token variables removed, output validated (5 s timeout); prepend `--secret-env-vars=COPILOT_GITHUB_TOKEN` | none | none |

A post-run hook failure never changes the exit status; it is reported in the status file's `postRunError` and in `events.jsonl` (§12.1.1).

### 12.7 `env` (standalone and diagnostic only; not used by LimitShift)

- `accshift env <cli> --account A --format sh|ps|cmd|json` prints the env delta: variables to set and to unset. Shell formats print one safely quoted assignment or unset per line, for people who want `eval "$(accshift env claude --account work --format sh --reveal-secrets)"` in their own shell.
- **Secret values are redacted** (`<redacted:claude/3f9a01c2>`, naming the account's `secretId`) unless `--reveal-secrets` is given. JSON lists them under `secretNames`. Without `--reveal-secrets`, `env` never opens the keystore.
- If the plan has a post-run hook or holds a lock for the run (agy slot, Windows codex copy mode), `env` exits 69 with `error.code = "requires-exec"`. `env` cannot run a post-run hook or keep a lock after it exits.
- `env` is a control verb (§10.3). It never prints arguments, so it cannot apply §12.1's added argument: a person who launches copilot from an `env` shell passes `--secret-env-vars=COPILOT_GITHUB_TOKEN` themselves (§7.6).
- `env` runs the idempotent pre-run link refresh for overlay homes, so the returned home is ready. That makes it a writer, for this step only (§6.3).
- **LimitShift MUST NOT use `env` to launch anything** (DECISIONS D3).
  - With `exec`, token values never pass through a long-running runner, and the per-cli scrub lists live in one place.
  - The Windows case for `env` (report 03 C9) was about a PowerShell-implemented accshift and does not apply to a native binary. LimitShift's own `.cmd` shim path cannot carry multi-line argv either, so accshift's shim resolution is the real fix [DECISIONS D3].

## 13. Concurrency, locking and crash safety

### 13.1 Locks

| Lock | Scope | Held for | Timeout |
|---|---|---|---|
| `locks/state.lock` | `accounts.json`, `state.json` | one load, merge, select and write, a few ms. Evidence parsing and vendor-artifact reads (evidence file, transcript tails, Codex rollouts, codex `auth.json` metadata) happen **before** the lock is taken (§9) | 5 s, then exit 73 `state-busy` (`exec`: 125 `state-busy`) |
| `locks/vault.lock` | `vault.v1.bin` (writers only; readers read the whole file and close it immediately) | one write, including at most one keystore call | 15 s, then exit 73 `vault-busy` (`exec`: 125 `vault-busy`) |
| `locks/agy-slot.lock` | agy's credential slot (keyring item and token files) | an `exec agy` run: from acquisition until its post-run save-back is done (a swap may first hand over to a shared lock, §8.3.3 B.9); a control verb: its whole operation | `--slot-wait` (default 30 s, `settings.slotWaitSeconds`), then `exec` exits 125 `slot-busy`. The control verbs that need the slot (`add agy`, `login agy`, `agy use`, `remove agy`, `doctor --fix`) exit 73 `slot-busy` instead |

- POSIX locks use `flock(2)` (gofrs/flock or x/sys); it works with `flock(1)` [R01 C11]. Windows uses `LockFileEx` on a dedicated lock file, never on a data file. Lock fds are close-on-exec and not inheritable.
- **Lock files stay empty.** On Windows `LockFileEx` locks are mandatory over their byte range: a shared lock denies writes to the range, an exclusive lock denies reads. So the lock is taken on a 1-byte range at a fixed high offset (`0x7FFFFFFF`) on every OS, and no code ever writes into a lock file.
- **Waiting.** While waiting for `agy-slot.lock`, `exec` prints `accshift: waiting for the agy slot lock` at most once every 10 s, only when stderr is a terminal and accshift is interactive (§12.1.1). The line names no pid and no account; `doctor` and `--debug` show the holder files. LimitShift treats `slot-busy` and `agy-busy` as transient: it waits and retries without charging its retry budget (§15.2).
- **`agy-slot.lock` modes** follow the A/B/C algorithm of §8.3.3:
  - **shared**: only for an `exec agy` run that takes the fast path (§8.3.2, steps A.1–A.6), when V-A8 has passed for this OS and the installed agy version, `settings.agyRestoreAfterRun` is unset and the root is not on NFS; and for `add agy --capture-current`, which only reads the slots (§8.3.4). A shared holder never writes a slot. Whether a run stays shared is decided by reading the slots under the shared lock (A.4), never from `state.agySlot`, which is a hint for `pick` and `list` only;
  - **exclusive**: every slot write, every recovery, and the save-back that precedes a write: the `exec agy` B path, `agy use`, the restore-after-run swap, `add agy`, `login agy`, `remove agy` (including `--sign-out-slot`) and `doctor --fix`;
  - a held lock is never converted in place. Shared is always released before exclusive is requested, because `flock(2)` conversion is not atomic and `LockFileEx` cannot convert.
- **Intent markers** give swappers writer preference. Each waiting swapper creates its own marker `locks/agy-slot.intent.d/<pid>` (`{pid, startTime, createdAt}`) before it requests the exclusive lock, and removes it when it acquires the lock or times out.
  - A marker is live while its (pid, start time) is alive. Dead markers are ignored and removed by whoever finds them.
  - A shared request defers to live markers for at most min(`--slot-wait`, 10 s) in total, then requests the lock anyway. The wait counts against `--slot-wait`.
- **Holder files.** Each holder writes `locks/agy-slot.holders/<pid>-<starttime>.json` (`{pid, startTime, account, mode, since, childPid, childStartTime}`) after it acquires the lock, records `childPid` and `childStartTime` once agy starts, and deletes the file before it releases the lock. `account` is the account id. Entries whose process is gone are ignored and removed.
  - Waiters, `doctor` and `--debug` read them for the "held by" diagnostics.
  - **The foreign-process check** (§8.3.3) gates only the exclusive path: there no other holder can exist, so every running agy process is foreign and blocks (125 `agy-busy`, control verbs 73). On the shared fast path it is informational: an agy process whose (pid, start time) equals a live holder's `childPid` and `childStartTime` is accshift's; any other sets `foreignAgy:true` in the status file, and the run continues. There is no parent-chain (ppid) rule.
  - The check finds agy processes by executable path: Linux `/proc/<pid>/exe`; macOS `KERN_PROCARGS2` through `unix.SysctlRaw("kern.procargs2", pid)` (never `proc_pidpath`, which needs cgo); Windows `QueryFullProcessImageName` (§8.3.3).
- **Process identity is (pid, start time).** PIDs are reused quickly on Windows and in containers, so a pid alone never proves a process is alive:
  - Linux: field 22 of `/proc/<pid>/stat`;
  - macOS: `kinfo_proc.kp_proc.p_starttime` via `sysctl kern.proc.pid`;
  - Windows: `GetProcessTimes` creation time.
  
  A record whose pid is absent or whose start time differs is dead.
- **Lock order** is always `agy-slot.lock` → `vault.lock` → `state.lock`. Never wait for an earlier lock while holding a later one, so no deadlock is possible.
- Several LimitShift queues MAY run in parallel. Claude, codex and copilot runs never block each other. agy runs on the live account share the slot once V-A8 has passed; swaps serialize on it (§8.3), and a queue that waits longer than `--slot-wait` gets `slot-busy`, which LimitShift retries (§15.2).
- Network filesystems: SMB and drvfs roots are refused. NFS roots get a `doctor` warning, and the agy exclusive path refuses there (125 `agy-busy`, control verbs 73) unless `settings.agyAllowNetworkHome` is true, because agy processes on other hosts are invisible (§6.1, §8.3.3 B.2).

### 13.2 Atomic writes

The write sequence for every state, registry and vault update:
1. write to `<file>.tmp-<pid>-<rand>` in the same directory, created with mode 0600 (§6.1);
2. `fsync` the file;
3. `rename` it over the target;
4. `fsync` the directory (POSIX).

Readers never need the lock for a consistent snapshot. Writers always take it.
- Read-only commands never write anything, not even a repair (§6.3). A reader that cannot parse a file exits 78 `config-corrupt` (`exec`: 125 `config-corrupt`) and changes nothing; only a writer holding `state.lock` may quarantine a file, after a second read 200 ms later fails the same way (§6.4).

**Windows.** Go's `os.Open` omits `FILE_SHARE_DELETE`, and a replace onto a file open that way fails with `ERROR_ACCESS_DENIED`, not a sharing violation. Therefore:
- readers open state, registry and vault files with `windows.CreateFile(…, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, …)`;
- writers replace with `SetFileInformationByHandle(FileRenameInfoEx, FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS)` where supported, else `MoveFileEx(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`;
- writers retry `ERROR_ACCESS_DENIED`, `ERROR_SHARING_VIOLATION` and `ERROR_LOCK_VIOLATION`, and readers retry those plus `ERROR_FILE_NOT_FOUND`, with exponential backoff for up to 2 s (antivirus and the search indexer open files briefly too).

The same rules apply to the `.corrupt-<epoch>` rename (§6.4), to agy token-file writes and to the status file (§12.1.1). A Windows contract test keeps a reader's handle open on each of state.json, accounts.json and vault.v1.bin during a write and asserts that the write succeeds (§18.2).

### 13.3 agy swap journal

Before writing to or deleting from agy's slot, accshift writes `journal/agy-swap.json` and fsyncs it (schema: Appendix D.3b). Example, for a swap from agy account a (`7c41d09e`) to b (`d5e8b3a1`):
```json
{"op":"swap","from":"7c41d09e","to":"d5e8b3a1",
 "saved":[{"secretId":"agy/7c41d09e","store":"keyring","path":null},{"secretId":"agy/7c41d09e","store":"file","path":"/home/me/.gemini/antigravity-cli/antigravity-oauth-token"}],
 "backupSecretId":"agy/_swap/1791385200","startedAt":1791385200,"pid":…,"startTime":…}
```
- `op` is one of:
  - `swap`: `exec agy`, `agy use` and the restore-after-run swap (§8.3.3 B.7);
  - `add`: `add agy` and `login agy` (§8.3.4 step 3);
  - `sign-out`: `remove agy --sign-out-slot` (§8.3.4); `from` is the removed account and `to` is null.
- `from` and `to` are agy account ids, never names, so `rename` never touches a journal. `rename` refuses with 73 `agy-journal-pending` while a journal exists (§10.2).
- `saved` lists every slot that held a credential, by store and, for files, by exact path, with the vault entry its content was saved to.
- `backupSecretId` is the per-operation backup `agy/_swap/<startedAt>` (§7.2). It holds the raw bytes of every slot that held a credential, each with its store and path. `<startedAt>` is the operation's start time in epoch seconds. No other operation overwrites it.
- **Commit before the journal.** The outgoing content, its owners' entries and the backup are written to the vault in one commit (§8.3.3 B.5) **before** the journal is written. If that commit fails, no slot has been touched and no journal exists; the operation fails (125 `vault-busy`, `keystore-unavailable`, `vault-changed` or `slot-write-failed`; control verbs 73 or 74).
- **Lifetimes.** A `swap` journal is deleted as soon as the written slots are verified (B.8), or after a verified rollback; it never outlives B.8, so agy never runs while one exists. An `add` journal is deleted when step 6 of §8.3.4 has restored and verified the saved content. A `sign-out` journal is deleted once every deleted slot reads as not found.
- `pid` and `startTime` are diagnostics only. `doctor` reports a pending journal of any `op` with the hint `accshift doctor --fix`.

**Recovery** is step B.3 of §8.3.3. It runs only under the **exclusive** `agy-slot.lock`, and only after the foreign-process check (B.2) has found no agy process. If an agy process still runs after the rest of `--slot-wait`, recovery does not start: the journal stays, and the operation fails with 125 `agy-busy` (control verbs 73). Holding the exclusive lock proves that the journal's writer is gone (its lock died with it), so the journal's pid is never checked. Recovery never writes a slot while any agy process runs.
1. **Read** every store and path the journal names, plus every reachable slot (§8.3.2). On any read error other than not-found (locked, timed out, would prompt), write nothing, keep the journal and fail: 125 `keystore-unavailable` (control verbs 74). An unparseable file is re-read after 1 s and counts as unreadable only if it still does not parse; its raw bytes are kept as `agy/_unparsed/<store>-<epoch>`.
2. **Save** each readable credential to its owner by the B.5 rules: a registered email to that account's entry `agy/<id>` (keeping the later `expiry`), an unregistered one to `agy/_unregistered/<email>`, and one with no identifiable owner to `agy/_unknown/<sha256-8>`. This is a commit point as in B.5: if the vault write fails, no slot is written and the journal stays.
3. **Finish or undo** the operation:
   - `swap` or `sign-out`: if every journaled store already holds what the operation meant to leave there (the incoming account's vault snapshot for `swap`, nothing for `sign-out`), the result is kept. Any other state, including empty stores under a `swap` journal, is a crash in the middle of a write: every store is rolled back from `backupSecretId` (written back to exactly the stores and paths it came from, and stores that were empty before are deleted), then verified. Empty stores under a `swap` journal are never read as agy's own rejection, so they never set `relogin(rejected)`;
   - `add`: always rolled back from `backupSecretId`, after step 2 has saved the user's new sign-in by its rules (a registered email to that account's `agy/<id>`, an unregistered one to `agy/_unregistered/<email>`, no identifiable owner to `agy/_unknown/<sha256-8>`). The user's sign-in is never lost.
   - If a rollback cannot be verified, the journal stays and the operation fails with 125 `slot-write-failed` (control verbs 74).
4. **Close.** Under `state.lock` set `state.agySlot` to what the slots now hold (`to` for a kept `swap`, `from` for a rolled-back one, null for a kept `sign-out` or when the slots hold no registered account), then delete the journal.

- Nothing is ever restored from a shared "last" copy; `agy/_last` does not exist (§7.2).
- After recovery no journal names an earlier backup, so the holder's first vault write deletes every `agy/_swap/*` entry written by an earlier operation (§7.2).
- A store that is locked, timed out or needs a prompt is never "empty"; step 1 fails instead.

## 14. Security and privacy

### 14.1 Threat model

**In scope:**
- other local users;
- accidental exposure: logs, screenshots, shell history, `ps`, backups, crash dumps;
- malformed or hostile vendor files (overlay links pointing outside);
- downgrade or tampering during self-update;
- supply chain (dependencies, release artifacts).

**Out of scope:**
- malware running as the same OS user: it can read the vendors' own plaintext credential files anyway;
- a compromised vendor CLI binary.

**Stated, not solved: the agents themselves.** The agents accshift launches run as the same OS user and can read every secret accshift stores, for every account and every CLI. One compromised or prompt-injected task can therefore exfiltrate all registered accounts. Per account, accshift's protection target is "no weaker than the vendor CLIs' own storage, and better where cheap" [R07 §7]; in aggregate it is weaker, and the README and first-run notice say so (§7.6, Appendix F).

### 14.2 Rules

1. **No network** except opt-in update checks (§17.7). No proxy mode. No calls to provider or GitHub APIs with stored tokens [R09 C2].
2. **Never run vendor `logout`** (it revokes credentials). Never run short-lived vendor commands to probe accounts [R09 C3, §1.6]. A version query is not a probe: `exec` runs `agy --version` only when the agy binary changed (§8.3.1), and `doctor` runs `<cli> --version` only interactively (§9.6).
3. **One owner per refreshable credential.** Never copy `auth.json`, `.credentials.json` or agy tokens into two live places. agy's slot is the single exception: it is swapped under a lock and always saved back.
4. **Secrets only travel by stdin, files at 0600, the vault, or a child's environment.** Never argv. On macOS, `security` commands that carry secrets are written to `security -i` stdin, and the 4096-byte line limit is checked before writing (§7.4).
5. **Overlay links MUST point only at allowlisted names directly inside the vendor's main home,** with names validated: no `..`, no path separators, no absolute targets outside the main home. A missing allowlisted directory may be created in the main home first; files are never created there.
   - Link refresh MUST NOT follow links while deleting, and recognises links by the rule in §8.2.
   - `remove` (unless `--keep-home`) deletes the overlay with a no-follow walk that never descends into linked directories.
6. **Vendor processes:** accshift MUST NOT kill vendor processes it did not start. (It may stop agy processes its own run started, §8.3.3 C.3.) A foreign agy blocks swaps and recovery instead (§13.1).
7. **Core dumps and memory:** accshift disables its own core dumps without leaking the setting into the child (§12.3). Secrets are held in `[]byte`, never Go strings, and zeroed after use; on the spawn path only the data key stays in memory during the run (§7.1). Go cannot guarantee zeroing, so this is best effort.
8. **Never re-serialize vendor files.**
   - Vendor credential blobs and config files are copied as raw bytes, never decoded and re-encoded. Decoding is allowed only to *read* labels or expiry.
   - The JSON library's error texts are never part of the contract (Go 1.27 switched `encoding/json` to the v2 backend) [R01 §3.12].

### 14.3 Permissions

See §6.1. Additionally:
- the vault key item uses service `accshift`, account `vault-key-v1-<kid>`, one item per vault, created without overwrite (macOS / Secret Service, §7.3);
- the DPAPI key file `<root>/vault.key.dpapi` uses `CRYPTPROTECT_UI_FORBIDDEN`.

### 14.4 Never log or print

- token values, vault plaintext, slot blobs, raw JWTs;
- `security -i` input;
- the values of any variable in the Appendix A set-lists;
- `auth.json` / `.credentials.json` content;
- keyring passwords or passphrases;
- D-Bus secret structs.

What MAY appear: account names, labels, `identity.email`, an 8-hex SHA-256 fingerprint of a secret (for "same token?" diagnostics), lengths, and timestamps. `exec`'s stderr is stricter: its lines name nothing at all (§12.1.1).

**One redactor for every channel.** The package `internal/redact` is applied to **every** output channel: stdout JSON, stderr, `--status-file`, `state.json` snippets, `events.jsonl`, the debug log, `error.message` and `doctor` messages. It masks:
- these patterns (the same table drives the `doctor` registry check, §6.2):
  - `sk-ant-[\w-]+`
  - `sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}` (OpenAI keys, `CODEX_API_KEY`)
  - `AIza[0-9A-Za-z_-]{35}` (Google API keys, which agy errors may print; Google client errors can print request URLs with `?key=`)
  - `github_pat_\w+`
  - `gh[oprsu]_\w+`
  - `ya29\.[\w-]+`
  - `1//[\w-]+`
  - `eyJ[\w-]+\.[\w-]+\.[\w-]*`
  - `at-[\w-]{10,}`
- the exact byte values of every secret this process has loaded (vault entries, `gh auth token` output), whatever their format.

`doctor` findings name the offending field and never quote its value. LimitShift is advised to pass captured run outputs through the same patterns before writing them (§15.5).

---
