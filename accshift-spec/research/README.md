# accshift research (2026-10-07)

Nine independent research tracks, run separately before the spec was written. Each file has a summary, a scorecard (language tracks only), a conclusions table (every claim marked VERIFIED or INFERRED, with evidence and what the spec should do), the full report, open questions and sources.

| # | Track | Question it answers | Headline |
|---|---|---|---|
| 01 | [lang-go](01-lang-go.md) | Is Go a good implementation language? | Yes. One Linux runner built all six targets (3.8–4.7 MB, about 2 ms per call). agy itself is Go and uses the same keyring library. Main risk: Windows Defender false positives on unsigned Go executables. |
| 02 | [lang-rust](02-lang-rust.md) | Is Rust a good implementation language? | It works, with smaller and faster binaries, but needs zig, cargo-zigbuild and cargo-xwin to cross-build (about 3.6 GB of toolchain). Its main macOS keychain crate cannot be linked from Linux, and both iteration and agent reliability are slower. |
| 03 | [lang-scripts](03-lang-scripts.md) | Why not bash + PowerShell (the limitshift model), or Node/Bun/Deno/.NET/Zig/Python? | No. limitshift's history shows 10+ sh/ps1 parity bugs; shipped limitshift.sh crashes on macOS bash 3.2; script credential access breaks on size limits and missing tools; pwsh costs 0.4–0.7 s per call. JS single executables are 62–127 MB. |
| 04 | [cli-claude-codex](04-cli-claude-codex.md) | How do Claude Code and Codex store accounts, sessions and limits? | Claude: one `setup-token` per account, injected as `CLAUDE_CODE_OAUTH_TOKEN`. Codex: a per-account `CODEX_HOME` overlay. Codex refresh tokens are single-use, and a Codex session cannot be resumed under another account. |
| 05 | [cli-agy](05-cli-agy.md) | How does Antigravity (agy) store its login, conversations and limit errors? | One credential slot (keyring service `gemini`), with a plaintext file fallback in headless, SSH, WSL and container environments. Conversations are keyed by folder, not by account. |
| 06 | [cli-gemini-copilot](06-cli-gemini-copilot.md) | Gemini CLI and Copilot CLI (tier 2) | Gemini: a per-account `GEMINI_CLI_HOME`, sharing directories only. Copilot: `COPILOT_GITHUB_TOKEN` per run, rejecting classic `ghp_` tokens. |
| 07 | [os-credstores](07-os-credstores.md) | How to store secrets and swap another app's credential safely on each OS | Encrypted vault design. Use `/usr/bin/security` on macOS; on Linux, Secret Service with no D-Bus autolaunch and timeouts; on Windows, Credential Manager with a DPAPI fallback. Step-by-step agy slot swap. |
| 08 | [limitshift-integration](08-limitshift-integration.md) | Exactly where and how limitshift calls accshift | Hook points with line numbers, the JSON and exit-code contract, prototypes (bash 7/7 and PowerShell 4/4 scenarios passing), and existing limitshift bugs found along the way. |
| 09 | [prior-art-distribution](09-prior-art-distribution.md) | Existing switchers, release and signing, licence, clean room, provider terms | Never act as a proxy and never poll provider usage APIs. One owner per refreshable credential. Use GoReleaser, immutable releases, cosign and attestations. Licence: MIT. Includes a README notice draft. |

How the reports were produced:
- Each track ran as a separate agent with the same ground rules: clean room (no agm or ClaudeCodePortable code opened) and no russian-language sources.
- Vendor CLIs were downloaded, checksum-verified and inspected statically. They were run only with `--help`/`--version`, under an empty HOME, with no credentials.
- Experiments used fake tokens only.

The decisions taken from these reports are in [`../DECISIONS.md`](../DECISIONS.md). The specification is [`../SPEC.md`](../SPEC.md).
