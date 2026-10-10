# accshift: specification

| | |
|---|---|
| Document | `SPEC.md`, version 0.9 (draft for implementation) |
| Date | 2026-10-07 |
| Owner | j-ts (LimitShift maintainer) |
| Status | Ready for M0 (verification spike). Everything marked **VERIFY** must be confirmed on real machines and accounts before the matching milestone ships. |
| Working name | `accshift`. Free on npm, crates.io, Homebrew and PyPI, with no GitHub repository of that name (research 09, conclusion 22). The name appears only in `internal/buildinfo` and the release config, so a rename touches two places. |
| Licence | MIT |
| Evidence | Nine research reports in [`research/`](research/README.md) and the judged decisions in [`DECISIONS.md`](DECISIONS.md). Citations look like `[R04 §2b]` (report 04, section 2b) or `[R08 C3]` (report 08, conclusion 3). |

Conventions:
- **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are used in the RFC 2119 sense.
- `cli` always means one of the supported agentic CLIs: `claude`, `codex`, `agy`, `copilot`. Gemini CLI is out of scope (§1.3).
- Times on the wire are integer Unix epoch seconds, with RFC 3339 UTC strings next to them.
- Paths use `/` and `~`; on Windows read `%USERPROFILE%` for `~` and `\` for `/`.

---

## Contents

1. [Purpose, goals and non-goals](#1-purpose-goals-and-non-goals)
2. [Decisions at a glance (and why Go)](#2-decisions-at-a-glance-and-why-go)
3. [Glossary](#3-glossary)
4. [Supported platforms and CLIs](#4-supported-platforms-and-clis)
5. [Architecture](#5-architecture)
6. [On-disk layout and data model](#6-on-disk-layout-and-data-model)
7. [Secret storage (the vault)](#7-secret-storage-the-vault)
8. [CLI adapters](#8-cli-adapters)
9. [Rotation and limit-state engine](#9-rotation-and-limit-state-engine)
10. [Command-line interface](#10-command-line-interface)
11. [Output contract ("contract 1")](#11-output-contract-contract-1)
12. [Process execution (`exec`)](#12-process-execution-exec)
13. [Concurrency, locking and crash safety](#13-concurrency-locking-and-crash-safety)
14. [Security and privacy](#14-security-and-privacy)
15. [LimitShift integration](#15-limitshift-integration)
16. [Phase 2: interactive `run` wrapper](#16-phase-2-interactive-run-wrapper)
17. [Build, release, install and update](#17-build-release-install-and-update)
18. [Testing strategy](#18-testing-strategy)
19. [Repository layout and engineering rules](#19-repository-layout-and-engineering-rules)
20. [Licensing, clean room, provenance and provider terms](#20-licensing-clean-room-provenance-and-provider-terms)
21. [Milestones and acceptance criteria](#21-milestones-and-acceptance-criteria)
22. [Verification checklist (real machines and accounts)](#22-verification-checklist-real-machines-and-accounts)
- [Appendix A: environment variables per CLI](#appendix-a-environment-variables-per-cli)
- [Appendix B: vendor paths and credential slots per OS](#appendix-b-vendor-paths-and-credential-slots-per-os)
- [Appendix C: limit, auth and session signals per CLI](#appendix-c-limit-auth-and-session-signals-per-cli)
- [Appendix D: JSON schemas](#appendix-d-json-schemas)
- [Appendix E: exit codes](#appendix-e-exit-codes)
- [Appendix F: README notice (provider terms)](#appendix-f-readme-notice-provider-terms)

---
## 1. Purpose, goals and non-goals

### 1.1 Problem

LimitShift runs a queue of tasks through agentic CLIs. When a CLI reports that its account has hit a usage limit, LimitShift today waits for the reset and then resumes. Many users have more than one account for a CLI, for example a personal and a work subscription. accshift lets the queue switch to another account of the same CLI straight away, ideally continuing the same conversation, and wait only when every account is capped.

accshift replaces the earlier ai-switcher approach, which had two problems:
- **Licensing:** it was an LGPL fork of ClaudeCodePortable and bundled agm, which is CC-BY-NC and cannot be used.
- **Weight:** it downloaded a portable Node, Git, Python, Perl and PowerShell, and installed a separate 251 MB copy of Claude Code and a 450 MB copy of Codex for every account [R04 §0].

accshift is a new, clean-room program owned by the LimitShift maintainer.

### 1.2 Goals

| ID | Goal | How it is met |
|---|---|---|
| G1 | Keep a queue running across usage limits by switching accounts of the same CLI, continuing the conversation where the CLI allows it | §8 adapters, §9 engine, §15 integration |
| G2 | **macOS and Linux are mandatory**; Windows is supported. x64 and arm64 everywhere, Linux glibc and musl, and WSL | §4, §17 |
| G3 | Very efficient: one static binary per target (at most 6 MB uncompressed, 3 MB compressed), no runtime dependencies, at most 50 ms per control call, no daemon | §2, §12, NFR1 and NFR2 in §1.4 |
| G4 | Each refreshable credential has exactly one owner. accshift never performs OAuth, never proxies, and never calls provider APIs | §8, §14 |
| G5 | Usable standalone by people and by LimitShift through a stable JSON and exit-code contract | §10, §11 |
| G6 | Clean room, MIT-licensed, owned by the maintainer; no dependency on ai-switcher or agm | §20 |
| G7 | Safe unattended: never prompts or hangs in non-interactive mode, and `exec` never prompts at all; every external call is time-bounded; crash-safe state | §7.5, §12.1, §13 |

### 1.3 Non-goals

- **No proxy or API server**, and no use of stored tokens for network calls (usage polling, identity lookups). These are the patterns providers prohibit and the most fragile parts of prior art [R09 §1.3, §1.6].
- **No OAuth or sign-in flows of its own.** Logins always go through the vendor CLI's own command in the user's terminal.
- **Does not install or update the vendor CLIs**, and does not manage portable runtimes. The user installs `claude`, `codex`, `agy` and the others; accshift finds them.
- No GUI, no cloud sync between machines, no account creation.
- **No Gemini CLI (`gemini`) support** (owner decision, 2026-10-10). LimitShift keeps running gemini runners as it does today (§15.4). The research is kept for a later version [R06 §1]. agy (Google Antigravity CLI) is in scope; it keeps its files under `~/.gemini`, so that word still appears in agy paths.
- No handling of local-model routes (Ollama / `--oss`). Those runners bypass accshift (§15.6).
- No modification of vendor binaries or their configuration files beyond what §8 lists explicitly.

### 1.4 Non-functional requirements

| ID | Requirement |
|---|---|
| NFR1 | `version`, `list`, `pick`, `next`, `mark`, `status` and `classify` MUST finish in under 50 ms cold on every OS when the vault is not touched. "Cold" means a new process with a warm file cache; the first execution after install or update (Defender scan, macOS assessment) is measured separately and not gated (§18.4). Commands that touch the vault MUST finish in under 150 ms (macOS `security` exec, Secret Service round trip). `exec` overhead before the child starts SHOULD be under 30 ms for claude and codex, excluding the single keystore call a secret-bearing kind needs. §18.4 measures every command named here. |
| NFR2 | Release binaries MUST be built with `CGO_ENABLED=0`, one per target, each at most 6 MB uncompressed and at most 3 MB compressed (its release archive). CI fails above that (§18.4). |
| NFR3 | Zero runtime dependencies beyond what the OS ships. On macOS that means `/usr/bin/security`. On Linux, Secret Service is optional and a fallback exists. |
| NFR4 | No network access except `self-update` / `update-check`, both off by default and opt-in. No telemetry. |
| NFR5 | Every keychain, D-Bus or process call is bounded by a timeout. Keystore calls use the settings `keystoreProbeSeconds` (default 3) and `keystoreOpSeconds` (default 10). Keyring calls on agy's slot have a fixed 4 s bound, below agy's own 5 s (§7.5, §8.3.2). |
| NFR6 | State and vault writes are atomic (temp file, then fsync, then rename) and serialized by file locks; a crash at any point leaves a consistent previous state. |
| NFR7 | Secrets never appear in argv, logs, JSON output, error messages or crash dumps (§14.4), except in the explicit `env --reveal-secrets` output the user asked for. |

---
## 2. Decisions at a glance (and why Go)

Each decision was made in a separate research track and then checked by independent judges. The full reasoning, rankings, and what would change each decision are in [`DECISIONS.md`](DECISIONS.md).

| # | Decision | Chosen | Main alternatives rejected |
|---|---|---|---|
| D1 | Implementation language | **Go 1.27, `CGO_ENABLED=0`, one static binary per target, built from one Linux runner with GoReleaser OSS** | Rust; bash+PowerShell twins; one PowerShell 7 implementation; Bun/Node/Deno executables; .NET NativeAOT; Zig; Python |
| D2 | Licence | **MIT** (same as LimitShift) | Apache-2.0 (acceptable, adds NOTICE overhead); MPL (copyleft) |
| D3 | Integration surface | **LimitShift launches every managed CLI only through `accshift exec <cli> --account A --status-file F -- <args>`, and decides rotation through one-line-JSON control verbs with sysexits codes ("contract 1"). exec reports its own pre-launch failures only as 125 (126/127 for the binary), with the reason in the status file. `env` exists only for standalone and diagnostic use** | env as the launch path; both env and exec; shared code or library |
| D4 | claude selection | **`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, one per account; history shared; the user's own login is an untouched `native` account #0** | per-account `CLAUDE_CONFIG_DIR` (contingency only); `CLAUDE_SECURESTORAGE_CONFIG_DIR` (experimental opt-in) |
| D5 | codex selection | **per-account `CODEX_HOME` overlay (a real directory) sharing an *allowlist* of entries with the main `~/.codex` by link; `CODEX_SQLITE_HOME` → main; the main home is an untouched `native` account #0** | swapping or symlinking `auth.json`; copying credentials; `CODEX_ACCESS_TOKEN` (Business/Enterprise extra kind only) |
| D6 | agy selection | **in-place swap of agy's single native slot (keyring item `gemini`/`antigravity` and/or agy's token file, resolved per run: on Linux from agy's detectors against the child's environment, on macOS and Windows from the store recorded at `add` until V-A3 passes), with email-keyed save-back as a commit point, a journal, read-back verification, and a lock held for the whole run (spawn, never execve); `pick` and `next` prefer the live slot owner** | per-account `--gemini_dir` (deferred, unverified); forcing file mode by changing the child's env; `JETSKI_OAUTH_TOKEN`; `AGY_ACCOUNT` |
| D7 | Own secret storage | **envelope vault: one XChaCha20-Poly1305 file; the OS store holds a single 32-byte key (macOS keychain via `/usr/bin/security`, Linux Secret Service only when already unlocked, Windows DPAPI, else a 0600 key file); no plaintext mode; commands that need no secret never touch the keystore** | one OS item per secret (size limits); plain 0600 files; a per-OS split |
| D8 | Rotation order and selection | **LimitShift: models inside the account (skipped when the limit is account-wide) → accounts of the same CLI (same session when portable) → other CLI (fresh session + handoff) → wait for the soonest reset. accshift: sticky preference order; limit records per (cli, account, scope) merged by evidence tier (1–4, by the source of the reset value), with backoff for unknown resets; success reported only by `mark --ok`** | accounts before models (later opt-in); cyclic or round-robin; headroom-first |
| D9 | Limit knowledge | **passive only**: the caller's parsed reset, caller-captured output and local vendor files, parsed by one Go parser. No network, no proxy, no probing, no vendor-CLI spawning | polling provider usage endpoints; `codex app-server` probes; `claude -p /usage`; a local proxy |
| D10 | Distribution | GitHub immutable releases + SHA256SUMS + cosign + attestations; `install.sh` / `install.ps1`; Homebrew tap, Scoop, winget later; Windows signing before 1.0 | npm wrapper; unsigned 1.0 |

### 2.1 Why Go

Three judges looked at the evidence through different lenses: maintainability, end-user trust, and technical correctness. A fourth agent tried to refute the choice. All four chose Go. The refuter found no decisive counterargument. Rankings (0–10):

| Option | Maintainer lens | End-user lens | Technical lens |
|---|---|---|---|
| **Go** | **9** | **8.5** | **8.5** |
| Rust | 6 | 8 | 7.5 |
| Bun / Node / Deno executables | 4.5 | 4.5 | 5 |
| .NET NativeAOT | 4 | 5 | 4.5 |
| one PowerShell 7 implementation | 3 | 2 | 2.5 |
| bash + PowerShell twins (the LimitShift model) | 1.5 | 2.5 | 1.5 |
| Zig | 1 | 4 | 3.5 |
| Python | 2.5 | 1.5 | 3 |

**Go vs Rust.** Rust produces smaller, faster binaries:

| Measure | Rust | Go |
|---|---|---|
| Binary size | 0.55–1.9 MB [R02 C4] | 3.2–4.7 MB [R01 §2.1] |
| Time per call | 0.33 ms [R02 C6] | about 2 ms [R01 §2.3] |

None of that is visible next to the 200–450 MB CLIs being driven: Go's roughly 4 MB is about 2% of them [R01 §2.1, R02 §14]. What decides it:

1. **One toolchain, one runner.**
   - Go cross-built all six targets from one Linux runner with no SDKs, and the builds were byte-reproducible. A cold build takes about 15 s, an incremental rebuild 0.3 s [R01 C1].
   - Rust needed zig, cargo-zigbuild, cargo-xwin and a 1.1 GB Microsoft SDK, about 3.6 GB in all. A clean release build takes 60 s, an incremental release build 21 s [R02 C1, C17].
   - This point does not separate the two: neither language can link the native macOS keychain API (Security.framework) from Linux without a macOS SDK, so both must drive `/usr/bin/security`, as this spec does (§7.4) [R01 C8, R02 C2].
2. **Maintainer and agent speed where the product actually breaks.** accshift's risk is tracking undocumented vendor login formats quickly, not CPU work. Go's 0.3 s edit-build loop, its small language, and stable dependencies favour fast, reviewable fixes:
   - Go's standard library and toolchain are covered by the Go 1 compatibility promise, although Go 1.27 still raised the macOS minimum and moved `encoding/json` to a new backend [R01 §3.12]. The other modules accshift uses at runtime (godbus v5, x/sys, x/crypto) have small, slow-moving APIs but carry no formal guarantee.
   - Rust's keyring crate went through 4 major versions in 4 years, and zbus through 3 in 2 years [R02 C17].
   - Rust's prototype needed 6 `unsafe` sites in 383 lines that would need review [R02 §2.1].
3. **Byte-compatibility with the one CLI whose slot we must write.** agy is itself a Go binary built on `zalando/go-keyring` [R01 C5, R07 C1]. Its keychain, Secret Service and Credential Manager encodings come straight from that Go source, and accshift reproduces them in its own code (`go-keyring` is not used at runtime, §19.2).
   - The obvious Rust store crates differ: the Windows one writes UTF-16, and the Secret Service one auto-unlocks and prompts [R07 §4, R02 §5].
   - The judges weighted this point lower: Rust could reproduce the same formats by hand, and agy often uses its file fallback in headless contexts [R07 C2].
   - Codex being written in Rust does not matter, because per-account `CODEX_HOME` never touches Codex's keyring [R04 C12].
4. **Release coverage.** GoReleaser OSS builds archives, checksums, cosign signatures, SBOMs, a Homebrew cask, Scoop, winget, AUR and deb/rpm/apk from that one runner in about 3 s, and can notarize for macOS from Linux [R01 C13, R09 C15].

Go's real weaknesses, and how this spec handles them:

