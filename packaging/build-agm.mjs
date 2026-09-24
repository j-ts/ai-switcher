// Build agm from the commit pinned in packaging/agm.lock.
//
//   node packaging/build-agm.mjs                      all release targets -> build/agm/
//   node packaging/build-agm.mjs --targets current --install
//                                                    this platform only, then copy it to
//                                                    bin/<platform>/ so a source checkout works
//
// Needs Go (version per agm's go.mod) and tar; no git. agm is pure Go (its
// SQLite driver is modernc.org/sqlite), so every target cross-compiles with
// CGO disabled from any host.

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { download } from '../launcher/install.mjs';
import { REPO_ROOT, TARGETS, agmFileName, currentTarget, readAgmLock } from './targets.mjs';

function parse(argv) {
    const o = { out: path.join(REPO_ROOT, 'build', 'agm'), targets: 'all', install: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--out') o.out = path.resolve(argv[++i]);
        else if (argv[i] === '--targets') o.targets = argv[++i];
        else if (argv[i] === '--install') o.install = true;
        else throw new Error(`unknown option ${argv[i]}`);
    }
    return o;
}

function pick(spec) {
    if (spec === 'all') return TARGETS;
    if (spec === 'current') {
        const t = currentTarget();
        if (!t) throw new Error(`no release target for ${process.platform}-${process.arch}`);
        return [t];
    }
    return spec.split(',').map(id => {
        const t = TARGETS.find(x => x.id === id);
        if (!t) throw new Error(`unknown target ${id}`);
        return t;
    });
}

function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
}

async function main() {
    const opts = parse(process.argv.slice(2));
    const lock = readAgmLock();
    const targets = pick(opts.targets);

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-src-'));
    try {
        const tarball = path.join(work, 'src.tar.gz');
        console.log(`agm ${lock.repo}@${lock.commit.slice(0, 12)}: fetching source`);
        await download(`https://codeload.github.com/${lock.repo}/tar.gz/${lock.commit}`, tarball);
        // Relative name + cwd: GNU tar would read "C:\..." as a remote host:path.
        run('tar', ['-xzf', path.basename(tarball)], { cwd: work });
        const src = fs.readdirSync(work).map(n => path.join(work, n))
            .find(p => fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'go.mod')));
        if (!src) throw new Error('agm source archive has no go.mod');

        fs.mkdirSync(opts.out, { recursive: true });
        for (const t of targets) {
            const outFile = path.join(opts.out, agmFileName(t));
            console.log(`  building ${t.goos}/${t.goarch} -> ${path.relative(REPO_ROOT, outFile)}`);
            run('go', ['build', '-trimpath', '-ldflags', '-s -w -buildid=', '-o', outFile, '.'], {
                cwd: src,
                env: { ...process.env, CGO_ENABLED: '0', GOOS: t.goos, GOARCH: t.goarch, GOFLAGS: '-mod=readonly' },
            });
        }
        fs.writeFileSync(path.join(opts.out, 'SOURCE'), `${lock.repo}@${lock.commit}\n`);

        if (opts.install) {
            const t = currentTarget();
            const src = path.join(opts.out, agmFileName(t));
            if (!fs.existsSync(src)) throw new Error(`--install: ${agmFileName(t)} was not built`);
            const dst = path.join(REPO_ROOT, 'bin', t.platformKey, t.goos === 'windows' ? 'agm.exe' : 'agm');
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.copyFileSync(src, dst);
            fs.chmodSync(dst, 0o755);
            console.log(`  installed ${path.relative(REPO_ROOT, dst)}`);
        }
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

main().catch(e => { console.error(`build-agm: ${e.message}`); process.exit(1); });
