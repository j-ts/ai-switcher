// agm integration: Antigravity (agy) account management is delegated to the
// bundled `agm` binary (github.com/shyim/agm), which keeps an encrypted
// account store of its own and writes the active account into the OS
// credential store agy reads - Windows Credential Manager, the macOS
// Keychain, or libsecret (`secret-tool`) on Linux.
//
// agm's store is kept inside the portable tree (profiles/.agm) instead of
// ~/.antigravity-agent, so it travels, backs up and updates with the rest of
// the profiles.

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { IS_WIN, PORTABLE_ROOT, PROFILES_ROOT, APP_ROOT, currentPlatformKey } from './paths.mjs';

const EXE = IS_WIN ? 'agm.exe' : 'agm';

/** Where agm keeps cloud_accounts.db, its .mk master key and aliases.json. */
export function agmDataDir() {
    return process.env.AIS_AGM_DATA_DIR || path.join(PROFILES_ROOT, '.agm');
}

/** A stand-alone agm install's store, offered for import on first setup. */
export function legacyAgmDataDir() {
    return path.join(os.homedir(), '.antigravity-agent');
}

/**
 * Candidate agm binaries, most specific first:
 *   $AIS_AGM_BIN                     explicit override
 *   bin/<platform>/agm[.exe]         shipped in the release archive
 *   app/agm/agm[.exe]                built or dropped in by hand
 */
export function agmCandidates() {
    const out = [];
    if (process.env.AIS_AGM_BIN) out.push(process.env.AIS_AGM_BIN);
    out.push(path.join(PORTABLE_ROOT, 'bin', currentPlatformKey(), EXE));
    out.push(path.join(APP_ROOT, 'agm', EXE));
    return out;
}

export function agmBinary() {
    for (const p of agmCandidates()) {
        try {
            const st = fs.statSync(p);
            if (!st.isFile()) continue;
            // Archives unpacked by tools that drop unix modes lose the exec bit.
            if (!IS_WIN && !(st.mode & 0o111)) fs.chmodSync(p, 0o755);
            return p;
        } catch {}
    }
    return null;
}

export function agmEnv(base = process.env) {
    const env = { ...base, AGM_DATA_DIR: agmDataDir() };
    // Either of these would silently point agm at a different store.
    delete env.AGM_DB_PATH;
    delete env.ANTIGRAVITY_AGENT_DIR;
    return env;
}

function requireBinary() {
    const bin = agmBinary();
    if (!bin) {
        throw new Error('agm binary not found for ' + currentPlatformKey()
            + ' (looked in: ' + agmCandidates().join(', ') + ').\n'
            + 'Release archives ship it under bin/<platform>/; for a source checkout run\n'
            + '  go build -o app/agm/' + EXE + ' github.com/shyim/agm@<commit in packaging/agm.lock>');
    }
    return bin;
}

/** Run agm and capture its output. Never throws on a non-zero exit. */
export function runAgm(args, { input } = {}) {
    const r = spawnSync(requireBinary(), args, {
        encoding: 'utf8', env: agmEnv(), windowsHide: true, input,
    });
    return {
        status: r.error ? 1 : (r.status ?? 1),
        stdout: r.stdout || '',
        stderr: r.error ? String(r.error.message) : (r.stderr || ''),
    };
}

/** Run agm attached to the terminal (interactive commands, passthrough). */
export function runAgmInteractive(args) {
    const r = spawnSync(requireBinary(), args, { stdio: 'inherit', env: agmEnv() });
    if (r.error) throw r.error;
    return r.status ?? 1;
}

export function agmFailure(r) {
    return (r.stderr || r.stdout).trim().replace(/^error:\s*/i, '') || `agm exited ${r.status}`;
}

// ---------------------------------------------------------------------------
// Output parsing (agm has no JSON mode; its table formats are stable)
// ---------------------------------------------------------------------------
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const QUOTA = /^(\d+%|-)$/;

/**
 * Parse `agm list`:
 *   EMAIL      STATUS     GEM-PRO  GEM-FLASH  CLAUDE
 *   ------------------------------------------------
 *   a@x.com    cli        80%      100%       40%
 *   b@y.com               -        -          -
 * STATUS may be empty. Returns rows in agm's own order (most recently used
 * first), which is also the order agm's substring matcher walks.
 */
export function parseAgmList(text) {
    const rows = [];
    for (const raw of String(text).split(/\r?\n/)) {
        const tokens = raw.trim().split(/\s+/);
        if (tokens.length < 4 || !EMAIL.test(tokens[0])) continue;
        const quotas = tokens.slice(-3);
        if (!quotas.every(q => QUOTA.test(q))) continue;
        const status = tokens.length > 4 ? tokens.slice(1, -3).join(' ') : '';
        const tags = status ? status.split(',') : [];
        const pct = q => (q === '-' ? null : Number(q.slice(0, -1)));
        rows.push({
            email: tokens[0],
            tags,
            activeCli: tags.includes('cli'),
            tokenExpired: tags.includes('token-exp'),
            quota: { geminiPro: pct(quotas[0]), geminiFlash: pct(quotas[1]), claude: pct(quotas[2]) },
        });
    }
    return rows;
}

