import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import {
    LogTail, stripSessionArgs, isOneShot, codexSessionId, runWithRotation, ADAPTERS,
} from '../launcher/ais-run.mjs';
import {
    emptyState, addProfile, saveState, loadState, markLimited,
} from '../launcher/ais-state.mjs';
import { createProfile } from '../launcher/profiles.mjs';
import { PROFILES_ROOT, claudeConfigDir, codexConfigDir } from '../launcher/paths.mjs';

function tmpDir(t, prefix) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(d, { recursive: true, force: true }));
    return d;
}

// --- LogTail ----------------------------------------------------------------
test('LogTail only yields lines appended after it started, across new files', (t) => {
    const root = tmpDir(t, 'tail-');
    fs.mkdirSync(path.join(root, 'proj'));
    const old = path.join(root, 'proj', 'old.jsonl');
    fs.writeFileSync(old, '{"before":1}\n');
    const tail = new LogTail([root], { maxDepth: 2 });
    assert.deepEqual(tail.poll(), []);

    fs.appendFileSync(old, '{"after":1}\n{"half"');
    const fresh = path.join(root, 'proj', 'new.jsonl');
    fs.writeFileSync(fresh, '{"new":1}\n');
    fs.writeFileSync(path.join(root, 'proj', 'ignored.txt'), 'x\n');
    const got = tail.poll().map(l => l.line).sort();
    assert.deepEqual(got, ['{"after":1}', '{"new":1}']);

    fs.appendFileSync(old, ':2}\r\n');                  // completes the partial line
    assert.deepEqual(tail.poll().map(l => l.line), ['{"half":2}']);
    assert.deepEqual(tail.poll(), []);
});

