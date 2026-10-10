## 3. Glossary

| Term | Meaning |
|---|---|
| **cli** | One of `claude` (Claude Code), `codex` (OpenAI Codex CLI), `agy` (Google Antigravity CLI), `gemini` (Gemini CLI), `copilot` (GitHub Copilot CLI). |
| **account** | A named login for one cli, registered in acctshift (for example `claude/work`). Names match `^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$` (no trailing `.`, `-` or `_`, which Windows path normalisation would strip) and are unique per cli. Names never form vault ids, paths or state keys (those use the account id), so no name needs to be reserved for them; the regex also rules out a leading `_`. Not allowed: the reserved words `all`, `none`, `native`, and, on every OS so registries stay portable, the Windows device names `con`, `prn`, `aux`, `nul`, `com0`–`com9`, `lpt0`–`lpt9`, `conin$`, `conout$`, alone or followed by `.` and an extension. |
| **account id** | An immutable 8-hex-character identifier drawn at `add` and never reused in the registry. It keys the overlay home `homes/<cli>/<id>`, the vault entry `<cli>/<id>` and the `state.json` entry `<cli>/<id>`, so `rename` changes only the name (§6.2, §6.3, §7.2). |
| **kind** | How an account is selected for a run: `token`, `home`, `slot`, `native`, `access-token`, `api-key`, `gh`, `login-slot` (experimental) (§8). |
| **native account** | The cli's own default login (what plain `claude` uses today), registered so rotation can include it. acctshift never moves or copies its credential. |
| **pool** | The ordered list of accounts a caller allows for one runner. The default is every enabled account of that cli, in registry order. |
| **preference order** | Registry order, or `--pool` order when a pool is given. It decides which account is picked first when several are usable (§9.3). |
| **slot** | A vendor credential location that holds one login for the whole OS user, such as agy's keyring item or token file. Using a slot means swapping its content. |
| **overlay home** | A per-account directory used as a cli's home (`CODEX_HOME`, `GEMINI_CLI_HOME`). It holds that account's credential and links back to the user's real home for everything shared. Its directory name is an immutable id, not the account name (§6.2). |
| **limit window** | The time until which an account is known to be capped for one scope: the `until` of a limit record, kept per (cli, account, scope) where scope is `account` or `model:<bucket>` (§9.1). `limitedUntil` in `list` summarises them. |
| **contract** | The versioned JSON and exit-code interface for machine callers (§11). This spec defines contract 1. |
| **caller** | The program invoking acctshift, normally LimitShift (v1 bash, v1 PowerShell, v2 engine). |
| **control verb** | Every command other than `exec` and `run`. Control verbs report failures with the sysexits codes of §10.3 (64–78). `exec` and `run` report every failure before the child starts as 125, use 126/127 for the binary, and otherwise return the child's status (§12.1.1). |
| **usable** | An account a request may run on: enabled, no `relogin` and no `attentionCode`, not past `expiresAt`, and no active record that blocks the requested model (§9.3). Selection uses usability, never the displayed state. |
| **session portability** | Whether a conversation started under account A can continue under account B after a switch: `yes`, `likely`, `possible`, `unlikely` or `no`, decided per move by the adapter (§8). A move from an account to itself is always `yes`. |
| **vault** | acctshift's encrypted file of secrets plus the key that unlocks it (§7). |
| **sessionPortable** | Boolean form of session portability: true for `yes` and `likely`; false for `possible`, `unlikely` and `no`. When it is false, LimitShift starts a new session with the handoff note instead of resuming (§15.2). |

## 4. Supported platforms and CLIs

### 4.1 Operating systems and architectures

| OS | Architectures | Minimum | Notes |
|---|---|---|---|
| macOS | arm64, x64 | 13 Ventura (Go 1.27 minimum) | arm64 binaries carry the Go linker's ad-hoc signature automatically [R01 C4]. Notarization is not needed for curl or script installs [R09 C10]. |
| Linux | x64, arm64 | kernel 3.2 | Fully static binary. One artifact per architecture covers glibc, musl/Alpine, WSL2 and containers [R01 C2]. WSL1 is supported only once its CI smoke job passes (§18.4). Under WSL, acctshift launches only Linux CLI builds (§12.2). |
| Windows | x64, arm64 | Windows 10 / Server 2016 | Native arm64 build (ai-switcher only shipped x64). |

