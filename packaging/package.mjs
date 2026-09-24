// Assemble release archives from the working tree + agm builds.
//
//   node packaging/package.mjs --version 0.1.0.123 [--agm-dir build/agm] [--out dist]
//                              [--targets all|current|<id,...>] [--no-portable]
//
// Produces in --out:
//   ais-<target>.zip|tar.gz   one per platform, agm under bin/<platformKey>/
//   ais-portable.zip          every platform's agm (a folder you carry around)
//   install.sh, install.ps1   the installers, as standalone assets
//   SHA256SUMS                checksums the installers verify against
// Archives unpack to a single ais/ folder. Asset names carry no version so
// .../releases/latest/download/<asset> stays a stable URL.

import fs     from 'node:fs';
import path   from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
    REPO_ROOT, TARGETS, PORTABLE, PAYLOAD, EXECUTABLES,
    assetName, agmFileName, currentTarget, readAgmLock,
} from './targets.mjs';

function parse(argv) {
    const o = {
        version: null, agmDir: path.join(REPO_ROOT, 'build', 'agm'),
        out: path.join(REPO_ROOT, 'dist'), targets: 'all', portable: true,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--version') o.version = argv[++i];
        else if (a === '--agm-dir') o.agmDir = path.resolve(argv[++i]);
        else if (a === '--out') o.out = path.resolve(argv[++i]);
        else if (a === '--targets') o.targets = argv[++i];
        else if (a === '--no-portable') o.portable = false;
        else throw new Error(`unknown option ${a}`);
    }
    if (!o.version) throw new Error('--version is required');
    return o;
}

function pick(spec) {
    if (spec === 'all') return TARGETS;
    if (spec === 'current') return [currentTarget()].filter(Boolean);
    return spec.split(',').map(id => TARGETS.find(t => t.id === id) || (() => { throw new Error(`unknown target ${id}`); })());
}

const JUNK = /(^|[\\/])(__pycache__|\.DS_Store|Thumbs\.db)$|\.pyc$|kde-service-[^\\/]*\.sh$/;

function run(cmd, args, cwd) {
    const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
}

/** Copy the shipped files into <stage>/ais and add version + agm builds. */
function stage(dir, version, agmBuilds, lock) {
    const root = path.join(dir, 'ais');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    for (const rel of PAYLOAD) {
        const src = path.join(REPO_ROOT, rel);
        if (!fs.existsSync(src)) throw new Error(`payload entry missing: ${rel}`);
        fs.cpSync(src, path.join(root, rel), { recursive: true, filter: s => !JUNK.test(s) });
    }
    fs.writeFileSync(path.join(root, 'ais-version.txt'), version + '\n');
    fs.writeFileSync(path.join(root, 'bin', 'agm-source.txt'), `${lock.repo}@${lock.commit}\n`);
    for (const { target, file } of agmBuilds) {
        const dst = path.join(root, 'bin', target.platformKey, target.goos === 'windows' ? 'agm.exe' : 'agm');
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(file, dst);
        fs.chmodSync(dst, 0o755);
    }
    for (const rel of EXECUTABLES) {
        const p = path.join(root, rel);
        if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
    }
    return root;
}

function archive(stageDir, format, outFile) {
    fs.rmSync(outFile, { force: true });
    // Relative output path: GNU tar would read "C:\..." as a remote host:path.
    const rel = path.relative(stageDir, outFile);
    if (format === 'tar.gz') {
        run('tar', ['-czf', rel, 'ais'], stageDir);
    } else if (spawnSync('zip', ['-v'], { stdio: 'ignore' }).status === 0) {
        run('zip', ['-qrX', rel, 'ais'], stageDir);      // keeps unix modes for unzip
    } else if (process.platform === 'win32') {
        run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', rel, 'ais'], stageDir);
    } else {
        throw new Error('need `zip` to build .zip archives');
    }
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
    const o = parse(process.argv.slice(2));
    const lock = readAgmLock();
    const targets = pick(o.targets);
    if (!targets.length) throw new Error('no targets selected');

    const builds = t => {
        const file = path.join(o.agmDir, agmFileName(t));
        if (!fs.existsSync(file)) throw new Error(`missing agm build ${file} (run packaging/build-agm.mjs)`);
        return { target: t, file };
    };

    fs.mkdirSync(o.out, { recursive: true });
    const stageRoot = path.join(o.out, '.stage');
    const produced = [];
    try {
        for (const t of targets) {
            const dir = path.join(stageRoot, t.id);
            stage(dir, o.version, [builds(t)], lock);
            const out = path.join(o.out, assetName(t));
            archive(dir, t.format, out);
            produced.push(out);
        }
        if (o.portable) {
            const dir = path.join(stageRoot, PORTABLE.id);
            stage(dir, o.version, TARGETS.map(builds), lock);
            const out = path.join(o.out, assetName(PORTABLE));
            archive(dir, PORTABLE.format, out);
            produced.push(out);
        }
    } finally {
        fs.rmSync(stageRoot, { recursive: true, force: true });
    }

    for (const f of ['install.sh', 'install.ps1']) {
        const dst = path.join(o.out, f);
        fs.copyFileSync(path.join(REPO_ROOT, f), dst);
        produced.push(dst);
    }
    const sums = produced.map(f => `${sha256(f)}  ${path.basename(f)}`).join('\n') + '\n';
    fs.writeFileSync(path.join(o.out, 'SHA256SUMS'), sums);
    process.stdout.write(sums);
}

try { main(); }
catch (e) { console.error(`package: ${e.message}`); process.exit(1); }
