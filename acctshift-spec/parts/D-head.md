# acctshift: decision record

Each decision lists:
- the question;
- what was chosen;
- the options considered, with judges' scores where a judge panel ran;
- the reasons, ordered by weight, with citations to the research reports in [`research/`](research/README.md) (`R01`…`R09`, `C` = conclusion number);
- what would change the decision;
- the requirements it puts on the spec.

**Method.**
1. Nine research tracks ran separately (2026-10-07).
2. Contested questions then went to independent judge agents, each reading the reports in full:
   - three judges with different lenses for the language;
   - an adversarial refuter;
   - one judge per design question.
3. The spec (`SPEC.md`) follows these decisions. Where a decision depends on facts that still need real machines, the spec marks them **VERIFY** (§22).

---

## D1. Implementation language: **Go**

**Question:** Go, Rust, bash+PowerShell twins, one PowerShell 7 implementation, Bun/Node/Deno executables, .NET NativeAOT, Zig, or Python?

**Chosen:** Go 1.27.x, `CGO_ENABLED=0`, one static binary per target (linux/darwin/windows × amd64/arm64), built from one Linux runner with GoReleaser OSS.

**Judge scores (0–10):**

| Option | Maintainer lens | End-user lens | Technical lens |
|---|---|---|---|
| Go | 9 | 8.5 | 8.5 |
| Rust | 6 | 8 | 7.5 |
| Bun/Node/Deno | 4.5 | 4.5 | 5 |
| .NET NativeAOT | 4 | 5 | 4.5 |
| PowerShell 7 only | 3 | 2 | 2.5 |
| Python | 2.5 | 1.5 | 3 |
| bash+PowerShell twins | 1.5 | 2.5 | 1.5 |
| Zig | 1 | 4 | 3.5 |

**Adversarial refuter:** not refuted. Its overall ranking was:
1. Go
2. Rust
3. .NET NativeAOT
4. Bun
5. PowerShell 7
6. Deno
7. Node SEA
8. twins
9. Zig
10. Python

**Reasons (by weight):**
1. **Against the twin scripts.** This is decisive and comes from the owner's own history:
   - 10+ sh/ps1 parity fixes in about 4 months, with features committed twice;
   - v2 has already dropped the twin model;
   - shipped `limitshift.sh` crashes on macOS bash 3.2 [R03 C2–C4].

   Scripts also can't reach the OS stores safely:
   - `secret-tool` is missing by default, truncates at 8 KiB and still exits 0;
   - `security -i` has a 4096-byte line limit;
   - Windows needs Add-Type P/Invoke at 0.4–0.7 s [R03 C5–C7].

   PowerShell 7 alone fails the efficiency requirement (420–700 ms per call) and the "nothing to install" requirement [R03 C10].
2. **Against Rust.** Go needs one toolchain and one runner, with the fastest loop: a 0.3 s incremental build, byte-reproducible output, and all six targets with no SDK [R01 C1].

   Rust needs zig, cargo-zigbuild, cargo-xwin and about 3.6 GB in total, with 21 s incremental release builds [R02 C1, C17]. Its native macOS keychain crate cannot be linked from Linux without a macOS SDK [R02 C2]. That point does not separate the two: Go's native keychain libraries have the same problem, so both must drive `/usr/bin/security` to cross-build from Linux [R01 C8, R02 C2].
3. **Dependency churn in the credential layer.**
   - Rust: keyring 4 majors in 4 years, zbus 3 majors in 2 years.
   - Go: godbus v5 and x/sys have small, slow-moving APIs (go-keyring v0.2 likewise, though acctshift uses it only in tests). The Go 1 compatibility promise covers the language and standard library, not these modules, so this is a track record, not a guarantee; Go 1.27 itself still raised the macOS minimum [R02 C17, R01 §3.12].
