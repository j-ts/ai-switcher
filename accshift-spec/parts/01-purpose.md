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
