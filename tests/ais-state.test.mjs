import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import {
    emptyState, normalizeState, loadState, saveState, addProfile, removeProfile,
    renameProfile, setMapping, useProfile, currentProfile, rotationFrom, pickNext,
    markLimited, limitUntil, clearLimit, isValidAisName, defaultToolProfileName,
} from '../launcher/ais-state.mjs';

function two() {
    const s = emptyState();
    addProfile(s, 'main',   { claude: 'claude-main',   codex: 'codex-main',   agy: 'a@x.com' });
    addProfile(s, 'second', { claude: 'claude-second', codex: 'codex-second', agy: 'b@x.com' });
    return s;
}

function tmpFile(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-state-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'state.json');
}

test('first profile becomes active for every service it maps', () => {
    const s = two();
    assert.deepEqual(s.active, { claude: 'main', codex: 'main', agy: 'main' });
    assert.deepEqual(s.order, ['main', 'second']);
});

test('a service without an account stays inactive until one is linked', () => {
    const s = emptyState();
    addProfile(s, 'main', { claude: 'claude-main' });
    assert.equal(s.active.agy, null);
    setMapping(s, 'main', 'agy', 'a@x.com');
    assert.equal(s.active.agy, 'main');
});

test('names: reserved words, whitespace and path characters are rejected', () => {
    for (const bad of ['claude', 'codex', 'agy', 'ALL', 'antigravity', 'a b', 'x/y', '.hidden', '-x', '']) {
        assert.equal(isValidAisName(bad), false, bad);
    }
    for (const good of ['main', 'second', 'work-2', 'k12', 'my_acct']) assert.ok(isValidAisName(good), good);
    assert.throws(() => addProfile(emptyState(), 'codex'), /Invalid profile name/);
    assert.equal(defaultToolProfileName('codex', 'main'), 'codex-main');
});

test('duplicate names are refused', () => {
    assert.throws(() => addProfile(two(), 'main'), /already exists/);
});

test('useProfile switches every mapped service and reports from/to', () => {
    const s = two();
    const changes = useProfile(s, 'second');
    assert.deepEqual(changes.map(c => [c.service, c.from, c.to]), [
        ['claude', 'main', 'second'], ['codex', 'main', 'second'], ['agy', 'main', 'second'],
    ]);
    assert.deepEqual(s.active, { claude: 'second', codex: 'second', agy: 'second' });
});

test('useProfile limited to one service leaves the others alone', () => {
    const s = two();
    useProfile(s, 'second', ['codex']);
    assert.deepEqual(s.active, { claude: 'main', codex: 'second', agy: 'main' });
});

test('useProfile skips services the profile has no account for', () => {
    const s = two();
    addProfile(s, 'codexonly', { codex: 'codex-k12' });
    const changes = useProfile(s, 'codexonly');
    assert.deepEqual(changes.map(c => c.service), ['codex']);
    assert.equal(s.active.claude, 'main');
    assert.throws(() => useProfile(s, 'nope'), /Unknown profile/);
});

test('rotationFrom wraps around and puts the start last', () => {
    const s = two();
    addProfile(s, 'third', { claude: 'claude-third' });
    assert.deepEqual(rotationFrom(s, 'second'), ['third', 'main', 'second']);
    assert.deepEqual(rotationFrom(s, null), ['main', 'second', 'third']);
});

test('pickNext skips profiles without the service', () => {
    const s = two();
    addProfile(s, 'codexonly', { codex: 'codex-x' });
    useProfile(s, 'second');
    assert.equal(pickNext(s, 'claude').name, 'main');     // not codexonly
    assert.equal(pickNext(s, 'codex').name, 'codexonly');
});

test('pickNext returns null when no other profile has the service', () => {
    const s = emptyState();
    addProfile(s, 'solo', { claude: 'claude-solo' });
    assert.equal(pickNext(s, 'claude'), null);
});

test('pickNext avoids limited profiles, falls back to the soonest reset', () => {
    const now = Date.parse('2026-09-24T10:00:00Z');
    const s = two();
    addProfile(s, 'third', { claude: 'claude-third' });
    markLimited(s, 'claude', 'second', now + 3600e3);
    assert.equal(pickNext(s, 'claude', { now }).name, 'third');

    markLimited(s, 'claude', 'third', now + 7200e3);
    const r = pickNext(s, 'claude', { now });
    assert.equal(r.name, 'second');
    assert.equal(r.limitedUntil, now + 3600e3);

    // Expired limits no longer count.
    assert.equal(pickNext(s, 'claude', { now: now + 4 * 3600e3 }).name, 'second');
    assert.equal(pickNext(s, 'claude', { now: now + 4 * 3600e3 }).limitedUntil, null);
});

