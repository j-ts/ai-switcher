## 7. Secret storage (the vault)

### 7.1 What acctshift stores and where

**The vault holds only secrets acctshift owns:**
- Claude setup-tokens (about 100 B; Claude Code itself never saves them to disk, so acctshift holds the only copy [R04 C4]);
- Copilot PATs;
- Codex access tokens and API keys;
- Gemini API keys;
- **parked agy snapshots**: the token JSON of each agy account while it is *out* of agy's slot (size unmeasured; R05 C7 expects it to exceed 2560 B, **VERIFY V-A4**);
- **agy recovery copies** under reserved ids (§7.2): slot content whose owner is not a registered account, and the per-swap backup of the outgoing slot content.

**It never holds:**
- vendor-owned refreshable credentials: Codex or Gemini overlay-home files, or the live agy slot (one credential, one owner [R09 §1.6]);
- any per-account secret in an OS store. The OS store holds exactly **one 32-byte key per vault**, in an item named after that vault's key id (§7.3).

**Account metadata lives outside the vault**, in `accounts.json` / `state.json`: ids, names, kinds, labels, limits and expiry dates. Secret fingerprints live in the vault entries (Appendix D.3).
- `list`, `pick`, `next`, `mark`, `status`, `classify`, `enable`, `disable`, `order`, `rename`, `config`, `notice`, `vault status`, `env` without `--reveal-secrets`, and the non-secret `doctor` checks therefore **never open the keystore**.
- Only commands that need a secret value fetch the key, and at most once per process: `exec` for token kinds and agy, `env --reveal-secrets`, `add`, `login`, `remove`, `agy use`, `doctor --fix` (only when it recovers an agy journal, §9.6), `vault migrate`, `vault export`, `vault import`.
- `rename` never touches the vault: entries are keyed by the account's immutable id, not its name (§7.2).

**Secrets in memory.** Vault plaintext and secret values are handled as `[]byte`, never decoded into Go `string`s, so they can be zeroed.
- Before launching a CLI, acctshift extracts only the entry the run needs and zeroes the rest of the plaintext.
- On the spawn path (§12.3), the long-lived acctshift process keeps only the 32-byte data key (zeroed on exit) for the post-run agy save-back. It re-reads the vault file under `vault.lock` at that point instead of keeping the plaintext for the whole run.
- A post-run save-back that fails (the key is gone, `vault.lock` timed out, `vault-changed`) never changes `exec`'s exit status. It leaves the slot untouched, sets `state.agySlot.saveBackPending` (§6.3) and `postRunError` in the status file, and records an event; the next exclusive slot holder performs the save-back first (§8.3.3).

### 7.2 Format

`vault.v1.bin` = `header ‖ XChaCha20-Poly1305(dataKey, bodyNonce, plaintext, aad = header)`.
- **Header:** magic `ACSV`, format version 1, key-source id, a 16-byte key id, the absolute key-file path when the source is `key-file`, a 24-byte random body nonce (new on every write), and the wrapped data key.
- **Data key:** a random 32-byte key, wrapped by the **source key** (§7.3):
  - wrapped data key = `wrapNonce ‖ XChaCha20-Poly1305(sourceKey, wrapNonce, dataKey, aad = magic ‖ version ‖ keySourceId ‖ keyId)`, 72 bytes in total;
  - `wrapNonce` is 24 random bytes, new on every rewrap, and independent of the body nonce.
  - Rekeying or migrating key sources then rewraps 32 bytes instead of re-encrypting everything, and recovery wraps could be added later without a format change.
- **Plaintext:** JSON (Appendix D.3). Secret values are stored as opaque base64 bytes and never re-serialized. The decrypted size is capped at 1 MiB.
- **Entry ids (`secretId`).** An account's entry is `<cli>/<id>`, where `<id>` is the account's immutable 8-hex id (§6.2), for example `claude/3f9a01c2` or `agy/7c41d09e`.
  - The account name never appears in an entry id, so `rename` never rewrites the vault, and a removed and re-added name never meets an old entry.
  - `remove` deletes the account's entries in its transaction (§10.2).