| Weakness | Handling |
|---|---|
| Unsigned Go `.exe` files have a documented record of Defender machine-learning false positives [R01 C12] | Smart App Control blocks *any* unsigned unknown binary anyway, so signing is required whatever the language. Windows signing is mandatory before 1.0, with a clean-VM Defender scan as a release gate (§17.4) |
| `os/exec` mis-quotes `.cmd`/`.bat` arguments (golang/go#69939, still open) | accshift resolves npm shims and never routes prompts through cmd.exe (§12.4) |
| No job objects, ConPTY or junction API in the standard library | About 150–250 lines of `x/sys/windows` code, tested on real Windows CI (§12.4, §18.3) |
| No sum types for the state machine | Table tests and an exhaustiveness linter (§19.3) |
| Go 1.27 requires macOS 13 | Documented. Pin Go 1.26 if macOS 12 must be supported until early 2027 (§4.1) |

**What would flip it to Rust:**
- signed Go builds keep being quarantined on clean Windows 11 while signed Rust builds are not;
- the phase-2 ConPTY wrapper becomes the core product (Rust's portable-pty is proven in Codex and wezterm);
- or the owner decides to invest in Rust.

**What would change it otherwise:**
- the scope shrinks to env-only claude/codex rotation inside LimitShift: then small sh + pwsh functions, with no separate app;
- macOS 12 must be supported after about February 2027: then reconsider. Go 1.26 is the last toolchain that runs there, and it is supported only until then (§4.1).

### 2.2 Why not bash + PowerShell (or one PowerShell 7 implementation)

The evidence comes from LimitShift's own history and from measurements [R03]:

- **Parity cost is already hurting LimitShift.**
  - 10+ sh/ps1 parity fixes in about 4 months, with every feature committed twice.
  - The v2 engine has already dropped the twin model for PowerShell 7 only.
  - Shipped `limitshift.sh` crashes on macOS's bash 3.2 (`${var,,}`), and nobody noticed [R03 C2–C4].
- **Scripts cannot reach credential stores safely:**
  - Linux: `secret-tool` is not installed by default on Ubuntu desktop or server, fails headless, and silently cuts secrets at 8192 bytes while exiting 0.
  - macOS: `security -i` has a 4096-byte line limit.
  - Windows: no built-in cmdlet reads generic credentials. Add-Type P/Invoke costs 0.4–0.7 s per call [R03 C5–C7] and likely (unmeasured) looks like credential-dumping to AMSI [R03 scorecard].
- **Efficiency:** PowerShell 7 costs 420–700 ms per call and 100–180 MB of memory, against a 50 ms budget. It is not installed by default on macOS, Linux or Windows [R03 C10].
- **Data hazards:** PowerShell 7 rewrites ISO timestamps in JSON round trips, silently truncates at depth 2, and its parameter binder swallowed a child's `-c` flag [R03 C8–C9].

Scripts stay where they fit: `install.sh` / `install.ps1`, and the thin LimitShift glue that calls the JSON contract (§15).

### 2.3 Other runtimes

| Runtime | Why not |
|---|---|
| Bun / Node SEA / Deno executables | 62–127 MB per binary. Bun's keychain API is experimental and fails headless. Node SEA needs addon extraction and re-signing [R03 C11–C12] |
| .NET NativeAOT | Good binaries (1.8 MB, 3.5 ms), but no cross-OS compilation, so 4–6 native build runners would be needed [R03 C13] |
| Zig | No keychain support, and its standard library breaks between releases |
| PyInstaller | No cross-compilation, and 169 ms per call |

---
## 3. Glossary

| Term | Meaning |
|---|---|
| **cli** | One of `claude` (Claude Code), `codex` (OpenAI Codex CLI), `agy` (Google Antigravity CLI), `gemini` (Gemini CLI), `copilot` (GitHub Copilot CLI). |
| **account** | A named login for one cli, registered in accshift (for example `claude/work`). Names match `^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$` (no trailing `.`, `-` or `_`, which Windows path normalisation would strip) and are unique per cli. Names never form vault ids, paths or state keys (those use the account id), so no name needs to be reserved for them; the regex also rules out a leading `_`. Not allowed: the reserved words `all`, `none`, `native`, and, on every OS so registries stay portable, the Windows device names `con`, `prn`, `aux`, `nul`, `com0`–`com9`, `lpt0`–`lpt9`, `conin$`, `conout$`, alone or followed by `.` and an extension. |
| **account id** | An immutable 8-hex-character identifier drawn at `add` and never reused in the registry. It keys the overlay home `homes/<cli>/<id>`, the vault entry `<cli>/<id>` and the `state.json` entry `<cli>/<id>`, so `rename` changes only the name (§6.2, §6.3, §7.2). |
| **kind** | How an account is selected for a run: `token`, `home`, `slot`, `native`, `access-token`, `api-key`, `gh`, `login-slot` (experimental) (§8). |
| **native account** | The cli's own default login (what plain `claude` uses today), registered so rotation can include it. accshift never moves or copies its credential. |
| **pool** | The ordered list of accounts a caller allows for one runner. The default is every enabled account of that cli, in registry order. |
| **preference order** | Registry order, or `--pool` order when a pool is given. It decides which account is picked first when several are usable (§9.3). |
| **slot** | A vendor credential location that holds one login for the whole OS user, such as agy's keyring item or token file. Using a slot means swapping its content. |
| **overlay home** | A per-account directory used as a cli's home (`CODEX_HOME`). It holds that account's credential and links back to the user's real home for everything shared. Its directory name is an immutable id, not the account name (§6.2). |
| **limit window** | The time until which an account is known to be capped for one scope: the `until` of a limit record, kept per (cli, account, scope) where scope is `account` or `model:<bucket>` (§9.1). `limitedUntil` in `list` summarises them. |
| **contract** | The versioned JSON and exit-code interface for machine callers (§11). This spec defines contract 1. |
| **caller** | The program invoking accshift, normally LimitShift (v1 bash, v1 PowerShell, v2 engine). |
| **control verb** | Every command other than `exec` and `run`. Control verbs report failures with the sysexits codes of §10.3 (64–78). `exec` and `run` report every failure before the child starts as 125, use 126/127 for the binary, and otherwise return the child's status (§12.1.1). |
| **usable** | An account a request may run on: enabled, no `relogin` and no `attentionCode`, not past `expiresAt`, and no active record that blocks the requested model (§9.3). Selection uses usability, never the displayed state. |
| **session portability** | Whether a conversation started under account A can continue under account B after a switch: `yes`, `likely`, `possible`, `unlikely` or `no`, decided per move by the adapter (§8). A move from an account to itself is always `yes`. |
| **vault** | accshift's encrypted file of secrets plus the key that unlocks it (§7). |
| **sessionPortable** | Boolean form of session portability: true for `yes` and `likely`; false for `possible`, `unlikely` and `no`. When it is false, LimitShift starts a new session with the handoff note instead of resuming (§15.2). |

## 4. Supported platforms and CLIs

### 4.1 Operating systems and architectures

| OS | Architectures | Minimum | Notes |
|---|---|---|---|
| macOS | arm64, x64 | 13 Ventura (Go 1.27 minimum) | arm64 binaries carry the Go linker's ad-hoc signature automatically [R01 C4]. Notarization is not needed for curl or script installs [R09 C10]. |
| Linux | x64, arm64 | kernel 3.2 | Fully static binary. One artifact per architecture covers glibc, musl/Alpine, WSL2 and containers [R01 C2]. WSL1 is supported only once its CI smoke job passes (§18.4). Under WSL, accshift launches only Linux CLI builds (§12.2). |
| Windows | x64, arm64 | Windows 10 / Server 2016 | Native arm64 build (ai-switcher only shipped x64). |

Every MUST in this spec applies to all three OS families unless a section names an exception. **macOS and Linux are release-blocking**: a release MUST NOT ship if any macOS or Linux CI job is red (§18.4).

### 4.2 CLIs

| cli | Tier | Versions the research is based on | Account kinds |
|---|---|---|---|
| claude | 1 | Claude Code 2.1.293 [R04] | `token` (default), `native`, `login-slot` (experimental) |
| codex | 1 | Codex CLI 0.161.0 [R04] | `home` (default), `native`, `access-token`, `api-key` |
| agy | 1 | Antigravity CLI 1.3.1 [R05, R07] | `slot` |
| copilot | 2 | Copilot CLI 1.0.93 [R06] | `token` (default), `gh`, `native` |

- **Tier 1** is delivered in M2–M4 and is what LimitShift integrates with first.
- **Tier 2** is delivered in M6.
- A cli that `exec` cannot run on this OS is unsupported: `pick` and `next` exit 69 `unsupported-cli`, `list`, `status` and `mark` return `accounts:[]` with `poolSize:0` and `rotationPossible:false` (never 69), and `exec` and `run` exit 125 `unsupported-cli` (§10.3, §12.1.1). `version` lists `supportedClis` and the `experimental` subset whose rotation is unverified on this OS (§11.2). LimitShift then applies its legacy rule (§15.2).

Vendor behaviour changes over time. Every adapter MUST keep its vendor-specific constants (paths, env var names, regexes) in one file per cli, `internal/adapters/<cli>/facts.go`, with a comment giving the vendor version they were last verified against.

## 5. Architecture

### 5.1 Components

```
accshift (single Go binary, no daemon)
├── cli/          command parsing, human output, --json output, exit codes
├── paths/        per-OS root dir, ACCSHIFT_HOME, vendor home discovery
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
limitshift ──pick claude --model M --prefer work--> accshift ── reads registry+state, no lock ──> {"account":"work",...} exit 0
limitshift ──exec claude --account work --status-file S -- -p --session-id U ...--> accshift      (run starts 10:25Z = 1791368700)
      accshift: build env (scrub API-key vars, set CLAUDE_CODE_OAUTH_TOKEN from vault) ── execve claude
claude prints "You've hit your session limit · resets 3pm (Europe/Kyiv)" and exits 1      (10:40Z = 1791369600)
limitshift ──next claude --from work --model M --limited-until 1791374400 --evidence-file last-run.txt --exit 1
             --run-started-at 1791368700 --session U --cwd D--> accshift
      accshift: parse the evidence file and the tail of session U's transcript (no lock), then under state.lock
                 record claude/3f9a01c2 (work) scope=account until 1791374400 = 2026-10-07T12:00:00Z
                 (tier 3: the transcript's structured reset; the text and --limited-until say the same at tier 2);
                 pick the first usable account in preference order → "main"
      {"account":"main","previous":"work","switched":true,"sessionPortable":true,"recorded":{...}} exit 0
limitshift ──exec claude --account main --status-file S -- -p --resume U ...  (same conversation, no waiting)
limitshift ──mark claude --account main --ok--> accshift   (after the run succeeds; resets strikes and backoff)
```

**All accounts capped:** `next` returns exit 75 with `account` set to the account that frees up first and `resetAtEpoch` = its reset + 30 s. That account may be the one that just hit the limit; a one-account pool always gives 75 naming it (or 77 if it needs a human). A single runner sleeps until then plus its own buffer and runs on that account; with fallbacks, LimitShift marks the runner limited until `resetAtEpoch` and tries another runner (§9.3, §15.2).

**agy run:** `exec agy --account b` (§8.3.3 is normative). The **fast-path condition** is: the resolved slot holds a credential, every slot in the write set that holds a credential carries the requested email, and the slot copy's expiry is not earlier than the vault snapshot's (§8.3.2).
1. **Shared attempt**, only when V-A8 has passed for this OS and agy version. accshift waits briefly for live swapper intent markers, takes the agy slot lock shared, and reads every slot without writing. If no journal exists and the fast-path condition holds, the run goes to step 5 under the shared lock and nothing is written. A foreign agy does not block this path; it only sets `foreignAgy` in the status file. `state.agySlot` never decides the lock mode or the fast path; it is only a hint for `pick`.
2. Otherwise accshift releases the shared lock (a held lock is never converted in place) and takes it **exclusive**, with an intent marker. The foreign-process check gates only this exclusive path: a running agy that accshift did not start gives 125 `agy-busy`. Only after that check does it recover any stale journal.
3. It reads the slots and saves every slot's content back to the account that owns it, identified by email. An unregistered email stops the run before anything is written. This vault write is a commit point: if it fails, no slot is touched.
4. If the fast-path condition now holds, nothing is written. Otherwise it journals the swap, writes b's credential into every slot of the write set, and verifies each by read-back.
5. It spawns agy and waits.
6. After agy exits, it stops lingering agy processes this run started, reads the slots, and saves them back to b (agy may have refreshed the token). If every slot is empty, agy itself cleared a rejected login: there is no save-back, and b gets `relogin(rejected)`. Another email in the slot sets `wrongAccount` in the status file, and LimitShift re-runs the task without calling `next`. Then it releases the lock (§8.3, §13).

### 5.3 Design principles

1. **One owner per refreshable credential** [R09 §1.6]. Claude's env token never refreshes. Each Codex overlay home holds its own refreshing file. agy's single slot is swapped under a lock and always saved back.
2. **Use vendor-documented selection mechanisms first**: env tokens, home variables. Use undocumented ones only as explicitly experimental fallbacks.
3. **Passive limit knowledge.** accshift learns limits only from the caller (`--limited-until`), from local CLI output (`--evidence-file`, `classify`), or from local vendor files the CLI already wrote (the Claude transcript, the Codex rollout's `token_count`), read before `state.lock` is taken (§9). Never from the network.
4. **No resident process.** Every invocation is short-lived. State lives in files guarded by locks.
5. **Pure core, thin edges.** `engine`, `state` transitions and `classify` are pure functions with table tests. OS-specific code sits behind small interfaces with fakes.

---
## 6. On-disk layout and data model

### 6.1 Root directory

| OS | Default root | Override |
|---|---|---|
| Linux, WSL | `${XDG_DATA_HOME:-~/.local/share}/accshift` | `ACCSHIFT_HOME` |
| macOS | `~/Library/Application Support/accshift` | `ACCSHIFT_HOME` |
| Windows | `%LOCALAPPDATA%\accshift` (never Roaming) | `ACCSHIFT_HOME` |

- Everything accshift owns lives under one root, so a single directory can be backed up, moved or wiped. The one exception is the `key-file` key source, which deliberately lives elsewhere (§7.3).
- `ACCSHIFT_HOME` MUST be an absolute path; a relative one is a usage error (64 `usage`; 125 `usage` for `exec` and `run`).
- A relative `XDG_DATA_HOME` or `XDG_CONFIG_HOME` is ignored, as the XDG specification requires, and the default is used instead.
- The home directory MUST come from `$HOME` / `%USERPROFILE%` (`os.UserHomeDir`), never from `os/user`, which needs cgo [R01 C14].
- `version --json` and `doctor --json` report `root` and `rootSource` (`ACCSHIFT_HOME`, `XDG_DATA_HOME` or `default`). The root depends on the caller's environment, so a different context (a snap-packaged editor's terminal, a systemd unit, cron, sudo) can see a different, empty root. `doctor` warns when `XDG_DATA_HOME` or `XDG_CONFIG_HOME` points under `~/snap/` or `~/.var/app/`.
- The root and its subdirectories are created only by writers (§6.3), the first time they need them. `self-update --record-install` creates the root for the installers (§17.6). Read-only commands never create anything; with no root they behave as if no account were registered.

```
<root>/
├── accounts.json           registry (non-secret, human-readable); changed only through accshift commands (§6.2)
├── state.json              runtime state (limits, auth, agy slot owner, notice acceptance); machine-managed
├── vault.v1.bin            encrypted secrets (§7)
├── vault.key.dpapi         Windows default key source (§7.3); the key-file source lives in a different directory (§7.3)
├── locks/
│   ├── state.lock          guards accounts.json + state.json
│   ├── vault.lock          guards vault.v1.bin (and vault creation)
│   ├── agy-slot.lock       held for the whole duration of an agy run (§13); stays empty
│   ├── agy-slot.holders/   one <pid>-<starttime>.json per current holder (diagnostics, §13.1)
│   └── agy-slot.intent.d/  one <pid> marker per waiting swapper (writer preference, §13.1)
├── journal/
│   └── agy-swap.json       crash-recovery record for an in-flight slot swap, `add agy` / `login agy`, or `remove --sign-out-slot` (§13.3)
├── homes/
│   ├── codex/<id>/         Codex overlay homes (§8.2); <id> is the account's immutable id (§6.2), never renamed
│   └── claude/<id>/        claude login-slot directories (§8.1, experimental)
├── logs/accshift.log      written only by writers, with --debug or ACCSHIFT_DEBUG=1 (read-only commands log to stderr only, §10.1); redacted (§14.4); rotated at 1 MB, 3 files
├── logs/events.jsonl       append-only limit/auth/switch events and post-run findings (§9.6, §12.1.1); redacted; rotated at 1 MB
└── install.json            install receipt, written by accshift itself when an installer calls it (§17.6)
```

Migration backups (`<file>.bak-v<N>`) and quarantined files (`<file>.corrupt-<epoch>`) sit next to the file they come from (§6.4).

Permissions:
- **Exit codes.** The codes below are those of control verbs. `exec` and `run` report the same conditions before launch as 125 with the same `error.code` (§12.1.1).
- **POSIX modes.** accshift MUST NOT change the process umask, because umask is inherited by the CLI it launches (§12.3). It creates every file with `os.OpenFile(p, O_CREATE|O_EXCL|O_WRONLY, 0o600)` (or the atomic-write temp file, §13.2) and every directory with `os.Mkdir(p, 0o700)`, then `Chmod`s to the exact mode, because the caller's umask can only remove bits.
- **Root at a looser mode.** This covers a root owned by the current user but group- or world-accessible (for example created by a shell with umask 022), and a `vault.*`, `state.json` or `accounts.json` that is group- or world-accessible.
  - A writer (§6.3) tightens it (directories 0700, files 0600) before reading anything else, and prints one `accshift:` notice. `exec` prints nothing; it logs the fix with `--debug` only (§12.1.1).
  - A read-only command changes nothing and exits 78 `insecure-permissions` with the hint `accshift doctor --fix`. `doctor` without `--fix` reports it as a finding instead.
  - If tightening fails, the writer refuses before reading any secret: exit 78 `unsupported-filesystem` with the fix (`exec`: 125 `unsupported-filesystem`). An owner's `chmod` fails in practice only on a read-only mount or a filesystem without POSIX modes.
- **Ownership.** Every file and directory accshift reads or writes under the root (and the key-file directory, §7.3) MUST have `st_uid == geteuid()`. When euid is 0 and `$HOME` is owned by another uid (macOS `sudo` keeps `HOME` by default), accshift refuses before creating anything: exit 78 `wrong-owner`, hint "run without sudo".
- **Filesystems.** At first use accshift `statfs`es the root. On a filesystem that cannot hold POSIX modes or reliable locks it exits 78 `unsupported-filesystem` with the hint to set `ACCSHIFT_HOME` to a local path:
  - Linux `f_type`: V9FS `0x01021997` (WSL drvfs), CIFS `0xFF534D42`, SMB2 `0xFE534D42`, MSDOS `0x4d44`, exFAT `0x2011BAB0`;
  - macOS `f_fstypename`: `smbfs`, `msdos`, `exfat`.
  - NFS (`0x6969`, `nfs`) is allowed with a `doctor` warning, but agy swaps are refused there unless `settings.agyAllowNetworkHome` is true: agy processes on other hosts that share `~/.gemini` are invisible to the foreign-process check (§8.3.3).
- **Windows:** the root directory MUST get a protected DACL that grants access only to the current user SID (plus SYSTEM), set with `SetNamedSecurityInfo` [R07 §7]. A writer applies or repairs the DACL whenever the root lacks it, including a root an installer created. A read-only command treats a missing or wider DACL like a looser mode: exit 78 `insecure-permissions`.

### 6.2 `accounts.json` (registry)

- Non-secret and safe to read. accshift validates it on every load against Appendix D.1.
- Unknown fields are kept on rewrite (forward compatibility).
- Full schema: Appendix D.1.

```json
{
  "version": 1,
  "clis": {
    "claude": {
      "accounts": [
        { "name": "main", "id": "e04b7d93", "kind": "native", "label": "me@example.com", "enabled": true, "createdAt": "2026-10-07T10:00:00Z" },
        { "name": "work", "id": "3f9a01c2", "kind": "token", "label": "me@work.example", "plan": "max", "enabled": true,
          "createdAt": "2026-10-01T10:05:00Z", "expiresAt": "2027-10-01T10:05:00Z", "secretId": "claude/3f9a01c2" }
      ]
    },
    "codex": {
      "mainHome": "/home/me/.codex",
      "accounts": [
        { "name": "main", "id": "52a8c1f0", "kind": "native", "label": "me@example.com", "enabled": true, "createdAt": "2026-10-06T08:00:00Z" },
        { "name": "work", "id": "c81f4a6d", "kind": "home", "home": "/home/me/.local/share/accshift/homes/codex/c81f4a6d",
          "label": "me@work.example", "plan": "plus",
          "identity": { "email": "me@work.example", "chatgptAccountId": "…", "chatgptUserId": "…" }, "enabled": true,
          "createdAt": "2026-10-06T08:10:00Z" }
      ]
    },
    "agy": {
      "settings": { "slotWaitSeconds": 60 },
      "accounts": [
        { "name": "a", "id": "7c41d09e", "kind": "slot", "label": "a@gmail.com", "identity": { "email": "a@gmail.com" },
          "secretId": "agy/7c41d09e", "agySlotUsed": { "store": "keyring", "path": null, "agyVersion": "1.3.1" }, "enabled": true,
          "createdAt": "2026-10-06T08:20:00Z" }
      ]
    }
  },
  "settings": {
    "minCooldownSeconds": 60,
    "unknownResetBackoffMinutes": { "start": 30, "max": 300 },
    "earlyRehitBackoffMinutes": { "start": 5, "max": 60 },
    "authSuspectMinutes": 15,
    "slotWaitSeconds": 30,
    "updateCheck": "off"
  }
}
```

Rules:
- **Account id.** Every account has an immutable `id`: 8 lowercase hex characters, drawn at random by `add` and unique in the registry across all clis. `add` draws again until the id is used nowhere: by no registry account, no `homes/<cli>/<id>` directory, no vault entry and no state.json key. The id, never the name, keys everything accshift stores for the account:
  - the overlay home `homes/<cli>/<id>` (for example `homes/codex/c81f4a6d`);
  - the vault entry, `secretId` = `<cli>/<id>` (for example `claude/3f9a01c2`, §7.2);
  - the state.json entry `<cli>/<id>` (§6.3).
- **Names.** `name` is what people and commands use; it is unique per cli (§3). `rename <cli> <old> <new>` changes only `name`, plus every `agyRestoreAfterRun` setting (global or `clis.agy.settings`) that names the old account, in one atomic write of accounts.json under `state.lock`. It never moves directories, secrets or state, so vendor keyring keys that derive from the canonical home path (§8.1, §8.2) stay valid and a running CLI keeps its home (§10.2). `remove` deletes the account's vault entries, overlay directory and state entry, then the registry entry, in one transaction (§10.2).
- The array order of `clis.<cli>.accounts` is the **preference order** (§9.3). `accshift order` rewrites it.
- `label` is what users see. `identity` holds facts decoded locally from vendor files (a Codex `id_token`, an agy token's `email`). Labels for `token` kinds are user-asserted, because those tokens cannot be decoded offline [R04 C11]. A `native` account's identity can change outside accshift (the user signs in to another account with the vendor's own login); `doctor` compares the vendor's current email or label with the recorded one and warns (§9.6); `doctor --fix` or `mark --clear` then clears that account's records.
- `secretId` points to the account's vault entry, for kinds whose secret accshift holds (§7.1). `home` points to an overlay home inside `<root>/homes`; adopting a home outside the root is allowed only for `native` codex accounts.
- `home` is stored as the canonical path (`filepath.EvalSymlinks`) recorded at `add` (§8.2).
- The registry MUST NOT contain secrets. `accshift doctor` warns if any string field matches the redaction pattern table (§14.4), naming the field and never quoting its value.

**Changing the registry.** LimitShift queues run for days, so there is no moment when "no accshift process runs", and many editors save in place rather than atomically. Users therefore change the registry only through accshift:
- **Accounts** through their commands: `add`, `login`, `rename`, `enable`, `disable`, `order`, `remove`.
- **Single keys** with `accshift config <key>` (prints the effective value) and `accshift config <key> <value>` (sets it). Keys are dotted paths from the registry root:
  - `clis.<cli>.mainHome`, `clis.<cli>.mainSqliteHome`, `clis.<cli>.bin`, `clis.<cli>.buckets.<model>`, `clis.<cli>.shareExtra`;
  - `settings.<key>` and `clis.<cli>.settings.<key>` (table below).
  
  A value is parsed as JSON when it parses (a number, boolean or list), otherwise it is taken as a string. The changed registry is validated and then written atomically under `state.lock` (§13.2). An invalid value, such as a relative `clis.<cli>.bin` or a `clis.codex.mainHome` inside `<root>/homes/` (§8.2), exits 65 `invalid-config` and changes nothing.
- **Anything else** with `accshift config edit`. It needs a terminal (non-interactively it exits 64 `usage`). It copies accounts.json to a 0600 temp file in `<root>`, opens `$VISUAL` or `$EDITOR`, validates the saved copy, and writes it atomically under `state.lock`.
  - It refuses a copy that changes an account's `id`, `secretId` or `home`, adds or removes an account, or fails validation. It then shows the error and offers to re-open the editor; declining leaves accounts.json unchanged (exit 65 `invalid-config`).
  - A changed `name` follows the `rename` rules (§10.2).
  - If accounts.json changed while the editor was open, nothing is written: it exits 73 `registry-changed` and keeps the edited copy, naming its path.
  - It is also the repair path for a registry that fails validation or was quarantined (§6.4).

**Settings** (`Settings` in Appendix D.1). For a command on cli C, a key's effective value is `clis.C.settings.<key>` if set, else `settings.<key>`, else the default. `updateCheck` is read only from the global `settings`.

| Key | Default | Meaning |
|---|---|---|
| `minCooldownSeconds` | 60 | shortest stored limit; a caller `--limited-until` earlier than now + this is an unknown reset (§9.4) |
| `unknownResetBackoffMinutes` | `{start: 30, max: 300}` | unknown-reset backoff, doubling per consecutive hit of one scope (§9.4) |
| `earlyRehitBackoffMinutes` | `{start: 5, max: 60}` | backoff for a limit hit soon after the previous record of that scope expired (§9.4) |
| `authSuspectMinutes` | 15 | length of an auth-suspect record, and the provider-incident window (§9.2) |
| `slotWaitSeconds` | 30 | default `--slot-wait` for the agy slot lock (§13.1) |
| `updateCheck` | `"off"` | `"off"` or `"daily"` (§17.7); global only |
| `agyRestoreAfterRun` | unset | name of the agy account that every swapping run puts back afterwards (§8.3.3) |
| `agyAllowNetworkHome` | `false` | allow agy swaps when the root is on NFS (§6.1) |
| `keystoreProbeSeconds` | 3 | timeout of a keystore lock probe (§7.4, §7.5) |
| `keystoreOpSeconds` | 10 | timeout of one keystore operation (§7.4, §7.5) |

### 6.3 `state.json` (runtime state)

The example is a snapshot taken at 2026-10-07T10:45:00Z (epoch 1791369900). All times in state.json are UTC epoch seconds.

```json
{
  "version": 1,
  "notice": { "acceptedAt": 1790849100, "version": 1 },
  "accounts": {
    "claude/3f9a01c2": {
      "status": "limited",
      "reason": "limit",
      "records": [
        { "kind": "limit", "scope": "account", "until": 1791374400, "tier": 3, "limitSource": "structured", "resetConfidence": "exact",
          "limitType": "five_hour", "observedAt": 1791369600, "snippet": "You've hit your session limit · resets 3pm (Europe/Kyiv)" },
        { "kind": "limit", "scope": "model:opus", "until": 1791784800, "tier": 2, "limitSource": "text", "resetConfidence": "parsed",
          "limitType": "seven_day_opus", "observedAt": 1791368400, "snippet": "You've hit your Opus limit · resets Oct 12, 9am (Europe/Kyiv)" }
      ],
      "relogin": null,
      "authStrikes": 0, "lastStrikeAt": null, "attentionCode": null,
      "backoff": {
        "account":    { "hits": 0, "lastUntil": 1791374400, "lastHitAt": 1791369600, "rehitMinutes": 0 },
        "model:opus": { "hits": 0, "lastUntil": 1791784800, "lastHitAt": 1791368400, "rehitMinutes": 0 }
      },
      "lastUsedAt": 1791369600, "lastOkAt": 1791367800,
      "utilization": { "five_hour": 1.0, "seven_day": 0.41, "observedAt": 1791369600 }
    },
    "codex/c81f4a6d": {
      "status": "limited",
      "reason": "limit",
      "records": [
        { "kind": "limit", "scope": "account", "until": 1791370800, "tier": 1, "limitSource": "default", "resetConfidence": "guess",
          "observedAt": 1791367200 }
      ],
      "relogin": null,
      "authStrikes": 0, "lastStrikeAt": null, "attentionCode": null,
      "backoff": { "account": { "hits": 2, "lastUntil": 1791370800, "lastHitAt": 1791367200, "rehitMinutes": 0 } },
      "lastUsedAt": 1791367200
    },
    "codex/52a8c1f0": {
      "status": "needs-relogin",
      "reason": "refresh-dead",
      "records": [],
      "relogin": { "reason": "refresh-dead", "since": 1791364500,
                   "snippet": "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again." },
      "authStrikes": 0, "lastStrikeAt": null, "attentionCode": null
    }
  },
  "agySlot": { "owner": "7c41d09e", "store": "keyring", "writtenAt": 1791361200, "saveBackPending": false },
  "agyBinary": { "path": "/home/me/.local/bin/agy", "size": 211026152, "mtime": 1790838720, "version": "1.3.1" }
}
```

In the example, `claude/3f9a01c2` last reported success (`mark --ok`, which deletes the `backoff` map) at 10:10Z, and another queue's Opus run hit its weekly Opus limit at 10:20Z. At 10:40Z it hit its session limit (13:40 in Kyiv), which resets at 3pm Kyiv, 12:00Z. The Opus record resets on Oct 12 at 9am Kyiv (06:00Z) and blocks only requests for the `opus` bucket. The notice was accepted at the first `add`, which registered `work` (2026-10-01T10:05:00Z). `codex/c81f4a6d` hit a limit with no reset time twice: at 09:00Z (30 minutes) and again at 10:00Z, 30 minutes after that record expired, so the backoff doubled to 60 minutes (§9.4).

**Top level** (Appendix D.2):
- `version`: the file format version (§6.4).
- `notice`: `{acceptedAt, version}`, the user's acceptance of the provider notice (Appendix F, §20.4).
  - Every `add` (all clis and kinds, including `--native` and `--capture-current`) shows the notice when `notice` is unset or its `version` is older than the binary's, requires `y` or `--accept-notice`, and then writes it.
  - `accshift notice --accept` (or `y` at its prompt) also writes it, without adding an account (§10.2). This is how a user whose accounts are all registered accepts a new notice version, which is bumped only when the Appendix F text changes materially.
  - Until it holds the current version, `pick` and `next` exit 69 `notice-not-accepted` with the hint `accshift notice --accept`, and `exec` without `--account` exits 125 `notice-not-accepted`. `exec --account` still runs (§9.3). `doctor` reports it.
  - It lives here, not in the registry, so editing accounts.json cannot accept it.
- `accounts`: one AccountState per account, keyed `<cli>/<id>` with the immutable id of §6.2, never the name. `rename` therefore never touches state.json, and a lock-free reader that reads accounts.json and state.json as two snapshots can never see a renamed account without its state.
  - An account with no entry has the empty state: no records, `relogin` null, no strikes, no backoff.
  - `remove` deletes the account's entry in its own transaction (§10.2).
  - An entry whose key matches no registry account is ignored. `doctor` reports it and `doctor --fix` deletes it.
- `agySlot`: `{owner, store, writtenAt, saveBackPending?}`. `owner` is the `id` of the registered agy account accshift last put into agy's slot or last observed there, or `null`; `store` is where it was written.
  - It is a hint for `pick` and `list` only: `pick agy` returns `agySlot.owner` whenever it is a usable candidate (§9.3), and `pick` never opens the keystore. It never decides a lock mode or a swap; `exec` always reads the slots themselves (§8.3.3).
  - After a run, if every slot is empty, `agySlot` becomes `null`. On a mismatch, `owner` becomes the observed registered account or `null` (§8.3.3).
  - `saveBackPending: true` means a post-run save-back failed and left the slot untouched. The next exclusive slot holder performs that save-back before anything else (§8.3.3).
- `agyBinary`: `{path, size, mtime, version}`, the realpath, size and mtime of the resolved agy binary with its `agy --version` output. `exec` uses it to know the agy version without running agy. On a cache miss it runs `agy --version` once with a 2 s timeout and stores the result; an unknown version counts as V-A8 not passed (§8.3.1).
- `updateCheckedAt`: when the last update check ran (§17.7). With `settings.updateCheck: "daily"`, a check runs only if this is more than 24 h ago. Only writers write it, so read-only commands never run the check.

**AccountState** (Appendix D.2):
- `status` and `reason` are display caches. The engine always recomputes them from `records`, `relogin`, `attentionCode`, the registry (`enabled`, `expiresAt`) and `now` (§9.2), so an expired record never needs a write to clear it. They are never used for selection (§9.3).
- `records`: `Record = {kind, scope, until, tier, limitSource, resetConfidence, limitType?, observedAt, snippet?, clamped?}` (§9.1).
  - `kind` is `limit` or `auth-suspect`. An auth-suspect record has scope `account`, tier 1 and limitSource `auth` (§9.2). The merge rule applies only between records of the same kind; an active record of either kind blocks.
  - `scope` is `account` or `model:<bucket>`.
  - `tier` is an integer, describing where the reset value came from: 1 no vendor-supplied reset, 2 a reset parsed from text, 3 a reset from structured vendor data, 4 a user override (§9.4).
  - `until` is the vendor's reset, stored unchanged; the 30 s skew margin is added only when usability and `resetAtEpoch` are computed (§9.3).
  - `clamped: true` marks a record whose `until` the engine clamped because of clock skew (§9.4).
  - Expired records are pruned on the next write.
- `relogin`: `null` or `{reason, since, snippet?}`, the sticky needs-relogin state (§9.2).
  - `reason` is `rejected`, `refresh-dead`, `expired` or `missing`. It is set by definitive evidence, by an escalating strike, by `exec` when the account's credential is absent (`missing`), or by `exec` when agy emptied every slot during the run (`rejected`).
  - It is cleared only by `login` or `mark --clear`, never by a counter reset or by pruning.
  - `expired` is derived from accounts.json `expiresAt`. `mark --clear` cannot clear it (exit 65 `expired`, hint `accshift login <cli> <name>`).
- `authStrikes` and `lastStrikeAt`: ambiguous 401/403 strikes (§9.2). `mark --ok` and a same-identity `login` clear `authStrikes` and keep `lastStrikeAt` (the incident window, §9.2); `mark --clear` and `login --new-identity` clear both.
- `attentionCode`: the reason for a sticky needs-attention state (§9.2). Only `mark --clear` clears it.
- `backoff`: `{"<scope>": {hits, lastUntil, lastHitAt, rehitMinutes}}`, the memory the unknown-reset doubling and the early re-hit rule need after a record has expired (§9.4). `hits` counts consecutive unknown-reset hits of the scope; `lastUntil` is the `until` of the scope's last record; `rehitMinutes` is the current early re-hit backoff.
  - Pruning keeps an entry until 24 h after the later of its `lastHitAt` and `lastUntil`, even when its record has expired and been pruned, so a weekly or monthly record keeps its early re-hit memory (§9.4).
  - `mark --ok` and `mark --clear` delete the whole map.
- `lastUsedAt` and `lastOkAt`: `lastOkAt` is written only by `mark --ok`; `lastUsedAt` by `mark --ok` and by `next` for its `--from` account. `exec` writes neither (§9.2).
- `utilization` is display-only (§9.3).
- `wrongAccount` (agy only): `{expected, found, observedAt}`, set when the post-run check found a different email in the slot than the requested account's (§8.3.3). `expected` and `found` are emails; `found` may belong to no registered account. It is also reported in the status file. The next run of this account whose post-run check matches clears it.
- A same-identity `login` clears `relogin`, `authStrikes` and auth-suspect records, and keeps limit records, `backoff`, `attentionCode` and `lastStrikeAt` (§9.2). `login --new-identity` clears all records, `authStrikes`, `lastStrikeAt`, `backoff`, `attentionCode` and `relogin` (§8, §9.2). `mark --clear` removes all records, `authStrikes`, `lastStrikeAt`, `attentionCode`, `backoff` and `relogin` (except `expired`); `mark --clear --model M` removes only that bucket's records (§10.2).
- Unknown fields are kept on rewrite.

**Readers and writers** (§11.1 rule 8):
- **Read-only commands:** `version`, `list`, `status`, `pick`, `doctor` without `--fix`, `classify` without `--record`, `vault status`, and `notice` without `--accept` (unless the user answers `y` at its prompt). They take no lock and make no state, vendor or file-system write: no rename, migration, backup, recreation, `chmod` or re-ACL (§6.1, §6.4). Their `--debug` log goes to stderr only (§10.1). They read accounts.json and state.json lock-free as atomic snapshots (§13.2), and migrate an older version in memory only.
- **Writers:** `next`, `mark`, `enable`, `disable`, `order`, `config`, `classify --record`, `doctor --fix`, `notice --accept` (or `notice` answered `y`), `exec`, `add`, `login`, `remove`, `rename`, `agy use`, `vault migrate`, `vault export` and `vault import`; also `run` (it records limits like `next`, §16), `env` (overlay link refresh only, §12.7) and `self-update` (`install.json`, `updateCheckedAt`). A writer changes accounts.json and state.json only under `state.lock`, reads both files again after taking it, and writes atomically (§13.2).
  - accounts.json: `add`, `login`, `remove`, `rename`, `enable`, `disable`, `order`, `config`.
  - state.json: `next`, `mark`, `classify --record`, `run`, `add` (`notice`; `add agy --capture-current` also `agySlot`), `notice --accept` (`notice`), `login`, `remove`, `agy use` (`agySlot`), `doctor --fix`, `self-update` (`updateCheckedAt`), and `exec`.
  - `exec` writes only `relogin(missing)` when a credential is absent, the agy post-run bookkeeping (`agySlot`, `wrongAccount`, `relogin(rejected)` on an emptied slot, `saveBackPending`) and the `agyBinary` cache. It never changes strikes, backoff or `lastUsedAt` (§9.2).

### 6.4 Versioning and migration

- Both files carry `"version"`.
  - A writer migrates an older version forward atomically under `state.lock`, keeping a `<file>.bak-v<N>` copy.
  - A read-only command migrates in memory only and never rewrites, backs up or renames a file.
  - Commands refuse a newer version: exit 78 `config-newer-version` (`exec`: 125 `config-newer-version`), hint "upgrade accshift". They never write a newer file.
- **Damaged files** (`accounts.json`, `state.json`). A file that fails to parse is never overwritten silently, and only a writer holding `state.lock` may move it. A user's editor or another tool may be half-way through a non-atomic save, so one failed read proves nothing.
  - A read-only command, or any command that does not hold `state.lock`, exits 78 `config-corrupt` (`exec`: 125 `config-corrupt`) and changes nothing.
  - A writer holding `state.lock` reads the file again 200 ms later. Only if the second read fails the same way may it quarantine the file: rename it to `<name>.corrupt-<epoch>` (with the Windows retry rules of §13.2) and exit 78 `config-corrupt` (`exec`: 125).
  - A file that parses but fails validation (Appendix D.1, D.2), for example one with a relative `clis.<cli>.bin` (§12.2), is never renamed. Commands exit 78 `config-corrupt` naming the field (`exec`: 125 `config-corrupt`). `accshift config edit` opens accounts.json for repair (§6.2); an invalid state.json is quarantined and recreated by `doctor --fix` as below.
- **Missing files.**
  - `accounts.json` is created only by `add`, and never while an `accounts.json.corrupt-*` file, `vault.v1.bin` or any `homes/<cli>/<id>` directory exists. In that case commands exit 78 `config-corrupt` with the hint to restore the registry: `accshift config edit` opens the newest `accounts.json.corrupt-*` copy and, once it validates, writes it back as accounts.json.
  - A missing `state.json` reads as empty, and the first writer creates it, unless a `state.json.corrupt-*` file exists. Then commands exit 78 `config-corrupt`, and only `doctor --fix` may recreate it, because state.json holds sticky facts and a user decision (`relogin`, `notice`). `doctor --fix` shows Appendix F again and records `notice` on `y`; without `y` it recreates the file with `notice` unset.
- **Exceptions.** In every case above, `version` still works, and `doctor` without `--fix` reports the problem as a finding and exits 0 (§9.6). For a damaged or missing file, `config edit` and `doctor --fix` are the repair paths: they read the damaged file as text and do not exit 78 `config-corrupt` because of it (`doctor --fix` still exits 73, 74 or 78 when a repair fails, §10.2).
- While a `vault.v1.bin.corrupt-*` file exists, accshift refuses to create a new vault unless `--force-new-vault` is given (§7.3). The vault itself is never quarantined automatically: a failed tag leaves it untouched (§7.2).

---
## 7. Secret storage (the vault)

### 7.1 What accshift stores and where

**The vault holds only secrets accshift owns:**
- Claude setup-tokens (about 100 B; Claude Code itself never saves them to disk, so accshift holds the only copy [R04 C4]);
- Copilot PATs;
- Codex access tokens and API keys;
- **parked agy snapshots**: the token JSON of each agy account while it is *out* of agy's slot (size unmeasured; R05 C7 expects it to exceed 2560 B, **VERIFY V-A4**);
- **agy recovery copies** under reserved ids (§7.2): slot content whose owner is not a registered account, and the per-swap backup of the outgoing slot content.

**It never holds:**
- vendor-owned refreshable credentials: Codex overlay-home files, or the live agy slot (one credential, one owner [R09 §1.6]);
- any per-account secret in an OS store. The OS store holds exactly **one 32-byte key per vault**, in an item named after that vault's key id (§7.3).

**Account metadata lives outside the vault**, in `accounts.json` / `state.json`: ids, names, kinds, labels, limits and expiry dates. Secret fingerprints live in the vault entries (Appendix D.3).
- `list`, `pick`, `next`, `mark`, `status`, `classify`, `enable`, `disable`, `order`, `rename`, `config`, `notice`, `vault status`, `env` without `--reveal-secrets`, and the non-secret `doctor` checks therefore **never open the keystore**.
- Only commands that need a secret value fetch the key, and at most once per process: `exec` for token kinds and agy, `env --reveal-secrets`, `add`, `login`, `remove`, `agy use`, `doctor --fix` (only when it recovers an agy journal, §9.6), `vault migrate`, `vault export`, `vault import`.
- `rename` never touches the vault: entries are keyed by the account's immutable id, not its name (§7.2).

**Secrets in memory.** Vault plaintext and secret values are handled as `[]byte`, never decoded into Go `string`s, so they can be zeroed.
- Before launching a CLI, accshift extracts only the entry the run needs and zeroes the rest of the plaintext.
- On the spawn path (§12.3), the long-lived accshift process keeps only the 32-byte data key (zeroed on exit) for the post-run agy save-back. It re-reads the vault file under `vault.lock` at that point instead of keeping the plaintext for the whole run.
- A post-run save-back that fails (the key is gone, `vault.lock` timed out, `vault-changed`) never changes `exec`'s exit status. It leaves the slot untouched, sets `state.agySlot.saveBackPending` (§6.3) and `postRunError` in the status file, and records an event; the next exclusive slot holder performs the save-back first (§8.3.3).

### 7.2 Format

`vault.v1.bin` = `header ‖ XChaCha20-Poly1305(dataKey, bodyNonce, plaintext, aad = header)`.
- **Header:** magic `ACSV`, format version 1, key-source id, a 16-byte key id, the absolute key-file path when the source is `key-file`, a 24-byte random body nonce (new on every write), and the wrapped data key.
- **Data key:** a random 32-byte key, wrapped by the **source key** (§7.3):
  - wrapped data key = `wrapNonce ‖ XChaCha20-Poly1305(sourceKey, wrapNonce, dataKey, aad = magic ‖ version ‖ keySourceId ‖ keyId)`, 72 bytes in total;
  - `wrapNonce` is 24 random bytes, new on every rewrap, and independent of the body nonce.
  - Rekeying or migrating key sources then rewraps 32 bytes instead of re-encrypting everything, and recovery wraps could be added later without a format change.
- **Plaintext:** JSON (Appendix D.3). Secret values are stored as opaque base64 bytes and never re-serialized. The decrypted size is capped at 1 MiB.
- **Entry ids (`secretId`).** An account's entry is `<cli>/<id>`, where `<id>` is the account's immutable 8-hex id (§6.2), for example `claude/3f9a01c2` or `agy/7c41d09e`.
  - The account name never appears in an entry id, so `rename` never rewrites the vault, and a removed and re-added name never meets an old entry.
  - `remove` deletes the account's entries in its transaction (§10.2).
- **Reserved agy ids.** Only the agy slot code writes them (§8.3.3, §8.3.4, §13.3); no account can have these ids, because `_` is not a hex digit:
  - `agy/_unregistered/<email>`: slot content for an email that no agy account has (save-back, the `add agy` / `login agy` capture, `remove agy --sign-out-slot`);
  - `agy/_unknown/<sha256-8>`: slot content whose owner cannot be identified (no `email` field and no decodable `id_token` email). `<sha256-8>` is the first 8 lowercase hex characters of the SHA-256 of the raw bytes;
  - `agy/_unparsed/<store>-<epoch>`: the raw bytes of a slot that still does not parse after a re-read;
  - `agy/_swap/<startedAt>`: the per-swap backup of the outgoing slot content, written in the save-back step before the journal, and named by the journal's `backupSecretId`. No other operation overwrites it. Recovery rolls back from it (§13.3).
  - There is no `agy/_last`. Nothing is ever restored from a shared "last" copy, whose content would depend on which operation wrote it last.
  - Reserved entries count toward the 1 MiB cap. Every swap adds an `agy/_swap/*` entry, so they are pruned: once a holder of the exclusive slot lock has finished its recovery step (§13.3), no journal names an earlier backup, and its first vault write deletes every `agy/_swap/*` entry written by an earlier operation. Its own new backup is never pruned while its journal exists. The other reserved entries are kept; `doctor` lists them with their size and `updatedAt`.
- **Integrity:** a failed tag is a hard error (exit 78, `vault-corrupt`; `exec`: 125 `vault-corrupt`) that leaves the file untouched and points to `vault import` of an export.
- **Concurrency:** writes are atomic (§13.2) under **`locks/vault.lock`** (separate from `state.lock`, so a slow keystore call never blocks state updates). A writer that cannot take `vault.lock` within 15 s exits 73 `vault-busy` (`exec`: 125 `vault-busy`, §13.1).
  - Every vault write MUST, under `vault.lock`, re-read the current file and compare its key id and wrapped data key with the ones this process unwrapped.
  - If they differ (for example a `vault migrate` ran while a long `exec agy` was in progress), accshift unwraps again from the current header, or aborts with exit 74 `vault-changed` (`exec` before launch: 125 `vault-changed`; after launch it is a post-run failure, §7.1).
  - The new body is always written with the **current** header's wrapped key, never with one cached from earlier in the process.

Why an envelope rather than one OS item per secret (DECISIONS D7):
- it avoids the Windows 2560-byte and macOS `security -i` 4096-byte limits, which agy snapshots can exceed [R07 C6, R03 C6];
- it needs only one bounded keystore call per process;
- it works the same way on every OS, with a prompt-free path on headless machines;
- it gives real at-rest protection for the only on-disk copy of one-year Claude tokens.

### 7.3 Key sources (v1)

`<kid>` below is the lowercase hex of the vault's 16-byte key id. Every item and file is named per vault, so a second vault (another `ACCSHIFT_HOME`, a test run, a second LimitShift profile) can never overwrite the key of the first.

| Source id | Where the 32-byte source key lives | Default when |
|---|---|---|
| `keychain` | macOS login keychain, generic password service `accshift`, account `vault-key-v1-<kid>`, via `/usr/bin/security` (§7.4) | **macOS**, except when the vault is created over SSH (see Rules) |
| `secret-service` | Secret Service item `{service:"accshift", username:"vault-key-v1-<kid>"}` in the `login` collection, else the collection behind the `default` alias. The target collection MUST be persistent: the alias must not resolve to `/org/freedesktop/secrets/collection/session` (which lives in memory only) or to `/` | **Linux**, only if **all** hold at vault creation: the bus is reachable through `DBUS_SESSION_BUS_ADDRESS` or `$XDG_RUNTIME_DIR/bus` without autolaunch; none of agy's bypass conditions apply (SSH vars, WSL, container); a persistent collection exists and is **already unlocked** without accshift calling `Unlock` |
| `dpapi` | `<root>\vault.key.dpapi` = `CryptProtectData(key, CurrentUser, CRYPTPROTECT_UI_FORBIDDEN)` (never `LOCAL_MACHINE`). The DPAPI blob is useless without the user's Windows profile, so it may sit next to the vault | **Windows**, except when the vault is created over SSH (see Rules) |
| `key-file` | a 0600 file (an owner-only DACL on Windows), **in a different directory from the vault** so that copying the data directory never carries both: `${XDG_CONFIG_HOME:-~/.config}/accshift/vault-<kid>.key` on Linux/WSL and macOS, `%USERPROFILE%\.accshift\vault-<kid>.key` on Windows. `ACCSHIFT_KEY_FILE` names an exact path instead (containers, CI secret mounts). The absolute path used at creation is recorded in the header | **everything else**: Linux headless, SSH, WSL, containers, CI |

- A `passphrase` source (Argon2id t=3, m=64 MiB, p=4, optionally cached in the Linux kernel keyring) MAY come in v1.x. It is never a default and is not part of v1.
- There is **no plaintext-vault mode**.

**Creating a vault.** Creation runs entirely under `vault.lock`:
1. Re-check that no vault exists. If `<root>/vault.v1.bin.corrupt-*` exists, refuse with exit 78 `vault-corrupt-present` unless `--force-new-vault` is given, so a damaged vault is never silently replaced.
2. Generate the key id and the source key.
3. Store the source key with **create-only** semantics:
   - macOS: `add-generic-password` **without `-U`**; exit 45 (duplicate) is fatal: exit 78 `key-item-exists`;
   - Secret Service: `SearchItems` must miss, then `CreateItem(replace=false)`; afterwards read the item back through a fresh connection and compare;
   - key-file: `open(O_CREAT|O_EXCL|O_WRONLY, 0600)`, fsync, and fsync the directory;
   - DPAPI: the same exclusive create for `vault.key.dpapi`.
4. Only then write the vault file.

Two concurrent first `add`s therefore produce one vault; the second waits on `vault.lock` and then finds it.

**Rules:**
- The source is chosen once, at vault creation: the OS default above, or `--key-source` / `ACCSHIFT_KEY_SOURCE`. It is recorded in the header.
- On macOS and Windows, if `SSH_CONNECTION`, `SSH_TTY` or `SSH_CLIENT` is set at vault creation, accshift asks for `--key-source` interactively. Non-interactively it uses `key-file` and prints one `accshift:` notice.
- accshift **never switches sources silently** and **never generates a new key** when the recorded one is missing, locked or unreachable. It never overwrites a vault it cannot decrypt. It fails instead: exit 74 `keystore-unavailable` for control verbs, exit 125 `keystore-unavailable` for `exec`.
  - The hint names the unlock command or `accshift vault migrate --to key-file`.
  - When no vault exists yet, the hint is `--key-source key-file` / `ACCSHIFT_KEY_SOURCE=key-file` instead.
- After the vault exists, the key file is read from the path recorded in the header. A later run that sets a different `ACCSHIFT_KEY_FILE`, or none, still uses the recorded path, and a missing file fails with a message that names it.
- `vault migrate --to <source>`:
  - holds `vault.lock` from reading through rewrap, header swap and old-key deletion;
  - fsyncs the new vault file before deleting anything;
  - deletes **only** the item or file whose name carries this vault's key id, never a bare `vault-key-v1` item or another vault's item.
  - It is in v1.
- `vault export --to FILE` / `vault import FILE` (v1, SHOULD) write and read a passphrase-encrypted bundle (Argon2id + XChaCha20-Poly1305), for moving machines and as a backup against losing the key. A wrong passphrase or a damaged bundle makes `vault import` exit 65 `invalid-bundle` and change nothing.
- `vault status` reads only the vault header: whether a vault exists, its key source, key id and recorded key-file path. It never opens the keystore and is read-only (§6.3). `vault status --json` is a contract command (§11.2); `vault migrate`, `vault export` and `vault import` are not.
- **Key-file checks**, at every key read and not only in `doctor`:
  - the key file and its directory MUST be owned by the current uid (or, for an `ACCSHIFT_KEY_FILE` mount, by root) and MUST NOT be writable by group or others;
  - a key file at the default path MUST also not be readable by group or others;
  - otherwise exit 74 `keystore-unavailable` with the fix (`exec`: 125 `keystore-unavailable`; the status file's `error.reason` is `key-file-permissions`, Appendix D.4). Secret mounts must use mode 0400 and an owner that matches the runtime uid; Docker `/run/secrets` and Kubernetes `..data` symlinks are followed only for `ACCSHIFT_KEY_FILE`.
  - These checks never `chmod` the key file: a key outside the root is the user's to fix.
- `doctor` describes `key-file` as "at-rest protection equal to the vendor CLIs' own plaintext credential files".
- **Linux implementation:** accshift's own godbus client with an explicit `Connect(address)`. Never `SessionBus()`, never spawn `dbus-launch`, check `Locked` before any read, never `Unlock` or `Prompt`, and bound every call. Never shell out to `secret-tool`. `zalando/go-keyring` is not used at runtime, neither for accshift's own key nor for agy's slot: its prompt wait has no timeout [R07 C5], and on macOS it passes no explicit keychain and no `-T` and cannot kill a timed-out `security` child (§7.4). It may appear only in tests, as a byte-compatibility fixture (§19.2).

### 7.4 macOS `security` rules (own key and agy slot)

- Always invoke the absolute path `/usr/bin/security`.
- **Explicit keychain.** Every `security` invocation, including each `-i` line, ends with an explicit keychain path supplied by one function.
  - In production this is the user's default keychain, resolved once per process with `security default-keychain -d user` (the keychain agy also writes to).
  - In tests it is the path from `ACCSHIFT_TEST_KEYCHAIN`, which exists only in `accshift_test` builds (§18.3).
- **Writes:**
  - send the command as one line to `security -i` on stdin, so the secret never appears in argv;
  - accshift's own key: `add-generic-password -s accshift -a vault-key-v1-<kid> -T /usr/bin/security -w <base64(key)> <keychain>`, **without `-U`** (create-only, §7.3);
  - agy's slot: `add-generic-password -U -s gemini -a antigravity -T /usr/bin/security -w go-keyring-base64:<base64(blob)> <keychain>`, exactly the value agy's library writes [R07 §1]. `-U` is used here because the slot is a vendor item that a swap must replace;
  - before writing, compute the line length. If it would exceed 4096 bytes: for accshift's own key, fail with exit 74 `keychain-line-too-long`; for agy's slot, apply the §8.3.2 rule for a slot that cannot take the blob. Never fall back to argv.
- `-T /usr/bin/security` is passed explicitly. Writing with `-U` and no `-T` means "trust only the writing process" [R09 C4]; the writer is `/usr/bin/security` anyway, so this is harmless and explicit. accshift adds **neither its own binary path nor any vendor binary path**: those paths change on every update, which would bring back prompts [D6, D7].
- **Never** use `-A`, `-T ""`, or `set-generic-password-partition-list`. Items written by `/usr/bin/security` keep trusting `/usr/bin/security`, which is how agy and Claude Code read them. This avoids the prompt loops and partition-list lockouts seen in prior art [R07 C3, R09 §1.4]. **VERIFY V-A5** for agy and V-K1 for the own key.
- **Reads:** `find-generic-password -s <svc> -wa <acct> <keychain>`. Strip the `go-keyring-base64:` (or hex `go-keyring-encoded:`) prefix for agy items.
- **Exit-status mapping:**

  | `security` exit | Meaning | accshift result |
  |---|---|---|
  | 44 | not found | not found |
  | 36 | interaction not allowed / locked | keystore-unavailable (agy: `agy-keyring-locked`, §8.3.2), with the hint `security unlock-keychain ~/Library/Keychains/login.keychain-db` |
  | 37 / 50 | no default keychain, no such keychain | keystore-unavailable (agy: an in-scope keychain that exits 37 or 50 is `agy-keyring-locked`, fail closed; it is never evidence of file mode, §8.3.2) |
  | 51 | auth failed | keystore-unavailable |
  | 45 | duplicate item | own key: fatal `key-item-exists`; agy slot: cannot happen with `-U` |

  [R07 §3]
- Every call has a 10 s timeout (3 s for a probe; `settings.keystoreOpSeconds` and `settings.keystoreProbeSeconds`, §6.2). A call on agy's slot is cut off after 4 s instead (§7.5). On timeout accshift kills the `security` child and reports keystore-unavailable (agy slot: `agy-keyring-locked`), **never** "not found". accshift never asks for or stores the login password in non-interactive mode.
- **Prompt-free lock probe (V-K3).** Once V-K3 confirms a probe that never raises UI (candidate: the exit status of `security show-keychain-info <keychain>`), non-interactive runs call it before any read and treat "locked" as keystore-unavailable without calling `find-generic-password`.

### 7.5 Non-interactive guarantees

**When non-interactive.** accshift is non-interactive when stdin is not a TTY, when `--non-interactive` is given, or when `ACCSHIFT_NONINTERACTIVE=1`.
- LimitShift MUST export `ACCSHIFT_NONINTERACTIVE=1` for every accshift invocation (§15.3). A TTY check alone is not enough: a process started in a hidden Windows console (LimitShift's agy launch path, §12.4) has a console handle as stdin, which Go's terminal check reports as a TTY, and a control verb started from a queue inherits the user's terminal.
- `exec` never prompts, whatever stdin is. `run` never prompts during pre-launch credential handling; it MAY ask its §16 post-exit question ("switch and resume?") only when stdin is a TTY and `ACCSHIFT_NONINTERACTIVE` is not `1`. Any other condition that would need input takes the non-interactive branch; for example an unregistered agy login in the slot gives 125 `agy-slot-unregistered` (§8.3.3). Other prompts exist only in control verbs that people run by hand, such as `add`, `login`, `remove`, `notice` and `vault export`.

**What it then never does:**
- call an API whose purpose is to prompt: Secret Service `Unlock` or `Prompt`, `security unlock-keychain`, or a credential UI;
- read from a terminal.

**What it cannot fully prevent.** On macOS, when the login keychain is locked in a GUI session, `/usr/bin/security` can make SecurityAgent show an unlock dialog, and `security` has no flag that forbids UI. Providers that confirm access themselves (KeePassXC) behave the same way on Linux. accshift bounds such a dialog with the 3 s probe timeout and kills `security`. V-K1 records whether the dialog stays on screen; the V-K3 probe removes the case once verified.

**Time bounds.** Every keystore call is bounded.
- For the vault key: probe 3 s, operation 10 s (`settings.keystoreProbeSeconds`, `settings.keystoreOpSeconds`), so at most 15 s per process, because the key is fetched at most once (§7.1).
- For agy's slot: any keychain, Secret Service or Credential Manager call that takes longer than **4 s** counts as uncertain, and accshift fails closed (§8.3.2). The reason: go-keyring's own prompt wait is unbounded [R07 C5], but agy bounds its keyring operations at about 5 s; after a timeout it writes its keyring-unavailable marker and uses its token file for an hour [R05 §a]. A keyring that answers accshift in 6 s could therefore make agy run from a file slot accshift did not write for this account. The 4 s bound is fixed and kept with agy's timeout in agy `facts.go`; `keystoreOpSeconds` does not raise it.
- Failures end in exit 74 `keystore-unavailable` (control verbs) or 125 `keystore-unavailable` (`exec`); for agy's slot, `agy-keyring-locked` (74 or 125, §8.3.2).

**What LimitShift does about it:**
- runs `accshift doctor --json` at queue start, while the user is still present, and warns when the key source is not safe for unattended use (§15.7);
- if `exec` reports 125 `keystore-unavailable` or `agy-keyring-locked`, it follows §15.2:
  - under the legacy rule (the runner has no `accounts` key under `accountRotation:"auto"`, and the CLI is not agy while accshift has at least one agy account registered), it launches that run unwrapped (the CLI's own login, no rotation) and uses accshift again for the next run; a runner never stays in legacy mode for the rest of the queue;
  - otherwise it marks the task needs-human with the `error.code` (with fallbacks: it sets the runner aside for this task);
  - either way it logs why and never aborts the queue.

### 7.6 Threat model statement (for SECURITY.md and the README)

**What the vault protects**, by key source:
- `keychain`, `secret-service`, `dpapi`: accshift's stored secrets against disclosure of copies of its files (backups, sync tools, dotfile repositories, support bundles) and against other OS users.
- `key-file`: only against a copy of accshift's data directory on its own. A backup or sync of the whole home directory contains both the key and the vault.

**What it does not protect against.** Software running as the same OS user. Such software can read the source key: any same-user process on Linux and Windows [R07 C4], or any process that runs `/usr/bin/security` on macOS. It can also read the environment of a running CLI. The vendor CLIs' own credential files have the same exposure.

**Aggregate exposure (the agents themselves).** The agents accshift launches run as the same OS user, usually unattended and with permission-bypass flags, and they process untrusted content. They can therefore read every secret accshift stores, for every account and every CLI, not only the account of the current run. One compromised or prompt-injected task can exfiltrate all registered accounts. Per account, accshift is no weaker than the vendor's own storage; in aggregate it is weaker. This sentence also appears in the README and the first-run notice (Appendix F).

**Injected tokens reach the agent's subprocesses.** A token placed in the CLI's environment (`CLAUDE_CODE_OAUTH_TOKEN`, `COPILOT_GITHUB_TOKEN`, `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`) is inherited by the agent's shell tools, hooks, MCP servers, test suites and install scripts, unless the vendor removes it. A routine `env` in a task can write it into LimitShift's captured output.
- V-C5, V-X4 and V-P2 (§22) record, per CLI, whether the vendor strips its auth variable from tool subprocesses and whether a switch exists. The result goes in `facts.go`.
- A switch that is an environment variable goes into that kind's set list (§12.5).
- **The one added argument.** `exec` never adds arguments to the caller's command, with exactly one exception: for secret-bearing kinds it MAY prepend the vendor's secret-isolation argument listed in `facts.go`, when the caller's argv does not already contain it. Today that is only copilot's `--secret-env-vars=COPILOT_GITHUB_TOKEN`, which keeps the token out of the agent's shell and MCP children [R06 §2.8]. `exec` reports it in the status file's `addedArgs`, which LimitShift logs after each run (§15.5); LimitShift's dry-run shows only the wrapped command, not the added argument. V-P2 verifies that the flag removes the token from those subprocesses in current Copilot releases, and whether it is still needed.
- A switch that needs any other argument or a config change is never applied by `exec`. Codex's `shell_environment_policy` would need `-c`, so for codex the README documents it as a setting in the user's own `config.toml` (V-X4).
- The README recommends fine-grained PATs over the `gh` kind for copilot, and LimitShift passes captured outputs through the same redaction patterns before writing them (§14.4, §15.5).

**Losing the key.** If the keychain is reset, the DPAPI master key is lost, or the Secret Service collection is deleted, the vault becomes unreadable. The fix is `vault import` of an export, or re-adding the accounts through the vendors' own flows.

---
## 8. CLI adapters

Every adapter implements the same interface (Go sketch):

```go
type Adapter interface {
    CLI() string                                   // "claude", ...
    Kinds() []Kind                                 // supported account kinds, default first
    Add(ctx, req AddRequest) (Account, error)      // guided login / import; never performs OAuth itself
    Login(ctx, acct Account, req LoginRequest) (Account, error) // re-authenticate in place; identity check (Login rules below)
    Prepare(ctx, acct Account, args []string) (RunPlan, error)  // env, binary, pre-run hooks, locks
    AfterRun(ctx, acct Account, plan RunPlan, exit int) error   // post-run hooks (save-back, copy-back); spawn path only
    Doctor(ctx, acct *Account) []Finding
    Classify(in ClassifyInput) Classification      // pure: evidence -> class, scope, reset, tier (§9.4)
    Portability(from, to Account) Portability      // yes | likely | possible | unlikely | no
}
```

`RunPlan` holds:
- the resolved binary;
- the caller's args, never modified. The one exception is the secret-isolation argument of §7.6 that `exec` MAY prepend; the plan lists it as `addedArgs`, and the status file reports it;
- the env delta (variables to set and to unset);
- whether execve is allowed (no post-run hook and no lock to hold);
- the locks to hold;
- the post-run hooks. A hook failure never changes the returned exit status: it sets the status file's `postRunError` and logs an event (§12.1.1).

**Portability.** `Portability(from, to)` returns one of five values for one move between two accounts of the cli:
- `sessionPortable` (§3, §11.2) is true for `yes` and `likely`, and false for `possible`, `unlikely` and `no`. For false, LimitShift starts a new session with the handoff note instead of resuming.
- `from` equal to `to` (no switch, for example exit 75 naming `--from`) is always `yes`.
- The adapter decides from the two accounts' recorded kinds and identities only. accshift keeps no record of which account created a session, so no adapter has a "returning to the session's creator" case.

**Rules for all adapters** [R09 §1.6, D4, D5]:
- **Never** run vendor logout commands (`codex logout`, `claude auth logout`, `/logout`); they revoke credentials.
- **Never** copy `auth.json`, `.credentials.json`, or Keychain / Credential Manager items between places.
- **Never** perform OAuth or call provider endpoints.
- **Never** add arguments to the caller's command, with exactly one exception: `exec` MAY prepend the vendor's secret-isolation argument listed in `facts.go` (today only copilot's `--secret-env-vars=COPILOT_GITHUB_TOKEN`) when the caller's argv does not already contain it, and reports it in the status file's `addedArgs` (§7.6). A switch that needs any other argument, such as codex `-c`, is never applied by `exec`. `run` has its own documented exception for codex `--no-daemon` (§8.2, §16).
- The user's existing default login of each cli is registered, if the user wants it, as a **`native`** account. That is typically account #0, named `main`, at pool position 0.
  - accshift never reads, copies, moves or rewrites a native credential. Detecting that one exists (`add --native`) uses file existence or keystore attributes only.
  - `remove` on a native account only unregisters it.
  - agy has no `native` kind, because its single slot is swapped; §8.3.3 says how the user's own unregistered agy login is protected.
- **Secrets are never flag values.** Every secret-bearing kind (claude `token`, codex `access-token` / `api-key`, copilot `token`) reads its secret only from a no-echo TTY prompt or from one line on stdin with `--token-stdin`.
- **Overlay-owned vendor keyring items.** When a codex `home` overlay or a claude `login-slot` directory has made the vendor store its credential in the OS keyring under a key derived from that directory's own path, the item is single-owned by the overlay. `remove` deletes it (this is not a logout: no vendor command runs and nothing outside the overlay changes). accshift never touches items derived from `mainHome` or the default config dir. If the delete fails, `remove` prints the exact item name for manual removal.
- **Provider notice at every `add`.** Every `add` (every cli and kind, including `--native` and `--capture-current`) shows the Appendix F notice when state.json `notice` is unset or its `version` is older than this binary's notice version. It requires `y` at the prompt, or `--accept-notice` (the only way without a TTY), before any vendor login runs or anything is stored. On acceptance it writes `notice = {acceptedAt, version}` (§6.3). If the notice is not accepted, nothing is registered and `add` exits 65 `notice-not-accepted`. Until `notice` is current, `pick` and `next` exit 69 `notice-not-accepted` with the hint `accshift notice --accept` (§9.3). `accshift notice --accept` (§10.2) accepts a new notice version without an `add`, for a user whose accounts are all registered.

**Login rules** (`accshift login <cli> <name> [--label L] [--new-identity]`, every adapter):
- `login` re-authenticates an account in place. Its `id`, overlay or slot directory, vault `secretId`, name and pool position stay the same. Like `add`, it runs only the vendor's own login flow attached to the TTY, or reads a new secret for a secret-bearing kind, and never performs OAuth itself.
- It compares the new credential's offline identity with the recorded one:
  - codex file store: (`chatgptAccountId`, `chatgptUserId`) decoded from the `id_token` (§8.2);
  - claude `login-slot`: `oauthAccount.emailAddress` read right after the login (§8.1);
  - agy: the slot's email (§8.3.4);
  - where the identity is user-asserted (claude `token`; codex `home` in keyring or auto store, `access-token` and `api-key`; any kind another adapter marks so): `--label` is required and MUST equal the account's current label.
- On a mismatch, accshift restores the previous credential where the adapter still has it, or deletes or parks the new one (each adapter says which), and exits 65 `identity-mismatch`. `--new-identity` accepts the new identity instead: it runs the add-time dedupe, updates the identity fields, and clears all records, `authStrikes`, `lastStrikeAt`, `backoff`, `attentionCode` and `relogin` (§9.2).
- A same-identity login clears `relogin`, `authStrikes` and auth-suspect records. It keeps limit records, `backoff`, `attentionCode` and `lastStrikeAt`, because a fresh login does not reset a usage window (§9.2).
- `login` on a `native` account exits 64 `native-account` with the vendor's own login command as the hint (claude `claude auth login`, codex `codex login`). accshift never touches a native credential.
- A native account can change identity outside accshift, through the user's own vendor login. Where accshift can read the native identity offline without reading the credential, `doctor` compares it with the recorded one and warns on a change; `doctor --fix` or `mark --clear` clears that account's records (§9.2). Each adapter says what it can compare.

### 8.1 claude (Claude Code), tier 1

**Facts (verified against 2.1.293)** [R04 §1]:
- **Credentials** [R04 §1a, C1–C3]. `<dir>`, the service and the account come from the slot derivation below:
  - Linux: `<dir>/.credentials.json` (0600, plaintext) only. Claude never uses libsecret;
  - macOS: the Keychain through `/usr/bin/security`. If a Keychain write fails, Claude falls back to plaintext `<dir>/.credentials.json` [R04 C2];
  - Windows: `<dir>\.credentials.json`, unless Credential Manager is switched on by `CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1` or by `cachedGrowthBookFeatures.tengu_windows_credman === true` in `.claude.json`. Then Claude uses the Credential Manager entry it writes through Bun.secrets for the derived service and the constant user `claude-code-user`, with the plaintext file as fallback [R04 C3]. The exact target name of that entry is kept in claude `facts.go`.
- **Credential slot derivation.** This is Claude's own code [R04 §1a], kept in claude `facts.go`. `ss` is `CLAUDE_SECURESTORAGE_CONFIG_DIR` and `cd` is `CLAUDE_CONFIG_DIR`; "set" distinguishes an unset variable from a set-but-empty one. `~` is the home directory as Node resolves it: `$HOME` on POSIX, `%USERPROFILE%` on Windows.
  - `<dir>`: `ss` if set (an empty `ss` means `~/.claude`); otherwise `cd` if set and non-empty; otherwise `~/.claude`.
  - No hash suffix when `ss` is set and empty, or when `ss` is unset and `cd` is unset or empty.
  - Otherwise the suffix is `-` plus the first 8 hex digits of sha256 of the hashed string: `NFC(ss)` when `ss` is set, else `NFC(cd)`. The raw string is hashed: no symlink resolution, no `~` expansion, no trailing-slash trimming, no path cleaning.
  - Service = `Claude Code` + `OAUTH_FILE_SUFFIX` + `-credentials` + suffix. `OAUTH_FILE_SUFFIX` is empty in release builds and becomes `-custom-oauth` when `CLAUDE_CODE_CUSTOM_OAUTH_URL` is set. accshift unsets that variable for every run (Appendix A.1), so it always derives with the empty suffix.
  - macOS Keychain account: `$USER` if set and non-empty; else the user name of the current uid (`os/user.Current()`, which on macOS calls `getpwuid_r` through libSystem without cgo; accshift is never built with the `osusergo` tag). If neither yields a name, or the name fails `^[a-zA-Z0-9._-]+$`, the account is `claude-code-user`. Windows always uses `claude-code-user`.
  - This is why setting `CLAUDE_CONFIG_DIR`, even to the default path, selects another Keychain entry [#92252], and why a set-but-empty `CLAUDE_SECURESTORAGE_CONFIG_DIR` pins the default one.
  - With `cd` set but empty (and `ss` unset), Claude resolves `<dir>` relative to its working directory. accshift does not support that state: `add --native` refuses it with exit 78 `unsupported-config` and the hint to unset `CLAUDE_CONFIG_DIR`.
- **`claude setup-token`:** mints a 1-year, inference-only OAuth token (`sk-ant-oat…`). It has no refresh token, and Claude never saves it to disk.
- **`CLAUDE_CODE_OAUTH_TOKEN`:**
  - works for `-p`, `json`/`stream-json`, interactive mode and `--resume`;
  - is ignored in `--bare` mode;
  - is outranked by `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper` and the `CLAUDE_CODE_USE_*` providers;
  - on a 401, Claude keeps the env token and never silently adopts the stored login, so a wrong-account run on the main subscription cannot happen silently.
- **Transcripts:** `<configDir>/projects/<slug(cwd)>/<sessionId>.jsonl`, where `<configDir>` is `CLAUDE_CONFIG_DIR` or `~/.claude`. They carry no account binding [R04 §1d].
  - `slug(cwd)` replaces every UTF-16 code unit outside `[A-Za-z0-9]` with `-`, so a character outside the BMP becomes `--`. A slug longer than 200 characters is truncated and gets a `-<base36 hash>` suffix whose algorithm is unverified. For such paths accshift finds the transcript by globbing `projects/*/<sessionId>.jsonl` (Appendix B).
- **Shared config:** an env token never rewrites `oauthAccount` in the shared `.claude.json` [R04 C8].

**Kinds:**

| Kind | Selection for a run | History | Concurrency | Notes |
|---|---|---|---|---|
| `token` (default) | set `CLAUDE_CODE_OAUTH_TOKEN=<token from vault>` | shared (`~/.claude` or the user's own `CLAUDE_CONFIG_DIR`) | unlimited; no file is touched | inference-only: no `/usage` plan percentages, Remote Control or claude.ai connectors [R04 C5]. `usageProbe:false` |
| `native` (account #0) | unset `CLAUDE_CODE_OAUTH_TOKEN`; the stored `/login` credential is used. `CLAUDE_SECURESTORAGE_CONFIG_DIR` passes through **exactly as the user had it at `add --native`**, including a set-but-empty value (the #92252 workaround). It is removed only if it points into accshift's `homes/` | shared | unlimited | full scopes; `usageProbe:true` (LimitShift still never probes a managed runner, §15.6) |
| `login-slot` (experimental, needs `--experimental`) | `CLAUDE_SECURESTORAGE_CONFIG_DIR=<root>/homes/claude/<id>` (the immutable directory id, §6.2): an absolute NFC path, no trailing slash, the same string every time | shared | unlimited | undocumented. The shared `oauthAccount` shows the last login, so `/status` may name the wrong account [R04 C7, #79222]. `doctor` warns about skills-sync churn (#98526) and suggests users pass `--settings '{"syncClaudeAiSkills":false}'` themselves. `usageProbe:false`: short-lived probes can spend its refresh token [R09 C3] |

Per-account `CLAUDE_CONFIG_DIR` (documented by Anthropic) is **not built in v1**. It is the contingency if `CLAUDE_SECURESTORAGE_CONFIG_DIR` disappears, and would reuse the codex overlay engine with an allowlist (D4).

**Environment for every claude run** (Appendix A.1):
- Unset:
  - `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`;
  - `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`;
  - `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, `CCR_OAUTH_TOKEN_FILE`;
  - `CLAUDE_CODE_SIMPLE`, `CLAUDE_CODE_RETRY_WATCHDOG`;
  - `ANTHROPIC_UNIX_SOCKET`, `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`;
  - `CLAUDE_CODE_OAUTH_SCOPES` (would give an env token false scopes);
  - `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`;
  - `CLAUDE_CODE_CUSTOM_OAUTH_URL` (changes OAuth endpoints and the Keychain suffix);
  - `CLAUDE_CODE_SUBSCRIPTION_TYPE`, `CLAUDE_CODE_RATE_LIMIT_TIER`;
  - SHOULD also unset `ANTHROPIC_ORGANIZATION_ID`.
- Unsetting `CLAUDE_CODE_RETRY_WATCHDOG` is essential: with it set, Claude silently waits out the limit [R04 C6].
- Then set the kind's variable from the table above. accshift does not set `CLAUDE_CODE_SUBSCRIPTION_TYPE` (its effect is unverified).
- accshift MUST NOT set or change `CLAUDE_CONFIG_DIR` or `HOME`. Explicitly setting `CLAUDE_CONFIG_DIR`, even to the default path, selects a different Keychain entry and logs the user out silently [R09 §1.4, #92252].
- `--bare` in the caller's args with a `token` account → exit 125 (`bare-ignores-token`), unless `--allow-bare`.
- **Settings that override the environment.** Claude Code's settings can define `apiKeyHelper` and an `env` block that is applied to every session, so they can re-introduce variables accshift removed. Before every claude run, `exec` scans, offline and cached by mtime:
  - the user layer (`~/.claude/settings.json`, or the one under the user's own `CLAUDE_CONFIG_DIR`);
  - the project layers of exec's working directory and of its git root (`.claude/settings.json`, `.claude/settings.local.json`);
  - the managed layer, at the per-OS paths kept in claude `facts.go` and Appendix B (macOS `/Library/Application Support/ClaudeCode/managed-settings.json`, Linux/WSL `/etc/claude-code/managed-settings.json`, Windows `C:\Program Files\ClaudeCode\managed-settings.json`; **VERIFY V-C4**);
  - any `--settings <json|file>` value in the caller's args, read only (the args are never modified).
  
  If any layer defines `apiKeyHelper`, `exec` exits 125 `apikeyhelper-overrides-token` unless `--allow-apikeyhelper`. If any layer's `env` sets a variable from the A.1 always-unset list, or `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR` or `ANTHROPIC_BASE_URL`, `exec` exits 125 `settings-env-overrides-token` unless `--allow-settings-env`. V-C4 confirms that settings `env` wins over the process environment in the installed version.
- **Base URL.** For `token` and `login-slot` runs, if `ANTHROPIC_BASE_URL` is set in the child environment or in any settings `env` layer and its host is not `api.anthropic.com`, `exec` exits 125 `base-url-would-receive-token` unless `--allow-base-url`: the token would be sent to that host.
- **Credential presence** (exec's `relogin(missing)` check, §12.1): `token` → the vault entry `claude/<id>` exists; `login-slot` → `S/.credentials.json` exists, or on macOS the Keychain item derived from `S` exists (by attributes, as in the login-slot add step 3); `native` → never checked. An absent credential makes exec record `relogin(missing)` and exit 125 `needs-relogin`.

**Add flows:**

Syntax: `accshift add claude <name> [--native | --experimental --kind login-slot] [--label EMAIL] [--force] [--token-stdin] [--accept-notice]`. Without `--native` or `--kind`, the kind is `token`.

**`add claude <name>` (token):**
1. A TTY is required unless `--token-stdin`. With `--token-stdin` the token was minted elsewhere, so steps 3 and 4 are skipped.
2. Show the provider notice when it is not yet accepted (§8 rules), requiring `y` or `--accept-notice`.
3. Tell the user to approve in a private window, or in a browser profile signed in to the intended account.
4. Run `claude setup-token` with stdin, stdout and stderr inherited: no PTY, no output scraping.
5. Read the pasted token with no echo, or one line from stdin with `--token-stdin`.
6. Validate: one line, `^sk-ant-oat[0-9A-Za-z_-]+$`, 40–512 bytes. Any other input exits 65 `invalid-token`, and nothing is stored.
7. Require `--label <email>`. Refuse a label already used by another claude account (65 `duplicate-account`) unless `--force`, because token identity cannot be checked offline.
8. Store the token in the vault under `claude/<id>`, with the account's immutable id (§6.2). Record `createdAt` and `expiresAt = createdAt + 365 d`.
9. Never make a model call, and never spawn `claude auth status`: short-lived Claude commands can spend refresh tokens [R09 C3].
10. The first time `add claude` runs in a TTY, it SHOULD offer to register the native login as `main` at position 0.
11. If `CLAUDE_CODE_OAUTH_TOKEN` is already exported in the user's shell, it SHOULD offer to import it as a token account. `doctor` notes that `exec` overrides it.

**`add claude main --native`:** show the notice (§8 rules), then detect the default login **without reading the secret**. `<dir>`, the service and the account come from the slot derivation above, applied to the environment `add` runs in [R04 §1a, C2, C3]:
- Linux: `<dir>/.credentials.json` exists.
- macOS: `/usr/bin/security find-generic-password -s <service> -a <account> <keychain>` **without** `-w`. Exit 0 means present and 44 means absent; other statuses map as in §7.4. If the item is absent, an existing `<dir>/.credentials.json` (Claude's plaintext fallback) also counts as present.
- Windows: `<dir>\.credentials.json` exists. When Credential Manager is switched on (Facts above), the Credential Manager entry for the derived service and `claude-code-user` also counts. Only its existence is used: the returned blob is zeroed unread.
- If no login is found, `add` exits 65 `no-login-detected` with the hint `claude auth login`.
- `CLAUDE_SECURESTORAGE_CONFIG_DIR` is recorded exactly as set, including set-but-empty, or as absent (kinds table above).
- If the user's environment sets `CLAUDE_CODE_CUSTOM_OAUTH_URL`, `add` warns that the user's own login lives under a `-custom-oauth` item that accshift runs do not use.
- The label comes from `oauthAccount.emailAddress` in the global config, read offline: `$CLAUDE_CONFIG_DIR/.claude.json` when `CLAUDE_CONFIG_DIR` is set and non-empty, else `$HOME/.claude.json`; a legacy `<configDir>/.config.json` wins when present [R04 §1a, §1c].

**`add claude <name> --experimental --kind login-slot`:** after the notice (§8 rules):
1. Record the default slot's state: file mtime, or the Keychain item's modification date, read by attributes only.
2. Create `S = <root>/homes/claude/<id>` (a new immutable id) and run `CLAUDE_SECURESTORAGE_CONFIG_DIR=S claude auth login --claudeai` attached to the TTY.
3. Verify that the new slot exists **and** that the default slot did not change. The new slot is `S/.credentials.json`, or on macOS the Keychain item `Claude Code-credentials-<sha256(NFC(S))[0:8]>` with the derived account, checked by attributes (or the plaintext fallback `S/.credentials.json`).
   - If either check fails, abort with exit 65 `securestorage-ignored` and warn that the default login may have been replaced.
4. Take the identity from `.claude.json` read right after login. Never spawn claude to get it.

**Login** (`accshift login claude <name> [--label EMAIL] [--new-identity] [--token-stdin]`), under the §8 Login rules:
- `token`: steps 1 and 3–6 of the token add flow, then step 9. `--label` is required and MUST equal the account's current label, because a token's identity cannot be read offline [R04 §1g].
  - On a mismatch the new token is discarded without being stored, and `login` exits 65 `identity-mismatch`.
  - On success the token replaces the vault entry `claude/<id>`, and `createdAt` and `expiresAt = createdAt + 365 d` are reset, which also ends an `expired` needs-relogin.
  - With `--new-identity`, the label may change, and step 7's uniqueness check applies.
- `login-slot`: steps 1–4 in the account's existing `S`; the Keychain key derives from `S`, so the slot cannot move. Step 1 also records `S`'s own state, and step 3 requires that `S`'s credential changed (file mtime or Keychain modification date) while the default slot did not. The identity from step 4 MUST equal the recorded label.
  - On a mismatch, accshift deletes the new credential from `S` (the file, or the Keychain item derived from `S`; no vendor command runs), records `relogin(missing)` and exits 65 `identity-mismatch`. The previous slot credential was already replaced by the vendor login and cannot be restored, so `login` warns about this before step 2.
- `native`: exit 64 `native-account` with the hint `claude auth login` (or `/login` inside Claude Code).

**Doctor:**
- token expiry: a warning from 30 days before, an error once expired;
- `apiKeyHelper`, `ANTHROPIC_PROFILE` or an overriding `env` key in any settings layer;
- `ANTHROPIC_BASE_URL` set in the user's environment (exec refuses token runs with it, see above);
- whether Claude Code strips `CLAUDE_CODE_OAUTH_TOKEN` from tool and MCP subprocesses (V-C5, §7.6);
- `.claude.json` missing `hasCompletedOnboarding` (#8938);
- `CLAUDE_CODE_RETRY_WATCHDOG` or `CLAUDE_CODE_CUSTOM_OAUTH_URL` in the user's environment;
- the native account's identity: `oauthAccount.emailAddress` (read offline, as at `add --native`) compared with the recorded label, with a warning on a change (§8 Login rules). The check is skipped once any `login-slot` account exists, because the shared `oauthAccount` then names the last slot login [R04 C7, #79222];
- the `claude` binary path and version. The version is read from package metadata where possible (the `package.json` next to an npm install). `claude --version` runs only in an interactive `doctor`, never in `doctor --json` (§9.6), because whether it starts an OAuth refresh for a logged-in account is unverified (V-C6) [R09 C3].

**Limits** (Appendix C.1):
- Structured, with a reset (tier 3): stream-json `rate_limit_event` with `status:"rejected"` → `resetsAt` and `rateLimitType`; the transcript's `rate_limit_info` carries the same fields [R04 §1d, §1e].
- Structured, without a reset: assistant `error:"rate_limit"` and the result's `is_error` with `api_error_status` 429 detect a limit but carry no reset time. The reset then comes from the text (tier 2) or, failing that, the default backoff (tier 1): the tier describes the reset value's source, not the detection (§9.4).
- Text (tier 2): the `You've hit your … · resets …` family, matched on the decoded `result` string (Appendix C.1). The reset reads `3pm` or `3:30pm` within 24 h, otherwise `Oct 9, 3pm`, with the year added when it differs, followed by ` (<IANA zone>)` [R04 §1e].
- Scope mapping: `five_hour`, `seven_day`, `overage`, "session limit" and "weekly limit" → `account`; `seven_day_opus` / "Opus limit" → `model:opus`; `seven_day_sonnet` → `model:sonnet`; `seven_day_overage_included` / "Fable limit" → `model:fable`.
- `account_on_hold`, `verification_required`, `billing_error`, `oauth_org_not_allowed`, "Your org is out of usage", "Your seat type doesn't include…" → `blocked` (`needs-attention`).

**Auth:**
- `…has no refresh token — it cannot self-heal…`, `authentication_failed`, `Invalid bearer token`, or HTTP 401 → `auth` (ambiguous strike).
- A past `expiresAt` → `needs-relogin` (§9.2).

**Session portability:** `likely`, so the contract reports `sessionPortable:true`. History is shared, transcripts carry no account binding, and thinking signatures are portable [R04 C9]. LimitShift resumes, and falls back to New plus the handoff note on `No conversation found with session ID` (`session-lost`) or a failed first resumed turn. **VERIFY V-C1.**

### 8.2 codex (OpenAI Codex CLI), tier 1

**Facts (verified against 0.161.0)** [R04 §2]:
- `auth.json` lives in `CODEX_HOME`, with `cli_auth_credentials_store` defaulting to `file`.
- Every store is keyed by the canonical `CODEX_HOME`: the keyring entry `Codex Auth` / `cli|sha256[0:16]`, and on Windows `secrets/codex_auth.age`. A per-account home therefore isolates the credential in every store mode [R04 C12].
- Refresh tokens are single-use and rotate. `auth.json` is rewritten non-atomically on refresh [R04 C13].
- There is no sessions-dir override. The sqlite state can be moved with `CODEX_SQLITE_HOME` [R04 C14].
- `codex exec --json` reports limits only as text. Structured windows are in the rollout's `token_count` [R04 C17].
- Resuming a thread under a different ChatGPT account will probably fail (`invalid_encrypted_content`) [R04 C19].

**Kinds:**

| Kind | Selection for a run | Notes |
|---|---|---|
| `home` (default) | `CODEX_HOME=<overlay>`, `CODEX_SQLITE_HOME=<mainSqliteHome>` | per-account `auth.json`, refreshed in place by Codex itself |
| `native` (account #0) | no `CODEX_HOME` change: the user's own `CODEX_HOME` or `~/.codex` | accshift never copies, moves, rewrites or deletes its `auth.json` or keyring item |
| `access-token` | `CODEX_ACCESS_TOKEN=at-…` from the vault, main home | ChatGPT **Business/Enterprise** workspace tokens only. Validate the `at-` prefix and track expiry (at most 90 days). Not available for personal Plus/Pro [R04 C20] |
| `api-key` | `CODEX_API_KEY=…` from the vault, main home | API billing; `codex exec` only |

There is **no swap kind** and **no symlinked-`auth.json` mode**. Both create two owners of a single-use refresh token [R09 §1.4, D5].

**Homes:**
- `mainHome` = the caller's `CODEX_HOME` when the codex registry is first created, else `~/.codex`. It is recorded and can be changed with `accshift config clis.codex.mainHome <dir>` (§10.2).
- A directory whose canonical path is inside `<root>/homes/` MUST never become `mainHome`, so an inherited overlay `CODEX_HOME` can never become the main home. Initialising `mainHome` from such a `CODEX_HOME` refuses with 78 `unsupported-config`; `config clis.codex.mainHome` refuses such a value with 65 `invalid-config` and changes nothing (§10.2).
- `mainSqliteHome` = `sqlite_home` from `<mainHome>/config.toml`, else the user's `CODEX_SQLITE_HOME`, else `mainHome`.

**Overlay home** (`<root>/homes/codex/<id>`, with an immutable id, §6.2):
- The overlay leaf MUST be a **real directory** (0700), not a symlink or junction.
- At `add`, accshift resolves it with `filepath.EvalSymlinks`, records that canonical path, and always exports the canonical path as `CODEX_HOME`. This works when the root's path contains symlinks (macOS `/var` → `/private/var`, `/tmp`, OSTree `/home` → `/var/home`). Canonicalising avoids Seatbelt rejections caused by symlinks **above** the overlay. Linked children can still be rejected if Codex makes them Seatbelt writable roots (macOS Seatbelt, below).
- The path uses the account's immutable id, never its name. `rename` moves nothing, so the canonical path, and the keyring and secrets keys derived from it, stay valid across renames (§6.2, §10.2).
- `doctor` reports an error if `EvalSymlinks(recorded) != recorded`, because keyring and secrets keys derive from `sha256(canonical CODEX_HOME)`. Moving `ACCSHIFT_HOME` therefore needs a re-login of keyring-mode codex accounts.

**What is shared, and what stays per account.** Shared entries come from an **allowlist**, kept in a version-tagged facts table. Everything else stays per account.

| | Entries |
|---|---|
| **Shared by link** | `config.toml`, `*.config.toml`, `sessions/`, `archived_sessions/`, `history.jsonl`, `session_index.jsonl`, `AGENTS.md`, `AGENTS.override.md`, `rules/`, `skills/`, `memories/`, `memories_v2/`, `plugins/`, `hooks.json`, `themes/`, `worktrees/`, `.credentials.json` (MCP OAuth; **only** when it can be a true symlink), plus a user-configurable `clis.codex.shareExtra` list. On macOS, entries recorded as Seatbelt writable roots move to the per-account row (macOS Seatbelt, below) |
| **Per-account, never linked** | `auth.json`, `secrets/`, `models_cache.json`, `version.json`, `app-server-control/`, `app-server-daemon/`, `packages/`, `arg0/`, `tmp/`, `.tmp/`, `log/`, `.sandbox*`, `sandbox_users.json`, and **every top-level entry not on the allowlist** |

`doctor` lists main-home entries that are on neither list as "not shared".

Why an allowlist, not "link everything else" (D5):
- After a switch the sessions cannot move between accounts anyway, so links serve only configuration and history visibility.
- Wrongly sharing an account-bound file (as `models_cache.json` is) risks wrong-account behaviour or token clobbering. Wrongly isolating a file only loses a customisation, visibly.

**Link refresh** (pre-run, under `state.lock`):
- pre-create missing shared directories in `mainHome`;
- create missing links and replace dangling ones;
- **never** delete or overwrite a real file or directory; report any real entry that shadows a shared name.
- **What counts as a link.** An entry is a link if and only if `Lstat` reports `ModeSymlink` or `ModeIrregular` (Go 1.23+ reports junctions as irregular), or, on Windows, its attributes include `FILE_ATTRIBUTE_REPARSE_POINT`.
- **Unlinking and overlay removal** remove a link with a single `os.Remove` (`RemoveDirectory` for a junction), never with a walk, and **never recurse through a symlink or junction**. Directory walks use `Lstat` / `ReadDir` only, never `os.Stat`. Windows CI MUST prove that removing an overlay leaves `mainHome/sessions` intact.

How links are made per OS:

| OS | Directories | Files |
|---|---|---|
| Linux, macOS | symlink | symlink. Codex follows symlinks when editing config [R04 C14] |
| Windows | directory junction (`FSCTL_SET_REPARSE_POINT`, no admin needed) | symlink when `os.Symlink` succeeds (Developer Mode or privilege). Otherwise **copy mode**, described below |

**Windows copy mode** (when file symlinks are unavailable):
- Before the run, copy in `config.toml`, `*.config.toml`, `AGENTS*.md` and `hooks.json`.
- After the run, copy back each file whose hash changed. If `mainHome`'s copy also changed since the copy-in, keep main's version and report the conflict only in the status file's `postRunError` and in events.jsonl. `exec` writes nothing to stderr after the child starts (§12.1.1), and a copy-back failure never changes the returned exit status.
- `history.jsonl` and `session_index.jsonl` stay per-account (a documented loss).
- `.credentials.json` is **never** copied, because MCP OAuth refresh tokens need one owner.
- Hard links are never used for files Codex rewrites by atomic rename: the rename would silently break the link.
- In copy mode, `env` exits 69 (`requires-exec`).

**macOS Seatbelt** [R04 C15]:
- `allow_symlinked_codex_home` only lets the macOS Seatbelt sandbox accept symlinked writable roots at or beneath `CODEX_HOME`. It has no effect on Linux or Windows and does not make symlinked homes work in general.
- If Codex rejects a symlinked writable root (`contains symlink component … allow_symlinked_codex_home`), `classify` reports `config-error` with a hint.
- On macOS, every allowlisted entry that V-X2 records as a Seatbelt writable root under `CODEX_HOME` (in workspace-write mode) is kept per account, unlinked, unless the shared `config.toml` sets `allow_symlinked_codex_home = true`. The list lives in codex `facts.go` per Codex version; until V-X2 has run, it is empty and the `config-error` hint is the fallback.
- `doctor --fix` MAY add `allow_symlinked_codex_home = true` to the shared `config.toml`, but only with explicit consent.

**Environment for every codex run** (Appendix A.2):
- Set `CODEX_HOME` / `CODEX_SQLITE_HOME` as above, for `home` accounts.
- For `native`, `access-token` and `api-key` runs, an inherited `CODEX_HOME` or `CODEX_SQLITE_HOME` whose canonical path is inside `<root>/homes/` belongs to accshift (for example from an `eval "$(accshift env …)"` shell, or an agent that runs accshift again). accshift sets `CODEX_HOME=<mainHome>`, or unsets it when `mainHome` is `~/.codex`, and treats `CODEX_SQLITE_HOME` the same way (§12.5).
- For `home` and `native`, unset `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN`.
- Always unset `CODEX_REFRESH_TOKEN_URL_OVERRIDE`, which would send refresh tokens elsewhere [R04 §2d].
- **Never touch `OPENAI_API_KEY`.** Codex does not use it for auth, and the user's task code may need it [R04 C20].
- `exec` never adds `-c` or `--no-daemon`. The interactive Codex TUI starts one app-server daemon per `CODEX_HOME` (`codex exec` does not use it). `doctor` reports live per-overlay daemons, and `remove` refuses with 65 `account-in-use` while one runs (§10.2) [R04 C16].
- `run` (§16) is the documented exception: for a codex TUI launch it appends `--no-daemon` unless the caller's args already select daemon behaviour, so relaunches do not leave a daemon per overlay [R04 C16]. `exec` never does this.
- **Credential presence** (exec's `relogin(missing)` check, §12.1). The store mode comes from `cli_auth_credentials_store` in the shared `config.toml` (default `file`), read offline:
  - `home`, file store → the overlay's `auth.json` exists;
  - `home`, Windows secrets mode (the Windows default for `keyring` and `auto`) → the overlay's `secrets/codex_auth.age` exists;
  - `home`, `keyring` or `auto` on macOS and Linux → not checked, because accshift never reads Codex's keyring item;
  - `access-token`, `api-key` → the vault entry `codex/<id>` exists;
  - `native` → never checked.

**Add** (`accshift add codex <name> [--native | --kind home|access-token|api-key] [--browser] [--import-home DIR] [--label L] [--token-stdin] [--accept-notice]`). Without `--native` or `--kind`, the kind is `home`; `--browser` and `--import-home` apply to `home` only. The `home` flow:
1. A TTY is required. Show the notice when it is not yet accepted (§8 rules).
2. Print the emails already registered, including `main`, with "do not sign in with these".
3. Create the overlay and run the link refresh.
4. Run `CODEX_HOME=<overlay> codex login --device-auth` attached to the terminal.
   - Device auth is the default, because two ChatGPT accounts signed in to one browser can invalidate fresh refresh tokens [R09 §1.4, #39199].
   - `--browser` uses the PKCE browser flow and tells the user to use a private window.
5. **File-store mode:** decode `tokens.id_token` locally (no signature check, labelling only):
   - `email`;
   - `https://api.openai.com/auth.chatgpt_plan_type`, `chatgpt_account_id`, `chatgpt_user_id`.
   
   Dedupe on (`chatgptAccountId`, `chatgptUserId`). A new sign-in probably invalidates the account's previous refresh token [R09 C7, inferred], so accshift **never deletes the newest credential**. On a duplicate of registered account X:
   - confirm that no codex process or daemon uses X's overlay (procscan, as for `remove`, §10.2); otherwise exit 73 `overlay-in-use` and keep the new overlay for a retry;
   - rename the new `auth.json` over X's `auth.json` (same filesystem), remove the new overlay, and apply the effects of a same-identity login to X (§8 Login rules: `relogin`, `authStrikes` and auth-suspect records are cleared; limit records stay);
   - exit 65 `duplicate-account` with the message "re-authenticated X".
   - If the duplicate is the native `main` account, which accshift cannot inspect, keep the new account and warn that `main` may need `codex login`.
6. **Keyring or auto store mode:** identity is user-asserted (`--label` required), and accshift never reads Codex's keyring item.
7. If the shared config sets `cli_auth_credentials_store = "ephemeral"`, refuse overlays (exit 78 `unsupported-config`).

**Add, `access-token` and `api-key`** (`--kind access-token|api-key`):
1. Show the notice when it is not yet accepted (§8 rules). A TTY is required unless `--token-stdin`.
2. Read the secret from a no-echo TTY prompt, or as one line of stdin with `--token-stdin` (§8 rules).
3. `access-token`: the secret MUST start with `at-`; otherwise `add` exits 65 `invalid-token` and stores nothing. Record `createdAt` and `expiresAt = createdAt + 90 d`, the longest lifetime of such a token (Kinds, above).
4. Require `--label`: the identity is user-asserted, and `login` later requires the same label (§8 Login rules).
5. Store the secret in the vault under `codex/<id>`. Never make a model call.

**Import** (`--import-home DIR`): adopts an existing single-account Codex home by **moving** its `auth.json` into a new overlay. It never leaves two copies, because refresh tokens are single-use [R04 C13]. It refuses with 65 `invalid-import` if DIR is `mainHome`, and with 73 `overlay-in-use` while any codex process or daemon is using DIR.
- If the rename fails with `EXDEV` (another filesystem): copy to a temp file in the overlay, fsync, unlink the source, and only after the unlink succeeds rename the temp file to `auth.json`. If the unlink fails, delete the copy and abort with exit 74 `import-failed`.

**`add codex main --native`** registers `mainHome`, after the notice (§8 rules). Its label is user-asserted (`--label`), because accshift never reads the native `auth.json`.

**Login** (`accshift login codex <name> [--browser] [--label L] [--new-identity] [--token-stdin]`), under the §8 Login rules:
- `home`, file store: run add steps 3 and 4 in a new **temporary** overlay `homes/codex/<new id>`, so the account's own `auth.json` stays untouched until the identity is known. Then decode the new `id_token` as in add step 5.
  - Same (`chatgptAccountId`, `chatgptUserId`) as the account: after add step 5's in-use check (73 `overlay-in-use`, keeping the temporary overlay for a retry), rename the new `auth.json` over the account's own and remove the temporary overlay. Two copies are never kept [R04 C13].
  - A different identity without `--new-identity`: if it is another registered account Y, it is handled as add step 5 (moved over Y's `auth.json`, never deleted). Otherwise the temporary overlay is deleted, with a warning that `main` may need `codex login` if that identity was the native account's [R09 C7]. Either way the account's own `auth.json` is unchanged, and `login` exits 65 `identity-mismatch`.
  - With `--new-identity`: the add-time dedupe runs first (a registered Y is handled as add step 5). Otherwise the new `auth.json` replaces the account's own as above, the identity fields are updated, and all the account's records are cleared.
- `home`, keyring or auto store: the item is keyed by the overlay's own path, so `login` runs `codex login --device-auth` (or `--browser`) directly in the account's overlay, after the same in-use check. The identity is user-asserted: `--label` MUST equal the current label unless `--new-identity` is given.
- `access-token`, `api-key`: read the new secret as at add (no-echo TTY or `--token-stdin`) and replace the vault entry `codex/<id>`. `--label` MUST equal the current label unless `--new-identity` is given. For `access-token`, validate the `at-` prefix (else 65 `invalid-token`, and the vault entry is unchanged) and reset `expiresAt` to now + 90 d.
- `native`: exit 64 `native-account` with the hint `codex login` (run with the user's own `CODEX_HOME`).

**Doctor:**
- auth file present and parseable; the access token's `exp`, for information;
- the store mode;
- link health; entries that are not shared;
- per-overlay daemons;
- codex processes and daemons that use `mainHome`: procscan finds vendor processes whose `CODEX_HOME` is unset or resolves to `mainHome` (POSIX `/proc/<pid>/environ` or `ps eww`; Windows best effort). When a `native` codex account is registered, `doctor` warns that they race accshift's `main` runs for the single-use refresh token (Concurrency, below);
- the Seatbelt hint;
- whether the overlay's canonical path changed;
- whether Codex's `shell_environment_policy` keeps `CODEX_ACCESS_TOKEN` / `CODEX_API_KEY` out of tool subprocesses for secret-bearing kinds (V-X4, §7.6). `exec` cannot apply that setting, since it would need `-c`; the README documents it as a setting in the user's own `config.toml`;
- a `native` codex account's identity is not checked: accshift never reads the native `auth.json`.

**Limits** (Appendix C.2):
- **Text** from `exec --json` `error` / `turn.failed`, matched on the decoded message strings (Appendix C.2):
  - `You[’']ve hit your usage limit` → scope `account`;
  - `…usage limit for {limit_name}. Switch to another model…` → `model:<limit_name>`;
  - reset from `try again at <t>` (tier 2), where `<t>` is `3:45 PM` today or `Oct 9th, 2026 3:45 PM`, in local time [R04 §2f];
  - `Try again later` → no reset: default backoff (tier 1).
- **Structured** (tier 3): with `--session <thread_id>`, `next`, `mark` and `classify` read that thread's rollout [R04 C17, §2f]. Only events at or after `--run-started-at` count (§9.4).
  - **Lookup.** Rollouts live at `<mainHome>/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>[_<rollout_id>].jsonl[.zst]`. accshift searches only the date directories of the run-start date and the day before, each computed in local time and in UTC (at most four directories); the newest matching file wins. Only plain `classify` (without `--record`) falls back to a full walk of `sessions/`. When the thread's rollout lies elsewhere (for example a thread first created days earlier), `next` and `mark` use the text evidence only. The lookup and the parse run before `state.lock` is taken (§9.3).
  - **Signal.** Tier 3 applies only when the thread's last `token_count` event has `rate_limit_reached_type == "rate_limit_reached"`.
  - **Reset.** The latest `resets_at` (epoch s) among the windows (`primary`, `secondary`) whose `used_percent >= 100`. If no window is at 100, the later of the primary and secondary `resets_at`, with resetConfidence `parsed`.
  - `used_percent`, alone, is never a limit signal [R03 §9]. §9.4 uses the same rule.
- **Workspace exhaustion** → class `blocked` (`needs-attention`), with no limit record [R04 §2f]:
  - `rate_limit_reached_type` `workspace_owner_credits_depleted`, `workspace_member_credits_depleted`, `workspace_owner_usage_limit_reached` or `workspace_member_usage_limit_reached`; `attentionCode` is that value;
  - the texts `Your workspace is out of credits…` (`attentionCode` `workspace-out-of-credits`) and `You hit your spend cap set in your workspace…` (`attentionCode` `workspace-spend-cap`).

**Auth:**
- `…since logged out or signed in to another account…` → `relogin` with reason `rejected`; `refresh_token_expired` or `refresh_token_invalidated` → `relogin` with reason `refresh-dead`. Both apply on the first occurrence; these never heal by themselves (§9.2).
- `refresh token was already used` (`refresh_token_reused`) loses a race more often than it reports a dead login [R04 C13]. It is definitive (`refresh-dead`) only if the account's `auth.json` was **not** rewritten after the failing run started: `next` and `mark` read its mtime and `last_refresh` offline, before the lock, and compare them with `--run-started-at`. For a `native` account only the mtime is used (a stat; the native file is never opened). If either value is at or after that time, the failure is transient: no strike and no record, and the caller MAY retry the same account once. This applies to `home` and `native` accounts alike. In keyring, auto or Windows secrets mode there is no `auth.json` to check, so the text counts as an ambiguous strike (§9.2).
- A plain 401 → an ambiguous strike (§9.2).

**Concurrency:**
- Different accounts are fully parallel.
- Two processes that use one Codex home race the single-use refresh rotation [R09 §1.4, #48507, R04 C13]: two accshift runs of the same account, or a `native` run next to the user's own codex, IDE extension or daemon on `mainHome`. The loser may report `refresh token was already used` while `auth.json` already holds the winner's valid token.
- v1 does **not** stagger same-account runs. On the execve path nothing records an in-flight run, and a pre-launch wait cannot observe Codex's refresh triggers (5 minutes before `exp`, `last_refresh` older than 8 days, or a 401 [R04 §2d]). Instead:
  - the `refresh_token_reused` rule above keeps the loser of a race out of needs-relogin;
  - the README and `doctor` document the race (D5 risks), and `doctor` reports other codex processes on `mainHome` (Doctor, above);
  - V-X7 records what Codex does when two processes in one home refresh at once.
- A later version may add a per-overlay holder file on the spawn path.

**Session portability** (`Portability(from, to)` per move, §8, D5):
- a different `chatgptAccountId`, or one accshift does not know (`native`, keyring or auto store, `access-token`, `api-key`) → `unlikely`, so `sessionPortable:false`. LimitShift starts New plus the handoff note directly, without attempting a resume;
- the same `chatgptAccountId` (two users of one workspace) → `possible`, which also gives `sessionPortable:false`;
- there is no `yes` case across codex accounts: accshift keeps no record of which account created a thread. Only `from` = `to` is `yes` (§8).
- As a safety net, `classify` maps `invalid_encrypted_content`, `could not be verified` and `organization_id did not match` to `resume-incompatible`.
- `codex exec resume` of an unknown thread id → `session-lost`. Its exact text is **VERIFY V-X5**.
- **VERIFY V-X1.**

---
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
- accshift MUST NOT select agy accounts through `JETSKI_OAUTH_TOKEN`, `AGY_ACCOUNT`, `HOME`, `--gemini_dir`, or by adding or removing environment variables such as `DBUS_SESSION_BUS_ADDRESS` or `SSH_*` for the child. The last would also break the agent's own git and gh keyring helpers.
- **Environment** (Appendix A.3). accshift unsets the selectors listed there, so the stored login is used. It also:
  - refuses with `exec` exit 125 `agy-env-overrides-slot` when any `AGY_LLM_GATEWAY_*` variable (URL, API key, headers, models, proxy URL, CA certificate, wire protocol [R05 §c]) is set in the environment it would pass to agy, unless `--allow-settings-env` is given. agy's enterprise-gateway auth would then decide the account, not the slot;
  - unsets `GOOGLE_GEMINI_BASE_URL`;
  - leaves `GOOGLE_APPLICATION_CREDENTIALS` and `GOOGLE_CLOUD_*` untouched. They matter only with `AGY_ADC_AUTH`, which is unset.
  
  The variable names live in agy `facts.go`.
- **The user's own agy follows the swaps.** agy has no `native` kind: there is one slot per OS user. An interactive `agy` started by the user runs as whichever account accshift last put in the slot. `accshift agy use <name>` swaps an account in without running agy, and `settings.agyRestoreAfterRun: "<name>"` makes every swapping run put that account back afterwards (§8.3.3). The README says this plainly.

#### 8.3.1 Slot facts (data, in `adapters/agy/facts.go`, version-tagged)

| Store | Identity and encoding |
|---|---|
| Linux Secret Service | attributes `{service:"gemini", username:"antigravity"}`, label `Password for 'antigravity' on 'gemini'`, collection `login`, else the `default` alias; `CreateItem(replace=true)`; `plain` session; the secret is the raw token JSON |
| macOS keychain | login keychain generic password `-s gemini -a antigravity`. Write via `/usr/bin/security -i` stdin: `add-generic-password -U -s gemini -a antigravity -T /usr/bin/security -w go-keyring-base64:<base64(json)> <keychain>`. Read: `find-generic-password -s gemini -wa antigravity <keychain>`, accepting raw, `go-keyring-base64:` and hex `go-keyring-encoded:` forms (§7.4) |
| Windows Credential Manager | `CredWriteW` with `CRED_TYPE_GENERIC`, TargetName `gemini:antigravity`, UserName `antigravity`, `CRED_PERSIST_LOCAL_MACHINE`, raw UTF-8 blob of **at most 2560 bytes**. accshift calls `CredWriteW` / `CredReadW` itself; `zalando/go-keyring` is not used at runtime (§7.3) |
| CLI token file | candidates in order: `<home>/.gemini/antigravity-cli/antigravity-oauth-token`, then `<home>/.gemini/antigravity-oauth-token` (**VERIFY V-A2**; reports 05 and 07 disagree, so the judge leans to the first). A file that already exists wins. New files are written 0600 with temp + fsync + rename in the same directory, following the Windows rules of §13.2 |
| Language-server token file | `<home>/.gemini/jetski-standalone-oauth-token` [R05 §a] (**VERIFY V-A2, V-A10**). It is part of every snapshot, diff and write set whenever it holds a credential |
| Keyring-timeout markers | `<home>/.gemini/antigravity-cli/cache/antigravity-keyring-unavailable` (the CLI's) and `<home>/.gemini/cache/antigravity-keyring-unavailable` (the language server's) [R05 §a]. Both are checked (§8.3.2) |
| Keyring timeouts | agy: about 5 s per keyring operation, 2.5 s for detection [R05 §a]. accshift: 4 s for any call on agy's slot (§8.3.2, §7.5) |
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

The **resolved slot** is the store agy will read in this run. accshift resolves it per OS, against the exact environment it will pass to the child (Appendix A.3). Whether the keyring store is **in scope** is decided by the rules below. An in-scope keyring that cannot be read stops the run.

**Linux.** agy's own detectors decide [R05 §a, R05 C3]. They fall into two classes.
- **Permanent detectors** (environment and OS). Any one of:
  - `DBUS_SESSION_BUS_ADDRESS` is empty;
  - `/.dockerenv` exists, or `/proc/1/cgroup` contains `docker`, `containerd` or `kubepods`;
  - `CLOUD_SHELL` is set;
  - `WSL_DISTRO_NAME` or `WSL_INTEROP` is set, or `/proc/sys/kernel/osrelease` contains `microsoft`;
  - `SSH_TTY`, `SSH_CLIENT` or `SSH_CONNECTION` is set;
  - Android/termux.

  If one fires, the resolved slot is the CLI token file. agy decides this up front per process and does not use the keyring in that run, so the keyring is **out of scope**: the locked-keyring rule below does not apply. If the keyring is reachable (through the `DBUS_SESSION_BUS_ADDRESS` of the child's environment), unlocked, answers within 4 s and holds an agy credential, it still joins the write set like any other slot. Otherwise it is skipped.
- **Transient detector:** a keyring-timeout marker younger than 1 h. Both marker paths are checked (§8.3.1). A fresh marker at the CLI's path makes the CLI token file the resolved slot for this run. A fresh marker at the language server's path makes the language server use its own token file, which is in the write set whenever it holds a credential. Either way the keyring stays **in scope**, because agy and the language server go back to it once their markers expire. accshift MUST read it: if it holds a credential it joins the write set; if it cannot be read, the locked-keyring rule applies.
- If no detector fires, the resolved slot is the Secret Service item, and it is in scope.

**macOS and Windows.** agy's detectors are verified on Linux only. Whether they fire on macOS and Windows is **VERIFY V-A3**: `DBUS_SESSION_BUS_ADDRESS` is normally empty on macOS, so if agy runs its D-Bus detector there it always uses the file. Until V-A3 is recorded in `facts.go` for that OS and the installed agy version:
- the resolved slot is the store and path that `add agy` or `login agy` last recorded in an account's `agySlotUsed` for the installed agy version (§8.3.4, Appendix D.1);
- with no such record, it is the login keychain on macOS, and Credential Manager on Windows unless the incoming blob exceeds 2560 B. In that case it is the CLI token file, where agy's own failed keyring save would put it [R05 §a];
- a file candidate joins the write set only if it already holds a credential, or under the size rule of the write set below;
- accshift MUST NOT create a new token file on macOS;
- a keychain or Credential Manager item that is the resolved slot is in scope. When the resolved slot is a file, the item joins the write set if it is readable within 4 s and holds a credential, and is skipped otherwise.

Once V-A3 is recorded for an OS and agy version, the Linux rules above apply there, with that OS's detectors.

**An in-scope keyring that cannot be read fails closed.** "Cannot be read" means the store is locked, would need a prompt, is unreachable or absent, or any call on it takes longer than 4 s:
- Linux: the target collection has `Locked=true`; the bus has no `login` collection and no persistent `default` collection (agy's behaviour there is VERIFY V-A3); or nothing answers at the bus address, or the connection is refused;
- macOS: `security` exits 36 (locked), 37 or 50 (no default keychain, no such keychain), the read needs a prompt, or the call times out;
- Windows: a Credential Manager call fails with anything other than not-found (for example error 1312 on network logons), or times out.

A keyring that answers "not found" is readable and empty; that is not a failure.

Why: go-keyring's own prompt wait is unbounded [R07 C5], but agy bounds its keyring operations at about 5 s [R05 §a]. After a timeout agy writes its keyring-unavailable marker and uses its file slot for an hour. A keyring accshift cannot read therefore leads either to a GUI unlock within those 5 s, after which agy reads an item accshift could neither read nor overwrite, or to a silent switch to a file slot accshift did not write for this account. Either way agy could start as a stale account. So:
- a locked, unreachable or slow keyring is **never** evidence of file mode. File mode comes only from the detectors above, or, on macOS and Windows, from the `agySlotUsed` record or the 2560 B rule;
- accshift treats any keyring call on agy's slot that takes longer than 4 s as uncertain (§7.5). The 4 s bound and agy's own timeout are recorded in agy `facts.go`;
- the run MUST NOT proceed, neither a swap nor a fast-path run: `exec` exits 125 `agy-keyring-locked`; control verbs exit 74. The hint is "unlock the login keyring or keychain, or run where agy uses its file store". `doctor` reports the same state as a finding.

`doctor --json` reports the resolved slot, the detector, record or default that decided it, and whether the keyring is in scope.

**Write set** = the resolved slot **plus every other reachable slot that currently holds an agy credential** (both CLI token files and the language-server token file included; on macOS and Windows, file candidates only as stated above).
- **The resolved slot cannot take the blob.** If the resolved slot cannot accept the incoming blob (size cap: Windows Credential Manager over 2560 B, or a macOS `security -i` line over 4096 bytes), the first CLI token-file candidate, or the file path recorded in `agySlotUsed`, joins the write set. This mirrors agy's own fallback after a failed keyring save [R05 §a]. On macOS that file joins only if it already exists or `agySlotUsed` recorded it; otherwise the swap is refused before any write, with `exec` exit 125 `slot-write-failed` (control verbs 74). V-A4 confirms which slot agy reads after a failed keyring save.
- **Fail closed.** If any slot that holds a credential cannot accept the incoming blob, accshift saves it back (§8.3.3 B.5) and then **deletes** it. agy must never be able to start as a stale account.
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
- **Identification.** accshift identifies agy processes by **executable path**, not by name, and compares them with the "agy executables" row of §8.3.1:
  - Linux: `/proc/<pid>/exe`;
  - macOS: enumerate with `sysctl kern.proc.uid` (`unix.SysctlKinfoProcSlice`) and read the exec path from `KERN_PROCARGS2` (`unix.SysctlRaw("kern.procargs2", pid)`), resolved with `filepath.EvalSymlinks`. `proc_pidpath` MUST NOT be used: it lives in libproc and needs cgo (§17.1);
  - Windows: `QueryFullProcessImageName`.

  Until V-A10 has recorded which components share the slot, every listed sidecar and the Antigravity desktop app count as agy. Only processes of the current user count. Process identity is always (pid, start time) (§13.1).
- **It gates only the exclusive path** (swap, recovery, `add agy`, `login agy`, `agy use`, `remove`, `doctor --fix`). Under the exclusive lock no other holder can exist, so every running agy process is foreign. No ancestry test is needed.
- **On the shared fast path it is informational.** An agy process is accshift's when its (pid, start time) equals the `childPid` and `childStartTime` of a live holder file (§13.1); every other agy process is foreign. A foreign agy does not block the run. `exec` sets `foreignAgy:true` in the status file and writes nothing to stderr. Nothing is written to the slot on this path, so nothing can be mixed up under a running agy; a sidecar started by another holder's agy may show up as foreign here, which is harmless.
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
     - `exec` never asks (§7.5). It refuses **before writing anything**: exit 125 `agy-slot-unregistered`, with the hint `accshift add agy <name> --capture-current`. A non-interactive control verb refuses the same way with exit 77.
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
   - **Save-back failure.** A post-run save-back that fails (the key is gone, `vault.lock` timed out, `vault-changed`) never changes `exec`'s exit status (§7.1). The slot is left untouched. accshift sets `state.agySlot.saveBackPending` to true and `postRunError` in the status file, and records an event. The next exclusive holder performs that save-back in its step B.5, before any slot write. Any later successful save-back of the slot clears the flag.
   - **Restore after run.** If `settings.agyRestoreAfterRun` names an account and this run holds the lock exclusively, swap that account back in (B.5–B.8). A failure here is a post-run failure: it never changes the exit status, leaves the slot as B.8's rollback left it, and sets `postRunError`. An unregistered email found in B.5 skips the restore (`postRunError` with `agy-slot-unregistered`).
   - Delete the holder file and release the lock.

**`pick agy`** returns the live slot owner (`state.agySlot.owner`) whenever it is a usable candidate, even if `--prefer` names another account (§9.3). agy sessions are not portable, so stickiness buys nothing, and staying on the live owner avoids swaps and slot-lock contention (D6). `pick` never opens the keystore. `state.agySlot` is only its hint; the lock algorithm above reads the slots and is authoritative.

#### 8.3.4 Add, login and use

`accshift add agy <name>`:
1. Show the notice (Appendix F) when `state.notice` is unset or older than the binary's (§6.3).
2. Take the exclusive slot lock and run steps B.1–B.5 of §8.3.3 (intent, foreign-process check, recovery, read, save-back). The save-back is the commit point of B.5 and also writes the per-operation backup `agy/_swap/<startedAt>`. An unregistered credential found here is parked as `agy/_unregistered/<email>` with a notice, since it is restored in step 6.
3. Write `journal/agy-swap.json` with `op:"add"`, listing the saved secret ids, the exact stores and paths they came from, and `backupSecretId`, and fsync it. Then **delete every slot**, so that agy starts signed out. accshift never tells the user to use agy's `/logout`, which could revoke the live account.
4. Run `agy` attached to the terminal. The user signs in, then exits.
5. Read the slots, including every file candidate, since agy has just written one. Every slot that now holds a credential must carry the same email.
   - `add` requires an **unregistered** email. If the email belongs to a registered agy account, the new credential is saved to that account by the B.5 rules, and the command exits 65 `duplicate-account` after step 6.
   - Otherwise store it as the new account's snapshot `agy/<id>` (§7.2). Record in the account's `agySlotUsed` `{store, path, agyVersion}` (Appendix D.1) the store and path agy wrote, with `agyVersion` from §8.3.1.
   - If no slot holds a credential, exit 65 `no-login-detected` after step 6.
6. **Restore** the saved-back content into exactly the slots it came from, and empty again the slots that were empty before step 3. Verify the read-back, delete the journal, and release the lock. Adding an account therefore never changes which account is live. If nothing was live before, `accshift agy use <name>` makes the new account live.

**Signals during steps 3–6.** Before step 3, accshift installs `signal.Notify` for SIGINT, SIGTERM and SIGHUP (on Windows, `os.Interrupt` and SIGTERM). It never ignores a signal (§12.3).
- agy shares the terminal's process group, so a Ctrl+C reaches it directly; accshift forwards SIGTERM and SIGHUP to it.
- On any of these signals accshift waits for agy to exit (at most 10 s, then kills it). Whether agy exited normally or after a signal, accshift always runs step 6 before it exits. On a Windows console close, step 6 has the roughly 5 s Windows allows (§12.4).
- If accshift dies anyway (SIGKILL, power loss), the `op:"add"` journal remains, and the next exclusive holder's recovery (B.3, §13.3) saves whatever the user signed in to by the B.5 rules and restores the saved content from `agy/_swap/<startedAt>`.
- `doctor` reports a pending journal of any `op` with the hint `accshift doctor --fix`. `doctor --fix` takes the exclusive slot lock and runs B.1–B.3 only; it never swaps. A failure there exits with that step's control-verb code (73 or 74), and `doctor --fix` still prints every finding (§10.2).

**`accshift login agy <name>`** runs the same flow for an existing account, for example after revocation. Step 1 is skipped.
- **Identity.** The email found in step 5 must equal the account's `identity.email`. Otherwise the new credential is saved by the B.5 rules (a registered email to that account's entry `agy/<id>`, keeping the later `expiry`; an unregistered one as `agy/_unregistered/<email>`; one with no identifiable owner as `agy/_unknown/<sha256-8>`), and after step 6 the command exits 65 `identity-mismatch`.
  - With `--new-identity`, the add-time rule applies instead: the email must not belong to another registered agy account (else 65 `duplicate-account`). `identity.email` is then updated and all of the account's records are cleared (§8).
- **On success the new credential replaces the account's snapshot** unconditionally, and `agySlotUsed` is updated. A same-identity login clears `relogin`, `authStrikes` and auth-suspect records, and keeps limit records (§9.2).
- **Login of the live account.** If the slots held this account's email before step 3, step 6 does not put its old credential back. Every slot that held it gets the new credential instead, written and verified like B.8, so the fresh login stays live and the fast path never keeps the stale copy. `state.agySlot.owner` stays this account. Slots that held other content are restored as usual.

**`--capture-current`** registers whatever account is in the slot now, without running agy. It takes the lock shared and only reads the slots (§8.3.2, including the locked-keyring rule); it writes no slot. It writes the vault, the registry and, under `state.lock`, the notice when it is accepted (step 1) and `state.agySlot = {owner: <the new account's id>, store: <the resolved slot's store>, writtenAt}`, because the new account is the observed slot owner (§6.3). If `journal/agy-swap.json` exists, it takes the exclusive path instead (B.1–B.4), so the journal is recovered before the slots are read.
- Every slot that holds a credential must carry the same email, and that email must not belong to a registered agy account (65 `duplicate-account`).
- `agySlotUsed` records the store and path that hold the credential.
- The notice rule of step 1 applies.

**`accshift agy use <name>`** performs B.1–B.8 without running agy and releases the lock, so the user's own interactive `agy` uses that account. When it runs interactively, the unregistered-email question of B.5 applies.

**`remove` and `rename`** (§10.2):
- **`remove agy <name>`** takes the exclusive slot lock and runs B.1–B.4 (intent, foreign-process check, recovery, read).
  - If any slot holds the account's email, it refuses with 65 `agy-account-live` and the hint `accshift agy use <other>`. Removing it anyway would leave the slot holding an email no account has, and every later non-interactive `exec agy` would stop with `agy-slot-unregistered`.
  - With `--sign-out-slot` it instead parks those slots' raw bytes as `agy/_unregistered/<email>` and in the backup `agy/_swap/<startedAt>` (one commit, as in B.5). It then writes a journal with `op:"sign-out"`, which §13.3 recovers by the `swap` rules, deletes every slot that holds the account's email, verifies that each reads as not found, and deletes the journal. `state.agySlot` becomes null if it named the account. Slots that hold other accounts are untouched.
  - Only then does the rest of the `remove` transaction run (§10.2). A `remove` that dies part-way is simply run again.
- **`rename agy`** never touches the slot. `state.agySlot.owner`, vault entry ids and journals use the account's immutable id (§6.2). `rename` rewrites `settings.agyRestoreAfterRun` when that names the old account, and refuses with 73 `agy-journal-pending` while `journal/agy-swap.json` exists (§10.2).

accshift never performs Google OAuth. It only moves credentials agy produced.

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
- **Experimental gating:** agy rotation ships marked experimental per OS until that OS's V-A items pass. `version` then lists agy in both `supportedClis` and `experimental` (§11.2). Unlike other experimental clis, while at least one agy account is registered LimitShift routes every agy runner through accshift, with or without `accounts`, because an unwrapped agy would race slot swaps (§11.2, §15.4). `facts.go` records the agy versions it was verified against, and `doctor` warns when a newer agy is installed.
- **macOS:** never `-A`, `-T ""`, partition-list edits, or argv secrets. If a non-interactive read-back fails after a write, roll back and report `keychain-prompt-required`. A locked keychain fails closed before any write (§8.3.2); V-A5 confirms that agy reads items written by `/usr/bin/security` without a prompt.
- **WSL:** a Windows `agy.exe` reached through interop is refused (§12.2), because swapping the WSL-side file slot would not affect it.
- **Provider terms:** the Antigravity terms bar third-party software accessing the service [R09 §1.5]. accshift moves only agy's own credentials and agy does all the network access, but the notice and explicit opt-in still apply (§20.4).

#### 8.3.6 Alternatives kept behind verification

- **Per-account `--gemini_dir` (isolated history), opt-in for parallel headless Linux runs.** Considered only if V-A9 shows the flag moves the token file **and** `brain/` **and** `conversation_summaries.db`, and agy can be put into file mode per directory without changing the child's environment. If adopted, `exec` reports the per-account `dataDir` in the status file (a field §11.2 would then add), so LimitShift can set `LIMITSHIFT_AGY_DATA_DIR`. `capabilities.agy.dataDir` in `version` stays the user's default, `null` until V-A2 has recorded the OS's path (§11.2).
- **`JETSKI_OAUTH_TOKEN` / `AGY_ACCOUNT`.** One-shot probes in M0 (V-A7). They are adopted only if they select the Google sign-in for `agy -p` without accshift minting or refreshing tokens.
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
## 10. Command-line interface

### 10.1 Global rules

- Syntax: `accshift <command> [args] [flags]`. Flags may come before or after positional args, except after `--` in `exec`, `env` and `run`, where everything is passed through untouched.
- A **control verb** is every command other than `exec` and `run` (§3). Control verbs report failures with the sysexits codes of §10.3 (64–78). `exec` and `run` report every failure before the child starts as 125, and otherwise return the child's status (§12.1.1).
- Global flags (types and defaults in §10.4):
  - `--json`: machine output per §11; implied for every contract command when stdout is not a terminal and `ACCSHIFT_JSON=1`.
  - `--home DIR`: same as `ACCSHIFT_HOME`.
  - `--non-interactive`: never prompt. accshift is also non-interactive when stdin is not a TTY or when `ACCSHIFT_NONINTERACTIVE=1`. LimitShift MUST export `ACCSHIFT_NONINTERACTIVE=1` for every accshift invocation (§7.5, §15.3). Control verbs that would need input then fail with a hint:
    - exit 74 `keystore-unavailable` when the input is a vault passphrase or a keystore unlock;
    - exit 65 `notice-not-accepted` when `add` would show the provider notice and `--accept-notice` is missing (§8), or `notice` finds the current version not accepted and `--accept` is missing (§10.2);
    - exit 77 `agy-slot-unregistered` when an agy control verb finds an unregistered login in agy's slot (§8.3.3);
    - exit 64 `usage` for anything else, such as a missing `--yes`, a token that must come from `--token-stdin`, or `config edit`.
  - `exec` never prompts, whatever stdin is: a condition that needs input takes the non-interactive branch and exits 125 (§7.5, §12.1.1). `run` never prompts during pre-launch credential handling either; it MAY ask its §16 post-exit question ("switch and resume?") only when stdin is a TTY and `ACCSHIFT_NONINTERACTIVE` is not `1`.
  - `--debug` (or `ACCSHIFT_DEBUG=1`): redacted debug log to stderr. Writers also append it to `logs/accshift.log` (§6.1); read-only commands write it to stderr only, so they still write no file (§11.1 rule 8). It is for people only; LimitShift never passes it. There is no `--verbose`.
  - `--contract N`; `--no-color`; `--version`; `-h, --help`.
- Human output goes to stdout. Diagnostics go to stderr, always prefixed `accshift: `, and never start with `{` (LimitShift merges stderr into parsed output) [R08 C3]. `exec` writes at most the catalogue lines of §12.1.1 and nothing after the child starts.
- **Flag parsing** uses the Go standard library (`flag`) with a small subcommand dispatcher. No CLI framework dependency (§19).
  - The dispatcher first takes the command words (`vault status`, `agy use`, `config edit`; a `config` key always starts with `clis.` or `settings.`, so `edit` is never a key).
  - `FlagSet.Parse` stops at the first positional argument, so the dispatcher parses repeatedly: `Parse`, take one positional, `Parse` the remainder, until `--` or the end.
  - After `--` (`exec`, `env`, `run`) everything is passed through unparsed and in order.
  - Unknown flags, a missing flag value, a missing or extra positional, and conflicting flags are usage errors: 64 `usage` (`exec`/`run`: 125 `usage`).

### 10.2 Commands

| Command | Purpose | Contract command (§11) |
|---|---|---|
| `version` | name, version, commit, contracts, supported and experimental clis, platform, `root`, `rootSource`, capabilities, `stderrCatalogue` | yes |
| `add <cli> <name> [kind flags] [--label L] [--token-stdin] [--accept-notice] [--key-source S] [--force-new-vault]` | register an account (guided vendor login, import, or agy `--capture-current`); per-cli kind flags in §10.4. It shows the provider notice (Appendix F) whenever `state.notice` is unset or older, and requires `y` or `--accept-notice` (else 65 `notice-not-accepted`). Secret-bearing kinds read the secret only from a no-echo TTY prompt or one line on stdin with `--token-stdin`; no flag ever takes a secret value (§8). It draws the account's immutable `id` (§6.2) | no (interactive) |
| `login <cli> <name> [--label L] [--new-identity] [--browser] [--token-stdin]` | re-authenticate an existing account in place: same `id`, home, `secretId`, name and pool position, under the §8 Login rules. A different identity exits 65 `identity-mismatch` unless `--new-identity`. On a `native` account it exits 64 `native-account` with the vendor's own login command as the hint | no |
| `remove <cli> <name> [--yes] [--keep-home] [--sign-out-slot]` | one transaction under `state.lock` and `vault.lock` (agy: also the exclusive slot lock, §8.3.4). It deletes the account's vault entries, its overlay directory (unless `--keep-home`) with any vendor keyring item derived from that overlay's own path (§8), its state entry, and then its registry entry. A `native` account is only unregistered. It refuses with 65 `account-in-use` while procscan finds a vendor process whose environment or cwd references the overlay (POSIX: `/proc/<pid>/environ` or `ps eww`; Windows: best effort, a warning only). agy: while any slot holds the account's email it refuses with 65 `agy-account-live` (hint `accshift agy use <other>`), unless `--sign-out-slot` is given (§8.3.4). Asks unless `--yes` | no |
| `rename <cli> <old> <new>` | changes only `name` in accounts.json, plus every `agyRestoreAfterRun` setting that names the old account, in one atomic write under `state.lock`. It never moves directories, vault entries or state, which are all keyed by the immutable id (§6.2), so vendor keyring keys stay valid and a running cli keeps its home. It refuses with 73 `agy-journal-pending` while `journal/agy-swap.json` exists. A LimitShift account file that still holds the old name only makes `pick --prefer` ignore it (`preferIgnored:true`) | no |
| `agy use <name> [--slot-wait S]` | put that agy account into agy's slot without running agy, so the user's own `agy` uses it (§8.3.4) | no |
| `enable <cli> <name>` / `disable <cli> <name>` | toggle selection | yes |
| `order <cli> <name>…` | set preference order (named accounts first, others keep relative order) | yes |
| `list [<cli>] [--pool a,b]` | accounts with state and active limit records; read-only | **yes** |
| `status [<cli>] [--pool a,b] [--history]` | the `list` fields plus the vault header, the notice, agy's slot hint and per-account auth details; offline and read-only, never opens the keystore | **yes** |
| `pick <cli> [--prefer A] [--model M] [--pool a,b]` | choose an account for the run about to start (read-only, lock-free, §9.3) | **yes** |
| `next <cli> --from A [--model M] [--limited-model L] [--limited-until T \| --reason auth] [--run-started-at T0] [--evidence-file F] [--exit N] [--session ID] [--cwd DIR] [--pool a,b]` | record what A's failed run shows (a limit record, an auth strike, `relogin`, an `attentionCode`, or nothing, §9.3) and choose the next account, in one locked transaction. The evidence is parsed before the lock (§9) | **yes** |
| `mark <cli> --account A (--limited-until T \| --override --limited-until T \| --auth-failed \| --ok \| --clear) [--model M] [--evidence-file F] [--exit N] [--session ID] [--cwd DIR] [--run-started-at T0] [--pool a,b]` | update state without choosing (actions below) | **yes** |
| `exec <cli> [--account A \| --prefer A] [--pool a,b] [--slot-wait S] [--status-file P] [--track] [--allow-bare] [--allow-apikeyhelper] [--allow-settings-env] [--allow-base-url] -- <args…>` | run the cli as that account (§12). **The only way LimitShift launches a managed cli**; LimitShift always passes `--account` and `--status-file`. The `--allow-*` flags override the corresponding refusals of §8.1, §8.3 and §12.5 and are never used by LimitShift | **yes** (exit-code passthrough, §12.1.1) |
| `env <cli> --account A [--format sh\|ps\|cmd\|json] [--reveal-secrets]` | print the env delta for people who launch the cli themselves; secrets redacted by default, and the keystore is opened only with `--reveal-secrets` (§12.7). Exits 69 `requires-exec` when the plan has a post-run hook or holds a lock for the run (agy slot, Windows codex copy mode) | no (standalone / diagnostic) |
| `classify <cli> [--exit N] [--session ID] [--cwd DIR] [--evidence-file F\|-] [--model M] [--run-started-at T0] [--record --account A]` | classify a finished run's output (§9.4–§9.5, Appendix C). Exits 0 for every class, and 66 `evidence-unreadable` when the evidence file cannot be read. With `--record` it also stores the result for A, like `mark`, and is then a writer. `classify --record` and `next`/`mark --evidence-file` MUST NOT both be used for one run: each would record the same strike or limit (§9.2) | **yes** |
| `doctor [<cli>] [--account A] [--fix]` | diagnostics: binaries, versions, root, permissions, vault, keystore, locks, pending journals, links, env conflicts, expiries, the notice, and native identity changes (§9.6). Without `--fix` it is read-only and exits 0 whenever it ran. `--fix` makes it a writer: it tightens permissions, quarantines and recreates damaged files (§6.4), recovers a pending agy journal (§8.3.4), deletes orphaned state entries, and clears a native account's records after an identity change (§9.2). `doctor --fix` exits 0 when every repair it attempted succeeded or nothing needed one; otherwise it exits with the code of the first repair that failed, 73 (`state-busy`, `vault-busy`, `slot-busy`, `agy-busy`), 74 (`keystore-unavailable`, `agy-keyring-locked`) or 78 (for example `unsupported-filesystem`), and still prints every finding. LimitShift only calls `doctor --json`, never `--fix` | **yes** |
| `notice [--accept]` | print the provider notice (Appendix F) and whether its current version is accepted; read-only. When it is not accepted, `notice` asks at a TTY, and `y` or `--accept` writes `state.notice = {acceptedAt, version}` under `state.lock` (a writer). If it stays unaccepted (declined, or non-interactive without `--accept`), `notice` exits 65 `notice-not-accepted`. On an accepted notice, `--accept` changes nothing. This is how a user whose accounts are all registered accepts a new notice version; it is the hint of 69 `notice-not-accepted` (§10.3) | **yes** |
| `vault status` | the vault header: whether a vault exists, its key source, key id and key-file path (§7.3); read-only | **yes** |
| `vault migrate --to SOURCE` / `vault export --to FILE` / `vault import FILE` | key source management; encrypted export/import for moving machines (§7.3) | no |
| `config <key> [value]` / `config edit` | read or set one registry key by dotted path: `clis.<cli>.mainHome`, `clis.<cli>.mainSqliteHome`, `clis.<cli>.bin`, `clis.<cli>.buckets.<model>`, `clis.<cli>.shareExtra`, `settings.<key>`, `clis.<cli>.settings.<key>` (§6.2). An invalid value, such as a relative `clis.<cli>.bin` or a `clis.codex.mainHome` inside `<root>/homes/` (§8.2), exits 65 `invalid-config` and changes nothing. `config edit` opens accounts.json in `$VISUAL`/`$EDITOR` and writes it atomically under `state.lock`: 64 `usage` non-interactively, 65 `invalid-config` on an invalid edit, 73 `registry-changed` if accounts.json changed while the editor was open (§6.2) | no |
| `run <cli> [--account A] [--pool a,b] [--slot-wait S] [--wait] -- <args…>` | phase 2 interactive wrapper with automatic rotation (§16). Every failure before a child starts exits 125. When every account is capped, at the start or after a limit, it exits 125 `all-capped`, unless `--wait` is given | no |
| `self-update [--check] [--version X] [--allow-downgrade]` / `self-update --record-install script --path DIR` | optional update for script installs; `--record-install` is the installers' offline call that creates the root and writes `install.json` (§17.6, §17.7) | no |
| `completion bash\|zsh\|fish\|powershell` | shell completion script | no |

**Names in selection flags** (§9.3). They never cause exit 64:
- An empty `--prefer`, `--model` or `--limited-model` counts as absent.
- An unknown, disabled, non-member or unusable `--prefer` is ignored, and the response says `preferIgnored:true`.
- An unknown `--from` records nothing (`recorded:null`), and `next` still selects.
- Unknown `--pool` names are dropped and listed in `poolDropped`. When no account remains (including an empty `--pool`), `pick` and `next` exit 69 `empty-pool` (`exec`/`run`: 125 `empty-pool`). `list`, `status` and `mark` never exit 69: they return `accounts:[]`, `poolSize:0` and `rotationPossible:false` (§10.3).

**`next` flags** (§9.3):
- `--reason limit|auth` defaults to `limit`. `--limited-until` together with `--reason auth` is a usage error (64).
- `--model M` is the model of the **next** run and is used only for selection. `--limited-model L` is the model that hit the limit and is used only for the recorded scope; it defaults to `--model`.
- `--run-started-at T0` is when the failing run started (default now − 60 s). It decides strike escalation and the codex refresh race (§9.2).

**`mark` actions.** Exactly one action is required; none, or two, is a usage error (64). `--override` without `--limited-until` is also 64.
- `--limited-until T` records a limit like `next`. `--override --limited-until T` writes a tier-4 record, which only another `--override` replaces and only `--clear` removes (§9.4). Both write scope `model:<bucket(M)>` when `--model M` is given and maps to a bucket, else `account`.
- `--auth-failed` records one ambiguous strike, exactly like `next --reason auth` (§9.2).
- `--ok` reports success, and is the only success channel. It clears `authStrikes`, the `backoff` map and every auth-suspect record, and sets `lastOkAt` and `lastUsedAt`. It keeps limit records, `lastStrikeAt`, `relogin` and `attentionCode` (§9.2).
- `--clear` removes all records, `authStrikes`, `lastStrikeAt`, `attentionCode`, the `backoff` map and `relogin`. On an account past `expiresAt` it still does so, then exits 65 `expired` with the hint `accshift login <cli> <name>`, because only `login` replaces an expired token. `--clear --model M` removes only the records of M's bucket.
- `--evidence-file` (with `--exit`, `--session`, `--cwd` and `--run-started-at`) is accepted with `--limited-until` and `--auth-failed`, and is a usage error (64) with any other action. It is parsed as for `next`, and the §9.3 table applies with `--limited-until` as `--reason limit` and `--auth-failed` as `--reason auth`.
- `--pool` only shapes the response (`poolSize`, `rotationPossible`, `accounts[]`). `mark` selects nothing and is not subject to the notice gate.

**Time arguments.** `--limited-until` accepts integer epoch seconds, RFC 3339, or a duration (`90m`, `4h46m9s`) relative to now. `--run-started-at` accepts integer epoch seconds or RFC 3339. `--expires` accepts RFC 3339 or `YYYY-MM-DD` (00:00 UTC that day).

### 10.3 Exit codes

Summary for control verbs (full table with caller actions in Appendix E):

| Code | Meaning |
|---|---|
| 0 | success / an account is ready |
| 64 | usage error: bad, unknown or conflicting flags (`usage`), an unknown cli (`unknown-cli`), or an unknown account where a command names its target (`unknown-account`: `mark --account`, `enable`, `disable`, `order`, `login`, `remove`, `rename`, `env`, `agy use`, `doctor --account`, `classify --record --account`). Also `native-account` (`login` on a `native` account; the hint names the vendor's own login command) and input that non-interactive mode cannot get (`usage`, §10.1). Never for a `--prefer`, `--from` or `--pool` name (§10.2). `exec`/`run` report all of these as 125 |
| 65 | data error: `invalid-token` (a secret with the wrong format or prefix, §8), `duplicate-account`, `identity-mismatch`, `no-login-detected`, `securestorage-ignored`, `classic-pat-unsupported` (a `ghp_` token, §8.5), `gh-token-unavailable` (`add`/`login copilot --kind gh`, §8.5), `invalid-import` (`add codex --import-home` naming `mainHome`, §8.2), `invalid-bundle` (`vault import` with a wrong passphrase or a damaged bundle, §7.3), `notice-not-accepted` (`add`, `notice`), `account-in-use` and `agy-account-live` (`remove`), `expired` (`mark --clear` on an account past `expiresAt`), `invalid-config` (an invalid `config` value or edit) |
| 66 | `classify` only: the evidence file cannot be read (`evidence-unreadable`) |
| 69 | unavailable, only from `pick` and `next`: `empty-pool` (the cli has no accounts, every `--pool` name is unknown, or every remaining account is disabled), `unsupported-cli` (a known cli that exec cannot run on this OS), `notice-not-accepted` (hint `accshift notice --accept`); and `env`'s `requires-exec`. `list`, `status` and `mark` never exit 69: for a cli without accounts, an unsupported cli or an empty pool they return `accounts:[]`, `poolSize:0` and `rotationPossible:false`. A one-account pool is not 69: it gives 75 or 77 |
| 70 | internal error, a bug (`internal`) |
| 73 | busy: `state-busy` (`state.lock` wait), `vault-busy` (`vault.lock` wait), `slot-busy` (agy slot lock wait), `agy-busy` (an agy process accshift did not start is running), `agy-journal-pending` (`rename` while `journal/agy-swap.json` exists), `overlay-in-use` (codex `add` or `login` while a codex process uses the overlay, or `add codex --import-home` while one uses DIR, §8.2), `registry-changed` (`config edit`). A `next` that exits 73 recorded nothing; the caller repeats the same call (§15.2) |
| 74 | vault or keystore unavailable, or a secret write failed: `keystore-unavailable` (keychain locked, macOS exit 36; Secret Service locked or absent; DPAPI failure; key file missing, or with a wrong owner or mode, §7.3; a passphrase or unlock needed in non-interactive mode; timeout), `vault-changed`, `agy-keyring-locked`, `slot-write-failed` (an agy slot could not be written or verified and was restored, or the agy save-back failed for a reason other than the key or a lock, such as a full disk; §8.3.2, §8.3.3, §13.3), `keychain-prompt-required` (macOS would prompt to read back an agy item; rolled back, §8.3.3), `keychain-line-too-long` (accshift's own key item would exceed the `security -i` line limit, §7.4), `import-failed` (`add codex --import-home` could not remove the source after a cross-filesystem copy, §8.2) |
| 75 | every waiting candidate is time-limited. JSON names the soonest-free `account`, which may be `--from`, and `resetAtEpoch`. A one-account pool gives 75 naming that account (§9.3) |
| 77 | every remaining candidate needs a human: re-login, an expired token, a missing credential, or needs-attention (`needs-relogin`); for agy control verbs also `agy-slot-unregistered` |
| 78 | configuration or state error: `config-corrupt` (including a relative `clis.<cli>.bin` in accounts.json, §12.2), `config-newer-version`, `insecure-permissions` (a read-only command found a loose mode or a missing DACL), `wrong-owner`, `unsupported-filesystem` (including a mode a writer cannot tighten), `vault-corrupt`, `vault-corrupt-present`, `key-item-exists`, `unsupported-config` (`add claude --native` with `CLAUDE_CONFIG_DIR` set but empty, §8.1; a codex `ephemeral` credential store; a codex `mainHome` inside `<root>/homes/` when it is first initialised, §8.2) |
| 125 / 126 / 127 | `exec` / `run` only. 125: accshift failed before the child started, for any of the conditions above or those of §12.1.1, whatever code a control verb would use; the `error.code` is in the status file and in the one stderr line (§12.1.1), and LimitShift's per-code actions are in §15.2. 126: the cli was found but is not executable (`not-executable`, `cmd-shim-unsupported`, `wsl-windows-binary`). 127: the cli was not found (`not-found`). LimitShift treats a 126 or 127 whose status file says `launched:false` as needs-human (§15.2); with `launched:true`, or with no status file, it is the cli's own status |
| other | `exec` / `run`: the cli's own exit code; a signal death gives 128+n |

Control verbs never exit 125–127, and `exec` and `run` never exit 64–78 for their own failures.

### 10.4 Flags per command

Value flags take `--name value` or `--name=value`; a value flag given twice keeps the last value. Boolean flags take no value (`--fix`) or an explicit `--name=false`. Types:
- *name*: an account name; *names*: comma-separated account names, in order;
- *time*: integer epoch seconds, RFC 3339, or a duration relative to now; *epoch*: integer epoch seconds or RFC 3339;
- *seconds*: integer seconds or a duration (`45s`, `2m`); *path*: a file or directory path.

**Global** (every command):

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--json` | bool | false; implied as in §10.1 | machine output (§11) |
| `--home DIR` | absolute path | `ACCSHIFT_HOME`, else the OS default (§6.1) | the root directory; a relative path is 64 (125 for `exec`/`run`) |
| `--non-interactive` | bool | false; non-interactive anyway when stdin is not a TTY or `ACCSHIFT_NONINTERACTIVE=1` | never prompt (§10.1) |
| `--debug` | bool | false (`ACCSHIFT_DEBUG=1`) | redacted debug log to stderr; writers also append it to `logs/accshift.log` (§10.1) |
| `--no-color` | bool | false | plain human output |
| `--contract N` | int | 1 | contract version of the JSON output (§11.1 rule 6) |
| `--version` | bool | false | print the version and exit 0; only without a command (after `self-update` it is that command's value flag) |
| `-h`, `--help` | bool | false | print usage and exit 0 |

**Selection and recording:**

| Flag | Commands | Type | Default | Meaning |
|---|---|---|---|---|
| `--pool a,b` | `list`, `status`, `pick`, `next`, `mark`, `exec`, `run` | names | every account of the cli | the candidates, in pool order (§9.3). `list` and `status` require a cli with it |
| `--prefer A` | `pick`, `exec` (without `--account`) | name | none | sticky preference (§9.3) |
| `--from A` | `next` | name | required | the account whose run just failed |
| `--model M` | `pick`, `next`, `mark`, `classify` | string | none | `pick`/`next`: the model of the run about to start (selection); `mark`: the limited model (scope); `classify`: the model of the classified run (scope) |
| `--limited-model L` | `next` | string | the `--model` value | the model that hit the limit (recorded scope) |
| `--limited-until T` | `next`, `mark` | time | none | a reset the caller parsed from this run's output (tier 2, §9.4) |
| `--reason R` | `next` | `limit` \| `auth` | `limit` | what to record when the evidence names no class (§9.3) |
| `--run-started-at T0` | `next`, `mark`, `classify` | epoch | now − 60 s | when the failing run started (§9.2, §9.4) |
| `--evidence-file F` | `next`, `mark`, `classify` | path, or `-` for stdin | none | the failing run's captured stdout and stderr, tail-bounded to 256 KB (§9.5) |
| `--exit N` | `next`, `mark`, `classify` | int | none | the cli's exit status |
| `--session ID` | `next`, `mark`, `classify` | string | none | the vendor session or thread id, for the artifact lookup of §9.5 |
| `--cwd DIR` | `next`, `mark`, `classify` | path | none (no Claude transcript lookup) | the run's working directory, for Claude's `projects/<slug>` (§9.5) |
| `--account A` | `mark` (required), `classify --record` (required), `exec`, `run`, `env` (required), `doctor` | name | none | the target account |
| `--override`, `--auth-failed`, `--ok`, `--clear` | `mark` | bool | false | the `mark` action; `--limited-until` is the fifth (§10.2) |
| `--record` | `classify` | bool | false | also store the result for `--account` (§9.2) |

**exec and run:**

| Flag | Commands | Type | Default | Meaning |
|---|---|---|---|---|
| `--slot-wait S` | `exec`, `run`, and the control verbs that take the agy slot lock (`add agy`, `login agy`, `remove agy`, `agy use`, `doctor --fix`) | seconds | `settings.slotWaitSeconds` (30) | how long to wait for the agy slot lock (§13.1); then 125 `slot-busy` / `agy-busy`, or 73 for control verbs |
| `--status-file P` | `exec` | path | none | write the status file (§11.2, §12.1.1). LimitShift MUST pass it. A path that cannot be written before launch (for example its directory does not exist) is 125 `usage`. `run` has no `--status-file` |
| `--track` | `exec` | bool | false | force the spawn path (§12.3), so the status file is rewritten after the child exits with `exitCode` and the post-run fields |
| `--allow-bare` | `exec` | bool | false | override `bare-ignores-token` (§8.1) |
| `--allow-apikeyhelper` | `exec` | bool | false | override `apikeyhelper-overrides-token` (§8.1) |
| `--allow-settings-env` | `exec` | bool | false | override `settings-env-overrides-token` (§8.1) and `agy-env-overrides-slot` (§8.3) |
| `--allow-base-url` | `exec` | bool | false | override `base-url-would-receive-token` (§12.5) |
| `--wait` | `run` | bool | false | when every account is capped, wait for the soonest reset and relaunch, instead of exiting 125 `all-capped` |

**Account management:**

| Flag | Commands | Type | Default | Meaning |
|---|---|---|---|---|
| `--accept-notice` | `add` | bool | false | accept the provider notice (Appendix F) without a prompt; the only way without a TTY |
| `--label L` | `add`, `login` | string | none (decoded where the vendor file allows) | the account's label. Required for user-asserted identities; on `login` it MUST equal the current label (§8) |
| `--token-stdin` | `add`, `login` | bool | false | read the secret as one line from stdin (secret-bearing kinds, §8) |
| `--native` | `add` (claude, codex, copilot) | bool | false | register the cli's default login; the same as `--kind native` |
| `--kind K` | `add` | claude `token` \| `login-slot`; codex `home` \| `access-token` \| `api-key`; copilot `token` \| `gh`; and `native` for these three clis | claude `token`, codex `home`, copilot `token`; agy is always `slot` | the account kind (§8) |
| `--experimental` | `add` | bool | false | required for experimental kinds (claude `login-slot`) |
| `--force` | `add claude` | bool | false | allow a label another claude account already uses (§8.1) |
| `--browser` | `add codex`, `login codex` | bool | false | the PKCE browser flow instead of device auth (§8.2) |
| `--import-home DIR` | `add codex` | path | none | adopt an existing Codex home by moving its `auth.json` (§8.2) |
| `--capture-current` | `add agy` | bool | false | register the account now in agy's slot, without running agy (§8.3.4) |
| `--expires DATE` | `add copilot` | RFC 3339 or `YYYY-MM-DD` | none | the PAT's expiry, for `doctor` warnings (§8.5) |
| `--gh-user LOGIN` | `add copilot --kind gh` | string | required | the gh account whose token `exec` fetches (§8.5) |
| `--gh-host HOST` | `add copilot` (kinds `token` and `gh`) | string | `github.com` | the GitHub host, stored as `identity.host`; a host other than `github.com` sets `COPILOT_GH_HOST` for runs (§8.5) |
| `--key-source S` | `add` (only when it creates the vault) | `keychain` \| `secret-service` \| `dpapi` \| `key-file` | `ACCSHIFT_KEY_SOURCE`, else the OS default (§7.3) | the new vault's key source |
| `--force-new-vault` | `add` | bool | false | create a vault although `vault.v1.bin.corrupt-*` exists (§7.3) |
| `--new-identity` | `login` | bool | false | accept a different identity: add-time dedupe, then clear all records (§8) |
| `--yes` | `remove` | bool | false | do not ask; required non-interactively (else 64) |
| `--keep-home` | `remove` | bool | false | keep the overlay directory; its id is never reused (§6.2) |
| `--sign-out-slot` | `remove agy` | bool | false | sign the account out of agy's slot and park the bytes as `agy/_unregistered/<email>` (§8.3.4) |

**Other commands:**

| Flag | Commands | Type | Default | Meaning |
|---|---|---|---|---|
| `--format F` | `env` | `sh` \| `ps` \| `cmd` \| `json` | `ps` on Windows, else `sh` | the output format (§12.7) |
| `--reveal-secrets` | `env` | bool | false | print secret values; opens the keystore |
| `--fix` | `doctor` | bool | false | apply the repairs of §10.2 (writer) |
| `--accept` | `notice` | bool | false | accept the current notice version without a prompt; the only way without a TTY (§10.2) |
| `--history` | `status` | bool | false | append recent events from `events.jsonl` (§9.6); human output only, ignored with `--json` |
| `--to SOURCE` | `vault migrate` | key source, as `--key-source` | required | the new key source (§7.3) |
| `--to FILE` | `vault export` | path | required | the bundle to write (§7.3) |
| `--check` | `self-update` | bool | false | report whether an update exists; change nothing |
| `--version X` | `self-update` | version | the latest release | the target version (§17.7) |
| `--allow-downgrade` | `self-update` | bool | false | allow a target older than the running version |
| `--record-install METHOD` | `self-update` | `script` | none | offline: create the root and write `install.json` (§17.6) |
| `--path DIR` | `self-update --record-install` | path | required | where the installer put the binary |

`order`, `rename`, `enable`, `disable`, `agy use`, `vault status`, `vault import FILE`, `config` and `completion` take only positional arguments and the global flags (`agy use` also `--slot-wait`).

## 11. Output contract ("contract 1")

### 11.1 Framing rules (MUST)

1. With `--json`, stdout carries **exactly one line** of JSON (no BOM), terminated by `\n`, and nothing else. The line is **pure ASCII**: every code point above U+007E is written as a `\uXXXX` escape (surrogate pairs for astral characters). Windows PowerShell 5.1 decodes a native command's stdout with the OEM code page, so raw UTF-8 would arrive mangled; a Pester test under 5.1 round-trips a U+2019 snippet.
2. Every response object has `"contract": 1` at its top level. Absent values are `null`, not omitted. Arrays are always arrays, even with one element or none.
3. Keys are camelCase. **No two keys in one object may differ only in case** (Windows PowerShell 5.1 `ConvertFrom-Json` rejects that) [R08 C3].
4. Every timestamp is given twice: `fooEpoch` (integer seconds) and `foo` (RFC 3339 UTC). Both forms MUST denote the same instant (a schema test checks every pair). Callers in bash and PowerShell SHOULD use the epoch form, because PowerShell 7 silently converts ISO strings into DateTime [R03 C8].
5. Errors still print one JSON line, together with a non-zero exit code:
   - `pick` and `next` print their full response shape (§11.2) on 0 and 75, where `error` is `null`, and on 69 and 77, where `error` is set. `mark` prints the same shape on 0, and on `--clear`'s 65 `expired` with `error` set.
   - `doctor` prints its own shape whenever it ran, including `doctor --fix`'s 73, 74 and 78 (§11.2).
   - Every other failure of any command (for example 64, 73, 74 or 78) prints `{"contract":1,"error":{"code":"<kebab-id>","message":"<human text>","hint":"<what to do>"}}`. `hint` may be `null`.
6. Additive changes (new fields, new enum values listed as "may grow") stay contract 1. Removing or renaming a field, or changing a type or exit-code meaning, requires contract 2. A binary MAY serve several contracts with `--contract N`.
7. `exec`, `env --format sh|ps|cmd` and `run` never write JSON to stdout; their stdout is the child's (or the env script). `exec`'s machine-readable result is its status file (§11.2).
8. **Read-only commands:** `version`, `list`, `status`, `pick`, `doctor` without `--fix`, `classify` without `--record`, `vault status`, and `notice` without `--accept` (unless the user answers `y` at its prompt).
   - They take no lock and make no state, vendor or file-system write: no rename, migration, backup, recreation, `chmod` or re-ACL. They migrate an older file version in memory only, and never create the root. Their `--debug` log goes to stderr only (§10.1).
   - A file they cannot parse gives 78 `config-corrupt`, and a loose mode or missing DACL gives 78 `insecure-permissions`; they change nothing (§6.1, §6.4). `version` still works, and `doctor` reports these as findings.
   - LimitShift's dry-run and `--validate-only` can therefore call them without side effects.

   **Writers:** `next`, `mark`, `enable`, `disable`, `order`, `config`, `classify --record`, `doctor --fix`, `notice --accept` (or `notice` answered `y`), `exec`, `add`, `login`, `remove`, `rename`, `agy use`, `vault migrate`, `vault export`, `vault import`, `run`, `env` (overlay link refresh only) and `self-update`. A writer changes accounts.json and state.json only under `state.lock`, and only a writer holding it may quarantine or recreate a file (§6.3, §6.4).

### 11.2 Responses

The examples share one scenario (the §6.3 snapshot): claude `main` (id `e04b7d93`, `native`) and `work` (id `3f9a01c2`, `token`). At 10:40Z on 2026-10-07, `work` hit its five-hour limit, which resets at 3pm Europe/Kyiv (12:00Z). Since 10:20Z it also has a weekly Opus record that resets on Oct 12 at 9am Kyiv (06:00Z).

**`version --json`**
```json
{"contract":1,"name":"accshift","version":"0.3.0","commit":"abc1234","goos":"darwin","goarch":"arm64",
 "root":"/Users/me/Library/Application Support/accshift","rootSource":"default",
 "contracts":[1],"supportedClis":["claude","codex","agy","copilot"],"experimental":["agy","copilot"],
 "capabilities":{
   "claude":{"sessionPortable":true,"lockScope":"none","usageProbe":"per-account"},
   "codex":{"sessionPortable":false,"lockScope":"none","usageProbe":"none"},
   "agy":{"sessionPortable":false,"lockScope":"machine","usageProbe":"none","dataDir":null}},
 "stderrCatalogue":["accshift: error unknown-account: no such account is registered","…"]}
```
- `supportedClis` lists every cli `exec` can run on this OS. `experimental` ⊆ `supportedClis` marks clis whose rotation is unverified on this OS: agy until that OS's V-A items pass (§8.3.5), and copilot (tier 2). LimitShift's auto mode routes an experimental cli only when the runner lists `accounts` explicitly, and `--validate-only` prints a WARNING (§15.4). The one exception is agy: while accshift has at least one agy account registered, every agy runner is routed, with or without `accounts`, under `auto` or `required`, because an unwrapped agy would race slot swaps; `--validate-only` then prints a WARNING that agy rotation is experimental on this OS.
- `capabilities` let callers adapt without hard-coding vendor knowledge. There is one entry per cli in `supportedClis` (copilot is left out of this example).
  - `sessionPortable` is the cli's default for a move between two of its accounts. `next` reports the actual value for each move.
  - `lockScope` = `machine` means runs of that cli serialize across all queues on the machine.
  - `dataDir` (agy only) tells LimitShift where agy's transcripts are. It is always the user's default, and accshift never moves it. The path comes from agy `facts.go` and is `null` on an OS whose path V-A2 has not yet recorded (macOS and Windows today, §8.3.1), as in this darwin example.
  - `usageProbe` = `per-account` means each account entry says whether `claude -p /usage` works for it. It is true only for `native`; `token` is inference-only [R04 C5], and `login-slot` is false because short-lived probes can spend its refresh token [R09 C3]. LimitShift never runs `/usage` for a routed claude runner (§15.6); the field is informational for standalone use.
- `stderrCatalogue` lists, verbatim, every line `exec` can write to stderr. Messages interpolate nothing (§12.1.1), so the list is exhaustive. Each release also ships it as `testdata/stderr-catalogue.txt`. LimitShift's own test suite asserts that its limit and auth regexes match none of these lines.

**`list [cli] --json`** (snapshot at 2026-10-07T10:45:00Z)
```json
{"contract":1,"cli":"claude","poolSize":2,"rotationPossible":true,"poolDropped":[],
 "accounts":[
  {"name":"main","id":"e04b7d93","kind":"native","label":"me@example.com","state":"ready","reason":null,"enabled":true,"usageProbe":true,
   "limitedUntil":null,"limitedUntilEpoch":null,"limitType":null,"limitSource":null,"limits":[],
   "expiresSoon":false,"expiresAt":null,"expiresAtEpoch":null,"lastUsedAt":null,"lastUsedAtEpoch":null},
  {"name":"work","id":"3f9a01c2","kind":"token","label":"me@work.example","state":"limited","reason":"limit","enabled":true,"usageProbe":false,
   "limitedUntil":"2026-10-12T06:00:00Z","limitedUntilEpoch":1791784800,"limitType":"seven_day_opus","limitSource":"text",
   "limits":[
    {"kind":"limit","scope":"account","until":"2026-10-07T12:00:00Z","untilEpoch":1791374400,"tier":3,"limitType":"five_hour","limitSource":"structured"},
    {"kind":"limit","scope":"model:opus","until":"2026-10-12T06:00:00Z","untilEpoch":1791784800,"tier":2,"limitType":"seven_day_opus","limitSource":"text"}],
   "expiresSoon":false,"expiresAt":"2027-10-01T10:05:00Z","expiresAtEpoch":1822385100,"lastUsedAt":"2026-10-07T10:40:00Z","lastUsedAtEpoch":1791369600}]}
```
- Without a cli, `list` returns `{"contract":1,"clis":[{…per-cli object without contract…}]}`.
- An account entry has: `name`, `id` (immutable, §6.2), `kind`, `label`, `state` and `reason` (§9.2), `enabled`, `usageProbe`, the summary fields, `limits`, `expiresSoon`, `expiresAt`, and `lastUsedAt`.
- `limits` lists every active record as `{kind, scope, until, untilEpoch, tier, limitType, limitSource}` (§9.1). An auth-suspect record has `kind:"auth-suspect"`, `limitType:null` and `limitSource:"auth"`.
- The summary fields (`limitedUntil`, `limitedUntilEpoch`, `limitType`, `limitSource`) describe the record with the latest `until` among those that block a model-less request. That is why `work` shows the Opus record: a run without `--model`, or with an Opus model, cannot use `work` before Oct 12, while `pick --model <a Sonnet model>` can use it from 12:00:30Z.
- `untilEpoch` and `limitedUntilEpoch` are the stored reset, without the 30 s skew margin (§9.3).

**`status [cli] --json`**: the `list` object, plus:
- at the top level, `vault: {exists, keySource, keyId, keyFilePath}` (the `vault status` fields, from the header only) and `notice: {accepted, version, acceptedAt, acceptedAtEpoch}`, where `accepted` is true when `version` is the binary's current notice version;
- in the agy per-cli object, `agySlot: null | {owner, store, writtenAt, writtenAtEpoch, saveBackPending}`. `owner` is the name of the registered account whose id state.json records, or `null`. It is only the hint of §6.3: `status` never opens the keystore and never reads the slots;
- in every account entry, `relogin: null | {reason, since, sinceEpoch}`, `attentionCode`, `authStrikes`, `lastStrikeAt`/`lastStrikeAtEpoch`, `lastOkAt`/`lastOkAtEpoch`, `utilization: null | {<window>: fraction, observedAt, observedAtEpoch}` (display only, §9.3), and for agy `wrongAccount: null | {expected, found, observedAt, observedAtEpoch}` (emails, §8.3.3).

Without a cli, `status` returns `{"contract":1,"vault":{…},"notice":{…},"clis":[…]}`.

**`pick` / `next` / `mark --json`** (`next claude --from work --model M --evidence-file F --exit 1 --run-started-at T0 --session U --cwd D` at 10:40Z, where M is a model in the `sonnet` bucket; the tier-3 reset comes from the Claude transcript that `--session` and `--cwd` locate, §9.5)
```json
{"contract":1,"cli":"claude","account":"main","previous":"work","switched":true,"available":true,
 "resetAt":null,"resetAtEpoch":null,"poolSize":2,"rotationPossible":true,"poolDropped":[],"preferIgnored":false,
 "sessionPortable":true,"sessionPortability":"likely",
 "recorded":{"account":"work","class":"limit","kind":"limit","scope":"account","until":"2026-10-07T12:00:00Z","untilEpoch":1791374400,
             "tier":3,"limitSource":"structured","resetConfidence":"exact","limitType":"five_hour","relogin":null,"attentionCode":null},
 "accounts":[
  {"name":"main","state":"ready","reason":null,"limitedUntil":null,"limitedUntilEpoch":null,"limits":[]},
  {"name":"work","state":"limited","reason":"limit","limitedUntil":"2026-10-12T06:00:00Z","limitedUntilEpoch":1791784800,
   "limits":[
    {"kind":"limit","scope":"account","until":"2026-10-07T12:00:00Z","untilEpoch":1791374400,"tier":3,"limitType":"five_hour","limitSource":"structured"},
    {"kind":"limit","scope":"model:opus","until":"2026-10-12T06:00:00Z","untilEpoch":1791784800,"tier":2,"limitType":"seven_day_opus","limitSource":"text"}]}],
 "error":null}
```
The same call with `--pool work` (a one-account pool) exits 75:
```json
{"contract":1,"cli":"claude","account":"work","previous":"work","switched":false,"available":false,
 "resetAt":"2026-10-07T12:00:30Z","resetAtEpoch":1791374430,"poolSize":1,"rotationPossible":false,"poolDropped":[],"preferIgnored":false,
 "sessionPortable":true,"sessionPortability":"yes","recorded":{…as above…},"accounts":[{…work as above…}],"error":null}
```
Field rules:
- `account`: the chosen account. On 75 it is the soonest-free account, which may be `--from` (§9.3). It is `null` on 69 and 77, and always for `mark`.
- `available`: true on exit 0; false on 69, 75 and 77; `null` for `mark`.
- `previous`: `--from` for `next`; `null` for `pick` and `mark`.
- `switched`: true when `account` and `previous` are both non-null and differ. It is always false for `pick` and `mark`.
- `resetAt` / `resetAtEpoch`: on 75, the chosen account's effective reset **plus the 30 s skew margin**, the first instant accshift itself will return it as usable (§9.3); otherwise `null`. Stored values (`recorded.untilEpoch`, `limitedUntilEpoch`, `limits[].untilEpoch`) never include the margin. Callers add their own sleep buffer.
- `poolSize` and `rotationPossible` (true when at least 2 pool accounts are neither `disabled` nor `needs-*`, §9.3); `poolDropped`: the unknown `--pool` names that were dropped, else `[]`.
- `preferIgnored`: true when `pick` ignored `--prefer` (unknown, disabled, non-member or unusable, or agy's live slot owner won, §9.3); false otherwise and always for `next` and `mark`.
- `sessionPortability`: `yes`, `likely`, `possible`, `unlikely` or `no`, for the move from `previous` to `account` (§8). `sessionPortable` is true only for `yes` and `likely`. A move to the same account is `yes`. Both are `null` for `pick`, for `mark`, and when `account` is `null`.
- `recorded`: `null` for `pick` and for an unknown `--from`. Otherwise it says what this call stored for `--from` (`next`) or `--account` (`mark`, `classify --record`):
  - `class`: the evidence class that decided (§9.3 table). Without one, it is `limit` or `auth` from `--reason`, `--limited-until` or `--auth-failed`; for `mark --ok` it is `ok` and for `mark --clear` it is `clear`. A class that stores nothing (for example `transient` after a codex refresh race, §9.2) still appears here.
  - `kind`, `scope`, `until`, `untilEpoch`, `tier`, `limitSource`, `resetConfidence`, `limitType`: the record this call wrote, after the merge rule of §9.4; all `null` when it wrote none.
  - `relogin`: the reason this call set (`rejected`, `refresh-dead`), else `null`. `attentionCode`: the code this call set, else `null`.
- When `recorded.scope` is `account`, the caller SHOULD skip its remaining models on that account (§15.2).
- `accounts`: every account named by `--pool` after dropping unknown names, or every account of the cli, in candidate order, disabled ones included. Each entry is `{name, state, reason, limitedUntil, limitedUntilEpoch, limits}` with the `list` meanings.
- `error`: `null`, or `{code, message, hint}` on 69 (`empty-pool`, `unsupported-cli`, `notice-not-accepted` with the hint `accshift notice --accept`), 77 (`needs-relogin`) and `mark --clear`'s 65 (`expired`).
- `mark` returns this shape with `recorded` filled and `account:null` (§9.3).

**`enable` / `disable` / `order --json`** → `{"contract":1,"cli":"claude","accounts":[…]}`, with the `list` account entries after the change.

**`vault status --json`** → `{"contract":1,"exists":true,"keySource":"keychain","keyId":"…","keyFilePath":null}`. With no vault, `exists` is false and the other fields are `null`. It reads only the vault header (§7.3).

**`env <cli> --account A --format json`** (standalone/diagnostic; not part of the LimitShift contract)
```json
{"contract":1,"cli":"claude","account":"work","set":{"CLAUDE_CODE_OAUTH_TOKEN":"<redacted:claude/3f9a01c2>"},
 "unset":["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_RETRY_WATCHDOG","…"],"secretNames":["CLAUDE_CODE_OAUTH_TOKEN"]}
```
- Values are revealed only with `--reveal-secrets`. A redacted value names the account's `secretId`.
- When the plan has a post-run hook or holds a lock for the run (agy slot, Windows codex copy mode), `env` exits 69 with `error.code:"requires-exec"` (§12.7).

**`classify --json`**
```json
{"contract":1,"cli":"codex","class":"limit","scope":"account","limitType":"usage_limit",
 "resetAt":"2026-10-07T15:45:00Z","resetAtEpoch":1791387900,"tier":3,"limitSource":"structured","resetConfidence":"exact",
 "retrySameAccount":false,"rotate":true,"attentionCode":null,
 "snippet":"You’ve hit your usage limit. Try again at 3:45 PM.","sessionId":"0199…","recorded":null}
```
- `class` is one of: `ok`, `limit`, `transient`, `auth`, `auth-definitive`, `blocked` (sets `attentionCode`, so the account becomes `needs-attention`), `session-lost`, `resume-incompatible`, `config-error`, `error`, `unknown`. It may grow. `blocked` is the only name for a provider block; there is no `blocked-account` (§9.4).
- `resetAt` / `resetAtEpoch` are the reset the evidence states, exactly as a record would store it (no skew margin); `tier` is the tier that reset would get (§9.4). All three are `null` when the class carries no reset.
- `retrySameAccount` and `rotate` tell a caller without its own policy what to do; for example Copilot `session_quota_exceeded` is class `error` with `rotate:false` (§9.4).
- `snippet` is masked (§14.4) and at most 200 characters. (The example shows the decoded text; on the wire the `’` is `\u2019`, rule 1.)
- `recorded` is `null` without `--record`; with it, it has the `next` meaning.
- `classify` exits 0 for every class, and 66 `evidence-unreadable` when the evidence file cannot be read.

**`doctor --json`** → `{"contract":1,"ok":false,"root":"…","rootSource":"default","findings":[{"severity":"error|warn|info","cli":"agy","account":null,"code":"secret-service-locked","message":"…","hint":"…"}]}`
- `doctor` without `--fix` exits 0 whenever it ran; only a usage error is non-zero (64). Callers read `ok`, which is false when any finding has severity `error`.
- `doctor --fix` exits 0 when every repair it attempted succeeded or nothing needed one. Otherwise it exits 73, 74 or 78 with the code of the first repair that failed (§10.2), and still prints this shape: the failed repair stays an `error` finding whose `code` is that `error.code`. LimitShift only calls `doctor --json`, never `--fix`.

**`notice --json`** → `{"contract":1,"notice":{"accepted":true,"version":1,"acceptedAt":"2026-10-01T10:05:00Z","acceptedAtEpoch":1790849100}}`: the `status` notice object, after any acceptance this call made. The notice text is human output only. A declined or unanswered notice exits 65 `notice-not-accepted` with the plain error object (rule 5).

**exec `--status-file`** (one contract-1 line; semantics in §12.1.1)
```json
{"contract":1,"launched":true,"cli":"agy","account":"a","exitCode":0,"error":null,"addedArgs":[],
 "foreignAgy":false,"wrongAccount":null,"postRunError":null}
```
- On the execve path it is written just before execve with `launched:true` and `exitCode:null`. If execve returns, exec rewrites it with `launched:false` and the error, then exits 125, 126 or 127. On the spawn path it is rewritten after the child exits.
- `account`: the account exec ran or tried to run (the picked one without `--account`), else `null`. `exitCode`: the status exec exits with (the child's, 128+n, or 125–127 when `launched` is false).
- `error`: `null`, or `{code, reason}` for a failure before the child started. `reason` refines the code, for example `missing` or `expired` for `needs-relogin`, else `null`.
- `addedArgs`: the arguments exec prepended, at most the single secret-isolation argument of §7.6, else `[]`.
- `foreignAgy`: true when agy's shared fast path ran while an agy process accshift did not start was running (§8.3.3); false otherwise.
- `wrongAccount`: `null`, or `{expected, found, observedAt, observedAtEpoch}` (agy; emails, §8.3.3).
- `postRunError`: `null`, or `{code, reason}` when a post-run hook failed or was skipped (for example `save-back-failed`, `agy-slot-unregistered`, `copy-back-conflict`, `copy-back-skipped`, `copy-back-failed`; `reason` refines the code, else `null`). Post-run failures never change the exit status.

### 11.3 Caller recipes

LimitShift exports `ACCSHIFT_NONINTERACTIVE=1` for every call. It omits `--pool` when the runner has no pool and `--limited-until` when it parsed no reset from this run's output. It passes `--session` and `--cwd` for claude and codex only (§15.2), so `next` can read the transcript or rollout (§9.5). Every exit other than 0 and 75 goes to §15.2's per-code rules; a cli runs unwrapped only under the legacy rule there.

**bash (jq):**
```bash
export ACCSHIFT_NONINTERACTIVE=1
out=$("$ACCSHIFT" next claude --from "$acct" --model "$next_model" --limited-model "$model" \
        --evidence-file "$last_run_file" --exit "$cli_rc" --run-started-at "$run_start" \
        ${sid:+--session "$sid" --cwd "$project_path"} \
        ${pool:+--pool "$pool"} ${parsed_reset:+--limited-until "$parsed_reset"} --json); rc=$?
case $rc in
  0)  acct=$(jq -r .account <<<"$out") ;;                                         # switch now
  75) acct=$(jq -r .account <<<"$out"); wake=$(jq -r .resetAtEpoch <<<"$out") ;;  # rest until wake, then run on acct
  *)  code=$(jq -r '.error.code // empty' <<<"$out" 2>/dev/null) ;;               # 69/73/77/78/...: §15.2
esac
```

**PowerShell 5.1 / 7** (StrictMode 2.0-safe):
```powershell
$env:ACCSHIFT_NONINTERACTIVE = '1'
$acctArgs = @('next', 'claude', '--from', $acct, '--model', $nextModel, '--limited-model', $model,
              '--evidence-file', $lastRunFile, '--exit', $cliRc, '--run-started-at', $runStart, '--json')
if ($sid) { $acctArgs += @('--session', $sid, '--cwd', $projectPath) }   # claude and codex only (§15.2)
if ($pool) { $acctArgs += @('--pool', $pool) }
if ($parsedReset) { $acctArgs += @('--limited-until', $parsedReset) }
$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
try { $raw = & $AccShift @acctArgs 2>$null; $rc = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
$j = $null; try { $j = (@($raw) -join "`n") | ConvertFrom-Json } catch {}
if ($rc -eq 0) { $acct = $j.account }
elseif ($rc -eq 75) { $acct = $j.account; $wake = [DateTimeOffset]::FromUnixTimeSeconds([long]$j.resetAtEpoch).LocalDateTime }
```
`$wake` is a local `[datetime]`, the type LimitShift's ps1 runners keep in `$limitedUntil[]` and pass to their wait functions (§15.3).

---
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
## 16. Phase 2: interactive `run` wrapper

Purpose: give people (not LimitShift) the "keep going on another account" behaviour in an interactive terminal session, replacing ai-switcher's `ais run`.

`accshift run <cli> [--account A] [--pool a,b] [--slot-wait S] [--wait] -- <args…>` (flags: §10.4):
- **Exit codes as for `exec`** (§12.1.1): every failure before a child starts exits 125, with one stderr line `accshift: error <code>: <catalogue message>` and a code from the closed set; 126 and 127 cover the binary; otherwise `run` returns the last child's status (128+n for a signal death). It never exits 64–78 or 75 for its own failures.
- **Never prompts before launch.** Pre-launch credential handling takes the non-interactive branch, as in `exec` (for example 125 `agy-slot-unregistered`, §8.3.3 B.5). The only question `run` may ask is the one in step 6.
- `run` is a writer: it records limits as `next` does (§6.3).

1. `pick` an account, or use `--account A` under the state table of §12.1. Launch the cli with the terminal inherited (no PTY), using the spawn path of §12.3/§12.4, with these differences on POSIX:
   - the child is started with `Setpgid: true`, in its own process group, so stopping it never signals accshift or the caller's shell job (§12.3's same-group rule is for `exec` only);
   - if stdin is a TTY and accshift owns the foreground group, accshift calls `tcsetpgrp(ttyfd, childPgid)` right after start, with SIGTTOU blocked, and makes its own group the foreground again after the child exits or stops;
   - SIGTSTP and SIGCONT are relayed, so job control keeps working.

   **codex TUI launches:** for a codex launch other than `codex exec`, `run` appends `--no-daemon` unless the caller's args already select daemon behaviour (the flags are listed in codex `facts.go`) [R04 C16]. Otherwise every relaunch would leave one app-server daemon per overlay, which blocks `remove` and can race the overlay's single-use refresh token. This is a `run`-only exception to "never add arguments": `exec` never adds it (§8, §8.2).
2. **Watch only the files this session writes.** Don't scan whole directory trees every second as ai-switcher did.
   - After launch, find the newest transcript created after start: Claude `projects/<slug(cwd)>/*.jsonl` (slug rule: Appendix B); Codex `sessions/YYYY/MM/DD/rollout-*.jsonl`, in the launch date's directories (§8.2); agy, the files in its log directory (Appendix B; **VERIFY V-A2** on macOS and Windows).
   - Tail it with 500 ms polling (`os.Stat` size check, read appended bytes only).
   - Run `classify` line by line: Claude's synthetic `isApiErrorMessage` + `error:"rate_limit"` lines; Codex `token_count.rate_limits.rate_limit_reached_type`; agy `RESOURCE_EXHAUSTED`.
3. On a limit:
   - stop the child tree: POSIX `kill(-childPgid, SIGTERM)`, then SIGKILL after 3 s; Windows: close the job;
   - restore the terminal (SGR reset, show cursor, leave the alt screen, disable bracketed paste and mouse modes, `stty sane` on POSIX);
   - record the limit and select the next account exactly as `next <cli> --from A` would, with the matched transcript lines as evidence and the launch time as `--run-started-at` (§9.3); then relaunch with the cli's resume form (Claude `--resume <id>`; Codex `resume <id>`, falling back to a fresh session with a printed note when resume is incompatible; agy `--continue`).
   - Caller args that select sessions (`--resume`, `-c`, `--continue`, `--session-id`, Codex `resume …`) are removed before the resume args are appended.
4. One-shot invocations (`-p`, `--print`, `codex exec`) are re-run as given.
5. If every account is capped, at the start or after a limit: print when the first account frees up (only when stderr is a terminal) and exit 125 `all-capped`. With `--wait`, `run` instead sleeps until `resetAtEpoch` and relaunches on that account.
6. If the child exits normally but its log showed a limit in its last second, `run` MAY ask whether to switch and resume, only when stdin is a TTY and `ACCSHIFT_NONINTERACTIVE` is not `1`. Otherwise it returns the child's exit status.

Explicitly out of scope: ConPTY or PTY emulation (inheriting the terminal is enough), and parsing the TUI's screen output.

## 17. Build, release, install and update

### 17.1 Toolchain

- **Go:** the `go` directive is `1.27`, with a `toolchain go1.27.x` line; the CI version is pinned.
- **Release flags:**
  ```
  CGO_ENABLED=0 go build -trimpath \
    -ldflags "-s -w -buildid= -X <mod>/internal/buildinfo.Version=… -X …Commit=… -X …Date=…"
  ```
- **CI guard (no cgo):** one cgo dependency would break darwin cross-builds [R01 C1, C8]. Two checks:
  - for each of the six GOOS/GOARCH pairs, `CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build ./...` must exit 0 (a cgo-only dependency then fails through the exit status, not through output);
  - with `CGO_ENABLED=1`, `go list -deps -f '{{if and .CgoFiles (not .Standard)}}{{.ImportPath}}{{end}}' ./...` must print nothing. (The plain `{{if .CgoFiles}}` form always prints `runtime/cgo` and `net` under the runner's default `CGO_ENABLED=1`.)
- **Test-only code:** test keystore overrides (`ACCSHIFT_TEST_KEYCHAIN`, the fake keystore) and test hooks (for example the artificial evidence-parse delay of §18.2) are compiled only under the `accshift_test` build tag. Release builds ignore them unconditionally, and CI asserts that the release binaries do not contain these strings.
- `import _ "time/tzdata"`.
- **No `osusergo` tag.** When `$USER` is unset, the claude slot derivation reads the user name with `os/user.Current()` (§8.1). Without cgo, that calls `getpwuid_r` through libSystem on macOS. Release builds MUST NOT use the `osusergo` build tag, whose pure-Go fallback only parses `/etc/passwd` and misses directory-service users on macOS.
- **Windows resources:** VERSIONINFO and a manifest (`asInvoker`, `longPathAware`) via goversioninfo (MIT), which helps reputation scoring.
- **Never** UPX or garble [R01 C12].

### 17.2 Targets and artifacts

Targets: `linux_amd64`, `linux_arm64`, `darwin_amd64`, `darwin_arm64`, `windows_amd64`, `windows_arm64`. All are built on **one** `ubuntu-latest` runner with **GoReleaser OSS v2.18+** [R01 C13, R09 C15].

Each release publishes:
- `accshift_<ver>_<os>_<arch>.tar.gz` (`.zip` for Windows), each containing the binary, `LICENSE`, `THIRD_PARTY_NOTICES.md` and `README.md`;
- `SHA256SUMS`;
- `SHA256SUMS.sigstore.json` (cosign v3 keyless bundle);
- `SHA256SUMS.sig` (Ed25519, used by self-update);
- `*.sbom.spdx.json` (syft);
- `install.sh`, `install.ps1`.

Release mechanics:
- Create a draft, upload everything, then publish as a **GitHub immutable release**. Build provenance comes from `actions/attest@v4`, which needs a **public** repository [R09 C14].
- Permissions for the release job: `contents: write`, `id-token: write`, `attestations: write`.

### 17.3 Versioning and channels

- SemVer `0.y.z` until 1.0. The contract version (§11) is independent of the app version.
- `main` gets CI on every push. Tags `v*` trigger releases. Nightlies are optional, as prereleases tagged `nightly-YYYYMMDD` and pruned to the last 7.
- Commit subjects follow the LimitShift / house convention chosen for the new repo. Changelog generation is automatic (§19.4).

### 17.4 Signing and trust

| Platform | v0.x | Before 1.0 |
|---|---|---|
| macOS | Go ad-hoc signature (automatic on arm64). curl/tar installs are not quarantined, so no notarization [R09 C10] | optional Developer ID plus notarization (GoReleaser OSS + quill from Linux) for browser-download users and casks |
| Windows | unsigned. Documented: Smart App Control in enforcement mode blocks unknown unsigned binaries; Defender ML false positives have been seen on Go executables [R01 C12, R09 C12] | **required:** Authenticode. Apply to SignPath Foundation (free for OSS; its policy on "circumvent" tools must be checked); fallback Certum Open Source or an OV certificate; Azure Artifact Signing only if the owner is a US or Canadian individual [R09 C13]. Keep one signing identity so reputation builds |
| Linux | n/a | n/a |

Every release candidate MUST pass a scan on a clean Windows 11 VM with Defender (x64 and arm64), plus a VirusTotal upload, before publishing.

### 17.5 Package channels

| Channel | When | Notes |
|---|---|---|
| GitHub Releases + `install.sh` / `install.ps1` | v0.1 (M1) | primary; used by LimitShift's helper |
| Homebrew tap `j-ts/homebrew-tap` | v0.2 (M2) | prefer a **source-build formula** (`depends_on "go" => :build`): no quarantine, no signing. Homebrew 6 requires explicit tap trust; the `brew trust j-ts/tap` syntax comes from secondary summaries of the release notes, so confirm it before documenting it [R09 C16] |
| Scoop bucket `j-ts/scoop-bucket` | v0.2 (M2) | x64 and arm64 |
| winget `j-ts.accshift` | v0.3 (M3) | zip with a nested portable installer (schema 1.12.0) [R09 C17] |
| AUR `accshift-bin`; `.deb` / `.rpm` / `.apk` via nfpm | v0.3 (M3) | optional |
| npm | not planned | GoReleaser's npm publisher is Pro-only, and there is no benefit for this tool |

### 17.6 Installer scripts

`install.sh` (POSIX sh: runs under dash and bash 3.2) and `install.ps1` (Windows PowerShell 5.1 and pwsh 7):
- No admin rights. Default install dir: `~/.local/bin` on Unix; `%LOCALAPPDATA%\Programs\accshift` on Windows (outside accshift's root), added to the **user** PATH as a raw registry value.
  - `ACCSHIFT_INSTALL_DIR` overrides the location.
  - **Unix PATH:** if the install dir is not on PATH, append one idempotent, marked line to the login-shell rc chosen from `$SHELL` (zsh → `~/.zprofile`; bash → `~/.bash_profile` on macOS, `~/.bashrc` on Linux; fish → `fish_add_path`), and print what was changed. `~/.local/bin` is not on PATH by default on macOS.
  - `ACCSHIFT_NO_MODIFY_PATH=1` opts out of the PATH change.
- Knobs:
  - `ACCSHIFT_VERSION` (pin; LimitShift always pins);
  - `ACCSHIFT_NO_INSTALL_RECEIPT=1`: skip the `self-update --record-install` call at the end, so no `install.json` is written. A copy installed this way is not self-updated; its owner updates it. LimitShift's helper sets it, together with `ACCSHIFT_INSTALL_DIR=<limitshift>/bin`, `ACCSHIFT_NO_MODIFY_PATH=1` and `ACCSHIFT_VERSION=<pin>`, so a bundled copy never changes the user's PATH and never takes over the receipt of a user's own install (§15.9);
  - `ACCSHIFT_ARCHIVE` (local path or URL); when it is set, `ACCSHIFT_SHA256` (the expected archive hash) is required;
  - `ACCSHIFT_REPO`;
  - `ACCSHIFT_GITHUB_TOKEN`, for a private repository only. Tokens are used **only** when this variable is set explicitly; `GITHUB_TOKEN`, `GH_TOKEN` and `gh` are never read. The token is sent only to `https://github.com` and `https://api.github.com`, never to an `ACCSHIFT_ARCHIVE` host or a redirect target, and is passed to curl or wget through stdin (`curl -H @-` or `--config -`) or a 0600 temp file, never in argv. `install.ps1` passes it with `-Headers` in-process.
- **Downloader:** `curl`, else `wget` (Alpine has busybox wget but no curl).
- **Architecture detection:**
  - Unix: `uname -s` / `uname -m`. On Darwin, use arm64 when `sysctl -n sysctl.proc_translated` prints 1 (a Rosetta shell reports `x86_64`).
  - Windows: the native architecture from `IsWow64Process2` or the `PROCESSOR_ARCHITECTURE` value under `HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`, then `[RuntimeInformation]::OSArchitecture`, then `PROCESSOR_ARCHITEW6432` / `PROCESSOR_ARCHITECTURE`, choosing native arm64. An emulated x64 PowerShell on ARM64 reports x64 through the later sources.
- **Verification** before unpacking:
  - verify `SHA256SUMS` (`sha256sum`, `shasum -a 256`, or `Get-FileHash`);
  - when `cosign` is present: `cosign verify-blob --bundle SHA256SUMS.sigstore.json --certificate-identity-regexp '^https://github.com/j-ts/accshift/\.github/workflows/release\.yml@refs/tags/v' --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS`;
  - `SHA256SUMS` comes from the same place as the archive, so on its own it only detects corruption. LimitShift's helper therefore embeds its own expected hashes (§15.9).
- macOS: `xattr -dr com.apple.quarantine` defensively.
- **Replacing a binary.** `install.sh` extracts into a temporary directory on the same filesystem as the target, runs `chmod 0755`, then `mv -f` (a rename) over the destination. It never copies, cats or untars over an existing binary in place: on Apple silicon that invalidates the kernel's cached code signature and the next launch dies with "Killed: 9". `install.ps1` renames a running exe to `.old` and then uses `Move-Item`. A macOS arm64 CI test installs vN, runs it, upgrades to vN+1 with `install.sh`, runs it again, and requires an exit status other than 137.
- `install.ps1` always uses `-UseBasicParsing` (the KB5074596 prompt) [R09 C12] and clears `PSModulePath` for Windows PowerShell child calls (the ai-switcher lesson about pwsh 7 leaking into 5.1).
- **The installers never create or write accshift's root.** After verification they run `"<bin>/accshift" self-update --record-install script --path <bin>` (skipped when `ACCSHIFT_NO_INSTALL_RECEIPT=1`), so only accshift creates the root (0700, protected DACL on Windows, §6.1) and writes `install.json` (0600) = `{"method":"script","version":"…","path":"…","installedAt":"…"}`.

### 17.7 Self-update

- `accshift self-update --record-install script --path DIR` is what the installers call after verifying a download. It makes no network call: it creates the root if needed (§6.1) and writes `install.json`.
- `accshift self-update [--check] [--version X] [--allow-downgrade]` works only when `install.json` says `method:"script"` and its `path` matches the running binary. Here `--version X` is this command's value flag; the global `--version` applies only without a command (§10.4). For package-manager installs it prints the right command (`brew upgrade`, `scoop update`, `winget upgrade`). Without a matching receipt (for example a LimitShift-bundled copy), it changes nothing and says that the copy is updated by whatever installed it.
- **Source:** the hard-coded `https://github.com/j-ts/accshift/releases/{latest|download/vX}/…`. No API calls, so the unauthenticated rate limit does not apply.
- **Verify:**
  1. the Ed25519 signature over `SHA256SUMS` against 1–2 public keys embedded in the binary (current and next, for rotation);
  2. the archive hash;
  3. the target version is parsed from the archive file name listed in the **signed** `SHA256SUMS` (`accshift_<ver>_<os>_<arch>…`), never from the `latest` redirect or the URL. It must be greater than the running version unless `--allow-downgrade`.
  
  The signing key lives in a GitHub Environment secret with required reviewers.
- **Extract safely:** write only the single expected binary entry, reject any other path, and never follow symlinks in the archive.
- **Replace atomically:** the target is `os.Executable()`, and it must match `install.json`'s `path`.
  - Unix: write next to the binary, then fsync, chmod and rename (never overwrite in place, see §17.6);
  - Windows: rename the running exe to `.old`, move the new exe in, and delete `.old` on the next start.
- **Never** update while `agy-slot.lock` is held, or during `exec` / `run`.
- Update checks are **off by default**. `settings.updateCheck: "daily"` enables a check that runs only inside an interactive **writer** command (§11.1 rule 8), at most once a day: when `state.updateCheckedAt` is more than 24 h old, the command checks and then writes `updateCheckedAt` under `state.lock` (§6.3). Read-only commands, `exec`, `run` and non-interactive invocations (§7.5) never check. `ACCSHIFT_NO_UPDATE_CHECK=1` forces checks off. A check only reports; it never updates. No telemetry.

---
## 18. Testing strategy

### 18.1 Unit tests (pure, every OS)

- `engine`: table tests over every state transition (§9.2) and selection rule (§9.3), including clamping, cooldown, no wrap-around (`next` is never cyclic, §9.3), an all-capped pool, a mixed limited and needs-relogin pool, and pool filtering. Required cases:
  - **Backoff memory:** three unknown-reset hits of one scope, each soon after the previous record expired and with unrelated writes in between, give 30, 60 and 120 minutes; a hit within 15 minutes after a record expired applies the early re-hit backoff, also after a 7-day record whose `lastHitAt` is days old, because pruning keeps a backoff entry until 24 h after the later of its `lastHitAt` and `lastUntil` (§9.4).
  - **Pool of one:** `next --from A` with the pool `[A]` records A's limit and returns 75 naming A, or 77 when A became `needs-*`; never 69 (§9.3).
  - **Merge rules 2–5** (§9.4): a lower tier only lengthens a limit; two equal-tier records observed less than 10 minutes apart keep the later `until`, otherwise the newer observation wins; a caller `--limited-until` earlier than now + `minCooldownSeconds` becomes a tier-1 unknown reset; a tier-4 override is replaced only by another override and removed only by `mark --clear`.
  - **Strikes** (§9.2): one ambiguous strike gives an auth-suspect record, not `relogin`; a strike from a run that started before the auth-suspect record expired only refreshes it; one from a run that started after it expired escalates to `relogin(rejected)`; two accounts struck within `authSuspectMinutes` are an incident, so neither escalates, both get auth-suspect records and their `authStrikes` reset; `mark --ok` clears `authStrikes`, backoff and auth-suspect records and keeps limit records and `lastStrikeAt` (so the incident window still sees that strike); `relogin` never ages out.
  - **Codex refresh race:** `refresh_token_reused` when `auth.json` was rewritten at or after `--run-started-at` records nothing (`recorded.class` `transient`); without a rewrite it sets `relogin(refresh-dead)`.
  - **Model scope** (§9.1, §9.3): a `model:opus` record does not block `pick --model <a Sonnet model>`; an unmapped `--model` is blocked by every model record; `next --model <a Sonnet model> --limited-model <an Opus model>` records scope `model:opus` and may return an account whose only active record is an Opus one.
  - **Request inputs** (§9.3): an unknown, disabled, non-member or unusable `--prefer` is ignored with `preferIgnored:true` and never exits 64; unknown `--pool` names are dropped into `poolDropped`, and an empty remainder gives `pick` and `next` 69 `empty-pool`; `next --from` an unknown account records nothing (`recorded:null`) and still selects; `pick agy` returns the usable live slot owner even when `--prefer` names another account, and `next agy` returns it when it is a usable candidate other than A; an unaccepted notice gives 69 `notice-not-accepted`.
  - **Clock:** a fake clock that jumps a year forward and back again. A record written while the clock was ahead reads as now + (`until` − `observedAt`), at most 32 days, with `clamped:true`; future `lastStrikeAt` and `lastHitAt` values are ignored for the 24 h windows (§9.4).
  - **Skew margin:** a record blocks until `until` + 30 s; `resetAtEpoch` is the effective reset + 30 s, while `recorded.untilEpoch` and `limitedUntilEpoch` show the stored value.
- `classify`: golden tests driven by a **corpus** in `testdata/corpus/<cli>/` of real vendor output.
  - Every pattern in Appendix C has at least one positive and one near-miss negative fixture.
  - New patterns MUST arrive with a verbatim fixture from a real session (no invented strings), as the ai-switcher rule already required. Appendix C marks strings that have none as `UNVERIFIED (no fixture)`, and a test asserts that each such string classifies as `unknown`, so it never drives a decision until a fixture replaces the mark.
  - Required goldens: Copilot `session_quota_exceeded` → class `error`, `rotate:false`, no record; each `AGY_ERROR` branch of §8.3.5; Codex `used_percent` 100 without `rate_limit_reached_type == "rate_limit_reached"` → no limit; Codex `workspace_*` values → `blocked`; Claude `is_error` with `api_error_status` 429 → a tier-1 limit.
  - A `^`-anchored text pattern matches inside a decoded JSON string (the `result` of `--output-format json`), not only on raw lines (§9.5).
- `timeparse`: DST edges (Europe/Berlin, America/New_York), the year rollover, a missing zone, ordinal suffixes, `~` forms, Claude's dated form with a year (`Oct 9, 2027, 3pm`), and fixed `now` values.
- `adapters` (pure parts, table tests):
  - the claude credential-slot derivation (§8.1): `CLAUDE_SECURESTORAGE_CONFIG_DIR` unset, empty and set, against `CLAUDE_CONFIG_DIR` unset, empty and set. A set-but-empty `CLAUDE_SECURESTORAGE_CONFIG_DIR` gives no suffix even when `CLAUDE_CONFIG_DIR` is set. NFC and NFD spellings of one path give the same suffix, and the raw string is hashed with no `~` expansion, symlink resolution or trailing-slash trimming. `USER` unset, empty, or failing `^[a-zA-Z0-9._-]+$` gives the OS user name or `claude-code-user` as §8.1 says;
  - codex `Portability()` (§8.2): a move to the same account is `yes`, between two users of one `chatgptAccountId` `possible`, and every other move `unlikely`, so `sessionPortable` is false for both of the latter.
- **Example pairs:** a test reads every JSON example in `SPEC.md` and every golden file and asserts that each `foo`/`fooEpoch` pair denotes the same instant, and that every `observedAt` precedes the `until` it produced.
- `vault`: encrypt/decrypt round trips, wrong key, a truncated file, header tampering (AAD on both the body and the wrapped data key), version migration, a stale header after a concurrent `vault migrate` (§7.2), and create-only key storage (a second vault never overwrites the first's key item, §7.3).
- `fsx`: atomic write under injected failures; link refresh with hostile names (`..`, absolute paths, existing real files).
- Fuzz targets (`go test -fuzz`) for `classify`, `timeparse`, the registry and state loaders, and the npm cmd-shim parser.

### 18.2 Contract tests (black-box)

- Build the real binary and run it against a temporary `ACCSHIFT_HOME`, with **fake CLIs** written in Go under `tests/fakecli/` and built in test setup.
- **Never touch the developer's real keystore.** Contract tests MUST set `ACCSHIFT_KEY_SOURCE=key-file` with an `ACCSHIFT_KEY_FILE` inside the temporary root, or use the fake-keystore build (`accshift_test` tag). CI asserts that the user's login keychain and Secret Service are unchanged after the suite; a test that touches them is a CI failure.
- The fakes also record their umask, `ulimit -c` and ignored-signal mask, which must equal the caller's (§12.3).
- The fakes record their argv, env, stdin and cwd to a file, and can emit scripted outputs (limit, auth error, success) per account, selected by the injected token or home.
- Assert every §11 response shape against the JSON schemas in Appendix D, and every exit code in Appendix E. In every response and status file the suite produces, each `foo`/`fooEpoch` pair denotes the same instant (§11.1 rule 4).
- Assert that stdout carries exactly one line under `--json` and that stderr lines start with `accshift: `.
- Assert argv passthrough byte for byte, including newlines, quotes, `%`, `^`, `&`, `|`, `<`, `>` and non-ASCII. On Windows this goes through two real npm-style `.cmd` shim fixtures: the JS template that wraps a fake node script, and the direct-target template whose target is a fake `.exe` (Claude Code's npm install, §12.4). Neither ever routes the prompt through `cmd.exe`.
- Assert stdin passthrough (a 1 MB prompt) and exit-code passthrough (0, 1, 3, 42, 75, signal → 128+n).
- agy slot tests use a **fake keystore backend** plus real temp-file slots (all three file candidates). Kill accshift with SIGKILL at every step of the swap **and** of `add agy`, and run the journal recovery (§13.3). Further cases:
  - a fake keystore that fails the B.5 vault write leaves every slot's bytes unchanged, and `exec` exits 125;
  - Linux with `DBUS_SESSION_BUS_ADDRESS` set, no detector firing and a locked fake keyring → 125 `agy-keyring-locked`, nothing written; the same with a fresh timeout marker; with a permanent detector (for example `SSH_CONNECTION` set) and a locked keyring, the run proceeds on the file slot;
  - macOS rules with every slot empty → the keychain item is written and no token file is created; a resolved slot that cannot take the blob (Windows, over 2560 B) → the first file candidate joins the write set;
  - an unregistered email in the slot refuses before any write; a credential with no identifiable owner is saved as `agy/_unknown/<sha256-8>`;
  - a fake agy process (by executable path) blocks a swap with 125 `agy-busy`; on the shared fast path it does not block, and the status file says `foreignAgy:true` while stderr stays empty;
  - two shared holders plus a swapper never produce a slot write under the shared lock, and no held lock is converted in place;
  - a stale journal and an intent marker whose pid has been reused with a different start time are treated as dead; recovery runs only after the foreign-process check, rolls back to `agy/_swap/<startedAt>`, writes nothing on a read error other than not-found, and is followed by the pruning of earlier `agy/_swap/*` entries (§7.2);
  - a run that empties every slot records `relogin(rejected)` without a save-back; another email in the slot sets `wrongAccount` in the status file; a failed post-run save-back leaves the exit status unchanged, sets `postRunError` and `saveBackPending`, and the next exclusive run saves back first;
  - two waiting swappers each keep their own intent marker in `locks/agy-slot.intent.d/`, and removing one leaves the other's in place; a shared request defers to a live marker for at most min(`--slot-wait`, 10 s);
  - an agy binary whose version cannot be read (a fake `agy --version` that times out) counts as V-A8 not passed, so the run takes the exclusive path;
  - an `AGY_LLM_GATEWAY_*` variable in the environment gives 125 `agy-env-overrides-slot` before any slot is read, unless `--allow-settings-env` is given (Appendix A.3);
  - SIGINT, SIGTERM or SIGHUP during `add agy` steps 3–6 restores the slot before accshift exits;
  - `login agy <name>` whose new sign-in has another email exits 65 `identity-mismatch` and restores the slots; `login agy` of the live account leaves the new credential in every slot that held the old one;
  - `remove agy` of the live account exits 65 `agy-account-live`; with `--sign-out-slot` it empties those slots and parks the bytes as `agy/_unregistered/<email>`.
- **exec** (§12.1, §12.1.1):
  - every failure before the child starts exits 125 (126/127 for the binary), never 64–78, with exactly one stderr line `accshift: error <code>: …` whose code is in the closed set and equals the status file's `error.code`;
  - nothing reaches stderr after the child has started, on either path and including post-run failures; `version --json`'s `stderrCatalogue` equals `testdata/stderr-catalogue.txt`, and every catalogue line starts with `accshift: ` and contains no digit;
  - the status file reads `launched:true, exitCode:null` before `execve`; when `execve` fails (`E2BIG` from an oversized argument) it is rewritten with `launched:false`; on the spawn path it carries the exit code and the post-run fields;
  - the `--account` state table: `limited` and `needs-attention` accounts run; `disabled` → `account-disabled`; an account past `expiresAt` → 125 `needs-relogin` with `error.reason:"expired"`, and nothing is written; a missing vault entry records `relogin(missing)` and gives 125 `needs-relogin` with `error.reason:"missing"`; once the entry is restored, the same account runs although `relogin(missing)` is still stored; exec never changes strikes, backoff or `lastUsedAt`;
  - without `--account`, the pick outcomes 75, 77 and 69 give 125 `all-capped`, `needs-relogin`, `empty-pool` or `notice-not-accepted`; with the notice unaccepted, `exec --account` still runs;
  - exec never prompts: with a TTY on stdin and an unregistered agy login in the slot it exits 125 `agy-slot-unregistered`;
  - copilot runs get `--secret-env-vars=COPILOT_GITHUB_TOKEN` prepended once and listed in `addedArgs`; no other argument is ever added (`run`'s codex `--no-daemon` is tested separately);
  - `env` exits 69 `requires-exec` for agy and Windows codex copy-mode plans.
- **Control verbs:**
  - flag-table conformance: every §10.4 flag parses on each of its commands in any position before `--` (`pick claude --prefer work`); an unknown flag is 64 (`exec`/`run`: 125 `usage`); an empty `--pool` gives 69 `empty-pool` from `pick` and `next`, while `list` and `status` exit 0 with `accounts:[]`, `poolSize:0` and `rotationPossible:false`, as they do for a cli with no accounts or one `exec` cannot run (§10.3); an empty or unknown `--prefer` never gives 64;
  - `mark --clear` on an account past `expiresAt` clears its records, strikes, backoff, `attentionCode` and stored `relogin`, then exits 65 `expired` with the pick/next response shape (§11.1 rule 5);
  - `doctor` warns when a native account's vendor identity differs from the recorded one, and `doctor --fix` clears that account's records;
  - with an evidence parser slowed artificially (`accshift_test` build), a concurrent `next` on another account never waits on `state.lock` for that parse (§9);
  - read-only commands (`version`, `list`, `status`, `pick`, `doctor` without `--fix`, `classify` without `--record`, `vault status`, `notice` without `--accept`) never take a lock or write, rename, migrate, chmod or re-ACL anything, even with a loose mode or a corrupt file (they exit 78 `insecure-permissions` or `config-corrupt` instead), and with `--debug` they log to stderr only and never create `logs/accshift.log`;
  - a writer quarantines a corrupt file only when a second read 200 ms later fails the same way (§6.4);
  - `rename` changes only the name: ids, vault entries, overlay paths and state keys are untouched; `remove` refuses with 65 `account-in-use` while a fake vendor process references the overlay, and a re-added name starts with no state;
  - `login` with another identity restores or removes the new credential and exits 65 `identity-mismatch`; `--new-identity` clears all records;
  - `add` with no TTY and no `--accept-notice`, and `notice` with no TTY and no `--accept`, exit 65 `notice-not-accepted`; `notice --accept` writes `state.notice` with the current version, after which `pick` no longer exits 69 `notice-not-accepted`;
  - `doctor` without `--fix` exits 0 whenever it ran; `doctor --fix` exits 0 when every repair it attempted succeeded, otherwise 73, 74 or 78 with the code of the first failed repair, and still prints every finding; `classify` exits 0 for every class and 66 for an unreadable evidence file.
- **Tier-2 adapters** (§8.4, §8.5, Appendix A.4, A.5):
  - a copilot account with a GitHub Enterprise `identity.host` gets `COPILOT_GH_HOST=<host>`; for a github.com account an inherited `COPILOT_GH_HOST` naming another host is unset;
- Windows atomic writes: a reader that holds `state.json`, `accounts.json` or `vault.v1.bin` open the way accshift's readers do (`FILE_SHARE_DELETE`) while a writer replaces it never fails the write (§13.2).

### 18.3 OS integration tests

| Platform | Keystore test | Notes |
|---|---|---|
| Linux x64 + arm64 runners | `dbus-run-session` + `gnome-keyring-daemon --unlock` (password on stdin), with the login collection unlocked; separately a locked collection (must fail fast, never hang) and no bus at all (must fall back, never autolaunch `dbus-launch`) [R07 §4] | plus an Alpine container job for the static binary, and a `/proc`-scan test for `procscan` |
| macOS arm64 and Intel (mandatory: an Intel runner while one exists, e.g. `macos-15-intel`, otherwise the amd64 binary under Rosetta 2 with `arch -x86_64`) | a temporary keychain created with `security create-keychain`, passed explicitly to every `security` call through the `ACCSHIFT_TEST_KEYCHAIN` override that exists only in `accshift_test` builds (§7.4), so the CI user's login keychain is never touched; covers 4096-byte line handling, exit 36/44/45 mapping and create-only key writes | Gatekeeper smoke test: download the release artifact with curl, run it, and assert no quarantine attribute; the install-then-upgrade test of §17.6 (no "Killed: 9") |
| Every OS | vault: a key file with the wrong owner or mode is refused (74 `keystore-unavailable`; `exec`: 125); a corrupt tag → 78 `vault-corrupt` with the file untouched; a `.corrupt-*` vault blocks creation of a new one (78 `vault-corrupt-present`); a missing or locked key never regenerates a key or overwrites the vault; `list`/`pick`/`next` never touch the keystore (asserted with a failing fake keystore) | |
| Windows x64 + arm64 runners | Credential Manager round trip (agy slot); the DPAPI key file; the job object kills the grandchild on accshift termination, including a grandchild started before accshift could have assigned it late; junction creation as a non-admin user, and junction detection by the §8.2 rule; Ctrl+C and Ctrl+Break delivery to the child (`GenerateConsoleCtrlEvent` in a test harness) | Pester tests for `install.ps1` under 5.1 and 7, and a 5.1 round trip of a `--json` line containing U+2019 (§11.1) |

### 18.4 CI gates

- Every push runs:
  - `gofmt`, `go vet`, staticcheck;
  - `go test ./...` (with `-race` on the Linux job, which uses cgo only for the test build);
  - the contract tests on all six OS/arch runners;
  - the no-cgo guard (both checks of §17.1);
  - the check that release binaries contain no test-only override strings (§17.1);
  - the stderr-catalogue check: `testdata/stderr-catalogue.txt` equals the binary's `stderrCatalogue`, every line has the `accshift: ` prefix and no digit, and no line matches the limit or auth regexes of the LimitShift releases accshift is tested with (§12.1.1);
  - `go-licenses check` with the allowlist;
  - `govulncheck` in source mode;
  - the clean-room guard (§20.3);
  - the SPDX header check.
- **Any red macOS or Linux job blocks merge and release.**
- Release jobs repeat the full matrix on the tag commit before publishing.

Additional release-pipeline checks:
- Assert each darwin/arm64 artifact carries a valid `LC_CODE_SIGNATURE`.
- Run the linux/amd64 binary in an empty scratch root and in an Alpine container, and the linux/arm64 binary on an arm64 runner.
- A WSL2 smoke job, and a WSL1 smoke job (setup-wsl with WSL1 on `windows-latest`) exercising `flock`, `prctl` and `/proc`. WSL1 stays unsupported until its job passes (§4.1).
- Size budget: at most 6 MB uncompressed and 3 MB compressed (the release archive) per target (NFR2); CI fails above that.
- NFR1 latency, measured on every OS runner as the median of 50 runs, each a new process with a warm file cache:
  - every NFR1 command without the vault (`version`, `list`, `pick`, `next`, `mark`, `status`, `classify`, each with `--json`): gated at 50 ms;
  - `exec` of a fake CLI for a claude `token` account with the `key-file` source, up to the child's start: reported against the 30 ms target, with the key-file read timed separately;
  - one vault-touching command (`exec` of a `token` account) per key source available on that runner: gated at 150 ms.

  The first execution after install or update (Defender scan, macOS assessment) is measured and reported separately, without gating.

### 18.5 Shell checks

`install.sh` and any shell glue run in CI under a source-built bash 3.2.57 and under dash [R03 C4].

### 18.6 Acceptance on real accounts (manual, per release that touches an adapter)

A checklist in `docs/acceptance.md`, run by the owner with real accounts on macOS and Linux (and Windows for releases that touch Windows code). It covers every **VERIFY** item in §22 that the release depends on. Results are recorded with the vendor CLI versions used.

## 19. Repository layout and engineering rules

### 19.1 Repository

- **Name:** `j-ts/accshift`, **public**. Public is needed for attestations, SignPath, Scoop/winget URLs and immutable releases [R09 §2.1].
- **History:** fresh, with no shared history with ai-switcher.

```
accshift/
├── cmd/accshift/main.go
├── internal/
│   ├── buildinfo/  cli/  paths/  registry/  state/  engine/  vault/  keystore/{darwin,linux,windows,fake}/
│   ├── adapters/{claude,codex,agy,copilot}/   (each with facts.go, add.go, run.go, classify.go, doctor.go)
│   ├── execx/  lockx/  fsx/  classify/{timeparse}/  procscan/  doctor/  update/  redact/
├── tests/{contract,fakecli}/
├── testdata/{corpus/{claude,codex,agy,copilot}/,stderr-catalogue.txt}
├── docs/{SPEC.md,DECISIONS.md,acceptance.md,research/,provenance/{SOURCES,DECISIONS,AI-USAGE,CLEANROOM}.md}
├── install.sh  install.ps1  .goreleaser.yaml  LICENSE  THIRD_PARTY_NOTICES.md  README.md  README.uk.md  SECURITY.md  AGENTS.md  CLAUDE.md
└── .github/workflows/{ci.yml,release.yml}
```

### 19.2 Dependencies

The allowed runtime set is small and permissive [R01 §5, R07 §6]:

| Module | Licence | Use |
|---|---|---|
| `golang.org/x/sys` | BSD-3 | flock / LockFileEx, job objects, DPAPI, junctions, Toolhelp32, prctl |
| `golang.org/x/crypto` | BSD-3 | XChaCha20-Poly1305 and Argon2id (vault) |
| `github.com/godbus/dbus/v5` | BSD-2 | Secret Service with `Connect(address)`, never the autolaunching `SessionBus()` |
| `github.com/danieljoos/wincred` | MIT | Windows Credential Manager for agy's slot (`CredWriteW` / `CredReadW` with the §8.3.1 attributes); MAY be replaced by direct `x/sys/windows` calls |
| `golang.org/x/text` | BSD-3 | `unicode/norm`: NFC normalisation of the path string hashed by the claude slot derivation (§8.1) |
| `github.com/klauspost/compress/zstd` | BSD-3 / Apache-2.0 | reading compressed Codex rollouts (`.jsonl.zst`) in `classify` |
| `github.com/josephspurrier/goversioninfo` (build-time) | MIT | Windows resources |

- **`github.com/zalando/go-keyring` is not used at runtime** on any OS. Its prompt wait has no timeout [R07 C5], and on macOS it passes no explicit keychain and no `-T` and cannot kill a timed-out `security` child, so it cannot meet §7.4. accshift drives `/usr/bin/security` itself on macOS (§7.4), its own godbus code on Linux (reproducing go-keyring's attributes `{service, username}`, its label format and the `plain` session), and Credential Manager directly on Windows. go-keyring's encodings are reproduced in agy `facts.go`. It MAY appear only in test code (`_test.go` files or the `accshift_test` build), as a byte-compatibility fixture.
- Adding any other runtime dependency requires a DECISIONS.md entry.
- CLI parsing, JSON, HTTP (self-update), Ed25519 and tzdata come from the standard library.

### 19.3 Code rules

- Each package's public functions take a `context.Context` with deadlines for any OS or external call.
- **No global mutable state.** The clock (`now`), filesystem root, environment, keystore and process launcher are injected, so tests run in parallel and hermetically.
- Errors carry a stable kebab-case `code` (used in `error.code` and `doctor` findings) plus a human message and hint.
- Every vendor constant lives in `adapters/<cli>/facts.go` with a `// verified: <vendor> <version> <date>` comment.
- Every source file starts with `// SPDX-License-Identifier: MIT`.
- The OS-specific files `*_darwin.go`, `*_linux.go` and `*_windows.go` stay small. Shared logic is in plain files and tested on every OS.
- **Lint:** `golangci-lint` with `staticcheck`, `errcheck`, `exhaustive` (every switch over states, kinds and outcomes), `nilness`, `gosec` and `govet`; warnings fail CI. Go has no sum types, so the exhaustiveness linter plus table tests stand in for the compiler on the state machine.
- **Style:** stdlib first, synchronous code. Goroutines only for timeouts, signal forwarding and output copying. No reflection-based frameworks.
- **Go toolchain bumps** (`toolchain go1.27.x` → newer) need a check of the release notes for raised platform minimums, recorded in DECISIONS.md.

### 19.4 Working agreement (for `AGENTS.md` in the new repo)

- **Forbidden sources:**
  - agm (any path or fork);
  - Hawkynt's ClaudeCodePortable;
  - `j-ts/ai-switcher` files other than the owner's own `ais*` modules (requirements only);
  - **source code** of third-party switchers (READMEs, docs and issues are fine);
  - any GPL repository source.
- Agents MUST NOT clone or fetch third-party source, or paste code from search results, and MUST log every web source in `docs/provenance/SOURCES.md` (§20.3).
- **Commits:** one concern per commit, with a meaningful subject. If the owner adopts LimitShift's `+ - * # !` prefix convention, CHANGELOG generation follows it.
- **Before each commit:** `go test ./...` plus the contract tests on the developer OS (which use a key-file or the fake keystore, never the developer's own keychain, §18.2).
- Never commit secrets, real tokens, or real vendor credential files. Corpus fixtures MUST be scrubbed: emails replaced with `user@example.com`, and ids and tokens replaced with same-length fake values.

## 20. Licensing, clean room, provenance and provider terms

### 20.1 Licence

**MIT**, the same as LimitShift: `Copyright (c) 2026 j-ts and accshift contributors` [R09 C18].
- MIT puts no restriction on commercial use, is OSI-approved (which SignPath and the package repositories need), and is compatible with every allowed dependency.
- The README claims no affiliation with Anthropic, OpenAI, Google or GitHub, and does not use their logos.

### 20.2 Dependency licence policy

- **Allow:** MIT, MIT-0, BSD-2/3-Clause, ISC, Apache-2.0, 0BSD, Zlib, BSL-1.0, CC0-1.0, Unicode-3.0.
- **Deny:** GPL, LGPL, AGPL, SSPL, BUSL, Elastic, Commons Clause, CC-BY-NC*, CC-BY-SA, any rider or field-of-use licence, and unknown or missing licences.
- Enforced in CI with `go-licenses check --allowed_licenses=…`. `THIRD_PARTY_NOTICES.md` is generated by `go-licenses report` and shipped in every archive [R09 §3.2].

### 20.3 Clean-room procedure

1. A fresh repository; nothing forked.
2. The spec (this document) and the behavioural tests are written only from these sources:
   - (a) vendor public docs;
   - (b) black-box observation of vendor CLIs and the files they write, including static inspection of released binaries for interoperability;
   - (c) READMEs and docs of permissively licensed prior art, for ideas only;
   - (d) the owner's own ai-switcher `ais*` modules, as requirements;
   - (e) the owner's LimitShift code.
3. `docs/provenance/` holds:
   - `SOURCES.md`: URL, date, licence, what was learned, and the statement "no code copied";
   - `DECISIONS.md`: ADRs citing sources;
   - `AI-USAGE.md`: which agents and models were used, plus a statement of human review;
   - `CLEANROOM.md`: these rules, and an honest note that the owner previously shipped agm as a separate binary in ai-switcher, and that accshift's mechanisms come from vendor-documented interfaces (env vars, home variables, OS credential APIs).
4. **CI guard:** fail on forbidden identifiers in the tree (`shyim`, `ClaudeCodePortable`, `Hawkynt`, `NonCommercial`, `Commons Clause`, and `agm` as a Go identifier or import path). Fail on missing SPDX headers.
5. **Optional audit:** someone allowed to view agm runs a similarity tool (e.g. JPlag or Dolos) against accshift and reports only scores.

### 20.4 Provider terms

- The README shows the notice in Appendix F. Account rotation is **opt-in**: nothing rotates until the user has accepted the notice and registered at least two accounts.
  - **Stored:** acceptance is `state.json` `notice: {acceptedAt, version}` (§6.3), never a registry field, so a hand-edited registry cannot bypass it.
  - **Shown:** every `add`, for every cli and kind (including `--native` and `--capture-current`), shows the notice when `notice` is unset or its `version` is older than the binary's, and requires `y` or `--accept-notice`; without either it exits 65 `notice-not-accepted` (§10.3).
  - **Re-accepted:** `accshift notice` prints the notice and whether its current version is accepted; `notice --accept` (or `y` at a TTY) accepts it without an `add` (§10.2). The version is bumped only when the Appendix F text changes materially.
  - **Enforced:** until `notice` holds the current version, `pick` and `next` exit 69 `notice-not-accepted` with the hint `accshift notice --accept`, and `exec` without `--account` exits 125 `notice-not-accepted`. `exec --account` still runs, because it never rotates (§9.3, §12.1). `doctor` reports a missing or outdated acceptance.
  - Rotation also needs a second usable account: `rotationPossible` is false for a pool with fewer than two accounts that are neither `disabled` nor `needs-*` (§9.3).
- Positioning: a personal and educational tool that runs the official, unmodified CLIs locally. It never signs in for the user and never proxies. It hands tokens only to the cli it launches, and refuses to do so when a base-URL setting would send them to a non-vendor host (§12.5) [R09 §3.4–3.5].

## 21. Milestones and acceptance criteria

Terms used in the exit criteria:
- **V-rows pass:** the milestone's §22 items are marked pass in `docs/acceptance.md`, each with the OS, the vendor CLI version and the date. A failed item changes this spec before the milestone closes.
- **Crash matrix green:** the §18.2 SIGKILL tests (every step of each atomic write, of the agy swap and of `add agy`) pass on all six OS/arch runners.
- **Docs complete:** `README.md`, `SECURITY.md` (containing the §7.6 threat-model text), the Appendix F notice and `AGENTS.md` exist, and a link check over them passes.
- **Released:** M1 to M6 each close by publishing a release (M1 v0.1.0, M2 v0.2.0, M3 v0.3.0, and so on up to M6 v0.6.0), and M7 publishes 1.0.0. Each §17.5 package channel starts with the release its row names.

Every §22 item is scheduled in exactly one milestone. V-A9 is scheduled in M4 but runs only if the per-directory agy mode is pursued (§8.3.6).

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0: verification spike** (before adapter coding) | Run §22 items V-C1…V-C6, V-X1…V-X5, V-X7, V-A1…V-A8, V-A10, V-A11 and V-K2 on real accounts, on macOS and Linux (V-K2: Linux only), and on Windows for the agy items, V-X2 (junctions) and V-C4 (the managed-settings path) | V-rows pass or the spec is updated (agy primary mechanism confirmed per OS, Codex portability decided, Linux default key source decided); corpus fixtures saved for V-C2, V-X3, V-X5 and V-A11 |
| **M1: core** | repo, CI matrix, release pipeline (unsigned), paths, registry/state, locks, atomic IO, vault + all key sources, `vault status` and `vault migrate`, `version/list/status/doctor/pick/next/mark/enable/disable/order/config/notice`, `self-update --record-install` (offline), `install.sh`, `install.ps1`, contract tests | every §11 response of the M1 commands validates against Appendix D; the §18.4 size gate and the 50 ms NFR1 gate for `version`, `list`, `pick`, `next`, `mark` and `status` pass on every runner; crash matrix green for the M1 writers; V-K1, V-K3 and V-W4 pass; v0.1.0 published with checksums, cosign and attestations, and installed by `install.sh` and `install.ps1` (including the §17.6 upgrade test) |
| **M2: claude** | `token`/`native` kinds, the experimental `login-slot` kind (§8.1), `add/login/remove/rename`, `exec` on every OS (the execve path on POSIX; the spawn path everywhere, with the Windows job object, native `.exe` launch and signal forwarding; the status file), `env`, `classify claude`, corpus, the Homebrew tap and the Scoop bucket (§17.5) | the §18.2 exec and control-verb tests of the M2 features green on all six runners; the remaining §18.4 NFR1 gates (`classify`, the `exec` overhead report, and the 150 ms vault-touching `exec` per key source) pass on every runner; the `classify`, `env` and status-file responses validate against Appendix D; V-W3 passes; LimitShift POC hooks run against the real binary |
| **M3: codex** | overlay homes + link refresh (POSIX symlinks, Windows junctions + copy-back), `native`/`access-token`/`api-key`, `classify codex` (incl. rollout reader), npm cmd-shim resolution (§12.4), winget and the optional AUR and nfpm packages (§17.5) | link-refresh safety tests; the Windows npm shim fixtures of §18.2 pass; V-X6 and V-W1 pass; the `resume-incompatible` path exercised against a recorded fixture |
| **M4: agy** | slot mechanism per §8.3 (keyring + file stores), lock, journal, foreign-process check, `classify agy` | crash matrix green for agy; a swap, a fast-path run and a journal recovery each recorded as passing on macOS desktop, Linux desktop, Linux SSH/headless and Windows; V-A9 passes if the per-directory mode is pursued (§8.3.6) |
| **M5: LimitShift integration** | §15.1 prerequisite fixes, v1 sh/ps1 hooks, v2-root, v2 engine, schema, validate-only, tests, docs, `tools/get-accshift.*` | LimitShift suites green on macOS (bash 3.2 + pwsh), Linux, Windows (5.1 + 7); the §15.10 scenarios pass against the real accshift; V-L1 passes |
| **M6: tier 2** | copilot (`token`/`gh`/`native`) | every Appendix C.5 pattern has a corpus fixture; V-P1…V-P3 pass; LimitShift `supportedClis` grows |
| **M7: 1.0** | `run` wrapper (§16), networked self-update (download and verify, §17.7), `vault export` / `vault import`, Windows signing, `classify` adoption flag in LimitShift | signed Windows binaries pass the Defender and Smart App Control checks (V-W2 passes); docs complete; contract 1 frozen |

## 22. Verification checklist (real machines and accounts)

Items the research could not settle offline. Each lists what to do, what decides it, and the spec section it changes. "Mac" means macOS 15/26 on Apple silicon unless stated.

| ID | Question | How to verify | Decides |
|---|---|---|---|
| V-C1 | Does `claude -p --resume <id>` continue a transcript created under account A when `CLAUDE_CODE_OAUTH_TOKEN` belongs to account B? | two Pro/Max accounts; run, hit or simulate the switch, resume; check the reply uses prior context | §8.1 portability `likely → yes/no` |
| V-C2 | Exact stream-json / json output on a real limit with a setup-token: are `rate_limit_event` and `api_error_status` emitted to stdout? Do setup-token runs share the account's 5 h / weekly buckets? | run each account into a limit with `--output-format stream-json` and `json`; save the verbatim output to the corpus | Appendix C.1, classify |
| V-C3 | Does an inference-only token leave `~/.claude.json` `oauthAccount` and caches untouched? | diff the file before and after a token run | §8.1 claims |
| V-C4 | Does a settings `env` block (user, project, local, managed, `--settings`) win over the process environment for `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_*` and `CLAUDE_CODE_RETRY_WATCHDOG`? Where are the managed-settings files on each OS? | set each variable in each layer and observe which account and endpoint are used | §8.1 settings scan |
| V-C5 | Does Claude Code remove `CLAUDE_CODE_OAUTH_TOKEN` from Bash-tool, hook and MCP-server subprocess environments? Is there a setting that does? | run `env` through the Bash tool, a hook and a stdio MCP server | §7.6, claude `facts.go` |
| V-C6 | Does `claude --version` start an OAuth refresh, or read or rewrite stored credentials, for a logged-in `native` or `login-slot` account? | run it near token expiry while watching the credential file or Keychain item and the network | §9.6 and §8.1 doctor (until it passes, `--version` runs only in an interactive `doctor`) |
| V-X1 | Codex: resume a thread from ChatGPT account A while running as account B (both personal) | `codex exec resume <id>` in B's overlay | §8.2 portability |
| V-X2 | Codex overlay with symlinked `sessions/`, `config.toml`, `history.jsonl`, plus `CODEX_SQLITE_HOME` → main: exec, exec resume, the TUI picker and rollout compression all work on macOS, Linux, Windows (junctions); the Seatbelt behaviour under workspace-write on macOS, and which directories under `CODEX_HOME` are Seatbelt writable roots there | scripted run per OS; on macOS, list the writable roots of a workspace-write run | §8.2 layout: on macOS the writable roots leave the shared allowlist and stay per-account, unless the user set `allow_symlinked_codex_home=true` |
| V-X3 | Real Codex limit transcript: `exec --json` error text plus the rollout's `token_count.rate_limits` | run into a limit | Appendix C.2 |
| V-X4 | Does Codex's default `shell_environment_policy` keep `CODEX_ACCESS_TOKEN` / `CODEX_API_KEY` out of tool subprocesses? | run `env` as a tool call under each kind | §7.6, codex `facts.go`. The remedy is a setting in the user's own `config.toml`, which the README documents; `exec` never adds `-c` |
| V-X5 | Codex: the exact error text and exit status of `codex exec resume <id>` for a thread id the account's home does not know | run it with an unknown id and with another account's id; save the verbatim output to the corpus | Appendix C.2 session-lost (UNVERIFIED until then) |
| V-X6 | Windows: does Codex's npm JS launcher change the environment (prepend its vendored ripgrep directory to `PATH`, set `CODEX_MANAGED_BY_NPM`, or more)? | diff the native child's environment against the launcher's | §12.4 step 2 (until then codex always launches through node and its JS entry) |
| V-X7 | Codex: two processes in one `CODEX_HOME` refresh at once. What does the loser report, does `auth.json` end up holding a valid token, and do its mtime and `last_refresh` change? | two `codex exec` runs on one overlay started near token expiry (or with `last_refresh` older than 8 days), and a `native` run next to the user's own codex | §8.2 concurrency, §9.2 `refresh_token_reused` rule |
| V-A1 | agy slot identity per OS: service `gemini`, account `antigravity` | Linux `secret-tool search --all service gemini`; Mac `security find-generic-password -s gemini -g`; Windows `cmdkey /list` | §8.3, Appendix B |
| V-A2 | agy fallback file path and mode: `~/.gemini/antigravity-cli/antigravity-oauth-token` vs `~/.gemini/antigravity-oauth-token` (reports 05 and 07 disagree); which file(s) the language server reads and writes (`~/.gemini/jetski-standalone-oauth-token`) during `agy -p`, in keyring and in file mode; on macOS and Windows, agy's app-data directory (token files, log directory, `conversation_summaries.db`) | log in over SSH (forces file mode on Linux) and `find ~/.gemini -name '*oauth-token*'`; repeat on a desktop session. On macOS and Windows search the whole profile: `find ~ -name '*oauth-token*' -newer <stamp>`, or `Get-ChildItem $env:USERPROFILE,$env:APPDATA,$env:LOCALAPPDATA -Recurse -Filter '*oauth-token*'`, and locate `conversation_summaries.db` and the log directory the same way | §8.3.1, Appendix B; the verified paths per OS go in agy `facts.go` |
| V-A3 | Do agy's SSH, WSL, container and no-D-Bus detectors fire on macOS and Windows too? What does agy do on Linux when the bus has no `login` collection, or the collection is locked (prompt, timeout, file fallback)? | log in over SSH to a Mac and to Windows (OpenSSH) and see which store is written; repeat on Linux with a locked and with a missing login collection | §8.3.2 store prediction and fail-closed rule; until it is recorded for an OS and agy version, macOS and Windows use the store recorded at `add agy` |
| V-A4 | agy token blob size (unmeasured; R05 C7 expects more than 2560 B) against the 2560-byte Credential Manager cap and the 4096-byte `security -i` line. Which slot does agy read after a failed keyring save, and does it read the token file when the keyring item is absent? | measure the file-mode blob size; on Windows force an over-cap save, then watch which store agy writes and later reads | §8.3.2 write set (the first file candidate joins it when the resolved slot cannot take the blob), §7.1 |
| V-A5 | Mac: is an item written by `/usr/bin/security add-generic-password -U` read by agy with no prompt? Does agy ever rewrite it with its own ACL? | swap, run agy, refresh, swap again | §7.4, §8.3 |
| V-A6 | After a slot swap with the same `~/.gemini`, does `agy -c` continue the folder's last conversation under the new account, or does the server reject it? | two accounts, one folder | §8.3 portability |
| V-A7 | `JETSKI_OAUTH_TOKEN` and `AGY_ACCOUNT`: do they select an account for `agy -p` in the normal CLI, and with what token type? | experiment | possible simpler agy mechanism (§8.3.6) |
| V-A8 | Does a running agy re-read the slot before refreshing, or keep its token in memory? Does the refresh token rotate during runs longer than an hour? | long run while watching the slot | lock-mode safety (§8.3.3) |
| V-A9 | (Only if the per-directory mode is wanted.) Does `--gemini_dir` / `--app_data_dir` move the token file, `brain/` and `conversation_summaries.db`? | experiment | §8.3.6 |
| V-A10 | Which processes read and refresh which slot: `agy -p`, the language server, the remote-control daemon, and the Antigravity desktop app with its helpers? Their executable paths per OS, and whether they share the `gemini`/`antigravity` item. Does `agy -p` leave a language server or remote-control daemon running after it exits? | process listing and slot watching during each component's use, and again after each `agy -p` exits | §8.3.1 agy executables, foreign-process check and lingering daemons (§8.3.3) |
| V-A11 | agy auth failures in `-p` mode: the stderr text, the `AGY_ERROR` JSON and the exit status for a revoked, an expired and a disabled login | revoke an account's access from the Google side, then run `agy -p`; save the verbatim output to the corpus | Appendix C.3 auth row, §8.3.5 (UNVERIFIED until then) |
| V-W1 | Windows: Ctrl+C / Ctrl+Break / console-close semantics through npm `.cmd` shims, daemons started by the CLI (for example a Codex app-server; killed with the job), and junction creation without admin | Windows 11 x64 + arm64 | §12.4, §8.2 |
| V-W3 | Windows: the job-object kill tree and Ctrl+C / Ctrl+Break / console-close semantics with the native `claude.exe` | Windows 11 x64 + arm64 | §12.4 |
| V-W4 | Windows: the DPAPI key file over OpenSSH key-based logons and Task Scheduler S4U | Windows 11 x64 + arm64 | §7.3 Windows default source |
| V-K1 | macOS: own-key reads via `/usr/bin/security` from tmux, from SSH while a GUI session is logged in, and after a reboot with no GUI login; what happens to a GUI unlock dialog when `security` is killed on timeout; the `security` cost per call | macOS 13 + 15/26 | §7.3–7.5 default source |
| V-K2 | Linux: Secret Service providers that re-lock during a session (KeePassXC on screen lock, KWallet without PAM unlock, Fedora's oo7 "scoped authorization") | Fedora, KDE, KeePassXC setups | §7.3 Linux default |
| V-K3 | macOS: a lock probe that never raises UI (candidate: the exit status of `security show-keychain-info <keychain>`) in GUI, SSH and tmux sessions, locked and unlocked | macOS 13 + 15/26 | §7.4 prompt-free probe |
| V-W2 | Defender / Smart App Control reaction to unsigned vs signed builds | clean VMs + VirusTotal | §17.4 |
| V-P1 | Copilot: real `--output-format json` envelope (`.data.*`?), resume of a session under another token; fixtures for `free_quota_exceeded` and `legacy_cap_reached`, and the format of `<date>` in `Your quota resets <date>` | real account; save each case to the corpus | Appendix C.5, §8.5, §15.1 P6 |
| V-P2 | Copilot's `--secret-env-vars` exists [R06 §2.8], and `exec` prepends `--secret-env-vars=COPILOT_GITHUB_TOKEN` (§7.6). Does it remove the token from shell-tool and MCP subprocesses in 1.0.93 and later, and is it still needed? | run `env` as a tool call and through a stdio MCP server, with and without the flag | §7.6, §12.1 `addedArgs`, copilot `facts.go` |
| V-P3 | The minimum gh version whose `gh auth token --hostname <host> --user <login>` works | run it with older gh releases | §8.5 `gh` kind, copilot `facts.go` |
| V-L1 | LimitShift ps1 hooks under real Windows PowerShell 5.1; `Invoke-NativeProcess` → accshift.exe → npm shim keeps multi-line `-p` intact; an agy task with P7 applied (`-Cli agy`) starts accshift.exe windowless, agy runs inside that hidden console, and nothing prompts | Windows 11 | §15.1 P7, §15.3, §12.4 |

---
## Appendix A: environment variables per CLI

**A.0 accshift's own variables**

| Variable | Meaning |
|---|---|
| `ACCSHIFT_HOME` | root directory (§6.1) |
| `ACCSHIFT_<CLI>_BIN` | path to the vendor binary (§12.2) |
| `ACCSHIFT_NONINTERACTIVE=1` | never prompt (§7.5). LimitShift MUST export it for every accshift invocation (§15.3). `exec` never prompts even without it; `run` asks its post-exit question (§16) only when stdin is a TTY and this is not set |
| `ACCSHIFT_JSON=1` | default to `--json` when stdout is not a TTY |
| `ACCSHIFT_DEBUG=1` | as `--debug`: redacted debug log to stderr; only writer commands also write `logs/accshift.log` (§10.1) |
| `ACCSHIFT_KEY_SOURCE` | key source at vault creation: `keychain`, `secret-service`, `dpapi`, `key-file` (§7.3) |
| `ACCSHIFT_KEY_FILE` | key file path for `key-file` at vault creation (CI, containers); afterwards the path recorded in the vault header is used (§7.3) |
| `ACCSHIFT_NO_UPDATE_CHECK=1` | disable update checks |
| `ACCSHIFT_TEST_KEYCHAIN` | test-only macOS keychain path. It exists only in binaries built with the `accshift_test` tag; release builds do not contain it (§17.1) |

Installer variables: `ACCSHIFT_INSTALL_DIR`, `ACCSHIFT_VERSION`, `ACCSHIFT_ARCHIVE`, `ACCSHIFT_SHA256` (required with `ACCSHIFT_ARCHIVE`), `ACCSHIFT_REPO`, `ACCSHIFT_NO_MODIFY_PATH=1`, `ACCSHIFT_NO_INSTALL_RECEIPT=1` (no `install.json`, for copies bundled by LimitShift, §15.9), `ACCSHIFT_GITHUB_TOKEN` (the only token the installers read, §17.6).

**A.1 claude**

| Action | Variables |
|---|---|
| always unset | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, `CCR_OAUTH_TOKEN_FILE`, `CLAUDE_CODE_SIMPLE`, `CLAUDE_CODE_RETRY_WATCHDOG`, `ANTHROPIC_UNIX_SOCKET`, `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`, `CLAUDE_CODE_OAUTH_SCOPES`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_CUSTOM_OAUTH_URL`, `CLAUDE_CODE_SUBSCRIPTION_TYPE`, `CLAUDE_CODE_RATE_LIMIT_TIER`; SHOULD also unset `ANTHROPIC_ORGANIZATION_ID` |
| `token` | set `CLAUDE_CODE_OAUTH_TOKEN`; unset `CLAUDE_SECURESTORAGE_CONFIG_DIR` only if it points into accshift's `homes/` |
| `native` | unset `CLAUDE_CODE_OAUTH_TOKEN`; `CLAUDE_SECURESTORAGE_CONFIG_DIR` passes through exactly as the user had it at `add --native` (including set-but-empty); removed only if it points into accshift's `homes/` |
| `login-slot` | unset `CLAUDE_CODE_OAUTH_TOKEN`; set `CLAUDE_SECURESTORAGE_CONFIG_DIR=<root>/homes/claude/<id>` |
| refuse (exit 125) | `ANTHROPIC_BASE_URL` with a non-Anthropic host for `token` / `login-slot` (`base-url-would-receive-token`); any settings `env` layer that sets an always-unset variable, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR` or `ANTHROPIC_BASE_URL` (`settings-env-overrides-token`) (§8.1) |
| never touch | `CLAUDE_CONFIG_DIR`, `HOME` |

**A.2 codex**

| Action | Variables |
|---|---|
| always unset | `CODEX_REFRESH_TOKEN_URL_OVERRIDE` |
| `home` | set `CODEX_HOME=<overlay>`, `CODEX_SQLITE_HOME=<mainSqliteHome>`; unset `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` |
| `native` | leave `CODEX_HOME` / `CODEX_SQLITE_HOME` as in the caller's environment, unless they point into `<root>/homes/` (then set `CODEX_HOME=<mainHome>` or unset it, §12.5); unset `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` |
| `access-token` | set `CODEX_ACCESS_TOKEN=at-…`; unset `CODEX_API_KEY`; main home (same inherited-home rule as `native`) |
| `api-key` | set `CODEX_API_KEY`; unset `CODEX_ACCESS_TOKEN`; main home (same inherited-home rule as `native`) |
| never touch | `OPENAI_API_KEY` (not used for Codex auth) |

**A.3 agy** (no selection variables: slot mechanism, §8.3). The names live in agy `facts.go`.

| Action | Variables |
|---|---|
| always unset | `AGY_ADC_AUTH`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `JETSKI_OAUTH_TOKEN` and its companion `JETSKI_TEST_GAIA_TOKEN` [R05 §c], so the stored login is used; `GOOGLE_GEMINI_BASE_URL` (the API-key endpoint) |
| refuse (exit 125) | any `AGY_LLM_GATEWAY_*` variable (`_URL`, `_API_KEY`, `_HEADERS`, `_MODELS`, `_PROXY_URL`, `_CA_CERT`, `_WIRE_PROTOCOL`) [R05 §c]: agy's enterprise-gateway auth would decide the account, not the slot. `exec` exits 125 `agy-env-overrides-slot` unless `--allow-settings-env` |
| never touch | `HOME` and `--gemini_dir`; `GOOGLE_APPLICATION_CREDENTIALS` and `GOOGLE_CLOUD_*` (they matter only with `AGY_ADC_AUTH`, which is unset); the variables agy's store detectors read, such as `DBUS_SESSION_BUS_ADDRESS`, `SSH_*`, `WSL_*` and `CLOUD_SHELL` (§8.3.2) |

**A.4 gemini**: out of scope (§8.4).

**A.5 copilot**

| Action | Variables |
|---|---|
| `token`, `gh` | set `COPILOT_GITHUB_TOKEN` (never launch without it). When `identity.host` is not `github.com`, set `COPILOT_GH_HOST=<host>`; otherwise unset an inherited `COPILOT_GH_HOST` that names another host [R06 §2.3]. Arguments: `exec` prepends `--secret-env-vars=COPILOT_GITHUB_TOKEN` unless the caller's argv already contains it, and reports it in the status file's `addedArgs` (§8.5) |
| `native` | unset `COPILOT_GITHUB_TOKEN` |
| `gh` helper only | run `gh auth token --hostname <identity.host> --user <identity.login>` with `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` removed from gh's own environment (§8.5) |
| never touch (in copilot's environment) | `COPILOT_HOME`, `COPILOT_CACHE_HOME`, `XDG_CACHE_HOME`, `GH_TOKEN`, `GITHUB_TOKEN` |

## Appendix B: vendor paths and credential slots per OS

| cli | Linux | macOS | Windows |
|---|---|---|---|
| claude credential | `<dir>/.credentials.json` (0600); Claude never uses libsecret | Keychain via `/usr/bin/security`: service `Claude Code-credentials[-<suffix>]`, account `$USER`, else the OS user name, else `claude-code-user`. Plaintext `<dir>/.credentials.json` when the Keychain write failed [R04 C2] | `<dir>\.credentials.json`; Credential Manager (user `claude-code-user`) only when `CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1` or the cached `tengu_windows_credman` flag is true [R04 C3] |
| claude managed settings (**VERIFY V-C4**) | `/etc/claude-code/managed-settings.json` (also WSL) | `/Library/Application Support/ClaudeCode/managed-settings.json` | `C:\Program Files\ClaudeCode\managed-settings.json` |
| claude history | `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<slug>/<sessionId>.jsonl` | same | same |
| codex credential | `$CODEX_HOME/auth.json` (file store default); keyring `Codex Auth` / `cli\|<sha256(home)[0:16]>` if configured | same | same, or `secrets/codex_auth.age` with key in `codex` / `secrets\|…` in keyring/auto mode |
| codex history | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl[.zst]`; sqlite at `CODEX_SQLITE_HOME` | same | same |
| agy credential | Secret Service `{service:gemini, username:antigravity}` in the login collection, **or** the CLI token file (`~/.gemini/antigravity-cli/antigravity-oauth-token`, else `~/.gemini/antigravity-oauth-token`; **VERIFY V-A2**) when a permanent detector fires (no D-Bus, container, Cloud Shell, WSL, SSH, Android) or a timeout marker is younger than 1 h (§8.3.2) | login keychain `-s gemini -a antigravity`, value prefixed `go-keyring-base64:` (via `/usr/bin/security`). The resolved slot is the store recorded in `agySlotUsed`, by default the keychain (§8.3.2). Token-file paths: **VERIFY V-A2** | Credential Manager `gemini:antigravity` (2560-byte cap; the blob size is unmeasured and R05 C7 expects it to exceed the cap, **VERIFY V-A4**), else the CLI token file under `%USERPROFILE%` (**VERIFY V-A2**) |
| agy language-server token (**VERIFY V-A10**) | `~/.gemini/jetski-standalone-oauth-token` (**VERIFY V-A2**) | the Linux path under `~`, unconfirmed (**VERIFY V-A2**) | the Linux path under `%USERPROFILE%`, unconfirmed (**VERIFY V-A2**) |
| agy keyring-timeout markers | `~/.gemini/antigravity-cli/cache/antigravity-keyring-unavailable` (CLI) and `~/.gemini/cache/antigravity-keyring-unavailable` (language server) [R05 §a] | unconfirmed (**VERIFY V-A2**) | unconfirmed (**VERIFY V-A2**) |
| agy history | `~/.gemini/antigravity-cli/{conversation_summaries.db, brain/<id>/, cache/last_conversations.json}` | the Linux path under `~`, unconfirmed (**VERIFY V-A2**) | the Linux path under `%USERPROFILE%`, unconfirmed (**VERIFY V-A2**) |
| agy log | `~/.gemini/antigravity-cli/log/` (**VERIFY V-A2**) | the Linux path under `~`, unconfirmed (**VERIFY V-A2**) | the Linux path under `%USERPROFILE%`, unconfirmed (**VERIFY V-A2**) |
| copilot credential | keychain `copilot-cli`, or `~/.copilot/config.json` (consented plaintext); env tokens outrank both | same | same |
| copilot history | `$COPILOT_HOME/session-state/<id>/` (default `~/.copilot`) | same | same |

Notes:
- **claude credential slot** [R04 §1a]. `<dir>`, `<suffix>` and the account follow the slot derivation in §8.1, kept in claude `facts.go`:
  - no suffix when `CLAUDE_SECURESTORAGE_CONFIG_DIR` is set but empty, or when it is unset and `CLAUDE_CONFIG_DIR` is unset or empty;
  - otherwise `<suffix>` is the first 8 hex digits of the sha256 of the raw NFC string of `CLAUDE_SECURESTORAGE_CONFIG_DIR` when it is set, else of `CLAUDE_CONFIG_DIR` (no symlink resolution, `~` expansion or trailing-slash trimming);
  - an account name that fails `^[a-zA-Z0-9._-]+$` becomes `claude-code-user`.
- **claude `<slug>`** [R04 §1]: the working directory with every UTF-16 code unit outside `[A-Za-z0-9]` replaced by `-` (a character outside the BMP becomes `--`). A slug over 200 characters is truncated and gets a `-<base36 hash>` suffix whose algorithm is unverified, so for such paths accshift locates the transcript by globbing `projects/*/<sessionId>.jsonl`.
- **agy on macOS and Windows.** agy's app-data directory there is unconfirmed (R07 open question), so every macOS and Windows agy path is **VERIFY V-A2**; `facts.go` records the verified paths per OS (§8.3.1).

## Appendix C: limit, auth and session signals per CLI

- Regexes are case-insensitive unless noted. `’` means U+2019. The corpus in `testdata/corpus/` is authoritative; this appendix is the starting set.
- **Where patterns apply.** Text patterns are applied to decoded message strings (the JSON `result`, `message` and `error.message` fields, after unescaping), and to raw lines only for text-mode output. A `^` anchor refers to the start of the decoded string.
- **Classes** (`classify`, §11.2): `limit` (a limit record, tiers per §9.4), `blocked` (sets `attentionCode`: sticky `needs-attention`, no limit record), `auth` (an ambiguous strike, §9.2), `auth-definitive` (sets `relogin`, §9.2), `transient` (retry the same account; no record), `error` (no state change, `rotate:false`), `session-lost` and `resume-incompatible`.
- **UNVERIFIED (no fixture)** marks a string that no research report evidences. It is not used for classification until a verbatim corpus fixture lands (§18.1), or it is removed: evidence that matches only such a string classifies as `unknown`.

**C.1 claude**

| Outcome | Signal |
|---|---|
| limit, tier 3 | stream-json `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":<s>,"rateLimitType":…}}`, or the transcript's `rate_limit_info` with the same fields [R04 §1d, §1e] |
| limit, no reset | assistant `"error":"rate_limit"`; result `is_error:true` + `api_error_status:429`. These detect a limit but carry no reset time, so they are not tier-3 evidence: the reset comes from the text row (tier 2), else the unknown-reset backoff (tier 1) |
| limit (text), tier 2 | `^(You['’]ve hit your\|You['’]ve reached your\|You['’]re out of (usage credits\|extra usage))` on the decoded `result`. Reset: `resets (?:(?P<mon>[A-Z][a-z]{2}) (?P<day>\d{1,2}),? (?:(?P<y>\d{4}),? )?)?(?P<h>\d{1,2})(?::(?P<m>\d{2}))?\s?(?P<ap>am\|pm)(?: \((?P<tz>[^)]+)\))?`, which covers `3pm`, `3:30pm`, `Oct 9, 3pm` and `Oct 9, 2027, 3pm` (the year appears when it differs) [R04 §1e] |
| blocked | assistant `error` `account_on_hold`, `verification_required`, `billing_error` or `oauth_org_not_allowed` (attentionCode = that value); text `Your org is out of usage`, `Your seat type doesn['’]t include`, `Your usage allocation has been disabled`, `Your group['’]s usage limit is set to \$0`, `This service is disabled for your org` (attentionCode `blocked-org`) |
| auth | `has no refresh token — it cannot self-heal`, `authentication_failed`, `Invalid bearer token`, `api_error_status` 401. UNVERIFIED (no fixture): `OAuth token has expired` |
| auth-definitive | `invalid_grant` on a refresh (`native`, `login-slot`) → `relogin` `refresh-dead` [R04 §1f]. Its rendered text is UNVERIFIED (no fixture) |
| session-lost | `No conversation found with session ID` |
| transient | assistant `error` `overloaded` or `server_error` [R04 §1e]. UNVERIFIED (no fixture): `api_error_status` 529 / 500–504 |

**C.2 codex**

| Outcome | Signal |
|---|---|
| limit (text), tier 2 | `You['’]ve hit your usage limit` → scope `account`; `usage limit for (?P<name>.+?)\. Switch to another model` → `model:<bucket(name)>`. Reset `try again at (?:(?P<mon>[A-Z][a-z]{2}) (?P<day>\d{1,2})(?:st\|nd\|rd\|th), (?P<y>\d{4}) )?(?P<h>\d{1,2}):(?P<m>\d{2}) (?P<ap>AM\|PM)` (local time) [R04 §2f] |
| limit, tier 1 | `try again later`: no reset, unknown-reset backoff |
| limit, tier 3 | rollout `token_count.rate_limits` of the thread, from events at or after `--run-started-at`: only when the thread's last `token_count` has `rate_limit_reached_type == "rate_limit_reached"`. Reset = the latest `resets_at` (s) among windows with `used_percent >= 100`; if no window is at 100, the later of the primary and secondary `resets_at` (resetConfidence `parsed`). `used_percent` alone is never a signal [R03 §9, R04 §2f] |
| blocked | `rate_limit_reached_type` `workspace_owner_credits_depleted`, `workspace_member_credits_depleted`, `workspace_owner_usage_limit_reached` or `workspace_member_usage_limit_reached` (attentionCode = that value); text `Your workspace is out of credits` (attentionCode `workspace-out-of-credits`), `You hit your spend cap` (attentionCode `workspace-spend-cap`). No limit record |
| auth-definitive | `since logged out or signed in to another account` → `relogin` `rejected`; `refresh_token_expired`, `refresh_token_invalidated` → `refresh-dead` |
| auth-definitive or transient | `refresh token was already used` (`refresh_token_reused`): `refresh-dead` only if the account's `auth.json` was not rewritten at or after `--run-started-at` (mtime and `last_refresh`; `native`: mtime only); otherwise `transient`, with no strike and no record. In keyring, auto or Windows secrets mode it is an `auth` strike. Plain `classify` reports `auth-definitive` (§8.2, §9.2) |
| auth | a plain 401. UNVERIFIED (no fixture): `401 Unauthorized` |
| resume-incompatible | `invalid_encrypted_content`, `could not be verified`, `organization_id did not match` |
| session-lost | `codex exec resume` of an unknown thread id. Exact text **VERIFY V-X5**; until then UNVERIFIED (no fixture): `no rollout found for thread id`, `thread not found` |

**C.3 agy**

An `AGY_ERROR` line is classified only from its JSON (row below). The other rows apply to the rest of the output.

| Outcome | Signal |
|---|---|
| limit | `RESOURCE_EXHAUSTED`, `code 429`, `Individual quota reached`, `quota (exceeded\|reached)`, `Your AI credits balance is too low`, `Out of credits`. Reset `Resets in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?` (tier 2), else unknown (tier 1) [R05 §f] |
| `AGY_ERROR: {json}` (one stderr line, exit 3) | printed for **any** model or agent failure [R05 §f]. Parse the JSON (key names in agy `facts.go`, from a corpus fixture), then, in this order: a `MODEL_CAPACITY_*` status or `Overloaded prefill queue` message → `transient`; status `RESOURCE_EXHAUSTED` or code 429 with a quota or credits message → `limit` (reset from a `Resets in …` text, else tier 1); status `UNAVAILABLE`, an HTTP 5xx code or retryable true → `transient`; status `UNAUTHENTICATED` or `PERMISSION_DENIED` → `auth` (**VERIFY V-A11**); anything else → `error`. Each branch needs a verbatim fixture before it ships (§18.1) |
| transient | `MODEL_CAPACITY_EXHAUSTED`, `Overloaded prefill queue`, `502` / `503` / `504` |
| auth-definitive | agy emptied every slot during the run. agy clears its entry on a definitive server rejection [R05 §d], so `exec` records `relogin` `rejected` itself (§8.3.3); this is not an output pattern |
| auth | texts for a revoked, expired or disabled login: UNVERIFIED (no fixture), **VERIFY V-A11** |

**C.4 gemini**: out of scope (§8.4).

**C.5 copilot**

Fields are accepted top-level and under `.data` [R06 C12].

| Outcome | Signal |
|---|---|
| limit | `session.error` with `data.errorType == "rate_limit"` (errorCode `user_weekly_rate_limited`, `user_global_rate_limited`, `user_model_rate_limited`, `integration_rate_limited`, `rate_limited`), or `data.errorType == "quota"` with errorCode `quota_exceeded` or `additional_spend_limit_reached`; also `free_quota_exceeded` and `legacy_cap_reached` (in the binary, no fixture yet: **VERIFY V-P1**). Scope `model:<bucket>` for `user_model_rate_limited`, else `account`. Reset: `auto_mode_switch.requested.data.retryAfterSeconds` (tier 3, anchored at the event timestamp); for the quota codes without it, the 1st of next month 00:00 UTC (tier 3); text `resets in ~(\d+)s` and `Your quota resets <date>` (tier 2; a `<date>` that does not parse as a full date is ignored); else tier 1 |
| error (`rotate:false`, no state change) | `session_quota_exceeded` (`You['’]ve reached the spending limit for this session`: the user's own per-session cap [R06 §2.6, C11]); `context_limit` |
| blocked | `billing_not_configured` (attentionCode `billing_not_configured`); `multiple GitHub Copilot licenses` (attentionCode `multiple-licenses`) |
| auth | `errorType ∈ {authentication, authorization}`; `contains a classic PAT and will be ignored` |
| resume-incompatible | `belongs to a different GitHub user` |

## Appendix D: JSON schemas

The schemas ship in `docs/schemas/` (JSON Schema 2020-12) and contract tests validate against them. Normative field lists follow. In D.1–D.3, `?` marks an optional key; all times in state.json are UTC epoch seconds.

- **D.1 `accounts.json`** (§6.2)
  - `{version:1, clis:{<cli>:{mainHome?, mainSqliteHome?, bin?, buckets?:{<model>:<bucket>}, shareExtra?:[name], settings?:Settings, accounts:[Account]}}, settings:Settings}`.
    - `mainHome`, `mainSqliteHome`: the vendor's main homes (codex, §8.2). `bin`: absolute path of the vendor binary (§12.2); a relative value fails validation (§6.4). `buckets`: model → bucket overrides of `facts.go` (§9.1). `shareExtra`: extra overlay link names, validated like the built-in allowlist (§8.2). `settings`: per-cli overrides of the global `settings`.
  - `Account = {id, name, kind, label?, plan?, enabled, createdAt, expiresAt?, secretId?, home?, identity?:{email?, chatgptAccountId?, chatgptUserId?, login?, host?}, extraEnv?:{[k]:string}, agySlotUsed?:{store, path, agyVersion}, notes?}`.
    - `id`: 8 lowercase hex characters, random at `add`, immutable, unique across the registry and never reused (§6.2). It keys the overlay `homes/<cli>/<id>`, the vault `secretId` `<cli>/<id>` and the state.json key `<cli>/<id>`.
    - `name` matches the account-name rule of §3 and is unique per cli. `rename` changes only `name`.
    - `kind`: claude `token` | `native` | `login-slot`; codex `home` | `native` | `access-token` | `api-key`; agy `slot`; copilot `token` | `gh` | `native` (§8).
    - `secretId` is `<cli>/<id>` for the kinds whose secret accshift holds: claude `token`, codex `access-token` and `api-key`, copilot `token`, agy `slot` (§7.1).
    - `home` is the canonical path of `<root>/homes/<cli>/<id>` (codex overlays, claude `login-slot`); only a `native` codex account may adopt a home outside the root (§6.2).
    - `identity.login` and `identity.host` (copilot): the gh login (`gh` kind) and the GitHub host, default `github.com` (§8.5).
    - `agySlotUsed` (agy): the store (`keyring`, `file` or `ls-file`, the language-server token file) and path (null for `keyring`) that agy wrote at the last `add`, `login` or `--capture-current`, with `agyVersion` (§8.3.4). On macOS and Windows it decides the resolved slot until V-A3 is recorded (§8.3.2).
  - `extraEnv` keys MUST be on the per-cli allowlist in `facts.go`. In v1 no cli has entries; the field is kept for later adapters. Any other key makes the registry invalid (exit 78 `config-corrupt`). The child gets `parent − ACCSHIFT_* − scrub + extraEnv + set` (§12.5).
  - `Settings = {minCooldownSeconds=60, unknownResetBackoffMinutes:{start=30, max=300}, earlyRehitBackoffMinutes:{start=5, max=60}, authSuspectMinutes=15, slotWaitSeconds=30, updateCheck:"off"|"daily"="off", agyRestoreAfterRun?:<agy account name>, agyAllowNetworkHome=false, keystoreProbeSeconds=3, keystoreOpSeconds=10}`. Meanings are in the §6.2 table. For a command on cli C, `clis.C.settings.<key>` beats `settings.<key>`, which beats the default; `updateCheck` is read only from the global `settings`.
  - `config` keys are dotted paths from the registry root: `clis.<cli>.mainHome`, `clis.<cli>.mainSqliteHome`, `clis.<cli>.bin`, `clis.<cli>.buckets.<model>`, `clis.<cli>.shareExtra`, `settings.<key>` and `clis.<cli>.settings.<key>` (§6.2).
- **D.2 `state.json`** (§6.3)
  - `{version:1, notice?:{acceptedAt, version}, accounts:{"<cli>/<id>": AccountState}, agySlot?:{owner, store, writtenAt, saveBackPending?}, agyBinary?:{path, size, mtime, version}, updateCheckedAt?}`.
  - `AccountState = {status, reason, records:[Record], relogin:null|{reason:"rejected"|"refresh-dead"|"expired"|"missing", since, snippet?}, authStrikes, lastStrikeAt?, attentionCode?, backoff?:{"<scope>":{hits, lastUntil, lastHitAt, rehitMinutes}}, lastUsedAt?, lastOkAt?, utilization?:{five_hour?, seven_day?, observedAt}, wrongAccount?:{expected, found, observedAt}}`.
  - `Record = {kind:"limit"|"auth-suspect", scope:"account"|"model:<bucket>", until, tier:1|2|3|4, limitSource:"structured"|"text"|"caller"|"default"|"user"|"auth", resetConfidence:"exact"|"parsed"|"guess", limitType?, observedAt, snippet?, clamped?:true}`.
  - Rules:
    - Accounts are keyed by the immutable id, never the name. `remove` deletes the entry (§10.2).
    - `tier` and `limitSource` go together: 4 `user`; 3 `structured`; 2 `text` or `caller`; 1 `default` or `auth` (§9.4). An `auth-suspect` record has scope `account`, tier 1 and limitSource `auth`.
    - `until` is the reset as stored, without the 30 s skew margin (§9.3).
    - `status` and `reason` are display caches, never used for selection (§9.2).
    - `agySlot` is a hint only (§6.3). `agySlot.owner` is an agy account id, or null. `wrongAccount.expected` and `.found` are emails; `found` may be null or belong to no registered account.
    - There is no `Record.hits`, no `earlyRehitBackoffMinutes` and no session map: backoff memory lives in `backoff` (§9.4).
- **D.3 vault plaintext:** `{version:1, entries:{"<secretId>":{type:"token"|"api-key"|"agy-slot"|"agy-swap-backup", value:string, createdAt, updatedAt, fingerprint}}}` (§7.2).
  - `value` is the base64 of the raw secret bytes. `fingerprint` is the first 8 lowercase hex characters of the SHA-256 of those bytes; it serves duplicate detection and `doctor`, and is never logged together with a value.
  - `type` by entry: claude and copilot `token`, codex `access-token` → `token`; codex `api-key` → `api-key`; `agy/<id>`, `agy/_unregistered/<email>`, `agy/_unknown/<sha256-8>` and `agy/_unparsed/<store>-<epoch>` → `agy-slot` (raw slot bytes); `agy/_swap/<startedAt>` → `agy-swap-backup`.
  - An `agy-swap-backup` value is the base64 of the JSON `[{store, path, bytes}]`, one element per slot that held a credential (`bytes` in base64, `path` null for `keyring`) (§8.3.3 B.5).
  - Reserved agy ids (§7.2): `agy/_unregistered/<email>`, `agy/_unknown/<sha256-8>` (the first 8 hex of the SHA-256 of the raw bytes), `agy/_unparsed/<store>-<epoch>` and `agy/_swap/<startedAt>`. There is no `agy/_last`.
- **D.3a vault header:** `magic "ACSV" ‖ version ‖ keySourceId ‖ keyId(16) ‖ keyFilePath? ‖ bodyNonce(24) ‖ wrappedDataKey(72 = wrapNonce(24) ‖ ciphertext(32) ‖ tag(16))` (§7.2).
- **D.3b agy journal:** `{op:"swap"|"add"|"sign-out", from, to, saved:[{secretId, store, path}], backupSecretId, startedAt, pid, startTime}` (§13.3).
  - `op`: `swap` (`exec agy`, `agy use` and the restore-after-run swap, §8.3.3), `add` (`add agy` and `login agy`, §8.3.4), `sign-out` (`remove agy --sign-out-slot`).
  - `from`: the agy account id whose credential the slots held, or null. `to`: the incoming account id (for `add`, the account being added or logged in); null for `sign-out`.
  - `saved`: every slot that held a credential, by store (`keyring`, `file`, `ls-file`) and, for files, exact path (else null), with the vault entry its content was saved to.
  - `backupSecretId` = `agy/_swap/<startedAt>`, the per-operation backup recovery rolls back from. `startedAt` is in epoch seconds. `pid` and `startTime` are diagnostics only; recovery never checks them.
- **D.4 contract responses** (§11.2). Every response is one JSON object with `contract` and follows §11.1: an absent value is `null`, never an omitted key, and every timestamp is given as `foo` (RFC 3339 UTC) and `fooEpoch` (integer seconds). The two forms MUST denote the same instant; a schema test checks every pair in the examples and goldens. `?` below marks a field that is `null` when it does not apply.
  - **Error object:** `error:{code, message, hint?}`. `code` is a kebab-case id (Appendix E, §12.1.1); `message` comes from the fixed catalogue. A response that is only an error is `{contract, error}`.
  - **`version`:** `{contract, name, version, commit, goos, goarch, root, rootSource:"ACCSHIFT_HOME"|"XDG_DATA_HOME"|"default", contracts:[int], supportedClis:[cli], experimental:[cli], capabilities:{<cli>:{sessionPortable, lockScope:"none"|"machine", usageProbe:"per-account"|"none", dataDir?}}, stderrCatalogue:[string]}`. `supportedClis` lists every cli `exec` can run on this OS, and `experimental ⊆ supportedClis`. `stderrCatalogue` lists, verbatim, every line `exec` can write to stderr; lines interpolate nothing and contain no digits, so the list is exhaustive (§12.1.1). Each release also ships it as `testdata/stderr-catalogue.txt`.
  - **Limit:** `{kind:"limit"|"auth-suspect", scope, until, untilEpoch, tier, limitType?, limitSource}`, with the stored `until`.
  - **AccountEntry** (`list`, `status`, `enable`, `disable`, `order`): `{name, id, kind, label?, state:"ready"|"limited"|"needs-relogin"|"needs-attention"|"disabled", reason?, enabled, usageProbe, limitedUntil?, limitedUntilEpoch?, limitType?, limitSource?, limits:[Limit], expiresSoon, expiresAt?, expiresAtEpoch?, lastUsedAt?, lastUsedAtEpoch?}`.
    - The summary fields describe the record with the latest `until` among the records that block a model-less request (§9.1); `limitedUntilEpoch` is the stored value, without the skew margin.
    - `usageProbe` is true only for claude `native`.
    - `id` is the immutable account id (§6.2).
  - **`list <cli>`:** `{contract, cli, poolSize, rotationPossible, poolDropped:[name], accounts:[AccountEntry]}`. Without a cli: `{contract, clis:[<the per-cli object, without contract>]}`. `list` never exits 69: with no accounts or an unsupported cli it returns `accounts:[]`, `poolSize:0`, `rotationPossible:false`.
  - **`status [cli]`:** the `list` shape, plus:
    - top level: `vault:{exists, keySource?, keyId?, keyFilePath?}` (from the header only, as `vault status`) and `notice:{accepted, version?, acceptedAt?, acceptedAtEpoch?}` (`accepted` is true when `version` is the binary's current notice version). Without a cli: `{contract, vault, notice, clis:[…]}`;
    - in the agy per-cli object: `agySlot?:{owner?, store?, writtenAt?, writtenAtEpoch?, saveBackPending}` (the state.json hint with `owner` as the account name; no keystore access);
    - in every AccountEntry: `relogin?:{reason, since, sinceEpoch}`, `attentionCode?`, `authStrikes`, `lastStrikeAt?`, `lastStrikeAtEpoch?`, `lastOkAt?`, `lastOkAtEpoch?`, `utilization?:{<window>:fraction, observedAt, observedAtEpoch}` (display only), and for agy `wrongAccount?:{expected, found?, observedAt, observedAtEpoch}` (emails).
  - **`pick` / `next` / `mark`:** `{contract, cli, account?, previous?, switched, available?, resetAt?, resetAtEpoch?, poolSize, rotationPossible, poolDropped:[name], preferIgnored, sessionPortable?, sessionPortability?:"yes"|"likely"|"possible"|"unlikely"|"no", recorded?, accounts:[{name, state, reason?, limitedUntil?, limitedUntilEpoch?, limits:[Limit]}], error?}`.
    - `accounts[]`: the pool after dropping unknown names (else every account of the cli), in candidate order, disabled ones included. `limits` lists every active record; `state`, `reason` and the summary fields follow the AccountEntry rules.
    - `pick`: `previous:null`, `switched:false`, `recorded:null`, `sessionPortable:null`, `sessionPortability:null`.
    - `next`: `previous` = `--from`; `switched` is true only when `account` and `previous` are both non-null and differ (so false on 69 and 77, and on a 75 that names `--from`).
    - `mark`: selects nothing. `account`, `previous`, `available`, `resetAt`, `resetAtEpoch`, `sessionPortable` and `sessionPortability` are null, `switched` is false, and `recorded` is set.
    - `preferIgnored` is true when `pick` did not honour a given `--prefer` (§9.3); always false for `next` and `mark`. `poolDropped` lists unknown `--pool` names.
    - `sessionPortable` and `sessionPortability` are null whenever `account` is null.
    - `recorded`: null for `pick` and for an unknown `--from`; otherwise `{account, class, kind?, scope?, until?, untilEpoch?, tier?, limitSource?, resetConfidence?, limitType?, relogin?, attentionCode?}`.
      - `class` is the evidence class that decided (§9.3), else `limit` or `auth` from `--reason`, `--limited-until` or `--auth-failed`, and `ok` / `clear` for `mark --ok` / `mark --clear`. When nothing was stored (for example a codex refresh race), `class` still names the evidence class and the record fields are null. `untilEpoch` is the stored value.
      - `relogin` is the reason this call set (`rejected`, `refresh-dead`); `attentionCode` the code this call set; else null.
    - Exit 0: `available:true`, `account` set, `error:null`.
    - Exit 75: `available:false`; `account` = the soonest-free account (it may be `--from`); `resetAt` / `resetAtEpoch` = its effective reset + 30 s; `error:null`.
    - Exit 69 and 77: `available:false`, `account:null`, and `error` set (69: `empty-pool`, `unsupported-cli`, `notice-not-accepted` with the hint `accshift notice --accept`; 77: `needs-relogin`). Only `pick` and `next` exit 69.
    - `mark --clear` on an account past `expiresAt`: the `mark` shape with `error` `expired` (exit 65).
    - Every other non-zero exit returns the plain error response.
  - **`enable` / `disable` / `order`:** `{contract, cli, accounts:[AccountEntry]}`.
  - **`classify`:** `{contract, cli, class, scope?, limitType?, resetAt?, resetAtEpoch?, tier?, limitSource?, resetConfidence?, retrySameAccount, rotate, attentionCode?, snippet?, sessionId?, recorded?}`. `class` is one of the Appendix C classes, `config-error`, `ok` or `unknown` (it may grow). `recorded` is null unless `--record`. `classify` exits 0 for every class, and 66 when the evidence file is unreadable.
  - **`doctor`:** `{contract, ok, root, rootSource, findings:[{severity:"error"|"warn"|"info", cli?, account?, code, message, hint?}]}`. `ok` is false when any finding has severity `error`. `doctor` without `--fix` is read-only and exits 0 whenever it ran; callers read `ok`. `doctor --fix` is a writer: it exits 0 when every fix it attempted succeeded or nothing needed fixing, else 73 (a lock timeout, a foreign agy), 74 (keystore) or 78, and still prints this shape with the findings. LimitShift only calls `doctor --json`, never `--fix`.
  - **`notice`:** `{contract, notice:{accepted, version?, acceptedAt?, acceptedAtEpoch?}}`, the `status` notice object after the command. Without `--accept` (and without `y` at its TTY prompt) `notice` is read-only; `notice --accept` writes `state.notice = {acceptedAt, version}` under `state.lock` (§6.3, Appendix F).
  - **`vault status`:** `{contract, exists, keySource?, keyId?, keyFilePath?}`.
  - **`env --format json`** (diagnostic; LimitShift never uses it): `{contract, cli, account, set:{<name>:<value>}, unset:[name], secretNames:[name]}`. Secret values read `<redacted:<secretId>>` unless `--reveal-secrets`.
  - **Status file** (`exec --status-file PATH`, §12.1.1; one line, same framing; `run` has no status file): `{contract, launched, cli, account, exitCode?, error?:{code, reason?}, addedArgs:[string], foreignAgy, wrongAccount?:{expected, found?, observedAt, observedAtEpoch}, postRunError?:{code, reason?}}`.
    - Pre-launch failure: `launched:false`, `exitCode` 125, 126 or 127, and `error` set. `error.reason` refines the code: `missing` or `expired` for `needs-relogin` with `--account` (null when exec picked the account), `key-file-permissions` for a `keystore-unavailable` from the key-file check (§7.3); else null.
    - execve path: written just before execve with `launched:true` and `exitCode:null`. If execve returns, exec rewrites it with `launched:false`, the error and the exit status (125/126/127).
    - spawn path: rewritten after the child exits, with `exitCode` (the child's status, or 128+n) and the post-run fields.
    - `addedArgs` lists the one argument `exec` may prepend (§8.5); it is `[]` otherwise.
    - `foreignAgy` is true when the agy shared fast path ran while a foreign agy was running (§8.3.3), else false.
    - `postRunError` reports a failed or skipped post-run hook, for example `save-back-failed`, `agy-slot-unregistered` (restore-after-run skipped), `copy-back-conflict`, `copy-back-skipped` or `copy-back-failed`. It never changes `exitCode`.

## Appendix E: exit codes

Codes 64–78 are those of the **control verbs** (every command other than `exec` and `run`). `exec` and `run` never use them for their own failures: every failure before the child starts is 125, whatever code a control verb would use for the same condition, and 126 and 127 cover the binary itself (§12.1.1). A cli can exit 125–127 on its own; `--status-file` (`launched`) tells the two apart.

| Code | Name | Commands | Caller action (LimitShift) |
|---|---|---|---|
| 0 | OK | all | proceed |
| 1–124 | child exit | exec, run | normal CLI result handling |
| 64 | USAGE | control verbs: `usage` (bad, unknown or conflicting flags; input that non-interactive mode cannot get, such as `config edit` without a terminal); `native-account` (`login` on a `native` account, with the vendor's own login command as the hint); `unknown-cli`; `unknown-account` where a command names its target (`mark --account`, `enable`, `disable`, `order`, `login`, `remove`, `rename`, `env`, `agy use`, `doctor --account`, `classify --record --account`; never `--prefer`, `--pool` or `next --from`, §9.3) | bug in caller: needs-human |
| 65 | DATAERR | `add`, `login`, `remove`, `mark --clear`, `config`, `notice`, `vault import`: `invalid-token` (a token or key that fails its format check, §8), `classic-pat-unsupported`, `gh-token-unavailable` (`add`/`login copilot --kind gh`, §8.5), `identity-mismatch`, `duplicate-account`, `no-login-detected`, `securestorage-ignored`, `invalid-import` (codex `--import-home` names `mainHome`, §8.2), `notice-not-accepted` (the notice declined at `add` or `notice`), `account-in-use` and `agy-account-live` (`remove`), `expired` (`mark --clear` past `expiresAt`), `invalid-config` (an invalid `config` value or edit, such as a `clis.codex.mainHome` inside `<root>/homes/` or a relative `clis.<cli>.bin`, §6.2), `invalid-bundle` (`vault import`: a wrong passphrase or a damaged bundle) | needs-human |
| 66 | NOINPUT | `classify`: `evidence-unreadable` (the evidence file cannot be read) | treat as no evidence |
| 69 | UNAVAILABLE | `pick`, `next`: `empty-pool` (no accounts, every `--pool` name unknown, or every remaining account disabled), `unsupported-cli`, `notice-not-accepted` (hint `accshift notice --accept`); `env`: `requires-exec`. No other command exits 69: `list` and `status` with no accounts or an unsupported cli return `accounts:[]`, `poolSize:0`, `rotationPossible:false` | legacy launch only under the §15.2 legacy rule; otherwise needs-human (fallbacks: set the runner aside); for `notice-not-accepted` the needs-human reason carries the hint `accshift notice --accept` |
| 70 | SOFTWARE | control verbs: `internal` (a bug) | as 69, and report the bug |
| 73 | BUSY | control verbs: `state-busy` (`state.lock`, 5 s), `vault-busy` (`vault.lock`, 15 s); `slot-busy` (the agy slot lock) and `agy-busy` (a foreign agy, or an NFS root) for `agy use`, `add agy`, `login agy`, `remove agy` and `doctor --fix`; `overlay-in-use` (`add codex`, `login codex`, or `add codex --import-home`, while a codex process uses the overlay or DIR, §8.2); `agy-journal-pending` (`rename` while `journal/agy-swap.json` exists); `registry-changed` (`config edit` when accounts.json changed meanwhile) | transient: retry later. `next`'s `state-busy` recorded nothing: LimitShift waits 60 s and retries the same `next` call (never a `pick`, and never a relaunch on `--from` in between), up to accountBusyWaitMinutes. `mark --ok` is best effort and ignores it |
| 74 | IOERR | control verbs that need a secret (`add`, `login`, `remove`, `agy use`, `vault migrate`, `vault export`, `vault import`, `env --reveal-secrets`, and `doctor --fix` when it recovers an agy journal): `keystore-unavailable` (a locked, absent or timed-out keystore; a missing key item or key file, or a key file that fails the owner or mode check, §7.3; a passphrase needed in non-interactive mode), `vault-changed`, `agy-keyring-locked` (§8.3.2), `slot-write-failed` (an agy slot write or its verification failed and was rolled back, or a vault write failed for another reason, such as a full disk; §8.3.3, §13.3), `keychain-prompt-required` (§8.3.3 B.8), `keychain-line-too-long` (§7.4), `import-failed` (codex `--import-home` could not remove the source after a cross-filesystem copy, §8.2) | surface the unlock hint: needs-human |
| 75 | TEMPFAIL | `pick`, `next` | single runner: rest until `resetAtEpoch` + resetBufferMinutes, then run on `account`; fallbacks: mark the runner limited until `resetAtEpoch` and select the next runner (§15.2) |
| 77 | NOPERM | `pick`, `next`, `agy use`: every remaining candidate needs a human (`needs-relogin`: re-login, an expired token, missing credentials, or a provider block); the agy slot holds an unregistered login (`agy-slot-unregistered`, non-interactive) | legacy launch only under the §15.2 legacy rule; otherwise needs-human |
| 78 | CONFIG | control verbs: `config-corrupt` (a file that does not parse or fails validation, such as a relative `clis.<cli>.bin`, §6.4), `config-newer-version`, `insecure-permissions` (read-only commands; writers tighten), `unsupported-filesystem` (also a writer that cannot tighten a mode), `wrong-owner`, `vault-corrupt`, `vault-corrupt-present`, `key-item-exists`, `unsupported-config` (`add claude --native` with `CLAUDE_CONFIG_DIR` set but empty, §8.1; a codex `ephemeral` credential store, or a codex `mainHome` inside `<root>/homes/` at its first initialisation, §8.2) | needs-human |
| 125 | exec/run failed before the child started | exec, run | per-code action table in §15.2 (summary below) |
| 126 | found but not executable: `not-executable`, `cmd-shim-unsupported` (§12.4), `wsl-windows-binary` (§12.2) | exec, run | status file `launched:false`: needs-human, no retry. `launched:true`, or no status file: the cli's own status, normal CLI result handling |
| 127 | cli not found: `not-found` (§12.2) | exec, run | as 126 |
| 128+n | child killed by signal n | exec, run | as today |

**Exit 125 `error.code`** (the closed set, §12.1.1; on stderr as `accshift: error <code>: <catalogue message>` and in the status file): `usage`, `unknown-cli`, `unsupported-cli`, `unknown-account`, `account-disabled`, `needs-relogin`, `all-capped` (only when picking), `notice-not-accepted` (only when picking), `empty-pool` (only when picking), `wrong-owner`, `unsupported-filesystem`, `config-corrupt`, `config-newer-version`, `vault-corrupt`, `vault-changed`, `vault-busy`, `state-busy`, `slot-busy`, `agy-busy`, `keystore-unavailable`, `keychain-prompt-required`, `agy-keyring-locked`, `agy-slot-unregistered`, `agy-env-overrides-slot`, `slot-write-failed`, `bare-ignores-token`, `apikeyhelper-overrides-token`, `settings-env-overrides-token`, `base-url-would-receive-token`, `classic-pat-unsupported`, `gh-token-unavailable`, `cmdline-too-long`, `internal`. `run` reports a fully capped pool as 125 `all-capped`, never 75.

LimitShift's action per code (§15.2 is normative):
- `slot-busy`, `agy-busy`, `state-busy`, `vault-busy`: transient. Not charged to maxRetriesOnError or maxRunsPerTask: wait 60 s, re-pick, retry. After `accountBusyWaitMinutes` (default 30) of continuous busy, treat the runner as limited until now + accountBusyWaitMinutes.
- `needs-relogin`, `account-disabled`, `unknown-account`: clear the current account and re-pick (no strike).
- `keystore-unavailable`, `agy-keyring-locked`, `notice-not-accepted`: legacy launch only under the legacy rule, else needs-human.
- Every other code: needs-human, no retry.

## Appendix F: README notice (provider terms)

Shown in the README, by `accshift notice`, and at every `add` (every cli and kind, including `--native` and `--capture-current`) while state.json `notice` is unset or older than this notice's version; `add` requires `y` or `--accept-notice`, and `notice` requires `y` or `--accept` (§8, §6.3, §10.2). **Notice version: 1.** The version is incremented only when the text changes materially. Every user then accepts it again with `accshift notice --accept` or at the next `add`; until then `pick` and `next` exit 69 `notice-not-accepted` (§9.3). EN text below; the UK translation in README.uk.md is drafted in [R09 §3.5].

> **Use at your own risk: read your providers' terms.** accshift is an independent, unofficial tool for personal and educational use. It is not affiliated with or endorsed by Anthropic, OpenAI, Google or GitHub. It runs the official, unmodified CLIs on your own machine. It never signs in on your behalf, never sees your passwords, never proxies requests, and hands your tokens only to the CLI you launch.
>
> **Your agents can read every stored account.** The agents accshift launches run as you, and can read every secret accshift stores, for every account and every CLI, not only the one in use. A compromised or prompt-injected task could take all of them. Per account, accshift is no weaker than the vendors' own storage; in aggregate it is weaker. Tokens placed in a CLI's environment may also be visible to the agent's own tools and scripts.
>
> Each provider's terms govern how you may use your accounts, and they change. As of October 2026:
> - Anthropic says subscription usage limits "assume ordinary, individual usage" and restricts how subscription credentials may be used.
> - OpenAI prohibits attempts to "circumvent any rate limits or restrictions".
> - Google prohibits using third-party software to access Antigravity.
> - GitHub allows one free account per person.
>
> Using several accounts to keep working after one reaches its limit may break these terms and can get your accounts suspended. Only use accounts you own and pay for, never share them, and check the current terms yourself. This is not legal advice. accshift is provided "as is", without warranty (see LICENSE).

Before release, the owner checks every quoted phrase against the primary page linked below. The OpenAI wording was read through a mirror, so its fidelity is INFERRED [R09 §3.4].

Links (from R09 §3.4):
- Claude Code legal: https://code.claude.com/docs/en/legal-and-compliance
- Anthropic Consumer Terms: https://www.anthropic.com/legal/consumer-terms
- OpenAI Terms of Use: https://openai.com/policies/row-terms-of-use
- Antigravity terms: https://antigravity.google/terms
- GitHub Terms of Service: https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
