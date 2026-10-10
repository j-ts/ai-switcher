## 6. On-disk layout and data model

### 6.1 Root directory

| OS | Default root | Override |
|---|---|---|
| Linux, WSL | `${XDG_DATA_HOME:-~/.local/share}/accshift` | `ACCSHIFT_HOME` |
| macOS | `~/Library/Application Support/accshift` | `ACCSHIFT_HOME` |
| Windows | `%LOCALAPPDATA%\accshift` (never Roaming) | `ACCSHIFT_HOME` |

- Everything accshift owns lives under one root, so a single directory can be backed up, moved or wiped. The one exception is the `key-file` key source, which deliberately lives elsewhere (§7.3).
- `ACCSHIFT_HOME` MUST be an absolute path; a relative one is a usage error (64 `usage`; 125 `usage` for `exec` and `run`).
- A relative `XDG_DATA_HOME` or `XDG_CONFIG_HOME` is ignored, as the XDG specification requires, and the default is used instead.
- The home directory MUST come from `$HOME` / `%USERPROFILE%` (`os.UserHomeDir`), never from `os/user`, which needs cgo [R01 C14].
- `version --json` and `doctor --json` report `root` and `rootSource` (`ACCSHIFT_HOME`, `XDG_DATA_HOME` or `default`). The root depends on the caller's environment, so a different context (a snap-packaged editor's terminal, a systemd unit, cron, sudo) can see a different, empty root. `doctor` warns when `XDG_DATA_HOME` or `XDG_CONFIG_HOME` points under `~/snap/` or `~/.var/app/`.
- The root and its subdirectories are created only by writers (§6.3), the first time they need them. `self-update --record-install` creates the root for the installers (§17.6). Read-only commands never create anything; with no root they behave as if no account were registered.

```
<root>/
├── accounts.json           registry (non-secret, human-readable); changed only through accshift commands (§6.2)
├── state.json              runtime state (limits, auth, agy slot owner, notice acceptance); machine-managed
├── vault.v1.bin            encrypted secrets (§7)
├── vault.key.dpapi         Windows default key source (§7.3); the key-file source lives in a different directory (§7.3)
├── locks/
│   ├── state.lock          guards accounts.json + state.json
│   ├── vault.lock          guards vault.v1.bin (and vault creation)
│   ├── agy-slot.lock       held for the whole duration of an agy run (§13); stays empty
│   ├── agy-slot.holders/   one <pid>-<starttime>.json per current holder (diagnostics, §13.1)
│   └── agy-slot.intent.d/  one <pid> marker per waiting swapper (writer preference, §13.1)
├── journal/
│   └── agy-swap.json       crash-recovery record for an in-flight slot swap, `add agy` / `login agy`, or `remove --sign-out-slot` (§13.3)
├── homes/
│   ├── codex/<id>/         Codex overlay homes (§8.2); <id> is the account's immutable id (§6.2), never renamed
│   └── claude/<id>/        claude login-slot directories (§8.1, experimental)
├── logs/accshift.log      written only by writers, with --debug or ACCSHIFT_DEBUG=1 (read-only commands log to stderr only, §10.1); redacted (§14.4); rotated at 1 MB, 3 files
├── logs/events.jsonl       append-only limit/auth/switch events and post-run findings (§9.6, §12.1.1); redacted; rotated at 1 MB
└── install.json            install receipt, written by accshift itself when an installer calls it (§17.6)
```

Migration backups (`<file>.bak-v<N>`) and quarantined files (`<file>.corrupt-<epoch>`) sit next to the file they come from (§6.4).

