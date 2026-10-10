## 10. Command-line interface

### 10.1 Global rules

- Syntax: `acctshift <command> [args] [flags]`. Flags may come before or after positional args, except after `--` in `exec`, `env` and `run`, where everything is passed through untouched.
- A **control verb** is every command other than `exec` and `run` (§3). Control verbs report failures with the sysexits codes of §10.3 (64–78). `exec` and `run` report every failure before the child starts as 125, and otherwise return the child's status (§12.1.1).
- Global flags (types and defaults in §10.4):
  - `--json`: machine output per §11; implied for every contract command when stdout is not a terminal and `ACCTSHIFT_JSON=1`.
  - `--home DIR`: same as `ACCTSHIFT_HOME`.
  - `--non-interactive`: never prompt. acctshift is also non-interactive when stdin is not a TTY or when `ACCTSHIFT_NONINTERACTIVE=1`. LimitShift MUST export `ACCTSHIFT_NONINTERACTIVE=1` for every acctshift invocation (§7.5, §15.3). Control verbs that would need input then fail with a hint:
    - exit 74 `keystore-unavailable` when the input is a vault passphrase or a keystore unlock;
    - exit 65 `notice-not-accepted` when `add` would show the provider notice and `--accept-notice` is missing (§8), or `notice` finds the current version not accepted and `--accept` is missing (§10.2);
    - exit 77 `agy-slot-unregistered` when an agy control verb finds an unregistered login in agy's slot (§8.3.3);
    - exit 64 `usage` for anything else, such as a missing `--yes`, a token that must come from `--token-stdin`, or `config edit`.
  - `exec` never prompts, whatever stdin is: a condition that needs input takes the non-interactive branch and exits 125 (§7.5, §12.1.1). `run` never prompts during pre-launch credential handling either; it MAY ask its §16 post-exit question ("switch and resume?") only when stdin is a TTY and `ACCTSHIFT_NONINTERACTIVE` is not `1`.
  - `--debug` (or `ACCTSHIFT_DEBUG=1`): redacted debug log to stderr. Writers also append it to `logs/acctshift.log` (§6.1); read-only commands write it to stderr only, so they still write no file (§11.1 rule 8). It is for people only; LimitShift never passes it. There is no `--verbose`.
  - `--contract N`; `--no-color`; `--version`; `-h, --help`.
- Human output goes to stdout. Diagnostics go to stderr, always prefixed `acctshift: `, and never start with `{` (LimitShift merges stderr into parsed output) [R08 C3]. `exec` writes at most the catalogue lines of §12.1.1 and nothing after the child starts.
- **Flag parsing** uses the Go standard library (`flag`) with a small subcommand dispatcher. No CLI framework dependency (§19).
  - The dispatcher first takes the command words (`vault status`, `agy use`, `config edit`; a `config` key always starts with `clis.` or `settings.`, so `edit` is never a key).
  - `FlagSet.Parse` stops at the first positional argument, so the dispatcher parses repeatedly: `Parse`, take one positional, `Parse` the remainder, until `--` or the end.
  - After `--` (`exec`, `env`, `run`) everything is passed through unparsed and in order.
  - Unknown flags, a missing flag value, a missing or extra positional, and conflicting flags are usage errors: 64 `usage` (`exec`/`run`: 125 `usage`).

### 10.2 Commands

