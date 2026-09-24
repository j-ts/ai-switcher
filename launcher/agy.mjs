// Portable Antigravity CLI (agy) install.
//
// Google's install.sh/install.ps1 fetch a per-platform manifest
// ({ version, url, sha512 }) from the CLI auto-updater service, verify the
// download against it and then run `agy install`, which edits shell rc files
// and the user PATH. We do the fetch + verify part ourselves and stop there:
// the binary lands in app/agy/ and nothing outside the portable tree is
// touched. agy keeps self-updating in place from there.
//
// agy is run with the real HOME (not a profile-redirected one): its login
// lives in the OS credential store, which agm switches per ais profile.

import fs     from 'node:fs';
import path   from 'node:path';
import https  from 'node:https';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { IS_WIN, IS_MAC, APP_ROOT } from './paths.mjs';
import { download, extractTar } from './install.mjs';
import { color } from './ui.mjs';

export const AGY_MANIFEST_BASE = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests';
export const AGY_DIR = path.join(APP_ROOT, 'agy');

export function agyBinPath() {
    return path.join(AGY_DIR, IS_WIN ? 'agy.exe' : 'agy');
}

/** Manifest platform id for a Node platform/arch pair (null = unsupported). */
export function agyPlatform(platform = process.platform, arch = process.arch, { musl = false } = {}) {
    const a = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'amd64' : null;
    if (!a) return null;
    if (platform === 'win32')  return `windows_${a}`;
    if (platform === 'darwin') return `darwin_${a}`;
    if (platform === 'linux')  return musl ? `linux_${a}_musl` : `linux_${a}`;
    return null;
}

function isMusl() {
    if (process.platform !== 'linux') return false;
    try {
        const report = process.report && process.report.getReport();
        return !(report && report.header && report.header.glibcVersionRuntime);
    } catch { return false; }
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'ais' } }, res => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', d => { body += d; });
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

function sha512(file) {
    return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('hex');
}

/** Install agy into app/agy unless present. Returns the binary path. */
export async function ensureAgy() {
    const bin = agyBinPath();
    if (fs.existsSync(bin)) return bin;

    const platform = agyPlatform(process.platform, process.arch, { musl: isMusl() });
    if (!platform) throw new Error(`Antigravity CLI has no build for ${process.platform}-${process.arch}.`);

    console.log(color('cyan', 'First-time setup: Antigravity CLI (agy)'));
    const manifest = await fetchJson(`${AGY_MANIFEST_BASE}/${platform}.json`);
    if (!manifest || !manifest.url || !manifest.sha512) throw new Error('Antigravity release manifest is malformed.');

    fs.mkdirSync(AGY_DIR, { recursive: true });
    const isTar = /\.tar\.gz(\?|$)/.test(manifest.url);
    const payload = path.join(AGY_DIR, isTar ? 'agy.tar.gz' : 'agy.download');
    console.log(color('darkcyan', `  downloading agy ${manifest.version || ''} ...`));
    try {
        await download(manifest.url, payload);
        if (sha512(payload) !== String(manifest.sha512).toLowerCase()) {
            throw new Error('SHA512 mismatch for the Antigravity CLI download.');
        }
        if (isTar) {
            const stage = path.join(AGY_DIR, 'stage');
            fs.rmSync(stage, { recursive: true, force: true });
            extractTar(payload, stage);
            const inner = ['antigravity', 'agy'].map(n => path.join(stage, n)).find(p => fs.existsSync(p));
            if (!inner) throw new Error('Antigravity archive did not contain the CLI binary.');
            fs.renameSync(inner, bin);
            fs.rmSync(stage, { recursive: true, force: true });
        } else {
            fs.renameSync(payload, bin);
        }
    } finally {
        fs.rmSync(payload, { force: true });
    }
    if (!IS_WIN) fs.chmodSync(bin, 0o755);
    if (IS_MAC) clearQuarantine(bin);
    return bin;
}

/** Same as Google's installer: a stray quarantine flag would block exec. */
function clearQuarantine(file) {
    spawnSync('xattr', ['-d', 'com.apple.quarantine', file], { stdio: 'ignore' });
}

/** Where agy writes its logs (used by `ais run agy` to spot quota errors). */
export function agyLogDirs(home) {
    const base = path.join(home, '.gemini', 'antigravity-cli');
    return [path.join(base, 'log'), base];
}
