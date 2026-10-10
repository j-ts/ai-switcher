# Research track: lang-scripts

_Research date: 2026-10-07. Claims are marked VERIFIED (evidence gathered during the research) or INFERRED._

## Summary

Writing acctshift as two scripts, bash/POSIX sh plus PowerShell (the way limitshift is built today), is not the right primary implementation. The evidence comes from measurements in this sandbox and from limitshift's own history.

The user's repos show the cost of keeping two implementations in step. There were 10+ sh/ps1 parity fixes in about 4 months, and every feature was committed twice: `feat(ps1)`/`feat(sh)` pairs, cross-shell byte-parity tests that need Git Bash, cygpath and powershell.exe, and Pester's 248 `It` blocks against 138 bash tests. The v2 engine has already dropped the twin model and is PowerShell 7 only.

I built GNU bash 3.2.57 (the version macOS ships) and found a latent bug: shipped limitshift.sh 1.3.2 crashes there with `${trimmed_reason,,}: bad substitution`. Four block-recovery tests fail that pass on bash 5.2.

Credential access is where scripts break down:
- **Linux:** `secret-tool` is not installed on Ubuntu 24.04 or 26.04 desktop, or on the server image. It fails headless ("Cannot autolaunch D-Bus without X11 $DISPLAY"). It also silently cuts secrets at 8192 bytes while exiting 0.
- **macOS:** `security -i` has a 4096-byte line buffer, so stdin writes carry at most ~2 KB. Claude Code 2.1.292 itself switches to argv (visible in `ps`) for longer commands.
- **Windows:** there is no built-in cmdlet that reads generic credentials. Add-Type P/Invoke costs 0.4–0.7 s per process (measured with pwsh 7.6 on Linux), and blobs are limited to 2560 bytes.

PowerShell 7.6 also showed measured data hazards. It rewrites ISO timestamp offsets when JSON round-trips, truncates silently at the default `-Depth 2`, and its parameter binder captures child flags such as `-c`.

Speed per call: sh+jq takes about 25 ms on Linux, pwsh 7.6 400–700 ms, and compiled binaries 2–13 ms.

Briefly, the other runtimes:
- **Bun --compile:** built all 8 targets from one Linux box; 62–86 MB; 10.5 ms; built-in `Bun.secrets` is experimental.
- **Deno compile:** 6 targets, no musl; 68–105 MB; 43 ms.
- **Node SEA:** 93–127 MB; 32 ms; macOS binaries need re-signing.
- **.NET NativeAOT:** 1.8 MB, 3.5 ms, but cannot build for another OS.
- **Zig:** 8 targets at 130–443 KB, but no keyring support and its standard library breaks between releases.
- **PyInstaller:** cannot cross-compile; 169 ms per call.

Recommendation: ship acctshift as one compiled binary. Keep scripts only for the installers (install.sh, install.ps1) and the thin limitshift glue. Add an `acctshift env` mode so limitshift keeps launching the CLIs itself.

## Scorecard

| Criterion | Score (1-5) | Rationale |
|---|---|---|
| 1. Platform reach (Win x64/arm64, macOS x64/arm64, Linux x64/arm64 incl. musl, WSL) | 4 | Scripts are architecture-independent and run wherever bash or PowerShell exists, including WSL and Windows arm64 (PS 5.1 is inbox). Alpine has only busybox ash (INFERRED), so bash-isms break there, and dash cannot do process-group job control headless (VERIFIED). Windows needs a separate PowerShell implementation because Git Bash is not guaranteed and is slow. |
| 2. End-user footprint / zero runtime dependencies | 2 | The scripts themselves are KB-sized, but they need tools that are often missing. jq is absent on macOS ≤14 and on Windows; macOS 15 ships an Apple jq-1.6 build. secret-tool is not installed on Ubuntu 24.04/26.04 desktop or server (VERIFIED from manifests). A running Secret Service daemon is required. Windows ships only PowerShell 5.1 and needs an execution-policy change plus Unblock-File (limitshift README). |
| 3. Startup latency and per-call overhead | 3 | Linux sh+jq: 25 ms for next and 5.7 ms for exec (VERIFIED). pwsh 7.6: 197 ms bare, 420-554 ms for the prototype, 704 ms with Add-Type P/Invoke (VERIFIED on Linux). Windows Git Bash fork emulation costs about 27 ms per fork and degrades to seconds (cited). So the result is fast on POSIX and slow on Windows. |
| 4. Build / cross-compilation from one Linux runner | 5 | There is nothing to compile; one Linux runner can package everything. Testing still needs real macOS (bash 3.2 + BSD date/sed) and Windows (PS 5.1 and 7) runners. Bash 3.2 compatibility can be checked on Linux by building bash 3.2.57 from source, which takes about 1 minute (VERIFIED). |
| 5. OS credential store access | 2 | macOS 'security -i' caps at a 4096-byte line (about 2013-byte payload), beyond which the secret goes on argv; Claude Code 2.1.292 does exactly that (VERIFIED in binary strings). Linux secret-tool is missing by default, fails headless, and silently truncates at 8192 bytes with exit 0 (VERIFIED). Windows has no cmdlet that reads generic credentials, needs AMSI-scanned Add-Type P/Invoke (0.4-0.7 s, VERIFIED on Linux), and caps blobs at 2560 bytes (MS docs). |
| 6. Process control (env, stdio, exit codes, signals, tree kill, PTY, locks, atomic writes, links) | 2 | Env injection, exit codes and atomic mv are easy in sh. dash cannot create process groups headless (VERIFIED); there is no flock on macOS and no PTY. A PowerShell param() block captured a child's '-c' flag (VERIFIED). PS 5.1 needs hand-rolled CommandLineToArgvW quoting (limitshift.ps1:1700). Tree kill without taskkill needs PS 7, and Job Objects or ConPTY need P/Invoke. Command substitution strips trailing newlines and NULs (VERIFIED). |
| 7. Trust / distribution friction (Gatekeeper, notarization, SmartScreen, AV) | 3 | Scripts avoid Mach-O signing and notarization and SmartScreen for curl-based installs. Windows execution policy (Restricted on clients when undefined) and Mark-of-the-Web need Set-ExecutionPolicy and Unblock-File (VERIFIED in limitshift README and MS docs). Credential-API P/Invoke inside PowerShell looks like credential-dumping tradecraft to AMSI and Defender (INFERRED; not measured). |
| 8. Dependency licenses and supply-chain size | 4 | Nothing is bundled: system bash (GPLv3, not redistributed), jq (MIT), PowerShell (MIT), secret-tool and security as system tools. The supply chain is minimal. The drawback is behaviour drift across OS-provided tool versions (jq 1.6/1.7/1.8, BSD vs GNU coreutils) that the project cannot pin. |
| 9. Maintainability by one person with AI agents | 1 | Two implementations in two languages without compile-time safety. limitshift history shows 10+ parity fixes in about 4 months and every feature committed twice (VERIFIED). A shipped bash-3.2 crash went unnoticed (VERIFIED). PowerShell traps hit in practice: the ParseExact comma, exit-code collapse, the PSModulePath fork-bomb, and a Pester-3 false green. The bash suite takes 2m46s and is non-hermetic (24/138 failures on a clean box). |
| 10. Fit with limitshift | 4 | Same languages and packaging model, with no second toolchain; it could be sourced directly by limitshift.sh/.ps1 and share the test harnesses. But it inherits limitshift's parity cost, and v2 has already moved to a pwsh-7-only engine (VERIFIED). The best fit would be a tiny JSON-CLI contract rather than shared script code. |
| 11. Packaging channels | 3 | GitHub Releases with checksums, a Homebrew formula (depends_on jq), AUR and apt are all easy. Scoop and winget handle bare .ps1 tools awkwardly, and an npm wrapper is pointless. Self-update is simple on POSIX; cmd/ps1 self-rewrite hazards on Windows are documented in the user's own ais.cmd comment (VERIFIED). |
| 12. Long-term risk (ecosystem stability, breaking changes) | 3 | bash and PowerShell are stable, but macOS bash is frozen at 3.2 forever and zsh is the default shell. PS 5.1 is frozen, while PS 7 changes JSON and argument-passing semantics across versions (7.6 on .NET 10). OS-tool versions drift (jq). The Linux keyring stack is evolving, and Windows AMSI signatures change without notice. |

## Conclusions

