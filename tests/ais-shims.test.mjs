import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import {
    shimContent, shimFileName, installShims, removeShims, SHIM_SERVICES, SHIM_MARKER,
} from '../launcher/ais-shims.mjs';

function tmp(t) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-shims-'));
    t.after(() => fs.rmSync(d, { recursive: true, force: true }));
    return d;
}

test('unix shim execs ais with the service and all arguments', () => {
    const s = shimContent('codex', '/home/u/.ais', false);
    assert.ok(s.startsWith('#!/bin/sh\n'));
    assert.ok(s.includes(SHIM_MARKER));
    assert.ok(s.trimEnd().endsWith('exec "/home/u/.ais/bin/ais" codex "$@"'));
    assert.equal(shimFileName('codex', false), 'codex');
});

test('windows shim calls ais.cmd with %* and CRLF endings', () => {
    const s = shimContent('agy', 'C:\\Users\\u\\AppData\\Local\\ais', true);
    assert.ok(s.includes('"C:\\Users\\u\\AppData\\Local\\ais\\bin\\ais.cmd" agy %*'));
    assert.equal(s.split('\n').length, s.split('\r\n').length);
    assert.equal(shimFileName('agy', true), 'agy.cmd');
});

test('install writes all shims, refuses foreign files, remove only deletes ours', (t) => {
    const dir = tmp(t);
    const foreign = path.join(dir, shimFileName('codex'));
    fs.writeFileSync(foreign, '#!/bin/sh\necho the real codex\n');

    const r = installShims(dir);
    assert.deepEqual(r.map(x => [x.service, x.status]), [
        ['claude', 'installed'], ['codex', 'skipped'], ['agy', 'installed'],
    ]);
    assert.match(fs.readFileSync(foreign, 'utf8'), /the real codex/);
    assert.deepEqual(installShims(dir).map(x => x.status), ['updated', 'skipped', 'updated']);

    const removed = removeShims(dir).map(f => path.basename(f));
    assert.deepEqual(removed, [shimFileName('claude'), shimFileName('agy')]);
    assert.ok(fs.existsSync(foreign));
    assert.equal(SHIM_SERVICES.length, 3);
});