| Command | Purpose | Contract command (§11) |
|---|---|---|
| `version` | name, version, commit, contracts, supported and experimental clis, platform, `root`, `rootSource`, capabilities, `stderrCatalogue` | yes |
| `add <cli> <name> [kind flags] [--label L] [--token-stdin] [--accept-notice] [--key-source S] [--force-new-vault]` | register an account (guided vendor login, import, or agy `--capture-current`); per-cli kind flags in §10.4. It shows the provider notice (Appendix F) whenever `state.notice` is unset or older, and requires `y` or `--accept-notice` (else 65 `notice-not-accepted`). Secret-bearing kinds read the secret only from a no-echo TTY prompt or one line on stdin with `--token-stdin`; no flag ever takes a secret value (§8). It draws the account's immutable `id` (§6.2) | no (interactive) |
| `login <cli> <name> [--label L] [--new-identity] [--browser] [--token-stdin]` | re-authenticate an existing account in place: same `id`, home, `secretId`, name and pool position, under the §8 Login rules. A different identity exits 65 `identity-mismatch` unless `--new-identity`. On a `native` account it exits 64 `native-account` with the vendor's own login command as the hint | no |
| `remove <cli> <name> [--yes] [--keep-home] [--sign-out-slot]` | one transaction under `state.lock` and `vault.lock` (agy: also the exclusive slot lock, §8.3.4). It deletes the account's vault entries, its overlay directory (unless `--keep-home`) with any vendor keyring item derived from that overlay's own path (§8), its state entry, and then its registry entry. A `native` account is only unregistered. It refuses with 65 `account-in-use` while procscan finds a vendor process whose environment or cwd references the overlay (POSIX: `/proc/<pid>/environ` or `ps eww`; Windows: best effort, a warning only). agy: while any slot holds the account's email it refuses with 65 `agy-account-live` (hint `acctshift agy use <other>`), unless `--sign-out-slot` is given (§8.3.4). Asks unless `--yes` | no |
| `rename <cli> <old> <new>` | changes only `name` in accounts.json, plus every `agyRestoreAfterRun` setting that names the old account, in one atomic write under `state.lock`. It never moves directories, vault entries or state, which are all keyed by the immutable id (§6.2), so vendor keyring keys stay valid and a running cli keeps its home. It refuses with 73 `agy-journal-pending` while `journal/agy-swap.json` exists. A LimitShift account file that still holds the old name only makes `pick --prefer` ignore it (`preferIgnored:true`) | no |
| `agy use <name> [--slot-wait S]` | put that agy account into agy's slot without running agy, so the user's own `agy` uses it (§8.3.4) | no |
| `enable <cli> <name>` / `disable <cli> <name>` | toggle selection | yes |
| `order <cli> <name>…` | set preference order (named accounts first, others keep relative order) | yes |
| `list [<cli>] [--pool a,b]` | accounts with state and active limit records; read-only | **yes** |
| `status [<cli>] [--pool a,b] [--history]` | the `list` fields plus the vault header, the notice, agy's slot hint and per-account auth details; offline and read-only, never opens the keystore | **yes** |
| `pick <cli> [--prefer A] [--model M] [--pool a,b]` | choose an account for the run about to start (read-only, lock-free, §9.3) | **yes** |
| `next <cli> --from A [--model M] [--limited-model L] [--limited-until T \| --reason auth] [--run-started-at T0] [--evidence-file F] [--exit N] [--session ID] [--cwd DIR] [--pool a,b]` | record what A's failed run shows (a limit record, an auth strike, `relogin`, an `attentionCode`, or nothing, §9.3) and choose the next account, in one locked transaction. The evidence is parsed before the lock (§9) | **yes** |
| `mark <cli> --account A (--limited-until T \| --override --limited-until T \| --auth-failed \| --ok \| --clear) [--model M] [--evidence-file F] [--exit N] [--session ID] [--cwd DIR] [--run-started-at T0] [--pool a,b]` | update state without choosing (actions below) | **yes** |
| `exec <cli> [--account A \| --prefer A] [--pool a,b] [--slot-wait S] [--status-file P] [--track] [--allow-bare] [--allow-apikeyhelper] [--allow-settings-env] [--allow-base-url] -- <args…>` | run the cli as that account (§12). **The only way LimitShift launches a managed cli**; LimitShift always passes `--account` and `--status-file`. The `--allow-*` flags override the corresponding refusals of §8.1, §8.3 and §12.5 and are never used by LimitShift | **yes** (exit-code passthrough, §12.1.1) |
| `env <cli> --account A [--format sh\|ps\|cmd\|json] [--reveal-secrets]` | print the env delta for people who launch the cli themselves; secrets redacted by default, and the keystore is opened only with `--reveal-secrets` (§12.7). Exits 69 `requires-exec` when the plan has a post-run hook or holds a lock for the run (agy slot, gemini `home`, Windows codex copy mode) | no (standalone / diagnostic) |
| `classify <cli> [--exit N] [--session ID] [--cwd DIR] [--evidence-file F\|-] [--model M] [--run-started-at T0] [--record --account A]` | classify a finished run's output (§9.4–§9.5, Appendix C). Exits 0 for every class, and 66 `evidence-unreadable` when the evidence file cannot be read. With `--record` it also stores the result for A, like `mark`, and is then a writer. `classify --record` and `next`/`mark --evidence-file` MUST NOT both be used for one run: each would record the same strike or limit (§9.2) | **yes** |
| `doctor [<cli>] [--account A] [--fix]` | diagnostics: binaries, versions, root, permissions, vault, keystore, locks, pending journals, links, env conflicts, expiries, the notice, and native identity changes (§9.6). Without `--fix` it is read-only and exits 0 whenever it ran. `--fix` makes it a writer: it tightens permissions, quarantines and recreates damaged files (§6.4), recovers a pending agy journal (§8.3.4), deletes orphaned state entries, and clears a native account's records after an identity change (§9.2). `doctor --fix` exits 0 when every repair it attempted succeeded or nothing needed one; otherwise it exits with the code of the first repair that failed, 73 (`state-busy`, `vault-busy`, `slot-busy`, `agy-busy`), 74 (`keystore-unavailable`, `agy-keyring-locked`) or 78 (for example `unsupported-filesystem`), and still prints every finding. LimitShift only calls `doctor --json`, never `--fix` | **yes** |
| `notice [--accept]` | print the provider notice (Appendix F) and whether its current version is accepted; read-only. When it is not accepted, `notice` asks at a TTY, and `y` or `--accept` writes `state.notice = {acceptedAt, version}` under `state.lock` (a writer). If it stays unaccepted (declined, or non-interactive without `--accept`), `notice` exits 65 `notice-not-accepted`. On an accepted notice, `--accept` changes nothing. This is how a user whose accounts are all registered accepts a new notice version; it is the hint of 69 `notice-not-accepted` (§10.3) | **yes** |
| `vault status` | the vault header: whether a vault exists, its key source, key id and key-file path (§7.3); read-only | **yes** |
| `vault migrate --to SOURCE` / `vault export --to FILE` / `vault import FILE` | key source management; encrypted export/import for moving machines (§7.3) | no |
| `config <key> [value]` / `config edit` | read or set one registry key by dotted path: `clis.<cli>.mainHome`, `clis.<cli>.mainSqliteHome`, `clis.<cli>.bin`, `clis.<cli>.buckets.<model>`, `clis.<cli>.shareExtra`, `settings.<key>`, `clis.<cli>.settings.<key>` (§6.2). An invalid value, such as a relative `clis.<cli>.bin` or a `clis.codex.mainHome` inside `<root>/homes/` (§8.2), exits 65 `invalid-config` and changes nothing. `config edit` opens accounts.json in `$VISUAL`/`$EDITOR` and writes it atomically under `state.lock`: 64 `usage` non-interactively, 65 `invalid-config` on an invalid edit, 73 `registry-changed` if accounts.json changed while the editor was open (§6.2) | no |
| `run <cli> [--account A] [--pool a,b] [--slot-wait S] [--wait] -- <args…>` | phase 2 interactive wrapper with automatic rotation (§16). Every failure before a child starts exits 125. When every account is capped, at the start or after a limit, it exits 125 `all-capped`, unless `--wait` is given | no |
| `self-update [--check] [--version X] [--allow-downgrade]` / `self-update --record-install script --path DIR` | optional update for script installs; `--record-install` is the installers' offline call that creates the root and writes `install.json` (§17.6, §17.7) | no |
| `completion bash\|zsh\|fish\|powershell` | shell completion script | no |

**Names in selection flags** (§9.3). They never cause exit 64:
- An empty `--prefer`, `--model` or `--limited-model` counts as absent.
- An unknown, disabled, non-member or unusable `--prefer` is ignored, and the response says `preferIgnored:true`.
- An unknown `--from` records nothing (`recorded:null`), and `next` still selects.
- Unknown `--pool` names are dropped and listed in `poolDropped`. When no account remains (including an empty `--pool`), `pick` and `next` exit 69 `empty-pool` (`exec`/`run`: 125 `empty-pool`). `list`, `status` and `mark` never exit 69: they return `accounts:[]`, `poolSize:0` and `rotationPossible:false` (§10.3).

**`next` flags** (§9.3):
- `--reason limit|auth` defaults to `limit`. `--limited-until` together with `--reason auth` is a usage error (64).
- `--model M` is the model of the **next** run and is used only for selection. `--limited-model L` is the model that hit the limit and is used only for the recorded scope; it defaults to `--model`.
- `--run-started-at T0` is when the failing run started (default now − 60 s). It decides strike escalation and the codex refresh race (§9.2).