| # | Claim | Status | Confidence | Evidence | What the spec should do |
|---|---|---|---|---|---|
| 1 | acctshift should not be implemented as a dual bash/POSIX-sh + PowerShell script pair; scripts should be limited to installers (install.sh, install.ps1) and limitshift glue. | INFERRED | high | Synthesis of the VERIFIED findings below: limitshift parity drift (10+ fixes, every feature committed twice), a bash-3.2 crash in shipped limitshift.sh, credential-CLI size limits and silent truncation, PowerShell argument and JSON hazards, and 0.4-0.7 s pwsh per-call cost. | The spec mandates a single native binary for acctshift. Its distribution includes POSIX-sh install.sh and install.ps1 only; no runtime logic in scripts. |
| 2 | The user's own repos show continuous sh/ps1 parity drift and double work. | VERIFIED | high | CHANGELOG 1.1.0-1.3.2 and limitshift-v2 commits 71eb7d4 (sh missed agy limit wording), d5c69f7 (+226/-31 lines to port the /usage cross-check to sh), e4afb80 (ps1-only copilot no-detail bug), 46b600f (sh trim collapsed whitespace; the fix needs a Git Bash + cygpath + powershell.exe byte-parity test), feat(ps1)/feat(sh) commit pairs f5de773/adee223, 6feb25e/5e41b14, 968a2a5/854e95a. Pester has 248 It blocks against 138 bash test results. | One codebase and one test suite for acctshift. limitshift's integration surface toward acctshift must stay tiny (a handful of --json calls) so the sh/ps1 twins add little new parity burden. |
| 3 | The user's v2 engine has already abandoned the twin model and requires PowerShell 7. | VERIFIED | high | v2/ holds 6,877 lines of .ps1 and 0 .sh. v2/v2.ps1, preflight.ps1 and run-tests.ps1 start with '#requires -Version 7'. Commit 83a282d 'chore(v2): consolidate on pwsh 7'. | acctshift must be callable equally well from pwsh 7, Windows PowerShell 5.1 (v1) and bash 3.2 (v1). That argues for a native exe with a JSON CLI contract rather than a PowerShell module. |
| 4 | Shipped limitshift.sh (1.3.2 and v2) uses bash-4-only ${var,,} and crashes on macOS /bin/bash 3.2.57 whenever a task is blocked. | VERIFIED | high | limitshift.sh:2825 and 3209 (v2: 3759, 4143). The repo's bash suite under a source-built bash 3.2.57 gives 110 passed / 28 failed against 114/24 on bash 5.2. The 4 block-recovery tests flip with 'line 2825: ${trimmed_reason,,}: bad substitution'. | Any shell glue (install.sh, limitshift integration) needs a CI job that runs it under bash 3.2.57 (buildable on the Linux runner) and under dash. A fix task was queued (task_98486ec8). |
| 5 | Linux secret-tool is absent by default on Debian and Ubuntu (desktop and server), fails without a D-Bus session, and silently truncates secrets at 8192 bytes while exiting 0. | VERIFIED | high | The Ubuntu 24.04.5 and 26.04.1 desktop manifests list gnome-keyring and libsecret-1-0 but no libsecret-tools; the 24.04 cloud manifest has neither. Headless run: 'Cannot autolaunch D-Bus without X11 $DISPLAY'. Under dbus-run-session + gnome-keyring, inputs of 8193 and 12000 bytes gave store_exit=0 and stored_bytes=8192 with 'password is too long' on stderr. Bun.secrets and Python keyring fail headless the same way. | acctshift must have a file-backed vault fallback (0600, optionally encrypted) for headless Linux, SSH and WSL. Any use of the Secret Service must verify the read-back length or hash. Never shell out to secret-tool for secrets over 8 KiB. |
| 6 | macOS 'security -i' has a 4096-byte line buffer (about 2013-byte payload with -X hex). Claude Code 2.1.292 itself switches to putting the hex secret on argv beyond 4032 characters. | VERIFIED | high | Strings in /opt/claude-code/bin/claude (2.1.292): 'a.length<=U?await oh("security",["-i"],{input:a…}):await oh("security",["add-generic-password","-U","-a",n,"-s",I,"-X",i]…' and 'U=4032'. Corroborated by Claude Code issues #30337 and #28541 (2013-byte boundary). | If acctshift uses /usr/bin/security (for example for agy's item, to keep a stable Apple-signed requester identity), it must keep commands under 4096 bytes or explicitly accept argv exposure. Otherwise use Security.framework. Add size-boundary tests on a real Mac. |
| 7 | Windows has no built-in cmdlet that reads generic Credential Manager secrets. Scripts need Add-Type C# P/Invoke, which cost 0.4-0.7 s per process in pwsh 7.6, and blobs are capped at 2560 bytes. | VERIFIED | medium | pwsh 7.6.6 on Linux measured addtype_ms=717/433/408 and a 704 ms total process median (179 MB RSS); a precompiled DLL still loads in 140 ms (409 ms total). MS Learn CREDENTIALW: 'cannot be larger than CRED_MAX_CREDENTIAL_BLOB_SIZE (5*512) bytes'. The Windows-host timing and AMSI behaviour are not measured. | The Windows credential backend must chunk or store larger blobs in DPAPI-protected files. Measure the agy credential blob size on Windows before committing to a Credential Manager slot swap. Do not depend on PowerShell for it. |
| 8 | PowerShell 7 JSON handling mutates data: ISO strings are coerced to DateTime and offsets rewritten on round-trip, the default -Depth 2 truncates silently to strings, and single-element arrays unwrap. PS 5.1 behaves differently. | VERIFIED | high | pwsh 7.6.6: '2026-10-07T21:00:00+01:00' round-trips as '2026-10-07T20:00:00+00:00'. Depth-2 output was {"claims":"@{email=x@y; plan=}"} with only a WARNING. @(1)\|ConvertTo-Json gives 1. | acctshift --json output must include epoch-integer timestamps (resetAtEpoch, limitedUntilEpoch) next to ISO strings, keep nesting shallow, and always emit arrays. acctshift must never round-trip a CLI's own auth.json through a re-serializer that rewrites fields; copy bytes. |
| 9 | PowerShell wrappers are unsafe for argument pass-through: a param()-based script captured a child's '-c' flag, and Windows PowerShell 5.1 legacy native quoting forced limitshift to hand-roll CommandLineToArgvW quoting. | VERIFIED | high | pwsh 7.6: 'Parameter cannot be processed because the parameter name '' is ambiguous. Possible matches include: -Command -Cli…' when calling 'acctshift.ps1 exec claude -- sh -c …'. limitshift.ps1:1700-1730 ConvertTo-WindowsArgString comment: 'Start-Process -ArgumentList given an *array* … does NOT quote elements that contain spaces'. | Add 'acctshift env <cli> --format sh\|ps\|json'. limitshift applies the env and launches CLIs itself with its proven quoting, so arguments never pass through two wrappers. 'exec' remains for standalone users. |
| 10 | Per-call latency: sh+jq is about 25 ms (next) and 6 ms (exec) on Linux, pwsh 7.6 is about 420-700 ms, and compiled binaries are 2-13 ms (Bun 10.5, Node SEA 32, Deno 43, PyInstaller onefile 169). | VERIFIED | high | Python harness medians on the Linux x86_64 sandbox (section 7 of the report). Git Bash fork emulation on Windows is cited at about 27 ms per fork and degrading with uptime (INFERRED for Windows). | Set a non-functional requirement: next/env/status under 50 ms cold on every OS. This excludes PowerShell and PyInstaller onefile implementations. |
| 11 | Bun --compile cross-builds all 8 targets (including musl and windows-arm64) from one Linux runner in 1-3 s each, producing 62-86 MB binaries with about 10 ms startup and built-in Bun.secrets. Bun.secrets is experimental and fails headless. Claude Code itself is a Bun-compiled binary. | VERIFIED | high | Build log sizes: darwin-arm64 62,226,930 B to windows-x64 86,088,704 B; linux-x64 gzip 36.7 MB. Darwin outputs contain LC_CODE_SIGNATURE. typeof Bun.secrets === 'object' with get/set/delete. 'Cannot autolaunch D-Bus' headless. '$bunfs' strings in /opt/claude-code/bin/claude. Bun docs: 'new and experimental', 'typically 2048-4096 bytes'. | If the language tracks prefer TypeScript, Bun is the strongest JS option for build and startup. The spec must still budget about 35 MB per download and keep an independent keyring fallback, and must not rely on Bun.secrets alone. |
| 12 | Node SEA works cross-target via postject but yields 93-127 MB binaries. macOS output must be re-signed after injection, and native keyring addons must be extracted to temp and dlopen'ed. | VERIFIED | high | Node 24.21.0 builds: linux-x64 126,684,352 B (gzip 43.3 MB), win-x64 93,708,288 B with a 'signature seems corrupted' warning. Node docs: 'Stability: 1.1', 'codesign --sign - sea', native addons via getRawAsset and process.dlopen, --build-sea since v25.5.0. | Node SEA is not preferred: largest artifacts, extra signing steps, and native-addon extraction for the keyring. |
| 13 | .NET NativeAOT gives a 1.8 MB binary with 3.5 ms startup but cannot cross-compile to another OS. Zig cross-builds 8 targets at 130-443 KB but cannot link Security.framework or libsecret without SDK or sysroot, and its standard library breaks between releases. PyInstaller cannot cross-compile. | VERIFIED | high | dotnet publish -r win-x64 gave 'Cross-OS native compilation is not supported.'; osx-arm64 and linux-arm64 failed at clang link. zig cc -framework Security gave 'unable to find system framework "Security"'. Pre-0.15 Zig code failed on 0.17.0 ('heap' has no member 'GeneralPurposeAllocator'). PyInstaller built for the host only. | These are not recommended as the acctshift language. NativeAOT would need three CI runner OSes; Zig lacks keyring support and has API churn that hurts AI-assisted maintenance. |
| 14 | Scripts' real advantages are zero build, KB-sized artifacts and no Gatekeeper or notarization exposure. On Windows they bring execution-policy and Mark-of-the-Web friction, and users already have to run Set-ExecutionPolicy and Unblock-File for limitshift. | VERIFIED | high | limitshift README.md lines 105 and 129. MS Learn about_Execution_Policies: Undefined resolves to Restricted on Windows clients; RemoteSigned needs a signature or Unblock-File for downloaded scripts; curl.exe and Invoke-WebRequest downloads do not set MOTW. | Install docs should prefer curl/irm-based installers (no MOTW) and avoid asking users to change the execution policy again for acctshift. A signed or packaged native exe avoids the policy issue entirely. |
| 15 | A scripts-only approach is viable only for an env-injection MVP (claude via CLAUDE_CODE_OAUTH_TOKEN, codex via CODEX_HOME) that never touches OS credential stores. | INFERRED | medium | The sh prototype implemented next/exec in about 1.7 KB with correct exit-75 and exit-code passthrough, at 25 ms and 6 ms per call. Every OS-store path hit a size or availability wall (sections 4.1-4.3 of the report). | Optional Phase 0: limitshift could ship an internal env-only rotation for claude and codex while acctshift (native) is built. agy store swapping and the interactive wrapper belong only in the native binary. |

