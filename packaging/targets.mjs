// Release targets: one archive per OS/arch, each carrying the agm build for
// that platform under bin/<platformKey>/. Shared by build-agm.mjs,
// package.mjs, the installers (asset names) and the tests.

import fs   from 'node:fs';
import path from 'node:path';
import url  from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

export const TARGETS = [
    { id: 'windows-x64', platformKey: 'win32-x64',    goos: 'windows', goarch: 'amd64', format: 'zip' },
    { id: 'macos-arm64', platformKey: 'darwin-arm64', goos: 'darwin',  goarch: 'arm64', format: 'tar.gz' },
    { id: 'macos-x64',   platformKey: 'darwin-x64',   goos: 'darwin',  goarch: 'amd64', format: 'tar.gz' },
    { id: 'linux-x64',   platformKey: 'linux-x64',    goos: 'linux',   goarch: 'amd64', format: 'tar.gz' },
    { id: 'linux-arm64', platformKey: 'linux-arm64',  goos: 'linux',   goarch: 'arm64', format: 'tar.gz' },
];

/** Every platform's agm in one zip, for a folder carried between machines. */
export const PORTABLE = { id: 'portable', format: 'zip' };

export function assetName(target) {
    return `ais-${target.id}.${target.format}`;
}

export function agmFileName(target) {
    return `agm-${target.goos}-${target.goarch}${target.goos === 'windows' ? '.exe' : ''}`;
}

export function currentTarget(platform = process.platform, arch = process.arch) {
    const key = `${platform}-${arch === 'arm64' ? 'arm64' : 'x64'}`;
    return TARGETS.find(t => t.platformKey === key) || null;
}

/** Parse packaging/agm.lock (key=value lines, # comments). */
export function readAgmLock(file = path.join(REPO_ROOT, 'packaging', 'agm.lock')) {
    const out = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([a-z]+)\s*=\s*(\S+)\s*$/.exec(line);
        if (m) out[m[1]] = m[2];
    }
    // GitHub owner/name; it ends up in a download URL, so no dot segments.
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][\w.-]*$/.test(out.repo || '') || out.repo.includes('..')) {
        throw new Error('agm.lock: bad repo');
    }
    if (!/^[0-9a-f]{40}$/.test(out.commit || '')) throw new Error('agm.lock: commit must be a full SHA');
    return out;
}

/**
 * What goes into every archive, relative to the repo root. Runtime state
 * (app/, profiles/), tests and CI config never ship.
 */
export const PAYLOAD = [
    'launcher', 'templates', 'assets', 'bin/ais', 'bin/ais.cmd',
    'Claude.bat', 'Codex.bat', 'Copilot.bat', 'Antigravity.bat', 'Happy.bat',
    'claude.sh', 'codex.sh', 'copilot.sh', 'antigravity.sh',
    'install.sh', 'install.ps1',
    'LICENSE', 'CHANGELOG.md', 'VERSION', 'THIRD_PARTY_NOTICES.md',
];

/** Files that must be executable inside unix archives. */
export const EXECUTABLES = [
    'bin/ais', 'claude.sh', 'codex.sh', 'copilot.sh', 'antigravity.sh', 'install.sh',
    'launcher/open-in-terminal.sh',
];