**`mark` actions.** Exactly one action is required; none, or two, is a usage error (64). `--override` without `--limited-until` is also 64.
- `--limited-until T` records a limit like `next`. `--override --limited-until T` writes a tier-4 record, which only another `--override` replaces and only `--clear` removes (§9.4). Both write scope `model:<bucket(M)>` when `--model M` is given and maps to a bucket, else `account`.
- `--auth-failed` records one ambiguous strike, exactly like `next --reason auth` (§9.2).
- `--ok` reports success, and is the only success channel. It clears `authStrikes`, the `backoff` map and every auth-suspect record, and sets `lastOkAt` and `lastUsedAt`. It keeps limit records, `lastStrikeAt`, `relogin` and `attentionCode` (§9.2).
- `--clear` removes all records, `authStrikes`, `lastStrikeAt`, `attentionCode`, the `backoff` map and `relogin`. On an account past `expiresAt` it still does so, then exits 65 `expired` with the hint `acctshift login <cli> <name>`, because only `login` replaces an expired token. `--clear --model M` removes only the records of M's bucket.
- `--evidence-file` (with `--exit`, `--session`, `--cwd` and `--run-started-at`) is accepted with `--limited-until` and `--auth-failed`, and is a usage error (64) with any other action. It is parsed as for `next`, and the §9.3 table applies with `--limited-until` as `--reason limit` and `--auth-failed` as `--reason auth`.
- `--pool` only shapes the response (`poolSize`, `rotationPossible`, `accounts[]`). `mark` selects nothing and is not subject to the notice gate.

**Time arguments.** `--limited-until` accepts integer epoch seconds, RFC 3339, or a duration (`90m`, `4h46m9s`) relative to now. `--run-started-at` accepts integer epoch seconds or RFC 3339. `--expires` accepts RFC 3339 or `YYYY-MM-DD` (00:00 UTC that day).

### 10.3 Exit codes

Summary for control verbs (full table with caller actions in Appendix E):