Permissions:
- **Exit codes.** The codes below are those of control verbs. `exec` and `run` report the same conditions before launch as 125 with the same `error.code` (§12.1.1).
- **POSIX modes.** accshift MUST NOT change the process umask, because umask is inherited by the CLI it launches (§12.3). It creates every file with `os.OpenFile(p, O_CREATE|O_EXCL|O_WRONLY, 0o600)` (or the atomic-write temp file, §13.2) and every directory with `os.Mkdir(p, 0o700)`, then `Chmod`s to the exact mode, because the caller's umask can only remove bits.
- **Root at a looser mode.** This covers a root owned by the current user but group- or world-accessible (for example created by a shell with umask 022), and a `vault.*`, `state.json` or `accounts.json` that is group- or world-accessible.
  - A writer (§6.3) tightens it (directories 0700, files 0600) before reading anything else, and prints one `accshift:` notice. `exec` prints nothing; it logs the fix with `--debug` only (§12.1.1).
  - A read-only command changes nothing and exits 78 `insecure-permissions` with the hint `accshift doctor --fix`. `doctor` without `--fix` reports it as a finding instead.
  - If tightening fails, the writer refuses before reading any secret: exit 78 `unsupported-filesystem` with the fix (`exec`: 125 `unsupported-filesystem`). An owner's `chmod` fails in practice only on a read-only mount or a filesystem without POSIX modes.
- **Ownership.** Every file and directory accshift reads or writes under the root (and the key-file directory, §7.3) MUST have `st_uid == geteuid()`. When euid is 0 and `$HOME` is owned by another uid (macOS `sudo` keeps `HOME` by default), accshift refuses before creating anything: exit 78 `wrong-owner`, hint "run without sudo".
- **Filesystems.** At first use accshift `statfs`es the root. On a filesystem that cannot hold POSIX modes or reliable locks it exits 78 `unsupported-filesystem` with the hint to set `ACCSHIFT_HOME` to a local path:
  - Linux `f_type`: V9FS `0x01021997` (WSL drvfs), CIFS `0xFF534D42`, SMB2 `0xFE534D42`, MSDOS `0x4d44`, exFAT `0x2011BAB0`;
  - macOS `f_fstypename`: `smbfs`, `msdos`, `exfat`.
  - NFS (`0x6969`, `nfs`) is allowed with a `doctor` warning, but agy swaps are refused there unless `settings.agyAllowNetworkHome` is true: agy processes on other hosts that share `~/.gemini` are invisible to the foreign-process check (§8.3.3).
- **Windows:** the root directory MUST get a protected DACL that grants access only to the current user SID (plus SYSTEM), set with `SetNamedSecurityInfo` [R07 §7]. A writer applies or repairs the DACL whenever the root lacks it, including a root an installer created. A read-only command treats a missing or wider DACL like a looser mode: exit 78 `insecure-permissions`.

### 6.2 `accounts.json` (registry)

- Non-secret and safe to read. accshift validates it on every load against Appendix D.1.
- Unknown fields are kept on rewrite (forward compatibility).
- Full schema: Appendix D.1.

```json
{
  "version": 1,
  "clis": {
    "claude": {
      "accounts": [
        { "name": "main", "id": "e04b7d93", "kind": "native", "label": "me@example.com", "enabled": true, "createdAt": "2026-10-07T10:00:00Z" },
        { "name": "work", "id": "3f9a01c2", "kind": "token", "label": "me@work.example", "plan": "max", "enabled": true,
          "createdAt": "2026-10-01T10:05:00Z", "expiresAt": "2027-10-01T10:05:00Z", "secretId": "claude/3f9a01c2" }
      ]
    },
    "codex": {
      "mainHome": "/home/me/.codex",
      "accounts": [
        { "name": "main", "id": "52a8c1f0", "kind": "native", "label": "me@example.com", "enabled": true, "createdAt": "2026-10-06T08:00:00Z" },
        { "name": "work", "id": "c81f4a6d", "kind": "home", "home": "/home/me/.local/share/accshift/homes/codex/c81f4a6d",
          "label": "me@work.example", "plan": "plus",
          "identity": { "email": "me@work.example", "chatgptAccountId": "…", "chatgptUserId": "…" }, "enabled": true,
          "createdAt": "2026-10-06T08:10:00Z" }
      ]
    },
    "agy": {
      "settings": { "slotWaitSeconds": 60 },
      "accounts": [
        { "name": "a", "id": "7c41d09e", "kind": "slot", "label": "a@gmail.com", "identity": { "email": "a@gmail.com" },
          "secretId": "agy/7c41d09e", "agySlotUsed": { "store": "keyring", "path": null, "agyVersion": "1.3.1" }, "enabled": true,
          "createdAt": "2026-10-06T08:20:00Z" }
      ]
    }
  },
  "settings": {
    "minCooldownSeconds": 60,
    "unknownResetBackoffMinutes": { "start": 30, "max": 300 },
    "earlyRehitBackoffMinutes": { "start": 5, "max": 60 },
    "authSuspectMinutes": 15,
    "slotWaitSeconds": 30,
    "updateCheck": "off"
  }
}
```