test('LogTail respects maxDepth and survives missing roots', (t) => {
    const root = tmpDir(t, 'tail-depth-');
    const deep = path.join(root, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    const tail = new LogTail([root, path.join(root, 'nope')], { maxDepth: 2 });
    fs.writeFileSync(path.join(deep, 'x.jsonl'), '{"deep":1}\n');
    fs.writeFileSync(path.join(root, 'a', 'y.jsonl'), '{"shallow":1}\n');
    assert.deepEqual(tail.poll().map(l => l.line), ['{"shallow":1}']);
});

// --- argument handling ------------------------------------------------------
test('stripSessionArgs removes session selection but keeps everything else', () => {
    assert.deepEqual(stripSessionArgs('claude', ['--resume', 'abc', '--model', 'opus', '-c', '--new']), ['--model', 'opus']);
    assert.deepEqual(stripSessionArgs('claude', ['-r', 'abc', '--fork-session', 'x']), ['x']);
    assert.deepEqual(stripSessionArgs('codex', ['resume', 'abc', '--model', 'o3']), ['--model', 'o3']);
    assert.deepEqual(stripSessionArgs('codex', ['resume', '--last', '-c', 'k=v']), ['-c', 'k=v']);
    assert.deepEqual(stripSessionArgs('agy', ['--continue', '--conversation', 'id1', '--model', 'm']), ['--model', 'm']);
});

test('isOneShot recognises print/exec modes', () => {
    assert.equal(isOneShot('claude', ['-p', 'hi']), true);
    assert.equal(isOneShot('claude', ['--model', 'opus']), false);
    assert.equal(isOneShot('codex', ['exec', 'do it']), true);
    assert.equal(isOneShot('codex', ['--model', 'exec']), false);
    assert.equal(isOneShot('agy', ['--print', 'x']), true);
});

test('codexSessionId from the rollout name, else from session_meta', (t) => {
    const d = tmpDir(t, 'cx-');
    const named = path.join(d, 'rollout-2026-09-18T14-36-38-0199aa00-1111-2222-3333-444455556666.jsonl');
    fs.writeFileSync(named, '{}\n');
    assert.equal(codexSessionId(named), '0199aa00-1111-2222-3333-444455556666');
    const other = path.join(d, 'odd.jsonl');
    fs.writeFileSync(other, JSON.stringify({ type: 'session_meta', payload: { id: 'meta-id' } }) + '\n');
    assert.equal(codexSessionId(other), 'meta-id');
    assert.equal(codexSessionId(path.join(d, 'missing.jsonl')), null);
});

test('codex transfer keeps the dated sessions/ layout', (t) => {
    const a = 'cxa-' + process.hrtime.bigint(), b = 'cxb-' + process.hrtime.bigint();
    t.after(() => { for (const p of [a, b]) fs.rmSync(path.join(PROFILES_ROOT, p), { recursive: true, force: true }); });
    const file = path.join(codexConfigDir(a), 'sessions', '2026', '09', '18', 'rollout-x.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"x":1}\n');
    ADAPTERS.codex.transfer(a, b, { file });
    assert.equal(fs.readFileSync(path.join(codexConfigDir(b), 'sessions', '2026', '09', '18', 'rollout-x.jsonl'), 'utf8'), '{"x":1}\n');
});

// --- the rotation loop, end to end with a fake CLI --------------------------
const SID = '7d1c0a5e-aaaa-bbbb-cccc-ddddeeeeffff';

// Stands in for launcher.mjs: logs a normal turn, then a rate-limit error,
// then hangs like a TUI would. Relaunched with --resume it just records that.
const FAKE_CLI = `
import fs from 'node:fs';
import path from 'node:path';
const [, , , account, ...extra] = process.argv;
fs.appendFileSync(process.env.FAKE_OUT, JSON.stringify({ account, extra }) + '\\n');
if (extra.includes('--resume') || process.env.FAKE_NEVER_LIMIT) process.exit(0);
const dir = path.join(process.env.FAKE_PROFILES_ROOT, account, 'claude-config', 'projects', 'proj');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, '${SID}.jsonl');
fs.appendFileSync(file, JSON.stringify({ type: 'user', sessionId: '${SID}', message: { content: 'hi' } }) + '\\n');
setTimeout(() => fs.appendFileSync(file, JSON.stringify({
    type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', sessionId: '${SID}',
    message: { content: [{ type: 'text', text: "You've hit your session limit · resets 11pm (UTC)" }] },
}) + '\\n'), 150);
setTimeout(() => {}, 60000);
`;

function setupRotation(t, names) {
    const dir = tmpDir(t, 'rot-');
    const prevState = process.env.AIS_STATE_DIR;
    process.env.AIS_STATE_DIR = path.join(dir, 'state');
    t.after(() => { if (prevState === undefined) delete process.env.AIS_STATE_DIR; else process.env.AIS_STATE_DIR = prevState; });

    const fake = path.join(dir, 'fake-cli.mjs');
    fs.writeFileSync(fake, FAKE_CLI);
    const out = path.join(dir, 'out.jsonl');
    process.env.FAKE_OUT = out;
    process.env.FAKE_PROFILES_ROOT = PROFILES_ROOT;

    const state = emptyState();
    const accounts = {};
    for (const n of names) {
        const acct = `rot-${n}-${process.hrtime.bigint()}`;
        createProfile(acct, { tool: 'claude' });
        fs.writeFileSync(path.join(claudeConfigDir(acct), '.claude.json'),
            JSON.stringify({ oauthAccount: { emailAddress: `${n}@example.com` } }));
        t.after(() => fs.rmSync(path.join(PROFILES_ROOT, acct), { recursive: true, force: true }));
        addProfile(state, n, { claude: acct });
        accounts[n] = acct;
    }
    saveState(state);
    const runs = () => fs.readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const argsFor = (service, account, extra) => [fake, '--profile', account, ...extra];
    return { accounts, runs, argsFor };
}

test('usage limit mid-session: stop, mark, switch profile, resume the same session', async (t) => {
    const { accounts, runs, argsFor } = setupRotation(t, ['main', 'second']);
    const code = await runWithRotation('claude', [], { argsFor, pollMs: 50 });
    assert.equal(code, 0);

    assert.deepEqual(runs(), [
        { account: accounts.main,   extra: [] },
        { account: accounts.second, extra: ['--resume', SID] },
    ]);
    const s = loadState();
    assert.equal(s.active.claude, 'second');
    assert.ok(Date.parse(s.limits.claude.main) > Date.now(), 'limit window recorded for main');
    assert.match(s.limits.claude.main, /T23:00:00\.000Z$/);            // "resets 11pm (UTC)"

    const copied = path.join(claudeConfigDir(accounts.second), 'projects', 'proj', `${SID}.jsonl`);
    assert.equal(fs.readFileSync(copied, 'utf8').trim().split('\n').length, 2);
});

test('no other account: give up with EX_TEMPFAIL instead of looping', async (t) => {
    const { runs, argsFor } = setupRotation(t, ['solo']);
    const code = await runWithRotation('claude', [], { argsFor, pollMs: 50 });
    assert.equal(code, 75);
    assert.equal(runs().length, 1);
    assert.ok(loadState().limits.claude.solo);
});

test('a profile already known to be limited is skipped before launch', async (t) => {
    const { accounts, runs, argsFor } = setupRotation(t, ['main', 'second']);
    const s = loadState();
    markLimited(s, 'claude', 'main', Date.now() + 3600e3);
    saveState(s);
    process.env.FAKE_NEVER_LIMIT = '1';
    t.after(() => delete process.env.FAKE_NEVER_LIMIT);

    const code = await runWithRotation('claude', ['--model', 'opus'], { argsFor, pollMs: 50 });
    assert.equal(code, 0);
    assert.deepEqual(runs(), [{ account: accounts.second, extra: ['--model', 'opus'] }]);
    assert.equal(loadState().active.claude, 'second');
});