/** "Logged in as x@y.com" / "Imported x@y.com (from agy keychain)". */
export function parseLoggedInEmail(text) {
    const m = /(?:Logged in as|Imported)\s+([^\s@]+@[^\s@()]+)/.exec(String(text));
    return m ? m[1] : null;
}

/** "Switching x@y.com → Antigravity CLI (agy)" - which account agm matched. */
export function parseSwitchedEmail(text) {
    const m = /Switching\s+([^\s@]+@[^\s@]+)\s/.exec(String(text));
    return m ? m[1] : null;
}

/**
 * agm resolves an account by case-insensitive SUBSTRING, first match in list
 * order - so "bob@x.com" can land on "jimbob@x.com". Returns the email agm
 * would actually pick for `pattern`, so callers can refuse ambiguous picks
 * before any credential is written.
 */
export function agmWouldResolve(accounts, pattern) {
    const needle = String(pattern).toLowerCase();
    const hit = accounts.find(a => a.email.toLowerCase().includes(needle));
    return hit ? hit.email : null;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------
export function ensureStore() {
    fs.mkdirSync(agmDataDir(), { recursive: true });
    const r = runAgm(['init']);
    if (r.status !== 0) throw new Error('agm init failed: ' + agmFailure(r));
}

export function listAccounts() {
    const r = runAgm(['list']);
    if (r.status !== 0) throw new Error('agm list failed: ' + agmFailure(r));
    return parseAgmList(r.stdout);
}

/**
 * Write `email`'s login into the OS credential store agy reads. Refuses when
 * agm's substring matching would pick a different account.
 */
export function switchAccount(email) {
    const accounts = listAccounts();
    if (!accounts.some(a => a.email.toLowerCase() === String(email).toLowerCase())) {
        throw new Error(`Antigravity account ${email} is not in the agm store (log in with: ais login <profile> agy).`);
    }
    const resolved = agmWouldResolve(accounts, email);
    if (!resolved || resolved.toLowerCase() !== String(email).toLowerCase()) {
        throw new Error(`agm would match ${resolved} for "${email}" (substring match); `
            + `remove or rename the conflicting account with: ais agm remove ${resolved}`);
    }
    const r = runAgm(['switch', email, '--target', 'agy']);
    if (r.status !== 0) throw new Error('agm switch failed: ' + agmFailure(r));
    const switched = parseSwitchedEmail(r.stdout);
    if (switched && switched.toLowerCase() !== String(email).toLowerCase()) {
        throw new Error(`agm switched ${switched} instead of ${email}.`);
    }
    return r.stdout;
}

/**
 * Browser OAuth via `agm login`. Output streams to the terminal as it comes
 * (it carries the URL to open when no browser starts); the logged-in email
 * is parsed from it. Resolves to the email, or rejects.
 */
export function loginAccount({ onOutput = s => process.stdout.write(s) } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(requireBinary(), ['login'], {
            env: agmEnv(), stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true,
        });
        let out = '';
        child.stdout.on('data', d => { out += d; onOutput(String(d)); });
        child.stderr.on('data', d => { out += d; onOutput(String(d)); });
        child.on('error', reject);
        child.on('close', code => {
            const email = parseLoggedInEmail(out);
            if (code === 0 && email) return resolve(email);
            const last = out.trim().split(/\r?\n/).pop() || `agm exited ${code}`;
            reject(new Error(last.replace(/^error:\s*/i, '')));
        });
    });
}

/** Import whatever account agy is currently signed in with. */
export function importCliAccount() {
    const r = runAgm(['import-cli']);
    if (r.status !== 0) throw new Error(agmFailure(r));
    const email = parseLoggedInEmail(r.stdout);
    if (!email) throw new Error('agm import-cli reported no account.');
    return email;
}

/**
 * Copy a stand-alone agm store (~/.antigravity-agent) into ours. Only when
 * ours holds no database yet - never merges or overwrites.
 */
export function adoptLegacyStore(src = legacyAgmDataDir(), dst = agmDataDir()) {
    const db = path.join(src, 'cloud_accounts.db');
    if (!fs.existsSync(db)) return false;
    if (fs.existsSync(path.join(dst, 'cloud_accounts.db'))) return false;
    fs.mkdirSync(dst, { recursive: true });
    for (const f of ['cloud_accounts.db', '.mk', 'aliases.json']) {
        const from = path.join(src, f);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dst, f));
    }
    return true;
}

/** Linux needs libsecret's CLI for agm to reach the keyring. */
export function credentialStoreHint() {
    if (process.platform !== 'linux') return null;
    const r = spawnSync('sh', ['-c', 'command -v secret-tool'], { encoding: 'utf8' });
    if (r.status === 0) return null;
    return 'secret-tool (libsecret) not found - agm needs it to write the Antigravity login.\n'
         + '  Debian/Ubuntu: sudo apt install libsecret-tools   Fedora: sudo dnf install libsecret';
}