- **Reserved agy ids.** Only the agy slot code writes them (§8.3.3, §8.3.4, §13.3); no account can have these ids, because `_` is not a hex digit:
  - `agy/_unregistered/<email>`: slot content for an email that no agy account has (save-back, the `add agy` / `login agy` capture, `remove agy --sign-out-slot`);
  - `agy/_unknown/<sha256-8>`: slot content whose owner cannot be identified (no `email` field and no decodable `id_token` email). `<sha256-8>` is the first 8 lowercase hex characters of the SHA-256 of the raw bytes;
  - `agy/_unparsed/<store>-<epoch>`: the raw bytes of a slot that still does not parse after a re-read;
  - `agy/_swap/<startedAt>`: the per-swap backup of the outgoing slot content, written in the save-back step before the journal, and named by the journal's `backupSecretId`. No other operation overwrites it. Recovery rolls back from it (§13.3).
  - There is no `agy/_last`. Nothing is ever restored from a shared "last" copy, whose content would depend on which operation wrote it last.
  - Reserved entries count toward the 1 MiB cap. Every swap adds an `agy/_swap/*` entry, so they are pruned: once a holder of the exclusive slot lock has finished its recovery step (§13.3), no journal names an earlier backup, and its first vault write deletes every `agy/_swap/*` entry written by an earlier operation. Its own new backup is never pruned while its journal exists. The other reserved entries are kept; `doctor` lists them with their size and `updatedAt`.
- **Integrity:** a failed tag is a hard error (exit 78, `vault-corrupt`; `exec`: 125 `vault-corrupt`) that leaves the file untouched and points to `vault import` of an export.
- **Concurrency:** writes are atomic (§13.2) under **`locks/vault.lock`** (separate from `state.lock`, so a slow keystore call never blocks state updates). A writer that cannot take `vault.lock` within 15 s exits 73 `vault-busy` (`exec`: 125 `vault-busy`, §13.1).
  - Every vault write MUST, under `vault.lock`, re-read the current file and compare its key id and wrapped data key with the ones this process unwrapped.
  - If they differ (for example a `vault migrate` ran while a long `exec agy` was in progress), acctshift unwraps again from the current header, or aborts with exit 74 `vault-changed` (`exec` before launch: 125 `vault-changed`; after launch it is a post-run failure, §7.1).
  - The new body is always written with the **current** header's wrapped key, never with one cached from earlier in the process.

Why an envelope rather than one OS item per secret (DECISIONS D7):
- it avoids the Windows 2560-byte and macOS `security -i` 4096-byte limits, which agy snapshots can exceed [R07 C6, R03 C6];
- it needs only one bounded keystore call per process;
- it works the same way on every OS, with a prompt-free path on headless machines;
- it gives real at-rest protection for the only on-disk copy of one-year Claude tokens.

### 7.3 Key sources (v1)

`<kid>` below is the lowercase hex of the vault's 16-byte key id. Every item and file is named per vault, so a second vault (another `ACCTSHIFT_HOME`, a test run, a second LimitShift profile) can never overwrite the key of the first.

