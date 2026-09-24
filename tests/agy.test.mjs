import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { agyPlatform, agyBinPath, agyLogDirs, AGY_DIR } from '../launcher/agy.mjs';
import { APP_ROOT } from '../launcher/paths.mjs';

test('agyPlatform maps node platform/arch to the manifest ids', () => {
    assert.equal(agyPlatform('win32', 'x64'), 'windows_amd64');
    assert.equal(agyPlatform('win32', 'arm64'), 'windows_arm64');
    assert.equal(agyPlatform('darwin', 'arm64'), 'darwin_arm64');
    assert.equal(agyPlatform('darwin', 'x64'), 'darwin_amd64');
    assert.equal(agyPlatform('linux', 'x64'), 'linux_amd64');
    assert.equal(agyPlatform('linux', 'arm64', { musl: true }), 'linux_arm64_musl');
    assert.equal(agyPlatform('linux', 'ia32'), null);
    assert.equal(agyPlatform('freebsd', 'x64'), null);
});

test('agy lives in the portable app/ tree, never in the user profile', () => {
    assert.equal(AGY_DIR, path.join(APP_ROOT, 'agy'));
    assert.equal(path.dirname(agyBinPath()), AGY_DIR);
});

test('agyLogDirs: per-session logs and the rolling cli.log dir', () => {
    const [logDir, base] = agyLogDirs('/home/u');
    assert.equal(base, path.join('/home/u', '.gemini', 'antigravity-cli'));
    assert.equal(logDir, path.join(base, 'log'));
});
