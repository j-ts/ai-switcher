### 8.3 agy (Google Antigravity CLI), tier 1

**Facts (verified statically against agy 1.3.1)** [R05, R07]. The Linux facts come from the binary itself. The macOS and Windows store facts come from the `zalando/go-keyring` source; their on-device behaviour is V-A1, V-A3 and V-A5 (§22).
- agy is a Go binary that stores **one** login per OS user through a vendored `zalando/go-keyring`, under service `gemini`, account `antigravity`. It falls back to a plaintext 0600 token file when its detectors fire: no `DBUS_SESSION_BUS_ADDRESS`, a container, WSL, SSH, Android, or a keyring timeout in the last hour [R05 C3, R07 C1–C2]. It also falls back to the file when a keyring save fails (log line `Failed to save token to keyring, falling back to file`), for example a blob over the Windows 2560-byte Credential Manager cap [R05 §a]. The detectors are verified on Linux only; whether they fire on macOS and Windows is **VERIFY V-A3**.
- agy bounds each keyring operation at about 5 s (detection at 2.5 s). After a timeout it writes a keyring-unavailable marker and skips the keyring for an hour [R05 §a].
- agy rewrites the stored token on every refresh, 5 minutes before expiry, and on project and tier changes [R05 C8]. It clears the entry on a definitive server rejection (a revoked account) and on `/logout` [R05 §d]. Its file writes are not atomic (`MkdirAll 0755` + `WriteFile 0600`), so a concurrent reader can see a truncated file [R07 §1].
- The stored credential is the `StoredToken` JSON: access, refresh and id tokens, plus project, tier and `email` [R05 §a]. Its size is unmeasured; R05 C7 expects it to exceed 2560 B (**VERIFY V-A4**).
- agy's embedded language server and remote-control daemon build their own token storage, with a default file at `~/.gemini/jetski-standalone-oauth-token` [R05 §a].
- Conversations live under `~/.gemini/antigravity-cli/` (macOS and Windows: **VERIFY V-A2**) and are keyed by folder and workspace, not by account [R05 C9]. LimitShift reads agy replies from there [R08 §a1].
- There is no login subcommand: the user signs in by running `agy` interactively (a browser flow, or a pasted code over SSH), and signs out with its `/logout` slash command, which clears the stored entry.
- `JETSKI_OAUTH_TOKEN` and `AGY_ACCOUNT` exist in the binary but are not usable account selectors (D6).

**Mechanism: `slot-swap` on every OS** (DECISIONS D6).
- The registered account's credential snapshot (from the vault) is written into agy's native slot under a lock. The previous content is first saved back to the account that owns it. agy then runs with an unchanged environment and data dir.
- acctshift MUST NOT select agy accounts through `JETSKI_OAUTH_TOKEN`, `AGY_ACCOUNT`, `HOME`, `--gemini_dir`, or by adding or removing environment variables such as `DBUS_SESSION_BUS_ADDRESS` or `SSH_*` for the child. The last would also break the agent's own git and gh keyring helpers.
- **Environment** (Appendix A.3). acctshift unsets the selectors listed there, so the stored login is used. It also:
  - refuses with `exec` exit 125 `agy-env-overrides-slot` when any `AGY_LLM_GATEWAY_*` variable (URL, API key, headers, models, proxy URL, CA certificate, wire protocol [R05 §c]) is set in the environment it would pass to agy, unless `--allow-settings-env` is given. agy's enterprise-gateway auth would then decide the account, not the slot;
  - unsets `GOOGLE_GEMINI_BASE_URL`;
  - leaves `GOOGLE_APPLICATION_CREDENTIALS` and `GOOGLE_CLOUD_*` untouched. They matter only with `AGY_ADC_AUTH`, which is unset.
  
  The variable names live in agy `facts.go`.
- **The user's own agy follows the swaps.** agy has no `native` kind: there is one slot per OS user. An interactive `agy` started by the user runs as whichever account acctshift last put in the slot. `acctshift agy use <name>` swaps an account in without running agy, and `settings.agyRestoreAfterRun: "<name>"` makes every swapping run put that account back afterwards (§8.3.3). The README says this plainly.

#### 8.3.1 Slot facts (data, in `adapters/agy/facts.go`, version-tagged)