| Source id | Where the 32-byte source key lives | Default when |
|---|---|---|
| `keychain` | macOS login keychain, generic password service `acctshift`, account `vault-key-v1-<kid>`, via `/usr/bin/security` (§7.4) | **macOS**, except when the vault is created over SSH (see Rules) |
| `secret-service` | Secret Service item `{service:"acctshift", username:"vault-key-v1-<kid>"}` in the `login` collection, else the collection behind the `default` alias. The target collection MUST be persistent: the alias must not resolve to `/org/freedesktop/secrets/collection/session` (which lives in memory only) or to `/` | **Linux**, only if **all** hold at vault creation: the bus is reachable through `DBUS_SESSION_BUS_ADDRESS` or `$XDG_RUNTIME_DIR/bus` without autolaunch; none of agy's bypass conditions apply (SSH vars, WSL, container); a persistent collection exists and is **already unlocked** without acctshift calling `Unlock` |
| `dpapi` | `<root>\vault.key.dpapi` = `CryptProtectData(key, CurrentUser, CRYPTPROTECT_UI_FORBIDDEN)` (never `LOCAL_MACHINE`). The DPAPI blob is useless without the user's Windows profile, so it may sit next to the vault | **Windows**, except when the vault is created over SSH (see Rules) |
| `key-file` | a 0600 file (an owner-only DACL on Windows), **in a different directory from the vault** so that copying the data directory never carries both: `${XDG_CONFIG_HOME:-~/.config}/acctshift/vault-<kid>.key` on Linux/WSL and macOS, `%USERPROFILE%\.acctshift\vault-<kid>.key` on Windows. `ACCTSHIFT_KEY_FILE` names an exact path instead (containers, CI secret mounts). The absolute path used at creation is recorded in the header | **everything else**: Linux headless, SSH, WSL, containers, CI |

- A `passphrase` source (Argon2id t=3, m=64 MiB, p=4, optionally cached in the Linux kernel keyring) MAY come in v1.x. It is never a default and is not part of v1.
- There is **no plaintext-vault mode**.

**Creating a vault.** Creation runs entirely under `vault.lock`:
1. Re-check that no vault exists. If `<root>/vault.v1.bin.corrupt-*` exists, refuse with exit 78 `vault-corrupt-present` unless `--force-new-vault` is given, so a damaged vault is never silently replaced.
2. Generate the key id and the source key.
3. Store the source key with **create-only** semantics:
   - macOS: `add-generic-password` **without `-U`**; exit 45 (duplicate) is fatal: exit 78 `key-item-exists`;
   - Secret Service: `SearchItems` must miss, then `CreateItem(replace=false)`; afterwards read the item back through a fresh connection and compare;
   - key-file: `open(O_CREAT|O_EXCL|O_WRONLY, 0600)`, fsync, and fsync the directory;
   - DPAPI: the same exclusive create for `vault.key.dpapi`.
4. Only then write the vault file.

Two concurrent first `add`s therefore produce one vault; the second waits on `vault.lock` and then finds it.

**Rules:**
- The source is chosen once, at vault creation: the OS default above, or `--key-source` / `ACCTSHIFT_KEY_SOURCE`. It is recorded in the header.
- On macOS and Windows, if `SSH_CONNECTION`, `SSH_TTY` or `SSH_CLIENT` is set at vault creation, acctshift asks for `--key-source` interactively. Non-interactively it uses `key-file` and prints one `acctshift:` notice.
- acctshift **never switches sources silently** and **never generates a new key** when the recorded one is missing, locked or unreachable. It never overwrites a vault it cannot decrypt. It fails instead: exit 74 `keystore-unavailable` for control verbs, exit 125 `keystore-unavailable` for `exec`.
  - The hint names the unlock command or `acctshift vault migrate --to key-file`.
  - When no vault exists yet, the hint is `--key-source key-file` / `ACCTSHIFT_KEY_SOURCE=key-file` instead.
- After the vault exists, the key file is read from the path recorded in the header. A later run that sets a different `ACCTSHIFT_KEY_FILE`, or none, still uses the recorded path, and a missing file fails with a message that names it.
- `vault migrate --to <source>`:
  - holds `vault.lock` from reading through rewrap, header swap and old-key deletion;
  - fsyncs the new vault file before deleting anything;
  - deletes **only** the item or file whose name carries this vault's key id, never a bare `vault-key-v1` item or another vault's item.
  - It is in v1.