4. **Byte-compatibility with agy.** agy is Go plus zalando/go-keyring, and acctshift reproduces go-keyring's encodings in its own code (go-keyring is not used at runtime, SPEC §19.2) [R01 C5, R07 C1]. The judges weighted this lower than R01 did: Rust could reproduce the formats by hand, and agy uses its file fallback in many headless contexts [R07 C2].
5. **Reviewability.** A small language with gofmt-uniform code. Rust needed 6 `unsafe` blocks in 383 lines of prototype [R02 §2.1]. Agent success on Rust repos is lower, but that is INFERRED [R02 C18].
6. **Efficiency is met with margin.** 1.8–2.0 ms per call and 3–4.7 MB [R01 C3]. Rust's 0.33 ms and 0.55–1.9 MB are invisible to users.
7. **Release coverage.** GoReleaser OSS covers every channel plus Linux-side notarization [R01 C13, R09 C15].

**Disagreements resolved:**
- **Rust cross-compilation.** R07 says impossible; R02 says possible with zig and xwin. R02 is right, so the real cost is the extra tooling.
- **Defender false positives.** Go's record is VERIFIED; Rust's is INFERRED. No side-by-side scan was run. Signing is needed for any language anyway (Smart App Control) [R09 C12].
- **`security -i` limits.** About 2 KB for Claude's hex encoding, 4096 characters for go-keyring's base64. Both are correct for their own encoding.
- **agy keychain write format.** go-keyring source says `-w go-keyring-base64:<b64>`; R07 §8 says `-X hex`. The source-derived form wins, because hex would roughly halve the writable payload.
- **Windows Ctrl+C.** R01 suggests `signal.Ignore(os.Interrupt)`. The technical judge read the Go runtime source: with Ignore, the console handler returns FALSE and the process exits. Spec review then narrowed the fix to `signal.Notify(ch, os.Interrupt, syscall.SIGTERM)` with draining on Windows (the `SetConsoleCtrlHandler(NULL, TRUE)` alternative misses Ctrl+Break and console close), and to `signal.Notify` on POSIX too, because ignored signals are inherited by the child.
- **Exit 77.** R07 uses it for "keystore locked", R08 for "all need re-login". The end-user judge required distinct codes, so the spec uses 74 for the keystore and 77 for accounts.

**What would change it:**
- Signed Go builds keep being quarantined on clean Windows 11 while signed Rust builds pass → Rust.
- No affordable Windows signing route, and unsigned Go is flagged more → Rust.
- The phase-2 ConPTY wrapper becomes the core product → Rust becomes competitive (portable-pty).
- Scope shrinks to env-only claude/codex rotation inside LimitShift → small sh + pwsh functions, with no separate app.
- macOS 12 must be supported after about Feb 2027 → reconsider (Go 1.26 covers it until then).

**Spec requirements:** §2, §4.1, §12.3–12.4, §17.1, §18.4, §19.2–19.3. The key ones:
- the no-cgo CI guard;
- `/usr/bin/security` only on macOS;
- no `SessionBus()` autolaunch and timeouts on Linux;
- resolving npm `.cmd` shims and never sending prompts through cmd.exe;
- job objects;
- `time/tzdata`;
- no `osusergo` build tag: `os/user` is used only for the claude Keychain account when `$USER` is unset, and works without cgo on macOS (SPEC §8.1, §17.1);
- VERSIONINFO, no UPX;
- Windows signing before 1.0 with a clean-VM Defender gate;
- golangci-lint with an exhaustiveness check.

---

## D2. Licence: **MIT**

**Chosen:** MIT, matching LimitShift (`Copyright (c) 2026 j-ts and acctshift contributors`).

**Reasons:**
- No restriction on commercial use, which is the owner's stated need.
- OSI-approved, which SignPath, winget and Scoop need.
- Identical to LimitShift.
- Compatible with every allowed dependency [R09 C18].

Apache-2.0 would add an explicit patent grant at the cost of NOTICE handling. It is acceptable but not needed. MPL adds copyleft the owner does not want.

**Requirements:**
- An SPDX header in every file.
- A go-licenses allowlist in CI.
- `THIRD_PARTY_NOTICES.md` generated and shipped.
- The deny list includes CC-BY-NC* (agm's licence) and any GPL/LGPL [R09 §3.2].

---
