# Research track: prior-art-distribution

_Research date: 2026-10-07. Claims are marked VERIFIED (evidence gathered during the research) or INFERRED._

## Summary

PRIOR ART: There are already many multi-account switchers for these CLIs (I found 557 GitHub repos for Claude switchers and 685 for Codex). The permissively licensed ones I reviewed fall into six mechanisms: (A) swap the credential in place in the vendor's own slot (claude-swap, codex-auth, agy-tools); (B) a separate config home per account (aisw/CODEX_HOME, clausona, codex-accounts); (C) inject an env token per run (no notable tool relies on it, though Anthropic documents CLAUDE_CODE_OAUTH_TOKEN and GitHub documents COPILOT_GITHUB_TOKEN); (D) a wrapper that relaunches with --resume after a limit (cux, GPL so ideas only); (E) a local proxy that rotates bearer tokens (codex-multi-auth, CLIProxyAPI); (F) a shared config dir with a separate secure-storage location per account (CLAUDE_SECURESTORAGE_CONFIG_DIR). The problems users report again and again are refresh-token rotation and clobbering of copied credentials, vendor logout revoking tokens, macOS Keychain ACL resets and prompt loops, mismatched oauthAccount identity in a shared ~/.claude.json, and races between concurrent refreshes. In February 2026 Google banned accounts that used third-party harnesses on Antigravity OAuth, and Anthropic now forbids routing or intermediating subscription credentials. So accshift should never be a proxy, never call provider APIs with stored tokens, and keep exactly one owner per refreshable credential. The design hypothesis (env token for claude, per-account CODEX_HOME, locked single-slot swap for agy, plus native /user switch or COPILOT_GITHUB_TOKEN for copilot) matches the safest prior-art patterns. DISTRIBUTION: Ship static binaries on GitHub immutable releases for darwin/linux/windows x amd64/arm64, with SHA256SUMS, a cosign keyless bundle and actions/attest@v4 provenance (needs a public repo), plus an embedded Ed25519 key used to verify self-updates. Use GoReleaser v2.18 for Go; for Rust use dist 0.33, or GoReleaser's rust builder. I confirmed that Go cross-compiled from Linux ad-hoc-signs darwin/arm64 automatically. macOS needs no notarization for curl/tar installs, because curl sets no quarantine flag. Windows: irm-based installs carry no Mark of the Web, but Smart App Control in enforcement mode blocks unsigned unknown binaries whatever the source. Plan code signing (SignPath Foundation, Certum OSS or OV; Azure Artifact Signing only for US/Canada individuals) before 1.0. LICENSING: MIT, matching limitshift. Enforce an allowlist with go-licenses or cargo-deny, follow a documented clean-room and provenance process with CI guards, and add an honest README notice. That notice must say plainly that OpenAI's terms prohibit circumventing rate limits, Anthropic ties subscription limits to ordinary individual use, Google forbids third-party software accessing Antigravity, and GitHub allows one free account per person.

## Conclusions