Every MUST in this spec applies to all three OS families unless a section names an exception. **macOS and Linux are release-blocking**: a release MUST NOT ship if any macOS or Linux CI job is red (§18.4).

### 4.2 CLIs

| cli | Tier | Versions the research is based on | Account kinds |
|---|---|---|---|
| claude | 1 | Claude Code 2.1.293 [R04] | `token` (default), `native`, `login-slot` (experimental) |
| codex | 1 | Codex CLI 0.161.0 [R04] | `home` (default), `native`, `access-token`, `api-key` |
| agy | 1 | Antigravity CLI 1.3.1 [R05, R07] | `slot` |
| gemini | 2 | Gemini CLI 0.63.0 [R06] | `home` (default), `native`, `api-key` |
| copilot | 2 | Copilot CLI 1.0.93 [R06] | `token` (default), `gh`, `native` |

- **Tier 1** is delivered in M2–M4 and is what LimitShift integrates with first.
- **Tier 2** is delivered in M6.
- A cli that `exec` cannot run on this OS is unsupported: `pick` and `next` exit 69 `unsupported-cli`, `list`, `status` and `mark` return `accounts:[]` with `poolSize:0` and `rotationPossible:false` (never 69), and `exec` and `run` exit 125 `unsupported-cli` (§10.3, §12.1.1). `version` lists `supportedClis` and the `experimental` subset whose rotation is unverified on this OS (§11.2). LimitShift then applies its legacy rule (§15.2).

Vendor behaviour changes over time. Every adapter MUST keep its vendor-specific constants (paths, env var names, regexes) in one file per cli, `internal/adapters/<cli>/facts.go`, with a comment giving the vendor version they were last verified against.

## 5. Architecture

### 5.1 Components

```
acctshift (single Go binary, no daemon)
├── cli/          command parsing, human output, --json output, exit codes
├── paths/        per-OS root dir, ACCTSHIFT_HOME, vendor home discovery
├── registry/     accounts.json: accounts, kinds, order, pools (non-secret)
├── state/        state.json: limit windows, auth state, agy slot owner; pure functions + atomic IO
├── engine/       pick / next / mark: rotation policy over registry+state (pure, table-tested)
├── vault/        encrypted secrets file + key sources (keystore, DPAPI, key-file, passphrase)
├── keystore/     macOS /usr/bin/security, Linux Secret Service (godbus, no autolaunch), Windows wincred + DPAPI
├── adapters/     one package per cli: facts, add/login flow, env for a run, pre/post-run hooks, classify
├── execx/        launching: execve (POSIX), spawn+wait with signal forwarding, Windows job object, argv quoting, npm shim resolution
├── redact/       one redaction table applied to every output channel (§14.4)
├── lockx/        advisory file locks (flock / LockFileEx) with timeouts
├── fsx/          atomic writes, permissions, symlinks/junctions, safe link refresh
├── classify/     limit / auth / session-lost / resume-incompatible detection + reset-time parsing (embedded tzdata)
├── procscan/     "is a vendor process running?" by executable path, with (pid, start time) identity (Linux /proc; macOS sysctl kern.proc.uid + KERN_PROCARGS2, never proc_pidpath, which needs cgo; Windows Toolhelp32 + QueryFullProcessImageName)
├── doctor/       environment diagnostics
└── update/       optional self-update with Ed25519-verified checksums
```

### 5.2 Main flows

