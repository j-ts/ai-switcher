# Fix-round decisions (binding; they win over a verifier's proposed fix where they differ)

The verifier issues are in `verify-issues.json` (same directory): a JSON array of
{id, status, files, where, problem, fix, source}. Several issues are duplicates reported by different
verifiers; fix each underlying problem once, in every file you own that it touches.

1. **Appendix D.4 follows §11.2.** Where D.4 and §11.2 disagree, make D.4 match §11.2 exactly (account `id`,
   `poolDropped`, status top-level `notice`, `agySlot` inside the agy per-cli object, status account fields
   relogin/attentionCode/authStrikes/lastStrikeAt/lastOkAt/utilization, accounts[] `{name, state, reason?,
   limitedUntil?, limitedUntilEpoch?, limits}`, `recorded.relogin`/`recorded.attentionCode`).
   `switched` is true only when `account` and `previous` are both non-null and differ.
2. **postRunError** is `{code, reason}` everywhere (fix §11.2's `{code, message}`).
3. **`run` has no `--status-file`.** Drop `run` from D.4's status-file line. The status file is `exec --status-file`.
4. **126/127 codes:** 126 = `not-executable`, `cmd-shim-unsupported`, `wsl-windows-binary`; 127 = `not-found`.
   List them in §10.3 and Appendix E. LimitShift hooks treat exec 126/127 with `launched:false` (status file) as
   needs-human, like the "every other code" row; a 126/127 with `launched:true` (or no status file) is the CLI's own result.
5. **agy model discovery** (CI#26): `--validate-only` never runs `exec`; it uses only cached capabilities
   (an uncached agy pool is a WARNING). Discovery (`exec agy --account X -- models`) runs at queue start, before
   the first agy run, for the account `pick` returned for that run, so it adds no extra swap. Drop the claims that
   discovery "never swaps" or "takes the shared fast path". `--probe-models` (explicit) may probe each pool
   account and says it swaps the agy slot.
6. **doctor exit codes:** `doctor` (read-only) exits 0 whenever it ran. `doctor --fix` is a writer: it exits 0 when
   every fix it attempted succeeded or nothing needed fixing, else 73 (lock timeout, foreign agy), 74 (keystore) or
   78, with findings still printed. LimitShift only ever calls `doctor --json` (never `--fix`).
7. **Every control-verb error.code used anywhere must be listed** in §10.3 and Appendix E under its exit code.
   Add at least: 74 `slot-write-failed`, 74 `keychain-prompt-required`, 65 `gh-token-unavailable`,
   65 `classic-pat-unsupported`, 65 `identity-mismatch`, 65 `agy-account-live`, 65 `account-in-use`,
   65 `duplicate-account`, 65 `no-login-detected`, 65 `securestorage-ignored`, 65 `notice-not-accepted` (add),
   65 `expired` (mark --clear), 69 `notice-not-accepted` (pick/next), 74 `agy-keyring-locked`,
   78 `insecure-permissions`, 78 `config-corrupt`, 78 `config-newer-version`, 78 `unsupported-filesystem`,
   78 `wrong-owner`, 73 `agy-journal-pending`/`state-busy`/`vault-busy`/`slot-busy`/`agy-busy`. Grep the parts
   for `error.code`, "exits 6x/7x" and backticked codes to find any others, and give each refusal that has an exit
   code but no error.code a name.
8. **Key-file check:** a key file with the wrong owner or mode is 74 `keystore-unavailable` for control verbs
   (status-file / error `reason:"key-file-permissions"`), and 125 `keystore-unavailable` for exec.
9. **Invalid `config clis.codex.mainHome` value** → 65 (the §10.2/§6.2/§10.3/Appendix E rule). Fix §8.2.
10. **Relative `clis.<cli>.bin`** in accounts.json is a registry validation failure: control verbs 78
    `config-corrupt`, exec 125 `config-corrupt`; `config` rejects setting it with 65. Fix §12.2/§12.1.1.
11. **agy routing vs experimental:** while acctshift has at least one agy account registered, every agy runner is
    routed through acctshift (with or without `accounts`, under auto or required), because an unwrapped agy would
    race slot swaps. This is the one exception to "an experimental cli is routed only with explicit `accounts`";
    validate-only prints a WARNING that agy rotation is experimental on this OS. Every statement of the
    experimental rule (§10/§11 version text, §9, §15, D-03) carries this exception.
12. **lastStrikeAt** is kept by `mark --ok` and by a same-identity `login` (§9.2 is right; fix §6.3). Only
    `mark --clear` and `login --new-identity` clear it.
13. **Backoff retention:** a backoff entry is kept until 24 h after the later of `lastHitAt` and `lastUntil`
    (so weekly and monthly records keep their re-hit memory). §9.4, §6.3 and the §18.1 test say the same.
14. **Fingerprints** live in the vault entry (D.3), not in accounts.json/state.json. Fix §7.1.
15. **Example timeline:** claude `work` (id 3f9a01c2) was created 2026-10-01T10:05:00Z (epoch 1790849100), so its
    expiresAt is 2027-10-01T10:05:00Z (epoch 1822385100). Update §6.2's example and §11.2's list example
    (expiresAt and expiresAtEpoch), and every other place that shows work's createdAt/expiresAt. Every example
    account in §6.2 has `createdAt`.
16. **run prompting:** §7.5 must follow the amendment: exec never prompts; `run` MAY ask its §16 post-exit
    question only on a TTY with ACCTSHIFT_NONINTERACTIVE unset; never during pre-launch credential handling.
17. **Notice re-acceptance:** add a control verb `acctshift notice [--accept] [--json]`. Without `--accept` it prints
    Appendix F and the acceptance state (read-only). `notice --accept` (or `y` at a TTY) writes
    `state.notice = {acceptedAt, version}` under state.lock (a writer). The notice version is bumped only when the
    Appendix F text changes materially. On 69 `notice-not-accepted`, LimitShift marks routed tasks needs-human
    with the hint `acctshift notice --accept` (implicit-auto runners may run unwrapped under the legacy rule).
    Add the command to §10.2, §10.4, rule 8 (both lists), D.4 and Appendix E (65 when declined non-interactively).
18. **next 73 (state-busy):** nothing was recorded. LimitShift retries the same `next` call (not a `pick`) after the
    60 s wait, up to accountBusyWaitMinutes; it never relaunches on A in between.
19. **69 is pick/next only.** `list` never exits 69: with no accounts or an unsupported cli it returns
    `accounts:[]`, `poolSize:0`, `rotationPossible:false`. LimitShift's "agy accounts exist" test reads
    `list agy --json` → `accounts` non-empty. Fix §4.2 and §10.3 accordingly.
20. **`--gh-host`** is valid for copilot `--kind token` and `--kind gh` (§10.4).
21. **Copilot `session_quota_exceeded` in LimitShift:** for copilot runners, a limit-regex match is confirmed with
    `classify copilot ... --json` before LimitShift treats it as a limit; class `error` with this code starts a new
    session (New + handoff) on the same account, with no `next` and no rotation.
22. **addedArgs visibility:** LimitShift logs `addedArgs` from the status file after each run. The dry-run shows the
    wrapped command only; drop any claim that the dry-run shows the added argument (§7.6).
23. **exec state writes:** exec writes only `relogin(missing)`, the agy post-run bookkeeping and the `agyBinary`
    cache (§6.3 is right). Fix §9 and §12.1 where they omit the cache.
24. **`--debug` on read-only commands** writes to stderr only; the `logs/acctshift.log` file is written only by
    writer commands. State it in §10.1 and §6.
25. **Milestones** (§21): M1 exit criteria test only what M1 delivers (move exec/status-file/classify gates to M2);
    V-W1 sits where its Windows features land (junctions and npm shims: M3; DPAPI: M1; split V-W1 if needed);
    every V-item is scheduled (V-A9 too); M0 V-items that need Windows say so (M0 runs on all three OSes);
    package channels follow §17.5 (Homebrew and Scoop v0.2, winget v0.3); claude `login-slot`, gemini `native` and
    copilot `native` each land in a milestone.
26. **codex secret kinds** (`access-token`, `api-key`): §8.2 gets a short Add/Login subsection for them (secret
    read from a no-echo TTY or `--token-stdin`; label; identity check per the login rules).
27. **agy login mismatch parking:** everywhere (B.5, §7.2, §13.3) the rule is: a credential for a registered email
    is saved to that account's `agy/<id>`; for an unregistered email to `agy/_unregistered/<email>`; with no
    identifiable owner to `agy/_unknown/<sha256-8>`.
