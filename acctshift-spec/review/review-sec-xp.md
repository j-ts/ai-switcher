# LENS: security and secrets (vault, key sources
I read all of SPEC.md and checked it against DECISIONS D4–D7 and D10 and research reports 04, 05, 06, 07 and 09. I found 5 blockers, 21 majors and 15 minors.

**Blockers**
1. The vault key items have one fixed name per OS user, and they are written with overwrite semantics (`-U`, `replace=true`). Creating a vault under any other `ACCTSHIFT_HOME` silently destroys the existing vault's key. The spec's own contract tests do exactly that on a developer's Mac, and Claude setup-tokens exist only in the vault.
2. The agy shared/exclusive lock decision is a TOCTOU. Shared holders can also write the slot during recovery, and "foreign process" is undefined. Any of these can cause wrong-account runs.
3. `add agy` takes no lock, writes no journal and never clears the slot. That pushes the user towards agy's `/logout` and races concurrent `exec agy` runs.
4. When the keyring is present but locked, the spec resolves agy to file mode. agy itself can still unlock the keyring through a prompt and read a stale account.
5. Gemini's encrypted-storage mode keeps every overlay's credential in one shared keychain item.

**Majors**
- **Wrong account:** inherited `CODEX_HOME` / `GEMINI_CLI_HOME` for native runs; Claude settings `env` and `--settings` re-introduce scrubbed variables; `gh` kind can return a classic PAT; unrestricted `extraEnv`; a missing agy language-server token file; the user's own unregistered agy login is displaced.
- **Credential loss:** journal recovery runs before the foreign-process check; a stale vault header after `vault migrate`; Secret Service `session` collection; `rename` moving keyring-keyed homes; codex dedupe deletes the newest login; the `/usage` probe through `exec`.
- **Exposure:** redactor patterns are incomplete and only the debug logger is covered; `ANTHROPIC_BASE_URL` can send the 1-year token to a third-party host; env tokens are inherited by agent tools, MCP servers and logs; the threat model leaves out that the launched agent can decrypt every account's secrets; the installer puts a GitHub token in argv; installer verification is circular.
- **Correctness:** umask 077 and `RLIMIT_CORE=0` leak into the child; the macOS "never open any OS dialog" MUST is unimplementable.

**Minors:** wrap nonce and AAD are unspecified; DPAPI path contradicts itself and the Windows install dir sits under the root; key-file permission and ownership rules break CI mounts; `ErrDot` is treated as not-found only on Windows; test-only keystore overrides are env-gated in release builds; input method for non-claude secrets is unspecified; scrub-list gaps; self-update version binding; decrypted plaintext stays in memory on the spawn path; command list contradictions; `wrongAccount` is never surfaced to the caller; `remove` leaves keyring items orphaned; Windows junction link test; pre-create contradiction; codex import across filesystems (EXDEV); `key-file` protection overstated; shared agy runs not gated on V-A8.

## 1. [blocker] §7.3 Key sources (Rules), §7.4 Writes, §6.4, §18.2 Contract tests
PROBLEM: Vault key items have one fixed name per OS user and are written with overwrite semantics. Creating a vault in any second root silently replaces the key of the existing vault, making every stored secret unrecoverable, including Claude setup-tokens, which exist only in the vault.
EVIDENCE: §7.3: keychain 'service `acctshift`, account `vault-key-v1`'; secret-service '{service:"acctshift", username:"vault-key-v1"}'; key-file '${XDG_CONFIG_HOME:-~/.config}/acctshift/vault.key'. None of these depend on `ACCTSHIFT_HOME`, yet §6.1 allows any root. §7.4 writes 'add-generic-password -U …' (-U updates an existing item), and agy's Secret Service pattern is 'CreateItem(replace=true)'. The only guard is 'never generates a new key when the recorded one is missing', which does not cover the case 'key exists, vault absent'.

Concrete triggers:
- §18.2 runs 'the real binary … against a temporary ACCTSHIFT_HOME', and §19.4 makes developers run the contract tests before each commit. On macOS the default `keychain` source then overwrites the developer's real `acctshift/vault-key-v1`.
- §6.4 renames an unparseable file to `.corrupt-<epoch>`, and the next `add` creates a new vault and key.
- Two concurrent first `add`s race.
- §7.3 'vault migrate … then deletes the old key item' can delete a key that another root's vault still uses.

§7.1: Claude 'never saves them to disk, so acctshift holds the only copy'.
FIX: Replace the key-naming and creation rules in §7.3 with:
1. 'The key item is named per vault from the header key id: macOS/Secret Service account `vault-key-v1-<hex(keyId)>`; key-file `vault-<hex(keyId)>.key` (or the exact path recorded in the header when ACCTSHIFT_KEY_FILE was used); DPAPI `<root>/vault.key.dpapi`.'
2. 'Vault creation runs entirely under vault.lock. Re-check that no vault exists, generate keyId and key, then store the key with create-only semantics: macOS `add-generic-password` WITHOUT -U, with exit 45 being fatal `key-exists`; Secret Service `SearchItems` miss then `CreateItem(replace=false)`; key-file `O_CREAT|O_EXCL` mode 0600. Only then write the vault.'
3. 'vault migrate deletes only the item named by the migrated vault's key id.'
4. 'If `<root>/vault.v1.bin.corrupt-*` exists, creation refuses with exit 78 unless `--force-new-vault`.'

In §18.2 add: 'Contract tests MUST set ACCTSHIFT_KEY_SOURCE=key-file and ACCTSHIFT_KEY_FILE inside the temp dir, or use the fake-keystore build, and CI asserts the user's login keychain and Secret Service are untouched.'

## 2. [blocker] §8.3.3 The swap (Lock modes), §13.1 Locks, §13.3 agy swap journal
PROBLEM: The shared/exclusive choice is a TOCTOU, shared holders are allowed to write the slot, and the foreign-process rule has no defined test. Any of these can launch agy as the wrong account.
EVIDENCE: §8.3.3: 'A run whose account already equals the live slot owner takes the lock shared'. The spec never says how or when 'live slot owner' is determined (state.agySlot.owner, or a slot read before the lock). Another swapper can change the slot between that check and acquiring the shared lock.

Steps 1 (recovery, which 'restores agy/_last' into the slot) and 3/9 (save-back) apply to shared holders too. So two shared holders can run recovery concurrently, and one can restore `_last` while another holder's agy is running.

Step 2: 'not started by an acctshift holding the lock' cannot be tested:
- shared holders all write '{"pid":…}' into the same lock file (§13.1), clobbering each other;
- descendants that outlive their acctshift (the remote-control daemon; §8.3.3 step 8 says the lock is not inherited) are neither clearly ours nor foreign.
FIX: Replace 'Lock modes' with a normative algorithm:
1. Acquire agy-slot.lock shared.
2. If journal/agy-swap.json exists, release and take the exclusive path.
3. Under the shared lock, read every reachable slot. Run shared only if every slot that holds a credential carries the requested email. Otherwise release, create the intent file, acquire exclusive, and redo recovery, the foreign-process check and the full read. Never decide from state.agySlot.
4. Slot writes (recovery restore, swap, delete) happen ONLY under the exclusive lock. Shared holders may write only the vault, under vault.lock.
5. Foreign-process rule: under the exclusive lock, ANY running process matching the facts.go agy names is foreign, and the run refuses. Under the shared lock, each holder records `{pid, childPid, childStartTime}` in `locks/agy-slot.holders/<pid>.json` (not in the lock file). Any agy process that is not a descendant of a recorded live child is foreign.

## 3. [blocker] §8.3.4 Add and login (`acctshift add agy <name>`)
PROBLEM: The add flow takes no slot lock, does no foreign-process check, writes no journal, and runs agy while the slot still holds the live account. To sign in, the user must use agy's /logout. Concurrent `exec agy` runs see the slot change mid-run, and a crash or Ctrl+C leaves the new account live with the old content only in a 'temporary vault area'.
EVIDENCE: §8.3.4 steps 2–6 contain no lock, no step-2 foreign-process check and no journal. §13.1 lists only 'login agy, remove' as slot-lock users.

Step 3 says 'Tell the user to sign in in the agy session that opens'. But agy starts already signed in with whatever the slot holds, and R05 C10 / §(b) say sign-in and sign-out happen through the /login and /logout slash commands, with /logout clearing the stored entry. Neither the spec nor R05 confirms whether /logout also revokes the token server-side.

Step 6 'Restore the previous slot content' has no recovery path if acctshift dies first, because §13.3 handles only swap journals.
FIX: Rewrite steps 2–6:
'2. Take agy-slot.lock exclusive (73 on timeout) and run the §8.3.3 foreign-process check.
3. Save back every reachable slot (§8.3.3 step 3), write journal {op:"add", saved:[secretIds], stores:[…], paths:[…]}, then DELETE every slot so that agy starts signed out. Never tell the user to use agy's /logout.
4. Run agy attached. The user signs in, then exits.
5. Read every slot. Exactly one must hold a credential with a new email; store it as the account's snapshot.
6. Write the saved-back content into the slots it came from, verify read-back, clear the journal, release the lock.'

In §13.3 add: 'op:add journals are recovered by restoring the saved-back content.' Apply the same rule to `login agy`. `--capture-current` takes the shared lock and only reads.

## 4. [blocker] §8.3.2 Which slot agy will read
PROBLEM: A keyring that is present but locked is resolved to file mode and left out of the write set. agy, whose detectors did not fire, will still try the keyring. go-keyring calls Unlock, so a GUI unlock prompt (or the macOS SecurityAgent dialog) can unlock it, and agy then reads the stale account still stored there.
EVIDENCE: §8.3.2: 'Mode is also file if the keyring is unreachable or locked within a 3 s probe: Linux: … Locked checked …; macOS: security exits 36, 37 or 50'.

'Write set = the resolved slot plus every other reachable slot that currently holds an agy credential'. A locked keyring is not reachable, so its stale content is neither written nor deleted.

R05 §(b): go-keyring 'stores into the login collection (unlocked first)'. R07 §4: go-keyring calls Unlock, and its 'handlePrompt' waits for the user. The post-run email check (step 9) detects the problem only after the wrong account has already been used.
FIX: Add to §8.3.2:
'If the probe finds the keyring present but locked (Linux: collection exists with Locked=true; macOS: exit 36 with none of SSH_TTY/SSH_CLIENT/SSH_CONNECTION set) and none of agy's bypass detectors fire for the child environment, acctshift MUST NOT resolve to file mode. It fails closed: `exec` exit 125 `slot-unverifiable`, control verbs 74, with the unlock hint.'

File mode may be chosen for an unreachable keyring only when agy is also certain to bypass it (a detector fires, Windows 1312, or no bus at all). Add `slot-unverifiable` to the §12.1.1 table and Appendix E.

## 5. [blocker] §8.4 gemini (Overlay home, Environment), Appendix A.4
PROBLEM: With GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true, Gemini keeps OAuth credentials in a single OS keychain item that GEMINI_CLI_HOME does not change. Every gemini `home` overlay therefore shares one credential: wrong-account runs, and two owners of one refresh token.
EVIDENCE: R06 C1: 'The OS keychain (service gemini-cli-oauth, account main-account) and the encrypted fallback file gemini-credentials.json are used only when GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true'. R06 says to 'refuse it, or swap the keychain entry under a lock'.

The spec instead lists '`gemini-credentials.json` (if encrypted mode)' under 'Per-account real files', as though encrypted mode were per-account. Appendix A.4 neither unsets nor checks the variable. The fallback file's key is scrypt of hostname and username, so it is not a secret.
FIX: In §8.4 Overlay home, delete 'gemini-credentials.json (if encrypted mode)' and add:
'Encrypted storage is not supported for `home` accounts. acctshift unsets GEMINI_FORCE_ENCRYPTED_FILE_STORAGE (and GEMINI_FORCE_FILE_STORAGE) in the child environment for `home` runs and for `add gemini`, so each overlay uses its own `oauth_creds.json` (0600, inside the 0700 root). doctor warns when the caller sets it, and `add` fails with 65 `gemini-encrypted-storage` if no per-home oauth_creds.json was produced.'

Add both variables to the A.4 `home` unset row.

## 6. [major] Appendix A.2 (`native` row), Appendix A.4, §8.2 Homes (mainHome), §8.4 Kinds
PROBLEM: Native runs pass through an inherited CODEX_HOME or GEMINI_CLI_HOME. If the parent environment already points into an acctshift overlay, a 'native' run executes as that overlay's account. The spec handles this case for Claude but not for codex or gemini.
EVIDENCE: A.2 native: 'leave CODEX_HOME / CODEX_SQLITE_HOME exactly as in the caller's environment'. §8.4 native: 'no override'. §8.2: 'mainHome = the caller's CODEX_HOME when the codex registry is first created'.

