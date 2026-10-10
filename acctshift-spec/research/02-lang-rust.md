# Research track: lang-rust

_Research date: 2026-10-07. Claims are marked VERIFIED (evidence gathered during the research) or INFERRED._

## Summary

Rust works technically for acctshift, and I tested that empirically. With zig 0.15.2 + cargo-zigbuild 0.23.4 + cargo-xwin 0.23.1, one Linux x86_64 machine cross-compiled a 383-line prototype for all six targets plus static musl and macOS universal2. The prototype covers env injection, spawn/exec, signal forwarding, Job Objects, std file locking, atomic writes, junctions, OS credential stores, JSON and RFC 3339 timestamps. Release binaries are small: 0.55-0.60 MB on macOS and Windows, 1.65-1.87 MB on Linux. Most of the Linux size comes from the pure-Rust D-Bus stack (zbus); without it the musl binary is 0.62 MB. The static musl binary starts in 0.33 ms, against 1.5 ms for a Go hello-world, 1.9 ms for `bash -c :` and 2.8 ms for jq. A real Secret Service round trip against headless gnome-keyring passed, takes 10.8 ms per call, and fails cleanly in about 2 ms when there is no D-Bus. Under Wine, the Windows build passed exit-code 75, env plus exit-code passthrough and Credential Manager set/get, and the 2560-byte limit was enforced. All 134 dependency crates are permissive. Cargo metadata hides one trap: the libdbus 'vendored' variant ships C code under AFL-2.1/GPL-2.0+, so use zbus instead. The hard limit I found: linking Security.framework (security-framework / apple-native-keyring-store) fails without a macOS SDK ("unable to find framework 'Security'"). So acctshift should drive /usr/bin/security instead, which also avoids keychain ACL prompts on Claude Code's item, or build macOS on macOS runners. Codex itself is Rust and uses keyring-rs 3.6 and portable-pty 0.9, so it is a real-world reference for the same crates. The costs are real for a solo maintainer whose own code is bash, PowerShell and Node with no Rust. You need three cross tools (rustup, zig, xwin; about 3.6 GB of toolchain and SDK cache). A clean release build takes 60 s and an incremental fat-LTO build 21 s. Key crates churn: keyring had four major versions in four years and was split into keyring-core plus separate store crates in 2025. Published studies report noticeably lower agent success on Rust repositories. Verdict: an excellent fit if the maintainer accepts Rust's learning curve and build complexity. The biggest project-specific risk is that iteration speed and reviewability suffer on a tool whose real work is tracking fast-changing vendor login formats, not CPU-bound code.

## Scorecard

| Criterion | Score (1-5) | Rationale |
|---|---|---|
| 1. Platform reach (Win/mac/Linux x64+arm64, musl, WSL) | 5 | All six targets plus static musl and universal2 built [V]; tiers per doc.rust-lang.org: Tier 1 for aarch64-darwin, both windows-msvc and both linux-gnu targets; Tier 2 with host tools for musl and x86_64-darwin (demoted). arm64 musl ran under qemu and Windows x64 under Wine. Real macOS and Windows hardware were not tested. |
| 2. End-user footprint | 5 | A single 0.55-1.9 MB binary with no runtime: static musl, crt-static Windows (system DLLs only), libSystem-only macOS. Needs nothing pre-installed except /usr/bin/security (always present on macOS) and, on Linux, a Secret Service daemon if the keyring is used (any language). |
| 3. Startup latency / per-call overhead | 5 | 0.33 ms static musl vs 1.5 ms Go, 1.9 ms bash, 2.8 ms jq (hyperfine, 1000 runs); a Secret Service read is 10.8 ms per process, mostly D-Bus. |
| 4. Build / cross-compilation from one Linux runner | 3.5 | Works for all targets from one Linux host [V], but needs zig + cargo-zigbuild + cargo-xwin (1.1 GB Microsoft SDK download), cannot link Apple frameworks without an SDK, 60 s clean release per target, 2.1 GB toolchain. Reproducible with extra linker flags. More moving parts than a CGO-free Go build. |
| 5. OS credential store access | 4 | Mature permissive crates: keyring-core 1.0 plus apple/windows/zbus stores, security-framework 3.7, windows-sys raw-dylib. zbus is pure Rust and verified against headless gnome-keyring; the Windows limit is enforced; DPAPI is available. Minus: the framework path breaks cross-builds (use the security CLI), zbus is heavy (92 crates), the WSL default-collection gap, and keyring v4 API churn. |
| 6. Process control (spawn/env/stdio/exit, signals, process tree, PTY, locking, atomic writes, junctions) | 4 | std covers spawn, exec, process_group, File::lock and atomic rename [V]; Job Objects and DPAPI via windows-sys; portable-pty verified on Linux; junction crate. Minus: no std signal API (unsafe libc or crates), no PATHEXT resolution, portable-pty is slowly maintained and depends on winapi 0.3; Wine could not validate unlock or junctions. |
| 7. Trust / distribution friction | 3 | Same native-binary story as other compiled languages: zig emits a valid arm64 ad-hoc signature [V]; curl installs avoid quarantine; notarization needs a $99/yr Developer ID (rcodesign can do it from Linux, but has had no release since 2024-11). Rust EXEs see ML Defender false positives; Windows signing costs money. |
| 8. Dependency licenses & supply-chain size | 4 | All 134 crates are permissive [V]. Strong tooling (cargo-deny, audit, vet, auditable). Minus: 107 crates on Linux because of zbus, and the vendored-libdbus AFL/GPL trap hidden by crate metadata. |
| 9. Maintainability by one person + AI agents | 3 | Excellent compiler, test and refactor safety; the prototype compiled first time on three OSes. But: steep learning curve, slower edit-compile loops (1.6-21 s), unsafe FFI to review, the user has no Rust in their repos, published agent success on Rust repos is lower, and breaking churn in key crates. |
| 10. Fit with limitshift | 3 | JSON plus exit 75 is trivially consumable from bash/jq and PowerShell 7, and black-box tests can be shared. No code sharing, and it adds a new toolchain (rustup + zig + xwin) to a bash/PowerShell/Node world; Go was at least already used to build agm. |
| 11. Packaging channels | 5 | dist (v0.33.0, 2026-09) offers shell, PowerShell, Homebrew, npm and MSI installers plus checksums; axoupdater or self_update for self-update; cargo install/binstall, cargo-deb, maturin/PyPI; Scoop, winget and AUR are language-neutral. |
| 12. Long-term risk | 4 | Very stable language with strong governance and wide industry use (including Codex). Risks: crate major-version churn (keyring 4 majors in 4 years, zbus 3 majors in 2 years, windows-sys about 2 per year), MSRV creep, and single-maintainer crates (keyring-rs, portable-pty, apple-codesign). |

## Conclusions

