// Every bootstrap script carries its own copy of the Node pin (it has to run
// before any Node exists). They must all agree with launcher/paths.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import path from 'node:path';
import { PORTABLE_ROOT, NODE_VERSION, NODE_DIST } from '../launcher/paths.mjs';

const read = rel => fs.readFileSync(path.join(PORTABLE_ROOT, rel), 'utf8');
const SHA = key => NODE_DIST[key].sha256;

const WIN_SCRIPTS  = ['Claude.bat', 'Codex.bat', 'Copilot.bat', 'Antigravity.bat', 'Happy.bat', 'bin/ais.cmd'];
const UNIX_SCRIPTS = ['claude.sh', 'codex.sh', 'copilot.sh', 'antigravity.sh', 'bin/ais'];

for (const rel of WIN_SCRIPTS) {
    test(`${rel} pins the same win-x64 Node as paths.mjs`, () => {
        const s = read(rel);
        assert.match(s, new RegExp(`NODE_VERSION=${NODE_VERSION.replace(/\./g, '\\.')}\\b`));
        assert.ok(s.includes(SHA('win32-x64')), 'win-x64 sha256');
    });
}

for (const rel of UNIX_SCRIPTS) {
    test(`${rel} pins the same unix Node builds as paths.mjs`, () => {
        const s = read(rel);
        assert.match(s, new RegExp(`NODE_VERSION="${NODE_VERSION.replace(/\./g, '\\.')}"`));
        for (const key of ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64']) {
            assert.ok(s.includes(SHA(key)), `${key} sha256`);
        }
    });
}

test('bin/ais is POSIX sh and LF-only; bin/ais.cmd keeps CRLF', () => {
    const sh = read('bin/ais');
    assert.ok(sh.startsWith('#!/bin/sh\n'), 'POSIX shebang, LF');
    assert.ok(!sh.includes('\r'), 'no CR in the sh bootstrap');
    assert.ok(!/\[\[|BASH_SOURCE|^\s*local\s/m.test(sh), 'no bashisms');
    const cmd = read('bin/ais.cmd');
    assert.equal(cmd.split('\n').length, cmd.split('\r\n').length, 'every line CRLF');
});

for (const rel of WIN_SCRIPTS) {
    test(`${rel} clears PSModulePath before calling Windows PowerShell`, () => {
        // Started from PowerShell 7, the inherited PSModulePath breaks
        // Get-FileHash / Expand-Archive in Windows PowerShell 5.1.
        const lines = read(rel).split(/\r?\n/);
        const clear = lines.findIndex(l => /^\s*set "PSModulePath="\s*$/.test(l));
        const firstPs = lines.findIndex(l => /^\s*(for \/f .*\(')?powershell\b/i.test(l));
        assert.ok(clear >= 0, 'PSModulePath is cleared');
        assert.ok(firstPs > clear, 'before the first powershell call');
    });
}

test('bin/ais.cmd exits on the node line so a mid-run update cannot be misread', () => {
    const line = read('bin/ais.cmd').split('\r\n').find(l => l.startsWith('"%NODE_BIN%'));
    assert.match(line, /%\* & call exit \/b %%ERRORLEVEL%%$/);
});
