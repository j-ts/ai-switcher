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
## D3. Integration surface: **`exec` for every launch; JSON control verbs for decisions**

**Question:** Should LimitShift (A) wrap launches with `acctshift exec`, (B) ask `acctshift env` for variables and launch the CLI itself, or (C) use both?

**Chosen:** **A.**
- LimitShift launches every acctshift-managed CLI only through `acctshift exec <cli> --account <A> --status-file <F> -- <args>`.
- Rotation decisions go through the control verbs `version`, `list`, `pick`, `next`, `mark`, `status`, `classify` and `doctor`, each with `--json`, one JSON line, and sysexits codes (64–78).
- `env` exists for standalone and diagnostic use only. Its secrets are redacted unless the user passes `--reveal-secrets`.

**Judge scores:**

| Option | Score | Note |
|---|---|---|
| A | 8.5 | |
| C | 4.5 | |
| B | 1.5 | cannot serve agy |

**Reasons (by weight):**
1. **agy needs a process that lives as long as the CLI.** The slot must be locked, swapped, run, saved back and released [R05 §h, R07 §8]. Every per-process alternative for agy is unverified [R05 C11–C12]. So `exec` must exist anyway, which removes B.
2. **Proven in LimitShift.** A single wrap point covers every launch line, `--dry-run` and `--show-raw`. The prototypes passed 7/7 scenarios under bash and 4/4 under pwsh [R08 C1, §g]. No `env` prototype exists.
3. **Smallest parity surface.** `exec` is one argv prepend per runner. `env` would force each of the three runners to apply set and unset lists to child processes. v1 ps1 uses `Start-Process`, which under 5.1 has no per-process env parameter. `env` would also mean redacting secrets in dry-run and logs everywhere: the drift pattern of R03 C2, made worse.
4. **Secrets and env hygiene in one place.** Token values go from the vault straight into the child's environment and never pass through a long-running runner. The per-CLI scrub lists (R04 C5, C6, C20) exist once.
5. **R03's argument for `env` does not carry over.** Its VERIFIED evidence was about a PowerShell-implemented acctshift (param() swallowing `-c`) and Windows PowerShell 5.1 legacy quoting. A native `acctshift.exe` is launched through LimitShift's proven native-exe path. LimitShift's own `.cmd` shim path cannot carry multi-line argv either, so acctshift's shim resolution is the actual fix.

**Requirements the judge added (now in SPEC §12.1, §12.1.1):**
- `exec --account A` never picks, rotates, retries, or parses output, and never prompts, whatever stdin is.
- stdin is inherited and never read, buffered or closed.
- Nothing is written to stdout.
- Only 125/126/127 are reserved. Every failure before the child starts exits 125 (126/127 for the binary), whatever code a control verb would use for the same condition. The reason is an `error.code` from a closed set, written to the `--status-file` (which LimitShift MUST pass) and to one stderr line `acctshift: error <code>: <message>`.
- stderr comes from a fixed message catalogue whose lines interpolate nothing (no digits, pids, paths or account names), and exec writes nothing to stderr after the child starts; post-run findings go to the status file. The catalogue ships as `version --json` `stderrCatalogue` and `testdata/stderr-catalogue.txt`, and LimitShift's own tests assert that its limit and auth regexes match none of it.
- `version`, `list`, `status`, `pick`, `doctor` without `--fix`, `classify` without `--record`, `vault status` and `notice` without `--accept` are read-only.
- Capabilities (`sessionPortable`, `usageProbe`, `lockScope`, `dataDir`) appear in `version --json` `capabilities`; `list` entries carry a per-account `usageProbe` flag.
- The Claude `/usage` cross-check is not run for any acctshift-managed claude runner: token accounts are inference-only [R04 C5, resolving R08 C7], and for the other kinds a short-lived probe can spend the refresh token [R09 C3].

**What would change it:**
- agy gets a verified per-process account mechanism (`JETSKI_OAUTH_TOKEN` or `AGY_ACCOUNT`) **and** Windows testing shows the intermediate `acctshift.exe` breaks something unfixable: hidden-console inheritance, tree-kill, shim resolution, or a Defender block. Then: `env` for claude/codex/gemini in `limitshift.ps1` on Windows only.
- acctshift becomes a script instead of a native binary.