| # | Claim | Status | Confidence | Evidence | What the spec should do |
|---|---|---|---|---|---|
| 1 | A single Linux x86_64 host can cross-compile a realistic Rust acctshift (env injection, spawn/exec, keyring, locking, JSON) for linux x64/arm64 (musl static and gnu), macOS x64/arm64/universal2 and Windows x64/arm64 MSVC. | VERIFIED | high | cargo zigbuild (zig 0.15.2, cargo-zigbuild 0.23.4) and cargo xwin (0.23.1) builds all succeeded; table in report section 3; aarch64 musl binary ran under qemu-aarch64-static; Windows x64 build ran under Wine 9.0. | If Rust: the release CI can be one ubuntu job with zig, cargo-zigbuild and cargo-xwin (or dist with native runners), plus separate test jobs on macOS, Windows and arm64 runners. |
| 2 | Linking Security.framework (security-framework / apple-native-keyring-store) from Linux fails without a macOS SDK. | VERIFIED | high | Build log: 'error: unable to find framework 'Security'. searched paths: none' and the same for CoreFoundation, on both apple targets; the cargo-zigbuild README says to set SDKROOT to work around it. | The macOS keychain backend should spawn /usr/bin/security (with -i over stdin). A Security.framework backend must be optional and built only on macOS runners. |
| 3 | Using /usr/bin/security instead of Security.framework avoids keychain ACL prompts on items created via the security CLI (e.g. Claude Code's) and avoids per-update prompts for ad-hoc-signed binaries. | INFERRED | medium | Keychain ACLs trust the creating app; Claude Code reportedly writes via the security CLI (context facts); an ad-hoc signature's cdhash changes per build. Not testable without a Mac. | Spec the macOS store as 'security -i' with no secrets in argv; add a real-Mac acceptance test for no-prompt reads of the Claude Code credentials item. |
| 4 | Release binaries are small and dependency-free: 0.55 MB (macOS arm64), 0.54 MB (macOS x64), 1.1 MB universal2, 0.60/0.55 MB (Windows x64/arm64 with crt-static), 1.67-1.87 MB Linux musl with zbus (0.62 MB without). | VERIFIED | high | stat sizes in report section 3; ldd shows the musl builds are static; Windows imports with crt-static are only system DLLs. | Ship static musl for Linux, universal2 for macOS and crt-static MSVC for Windows; budget under 2 MB per binary. |
| 5 | The default MSVC Rust build depends on VCRUNTIME140.dll; +crt-static removes it. | VERIFIED | high | llvm-objdump -p imports, before and after adding rustflags target-feature=+crt-static. | Mandate -C target-feature=+crt-static for Windows targets in .cargo/config.toml. |
| 6 | Startup latency of a static musl Rust binary is about 0.33 ms, versus 1.5 ms for Go CGO=0, 1.9 ms for bash -c and 2.8 ms for jq; one Secret Service read costs about 10.8 ms per process. | VERIFIED | high | hyperfine -N, 1000 runs (bench/startup.md); keyring latency from 100 runs under dbus-run-session with gnome-keyring. | Per-call overhead is negligible; limitshift may call acctshift several times per task freely. Do not pick the language on latency. |
| 7 | zbus (pure Rust) works against a real headless Secret Service, interoperates with items created by secret-tool (service/username attributes), and fails fast (~2 ms) when no D-Bus is present. | VERIFIED | high | scripts/ss_session.sh output: set/get/del OK, foreign item found, error 'Failed to connect to address unix:path=/run/user/0/bus'. | Linux store: try Secret Service first and fall back to a 0600 file store on connect failure or on WSL (no default collection); 'doctor' explains how to unlock gnome-keyring headless. |
| 8 | The libdbus 'vendored' option carries AFL-2.1 / GPL-2.0+ C code, although the libdbus-sys crate metadata says Apache-2.0/MIT. | VERIFIED | high | libdbus-sys-0.2.7/Cargo.toml license field versus vendor/dbus/COPYING text. | Forbid dbus-secret-service 'vendored'; use zbus. Licence checks must look beyond crate metadata for vendored C. |
| 9 | All 134 crates in the prototype dependency graph are permissively licensed; zbus adds about 92 crates and about 1.25 MB on Linux. | VERIFIED | high | cargo tree -f '{p} \| {l}' tally (licenses.txt); 107 vs 15 crates for linux-musl with and without keyring. | Run cargo-deny with an MIT/Apache/BSD/ISC/Unlicense/Unicode-3.0 allowlist; consider a feature flag to build without zbus (file store only) for minimal installs. |
| 10 | Windows Credential Manager blobs are limited to 2560 bytes, and keyring-rs enforces it with a clear error. | VERIFIED | high | windows-sys 0.61.2 constant CRED_MAX_CREDENTIAL_BLOB_SIZE = 2560; under Wine a 3000-byte set returned 'Value of 'secret' is longer than the platform limit of 2560 chars'. | Store short tokens (e.g. Claude setup-token) in Credential Manager with an explicit target and persistence=Local; store larger blobs (codex auth.json) as DPAPI-protected files. |
| 11 | Rust std provides cross-platform advisory file locking (File::lock, stable since 1.89.0), atomic replace via rename, process groups (1.64.0) and exec (1.9.0); signal handling needs libc/unsafe or crates. | VERIFIED | high | rust-src stability attributes; Linux runs: second locker waited 698 ms, SIGINT group test exit 130, SIGTERM forwarded (child exit 99), exec exit passthrough. | Use a std-only lock file for state; on Unix forward SIGTERM/SIGHUP to the child and let SIGINT reach the foreground group; use exec when no post-processing is needed. |
| 12 | On Windows, Rust std resolves only .exe on PATH (not PATHEXT) and refuses CR/LF in arguments to .cmd/.bat files. | VERIFIED | high | rust-src std/src/sys/process/windows.rs resolve_exe; std/src/sys/args/windows.rs make_bat_command_line has DISALLOWED = b"\r\n" and returns InvalidInput. | Resolve CLIs with the which crate; for npm shims (codex.cmd, gemini.cmd) launch node with the JS entry, or require native exes, when prompts are multi-line. |
| 13 | SetConsoleCtrlHandler(NULL, TRUE) is inherited by child processes, so it must be called after spawning (or a handler returning TRUE used instead). | VERIFIED | high | Microsoft Learn SetConsoleCtrlHandler: 'This attribute of ignoring or processing CTRL+C is inherited by child processes.' | Spec the Windows Ctrl+C contract: the child gets CTRL_C_EVENT, acctshift survives and returns the child's exit code; enforce kill-tree with a KILL_ON_JOB_CLOSE Job Object. |
| 14 | The zig-linked macOS arm64 binary carries a valid ad-hoc (linker-signed) code signature, which is enough to run non-quarantined on Apple Silicon. | VERIFIED | medium | scripts/verify_adhoc.py: flags=0x20002 adhoc=True, 134 pages, bad_pages=0. Running it on a real Mac was not possible here. | curl/Homebrew-formula installs work unsigned; a browser-download path needs Developer ID signing and notarization (rcodesign can do this from Linux). |
| 15 | Builds can be made bit-reproducible: Linux musl as-is with --remap-path-prefix; Windows with /Brepro and /DEBUG:NONE; macOS differs only by LC_UUID when built from different paths. | VERIFIED | medium | sha256 comparisons of two-directory builds in report section 3.2. | Pin the toolchain (rust-toolchain.toml, zig version), build in a fixed CI path, publish SHA256SUMS and allow third-party rebuild checks. |
| 16 | OpenAI Codex (a managed CLI) is written in Rust and uses keyring 3.6 (apple-native, windows-native, linux-native-async-persistent), portable-pty 0.9.0 and windows-sys 0.61.2. | VERIFIED | high | raw.githubusercontent.com/openai/codex/main/codex-rs/Cargo.toml and codex-rs/keyring-store/Cargo.toml fetched today. | If acctshift must ever handle Codex keyring-mode credentials, the Rust keyring crates reproduce its naming conventions; otherwise keep Codex on file-mode CODEX_HOME per account. |
| 17 | Rust maintenance costs are material for this user: clean release build 60 s, incremental fat-LTO 21 s (debug 1.6 s), a 2.1 GB toolchain plus 1.5 GB of zig/xwin, yearly breaking majors in keyring/zbus/windows-sys, and MSRV creep (keyring 4.2 needs rustc 1.88). | VERIFIED | high | Timings and du in report sections 1 and 3.4; crates.io version history (keyring 3.x 2024-07, 4.x 2025-11; zbus 4.x 2024-02, 5.x 2024-10; windows-sys 0.59/0.60/0.61 in 2024-07/2025-06/2025-09). | If Rust: pin rust-toolchain.toml, commit Cargo.lock, and use Dependabot/cargo-deny; keep the dependency set minimal (lexopt instead of clap, jiff without tzdb). |
| 18 | AI agents are less reliable on Rust repositories than on simpler languages, although the compiler catches many errors early. | INFERRED | medium | Rust-SWE-bench (arXiv 2602.22764): agents resolve up to 21.2% (28.6% with RustForger), limited by type and trait semantics; the prototype here compiled first time, which is anecdotal. | If Rust is chosen, keep the code synchronous and simple (no async except inside zbus), wrap unsafe FFI in tiny audited modules, and require clippy -D warnings plus black-box tests. |
| 19 | Rust binaries are subject to ML-based Windows Defender false positives (e.g. Trojan:Win32/Bearfoos.A!ml). | INFERRED | medium | users.rust-lang.org threads; no VirusTotal scan was run here. | Plan Authenticode signing (Azure Trusted/Artifact Signing or SignPath OSS), VirusTotal checks in release CI, and winget/Scoop distribution. |

## Full report

# Track lang-rust: Rust as the implementation language for acctshift

All evidence was gathered on 2026-10-07 in this sandbox:

- **Machine:** Ubuntu 24.04.5 x86_64, 4 vCPU, 15 GB RAM. The lang-go track was running at the same time, so timings are noisy.
- **Labels:** **[V]** = VERIFIED now (the command, file or page is cited). **[I]** = INFERRED (memory or reasoning).
- **Prototype and scripts:** in `/tmp/claude-0/-home-user/228bfb4e-0bd0-5413-8490-21fae890d3fa/scratchpad/lang-rust/`:
  - `proto/src/main.rs`, `proto/Cargo.toml`, `proto/.cargo/config.toml`
  - `scripts/verify_adhoc.py`, `scripts/sigtest.sh`, `scripts/ss_session.sh`, `scripts/wine_smoke.sh`
  - `bench/startup.md`, `licenses.txt`, and the `build-*.log` files
- **Cleanup:** large downloads (xwin SDK, zig, wine prefix, target dirs) were deleted afterwards.
- **Sandbox packages installed:** gnome-keyring, libsecret-tools, qemu-user-static and wine64 were installed via apt. Only the sandbox OS changed; no repository was modified.
- **Clean room:** no agm code or ClaudeCodePortable code was opened. From ai-switcher only the allowed files `launcher/agy.mjs`, `launcher/ais-run.mjs` (head) and `packaging/*` were read, for requirements only.

---

## 1. Toolchain used (verified)

| Item | Version | How obtained |
|---|---|---|
| rustc / cargo | 1.97.0 (2026-07-07), LLVM 22.1.6 | preinstalled (`rustc -vV`) [V] |
| rustup std targets | x86_64/aarch64 linux-gnu and linux-musl, x86_64/aarch64 apple-darwin, x86_64/aarch64 windows-msvc, plus windows-gnu / gnullvm | `rustup target add …`, 45 s [V] |
| zig | 0.15.2 (sha256 `02aa270f…` checked against ziglang.org/download/index.json; 0.17.0 is the newest) | official tarball, 380 MB unpacked [V] |
| cargo-zigbuild | 0.23.4 (MIT) | `cargo install --locked` [V] |
| cargo-xwin | 0.23.1 (MIT); default MSVC CRT "17" | `cargo install --locked`; both tools took 3 min 31 s to build from source [V] |
| xwin MSVC CRT + Windows SDK cache | 1.1 GB, downloaded on first `cargo xwin build` | automatic [V] |
| hyperfine | latest | `cargo install`, 40 s [V] |

**Disk footprint for the maintainer or CI:**
- Rust toolchain with 10 std targets and rust-src: 2.1 GB
- cargo registry: 477 MB
- zig: 380 MB
- xwin cache: 1.1 GB
- one target dir with debug and release: about 1.1 GB

All figures are [V] from `du -sh`.

---

## 2. Prototype

### 2.1 What it does

`acctshift-proto` has 383 lines and 6 `unsafe` sites: the libc signal handler, `kill`, the Job Object, and DPAPI. Subcommands:

- `version`: JSON output.
- `run [--set K=V]… -- prog args`: spawn with modified env and inherited stdio, pass the exit code through, map a signal to 128+n, forward SIGTERM/SIGHUP/SIGQUIT, and ignore SIGINT in the parent. On Windows it uses `SetConsoleCtrlHandler(NULL,TRUE)` after spawn and a `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` Job Object.
- `exec …`: Unix `execve` via `CommandExt::exec`, so no wrapper process remains.
- `kr get|set|del --service --user [--target]`: keyring-core 1.0.0 with apple-native-keyring-store (macOS), windows-native-keyring-store (`default-features=false`, which drops regex) or zbus-secret-service-keyring-store (`crypto-rust`).
- `sec get|set`: macOS `/usr/bin/security -i`, with the command written to stdin so the secret is never in argv.
- `lock PATH`: std `File::lock`, stable since 1.89.0 (verified in rust-src `#[stable(feature = "file_lock", since = "1.89.0")]`).
- `write PATH CONTENT`: atomic write (temp file 0600, then fsync, then rename).
- `next STATE --now T`: pick the first uncapped account, or **exit 75** with `retry_at`.
- `link SRC DST`: symlink on Unix, `junction` crate on Windows.
- `pty …` (feature): portable-pty 0.9.0.

### 2.2 Dependencies

- serde 1, serde_json 1.0.151, lexopt 0.3.2
- jiff 0.2.38 with the `std` feature and no tzdb
- libc on Unix
- windows-sys 0.61.2 and junction 2.1.0 on Windows
- keyring-core and the store crates listed above
- portable-pty (optional feature)

Release profile: `opt-level="s"`, `lto="fat"`, `codegen-units=1`, `panic="abort"`, `strip=true`.

Windows needs `.cargo/config.toml` with `rustflags = ["-C","target-feature=+crt-static"]`.

The code compiled on the first attempt for Linux, macOS and Windows, with no code errors. The only warnings were a missing macOS SDK version and missing static-CRT PDBs, both benign. This is an anecdotal data point for AI-agent reliability.

---

## 3. Cross-compilation results (ONE Linux x86_64 host)

| Target | Command | Features | Result | Wall time | Size (bytes) | gzip -9 | Notes |
|---|---|---|---|---|---|---|---|
| x86_64-unknown-linux-gnu | `cargo build` (host cc) | keyring (zbus) | OK | 76 s cold | 1,830,024 | 812,670 | needs **GLIBC_2.39** because it was built on Ubuntu 24.04: do not ship host-gnu builds [V] |
| x86_64-unknown-linux-musl | `cargo zigbuild` | keyring | OK | 60 s | 1,871,144 | 861,476 | static, no ldd deps [V] |
| aarch64-unknown-linux-musl | `cargo zigbuild` | keyring | OK | 59 s | 1,674,984 | 827,148 | static; **ran under qemu-aarch64-static** (`version`, `next` exit 75) [V] |
| aarch64-unknown-linux-gnu | `cargo zigbuild` | keyring | OK | 50 s | 1,654,704 | 788,003 | max GLIBC_2.30 [V] |
| aarch64-apple-darwin | `cargo zigbuild` | keyring (Security.framework) | **FAIL** | 14 s | – | – | `error: unable to find framework 'Security'… 'CoreFoundation'. searched paths: none` [V] |
| x86_64-apple-darwin | same | keyring | **FAIL** | 13 s | – | – | same [V] |
| aarch64-apple-darwin | `cargo zigbuild --no-default-features` | `security` CLI path | OK | 18 s | 551,808 | 244,527 | dylibs: libSystem.B, libiconv.2, libcharset.1; **linker ad-hoc signature present and valid** (see below) [V] |
| x86_64-apple-darwin | same | same | OK | 18 s | 539,936 | 259,239 | no LC_CODE_SIGNATURE, which Intel does not require [V] |
| universal2-apple-darwin | `cargo zigbuild` | same | OK | 6 s | 1,108,864 | – | fat x86_64+arm64 [V] |
| x86_64-pc-windows-msvc | `cargo xwin build` | keyring (CredMan) | OK | 85 s (includes SDK download) | 499,200 with dynamic CRT, **595,456 with +crt-static** | 278,539 | the dynamic-CRT build imports **VCRUNTIME140.dll**, which is not guaranteed on stock Windows. With crt-static the imports are only advapi32, KERNEL32, bcryptprimitives, ntdll and api-ms-win-core-synch [V] |
| aarch64-pc-windows-msvc | `cargo xwin build` | keyring | OK | 12 s | 467,968 / **552,960** (crt-static) | 258,099 | same imports [V] |

**Comparison builds:**

- **Std-only "hello + spawn" binary:**
  - linux-gnu 362,136
  - musl x64 374,792
  - musl arm64 345,504
  - macOS arm64 320,096
  - macOS x64 317,760
  - win x64 305,152
  - win arm64 279,040 bytes [V]
- **Linux musl x64 without the zbus keyring:** 620,128 bytes. zbus therefore costs about **+1.25 MB and +92 crates** [V].
- **PTY feature:**
  - musl x64 (no keyring) 705,192
  - macOS arm64 602,128
  - win x64 668,160
  
  portable-pty pulls `winapi 0.3` via `filedescriptor` and `winreg` [V].
- **Profile impact (musl x64, full prototype):**
  - `s` + fat LTO + abort: 1,871,144
  - `z`: 1,890,304
  - `3` + fat LTO: 2,766,848
  - cargo default (opt 3, no LTO, 16 CGU, unwind, stripped): 4,009,664 [V]
- **libdbus "vendored" alternative** (`dbus-secret-service-keyring-store` with `vendored,crypto-rust`):
  - x86_64-gnu 969,672 in 30 s; aarch64-musl 908,496 in 24 s; zig compiles the C code fine; 49 crates.
  - **Licence trap:** `libdbus-sys` crate metadata says `Apache-2.0/MIT`, but `vendor/dbus/COPYING` says *"dbus is licensed to you under your choice of the Academic Free License version 2.1, or the GNU General Public License version 2 (or, at your option any later version)"* [V].
  - So prefer zbus, which is MIT.

### 3.1 macOS signature check

My own Mach-O parser is `scripts/verify_adhoc.py`, run with `python3 -I`. Output for the arm64 build:

```
CodeDirectory v0x20400 ident='acctshift_proto-29819a7fd09111c9' flags=0x20002 adhoc=True hash=sha256 pages=134 codeLimit=547360 bad_pages=0
SIGNATURE PAGE HASHES VALID
```

- zig's linker emits a valid linker-signed ad-hoc signature (flags 0x20002 = adhoc + linker-signed) on arm64, so the binary will run on Apple Silicon when it is not quarantined.
- The identifier is the rustc temp name. That is cosmetic; `codesign -s - -i acctshift` or `rcodesign` can re-sign with a proper identifier.

[V] for the signature bytes. [I] that it runs on a real Mac, since none was available here.

### 3.2 Reproducibility

Each target was built twice from different directories with `--remap-path-prefix`:

- **Linux musl:** bit-identical (`a162ea84…` both times) [V].
- **Windows:** 12–20 bytes differed (PE TimeDateStamp and PDB GUID). With `-C link-arg=/Brepro -C link-arg=/DEBUG:NONE` the builds were identical (`dd13810b…` ×2) [V].
- **macOS arm64:** only `LC_UUID` (16 B) and the two signature page hashes covering it differed. I expect identical output when built from the same CI path [I].

### 3.3 Answer: can ONE Linux CI runner build all six?

**Yes [V]**, for x86_64 and aarch64 on linux-musl, apple-darwin (plus universal2) and windows-msvc, on two conditions:

1. Do **not** link Apple frameworks. Use `/usr/bin/security` (or `dlopen` Security.framework at runtime [I]); otherwise you need a macOS SDK (`SDKROOT`) or a macOS runner.
2. Accept xwin's download of Microsoft's CRT and SDK (1.1 GB, under Microsoft's licence terms).

Alternatives:
- Native GitHub runners are listed as standard labels on docs.github.com [V]: `macos-14/15/26` (arm64), `macos-15-intel`, `windows-11-arm`, `ubuntu-24.04-arm`.
- `dist` (cargo-dist) uses native runners by default and "will transparently use either of: cargo-zigbuild [or] cargo-xwin" for other targets. Its docs also note that building aarch64-pc-windows-msvc "from an x86_64-unknown-linux-gnu runner is surprisingly easy via cargo-xwin" [V, dist book].

### 3.4 Compile times

Measured on musl x64, 4 vCPU [V]:

| Build | Time |
|---|---|
| Clean release (fat LTO, 1 CGU) | 59.8 s |
| Incremental release after touching main.rs | 20.8 s |
| Clean debug | 30.1 s |
| Incremental debug | 1.6 s |

The full six-target matrix ran sequentially in about 5 min on one 4-vCPU runner, after a warm toolchain (setup is about 1–4 min).

---

## 4. Runtime evidence

### 4.1 Linux x86_64 (static musl)

- `next` with all accounts capped prints `{"account":null,"cli":"codex","retry_at":"2026-10-07T23:00:00Z"}` with **exit=75**.
- `run --set FOO=bar -- sh -c '…; exit 7'` gives "child sees FOO=bar", **exit=7**.
- A child killed by SIGTERM gives **exit=143**.
- `exec` replaced the process (pid/ppid shown; exit 3 passed through).
- Signal test (`scripts/sigtest.sh`, run with `set -m`):
  - `SIGINT to group: wrapper exit=130 child-said=child-got-INT`
  - `SIGTERM to wrapper: wrapper exit=99 child-said=child-got-TERM`, i.e. forwarded.
  - Caveat: in a first attempt run under `setsid` from a non-job-control background, SIGINT was **pre-ignored** and inherited by the child, so the trap could not fire. This is a POSIX rule, not a Rust issue. limitshift should not background acctshift in a non-interactive shell and expect Ctrl+C semantics.
- `File::lock`: the second process printed `locked after 698.255934ms` while the first held the lock for 800 ms. Cross-process advisory locking works with std only.
- Atomic write produced a mode-`-rw-------` file. The symlink was created.
- PTY (portable-pty): the child printed `/dev/pts/0` and "stdout is a TTY", and **exit 5** was propagated.

### 4.2 Linux Secret Service (pure-Rust zbus)

The script `scripts/ss_session.sh` ran under `dbus-run-session`, with `gnome-keyring-daemon --unlock --components=secrets` and password `testpw`:

```
set exit=0 / {"found":true,"len":7} / del exit=0
label = keyring:alice@acctshift-test ; attribute.service = acctshift-test ; attribute.username = alice
interop: item created by `secret-tool store … service other-cli username bob` -> {"found":true,"len":14}
libdbus (vendored C) store reading the same item -> found 14 bytes
missing item -> {"found":false} exit 1
latency of one keyring read (new process + D-Bus + DH session + read): 10.8 ms ± 1.0 ms (100 runs)
```

- **Without a session bus:** `Platform failure: zbus error: Failed to connect to address 'unix:path=/run/user/0/bus': No such file or directory (os error 2)` in about 2 ms. A fallback is therefore cheap to detect [V].
- **Documented WSL caveat:** *"there is no 'default' collection defined under WSL. So this crate will not work on WSL unless you specify a non-default target modifier"* (zbus-secret-service-keyring-store 1.0.1 docs) [V, the docs; not tested on WSL].

### 4.3 Windows x64 under Wine 9.0 (not real Windows)

`scripts/wine_smoke.sh`:

```
next (all capped) exit=75
child sees ACCT=demo / run exit=7          (env injection + Job Object assignment + exit passthrough)
kr set exit=0 / {"found":true,"len":7}     (Credential Manager CredWriteW/CredReadW)
3000-byte secret -> "Value of 'secret' is longer than the platform limit of 2560 chars", exit 2
missing -> {"found":false}
atomic write / overwrite OK
lock OK, unlock -> "Lock violation. (os error 33)"     <- suspected Wine artifact
junction -> "Request not supported. (os error 50)"    <- Wine has no reparse points on its FS
```

`CRED_MAX_CREDENTIAL_BLOB_SIZE = 2560` is confirmed in `windows-sys-0.61.2/src/Windows/Win32/Security/Credentials/mod.rs:378` [V].

### 4.4 Startup latency

`hyperfine -N --warmup 50 --runs 1000` [V]:

| Command | Mean |
|---|---|
| Rust prototype, static musl, `version` | **0.33 ± 0.21 ms** |
| Rust prototype, musl, `next` (JSON parse + timestamps) | 0.36 ± 0.10 ms |
| Rust std-only hello (musl) | 0.34 ± 0.12 ms |
| Rust prototype, glibc dynamic | 1.6 ± 0.8 ms |
| Go hello, CGO_ENABLED=0, encoding/json, 1.70 MB (baseline only; lang-go track has the real data) | 1.5 ± 0.4 ms |
| /usr/bin/true (dynamic glibc) | 1.3 ± 0.3 ms |
| bash -c : | 1.9 ± 0.6 ms |
| jq -n 1 | 2.8 ± 0.6 ms |

These are all negligible next to the CLIs being driven: Claude Code's binary alone is about 251 MB. So latency cannot be a deciding factor between compiled languages.

---

## 5. OS credential stores in Rust (criterion 5)

### macOS

**Option A: `security-framework` 3.7.0** (MIT/Apache, kornelski).
- It is used by `apple-native-keyring-store` 1.0.2 via the legacy `SecKeychain` and `find_generic_password` APIs [V source]. The `protected` feature uses the data-protection keychain and needs entitlements.
- It links Security.framework and CoreFoundation, which **breaks Linux cross-compilation** [V].
- Items it creates trust the acctshift binary in their ACL. An ad-hoc-signed binary changes its cdhash on every update, so expect "acctshift wants to use your confidential information" prompts after upgrades unless the binary is Developer-ID signed with a stable designated requirement [I].
- Reading an item created by `/usr/bin/security` (Claude Code's item, per the context facts) from our own binary would prompt [I].

**Option B (recommended): spawn `/usr/bin/security -i` and send commands on stdin.**
- No secret appears in argv, so `ps` cannot see it.
- Apple's signed tool stays the accessor, so there is no prompt on items created through `security`.
- No SDK is needed.
- Implemented in the prototype (`cmd_sec`) [V compiles] [I behaviour, needs a Mac].

### Linux

- **`zbus` 5.19.0** (pure Rust, MIT) via `secret-service` 5.2.0 and `zbus-secret-service-keyring-store` 1.0.1 with `crypto-rust` (aes, cbc, hkdf, sha2, num-bigint DH). No libdbus and no C; works in static musl [V].
- **Alternative:** `dbus-secret-service-keyring-store` with `vendored`, which compiles libdbus C (AFL/GPL) [V].
- **Fallbacks:**
  - `linux-keyutils-keyring-store` 1.0.0: kernel keyring, lost at reboot [I].
  - A 0600 file under `$XDG_STATE_HOME` or `$XDG_DATA_HOME`, as Claude Code itself does on Linux per the context facts.

### Windows

- **`windows-native-keyring-store` 1.1.0** (MIT/Apache) on `windows-sys` 0.61.2.
  - `windows-sys` uses `windows-link` with `#[link(kind = "raw-dylib")]`, so no import libraries are needed for Win32 APIs [V].
  - An explicit `target` modifier gives an exact `TargetName`, which allows interop with other apps' entries. The default name is `{user}.{service}` [V docs].
  - `set_password` stores **UTF-16LE**; `set_secret` stores raw bytes. Interop with tools that store UTF-8 (e.g. Go's go-keyring [I]) needs `get_secret`/`set_secret` [V source `utils.rs`].
  - Enforces the 2560-byte limit [V].
  - Default persistence is **Enterprise** (roams with domain profiles), so pass `persistence=Local` [V docs].
- **DPAPI (`CryptProtectData`)** via windows-sys compiles [V]. Use it for blobs over 2560 B, such as a Codex `auth.json` [I size].

### Ecosystem signal

OpenAI Codex, one of the CLIs acctshift manages, is Rust and uses `keyring = { version = "3.6", default-features = false }` [V, raw.githubusercontent.com/openai/codex/main/codex-rs/Cargo.toml]. Per platform:
- macOS: `apple-native` + `security-framework = "3"`
- Linux: `linux-native-async-persistent` + `secret-service = "4"`
- Windows: `windows-native`

It also uses `portable-pty = "0.9.0"` and `windows-sys = "0.61.2"` [V].

If acctshift ever has to swap Codex credentials stored with `cli_auth_credentials_store="keyring"`, using the same crate family reproduces the naming conventions exactly. This is a minor but real Rust advantage. Note that keyring 4.x conventions may differ from 3.x [I].

---

## 6. Process control (criterion 6)

| Need | Rust answer | Status |
|---|---|---|
| Spawn with env, stdio, exit passthrough | `std::process::Command` | [V] Linux and Wine |
| Replace process (Unix) | `CommandExt::exec`, stable 1.9.0 | [V] |
| Signal forwarding | No std API; use `libc::signal`/`sigaction` (unsafe) or the `signal-hook` 0.4.5 / `ctrlc` 3.5.2 crates (MIT/Apache) | [V] Linux |
| Windows Ctrl+C | `SetConsoleCtrlHandler(NULL,TRUE)`. MS docs: *"This attribute of ignoring or processing CTRL+C is inherited by child processes"*, so call it **after** spawn (as the prototype does) or register a handler that returns TRUE | [V docs] |
| Kill process tree | Unix: `CommandExt::process_group(0)` (stable 1.64.0) + `killpg`. Windows: Job Object `KILL_ON_JOB_CLOSE` via windows-sys (`command-group` is stale since 2023; `process-wrap` is its successor [I]) | [V compile and Wine run] |
| PTY / ConPTY (phase 2) | `portable-pty` 0.9.0 (MIT, wezterm; last release 2025-02; depends on winapi 0.3) | [V] Linux run; mac and Windows compile |
| Advisory locking | std `File::lock`/`try_lock`: `flock(LOCK_EX)` on Linux/macOS, `LockFileEx` on Windows | [V] source and Linux run |
| Atomic writes | std `rename`: `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` with a `FileRenameInfoEx` fallback on Windows | [V] source |
| Symlinks / junctions | std `symlink_dir` passes `SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE`, which works without admin **only in Developer Mode**. `junction` 2.1.0 creates junctions without privileges | [V] source; junction not verifiable under Wine |
| Windows PATH lookup | std `resolve_exe` appends only `.exe` (not PATHEXT), so `codex.cmd`/`gemini.cmd` npm shims need the `which` crate (8.0.6) or a manual PATHEXT walk | [V] rust-src |
| .cmd/.bat argument safety | Since the BatBadBut fix, std escapes batch arguments and **refuses `\r`/`\n` in arguments to .bat/.cmd with InvalidInput**. Multi-line prompts must go to a native .exe or `node <script.js>`, not an npm shim. `raw_arg` (1.62.0) exists | [V] rust-src |

---

## 7. Trust and distribution (criterion 7)

### macOS

- `curl` does not set `com.apple.quarantine`, so Gatekeeper does not assess curl-installed binaries. On arm64, *"an ad-hoc signature is sufficient"* [V, secondary sources: Unit42 and users.rust-lang.org thread]. zig adds that signature automatically [V].
- Browser downloads get quarantined and need Developer ID signing and notarization ($99/yr Apple Developer Program [I]).
- `rcodesign` (apple-codesign, Rust, MIT/Apache) can sign and notarize from Linux with an App Store Connect API key [V docs]. Its last release is 0.29.0 from 2024-11-29 [V crates.io], so maintenance is slowing.
- Homebrew 5.0 deprecated `--no-quarantine` and is removing unsigned or un-notarized **casks** from the official tap by September 2026 [V, workbrew]. A formula in the user's own tap (a CLI binary fetched by brew's curl) is not covered by that change [I].

### Windows

- Unsigned browser-downloaded EXEs get a SmartScreen warning (Mark-of-the-Web) [I].
- Rust binaries do get ML-based Defender false positives, e.g. "Trojan:Win32/Bearfoos.A!ml" on users.rust-lang.org. The explanation given there: *"there weren't many rust executables in the datasets these tools were trained on"* [V forum]. Go has a long-standing FAQ entry on the same problem [I].
- Mitigations: code signing (Azure Artifact/Trusted Signing, SignPath for OSS, Certum OSS certificate [I]), submitting false positives to Microsoft, and distributing through winget or Scoop.

---

## 8. Licences and supply chain (criterion 8)

`cargo tree -f '{p} | {l}'` across linux-musl, aarch64-darwin, x86_64-msvc and aarch64-msvc with the pty feature gives **134 unique crates**. Licence counts:

| Licence string | Crates |
|---|---|
| MIT OR Apache-2.0 | 75 |
| Apache-2.0 OR MIT | 25 |
| MIT | 21 |
| Unlicense OR MIT | 4 |
| MIT/Apache-2.0 | 4 |
| Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | 2 |
| BSD-2-Clause OR Apache-2.0 | 1 |
| Apache-2.0/MIT | 1 |
| (MIT OR Apache-2.0) AND Unicode-3.0 | 1 |

All are permissive [V].

Per-target crate counts (normal + build): linux-musl **107** (15 without zbus); macOS 23; Windows 23 (18 without keyring) [V].

Tooling, versions per the crates.io API [V]:
- cargo-deny 0.20.2 (licences, advisories, bans)
- cargo-audit 0.22.2 (RustSec)
- cargo-vet 0.10.2
- cargo-auditable 0.7.7 (embeds an SBOM in the binary)
- zeroize 1.9.1, already used by the Windows store to wipe blobs [V source]

Rust std is MIT/Apache, musl is MIT, and static linking of the MSVC CRT is permitted [I].

---

## 9. Maintainability with AI agents (criterion 9)

**Pros:**
- Strong types and exhaustive `match` suit an account state machine.
- `cargo test`, `clippy`, `rustfmt`, `insta` 1.49.0, `assert_cmd` 2.2.2 and `cargo-nextest` 0.9.146 are available [V].
- keyring-core has an in-memory `sample` store for tests [V Cargo features].
- Refactors are compiler-checked.
- The prototype compiled first time for three OS families [V].

**Cons:**
- The borrow checker and async (zbus) add learning cost.
- Every agent edit-compile loop costs 1.6 s (debug) to 21 s (release LTO).
- Reviewing agent-written `unsafe` FFI (signals, Job Objects, DPAPI) needs Rust and Win32 literacy.
- The user's own repos contain bash, PowerShell and Node `.mjs`, and no `Cargo.toml` or `go.mod` (`find /home/user -maxdepth 4`) [V].
- Published evidence: Rust-SWE-bench (arXiv 2602.22764, Feb 2026) reports ReAct agents resolving *"up to 21.2%"* of Rust issues (28.6% with their RustForger), limited by *"complying with Rust's strict type and trait semantics"* [V abstract].
- Ecosystem churn: keyring major lines 1.x 2021-11, 2.x 2022-10, 3.x 2024-07, 4.x 2025-11. zbus 3.x 2022-08, 4.x 2024-02, 5.x 2024-10. windows-sys 0.48→0.52→0.59→0.60→0.61 between 2023-03 and 2025-09 [V crates.io API].
- MSRV creep: keyring 4.2 needs rustc 1.88 and cargo-xwin 1.89 [V `cargo info`].

---

## 10. Fit with limitshift (criterion 10)

- `--json` output plus exit codes such as 75 (EX_TEMPFAIL) are trivial to consume from `jq` and from `ConvertFrom-Json` (limitshift v2 requires PowerShell 7).
- No code can be shared with bash or PowerShell. Tests can be shared only black-box: limitshift's `tests/test-limitshift.sh` and Pester tests calling the binary with fake CLI shims.
- Rust adds a **new** toolchain (rustup + zig + cargo-zigbuild + cargo-xwin) to a world that today is bash, PowerShell 7 and Node. Go appears only as a third-party build dependency in ai-switcher's `packaging/build-agm.mjs` (`CGO_ENABLED: '0'` for five targets) [V].
- End users would install prebuilt binaries, so this burden falls only on the maintainer and CI.

Suggested release asset set (five files):
- `acctshift-linux-x64-musl.tar.gz`
- `acctshift-linux-arm64-musl.tar.gz`
- `acctshift-macos-universal2.tar.gz`
- `acctshift-windows-x64.zip`
- `acctshift-windows-arm64.zip`

Plus `SHA256SUMS`. limitshift.sh can pick the asset with `uname -s/-m` (static musl covers glibc, Alpine and WSL) and verify with `shasum -a 256`, which ships with macOS. limitshift.ps1 can use `$env:PROCESSOR_ARCHITECTURE` and `Get-FileHash`.

---

## 11. Packaging channels (criterion 11)

- **`dist` (cargo-dist):**
  - Releases: GitHub v0.33.0 on 2026-09-11; v0.32.0 on 2026-05-22; v0.31.0 on 2026-02-23 [V].
  - Installers: shell (`curl | sh`), PowerShell (`irm | iex`), npm, Homebrew formula and MSI [V book].
  - WinGet and Cask are listed as *not yet implemented* [V book].
  - It also supports non-Rust "custom build" projects, so it is not exclusive to Rust [V search].
  - Self-update: `axoupdater` 0.10.2 [V]. Alternative: `self_update` 1.3.0 [V].
- **Rust-specific channels:**
  - `cargo install` and `cargo binstall` (1.25.2, fetches release binaries) [V]
  - `cargo-deb` 3.8.0 for apt-style .deb files [V]
  - `maturin` 1.15.0 can ship the binary as a PyPI wheel for `uvx`/`pipx` [V, version; I, applicability]
- **Language-neutral:** Scoop and winget manifests, AUR `-bin`, npm `optionalDependencies` per platform.

---

## 12. Long-term risk (criterion 12)

**Low risk:**
- The language is stable (1.x backward compatibility, opt-in editions, six-weekly releases) [I].
- Target tiers per doc.rust-lang.org platform-support [V]:
  - Tier 1 with host tools: aarch64-apple-darwin, x86_64/aarch64-pc-windows-msvc, x86_64/aarch64-unknown-linux-gnu.
  - Tier 2 with host tools: both musl targets (musl 1.2.5) and **x86_64-apple-darwin, which has been demoted** (macOS 10.12+).

**Medium risk:**
- Crate churn (section 9) and single-maintainer crates: keyring-rs is maintained by Dan Brotsky [V README]; portable-pty sits inside wezterm with infrequent releases [V].
- `apple-codesign` has had no release since 2024-11 [V].

---

## 13. Design consequences for the spec (if Rust is chosen)

1. **Linux:** ship static musl (x64 and arm64). Never ship host-gnu builds.
2. **macOS:** ship universal2, built with cargo-zigbuild or on a macOS runner.
3. **Windows:** build msvc with `+crt-static`, and add `/Brepro /DEBUG:NONE` for reproducible builds.
4. **macOS keychain:** a `SecurityCli` backend driving `/usr/bin/security -i` over stdin. A `security-framework` backend is optional, behind a cargo feature, and only for macOS-runner builds.
5. **Linux credential store:** zbus Secret Service. Probe the bus once; on failure (about 2 ms), or on WSL without a default collection, fall back to a 0600 file store, and print a `doctor` hint (`gnome-keyring-daemon --unlock`).
6. **Windows credential store:** Credential Manager with explicit `target` and `persistence=Local` for tokens up to 2560 B; DPAPI-protected files for larger blobs.
7. **Process launching:**
   - Unix `exec` when no post-processing is needed.
   - Otherwise spawn and wait, with signal forwarding (Unix) or a Job Object plus post-spawn Ctrl+C ignore (Windows).
   - Resolve PATHEXT with `which`; never pass multi-line arguments through `.cmd` shims.
8. **Locking:** std `File::lock` on `<state>/acctshift.lock`.
9. **State writes:** temp file, then fsync, then rename, with mode 0600.
10. **Release profile:** `opt-level="s"`, `lto="fat"`, `codegen-units=1`, `panic="abort"`, `strip=true`.
11. **CI checks:** cargo-deny (licences, including a manual allowlist rule against vendored C code), cargo-audit, and test jobs on `macos-14`, `windows-latest`, `windows-11-arm` and `ubuntu-24.04-arm`.

---

## 14. Verdict

**Rust is the right choice when:**
- the maintainer is willing to own a Rust codebase and its cross toolchain;
- smallest and fastest static binaries matter;
- phase 2 (PTY wrapper with live output parsing) is a real goal: portable-pty is battle-tested, including by Codex;
- matching Codex's keyring-rs conventions has value;
- compile-time guarantees are wanted as the guard-rail for agent-written code.

**It is not the right choice when:**
- the priority is the lowest-friction solo maintenance and the fastest agent iteration on a tool whose logic is mostly I/O glue around fast-changing vendor login formats;
- the user wants one simple `GOOS/GOARCH`-style cross-build with no zig, xwin or SDK caveats.

Rust's measurable advantages here (0.33 ms vs about 1.5 ms startup; 0.55–1.9 MB binaries) do not matter beside the 250 MB CLIs being driven.

**Single biggest risk for THIS project:** maintainer velocity and reviewability. A solo bash/PowerShell/Node maintainer would be taking on Rust, async D-Bus, unsafe Win32 FFI and a three-tool cross-compile chain. Meanwhile the product's correctness depends on quickly tracking undocumented changes in Claude, Codex and agy authentication storage. A secondary technical trap that the spec must avoid: the idiomatic macOS path (security-framework) breaks Linux cross-builds and triggers keychain ACL prompts. Use `/usr/bin/security`.

## Open questions

- Run the zig-built aarch64 and x86_64 macOS binaries (and universal2) on real Macs (macOS 12-26): plain run after curl, after a browser download (quarantine), and via a Homebrew formula in a personal tap.
- On a real Mac, verify that 'security -i' accepts quoted add-generic-password/find-generic-password commands on stdin, and that reading Claude Code's 'Claude Code-credentials[-hash]' item through /usr/bin/security never prompts while a Security.framework read from acctshift does.
- Measure how often keychain prompts appear after acctshift upgrades if it owns items via Security.framework with ad-hoc vs Developer ID signing.
- On real Windows 10/11 x64 and arm64: Job Object kill-on-close for the whole tree, Ctrl+C semantics with SetConsoleCtrlHandler after spawn, File::lock/unlock (Wine gave 'Lock violation' on unlock), junction creation without admin, Credential Manager persistence=Local vs the Enterprise default, and running npm .cmd shims with multi-line prompts.
- Run Windows Defender/SmartScreen and a VirusTotal scan on unsigned release EXEs of the prototype; compare with a Go build of the same features.
- Linux Secret Service variants: KDE Wallet (kwalletd secret-service API, UTF-8-only), KeePassXC, a locked login keyring (prompt behaviour), WSL2 without a default collection, Alpine with static musl.
- agy's credential-store conventions (library, service/target names, attribute set, macOS ACL) are needed to decide whether keyring-core with explicit targets/attributes or raw APIs are required.
- If Codex keyring mode must be supported: confirm Codex's entry naming (keyring 3.6, linux-native-async-persistent) and whether keyring 4.x stores read and write it identically.
- Compile-time and CI cost on 2-vCPU private GitHub runners (if the repo is private) and whether dist's native-runner default or a single zig/xwin job is cheaper.
- Whether rcodesign (last release 2024-11) still notarizes successfully today, or whether notarization must run on a macOS runner with notarytool.

## Sources

- Prototype source, scripts, logs and benchmark (this run): /tmp/claude-0/-home-user/228bfb4e-0bd0-5413-8490-21fae890d3fa/scratchpad/lang-rust/ (proto/src/main.rs, proto/Cargo.toml, scripts/*.sh, scripts/verify_adhoc.py, bench/startup.md, licenses.txt, build-*.log)
- keyring 4.2.0 crate README/Cargo.toml (features v1, store split): https://crates.io/crates/keyring/4.2.0 (read from ~/.cargo/registry/src/*/keyring-4.2.0)
- windows-native-keyring-store 1.1.0 source (target names, UTF-16, blob limit): https://crates.io/crates/windows-native-keyring-store
- zbus-secret-service-keyring-store 1.0.1 docs (attributes, headless, WSL caveat): https://crates.io/crates/zbus-secret-service-keyring-store
- apple-native-keyring-store 1.0.2 (legacy SecKeychain via security-framework): https://crates.io/crates/apple-native-keyring-store
- libdbus-sys 0.2.7 vendored COPYING (AFL-2.1 or GPL-2.0+): https://crates.io/crates/libdbus-sys
- windows-sys 0.61.2 CRED_MAX_CREDENTIAL_BLOB_SIZE: https://crates.io/crates/windows-sys (src/Windows/Win32/Security/Credentials/mod.rs:378)
- Rust std source 1.97.0 (File::lock 1.89.0, resolve_exe, bat arg escaping, symlink flags, rename): rustup component rust-src: library/std/src/fs.rs, sys/process/windows.rs, sys/args/windows.rs, sys/fs/windows.rs
- cargo-zigbuild README (SDKROOT needed for darwin frameworks): https://github.com/rust-cross/cargo-zigbuild
- cargo-xwin: https://github.com/rust-cross/cargo-xwin
- Zig download index (0.15.2 checksum, 0.17.0 latest): https://ziglang.org/download/index.json
- Rust platform support tiers: https://doc.rust-lang.org/stable/rustc/platform-support.html
- OpenAI Codex workspace Cargo.toml (keyring 3.6, portable-pty 0.9.0, windows-sys 0.61.2): https://raw.githubusercontent.com/openai/codex/main/codex-rs/Cargo.toml
- OpenAI Codex keyring-store Cargo.toml (per-platform keyring features): https://raw.githubusercontent.com/openai/codex/main/codex-rs/keyring-store/Cargo.toml
- dist (cargo-dist) releases: https://github.com/axodotdev/cargo-dist/releases
- dist book: installers: https://axodotdev.github.io/cargo-dist/book/installers/index.html
- dist book: CI customizing (native runners, zigbuild/xwin): https://axodotdev.github.io/cargo-dist/book/ci/customizing.html
- GitHub-hosted runner labels: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- Windows on Arm runners for public repos (Apr 2025): https://blogs.windows.com/windowsdeveloper/2025/04/14/github-actions-now-supports-windows-on-arm-runners-for-all-public-repos/
- ARM64 runners in private repos (Feb 2026): https://dev.classmethod.jp/articles/github-actions-arm64-private-repos/
- SetConsoleCtrlHandler (inheritance of Ctrl+C ignore): https://learn.microsoft.com/en-us/windows/console/setconsolectrlhandler
- Homebrew 5.0.0 cask signing/notarization changes: https://workbrew.com/blog/what-homebrew-5-0-0-means-for-your-mac-fleet
- Distributing CLI apps on macOS (ad-hoc signature sufficient on arm64): https://users.rust-lang.org/t/distributing-cli-apps-on-macos/70223
- Unit42 on curl not setting quarantine: https://unit42.paloaltonetworks.com/gatekeeper-bypass-macos
- rcodesign notarization docs: https://gregoryszorc.com/docs/apple-codesign/main/apple_codesign_rcodesign_notarizing.html
- Rust Defender false positive thread (Bearfoos.A!ml): https://users.rust-lang.org/t/why-my-windows-defender-think-my-rust-file-is-trojan/111832
- Rust-SWE-bench / RustForger paper (Feb 2026): https://arxiv.org/abs/2602.22764
- crates.io API (versions, dates, downloads for keyring, zbus, windows-sys, cargo-dist, apple-codesign, etc.): https://crates.io/api/v1/crates/<name>
- ai-switcher packaging (requirements only: agm built with CGO_ENABLED=0 for 5 targets): /home/user/ai-switcher/packaging/build-agm.mjs, packaging/targets.mjs, launcher/agy.mjs
