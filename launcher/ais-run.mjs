// `ais run <service>`: start a CLI under the active profile and, when that
// account hits its usage limit, move to the next profile and restart the CLI
// where it left off.
//
// The CLI keeps the real terminal (inherited stdio), so its output cannot be
// read directly. Instead the tool's own session logs are tailed while it
// runs - every tool records limit errors there (see ais-limits.mjs). On a
// hit: stop the CLI (whole process tree), record the limit window, activate
// the next usable profile, carry the conversation over, relaunch.
//
//   claude  session <id>.jsonl copied into the next profile, `--resume <id>`
//   codex   rollout file copied into the next CODEX_HOME,   `resume <id>`
//   agy     conversations live in the shared ~/.gemini,     `--continue`
// One-shot invocations (claude -p, codex exec, agy -p) are simply re-run.

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { IS_WIN, claudeConfigDir, codexConfigDir } from './paths.mjs';
import { color, promptYesNo } from './ui.mjs';
import { DETECTORS } from './ais-limits.mjs';
import {
    loadState, saveState, useProfile, markLimited, pickNext, limitUntil,
} from './ais-state.mjs';
import { launcherArgs, identity, SERVICE_LABEL } from './ais-tools.mjs';
import { listAccounts } from './agm.mjs';
import { agyLogDirs } from './agy.mjs';

/** Assumed limit window when the tool's message names no reset time. */
export const DEFAULT_LIMIT_MS = 5 * 3600e3;

const POLL_MS = 1000;

// ---------------------------------------------------------------------------
// Log tailing
// ---------------------------------------------------------------------------

/**
 * Follows every file under `roots` (up to maxDepth levels) that `match`
 * accepts, yielding only lines appended after construction. Files created
 * later are read from their start.
 */
export class LogTail {
    constructor(roots, { maxDepth = 2, match = f => f.endsWith('.jsonl') } = {}) {
        this.roots = roots;
        this.maxDepth = maxDepth;
        this.match = match;
        this.offsets = new Map();
        this.partial = new Map();
        for (const f of this.files()) {
            try { this.offsets.set(f, fs.statSync(f).size); } catch {}
        }
    }

    files() {
        const out = [];
        const walk = (dir, depth) => {
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) { if (depth < this.maxDepth) walk(p, depth + 1); }
                else if (e.isFile() && this.match(p)) out.push(p);
            }
        };
        for (const r of this.roots) walk(r, 1);
        return out;
    }

    poll() {
        const lines = [];
        for (const f of this.files()) {
            let size;
            try { size = fs.statSync(f).size; } catch { continue; }
            const prev = this.offsets.get(f) ?? 0;
            if (size < prev) { this.offsets.set(f, size); this.partial.delete(f); continue; }
            if (size === prev) continue;
            let chunk = '';
            try {
                const fd = fs.openSync(f, 'r');
                try {
                    const buf = Buffer.alloc(size - prev);
                    fs.readSync(fd, buf, 0, buf.length, prev);
                    chunk = buf.toString('utf8');
                } finally { fs.closeSync(fd); }
            } catch { continue; }
            this.offsets.set(f, size);
            const parts = ((this.partial.get(f) || '') + chunk).split('\n');
            this.partial.set(f, parts.pop());
            for (const line of parts) {
                const l = line.replace(/\r$/, '');
                if (l.trim()) lines.push({ file: f, line: l });
            }
        }
        return lines;
    }
}

// ---------------------------------------------------------------------------
// Per-service behaviour
// ---------------------------------------------------------------------------
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Drop the caller's own session-selection flags before we add ours. */
export function stripSessionArgs(service, args) {
    const out = [];
    const takesValue = {
        claude: ['--resume', '-r', '--session-id'],
        codex:  [],
        agy:    ['--conversation'],
    }[service];
    const flags = {
        claude: ['-c', '--continue', '--resume-last', '--new', '--fork-session'],
        codex:  ['--new'],
        agy:    ['-c', '--continue'],
    }[service];
    for (let i = 0; i < args.length; i++) {
        if (takesValue.includes(args[i])) { i++; continue; }
        if (flags.includes(args[i])) continue;
        if (service === 'codex' && i === 0 && args[i] === 'resume') {
            // `resume [<id>|--last]`: drop the subcommand and its target.
            if (args[i + 1] && !args[i + 1].startsWith('-')) i++;
            else if (args[i + 1] === '--last') i++;
            continue;
        }
        out.push(args[i]);
    }
    return out;
}

/** Non-interactive runs are repeated as-is instead of resumed. */
export function isOneShot(service, args) {
    if (service === 'codex') return args[0] === 'exec' || args[0] === 'e';
    return args.some(a => a === '-p' || a === '--print' || a === '--prompt');
}