**Risks:**
- acctshift becomes a single point of failure for managed launches. Mitigations: `LIMITSHIFT_ACCTSHIFT=off`, the startup contract check, auto mode routing a runner without explicit `accounts` only when its cli is not `experimental` and `rotationPossible` is true (except agy: while agy accounts are registered, every agy runner is routed, because an unwrapped agy would race slot swaps; SPEC §15.4), the legacy rule (when acctshift fails, only a runner without an `accounts` key under `auto` runs unwrapped, never agy while agy accounts exist; SPEC §15.2), and signing.
- New Windows shim-resolution code sits on the critical path.
- A CLI's own exit code 125–127 could look like acctshift's; `--status-file` disambiguates.
- Parallel queues can stall on the machine-wide agy lock. `slot-busy` and `agy-busy` are transient for LimitShift: it waits and retries without charging its retry budget (SPEC §15.2).

---
## D4 and D5. claude and codex account mechanisms

**Questions:**
- **claude:** (A) one `claude setup-token` token per account, injected as `CLAUDE_CODE_OAUTH_TOKEN`; (B) per-account `CLAUDE_SECURESTORAGE_CONFIG_DIR`; or (C) per-account `CLAUDE_CONFIG_DIR` with links?
- **codex:** (A) a per-account `CODEX_HOME` overlay; (B) symlinking `auth.json`; (C) swapping `auth.json` under a lock; or (D) `CODEX_ACCESS_TOKEN`?

**Chosen:**
- **claude:**
  - Default kind `token`: one setup-token per account, set as `CLAUDE_CODE_OAUTH_TOKEN`.
  - The user's existing `/login` is an untouched `native` account #0.
  - `CLAUDE_SECURESTORAGE_CONFIG_DIR` is only an opt-in experimental `login-slot`.
  - Per-account `CLAUDE_CONFIG_DIR` is not built in v1; it is the contingency.
- **codex:**
  - Default kind `home`: a per-account `CODEX_HOME` overlay that is a real directory and links **only an allowlist** of shared entries to the main home, with `CODEX_SQLITE_HOME` → main.
  - The main `~/.codex` is an untouched `native` account #0.
  - `CODEX_ACCESS_TOKEN` is an extra kind for Business/Enterprise only.
  - There is no swap mode and no symlinked-`auth.json` mode.

**Judge scores:**

| claude option | Score |
|---|---|
| A (setup-token) | 8.5 |
| native | 8 |
| B (`CLAUDE_SECURESTORAGE_CONFIG_DIR`) | 5 |
| C (`CLAUDE_CONFIG_DIR`) | 4.5 |

| codex option | Score |
|---|---|
| A (overlay home) | 9 |
| D (`CODEX_ACCESS_TOKEN`) | 5 |
| C (swap) | 2.5 |
| B (symlinked `auth.json`) | 2 |

**Reasons:**
1. **One owner per refreshable credential.**
   - Codex refresh tokens are single-use, and `auth.json` is rewritten non-atomically [R04 C13].
   - Claude clears a stored credential on `invalid_grant` [R04 §1f].
   - Prior art keeps hitting clobbering and refresh races [R09 §1.4].

   Only codex A, claude A and the native kinds keep exactly one owner.
2. **Claude A fits how LimitShift actually runs Claude.**
   - LimitShift runs headless `-p --session-id/--resume --output-format json`. The token works for all of it and writes nothing [R04 C4, C5, C8].
   - On a 401 Claude keeps the env token and never silently uses the main login [R04 §1b].
   - It is documented for scripts [R09 C6].
3. **Codex A is the only correct general mechanism.**
   - Every credential store is keyed by the canonical `CODEX_HOME` [R04 C12, R07 C7].
   - It allows parallel runs on different accounts.
   - Prior art converges on it [R09 §1.2–1.3].
