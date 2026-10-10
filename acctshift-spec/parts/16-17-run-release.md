## 16. Phase 2: interactive `run` wrapper

Purpose: give people (not LimitShift) the "keep going on another account" behaviour in an interactive terminal session, replacing ai-switcher's `ais run`.

`acctshift run <cli> [--account A] [--pool a,b] [--slot-wait S] [--wait] -- <args…>` (flags: §10.4):
- **Exit codes as for `exec`** (§12.1.1): every failure before a child starts exits 125, with one stderr line `acctshift: error <code>: <catalogue message>` and a code from the closed set; 126 and 127 cover the binary; otherwise `run` returns the last child's status (128+n for a signal death). It never exits 64–78 or 75 for its own failures.
- **Never prompts before launch.** Pre-launch credential handling takes the non-interactive branch, as in `exec` (for example 125 `agy-slot-unregistered`, §8.3.3 B.5). The only question `run` may ask is the one in step 6.
- `run` is a writer: it records limits as `next` does (§6.3).

1. `pick` an account, or use `--account A` under the state table of §12.1. Launch the cli with the terminal inherited (no PTY), using the spawn path of §12.3/§12.4, with these differences on POSIX:
   - the child is started with `Setpgid: true`, in its own process group, so stopping it never signals acctshift or the caller's shell job (§12.3's same-group rule is for `exec` only);
   - if stdin is a TTY and acctshift owns the foreground group, acctshift calls `tcsetpgrp(ttyfd, childPgid)` right after start, with SIGTTOU blocked, and makes its own group the foreground again after the child exits or stops;
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
6. If the child exits normally but its log showed a limit in its last second, `run` MAY ask whether to switch and resume, only when stdin is a TTY and `ACCTSHIFT_NONINTERACTIVE` is not `1`. Otherwise it returns the child's exit status.

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
- **Test-only code:** test keystore overrides (`ACCTSHIFT_TEST_KEYCHAIN`, the fake keystore) and test hooks (for example the artificial evidence-parse delay of §18.2) are compiled only under the `acctshift_test` build tag. Release builds ignore them unconditionally, and CI asserts that the release binaries do not contain these strings.
- `import _ "time/tzdata"`.
- **No `osusergo` tag.** When `$USER` is unset, the claude slot derivation reads the user name with `os/user.Current()` (§8.1). Without cgo, that calls `getpwuid_r` through libSystem on macOS. Release builds MUST NOT use the `osusergo` build tag, whose pure-Go fallback only parses `/etc/passwd` and misses directory-service users on macOS.
- **Windows resources:** VERSIONINFO and a manifest (`asInvoker`, `longPathAware`) via goversioninfo (MIT), which helps reputation scoring.
- **Never** UPX or garble [R01 C12].

### 17.2 Targets and artifacts

Targets: `linux_amd64`, `linux_arm64`, `darwin_amd64`, `darwin_arm64`, `windows_amd64`, `windows_arm64`. All are built on **one** `ubuntu-latest` runner with **GoReleaser OSS v2.18+** [R01 C13, R09 C15].

Each release publishes:
- `acctshift_<ver>_<os>_<arch>.tar.gz` (`.zip` for Windows), each containing the binary, `LICENSE`, `THIRD_PARTY_NOTICES.md` and `README.md`;
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
| winget `j-ts.acctshift` | v0.3 (M3) | zip with a nested portable installer (schema 1.12.0) [R09 C17] |
| AUR `acctshift-bin`; `.deb` / `.rpm` / `.apk` via nfpm | v0.3 (M3) | optional |
| npm | not planned | GoReleaser's npm publisher is Pro-only, and there is no benefit for this tool |

### 17.6 Installer scripts

