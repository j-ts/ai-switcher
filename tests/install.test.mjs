import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from '../launcher/install.mjs';

test('sha256 hashes a small file deterministically', (t) => {
    const tmp = path.join(os.tmpdir(), 'cp-sha-' + Date.now() + '.txt');
    fs.writeFileSync(tmp, 'hello world\n');
    t.after(() => fs.rmSync(tmp, { force: true }));
    // `printf 'hello world\n' | sha256sum` → a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447
    assert.equal(sha256(tmp), 'a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447');
});

test('winPowerShellEnv drops PSModulePath in any spelling, keeps the rest', async () => {
    const { winPowerShellEnv } = await import('../launcher/install.mjs');
    const env = winPowerShellEnv({ PATH: 'p', PSModulePath: 'a', psmodulepath: 'b', Other: 'x' });
    assert.deepEqual(env, { PATH: 'p', Other: 'x' });
});