4. **Codex cross-account resume should be planned as failing** [R04 C19]. With that, overlay links only serve configuration and history visibility. That is why the judge corrected R04's "link every other entry" rule into an **allowlist**: wrongly sharing an account-bound file costs more than wrongly isolating a customisation.
5. **Claude B works but has costs.** It is undocumented, has known side effects (#79222, #98526), and fails dangerously if the variable is dropped: a login would overwrite the main slot. It stays opt-in and is verified after every login.
6. **Native account #0** follows from one owner per credential. The user's interactive tools, the IDE extension and the Codex daemon keep working.
7. **Add flows** run the vendor's own login attached to the user's TTY [R09 C2]. Codex defaults to device auth (#39199).
8. **Platform limits are bounded.**
   - Windows junctions need no privilege; file symlinks need Developer Mode, otherwise copy mode.
   - Hard links are never used, because Codex's atomic rename would silently break them.
   - Since Go 1.23, `os.RemoveAll` removes a junction rather than recursing into it. This still needs a Windows CI test.

**Disagreements resolved:**
- **Codex resume after a switch** (R08 POC versus R04 C19): `sessionPortable:false` (per move `unlikely`, or `possible` between two users of one workspace); go straight to New plus handoff. Settled by V-X1.
- **Claude resume after a switch:** `likely`, with a fallback. Settled by V-C1.
- **Codex refresh rotation:** R04 VERIFIED from source, so it is treated as fact.
- **Identity after a login-slot login:** read `.claude.json` instead of spawning `claude auth status` [R09 C3].
- **Codex usage probe:** dropped (D9).
- **Codex swap fallback:** rejected. If overlays fail V-X2, the fallback is overlays without session links, never a swap.
- **`OPENAI_API_KEY`:** never touched [R04 C20].
- **`CLAUDE_CODE_SUBSCRIPTION_TYPE`:** not set, and scrubbed.

**Requirements added** (in SPEC §8.1, §8.2 and Appendix A):
- claude:
  - more variables in the scrub list: `CLAUDE_CODE_OAUTH_SCOPES`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_CUSTOM_OAUTH_URL`, `CLAUDE_CODE_SUBSCRIPTION_TYPE`, `CLAUDE_CODE_RATE_LIMIT_TIER`;
  - the native account keeps the user's `CLAUDE_SECURESTORAGE_CONFIG_DIR` (the #92252 workaround);
  - token add requires `--label`, unique among claude accounts unless `--force`, and `login` must repeat it, because a token's identity cannot be read offline;
  - native detection never reads the secret;
  - an `apiKeyHelper` that would outrank the token makes `exec` refuse.
- codex:
  - the overlay must be a real directory, and its canonical path is checked. Its directory name is the account's immutable id, so `rename` never moves it and keyring-mode keys stay valid;
  - `CODEX_REFRESH_TOKEN_URL_OVERRIDE` is unset;
  - removal is link-aware;
  - Windows copy mode never copies MCP `.credentials.json`;
  - `remove` refuses while a daemon runs;
  - the add flow lists already-registered emails, then dedupes;
  - keyring-mode identity is user-asserted;
  - `ephemeral` store mode is refused (78 `unsupported-config`);
  - no same-account stagger in v1: a pre-launch wait cannot see Codex's refresh triggers on the execve path. The race is documented instead, `refresh_token_reused` is definitive only when `auth.json` was not rewritten after the failing run started (otherwise it is transient), and V-X7 measures what Codex does.
- both: `login` compares the new credential's identity with the recorded one and exits 65 `identity-mismatch` unless `--new-identity` is given. A same-identity login clears `relogin`, `authStrikes` and auth-suspect records, and keeps limit records, `backoff`, `attentionCode` and `lastStrikeAt`. `login` on a `native` account exits 64 `native-account` with the vendor's own login command as the hint.

**What would change it:**
- Anthropic states that third-party tools may not store setup-tokens, or setup-tokens draw from different buckets or fail widely → full-login kinds become the default (C via the overlay engine, or B).
- `CLAUDE_SECURESTORAGE_CONFIG_DIR` is dropped → build C.
- V-C1 or V-X1 results → flip the portability values.
- V-X2 shows the shared links break Codex on some OS → overlays without session links there.
- An official per-run Codex credential selector appears → use it.

**Risks:**
- Claude token identity cannot be verified offline.
- Storing setup-tokens is a grey area under Anthropic's wording [R09 §3.4].
- Setup-tokens expire after a year, can be revoked silently, and some accounts get 401s.
- A link-refresh bug could damage `~/.codex`. Mitigated by link-aware removal and Windows CI.
- Same-account parallel Codex runs, or a `native` run next to the user's own codex, can race refresh rotation. The loser's `refresh_token_reused` counts as transient when `auth.json` was rewritten during the run (SPEC §9.2).
- Codex may add new account-bound files. The allowlist contains the damage.
- Seatbelt and Windows degraded sharing.
- Moving `ACCTSHIFT_HOME` orphans keyring-mode Codex credentials.
- Re-sending a whole context uncached after a switch.
- Provider terms.

---
## D6. agy account selection: **in-place slot swap**

**Question:** agy keeps one login per OS user. The options:
- (A) swap agy's native slot in place, with save-back, a journal and a whole-run lock;
- (B) force file mode and give each account its own `--gemini_dir`;
- (C) force file mode and swap only the token file;
- (D) inject `JETSKI_OAUTH_TOKEN`;
- (E) use `AGY_ACCOUNT`.

**Chosen:** **A** on every OS.
- The slot is resolved per run. On Linux it is resolved against the exact environment handed to agy, with agy's own detectors. On macOS and Windows, until V-A3 is recorded for that OS and agy version, it is the store recorded at `add agy` (default: the keychain on macOS; Credential Manager on Windows unless the blob exceeds 2560 B), and acctshift never creates a new token file on macOS.
- acctshift also writes every other slot that already holds a credential, and fails closed by deleting any it cannot write. When the resolved slot cannot take the blob, the first token-file candidate joins the write set, as agy itself falls back to its file after a failed keyring save [R05 §a].
- Each swap does an email-keyed save-back, a write-ahead journal entry naming a per-swap backup `agy/_swap/<startedAt>`, and a read-back check. The save-back is a commit point: no slot is touched until the vault write has succeeded.
- A supervising acctshift (spawn, not execve) holds the slot lock for the whole run: exclusive for a swap, and shared only for a fast-path run (the resolved slot holds a credential, every slot in the write set that holds one carries the requested email, and the slot copy is not older than the vault snapshot), once V-A8 has passed.

Spec review tightened this: a locked, unreachable or slow keyring fails closed (`agy-keyring-locked`) instead of being treated as file mode; slot writes and journal recovery happen only under the exclusive lock, after a foreign-process check by executable path that the shared fast path does not need; recovery rolls back to the per-swap backup, never to a shared "last" copy; an unregistered login in the slot stops non-interactive runs before anything is written; and `add agy` and `login agy` empty the slot under the exclusive lock with a journal, so the user never needs agy's `/logout` (SPEC §8.3, §13.3).

**Judge scores:**

| Option | Score |
|---|---|
| A | 8.5 |
| B | 4.5 |
| C | 3.5 |
| D | 1.5 |
| E | 1 |

**Reasons:**
1. **Only A is verified from source and static analysis on all three OSes.** The slot identities and encodings come from agy's binary and the go-keyring source it vendors [R07 C1, §1; R05 C2, C5–C7], and two independent MIT tools corroborate them [R09 C8]. On-device behaviour on macOS and Windows is V-A1, V-A3 and V-A5.
2. **B and C depend on unverified facts.**
   - `--gemini_dir` was only shown to move `config/mcp_config.json`, not the token or `brain/` [R05 C4].
   - Forcing file mode is verified only on Linux, by clearing `DBUS_SESSION_BUS_ADDRESS`, which would also break the agent's git and gh keyring helpers.
3. **A keeps the LimitShift contract.** No HOME or data-dir change, and transcripts stay where LimitShift reads them [R08 §a1, §d]. B would also split MCP configuration per account.
4. **A keeps one history,** so cross-account `-c` can be tested and may become portable later.
5. **Prior art does the same.** Every agy switcher swaps in place (agy has no per-profile auth root) [R09 §1.3].
6. **D and E are out.**
   - D: `JETSKI_OAUTH_TOKEN` sits on the language-server path and most likely needs a short-lived access token, which acctshift would have to mint. That is forbidden.
   - E: `AGY_ACCOUNT` is documented for plugin-connected accounts in sandboxed commands, not for the Google sign-in [R05 §c].
7. **A is fast enough.** A swap took 11 ms with read-back and flock [R07 §4]. With the fast path and models-before-accounts ordering, swaps are rare.

**Disagreements resolved:**
- **Token file path.** R05 says `~/.gemini/antigravity-cli/…`; R07 says `~/.gemini/…`. The judge leans to R05 (the CLI's own file store versus the language server's), but the spec keeps an ordered candidate list, lets an existing file win, learns the path at `add` time by diffing, and settles it with V-A2.
- **Account string `antigravity`.** Accept R07 (disassembly plus two READMEs) over R05 (unresolved).
- **Windows: file or Credential Manager.** The blob size is unmeasured; R05 C7 expects it to exceed 2560 B (VERIFY V-A4). Both stores are handled: an over-cap keyring item is deleted after a snapshot (fail closed), and the first token-file candidate joins the write set.
- **macOS `-T`.** Pass `-T /usr/bin/security` only; never add agy's binary, whose path changes on update. Never `-A`, `-T ""` or partition-list edits.
- **macOS write form.** `security -i` on stdin with the `go-keyring-base64:` prefix (R07, from source), not argv `-w <json>` (R05).
- **execve versus holding the lock.** Use the spawn path for agy, with a CLOEXEC lock fd and post-run save-back.
- **Parallel queues.** Shared lock for fast-path runs on the live account; exclusive with writer preference (one intent marker per waiting swapper) for swaps. `pick` and `next` return the live slot owner whenever it is usable, even over `--prefer`, because agy sessions are not portable. LimitShift treats `slot-busy` and `agy-busy` as transient.

**What would change it:**
- V-A9 shows `--gemini_dir` moves token, `brain/` and the conversation DB, and per-directory file mode needs no environment change. Then per-account dirs become an opt-in for parallel headless runs.
- Google ships a supported per-run account selector. Then use it.
- V-A7 shows `JETSKI_OAUTH_TOKEN` accepts a self-refreshing credential. Then reconsider D.
- macOS shows GUI prompts for `security`-written items (V-A5). Then fall back to the file slot where agy bypasses the keychain, or make macOS agy rotation attended-only.
- Google states that swapping the official CLI's own credentials breaches its terms. Then ship agy rotation disabled by default.

**Risks:**
- A wrong-account run if the mode is misjudged. Mitigated by mirrored detectors (Linux) or the add-time store (macOS, Windows), writing every slot, fail-closed deletion, refusing a locked keyring, and the post-run email check (`wrongAccount` in the status file; LimitShift re-runs the task without calling `next`).
- The user's own interactive agy shares the slot and can block swaps (`agy-busy`). Fast-path runs on the live account still proceed and report `foreignAgy`.
- agy updates may change names, encoding or detectors. Mitigated by the version-tagged facts table, `doctor` warnings and experimental gating.
- macOS 26.x keychain changes.
- Windows is the least known platform.
- Cross-account `-c` may be rejected, so `sessionPortable` stays false until V-A6.
- Provider terms.

---
## D7. acctshift's own secret storage: **envelope vault**

**Question:** Where does acctshift keep the secrets it owns: Claude setup-tokens, Copilot PATs, API keys, and parked agy snapshots? The options were:
- (A) an envelope vault: one key in the OS store plus one encrypted file;
- (B) one OS-store item per secret;
- (C) plain 0600 files, like several vendors do;
- (D) a per-OS hybrid.

**Chosen:** **A.**
- One XChaCha20-Poly1305 vault file. The OS store holds only one 32-byte key per vault, in an item named after the vault's key id and created without overwrite (so a second vault, such as a test run under another `ACCTSHIFT_HOME`, can never destroy the first one's key), from exactly one recorded key source:
  - macOS: login keychain via `/usr/bin/security`;
  - Windows: DPAPI CurrentUser;
  - Linux: Secret Service only when it is already unlocked and reachable without autolaunch;
  - everything else (Linux headless, SSH, WSL, containers, CI): a 0600 key file.
- Every keystore call is bounded and never prompts. Commands that need no secret never touch the keystore.

**Judge scores:**

| Option | Score |
|---|---|
| A | 8.5 |
| C | 4.5 |
| D | 4 |
| B | 2.5 |

**Reasons:**
1. **Unattended safety with one storage engine.** At most one bounded keystore call per process. A locked collection fails in about 18 ms [R07 C4]. The key-file source is the zero-prompt path exactly where LimitShift runs headless [R05 C3, R07 C2]. Metadata stays outside the vault, so `next`, `mark`, `status` and `list` never touch the keystore.
2. **Size limits rule out B (VERIFIED).**
   - Windows Credential Manager caps at 2560 B [R07 C6].
   - macOS `security -i` lines cap at 4096 bytes, about 2 KB of hex payload [R03 C6].
   - agy snapshot sizes are unmeasured; R05 C7 expects them to exceed 2560 B (VERIFY V-A4).
3. **Real but bounded security benefit.** Claude never writes setup-tokens to disk, so acctshift holds the only copy [R04 C4]. On macOS the vendors themselves use the keychain, so plain files would be a step down. The protection covers file-level disclosure, not same-user malware [R07 C4]. The spec states this in §7.6.
4. **Acceptable cost.** x/crypto with no cgo; an 8 ms Linux round trip [R07 C9]. Most of the keystore code is needed anyway for the agy slot.
5. **Easy migration and backup:** `vault migrate`, plus a passphrase-encrypted `vault export` [R07 §7].
6. **The vault boundary follows the prior-art lessons:** one owner per credential, so Codex and Gemini OAuth files stay vendor-owned [R09 §1.6].

**Disagreements resolved:**
- **Windows key store.** Use DPAPI only, with key-file as fallback. Credential Manager fails on network logons [R07 §5], and one code path is simpler. This settles R01 §6.5 against R07 §7.
- **macOS `-T`.** Pass `-T /usr/bin/security` explicitly. Never `-A` or `-T ""`, never partition-list edits, and never acctshift's own path, which changes on every update.
- **Exit codes.** A keystore failure is 74 for control verbs and 125 `keystore-unavailable` for `exec` (agy's own keyring: `agy-keyring-locked`, also 74 / 125). 77 stays reserved for "all accounts need re-login". This resolves R07 §7 against R08 C3.
- **Linux kernel keyring.** At most a cache for a future passphrase source; Docker's default seccomp blocks it [R07 C10].
- **Plaintext mode.** R07 listed both a "plain-file" mode and "key-file". Plain-file is dropped: there is no plaintext-vault mode.
- **Passphrase source.** Deferred to v1.x and never a default.

**What would change it:**
- macOS keychain reads fail unattended (from tmux, SSH, or after a reboot) → default to key-file on macOS.
- DPAPI fails under OpenSSH key-based logons or S4U → default to key-file on Windows.
- Secret Service providers re-lock during sessions (KeePassXC, KWallet, oo7) → default to key-file on Linux.
- agy no longer needs parked snapshots and Copilot accounts use the `gh` kind (no stored token) → the vault would hold only small tokens. Even then, A with key-file stays preferable to plaintext.
- Protection against same-user malware becomes a requirement → this needs an agent design with no persistent key, which conflicts with unattended runs.

**Risks:**
- Losing the key loses the vault. Mitigated by export, clear errors, and never overwriting an unreadable vault.
- A keystore that locks mid-run stops rotation: `exec` exits 125 `keystore-unavailable`. LimitShift then runs the CLI unwrapped for that one step only under its legacy rule (a runner without an `accounts` key under `auto`, never agy while agy accounts exist), and otherwise marks the task needs-human. It never switches a runner to legacy mode for the rest of the run, and calls `pick` again before the next run (SPEC §15.2). A `doctor` check at queue start warns while the user is still present.
- Users may read "encrypted" as "malware-proof". The threat-model statement addresses this.
- Untested key-source paths rot. CI covers each source on its OS.

---
## D8 and D9. Rotation order, selection, and where limit knowledge comes from

**Question:**
- What order should rotation follow?
- How does acctshift pick the next account?
- How are limits represented and merged?
- What must acctshift never do?

**Chosen:**

- **acctshift stays passive** and imposes no order on models or CLIs. It only answers "which account of this CLI".
- **LimitShift's default order** (judge score 9, versus 7 for the earlier draft):
  1. Models inside the account. These are skipped when acctshift classifies the limit as account-wide.
  2. Accounts of the same CLI. Model index resets to 0. The session is resumed only if `sessionPortable`.
  3. Other CLIs, with a fresh session and the handoff note.
  4. Wait for the soonest reset across CLIs × accounts.
- **Selection:** sticky preference order over **usable** accounts: enabled, no `relogin` or `attentionCode`, not past `expiresAt`, and no active record that blocks the requested model. The displayed state is never used for selection.
  - `pick` returns `--prefer` if it is in the pool and usable. Otherwise it ignores it (`preferIgnored:true`, never an error) and returns the first usable account in order.
  - `next` returns the first usable account other than `--from`, in order.
  - agy: `pick` and `next` return the live slot owner whenever it is a usable candidate, since agy sessions are not portable.
  - When no candidate is usable but some are time-limited, return the soonest-free account with exit 75, even when it is `--from`. A one-account pool therefore gives 75 naming that account, or 77 when it needs a human.
- **Limit records** are kept per (cli, account, scope), where scope is `account` or `model:<bucket>`, and have a kind, `limit` or `auth-suspect`. Unknown scope is `account`, and a model that maps to no bucket is blocked by every model record.
- **Merging** is by evidence tier. The tier describes the source of the reset value, not of the detection:

  | Tier | Source of the reset |
  |---|---|
  | 4 | user override (`mark --override`) |
  | 3 | structured vendor data from the failing run |
  | 2 | text, or the caller's parsed value |
  | 1 | none: default backoff, auth-suspect, or a detector without a reset time |

  A higher tier replaces; a lower tier replaces only when its reset is later, so it can only lengthen a limit. Equal tiers observed less than 10 minutes apart keep the later reset; otherwise the newer observation wins. A caller value earlier than now + the minimum cooldown counts as an unknown reset (tier 1). A tier-4 record is replaced only by another override and removed only by `mark --clear`.
- **Bounds:** minimum cooldown 60 s; 32-day clamp, also applied at read time to records written while the clock was wrong.
- **Backoff:** unknown resets back off 30 → 300 minutes; early re-hits back off 5 → 60 minutes. The backoff memory is kept per scope, apart from the records, until 24 h after the later of the scope's last hit and its record's end, so pruning an expired record does not reset it, even for a weekly record.
- **States** (a display summary, recomputed on every read):
  - `ready`;
  - `limited`, with reason limit or auth-suspect;
  - `needs-relogin` (sticky: a stored `relogin` reason, or past `expiresAt`);
  - `needs-attention` (sticky, for provider blocks);
  - `disabled`.
- **Success** is reported only by `mark --ok`, which LimitShift calls after every successful run. It clears strikes, backoff and auth-suspect records. `exec` never reports success.
- **Parsing:** one Go parser serves `classify`, `next`/`mark --evidence-file` and the phase-2 `run`. It runs before `state.lock` is taken.
- **Never:** a proxy, network usage calls, spawning vendor CLIs to probe, or selecting by utilization.

**Option scores:**

| Option | Score |
|---|---|
| Scope-aware models-first with sticky preference order (chosen) | 9 |
| Report 08 / earlier draft (per-account records, cyclic `next`) | 7 |
| Accounts-first | 5 |
| Headroom-first | 3.5 |
| Live interception in phase-1 `exec` | 3 |
| Round-robin | 2.5 |
| Active probing | 0.5 |

**Reasons:**
1. **Passivity is required.**
   - Provider terms forbid intermediating credentials.
   - `/api/oauth/usage` returns a persistent 429 (#30930).
   - Short-lived Claude commands burn refresh tokens (#95822) [R09 C2, C3, §1.6].
   - So limits come only from the caller, captured output and local vendor files. An idle account's headroom cannot be known, which rules out selecting by headroom.
2. **The order is proven.** Models → accounts → CLI → wait was proven in LimitShift's prototypes [R08 C2].
   - Every switch has a cost: Codex sessions are unlikely to survive a switch [R04 C19], prompt caches go cold, and an agy switch means a slot swap.
   - Claude's 5-hour window is shared by all models [R04 §1e], and the owner's `limitBuckets` say the same. Rotating models after an account-wide limit is therefore wasted, so that step is skipped.
3. **Model-scoped limits are real**, and VERIFIED:
   - Claude: `seven_day_opus` / `seven_day_sonnet`, "Opus limit";
   - Codex: "usage limit for {limit_name}";
   - Copilot: `user_model_rate_limited`.

   With per-account records only, an Opus-only weekly cap would block Sonnet runners on that account for days.
4. **One parser with evidence tiers.**
   - The judge's read-only regex check found that LimitShift's parser misses Claude `resets Oct 9, 3pm (TZ)` and Codex `Try again at Oct 9th, 2026 3:45 PM`.
   - It turns Copilot `resets in ~3600s` into "now", which is a hot loop [R04 §5, R06 C14].
   - Tiers let structured data correct bogus text values. The cooldown and backoff stop hot loops.
5. **Sticky preference order.**
   - It honours the owner's ranking.
   - It keeps `pick` and `next` consistent.
   - It gives the same throughput as cyclic order with fewer switches.
   - Utilization is unreliable: Codex `used_percent` is not a signal [R03 §9], and agy quota numbers are untrusted [R09 C8].
   - Claude's `rate_limit_event` appears only in stream-json, while LimitShift uses `--output-format json`.
6. **Auth handling.**
   - Rotate away at once.
   - Mark sticky `needs-relogin` only on definitive evidence, or when an ambiguous strike comes from a run that started after the account's previous auth-suspect record expired. A first strike, and strikes while an auth-suspect record is active, only give a 15-minute auth-suspect record.
   - Strikes on two or more accounts of one CLI within that window are a provider incident: nothing escalates, and all of them back off.
   - Codex `refresh_token_reused` is definitive only when `auth.json` was not rewritten during the run; otherwise it is a lost refresh race and counts as transient.
   - Provider blocks are a separate sticky state, because re-login does not fix them [R08, R09 §1.6].
7. **Concurrency.** Writers use OS advisory locks plus atomic rename; readers are lock-free [R01 C10–C11, R07 C9].
8. **Phase split.** Phase-1 `exec` stays transparent (execve, no stdout) [R08 §d]. Live interception belongs to the phase-2 `run`.

**Disagreements resolved:**
- **Codex `sessionPortable`:** false. R04 C19 outweighs R08 C9.
- **The Codex app-server usage probe** suggested in R04 C18: dropped in every phase (R09).
- **agy swap verification:** read the token's `email` field locally. Never run `agy -p /usage`.
- **Claude `/usage` cross-check:** LimitShift must not run it for managed claude runners. acctshift never runs it.
- **Headroom:** record and display it only.
- **Scope:** per (cli, account, scope), with `account` as the default. This stays compatible with R08's calls.
- **Locks:** flock / LockFileEx rather than R03's lock directory. acctshift is the only writer.
- **The earlier draft's four departures from the evidence were corrected:**
  - per-account-only records;
  - cyclic `next`;
  - a merge that could only ever lengthen a limit;
  - "exec exit 0 resets auth", which is impossible under execve.

**What would change it:**
- Real captures show utilization matches the provider's figure without probing → add headroom as an opt-in tie-break.
- The owner's queues mostly hit account-wide limits, or model quality matters more → offer accounts-first as a default. Per-scope records already support it.
- Codex and agy resume reliably across accounts → accounts-first becomes more attractive.
- agy gets a per-run account selector → drop slot affinity.
- flock proves unreliable on the owner's setups (WSL `/mnt/c`, network homes) → switch to lock directories.
- Providers treat automatic rotation as a violation → manual rotation by default.

**Risks:**
- Vendors rename limit types or texts, which misclassifies scope. Unknown scope defaults to `account`, and real fixtures guard against drift.
- Output formats drift, so resets fall back to lower tiers.
- Preference order drains account #1 first. This is documented.
- Clock skew. Mitigated by the read-time clamp; timestamps in the future are ignored for the strike and backoff windows.
- WSL / network filesystems.
- `exec` never reports success on any OS, so LimitShift must call `mark --ok` after every successful run. Without it, strikes are forgotten only 24 h after the last strike, and backoff only 24 h after the later of the last hit and the end of its record.
- Token spend spikes after a switch (cold caches).
- Provider terms.

---
## D10. Distribution, trust and updates

**Chosen** (from research track 09 and the end-user language judge):
- **Repository:** public `j-ts/acctshift`.
- **Releases:** GitHub immutable releases, each with `SHA256SUMS`, a cosign v3 keyless bundle, `actions/attest@v4` provenance and SBOMs.
- **Install:** `install.sh` (POSIX sh) and `install.ps1` (5.1-compatible, `-UseBasicParsing`) install into user directories, with no admin rights.
- **Package channels:** a Homebrew tap (source-build formula), a Scoop bucket and winget, phased in from v0.2.
- **Self-update:** only for script installs, verified by an Ed25519 signature over `SHA256SUMS` against keys embedded in the binary. Update checks are opt-in. No telemetry.
- **macOS:** no notarization for curl installs (curl sets no quarantine flag). Notarization is optional before 1.0.
- **Windows:** Authenticode signing is **required before 1.0**, and a clean-VM Defender / Smart App Control check gates every release.

**Reasons:**
- Smart App Control blocks unknown unsigned binaries regardless of how they were downloaded [R09 C12].
- curl installs avoid Gatekeeper [R09 C10].
- Attestations need a public repository [R09 C14].
- GoReleaser OSS covers every channel except npm, which is not needed [R01 C13, R09 C15].

**Signing route for an individual outside the US/Canada:** SignPath Foundation first (free for open-source software; its "circumvent security measures" clause must be checked), then Certum Open Source, then an OV certificate [R09 C13].

---