| Store | Identity and encoding |
|---|---|
| Linux Secret Service | attributes `{service:"gemini", username:"antigravity"}`, label `Password for 'antigravity' on 'gemini'`, collection `login`, else the `default` alias; `CreateItem(replace=true)`; `plain` session; the secret is the raw token JSON |
| macOS keychain | login keychain generic password `-s gemini -a antigravity`. Write via `/usr/bin/security -i` stdin: `add-generic-password -U -s gemini -a antigravity -T /usr/bin/security -w go-keyring-base64:<base64(json)> <keychain>`. Read: `find-generic-password -s gemini -wa antigravity <keychain>`, accepting raw, `go-keyring-base64:` and hex `go-keyring-encoded:` forms (§7.4) |
| Windows Credential Manager | `CredWriteW` with `CRED_TYPE_GENERIC`, TargetName `gemini:antigravity`, UserName `antigravity`, `CRED_PERSIST_LOCAL_MACHINE`, raw UTF-8 blob of **at most 2560 bytes**. acctshift calls `CredWriteW` / `CredReadW` itself; `zalando/go-keyring` is not used at runtime (§7.3) |
| CLI token file | candidates in order: `<home>/.gemini/antigravity-cli/antigravity-oauth-token`, then `<home>/.gemini/antigravity-oauth-token` (**VERIFY V-A2**; reports 05 and 07 disagree, so the judge leans to the first). A file that already exists wins. New files are written 0600 with temp + fsync + rename in the same directory, following the Windows rules of §13.2 |
| Language-server token file | `<home>/.gemini/jetski-standalone-oauth-token` [R05 §a] (**VERIFY V-A2, V-A10**). It is part of every snapshot, diff and write set whenever it holds a credential |
| Keyring-timeout markers | `<home>/.gemini/antigravity-cli/cache/antigravity-keyring-unavailable` (the CLI's) and `<home>/.gemini/cache/antigravity-keyring-unavailable` (the language server's) [R05 §a]. Both are checked (§8.3.2) |
| Keyring timeouts | agy: about 5 s per keyring operation, 2.5 s for detection [R05 §a]. acctshift: 4 s for any call on agy's slot (§8.3.2, §7.5) |
| Environment overrides | `AGY_LLM_GATEWAY_*` (refuse), `GOOGLE_GEMINI_BASE_URL` and the Appendix A.3 list (unset) [R05 §c] |
| agy executables | the realpath of the resolved agy binary, plus the sidecar executable paths and names (language server, remote-control daemon, the Antigravity desktop app and its helpers) recorded for this agy version. Used by the foreign-process check (§8.3.3) |
| V-A3 result | per OS and agy version: whether agy's environment detectors apply on macOS and Windows (§8.3.2) |
| V-A8 result | per OS and agy version: whether shared-mode runs are allowed (§8.3.3) |

- **Paths on macOS and Windows.** `<home>` is the user's home directory (`%USERPROFILE%` on Windows). The paths above are inferred from the Linux build. agy's app-data directory on macOS (possibly under `~/Library`) and on Windows (possibly under `%APPDATA%`) is unconfirmed, so every macOS and Windows path in this table and in Appendix B is **VERIFY V-A2**. `facts.go` records the verified paths per OS.
- **Installed agy version.** The slot facts and the V-A3 and V-A8 results are keyed by agy version. `exec` identifies the installed version from `state.agyBinary` (§6.3): the realpath, size and mtime of the resolved agy binary.
  - On a cache miss (no entry, or any of the three differs) `exec` runs `agy --version` once, with a 2 s timeout and `AGY_CLI_DISABLE_AUTO_UPDATE=1`, before taking the slot lock. It stores the result under `state.lock`.
  - An unknown version (timeout, unparsable output) counts as V-A8 not passed and V-A3 not recorded.

`doctor` warns if internal-build variants (`jetski`, `jetski-cli`) exist, and never touches them.

#### 8.3.2 Which slot agy will read: resolved per run against the child's environment

The **resolved slot** is the store agy will read in this run. acctshift resolves it per OS, against the exact environment it will pass to the child (Appendix A.3). Whether the keyring store is **in scope** is decided by the rules below. An in-scope keyring that cannot be read stops the run.