Rules:
- **Account id.** Every account has an immutable `id`: 8 lowercase hex characters, drawn at random by `add` and unique in the registry across all clis. `add` draws again until the id is used nowhere: by no registry account, no `homes/<cli>/<id>` directory, no vault entry and no state.json key. The id, never the name, keys everything accshift stores for the account:
  - the overlay home `homes/<cli>/<id>` (for example `homes/codex/c81f4a6d`);
  - the vault entry, `secretId` = `<cli>/<id>` (for example `claude/3f9a01c2`, §7.2);
  - the state.json entry `<cli>/<id>` (§6.3).
- **Names.** `name` is what people and commands use; it is unique per cli (§3). `rename <cli> <old> <new>` changes only `name`, plus every `agyRestoreAfterRun` setting (global or `clis.agy.settings`) that names the old account, in one atomic write of accounts.json under `state.lock`. It never moves directories, secrets or state, so vendor keyring keys that derive from the canonical home path (§8.1, §8.2) stay valid and a running CLI keeps its home (§10.2). `remove` deletes the account's vault entries, overlay directory and state entry, then the registry entry, in one transaction (§10.2).
- The array order of `clis.<cli>.accounts` is the **preference order** (§9.3). `accshift order` rewrites it.
- `label` is what users see. `identity` holds facts decoded locally from vendor files (a Codex `id_token`, an agy token's `email`). Labels for `token` kinds are user-asserted, because those tokens cannot be decoded offline [R04 C11]. A `native` account's identity can change outside accshift (the user signs in to another account with the vendor's own login); `doctor` compares the vendor's current email or label with the recorded one and warns (§9.6); `doctor --fix` or `mark --clear` then clears that account's records.
- `secretId` points to the account's vault entry, for kinds whose secret accshift holds (§7.1). `home` points to an overlay home inside `<root>/homes`; adopting a home outside the root is allowed only for `native` codex accounts.
- `home` is stored as the canonical path (`filepath.EvalSymlinks`) recorded at `add` (§8.2).
- The registry MUST NOT contain secrets. `accshift doctor` warns if any string field matches the redaction pattern table (§14.4), naming the field and never quoting its value.

**Changing the registry.** LimitShift queues run for days, so there is no moment when "no accshift process runs", and many editors save in place rather than atomically. Users therefore change the registry only through accshift:
- **Accounts** through their commands: `add`, `login`, `rename`, `enable`, `disable`, `order`, `remove`.
- **Single keys** with `accshift config <key>` (prints the effective value) and `accshift config <key> <value>` (sets it). Keys are dotted paths from the registry root:
  - `clis.<cli>.mainHome`, `clis.<cli>.mainSqliteHome`, `clis.<cli>.bin`, `clis.<cli>.buckets.<model>`, `clis.<cli>.shareExtra`;
  - `settings.<key>` and `clis.<cli>.settings.<key>` (table below).
  
  A value is parsed as JSON when it parses (a number, boolean or list), otherwise it is taken as a string. The changed registry is validated and then written atomically under `state.lock` (§13.2). An invalid value, such as a relative `clis.<cli>.bin` or a `clis.codex.mainHome` inside `<root>/homes/` (§8.2), exits 65 `invalid-config` and changes nothing.
- **Anything else** with `accshift config edit`. It needs a terminal (non-interactively it exits 64 `usage`). It copies accounts.json to a 0600 temp file in `<root>`, opens `$VISUAL` or `$EDITOR`, validates the saved copy, and writes it atomically under `state.lock`.
  - It refuses a copy that changes an account's `id`, `secretId` or `home`, adds or removes an account, or fails validation. It then shows the error and offers to re-open the editor; declining leaves accounts.json unchanged (exit 65 `invalid-config`).
  - A changed `name` follows the `rename` rules (§10.2).
  - If accounts.json changed while the editor was open, nothing is written: it exits 73 `registry-changed` and keeps the edited copy, naming its path.
  - It is also the repair path for a registry that fails validation or was quarantined (§6.4).

**Settings** (`Settings` in Appendix D.1). For a command on cli C, a key's effective value is `clis.C.settings.<key>` if set, else `settings.<key>`, else the default. `updateCheck` is read only from the global `settings`.

| Key | Default | Meaning |
|---|---|---|
| `minCooldownSeconds` | 60 | shortest stored limit; a caller `--limited-until` earlier than now + this is an unknown reset (§9.4) |
| `unknownResetBackoffMinutes` | `{start: 30, max: 300}` | unknown-reset backoff, doubling per consecutive hit of one scope (§9.4) |
| `earlyRehitBackoffMinutes` | `{start: 5, max: 60}` | backoff for a limit hit soon after the previous record of that scope expired (§9.4) |
| `authSuspectMinutes` | 15 | length of an auth-suspect record, and the provider-incident window (§9.2) |
| `slotWaitSeconds` | 30 | default `--slot-wait` for the agy slot lock (§13.1) |
| `updateCheck` | `"off"` | `"off"` or `"daily"` (§17.7); global only |
| `agyRestoreAfterRun` | unset | name of the agy account that every swapping run puts back afterwards (§8.3.3) |
| `agyAllowNetworkHome` | `false` | allow agy swaps when the root is on NFS (§6.1) |
| `keystoreProbeSeconds` | 3 | timeout of a keystore lock probe (§7.4, §7.5) |
| `keystoreOpSeconds` | 10 | timeout of one keystore operation (§7.4, §7.5) |

### 6.3 `state.json` (runtime state)

The example is a snapshot taken at 2026-10-07T10:45:00Z (epoch 1791369900). All times in state.json are UTC epoch seconds.

```json
{
  "version": 1,
  "notice": { "acceptedAt": 1790849100, "version": 1 },
  "accounts": {
    "claude/3f9a01c2": {
      "status": "limited",
      "reason": "limit",
      "records": [
        { "kind": "limit", "scope": "account", "until": 1791374400, "tier": 3, "limitSource": "structured", "resetConfidence": "exact",
          "limitType": "five_hour", "observedAt": 1791369600, "snippet": "You've hit your session limit · resets 3pm (Europe/Kyiv)" },
        { "kind": "limit", "scope": "model:opus", "until": 1791784800, "tier": 2, "limitSource": "text", "resetConfidence": "parsed",
          "limitType": "seven_day_opus", "observedAt": 1791368400, "snippet": "You've hit your Opus limit · resets Oct 12, 9am (Europe/Kyiv)" }
      ],
      "relogin": null,
      "authStrikes": 0, "lastStrikeAt": null, "attentionCode": null,
      "backoff": {
        "account":    { "hits": 0, "lastUntil": 1791374400, "lastHitAt": 1791369600, "rehitMinutes": 0 },
        "model:opus": { "hits": 0, "lastUntil": 1791784800, "lastHitAt": 1791368400, "rehitMinutes": 0 }
      },
      "lastUsedAt": 1791369600, "lastOkAt": 1791367800,
      "utilization": { "five_hour": 1.0, "seven_day": 0.41, "observedAt": 1791369600 }
    },
    "codex/c81f4a6d": {
      "status": "limited",
      "reason": "limit",
      "records": [
        { "kind": "limit", "scope": "account", "until": 1791370800, "tier": 1, "limitSource": "default", "resetConfidence": "guess",
          "observedAt": 1791367200 }
      ],
      "relogin": null,
      "authStrikes": 0, "lastStrikeAt": null, "attentionCode": null,
      "backoff": { "account": { "hits": 2, "lastUntil": 1791370800, "lastHitAt": 1791367200, "rehitMinutes": 0 } },
      "lastUsedAt": 1791367200
    },
    "codex/52a8c1f0": {
      "status": "needs-relogin",
      "reason": "refresh-dead",
      "records": [],
      "relogin": { "reason": "refresh-dead", "since": 1791364500,
                   "snippet": "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again." },
      "authStrikes": 0, "lastStrikeAt": null, "attentionCode": null
    }
  },
  "agySlot": { "owner": "7c41d09e", "store": "keyring", "writtenAt": 1791361200, "saveBackPending": false },
  "agyBinary": { "path": "/home/me/.local/bin/agy", "size": 211026152, "mtime": 1790838720, "version": "1.3.1" }
}
```

In the example, `claude/3f9a01c2` last reported success (`mark --ok`, which deletes the `backoff` map) at 10:10Z, and another queue's Opus run hit its weekly Opus limit at 10:20Z. At 10:40Z it hit its session limit (13:40 in Kyiv), which resets at 3pm Kyiv, 12:00Z. The Opus record resets on Oct 12 at 9am Kyiv (06:00Z) and blocks only requests for the `opus` bucket. The notice was accepted at the first `add`, which registered `work` (2026-10-01T10:05:00Z). `codex/c81f4a6d` hit a limit with no reset time twice: at 09:00Z (30 minutes) and again at 10:00Z, 30 minutes after that record expired, so the backoff doubled to 60 minutes (§9.4).

**Top level** (Appendix D.2):
- `version`: the file format version (§6.4).
- `notice`: `{acceptedAt, version}`, the user's acceptance of the provider notice (Appendix F, §20.4).
  - Every `add` (all clis and kinds, including `--native` and `--capture-current`) shows the notice when `notice` is unset or its `version` is older than the binary's, requires `y` or `--accept-notice`, and then writes it.
  - `accshift notice --accept` (or `y` at its prompt) also writes it, without adding an account (§10.2). This is how a user whose accounts are all registered accepts a new notice version, which is bumped only when the Appendix F text changes materially.
  - Until it holds the current version, `pick` and `next` exit 69 `notice-not-accepted` with the hint `accshift notice --accept`, and `exec` without `--account` exits 125 `notice-not-accepted`. `exec --account` still runs (§9.3). `doctor` reports it.
  - It lives here, not in the registry, so editing accounts.json cannot accept it.
- `accounts`: one AccountState per account, keyed `<cli>/<id>` with the immutable id of §6.2, never the name. `rename` therefore never touches state.json, and a lock-free reader that reads accounts.json and state.json as two snapshots can never see a renamed account without its state.
  - An account with no entry has the empty state: no records, `relogin` null, no strikes, no backoff.
  - `remove` deletes the account's entry in its own transaction (§10.2).
  - An entry whose key matches no registry account is ignored. `doctor` reports it and `doctor --fix` deletes it.
- `agySlot`: `{owner, store, writtenAt, saveBackPending?}`. `owner` is the `id` of the registered agy account accshift last put into agy's slot or last observed there, or `null`; `store` is where it was written.
  - It is a hint for `pick` and `list` only: `pick agy` returns `agySlot.owner` whenever it is a usable candidate (§9.3), and `pick` never opens the keystore. It never decides a lock mode or a swap; `exec` always reads the slots themselves (§8.3.3).
  - After a run, if every slot is empty, `agySlot` becomes `null`. On a mismatch, `owner` becomes the observed registered account or `null` (§8.3.3).
  - `saveBackPending: true` means a post-run save-back failed and left the slot untouched. The next exclusive slot holder performs that save-back before anything else (§8.3.3).
- `agyBinary`: `{path, size, mtime, version}`, the realpath, size and mtime of the resolved agy binary with its `agy --version` output. `exec` uses it to know the agy version without running agy. On a cache miss it runs `agy --version` once with a 2 s timeout and stores the result; an unknown version counts as V-A8 not passed (§8.3.1).
- `updateCheckedAt`: when the last update check ran (§17.7). With `settings.updateCheck: "daily"`, a check runs only if this is more than 24 h ago. Only writers write it, so read-only commands never run the check.

**AccountState** (Appendix D.2):
- `status` and `reason` are display caches. The engine always recomputes them from `records`, `relogin`, `attentionCode`, the registry (`enabled`, `expiresAt`) and `now` (§9.2), so an expired record never needs a write to clear it. They are never used for selection (§9.3).
- `records`: `Record = {kind, scope, until, tier, limitSource, resetConfidence, limitType?, observedAt, snippet?, clamped?}` (§9.1).
  - `kind` is `limit` or `auth-suspect`. An auth-suspect record has scope `account`, tier 1 and limitSource `auth` (§9.2). The merge rule applies only between records of the same kind; an active record of either kind blocks.
  - `scope` is `account` or `model:<bucket>`.
  - `tier` is an integer, describing where the reset value came from: 1 no vendor-supplied reset, 2 a reset parsed from text, 3 a reset from structured vendor data, 4 a user override (§9.4).
  - `until` is the vendor's reset, stored unchanged; the 30 s skew margin is added only when usability and `resetAtEpoch` are computed (§9.3).
  - `clamped: true` marks a record whose `until` the engine clamped because of clock skew (§9.4).
  - Expired records are pruned on the next write.
- `relogin`: `null` or `{reason, since, snippet?}`, the sticky needs-relogin state (§9.2).
  - `reason` is `rejected`, `refresh-dead`, `expired` or `missing`. It is set by definitive evidence, by an escalating strike, by `exec` when the account's credential is absent (`missing`), or by `exec` when agy emptied every slot during the run (`rejected`).
  - It is cleared only by `login` or `mark --clear`, never by a counter reset or by pruning.
  - `expired` is derived from accounts.json `expiresAt`. `mark --clear` cannot clear it (exit 65 `expired`, hint `accshift login <cli> <name>`).
- `authStrikes` and `lastStrikeAt`: ambiguous 401/403 strikes (§9.2). `mark --ok` and a same-identity `login` clear `authStrikes` and keep `lastStrikeAt` (the incident window, §9.2); `mark --clear` and `login --new-identity` clear both.
- `attentionCode`: the reason for a sticky needs-attention state (§9.2). Only `mark --clear` clears it.
- `backoff`: `{"<scope>": {hits, lastUntil, lastHitAt, rehitMinutes}}`, the memory the unknown-reset doubling and the early re-hit rule need after a record has expired (§9.4). `hits` counts consecutive unknown-reset hits of the scope; `lastUntil` is the `until` of the scope's last record; `rehitMinutes` is the current early re-hit backoff.
  - Pruning keeps an entry until 24 h after the later of its `lastHitAt` and `lastUntil`, even when its record has expired and been pruned, so a weekly or monthly record keeps its early re-hit memory (§9.4).
  - `mark --ok` and `mark --clear` delete the whole map.
- `lastUsedAt` and `lastOkAt`: `lastOkAt` is written only by `mark --ok`; `lastUsedAt` by `mark --ok` and by `next` for its `--from` account. `exec` writes neither (§9.2).
- `utilization` is display-only (§9.3).
- `wrongAccount` (agy only): `{expected, found, observedAt}`, set when the post-run check found a different email in the slot than the requested account's (§8.3.3). `expected` and `found` are emails; `found` may belong to no registered account. It is also reported in the status file. The next run of this account whose post-run check matches clears it.
- A same-identity `login` clears `relogin`, `authStrikes` and auth-suspect records, and keeps limit records, `backoff`, `attentionCode` and `lastStrikeAt` (§9.2). `login --new-identity` clears all records, `authStrikes`, `lastStrikeAt`, `backoff`, `attentionCode` and `relogin` (§8, §9.2). `mark --clear` removes all records, `authStrikes`, `lastStrikeAt`, `attentionCode`, `backoff` and `relogin` (except `expired`); `mark --clear --model M` removes only that bucket's records (§10.2).
- Unknown fields are kept on rewrite.

**Readers and writers** (§11.1 rule 8):
- **Read-only commands:** `version`, `list`, `status`, `pick`, `doctor` without `--fix`, `classify` without `--record`, `vault status`, and `notice` without `--accept` (unless the user answers `y` at its prompt). They take no lock and make no state, vendor or file-system write: no rename, migration, backup, recreation, `chmod` or re-ACL (§6.1, §6.4). Their `--debug` log goes to stderr only (§10.1). They read accounts.json and state.json lock-free as atomic snapshots (§13.2), and migrate an older version in memory only.
- **Writers:** `next`, `mark`, `enable`, `disable`, `order`, `config`, `classify --record`, `doctor --fix`, `notice --accept` (or `notice` answered `y`), `exec`, `add`, `login`, `remove`, `rename`, `agy use`, `vault migrate`, `vault export` and `vault import`; also `run` (it records limits like `next`, §16), `env` (overlay link refresh only, §12.7) and `self-update` (`install.json`, `updateCheckedAt`). A writer changes accounts.json and state.json only under `state.lock`, reads both files again after taking it, and writes atomically (§13.2).
  - accounts.json: `add`, `login`, `remove`, `rename`, `enable`, `disable`, `order`, `config`.
  - state.json: `next`, `mark`, `classify --record`, `run`, `add` (`notice`; `add agy --capture-current` also `agySlot`), `notice --accept` (`notice`), `login`, `remove`, `agy use` (`agySlot`), `doctor --fix`, `self-update` (`updateCheckedAt`), and `exec`.
  - `exec` writes only `relogin(missing)` when a credential is absent, the agy post-run bookkeeping (`agySlot`, `wrongAccount`, `relogin(rejected)` on an emptied slot, `saveBackPending`) and the `agyBinary` cache. It never changes strikes, backoff or `lastUsedAt` (§9.2).

### 6.4 Versioning and migration

- Both files carry `"version"`.
  - A writer migrates an older version forward atomically under `state.lock`, keeping a `<file>.bak-v<N>` copy.
  - A read-only command migrates in memory only and never rewrites, backs up or renames a file.
  - Commands refuse a newer version: exit 78 `config-newer-version` (`exec`: 125 `config-newer-version`), hint "upgrade accshift". They never write a newer file.
- **Damaged files** (`accounts.json`, `state.json`). A file that fails to parse is never overwritten silently, and only a writer holding `state.lock` may move it. A user's editor or another tool may be half-way through a non-atomic save, so one failed read proves nothing.
  - A read-only command, or any command that does not hold `state.lock`, exits 78 `config-corrupt` (`exec`: 125 `config-corrupt`) and changes nothing.
  - A writer holding `state.lock` reads the file again 200 ms later. Only if the second read fails the same way may it quarantine the file: rename it to `<name>.corrupt-<epoch>` (with the Windows retry rules of §13.2) and exit 78 `config-corrupt` (`exec`: 125).
  - A file that parses but fails validation (Appendix D.1, D.2), for example one with a relative `clis.<cli>.bin` (§12.2), is never renamed. Commands exit 78 `config-corrupt` naming the field (`exec`: 125 `config-corrupt`). `accshift config edit` opens accounts.json for repair (§6.2); an invalid state.json is quarantined and recreated by `doctor --fix` as below.
- **Missing files.**
  - `accounts.json` is created only by `add`, and never while an `accounts.json.corrupt-*` file, `vault.v1.bin` or any `homes/<cli>/<id>` directory exists. In that case commands exit 78 `config-corrupt` with the hint to restore the registry: `accshift config edit` opens the newest `accounts.json.corrupt-*` copy and, once it validates, writes it back as accounts.json.
  - A missing `state.json` reads as empty, and the first writer creates it, unless a `state.json.corrupt-*` file exists. Then commands exit 78 `config-corrupt`, and only `doctor --fix` may recreate it, because state.json holds sticky facts and a user decision (`relogin`, `notice`). `doctor --fix` shows Appendix F again and records `notice` on `y`; without `y` it recreates the file with `notice` unset.
- **Exceptions.** In every case above, `version` still works, and `doctor` without `--fix` reports the problem as a finding and exits 0 (§9.6). For a damaged or missing file, `config edit` and `doctor --fix` are the repair paths: they read the damaged file as text and do not exit 78 `config-corrupt` because of it (`doctor --fix` still exits 73, 74 or 78 when a repair fails, §10.2).
- While a `vault.v1.bin.corrupt-*` file exists, accshift refuses to create a new vault unless `--force-new-vault` is given (§7.3). The vault itself is never quarantined automatically: a failed tag leaves it untouched (§7.2).

---
