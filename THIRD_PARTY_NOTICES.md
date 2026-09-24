# Third-party notices

## Bundled in the release archives

### agm

- Source: <https://github.com/shyim/agm>, built unmodified from the commit
  pinned in [`packaging/agm.lock`](packaging/agm.lock) (also recorded in
  `bin/agm-source.txt` inside every release archive).
- Author: Soner Sayakci (shyim).
- License: the upstream repository does not include a license file at the
  pinned commit. Redistribution of the prebuilt binaries relies on the
  author's permission; if you maintain a fork, make sure you have it, or
  build agm yourself with `node packaging/build-agm.mjs`.
- agm's Go dependencies (github.com/spf13/cobra, golang.org/x/sys,
  modernc.org/sqlite and their transitive modules, see agm's `go.sum`) are
  compiled into the binary under their own licenses (Apache-2.0, BSD-3-Clause).

## Downloaded at runtime (not bundled)

These are fetched from their official sources on first use, verified against
pinned checksums where the vendor publishes them, and stored under `app/` or
inside a profile:

- Node.js, Git for Windows (MinGit / PortableGit), Python, relocatable-perl,
  PowerShell - see the pinned versions and hashes in `launcher/paths.mjs`.
- Claude Code (`@anthropic-ai/claude-code`), OpenAI Codex CLI
  (`@openai/codex`), GitHub Copilot CLI (`@github/copilot`) - installed from
  npm into each profile.
- Google Antigravity CLI (`agy`) - downloaded from Google's release manifest
  and verified against its SHA-512.
