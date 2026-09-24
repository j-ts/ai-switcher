import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import {
    parseAgmList, parseLoggedInEmail, parseSwitchedEmail, agmWouldResolve,
    agmEnv, agmDataDir, agmCandidates, adoptLegacyStore,
} from '../launcher/agm.mjs';
import { PROFILES_ROOT, PORTABLE_ROOT, currentPlatformKey } from '../launcher/paths.mjs';

// Verbatim shape of `agm list` (printf "%-36s %-14s %10s %10s %10s").
const LIST = [
    'EMAIL                                STATUS            GEM-PRO  GEM-FLASH     CLAUDE',
    '------------------------------------------------------------------------------------',
    'me@gmail.com                         cli                   80%       100%        40%',
    'work@corp.example                                            -          -          -',
    'a-very-long-address-that-overflows@example.org active,token-exp        0%         5%         0%',
    '',
].join('\n');

test('parseAgmList: rows, tags and quotas, blank STATUS included', () => {
    const rows = parseAgmList(LIST);
    assert.deepEqual(rows.map(r => r.email), [
        'me@gmail.com', 'work@corp.example', 'a-very-long-address-that-overflows@example.org',
    ]);
    assert.equal(rows[0].activeCli, true);
    assert.deepEqual(rows[0].quota, { geminiPro: 80, geminiFlash: 100, claude: 40 });
    assert.deepEqual(rows[1].tags, []);
    assert.deepEqual(rows[1].quota, { geminiPro: null, geminiFlash: null, claude: null });
    assert.equal(rows[2].tokenExpired, true);
    assert.deepEqual(rows[2].tags, ['active', 'token-exp']);
});

test('parseAgmList: empty store and noise', () => {
    assert.deepEqual(parseAgmList('No accounts yet.\n  agm login        — browser OAuth\n'), []);
    assert.deepEqual(parseAgmList(''), []);
    assert.deepEqual(parseAgmList('error: something\r\n'), []);
});

test('login/import/switch output parsing', () => {
    assert.equal(parseLoggedInEmail('Starting Google OAuth login…\nLogged in as me@gmail.com\nQuota snapshot stored.'), 'me@gmail.com');
    assert.equal(parseLoggedInEmail('Imported me@gmail.com (from agy keychain)'), 'me@gmail.com');
    assert.equal(parseLoggedInEmail('error: oauth timed out'), null);
    assert.equal(parseSwitchedEmail('Switching me@gmail.com → Antigravity CLI (agy)\n  ✓ Antigravity CLI (agy)'), 'me@gmail.com');
    assert.equal(parseSwitchedEmail('nothing'), null);
});

test('agmWouldResolve mirrors agm substring matching (first hit in list order)', () => {
    const accounts = [{ email: 'jimbob@x.com' }, { email: 'bob@x.com' }];
    assert.equal(agmWouldResolve(accounts, 'bob@x.com'), 'jimbob@x.com');   // the trap
    assert.equal(agmWouldResolve(accounts, 'JIMBOB@x.com'), 'jimbob@x.com');
    assert.equal(agmWouldResolve([{ email: 'bob@x.com' }, { email: 'jimbob@x.com' }], 'bob@x.com'), 'bob@x.com');
    assert.equal(agmWouldResolve(accounts, 'nobody@x.com'), null);
});

test('agmEnv pins agm to the portable store and drops overrides', () => {
    const env = agmEnv({ PATH: 'p', AGM_DB_PATH: '/elsewhere.db', ANTIGRAVITY_AGENT_DIR: '/other' });
    assert.equal(env.AGM_DATA_DIR, agmDataDir());
    assert.equal(env.AGM_DB_PATH, undefined);
    assert.equal(env.ANTIGRAVITY_AGENT_DIR, undefined);
    assert.equal(env.PATH, 'p');
    if (!process.env.AIS_AGM_DATA_DIR) assert.equal(agmDataDir(), path.join(PROFILES_ROOT, '.agm'));
});

test('agmCandidates prefers the per-platform binary shipped in bin/', () => {
    const want = path.join(PORTABLE_ROOT, 'bin', currentPlatformKey(), process.platform === 'win32' ? 'agm.exe' : 'agm');
    assert.ok(agmCandidates().includes(want));
});

test('adoptLegacyStore copies a stand-alone store once, never over an existing one', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-adopt-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const src = path.join(root, 'legacy'), dst = path.join(root, 'ours');
    assert.equal(adoptLegacyStore(src, dst), false);                 // nothing to adopt

    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'cloud_accounts.db'), 'DB1');
    fs.writeFileSync(path.join(src, '.mk'), 'KEY');
    assert.equal(adoptLegacyStore(src, dst), true);
    assert.equal(fs.readFileSync(path.join(dst, 'cloud_accounts.db'), 'utf8'), 'DB1');
    assert.equal(fs.readFileSync(path.join(dst, '.mk'), 'utf8'), 'KEY');
    assert.ok(!fs.existsSync(path.join(dst, 'aliases.json')));

    fs.writeFileSync(path.join(src, 'cloud_accounts.db'), 'DB2');
    assert.equal(adoptLegacyStore(src, dst), false);
    assert.equal(fs.readFileSync(path.join(dst, 'cloud_accounts.db'), 'utf8'), 'DB1');
});