§12.7 explicitly supports `eval "$(acctshift env codex --account work --format sh …)"` in the user's shell. Agents inside an `exec` may also run LimitShift or acctshift again. For Claude the spec already removes CLAUDE_SECURESTORAGE_CONFIG_DIR 'only if it points into acctshift's homes/'.
FIX: Add to §12.5:
'Any inherited CODEX_HOME, CODEX_SQLITE_HOME, GEMINI_CLI_HOME or GEMINI_CLI_AUTH_OVERRIDE whose canonical path resolves inside `<root>/homes/` is treated as acctshift's. For codex `native`, `access-token` and `api-key` runs, set CODEX_HOME=<mainHome>, or unset it when mainHome is ~/.codex. For gemini `native`, unset GEMINI_CLI_HOME and GEMINI_CLI_AUTH_OVERRIDE.'

Add to §8.2 Homes: 'mainHome initialisation and `config codex.mainHome` MUST refuse (exit 78) a directory inside `<root>/homes/`.'

## 7. [major] §8.1 claude (apiKeyHelper rule, Doctor), Appendix A.1
PROBLEM: Only apiKeyHelper is checked. Claude Code's settings `env` block and a caller-supplied `--settings` can re-introduce every variable that A.1 scrubs, defeating the token injection and the RETRY_WATCHDOG unset.
EVIDENCE: §8.1: '`apiKeyHelper` in the user, project (`--cwd`) or managed settings outranks the token. `exec` refuses …'. Claude Code's documented settings key `env` applies environment variables to every session.

An `env` containing ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_RETRY_WATCHDOG or ANTHROPIC_BASE_URL in ~/.claude/settings.json, .claude/settings.json, .claude/settings.local.json, managed settings, or `--settings <json|file>` in the caller's args would then bill another account or API key, or wait out limits silently.

§12.1's `exec` has no `--cwd` flag, so 'project (--cwd)' is undefined for exec.
FIX: Replace the apiKeyHelper bullet with:
'exec scans offline (cached by mtime): user, project (process cwd and its git root), local (.claude/settings.local.json) and managed settings, plus any `--settings` value in the caller's args (read-only; args never modified). If any layer defines apiKeyHelper, or an `env` key that is in the A.1 always-unset list, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CONFIG_DIR or ANTHROPIC_BASE_URL, exec exits 125 (`apikeyhelper-overrides-token` / `settings-env-overrides-token`) unless `--allow-settings-env`.'

Add V-C4: confirm that settings `env` takes precedence over the process environment in the installed Claude version.

## 8. [major] §8.1 Doctor (ANTHROPIC_BASE_URL), Appendix A.1, A.4, §20.4
PROBLEM: A 1-year subscription token (or a stored API key) is injected even when the environment redirects the CLI to a non-vendor endpoint. The secret is then sent to that third-party host, which may log it. Only `doctor` warns, and LimitShift ignores warnings.
EVIDENCE: §8.1 Doctor: '`ANTHROPIC_BASE_URL` set while using a subscription account: the bearer token would go to that host'. It is in no scrub list and exec does not check it. §15.7 makes doctor findings warnings only.

Gemini's `GOOGLE_GEMINI_BASE_URL` ('gateway', R06 env table) has the same effect for `api-key` accounts.

§20.4 / Appendix F promise 'never sends your tokens anywhere except to the CLI you launch', which a user reasonably reads as 'to the vendor'.
FIX: Add to §12.5:
'For claude `token` and `login-slot` runs, if ANTHROPIC_BASE_URL is set in the child environment or in any settings `env` layer and its host is not api.anthropic.com, exec exits 125 `base-url-would-receive-token` unless `--allow-base-url`. The same applies to gemini `api-key` and `home` runs with GOOGLE_GEMINI_BASE_URL (names kept in facts.go).'

Add the code to §12.1.1 and Appendix E.

## 9. [major] §8.5 copilot (`gh` kind, Validation)
PROBLEM: For the `gh` kind, the token returned by `gh auth token` at exec time is never validated. A classic `ghp_` PAT is silently ignored by Copilot, which then falls back to GH_TOKEN, GITHUB_TOKEN or the keychain login, possibly another account. An empty result has the same effect.
EVIDENCE: §8.5: 'Classic `ghp_` PATs in env vars are silently ignored, and Copilot falls back to the stored login, which may be a different account [R06 C8]'. The only check is that 'add MUST reject ghp_ tokens', but the `gh` kind stores nothing: 'at exec time run gh auth token … and set COPILOT_GITHUB_TOKEN to the result'. gh can hold classic PATs (`gh auth login --with-token`). gh is also run with the caller's GH_TOKEN/GITHUB_TOKEN in its environment.
FIX: Add to §8.5 `gh` kind:
'Run gh with GH_TOKEN, GITHUB_TOKEN, GH_ENTERPRISE_TOKEN and GITHUB_ENTERPRISE_TOKEN removed from ITS environment. Trim the output and require `^(gho_|github_pat_)[A-Za-z0-9_]+$`. Otherwise exit 125 `classic-pat-unsupported`, or `gh-token-unavailable` on empty output, a non-zero exit or a timeout. Never launch copilot for a `gh` or `token` account without COPILOT_GITHUB_TOKEN set.'

## 10. [major] Appendix D.1 (`extraEnv`), §12.5 Environment construction
PROBLEM: `extraEnv` is excluded only from the scrub and set lists, so it can set variables the spec says must never change (CLAUDE_CONFIG_DIR, HOME, PATH) or that redirect or hijack the authenticated CLI. It is also missing from the §12.5 formula, so its precedence is undefined.
EVIDENCE: D.1: '`extraEnv` keys MUST NOT be in the Appendix A scrub or set lists. This is for things like GOOGLE_CLOUD_PROJECT'.

The 'never touch' rows (A.1 CLAUDE_CONFIG_DIR, HOME; A.5 GH_TOKEN, COPILOT_HOME) are not scrub or set lists. ANTHROPIC_BASE_URL, NODE_OPTIONS, LD_PRELOAD and DYLD_INSERT_LIBRARIES are also allowed.

§8.1: setting CLAUDE_CONFIG_DIR 'selects a different Keychain entry and logs the user out silently'. §12.5: 'MUST NOT change HOME, USERPROFILE, CLAUDE_CONFIG_DIR, XDG_* or PATH'. The formula is 'final = parent env − ACCTSHIFT_* − scrubList + setList', with no extraEnv term.
FIX: Replace the D.1 sentence with:
'extraEnv keys MUST be on the per-cli allowlist in facts.go (v1: gemini GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION; no other cli has entries). Any other key makes the registry invalid (exit 78).'

Change §12.5 to 'final = parent env − ACCTSHIFT_* − scrubList + extraEnv(account) + setList', so set-list values always win.

## 11. [major] §8.3.1 Slot facts, §8.3.3 step 2, §22
PROBLEM: The slot list omits a third agy token file that R05 found in the binary. The foreign-process name list ignores the Antigravity desktop app and the language server. A swap can therefore leave a component authenticated as the previous account, or swap under a running process that rewrites the slot.
EVIDENCE: R05 §(b): 'Standalone/language-server default: ~/.gemini/jetski-standalone-oauth-token (NewFileTokenStorage joins $HOME + .gemini + jetski-standalone-oauth-token)', and 'the embedded language-server/remote-control build it via authclient.NewAuthClient'.

§8.3.1 lists only `<home>/.gemini/antigravity-cli/antigravity-oauth-token` and `<home>/.gemini/antigravity-oauth-token`. §8.3.3 step 2 matches only 'agy, antigravity or agy.exe'. No V-item asks which components read which slot.
FIX: Add `<home>/.gemini/jetski-standalone-oauth-token` to the §8.3.1 file candidates. It is snapshotted in the add-time diff and included in the write set whenever it holds a credential.

Move the process-name list into facts.go.

Add V-A10: 'Which processes read and refresh which slot: agy -p, the language server, the remote-control daemon, and the Antigravity desktop app with its helpers. Record their process names and whether they share the gemini/antigravity keyring item.' Until V-A10 passes, any of those names counts as a foreign process.

## 12. [major] §8.3.3 step 3 (unregistered content), §4.2 agy kinds, §8 Rules for all adapters
PROBLEM: agy has no `native` kind. The first `exec agy` silently moves the user's own unregistered login out of the slot, and nothing ever restores it. The user's interactive agy afterwards runs, and bills, as whichever account acctshift last swapped in.
EVIDENCE: §8.3.3: 'Content for an unregistered email is kept as agy/_unregistered/<email> with a warning. It is never discarded.' §4.2 agy kinds: '`slot`' only. §8: 'The user's existing default login … is registered … as a native account. acctshift never reads, copies, moves or rewrites a native credential'.

The 'warning' is printed after launch on stderr, which §12.1.1 does not allow and which LimitShift merges into parsed output. D6 Risks mentions only that the user's agy 'can block rotation'.
FIX: Add to §8.3.3 step 3:
'In non-interactive mode, if any slot holds a credential whose email is not registered, exec exits 125 `agy-slot-unregistered` (control verbs 77) BEFORE writing anything, with hint `acctshift add agy <name> --capture-current`. Interactive exec asks first.'

Add `acctshift agy use <name>` (a swap with no run) and an optional `settings.agyRestoreAfterRun: <name>`. Document in §8.3 and the README that interactive agy uses the account acctshift swapped in last.

## 13. [major] §13.3 agy swap journal (Recovery), §8.3.3 steps 1–2, §12.3 spawn path
PROBLEM: Journal recovery runs before the foreign-process check and may write `agy/_last` into the slot while an orphaned agy is still running. That orphan can be an agy left behind on macOS after acctshift was SIGKILLed (macOS has no Pdeathsig), or a surviving descendant. An agy that is mid-refresh-write produces an 'unreadable' file, which triggers exactly that restore.
EVIDENCE: §8.3.3 order: '1. Recovery … then recover from any stale journal. 2. Foreign-process check'. §13.3: 'If the slot is empty or unreadable, it restores agy/_last and warns'.

§12.3: 'macOS has no equivalent … recovery after a SIGKILL of acctshift goes through the journal'. R07 §1: agy writes its file with 'MkdirAll 0755 + WriteFile 0600' (not atomic), so a concurrent read can see a truncated file. agy keeps refreshing and rewriting the slot (R05 C8), which mixes accounts.
FIX: Reorder §8.3.3: take the lock; run the foreign-process check; THEN recover. Add to §13.3:
'Recovery never writes a slot while any agy process runs (exit 125 `agy-busy` / 73). An unparseable file is re-read after 1 s and treated as unreadable only if it is still unparseable. Recovery checks every store and path recorded in the journal, which records file paths as well as store names.'

Add to §12.3: 'After the child exits, if agy processes started during this run are still alive, keep holding the lock until they exit or --slot-wait elapses, then warn.'

## 14. [major] §7.2 Format, §7.3 `vault migrate`, §7.1 (key fetched once per process)
PROBLEM: A long-running writer, such as `exec agy` whose post-run save-back happens hours after the key was fetched, can write the vault with a stale header after a concurrent `vault migrate` has rewrapped the data key and deleted the old key item. The vault then becomes undecryptable.
EVIDENCE: §7.2: the data key is 'wrapped … by the source key. Rekeying or migrating key sources then rewraps 32 bytes'. §7.3: '`vault migrate --to <source>` rewraps …, swaps the header atomically, and then deletes the old key item'. §7.1: the key is fetched 'at most once per process'.

The spec never requires a writer to re-read the header under vault.lock. A writer that caches header and data key writes the old source-id header (wrapped by the now-deleted key) over the migrated file.
FIX: Add to §7.2 Concurrency:
'Every vault write MUST, under vault.lock, re-read the current file and compare its key id and wrapped key with those this process unwrapped. If they differ, unwrap again from the current header, or abort with 74 `vault-changed`. The new body is always written with the CURRENT header's wrapped key.'

Add to §7.3: 'vault migrate holds vault.lock from reading through rewrap, header swap and old-key deletion, and fsyncs the new vault before deleting the old key.'

## 15. [major] §7.3 Key sources (`secret-service` row)
PROBLEM: Nothing forbids storing the vault key in a non-persistent collection. gnome-keyring's always-unlocked `session` collection, or a default alias pointing at it, passes the 'already unlocked' test. The key is then gone after logout or reboot, and so is the whole vault.
EVIDENCE: §7.3: 'Secret Service item … in the `login` collection, else the `default` alias … only if … the collection is already unlocked without acctshift calling Unlock'.