export function codexSessionId(file) {
    const m = UUID.exec(file);
    if (m) return m[1];
    try {
        const first = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
        const j = JSON.parse(first);
        return (j.payload && j.payload.id) || null;
    } catch { return null; }
}

function copyOver(src, dst) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
}

export const ADAPTERS = {
    claude: {
        watch: account => ({ roots: [path.join(claudeConfigDir(account), 'projects')], maxDepth: 2 }),
        detect(line, file) {
            const hit = DETECTORS.claude(line);
            if (hit) { hit.file = file; hit.sessionId = hit.sessionId || path.basename(file, '.jsonl'); }
            return hit;
        },
        resumeArgs: hit => ['--resume', hit.sessionId],
        /** Copy the transcript (plus its sidecar dir) into the next profile. */
        transfer(from, to, hit) {
            const project = path.basename(path.dirname(hit.file));
            const dstDir = path.join(claudeConfigDir(to), 'projects', project);
            copyOver(hit.file, path.join(dstDir, path.basename(hit.file)));
            const sidecar = path.join(path.dirname(hit.file), hit.sessionId);
            if (fs.existsSync(sidecar)) {
                fs.cpSync(sidecar, path.join(dstDir, hit.sessionId), { recursive: true, force: true });
            }
        },
    },
    codex: {
        watch: account => ({ roots: [path.join(codexConfigDir(account), 'sessions')], maxDepth: 4 }),
        detect(line, file) {
            const hit = DETECTORS.codex(line);
            if (hit) { hit.file = file; hit.sessionId = codexSessionId(file); }
            return hit;
        },
        resumeArgs: hit => (hit.sessionId ? ['--new', 'resume', hit.sessionId] : ['--new', 'resume', '--last']),
        transfer(from, to, hit) {
            const rel = path.relative(path.join(codexConfigDir(from), 'sessions'), hit.file);
            copyOver(hit.file, path.join(codexConfigDir(to), 'sessions', rel));
        },
    },
    agy: {
        watch: () => ({ roots: agyLogDirs(os.homedir()), maxDepth: 1, match: f => f.endsWith('.log') }),
        detect(line, file) {
            const hit = DETECTORS.agy(line);
            if (hit) hit.file = file;
            return hit;
        },
        resumeArgs: () => ['--continue'],
        transfer() { /* conversations live in the shared ~/.gemini */ },
    },
};

// ---------------------------------------------------------------------------
// Process control
// ---------------------------------------------------------------------------

/** pid + all descendants, children before parents (unix: via ps). */
function processTree(pid) {
    const r = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8' });
    const kids = new Map();
    for (const line of (r.stdout || '').split('\n')) {
        const [p, pp] = line.trim().split(/\s+/).map(Number);
        if (!p || !pp) continue;
        if (!kids.has(pp)) kids.set(pp, []);
        kids.get(pp).push(p);
    }
    const out = [];
    const visit = p => { for (const k of kids.get(p) || []) visit(k); out.push(p); };
    visit(pid);
    return out;
}

/** Stop a CLI and everything it spawned (the launcher runs the tool as a child). */
export function killTree(pid) {
    if (IS_WIN) {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        return;
    }
    const tree = processTree(pid);
    for (const p of tree) { try { process.kill(p, 'SIGTERM'); } catch {} }
    const t = setTimeout(() => {
        for (const p of tree) { try { process.kill(p, 'SIGKILL'); } catch {} }
    }, 3000);
    t.unref();
}