| Code | Meaning |
|---|---|
| 0 | success / an account is ready |
| 64 | usage error: bad, unknown or conflicting flags (`usage`), an unknown cli (`unknown-cli`), or an unknown account where a command names its target (`unknown-account`: `mark --account`, `enable`, `disable`, `order`, `login`, `remove`, `rename`, `env`, `agy use`, `doctor --account`, `classify --record --account`). Also `native-account` (`login` on a `native` account; the hint names the vendor's own login command) and input that non-interactive mode cannot get (`usage`, §10.1). Never for a `--prefer`, `--from` or `--pool` name (§10.2). `exec`/`run` report all of these as 125 |
| 65 | data error: `invalid-token` (a secret with the wrong format or prefix, §8), `duplicate-account`, `identity-mismatch`, `no-login-detected`, `securestorage-ignored`, `classic-pat-unsupported` (a `ghp_` token, §8.5), `gh-token-unavailable` (`add`/`login copilot --kind gh`, §8.5), `gemini-encrypted-storage`, `invalid-import` (`add codex --import-home` naming `mainHome`, §8.2), `invalid-bundle` (`vault import` with a wrong passphrase or a damaged bundle, §7.3), `notice-not-accepted` (`add`, `notice`), `account-in-use` and `agy-account-live` (`remove`), `expired` (`mark --clear` on an account past `expiresAt`), `invalid-config` (an invalid `config` value or edit) |
| 66 | `classify` only: the evidence file cannot be read (`evidence-unreadable`) |
| 69 | unavailable, only from `pick` and `next`: `empty-pool` (the cli has no accounts, every `--pool` name is unknown, or every remaining account is disabled), `unsupported-cli` (a known cli that exec cannot run on this OS), `notice-not-accepted` (hint `acctshift notice --accept`); and `env`'s `requires-exec`. `list`, `status` and `mark` never exit 69: for a cli without accounts, an unsupported cli or an empty pool they return `accounts:[]`, `poolSize:0` and `rotationPossible:false`. A one-account pool is not 69: it gives 75 or 77 |
| 70 | internal error, a bug (`internal`) |
| 73 | busy: `state-busy` (`state.lock` wait), `vault-busy` (`vault.lock` wait), `slot-busy` (agy slot lock wait), `agy-busy` (an agy process acctshift did not start is running), `agy-journal-pending` (`rename` while `journal/agy-swap.json` exists), `overlay-in-use` (codex `add` or `login` while a codex process uses the overlay, or `add codex --import-home` while one uses DIR, §8.2), `registry-changed` (`config edit`). A `next` that exits 73 recorded nothing; the caller repeats the same call (§15.2) |
| 74 | vault or keystore unavailable, or a secret write failed: `keystore-unavailable` (keychain locked, macOS exit 36; Secret Service locked or absent; DPAPI failure; key file missing, or with a wrong owner or mode, §7.3; a passphrase or unlock needed in non-interactive mode; timeout), `vault-changed`, `agy-keyring-locked`, `slot-write-failed` (an agy slot could not be written or verified and was restored, or the agy save-back failed for a reason other than the key or a lock, such as a full disk; §8.3.2, §8.3.3, §13.3), `keychain-prompt-required` (macOS would prompt to read back an agy item; rolled back, §8.3.3), `keychain-line-too-long` (acctshift's own key item would exceed the `security -i` line limit, §7.4), `import-failed` (`add codex --import-home` could not remove the source after a cross-filesystem copy, §8.2) |
| 75 | every waiting candidate is time-limited. JSON names the soonest-free `account`, which may be `--from`, and `resetAtEpoch`. A one-account pool gives 75 naming that account (§9.3) |
| 77 | every remaining candidate needs a human: re-login, an expired token, a missing credential, or needs-attention (`needs-relogin`); for agy control verbs also `agy-slot-unregistered` |
| 78 | configuration or state error: `config-corrupt` (including a relative `clis.<cli>.bin` in accounts.json, §12.2), `config-newer-version`, `insecure-permissions` (a read-only command found a loose mode or a missing DACL), `wrong-owner`, `unsupported-filesystem` (including a mode a writer cannot tighten), `vault-corrupt`, `vault-corrupt-present`, `key-item-exists`, `unsupported-config` (`add claude --native` with `CLAUDE_CONFIG_DIR` set but empty, §8.1; a codex `ephemeral` credential store; a codex `mainHome` inside `<root>/homes/` when it is first initialised, §8.2) |
| 125 / 126 / 127 | `exec` / `run` only. 125: acctshift failed before the child started, for any of the conditions above or those of §12.1.1, whatever code a control verb would use; the `error.code` is in the status file and in the one stderr line (§12.1.1), and LimitShift's per-code actions are in §15.2. 126: the cli was found but is not executable (`not-executable`, `cmd-shim-unsupported`, `wsl-windows-binary`). 127: the cli was not found (`not-found`). LimitShift treats a 126 or 127 whose status file says `launched:false` as needs-human (§15.2); with `launched:true`, or with no status file, it is the cli's own status |
| other | `exec` / `run`: the cli's own exit code; a signal death gives 128+n |

Control verbs never exit 125–127, and `exec` and `run` never exit 64–78 for their own failures.

### 10.4 Flags per command

Value flags take `--name value` or `--name=value`; a value flag given twice keeps the last value. Boolean flags take no value (`--fix`) or an explicit `--name=false`. Types:
- *name*: an account name; *names*: comma-separated account names, in order;
- *time*: integer epoch seconds, RFC 3339, or a duration relative to now; *epoch*: integer epoch seconds or RFC 3339;
- *seconds*: integer seconds or a duration (`45s`, `2m`); *path*: a file or directory path.

**Global** (every command):

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--json` | bool | false; implied as in §10.1 | machine output (§11) |
| `--home DIR` | absolute path | `ACCTSHIFT_HOME`, else the OS default (§6.1) | the root directory; a relative path is 64 (125 for `exec`/`run`) |
| `--non-interactive` | bool | false; non-interactive anyway when stdin is not a TTY or `ACCTSHIFT_NONINTERACTIVE=1` | never prompt (§10.1) |
| `--debug` | bool | false (`ACCTSHIFT_DEBUG=1`) | redacted debug log to stderr; writers also append it to `logs/acctshift.log` (§10.1) |
| `--no-color` | bool | false | plain human output |
| `--contract N` | int | 1 | contract version of the JSON output (§11.1 rule 6) |
| `--version` | bool | false | print the version and exit 0; only without a command (after `self-update` it is that command's value flag) |
| `-h`, `--help` | bool | false | print usage and exit 0 |

**Selection and recording:**

| Flag | Commands | Type | Default | Meaning |
|---|---|---|---|---|
| `--pool a,b` | `list`, `status`, `pick`, `next`, `mark`, `exec`, `run` | names | every account of the cli | the candidates, in pool order (§9.3). `list` and `status` require a cli with it |
| `--prefer A` | `pick`, `exec` (without `--account`) | name | none | sticky preference (§9.3) |
| `--from A` | `next` | name | required | the account whose run just failed |
| `--model M` | `pick`, `next`, `mark`, `classify` | string | none | `pick`/`next`: the model of the run about to start (selection); `mark`: the limited model (scope); `classify`: the model of the classified run (scope) |
| `--limited-model L` | `next` | string | the `--model` value | the model that hit the limit (recorded scope) |
| `--limited-until T` | `next`, `mark` | time | none | a reset the caller parsed from this run's output (tier 2, §9.4) |
| `--reason R` | `next` | `limit` \| `auth` | `limit` | what to record when the evidence names no class (§9.3) |
| `--run-started-at T0` | `next`, `mark`, `classify` | epoch | now − 60 s | when the failing run started (§9.2, §9.4) |
| `--evidence-file F` | `next`, `mark`, `classify` | path, or `-` for stdin | none | the failing run's captured stdout and stderr, tail-bounded to 256 KB (§9.5) |
| `--exit N` | `next`, `mark`, `classify` | int | none | the cli's exit status |
| `--session ID` | `next`, `mark`, `classify` | string | none | the vendor session or thread id, for the artifact lookup of §9.5 |
| `--cwd DIR` | `next`, `mark`, `classify` | path | none (no Claude transcript lookup) | the run's working directory, for Claude's `projects/<slug>` (§9.5) |
| `--account A` | `mark` (required), `classify --record` (required), `exec`, `run`, `env` (required), `doctor` | name | none | the target account |
| `--override`, `--auth-failed`, `--ok`, `--clear` | `mark` | bool | false | the `mark` action; `--limited-until` is the fifth (§10.2) |
| `--record` | `classify` | bool | false | also store the result for `--account` (§9.2) |

**exec and run:**

| Flag | Commands | Type | Default | Meaning |
|---|---|---|---|---|
| `--slot-wait S` | `exec`, `run`, and the control verbs that take the agy slot lock (`add agy`, `login agy`, `remove agy`, `agy use`, `doctor --fix`) | seconds | `settings.slotWaitSeconds` (30) | how long to wait for the agy slot lock (§13.1); then 125 `slot-busy` / `agy-busy`, or 73 for control verbs |
| `--status-file P` | `exec` | path | none | write the status file (§11.2, §12.1.1). LimitShift MUST pass it. A path that cannot be written before launch (for example its directory does not exist) is 125 `usage`. `run` has no `--status-file` |
| `--track` | `exec` | bool | false | force the spawn path (§12.3), so the status file is rewritten after the child exits with `exitCode` and the post-run fields |
| `--allow-bare` | `exec` | bool | false | override `bare-ignores-token` (§8.1) |
| `--allow-apikeyhelper` | `exec` | bool | false | override `apikeyhelper-overrides-token` (§8.1) |
| `--allow-settings-env` | `exec` | bool | false | override `settings-env-overrides-token` (§8.1) and `agy-env-overrides-slot` (§8.3) |
| `--allow-base-url` | `exec` | bool | false | override `base-url-would-receive-token` (§12.5) |
| `--wait` | `run` | bool | false | when every account is capped, wait for the soonest reset and relaunch, instead of exiting 125 `all-capped` |

**Account management:**

| Flag | Commands | Type | Default | Meaning |
|---|---|---|---|---|
| `--accept-notice` | `add` | bool | false | accept the provider notice (Appendix F) without a prompt; the only way without a TTY |
| `--label L` | `add`, `login` | string | none (decoded where the vendor file allows) | the account's label. Required for user-asserted identities; on `login` it MUST equal the current label (§8) |
| `--token-stdin` | `add`, `login` | bool | false | read the secret as one line from stdin (secret-bearing kinds, §8) |
| `--native` | `add` (claude, codex, gemini, copilot) | bool | false | register the cli's default login; the same as `--kind native` |
| `--kind K` | `add` | claude `token` \| `login-slot`; codex `home` \| `access-token` \| `api-key`; gemini `home` \| `api-key`; copilot `token` \| `gh`; and `native` for these four clis | claude `token`, codex `home`, gemini `home`, copilot `token`; agy is always `slot` | the account kind (§8) |
| `--experimental` | `add` | bool | false | required for experimental kinds (claude `login-slot`) |
| `--force` | `add claude` | bool | false | allow a label another claude account already uses (§8.1) |
| `--browser` | `add codex`, `login codex` | bool | false | the PKCE browser flow instead of device auth (§8.2) |
| `--import-home DIR` | `add codex` | path | none | adopt an existing Codex home by moving its `auth.json` (§8.2) |
| `--capture-current` | `add agy` | bool | false | register the account now in agy's slot, without running agy (§8.3.4) |
| `--expires DATE` | `add copilot` | RFC 3339 or `YYYY-MM-DD` | none | the PAT's expiry, for `doctor` warnings (§8.5) |
| `--gh-user LOGIN` | `add copilot --kind gh` | string | required | the gh account whose token `exec` fetches (§8.5) |
| `--gh-host HOST` | `add copilot` (kinds `token` and `gh`) | string | `github.com` | the GitHub host, stored as `identity.host`; a host other than `github.com` sets `COPILOT_GH_HOST` for runs (§8.5) |
| `--key-source S` | `add` (only when it creates the vault) | `keychain` \| `secret-service` \| `dpapi` \| `key-file` | `ACCTSHIFT_KEY_SOURCE`, else the OS default (§7.3) | the new vault's key source |
| `--force-new-vault` | `add` | bool | false | create a vault although `vault.v1.bin.corrupt-*` exists (§7.3) |
| `--new-identity` | `login` | bool | false | accept a different identity: add-time dedupe, then clear all records (§8) |
| `--yes` | `remove` | bool | false | do not ask; required non-interactively (else 64) |
| `--keep-home` | `remove` | bool | false | keep the overlay directory; its id is never reused (§6.2) |
| `--sign-out-slot` | `remove agy` | bool | false | sign the account out of agy's slot and park the bytes as `agy/_unregistered/<email>` (§8.3.4) |

**Other commands:**

| Flag | Commands | Type | Default | Meaning |
|---|---|---|---|---|
| `--format F` | `env` | `sh` \| `ps` \| `cmd` \| `json` | `ps` on Windows, else `sh` | the output format (§12.7) |
| `--reveal-secrets` | `env` | bool | false | print secret values; opens the keystore |
| `--fix` | `doctor` | bool | false | apply the repairs of §10.2 (writer) |
| `--accept` | `notice` | bool | false | accept the current notice version without a prompt; the only way without a TTY (§10.2) |
| `--history` | `status` | bool | false | append recent events from `events.jsonl` (§9.6); human output only, ignored with `--json` |
| `--to SOURCE` | `vault migrate` | key source, as `--key-source` | required | the new key source (§7.3) |
| `--to FILE` | `vault export` | path | required | the bundle to write (§7.3) |
| `--check` | `self-update` | bool | false | report whether an update exists; change nothing |
| `--version X` | `self-update` | version | the latest release | the target version (§17.7) |
| `--allow-downgrade` | `self-update` | bool | false | allow a target older than the running version |
| `--record-install METHOD` | `self-update` | `script` | none | offline: create the root and write `install.json` (§17.6) |
| `--path DIR` | `self-update --record-install` | path | required | where the installer put the binary |

`order`, `rename`, `enable`, `disable`, `agy use`, `vault status`, `vault import FILE`, `config` and `completion` take only positional arguments and the global flags (`agy use` also `--slot-wait`).

## 11. Output contract ("contract 1")

### 11.1 Framing rules (MUST)

1. With `--json`, stdout carries **exactly one line** of JSON (no BOM), terminated by `\n`, and nothing else. The line is **pure ASCII**: every code point above U+007E is written as a `\uXXXX` escape (surrogate pairs for astral characters). Windows PowerShell 5.1 decodes a native command's stdout with the OEM code page, so raw UTF-8 would arrive mangled; a Pester test under 5.1 round-trips a U+2019 snippet.
2. Every response object has `"contract": 1` at its top level. Absent values are `null`, not omitted. Arrays are always arrays, even with one element or none.
3. Keys are camelCase. **No two keys in one object may differ only in case** (Windows PowerShell 5.1 `ConvertFrom-Json` rejects that) [R08 C3].
4. Every timestamp is given twice: `fooEpoch` (integer seconds) and `foo` (RFC 3339 UTC). Both forms MUST denote the same instant (a schema test checks every pair). Callers in bash and PowerShell SHOULD use the epoch form, because PowerShell 7 silently converts ISO strings into DateTime [R03 C8].
5. Errors still print one JSON line, together with a non-zero exit code:
   - `pick` and `next` print their full response shape (§11.2) on 0 and 75, where `error` is `null`, and on 69 and 77, where `error` is set. `mark` prints the same shape on 0, and on `--clear`'s 65 `expired` with `error` set.
   - `doctor` prints its own shape whenever it ran, including `doctor --fix`'s 73, 74 and 78 (§11.2).
   - Every other failure of any command (for example 64, 73, 74 or 78) prints `{"contract":1,"error":{"code":"<kebab-id>","message":"<human text>","hint":"<what to do>"}}`. `hint` may be `null`.
6. Additive changes (new fields, new enum values listed as "may grow") stay contract 1. Removing or renaming a field, or changing a type or exit-code meaning, requires contract 2. A binary MAY serve several contracts with `--contract N`.
7. `exec`, `env --format sh|ps|cmd` and `run` never write JSON to stdout; their stdout is the child's (or the env script). `exec`'s machine-readable result is its status file (§11.2).
8. **Read-only commands:** `version`, `list`, `status`, `pick`, `doctor` without `--fix`, `classify` without `--record`, `vault status`, and `notice` without `--accept` (unless the user answers `y` at its prompt).
   - They take no lock and make no state, vendor or file-system write: no rename, migration, backup, recreation, `chmod` or re-ACL. They migrate an older file version in memory only, and never create the root. Their `--debug` log goes to stderr only (§10.1).
   - A file they cannot parse gives 78 `config-corrupt`, and a loose mode or missing DACL gives 78 `insecure-permissions`; they change nothing (§6.1, §6.4). `version` still works, and `doctor` reports these as findings.
   - LimitShift's dry-run and `--validate-only` can therefore call them without side effects.

   **Writers:** `next`, `mark`, `enable`, `disable`, `order`, `config`, `classify --record`, `doctor --fix`, `notice --accept` (or `notice` answered `y`), `exec`, `add`, `login`, `remove`, `rename`, `agy use`, `vault migrate`, `vault export`, `vault import`, `run`, `env` (overlay link refresh only) and `self-update`. A writer changes accounts.json and state.json only under `state.lock`, and only a writer holding it may quarantine or recreate a file (§6.3, §6.4).

### 11.2 Responses

The examples share one scenario (the §6.3 snapshot): claude `main` (id `e04b7d93`, `native`) and `work` (id `3f9a01c2`, `token`). At 10:40Z on 2026-10-07, `work` hit its five-hour limit, which resets at 3pm Europe/Kyiv (12:00Z). Since 10:20Z it also has a weekly Opus record that resets on Oct 12 at 9am Kyiv (06:00Z).

**`version --json`**
```json
{"contract":1,"name":"acctshift","version":"0.3.0","commit":"abc1234","goos":"darwin","goarch":"arm64",
 "root":"/Users/me/Library/Application Support/acctshift","rootSource":"default",
 "contracts":[1],"supportedClis":["claude","codex","agy","gemini","copilot"],"experimental":["agy","gemini","copilot"],
 "capabilities":{
   "claude":{"sessionPortable":true,"lockScope":"none","usageProbe":"per-account"},
   "codex":{"sessionPortable":false,"lockScope":"none","usageProbe":"none"},
   "agy":{"sessionPortable":false,"lockScope":"machine","usageProbe":"none","dataDir":null}},
 "stderrCatalogue":["acctshift: error unknown-account: no such account is registered","…"]}
```
- `supportedClis` lists every cli `exec` can run on this OS. `experimental` ⊆ `supportedClis` marks clis whose rotation is unverified on this OS: agy until that OS's V-A items pass (§8.3.5), and gemini and copilot (tier 2). LimitShift's auto mode routes an experimental cli only when the runner lists `accounts` explicitly, and `--validate-only` prints a WARNING (§15.4). The one exception is agy: while acctshift has at least one agy account registered, every agy runner is routed, with or without `accounts`, under `auto` or `required`, because an unwrapped agy would race slot swaps; `--validate-only` then prints a WARNING that agy rotation is experimental on this OS.
- `capabilities` let callers adapt without hard-coding vendor knowledge. There is one entry per cli in `supportedClis` (gemini and copilot are left out of this example).
  - `sessionPortable` is the cli's default for a move between two of its accounts. `next` reports the actual value for each move.
  - `lockScope` = `machine` means runs of that cli serialize across all queues on the machine.
  - `dataDir` (agy only) tells LimitShift where agy's transcripts are. It is always the user's default, and acctshift never moves it. The path comes from agy `facts.go` and is `null` on an OS whose path V-A2 has not yet recorded (macOS and Windows today, §8.3.1), as in this darwin example.
  - `usageProbe` = `per-account` means each account entry says whether `claude -p /usage` works for it. It is true only for `native`; `token` is inference-only [R04 C5], and `login-slot` is false because short-lived probes can spend its refresh token [R09 C3]. LimitShift never runs `/usage` for a routed claude runner (§15.6); the field is informational for standalone use.
- `stderrCatalogue` lists, verbatim, every line `exec` can write to stderr. Messages interpolate nothing (§12.1.1), so the list is exhaustive. Each release also ships it as `testdata/stderr-catalogue.txt`. LimitShift's own test suite asserts that its limit and auth regexes match none of these lines.

**`list [cli] --json`** (snapshot at 2026-10-07T10:45:00Z)
```json
{"contract":1,"cli":"claude","poolSize":2,"rotationPossible":true,"poolDropped":[],
 "accounts":[
  {"name":"main","id":"e04b7d93","kind":"native","label":"me@example.com","state":"ready","reason":null,"enabled":true,"usageProbe":true,
   "limitedUntil":null,"limitedUntilEpoch":null,"limitType":null,"limitSource":null,"limits":[],
   "expiresSoon":false,"expiresAt":null,"expiresAtEpoch":null,"lastUsedAt":null,"lastUsedAtEpoch":null},
  {"name":"work","id":"3f9a01c2","kind":"token","label":"me@work.example","state":"limited","reason":"limit","enabled":true,"usageProbe":false,
   "limitedUntil":"2026-10-12T06:00:00Z","limitedUntilEpoch":1791784800,"limitType":"seven_day_opus","limitSource":"text",
   "limits":[
    {"kind":"limit","scope":"account","until":"2026-10-07T12:00:00Z","untilEpoch":1791374400,"tier":3,"limitType":"five_hour","limitSource":"structured"},
    {"kind":"limit","scope":"model:opus","until":"2026-10-12T06:00:00Z","untilEpoch":1791784800,"tier":2,"limitType":"seven_day_opus","limitSource":"text"}],
   "expiresSoon":false,"expiresAt":"2027-10-01T10:05:00Z","expiresAtEpoch":1822385100,"lastUsedAt":"2026-10-07T10:40:00Z","lastUsedAtEpoch":1791369600}]}
```
- Without a cli, `list` returns `{"contract":1,"clis":[{…per-cli object without contract…}]}`.
- An account entry has: `name`, `id` (immutable, §6.2), `kind`, `label`, `state` and `reason` (§9.2), `enabled`, `usageProbe`, the summary fields, `limits`, `expiresSoon`, `expiresAt`, and `lastUsedAt`.
- `limits` lists every active record as `{kind, scope, until, untilEpoch, tier, limitType, limitSource}` (§9.1). An auth-suspect record has `kind:"auth-suspect"`, `limitType:null` and `limitSource:"auth"`.
- The summary fields (`limitedUntil`, `limitedUntilEpoch`, `limitType`, `limitSource`) describe the record with the latest `until` among those that block a model-less request. That is why `work` shows the Opus record: a run without `--model`, or with an Opus model, cannot use `work` before Oct 12, while `pick --model <a Sonnet model>` can use it from 12:00:30Z.
- `untilEpoch` and `limitedUntilEpoch` are the stored reset, without the 30 s skew margin (§9.3).

**`status [cli] --json`**: the `list` object, plus:
- at the top level, `vault: {exists, keySource, keyId, keyFilePath}` (the `vault status` fields, from the header only) and `notice: {accepted, version, acceptedAt, acceptedAtEpoch}`, where `accepted` is true when `version` is the binary's current notice version;
- in the agy per-cli object, `agySlot: null | {owner, store, writtenAt, writtenAtEpoch, saveBackPending}`. `owner` is the name of the registered account whose id state.json records, or `null`. It is only the hint of §6.3: `status` never opens the keystore and never reads the slots;
- in every account entry, `relogin: null | {reason, since, sinceEpoch}`, `attentionCode`, `authStrikes`, `lastStrikeAt`/`lastStrikeAtEpoch`, `lastOkAt`/`lastOkAtEpoch`, `utilization: null | {<window>: fraction, observedAt, observedAtEpoch}` (display only, §9.3), and for agy `wrongAccount: null | {expected, found, observedAt, observedAtEpoch}` (emails, §8.3.3).

Without a cli, `status` returns `{"contract":1,"vault":{…},"notice":{…},"clis":[…]}`.

**`pick` / `next` / `mark --json`** (`next claude --from work --model M --evidence-file F --exit 1 --run-started-at T0 --session U --cwd D` at 10:40Z, where M is a model in the `sonnet` bucket; the tier-3 reset comes from the Claude transcript that `--session` and `--cwd` locate, §9.5)
```json
{"contract":1,"cli":"claude","account":"main","previous":"work","switched":true,"available":true,
 "resetAt":null,"resetAtEpoch":null,"poolSize":2,"rotationPossible":true,"poolDropped":[],"preferIgnored":false,
 "sessionPortable":true,"sessionPortability":"likely",
 "recorded":{"account":"work","class":"limit","kind":"limit","scope":"account","until":"2026-10-07T12:00:00Z","untilEpoch":1791374400,
             "tier":3,"limitSource":"structured","resetConfidence":"exact","limitType":"five_hour","relogin":null,"attentionCode":null},
 "accounts":[
  {"name":"main","state":"ready","reason":null,"limitedUntil":null,"limitedUntilEpoch":null,"limits":[]},
  {"name":"work","state":"limited","reason":"limit","limitedUntil":"2026-10-12T06:00:00Z","limitedUntilEpoch":1791784800,
   "limits":[
    {"kind":"limit","scope":"account","until":"2026-10-07T12:00:00Z","untilEpoch":1791374400,"tier":3,"limitType":"five_hour","limitSource":"structured"},
    {"kind":"limit","scope":"model:opus","until":"2026-10-12T06:00:00Z","untilEpoch":1791784800,"tier":2,"limitType":"seven_day_opus","limitSource":"text"}]}],
 "error":null}
```
The same call with `--pool work` (a one-account pool) exits 75:
```json
{"contract":1,"cli":"claude","account":"work","previous":"work","switched":false,"available":false,
 "resetAt":"2026-10-07T12:00:30Z","resetAtEpoch":1791374430,"poolSize":1,"rotationPossible":false,"poolDropped":[],"preferIgnored":false,
 "sessionPortable":true,"sessionPortability":"yes","recorded":{…as above…},"accounts":[{…work as above…}],"error":null}
```
Field rules:
- `account`: the chosen account. On 75 it is the soonest-free account, which may be `--from` (§9.3). It is `null` on 69 and 77, and always for `mark`.
- `available`: true on exit 0; false on 69, 75 and 77; `null` for `mark`.
- `previous`: `--from` for `next`; `null` for `pick` and `mark`.
- `switched`: true when `account` and `previous` are both non-null and differ. It is always false for `pick` and `mark`.
- `resetAt` / `resetAtEpoch`: on 75, the chosen account's effective reset **plus the 30 s skew margin**, the first instant acctshift itself will return it as usable (§9.3); otherwise `null`. Stored values (`recorded.untilEpoch`, `limitedUntilEpoch`, `limits[].untilEpoch`) never include the margin. Callers add their own sleep buffer.
- `poolSize` and `rotationPossible` (true when at least 2 pool accounts are neither `disabled` nor `needs-*`, §9.3); `poolDropped`: the unknown `--pool` names that were dropped, else `[]`.
- `preferIgnored`: true when `pick` ignored `--prefer` (unknown, disabled, non-member or unusable, or agy's live slot owner won, §9.3); false otherwise and always for `next` and `mark`.
- `sessionPortability`: `yes`, `likely`, `possible`, `unlikely` or `no`, for the move from `previous` to `account` (§8). `sessionPortable` is true only for `yes` and `likely`. A move to the same account is `yes`. Both are `null` for `pick`, for `mark`, and when `account` is `null`.
- `recorded`: `null` for `pick` and for an unknown `--from`. Otherwise it says what this call stored for `--from` (`next`) or `--account` (`mark`, `classify --record`):
  - `class`: the evidence class that decided (§9.3 table). Without one, it is `limit` or `auth` from `--reason`, `--limited-until` or `--auth-failed`; for `mark --ok` it is `ok` and for `mark --clear` it is `clear`. A class that stores nothing (for example `transient` after a codex refresh race, §9.2) still appears here.
  - `kind`, `scope`, `until`, `untilEpoch`, `tier`, `limitSource`, `resetConfidence`, `limitType`: the record this call wrote, after the merge rule of §9.4; all `null` when it wrote none.
  - `relogin`: the reason this call set (`rejected`, `refresh-dead`), else `null`. `attentionCode`: the code this call set, else `null`.
- When `recorded.scope` is `account`, the caller SHOULD skip its remaining models on that account (§15.2).
- `accounts`: every account named by `--pool` after dropping unknown names, or every account of the cli, in candidate order, disabled ones included. Each entry is `{name, state, reason, limitedUntil, limitedUntilEpoch, limits}` with the `list` meanings.
- `error`: `null`, or `{code, message, hint}` on 69 (`empty-pool`, `unsupported-cli`, `notice-not-accepted` with the hint `acctshift notice --accept`), 77 (`needs-relogin`) and `mark --clear`'s 65 (`expired`).
- `mark` returns this shape with `recorded` filled and `account:null` (§9.3).

**`enable` / `disable` / `order --json`** → `{"contract":1,"cli":"claude","accounts":[…]}`, with the `list` account entries after the change.

**`vault status --json`** → `{"contract":1,"exists":true,"keySource":"keychain","keyId":"…","keyFilePath":null}`. With no vault, `exists` is false and the other fields are `null`. It reads only the vault header (§7.3).

**`env <cli> --account A --format json`** (standalone/diagnostic; not part of the LimitShift contract)
```json
{"contract":1,"cli":"claude","account":"work","set":{"CLAUDE_CODE_OAUTH_TOKEN":"<redacted:claude/3f9a01c2>"},
 "unset":["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_RETRY_WATCHDOG","…"],"secretNames":["CLAUDE_CODE_OAUTH_TOKEN"]}
```
- Values are revealed only with `--reveal-secrets`. A redacted value names the account's `secretId`.
- When the plan has a post-run hook or holds a lock for the run (agy slot, gemini `home`, Windows codex copy mode), `env` exits 69 with `error.code:"requires-exec"` (§12.7).

**`classify --json`**
```json
{"contract":1,"cli":"codex","class":"limit","scope":"account","limitType":"usage_limit",
 "resetAt":"2026-10-07T15:45:00Z","resetAtEpoch":1791387900,"tier":3,"limitSource":"structured","resetConfidence":"exact",
 "retrySameAccount":false,"rotate":true,"attentionCode":null,
 "snippet":"You’ve hit your usage limit. Try again at 3:45 PM.","sessionId":"0199…","recorded":null}
```
- `class` is one of: `ok`, `limit`, `transient`, `auth`, `auth-definitive`, `blocked` (sets `attentionCode`, so the account becomes `needs-attention`), `session-lost`, `resume-incompatible`, `config-error`, `error`, `unknown`. It may grow. `blocked` is the only name for a provider block; there is no `blocked-account` (§9.4).
- `resetAt` / `resetAtEpoch` are the reset the evidence states, exactly as a record would store it (no skew margin); `tier` is the tier that reset would get (§9.4). All three are `null` when the class carries no reset.
- `retrySameAccount` and `rotate` tell a caller without its own policy what to do; for example Copilot `session_quota_exceeded` is class `error` with `rotate:false` (§9.4).
- `snippet` is masked (§14.4) and at most 200 characters. (The example shows the decoded text; on the wire the `’` is `\u2019`, rule 1.)
- `recorded` is `null` without `--record`; with it, it has the `next` meaning.
- `classify` exits 0 for every class, and 66 `evidence-unreadable` when the evidence file cannot be read.

**`doctor --json`** → `{"contract":1,"ok":false,"root":"…","rootSource":"default","findings":[{"severity":"error|warn|info","cli":"agy","account":null,"code":"secret-service-locked","message":"…","hint":"…"}]}`
- `doctor` without `--fix` exits 0 whenever it ran; only a usage error is non-zero (64). Callers read `ok`, which is false when any finding has severity `error`.
- `doctor --fix` exits 0 when every repair it attempted succeeded or nothing needed one. Otherwise it exits 73, 74 or 78 with the code of the first repair that failed (§10.2), and still prints this shape: the failed repair stays an `error` finding whose `code` is that `error.code`. LimitShift only calls `doctor --json`, never `--fix`.

**`notice --json`** → `{"contract":1,"notice":{"accepted":true,"version":1,"acceptedAt":"2026-10-01T10:05:00Z","acceptedAtEpoch":1790849100}}`: the `status` notice object, after any acceptance this call made. The notice text is human output only. A declined or unanswered notice exits 65 `notice-not-accepted` with the plain error object (rule 5).

**exec `--status-file`** (one contract-1 line; semantics in §12.1.1)
```json
{"contract":1,"launched":true,"cli":"agy","account":"a","exitCode":0,"error":null,"addedArgs":[],
 "foreignAgy":false,"wrongAccount":null,"postRunError":null}
```
- On the execve path it is written just before execve with `launched:true` and `exitCode:null`. If execve returns, exec rewrites it with `launched:false` and the error, then exits 125, 126 or 127. On the spawn path it is rewritten after the child exits.
- `account`: the account exec ran or tried to run (the picked one without `--account`), else `null`. `exitCode`: the status exec exits with (the child's, 128+n, or 125–127 when `launched` is false).
- `error`: `null`, or `{code, reason}` for a failure before the child started. `reason` refines the code, for example `missing` or `expired` for `needs-relogin`, else `null`.
- `addedArgs`: the arguments exec prepended, at most the single secret-isolation argument of §7.6, else `[]`.
- `foreignAgy`: true when agy's shared fast path ran while an agy process acctshift did not start was running (§8.3.3); false otherwise.
- `wrongAccount`: `null`, or `{expected, found, observedAt, observedAtEpoch}` (agy; emails, §8.3.3).
- `postRunError`: `null`, or `{code, reason}` when a post-run hook failed or was skipped (for example `save-back-failed`, `agy-slot-unregistered`, `copy-back-conflict`, `copy-back-skipped`, `copy-back-failed`; `reason` refines the code, else `null`). Post-run failures never change the exit status.

### 11.3 Caller recipes

LimitShift exports `ACCTSHIFT_NONINTERACTIVE=1` for every call. It omits `--pool` when the runner has no pool and `--limited-until` when it parsed no reset from this run's output. It passes `--session` and `--cwd` for claude and codex only (§15.2), so `next` can read the transcript or rollout (§9.5). Every exit other than 0 and 75 goes to §15.2's per-code rules; a cli runs unwrapped only under the legacy rule there.

**bash (jq):**
```bash
export ACCTSHIFT_NONINTERACTIVE=1
out=$("$ACCTSHIFT" next claude --from "$acct" --model "$next_model" --limited-model "$model" \
        --evidence-file "$last_run_file" --exit "$cli_rc" --run-started-at "$run_start" \
        ${sid:+--session "$sid" --cwd "$project_path"} \
        ${pool:+--pool "$pool"} ${parsed_reset:+--limited-until "$parsed_reset"} --json); rc=$?
case $rc in
  0)  acct=$(jq -r .account <<<"$out") ;;                                         # switch now
  75) acct=$(jq -r .account <<<"$out"); wake=$(jq -r .resetAtEpoch <<<"$out") ;;  # rest until wake, then run on acct
  *)  code=$(jq -r '.error.code // empty' <<<"$out" 2>/dev/null) ;;               # 69/73/77/78/...: §15.2
esac
```

**PowerShell 5.1 / 7** (StrictMode 2.0-safe):
```powershell
$env:ACCTSHIFT_NONINTERACTIVE = '1'
$acctArgs = @('next', 'claude', '--from', $acct, '--model', $nextModel, '--limited-model', $model,
              '--evidence-file', $lastRunFile, '--exit', $cliRc, '--run-started-at', $runStart, '--json')
if ($sid) { $acctArgs += @('--session', $sid, '--cwd', $projectPath) }   # claude and codex only (§15.2)
if ($pool) { $acctArgs += @('--pool', $pool) }
if ($parsedReset) { $acctArgs += @('--limited-until', $parsedReset) }
$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
try { $raw = & $AcctShift @acctArgs 2>$null; $rc = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
$j = $null; try { $j = (@($raw) -join "`n") | ConvertFrom-Json } catch {}
if ($rc -eq 0) { $acct = $j.account }
elseif ($rc -eq 75) { $acct = $j.account; $wake = [DateTimeOffset]::FromUnixTimeSeconds([long]$j.resetAtEpoch).LocalDateTime }
```
`$wake` is a local `[datetime]`, the type LimitShift's ps1 runners keep in `$limitedUntil[]` and pass to their wait functions (§15.3).

---