R07 §4 experiment 2: 'gnome-keyring activated but not pre-unlocked (typical headless): only a `session` collection'. The session collection lives in memory only. KeePassXC exposes a user-chosen database through the default alias.
FIX: Add:
'The target collection MUST be persistent: `/org/freedesktop/secrets/aliases/default` must resolve to a collection other than `/org/freedesktop/secrets/collection/session`, and its path must not be `/`. Otherwise the secret-service source is not eligible and key-file is the default.'

Also: 'After creating the item, read it back through a fresh connection before writing the vault.'

## 16. [major] §10.2 `rename`, §8.2 Overlay home, §8.1 `login-slot`
PROBLEM: `rename` moves the home directory. For codex keyring/auto store mode and for macOS claude `login-slot`, the vendor credential is keyed by a hash of the directory path. Renaming therefore loses the login and leaves a live refresh token orphaned in the OS keychain.
EVIDENCE: §10.2: 'rename; moves the vault entry, home dir and state key'.

Affected keys:
- codex: §8.2 'keyring and secrets keys derive from sha256(canonical CODEX_HOME)';
- claude login-slot: §8.1 Keychain item 'Claude Code-credentials-<sha256(S)[0:8]>', where S = `<root>/homes/claude/<account>`.

D4/D5 Risks already note that 'Moving ACCTSHIFT_HOME orphans keyring-mode Codex credentials'. rename does the same thing per account.
FIX: Change §10.2: 'rename changes only the registry name, vault secretId and state key. Overlay and login-slot directories keep their path: the directory name is an immutable id assigned at add (e.g. `homes/codex/<8-hex id>`), recorded in `home`.'

Until then, rename MUST refuse (exit 78) for codex accounts not in file-store mode and for claude login-slot accounts on macOS.

## 17. [major] §14.4 Never log or print (redactor), §6.2 doctor token check, §9.1 snippet
PROBLEM: The redactor pattern list misses secret formats that acctshift itself stores and injects. The redactor is also mandated only for the debug logger, while secrets can reach snippets, JSON, state.json, events.jsonl, error messages and the status file.
EVIDENCE: §14.4 patterns: sk-ant-, github_pat_, gh[opsu]_, ya29., 1//, eyJ…, at-.

Missing:
- Gemini API keys `AIza[0-9A-Za-z_-]{35}` (stored per §7.1, set as GEMINI_API_KEY). Google client errors print request URLs with `?key=`.
- OpenAI keys `sk-proj-…` / `sk-…` (CODEX_API_KEY).
- GitHub refresh tokens `ghr_` (the `gh[opsu]_` pattern misses `r`).

'The debug logger MUST pass every record through a redactor', but the §9.1 snippet ('masked per §14.4') ends up in state.json, `classify --json`, `next`/`mark` `recorded` and events.jsonl. The §6.2 doctor check lists only 'sk-ant-, github_pat_, gho_, ya29., eyJ'.
FIX: Replace the §14.4 paragraph with:
'One package, internal/redact, is applied to EVERY output channel: stdout JSON, stderr, --status-file, state.json snippets, events.jsonl, logs, error.message and doctor messages.
- Patterns: sk-ant-[\w-]+, sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}, AIza[0-9A-Za-z_-]{35}, github_pat_\w+, gh[oprsu]_\w+, ya29\.[\w-]+, 1//[\w-]+, eyJ[\w-]+\.[\w-]+\.[\w-]*, at-[\w-]{10,}.
- In addition, the exact byte values of every secret loaded by this process (vault entries, gh output) are masked.
- doctor findings name the offending field and never quote its value.'

§6.2 reuses the same pattern table.

## 18. [major] §12.5 Environment construction, Appendix A set-lists, §7.6
PROBLEM: Injected tokens become visible to everything the agent spawns: Bash/shell tools, hooks, MCP stdio servers (often npx packages), test suites and package install scripts. A routine `env`/`printenv` or a debug dump writes them into LimitShift's captured outputs and into vendor transcripts. The spec never mentions this path.
EVIDENCE: §12.5: 'Secrets go only into the child's environment block'. The tokens are CLAUDE_CODE_OAUTH_TOKEN (1-year), COPILOT_GITHUB_TOKEN (for the `gh` kind a broad-scope gho_ token), GEMINI_API_KEY, CODEX_ACCESS_TOKEN and CODEX_API_KEY.

§14.1 lists 'accidental exposure: logs …' as in scope. §15.2: LimitShift writes run output to 'outputs/task-NN-…-output.txt'. §7.6 mentions the environment only for 'software running as the same OS user'.
FIX: Add V-C4, V-X4, V-G2 and V-P2: 'Does the CLI remove its auth variable from tool, hook and MCP subprocess environments? Is there a vendor switch, and does the default policy exclude *TOKEN*/*KEY* names?' Examples to check: Claude Code's subprocess env-scrub setting (if present in the installed version); Codex shell_environment_policy.

Record the result in facts.go. exec MUST set the vendor's scrub switch for secret-bearing kinds when one exists.

Document the residual exposure in §7.6 and the README. Recommend fine-grained PATs over the `gh` kind. Recommend that LimitShift pass captured outputs through the same redaction patterns before writing them.

## 19. [major] §7.6 Threat model statement, §14.1 Threat model
PROBLEM: The threat model calls same-user software out of scope, but acctshift's purpose is to run autonomous agents, which are same-user code processing untrusted content. Any one task can read the vault key and decrypt every account of every CLI. That is a larger blast radius than the vendors' own single-account storage, which contradicts the stated 'no weaker than the vendor CLIs' target.
EVIDENCE: §7.6: 'does not protect against … Software running as the same OS user. Such software can read the source key … or any process that runs `/usr/bin/security` on macOS'. §14.1: 'Out of scope: malware running as the same OS user'; 'protection target is "no weaker than the vendor CLIs' own storage"'.

LimitShift runs agents unattended with permission-bypass flags. A prompt-injected task can run `security find-generic-password -s acctshift -wa vault-key-v1` (the item trusts /usr/bin/security, §7.4), or read the key file, and then decrypt vault.v1.bin.
FIX: Replace the §7.6 'does not protect' paragraph and the §14.1 target with:
'The agents acctshift launches run as the same OS user and can read every secret acctshift stores, for every account and every CLI, not only the account of the current run. One compromised or prompt-injected task can therefore exfiltrate all registered accounts. Per account, acctshift is no weaker than the vendor's own storage; in aggregate it is weaker.'

Put the same sentence in the README and the first-run notice (Appendix F).