## Full report

# Track `lang-scripts`: acctshift as bash/POSIX-sh + PowerShell scripts (plus a short survey of Node SEA, Bun, Deno, Python, .NET NativeAOT and Zig)

All dates are relative to 2026-10-07. **VERIFIED** means I saw evidence in this session (command output, file contents or a fetched document). **INFERRED** means it comes from memory or reasoning, with a citation where one exists.

---

## 0. Verdict up front

- **Do not implement acctshift as a bash + PowerShell pair.**
  - The cost of keeping two implementations in step is already proven in the user's own repos (section 3).
  - The three OS credential stores are reachable from scripts only through CLI wrappers that have size limits, silent-truncation bugs or argv-exposure problems. On Windows there is no script-only path at all (section 4).
  - Process control and argument pass-through from PowerShell is a documented minefield in limitshift (section 5).
  - PowerShell costs 0.4–0.7 s per call (section 7).
- **When scripts are the right choice:** a claude- and codex-only MVP that just sets an environment variable (`CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_HOME`) and never touches an OS credential store. That is small enough to live inside limitshift itself as a function.
- **Keep scripts for:**
  - the installers (`install.sh` in POSIX sh, `install.ps1`);
  - the thin limitshift integration layer, which only calls `acctshift … --json`.
- **Single biggest risk for this project if scripts are chosen:** agy credential-store swapping. It needs byte-exact, lock-protected read/write of another app's keychain, Secret Service or Credential Manager entry. From scripts this goes through `security`, `secret-tool` and Add-Type P/Invoke. Each has a different size limit (about 2 KB, 8 KiB with silent truncation, and 2560 bytes) and a different failure mode. A silently truncated credential means a logged-out agy account.

---

## 1. Method and environment

| Item | Value |
|---|---|
| Sandbox | Ubuntu 24.04.5 LTS x86_64, 4 vCPU, 15 GB RAM, Linux 6.18. No macOS or Windows host. No Docker daemon (`/var/run/docker.sock` missing). |
| bash | 5.2.21 (system). **GNU bash 3.2.57 built from source** (`https://ftp.gnu.org/gnu/bash/bash-3.2.57.tar.gz`, sha256 `3fa9daf85ebf35068f090ce51283ddeeb3c75eb5bc70b1a4a7cb05868bfe06a4`, `CFLAGS="-O1 -std=gnu89 -w -fcommon" configure --without-bash-malloc --disable-nls`). |
| dash | system `/usr/bin/dash` (POSIX sh) |
| jq | 1.7 (system) |
| PowerShell | **7.6.6 on .NET 10.0.12** from `packages.microsoft.com/ubuntu/24.04/prod/pool/main/p/powershell/powershell_7.6.6-1.deb_amd64.deb` (55,382,806-byte deb, 180 MB unpacked). GitHub release downloads are blocked by the proxy (HTTP 403). |
| Node | 22.22.0 (system) and **24.21.0 LTS "Krypton"** official binaries, SHA256-checked against `SHASUMS256.txt` |
| Bun | 1.4.2 (preinstalled) |
| Deno | 2.9.7 (`dl.deno.land`) |
| Python | 3.13.16, PyInstaller 6.22.3, keyring 25.7.0, SecretStorage 3.5.0, jeepney 0.9.0 |
| .NET | SDK 10.0.401 via the official `dotnet-install.sh` (624 MB SDK plus 1.6 GB NuGet cache for ILCompiler packs) |
| Zig | **0.17.0** (released 2026-10-01; sha256 `1cbe9df9…2026` verified) |
| Go (reference only) | 1.24.7 |

**Prototype.** Every runtime got the same small program:

- `next <cli> --limited-until <iso>`:
  - takes a lock;
  - reads the state JSON (5 accounts);
  - marks the current account as limited;
  - picks the next account that is not capped;
  - writes the state atomically (temp file plus rename);
  - prints `{"ok":…}` and exits 75 when every account is capped.
- `exec <cli> -- cmd…`:
  - injects `CLAUDE_CODE_OAUTH_TOKEN`;
  - inherits stdio;
  - passes the child's exit code through.

Timing used a Python harness: one warm-up run, then N runs, reporting the median. Example of the sh+jq prototype working:

```
{"ok":true,"account":"a3"}   rc=0
{"ok":false}                 rc=75
child sees token-for-a3      rc=7   (exit code passthrough)
```

All large downloads and toolchains were deleted at the end; the scratch dir is down to 49 MB.

---

## 2. What a stock machine already has (the dependency problem for scripts)

| Platform | Shell | jq | Secret store CLI | Notes |
|---|---|---|---|---|
| macOS 13/14 | `/bin/bash` **3.2.57** (GPLv2; Apple never shipped bash 4+); zsh is the default login shell | **none** | `/usr/bin/security` (always present) | python3 is a Command Line Tools stub. INFERRED, cited [macOS bash] |
| macOS 15 Sequoia+ | bash 3.2.57 | `/usr/bin/jq` = `jq-1.6-159-apple-gcff5336-dirty` (a 1.6-era Apple build) | `security` | INFERRED, cited [HN 41560170] |
| Ubuntu 24.04.5 desktop | bash 5.2.21 | jq 1.7.1 | **`libsecret-tools` NOT installed**. `gnome-keyring 46.1`, `libsecret-1-0 0.21.4` are present. | **VERIFIED** from the release manifest `ubuntu-24.04.5.1-desktop-amd64.manifest` |
| Ubuntu 26.04.1 desktop | bash 5.3 | jq 1.8.1 | **`libsecret-tools` NOT installed**. `gnome-keyring 50.0` present. | **VERIFIED** from `ubuntu-26.04.1-desktop-amd64.manifest` |
| Ubuntu 24.04 server (cloud image) | bash 5.2.21 | jq 1.7.1 | no libsecret, no gnome-keyring, no Secret Service at all | **VERIFIED** from `ubuntu-24.04-server-cloudimg-amd64.manifest` |
| Debian 13 "trixie" | bash | optional | `secret-tool` lives in separate pkg `libsecret-tools` 0.21.7-1 | VERIFIED (packages.debian.org) |
| Fedora | bash | optional | `secret-tool` is inside the main `libsecret` pkg (`usr/bin/secret-tool`); present wherever GNOME pulls libsecret | VERIFIED file list (packages.fedoraproject.org); "present on Workstation" is INFERRED |
| Arch | bash | optional | `secret-tool` inside `libsecret` 0.21.8.2-1 | VERIFIED (archlinux.org file list) |
| Alpine | **busybox ash, no bash by default** (INFERRED) | optional | `secret-tool` inside `libsecret` (main) | VERIFIED (pkgs.alpinelinux.org) |
| WSL2 | distro bash | distro | no D-Bus session or keyring daemon by default, so it behaves like the headless case below | INFERRED. The headless failure itself is VERIFIED in §4.1. |
| Windows 10/11 | **Windows PowerShell 5.1 only** (.NET Framework 4.x). pwsh 7 is not inbox. | **none** | **no CLI that can read generic credentials** (`cmdkey` writes and lists only) | Execution policy for Windows clients with nothing configured: **Restricted** (5.1). The 7.6 docs say Default = RemoteSigned. VERIFIED (MS Learn about_Execution_Policies). |

