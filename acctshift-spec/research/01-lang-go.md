# Research track: lang-go

_Research date: 2026-10-07. Claims are marked VERIFIED (evidence gathered during the research) or INFERRED._

## Summary

Go is a strong, low-risk fit for acctshift. Several of its strengths showed up in this sandbox; the weaknesses are concentrated on Windows. I installed the current stable Go 1.27.1 and built a 369-line prototype that reads env vars, spawns with exec or spawn+wait, forwards signals, handles Windows job objects, ConPTY via go-pty, gofrs/flock locking, atomic writes, zalando/go-keyring, a raw /usr/bin/security read and a Windows junction. With CGO_ENABLED=0, one Linux x64 runner cross-compiled all six targets (linux/darwin/windows × amd64/arm64). Each target took about 15 s cold and 0.3 s incremental, stripped binaries were 3.8–4.7 MB (1.7–2.1 MB compressed), and rebuilds were byte-identical. The Linux binary is fully static. It ran inside an empty chroot with no libc and no /etc, so musl/Alpine and WSL work, and it ran on linux/arm64 under qemu. Median per-call latency was about 1.8–2.0 ms, against jq at 2.7 ms and node at 23 ms. darwin/arm64 binaries get an ad-hoc LC_CODE_SIGNATURE from the Go linker automatically. The most important finding for this project: Google's Antigravity CLI (agy 1.3.1) is itself a Go program and uses zalando/go-keyring on all three OSes, with a file fallback. A Go acctshift can therefore read and write agy's credential slot byte-for-byte using the very same library. GoReleaser OSS v2.18.2 produced archives, checksums, deb/rpm/apk/arch packages, Homebrew cask, Scoop, winget and AUR manifests from that one runner in about 3 s. Go's real weaknesses are on Windows. Unsigned Go executables have a documented, ongoing history of Defender machine-learning false positives. os/exec does not escape arguments for .cmd/.bat targets (golang/go#69939 is still open, which matters for npm shims). os/exec has no ConPTY or job-object hooks and there is no junction API, so about 100–200 lines of x/sys code are needed. On macOS, Go cannot use Security.framework without cgo or purego; the richer byteness/keyring library failed to cross-compile for darwin. Verdict: choose Go if acctshift ships as a CGO_ENABLED=0 single binary, uses /usr/bin/security on macOS, and has a Windows signing plan. The single biggest risk is Defender or SmartScreen quarantining an unsigned Go .exe that spawns processes and touches credential stores.

## Scorecard

| Criterion | Score (1-5) | Rationale |
|---|---|---|
| 1. Platform reach | 5 | VERIFIED: all six targets build natively, including windows/arm64. The static Linux binary covers musl/Alpine and WSL. Minimums are Linux 3.2+, Windows 10+, and macOS 13+ under Go 1.27 (macOS 12 needs Go 1.26). |
| 2. End-user footprint | 5 | VERIFIED: a single 3.2–4.7 MB file (1.7–2.1 MB compressed) with zero runtime dependencies. It runs in an empty chroot; on macOS it needs only /usr/bin/security; no jq, pwsh, bash 4, secret-tool or .NET. It is roughly 10x larger than Rust, but trivial next to 200–300 MB CLIs. |
| 3. Startup latency / per-call overhead | 4.5 | VERIFIED: 1.8–2.0 ms median per call, versus jq 2.7 ms and node 23 ms; about 0.5–1 ms slower than Rust or C. Wrapper RSS is about 4.5 MB. |
| 4. Build / cross-compilation | 5 | VERIFIED: one Linux runner, no SDK, osxcross or zig; byte-identical rebuilds; 0.3 s incremental builds. This holds only while the code stays cgo-free (byteness/keyring breaks darwin), and -race needs cgo in CI. |
| 5. OS credential store access | 4 | VERIFIED: zalando/go-keyring is exactly what agy uses on all three OSes, so items are byte-compatible. godbus and wincred are pure Go, and x/sys covers DPAPI and keyctl. Downsides: native Security.framework needs cgo or purego; go-keyring has fixed attributes, a plain session and autolaunches D-Bus; a headless fallback must be written. |
| 6. Process control | 4 | VERIFIED: exec, spawn, signals, group kill, flock and atomic rename all work on Linux. On Windows, os/exec lacks job objects and ConPTY and there is no junction API (x/sys code needed). The .cmd/.bat argument escaping issue golang/go#69939 is open, which matters for npm shims. |
| 7. Trust / distribution friction | 3 | macOS is good (VERIFIED automatic arm64 ad-hoc signature; notarization from Linux via GoReleaser OSS + quill). Windows is the weak spot: there is a documented, ongoing history of Defender ML false positives on Go executables, and the PE has no resources. Signing is effectively required, and Artifact Signing for individuals is US/CA only. |
| 8. Dependency licenses & supply chain | 5 | VERIFIED: all MIT, BSD-2/3 or Apache-2.0, with a tiny module graph. Go's checksum database and govulncheck provide reachability analysis. Binary scanners do produce CVE noise. |
| 9. Maintainability (solo + AI agents) | 4.5 | VERIFIED: fast build and test loops, with built-in testing, fuzzing, vet and gofmt. INFERRED: agents write compiling Go reliably; Rust agents struggle with type and trait semantics per Rust-SWE-bench 2026. Weaker compile-time guarantees than Rust: no sum types, and nil and err pitfalls. Windows code paths need Windows CI. |
| 10. Fit with limitshift | 3.5 | VERIFIED: callable identically from bash and pwsh, with JSON output and exit codes. It cannot share code with the bash/pwsh limitshift, only black-box tests. It adds a developer toolchain, which the user has already used for agm. |
| 11. Packaging channels | 4.5 | VERIFIED: GoReleaser OSS snapshot produced archives, checksums, deb/rpm/apk/arch, AUR, winget, Scoop and a Homebrew cask. The npm publisher is Pro-only, so npm must be hand-rolled. Self-update is available via go-selfupdate (MIT). |
| 12. Long-term risk | 4.5 | INFERRED: Go 1 compatibility promise, Google-backed, huge adoption (agy itself is Go). VERIFIED churn: macOS minimum bumped to 13 in 1.27, encoding/json moved to the v2 backend, and some libraries are slow-moving (creack/pty, 99designs/keyring). |

## Conclusions

