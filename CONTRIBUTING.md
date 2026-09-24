# Contributing to ai-switcher

Thanks for taking the time! This is a small repo and most contributions
fit into one of a handful of slots. This file explains how to run it
locally, work on `ais` and its agm integration, add a new portable tool, or
extend the menus.

## Local development

```bash
# Clone
git clone https://github.com/j-ts/ai-switcher.git
cd ai-switcher

# Unit tests (Node 22+, no dependencies)
node --test

# agm for this machine (needs Go) -> bin/<platform>/agm
node packaging/build-agm.mjs --targets current --install

# Run ais from the checkout (downloads Node into app/ on first run)
./bin/ais setup        # Linux / macOS
binais.cmd setup      # Windows

# Try things without touching your real profiles
CLAUDE_PROFILES_ROOT=/tmp/ais-play ./bin/ais profile add test --no-login

# Health checks
./bin/ais doctor
./Claude.bat --doctor
```

## Repository layout

```
bin/             the ais command (ais = POSIX sh bootstrap, ais.cmd = Windows); bin/<platform>/agm is dropped in by packaging
launcher/        ES modules: ais*.mjs (ais commands, registry, rotation, limit detection), agm.mjs/agy.mjs,
                 per-tool launchers (launcher.mjs, happy-/codex-/copilot-/antigravity-launcher.mjs on tool-launcher-core.mjs)
packaging/       agm.lock (pinned agm commit), build-agm.mjs, package.mjs, targets.mjs (asset names)
install.sh/.ps1  installers, also run by `ais update`
templates/       skill template library + skill-gate CLAUDE.md (committed)
tests/          node --test unit tests
assets/         icon + logo
.github/        CI/CD pipeline: workflows + helper scripts (version.pl, prune-nightlies, update-changelog)
app/            portable runtimes, auto-downloaded (git-ignored)
profiles/      per-profile data, auto-created  (git-ignored)
```

## Working on ais

- The registry logic (`launcher/ais-state.mjs`) and limit detection
  (`launcher/ais-limits.mjs`) are pure functions - cover changes there with
  tests first. Limit patterns must come from real session logs, never from
  guesses; add the verbatim line as a test fixture.
- `ais run` is tested end to end with a fake CLI (`tests/ais-run.test.mjs`);
  use `argsFor`/`pollMs` rather than real CLIs.
- agm is used, not modified. Talk to it through `launcher/agm.mjs` only, and
  always with `AGM_DATA_DIR` pointing at `profiles/.agm`.
- **Bumping agm**: review the upstream diff, change the commit in
  `packaging/agm.lock`, rebuild with `node packaging/build-agm.mjs --targets
  current --install`, and re-check the `agm list` / `login` / `switch` output
  formats `launcher/agm.mjs` parses (`tests/agm.test.mjs` pins them).
- Release archive names live in `packaging/targets.mjs`; the installers and
  `_build.yml` must ask for the same names (`tests/packaging.test.mjs`).

## Adding a sibling tool launcher

1. Copy `Claude.bat`/`claude.sh`, point the last line at `launcher/<tool>-launcher.mjs`.
2. Write the launcher on top of [`launcher/tool-launcher-core.mjs`](./launcher/tool-launcher-core.mjs)
   (`resolveProfile` → `baseProfileEnv` + tool env vars → `ensureNpmTool` → `spawnTool`);
   add the tool's config-dir helper in [`launcher/paths.mjs`](./launcher/paths.mjs).
3. Register it in the `TOOLS` list in [`launcher/registry.mjs`](./launcher/registry.mjs)
   and, if it has a native skills/instructions format, add a layout to
   [`launcher/skills-export.mjs`](./launcher/skills-export.mjs).

## Adding a portable tool

1. Bump or add the version pin + SHA256 in
   [`launcher/paths.mjs`](./launcher/paths.mjs). Cover every platform key
   you intend to support (`win32-x64`, `linux-x64`, `darwin-arm64`,
   `darwin-x64`).
