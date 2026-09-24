# Agent guide — ai-switcher

Working agreement for **all** coding agents and human contributors working in
this repository. These rules are not optional. The full house spec lives in
the `Hawkynt/project-template` repo (`STANDARD.md`); this file is the
per-repo distillation.

## What this is

`ais`, a multi-account switcher for Claude Code, OpenAI Codex and Google
Antigravity, built on a fork of **ClaudeCodePortable** (portable runtimes,
per-profile Claude/Codex directories, session picker) plus a bundled
**agm** (Antigravity accounts via the OS credential store). `bin/ais` /
`bin/ais.cmd` bootstrap the pinned Node and run `launcher/ais.mjs`; the
per-tool launchers (`Claude.bat` / `claude.sh`, …) remain usable on their
own. agm is built from the commit in `packaging/agm.lock` and shipped in the
release archives (`packaging/`). Tests are `node --test`
(`tests/*.test.mjs`) — including tests for the CI helper scripts and the
packaging contract.

## Commits

- **Group changes semantically/logically** — one concern per commit.
- **Every subject line starts with a prefix**: `+` added · `-` removed ·
  `*` changed · `#` bug fixed · `!` critical todo.
- Never start a subject with "fix"/"bugfix"/"changed"/"modified".
- **No AI traces anywhere**: no `Co-Authored-By` AI lines, no "Generated
  with" footers, no agent mentions in messages, comments, or authorship.

## The loop (always, in this order)

1. **Before committing**: `node --test` until green (exactly what CI runs);
   the launcher scripts must keep working on stock `cmd.exe` and POSIX `sh`.
   Update CONTRIBUTING when flags, layout or pipeline change;
   `CHANGELOG.md` is generated — never edit it by hand.
2. **Commit** (rules above) and **push**.
3. **Wait for CI**; on `main` a green CI triggers the nightly (prerelease +
   GFS prune). Fix and loop until everything is green.

Stable releases are **manual** (`gh workflow run release.yml`) — never cut
one unless explicitly asked.

## Code conventions

- The helper scripts under `.github/workflows/scripts/` are mirrored from
  the shared template — change them **in the template first**, then mirror;
  their tests under `tests/` pin the contract (notes-only nightlies,
  newest-nightly-always-kept pruning, bot-commit filtering).
- Batch/cmd files keep CRLF; shell scripts stay POSIX-compatible; no admin
  rights may ever become a requirement.
- agm is reused, never forked or patched: bump it only by changing the
  commit in `packaging/agm.lock` after reviewing the upstream diff.
- Nothing may replace or delete `app/` or `profiles/` during install or
  update — that is where users' logins live.
- Nothing phones home: no telemetry; network traffic only for downloads,
  GitHub releases (install/update) and agm's Google OAuth/quota calls.

## Repo conventions

- **No README in the repository.** `README.md` is the owner's local file,
  ignored by `.gitignore` — never commit it or re-add a README lint to CI.
- License is LGPL-3.0-or-later; `.github/FUNDING.yml` stays intact.