- `vault export --to FILE` / `vault import FILE` (v1, SHOULD) write and read a passphrase-encrypted bundle (Argon2id + XChaCha20-Poly1305), for moving machines and as a backup against losing the key. A wrong passphrase or a damaged bundle makes `vault import` exit 65 `invalid-bundle` and change nothing.
- `vault status` reads only the vault header: whether a vault exists, its key source, key id and recorded key-file path. It never opens the keystore and is read-only (§6.3). `vault status --json` is a contract command (§11.2); `vault migrate`, `vault export` and `vault import` are not.
- **Key-file checks**, at every key read and not only in `doctor`:
  - the key file and its directory MUST be owned by the current uid (or, for an `ACCTSHIFT_KEY_FILE` mount, by root) and MUST NOT be writable by group or others;
  - a key file at the default path MUST also not be readable by group or others;
  - otherwise exit 74 `keystore-unavailable` with the fix (`exec`: 125 `keystore-unavailable`; the status file's `error.reason` is `key-file-permissions`, Appendix D.4). Secret mounts must use mode 0400 and an owner that matches the runtime uid; Docker `/run/secrets` and Kubernetes `..data` symlinks are followed only for `ACCTSHIFT_KEY_FILE`.
  - These checks never `chmod` the key file: a key outside the root is the user's to fix.
- `doctor` describes `key-file` as "at-rest protection equal to the vendor CLIs' own plaintext credential files".
- **Linux implementation:** acctshift's own godbus client with an explicit `Connect(address)`. Never `SessionBus()`, never spawn `dbus-launch`, check `Locked` before any read, never `Unlock` or `Prompt`, and bound every call. Never shell out to `secret-tool`. `zalando/go-keyring` is not used at runtime, neither for acctshift's own key nor for agy's slot: its prompt wait has no timeout [R07 C5], and on macOS it passes no explicit keychain and no `-T` and cannot kill a timed-out `security` child (§7.4). It may appear only in tests, as a byte-compatibility fixture (§19.2).

### 7.4 macOS `security` rules (own key and agy slot)

- Always invoke the absolute path `/usr/bin/security`.
- **Explicit keychain.** Every `security` invocation, including each `-i` line, ends with an explicit keychain path supplied by one function.
  - In production this is the user's default keychain, resolved once per process with `security default-keychain -d user` (the keychain agy also writes to).
  - In tests it is the path from `ACCTSHIFT_TEST_KEYCHAIN`, which exists only in `acctshift_test` builds (§18.3).
- **Writes:**
  - send the command as one line to `security -i` on stdin, so the secret never appears in argv;
  - acctshift's own key: `add-generic-password -s acctshift -a vault-key-v1-<kid> -T /usr/bin/security -w <base64(key)> <keychain>`, **without `-U`** (create-only, §7.3);
  - agy's slot: `add-generic-password -U -s gemini -a antigravity -T /usr/bin/security -w go-keyring-base64:<base64(blob)> <keychain>`, exactly the value agy's library writes [R07 §1]. `-U` is used here because the slot is a vendor item that a swap must replace;
  - before writing, compute the line length. If it would exceed 4096 bytes: for acctshift's own key, fail with exit 74 `keychain-line-too-long`; for agy's slot, apply the §8.3.2 rule for a slot that cannot take the blob. Never fall back to argv.
- `-T /usr/bin/security` is passed explicitly. Writing with `-U` and no `-T` means "trust only the writing process" [R09 C4]; the writer is `/usr/bin/security` anyway, so this is harmless and explicit. acctshift adds **neither its own binary path nor any vendor binary path**: those paths change on every update, which would bring back prompts [D6, D7].
- **Never** use `-A`, `-T ""`, or `set-generic-password-partition-list`. Items written by `/usr/bin/security` keep trusting `/usr/bin/security`, which is how agy and Claude Code read them. This avoids the prompt loops and partition-list lockouts seen in prior art [R07 C3, R09 §1.4]. **VERIFY V-A5** for agy and V-K1 for the own key.
- **Reads:** `find-generic-password -s <svc> -wa <acct> <keychain>`. Strip the `go-keyring-base64:` (or hex `go-keyring-encoded:`) prefix for agy items.
- **Exit-status mapping:**

  | `security` exit | Meaning | acctshift result |
  |---|---|---|
  | 44 | not found | not found |
  | 36 | interaction not allowed / locked | keystore-unavailable (agy: `agy-keyring-locked`, §8.3.2), with the hint `security unlock-keychain ~/Library/Keychains/login.keychain-db` |
  | 37 / 50 | no default keychain, no such keychain | keystore-unavailable (agy: an in-scope keychain that exits 37 or 50 is `agy-keyring-locked`, fail closed; it is never evidence of file mode, §8.3.2) |
  | 51 | auth failed | keystore-unavailable |
  | 45 | duplicate item | own key: fatal `key-item-exists`; agy slot: cannot happen with `-U` |

  [R07 §3]
- Every call has a 10 s timeout (3 s for a probe; `settings.keystoreOpSeconds` and `settings.keystoreProbeSeconds`, §6.2). A call on agy's slot is cut off after 4 s instead (§7.5). On timeout acctshift kills the `security` child and reports keystore-unavailable (agy slot: `agy-keyring-locked`), **never** "not found". acctshift never asks for or stores the login password in non-interactive mode.
- **Prompt-free lock probe (V-K3).** Once V-K3 confirms a probe that never raises UI (candidate: the exit status of `security show-keychain-info <keychain>`), non-interactive runs call it before any read and treat "locked" as keystore-unavailable without calling `find-generic-password`.

### 7.5 Non-interactive guarantees

**When non-interactive.** acctshift is non-interactive when stdin is not a TTY, when `--non-interactive` is given, or when `ACCTSHIFT_NONINTERACTIVE=1`.
- LimitShift MUST export `ACCTSHIFT_NONINTERACTIVE=1` for every acctshift invocation (§15.3). A TTY check alone is not enough: a process started in a hidden Windows console (LimitShift's agy launch path, §12.4) has a console handle as stdin, which Go's terminal check reports as a TTY, and a control verb started from a queue inherits the user's terminal.
- `exec` never prompts, whatever stdin is. `run` never prompts during pre-launch credential handling; it MAY ask its §16 post-exit question ("switch and resume?") only when stdin is a TTY and `ACCTSHIFT_NONINTERACTIVE` is not `1`. Any other condition that would need input takes the non-interactive branch; for example an unregistered agy login in the slot gives 125 `agy-slot-unregistered` (§8.3.3). Other prompts exist only in control verbs that people run by hand, such as `add`, `login`, `remove`, `notice` and `vault export`.

**What it then never does:**
- call an API whose purpose is to prompt: Secret Service `Unlock` or `Prompt`, `security unlock-keychain`, or a credential UI;
- read from a terminal.

**What it cannot fully prevent.** On macOS, when the login keychain is locked in a GUI session, `/usr/bin/security` can make SecurityAgent show an unlock dialog, and `security` has no flag that forbids UI. Providers that confirm access themselves (KeePassXC) behave the same way on Linux. acctshift bounds such a dialog with the 3 s probe timeout and kills `security`. V-K1 records whether the dialog stays on screen; the V-K3 probe removes the case once verified.

**Time bounds.** Every keystore call is bounded.
- For the vault key: probe 3 s, operation 10 s (`settings.keystoreProbeSeconds`, `settings.keystoreOpSeconds`), so at most 15 s per process, because the key is fetched at most once (§7.1).
- For agy's slot: any keychain, Secret Service or Credential Manager call that takes longer than **4 s** counts as uncertain, and acctshift fails closed (§8.3.2). The reason: go-keyring's own prompt wait is unbounded [R07 C5], but agy bounds its keyring operations at about 5 s; after a timeout it writes its keyring-unavailable marker and uses its token file for an hour [R05 §a]. A keyring that answers acctshift in 6 s could therefore make agy run from a file slot acctshift did not write for this account. The 4 s bound is fixed and kept with agy's timeout in agy `facts.go`; `keystoreOpSeconds` does not raise it.
- Failures end in exit 74 `keystore-unavailable` (control verbs) or 125 `keystore-unavailable` (`exec`); for agy's slot, `agy-keyring-locked` (74 or 125, §8.3.2).

**What LimitShift does about it:**
- runs `acctshift doctor --json` at queue start, while the user is still present, and warns when the key source is not safe for unattended use (§15.7);
- if `exec` reports 125 `keystore-unavailable` or `agy-keyring-locked`, it follows §15.2:
  - under the legacy rule (the runner has no `accounts` key under `accountRotation:"auto"`, and the CLI is not agy while acctshift has at least one agy account registered), it launches that run unwrapped (the CLI's own login, no rotation) and uses acctshift again for the next run; a runner never stays in legacy mode for the rest of the queue;
  - otherwise it marks the task needs-human with the `error.code` (with fallbacks: it sets the runner aside for this task);
  - either way it logs why and never aborts the queue.

### 7.6 Threat model statement (for SECURITY.md and the README)

**What the vault protects**, by key source:
- `keychain`, `secret-service`, `dpapi`: acctshift's stored secrets against disclosure of copies of its files (backups, sync tools, dotfile repositories, support bundles) and against other OS users.
- `key-file`: only against a copy of acctshift's data directory on its own. A backup or sync of the whole home directory contains both the key and the vault.

**What it does not protect against.** Software running as the same OS user. Such software can read the source key: any same-user process on Linux and Windows [R07 C4], or any process that runs `/usr/bin/security` on macOS. It can also read the environment of a running CLI. The vendor CLIs' own credential files have the same exposure.

**Aggregate exposure (the agents themselves).** The agents acctshift launches run as the same OS user, usually unattended and with permission-bypass flags, and they process untrusted content. They can therefore read every secret acctshift stores, for every account and every CLI, not only the account of the current run. One compromised or prompt-injected task can exfiltrate all registered accounts. Per account, acctshift is no weaker than the vendor's own storage; in aggregate it is weaker. This sentence also appears in the README and the first-run notice (Appendix F).

**Injected tokens reach the agent's subprocesses.** A token placed in the CLI's environment (`CLAUDE_CODE_OAUTH_TOKEN`, `COPILOT_GITHUB_TOKEN`, `GEMINI_API_KEY`, `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`) is inherited by the agent's shell tools, hooks, MCP servers, test suites and install scripts, unless the vendor removes it. A routine `env` in a task can write it into LimitShift's captured output.
- V-C5, V-X4, V-G2 and V-P2 (§22) record, per CLI, whether the vendor strips its auth variable from tool subprocesses and whether a switch exists. The result goes in `facts.go`.
- A switch that is an environment variable goes into that kind's set list (§12.5).
- **The one added argument.** `exec` never adds arguments to the caller's command, with exactly one exception: for secret-bearing kinds it MAY prepend the vendor's secret-isolation argument listed in `facts.go`, when the caller's argv does not already contain it. Today that is only copilot's `--secret-env-vars=COPILOT_GITHUB_TOKEN`, which keeps the token out of the agent's shell and MCP children [R06 §2.8]. `exec` reports it in the status file's `addedArgs`, which LimitShift logs after each run (§15.5); LimitShift's dry-run shows only the wrapped command, not the added argument. V-P2 verifies that the flag removes the token from those subprocesses in current Copilot releases, and whether it is still needed.
- A switch that needs any other argument or a config change is never applied by `exec`. Codex's `shell_environment_policy` would need `-c`, so for codex the README documents it as a setting in the user's own `config.toml` (V-X4).
- The README recommends fine-grained PATs over the `gh` kind for copilot, and LimitShift passes captured outputs through the same redaction patterns before writing them (§14.4, §15.5).

**Losing the key.** If the keychain is reset, the DPAPI master key is lost, or the Secret Service collection is deleted, the vault becomes unreadable. The fix is `vault import` of an export, or re-adding the accounts through the vendors' own flows.

---