Consequences:

- A script implementation must either require `jq` (as limitshift does today: README line 106, "`brew install jq` / `sudo apt install jq`") or ship a jq binary per platform. Shipping jq brings back the binary-distribution problem that scripts were supposed to avoid.
- On Linux it must tell users to install `libsecret-tools` and have a running keyring daemon.
- On Windows it must ask users to change the execution policy. limitshift's README already does: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned; Unblock-File .\limitshift.ps1` (VERIFIED, README.md lines 105 and 129).

---

## 3. Evidence from limitshift: what the two-implementation model really costs

The local clones of `/home/user/j-ts/limitshift` and `/home/user/limitshift-v2` are squashed to a single commit each. The full history of `j-ts/limitshift-v2` was read through the GitHub API; `j-ts/limitshift` is not reachable from this session.

### 3.1 Parity defects and double work (all VERIFIED from CHANGELOG.md or commit messages and diffs)

| # | Where / when | What happened | Side that lagged or broke |
|---|---|---|---|
| 1 | 1.3.2 (2026-08-31) CHANGELOG | Copilot `model:"auto"` got an explicit `--effort` from the **bash** launcher. "`limitshift.sh` now mirrors the PowerShell launcher." | sh |
| 2 | commit `71eb7d4` (2026-08-09) "fix(sh): match agy real quota-reached wording…" | agy limit regex and both reset extractors (`resets <clock>`, `resets in 1h55m24s`) were missing in sh, so "a capped agy run was misclassified as a plain error". Diff: +30/−5 including a new test. | sh |
| 3 | commit `4e26af0` "fix(ps1,sh): parse agy models id column" | Same parsing bug in both runners, fixed twice | both |
| 4 | commit `e4afb80` (1.3.1) | Copilot failures showed "(no detail)" in **ps1** only. sh already had the raw-output fallback. | ps1 |
| 5 | 1.3.1 CHANGELOG | `Get-BareClockResetTimeFromErrorText` (ps1) rolled resets to the wrong year. "The new `limitshift.sh` port… was designed to derive the day directly… and never had this bug". The two runners use different algorithms for the same feature. | ps1 |
| 6 | commit `d5c69f7` "fix(sh): reinstate a scoped claude /usage reset cross-check, matching ps1" | Feature existed in ps1 only. Porting it took **+226/−31 lines** (109 in limitshift.sh, 117 in tests). | sh |
| 7 | 1.1.0 CHANGELOG | "Date-aware reset parsing (`limitshift.ps1`)", a ps1-only feature at release time | sh |
| 8 | 1.1.0 CHANGELOG | ps1 `ParseExact(... -replace ..., ...)`: the comma bound as a method-argument separator, giving a 4-argument overload. The empty `catch` swallowed the error, so precise reset times were always dropped. | ps1 (language pitfall) |
| 9 | 1.1.0 CHANGELOG | ps1 `Start-Process -Wait` costs ~1 s per spawn on Windows. Startup took **~22 s on an 11-task queue**; the fix was `& git` (~56 ms) plus memoization. | ps1 (platform pitfall) |
| 10 | commit `46b600f` (2026-06-20) | sh `awk '{$1=$1;print}'` trim collapsed internal whitespace in reasons. The fix added a **cross-shell byte-identity test** that needs `C:\Program Files\Git\bin\bash.exe`, `cygpath -w` and `powershell.exe`. | sh |
| 11 | commits `b561b3c`, `1750602` | "gate the verify feature on jq for the Bash runner": a feature is only available in sh when an extra dependency exists | sh |
| 12 | commit pairs `f5de773`/`adee223`, `6feb25e`/`5e41b14`, `968a2a5`/`854e95a` | Every feature is a `feat(ps1)` commit followed by a `feat(sh)` commit (atomic write, run-state helpers, run budget) | double work |
| 13 | commit `182a1d5` (v2) | A `.ps1` shim hosted in `powershell.exe` 5.1 hit `#requires -Version 7` and was refused in ~0.3 s. The whole mission blocked. | PS 5.1 vs 7 |
| 14 | commit `faa9c8d` (v2) | pwsh 7.6 MSIX children prepend module dirs, which caused a recursive **fork-bomb** in tests. Also: "a called script's own `exit N`… collapses to 0/1" under `-Command`. | PowerShell host semantics |
| 15 | commit `37f7441` (v2) | A Pester 3.x environment errored but **exited 0**, giving a false-green run | PowerShell test tooling |
| 16 | `/home/user/ai-switcher/bin/ais.cmd` (user's file) | "Started from PowerShell 7, PSModulePath points at its modules and Windows PowerShell cannot load Get-FileHash/Expand-Archive". Worked around by clearing `PSModulePath`. | PS 5.1 vs 7 |
| 17 | commit `83a282d` "chore(v2): consolidate on pwsh 7" | **v2 engine abandoned the twin model**: `v2/` holds 6,877 lines of `.ps1`, 0 `.sh`, and `#requires -Version 7` | design direction |

### 3.2 New latent bug: shipped limitshift.sh does not run on macOS's bash 3.2 (VERIFIED)

`limitshift.sh` claims "macOS (bash 3.2+)" in its header and in CHANGELOG 1.0.0. It uses bash-4 lowercase expansion:

```
/home/user/j-ts/limitshift/limitshift.sh:2825:  if [[ "${trimmed_reason,,}" =~ ^human: ]]; then
/home/user/j-ts/limitshift/limitshift.sh:3209:  (same)
/home/user/limitshift-v2/limitshift.sh:3759, 4143 (same)
```

Running the repo's own suite (`tests/test-limitshift.sh`, on a scratch copy) with bash 3.2.57 first on PATH, compared with bash 5.2:

```
bash 5.2  : passed: 114  failed: 24   (2m46s)
bash 3.2.57: passed: 110  failed: 28   (2m47s)
diff: 4 tests flip ok -> FAIL:
  block recovery — recoveryAttempts absent does not retry a blocked task
  block recovery — blocked task resumes same session with Variant A and completes
  block recovery — HUMAN short-circuits recovery and writes needs-human marker
  block recovery — exhaustion writes failed and needs-human markers
log: limitshift.sh: line 2825: ${trimmed_reason,,}: bad substitution
```

So any `[[TASK_BLOCKED]]` crashes limitshift.sh on a stock Mac. I queued a separate task suggestion (`task_98486ec8`) to fix it and add a bash-3.2 CI job.

Other bash-3.2 behaviour checked directly with the built bash 3.2.57 (VERIFIED). Each of these is a trap for anyone, human or AI agent, writing "modern bash":

- `declare -A` fails with "invalid option".
- `mapfile` is "command not found".
- `printf '%(%s)T'` gives "invalid format character".
- `local -n` is an invalid option.
- `set -u; a=(); echo "${a[@]}"` fails with **"a[@]: unbound variable"**; bash 5.2 prints an empty line.

### 3.3 Size and duplication (VERIFIED, `wc -l` and grep)

| | limitshift 1.3.2 | limitshift-v2 |
|---|---|---|
| limitshift.sh | 3,314 lines | 4,397 lines |
| limitshift.ps1 | 3,760 lines | 4,465 lines |
| bash tests | 4,829 lines; 138 results in a run | 5,937 lines |
| Pester tests | 4,400 lines; **248 `It` blocks** | 5,222 lines; 276 `It` |
| v2 engine | — | 6,877 lines, PowerShell 7 only |

The bash suite has ~56% of the Pester test count. Coverage parity is not maintained either.

### 3.4 Portability glue inside limitshift.sh (VERIFIED, grep)

| Kind of glue | 1.3.2 | v2 |
|---|---|---|
| `jq` invocation lines | 76 | 129 |
| `tr -d '\r'` (CRLF from jq under Git Bash on Windows) | 45 | 86 |
| GNU `date -d` / BSD `date -j -f` dual paths | 15 | — |

Also present: `sha256sum` vs `shasum -a 256` fallback, and `date -d @N` vs `date -r N` fallback.

### 3.5 Test infrastructure

- The bash suite takes **2 min 46 s** on Linux.
- It is **not hermetic**: 24 of 138 tests fail on a clean Linux box because they need `codex`, `gemini`, `copilot` or `ollama` on PATH ("The following CLI(s) are used in the queue but not found on PATH").
- Cross-shell parity tests need Git Bash on Windows (§3.1 #10).

---

## 4. OS credential stores from scripts

### 4.1 Linux: `secret-tool` (libsecret-tools 0.21.4 here)

All four results below are VERIFIED.

- **Headless means no store.**

  ```
  $ printf x | secret-tool store --label=t service acctshift-test account a
  secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY      (exit 1)
  ```

  Bun's built-in `Bun.secrets.set()` fails with the identical message, and Python `keyring` resolves to `keyring.backends.fail.Keyring (priority: 0)`. The lack of a Secret Service on headless Linux, SSH sessions and WSL is a **property of the platform, not the language**. acctshift needs a file-backed fallback no matter which language it is written in.
- **Making it work headless** needs `dbus-run-session` plus `gnome-keyring-daemon --unlock --components=secrets` with a password on stdin. It then works, at ~25 ms per `lookup`. gnome-keyring's control socket failed to bind when `XDG_RUNTIME_DIR` was long ("Address already in use" / "No such file or directory"). The cause is the ~108-byte `sun_path` limit; this is observed, not root-caused.
- **Silent truncation at 8 KiB, exit 0:**

  ```
  input=4000  store_exit=0 stored_bytes=4000
  input=8191  store_exit=0 stored_bytes=8191
  input=8192  store_exit=0 stored_bytes=8192   (+ "secret-tool: password is too long")
  input=8193  store_exit=0 stored_bytes=8192   (+ "password is too long")
  input=12000 store_exit=0 stored_bytes=8192   (+ "password is too long")
  ```

  A script that checks `$?` stores a corrupt credential and reports success.
- **Not installed by default** on Debian or Ubuntu, desktop or server (§2).

### 4.2 macOS: `/usr/bin/security`

- **What Claude Code itself does** (VERIFIED from strings in `/opt/claude-code/bin/claude`, Claude Code 2.1.292, a Bun-compiled 251 MB binary; `$bunfs` paths are present):

  ```
  k=`add-generic-password -U -a "${S}" -s "${h}" -X "${w}"`   // w = Buffer.from(secret).toString("hex")
  … a.length<=U ? oh("security",["-i"],{input:a,…}) : oh("security",["add-generic-password","-U","-a",n,"-s",I,"-X",i],…)
  var I="Claude Code-device-keys",b=2000,U=4032
  ```

  Claude Code sends the command through `security -i` on stdin when it is at most 4032 characters, and **otherwise puts the hex secret on argv**.
- **Cause:** `security -i` has a 4096-byte line buffer. With hex encoding the maximum payload is **≈2013 bytes**, and longer input "fails silently (exit code 1) or truncates" (cited from Claude Code issues #30337 and #28541). A shell script hits exactly the same wall, and above it must expose the secret on argv, where same-user `ps` can see it.
- **ACL and partition list** (INFERRED, to test on a real Mac):
  - Items created via `security` carry the `apple-tool:` partition, so later `security` reads do not prompt.
  - Items created by agy (its own team-ID partition) prompt the first time, and "Always Allow" binds to `/usr/bin/security`'s stable Apple identity.
  - The same prompt for an **ad-hoc-signed compiled binary** binds to its cdhash, which changes on every release, so it re-prompts after each update.
  - This is an argument for a compiled acctshift to still shell out to `/usr/bin/security` for *agy's* item, while respecting the 2 KB stdin limit.

### 4.3 Windows: Credential Manager and DPAPI from PowerShell

- **No in-box cmdlet reads `CRED_TYPE_GENERIC` secrets.**
  - `cmdkey` only lists and adds; it puts the password on argv and stores a UTF-16 blob, so it cannot write arbitrary bytes. (INFERRED, standard behaviour.)
  - The WinRT `PasswordVault` projection works only in 5.1 (.NET 5+ removed WinRT projection) and stores *web* credentials, not generic ones (INFERRED).
  - That leaves **Add-Type with C# P/Invoke** to `advapi32!CredReadW/CredWriteW/CredFree`.
- **Measured cost of that approach** (VERIFIED on pwsh 7.6.6 on Linux; Windows numbers are expected to be the same or worse because AMSI scans the inline C#):

  ```
  Add-Type (inline CREDENTIAL struct + 3 DllImports): addtype_ms=717, 433, 408
  whole process (pwsh -NoProfile -File addtype.ps1): median 704 ms, max RSS 179 MB
  precompiled 2.5 KB DLL via Add-Type -Path: load_ms=140, whole process median 409 ms
  ```

  A precompiled DLL means shipping a binary anyway, with the same signing and AV questions as a full binary.
- **Size limit:** `CredentialBlobSize` "cannot be larger than CRED_MAX_CREDENTIAL_BLOB_SIZE (5*512) bytes" = **2560 bytes** (VERIFIED, MS Learn CREDENTIALW). Anything larger, such as an OAuth JSON with several JWTs (INFERRED to be >2.5 KB for codex `auth.json`), must be chunked or kept in a DPAPI-encrypted file.
- **DPAPI:** `ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString` gives user-scoped DPAPI ciphertext on both 5.1 and 7 without Add-Type (INFERRED). On non-Windows, SecureString is **not** encrypted (INFERRED).
- **AMSI/Defender:** PowerShell script blocks, including Add-Type source, are AMSI-scanned. A script that P/Invokes the Credential Manager APIs looks just like known credential-dumping tradecraft (cited: credential-dumping brief). False-positive risk is real but **not measured here** (INFERRED; open question).

### 4.4 Shell data-integrity pitfalls (VERIFIED)

```
x=$(printf 'secret\n\n')   -> "secret"   (trailing newlines stripped)
x=$(printf 'a\0b')         -> "ab"        (bash 5.2 warns "ignored null byte"; bash 3.2.57 drops it silently)
```

Every secret must therefore be base64- or hex-encoded on every hop: keychain to variable to file to environment.

---

## 5. Process control from scripts

| Need (spec) | POSIX sh / bash | PowerShell | Evidence |
|---|---|---|---|
| Spawn with a modified env and pass through stdio and exit code | Easy: `VAR=…; export VAR; exec "$@"`. Measured 5.7 ms. | OK with a raw `$args` script (`& $exe @rest; exit $LASTEXITCODE`). **A `param()` block captured the child's `-c` flag:** "Parameter cannot be processed because the parameter name '' is ambiguous. Possible matches include: -Command -Cli …" | VERIFIED |
| Empty or quoted arguments to native exes | Fine | pwsh 7.6: `PSNativeCommandArgumentPassing=Standard` passes `''`, `"q"`, `-c` correctly. In 5.1, legacy passing drops empty args. limitshift hand-rolls `ConvertTo-WindowsArgString` (CommandLineToArgvW rules) because "Start-Process -ArgumentList given an *array* … does NOT quote elements that contain spaces". | VERIFIED (7.6 demo; limitshift.ps1:1700–1730) |
| Kill the whole process tree, forward Ctrl+C | bash: `set -m` puts the child in its own process group; `kill -TERM -- -$pgid` worked (exit 143). **dash: "set: can't access tty; job control turned off" and "kill: Illegal number: -"**, so this is not POSIX-portable headless. | PS7: `Process.Kill($true)` kills the tree. 5.1: `taskkill /T /F`. Job Objects need P/Invoke. | VERIFIED (sh/bash); PS INFERRED |
| PTY / ConPTY (phase-2 interactive wrapper) | No PTY. `script(1)` syntax differs between BSD (`script -q /dev/null cmd`) and util-linux (`script -qc cmd /dev/null`). | ConPTY only via substantial P/Invoke | INFERRED |
| Advisory file lock shared by both implementations | No `flock(1)` on macOS (util-linux tool). `mkdir` locks plus stale-PID handling are the only portable choice. | .NET `FileShare.None` on Unix is advisory flock and does **not** interoperate with sh `mkdir` locks | INFERRED; prototypes used `mkdir` (sh) and `File.Open(…,'None')` (ps1) |
| Atomic write | `mv` within the same dir | `Move-Item -Force` / `[IO.File]::Replace` (v2 commit `8a7866f` "V7 IO.File::Replace atomic writes") | VERIFIED (commit) |
| Symlink/junction on Windows without admin | n/a | `New-Item -ItemType Junction` works for directories; symlinks need Developer Mode | INFERRED |
| Time zone in limit text ("resets 12:50pm (Europe/London)", per ais-limits.mjs) | GNU: `TZ=Europe/London date -d …`; BSD: `TZ=… date -j -f …` (two code paths) | PS 7 (.NET 6+): IANA IDs OK. PS 5.1 (.NET Framework): `FindSystemTimeZoneById("Europe/London")` fails without a Windows-ID mapping table. | INFERRED |

---

## 6. PowerShell-specific data hazards (VERIFIED on pwsh 7.6.6 / .NET 10.0.12)

```
$o = '{"t":"2026-10-07T21:00:00Z","u":"2026-10-07T21:00:00+01:00","s":"2026-10-07"}' | ConvertFrom-Json
t type: System.DateTime kind=Utc
u type: System.DateTime kind=Local value=2026-10-07T20:00:00.0000000+00:00
s type: System.String
roundtrip: {"t":"2026-10-07T21:00:00Z","u":"2026-10-07T20:00:00+00:00","s":"2026-10-07"}
```

ISO strings are silently turned into DateTime, and the offset is rewritten on output. PS 5.1 keeps them as strings, so the same script behaves differently on 5.1 and 7. Any tool that round-trips a CLI's own `auth.json` through ConvertFrom/ConvertTo-Json changes that file.

```
WARNING: Resulting JSON is truncated as serialization has exceeded the set depth of 2.
default depth: {"tokens":{"id_token":{"claims":"@{email=x@y; plan=}"}},"one":[1]}
single-element array unwrap: [1] / 1      (ConvertTo-Json @(1)  vs  @(1) | ConvertTo-Json)
```

Startup and footprint (VERIFIED on Linux):
- `pwsh -NoProfile -NonInteractive -Command 'exit 0'`: median **197 ms**, 82 MB RSS.
- Windows PowerShell 5.1 on Windows with Defender is typically slower (INFERRED; not measurable here).

---

## 7. Per-call latency (VERIFIED: Linux x86_64, median of 8–30 runs after warm-up)

| Implementation | `next` (lock, JSON, atomic write) | `exec … /bin/true` | Max RSS |
|---|---|---|---|
| baseline `/bin/true` | — | 1.2 ms | — |
| **POSIX sh (dash) + jq** | **25.1 ms** (4 jq processes + date + mkdir + mv) | **5.7 ms** | 12 MB |
| bash 3.2.57 + jq | 25.7 ms | — | 12 MB |
| **pwsh 7.6 script** | **554 ms** | **422 ms** | 100–129 MB |
| pwsh 7.6 plus Add-Type P/Invoke (credential call path) | 704 ms total | — | 179 MB |
| pwsh 7.6 plus precompiled DLL | 409 ms total | — | 100 MB |
| Bun 1.4.2 `--compile` | 10.5 ms | 12.8 ms | 24 MB |
| Node 24.21 SEA | 32.6 ms | 32.0 ms | 63 MB |
| Node 22 plain script | 37.0 ms | — | 44 MB |
| Deno 2.9.7 compile | 43.3 ms | 46.8 ms | 46 MB |
| Python 3.13 script | 31.0 ms | — | — |
| PyInstaller onedir / onefile | 69.4 / **168.9 ms** | — | — |
| .NET 10 NativeAOT | — | 3.5 ms | 12 MB |
| Zig 0.17 | — | 1.8 ms | 12 MB |
| Go 1.24 (reference) | — | 3.0 ms | 12 MB |

**Windows caveat for the sh column:** Git Bash/MSYS2 emulates `fork`, costing ~27 ms per fork and degrading to 1–4.7 s per spawn after hours of uptime (desktop-heap exhaustion; a reboot resets it). A 4-jq script costs tens to hundreds of ms there (INFERRED, cited [MSYS2 fork]). That is why Windows needs the PowerShell twin, and why the twin costs ~0.4–0.7 s per call.

---

## 8. Other runtimes (brief, with empirical builds)

### 8.1 Cross-build matrix from ONE Linux x64 box (VERIFIED)

| Runtime | Targets built | Failures / caveats | Size per target (raw) | linux-x64 gzip | Build time per target |
|---|---|---|---|---|---|
| **Bun 1.4.2** `bun build --compile --minify --target=…` | **8/8**: linux x64/arm64 (glibc and musl), darwin x64/arm64, windows x64/arm64 | Darwin outputs carry `LC_CODE_SIGNATURE`. Windows icon/metadata flags cannot be cross-set. Docs recommend JIT entitlements when signing for notarization. | 62.2 MB (darwin-arm64) to 86.1 MB (win-x64) | 36.7 MB | 0.6–2.7 s |
| **Node 24.21 SEA** (blob plus `postject@1.0.0-alpha.6`, last published 2023) | 4 tested: linux-x64, linux-arm64, darwin-arm64, win-x64; all injected | Darwin needs `codesign --sign -` after injection (rcodesign on Linux). Win: "The signature seems corrupted!" warning. SEA is "Stability 1.1 – Active development". `--build-sea` exists since v25.5.0. Cross-target builds need `useCodeCache:false`. | 93.7 MB (win-x64) to 126.7 MB (linux-x64) | 43.3 MB | 3–12 s |
| **Deno 2.9.7** `deno compile --target …` | **6/6** incl. `aarch64-pc-windows-msvc` (supported since 2.9.3) | **No musl/Alpine target**. Ad-hoc signed on macOS by default (`LC_CODE_SIGNATURE` present). | 67.7 MB (darwin-arm64) to 105.0 MB (linux-arm64) | 34.4 MB | 2.6–5.2 s |
| **PyInstaller 6.22.3** | host only | No cross-compilation: needs a macOS runner, a Windows runner, and per-arch runners | 7.4 MB onefile / 17.7 MB onedir | 7.3 MB | 7 s |
| **.NET 10 NativeAOT** | linux-x64 OK; linux-musl-x64 linked (not run) | linux-arm64: clang link failed (no arm64 sysroot). osx-arm64: clang link failed (no SDK). win-x64: "**Cross-OS native compilation is not supported.**" | 1.82 MB | 0.89 MB | ~5 s (after a 1.6 GB NuGet restore) |
| **Zig 0.17.0** `zig build-exe -O ReleaseSmall -target …` | **8/8** incl. musl and windows-arm64 | Linking `-framework Security` fails ("unable to find system framework 'Security'", no SDK). `-lsecret-1` fails without a sysroot. `-ladvapi32` CredReadW for x64 and arm64 Windows **works** (mingw import libs ship with Zig). | 130 KB to 443 KB | 64 KB | 5–6.4 s |
| Go 1.24.7 (reference) | 6/6, `CGO_ENABLED=0` | Darwin has `LC_CODE_SIGNATURE` | 1.49–1.62 MB | 0.67 MB | 3.8–4.6 s |

### 8.2 Keyring options and licenses

| Runtime | macOS | Linux | Windows | Notes |
|---|---|---|---|---|
| Scripts | `/usr/bin/security` CLI | `secret-tool` (not installed by default on Debian/Ubuntu) | Add-Type P/Invoke (no cmdlet) | §4 |
| Node | `@napi-rs/keyring` 2.1.0 (MIT; prebuilt darwin x64/arm64, linux gnu/musl x64/arm64, win x64/arm64/ia32) | same | same | In SEA the `.node` addon must be written to temp and `process.dlopen`ed (Node docs, VERIFIED). keytar 7.9.0 last modified 2025-07; upstream archived (INFERRED). |
| Bun | **`Bun.secrets` built-in** (`get/set/delete` VERIFIED present) | libsecret via the Secret Service; fails headless (VERIFIED) | Credential Manager | Docs: "new and experimental", "Maximum password length… typically 2048–4096 bytes". Bun embeds JavaScriptCore (LGPL-2.1); relinking obligations need legal check (INFERRED). |
| Deno | none built-in; `npm:@napi-rs/keyring` or FFI | same | same | INFERRED |
| Python | `keyring` 25.7.0 (MIT) + SecretStorage 3.5.0 (BSD-3) + jeepney 0.9.0 (MIT) | headless resolves to the `fail` backend (VERIFIED) | `pywin32-ctypes` backend | PyInstaller: GPL-2 with bootloader exception |
| .NET | no BCL API; P/Invoke Security.framework (Git Credential Manager's MIT stores are a model) | libsecret P/Invoke | `CredRead` P/Invoke | INFERRED |
| Zig | hand-written bindings; macOS needs the SDK to cross-link | dlopen or hand-rolled D-Bus | advapi32 OK | VERIFIED link results |

### 8.3 Trust and distribution notes (INFERRED unless stated)

- **macOS arm64 needs at least an ad-hoc signature.** Bun, Deno, Go and Zig outputs already carry `LC_CODE_SIGNATURE` (VERIFIED). Node SEA must be re-signed after injection (VERIFIED from docs). Files fetched with `curl` get no quarantine attribute, so Gatekeeper does not check them; browser downloads do. Scripts avoid all of this.
- **JIT runtimes** (Bun, Node, Deno) need `allow-jit` / `allow-unsigned-executable-memory` entitlements under the hardened runtime for notarization (Bun docs, VERIFIED). AOT languages (Go, Rust, Zig, NativeAOT) do not.
- **AV false positives:** PyInstaller has a notorious history; Go has periodic reports; compiled JS runtimes have occasional reports. Claude Code itself ships as a Bun-compiled binary (VERIFIED, `$bunfs` strings), which lowers the novelty risk for Bun-compiled executables. Scripts are subject to AMSI instead.

---

## 9. Requirements from ai-switcher (allowed files only; for requirements)

- `launcher/ais-limits.mjs`: the limit detectors parse:
  - Claude session JSONL (`error:"rate_limit"`, "resets 12:50pm (Europe/London)");
  - Codex rollout `token_count.rate_limits.rate_limit_reached_type` (with the note "used_percent: 100 alone is NOT a signal");
  - agy "RESOURCE_EXHAUSTED … Resets in 4h46m9s".

  This needs time-zone-aware wall-clock to UTC conversion: hard in bash (GNU and BSD `date` differ) and in PS 5.1 (no IANA support).
- `launcher/ais-run.mjs`:
  - `ais run` polls log tails every 1 s;
  - kills the whole tree (`taskkill /T /F` or a `ps -A -o pid=,ppid=` walk plus SIGTERM, then SIGKILL);
  - runs `stty sane` after a killed TUI;
  - copies the session file to the next profile and resumes (`--resume <id>`, `resume <id>`, `--continue`).

  A phase-2 wrapper with these needs is far beyond comfortable bash/PowerShell territory.
- `launcher/ais-state.mjs`: atomic write via temp plus rename, no lock. acctshift must add a cross-process lock.
- `packaging/targets.mjs`: the previous release matrix was 5 targets (**no windows-arm64**). `bin/ais` and `bin/ais.cmd` bootstrap a SHA256-pinned portable Node 22.16.0 on first run, which is a runtime download to avoid next time. `ais.cmd` comments document cmd.exe self-rewrite hazards during `ais update`.

---

## 10. Scorecard rationale (scripts) and comparison grid for the alternatives

The scorecard field holds the 12 rows for **bash/POSIX-sh + PowerShell scripts**. The grid below gives my rougher scores for the alternatives I prototyped, for comparison; the other language tracks score Go and Rust in depth.

| Criterion | Scripts | Node SEA | Bun compile | Deno compile | Python/PyInstaller | .NET NativeAOT | Zig |
|---|---|---|---|---|---|---|---|
| 1 Platform reach | 4 | 4 | 5 | 4 (no musl) | 3 | 4 | 5 |
| 2 Footprint | 2 | 2 (94–127 MB) | 2 (62–86 MB) | 2 (68–105 MB) | 3 | 5 (1.8 MB) | 5 (≤0.45 MB) |
| 3 Latency | 3 (sh 25 ms / pwsh 0.4–0.7 s) | 4 (32 ms) | 5 (10 ms) | 4 (43 ms) | 2 (69–169 ms) | 5 (3.5 ms) | 5 (1.8 ms) |
| 4 Build / cross-compile | 5 (nothing to build) | 3 | 5 | 5 | 1 | 2 | 4 (keyring needs SDK) |
| 5 Credential store | 2 | 3 | 3 | 2 | 3 | 3 | 1 |
| 6 Process control | 2 | 4 | 4 | 4 | 4 | 4 | 3 |
| 7 Trust / distribution | 3 | 2 | 3 | 3 | 1 | 3 | 3 |
| 8 Licenses / supply chain | 4 | 4 | 3 (JSC LGPL check) | 5 | 4 | 5 | 5 |
| 9 Maintainability (1 dev + AI) | 1 | 4 | 4 | 4 | 4 | 4 | 1 (std churn) |
| 10 Fit with limitshift | 4 | 3 | 3 | 3 | 3 | 3 | 2 |
| 11 Packaging channels | 3 | 4 | 4 | 3 | 3 | 4 | 3 |
| 12 Long-term risk | 3 | 3 | 3 | 3 | 3 | 4 | 2 |

Zig maintainability evidence (VERIFIED): pre-0.15-style code fails on 0.17.0 with `error: root source file struct 'heap' has no member named 'GeneralPurposeAllocator'`. The new `pub fn main(init: std.process.Init) !u8` / `std.process.spawn(io, .{…})` API had to be learned by reading `lib/std/process.zig` before a prototype compiled.

---

## 11. Verdict for this option

- **Right choice when:**
  - acctshift only injects environment variables (claude: `CLAUDE_CODE_OAUTH_TOKEN`; codex: `CODEX_HOME`);
  - its secrets live in user-only (0600) files;
  - it never touches an OS credential store;
  - it is meant to be sourced by limitshift rather than shipped as a separate app.

  In that narrow case a ~2 KB POSIX-sh function plus a PowerShell function, both 3.2- and 5.1-safe, beats any binary on footprint and trust friction.
- **Wrong choice when** any of these are needed:
  - agy credential-store swapping;
  - Windows Credential Manager;
  - headless Linux keyring fallback;
  - process-tree control or a PTY wrapper (phase 2);
  - per-call overhead under 50 ms on Windows;
  - one test suite.

  That is the actual acctshift scope.
- **Single biggest risk:** silent credential corruption or exposure at the OS-store boundary:
  - `secret-tool` truncates at 8192 bytes with exit 0;
  - `security -i` caps at a ~2013-byte payload, beyond which the secret goes on argv;
  - Credential Manager caps blobs at 2560 bytes, reachable only via AMSI-scanned Add-Type;
  - shell command substitution strips trailing newlines and NULs.

  All of this would be implemented twice, in two languages, with the parity drift section 3 shows.

## 12. Spec implications (actionable)

1. **Implement acctshift as a single native binary.** Keep `install.sh` (POSIX sh: no bash-isms, no `readlink -f`, `sha256sum`/`shasum` fallback, as `/home/user/ai-switcher/install.sh` already does) and `install.ps1` as the only scripts.
2. **Add an `acctshift env <cli> [--account A] --format sh|ps|json` command.** It prints the variables to set and does not launch the CLI. limitshift keeps launching CLIs with its existing, tested Windows quoting (`ConvertTo-WindowsArgString`) and process handling. This avoids double argument-quoting through two wrappers and keeps acctshift out of the process tree for env-only CLIs (claude, codex). `exec` stays available for standalone use.
3. **Make JSON output friendly to PowerShell 5.1 and 7:**
   - always include epoch integers (`resetAtEpoch`, `limitedUntilEpoch`) next to ISO strings (PS 7 rewrites ISO offsets);
   - keep objects shallow, or document that consumers need `-Depth`;
   - always emit arrays as arrays;
   - put exactly one JSON document on stdout and send diagnostics to stderr;
   - exit 75 when all accounts are capped.
4. **Credential storage abstraction:**
   - (a) a file vault (0600 on POSIX; DPAPI-wrapped on Windows) as the always-available fallback for headless Linux and WSL;
   - (b) OS stores through native APIs;
   - (c) chunking or a pointer scheme for anything over 2560 bytes on Windows;
   - (d) never pass secrets on argv;
   - (e) hex/base64 for every transport;
   - (f) a test that round-trips 1 B, 2 KB, 4 KB, 8 KB and 16 KB secrets on all three OSes.
5. **macOS:** decide by experiment whether to read and write *agy's* item via `/usr/bin/security`, which has a stable Apple identity so "Always Allow" survives acctshift updates, or via Security.framework. If via `security`, keep the hex command line under 4096 bytes or fall back explicitly.
6. **Locking:** one lock protocol that every consumer can honour. Use a lock directory or lock file with PID plus start time and stale reclaim (the v2 `7226a7b` design); do not rely on flock interop between runtimes.
7. **limitshift side (separate work):**
   - fix `${var,,}` and add a bash-3.2.57 CI job (build from GNU source on the Linux runner, ~1 min);
   - keep limitshift's acctshift calls to `acctshift env|next|status --json`, so the sh twin needs only one jq parse per call.
8. **Per-call budget:** require acctshift `next`/`env`/`status` to complete in under 50 ms cold on all OSes. That rules out a PowerShell implementation (400–700 ms measured) and PyInstaller onefile (169 ms).

---

## Commands of note (excerpts)

```
$ build-bash32/bash -c 'x="HUMAN: foo"; [[ "${x,,}" =~ ^human: ]] && echo match'
bash: ${x,,}: bad substitution
$ PATH="$S/bash32bin:$PATH" bash tests/test-limitshift.sh   -> passed: 110 failed: 28  (vs 114/24 on 5.2)
$ secret-tool store … < 12000-byte file ; echo $?  -> "password is too long", 0 ; lookup | wc -c -> 8192
$ pwsh -NoProfile -File addtype.ps1   -> addtype_ms=717 / 433 / 408
$ bun build --compile --target=bun-windows-arm64 …   -> rc=0 size=77580800
$ dotnet publish -r win-x64 (PublishAot)            -> error : Cross-OS native compilation is not supported.
$ zig cc -target aarch64-macos kc.c -framework Security -> error: unable to find system framework "Security"
```

## Open questions

- On a real Mac (macOS 14, 15 and 26, arm64 and x64): confirm /bin/bash is 3.2.57 and /usr/bin/jq is jq-1.6-apple on 15+. Run the limitshift bash suite with BSD date/sed. Measure fork/exec latency of the sh+jq prototype.
- On a real Mac: when reading agy's keychain item via /usr/bin/security versus via an ad-hoc-signed compiled binary, which prompts appear, and does 'Always Allow' survive an acctshift upgrade (cdhash change)? Test the partition-list behaviour (apple-tool: vs teamid:).
- On a real Mac: what is the exact security -i boundary for a JSON blob of agy's real credential size, and how large is agy's stored credential on each OS?
- On Windows 11 x64 and arm64: measure powershell.exe 5.1 and pwsh 7.6 startup and Add-Type compile time with Defender real-time protection on. Check whether Defender/AMSI flags a script that P/Invokes CredReadW/CredWriteW, or a precompiled helper DLL.
- On Windows: how large is agy's Credential Manager blob (against the 2560-byte limit), what is its TargetName format, and does agy chunk it? How large is codex auth.json (whose size matters if cli_auth_credentials_store=keyring)?
- On WSL2 and SSH-only Linux: confirm there is no Secret Service by default, and decide whether acctshift should start a private dbus-run-session plus keyring or go straight to the file vault.
- On Alpine: confirm bash is absent by default, and check whether a POSIX-sh installer needs anything beyond busybox (sha256sum, tar, curl/wget).
- Git Bash on Windows: measure the sh+jq prototype per-call cost on the user's actual machine after long uptime (the reported desktop-heap degradation).
- Bun-compiled executables: legal check of LGPL-2.1 (JavaScriptCore) relinking obligations for redistributed binaries, and the Defender false-positive rate for unsigned Bun binaries on fresh Windows installs.
- Bun.secrets on Windows and macOS: real maximum blob size, and behaviour for items created by other applications (needed for agy slot swapping).

## Sources

- limitshift CHANGELOG (v1.0.0-1.3.2), parity fixes and bash 3.2 claim: /home/user/j-ts/limitshift/CHANGELOG.md
- limitshift.sh, bash-4 ${trimmed_reason,,} at lines 2825 and 3209; GNU/BSD date dual paths: /home/user/j-ts/limitshift/limitshift.sh
- limitshift.ps1 ConvertTo-WindowsArgString (lines 1700-1730): /home/user/j-ts/limitshift/limitshift.ps1
- limitshift README (jq requirement; Set-ExecutionPolicy + Unblock-File): /home/user/j-ts/limitshift/README.md
- limitshift bash test harness: /home/user/j-ts/limitshift/tests/test-limitshift.sh
- limitshift-v2 CHANGELOG and v2/ (pwsh 7 only): /home/user/limitshift-v2/CHANGELOG.md ; /home/user/limitshift-v2/v2/v2.ps1
- limitshift-v2 commit 71eb7d4 (sh missed agy limit wording): https://github.com/j-ts/limitshift-v2/commit/71eb7d47f3bbb24c278381ca4874d912e3fe46bc
- limitshift-v2 commit 46b600f (sh trim bug + cross-shell byte-parity test): https://github.com/j-ts/limitshift-v2/commit/46b600f56be430caa161b916aa88d980b73b79ef
- limitshift-v2 commit d5c69f7 (port /usage cross-check to sh, +226/-31): https://github.com/j-ts/limitshift-v2/commit/d5c69f7b20faa8a1993aec5b24ba4990a86f8f5b
- limitshift-v2 commit 83a282d (consolidate on pwsh 7): https://github.com/j-ts/limitshift-v2/commit/83a282df6db70dad2f031696a23906c8b3d20e05
- limitshift-v2 commits 182a1d5, faa9c8d, 37f7441 (PS 5.1 vs 7, exit-code collapse, Pester 3 false green): https://github.com/j-ts/limitshift-v2/commits/main
- ai-switcher requirements files (allowed list only): /home/user/ai-switcher/launcher/ais-limits.mjs ; ais-run.mjs ; ais-state.mjs ; bin/ais ; bin/ais.cmd ; packaging/targets.mjs ; install.sh
- Claude Code 2.1.292 binary (security -i / argv switch at 4032 chars; $bunfs = Bun-compiled): /opt/claude-code/bin/claude
- GNU bash 3.2.57 source: https://ftp.gnu.org/gnu/bash/bash-3.2.57.tar.gz
- Ubuntu 24.04.5 desktop manifest (no libsecret-tools; jq 1.7.1): https://releases.ubuntu.com/24.04/ubuntu-24.04.5.1-desktop-amd64.manifest
- Ubuntu 26.04.1 desktop manifest (no libsecret-tools; jq 1.8.1): https://releases.ubuntu.com/26.04/ubuntu-26.04.1-desktop-amd64.manifest
- Ubuntu 24.04 server cloud image manifest: https://cloud-images.ubuntu.com/releases/noble/release/ubuntu-24.04-server-cloudimg-amd64.manifest
- Debian libsecret-tools (trixie): https://packages.debian.org/trixie/libsecret-tools
- Arch libsecret file list (usr/bin/secret-tool): https://archlinux.org/packages/core/x86_64/libsecret/files/
- Alpine contents search: secret-tool in libsecret (main): https://pkgs.alpinelinux.org/contents?file=secret-tool&branch=edge
- Fedora libsecret package (includes secret-tool): https://packages.fedoraproject.org/pkgs/libsecret/libsecret/fedora-rawhide.html
- HN: jq in /usr/bin on macOS Sequoia (jq-1.6-159-apple): https://news.ycombinator.com/item?id=41560170
- macOS /bin/bash 3.2.57 discussion (GPLv3 reason): https://github.com/gnydick/ai-skills/issues/37
- Claude Code issue mirror: security -i 4096-byte line buffer (#30337): https://claudeissues.com/issue/30337-bug-macos-keychain-security-i-4096-byte-line-buffer-causes-credential-corruption
- Claude Code issue mirror: security -i buffer corruption (#28541): https://claudeissues.com/issue/28541-macos-keychain-credential-corruption-security-i-4096-byte-line-buffer-causes-oau
- Apple security(1) man page (partition list commands): https://opensource.apple.com/source/Security/Security-57336.1.9/SecurityTool/security.1.auto.html
- MS Learn CREDENTIALW (CRED_MAX_CREDENTIAL_BLOB_SIZE 5*512): https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw
- MS Learn about_Execution_Policies (7.6): https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies
- MS Learn Differences between Windows PowerShell 5.1 and PowerShell 7.x: https://learn.microsoft.com/en-us/powershell/scripting/whats-new/differences-from-windows-powershell
- Git Bash/MSYS2 fork-emulation slowdown report: https://claudeissues.com/issue/80670-windows-bash-tool-degrades-severely-over-session-machine-uptime-msys2-fork-emula
- Credential-dumping via PowerShell/Credential Manager (detection context): https://feed.craftedsignal.io/briefs/2026-09-credential-dumping/
- PowerShell 7.6.6 deb (packages.microsoft.com): https://packages.microsoft.com/ubuntu/24.04/prod/pool/main/p/powershell/powershell_7.6.6-1.deb_amd64.deb
- Node SEA docs (v26.11.0 source: Stability 1.1, --build-sea v25.5.0, codesign, dlopen): https://raw.githubusercontent.com/nodejs/node/v26.11.0/doc/api/single-executable-applications.md
- Node.js v24.21.0 binaries and SHASUMS256: https://nodejs.org/dist/v24.21.0/
- Bun executables docs (targets, codesign, entitlements): https://bun.com/docs/bundler/executables
- Bun.secrets docs (experimental, 2048-4096 bytes, secret service required): https://bun.com/docs/runtime/secrets
- Deno compile docs (targets, ad-hoc signing): https://docs.deno.com/runtime/reference/cli/compile/
- Deno 2.9.7 release: https://dl.deno.land/release/v2.9.7/deno-x86_64-unknown-linux-gnu.zip
- Zig 0.17.0 download index: https://ziglang.org/download/index.json
- .NET install script: https://dot.net/v1/dotnet-install.sh
- npm registry: @napi-rs/keyring 2.1.0 (MIT), keytar 7.9.0, postject 1.0.0-alpha.6: https://registry.npmjs.org/@napi-rs/keyring
- Prototype sources (kept in scratch): /tmp/claude-0/-home-user/228bfb4e-0bd0-5413-8490-21fae890d3fa/scratchpad/lang-scripts/{proto-sh,proto-ps,proto-bun,proto-node,proto-deno,proto-py,proto-dotnet,proto-zig,proto-go}