**Linux.** agy's own detectors decide [R05 §a, R05 C3]. They fall into two classes.
- **Permanent detectors** (environment and OS). Any one of:
  - `DBUS_SESSION_BUS_ADDRESS` is empty;
  - `/.dockerenv` exists, or `/proc/1/cgroup` contains `docker`, `containerd` or `kubepods`;
  - `CLOUD_SHELL` is set;
  - `WSL_DISTRO_NAME` or `WSL_INTEROP` is set, or `/proc/sys/kernel/osrelease` contains `microsoft`;
  - `SSH_TTY`, `SSH_CLIENT` or `SSH_CONNECTION` is set;
  - Android/termux.

  If one fires, the resolved slot is the CLI token file. agy decides this up front per process and does not use the keyring in that run, so the keyring is **out of scope**: the locked-keyring rule below does not apply. If the keyring is reachable (through the `DBUS_SESSION_BUS_ADDRESS` of the child's environment), unlocked, answers within 4 s and holds an agy credential, it still joins the write set like any other slot. Otherwise it is skipped.
- **Transient detector:** a keyring-timeout marker younger than 1 h. Both marker paths are checked (§8.3.1). A fresh marker at the CLI's path makes the CLI token file the resolved slot for this run. A fresh marker at the language server's path makes the language server use its own token file, which is in the write set whenever it holds a credential. Either way the keyring stays **in scope**, because agy and the language server go back to it once their markers expire. acctshift MUST read it: if it holds a credential it joins the write set; if it cannot be read, the locked-keyring rule applies.
- If no detector fires, the resolved slot is the Secret Service item, and it is in scope.

**macOS and Windows.** agy's detectors are verified on Linux only. Whether they fire on macOS and Windows is **VERIFY V-A3**: `DBUS_SESSION_BUS_ADDRESS` is normally empty on macOS, so if agy runs its D-Bus detector there it always uses the file. Until V-A3 is recorded in `facts.go` for that OS and the installed agy version:
- the resolved slot is the store and path that `add agy` or `login agy` last recorded in an account's `agySlotUsed` for the installed agy version (§8.3.4, Appendix D.1);
- with no such record, it is the login keychain on macOS, and Credential Manager on Windows unless the incoming blob exceeds 2560 B. In that case it is the CLI token file, where agy's own failed keyring save would put it [R05 §a];
- a file candidate joins the write set only if it already holds a credential, or under the size rule of the write set below;
- acctshift MUST NOT create a new token file on macOS;
- a keychain or Credential Manager item that is the resolved slot is in scope. When the resolved slot is a file, the item joins the write set if it is readable within 4 s and holds a credential, and is skipped otherwise.

Once V-A3 is recorded for an OS and agy version, the Linux rules above apply there, with that OS's detectors.

**An in-scope keyring that cannot be read fails closed.** "Cannot be read" means the store is locked, would need a prompt, is unreachable or absent, or any call on it takes longer than 4 s:
- Linux: the target collection has `Locked=true`; the bus has no `login` collection and no persistent `default` collection (agy's behaviour there is VERIFY V-A3); or nothing answers at the bus address, or the connection is refused;
- macOS: `security` exits 36 (locked), 37 or 50 (no default keychain, no such keychain), the read needs a prompt, or the call times out;
- Windows: a Credential Manager call fails with anything other than not-found (for example error 1312 on network logons), or times out.

A keyring that answers "not found" is readable and empty; that is not a failure.

Why: go-keyring's own prompt wait is unbounded [R07 C5], but agy bounds its keyring operations at about 5 s [R05 §a]. After a timeout agy writes its keyring-unavailable marker and uses its file slot for an hour. A keyring acctshift cannot read therefore leads either to a GUI unlock within those 5 s, after which agy reads an item acctshift could neither read nor overwrite, or to a silent switch to a file slot acctshift did not write for this account. Either way agy could start as a stale account. So:
- a locked, unreachable or slow keyring is **never** evidence of file mode. File mode comes only from the detectors above, or, on macOS and Windows, from the `agySlotUsed` record or the 2560 B rule;
- acctshift treats any keyring call on agy's slot that takes longer than 4 s as uncertain (§7.5). The 4 s bound and agy's own timeout are recorded in agy `facts.go`;
- the run MUST NOT proceed, neither a swap nor a fast-path run: `exec` exits 125 `agy-keyring-locked`; control verbs exit 74. The hint is "unlock the login keyring or keychain, or run where agy uses its file store". `doctor` reports the same state as a finding.

`doctor --json` reports the resolved slot, the detector, record or default that decided it, and whether the keyring is in scope.

**Write set** = the resolved slot **plus every other reachable slot that currently holds an agy credential** (both CLI token files and the language-server token file included; on macOS and Windows, file candidates only as stated above).
- **The resolved slot cannot take the blob.** If the resolved slot cannot accept the incoming blob (size cap: Windows Credential Manager over 2560 B, or a macOS `security -i` line over 4096 bytes), the first CLI token-file candidate, or the file path recorded in `agySlotUsed`, joins the write set. This mirrors agy's own fallback after a failed keyring save [R05 §a]. On macOS that file joins only if it already exists or `agySlotUsed` recorded it; otherwise the swap is refused before any write, with `exec` exit 125 `slot-write-failed` (control verbs 74). V-A4 confirms which slot agy reads after a failed keyring save.
- **Fail closed.** If any slot that holds a credential cannot accept the incoming blob, acctshift saves it back (§8.3.3 B.5) and then **deletes** it. agy must never be able to start as a stale account.
- **Fast path.** This is the one definition, used by §5.2, A.4 and B.6: **the resolved slot holds a credential, every slot in the write set that holds a credential carries the requested email, and the slot copy's `expiry` is not earlier than the vault snapshot's.** Then nothing is written.
  - "The slot copy" is the resolved slot's copy. An account with no vault snapshot passes the `expiry` test; its post-run save-back creates the snapshot.
  - A slot copy older than the vault snapshot (for example after a `login` stored a fresh credential) takes the exclusive path, which installs the vault copy.

#### 8.3.3 The run (inside `exec agy`)

The algorithm below is normative.
- **"Read the slots"** always means: resolve the slot and the write set (§8.3.2), read every slot in scope without writing (each keyring call bounded at 4 s), and parse the StoredToken JSON (fields `email`, `expiry`, …; read-only parsing). A file that does not parse is re-read after 1 s and counts as unreadable only if it still does not parse.
- **Lock modes.** Every slot write, every recovery, and the save-back that precedes a write run only under the **exclusive** lock. The shared lock is only for a fast-path run, which writes no slot. A held lock is never converted in place: shared is always released before exclusive is requested [flock(2): conversion is not atomic; Windows `LockFileEx` cannot convert].
- **`state.agySlot` is a hint for `pick` and `list` only.** It never decides a lock mode, a fast path or a swap.
- **Waiting.** A slot-lock wait that exceeds `--slot-wait` gives `exec` exit 125 `slot-busy` (control verbs 73). LimitShift treats `slot-busy` and `agy-busy` as transient: it waits and retries without charging its retry budget (§15.2).
- **Intent markers** give swappers writer preference. Each waiting swapper creates its own marker `locks/agy-slot.intent.d/<pid>` (`{pid, startTime, createdAt}`) and removes it when it acquires the lock or times out. A marker is live while its (pid, start time) is alive (§13.1); dead markers are ignored and removed by whoever finds them.

**Foreign-process check.**
- **Identification.** acctshift identifies agy processes by **executable path**, not by name, and compares them with the "agy executables" row of §8.3.1:
  - Linux: `/proc/<pid>/exe`;
  - macOS: enumerate with `sysctl kern.proc.uid` (`unix.SysctlKinfoProcSlice`) and read the exec path from `KERN_PROCARGS2` (`unix.SysctlRaw("kern.procargs2", pid)`), resolved with `filepath.EvalSymlinks`. `proc_pidpath` MUST NOT be used: it lives in libproc and needs cgo (§17.1);
  - Windows: `QueryFullProcessImageName`.

  Until V-A10 has recorded which components share the slot, every listed sidecar and the Antigravity desktop app count as agy. Only processes of the current user count. Process identity is always (pid, start time) (§13.1).
- **It gates only the exclusive path** (swap, recovery, `add agy`, `login agy`, `agy use`, `remove`, `doctor --fix`). Under the exclusive lock no other holder can exist, so every running agy process is foreign. No ancestry test is needed.
- **On the shared fast path it is informational.** An agy process is acctshift's when its (pid, start time) equals the `childPid` and `childStartTime` of a live holder file (§13.1); every other agy process is foreign. A foreign agy does not block the run. `exec` sets `foreignAgy:true` in the status file and writes nothing to stderr. Nothing is written to the slot on this path, so nothing can be mixed up under a running agy; a sidecar started by another holder's agy may show up as foreign here, which is harmless.
- There is no parent-chain (ppid) rule.
- **Daemons.** A language server or remote-control daemon that outlives the agy that started it (reparented to init or launchd) is foreign. It blocks the exclusive path until it exits. `doctor` reports it with the hint to stop it. V-A10 records whether `agy -p` leaves such processes running.

**A. Shared attempt** (only when V-A8 has passed for this OS and the installed agy version, `settings.agyRestoreAfterRun` is unset, and the root is not on NFS):
1. While a live intent marker exists in `locks/agy-slot.intent.d/`, wait, for at most min(`--slot-wait`, 10 s) in total; then go on even if a marker remains. The wait counts against `--slot-wait`.
2. Take `agy-slot.lock` **shared**.
3. If `journal/agy-swap.json` exists, release the lock and go to B.
4. Read the slots and the account's vault snapshot. If the fast-path condition (§8.3.2) does not hold, release the lock and go to B.
5. Run the foreign-process check in its informational form. A foreign agy sets `foreignAgy:true` in the status file; the run continues.
6. Go to C.

**B. Exclusive path:**
1. Create this process's intent marker, take `agy-slot.lock` **exclusive** (waiting at most the rest of `--slot-wait`), then delete the marker, also on timeout.
2. **Foreign-process check** (exclusive rule). If an agy process runs, wait for the rest of `--slot-wait`, then refuse: `exec` exit 125 `agy-busy`, control verbs exit 73. A journal, if any, stays in place. agy rewrites the slot on refresh, so swapping or recovering under a running agy would mix accounts.
   - If the root is on NFS and `settings.agyAllowNetworkHome` is not true, refuse the same way (125 `agy-busy`, control verbs 73) before step 3, because agy processes on other hosts sharing `~/.gemini` are invisible (§6.1).
3. **Recovery.** If `journal/agy-swap.json` exists, it is stale by definition: its writer's lock died with it, so the journal's pid is never checked. Recover it as §13.3 describes before anything else:
   - read every store and path the journal names, plus every reachable slot;
   - on any read error other than not-found, write nothing, keep the journal and fail: `exec` exit 125 `keystore-unavailable`, control verbs 74;
   - save each readable credential to its owner by the step 5 rules, parking an unregistered email as `agy/_unregistered/<email>`;
   - finish or undo the operation from the journal's per-operation backup `agy/_swap/<startedAt>` (its `backupSecretId`). A `swap` or `sign-out` whose journaled stores all already hold what it meant to leave there (the incoming snapshot, or nothing) is kept. Any other state is rolled back to the backup and verified. An `add` is always rolled back, after the user's new sign-in has been parked. A `swap` journal never outlives step 8, which deletes it before agy starts, so empty stores under it mean a crash in the middle of a write, not a rejection;
   - then delete the journal. Nothing is ever restored from a shared "last" copy; `agy/_last` does not exist (§7.2).
4. **Read the slots.**
5. **Save-back.**
   - **Unregistered email, checked first.** If any slot holds a credential for an email that no agy account has, the user's own login would be displaced.
     - `exec` never asks (§7.5). It refuses **before writing anything**: exit 125 `agy-slot-unregistered`, with the hint `acctshift add agy <name> --capture-current`. A non-interactive control verb refuses the same way with exit 77.
     - Interactive `agy use` asks whether to register it now (as `--capture-current` would), park it as `agy/_unregistered/<email>` and continue, or abort.
     - `add agy` and `login agy` park it as `agy/_unregistered/<email>` with a notice and continue, because their step 6 restores it (§8.3.4).
   - Then, for every slot that holds a credential:
     - identify the owner by the `email` field, falling back to the `id_token` email claim decoded locally for labelling only;
     - if the email is registered, store the raw bytes under that account's entry `agy/<id>` (§7.2), keeping whichever copy has the later `expiry`;
     - if the email is unregistered and the operation parks it (above), store the raw bytes as `agy/_unregistered/<email>`;
     - if no owner can be identified (no `email` field and no decodable `id_token` email), store the raw bytes as `agy/_unknown/<sha256-8>`, record an event, and let `doctor` list the entry;
     - an unreadable slot's raw bytes are kept as `agy/_unparsed/<store>-<epoch>`, never discarded.
   - If a slot write follows (step 6 does not take the fast path), also store the raw bytes of every slot that holds a credential, with its store and path, as the per-operation backup `agy/_swap/<startedAt>`. `<startedAt>` is this operation's start time, the value the journal records. No other operation overwrites it.
   - This step also completes a pending post-run save-back. Once it has committed, `state.agySlot.saveBackPending` is cleared.
   - **Commit point.** All of step 5's vault updates are one atomic vault write under `vault.lock` (temp, fsync, rename, §13.2), and it MUST succeed before step 6. If it fails, no slot has been touched; the lock is released and the operation fails:
     - `vault.lock` timeout → 125 `vault-busy` (control verbs 73);
     - vault key or keystore unavailable → 125 `keystore-unavailable` (74);
     - the vault header changed → 125 `vault-changed` (74);
     - any other write error, such as a full disk → 125 `slot-write-failed` (74).
     
     Slot content is never overwritten or deleted before it is in the vault.
6. **Fast path.**
   - If the requested account has no vault snapshot after step 5 (so no slot held its email either), its credential is absent: record `relogin(missing)` under `state.lock` and exit 125 `needs-relogin` (§12.1; `agy use`: 77 `needs-relogin`).
   - If the fast-path condition of §8.3.2 holds, skip to step 9.
7. **Journal.** Write `journal/agy-swap.json` (`op:"swap"`, `from`, `to`, the saved stores and paths, and `backupSecretId` = step 5's `agy/_swap/<startedAt>`; §13.3) and fsync it.
8. **Write and verify.**
   - Write the incoming snapshot's raw bytes to every slot in the write set, in that slot's exact encoding (§8.3.1), deleting the slots that cannot take it (§8.3.2).
   - Read every written slot back non-interactively and compare bytes. On any mismatch or prompt-required error, restore every written slot from `agy/_swap/<startedAt>` (deleting the slots that were empty), verify, delete the journal, and exit 125 `slot-write-failed` (macOS prompt: `keychain-prompt-required`); control verbs exit 74 with the same code. If the restore cannot be verified either, the journal stays for recovery (§13.3).
   - On success the slot is consistent (it holds the account whose vault snapshot equals it), so delete the journal. Under `state.lock` set `state.agySlot = {owner: <the account's id>, store: <the resolved slot's store>, writtenAt}`.
9. If V-A8 has passed, `agyRestoreAfterRun` is unset and the root is not on NFS, release the exclusive lock and go back to A.1, so other runs on the same account can share the slot. A.4 re-checks the slot, so a swap by someone else in between is caught. After 3 such rounds without success, exit 125 `agy-busy`. Otherwise keep the exclusive lock for the whole run and go to C.

**C. Run:**
1. Write the holder file `locks/agy-slot.holders/<pid>-<starttime>.json` (§13.1).
2. Run agy on the **spawn path** (never execve, §12.3). Record `childPid` and `childStartTime` in the holder file. The lock handle is close-on-exec and not inheritable, so agy's descendants cannot keep it alive.
3. **After the child exits** (under whichever lock is held). Only the restore-after-run bullet writes a slot. `exec` writes nothing to stderr after the child has started (§12.1.1); post-run findings go to the status file, `state.json` and `events.jsonl`.
   - **Lingering agy processes.** agy processes this run started that are still alive (descendants of the child whose executable is agy) are waited for until `--slot-wait` elapses, then terminated (POSIX SIGTERM, then SIGKILL after 3 s; on Windows the job does this). Non-agy descendants are left alone. An event records it. This happens before the slots are read, so a lingering refresh cannot land after the save-back.
   - **Read the slots.**
   - **Every slot empty** (agy clears its entry on a definitive server rejection and on `/logout` [R05 §d]): no save-back, and the account's vault snapshot is left untouched. Under `state.lock`, set `relogin` with reason `rejected` for the requested account (§9.2) and set `state.agySlot` to null. An event records it.
   - **Match** (every slot that holds a credential carries the requested email): save back to the account's entry, keeping the later `expiry`, writing only the vault. Clear the account's `wrongAccount` if set, and set `state.agySlot.owner` to the account if it differs.
   - **Mismatch** (some slot holds another email, or a credential with no identifiable owner):
     - save every slot's content back by the B.5 rules (registered owner, `agy/_unregistered/<email>`, `agy/_unknown/<sha256-8>`), writing only the vault;
     - set the requested account's `wrongAccount = {expected, found, observedAt}` (§6.3). `found` is the resolved slot's email when that differs from the requested one, else the first other email found; it is null when the differing credential has no identifiable owner;
     - set `state.agySlot.owner` to the registered account whose email the resolved slot holds, or null;
     - report `wrongAccount` in the `--status-file`. LimitShift then re-runs the task without calling `next`, so no limit is charged to the wrong account (§15.2);
     - the next run of this account whose post-run check matches clears `wrongAccount`.
   - **Save-back failure.** A post-run save-back that fails (the key is gone, `vault.lock` timed out, `vault-changed`) never changes `exec`'s exit status (§7.1). The slot is left untouched. acctshift sets `state.agySlot.saveBackPending` to true and `postRunError` in the status file, and records an event. The next exclusive holder performs that save-back in its step B.5, before any slot write. Any later successful save-back of the slot clears the flag.
   - **Restore after run.** If `settings.agyRestoreAfterRun` names an account and this run holds the lock exclusively, swap that account back in (B.5–B.8). A failure here is a post-run failure: it never changes the exit status, leaves the slot as B.8's rollback left it, and sets `postRunError`. An unregistered email found in B.5 skips the restore (`postRunError` with `agy-slot-unregistered`).
   - Delete the holder file and release the lock.

**`pick agy`** returns the live slot owner (`state.agySlot.owner`) whenever it is a usable candidate, even if `--prefer` names another account (§9.3). agy sessions are not portable, so stickiness buys nothing, and staying on the live owner avoids swaps and slot-lock contention (D6). `pick` never opens the keystore. `state.agySlot` is only its hint; the lock algorithm above reads the slots and is authoritative.

#### 8.3.4 Add, login and use

`acctshift add agy <name>`:
1. Show the notice (Appendix F) when `state.notice` is unset or older than the binary's (§6.3).
2. Take the exclusive slot lock and run steps B.1–B.5 of §8.3.3 (intent, foreign-process check, recovery, read, save-back). The save-back is the commit point of B.5 and also writes the per-operation backup `agy/_swap/<startedAt>`. An unregistered credential found here is parked as `agy/_unregistered/<email>` with a notice, since it is restored in step 6.
3. Write `journal/agy-swap.json` with `op:"add"`, listing the saved secret ids, the exact stores and paths they came from, and `backupSecretId`, and fsync it. Then **delete every slot**, so that agy starts signed out. acctshift never tells the user to use agy's `/logout`, which could revoke the live account.
4. Run `agy` attached to the terminal. The user signs in, then exits.
5. Read the slots, including every file candidate, since agy has just written one. Every slot that now holds a credential must carry the same email.
   - `add` requires an **unregistered** email. If the email belongs to a registered agy account, the new credential is saved to that account by the B.5 rules, and the command exits 65 `duplicate-account` after step 6.
   - Otherwise store it as the new account's snapshot `agy/<id>` (§7.2). Record in the account's `agySlotUsed` `{store, path, agyVersion}` (Appendix D.1) the store and path agy wrote, with `agyVersion` from §8.3.1.
   - If no slot holds a credential, exit 65 `no-login-detected` after step 6.
6. **Restore** the saved-back content into exactly the slots it came from, and empty again the slots that were empty before step 3. Verify the read-back, delete the journal, and release the lock. Adding an account therefore never changes which account is live. If nothing was live before, `acctshift agy use <name>` makes the new account live.

**Signals during steps 3–6.** Before step 3, acctshift installs `signal.Notify` for SIGINT, SIGTERM and SIGHUP (on Windows, `os.Interrupt` and SIGTERM). It never ignores a signal (§12.3).
- agy shares the terminal's process group, so a Ctrl+C reaches it directly; acctshift forwards SIGTERM and SIGHUP to it.
- On any of these signals acctshift waits for agy to exit (at most 10 s, then kills it). Whether agy exited normally or after a signal, acctshift always runs step 6 before it exits. On a Windows console close, step 6 has the roughly 5 s Windows allows (§12.4).
- If acctshift dies anyway (SIGKILL, power loss), the `op:"add"` journal remains, and the next exclusive holder's recovery (B.3, §13.3) saves whatever the user signed in to by the B.5 rules and restores the saved content from `agy/_swap/<startedAt>`.
- `doctor` reports a pending journal of any `op` with the hint `acctshift doctor --fix`. `doctor --fix` takes the exclusive slot lock and runs B.1–B.3 only; it never swaps. A failure there exits with that step's control-verb code (73 or 74), and `doctor --fix` still prints every finding (§10.2).

**`acctshift login agy <name>`** runs the same flow for an existing account, for example after revocation. Step 1 is skipped.
- **Identity.** The email found in step 5 must equal the account's `identity.email`. Otherwise the new credential is saved by the B.5 rules (a registered email to that account's entry `agy/<id>`, keeping the later `expiry`; an unregistered one as `agy/_unregistered/<email>`; one with no identifiable owner as `agy/_unknown/<sha256-8>`), and after step 6 the command exits 65 `identity-mismatch`.
  - With `--new-identity`, the add-time rule applies instead: the email must not belong to another registered agy account (else 65 `duplicate-account`). `identity.email` is then updated and all of the account's records are cleared (§8).
- **On success the new credential replaces the account's snapshot** unconditionally, and `agySlotUsed` is updated. A same-identity login clears `relogin`, `authStrikes` and auth-suspect records, and keeps limit records (§9.2).
- **Login of the live account.** If the slots held this account's email before step 3, step 6 does not put its old credential back. Every slot that held it gets the new credential instead, written and verified like B.8, so the fresh login stays live and the fast path never keeps the stale copy. `state.agySlot.owner` stays this account. Slots that held other content are restored as usual.

**`--capture-current`** registers whatever account is in the slot now, without running agy. It takes the lock shared and only reads the slots (§8.3.2, including the locked-keyring rule); it writes no slot. It writes the vault, the registry and, under `state.lock`, the notice when it is accepted (step 1) and `state.agySlot = {owner: <the new account's id>, store: <the resolved slot's store>, writtenAt}`, because the new account is the observed slot owner (§6.3). If `journal/agy-swap.json` exists, it takes the exclusive path instead (B.1–B.4), so the journal is recovered before the slots are read.
- Every slot that holds a credential must carry the same email, and that email must not belong to a registered agy account (65 `duplicate-account`).
- `agySlotUsed` records the store and path that hold the credential.
- The notice rule of step 1 applies.

**`acctshift agy use <name>`** performs B.1–B.8 without running agy and releases the lock, so the user's own interactive `agy` uses that account. When it runs interactively, the unregistered-email question of B.5 applies.

**`remove` and `rename`** (§10.2):
- **`remove agy <name>`** takes the exclusive slot lock and runs B.1–B.4 (intent, foreign-process check, recovery, read).
  - If any slot holds the account's email, it refuses with 65 `agy-account-live` and the hint `acctshift agy use <other>`. Removing it anyway would leave the slot holding an email no account has, and every later non-interactive `exec agy` would stop with `agy-slot-unregistered`.
  - With `--sign-out-slot` it instead parks those slots' raw bytes as `agy/_unregistered/<email>` and in the backup `agy/_swap/<startedAt>` (one commit, as in B.5). It then writes a journal with `op:"sign-out"`, which §13.3 recovers by the `swap` rules, deletes every slot that holds the account's email, verifies that each reads as not found, and deletes the journal. `state.agySlot` becomes null if it named the account. Slots that hold other accounts are untouched.
  - Only then does the rest of the `remove` transaction run (§10.2). A `remove` that dies part-way is simply run again.
- **`rename agy`** never touches the slot. `state.agySlot.owner`, vault entry ids and journals use the account's immutable id (§6.2). `rename` rewrites `settings.agyRestoreAfterRun` when that names the old account, and refuses with 73 `agy-journal-pending` while `journal/agy-swap.json` exists (§10.2).

acctshift never performs Google OAuth. It only moves credentials agy produced.

#### 8.3.5 Other rules

- **Limits** (Appendix C.3): the text `RESOURCE_EXHAUSTED (code 429): Individual quota reached … Resets in 4h46m9s`, the credits wording (`Your AI credits balance is too low to continue.`, `Out of credits`), and an `AGY_ERROR` line whose status is `RESOURCE_EXHAUSTED` or code 429 with a quota or credits message [R05 §f].
- **`AGY_ERROR: {json}`** (one stderr line, exit 3) is printed for **any** model or agent failure, not only limits [R05 §f]. `classify` parses its JSON (canonical status, HTTP/gRPC code, retryability, error id; the key names are recorded in agy `facts.go` from a corpus fixture) and maps it in this order:
  - a `MODEL_CAPACITY_*` status or `Overloaded prefill queue` message → `transient`;
  - status `RESOURCE_EXHAUSTED` or code 429 with a quota or credits message → `limit`. The reset comes from a `Resets in …` text when present, else it is unknown (tier 1, §9.4);
  - status `UNAVAILABLE`, an HTTP 5xx code, or retryable true → `transient`;
  - status `UNAUTHENTICATED` or `PERMISSION_DENIED` → `auth` (exact texts and exit status: V-A11);
  - anything else → `error`.
  
  Each branch needs a verbatim corpus fixture before it ships (§18.1).
- **Auth.** The definitive signal is that agy emptied every slot during the run, which `exec` records itself as `relogin(rejected)` (§8.3.3 C.3). Auth texts in agy's output stay unverified until V-A11 (Appendix C.3).
- **Session portability:** `no` (contract `sessionPortable:false`) until V-A6 shows the backend accepts a cross-account `agy -c` for the installed agy version. LimitShift then starts a fresh session with the handoff note after a switch.
- **Experimental gating:** agy rotation ships marked experimental per OS until that OS's V-A items pass. `version` then lists agy in both `supportedClis` and `experimental` (§11.2). Unlike other experimental clis, while at least one agy account is registered LimitShift routes every agy runner through acctshift, with or without `accounts`, because an unwrapped agy would race slot swaps (§11.2, §15.4). `facts.go` records the agy versions it was verified against, and `doctor` warns when a newer agy is installed.
- **macOS:** never `-A`, `-T ""`, partition-list edits, or argv secrets. If a non-interactive read-back fails after a write, roll back and report `keychain-prompt-required`. A locked keychain fails closed before any write (§8.3.2); V-A5 confirms that agy reads items written by `/usr/bin/security` without a prompt.
- **WSL:** a Windows `agy.exe` reached through interop is refused (§12.2), because swapping the WSL-side file slot would not affect it.
- **Provider terms:** the Antigravity terms bar third-party software accessing the service [R09 §1.5]. acctshift moves only agy's own credentials and agy does all the network access, but the notice and explicit opt-in still apply (§20.4).

#### 8.3.6 Alternatives kept behind verification

- **Per-account `--gemini_dir` (isolated history), opt-in for parallel headless Linux runs.** Considered only if V-A9 shows the flag moves the token file **and** `brain/` **and** `conversation_summaries.db`, and agy can be put into file mode per directory without changing the child's environment. If adopted, `exec` reports the per-account `dataDir` in the status file (a field §11.2 would then add), so LimitShift can set `LIMITSHIFT_AGY_DATA_DIR`. `capabilities.agy.dataDir` in `version` stays the user's default, `null` until V-A2 has recorded the OS's path (§11.2).
- **`JETSKI_OAUTH_TOKEN` / `AGY_ACCOUNT`.** One-shot probes in M0 (V-A7). They are adopted only if they select the Google sign-in for `agy -p` without acctshift minting or refreshing tokens.