2. Add an `ensure<Tool>()` function in
   [`launcher/install.mjs`](./launcher/install.mjs). Use the existing
   `downloadVerified` helper — SHA256 verification is mandatory.
3. Register the tool's bin directory in `setupPath()` inside
   [`launcher/launcher.mjs`](./launcher/launcher.mjs).
4. Add a check function in [`launcher/doctor.mjs`](./launcher/doctor.mjs)
   and append it to `ALL_CHECKS`.
5. Keep every bootstrap script's Node pin identical
   (`tests/bootstrap-pins.test.mjs` checks it).

## Extending the menus

Session-menu lives in
[`launcher/session-menu.mjs`](./launcher/session-menu.mjs). Reserved keys
are collected in the `RESERVED` `Set` near the top; if you add a new
single-key action, remember to update both the set and the footer hint.

Profile-menu is in
[`launcher/profile-menu.mjs`](./launcher/profile-menu.mjs). Anything that
runs in `-ReadOnly` mode (invoked by the session menu's move flow) must
still produce a usable pick; test with the move flow after every change.

## Tests

Tests live in `tests/*.test.mjs` and use Node's built-in
[`node:test`](https://nodejs.org/api/test.html). Keep new tests
**pure**: no network, no interactive input, no writes outside
`os.tmpdir()`. Use `t.after()` for teardown. Corrupt/garbage inputs are a
good thing to cover — the whole launcher is built to tolerate them.

## Release process

- **Nightly** builds are automatic after every successful CI run on
  `main` (`.github/workflows/nightly.yml`). They package the CI-validated
  SHA via the shared `_build.yml` block (agm build, archives, install check
  on all three OSes), publish the archives as a GitHub
  pre-release tagged `nightly-YYYYMMDD`, and apply a Grandfather-Father-Son
  pruning pass (7 dailies / 4 weekly / 3 monthly).
- **Stable releases** are cut by manually dispatching
  `.github/workflows/release.yml`. It re-runs the full CI matrix, builds
  the same artifact, refreshes `CHANGELOG.md`, and tags the dated release
  marker `vYYYYMMDD`.

## Commit messages

Commit subjects use a single-character prefix that decides which bucket
the entry lands in when the auto-maintained
[`CHANGELOG.md`](./CHANGELOG.md) is regenerated. The whole convention:

| prefix | meaning                                 | CHANGELOG bucket |
| :----: | --------------------------------------- | ---------------- |
| `+`    | added a feature, file, module, or doc   | **Added**        |
| `*`    | changed behaviour of something existing | **Changed**      |
| `#`    | fixed a bug                             | **Fixed**        |
| `-`    | removed code, feature, or file          | **Removed**      |
| `!`    | open TODO worth recording publicly      | **TODO**         |

Examples:

```
+ "--doctor" health check
* renamed "--resume-last" to "--continue" alias
# crash on empty .jsonl
- "data/" support (replaced by "profiles/")
! document registry schema in README
```

Sections in `CHANGELOG.md` render in the order **Added → Removed → Changed
→ Fixed → TODO** (matching the prefix convention `+ - * # !`), followed by
an "Other" catch-all for commits without a recognised prefix. Rendering
skips empty buckets so you only see what actually changed.

A space after the prefix is optional (`+ foo` and `+foo` both work).
Subjects that start with anything else still get a bullet — they just
land under "Other".

## Code style

- ES modules (`.mjs`), no bundler, no `node_modules`.
- 4-space indent, double quotes in JSON fixtures only.
- Prefer small modules with pure functions; reserve side effects (file I/O,
  `spawnSync`) to the edges.
- Defensive parsing: **per-item try/catch, never per-batch**. A corrupt
  file should degrade one row, not crash the menu.

## License

By contributing, you agree that your work ships under the same
LGPL-3.0-or-later license as the rest of the project. See [LICENSE](./LICENSE).