`install.sh` (POSIX sh: runs under dash and bash 3.2) and `install.ps1` (Windows PowerShell 5.1 and pwsh 7):
- No admin rights. Default install dir: `~/.local/bin` on Unix; `%LOCALAPPDATA%\Programs\acctshift` on Windows (outside acctshift's root), added to the **user** PATH as a raw registry value.
  - `ACCTSHIFT_INSTALL_DIR` overrides the location.
  - **Unix PATH:** if the install dir is not on PATH, append one idempotent, marked line to the login-shell rc chosen from `$SHELL` (zsh → `~/.zprofile`; bash → `~/.bash_profile` on macOS, `~/.bashrc` on Linux; fish → `fish_add_path`), and print what was changed. `~/.local/bin` is not on PATH by default on macOS.
  - `ACCTSHIFT_NO_MODIFY_PATH=1` opts out of the PATH change.
- Knobs:
  - `ACCTSHIFT_VERSION` (pin; LimitShift always pins);
  - `ACCTSHIFT_NO_INSTALL_RECEIPT=1`: skip the `self-update --record-install` call at the end, so no `install.json` is written. A copy installed this way is not self-updated; its owner updates it. LimitShift's helper sets it, together with `ACCTSHIFT_INSTALL_DIR=<limitshift>/bin`, `ACCTSHIFT_NO_MODIFY_PATH=1` and `ACCTSHIFT_VERSION=<pin>`, so a bundled copy never changes the user's PATH and never takes over the receipt of a user's own install (§15.9);
  - `ACCTSHIFT_ARCHIVE` (local path or URL); when it is set, `ACCTSHIFT_SHA256` (the expected archive hash) is required;
  - `ACCTSHIFT_REPO`;
  - `ACCTSHIFT_GITHUB_TOKEN`, for a private repository only. Tokens are used **only** when this variable is set explicitly; `GITHUB_TOKEN`, `GH_TOKEN` and `gh` are never read. The token is sent only to `https://github.com` and `https://api.github.com`, never to an `ACCTSHIFT_ARCHIVE` host or a redirect target, and is passed to curl or wget through stdin (`curl -H @-` or `--config -`) or a 0600 temp file, never in argv. `install.ps1` passes it with `-Headers` in-process.
- **Downloader:** `curl`, else `wget` (Alpine has busybox wget but no curl).
- **Architecture detection:**
  - Unix: `uname -s` / `uname -m`. On Darwin, use arm64 when `sysctl -n sysctl.proc_translated` prints 1 (a Rosetta shell reports `x86_64`).
  - Windows: the native architecture from `IsWow64Process2` or the `PROCESSOR_ARCHITECTURE` value under `HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`, then `[RuntimeInformation]::OSArchitecture`, then `PROCESSOR_ARCHITEW6432` / `PROCESSOR_ARCHITECTURE`, choosing native arm64. An emulated x64 PowerShell on ARM64 reports x64 through the later sources.
- **Verification** before unpacking:
  - verify `SHA256SUMS` (`sha256sum`, `shasum -a 256`, or `Get-FileHash`);
  - when `cosign` is present: `cosign verify-blob --bundle SHA256SUMS.sigstore.json --certificate-identity-regexp '^https://github.com/j-ts/acctshift/\.github/workflows/release\.yml@refs/tags/v' --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS`;
  - `SHA256SUMS` comes from the same place as the archive, so on its own it only detects corruption. LimitShift's helper therefore embeds its own expected hashes (§15.9).
- macOS: `xattr -dr com.apple.quarantine` defensively.
- **Replacing a binary.** `install.sh` extracts into a temporary directory on the same filesystem as the target, runs `chmod 0755`, then `mv -f` (a rename) over the destination. It never copies, cats or untars over an existing binary in place: on Apple silicon that invalidates the kernel's cached code signature and the next launch dies with "Killed: 9". `install.ps1` renames a running exe to `.old` and then uses `Move-Item`. A macOS arm64 CI test installs vN, runs it, upgrades to vN+1 with `install.sh`, runs it again, and requires an exit status other than 137.
- `install.ps1` always uses `-UseBasicParsing` (the KB5074596 prompt) [R09 C12] and clears `PSModulePath` for Windows PowerShell child calls (the ai-switcher lesson about pwsh 7 leaking into 5.1).
- **The installers never create or write acctshift's root.** After verification they run `"<bin>/acctshift" self-update --record-install script --path <bin>` (skipped when `ACCTSHIFT_NO_INSTALL_RECEIPT=1`), so only acctshift creates the root (0700, protected DACL on Windows, §6.1) and writes `install.json` (0600) = `{"method":"script","version":"…","path":"…","installedAt":"…"}`.

### 17.7 Self-update

- `acctshift self-update --record-install script --path DIR` is what the installers call after verifying a download. It makes no network call: it creates the root if needed (§6.1) and writes `install.json`.
- `acctshift self-update [--check] [--version X] [--allow-downgrade]` works only when `install.json` says `method:"script"` and its `path` matches the running binary. Here `--version X` is this command's value flag; the global `--version` applies only without a command (§10.4). For package-manager installs it prints the right command (`brew upgrade`, `scoop update`, `winget upgrade`). Without a matching receipt (for example a LimitShift-bundled copy), it changes nothing and says that the copy is updated by whatever installed it.
- **Source:** the hard-coded `https://github.com/j-ts/acctshift/releases/{latest|download/vX}/…`. No API calls, so the unauthenticated rate limit does not apply.
- **Verify:**
  1. the Ed25519 signature over `SHA256SUMS` against 1–2 public keys embedded in the binary (current and next, for rotation);
  2. the archive hash;
  3. the target version is parsed from the archive file name listed in the **signed** `SHA256SUMS` (`acctshift_<ver>_<os>_<arch>…`), never from the `latest` redirect or the URL. It must be greater than the running version unless `--allow-downgrade`.
  
  The signing key lives in a GitHub Environment secret with required reviewers.
- **Extract safely:** write only the single expected binary entry, reject any other path, and never follow symlinks in the archive.
- **Replace atomically:** the target is `os.Executable()`, and it must match `install.json`'s `path`.
  - Unix: write next to the binary, then fsync, chmod and rename (never overwrite in place, see §17.6);
  - Windows: rename the running exe to `.old`, move the new exe in, and delete `.old` on the next start.
- **Never** update while `agy-slot.lock` is held, or during `exec` / `run`.
- Update checks are **off by default**. `settings.updateCheck: "daily"` enables a check that runs only inside an interactive **writer** command (§11.1 rule 8), at most once a day: when `state.updateCheckedAt` is more than 24 h old, the command checks and then writes `updateCheckedAt` under `state.lock` (§6.3). Read-only commands, `exec`, `run` and non-interactive invocations (§7.5) never check. `ACCTSHIFT_NO_UPDATE_CHECK=1` forces checks off. A check only reports; it never updates. No telemetry.

---
