## 2. Decisions at a glance (and why Go)

Each decision was made in a separate research track and then checked by independent judges. The full reasoning, rankings, and what would change each decision are in [`DECISIONS.md`](DECISIONS.md).

| # | Decision | Chosen | Main alternatives rejected |
|---|---|---|---|
| D1 | Implementation language | **Go 1.27, `CGO_ENABLED=0`, one static binary per target, built from one Linux runner with GoReleaser OSS** | Rust; bash+PowerShell twins; one PowerShell 7 implementation; Bun/Node/Deno executables; .NET NativeAOT; Zig; Python |
| D2 | Licence | **MIT** (same as LimitShift) | Apache-2.0 (acceptable, adds NOTICE overhead); MPL (copyleft) |
| D3 | Integration surface | **LimitShift launches every managed CLI only through `acctshift exec <cli> --account A --status-file F -- <args>`, and decides rotation through one-line-JSON control verbs with sysexits codes ("contract 1"). exec reports its own pre-launch failures only as 125 (126/127 for the binary), with the reason in the status file. `env` exists only for standalone and diagnostic use** | env as the launch path; both env and exec; shared code or library |
| D4 | claude selection | **`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, one per account; history shared; the user's own login is an untouched `native` account #0** | per-account `CLAUDE_CONFIG_DIR` (contingency only); `CLAUDE_SECURESTORAGE_CONFIG_DIR` (experimental opt-in) |
| D5 | codex selection | **per-account `CODEX_HOME` overlay (a real directory) sharing an *allowlist* of entries with the main `~/.codex` by link; `CODEX_SQLITE_HOME` → main; the main home is an untouched `native` account #0** | swapping or symlinking `auth.json`; copying credentials; `CODEX_ACCESS_TOKEN` (Business/Enterprise extra kind only) |
| D6 | agy selection | **in-place swap of agy's single native slot (keyring item `gemini`/`antigravity` and/or agy's token file, resolved per run: on Linux from agy's detectors against the child's environment, on macOS and Windows from the store recorded at `add` until V-A3 passes), with email-keyed save-back as a commit point, a journal, read-back verification, and a lock held for the whole run (spawn, never execve); `pick` and `next` prefer the live slot owner** | per-account `--gemini_dir` (deferred, unverified); forcing file mode by changing the child's env; `JETSKI_OAUTH_TOKEN`; `AGY_ACCOUNT` |
| D7 | Own secret storage | **envelope vault: one XChaCha20-Poly1305 file; the OS store holds a single 32-byte key (macOS keychain via `/usr/bin/security`, Linux Secret Service only when already unlocked, Windows DPAPI, else a 0600 key file); no plaintext mode; commands that need no secret never touch the keystore** | one OS item per secret (size limits); plain 0600 files; a per-OS split |
| D8 | Rotation order and selection | **LimitShift: models inside the account (skipped when the limit is account-wide) → accounts of the same CLI (same session when portable) → other CLI (fresh session + handoff) → wait for the soonest reset. acctshift: sticky preference order; limit records per (cli, account, scope) merged by evidence tier (1–4, by the source of the reset value), with backoff for unknown resets; success reported only by `mark --ok`** | accounts before models (later opt-in); cyclic or round-robin; headroom-first |
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
2. **Maintainer and agent speed where the product actually breaks.** acctshift's risk is tracking undocumented vendor login formats quickly, not CPU work. Go's 0.3 s edit-build loop, its small language, and stable dependencies favour fast, reviewable fixes:
   - Go's standard library and toolchain are covered by the Go 1 compatibility promise, although Go 1.27 still raised the macOS minimum and moved `encoding/json` to a new backend [R01 §3.12]. The other modules acctshift uses at runtime (godbus v5, x/sys, x/crypto) have small, slow-moving APIs but carry no formal guarantee.
   - Rust's keyring crate went through 4 major versions in 4 years, and zbus through 3 in 2 years [R02 C17].
   - Rust's prototype needed 6 `unsafe` sites in 383 lines that would need review [R02 §2.1].
3. **Byte-compatibility with the one CLI whose slot we must write.** agy is itself a Go binary built on `zalando/go-keyring` [R01 C5, R07 C1]. Its keychain, Secret Service and Credential Manager encodings come straight from that Go source, and acctshift reproduces them in its own code (`go-keyring` is not used at runtime, §19.2).
   - The obvious Rust store crates differ: the Windows one writes UTF-16, and the Secret Service one auto-unlocks and prompts [R07 §4, R02 §5].
   - The judges weighted this point lower: Rust could reproduce the same formats by hand, and agy often uses its file fallback in headless contexts [R07 C2].
   - Codex being written in Rust does not matter, because per-account `CODEX_HOME` never touches Codex's keyring [R04 C12].
4. **Release coverage.** GoReleaser OSS builds archives, checksums, cosign signatures, SBOMs, a Homebrew cask, Scoop, winget, AUR and deb/rpm/apk from that one runner in about 3 s, and can notarize for macOS from Linux [R01 C13, R09 C15].

Go's real weaknesses, and how this spec handles them:

| Weakness | Handling |
|---|---|
| Unsigned Go `.exe` files have a documented record of Defender machine-learning false positives [R01 C12] | Smart App Control blocks *any* unsigned unknown binary anyway, so signing is required whatever the language. Windows signing is mandatory before 1.0, with a clean-VM Defender scan as a release gate (§17.4) |
| `os/exec` mis-quotes `.cmd`/`.bat` arguments (golang/go#69939, still open) | acctshift resolves npm shims and never routes prompts through cmd.exe (§12.4) |
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