test('pickNext honours isUsable and can ignore limits', () => {
    const now = Date.now();
    const s = two();
    addProfile(s, 'third', { claude: 'claude-third' });
    markLimited(s, 'claude', 'second', now + 3600e3);
    assert.equal(pickNext(s, 'claude', { now, isUsable: n => n !== 'third' }).name, 'second');
    assert.equal(pickNext(s, 'claude', { now, avoidLimited: false }).name, 'second');
});

test('limitUntil/clearLimit', () => {
    const now = Date.now();
    const s = two();
    markLimited(s, 'codex', 'main', now + 1000);
    assert.equal(limitUntil(s, 'codex', 'main', now), now + 1000);
    assert.equal(limitUntil(s, 'codex', 'main', now + 2000), null);
    clearLimit(s, 'codex', 'main');
    assert.equal(limitUntil(s, 'codex', 'main', now), null);
});

test('currentProfile: majority of services wins, ties go to claude', () => {
    const s = two();
    useProfile(s, 'second', ['codex', 'agy']);
    assert.equal(currentProfile(s), 'second');
    useProfile(s, 'main', ['agy']);
    assert.equal(currentProfile(s), 'main');
    assert.equal(currentProfile(emptyState()), null);
});

test('removeProfile hands active services to the next profile that has them', () => {
    const s = two();
    markLimited(s, 'claude', 'main', Date.now() + 1000);
    removeProfile(s, 'main');
    assert.deepEqual(s.active, { claude: 'second', codex: 'second', agy: 'second' });
    assert.deepEqual(s.order, ['second']);
    assert.equal(s.limits.claude.main, undefined);
    removeProfile(s, 'second');
    assert.deepEqual(s.active, { claude: null, codex: null, agy: null });
});

test('renameProfile carries order, active and limits', () => {
    const s = two();
    const until = Date.now() + 5000;
    markLimited(s, 'codex', 'main', until);
    renameProfile(s, 'main', 'work');
    assert.deepEqual(s.order, ['work', 'second']);
    assert.equal(s.active.claude, 'work');
    assert.equal(limitUntil(s, 'codex', 'work'), until);
    assert.throws(() => renameProfile(s, 'work', 'second'), /already exists/);
});

test('unlinking the active account moves the service elsewhere', () => {
    const s = two();
    setMapping(s, 'main', 'agy', null);
    assert.equal(s.active.agy, 'second');
    assert.throws(() => setMapping(s, 'main', 'gemini', 'x'), /Unknown service/);
});

test('normalizeState repairs garbage without throwing', () => {
    const s = normalizeState({
        order: ['ghost', 'main', 'main'],
        profiles: { main: { claude: 'claude-main', codex: 5, agy: '' }, 'bad name': {}, claude: {} },
        active: { claude: 'ghost', codex: 'main', agy: 'main' },
        limits: { claude: { main: 'not a date', ghost: '2026-01-01T00:00:00Z' }, bogus: {} },
    });
    assert.deepEqual(s.order, ['main']);
    assert.deepEqual(s.profiles, { main: { claude: 'claude-main', codex: null, agy: null } });
    assert.deepEqual(s.active, { claude: null, codex: null, agy: null });
    assert.deepEqual(s.limits, {});
    assert.deepEqual(normalizeState(null), emptyState());
});

test('save/load round-trip', (t) => {
    const file = tmpFile(t);
    const s = two();
    markLimited(s, 'agy', 'second', Date.parse('2030-01-01T00:00:00Z'));
    saveState(s, file);
    assert.deepEqual(loadState(file), normalizeState(s));
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);   // no temp left behind
});

test('missing file loads as empty; corrupt file is moved aside, not lost', (t) => {
    const file = tmpFile(t);
    assert.deepEqual(loadState(file), emptyState());
    fs.writeFileSync(file, '{ not json');
    assert.deepEqual(loadState(file), emptyState());
    const left = fs.readdirSync(path.dirname(file));
    assert.equal(left.length, 1);
    assert.match(left[0], /^state\.json\.corrupt-\d+$/);
});