**Unattended run from LimitShift (claude example).** The accounts are those of the §11.2 scenario: `main` (the native login, id `e04b7d93`) and `work` (a `token` account, id `3f9a01c2`). M is a Sonnet model, so `work`'s weekly Opus record from 10:20Z does not block it (§9.1).
```
limitshift ──pick claude --model M --prefer work--> acctshift ── reads registry+state, no lock ──> {"account":"work",...} exit 0
limitshift ──exec claude --account work --status-file S -- -p --session-id U ...--> acctshift      (run starts 10:25Z = 1791368700)
      acctshift: build env (scrub API-key vars, set CLAUDE_CODE_OAUTH_TOKEN from vault) ── execve claude
claude prints "You've hit your session limit · resets 3pm (Europe/Kyiv)" and exits 1      (10:40Z = 1791369600)
limitshift ──next claude --from work --model M --limited-until 1791374400 --evidence-file last-run.txt --exit 1
             --run-started-at 1791368700 --session U --cwd D--> acctshift
      acctshift: parse the evidence file and the tail of session U's transcript (no lock), then under state.lock
                 record claude/3f9a01c2 (work) scope=account until 1791374400 = 2026-10-07T12:00:00Z
                 (tier 3: the transcript's structured reset; the text and --limited-until say the same at tier 2);
                 pick the first usable account in preference order → "main"
      {"account":"main","previous":"work","switched":true,"sessionPortable":true,"recorded":{...}} exit 0
limitshift ──exec claude --account main --status-file S -- -p --resume U ...  (same conversation, no waiting)
limitshift ──mark claude --account main --ok--> acctshift   (after the run succeeds; resets strikes and backoff)
```

**All accounts capped:** `next` returns exit 75 with `account` set to the account that frees up first and `resetAtEpoch` = its reset + 30 s. That account may be the one that just hit the limit; a one-account pool always gives 75 naming it (or 77 if it needs a human). A single runner sleeps until then plus its own buffer and runs on that account; with fallbacks, LimitShift marks the runner limited until `resetAtEpoch` and tries another runner (§9.3, §15.2).

**agy run:** `exec agy --account b` (§8.3.3 is normative). The **fast-path condition** is: the resolved slot holds a credential, every slot in the write set that holds a credential carries the requested email, and the slot copy's expiry is not earlier than the vault snapshot's (§8.3.2).
1. **Shared attempt**, only when V-A8 has passed for this OS and agy version. acctshift waits briefly for live swapper intent markers, takes the agy slot lock shared, and reads every slot without writing. If no journal exists and the fast-path condition holds, the run goes to step 5 under the shared lock and nothing is written. A foreign agy does not block this path; it only sets `foreignAgy` in the status file. `state.agySlot` never decides the lock mode or the fast path; it is only a hint for `pick`.
2. Otherwise acctshift releases the shared lock (a held lock is never converted in place) and takes it **exclusive**, with an intent marker. The foreign-process check gates only this exclusive path: a running agy that acctshift did not start gives 125 `agy-busy`. Only after that check does it recover any stale journal.
3. It reads the slots and saves every slot's content back to the account that owns it, identified by email. An unregistered email stops the run before anything is written. This vault write is a commit point: if it fails, no slot is touched.
4. If the fast-path condition now holds, nothing is written. Otherwise it journals the swap, writes b's credential into every slot of the write set, and verifies each by read-back.
5. It spawns agy and waits.
6. After agy exits, it stops lingering agy processes this run started, reads the slots, and saves them back to b (agy may have refreshed the token). If every slot is empty, agy itself cleared a rejected login: there is no save-back, and b gets `relogin(rejected)`. Another email in the slot sets `wrongAccount` in the status file, and LimitShift re-runs the task without calling `next`. Then it releases the lock (§8.3, §13).

### 5.3 Design principles

1. **One owner per refreshable credential** [R09 §1.6]. Claude's env token never refreshes. Each Codex and Gemini overlay home holds its own refreshing file. agy's single slot is swapped under a lock and always saved back.
2. **Use vendor-documented selection mechanisms first**: env tokens, home variables. Use undocumented ones only as explicitly experimental fallbacks.
3. **Passive limit knowledge.** acctshift learns limits only from the caller (`--limited-until`), from local CLI output (`--evidence-file`, `classify`), or from local vendor files the CLI already wrote (the Claude transcript, the Codex rollout's `token_count`), read before `state.lock` is taken (§9). Never from the network.
4. **No resident process.** Every invocation is short-lived. State lives in files guarded by locks.
5. **Pure core, thin edges.** `engine`, `state` transitions and `classify` are pure functions with table tests. OS-specific code sits behind small interfaces with fakes.

---
