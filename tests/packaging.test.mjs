// The packaging contract: what ships, what the archives are called, and that
// the installers and CI ask for exactly those names.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import {
    REPO_ROOT, TARGETS, PORTABLE, PAYLOAD, EXECUTABLES,
    assetName, agmFileName, currentTarget, readAgmLock,
} from '../packaging/targets.mjs';

const read = rel => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

test('agm.lock pins a full commit of a GitHub repo', () => {
    const lock = readAgmLock();
    assert.equal(lock.repo, 'shyim/agm');
    assert.match(lock.commit, /^[0-9a-f]{40}$/);
});

test('agm.lock rejects branch names and short SHAs', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agmlock-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const f = path.join(dir, 'agm.lock');
    fs.writeFileSync(f, 'repo=shyim/agm\ncommit=main\n');
    assert.throws(() => readAgmLock(f), /full SHA/);
    fs.writeFileSync(f, 'repo=../evil\ncommit=' + 'a'.repeat(40) + '\n');
    assert.throws(() => readAgmLock(f), /bad repo/);
});

test('every payload entry exists; executables are shipped', () => {
    for (const rel of PAYLOAD) assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), rel);
    for (const rel of EXECUTABLES) {
        assert.ok(PAYLOAD.some(p => rel === p || rel.startsWith(p + '/')), `${rel} not in payload`);
    }
    for (const never of ['app', 'profiles', 'tests', '.github']) assert.ok(!PAYLOAD.includes(never), never);
});

test('asset and agm build names', () => {
    assert.deepEqual(TARGETS.map(assetName), [
        'ais-windows-x64.zip', 'ais-macos-arm64.tar.gz', 'ais-macos-x64.tar.gz',
        'ais-linux-x64.tar.gz', 'ais-linux-arm64.tar.gz',
    ]);
    assert.equal(assetName(PORTABLE), 'ais-portable.zip');
    assert.equal(agmFileName(TARGETS[0]), 'agm-windows-amd64.exe');
    assert.equal(agmFileName(TARGETS[1]), 'agm-darwin-arm64');
});

test('currentTarget covers every platform the Node bootstrap supports', () => {
    assert.equal(currentTarget('win32', 'x64').id, 'windows-x64');
    assert.equal(currentTarget('darwin', 'arm64').id, 'macos-arm64');
    assert.equal(currentTarget('darwin', 'x64').id, 'macos-x64');
    assert.equal(currentTarget('linux', 'x64').id, 'linux-x64');
    assert.equal(currentTarget('linux', 'arm64').id, 'linux-arm64');
    assert.equal(currentTarget('freebsd', 'x64'), null);
});

test('install.sh asks for exactly the unix asset names', () => {
    const sh = read('install.sh');
    assert.match(sh, /ASSET="ais-\$os-\$arch\.tar\.gz"/);
    const oses = [...sh.matchAll(/^\s+(?:Darwin|Linux)\)\s+os=(\w+)/gm)].map(m => m[1]);
    const arches = [...sh.matchAll(/\)\s+arch=(\w+) ;;/g)].map(m => m[1]);
    const names = oses.flatMap(o => arches.map(a => `ais-${o}-${a}.tar.gz`)).sort();
    const want = TARGETS.filter(t => t.format === 'tar.gz').map(assetName).sort();
    assert.deepEqual(names, want);
});

test('install.ps1 asks for the windows asset', () => {
    assert.match(read('install.ps1'), /\$asset\s+=\s+'ais-windows-x64\.zip'/);
});

test('installers default to the same release repo', () => {
    const sh = /REPO="\$\{AIS_REPO:-([^}]+)\}"/.exec(read('install.sh'))[1];
    const ps = /Opt 'AIS_REPO' '([^']+)'/.exec(read('install.ps1'))[1];
    assert.equal(sh, ps);
});

test('installers never replace app/ or profiles/', () => {
    assert.match(read('install.sh'), /case "\$name" in app\|profiles\) continue ;; esac/);
    assert.match(read('install.ps1'), /\$item\.Name -in @\('app', 'profiles'\)/);
});

test('the CI verify job installs every unix asset name it can meet', () => {
    const yml = read('.github/workflows/_build.yml');
    for (const t of TARGETS.filter(x => x.format === 'tar.gz')) {
        assert.ok(yml.includes(`asset=${assetName(t)}`), assetName(t));
    }
    assert.ok(yml.includes("'ais-windows-x64.zip'"));
});