/** Undo whatever terminal modes a killed TUI left behind. */
function resetTerminal() {
    if (!process.stdout.isTTY) return;
    // SGR reset, cursor on, leave alt screen, bracketed paste + mouse
    // reporting off, pop kitty keyboard mode.
    process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[<u\r\n');
    if (!IS_WIN && process.stdin.isTTY) spawnSync('stty', ['sane'], { stdio: 'inherit' });
}

/**
 * Run one CLI process until it exits (-> { type: 'exit', code, hit })
 * or its log shows a usage limit (-> { type: 'limit', hit }, CLI stopped).
 */
function supervise(child, tail, adapter, pollMs = POLL_MS) {
    return new Promise(resolve => {
        let hit = null, stopping = false;
        const scan = () => {
            for (const { file, line } of tail.poll()) {
                const h = adapter.detect(line, file);
                if (h) { hit = h; return true; }
            }
            return false;
        };
        // Ctrl+C belongs to the CLI; the supervisor must survive it.
        const ignore = () => {};
        process.on('SIGINT', ignore);
        const forward = () => { stopping = true; killTree(child.pid); };
        process.on('SIGTERM', forward);
        process.on('SIGHUP', forward);

        const timer = setInterval(() => {
            if (stopping) return;
            if (scan()) { stopping = true; clearInterval(timer); killTree(child.pid); }
        }, pollMs);

        const finish = result => {
            clearInterval(timer);
            process.off('SIGINT', ignore);
            process.off('SIGTERM', forward);
            process.off('SIGHUP', forward);
            resolve(result);
        };
        child.on('error', e => finish({ type: 'exit', code: 1, error: e, hit: null }));
        child.on('exit', (code, signal) => {
            if (hit) { resetTerminal(); return finish({ type: 'limit', hit }); }
            // A limit logged in the last second before a normal exit.
            scan();
            finish({ type: 'exit', code: code ?? (signal ? 1 : 0), hit });
        });
    });
}

// ---------------------------------------------------------------------------
// Rotation loop
// ---------------------------------------------------------------------------
function fmtTime(ms) {
    const d = new Date(ms);
    const sameDay = d.toDateString() === new Date().toDateString();
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return sameDay ? hm : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
}

function usableFn(service) {
    let agyAccounts = [];
    if (service === 'agy') { try { agyAccounts = listAccounts(); } catch {} }
    return state => name => identity(service, state.profiles[name][service], { agyAccounts }).loggedIn;
}

/**
 * Supervise `service` with automatic account rotation. `as` pins the first
 * profile. Returns the exit code for ais. argsFor/pollMs exist for tests.
 */
export async function runWithRotation(service, userArgs, {
    as = null, nodeExe = process.execPath, argsFor = launcherArgs, pollMs = POLL_MS,
} = {}) {
    const adapter = ADAPTERS[service];
    const label = SERVICE_LABEL[service];
    const usable = usableFn(service);
    let state = loadState();

    let name = as || state.active[service];
    if (!name) throw new Error(`No ${label} account is active - run: ais setup`);
    if (!state.profiles[name] || !state.profiles[name][service]) {
        throw new Error(`Profile '${name}' has no ${label} account.`);
    }

    // Don't start on an account we already know is spent.
    const until = limitUntil(state, service, name);
    if (until && !as) {
        const next = pickNext(state, service, { isUsable: usable(state) });
        if (next && !next.limitedUntil) {
            console.log(color('yellow', `${label}: ${name} is limited until ${fmtTime(until)} - using ${next.name}.`));
            useProfile(state, next.name, [service]);
            saveState(state);
            name = next.name;
        } else {
            console.log(color('yellow', `${label}: ${name} is limited until ${fmtTime(until)} and no other account is free - starting anyway.`));
        }
    }

    const oneShot = isOneShot(service, userArgs);
    const maxRotations = Math.max(1, state.order.length);
    let extra = userArgs;
    let rotations = 0;

    while (true) {
        const account = state.profiles[name][service];
        const w = adapter.watch(account);
        const tail = new LogTail(w.roots, w);
        const child = spawn(nodeExe, argsFor(service, account, extra), { stdio: 'inherit' });
        const outcome = await supervise(child, tail, adapter, pollMs);

        if (outcome.type === 'exit') {
            if (!outcome.hit || !process.stdin.isTTY) return outcome.code;
            const ok = await promptYesNo(`${label} account '${name}' hit its usage limit. Switch to the next profile and resume?`);
            if (!ok) return outcome.code;
        }

        const hit = outcome.hit;
        state = loadState();
        markLimited(state, service, name, hit.resetAt || Date.now() + DEFAULT_LIMIT_MS);
        const next = pickNext(state, service, { isUsable: usable(state) });
        saveState(state);

        console.log('');
        console.log(color('yellow', `${label}: '${name}' hit its usage limit - ${hit.message}`));
        if (!next || next.limitedUntil || ++rotations > maxRotations) {
            const when = next && next.limitedUntil ? ` The first account frees up around ${fmtTime(next.limitedUntil)} (${next.name}).` : '';
            console.log(color('red', `No other ${label} account is available.${when}`));
            return 75;   // EX_TEMPFAIL
        }

        useProfile(state, next.name, [service]);
        saveState(state);
        let resumed = false;
        if (!oneShot) {
            try {
                adapter.transfer(account, state.profiles[next.name][service], hit);
                resumed = true;
            } catch (e) {
                console.log(color('yellow', `  could not carry the session over (${e.message}); starting fresh.`));
            }
        }
        extra = oneShot ? userArgs
              : resumed ? [...adapter.resumeArgs(hit), ...stripSessionArgs(service, userArgs)]
              : stripSessionArgs(service, userArgs);
        console.log(color('green', `${label}: switched to '${next.name}'${resumed ? ', resuming the conversation' : ''} ...`));
        console.log('');
        name = next.name;
    }
}