| # | Claim | Status | Confidence | Evidence | What the spec should do |
|---|---|---|---|---|---|
| 1 | Prior art falls into six mechanisms: (A) swap the vendor's own credential slot in place, (B) a config home per account, (C) inject an env token per run, (D) a wrapper that relaunches with --resume, (E) a local proxy that rotates bearer tokens, (F) a shared config with secure storage per account. The safest are (B) and (C), because each refreshable credential has exactly one owner. | VERIFIED | high | READMEs of realiti4/claude-swap (MIT), burakdede/aisw (MIT), omarhoumz/codex-accounts (MIT), larcane97/clausona (MIT), inulute/cux (GPL-3.0), ndycode/codex-multi-auth (MIT), agy-tools and agy-cli-manager (MIT). Claude Code docs say 'Log in with multiple accounts' via CLAUDE_CONFIG_DIR. codex-accounts says: 'a copy-based swapper leaves the saved copy holding a token that has since been rotated away'. | Use env token per run for claude (CLAUDE_CODE_OAUTH_TOKEN) and copilot (COPILOT_GITHUB_TOKEN), and a per-account CODEX_HOME for codex. Swap a slot under a lock only for agy. Never copy refreshable OAuth credentials into two places that both refresh. |
| 2 | Local proxies that rotate subscription tokens (CLIProxyAPI ~54k stars, codex-multi-auth, Muriel-Gasparini's Antigravity switcher) are the exact pattern providers prohibit. Polling private usage endpoints with stored tokens is fragile and also counts as intermediating. | VERIFIED | high | Claude Code legal page: 'developers may not collect, store, or intermediate Claude.ai credentials or session tokens'. Antigravity ToS: 'Using third party software, tools, or services to access the Service ... is a breach'. Claude issue #30930: /api/oauth/usage returns a persistent 429. | accshift makes no network calls to providers, has no proxy mode and no usage polling. Limit detection is passive: CLI output and exit codes, or --limited-until supplied by limitshift. |
| 3 | Short-lived Claude Code commands such as 'claude auth status' can spend the refresh token: they start a refresh and exit before saving it. | VERIFIED | high | anthropics/claude-code#95822 (v2.1.277, macOS): 'Process exits prematurely... The Keychain retains the old spent token. Next refresh gets invalid_grant'. | status and doctor must never spawn the vendor CLI to probe an account. They report from accshift's own records, plus a local token-expiry check where the token format allows. |
| 4 | On macOS, rewriting Keychain items drops their ACLs: 'security add-generic-password -U' without -T trusts only the writing process, and Claude's own refresh resets the ACL too, which causes prompt loops. | VERIFIED | high | claude-code#94491 and #96385. claude-swap#279: 'omitting -T on a write does not mean leave the existing ACL alone, it means trust only the process performing this write'. | When swapping the agy keychain slot (or any vendor item), pass explicit -T entries for /usr/bin/security and the vendor binary path, or verify the ACL after writing. Use /usr/bin/security (Apple-signed, stable identity) for accshift's own keychain items. |
| 5 | Setting CLAUDE_CONFIG_DIR explicitly, even to the default path, selects a different hash-suffixed Keychain entry. A cached oauthAccount in the shared ~/.claude.json makes /status show the wrong identity. | VERIFIED | high | claude-code#92252 (v2.1.261; workaround CLAUDE_SECURESTORAGE_CONFIG_DIR=""), #79222 (v2.1.215), #98526 (skills-sync churn; workaround --settings '{"syncClaudeAiSkills":false}'). | Never export CLAUDE_CONFIG_DIR unless the user configured it. Report the active identity from accshift's own record. Document the cosmetic /status mismatch. Consider passing syncClaudeAiSkills:false when using the backup plan (F). |
| 6 | Claude auth precedence puts ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY and apiKeyHelper above CLAUDE_CODE_OAUTH_TOKEN. A setup-token token is a one-year token that can only make model requests, and bare mode ignores it. | VERIFIED | high | code.claude.com/docs/en/authentication: precedence list; 'generate a one-year OAuth token'; 'It can only make model requests, so it can't establish Remote Control sessions or fetch claude.ai connectors'; 'Bare mode does not read CLAUDE_CODE_OAUTH_TOKEN'. | accshift exec claude: unset ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN, warn on apiKeyHelper and ANTHROPIC_PROFILE, refuse or warn on --bare, record the token's creation date and warn before one-year expiry. Note the loss of connectors and Remote Control. |
| 7 | Codex refresh tokens rotate. Saved auth.json snapshots go stale, and a new sign-in, or two ChatGPT accounts signed in on the web in one browser, can invalidate a login. | INFERRED | medium | openai/codex#39199 (body fetched), #40541, #40267, #48507 (titles). codex-auth#86: 'Your access token could not be refreshed because you have since logged out or signed in to another account'. codex-accounts README (third-party) claims that each login invalidates the previous refresh token server-side. | Each codex account lives in its own CODEX_HOME, created by running 'CODEX_HOME=<dir> codex login --device-auth' (or a private browser window). Never copy auth.json afterwards, never run codex logout, and map that error string to the account state needs_relogin. |
| 8 | agy keeps one credential slot (Keychain or Secret Service service 'gemini', account 'antigravity') with no per-profile auth root. A running agy must restart to pick up a swapped token, and its quota endpoints are unreliable. | INFERRED | medium | Two independent MIT READMEs (tnduyh5/agy-tools on macOS, zcop/agy-cli-manager on Linux) give the same service and account names. aisw: 'no documented per-profile auth root'. agy-tools removed its quota display because 'the number could not be trusted'. The quota log line is 'RESOURCE_EXHAUSTED (code 429): Individual quota reached'. | agy swap = lock, snapshot outgoing (plus a _last backup), atomic write, never while an agy process is running. Detect limits from agy output and logs only. The agy track must verify the service names on real machines. |
| 9 | Copilot CLI already supports several accounts natively (/user list, /user switch) and takes a per-run token via COPILOT_GITHUB_TOKEN, which outranks GH_TOKEN and GITHUB_TOKEN. Classic ghp_ PATs are not supported. | VERIFIED | high | docs.github.com Copilot CLI authentication page: keychain service 'copilot-cli', plaintext fallback ~/.copilot/config.json, fine-grained PAT needs the 'Copilot Requests' permission. | The copilot adapter stores a fine-grained PAT per account and injects COPILOT_GITHUB_TOKEN. It never touches the copilot-cli keychain item. The notice must point out GitHub's one-free-account rule. |
| 10 | curl- and script-based installs need no macOS notarization, because curl never sets the quarantine attribute and Gatekeeper only checks quarantined files. | VERIFIED | high | Apple DTS, forum thread 706273: 'When you use curl, there are no checks being done at all. Gatekeeper works by having the web browser attach a quarantine flag'. | v0.x ships without notarization. install.sh strips com.apple.quarantine defensively, and the README documents xattr for browser downloads. A Developer ID certificate is optional and mainly gives a stable keychain designated requirement. |
| 11 | Go cross-compiling from Linux automatically adds an ad-hoc, linker-signed code signature to darwin/arm64 binaries, which is the arm64 signing requirement. | VERIFIED | high | Ran go1.24.7 with CGO_ENABLED=0 GOOS=darwin GOARCH=arm64. llvm-objdump shows LC_CODE_SIGNATURE; parsed CodeDirectory flags are 0x20002 (adhoc=True, linker-signed=True). darwin/amd64 has no signature. | With Go, all six targets can be built on one Linux runner. With Rust, build darwin on macOS runners or verify the signature with codesign -dv in CI. |
| 12 | On Windows, irm/Invoke-WebRequest downloads carry no Mark of the Web and launching from a terminal skips SmartScreen. Smart App Control in enforcement mode still blocks unknown unsigned code, whatever the Mark of the Web says. | VERIFIED | high | textslashplain.com MOTW article (updated 2026-09-01): PowerShell and curl do not set MOTW; 'MotW files invoked by non-shell means... do not trigger security checks'. MS Learn Smart App Control (2026-09-30): 'unknown, unsigned code are blocked by default' unless signed by a Trusted Root Program CA. biome#12126 shows a real block. | Document the Smart App Control caveat. Get Windows code signing before 1.0. install.ps1 always uses -UseBasicParsing (KB5074596 prompt in PowerShell 5.1). |
| 13 | Windows signing options for an individual: Azure Artifact Signing (~$9.99/mo, individuals in the US/Canada only), SignPath Foundation (free for OSI-licensed OSS, publisher shown as SignPath Foundation, excludes tools 'designed to circumvent security measures'), OV certificates ($150-300/yr) and the Certum OSS certificate. EV no longer bypasses SmartScreen. | VERIFIED | high | MS Learn code-signing options page (2026-08-29) and signpath.org/terms. Certum price is from a secondary source (inferred). | Plan: apply to SignPath first. Fall back to the Certum OSS certificate, or Azure if the user is eligible. Keep one stable signing identity so reputation builds. Add a Windows version resource and do not pack with UPX. |
| 14 | Release integrity stack for 2026: GitHub immutable releases (GA since 2025-10-28; verify with gh release verify / verify-asset), actions/attest@v4 build provenance (public repos on all plans; private repos need Enterprise Cloud; SLSA Build L2), cosign v3 keyless .sigstore.json bundles over SHA256SUMS, and SBOMs. | VERIFIED | high | docs.github.com attestation and release-integrity pages; GoReleaser cosign-v3 blog; GoReleaser install page showing the cosign verify-blob and gh attestation verify commands. | Make the accshift repo public. The release workflow needs id-token: write and attestations: write. Publish SHA256SUMS, SHA256SUMS.sigstore.json, SHA256SUMS.sig (Ed25519, for self-update) and SBOMs, with verification commands in the README. |
| 15 | GoReleaser OSS v2.18.x covers most packaging for a Go CLI: archives, checksums, cosign, SBOM, homebrew_casks (brews formulas deprecated since v2.10/v2.16), scoops, winget PRs, AUR -bin, nfpm, cross-platform macOS notarization through quill, and Rust via builder: rust. dist 0.33 is the Rust-native alternative (shell, ps1, homebrew, msi, npm installers, updater, Azure signing for x86_64 Windows). | VERIFIED | high | goreleaser.com deprecations, notarize, aur, winget and rust pages; GoReleaser install page lists v2.18.2; dist release 0.33.0 (2026-09-10) and config reference. | Pick GoReleaser if the language is Go. If Rust, use dist or GoReleaser's rust builder. Do not hand-roll CI. |
| 16 | Homebrew 6 (June 2026) requires explicit tap trust (brew trust <user>/<tap>; HOMEBREW_REQUIRE_TAP_TRUST on by default). Official homebrew/cask disables casks that fail Gatekeeper from Sept 2026 and deprecated --no-quarantine. Third-party taps are not subject to the Gatekeeper check. | VERIFIED | medium | brew.sh Homebrew 5.0.0 and 6.0.0 posts (fetched); the brew trust syntax comes from secondary summaries of the release notes. | Ship an own tap, j-ts/homebrew-tap. Prefer a source-build Go formula (no quarantine issue), or a cask with a postflight xattr hook. The README install line includes 'brew trust j-ts/tap'. |
| 17 | winget accepts unsigned portable CLIs as a zip with a nested portable installer (schema 1.12.0, PortableCommandAlias, arm64 supported), provided InstallerUrl is the publisher's own release location. Scoop needs only a bucket manifest. | VERIFIED | high | winget-pkgs installer schema 1.12.0 doc; winget repository policies 1.1.4 (no signing requirement listed); Scoop App-Manifests wiki. | Publish to an own Scoop bucket and to winget through GoReleaser pipes, with both x64 and arm64. |
| 18 | MIT is the right licence for accshift: it matches limitshift, puts no restriction on commercial use, and is OSI-approved (needed for SignPath and package repos). Apache-2.0 adds a patent grant at the cost of NOTICE overhead. MPL-2.0 adds file-level copyleft the user does not want. | INFERRED | high | limitshift LICENSE is MIT (verified). The licence comparison comes from standard licence terms. SignPath requires an OSI licence without commercial dual-licensing (verified). | LICENSE: MIT. Every source file gets an SPDX header. If Rust, MIT OR Apache-2.0 is acceptable. Enforce a dependency allowlist with go-licenses v2 (Go) or cargo-deny (Rust), and generate THIRD_PARTY_NOTICES. |
| 19 | Provider terms conflict with account rotation to some degree: OpenAI prohibits circumventing rate limits, Anthropic ties limits to 'ordinary, individual usage' and restricts storing or intermediating credentials, Google bars third-party software from accessing Antigravity (with a Feb 2026 ban wave), and GitHub allows one free account per person. | VERIFIED | medium | Anthropic Consumer Terms (effective 2025-10-08), Claude Code legal page, AUP (2025-09-15), Antigravity terms and GitHub ToS (2026-04-27) were fetched directly. The OpenAI ToU (2026-01-01) was read via ConductAtlas because openai.com returned 403. Ban events come from secondary press. | The README carries the drafted notice (EN and UK), shown on first 'add'. Automatic rotation is explicit opt-in. accshift stays local, never signs in for the user, and uses only vendor-documented mechanisms. |
| 20 | A solo developer working with AI agents can make a defensible clean room through process: a fresh repo, a spec built only from allowed sources, a forbidden-sources list in AGENTS.md, a provenance log, and CI guards. | INFERRED | medium | Task constraints; US Copyright Office Part 2 report (2025-01-29) on human authorship; standard clean-room practice. | The repo gets docs/provenance/{SOURCES,DECISIONS,AI-USAGE,CLEANROOM}.md. CI checks forbidden tokens, SPDX headers and licence policy. Commits use DCO sign-off. An optional third-party similarity audit can be run against agm. |
| 21 | Self-update should verify an Ed25519 signature over SHA256SUMS against embedded public keys (stdlib, no heavy deps), replace the binary atomically (rename the running exe on Windows), and defer to package managers when they own the install. | INFERRED | medium | Library licences checked on deps.dev: go-selfupdate MIT/Apache, minio/selfupdate Apache (last release 2022), Rust self_update MIT, self-replace Apache, go-minisign MIT, sigstore-go Apache. The design reasoning is my own. | 'accshift self-update' is only allowed when an install receipt says method=script. Download from a hard-coded GitHub release URL, refuse downgrades, never update during an exec, run an opt-in daily check, send no telemetry. |
| 22 | The name 'accshift' is unused on npm, crates.io, Homebrew (formula and cask), PyPI and GitHub repository search. | VERIFIED | high | curl returned HTTP 404 for registry.npmjs.org/accshift, crates.io/api/v1/crates/accshift, formulae.brew.sh formula and cask JSON, and pypi.org/pypi/accshift/json. GitHub repo search for 'accshift' returned 0 results. | Keep the working name. Reserve the GitHub repo, the Homebrew tap name and the winget identifier (e.g. j-ts.accshift) early. |

## Full report

# Track: prior-art-distribution (accshift)

Date of research: 2026-10-07. Labels: **VERIFIED** means I saw evidence in this session (a fetched page, an API result or a command output, all cited). **INFERRED** means memory, reasoning or a secondary or third-party claim.

Clean-room compliance:
- I never opened, cloned or fetched agm or ClaudeCodePortable code.
- In `/home/user/ai-switcher` I read only `install.sh`, `install.ps1` and `packaging/targets.mjs`, all on the allowed list, and only for requirements.
- For prior art I read README, docs and issue pages only. I never read source files.
- One disclosure: I read the README of `Dicklesworthstone/coding_agent_account_manager` before I learned its licence is non-standard ("MIT + OpenAI/Anthropic Rider"). I took no lessons from it, and it is listed under "Excluded".

---

## PART 1: PRIOR ART

### 1.1 How I searched
- I ran GitHub repository search through the GitHub MCP. "claude code account switcher" returned 557 repos and "codex account switch" returned 685. I also searched for gemini, antigravity, copilot and CLIProxyAPI.
- I cross-checked licences with the deps.dev projects API.
- I read GitHub issues in `anthropics/claude-code` and `openai/codex` (search API plus issue pages via WebFetch).
- I read vendor docs: code.claude.com, learn.chatgpt.com (Codex auth), docs.github.com (Copilot CLI).

### 1.2 Landscape: notable projects (licence and stars VERIFIED via GitHub search / deps.dev on 2026-10-07)

| Project | Licence | Lang | ★ | CLIs | Mechanism | Distribution |
|---|---|---|---|---|---|---|
| [realiti4/claude-swap](https://github.com/realiti4/claude-swap) | MIT | Python | ~3.1k | claude (+VS Code ext) | **(A) In-place swap of the vendor slot.** Swaps only the account-specific login in Claude's native store (Keychain on macOS, credentials file on Linux/Windows). Backups live in `~/.claude-swap-backup/` (macOS/Windows) or `${XDG_DATA_HOME:-~/.local/share}/claude-swap/`. "Holds Claude Code's own credential locks while writing." Auto-rotation polls 5h/7d usage and switches at 90%. `cswap run N` gives a per-terminal session with its own token copy. Quarantines accounts whose refresh token died. | `uv tool install` / `pipx` |
| [inulute/cux](https://github.com/inulute/cux) | **GPL-3.0** (ideas only) | Go | 83 | claude | **(D) Wrapper with resume.** On a rate-limit response, or at a proactive threshold after the turn ends, it swaps credentials transactionally and relaunches `claude <orig flags> --resume <id> "Go continue."`. Stores `credentials.json` plus the `oauthAccount` block per account. Installs hooks in `~/.claude/settings.json`. On native Windows it hard-terminates claude ("Go cannot send SIGINT cross-process"). | npm `@inulute/cux`, `curl \| sh`, raw binaries `cux-{linux,darwin}-{amd64,arm64}`, `cux-windows-amd64.exe` |
| [burakdede/aisw](https://github.com/burakdede/aisw) | MIT | Rust | 124 | claude, codex, gemini, agy | **(A)+(B).** Stores in `~/.aisw/` (0600) using the OS keyring (Keychain, Secret Service, Credential Manager) with an encrypted-file fallback. Codex gets an isolated `CODEX_HOME` per profile, and "shared-mode ChatGPT auth switching is explicitly unsupported". Antigravity OAuth is "shared keyring state" and has "no documented per-profile auth root". For Claude it advises "start a fresh Claude process instead of relying on a resumed session from the previous account". | brew tap, `curl \| sh`, cargo. Raw binaries per target plus `.sha256`. v0.3.10 fixed glibc compatibility |
| [Loongphy/codex-auth](https://github.com/Loongphy/codex-auth) | MIT | Zig | ~2.8k | codex | **(A).** Swaps `~/.codex/auth.json` from a `registry.json`. Usage comes from `GET https://chatgpt.com/backend-api/wham/usage` or from local `~/.codex/sessions/*/rollout-*.jsonl`. Codex must be restarted after a switch. | npm `@loongphy/codex-auth` |
| [omarhoumz/codex-accounts](https://github.com/omarhoumz/codex-accounts) | MIT | bash | n/a | codex | **(A via symlink)+(B).** `~/.codex/auth.json` becomes a symlink to `~/.codex-accounts/<name>/auth.json`, because "a copy-based swapper leaves the saved copy holding a token that has since been rotated away". `codex-run` uses a per-account `CODEX_HOME` for concurrency. `config.toml` is symlinked and shared; histories stay isolated. | Homebrew |
| [larcane97/clausona](https://github.com/larcane97/clausona) | MIT | TS | 48 | claude, codex | **(B).** One config dir per profile; plugins, settings and skills are symlinked back to the primary dir. Session history is per account by default (`--merge-sessions` is opt-in). Caveat: MCP servers added with `claude mcp add` live in each dir's `.claude.json`, so they are not shared. | npm |
| [ndycode/codex-multi-auth](https://github.com/ndycode/codex-multi-auth) | MIT | TS | ~530 | codex | **(E) Loopback proxy.** Picks "the healthiest account per request". Disclaimer: "intended for personal development use… not an official OpenAI product". | npm |
| [zcop/agy-cli-manager](https://github.com/zcop/agy-cli-manager) | MIT | Python | 26 | agy | **(A).** The agy slot is Secret Service `service=gemini`, `username=antigravity`, or files under `~/.agy-cli-manager/accounts/<n>/.gemini/`. It tails agy logs (`antigravity-cli/log/`, `cli.log`) for `RESOURCE_EXHAUSTED (code 429): Individual quota reached` and protects switching with a single lock file. agy must be restarted to pick up the new token. | pip |
| [tnduyh5/agy-tools](https://github.com/tnduyh5/agy-tools) | MIT | shell | 3 | agy (macOS) | **(A).** Live slot is Keychain `service=gemini`, `account=antigravity`; profiles are stored under `service=gemini-profile`. Every `use` first snapshots the live token into a profile named `_last`. Tokens go to `security` via stdin, not argv. The quota display "was removed because the number could not be trusted". | script |
| [Muriel-Gasparini/antigravity-account-switcher](https://github.com/Muriel-Gasparini/antigravity-account-switcher) | MIT | Go | 15 | Antigravity | **(E) Reverse proxy.** Swaps the bearer token and replays a 429'd request in memory. Tokens are kept in SQLite. Linux only. | make install |
| [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | MIT | Go | ~54k | many | **(E).** Exposes the CLIs' OAuth logins as an OpenAI-, Gemini- and Claude-compatible API. This is the category the providers prohibit (see 1.4 and 3.4). | binaries |
| [ming86/cc-account-switcher](https://github.com/ming86/cc-account-switcher) | MIT | Shell | 450 | claude | **(A).** Uses the Keychain plus `~/.claude-switch-backup/`; needs bash 4.4 and jq. **Archived 2026-02-22.** | script |
| [farion1231/cc-switch](https://ccswitch.io) | MIT | (desktop) | ~140k (deps.dev) | many | Switches provider and endpoint config, not account rotation (described from the repo description only). | desktop app |
| Copilot CLI (official, [docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)) | n/a | n/a | n/a | copilot | **Native multi-account**: `/user list`, `/user switch`. The Keychain service is `copilot-cli`, with a plaintext fallback at `~/.copilot/config.json`. Env precedence is `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN` > keychain > gh. Fine-grained PATs (`github_pat_`) need the "Copilot Requests" permission; classic `ghp_` PATs are not supported. | n/a |
| Claude Code (official, [docs](https://code.claude.com/docs/en/authentication)) | n/a | n/a | n/a | claude | **(B) is the documented multi-account path**: "give each account its own configuration directory… set `CLAUDE_CONFIG_DIR`… Each directory has its own settings, session history, and claude.ai login". `claude setup-token` gives a "one-year OAuth token" that "does not save the token anywhere" and "can only make model requests". | n/a |

Minor projects, where I read the description only: `Nemo-Illusionist/claude-code-account-switcher` (MIT, Rust, binds accounts to directories on `cd`), `hamzarehmandeveloper/claude-account` (MIT, Rust), `quinnjr/claude-code-profiles` (MIT, Shell), `chussum/mobius` (MIT, Swift, auto-fallback), `jagtesh/guise` (BSD-3, Go), `reyanshgupta/ditto-cli` (MIT, Rust, 20+ agents), `07rjain/codauth` (MIT, Go), `AyakaMods/AyakaGeminiAccountSwitcher` (Apache-2.0).

**Excluded because the licence is unclear or restrictive (not studied):**
- `Dicklesworthstone/coding_agent_account_manager`: "MIT + OpenAI/Anthropic Rider", which deps.dev reports as "non-standard".
- `lbjlaq/Antigravity-Manager` (~32k★): CC BY-NC-SA 4.0, "Strictly for non-commercial use".
- No licence: `jlcodes99/cockpit-tools` (~18.7k★), `XueshiQiao/CCSwitcher`, `Lampese/codex-switcher`, `hoangpm96/ai-switcher`, `sujitagarwal/multigravity-cli`, `supSugam/agy-manager`.
- NOASSERTION: `timharris707/modeldeck`, `anglee0323/agy-switch`, `Draculabo/AntigravityManager`.

### 1.3 Mechanism taxonomy and verdict for accshift

| Mechanism | Used by | Pros | Cons / failure modes | accshift |
|---|---|---|---|---|
| (A) In-place swap of the vendor slot (keychain or file) | claude-swap, codex-auth, agy-tools, agy-cli-manager, cc-account-switcher | Works for running IDE extensions; plain `claude` keeps working | Saved copies go stale when the CLI rotates the refresh token. Keychain ACL clobbering. Every running process shares one slot. Needs locks. | **Only for agy**, which has no per-profile root; do it under a lock with snapshot-first |
| (B) Per-account config home | Claude docs, aisw (codex), clausona, codex-accounts | Each credential has exactly one owner, and the CLI refreshes it in place | Splits history unless sessions are linked; per-dir MCP config (clausona caveat) | **Codex** (`CODEX_HOME` per account, sessions linked to the shared dir; the codex track must verify) |
| (C) Per-run env token | Documented by Anthropic (`CLAUDE_CODE_OAUTH_TOKEN`) and GitHub (`COPILOT_GITHUB_TOKEN`) | No file mutation, no races, history stays shared | Claude setup-token: model requests only. Lower precedence than API-key vars. Identity shown in `/status` comes from the cached `oauthAccount`. | **Claude and Copilot** primary |
| (D) Wrapper plus `--resume` | cux | Continues the same conversation | Needs process control; on Windows, Go cannot send SIGINT cross-process | Phase 2 `run` / limitshift integration |
| (E) Local proxy | codex-multi-auth, CLIProxyAPI, Muriel-Gasparini | Rotation per request | **Squarely the prohibited "intermediating" pattern.** Uses private endpoints. | **Never** |
| (F) Shared config, per-account secure storage | `CLAUDE_SECURESTORAGE_CONFIG_DIR` users (issues #79222, #98526) | Shared history | Wrong cached identity in `/status`; skills-sync churn | Backup plan only |

### 1.4 Known problems reported by users (with evidence)

**Claude Code.** All VERIFIED by fetching the issue pages; versions are as reported.
- **Short-lived commands burn refresh tokens.** [#95822](https://github.com/anthropics/claude-code/issues/95822), v2.1.277, macOS: `claude auth status` and `claude --bg` start an unawaited OAuth refresh at init and `process.exit()` before saving it, leaving "the Keychain [with] the old spent token". The next refresh fails with `invalid_grant` ("Login expired · Please run /login").
  - **Implication:** accshift's `status`/`doctor` must never spawn `claude` (not even `auth status`) to probe an account.
- **Concurrent sessions race on rotation.** [#88947](https://github.com/anthropics/claude-code/issues/88947), v2.1.228–240, Linux: 10–24 sessions sharing `~/.claude/.credentials.json` mean that "two near-simultaneous refreshes can invalidate the chain", logging the whole machine out weekly.
- **Keychain ACL dropped on refresh.** [#94491](https://github.com/anthropics/claude-code/issues/94491) and [#96385](https://github.com/anthropics/claude-code/issues/96385), macOS, v2.1.270/271: a token refresh rewrites `Claude Code-credentials` in place and drops its ACL, so "Always Allow" grants are wiped and the prompt loop restarts.
  - Third-party evidence: claude-swap [#279](https://github.com/realiti4/claude-swap/issues/279) explains that `security add-generic-password -U` without `-T` "does not mean 'leave the existing ACL alone', it means 'trust only the process performing this write'", which locks Claude Code out. The fix there is explicit `-T /usr/bin/security -T <claude path>`.
- **Setting the default path explicitly selects a different Keychain entry.** [#92252](https://github.com/anthropics/claude-code/issues/92252), v2.1.261: `CLAUDE_CONFIG_DIR="$HOME/.claude"` set explicitly uses the hash-suffixed `Claude Code-credentials-<hash>` entry, so the user appears silently logged out. Workaround: `CLAUDE_SECURESTORAGE_CONFIG_DIR=""` pins the default store.
  - **Implication:** never export `CLAUDE_CONFIG_DIR` "for clarity".
- **Wrong identity from the cached oauthAccount.** [#79222](https://github.com/anthropics/claude-code/issues/79222), v2.1.215: with per-account secure stores, `/status` shows the cached `oauthAccount` from the shared `~/.claude.json`, "while the session authenticates, bills, and rate-limits against one account". Related: [#99240](https://github.com/anthropics/claude-code/issues/99240).
- **Skills-sync churn.** [#98526](https://github.com/anthropics/claude-code/issues/98526), v2.1.285: per-account `CLAUDE_SECURESTORAGE_CONFIG_DIR` with a shared `~/.claude` makes the claude.ai skills-sync bucket `~/.claude/skills/synced/<org>_<account>/` churn. In one report `.trash` reached 886 MB. Workaround: `--settings '{"syncClaudeAiSkills":false}'`.
- **setup-token caveats.**
  - [#84903](https://github.com/anthropics/claude-code/issues/84903): 401 "Invalid bearer token" on some accounts (v2.1.214).
  - [#92529](https://github.com/anthropics/claude-code/issues/92529): tokens sometimes lack the `user:sessions:claude_code` scope.
  - [#96076](https://github.com/anthropics/claude-code/issues/96076): setup-token tokens and Remote Control are mutually exclusive. The docs confirm the token "can only make model requests".
  - [#8938](https://github.com/anthropics/claude-code/issues/8938): the token alone is not enough on a fresh config dir, because onboarding and theme prompts still appear.
  - Docs: "[Bare mode](https://code.claude.com/docs/en/headless) does not read `CLAUDE_CODE_OAUTH_TOKEN`".
- **Auth precedence.** [Docs](https://code.claude.com/docs/en/authentication), VERIFIED: cloud provider vars > `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > `apiKeyHelper` > `CLAUDE_CODE_OAUTH_TOKEN` > Anthropic profiles > `/login`.
  - **Implication:** `accshift exec claude` must unset `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`, and warn if settings define `apiKeyHelper` or `ANTHROPIC_PROFILE`.
- **Usage endpoint returns 429.** [#30930](https://github.com/anthropics/claude-code/issues/30930): `/api/oauth/usage` returns a persistent 429 for Max users, so usage polling is fragile.
- **Logout revokes.** claude-swap README: "Do not run `/logout` first: current Claude Code may revoke the refresh token stored for the account you are leaving." Docs: `/logout` "removes and revokes the credential this sign-in wrote" (Console profile case).
- **Keychain contention.** claude-swap [#254](https://github.com/realiti4/claude-swap/issues/254): `errSecIO` (rc 36) appears when 18 processes contend for one item. It was misclassified as a dead token and self-healed in about 5 minutes.

**Codex.** VERIFIED as titles via the GitHub search API; bodies fetched where noted.
- [#39199](https://github.com/openai/codex/issues/39199) (body fetched): a fresh refresh token is invalidated immediately when two ChatGPT accounts are signed in on the web in one browser. Workaround: sign both out of the browser.
  - **Implication:** add accounts via `codex login --device-auth` or a private browser window.
- [#40541](https://github.com/openai/codex/issues/40541) and [#40267](https://github.com/openai/codex/issues/40267): a rotated refresh token was never persisted, so the login was invalidated within seconds.
- [#48507](https://github.com/openai/codex/issues/48507) and [#46028](https://github.com/openai/codex/issues/46028): concurrent processes race refresh-token rotation.
- codex-auth [#86](https://github.com/Loongphy/codex-auth/issues/86): after swapping saved `auth.json` snapshots, Codex says "Your access token could not be refreshed because you have since logged out or signed in to another account."
- codex-auth [#132](https://github.com/Loongphy/codex-auth/issues/132): `token_revoked` when adding a third account.
- codex-accounts README (third-party, **INFERRED**): "OpenAI rotates an account's refresh token on every login: a new sign-in invalidates the previous one server-side."
- codex-auth [#46](https://github.com/Loongphy/codex-auth/issues/46) (anecdote): after an auto switch, "a few sentences" consumed ~90% of the 5h window. A plausible cause is that the full context is re-sent with no prompt cache on the new account (**INFERRED**).
- Docs ([learn.chatgpt.com/docs/auth](https://learn.chatgpt.com/docs/auth), VERIFIED):
  - `cli_auth_credentials_store` = `file` | `keyring` | `auto` | `ephemeral`.
  - "Treat `~/.codex/auth.json` like a password."
  - `codex login --device-auth`.
  - `CODEX_ACCESS_TOKEN` is for enterprise automation.

**Antigravity (agy).** INFERRED from two independent third-party READMEs.
- There is one live credential slot: Keychain or Secret Service `service=gemini`, `account/username=antigravity`.
- No per-profile auth root is documented (aisw).
- A running agy must be restarted to pick up a swapped token.
- The quota endpoint is untrustworthy (agy-tools).
- Quota exhaustion appears in logs as `RESOURCE_EXHAUSTED (code 429): Individual quota reached`.
- The user's own ai-switcher installer notes "Antigravity logins need secret-tool (Debian/Ubuntu: sudo apt install libsecret-tools)" (VERIFIED, `/home/user/ai-switcher/install.sh`).

**Copilot.** Natively multi-account, plus per-run env token (VERIFIED docs). No significant third-party switchers.

**Gemini CLI.** aisw README (INFERRED): "Gemini CLI no longer serves Google AI Pro, Ultra, or free-tier individual accounts; those users should use Antigravity instead." This matches the limitshift-v2 README (VERIFIED): "Antigravity is Google's replacement for Gemini CLI on personal Google AI Pro/Ultra accounts (Gemini CLI stays for enterprise)."

### 1.5 Enforcement and ban events

- **Google, Antigravity.** Mid-February 2026 ban wave on users of OpenClaw and other third-party tools via Antigravity OAuth; reversal and "welcome back" on Feb 27 (secondary reporting: [The Register](https://www.theregister.com/software/2026/02/23/google-antigravity-falls-to-earth-under-compute-burden/4676154), [Techzine](https://www.techzine.eu/news/privacy-compliance/139032/google-intervenes-in-heavy-use-of-antigravity-and-gemini/), [piunikaweb](https://piunikaweb.com/2026/03/02/google-account-disabled-openclaw-antigravity-exec/); **INFERRED**).
  - The current [Antigravity ToS](https://antigravity.google/terms) (VERIFIED) says: "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement."
  - A July 2026 forum question asks whether wrapping the official `agy --print` is acceptable. It has only a **non-staff** reply saying Google's concern is other harnesses using the OAuth ([thread](https://discuss.ai.google.dev/t/is-invoking-the-official-antigravity-cli-agy-print-from-a-third-party-developer-tool-an-acceptable-use/175462), VERIFIED; no official answer).
- **Anthropic.** Server-side block of third-party OAuth harnesses (Jan 9, 2026); docs clarification (Feb 19, 2026); subscriptions no longer covering third-party harnesses (from Apr 4, 2026); a reported partial reversal (May 13). All from secondary press ([GIGAZINE](https://gigazine.net/gsc_news/en/20260220-anthropic-third-party-block/), [WinBuzzer](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/)), so **INFERRED**.
  - The current [Claude Code legal page](https://code.claude.com/docs/en/legal-and-compliance) (VERIFIED) says: "developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow", and "Advertised usage limits for Pro and Max plans assume ordinary, individual usage".
  - Reports of bans for holding multiple Max accounts (Feb 2026) exist only in secondary and unverified blogs ([metricnexus](https://metricnexus.ai/blog/anthropic-banning-multiple-claude-accounts)), which also cite an unnamed employee saying multiple accounts are not a violation. **Low confidence.** I found no primary source.

### 1.6 Lessons for accshift (actionable)
1. **Never be a proxy, and never make network calls with stored subscription tokens.** That excludes usage polling against private endpoints such as `chatgpt.com/backend-api/wham/usage` and `/api/oauth/usage`. Detect limits passively (CLI output, exit codes, or `--limited-until` supplied by limitshift).
2. **One credential, one owner.** A refreshable OAuth credential lives in exactly one place that the vendor CLI refreshes: the env token is never written anywhere else, and the per-account `CODEX_HOME` holds its own `auth.json`. Never copy `auth.json` or `.credentials.json` between places that both refresh.
3. **Slot swaps (agy only) follow the agy-tools pattern:**
   - take an exclusive lock;
   - snapshot the outgoing live credential (into its account record and a `_last` backup);
   - write the new one atomically;
   - on macOS, write with explicit `-T` trusted-app entries (or verify the ACL after the write);
   - pass secrets via stdin, never argv.
4. **Never run vendor `logout`, and never probe with short-lived vendor commands** (#95822).
5. **Failure classification.** Treat keychain I/O errors (`errSecIO`) and network errors as transient. Mark an account `needs_relogin` only on explicit `invalid_grant`, revoked or 401 evidence seen twice. Mark capped accounts `limited_until=<time>`.
6. **Env hygiene for `exec`:**
   - claude: unset `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`; warn on `apiKeyHelper` / `ANTHROPIC_PROFILE`; refuse `--bare`; never set `CLAUDE_CONFIG_DIR` to the default path.
   - codex: unset `CODEX_API_KEY`, `OPENAI_API_KEY` (unless the account type is API key).
   - copilot: set `COPILOT_GITHUB_TOKEN`, which already wins over `GH_TOKEN`/`GITHUB_TOKEN`.
7. **Report identity from accshift's own record,** never from `/status`, because of the cached `oauthAccount` (#79222).
8. **Adding accounts:** guide the user to sign in through the vendor's own flow (`claude setup-token`, `CODEX_HOME=… codex login --device-auth`, `agy` login) in an isolated browser context. accshift never performs OAuth.
9. **Resuming on another account** works in cux via `--resume <id>`. aisw advises a fresh process. The other tracks must test this on real accounts; expect a cost spike on the first turn (no prompt cache).
10. **Windows process control:** the wrapper must own the child's console/process group. cux could not deliver SIGINT from Go and hard-kills (**INFERRED** remedy: `CREATE_NEW_PROCESS_GROUP` plus `CTRL_BREAK_EVENT`).
11. **Show a risk notice once,** on first `add`. Only codex-multi-auth among prior art has an explicit "personal use" disclaimer.
12. **Ship static binaries.** aisw needed a glibc fix. Python, npm and Zig-via-npm distribution in prior art adds runtime dependencies that accshift avoids.

---

## PART 2: DISTRIBUTION AND TRUST (as of 2026-10-07)

### 2.1 Recommended release pipeline
- **Repo:** public `j-ts/accshift` from the first release. Attestations on private repos need GitHub Enterprise Cloud (VERIFIED, [docs](https://docs.github.com/en/enterprise-cloud@latest/actions/concepts/security/artifact-attestations)). Winget, Scoop and SignPath also require public URLs or open source.
- **Targets:** `darwin-arm64`, `darwin-amd64`, `linux-amd64`, `linux-arm64`, `windows-amd64`, `windows-arm64`.
  - ai-switcher shipped only `windows-x64` and told ARM users "runs the x64 build under emulation" (VERIFIED, `install.ps1`). Go builds native `windows/arm64` trivially (VERIFIED, below).
  - macOS Intel is still worth shipping, but Homebrew moves Intel to Tier 3 in Sept 2026 and to unsupported in Sept 2027 (VERIFIED, [Homebrew 6.0.0](https://brew.sh/2026/06/11/homebrew-6.0.0/)).
- **Assets per release:**
  - `accshift_<ver>_<os>_<arch>.tar.gz`, or `.zip` for Windows;
  - `SHA256SUMS`;
  - `SHA256SUMS.sigstore.json` (cosign keyless bundle);
  - `SHA256SUMS.sig` (Ed25519, for self-update);
  - `*.sbom.json` (SPDX via syft);
  - `install.sh`, `install.ps1`, `THIRD_PARTY_NOTICES.md`.
- **Release mechanics:**
  - Publish as a **GitHub immutable release**: create a draft, upload everything, then publish. Immutable releases have been GA since 2025-10-28; verify with `gh release verify <tag>` and `gh release verify-asset <tag> <file>` (VERIFIED, [docs](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity)).
  - Provenance: `actions/attest@v4` with permissions `id-token: write`, `attestations: write`, `contents: read` (VERIFIED, [docs](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)). `attest-build-provenance` v4 is now a wrapper around it. Users verify with `gh attestation verify <file> -R j-ts/accshift`. This gives SLSA v1.0 Build Level 2, or L3 with reusable workflows (VERIFIED).
  - Cosign v3 keyless signing (GoReleaser [blog](https://goreleaser.com/blog/cosign-v3), VERIFIED):
    - signs config: `signs: [{cmd: cosign, signature: "${artifact}.sigstore.json", args: [sign-blob, "--bundle=${signature}", "${artifact}", "--yes"], artifacts: checksum}]`;
    - users verify with `cosign verify-blob --certificate-identity 'https://github.com/j-ts/accshift/.github/workflows/release.yml@refs/tags/vX' --certificate-oidc-issuer https://token.actions.githubusercontent.com --bundle SHA256SUMS.sigstore.json SHA256SUMS` (the pattern GoReleaser itself documents, VERIFIED);
    - note: keyless signing from a **private** repo would publish the workflow identity to the public Rekor log (**INFERRED**).
- **Build flags:**
  - Go: `CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=… -X main.commit=…"`, with a reproducible mtime (GoReleaser `mod_timestamp`).
  - No UPX: packers raise AV false positives (**INFERRED**).
  - Windows: embed version info (go-winres or goversioninfo; **INFERRED**, it helps reputation).

### 2.2 Build tool comparison

| | GoReleaser OSS v2.18.x (VERIFIED v2.18.2 current) | dist (cargo-dist) 0.33.0, 2026-09-10 (VERIFIED) | Hand-written CI |
|---|---|---|---|
| Languages | Go native; Rust via `builder: rust` since v2.5 (uses `cargo zigbuild`; you install rust, zig and zigbuild yourself) | Rust only | any |
| Checksums / cosign / SBOM | yes / yes (bundle) / syft | yes / attestations (`github-attestations`) / n/a | manual |
| Homebrew | `homebrew_casks` (`brews` formulas deprecated v2.10, hard v2.16, VERIFIED) | Homebrew formula | manual |
| Scoop / winget / AUR / deb-rpm | `scoops` / `winget` (opens PR to winget-pkgs) / `aurs` (`-bin`, SSH key) / `nfpms` (all VERIFIED; MSI/NSIS are Pro) | no / no / no / no (has shell, ps1, npm, MSI installers and an `install-updater`) | manual |
| macOS sign + notarize | cross-platform via anchore/quill from Linux (bare binaries; not for app bundles, VERIFIED) | not documented in config ref | manual (`rcodesign` or `codesign`) |
| Windows signing | via `signs` / `binary_signs` hooks | `azure-windows-sign` (x86_64 only), `ssldotcom-windows-sign` (VERIFIED) | manual |
| Maintenance | active | axodotdev active (0.33 on 2026-09-10); Oxide keeps an internal fork "for Oxide's internal use" (VERIFIED) | you |

**Recommendation:** GoReleaser if the language is Go, since it has the widest packaging coverage. If Rust, use dist for installers plus manual Scoop/winget, or GoReleaser's rust builder. Hand-written CI is a waste for a solo developer.

### 2.3 macOS
- **Quarantine and notarization.** curl, and install scripts in general, do **not** set `com.apple.quarantine`, so Gatekeeper never checks the binary. Apple DTS: "When you use curl, there are no checks being done at all. Gatekeeper works by having the web browser attach a quarantine flag" (VERIFIED, [Apple forum 706273](https://developer.apple.com/forums/thread/706273)). **Notarization is not needed for curl, tar or install.sh installs.**
  - Browser downloads are quarantined. Since Sequoia the Control-click "Open" bypass is gone, and users must use System Settings > Privacy & Security > "Open Anyway" (VERIFIED, secondary: [Cult of Mac](https://www.cultofmac.com/864843/macos-sequoia-removes-handy-shortcut-bypass-gatekeeper-security/)).
  - So `install.sh` keeps ai-switcher's defensive `xattr -dr com.apple.quarantine` step (VERIFIED in `/home/user/ai-switcher/install.sh`), and the README tells browser users to run `xattr -d com.apple.quarantine ./accshift`.
- **arm64 signing.** Native arm64 code must carry at least an ad-hoc signature. **VERIFIED in this session:** Go 1.24.7 cross-compiling from Linux emits `LC_CODE_SIGNATURE` for darwin/arm64, with CodeDirectory flags `0x20002` (adhoc + linker-signed), and none for darwin/amd64 (not required there).
  - Rust: Apple `ld` and LLVM `ld64.lld` ad-hoc-sign arm64 by default, and so do zig-based builds (**INFERRED**). The safest course is to build darwin on `macos-latest` runners or verify with `codesign -dv` in CI.
- **Keychain and code identity.** This links signing choices to the design.
  - The file-based keychain enforces item ACLs via the creating app's **designated requirement** (Apple DTS, VERIFIED, [forum 732869](https://developer.apple.com/forums/thread/732869)). Ad-hoc-signed binaries get a new cdhash every build, so ACL grants bound to accshift itself would re-prompt after every update (**INFERRED**, secondary [evidence](https://cdn.jsdelivr.net/npm/@linzumi/cli@1.0.179/scripts/qa/codex-keychain-partition-repro.md)).
  - Recommendation: do all macOS keychain I/O through `/usr/bin/security` (Apple-signed, so its identity is stable), as Claude Code does, and pass explicit `-T` for each app that must keep access.
  - A Developer ID certificate ($99/yr Apple Developer Program; **INFERRED** price) gives a stable DR. It is optional before 1.0.
- **Homebrew.**
  - Own tap `j-ts/homebrew-tap`.
  - Homebrew 6.0.0 (2026-06-11) introduced **tap trust**: `HOMEBREW_REQUIRE_TAP_TRUST` is on by default, and users run `brew trust j-ts/tap` (VERIFIED, secondary summary of the release notes). Documented install: `brew tap j-ts/tap && brew trust j-ts/tap && brew install accshift`. Exact UX still to be tested.
  - `homebrew/cask` disables casks that fail Gatekeeper in Sept 2026, and `--no-quarantine` is deprecated ("does not wish to easily provide circumvention", VERIFIED, [Homebrew 5.0.0](https://brew.sh/2025/11/12/homebrew-5.0.0/)). Third-party taps are not subject to that check.
  - An unsigned **cask** gets quarantined, so GoReleaser's documented pattern adds a postflight `xattr -dr com.apple.quarantine` hook (VERIFIED via GoReleaser docs summary).
  - Cleaner alternative for Go: a **source-build formula** in the tap (`depends_on "go" => :build`). It needs no quarantine handling or signing and is homebrew-core-style (**INFERRED**).

### 2.4 Windows
- **Mark of the Web.** Browsers set MOTW. **curl.exe, bitsadmin and PowerShell's System.Net/WinHTTP downloads do not** ("by-design"), command-line extractors don't propagate it, and "MotW files invoked by non-shell means (e.g. cmd.exe or PowerShell) do not trigger security checks" (VERIFIED, [Eric Lawrence, updated 2026-09-01](https://textslashplain.com/2016/04/04/downloads-and-the-mark-of-the-web)). So `irm …/install.ps1 | iex` installs see no SmartScreen prompt.
- **Windows PowerShell 5.1** now shows a "Script Execution Risk" prompt for `Invoke-WebRequest` without `-UseBasicParsing` (KB5074596, 2025-12-09, VERIFIED, [Microsoft](https://support.microsoft.com/en-us/servicing/os/windows/2025/12/powershell-5-1-invoke-webrequest-preventing-script-execution-from-web-content)). `install.ps1` must always pass `-UseBasicParsing`; ai-switcher's installer already does.
- **Smart App Control (the real blocker).** On clean Windows 11 installs in *enforcement mode*, "Malware, Potentially Unwanted Apps (PUA), and unknown, unsigned code are blocked by default", whatever the MOTW status. Code is allowed if the cloud service knows it, or if it is "signed with a certificate issued by a CA within the Trusted Root Program". *Evaluation mode* turns itself off for developer-like users (VERIFIED, [MS Learn 2026-09-30](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)). Real-world hits in Oct 2026: unsigned Biome CLI blocked ([biome#12126](https://github.com/biomejs/biome/issues/12126), VERIFIED).
- **Defender false positives.** Go FAQ: "This is a common occurrence, especially on Windows machines, and is almost always a false positive" (VERIFIED, [go.dev/doc/faq](https://go.dev/doc/faq)). A binary that reads Credential Manager and keychain items may look stealer-like to ML heuristics (**INFERRED**). Mitigations: signing, version resource, no packing, and submitting FPs via the Microsoft WDSI portal.
- **Code-signing options for an individual** (VERIFIED, [MS Learn 2026-08-29](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)):

  | Option | Cost | Eligibility | Notes |
  |---|---|---|---|
  | Azure Artifact Signing (formerly Trusted Signing) | ~$9.99/mo | Individuals: **USA and Canada only**. Orgs: USA, Canada, EU, UK. | Reputation still builds over time; CI-friendly |
  | SignPath Foundation | free | OSI licence with no commercial dual-licensing, no proprietary components, already released, MFA, manual approval per release, "Code signing policy" page | Certificate is issued to **SignPath Foundation** (it is the publisher). The policy excludes software "designed to … circumvent security measures"; rate-limit rotation could draw scrutiny (VERIFIED [terms](https://signpath.org/terms); applicability **INFERRED**) |
  | Certum Open Source Code Signing | from ~$49.99 | worldwide | Cloud SimplySign, no token (secondary source, **INFERRED**) |
  | OV certificate (DigiCert, Sectigo…) | $150–300/yr | worldwide | HSM or token required since June 2023 |
  | EV certificate | $400+/yr | worldwide | **No SmartScreen bypass since 2024**; not worth it |

  Recommendation: ship v0.x unsigned through the scripts, Scoop and winget, and document the Smart App Control caveat. Before 1.0, sign Windows binaries. Apply to SignPath first (free), with Certum OSS as the fallback, or Azure if the user is in the US or Canada. Use one stable signing identity so reputation accumulates.
- **Scoop:** own bucket `j-ts/scoop-bucket` (GoReleaser `scoops`). Manifest fields: `version`, `architecture.{64bit,arm64}.{url,hash}`, `bin`, `checkver` (github), `autoupdate` (VERIFIED, [Scoop wiki](https://github.com/ScoopInstaller/Scoop/wiki/App-Manifests)).
- **winget:**
  - Manifest schema 1.12.0. `InstallerType: zip` with `NestedInstallerType: portable` and `NestedInstallerFiles: [{RelativeFilePath: accshift.exe, PortableCommandAlias: accshift}]`, for `Architecture` x64 and arm64 (VERIFIED, [schema](https://github.com/microsoft/winget-pkgs/blob/master/doc/manifest/schema/1.12.0/installer.md)).
  - Policy 1.1.4: "The InstallerUrl must be the ISV's release location" (GitHub Releases is fine).
  - The policies contain no signing requirement (VERIFIED, [policies](https://learn.microsoft.com/en-us/windows/package-manager/package/windows-package-manager-policies)). The validation pipeline does malware scanning (**INFERRED**).
  - Use the GoReleaser `winget` pipe to open the PR, or `wingetcreate`.

### 2.5 Linux
- **Static binaries.** VERIFIED: Go with `CGO_ENABLED=0` produced "statically linked" ELF for amd64 and arm64, about 1.4 MB for hello-world with `-s -w`. Secret Service access works without CGO via D-Bus (godbus, BSD-2-Clause; go-keyring, MIT). Rust: `*-unknown-linux-musl` targets.
- **Headless fallback.** When there is no Secret Service, use a 0600 file under `$XDG_DATA_HOME/accshift`, which is what Claude and Copilot themselves do. Mark it in `doctor`.
- **Optional packages:** `.deb`, `.rpm` and `.apk` via nfpm; AUR `accshift-bin` via GoReleaser `aurs`; Homebrew on Linux via the same tap. Note that Homebrew 6 raised its Linux baseline to glibc 2.39, which does not matter for static binaries (VERIFIED, release notes).

### 2.6 Installer scripts
These requirements are carried over from the user's own ai-switcher installers (VERIFIED by reading `install.sh` and `install.ps1`):
- POSIX `install.sh` (`curl … | sh`) and `install.ps1` (`irm … | iex`), with no admin rights.
- Default locations: `~/.local/bin` on Unix, `%LOCALAPPDATA%\accshift\bin` on Windows plus the user PATH (written as a raw registry value). An `ACCSHIFT_NO_MODIFY_PATH=1` opt-out.
- Knobs: `ACCSHIFT_VERSION` (pin), `ACCSHIFT_ARCHIVE` (local or URL override), `ACCSHIFT_REPO`, and `ACCSHIFT_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token` for a private repo.
- **Verify `SHA256SUMS` before unpacking.** Also, as a new step, verify the cosign bundle when `cosign` is present.
- Strip quarantine on macOS.
- Never touch account data on update. In ai-switcher, `app/` and `profiles/` were preserved; here, everything under the data dir is.
- Windows: detect `PROCESSOR_ARCHITEW6432`/`PROCESSOR_ARCHITECTURE` and pick native arm64.
- limitshift integration (**INFERRED** proposal): limitshift finds accshift via `ACCSHIFT_BIN` or `PATH`, checks `accshift version --json` (`{"version","commit","protocol":1}`), and offers `--install-accshift`, which runs the official installer. It never vendors the binary.

### 2.7 Self-update design (`accshift self-update`)
1. **Package-manager installs:** if installed by brew, scoop, winget, AUR or a distro package, print the right upgrade command and exit. Detect this through an install receipt written by `install.sh`/`install.ps1` (e.g. `$XDG_DATA_HOME/accshift/install.json` = `{method:"script", version, path}`), not by guessing paths.
2. **Source:** hard-coded `https://github.com/j-ts/accshift/releases/latest/download/…`. The redirect avoids the 60/h unauthenticated API limit.
3. **Verify:**
   - Check `SHA256SUMS` with an **Ed25519 signature** using stdlib `crypto/ed25519` (or MIT `go-minisign` / `minisign-verify`) and 1–2 **embedded public keys** (current + next, for rotation).
   - Then check the archive hash.
   - Refuse downgrades unless `--allow-downgrade`.
   - Cosign/attestations remain for humans and CI. In-binary sigstore-go (Apache-2.0) is heavy, needing a TUF root (**INFERRED**).
   - Keep the signing key in a GitHub Environment secret with required reviewers.
4. **Atomic replace:**
   - Unix: write into the same directory, fsync, chmod, then `rename()` over the old binary.
   - Windows: rename the running `accshift.exe` to `accshift.exe.old`, move the new file in, and delete `.old` on next start.
   - Candidate libraries (licences VERIFIED via deps.dev): `creativeprojects/go-selfupdate` v1.6.0 (MIT/Apache-2.0), `minio/selfupdate` v0.6.0 (Apache-2.0, last release 2022), Rust `self_update` 1.3.0 (MIT), `self-replace` 1.5.0 (Apache-2.0).
5. **Policy:**
   - Never update during an `exec` or while limitshift holds the lock.
   - Update checks are opt-in, at most once a day, and disabled with `ACCSHIFT_NO_UPDATE_CHECK=1`.
   - No telemetry.

---

## PART 3: LICENSING, CLEAN ROOM, DISCLAIMER

### 3.1 Licence choice

| | MIT | Apache-2.0 | MPL-2.0 |
|---|---|---|---|
| Commercial use | yes | yes | yes |
| Obligations | keep notice | notice, NOTICE file, state changes | modified MPL files stay MPL with source available (file-level copyleft) |
| Patent grant | implicit at best | explicit, with termination | explicit |
| GPLv2 compatible | yes | no | yes (secondary-licence clause) |
| Fit with limitshift (MIT) | identical | fine | adds copyleft friction |

**Recommendation: MIT**, the same as limitshift (VERIFIED `/home/user/j-ts/limitshift/LICENSE`: "MIT License, Copyright (c) 2026 LimitShift Contributors").
- If the implementation language is Rust, `MIT OR Apache-2.0` is the ecosystem norm and also acceptable.
- MPL is not recommended because it adds an obligation the user does not want.
- Use `Copyright (c) 2026 <owner> and accshift contributors`, and put an `SPDX-License-Identifier: MIT` header in every source file.
- Note that MIT grants no trademark rights. The README should claim no affiliation and must not use vendor names or logos in the product name (Claude Code docs forbid that, VERIFIED).

### 3.2 Dependency licence policy and enforcement
- **Allow:** MIT, MIT-0, BSD-2-Clause, BSD-3-Clause, ISC, Apache-2.0, 0BSD, Zlib, BSL-1.0, CC0-1.0, Unicode-3.0 / Unicode-DFS-2016.
- **Review case by case:** MPL-2.0, only if unmodified and only as a dependency.
- **Deny:** GPL-*, LGPL-* (static linking makes LGPL compliance hard), AGPL-*, SSPL, BUSL/BSL-1.1, Elastic-2.0, Commons Clause, CC-BY-NC*, CC-BY-SA, the JSON licence, any "rider" or field-of-use licence, and unknown or no licence.
- **Go tooling:** `go install github.com/google/go-licenses/v2@latest` (repo not archived, v2 current, VERIFIED).
  - CI: `go-licenses check ./... --allowed_licenses=MIT,BSD-2-Clause,BSD-3-Clause,Apache-2.0,ISC`.
  - Notices: `go-licenses report ./... --template=notices.tpl > THIRD_PARTY_NOTICES.md`; `go-licenses save` for archives.
  - Plus `golang/govulncheck-action@v1`.
- **Rust tooling:** `cargo deny check licenses bans advisories sources` (cargo-deny 0.20.2, `Apache-2.0 OR MIT`, VERIFIED). In config v2, "all licenses are denied by default unless explicitly included in the allow list" (VERIFIED, [docs](https://embarkstudios.github.io/cargo-deny/checks/licenses/cfg.html)). Use `cargo about` for notices (**INFERRED**).
- **Licences of candidate libraries** (VERIFIED via deps.dev 2026-10-07): zalando/go-keyring v0.2.8 MIT; 99designs/keyring v1.2.2 MIT (last release 2022); danieljoos/wincred v1.2.3 MIT; godbus/dbus/v5 v5.2.2 BSD-2-Clause; keybase/go-keychain MIT (CGO, so avoid); spf13/cobra v1.10.2 Apache-2.0; alecthomas/kong v1.16.1 MIT; sigstore-go v1.3.0 Apache-2.0; go-minisign MIT; Rust keyring 4.2.0 `Apache-2.0 OR MIT`.

### 3.3 Clean-room procedure for a solo developer using AI agents
1. **Fresh repository** (`git init`). Share no history with ai-switcher; do not fork anything.
2. **Spec room.** Write `docs/SPEC.md` and behavioural tests from only these sources:
   - (a) the user's own ai-switcher files on the allowed list, as requirements;
   - (b) vendor public docs;
   - (c) black-box observation of vendor CLIs (`--help`, files they create);
   - (d) READMEs and docs of permissively licensed prior art, for ideas only.
3. **Implementation room.** The new repo's `AGENTS.md`/`CLAUDE.md` gets a **Forbidden sources** list:
   - any `github.com/shyim/agm` path or fork;
   - Hawkynt ClaudeCodePortable;
   - `/home/user/ai-switcher` (except the allowed list, and even then requirements only);
   - code files of any third-party switcher (READMEs and issues are fine);
   - any GPL repo source (cux).
   Rules for agents: never clone or fetch third-party source; never paste code from search results; prefer the stdlib; log every web source.
4. **Provenance files** in `docs/provenance/`:
   - `SOURCES.md`: URL, date, licence, what was learned, "no code copied";
   - `DECISIONS.md`: ADRs citing sources;
   - `AI-USAGE.md`: which agents and models were used, which sessions, and a statement of human review;
   - `CLEANROOM.md`: the rules above plus an honest note that the owner previously bundled agm as a binary dependency, and that accshift's mechanisms come from vendor-documented interfaces (env vars, `CODEX_HOME`, OS credential APIs).
5. **CI guards:**
   - fail on forbidden tokens (`shyim`, `agm` as an identifier, `ClaudeCodePortable`, `Hawkynt`, `NonCommercial`, `Commons Clause`);
   - require an SPDX header in every source file;
   - enforce the licence allowlist;
   - optionally compare file hashes against a hash list of ai-switcher and agm-adjacent files that the owner generates locally (hashes leak nothing).
6. **Commit hygiene:** `git commit -s` (DCO) and `Co-Authored-By` trailers for agent commits. Releases are reproducible, with attestations tying binaries to commits.
7. **Optional audit:** a separate party who is allowed to view agm runs a similarity tool (e.g. Dolos, JPlag) and reports only scores. Implementation agents never see the results' code.
8. **Note on AI output** (not legal advice): the US Copyright Office (Part 2 report, 2025-01-29) concluded that "purely AI-generated material" is not copyrightable and that human selection and modification matter ([LoC blog](https://blogs.loc.gov/copyright/2025/02/inside-the-copyright-offices-report-copyright-and-artificial-intelligence-part-2-copyrightability/)). Keeping human design docs and reviews strengthens ownership.

### 3.4 What provider terms say (summaries with links, not legal advice)
- **Anthropic.**
  - [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) (effective 2025-10-08, VERIFIED), §2: "You may not share your Account login information… or Account credentials with anyone else." §3 prohibits access "through automated or non-human means, whether through a bot, script, or otherwise", "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it".
  - [Claude Code legal page](https://code.claude.com/docs/en/legal-and-compliance) (VERIFIED):
    - "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
    - OAuth "is designed to support ordinary use of Claude Code and other native Anthropic applications".
    - "developers may not collect, store, or intermediate Claude.ai credentials or session tokens".
    - "Anthropic reserves the right to take measures to enforce these restrictions… without prior notice".
  - [Usage Policy](https://www.anthropic.com/legal/aup) (effective 2025-09-15, VERIFIED) bans circumventing "a ban through the use of a different account" and coordinating activity "across multiple accounts to avoid detection or circumvent product guardrails".
  - Note the tension: `claude setup-token` docs tell users to put the token in an env var "wherever you want to authenticate". accshift storing the user's *own* token locally and passing it to the unmodified binary is the most defensible form, but the "store" wording is a grey area.
- **OpenAI.** Terms of Use (ROW, effective 2026-01-01; text via [ConductAtlas](https://conductatlas.com/platform/openai/terms-of-use-row/provision/CA-P-017134/prohibition-on-interfering-with-or-disrupting-services/) because openai.com returned 403; **INFERRED** fidelity): users may not "Interfere with or disrupt our Services, including circumvent any rate limits or restrictions or bypass any protective measures". The Business Terms prohibit configuring "the Services to avoid Usage Limits" (secondary).
- **Google.** [Antigravity ToS](https://antigravity.google/terms) (VERIFIED): "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement"; and "You must not abuse, harm, interfere with, or disrupt the Service. This includes… using the Service in connection with products not provided by us." The Feb 2026 bans are described in 1.5.
- **GitHub.** [ToS](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) (effective 2026-04-27, VERIFIED):
  - B.3: "One person or legal entity may maintain no more than one free Account".
  - H: "You may not share API tokens to exceed GitHub's rate limitations".
  - The [AUP](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies) prohibits "automated excessive bulk activity".

**Honest bottom line:** rotating accounts specifically to keep working past one account's limit runs directly against OpenAI's "circumvent any rate limits" clause. It is in tension with Anthropic's "ordinary, individual usage" framing and Google's third-party-tool clause, and it is limited by GitHub's one-free-account rule. "Personal or educational" positioning does not exempt anyone from these terms.

### 3.5 Proposed README notice (EN)
> **Use at your own risk: read your providers' terms.** accshift is an independent, unofficial tool for personal and educational use. It is not affiliated with or endorsed by Anthropic, OpenAI, Google or GitHub. It runs the official, unmodified CLIs on your own machine. It never signs in on your behalf, never sees your passwords, never proxies requests, and never sends your tokens anywhere except to the CLI you launch.
>
> Each provider's terms govern how you may use your accounts, and they change. As of October 2026:
> - Anthropic says subscription usage limits "assume ordinary, individual usage" and restricts how subscription credentials may be used ([Claude Code legal](https://code.claude.com/docs/en/legal-and-compliance), [Consumer Terms](https://www.anthropic.com/legal/consumer-terms)).
> - OpenAI prohibits attempts to "circumvent any rate limits or restrictions" ([Terms of Use](https://openai.com/policies/row-terms-of-use)).
> - Google prohibits using third-party software to access Antigravity ([terms](https://antigravity.google/terms)).
> - GitHub allows one free account per person ([ToS](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)).
>
> Using several accounts to keep working after one reaches its limit may break these terms and can get your accounts suspended. Only use accounts you own and pay for, never share them, and check the current terms yourself. This is not legal advice. accshift is provided "as is", without warranty (see LICENSE).

**UK (for README.uk.md):**
> **Використовуйте на власний ризик — ознайомтеся з умовами постачальників.** accshift — незалежний неофіційний інструмент для особистого та навчального використання; він не пов'язаний з Anthropic, OpenAI, Google чи GitHub. Він запускає офіційні незмінені CLI на вашому комп'ютері, не входить в акаунти замість вас, не проксіює запити й не передає ваші токени нікуди, крім CLI, який ви запускаєте. Умови постачальників змінюються; станом на жовтень 2026 вони обмежують обхід лімітів використання, використання сторонніх інструментів і кількість безкоштовних акаунтів (див. посилання вище). Використання кількох акаунтів, щоб продовжувати роботу після вичерпання ліміту одного, може порушувати ці умови й призвести до блокування. Це не юридична порада; програма надається «як є», без гарантій.

---

## 4. Commands run (excerpts)
- **Go cross-build check** (scratch `prior-art-distribution/gosign`, deleted afterwards):
  - `CGO_ENABLED=0 GOOS=… GOARCH=… go build -trimpath -ldflags="-s -w"` with go1.24.7 linux/amd64. Sizes: darwin/arm64 1,572,562 B; darwin/amd64 1,560,016; linux/amd64 1,429,688; linux/arm64 1,441,976; windows/amd64 1,530,880; windows/arm64 1,486,336.
  - `file`: linux binaries are "statically linked"; windows/arm64 is "PE32+ executable (console) Aarch64".
  - `llvm-objdump --macho --private-headers hi-darwin-arm64` shows `LC_CODE_SIGNATURE` (datasize 12306); darwin/amd64 has none.
  - Parsed with `python3 -I cs.py`: `CodeDirectory version 20400 flags 20002 (adhoc=True linker-signed=True) ident=a.out`.
- **Toolchains present:** rustc 1.97.0 with targets aarch64/x86_64 apple-darwin, windows-msvc/gnullvm, linux-gnu and linux-musl (aarch64); no cosign, goreleaser or zig.
- **Name availability:** `accshift` returned 404 on npm, crates.io, the Homebrew formula and cask APIs, and PyPI. GitHub repo search returned 0 results.
- **deps.dev licence lookups** for prior-art projects and libraries (results in the tables above). `gh api` to arbitrary repos is blocked in this session (403 "not enabled"); GitHub MCP search worked.

## 5. Open questions (need real accounts or machines)
See the `open_questions` field.

## Open questions

- Does 'claude --resume <id>' started under account A continue correctly when run with account B's CLAUDE_CODE_OAUTH_TOKEN and the same ~/.claude? What does the first turn cost on B (prompt cache lost)?
- Do setup-token tokens draw on the same 5h/weekly limits as /login, and what exact limit messages and exit codes appear in headless (-p) mode?
- Is there any primary Anthropic or OpenAI statement on one person holding several paid subscriptions? Only secondary blogs were found.
- Would SignPath Foundation accept a tool whose purpose includes rotating past usage limits, given its 'circumvent security measures' exclusion? What country is the user in (Azure Artifact Signing individuals: US/Canada only)?
- Does Smart App Control on a clean Windows 11 (enforcement mode) block an unsigned Go accshift.exe launched from PowerShell? What about from a limitshift child process? Measure the Defender ML false-positive rate for a binary that reads Credential Manager.
- On macOS 26/27, what happens when a quarantined unsigned CLI downloaded by browser is run from Terminal? Confirm the exact Homebrew 6 tap-trust UX ('brew trust j-ts/tap') and whether a postflight xattr hook in a third-party cask still works.
- When accshift rewrites agy's keychain item (service 'gemini', account 'antigravity') through /usr/bin/security, which -T entries keep agy prompt-free? Is the item name the same in the Windows Credential Manager target?
- Is a Codex refresh token invalidated per login (every sign-in to the same account kills older copies), or per browser session? Does 'codex resume' work when sessions/ is symlinked into several CODEX_HOMEs (allow_symlinked_codex_home)?
- Does the immutable-release flow (draft, upload, publish) work cleanly with GoReleaser or dist, and do 'gh release verify' and 'gh attestation verify' both pass for the same assets?
- Do provider terms see an automatic-rotation default as materially riskier than manual switching? Decide the default: manual, or auto with explicit opt-in.

## Sources

- realiti4/claude-swap README (MIT): https://github.com/realiti4/claude-swap
- claude-swap issue #279 (security -U resets ACL): https://github.com/realiti4/claude-swap/issues/279
- claude-swap issue #254 (errSecIO under contention): https://github.com/realiti4/claude-swap/issues/254
- inulute/cux README (GPL-3.0, ideas only): https://github.com/inulute/cux
- burakdede/aisw README (MIT): https://github.com/burakdede/aisw
- aisw releases: https://github.com/burakdede/aisw/releases
- Loongphy/codex-auth README (MIT): https://github.com/Loongphy/codex-auth
- codex-auth issue #86: https://github.com/Loongphy/codex-auth/issues/86
- codex-auth issue #132: https://github.com/Loongphy/codex-auth/issues/132
- codex-auth issue #46: https://github.com/Loongphy/codex-auth/issues/46
- omarhoumz/codex-accounts README (MIT): https://github.com/omarhoumz/codex-accounts
- larcane97/clausona README (MIT): https://github.com/larcane97/clausona
- ndycode/codex-multi-auth README (MIT): https://github.com/ndycode/codex-multi-auth
- zcop/agy-cli-manager README (MIT): https://github.com/zcop/agy-cli-manager
- tnduyh5/agy-tools README (MIT): https://github.com/tnduyh5/agy-tools
- Muriel-Gasparini/antigravity-account-switcher README (MIT): https://github.com/Muriel-Gasparini/antigravity-account-switcher
- ming86/cc-account-switcher README (MIT, archived): https://github.com/ming86/cc-account-switcher
- router-for-me/CLIProxyAPI (MIT, proxy category): https://github.com/router-for-me/CLIProxyAPI
- lbjlaq/Antigravity-Manager (CC BY-NC-SA, excluded): https://github.com/lbjlaq/Antigravity-Manager
- Claude Code docs: Authentication: https://code.claude.com/docs/en/authentication
- Claude Code docs: Legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
- claude-code #95822 short-lived commands burn refresh token: https://github.com/anthropics/claude-code/issues/95822
- claude-code #88947 refresh rotation race: https://github.com/anthropics/claude-code/issues/88947
- claude-code #94491 keychain ACL dropped on refresh: https://github.com/anthropics/claude-code/issues/94491
- claude-code #92252 CLAUDE_CONFIG_DIR default path different keychain entry: https://github.com/anthropics/claude-code/issues/92252
- claude-code #79222 cached oauthAccount identity: https://github.com/anthropics/claude-code/issues/79222
- claude-code #98526 skills sync churn with CLAUDE_SECURESTORAGE_CONFIG_DIR: https://github.com/anthropics/claude-code/issues/98526
- claude-code #84903 setup-token 401: https://github.com/anthropics/claude-code/issues/84903
- claude-code #92529 setup-token scopes: https://github.com/anthropics/claude-code/issues/92529
- claude-code #8938 setup-token not enough on fresh config: https://github.com/anthropics/claude-code/issues/8938
- Codex auth docs: https://learn.chatgpt.com/docs/auth
- openai/codex #39199 two web accounts invalidate refresh token: https://github.com/openai/codex/issues/39199
- Copilot CLI authentication docs: https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli
- Anthropic Consumer Terms: https://www.anthropic.com/legal/consumer-terms
- Anthropic Usage Policy: https://www.anthropic.com/legal/aup
- OpenAI Terms of Use (ROW) - provision mirror: https://conductatlas.com/platform/openai/terms-of-use-row/provision/CA-P-017134/prohibition-on-interfering-with-or-disrupting-services/
- Google Antigravity Terms: https://antigravity.google/terms
- Google AI forum: wrapping agy --print acceptable use: https://discuss.ai.google.dev/t/is-invoking-the-official-antigravity-cli-agy-print-from-a-third-party-developer-tool-an-acceptable-use/175462
- The Register: Antigravity compute burden / bans: https://www.theregister.com/software/2026/02/23/google-antigravity-falls-to-earth-under-compute-burden/4676154
- GIGAZINE: Anthropic bans third-party subscription auth: https://gigazine.net/gsc_news/en/20260220-anthropic-third-party-block/
- GitHub Terms of Service: https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
- GitHub Acceptable Use Policies: https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies
- GitHub artifact attestations how-to: https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations
- GitHub artifact attestations concepts (EC): https://docs.github.com/en/enterprise-cloud@latest/actions/concepts/security/artifact-attestations
- GitHub immutable releases GA: https://github.blog/changelog/2025-10-28-immutable-releases-are-now-generally-available/
- GitHub verify release integrity: https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity
- GoReleaser cosign v3 blog: https://goreleaser.com/blog/cosign-v3
- GoReleaser install/verify (v2.18.2): https://www.goreleaser.com/getting-started/install/oss/
- GoReleaser deprecations: https://goreleaser.com/deprecations/
- GoReleaser notarize: https://goreleaser.com/customization/sign/notarize/
- GoReleaser AUR: https://goreleaser.com/customization/publish/aur/
- GoReleaser winget: https://goreleaser.com/customization/publish/winget/
- GoReleaser Rust builder: https://goreleaser.com/customization/builds/rust/
- cargo-dist releases: https://github.com/axodotdev/cargo-dist/releases
- cargo-dist config reference: https://axodotdev.github.io/cargo-dist/book/reference/config.html
- Apple forum 706273 (curl vs quarantine): https://developer.apple.com/forums/thread/706273
- Apple forum 732869 (keychain DR): https://developer.apple.com/forums/thread/732869
- Homebrew 5.0.0: https://brew.sh/2025/11/12/homebrew-5.0.0/
- Homebrew 6.0.0: https://brew.sh/2026/06/11/homebrew-6.0.0/
- Cult of Mac: Sequoia removes Control-click bypass: https://www.cultofmac.com/864843/macos-sequoia-removes-handy-shortcut-bypass-gatekeeper-security/
- Eric Lawrence: Downloads and the Mark of the Web: https://textslashplain.com/2016/04/04/downloads-and-the-mark-of-the-web
- MS: PowerShell 5.1 Invoke-WebRequest change KB5074596: https://support.microsoft.com/en-us/servicing/os/windows/2025/12/powershell-5-1-invoke-webrequest-preventing-script-execution-from-web-content
- MS Learn: Smart App Control: https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview
- MS Learn: Code signing options: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
- biome #12126 Smart App Control blocks unsigned CLI: https://github.com/biomejs/biome/issues/12126
- SignPath Foundation terms: https://signpath.org/terms
- winget repository policies: https://learn.microsoft.com/en-us/windows/package-manager/package/windows-package-manager-policies
- winget manifest doc: https://learn.microsoft.com/en-us/windows/package-manager/package/manifest
- winget installer schema 1.12.0: https://github.com/microsoft/winget-pkgs/blob/master/doc/manifest/schema/1.12.0/installer.md
- Scoop App Manifests wiki: https://github.com/ScoopInstaller/Scoop/wiki/App-Manifests
- Go FAQ: virus scanners false positives: https://go.dev/doc/faq
- google/go-licenses: https://github.com/google/go-licenses
- cargo-deny licenses config: https://embarkstudios.github.io/cargo-deny/checks/licenses/cfg.html
- deps.dev API (licence lookups): https://api.deps.dev/v3/
- US Copyright Office AI Part 2 (LoC blog): https://blogs.loc.gov/copyright/2025/02/inside-the-copyright-offices-report-copyright-and-artificial-intelligence-part-2-copyrightability/
- User's own ai-switcher installers (requirements only): /home/user/ai-switcher/install.sh, /home/user/ai-switcher/install.ps1, /home/user/ai-switcher/packaging/targets.mjs
- limitshift LICENSE (MIT): /home/user/j-ts/limitshift/LICENSE
- limitshift-v2 README (CLI table, agy note): /home/user/limitshift-v2/README.md
