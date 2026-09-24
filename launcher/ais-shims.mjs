// Optional `claude` / `codex` / `agy` commands that start the CLI as the
// active ais profile, so after `ais use second` a plain `claude` in any
// terminal is already the second account. Opt-in (`ais shims install`)
// because they deliberately shadow any globally installed CLI of the same
// name that comes later on PATH.
//
// Shims carry a marker line; install never overwrites and remove never
// deletes a file without it.

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { IS_WIN, PORTABLE_ROOT } from './paths.mjs';

export const SHIM_SERVICES = ['claude', 'codex', 'agy'];
export const SHIM_MARKER = 'ais shim';

export function defaultShimDir() {
    return IS_WIN ? path.join(PORTABLE_ROOT, 'bin') : path.join(os.homedir(), '.local', 'bin');
}

export function shimFileName(service, win = IS_WIN) {
    return win ? `${service}.cmd` : service;
}

export function shimContent(service, root = PORTABLE_ROOT, win = IS_WIN) {
    if (win) {
        const ais = path.win32.join(root, 'bin', 'ais.cmd');
        return `@echo off\r\nREM ${SHIM_MARKER}: ${service} as the active ais profile (remove: ais shims remove)\r\n`
             + `"${ais}" ${service} %*\r\n`;
    }
    const ais = path.posix.join(root, 'bin', 'ais');
    return `#!/bin/sh\n# ${SHIM_MARKER}: ${service} as the active ais profile (remove: ais shims remove)\n`
         + `exec "${ais}" ${service} "$@"\n`;
}

function isOurs(file) {
    try { return fs.readFileSync(file, 'utf8').includes(SHIM_MARKER); }
    catch { return false; }
}

/** Returns [{ service, file, status: 'installed'|'updated'|'skipped', reason? }]. */
export function installShims(dir = defaultShimDir(), { root = PORTABLE_ROOT, win = IS_WIN } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    return SHIM_SERVICES.map(service => {
        const file = path.join(dir, shimFileName(service, win));
        const existed = fs.existsSync(file);
        if (existed && !isOurs(file)) return { service, file, status: 'skipped', reason: 'a different file already exists' };
        fs.writeFileSync(file, shimContent(service, root, win));
        if (!win) fs.chmodSync(file, 0o755);
        return { service, file, status: existed ? 'updated' : 'installed' };
    });
}

export function removeShims(dir = defaultShimDir(), { win = IS_WIN } = {}) {
    const removed = [];
    for (const service of SHIM_SERVICES) {
        const file = path.join(dir, shimFileName(service, win));
        if (fs.existsSync(file) && isOurs(file)) { fs.rmSync(file); removed.push(file); }
    }
    return removed;
}

/** First `name` on PATH, or null (to warn when something else shadows a shim). */
export function whichFirst(name) {
    const r = IS_WIN
        ? spawnSync('where', [name], { encoding: 'utf8', windowsHide: true })
        : spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    return (r.stdout || '').split(/\r?\n/).find(Boolean) || null;
}