| # | Claim | Status | Confidence | Evidence | What the spec should do |
|---|---|---|---|---|---|
| 1 | Go 1.27.1 with CGO_ENABLED=0 cross-compiles all six required targets (linux/darwin/windows x amd64/arm64) from one Linux x64 runner with no SDKs, and the builds are reproducible. | VERIFIED | high | Built the 369-line prototype for all six targets: about 14–16 s cold each, 0.28–0.36 s incremental. Rebuilds of linux/amd64, darwin/arm64 and windows/amd64 had identical sha256 hashes. `file` output: ELF static, Mach-O arm64/x86_64, PE32+ x86-64/Aarch64. | Release pipeline: a single ubuntu runner with GoReleaser OSS. Add a CI guard that forbids any cgo dependency, because one cgo module breaks darwin cross-builds. |
| 2 | The Linux binary needs no libc at all, so musl/Alpine, any glibc and WSL are covered by the same artifact. | VERIFIED | high | `readelf`: no PT_INTERP and no dynamic section. `chroot <empty dir with only the binary> /acct env HOME` printed valid JSON. linux/arm64 also ran under qemu-aarch64-static. | Ship exactly two Linux artifacts (amd64, arm64); no separate musl build is needed. |
| 3 | Per-call overhead is about 1.8–2.0 ms median on Linux, lower than jq (2.66 ms) and node (23 ms), and about 0.5–1 ms above C or Rust. | VERIFIED | high | Go harness, 400 runs per command. acctproto nop 1.81 ms (p95 2.30); env+JSON 2.02 ms; lock 2.28 ms; /bin/true 0.99 ms; Rust hello 1.29 ms; node -e 0 23.18 ms. The waiting wrapper had VmRSS 4.5 MB and 7 threads. | limitshift may call acctshift several times per task without any batching or daemon. |
| 4 | darwin/arm64 Go binaries carry an ad-hoc LC_CODE_SIGNATURE automatically, so they run on Apple silicon without codesign, and their minimum macOS is 13.0 under Go 1.27. | VERIFIED | high | `llvm-objdump --macho --private-headers` on the darwin/arm64 build showed LC_CODE_SIGNATURE, minos 13.0 and sdk 26.2. The Go 1.27 release notes say it requires macOS 13 Ventura. | A curl-based installer works on Apple silicon without Apple tooling. Document macOS 13+, or pin Go 1.26 if macOS 12 support is required. Notarization (GoReleaser OSS + quill, $99/yr) is optional and only matters for browser downloads and casks. |
| 5 | Google's Antigravity CLI (agy 1.3.1) is a Go binary that uses zalando/go-keyring on Linux, macOS and Windows, with a file-based token fallback. | VERIFIED | high | Strings and symbols from the sha512-verified 1.3.1 binaries: - go_keyring keyring.{Get,Set,Delete} and secretServiceProvider (linux); - macOSXKeychain with '/usr/bin/security' and 'go-keyring-base64:' (darwin); - windowsKeychain with danieljoos/wincred and CredReadW/CredWriteW (windows); - codeassistclient compositeTokenStorage, fileTokenStorage, shouldBypassKeyring; - Go buildinfo 'go1.28-20260921-RC02'. | A Go acctshift can swap agy's slot with the identical library, so items are byte-compatible. The spec must also handle agy's file-fallback store and confirm agy's service and user names on real machines. |
| 6 | zalando/go-keyring stores macOS values as 'go-keyring-base64:'+base64 via `/usr/bin/security -i` (4096-char line limit); Windows values as generic credentials 'service:user' with a 2560-byte cap; Linux values over Secret Service with attributes {username, service} in the login collection, using a 'plain' session. | VERIFIED | high | Read keyring_darwin.go, keyring_windows.go, keyring_unix.go and secret_service.go in module v0.2.8. | Use go-keyring only for agy's slot. acctshift's own vault needs DPAPI files on Windows, because Codex auth.json exceeds 2560 bytes. Never pass secrets on argv. |
| 7 | godbus (via go-keyring) tries to autolaunch dbus-launch when no session bus is found, which is a hazard on headless Linux or WSL. | VERIFIED | high | Running kr-get without D-Bus returned 'exec: "dbus-launch": executable file not found in $PATH'. godbus conn.go:77-88 falls back to getSessionBusPlatformAddress(), which runs `dbus-launch`. | Probe DBUS_SESSION_BUS_ADDRESS or $XDG_RUNTIME_DIR/bus, or use SessionBusPrivateNoAutoStartup, before any Secret Service call. Fall back to the kernel keyring or a 0600 file, and report this in `doctor`. |
| 8 | Native Security.framework keychain libraries need cgo and break Linux cross-compilation; byteness/keyring fails for darwin with CGO_ENABLED=0. | VERIFIED | high | Without cgo: 'imports github.com/noamcohen97/touchid-go: build constraints exclude all Go files'. With cgo: 'clang: error: unsupported option -arch'. keybase/go-keychain has `import "C"`. purego Dlopen of Security.framework compiles without cgo. | On macOS use `/usr/bin/security` via exec (as agy and Claude Code do). Keep purego as the only escape hatch. Prefer CLAUDE_CODE_OAUTH_TOKEN injection over touching Claude's keychain item (see the Claude.app partition-list bug #62213). |
| 9 | Go's os/exec does not escape arguments correctly for .cmd/.bat targets on Windows (BatBadBut class), and the upstream issue is still open. | VERIFIED | high | golang/go#69939 is open with NeedsDecision and says 'os/exec doesn't correctly escape nor quote *.bat, *.cmd, cmd /c * arguments'. | acctshift exec on Windows must resolve npm .cmd shims to node.exe plus the JS entry, or apply cmd.exe quoting through SysProcAttr.CmdLine, or refuse dangerous metacharacters. Add tests with quotes, %, ^ and & in args. |
| 10 | Go's standard library has no ConPTY or job-object support in os/exec and no junction-creation API; golang.org/x/sys provides all the primitives needed. | VERIFIED | high | Go 1.27.1 syscall.SysProcAttr (Windows) has no such fields. go-pty's README cites go#62708. x/sys v0.48.0 exports CreateJobObject, AssignProcessToJobObject, CreatePseudoConsole, CryptProtectData, LockFileEx, DeviceIoControl and FSCTL_SET_REPARSE_POINT. The prototype's job-object and junction code compiles for windows/amd64 and arm64. | Budget about 150–200 lines of Windows-specific code. Assign self to a kill-on-close job before spawning, and create Codex directory junctions via FSCTL_SET_REPARSE_POINT. Phase-2 ConPTY: creack/pty plus own x/sys ConPTY, or charmbracelet/x/xpty. |
| 11 | POSIX process control works as required: env injection, exit-code passthrough including 128+signal, signal forwarding to the process group, and tree kill on SIGTERM. SIGKILL of the wrapper orphans grandchildren. | VERIFIED | high | Linux tests: exit 42, exec exit 7, signaled exit 143, forwarded SIGINT gave 130 with 'child-got-INT', no orphans after SIGTERM; `sleep 33` survived SIGKILL of the wrapper. gofrs/flock waited about 1716 ms behind a flock(1) holder. | Use syscall.Exec for plain exec mode. In watch mode use Setpgid with forwarding, plus Pdeathsig on Linux; document that macOS has no Pdeathsig equivalent. |
| 12 | Unsigned Go Windows executables have a documented, ongoing history of Microsoft Defender ML false positives. | VERIFIED | medium | Go FAQ ('a common occurrence, especially on Windows'); microsoft/go#1255, open since 2024-06; kachick/dotfiles#851 (Go 1.23: Wacatac.B!ml, Sabsik.FL.A!ml); SilverBullet Go rewrite 2025 (Wacatac.H!ml, Bearfoos.A!ml). The Go PE imports only kernel32.dll and has no .rsrc. | Plan Authenticode signing (Azure Artifact Signing is for US/CA individuals only, about $9.99/mo; SignPath OSS or an OV certificate otherwise). Embed VERSIONINFO and a manifest, never use UPX or garble, and test release candidates on Windows Defender before publishing. |
| 13 | GoReleaser OSS produces every needed channel from one runner, except npm, which is Pro-only. | VERIFIED | high | A v2.18.2 snapshot produced six archives, deb/rpm/apk/archlinux packages, an AUR PKGBUILD, winget manifests, a Homebrew cask, a Scoop manifest and checksums.txt in about 3 s. GoReleaser docs: npm publisher 'exclusively available with GoReleaser Pro' since v2.8; brews deprecated since v2.10 but still working. | Use GoReleaser OSS. Hand-roll an npm optionalDependencies wrapper. For Homebrew, use a personal tap: a cask needs notarization or the quarantine hook, because Homebrew 5 disables Gatekeeper-failing casks in homebrew-cask from Sept 2026. |
| 14 | Go needs embedded tzdata to parse IANA zone names on Windows and minimal Linux, and os/user does not work without cgo unless $USER/$HOME are set. | VERIFIED | high | In the empty chroot: 'unknown time zone Europe/Kyiv'; with `import _ time/tzdata`: ok (+405 KB). user.Current: 'requires cgo or $USER set'. | Import time/tzdata and use $HOME/$USER together with os.UserHomeDir(). |
| 15 | All candidate dependencies are permissively licensed and the dependency graph is small. | VERIFIED | high | LICENSE files: - MIT: go-keyring, wincred, creack/pty, go-pty, xpty/conpty, go-selfupdate, kong, byteness/keyring, goversioninfo - BSD-2: godbus - BSD-3: x/sys, x/crypto, gofrs/flock, u-root - Apache-2.0: purego, cobra, renameio The Windows build list has 6 third-party modules plus x/sys and x/crypto. | License the app as MIT or Apache-2.0. Run govulncheck in source mode in CI and keep golang.org/x/* bumped; go-pty pinned x/crypto v0.51.0, which carries 17 advisories, none reachable. |
| 16 | Go adds a second toolchain only for the developer; the user has already built a Go tool (agm) with the same flags. | VERIFIED | high | ai-switcher packaging/build-agm.mjs runs `go build -trimpath -ldflags '-s -w -buildid='` with CGO_ENABLED=0 for five targets. limitshift is bash+pwsh, with v2 requiring pwsh 7. | Integrate with limitshift through the CLI and JSON contract only. Share black-box contract tests and fake-CLI fixtures, not code. |

## Full report

# Track `lang-go`: Go as the implementation language for **acctshift**

Date: 2026-10-07. Every claim is labelled **[VERIFIED]** (I saw the evidence in this session, cited below) or **[INFERRED]** (memory or reasoning).

---

## 0. Verdict up front

**Go is a good choice for acctshift, provided four rules hold:**
1. Always build with `CGO_ENABLED=0`.
2. On macOS, read and write the keychain through `/usr/bin/security`, not native Security.framework bindings.
3. Budget for Windows Authenticode signing, or accept a real risk of Defender false positives.
4. Write about 150–250 lines of Windows glue with `golang.org/x/sys/windows`: job objects, `.cmd` quoting, junctions and (in phase 2) ConPTY.

It is the **right choice** when the priorities are:
- one Linux runner building every target with no SDKs;
- a zero-dependency single file;
- fast edit/compile/test loops for an AI-assisted solo maintainer;
- byte-level compatibility with agy's credential storage (agy itself uses Go plus zalando/go-keyring, see §2.6).

It is the **wrong choice** if any of these apply:
- (a) Windows trust has to be perfect with no signing budget. Go executables are disproportionately flagged by Defender's ML.
- (b) The user refuses a second toolchain, since limitshift is bash + PowerShell.
- (c) The smallest binaries and the strongest compile-time guarantees matter more than iteration speed. Rust does better on both.

**Single biggest risk for this project:** an unsigned Go `.exe` that spawns child processes and reads or writes Windows Credential Manager is exactly the profile Defender's `!ml` heuristics flag (`Trojan:Win32/Wacatac.B!ml`, `Bearfoos`, `Sabsik`). One quarantine on a user's machine breaks limitshift's queue silently.

---

## 1. Method and environment

- **Sandbox:** Ubuntu 24.04.5, x86_64, 4 vCPU, 15 GB RAM.
  - Pre-installed: Go 1.24.7, rustc 1.97.0, node 22.22.0, gcc, clang 18, jq.
  - Missing: zig, pwsh, wine, upx, goreleaser.
  - A docker CLI is installed but the daemon is not running.
- **Toolchain:** the current stable Go was installed from the official tarball.
  - `go.dev/dl/?mode=json` → `go1.27.1` (previous: `go1.26.8`).
  - `go1.27.1.linux-amd64.tar.gz`, sha256 `63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445`, matched the manifest **[VERIFIED]**.
  - Isolated with `GOPATH`/`GOCACHE` in scratch, `GOTOOLCHAIN=local` and `GOFLAGS=-modcacherw`.
- **Not testable here:** there are no macOS or Windows hosts, so darwin and windows binaries were verified only at build and inspection level (Mach-O load commands, PE headers). linux/arm64 was run under `qemu-aarch64-static` 8.2.2, extracted from the Ubuntu `qemu-user-static` .deb.
- **Prototype `acctproto`:** 369 lines of Go, kept at `/tmp/claude-0/-home-user/228bfb4e-0bd0-5413-8490-21fae890d3fa/scratchpad/lang-go/proto/`. Subcommands:
  - `env` (JSON output)
  - `exec`: `syscall.Exec` on POSIX
  - `spawn`: Setpgid, signal forwarding to the process group, exit code mapped to 128+signal; on Windows, a kill-on-close Job Object assigned to self, plus ignoring Ctrl+C
  - `lock`: gofrs/flock
  - `atomic`: temp file + fsync + rename
  - `kr-get`/`kr-set`: zalando/go-keyring
  - `raw-get`: exec `/usr/bin/security` on darwin; `CredRead` via wincred on Windows
  - a purego `Dlopen` of Security.framework, compile-only
  - Windows junction creation through `FSCTL_SET_REPARSE_POINT`, compile-only
  - `pty`: aymanbagabas/go-pty
  - a unit test and a fuzz test
- **Clean room:** no agm code was opened. In ai-switcher I read only the allowed files: `launcher/agy.mjs`, `packaging/targets.mjs`, `packaging/build-agm.mjs` (grep only), and `install.sh`/`install.ps1` (grep only).

---

## 2. Empirical results

### 2.1 Cross-compilation from one Linux x64 runner [VERIFIED]

Command: `CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w -buildid=" .`
The build cache was cleared first, so each target also compiled its own stdlib.

| Target | Result | Cold build | Stripped size (full prototype) | Without the PTY lib |
|---|---|---|---|---|
| linux/amd64 | OK, `ELF … statically linked` | 14.87 s | 4,739,196 B | 3,776,672 B |
| linux/arm64 | OK | 15.58 s | 4,456,572 B | – |
| darwin/amd64 | OK, `Mach-O 64-bit x86_64` | 14.93 s | 4,414,304 B | – |
| darwin/arm64 | OK, `Mach-O 64-bit arm64` | 15.28 s | 4,155,874 B | 3,159,026 B |
| windows/amd64 | OK, `PE32+ (console) x86-64` | 14.22 s | 4,177,920 B | 3,182,592 B |
| windows/arm64 | OK, `PE32+ (console) Aarch64` | 14.62 s | 3,809,280 B | – |

- **Failures:** none.
- **Incremental rebuild** after `touch main.go`: 0.28–0.36 s per target.
- **Reproducibility:** I rebuilt linux/amd64, darwin/arm64 and windows/amd64 a second time and the sha256 hashes were identical.
- **Size baseline:** a minimal Go program (`encoding/json` + `os/exec`) is 2,834,556 B on linux/amd64, 2,667,186 B on darwin/arm64 and 2,937,344 B on windows/amd64. Unstripped linux it is 4,297,795 B.
- **For comparison:**
  - a Rust `-O -C strip=symbols` hello world was 343,424 B;
  - a C hello world was 15,776 B;
  - agy 1.3.1 for linux-x64 is 211,026,152 B (measured);
  - the brief puts Claude Code at about 251 MB and Codex at about 292 MB.

  Go's roughly 4 MB is about 2% of the CLIs it manages.
- **PTY library cost:** `aymanbagabas/go-pty` adds about 950 KB, because it drags in `golang.org/x/crypto/ssh` and `u-root`.
- **Packaged downloads** from the GoReleaser snapshot: 1,660,730 B (windows_arm64.zip) to 2,150,854 B (linux_amd64.apk).

### 2.2 Binary inspection [VERIFIED]

- **darwin/arm64** (`llvm-objdump --macho --private-headers`):
  - `LC_CODE_SIGNATURE` is present: the Go linker ad-hoc signs automatically. This satisfies Apple silicon's rule that native code must carry a valid signature, with no `codesign` needed.
  - `minos 13.0`, `sdk 26.2`.
  - It dynamically loads `/usr/lib/libSystem.B.dylib`, CoreFoundation, Security and libresolv **without cgo**.
- **darwin/amd64:** no signature load command (Intel Macs do not require one).
- **windows/amd64** (`llvm-objdump -p`):
  - imports only `kernel32.dll`; everything else is loaded lazily;
  - has no `.rsrc` section, so no VERSIONINFO, no manifest and no icon;
  - sections: `.text .rdata .data .pdata .xdata .idata .reloc .symtab`.
- **linux/amd64:**
  - `readelf -l`: no `PT_INTERP`; `readelf -d`: "There is no dynamic section".
  - `chroot <dir containing only the binary> /acct env HOME` printed `{"ok":true,"cmd":"env","value":"/root"}`.
  - So it needs no libc, `/bin` or `/etc`, which covers Alpine/musl, any glibc version and WSL.

### 2.3 Startup latency and per-call overhead (Linux x64) [VERIFIED]

Measured with a Go harness: 400 runs per command, second round reported, wall time including fork/exec.

| Command | Median | p95 |
|---|---|---|
| `/bin/true` (fork+exec floor) | 0.99 ms | 1.29 ms |
| Go hello `nop` | 1.49 ms | 1.93 ms |
| `acctproto nop` (4.7 MB, all deps linked) | 1.81 ms | 2.30 ms |
| `acctproto env HOME` (JSON to stdout) | 2.02 ms | 2.61 ms |
| `acctproto lock <file>` (flock + JSON) | 2.28 ms | 2.79 ms |
| `acctproto atomic <file> hi` (CreateTemp + fsync + rename) | 3.19 ms | 4.86 ms |
| `acctproto exec /bin/true` (two execs) | 3.25 ms | 4.12 ms |
| `acctproto spawn /bin/true` | 3.48 ms | 4.54 ms |
| `jq -n 1` | 2.66 ms | 3.80 ms |
| `bash -c :` | 1.55 ms | 2.12 ms |
| `node -e 0` | 23.18 ms | 31.32 ms |

- A second run gave these medians: C 0.90 ms, Rust 1.29 ms, Go hello 2.00 ms, acctproto 1.93 ms. Go's runtime start-up costs about 0.5–1 ms over C.
- A waiting Go wrapper process had 7 OS threads and `VmRSS: 4504 kB`.
- Windows/macOS start-up was not measured. **[INFERRED]** Windows is typically slower on first run because Defender scans new executables.

### 2.4 Process control (Linux; arm64 under qemu) [VERIFIED]

- **Env injection:** `spawn sh -c 'echo $ACCTPROTO_INJECTED; exit 42'` printed `1` and exited 42.
- **Exit codes:** `exec sh -c 'exit 7'` → 7. A child killed by SIGTERM → 143 (128+15, via `WaitStatus.Signaled()`).
- **SIGINT** sent to the wrapper was forwarded to the child's process group. The child's trap printed `child-got-INT` and the wrapper exited 130.
- **Whole-tree kill:**
  - SIGTERM to the wrapper reached the whole group, so both background `sleep`s died ("no orphan sleeps").
  - **SIGKILL** of the wrapper left the grandchild running (`sleep 33`, reparented). Mitigations: `SysProcAttr.Pdeathsig` on Linux; on macOS there is no equivalent, so use a kqueue watcher or accept the limitation.
- **Locking:** gofrs/flock waited about 1,716 ms while a `flock(1)` holder kept the lock for about 1.7 s. That confirms it interoperates with `flock(1)`.
- **linux/arm64 under qemu:** `env`, `spawn /bin/false` (exit 1), `lock` and `atomic` all worked.
  - The PTY demo printed nothing under qemu. This is a defect in my demo (it does not wait for the output-copy goroutine), not a Go issue. On x86 it printed `/dev/pts/0`.
- **Standard-library facts** (grep of the Go 1.27.1 sources):
  - Windows `syscall.SysProcAttr` has `HideWindow, CmdLine, CreationFlags, Token, ProcessAttributes, ThreadAttributes, NoInheritHandles, AdditionalInheritedHandles, ParentProcess`. There is **no pseudo-console and no job-object field**.
  - `os.Rename` on Windows = `MoveFileEx(from, to, MOVEFILE_REPLACE_EXISTING)` (`internal/syscall/windows/syscall_windows.go:366`).
  - `os.Symlink` on Windows sets `SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE` (`os/file_windows.go:371`), so it works without admin only when Developer Mode is on.
  - `os.Link` → `CreateHardLink`, which needs no admin.
  - There is no junction-creation API; `os.Readlink` does understand `IO_REPARSE_TAG_MOUNT_POINT`. My `FSCTL_SET_REPARSE_POINT` junction code (about 50 lines) compiles for windows/amd64 and windows/arm64.
- **x/sys v0.48.0 exports what Windows needs:** `CreateJobObject`, `AssignProcessToJobObject`, `CreatePseudoConsole`, `CryptProtectData`/`CryptUnprotectData` (DPAPI), `LockFileEx`, `GenerateConsoleCtrlEvent`, `DeviceIoControl`, `FSCTL_SET_REPARSE_POINT`.
- **x/sys exports what Linux needs:** `AddKey`/`KeyctlSearch` (kernel keyring), `Flock`, `Prctl`.

### 2.5 Credential-store behaviour of the Go libraries [VERIFIED by reading module source and running]

**zalando/go-keyring v0.2.8** (MIT, 2026-03-23):
- **macOS:**
  - `Get` runs `/usr/bin/security find-generic-password -s <svc> -wa <user>`.
  - `Set` pipes into `/usr/bin/security -i` a line `add-generic-password -U -s <svc> -a <user> -w <pw>`, so the secret is **not on argv**.
  - The value is stored as `go-keyring-base64:` + base64.
  - The command line is limited to 4096 chars (`ErrSetDataTooBig`).
  - No cgo.
- **Linux:**
  - Secret Service over `godbus/dbus/v5` (pure Go).
  - Attributes `{"username": user, "service": service}`, label `Password for '<user>' on '<service>'`.
  - Collection `/org/freedesktop/secrets/collection/login`, falling back to the alias `/aliases/default`.
  - Session algorithm `"plain"` (unencrypted on the session bus).
- **Windows:**
  - `danieljoos/wincred` generic credential, `TargetName = service + ":" + user`.
  - The blob is the raw bytes; anything over 2560 bytes is rejected (this is `CRED_MAX_CREDENTIAL_BLOB_SIZE`).
- **Without D-Bus:**
  - `acctproto kr-get svc user` returned `exec: "dbus-launch": executable file not found in $PATH`.
  - So `godbus.SessionBus()` tries to **autolaunch `dbus-launch`** when `DBUS_SESSION_BUS_ADDRESS` is unset and `$XDG_RUNTIME_DIR/bus` is missing (`conn.go:77-88`).
  - On headless boxes or WSL with dbus-x11 installed this could spawn a stray bus. The fix is to probe first, or use `SessionBusPrivateNoAutoStartup`.

**byteness/keyring v1.13.2** (MIT, 2026-09-15; the maintained fork of `99designs/keyring` v1.2.2, whose last release was 2022-12):
- With `CGO_ENABLED=0 GOOS=darwin` the build **fails**: `imports github.com/noamcohen97/touchid-go: build constraints exclude all Go files`.
- With `CGO_ENABLED=1` it fails differently: `clang: error: unsupported option '-arch' for target 'x86_64-pc-linux-gnu'` (it needs a macOS SDK or toolchain).
- Its darwin backend uses `byteness/go-keychain`, which is cgo. `keybase/go-keychain` v0.0.1 also has `import "C"`.
- Linux and Windows build without cgo. On Linux the reported backends were `[keyctl pass passage file op-connect op op-desktop proton-pass]`.

**purego v0.11.1** (Apache-2.0): `purego.Dlopen("/System/Library/Frameworks/Security.framework/Security")` plus `Dlsym("SecItemCopyMatching")` compiles for darwin with `CGO_ENABLED=0`. This is a no-cgo path to the framework if it is ever needed.

### 2.6 Key cross-track finding: agy is a Go binary built on zalando/go-keyring [VERIFIED]

I downloaded agy 1.3.1 from its updater manifests and verified the sha512 against each manifest. The binaries were **not executed**; I inspected them with `strings`/`file`/`llvm-objdump`, then deleted them.

- **linux_amd64:**
  - ELF PIE, dynamically linked.
  - Go buildinfo: `go1.28-20260921-RC02 cl/985595000 +644cd61a4a X:fieldtrack,boringcrypto,simd`.
  - Symbols:
    - `google3/third_party/golang/github_com/zalando/go_keyring/v/v0/keyring.{Get,Set,Delete}` and `secretServiceProvider`;
    - `jetski/cli/backend/auth.(*keyringAuth).{TryAuth,Logout,StartInteractive}`;
    - `codeassistclient.{KeyringTokenStorage, fileTokenStorage, compositeTokenStorage.{isUseFileStatic,setUseFileStatic,memoizeKeyringTimeout,recordKeyringError}, shouldBypassKeyring, keyringRecentlyUnavailable, DefaultKeyringMarkerPath}`.
  - That means a keyring with an **automatic file fallback**.
- **darwin_arm64:**
  - Strings include `/usr/bin/security`, `go-keyring-base64:` and `keyring.macOSXKeychain.{Get,Set,Delete,DeleteAll}`.
  - `LC_CODE_SIGNATURE`; `minos 12.0`.
- **windows_amd64:**
  - Symbols include `keyring.windowsKeychain.{Get,Set,Delete,DeleteAll,credName}`, `danieljoos/wincred`, `CredReadW/CredWriteW/CredDeleteW`.
  - Authenticode certificate table of 10,392 bytes, so it is **signed**.
- **Env var strings found:** `JETSKI_OAUTH_TOKEN`, `AGY_ADC_AUTH`. What they do is **unverified**, but they may allow per-run token injection.
- **Not determined:** the exact keyring service and user names. Candidate strings are `jetski-standalone-oauth-token` and `antigravity-cli`. This needs a real login to confirm.

**Implication for language choice:** in Go, acctshift can call the *same* `keyring.Get/Set` agy uses and get byte-identical items on all three OSes. That includes the `go-keyring-base64:` prefix, the attribute set and the `svc:user` target name. Other languages can reproduce this format (it is simple), but must track any change to it by hand.

### 2.7 Other Go behaviours that matter [VERIFIED]

- **Timezones:**
  - A static binary in an empty root printed `LoadLocation error: unknown time zone Europe/Kyiv`.
  - With `import _ "time/tzdata"` it printed `ok 2026-10-07T12:00:00Z`, at a cost of about 405 KB (1,605,792 B → 2,019,488 B).
  - Windows and minimal Alpine have no IANA database Go can use, so tzdata must be embedded to parse reset times such as "resets 3pm (Europe/Kyiv)".
- **`os/user` without cgo:**
  - In a root without `/etc/passwd`: `user: Current requires cgo or $USER set in environment`.
  - With `HOME` unset as well: `os.UserHomeDir` failed with `$HOME is not defined`.
  - So use `$HOME`/`$USER` and `os.UserHomeDir()`.
- **Testing:**
  - `go test ./...` took 3.4 s cold.
  - `CGO_ENABLED=0 go test -race` → `-race requires cgo`; with `CGO_ENABLED=1` it passed on Linux.
  - `go test -fuzz FuzzAtomicWrite -fuzztime 3s` → PASS.
  - `GOOS=windows go test -c` cross-compiles test binaries (they still need a Windows runner to execute).
- **govulncheck v1.8.0:**
  - Source mode reported "Your code is affected by 0 vulnerabilities". It found 12 vulnerabilities in imported packages and 5 more in required modules, all in `golang.org/x/crypto@v0.51.0` (fixed in v0.52–v0.56), pulled in by go-pty's ssh support.
  - Binary mode on the stripped `.exe` reported "affected by 17 vulnerabilities from 1 module", because it cannot check reachability. Software composition analysis tools give the same noise for Go Windows binaries; see freelens#2631, where Grype raised false CVE alerts in Oct 2026.
- **Embedded build info:** `go version -m` prints the module list with hashes, which is useful for SBOMs.

### 2.8 GoReleaser OSS v2.18.2 (2026-09-17, built with go1.27.1) [VERIFIED]

- The `checksums.txt` sha256 matched.
- `goreleaser release --snapshot --clean --skip=publish,sign` produced all of the following in "release succeeded after 2s" (real 2.95 s, warm cache):
  - six binaries and six archives (tar.gz; zip for Windows);
  - `.deb`/`.rpm`/`.apk`/`.pkg.tar.zst` for amd64 and arm64;
  - an AUR `PKGBUILD`/`.srcinfo`;
  - three winget manifests;
  - a Homebrew **cask** with `on_macos`/`on_linux` × `on_arm`/`on_intel` and sha256s;
  - a Scoop manifest for 64bit and arm64;
  - `checksums.txt`.

---

## 3. Criterion-by-criterion analysis

### 1. Platform reach
- **[VERIFIED]** All six targets build natively, including windows/arm64. The previous ai-switcher/agm packaging had no windows-arm64 target and ran x64 under emulation; its install.ps1 says so.
- **[VERIFIED]** Static Linux binaries cover musl/Alpine and WSL.
- Minimum versions (go.dev/wiki/MinimumRequirements and release notes) **[VERIFIED via web]**:
  - Linux kernel ≥ 3.2 (Go 1.24+);
  - Windows 10 / Server 2016+ (Go 1.21+);
  - **macOS 13 Ventura+ for Go 1.27**; macOS 12 needs Go 1.26, which is supported until Go 1.28 (about Feb 2027);
  - `GOAMD64=v1` baseline;
  - 32-bit windows/arm was removed in Go 1.26 (irrelevant here).
- Caveat: each Go release can raise these minimums.

### 2. End-user footprint
- **[VERIFIED]** One file of 3.2–4.7 MB with zero runtime dependencies.
- On macOS it needs only `/usr/bin/security`, which ships with the OS. It does not need bash 4, jq, pwsh, `secret-tool` or .NET.
- The same `.exe` works from Windows PowerShell 5.1 and pwsh 7.

### 3. Latency
- **[VERIFIED]** About 1.8–2.0 ms per call on Linux; faster than jq and roughly 12× faster than node.
- About 0.5–1 ms slower than Rust or C, which is irrelevant at limitshift's call rate.

### 4. Build and cross-compilation
- **[VERIFIED]** One Linux runner, no macOS SDK, no osxcross, no zig, reproducible output.
- The hard rule that keeps this true is **no cgo**: a single cgo dependency, such as byteness/keyring on darwin, breaks it.
- `-race` needs cgo. Run it only on Linux CI, not in release builds.

### 5. OS credential stores
- **macOS** **[VERIFIED for libraries]**: the pragmatic path is exec of `/usr/bin/security`. It needs no cgo and is what agy and Claude Code use (Claude Code via the `security` CLI per the project brief).
  - **[VERIFIED via web]** One Claude.app bug report: Claude.app (v1.8555.2) recreates `Claude Code-credentials` with `SecItemDelete`+`SecItemAdd`. That drops `apple-tool:` from the partition list and causes "security wants to access" prompts (claudeissues #62213, May 2026).
  - Therefore prefer `CLAUDE_CODE_OAUTH_TOKEN` env injection over touching Claude's keychain item.
  - Native Security.framework access from Go needs cgo, which means building on a macOS runner, or purego.
- **Linux:** godbus is pure Go (BSD-2). go-keyring has fixed attributes, a plain session and autolaunches D-Bus. A fallback is needed when there is no daemon (kernel keyring via `x/sys/unix` `AddKey`, or a 0600 or encrypted file); agy does the same.
- **Windows:** wincred is pure Go; the 2560-byte blob limit applies. DPAPI is available via `x/sys/windows.CryptProtectData`.

### 6. Process control
- **[VERIFIED on Linux]** exec, spawn, env injection, exit codes, signal forwarding, group kill, flock, atomic rename.
- **Windows gaps:**
  - job objects and ConPTY need x/sys code or third-party libraries; go-pty re-implements CreateProcess because os/exec cannot attach the pseudo-console attribute (go#62708, per the go-pty README);
  - there is no junction API;
  - **`.cmd`/`.bat` argument escaping is unsolved**: golang/go#69939 is open with NeedsDecision, and the issue says "os/exec doesn't correctly escape nor quote *.bat, *.cmd, cmd /c * arguments".
  - **[INFERRED]** codex, gemini and copilot are commonly installed on Windows as npm `.cmd` shims. acctshift `exec` must resolve the shim to `node <script>` or quote for cmd.exe itself via `SysProcAttr.CmdLine`.
  - Rust's std fixed the equivalent problem (BatBadBut, CVE-2024-24576) **[INFERRED from memory]**.

### 7. Trust and distribution
- **macOS** **[VERIFIED]**:
  - The automatic ad-hoc signature means curl-installed binaries run on Apple silicon.
  - **[INFERRED]** curl does not set `com.apple.quarantine`, but browsers do; a browser-downloaded unsigned binary hits Gatekeeper.
  - Notarization from Linux is possible in GoReleaser OSS (`notarize.macos`, which embeds anchore/quill). It needs an Apple Developer account at $99/yr, a .p12 certificate and an App Store Connect .p8 key.
  - Homebrew 5.0.0 (2025-11-12) deprecated `--no-quarantine` and will "disable all Homebrew/homebrew-cask casks that fail Gatekeeper checks in September 2026". A *personal tap* cask still works, but needs GoReleaser's documented `xattr -dr com.apple.quarantine` postflight hook, which GoReleaser's own docs warn about. GoReleaser's `brews` (formula) support is deprecated since v2.10 but still works.
- **Windows** — this is the language-specific negative:
  - The Go FAQ itself says AV false positives are "a common occurrence, especially on Windows".
  - microsoft/go#1255, "Microsoft defender false positives of Go binaries on windows", has been open since 2024-06-27.
  - kachick/dotfiles#851 (2024-10): "Since go 1.23, Windows Defender detects the built binaries as a Trojan" (`Wacatac.B!ml`, `Sabsik.FL.A!ml`).
  - SilverBullet's Go rewrite (Sep–Nov 2025): `Trojan:Script/Wacatac.H!ml`, `Bearfoos.A!ml`; a contributor linked it to "go binaries … that execute shell commands".
  - **[INFERRED]** The only-kernel32-plus-lazy-load import table and the missing VERSIONINFO (both verified in §2.2) plausibly feed the ML heuristics.
  - Mitigations:
    - Authenticode signing. Azure Artifact Signing costs about $9.99/month but is available to **individuals in the USA/Canada only**; organizations also get the EU/UK. SignPath Foundation offers free signing for OSS **[INFERRED]**, or buy an OV certificate.
    - Embed VERSIONINFO and a manifest (goversioninfo v1.7.0, MIT).
    - Never use UPX or garble.
    - Submit false positives to Microsoft.

### 8. Licenses and supply chain
- **[VERIFIED]** Every candidate dependency is permissive: MIT, BSD-2/3 or Apache-2.0 (table in §5).
- The Windows build list is only 6 third-party modules plus x/sys and x/crypto.
- Go module checksums are verified against sum.golang.org (go.sum) **[INFERRED: standard behaviour]**.
- Tooling: govulncheck (reachability-aware), `go version -m` for SBOMs.
- Risk: minimum version selection keeps transitive dependencies such as x/crypto at old versions until bumped explicitly; I saw this with go-pty.

### 9. Maintainability by one person plus AI agents
- **[VERIFIED]** Fast loops: 0.3 s incremental builds, 3.4 s test run. Fuzzing and testing are built in; gofmt and vet ship with the toolchain.
- **[INFERRED]** Go is small and idiomatic, so agents generally produce compiling, readable Go.
- Weaknesses: nil pointers and maps, error-shadowing, no sum types or exhaustive enums for state machines, goroutine leaks, and Windows code paths that cannot be tested off Windows.
- For comparison, Rust gives stronger compile-time guarantees, but agents struggle more there. Rust-SWE-bench (arXiv 2602.22764, Feb 2026) cites "complying with Rust's strict type and trait semantics" as the main barrier; ReAct agents resolved at most 21.2% of its issues.

### 10. Fit with limitshift
- **[VERIFIED]** limitshift v1 is `limitshift.sh` (4,397 lines) + `limitshift.ps1` (4,465 lines); v2 is pwsh 7 (`#requires -Version 7`, `v2/lib/*.ps1`).
- A Go binary is called identically from bash and pwsh, emits JSON (`encoding/json`, backed by the v2 implementation in Go 1.27) and returns exit codes such as 75.
- **No code sharing with limitshift is possible.** Contract tests can be shared as black-box CLI tests; limitshift-v2 already has a fake-CLI pattern in `v2/benchmarks/limit-shim/claude.ps1`.
- It adds a second toolchain to the *developer's* machine only (one roughly 280 MB tarball, no extra package manager).
- **[VERIFIED]** The user has already built agm with Go in ai-switcher's `packaging/build-agm.mjs`: `go build -trimpath -ldflags '-s -w -buildid='` with `CGO_ENABLED=0` for five GOOS/GOARCH pairs. Go is not new to their world.

### 11. Packaging channels
- **[VERIFIED]** GoReleaser OSS covers GitHub Releases and checksums, Homebrew cask/tap, Scoop, winget, AUR, deb/rpm/apk/arch.
- The **npm publisher is Pro-only** (since v2.8; it uses a postinstall download that breaks with `--ignore-scripts`; Pro costs $165/yr). Hand-roll an esbuild-style `optionalDependencies` set instead **[INFERRED]**.
- Self-update: `creativeprojects/go-selfupdate` v1.6.0 (MIT) supports GitHub/Gitea/GitLab with checksum or signature validation.

### 12. Long-term risk
- **[INFERRED]** The Go 1 compatibility promise, the 6-month release cadence, support for the last two releases, and GODEBUG settings for behaviour changes make Go low-risk. It is used across Kubernetes, Docker and Google itself; agy is built with an internal Go 1.28 RC.
- **[VERIFIED]** Concrete churn exists:
  - macOS minimum bumped to 13 in 1.27;
  - `encoding/json` switched to the v2 implementation in 1.27 (error texts may differ);
  - windows/arm removed in 1.26;
  - some libraries are slow-moving: creack/pty's last release was 2024-10, 99designs/keyring's was 2022.

---

## 4. Where Go is weak for this project (consolidated)

| # | Weakness | Evidence | Severity | Mitigation |
|---|---|---|---|---|
| W1 | Defender/SmartScreen false positives on unsigned Go `.exe` | Go FAQ; microsoft/go#1255 (open); kachick#851; SilverBullet 2025 | **High** (Windows) | Authenticode signing; VERSIONINFO + manifest; no UPX/garble; test release candidates on Windows; submit FPs |
| W2 | os/exec does not escape args for `.cmd/.bat` | golang/go#69939 open | High for npm shims on Windows | Resolve npm shims to `node.exe <js>`; otherwise apply cmd.exe quoting via `SysProcAttr.CmdLine`; reject `%`/`^`/`"` in args when going through cmd |
| W3 | No ConPTY or job-object support in os/exec; no junction API | Go 1.27.1 source (§2.4) | Medium | ~150–200 lines of x/sys code (job object on self before spawn; `FSCTL_SET_REPARSE_POINT`); phase 2: creack/pty + own ConPTY, or charmbracelet/x/xpty |
| W4 | Native Security.framework needs cgo (macOS SDK or macOS runner) | byteness/keyring build failure (§2.5) | Low (avoidable) | Exec `/usr/bin/security` (go-keyring); purego if ever needed |
| W5 | go-keyring Linux path: autolaunches D-Bus, plain session, fixed attributes, no fallback | §2.5 | Medium | Probe the bus first or use NoAutoStartup; own fallback store; use go-keyring only for agy's slot (for exact compatibility) |
| W6 | Binary size about 10× Rust | §2.1 | Low | Irrelevant next to 200–300 MB CLIs |
| W7 | No tzdata on Windows or minimal Linux; `os/user` without cgo | §2.7 | Low | `import _ "time/tzdata"`; use `$HOME`/`$USER` |
| W8 | SCA noise from embedded module info | govulncheck binary mode, freelens#2631 | Low | Keep x/* bumped; publish govulncheck source-mode results |
| W9 | Second toolchain for the developer | §3.10 | Low | User already used Go for agm |

---

## 5. Library shortlist (all permissive) [VERIFIED versions, dates and licenses from proxy.golang.org and module LICENSE files]

| Purpose | Module | Latest (date) | License | cgo? | Notes |
|---|---|---|---|---|---|
| agy-compatible keyring | github.com/zalando/go-keyring | v0.2.8 (2026-03-23) | MIT | no | Same library agy 1.3.1 uses on all three OSes |
| D-Bus | github.com/godbus/dbus/v5 | v5.2.2 (2025-12-29) | BSD-2 | no | Use `SessionBusPrivateNoAutoStartup` for probing |
| Windows Credential Manager | github.com/danieljoos/wincred | v1.2.3 (2025-10-02) | MIT | no | 2560-byte blob limit |
| Syscalls (job, DPAPI, ConPTY, LockFileEx, keyctl, prctl) | golang.org/x/sys | v0.48.0 (2026-08-31) | BSD-3 | no | – |
| Advisory lock | github.com/gofrs/flock | v0.13.1 (2026-08-27) | BSD-3 | no | Interop with `flock(1)` verified |
| Unix PTY | github.com/creack/pty | v1.1.24 (2024-10-31) | MIT | no | – |
| Cross-platform PTY | github.com/charmbracelet/x/xpty / x/conpty | v0.1.4 (2026-07-30) / v0.2.0 (2025-11-17) | MIT | no | Alternative to go-pty |
| Cross-platform PTY | github.com/aymanbagabas/go-pty | v0.2.3 (2026-05-17) | MIT | no | +~950 KB; pulls x/crypto/ssh and u-root |
| Framework calls without cgo | github.com/ebitengine/purego | v0.11.1 (2026-09-18) | Apache-2.0 | no | Fallback only |
| Multi-backend keyring (avoid on darwin) | github.com/byteness/keyring | v1.13.2 (2026-09-15) | MIT | **yes on darwin** | Fails `CGO_ENABLED=0` for darwin |
| Atomic write | stdlib (~20 lines); google/renameio/v2 v2.0.2 Apache-2.0 has `!windows` build tags; natefinch/atomic v1.0.1 MIT (2021) | – | – | no | Stdlib is enough (`os.Rename` = MoveFileEx REPLACE_EXISTING) |
| Self-update | github.com/creativeprojects/go-selfupdate | v1.6.0 (2026-07-08) | MIT | no | Checksums.txt or signature validation |
| CLI parsing | stdlib `flag`; alecthomas/kong v1.16.1 (MIT); spf13/cobra v1.10.2 (Apache-2.0) | – | – | no | – |
| Windows resources | github.com/josephspurrier/goversioninfo | v1.7.0 (2026-05-11) | MIT | no | VERSIONINFO + manifest `.syso` |
| Release automation | goreleaser (OSS) | v2.18.2 (2026-09-17) | MIT | – | npm publisher is Pro-only |

---

## 6. Spec implications if Go is chosen (concrete rules)

1. **Toolchain:**
   - `go 1.27` with `toolchain go1.27.x` in go.mod;
   - release flags `CGO_ENABLED=0 -trimpath -ldflags "-s -w -buildid= -X main.version=…"`;
   - add a CI guard that fails when `go list -deps` shows any package with CgoFiles;
   - build all six targets on one `ubuntu-latest` runner with GoReleaser OSS;
   - run tests on ubuntu-latest, ubuntu-24.04-arm, macos-14 (arm64), macos-13 (x64) and windows-latest. **[INFERRED]** A windows-11-arm runner should also exist.
2. **Packaging:**
   - GitHub Releases + checksums.txt;
   - deb/rpm/apk/arch via nfpms;
   - a Homebrew tap, either a cask with the quarantine hook or, better, notarized binaries;
   - Scoop, winget, AUR (`-bin`);
   - npm via hand-made `optionalDependencies` packages;
   - curl and PowerShell installers mirroring ai-switcher's `install.sh`/`install.ps1` (uname mapping, sha256 check, `xattr -dr com.apple.quarantine` on macOS);
   - self-update only when not installed by a package manager.
3. **Windows hygiene:**
   - embed VERSIONINFO plus a manifest (`asInvoker`, `longPathAware`);
   - avoid "setup/install/update" in exe names (installer-detection heuristics **[INFERRED]**);
   - plan Authenticode signing before the first public release.
4. **Process model:**
   - POSIX `exec` with no post-processing → `syscall.Exec`, zero overhead.
   - POSIX `exec` that watches for limits → spawn with `Setpgid`, forward INT/TERM/HUP to `-pgid`, set `Pdeathsig` on Linux, and map signal deaths to 128+N.
   - Windows: assign self to a kill-on-close Job Object before spawning, so children inherit it with no race; `signal.Ignore(os.Interrupt)` and let the child handle Ctrl+C; return the child's exit code.
   - Resolve `.cmd` shims, or implement cmd.exe quoting (§4 W2).
5. **Credentials:**
   - **claude:** inject `CLAUDE_CODE_OAUTH_TOKEN` per run and do not touch Claude's keychain item (avoids the partition-list prompts).
   - **agy:** read and write through `zalando/go-keyring` with agy's exact service and user names (open question), **only after probing the session bus**. Handle agy's file fallback store. Swap under a lock and always back up the outgoing value first.
   - **acctshift's own vault:**
     - macOS: one keychain item via `/usr/bin/security -i` (stdin, never argv);
     - Windows: DPAPI-encrypted file, because the Credential Manager 2560-byte limit is too small for Codex `auth.json`;
     - Linux: Secret Service when the bus is present, else kernel keyring or a 0600 file, with clear `doctor` output.
6. **Files:**
   - Lock a dedicated `.lock` file with gofrs/flock. Windows `LockFileEx` is mandatory on the byte range, so never lock the data file itself.
   - Atomic write: temp file in the same directory, fsync, rename; on Windows, retry on sharing violations **[INFERRED]**.
   - Codex history sharing on Windows: directory junction (own code) and hard links for files; symlinks only when Developer Mode is on.
7. **Runtime details:** `import _ "time/tzdata"`; never rely on `os/user`; JSON output on every command; documented exit codes (75 when all accounts are capped).
8. **Phase-2 PTY:** creack/pty on Unix plus x/sys ConPTY (or charmbracelet/x/xpty). Avoid go-pty's ssh dependency tree.

---

## 7. How Go compares to the alternatives on the user's question ("why Go and not Rust, or pwsh+bash?")

- **vs Rust** **[INFERRED except where marked]**:
  - Rust gives about 10× smaller binaries (verified hello: 343 KB vs 2.8 MB), about 0.5 ms faster start-up (verified), stronger types, and a std that already fixed BatBadBut.
  - Go gives:
    - simpler cross-compilation of darwin targets from Linux with no linker or SDK (verified for Go);
    - roughly 10× faster compile and test loops;
    - easier code for agents;
    - the agy-identical keyring library (verified).
  - Defender false-positive history is better documented for Go (verified).
- **vs pwsh + bash:**
  - It would share code with limitshift, but every stock machine lacks something:
    - macOS has bash 3.2, no jq and no pwsh;
    - Windows ships PS 5.1;
    - many Linux distros lack `secret-tool`.
  - Credential Manager and DPAPI access from PowerShell need P/Invoke or C# `Add-Type` or .NET APIs. Process-tree control and junctions are possible but brittle across shells.
  - Measured per-call costs: `bash -c :` 1.55 ms and `jq` 2.66 ms are fine, but pwsh start-up is typically hundreds of ms **[INFERRED; pwsh is not installed here]**.
  - Not having to depend on jq/pwsh on end-user machines is a major point in favour of a compiled single binary.

---

## 8. Final verdict

- **Choose Go** if acctshift is designed as a CGO-free single binary that execs `/usr/bin/security` on macOS, uses `zalando/go-keyring` for agy compatibility, and has a funded Windows signing plan. On this project's hard requirements it is the easiest compiled option to build, ship and maintain:
  - macOS and Linux mandatory;
  - Windows;
  - x64 and arm64 everywhere;
  - efficiency;
  - a standalone app limitshift can call.
- **Don't choose Go** if unsigned Windows distribution must be friction-free, or if the user wants no new toolchain at all.
- **Biggest single risk:** Defender ML quarantining the unsigned Go `.exe` that spawns CLIs and swaps credentials.

## Open questions

- agy's exact keyring service and user names. Candidate strings are 'jetski-standalone-oauth-token' and 'antigravity-cli'. Confirm on real logins with `secret-tool search --all service <x>`, `security dump-keychain | grep -B4 go-keyring-base64` (or find-generic-password) and `cmdkey /list`.
- Whether agy honours the JETSKI_OAUTH_TOKEN or AGY_ADC_AUTH env vars (strings found in 1.3.1) for per-run token injection, which would make keyring swapping unnecessary.
- agy's file-fallback token path and format, when the keyring is unavailable (headless Linux or WSL), and how `shouldBypassKeyring`/`DefaultKeyringMarkerPath` decide between keyring and file.
- Actual size of agy's stored token relative to the 2560-byte wincred limit and the 4096-char `security -i` line limit.
- Windows runtime validation, which could not be run here:
- job-object inheritance when the parent is already in a job (Windows Terminal, CI);
- junction creation without admin;
- Ctrl+C semantics with claude.exe and npm .cmd shims (codex.cmd, gemini.cmd, copilot.cmd);
- a wincred round-trip;
- os.Rename sharing violations while a CLI holds auth.json open.
- Defender and SmartScreen reaction to an unsigned versus signed acctshift.exe that spawns processes and calls CredRead/CredWrite. Test release candidates on clean Windows 11 x64/arm64 VMs and upload them to VirusTotal before release.
- macOS: whether `/usr/bin/security` reads of 'Claude Code-credentials' trigger prompts after Claude.app recreates the item (claudeissues #62213), and whether CLAUDE_CODE_OAUTH_TOKEN injection fully avoids keychain access on macOS 13–26.
- macOS startup latency and the Gatekeeper behaviour of curl-installed versus browser-downloaded ad-hoc-signed Go binaries on macOS 15/26. Also whether a personal-tap Homebrew formula avoids quarantine entirely.
- WSL1/WSL2 and network filesystems: flock semantics on /mnt/c (drvfs) for the state lock.
- Code-signing eligibility for the user (likely outside US/CA, so no Azure Artifact Signing for individuals): SignPath Foundation OSS acceptance versus the cost of an OV certificate.
- Whether Go 1.28 (expected Feb 2027) raises any platform minimum again (watch the release notes) and whether macOS 12 users matter.

## Sources

- Go downloads JSON (current stable go1.27.1, sha256): https://go.dev/dl/?mode=json
- Go FAQ: virus scanners & binary size: https://go.dev/doc/faq
- Go 1.27 release notes (macOS 13 minimum, json v2 backend, linker -macos/-macsdk): https://go.dev/doc/go1.27
- Go 1.26 release notes (windows/arm removed, os.Process.WithHandle, Green Tea GC): https://go.dev/doc/go1.26
- Go minimum requirements wiki: https://go.dev/wiki/MinimumRequirements
- microsoft/go#1255 Defender false positives of Go binaries: https://github.com/microsoft/go/issues/1255
- kachick/dotfiles#851 Since go 1.23 Defender detects binaries as Trojan: https://github.com/kachick/dotfiles/issues/851
- SilverBullet: Windows Defender detects Trojan (Go rewrite, 2025): https://community.silverbullet.md/t/windows-defender-detects-trojan-in-silverbullet-exe/3183
- Go forum: compiled exe declared as virus (2023): https://forum.golangbridge.org/t/my-compiled-exe-file-is-declared-as-a-virus/34038
- Fix Windows Defender false positives (Go build temp exclusions): https://ready-to-release.github.io/eac/how-to-guides/eac/commands/build-test-validate/fix-windows-defender-false-positives/
- freelens#2631 Grype false CVE alerts on Go Windows binaries (Oct 2026): https://github.com/freelensapp/freelens/issues/2631
- golang/go#69939 os/exec .bat/.cmd escaping (open): https://github.com/golang/go/issues/69939
- CERT VU#123335 BatBadBut: https://kb.cert.org/vuls/id/123335
- GoReleaser notarize (macos via quill in OSS, macos_native Pro): https://goreleaser.com/customization/notarize/
- GoReleaser homebrew_casks (v2.10+, quarantine hook warning): https://goreleaser.com/customization/homebrew_casks/
- GoReleaser homebrew formulas (deprecated v2.10): https://goreleaser.com/customization/homebrew_formulas/
- GoReleaser npm publisher (Pro-only, v2.8+): https://goreleaser.com/customization/npm/
- GoReleaser Pro feature list and pricing: https://goreleaser.com/pro/
- Homebrew 5.0.0 release notes (Gatekeeper casks disabled Sept 2026, --no-quarantine deprecated): https://brew.sh/2025/11/12/homebrew-5.0.0/
- Microsoft code signing options / Artifact Signing: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
- Azure Artifact Signing pricing: https://azure.microsoft.com/pricing/details/trusted-signing/
- Claude.app recreates 'Claude Code-credentials' keychain item, dropping apple-tool: partition (#62213): https://claudeissues.com/issue/62213-bug-claude-app-deletes-recreates-keychain-item-on-workspace-open-dropping-apple
- Rust-SWE-bench (arXiv 2602.22764, Feb 2026): https://arxiv.org/abs/2602.22764
- Go module proxy @latest queries (versions/dates for go-keyring, godbus, wincred, flock, pty libs, x/sys, purego, byteness/keyring, go-selfupdate, goreleaser): https://proxy.golang.org/
- agy updater manifests (linux_amd64, darwin_arm64, windows_amd64; v1.3.1 downloaded, sha512-verified, inspected with strings/objdump only): https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/
- Local: Go prototype source: /tmp/claude-0/-home-user/228bfb4e-0bd0-5413-8490-21fae890d3fa/scratchpad/lang-go/proto/
- Local: zalando/go-keyring v0.2.8 source (keyring_darwin.go, keyring_windows.go, keyring_unix.go, secret_service/secret_service.go) — read from module cache (since deleted): github.com/zalando/go-keyring@v0.2.8
- Local: godbus/dbus v5.2.2 conn.go session bus autolaunch logic: github.com/godbus/dbus/v5@v5.2.2/conn.go
- Local: Go 1.27.1 stdlib sources (syscall/exec_windows.go SysProcAttr, os/file_windows.go Symlink/Link, internal/syscall/windows MoveFileEx): go1.27.1 src
- Local: limitshift-v2 (v2/v2.ps1 #requires -Version 7, v2/lib/Lock.ps1, v2/benchmarks/limit-shim/claude.ps1): /home/user/limitshift-v2
- Local: ai-switcher allowed files (launcher/agy.mjs, packaging/targets.mjs, packaging/build-agm.mjs, install.sh, install.ps1): /home/user/ai-switcher