## 20. [major] §17.6 Installer scripts (token variables)
PROBLEM: install.sh picks up ambient GitHub tokens on its own (GITHUB_TOKEN, GH_TOKEN, `gh auth token`) for a repository the spec says is public. A POSIX shell installer would naturally pass the token as a curl `-H` argument, which shows up in `ps` and /proc/*/cmdline. The token could also be sent to whatever host ACCTSHIFT_ARCHIVE names.
EVIDENCE: §17.6: 'token variables for a private repo: ACCTSHIFT_GITHUB_TOKEN, GITHUB_TOKEN, GH_TOKEN, or gh auth token'; 'ACCTSHIFT_ARCHIVE (local path or URL)'. §19.1 makes the repository public. NFR7 / §14.2 rule 4 forbid secrets in argv.
FIX: Replace the token bullet with:
'Tokens are used only when ACCTSHIFT_GITHUB_TOKEN is set explicitly. GITHUB_TOKEN, GH_TOKEN and gh are never read. The token is sent only to https://github.com and https://api.github.com, never to an ACCTSHIFT_ARCHIVE host and never to a redirect target. It is passed to curl via stdin (`curl -H @-` or `--config -`) or a 0600 temp file, never in argv. install.ps1 uses -Headers in-process.'

## 21. [major] §15.9 Install and offer, §17.6 (verification)
PROBLEM: The integrity check LimitShift relies on is circular. SHA256SUMS comes from the same place as the archive, cosign runs only if it happens to be installed and checks no signer identity, and environment knobs can redirect the download. LimitShift could install an arbitrary binary that then receives every token.
EVIDENCE: §15.9: 'run acctshift's official installer with ACCTSHIFT_INSTALL_DIR=<limitshift>/bin and a pinned version, after which the SHA-256 is verified (§17.6)'. §17.6: 'verify SHA256SUMS … Also verify the cosign bundle when cosign is on PATH'. ACCTSHIFT_REPO and ACCTSHIFT_ARCHIVE are honoured from the environment, and where the installer script itself is fetched from is unspecified.
FIX: Change §15.9:
'tools/get-acctshift.* embeds a table of expected SHA-256 values for the pinned version's six archives (and install.sh/ps1), downloads only from https://github.com/j-ts/acctshift/releases/download/v<pinned>/, unsets ACCTSHIFT_REPO and ACCTSHIFT_ARCHIVE, and verifies against its own table before installing.'

Change §17.6:
'When cosign is present: `cosign verify-blob --bundle SHA256SUMS.sigstore.json --certificate-identity-regexp "^https://github.com/j-ts/acctshift/\.github/workflows/release\.yml@refs/tags/v" --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS`. When ACCTSHIFT_ARCHIVE is set, ACCTSHIFT_SHA256 is required.'

## 22. [major] §6.1 Permissions (umask 077), §14.2 rule 7 (RLIMIT_CORE=0), §12.3
PROBLEM: umask and rlimits are inherited across fork/execve. Setting umask 077 and RLIMIT_CORE=0 at startup silently changes the launched CLI's environment. Every file and directory the agent creates in the user's project becomes 0600/0700, which breaks web roots, shared repos and container builds, and core dumps are disabled. This contradicts 'behaves exactly as if the caller had launched it'.
EVIDENCE: §6.1: 'acctshift MUST set umask 077 at start'. §14.2 rule 7: 'set RLIMIT_CORE=0 on POSIX at start'. §12.3 execve path: 'The cli takes over … so it behaves exactly as if the caller had launched it'. Neither section restores the values before launching.
FIX: Add to §12.3 (both paths) and §12.4 where relevant:
'Before execve or spawn, restore the umask and RLIMIT_CORE values that acctshift inherited (saved at start), or apply 077 only through explicit modes on acctshift's own creates (`os.OpenFile(…, 0600)`, `Mkdir(…, 0700)`) without changing the process umask. Helper processes acctshift spawns for itself (security, gh, ps) may keep the restrictive values.'

## 23. [major] §7.5 Non-interactive guarantees, §7.4 macOS rules
PROBLEM: 'Never open any OS dialog' is a MUST that /usr/bin/security cannot honour. When the login keychain is locked in a GUI session, `security find-generic-password` raises the SecurityAgent unlock dialog, and the spec's own V-K1 already asks 'what happens to a GUI unlock dialog when security is killed on timeout'. KeePassXC's access-confirmation dialog behaves the same way on Linux. LimitShift runs doctor, which probes the keystore, at every queue start.
EVIDENCE: §7.5: 'What it then never does: open any OS dialog'. §22 V-K1: 'what happens to a GUI unlock dialog when security is killed on timeout'. §8.3.2 probes the keyring on every agy run. §15.7 item 6 runs `doctor --json` at the start of every real run.
FIX: Change §7.5:
'acctshift never calls an API whose purpose is to prompt. On macOS a GUI session may still show an unlock dialog until the 3 s probe timeout kills `security`. The same applies to providers that confirm access themselves (KeePassXC).'

Add V-K3: 'find a prompt-free lock probe (candidate: `security show-keychain-info <login keychain>` exit status). Once verified, non-interactive runs call it before any read and treat "locked" as keystore-unavailable without invoking find-generic-password.'

Make V-K1/V-K3 exit criteria for M1 on macOS.

## 24. [major] §15.3 bash hook (comment at :2775), §15.6 item 1, §14.2 rule 2
PROBLEM: The LimitShift integration still routes the short-lived `claude -p /usage` probe through `acctshift exec` for refresh-token accounts (native, login-slot). The spec's own evidence says this can spend the refresh token, so it contradicts the 'never probe' rule.
EVIDENCE: §15.3: 'lim=$(get_runner_reset_epoch ...)  # /usage cross-check now runs via: acctshift exec claude --account "$ACCT_CURRENT" -- -p /usage'. §15.6: 'If LimitShift keeps the probe for accounts whose usageProbe is true, it MUST run it through acctshift exec'; usageProbe is true for native and login-slot (§11.2).

§15.6 itself says 'Short-lived Claude commands can spend a login-slot account's refresh token [R09 C3]'. §14.2 rule 2: 'Never run short-lived vendor commands to probe accounts'.
FIX: Change §15.6 item 1:
'When a claude runner is managed by acctshift, LimitShift MUST NOT run `claude -p /usage` for any account. It uses `resetAtEpoch` from `next`/`classify`.'

Delete the /usage comment in the §15.3 bash snippet and §15.10 scenario 8. Set `usageProbe` to false for login-slot.

## 25. [major] §8.2 codex Add step 5 (dedupe)
PROBLEM: On a duplicate login, the spec deletes the NEWEST credential. If a new sign-in invalidates the account's previous refresh token, the existing overlay is already dead, so that ChatGPT account ends up with no working login. The failure surfaces only mid-queue, as 'refresh token was already used'.
EVIDENCE: §8.2 step 5: 'Dedupe on (chatgptAccountId, chatgptUserId). On a duplicate, delete the new overlay's auth.json without codex logout and exit 65'.

R09 C7 (INFERRED): 'a new sign-in invalidates the previous one server-side'. §8.2 step 4 cites #39199 for login-induced invalidation.
FIX: Replace the duplicate branch with:
'On a duplicate of registered account X, after confirming that no codex process or daemon uses X's overlay, rename the new auth.json over X's auth.json (same filesystem; the old one is presumed invalidated), remove the new overlay, clear X's needs-relogin state, and exit 65 `duplicate-account` with the message "re-authenticated X". Never delete the newest credential.'

If the duplicate is the native `main` account, which acctshift cannot inspect, warn that main may need `codex login`.

## 26. [minor] §7.2 Format (data key wrapping)
PROBLEM: The wrap of the data key specifies neither a nonce nor AAD. An implementer could reuse the body nonce, use a fixed nonce, or leave the key id and source id unauthenticated.
EVIDENCE: §7.2: 'Data key: a random 32-byte key, wrapped (XChaCha20-Poly1305) by the source key'. The header lists only one '24-byte random nonce (new on every write)'.
FIX: Add:
'wrapped data key = wrapNonce(24 random bytes, new on every rewrap) ‖ XChaCha20-Poly1305(sourceKey, wrapNonce, dataKey, aad = magic‖version‖keySourceId‖keyId), 72 bytes in total. The body nonce is independent of it.'

## 27. [minor] §6.1 layout vs §7.3 `dpapi` row; §17.6 Installer scripts
PROBLEM: The DPAPI key path contradicts itself. On Windows the default install directory sits inside the root that the installer must not touch. And install.sh can create the root with a 0755 mode, which acctshift then refuses to use.
EVIDENCE: §6.1 lists `<root>/vault.key.dpapi`, while §7.3 says '%LOCALAPPDATA%\acctshift\vault.key.dpapi'. These differ under ACCTSHIFT_HOME.

§17.6: default Windows install directory '%LOCALAPPDATA%\acctshift\bin' (= <root>\bin), alongside 'Never touch anything under <root> except install.json'.

§17.6 writes '<root>/install.json', which creates <root> with the shell's umask (typically 0755). §6.1 then 'MUST refuse to read secrets … (exit 78)'.
FIX: State that the DPAPI file is `<root>/vault.key.dpapi`. Move the Windows install directory to `%LOCALAPPDATA%\Programs\acctshift\bin`.

Add to §17.6: 'The installer creates <root> with `umask 077; mkdir -p -m 700` (Windows: let acctshift apply the protected DACL on first run). acctshift applies or repairs the Windows DACL whenever the root lacks it.'

## 28. [minor] §7.3 `key-file` row and Rules, §6.1 Permissions
PROBLEM: The key-file permission rule is enforced only by doctor, it has no ownership or symlink checks, and it conflicts with the advertised CI and container secret mounts. Those are typically 0444 or 0644 symlinks (Docker /run/secrets, Kubernetes `..data`).
EVIDENCE: §7.3: 'ACCTSHIFT_KEY_FILE overrides the path (containers, CI secret mounts)'; '`doctor` … refuses a key file or vault that is readable by group or others'. §6.1 checks the mode only, not the owner, and covers only 'root, vault.* or state.json'.
FIX: Add:
'At every key read (not only in doctor), the key file and the root MUST be owned by the current uid, or by root for ACCTSHIFT_KEY_FILE, and MUST NOT be writable by group or others. A default-path key file must also not be group- or world-readable.'

Document that mounts must use mode 0400 and an owner that matches the runtime uid. Record the key-file path in the vault header, so that a later run without ACCTSHIFT_KEY_FILE fails with a clear message.

## 29. [minor] §12.2 Resolving the cli binary
PROBLEM: Only Windows treats ErrDot as 'not found'. On POSIX, an empty or relative PATH entry plus a repository-provided `./claude` would receive the injected token, and LimitShift runs inside untrusted project directories. Relative ACCTSHIFT_<CLI>_BIN values resolve against the cwd in the same way.
EVIDENCE: §12.2: 'On Windows this honours PATHEXT, and the current directory is never searched (Go's exec.LookPath returns ErrDot; treat it as not found)'.
FIX: Change to:
'On every OS, a LookPath result that errors with exec.ErrDot is treated as not found (127). ACCTSHIFT_<CLI>_BIN and clis.<cli>.bin MUST be absolute paths; a relative value is a usage error (64).'

## 30. [minor] Appendix A.0 (`ACCTSHIFT_TEST_KEYCHAIN`), §18.3
PROBLEM: Release builds honour a test-only keystore override when ACCTSHIFT_TESTING=1 is set. If a copied CI environment leaks into real use, the vault key ends up in a throwaway keychain and the vault is lost.
EVIDENCE: A.0: 'test-only macOS keychain path (ignored in release builds unless ACCTSHIFT_TESTING=1)'.
FIX: Change to:
'Test keystore overrides (ACCTSHIFT_TEST_KEYCHAIN, fake keystore) are compiled only under the `acctshift_test` build tag. Release builds ignore them unconditionally, and CI asserts that the release binary does not contain these strings.'

## 31. [minor] §8.2 Kinds (`access-token`, `api-key`), §8.4 (`api-key`), §8.5 (`token`)
PROBLEM: Only the Claude add flow says how the secret is entered. For the other secret kinds an implementer could add `--api-key VALUE` or `--token VALUE` flags, which would put secrets in argv.
EVIDENCE: §8.1 add specifies 'Read the pasted token with no echo, or one line from stdin with --token-stdin'. §8.2, §8.4 and §8.5 store CODEX_ACCESS_TOKEN, CODEX_API_KEY, GEMINI_API_KEY and PATs 'from the vault' but never say how they get there.
FIX: Add to §10.2 add:
'Every secret-bearing kind (claude token, codex access-token/api-key, gemini api-key, copilot token) reads its secret only from a no-echo TTY prompt or `--token-stdin` (one line). No flag takes a secret value.'

## 32. [minor] Appendix A.3 agy, Appendix A.4 gemini
PROBLEM: The scrub lists have gaps. JETSKI_TEST_GAIA_TOKEN, a companion token that agy reads alongside JETSKI_OAUTH_TOKEN, is not unset. A.4 has no `native` row, although §8.4 says to unset GEMINI_API_KEY and GOOGLE_API_KEY for native. The `api-key` row leaves Vertex and other auth-type variables in place.
EVIDENCE: R05 §(c): 'JETSKI_TEST_GAIA_TOKEN — companion test token', read by NewStandaloneAuthProvider. §8.4: 'Unset GEMINI_API_KEY and GOOGLE_API_KEY for home / native'. A.4 has rows only for `home` and `api-key`. R06 lists GOOGLE_GENAI_USE_VERTEXAI and GEMINI_CLI_USE_COMPUTE_ADC as auth-type selectors.
FIX: A.3: add JETSKI_TEST_GAIA_TOKEN to the unset list.

A.4:
- add a `native` row: unset GEMINI_API_KEY and GOOGLE_API_KEY;
- `api-key` row: also unset GOOGLE_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA, GEMINI_CLI_USE_COMPUTE_ADC and GOOGLE_CLOUD_ACCESS_TOKEN.

## 33. [minor] §17.7 Self-update (Verify)
PROBLEM: The downgrade check does not say where the version comes from. If it is taken from the `latest` redirect or the URL, an older validly signed SHA256SUMS defeats it. Archive extraction is also unconstrained.
EVIDENCE: §17.7: 'the Ed25519 signature over SHA256SUMS …; the archive hash; refuse downgrades unless --allow-downgrade'. The source is '…/releases/{latest|download/vX}/…'.
FIX: Add:
'The target version is parsed from the archive file name listed in the SIGNED SHA256SUMS (acctshift_<ver>_<os>_<arch>…). It must be greater than the running version unless --allow-downgrade. Extraction writes only the single expected binary entry, rejects any other path, and never follows symlinks in the archive. The replacement path is os.Executable(), and it must match install.json `path`.'

## 34. [minor] §14.2 rule 7 (zero buffers), §12.3 spawn path, §12.4
PROBLEM: On the spawn path (agy on every OS, and every CLI on Windows), acctshift stays alive for the whole run. Nothing stops it from holding the decrypted vault, meaning every account's secrets, in memory for hours. Decoding into Go strings also makes zeroing impossible.
EVIDENCE: §14.2 rule 7: 'Zero decrypted vault buffers after use where practical'. §7.1: the key is fetched at most once per process. §12.4: 'Always the spawn path' on Windows. agy save-back happens after the run.
FIX: Add:
'Before spawning, extract only the needed entry from the plaintext []byte and zero the plaintext. On the spawn path, keep only the 32-byte data key (zeroed on exit) for post-run save-back, and re-read the vault file under vault.lock at that point. Vault values are decoded into []byte, never into string.'

## 35. [minor] §7.1 (commands that fetch the key), NFR7, §11.2 env
PROBLEM: The list of commands allowed to open the keystore omits `env --reveal-secrets` and `rename`, both of which need secret values. NFR7 also says secrets never appear in JSON output, but `env --format json --reveal-secrets` emits them.
EVIDENCE: §7.1: 'Only commands that need a secret value fetch the key …: exec for token kinds and agy, add, login, remove, vault *'. §10.2 rename 'moves the vault entry'. §11.2 env: 'Values are revealed only with --reveal-secrets'. NFR7: 'Secrets never appear in … JSON output'.
FIX: §7.1: add '`env --reveal-secrets` and `rename`'; `env` without --reveal-secrets never opens the keystore.

NFR7: append 'except the explicit `env --reveal-secrets` output the user requested'.

## 36. [minor] §8.3.3 step 9 (post-run check), §12.1.1 stderr rules, `--status-file`
PROBLEM: A detected wrong-account run is only written to state and printed as a stderr warning, which §12.1.1 does not allow after launch. The caller never learns which account the run actually used. An empty slot after the run (agy clears it on revocation or /logout) is unhandled.
EVIDENCE: Step 9: 'On a mismatch record wrongAccount in state and print an acctshift: warning'. §12.1.1: 'acctshift writes stderr only on a pre-launch failure, while waiting for a lock …, on the auto-pick notice …, or with --verbose'. R05 §(b): agy 'clears the entry on definitive server rejection … and on /logout'.
FIX: Add a `wrongAccount: {expected, found}` field to the --status-file line, and add the post-run warning to the allowed stderr list as a fixed catalogue message.

Add: 'If every slot is empty after the run, do not touch the account's snapshot. Set the account to needs-relogin (reason `refresh-dead`) and record the event.'

## 37. [minor] §10.2 `remove`, §8 Rules for all adapters
PROBLEM: Removing a codex overlay in keyring or auto mode, or a claude login-slot account, deletes the directory but leaves that account's vendor keyring item. A live refresh token stays in the OS store indefinitely, with no owner.
EVIDENCE: §10.2: 'delete the account and its secret / overlay home'. The keyring keys are `Codex Auth`/`cli|sha256(home)[0:16]` (§8.2, Appendix B) and `Claude Code-credentials-<sha256(S)[0:8]>` (§8.1). §8 says only that native credentials are never touched.
FIX: Add:
'remove of a codex `home` account, or a claude `login-slot` account, also deletes the vendor keyring item derived from that overlay's own path: it is single-owned by the overlay, so this is not a logout. It never touches items derived from mainHome or the default config dir. If the delete fails, print the exact item name for manual removal.'

## 38. [minor] §8.2 Link refresh / overlay removal (Windows)
PROBLEM: The spec does not define how a 'link' is recognised on Windows. Since Go 1.23, Lstat reports junctions as ModeIrregular, not ModeSymlink. An implementer testing ModeSymlink will treat junctions as real directories, and a recursive delete that uses Stat would descend into mainHome.
EVIDENCE: §8.2: 'remove only the link or reparse point and never recurse through a symlink or junction'. DECISIONS D4/D5 relies on 'Since Go 1.23, os.RemoveAll removes a junction rather than recursing into it'. The spec never says how a junction is detected.
FIX: Add:
'An entry is a link iff Lstat reports ModeSymlink or ModeIrregular, or on Windows its attributes include FILE_ATTRIBUTE_REPARSE_POINT. Links are removed with a single os.Remove (RemoveDirectory for junctions), never with a walk. Walks use Lstat/ReadDir only and never os.Stat.'

## 39. [minor] §14.2 rule 5 vs §8.2 Link refresh
PROBLEM: Two MUSTs contradict each other: links may be created only for entries that already exist in the main home, yet link refresh pre-creates missing shared directories in mainHome.
EVIDENCE: §14.2 rule 5: 'Overlay links MUST be created only for entries that actually exist in the vendor's main home'. §8.2: 'pre-create missing shared directories in mainHome'.
FIX: Change §14.2 rule 5 to:
'Overlay links MUST point only at allowlisted names directly inside mainHome. Missing allowlisted directories may be created in mainHome first; files are never created there.'

## 40. [minor] §8.2 Import (`--import-home DIR`)
PROBLEM: 'Moving' auth.json fails across filesystems (EXDEV). A naive copy-then-delete fallback leaves two owners of a single-use refresh token if the delete fails.
EVIDENCE: §8.2: 'adopts an existing single-account Codex home by moving its auth.json into a new overlay. It never copies, because refresh tokens are single-use'.
FIX: Add:
'If rename fails with EXDEV: copy to a temp file in the overlay, fsync, unlink the source, and only after the unlink succeeds rename the temp file to auth.json. If the unlink fails, delete the copy and abort with exit 73.'

## 41. [minor] §7.6 What the vault protects
PROBLEM: With the `key-file` source (the default on headless Linux, WSL and CI), a whole-home backup or sync carries both the key and the vault. The blanket claim of protection against 'backups, sync tools' is false for that source.
EVIDENCE: §7.6: 'What the vault protects. acctshift's stored secrets against disclosure of its files: backups, sync tools, dotfile repositories …'. The §7.3 key file lives at '~/.config/acctshift/vault.key' and the vault at '~/.local/share/acctshift', both under $HOME. §7.3 itself says doctor describes key-file as 'equal to the vendor CLIs' own plaintext credential files'.
FIX: Make the paragraph per source:
'keychain / secret-service / dpapi: protects against disclosure of copies of acctshift's files. key-file: protects only against copies of the acctshift data directory alone; a backup of the whole home directory contains both the key and the vault.'

## 42. [minor] §8.3.3 Lock modes vs §22 V-A8
PROBLEM: Shared-mode parallel agy runs on one account are normative even though V-A8, which the spec says decides 'lock-mode safety', is unverified. If agy's refresh token rotates, concurrent refreshes from in-memory copies can invalidate the login.
EVIDENCE: §22 V-A8: 'Does a running agy re-read the slot before refreshing, or keep its token in memory? Does the refresh token rotate during runs longer than an hour? | lock-mode safety (§8.3.3)'. §8.3.3 allows the shared mode unconditionally.
FIX: Add to §8.3.3:
'Until V-A8 passes on an OS, agy runs take the lock exclusively there (no shared mode). facts.go records the V-A8 result per agy version.'
# LENS: Cross-platform correctness: macOS (arm64
The spec is close on the main design but has several defects in the OS-specific details. Two are blockers:
(1) §8.3.2 treats a locked keychain or Secret Service as "file mode". agy itself calls Unlock and waits for a human, so a user who unlocks the prompt gets agy running on whatever account the keyring holds. That is a wrong-account run.
(2) The OS-store item for the vault key has one fixed name per machine and is written with `-U`. Creating a second vault, for example with a different ACCTSHIFT_HOME or the contract tests on a developer machine, silently overwrites the key of the first vault. The only copy of the Claude setup-tokens is then lost.

I verified these with go1.24.7 in a sandbox:
- `signal.Ignore`, `umask 077` and `RLIMIT_CORE` are inherited by children on both exec paths. This breaks exec transparency: Ctrl+C is ignored in agent subprocesses, and files the agent creates get mode 0600.
- Go's Windows `StartProcess` closes the primary thread handle, so "start suspended, assign to job, resume" cannot be built on os/exec.
- Go's Windows `os.Open` omits FILE_SHARE_DELETE, so lock-free readers make `MoveFileEx` fail with ACCESS_DENIED, which the spec's retry rule does not cover.
- The §17.1 no-cgo guard always prints `runtime/cgo` and `net` under the runner's default CGO_ENABLED=1, and never prints anything under CGO_ENABLED=0.

Other major issues:
- LockFileEx locks byte 0, but the spec has lock holders write diagnostics into that same byte range.
- There is no rule for moving from a shared to an exclusive agy lock, and journal recovery can run under a shared lock.
- Liveness is judged by pid alone, which breaks with pid reuse in containers and on Windows.
- The installer creates the root with mode 0755, so acctshift refuses to read secrets (exit 78), and on Windows it puts bin/ inside the root.
- install.sh can overwrite a signed arm64 binary in place on macOS, which then dies with "Killed: 9".
- The `run` wrapper shares a process group with the child but kills "the group", which would kill acctshift too.
- "Never under a symlinked parent" fails on macOS TMPDIR and on symlinked homes.
- The foreign-process check is not specified enough to implement (process ancestry, the name clash with the Antigravity IDE, daemons that outlive agy).
- WSL interop binaries never see the env delta.
- Account names that Windows treats as the same path (trailing dots) or as reserved device names are allowed.
- agy's language-server token file is missing from the slot list.
- §12.3 and §8.4 contradict each other on gemini's launch path.

The minor findings cover:
- unreachable or wrong statements (the kqueue SHOULD, "never open any OS dialog");
- Windows Ctrl+Break and console close;
- PowerShell 5.1 code-page mangling of non-ASCII text in JSON output;
- installer PATH setup and architecture detection under emulation;
- XDG differences between contexts, network filesystems, ownership under sudo;
- test keychain plumbing, darwin/amd64 and WSL1 CI coverage, NFR "cold" timing;
- E2BIG handling, Claude native detection on macOS, npm shim step 2.

## 1. [blocker] §8.3.2 Which slot agy will read (and §13.3 Recovery)
PROBLEM: A locked keyring is treated as deterministic "file mode". agy does not behave that way: it calls Unlock and waits for a human. When the user unlocks within agy's keyring timeout, agy reads the keyring item, which acctshift could neither read nor overwrite. agy then runs as the previous account: a wrong-account run. Recovery's "unreadable → restore agy/_last" compounds this by writing an old token while the store is merely locked.
EVIDENCE: Spec: "Mode is also file if the keyring is unreachable or locked within a 3 s probe: Linux: no autolaunch, Locked checked, never Unlock; macOS: security exits 36, 37 or 50". The write set is only "every other reachable slot that currently holds an agy credential", and a locked store is not reachable, so it is neither written nor fail-closed deleted. §13.3: "If the slot is empty or unreadable, it restores agy/_last".

Research:
- R05 §a: go-keyring "stores into the login collection (unlocked first)", with "GetLoginCollection/Unlock/CreateItem" in secretServiceProvider.
- R07 C5: the go-keyring prompt wait has no timeout.
- R05: "Keyring op timeout is 5 s", and agy falls back to its file only after that timeout (marker for 1 h).

So the store agy ends up using depends on whether someone at the desktop unlocks the gcr-prompter or SecurityAgent dialog in time. Typical case: a Linux desktop with auto-login, where the login collection stays locked. On macOS in a GUI session, `security` shows an unlock dialog rather than exiting 36, so acctshift's 3 s probe times out and is classified "unreachable → file". agy's own `security` call shows the same dialog, the user unlocks it, and agy reads the keychain.
FIX: Replace the locked/unreachable bullet with:

"File mode is inferred only from deterministic conditions:
- an agy bypass detector fires; or
- the store is absent in a way agy also cannot use: no bus or connection refused; macOS exit 37/50 (no default/no such keychain); Windows error 1312.

If the store exists but is locked (Linux `Locked=true`; macOS exit 36, or a probe timeout or prompt), a swap or fast-path run MUST NOT proceed. `exec` exits 125 `agy-keyring-locked`, control verbs exit 74, and the hint is 'unlock the login keyring/keychain, or run where agy uses its file store'."

In §13.3, replace "empty or unreadable" with "readable and empty (item or file absent)". A locked, timed-out or prompt-requiring store MUST leave the journal in place and fail with the same error.

## 2. [blocker] §7.3 Key sources (v1) / §7.4 macOS security rules / §14.3
PROBLEM: Each OS store holds a single machine-wide key item: `acctshift`/`vault-key-v1` in the keychain or Secret Service, and one fixed key-file path. It is written with `-U` (update), and its location does not depend on ACCTSHIFT_HOME. Creating a second vault therefore overwrites the first vault's source key. Ways a second vault gets created: `--home`/`ACCTSHIFT_HOME` (documented), the contract tests that run "against a temporary ACCTSHIFT_HOME" on the developer's OS, or a second LimitShift profile. The first vault then becomes permanently undecryptable, and it holds the only copy of the Claude setup-tokens. `vault migrate` likewise "deletes the old key item", which may belong to another root.
EVIDENCE: §7.3: `keychain` = "generic password service `acctshift`, account `vault-key-v1`"; `secret-service` = "{service:"acctshift", username:"vault-key-v1"}"; `key-file` = "${XDG_CONFIG_HOME:-~/.config}/acctshift/vault.key" (independent of the root).

§7.4 writes with "add-generic-password -U".

§7.1 says Claude Code "never saves [setup-tokens] to disk, so acctshift holds the only copy [R04 C4]".

§18.2 runs "the real binary ... against a temporary ACCTSHIFT_HOME". §19.4 says to run "the contract tests on the developer OS" before each commit.

The header carries a 16-byte key id, but the item name does not, so a mismatch is detected only after the key is already gone.
FIX: In §7.3:
- Name the item per vault: account `vault-key-v1-<keyid-hex>` (keychain and Secret Service), key file `<dir>/vault-<keyid-hex>.key`.
- Write the key at creation without `-U`. Treat exit 45 or an existing item or file as a hard error (`key-item-exists`). Never overwrite.
- `vault migrate` deletes only the item whose name carries this vault's key id.
- Record the absolute key-file path in the vault header.

In §18.2 and §19.4: contract tests MUST set `ACCTSHIFT_KEY_SOURCE=key-file` with an `ACCTSHIFT_KEY_FILE` inside the temporary root, or use the fake keystore. A test that touches the real login keychain or Secret Service is a CI failure.

## 3. [major] §6.1 Permissions (POSIX umask) and §14.2 rule 7 (RLIMIT_CORE)
PROBLEM: `umask 077` and `RLIMIT_CORE=0` are process attributes that the vendor CLI inherits on both the execve and spawn paths. Every file the agent then creates in the user's project (sources, build outputs, git working-tree files) gets mode 0600/0700 instead of 0644/0755, and core dumps are disabled for the CLI and every tool it runs. That breaks the promise that exec is transparent: "behaves exactly as if the caller had launched it".
EVIDENCE: Spec §6.1: "acctshift MUST set umask 077 at start". §14.2: "set RLIMIT_CORE=0 on POSIX at start". §12.3: execve "behaves exactly as if the caller had launched it".

Verified with go1.24.7 on Linux: after `syscall.Umask(0o077)`, an `exec.Command` child prints `umask` = 0077, and a `syscall.Exec`'d `sh` also prints 0077. umask and rlimits survive fork and execve per POSIX, on macOS as well.
FIX: Replace the umask MUST with:

"acctshift MUST NOT change the process umask. It creates every file with `os.OpenFile(p, O_CREATE|O_EXCL|O_WRONLY, 0o600)` and every directory with `os.Mkdir(p, 0o700)`, then `Chmod`s to the exact mode (umask can only remove bits)."

For core dumps, either:
- save the original RLIMIT_CORE at start and restore it immediately before `syscall.Exec` and `cmd.Start`, re-applying 0 after Start on the spawn path; or
- on Linux use `prctl(PR_SET_DUMPABLE, 0)`, which execve resets.

Add a contract test: the fake CLI records its umask and `ulimit -c`, and both must equal the caller's.

## 4. [major] §12.3 POSIX launch (Linux, macOS), spawn path
PROBLEM: "acctshift ignores SIGINT and SIGQUIT itself" naturally becomes `signal.Ignore` (or SIG_IGN) before `cmd.Start`. Ignored dispositions are inherited across fork and exec, so agy and every shell command it runs start with SIGINT and SIGQUIT ignored. Ctrl+C and the agent's own cancellation of tool subprocesses stop working. The spec forbids `signal.Ignore` only in the Windows section.
EVIDENCE: Verified with go1.24.7: after `signal.Ignore(SIGINT, SIGQUIT)`, a child's `/proc/self/status` shows `SigIgn: 0000000000000006`. After `signal.Notify(ch, SIGINT)`, the child shows only the SIGQUIT bit, because the Go runtime resets caught signals to SIG_DFL in the forked child. §12.4 forbids `signal.Ignore(os.Interrupt)` for Windows only.
FIX: Replace the bullet with:

"acctshift catches SIGINT and SIGQUIT with `signal.Notify(ch, syscall.SIGINT, syscall.SIGQUIT)` and drains the channel. It installs this before `cmd.Start`, so the child starts with default dispositions. `signal.Ignore` and SIG_IGN MUST NOT be used on any OS. acctshift forwards SIGTERM and SIGHUP to the child."

Add a contract test: the fake CLI records its ignored-signal mask (Linux `SigIgn`; macOS via `sigaction` query), and it must equal the caller's.

## 5. [major] §12.4 Windows launch (job object)
PROBLEM: "Start the child suspended, assign it to the job, resume it" cannot be done with os/exec. Go's Windows StartProcess closes the primary thread handle, so there is nothing to `ResumeThread`. An implementer will likely start the child unsuspended and assign it afterwards, which leaves a race in which early grandchildren escape the job. The spec also does not decide breakaway: whether CLIs that launch persistent daemons with CREATE_BREAKAWAY_FROM_JOB (for example a Codex app-server) are killed on close or fail to start.
EVIDENCE: Go source `syscall/exec_windows.go:395` (go1.24.7): `defer CloseHandle(Handle(pi.Thread))`. R01 §2.4: SysProcAttr has no job or thread-handle field. R01 C10 itself recommends "Assign self to a kill-on-close job before spawning".
FIX: Specify one mechanism:

"Create the job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (and explicitly without `BREAKAWAY_OK`/`SILENT_BREAKAWAY_OK`). Then either:
(a) call `windows.CreateProcess` directly (x/sys) with `CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT`, an explicit handle list for stdio, `AssignProcessToJobObject`, then `ResumeThread(pi.Thread)`; or
(b) assign acctshift's own process to the job before `cmd.Start`, so the child inherits membership with no race (nested jobs, Windows 8+)."

State that daemons started by the CLI die when acctshift exits on Windows, unlike on POSIX, and add that to V-W1.

## 6. [major] §13.1 Locks (lock-file contents, Windows LockFileEx)
PROBLEM: The holder writes its JSON into the lock file it has locked. On Windows LockFileEx locks are mandatory over their byte range: gofrs/flock locks 1 byte at offset 0. As a result:
- a shared holder cannot write that range at all, including its own handle;
- under an exclusive lock, `doctor` and waiters (which must print "held by pid N, account X") get ERROR_LOCK_VIOLATION when they read it.

On POSIX, several shared holders overwrite each other's line.
EVIDENCE: Spec: "The holder writes {\"pid\":…,\"account\":…,\"since\":…} into the lock file" and "prints acctshift: waiting for the agy slot (held by pid N, account X)". "Windows uses LockFileEx on a dedicated lock file, never on a data file".

R01 §6 item 6: "Windows LockFileEx is mandatory on the byte range, so never lock the data file itself".

Microsoft LockFileEx: a shared lock "denies all processes write access to the locked region"; an exclusive lock denies other processes read access.
FIX: "The lock is taken on a 1-byte range at a fixed offset beyond any data (e.g. offset 0x7FFFFFFF) on every OS, or the lock file stays empty. Holder diagnostics go to per-holder sidecar files `locks/agy-slot.holders/<pid>-<starttime>.json`, created after acquiring the lock and deleted before releasing it. Readers ignore entries whose process is gone (see the pid-identity rule). No code ever writes into a locked byte range."

## 7. [major] §8.3.3 Lock modes / step 1 Recovery / §13.1
PROBLEM: Nothing says how a run moves from shared to exclusive:
- The lock mode must be chosen before step 1, but the live owner is known only after reading the slot (step 3). If it is decided from `state.agySlot`, a manual agy `/login` makes the record stale.
- When a shared holder finds the slot holds another account, the spec is silent.
- Journal recovery (which may write the slot) is allowed under whichever lock was taken, including shared, while other shared holders' agy processes run.

In-place conversion is unsafe on both OS families: flock conversion is not atomic, and on Windows LockFileEx cannot convert; requesting exclusive on a range the same handle holds shared blocks.
EVIDENCE: Spec: "A run whose account already equals the live slot owner takes the lock shared"; step 1: "Take agy-slot.lock (§13.1), then recover from any stale journal"; §13.3: "any acctshift command that touches agy first checks the journal while holding agy-slot.lock". flock(2): "Converting a lock ... is not guaranteed to be atomic".
FIX: Add to §8.3.3:
"1. Take the lock shared and read every reachable slot.
2. If a journal exists, or any slot in the write set does not hold the requested account by email, release the shared lock, create the intent marker, acquire the lock exclusive, and restart from Recovery.
3. Never convert a held lock in place.
4. Journal recovery and every slot write (swap, restore, fail-closed delete) MUST run only under the exclusive lock.
5. `state.agySlot` is a hint for `pick` only and never decides the lock mode."

## 8. [major] §13.3 agy swap journal / §13.1 agy-slot.intent (pid liveness)
PROBLEM: Stale-state decisions use only "pid is (not) alive". PIDs are reused quickly on Windows, and in containers every run starts from low PIDs. A stale journal or intent therefore often names a live, unrelated process, sometimes the current acctshift itself. Recovery is then skipped forever, or shared requests wait out --slot-wait every time.
EVIDENCE: §13.3: "If the journal exists and its pid is not alive". §13.1: "new shared requests wait while it exists and its pid is alive". Example: in Docker with a volume-mounted home, acctshift is typically PID 7–20 in every container, so a journal left with pid 9 is "alive" whenever the current run happens to be PID 9.
FIX: "Liveness is (pid, start time):
- Linux: field 22 of /proc/<pid>/stat;
- macOS: `kinfo_proc.kp_proc.p_starttime` via sysctl kern.proc.pid;
- Windows: GetProcessTimes creation time.

A record whose pid is absent or whose start time differs is dead. A journal found while holding the exclusive slot lock is stale by definition (its writer's lock died with it) and is recovered without any liveness check. Intent markers also expire after --slot-wait + 10 s."

## 9. [major] §13.2 Atomic writes (Windows) and §6.4 .corrupt rename
PROBLEM: Lock-free readers (pick, list, status, vault reads, Defender, the search indexer) open files without FILE_SHARE_DELETE. MoveFileEx(REPLACE_EXISTING) onto a file open that way fails with ERROR_ACCESS_DENIED, not a sharing violation, so the specified retry never fires. Readers can also hit transient ACCESS_DENIED during a replace. With several queues in parallel, `next`, `mark` and agy save-back will fail sporadically on Windows.
EVIDENCE: Spec: "MoveFileEx with REPLACE_EXISTING, retrying up to 5 times with 50 ms backoff on sharing violations"; "Readers never need the lock".

Go source `syscall/syscall_windows.go:374` (go1.24.7): `sharemode := uint32(FILE_SHARE_READ | FILE_SHARE_WRITE)`, with no FILE_SHARE_DELETE.

Go's own `cmd/internal/robustio` treats ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND and ERROR_SHARING_VIOLATION as ephemeral on Windows and retries for up to 2000 ms.
FIX: "On Windows:
- readers open state, registry and vault files with `windows.CreateFile(..., FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE, ...)`;
- writers replace with `SetFileInformationByHandle(FileRenameInfoEx, FILE_RENAME_FLAG_REPLACE_IF_EXISTS|FILE_RENAME_FLAG_POSIX_SEMANTICS)` where supported, else MoveFileEx;
- writers retry ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION and ERROR_LOCK_VIOLATION, and readers retry those plus ERROR_FILE_NOT_FOUND, with exponential backoff up to 2 s.

The same rules apply to the `.corrupt-<epoch>` rename and the agy token-file write."

## 10. [major] §17.6 Installer scripts (vs §6.1 root and permissions)
PROBLEM: Several problems with how the installers treat the root:
- install.sh and install.ps1 "write <root>/install.json", so they create the root with the shell's default umask (0755) and install.json as 0644. Every later command that reads secrets then refuses with exit 78, because the root is group- or world-accessible. Unattended LimitShift silently falls back to legacy.
- The default Windows install dir `%LOCALAPPDATA%\acctshift\bin` is inside the default root. That contradicts "Never touch anything under <root> except install.json" and "a single directory can be ... wiped".
- install.ps1 also creates the root before acctshift can apply its protected DACL.
EVIDENCE: §6.1: "If the root, vault.* or state.json is group- or world-accessible, it MUST refuse to read secrets ... (exit 78)". §17.6: "%LOCALAPPDATA%\acctshift\bin on Windows", "Write <root>/install.json", "Never touch anything under <root> except install.json".
FIX: "Default Windows install dir: `%LOCALAPPDATA%\Programs\acctshift` (outside the root). Installers never create the root themselves. After verification they run `"<bin>/acctshift" self-update --record-install script --path <bin>`, so only acctshift creates the root (0700, protected DACL) and writes install.json (0600)."

Additionally: "If acctshift finds its root at a looser mode and owned by the current user, it tightens it to 0700 and prints one `acctshift:` notice, instead of exit 78."

## 11. [major] §17.6 Installer scripts / §17.7 Self-update (macOS arm64 upgrade)
PROBLEM: "Upgrades replace only the binary" does not say how. On Apple silicon, overwriting an existing signed (including ad-hoc signed) Mach-O in place with `cp`, `cat >`, or tar extraction over the file invalidates the kernel's cached code signature for that vnode. The next launch is SIGKILLed ("Killed: 9", exit 137). LimitShift's version probe then fails and it silently drops to legacy.
EVIDENCE: §17.6 says only "Upgrades replace only the binary". §17.7 specifies rename only for self-update ("write next to the binary, then fsync, chmod and rename"). §4.1: "arm64 binaries carry the Go linker's ad-hoc signature automatically".
FIX: Add to §17.6:

"install.sh MUST extract into a temporary directory on the same filesystem as the target, `chmod 0755`, then `mv -f` (rename) over the destination. It never cp's, cats or untars in place over an existing binary. install.ps1 uses Move-Item after renaming a running exe to `.old`."

Add a macOS arm64 CI test: install vN, run it, upgrade to vN+1 with install.sh, run again, and require exit ≠ 137.

## 12. [major] §16 Phase 2: interactive run wrapper (POSIX process groups)
PROBLEM: `run` uses "the spawn path of §12.3", which puts the child in acctshift's own process group, but then stops the child with "SIGTERM to the group". That kills acctshift, and possibly the caller's shell job, before it can call `next` and relaunch. Moving the child to its own group (Setpgid) without handing it the terminal makes an interactive TUI stop on SIGTTIN/SIGTTOU.
EVIDENCE: §16 step 1: "using the spawn path of §12.3/§12.4"; step 3: "POSIX SIGTERM to the group, SIGKILL after 3 s". §12.3: "start the child in the same process group".
FIX: Specify for `run` on POSIX:
"The child is started with `Setpgid:true`. If stdin is a TTY and acctshift owns the foreground group, acctshift calls `tcsetpgrp(ttyfd, childPgid)` right after Start, with SIGTTOU blocked. It restores its own group as foreground after the child exits or is stopped. Stopping the tree = `kill(-childPgid, SIGTERM)`, then SIGKILL after 3 s. SIGTSTP/SIGCONT are relayed so job control keeps working."

Keep §12.3's same-group rule for `exec` only, and say so explicitly.

## 13. [major] §8.2 codex, Overlay home
PROBLEM: "Never under a symlinked parent" makes overlays impossible whenever the root's path contains any symlink:
- macOS `$TMPDIR` and Go's `t.TempDir()` live under /var → /private/var, so the §18.2 contract tests with a temporary ACCTSHIFT_HOME fail on macOS;
- /tmp → /private/tmp on macOS;
- homes or /home reached through a symlink (OSTree/Fedora Atomic /home → var/home, admin-relocated homes).

No fix-up is defined.
EVIDENCE: Spec: "It is a real directory (0700), never a symlink or junction, and never under a symlinked parent." R07 C7: Codex's keyring key uses `canonicalize(CODEX_HOME)`, "canonicalize resolves symlinks".
FIX: Replace with:

"The overlay leaf MUST be a real directory (not a link or junction). At `add`, acctshift resolves it with `filepath.EvalSymlinks`, records that canonical path, and always exports the canonical path as CODEX_HOME (this also avoids Seatbelt's `contains symlink component` rejection). `doctor` reports an error if `EvalSymlinks(recorded) != recorded`."

## 14. [major] §8.3.3 step 2 Foreign-process check / §5.1 procscan
PROBLEM: "Not started by an acctshift holding the lock" cannot be implemented as written:
- On macOS there is no way to tell which process holds a flock (no /proc/locks).
- The lock file's holder pid is "diagnostics only" and gets overwritten by shared holders.
- Windows Toolhelp32 parent pids are unreliable after the parent exits (pids are reused).

Matching by bare name is also fragile:
- The agy CLI binary itself is named `antigravity` on Linux and macOS [R05 §a], which is presumably also the name of the Antigravity desktop IDE's processes (to verify). An open IDE would then block every swap.
- Windows names other than `agy.exe` (e.g. `antigravity.exe`) are missed.
- On Linux `/proc/<pid>/comm` shows the exec'd symlink name.

Descendants of agy that outlive it (daemons) survive on POSIX after the lock is released, so the next swap either blocks forever or must judge them.
EVIDENCE: Spec: "If any agy, antigravity or agy.exe process not started by an acctshift holding the lock is running for this user (the remote-control daemon and language server included)"; §13.1: holder JSON is "for diagnostics only". R05 §a: "Linux/macOS artifacts are .tar.gz containing one binary named antigravity". R07 §1: agy has `remotecontrol.(*Daemon)`.
FIX: Rewrite step 2:
"Identify agy processes by executable path, not name:
- Linux `/proc/<pid>/exe`; macOS `proc_pidpath` or sysctl KERN_PROCARGS2; Windows `QueryFullProcessImageName`.
- Compare against the realpath of the resolved agy binary plus the sidecar paths in facts.go.

In exclusive mode, every such process of this uid is foreign; no ancestry test is needed.

In shared mode, a process is 'owned' if its parent chain (each link validated by start time ≤ the child's) reaches a live process whose executable is acctshift.

Before releasing the lock after the run, acctshift waits up to 5 s for, then terminates, the child's remaining descendants:
- Linux: `prctl(PR_SET_CHILD_SUBREAPER)` and reap;
- macOS: walk ppid/pgid from the child pid;
- Windows: the job."

Add a VERIFY item: does the Antigravity desktop IDE share the `gemini`/`antigravity` slot, and what are its process paths?

## 15. [major] §17.1 Toolchain (CI guard) / §18.4
PROBLEM: The no-cgo guard is broken both ways. On ubuntu-latest CGO_ENABLED defaults to 1, and the guard prints `runtime/cgo` and `net` for any program that imports net/http (self-update) or godbus, so CI is always red. Under CGO_ENABLED=0 a cgo-only dependency is excluded by build constraints, so the guard prints nothing; it only fails through the exit status, which a typical `test -z "$(…)"` ignores. So the guard never catches the darwin cross-build break it exists for.
EVIDENCE: Spec: "fail if go list -deps -f '{{if .CgoFiles}}{{.ImportPath}}{{end}}' ./... prints anything."

Verified with go1.24.7:
- CGO_ENABLED=1: prints `runtime/cgo` and `net` for a main importing net/http.
- CGO_ENABLED=0 GOOS=darwin with a dependency containing only `import "C"`: prints nothing, exits 1 ("build constraints exclude all Go files").
- CGO_ENABLED=1 with `{{if and .CgoFiles (not .Standard)}}`: prints only the offending module.
FIX: Replace with:

"For each of the six GOOS/GOARCH pairs, run `CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build ./...` and fail on a non-zero exit. Additionally, with CGO_ENABLED=1, run `go list -deps -f '{{if and .CgoFiles (not .Standard)}}{{.ImportPath}}{{end}}' ./...` and fail if it prints anything."

## 16. [major] §12.2 Resolving the cli binary / §12.5 Environment construction (WSL)
PROBLEM: Under WSL, `ACCTSHIFT_<CLI>_BIN` or PATH can resolve to a Windows executable through interop (/mnt/c/..., e.g. a Windows-only agy.exe or claude.exe install). A Windows process started from WSL receives Linux environment variables only if they are listed in WSLENV, so the set list (CLAUDE_CODE_OAUTH_TOKEN, CODEX_HOME, …) and the unset list never apply. The CLI runs as the Windows native login: a wrong-account run.

For agy, acctshift would also swap the WSL-side file slot while Windows agy reads Windows Credential Manager or %USERPROFILE%.
EVIDENCE: §4.1 claims WSL support. §12.2 has no check on the resolved binary's platform. Microsoft WSL interop documentation: environment variables are shared between WSL and Windows only through WSLENV.
FIX: Add to §12.2:

"On Linux, if `/proc/sys/fs/binfmt_misc/WSLInterop` (or `WSLInterop-late`) exists and the resolved binary is on a drvfs/9p mount or starts with the PE magic `MZ`, `exec` MUST refuse with 126 `wsl-windows-binary` (hint: install the Linux build inside WSL, or run the Windows acctshift from Windows). `add` and `doctor` apply the same check."

## 17. [major] §3 Glossary (account name rule) / §6.1 homes/
PROBLEM: The account-name regex allows names that Windows treats as the same path, or as devices:
- A trailing '.' is allowed (`work.`). Win32 path normalisation strips trailing dots, so `homes\codex\work.` and `homes\codex\work` are the same directory. Two accounts then share one overlay and one single-use refresh token, exactly what D5 forbids, and runs go to the wrong account.
- Reserved device names (`con`, `nul`, `aux`, `prn`, `com1`, `lpt1`) are allowed and cannot be created as directories.
EVIDENCE: §3: "Names match ^[a-z0-9][a-z0-9._-]{0,31}$". §8.2/§8.4: overlay dir = `<root>/homes/<cli>/<account>`. Go adds the `\\?\` prefix only for long paths, so short paths get Win32 normalisation.
FIX: Change to `^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$` (no trailing '.', '-' or '_'). Also reject, on every OS so registries stay portable, the basenames `con`, `prn`, `aux`, `nul`, `com0`–`com9`, `lpt0`–`lpt9`, `conin$`, `conout$`, alone or followed by '.' and an extension.

## 18. [major] §8.3.1 Slot facts (File row) / §8.3.4 / Appendix B
PROBLEM: The file-slot candidate list leaves out the language-server/standalone token file that R05 found. agy's embedded language server and remote-control build their storage through `authclient.NewAuthClient` / `NewFileTokenStorage` at `$HOME/.gemini/jetski-standalone-oauth-token`. A stale account there is neither saved back, written, nor fail-closed deleted, and `add` cannot see it change.
EVIDENCE: R05 §a: "Standalone/language-server default: ~/.gemini/jetski-standalone-oauth-token (NewFileTokenStorage joins $HOME + .gemini + jetski-standalone-oauth-token)"; "the embedded language-server/remote-control build it via authclient.NewAuthClient". The spec's File row lists only `antigravity-cli/antigravity-oauth-token` and `.gemini/antigravity-oauth-token`.
FIX: Add `<home>/.gemini/jetski-standalone-oauth-token` as a third file candidate in §8.3.1, the §8.3.4 snapshot/diff set, the §8.3.2 write-set rule (fail-closed delete if it holds a credential that cannot be matched) and Appendix B. Extend V-A2: "which file(s) does the language server read and write during `agy -p` in keyring and in file mode".

## 19. [major] §12.3 POSIX launch vs §8.4 gemini / §12.6
PROBLEM: Contradiction: §12.3 says the execve path is "the normal case for claude, codex, gemini and copilot", but gemini's default `home` kind copies settings.json back after every run, which requires the spawn path on POSIX too. The spawn-path trigger `--track` appears nowhere in the §10.2 or §12.1 exec syntax.
EVIDENCE: §12.3: "execve path (no lock to hold and no post-run hook; the normal case for claude, codex, gemini and copilot)"; "spawn path (agy; any account with copy-back; --track)". §8.4: "Copy-back after the run: settings.json only, if its hash changed". §10.2 exec flags: `--account | --prefer, --pool, --slot-wait, --status-file` only.
FIX: In §12.3 write: "execve path: claude (all kinds), codex on POSIX, copilot, gemini `native`/`api-key`. Spawn path: agy, gemini `home` (copy-back), Windows always." Then either add `--track` to §10.2 and §12.1 (forces the spawn path and records `lastUsedAt` and the exit status) or delete it.

## 20. [minor] §12.3 POSIX launch (macOS kqueue SHOULD)
PROBLEM: Watching the child with kqueue EVFILT_PROC/NOTE_EXIT gives acctshift nothing it does not already get from wait4. The problem being solved is acctshift being SIGKILLed, and a watcher inside the killed process cannot help. An implementer would add dead code and believe macOS has a Pdeathsig equivalent.
EVIDENCE: Spec: "macOS has no equivalent: acctshift SHOULD watch the child with kqueue EVFILT_PROC/NOTE_EXIT for prompt cleanup".
FIX: Delete the SHOULD and state:

"On macOS a SIGKILL of acctshift leaves the child running. Safety relies on the journal (§13.3) and on the foreign-process check, because the orphan's parent becomes launchd."

Optionally: spawn through a small guard process (`acctshift __guard`) that watches its parent with kqueue NOTE_EXIT on getppid() and sends SIGTERM to the CLI.

## 21. [minor] §12.3 POSIX launch (Linux Pdeathsig)
PROBLEM: Pdeathsig fires when the OS thread that forked the child exits, not when the process does. In Go that thread can go away while acctshift is still alive (for example a goroutine that exits while holding LockOSThread), which would SIGTERM agy mid-run.
EVIDENCE: Spec: "Linux: set Pdeathsig = SIGTERM". Go syscall docs note that Pdeathsig is sent on thread termination (golang/go#27505).
FIX: Add: "The goroutine that calls `cmd.Start` with Pdeathsig MUST call `runtime.LockOSThread()` first and stay locked until `cmd.Wait` returns."

## 22. [minor] §12.4 Windows launch (Ctrl+C / console close)
PROBLEM: Problems with the allowed Windows handlers:
- The `SetConsoleCtrlHandler(NULL, TRUE)` alternative ignores only CTRL_C. Ctrl+Break still runs the default handler (ExitProcess), and the kill-on-close job then kills the CLI without the agy save-back.
- With either option, closing the console window (CTRL_CLOSE_EVENT, which Go delivers as SIGTERM) is unhandled, so there is no save-back within the ~5 s Windows allows.
EVIDENCE: Spec lists two allowed implementations: `signal.Notify(ch, os.Interrupt)`, or `SetConsoleCtrlHandler(NULL, TRUE)` after spawn. Microsoft SetConsoleCtrlHandler: a NULL handler with TRUE affects CTRL+C input only.
FIX: Require `signal.Notify(ch, os.Interrupt, syscall.SIGTERM)` on Windows. Go maps CTRL_C and CTRL_BREAK to os.Interrupt, which acctshift drains, and CTRL_CLOSE/LOGOFF/SHUTDOWN to SIGTERM, on which acctshift runs the agy post-run save-back at once and exits. Drop the SetConsoleCtrlHandler(NULL, TRUE) alternative.

## 23. [minor] §7.5 Non-interactive guarantees / §7.3 key-source defaults (macOS, Windows)
PROBLEM: Three problems:
- "Never open any OS dialog" cannot be guaranteed on macOS. When the login keychain is locked in a GUI session, `/usr/bin/security` makes SecurityAgent show an unlock dialog, and `security` has no flag to forbid UI.
- The macOS (keychain) and Windows (DPAPI) defaults are chosen unconditionally, even when the vault is created over SSH, where they are likely to fail or need V-K1 and V-W1.
- The failure hint `vault migrate --to key-file` is wrong when no vault exists yet.
EVIDENCE: §7.5: "What it then never does: open any OS dialog". §7.3: keychain is the default for "macOS" and dpapi for "Windows" with no conditions, while the Linux default has conditions. "The hint names the unlock command or acctshift vault migrate --to key-file."
FIX: In §7.5 replace with: "acctshift never deliberately requests UI. On macOS a locked keychain may still show an unlock dialog. acctshift bounds it with the 3 s probe and kills `security`, and V-K1 records whether the dialog persists."

In §7.3: at vault creation on macOS and Windows, if SSH_CONNECTION, SSH_TTY or SSH_CLIENT is set, require `--key-source` (non-interactive: default to key-file with a stderr notice).

When no vault exists, the hint is `--key-source key-file` / `ACCTSHIFT_KEY_SOURCE=key-file`.

## 24. [minor] §6.1 Root directory / §13.1 Network filesystems
PROBLEM: On WSL drvfs (/mnt/c without metadata), FAT/exFAT, SMB, and Docker Desktop bind mounts on macOS, mode bits are fixed (often 0777) and chmod has no effect. The 0600/0700 refusal then fires forever, with a chmod hint that cannot work. On NFS homes shared across hosts, both acctshift's root and agy's ~/.gemini slot are visible to other machines whose agy processes the foreign-process check cannot see. A doctor warning about locks is not enough.
EVIDENCE: §6.1: refuse when "group- or world-accessible ... print the chmod fix (exit 78)". §13.1: only "doctor warns that advisory locks may not work".
FIX: "At first use, statfs the root:
- Linux f_type: V9FS 0x01021997, NFS 0x6969, CIFS 0xFF534D42, SMB2 0xFE534D42, MSDOS 0x4d44, exFAT 0x2011BAB0;
- macOS f_fstypename: nfs, smbfs, msdos, exfat.

On a filesystem that cannot hold POSIX modes, exit 78 `unsupported-filesystem` with the hint to set ACCTSHIFT_HOME to a local path. On NFS, refuse agy swaps unless `settings.agyAllowNetworkHome` is true, because agy on other hosts sharing ~/.gemini is invisible."

## 25. [minor] §6.1 Root directory / §7.3 key-file location (XDG differences between contexts)
PROBLEM: The Linux root and key-file depend on XDG_DATA_HOME and XDG_CONFIG_HOME at every call. These differ between contexts: snap-packaged editors' terminals (e.g. snap VS Code overrides XDG_* for its children), systemd units, cron, sudo. In such a context LimitShift sees an empty registry and silently drops to legacy (69), or cannot find the key file (74). XDG_DATA_HOME is also not checked to be absolute, although XDG says relative values are invalid.
EVIDENCE: §6.1: "${XDG_DATA_HOME:-~/.local/share}/acctshift"; only ACCTSHIFT_HOME must be absolute. §7.3: "${XDG_CONFIG_HOME:-~/.config}/acctshift/vault.key". The vault header records only a "key-source id".
FIX: - Ignore a relative XDG_* value, as the XDG spec requires.
- Record the absolute key-file path in the vault header at creation and always use it.
- `version --json` and `doctor --json` report `root` and `rootSource` (ACCTSHIFT_HOME | XDG_DATA_HOME | default).
- `doctor` warns when XDG_DATA_HOME or XDG_CONFIG_HOME point under `~/snap/` or `~/.var/app/`.

## 26. [minor] §11.1 Framing rules (PowerShell 5.1)
PROBLEM: Windows PowerShell 5.1 decodes a native command's stdout with [Console]::OutputEncoding, which defaults to the OEM code page (437/866/…). UTF-8 JSON containing non-ASCII therefore arrives mangled in `$raw`: snippets with U+2019, which §11.2's own example has, and labels or emails. Callers that compare or log those strings break.
EVIDENCE: §11.1: "exactly one line of UTF-8 JSON (no BOM)". §11.2 classify example: "snippet":"You’ve hit your usage limit…". The §11.3 PowerShell recipe captures `& $AcctShift … --json` without setting OutputEncoding.
FIX: Add rule: "--json output MUST be pure ASCII: every code point above 0x7E is emitted as a \\uXXXX escape (surrogate pairs for astral characters)." Add a Pester test under 5.1 that round-trips a U+2019 snippet.

## 27. [minor] §17.6 Installer scripts (PATH, arch detection, downloader)
PROBLEM: Gaps in install.sh and install.ps1:
- `~/.local/bin` is not on PATH by default on macOS, and the Unix PATH change is unspecified (which rc file, which shell).
- `uname -m` reports x86_64 in a Rosetta shell on Apple silicon, so the x64 binary is installed.
- On Windows, `RuntimeInformation.OSArchitecture` and PROCESSOR_ARCHITECTURE report x64 inside an emulated x64 PowerShell on ARM64.
- Alpine has busybox wget but no curl.
EVIDENCE: §17.6: "Default install dir: ~/.local/bin on Unix"; "ACCTSHIFT_NO_MODIFY_PATH=1 opts out of the PATH change"; "Architecture detection: uname -s / uname -m. On Windows, [RuntimeInformation]::OSArchitecture, then PROCESSOR_ARCHITEW6432 / PROCESSOR_ARCHITECTURE".
FIX: Specify:
- If the install dir is not on PATH, append an idempotent marked line to the login-shell rc chosen from $SHELL (zsh → ~/.zprofile; bash → ~/.bash_profile on macOS, ~/.bashrc on Linux; fish → `fish_add_path`) unless ACCTSHIFT_NO_MODIFY_PATH=1, and print it.
- On Darwin, use arm64 when `sysctl -n sysctl.proc_translated` prints 1.
- Support curl or wget.
- install.ps1 reads the native architecture from `HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment` PROCESSOR_ARCHITECTURE (or IsWow64Process2) before falling back.

## 28. [minor] §7.4 macOS security rules vs §8.3.2 write set
PROBLEM: For agy's macOS keychain slot, §7.4 says to fail with `keychain-line-too-long` when the line exceeds 4096 bytes. The fail-closed rule (snapshot, then delete a slot that cannot take the blob) is stated only for "Windows keyring over 2560 B". With a 2–4 KB token, base64 inflation pushes the line over 4096. agy itself then stores that token in its file, while an older keychain item for another account stays first in agy's lookup.
EVIDENCE: §7.4: "If it would exceed 4096 bytes, fail with error.code = keychain-line-too-long". §8.3.2: "If a slot that holds a credential cannot accept the incoming blob (Windows keyring over 2560 B), acctshift snapshots it and then deletes it". §7.1: agy snapshots are "probably 2–4 KB".
FIX: In §8.3.2 write "(Windows keyring over 2560 B, or a macOS `security -i` line over 4096 bytes)". In §7.4, limit `keychain-line-too-long` to acctshift's own key.

## 29. [minor] §8.1 claude: add --native detection and apiKeyHelper settings
PROBLEM: Three gaps:
- macOS native detection checks only the unsuffixed item and uses `$USER`. Claude Code appends `-<sha256(dir)[0:8]>` when CLAUDE_CONFIG_DIR or CLAUDE_SECURESTORAGE_CONFIG_DIR is set, and falls back to the account `claude-code-user`, so detection gives false negatives.
- The managed-settings paths that must be scanned for apiKeyHelper are given for no OS.
- 'project (--cwd)' refers to a flag exec does not have.
EVIDENCE: §8.1: "/usr/bin/security find-generic-password -s 'Claude Code-credentials' -a $USER"; "apiKeyHelper in the user, project (--cwd) or managed settings". R07 §2: service suffix `-${sha256(dir)[:8]}` when either env var is set; account `$USER` (fallback `claude-code-user`).
FIX: - Compute the service and account exactly as R07 §2 describes.
- List the managed-settings paths per OS in claude `facts.go` and Appendix B (macOS `/Library/Application Support/ClaudeCode/managed-settings.json`, Linux/WSL `/etc/claude-code/managed-settings.json`, Windows `C:\Program Files\ClaudeCode\managed-settings.json`), marked VERIFY.
- Define 'project' as exec's working directory.

## 30. [minor] §12.4 Windows launch, npm shim step 2
PROBLEM: Launching the package's native binary directly bypasses the npm JS launcher's environment setup. The Codex launcher is understood to prepend its vendored ripgrep directory to PATH and set CODEX_MANAGED_BY_NPM before spawning codex.exe (to verify against the installed package). Behaviour then differs from a normal launch, and reproducing that setup would break §12.5's "MUST NOT change PATH".
EVIDENCE: §12.4 step 2: "MAY launch that binary directly when the package layout matches the facts file". §12.5: "acctshift MUST NOT change HOME, USERPROFILE, CLAUDE_CONFIG_DIR, XDG_* or PATH".
FIX: Delete step 2, or limit it to packages whose facts.go entry records that the JS launcher changes no environment. Otherwise always use step 1 (`node.exe <entry.js> <args…>`).

## 31. [minor] §1.4 NFR1 / §18.4 latency gate
PROBLEM: "Under 50 ms cold on every OS" is ambiguous and probably false on Windows and macOS:
- the first run of a new or updated binary is scanned by Defender, or assessed by syspolicyd/XProtect on macOS;
- R01 measured start-up only on Linux;
- the CI gate uses "median of 50 cold runs", which are warm in practice.
EVIDENCE: NFR1: "MUST finish in under 50 ms cold on every OS". R01 §2.3: "Windows/macOS start-up was not measured. [INFERRED] Windows is typically slower on first run because Defender scans new executables."
FIX: Define cold as "a new process with a warm file cache, excluding the first execution after install or update". Measure and report the first execution separately, without gating on it.

## 32. [minor] §12.1.1 exec's own failures (POSIX E2BIG)
PROBLEM: Only the Windows command-line limit is mapped. On POSIX, `execve` and `cmd.Start` return E2BIG when a single argument exceeds 128 KiB on Linux (MAX_ARG_STRLEN; LimitShift passes whole prompts and handoff notes as one `-p` value), or when argv plus env exceeds ARG_MAX (about 1 MiB on macOS). The exit code is left to the implementer.
EVIDENCE: §12.1.1 table: "cmdline-too-long | the Windows command line would exceed 32,767 characters".
FIX: Change the row to "Windows: over 32,767 characters; POSIX: execve/posix_spawn returned E2BIG", with exit 125 `cmdline-too-long` on both.

## 33. [minor] §6.1 Permissions (ownership)
PROBLEM: Only mode bits are checked. macOS sudo keeps HOME by default, so `sudo acctshift …` creates root-owned 0600 files in the user's root. Later runs as the user fail with EACCES, which surfaces as 74 or 78 with a misleading chmod hint.
EVIDENCE: §6.1: refuse only if "group- or world-accessible". §6.1: the home directory comes from $HOME.
FIX: Add: "Every file and directory acctshift reads or writes under the root and the key-file directory MUST have st_uid == geteuid(). When euid is 0 and $HOME is owned by another uid, acctshift refuses before creating anything (exit 78 `wrong-owner`, hint `run without sudo`)."

## 34. [minor] §18.3 OS integration tests (macOS) / §7.4
PROBLEM: The test-only `ACCTSHIFT_TEST_KEYCHAIN` override cannot work with the commands as specified. §7.4's lines name no keychain, so writes go to the user's default keychain and reads search the user's search list; a temporary keychain is never touched unless every call passes its path.
EVIDENCE: §7.4 commands: `add-generic-password -U -s <svc> -a <acct> …`, `find-generic-password -s <svc> -wa <acct>` (no keychain argument). §18.3: "a temporary keychain ... selected through the test-only ACCTSHIFT_TEST_KEYCHAIN override, so the CI user's login keychain is never touched".
FIX: Add to §7.4:

"Every `security` invocation, including `-i` lines, ends with an explicit keychain path from one function. In production this is the user's default keychain, resolved once per process with `security default-keychain -d user` (where agy also writes). In tests it is `ACCTSHIFT_TEST_KEYCHAIN`."

## 35. [minor] §18.3 / §18.4 CI coverage (darwin/amd64, WSL1)
PROBLEM: Two supported targets have no assured CI coverage:
- darwin/amd64 is supported and macOS is release-blocking, but CI has it only "where a runner exists".
- WSL1 is claimed in §4.1, but only "a WSL2 smoke job where a runner is available" is planned. Neither the R01 C2 evidence (readelf plus an empty chroot) nor that job exercises WSL1-specific kernel emulation (flock, prctl, /proc).
EVIDENCE: §4.1: "macOS | arm64, x64"; Linux row: "WSL1/2". §18.3: "macOS arm64 (and Intel where a runner exists)". §18.4: "the contract tests on all six OS/arch runners"; "A WSL2 smoke job where a runner is available".
FIX: - Make darwin/amd64 mandatory: run the contract tests on an Intel macOS runner while one exists (e.g. macos-15-intel), otherwise run the amd64 binary under Rosetta 2 on the arm64 runner (`arch -x86_64`).
- Either add a WSL1 smoke job (setup-wsl with WSL1 on windows-latest) or drop WSL1 from §4.1 until it has been tested.
