// Per-service plumbing for ais: who is logged in, how to log in, and how to
// start each CLI for a given account.
//
// Launching is delegated to the existing per-tool launchers (launcher.mjs,
// codex-launcher.mjs, antigravity-launcher.mjs) so `ais claude` gets the same
// session picker, daily updates and portable runtime PATH as Claude.bat. Only
// logins run the CLIs directly (`claude auth login`, `codex login`,
// `agm login`), because those must not open a session afterwards.

import fs   from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
    IS_WIN, PORTABLE_ROOT, PROFILES_ROOT, claudeCli, claudeConfigDir, codexConfigDir,
    nodeBinDir, npmGlobalDir,
} from './paths.mjs';
import {
    createProfile, getProfileInfo, listProfileNames, profileTool,
} from './profiles.mjs';
import { ensureClaudeCode } from './install.mjs';
import { baseProfileEnv, ensureNpmTool } from './tool-launcher-core.mjs';
import { loginAccount } from './agm.mjs';

export const SERVICE_LABEL = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' };

const LAUNCHER = {
    claude: 'launcher.mjs',
    codex:  'codex-launcher.mjs',
    agy:    'antigravity-launcher.mjs',
};

/** argv (for the portable node) that starts `service` as `account`. */
export function launcherArgs(service, account, extra = []) {
    const script = path.join(PORTABLE_ROOT, 'launcher', LAUNCHER[service]);
    const flag = service === 'agy' ? '--account' : '--profile';
    return [script, flag, account, ...extra];
}

/**
 * Make sure a tool profile directory exists and belongs to `service`.
 * Adopts an existing directory of the right tool; refuses a foreign one.
 */
export function ensureToolProfile(service, dirName) {
    if (listProfileNames().includes(dirName)) {
        const owner = profileTool(dirName);
        if (owner !== service) {
            throw new Error(`profiles/${dirName} belongs to ${owner}, not ${service}.`);
        }
        return { created: false };
    }
    createProfile(dirName, { tool: service });
    return { created: true };
}

/**
 * Account identity for display: { email, loggedIn }.
 * agyAccounts: the parsed `agm list` rows, passed in so callers can fetch
 * them once for a whole table.
 */
export function identity(service, account, { agyAccounts = [] } = {}) {
    if (!account) return { email: null, loggedIn: false, missing: false };
    if (service === 'agy') {
        const known = agyAccounts.some(a => a.email.toLowerCase() === account.toLowerCase());
        return { email: account, loggedIn: known, missing: !known };
    }
    if (!listProfileNames().includes(account)) return { email: null, loggedIn: false, missing: true };
    const info = getProfileInfo(account);
    const loggedIn = info.email && info.email !== '<not logged in>';
    return { email: loggedIn ? info.email : null, loggedIn: !!loggedIn, missing: false };
}

export function claudeEnv(dirName) {
    return {
        ...process.env,
        ...baseProfileEnv(dirName),
        CLAUDE_PROFILE:    dirName,
        CLAUDE_CONFIG_DIR: claudeConfigDir(dirName),
    };
}

export function codexEnv(dirName) {
    return { ...process.env, ...baseProfileEnv(dirName), CODEX_HOME: codexConfigDir(dirName) };
}

/** Codex's JS entry inside a profile's npm-global (runs under our node). */
export function codexEntry(dirName) {
    const g = npmGlobalDir(dirName);
    const candidates = [
        path.join(g, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
        path.join(g, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
}

function nodeExe() {
    const bundled = path.join(nodeBinDir(), IS_WIN ? 'node.exe' : 'node');
    return fs.existsSync(bundled) ? bundled : process.execPath;
}

function run(cmd, args, env, { shell = false } = {}) {
    const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell });
    if (r.error) throw r.error;
    return r.status ?? 1;
}

/**
 * Interactive login for one service of one account. Installs the CLI into
 * the tool profile first when needed. Returns the logged-in email (agy) or
 * the identity found afterwards (claude/codex); throws on failure.
 */
export async function loginService(service, account, extraArgs = []) {
    if (service === 'agy') return await loginAccount();

    fs.mkdirSync(PROFILES_ROOT, { recursive: true });
    if (service === 'claude') {
        ensureToolProfile('claude', account);
        fs.mkdirSync(claudeConfigDir(account), { recursive: true });
        ensureClaudeCode(account);
        const cli = claudeCli(account);
        const [cmd, pre] = cli.kind === 'native' ? [cli.path, []] : [nodeExe(), [cli.path]];
        const code = run(cmd, [...pre, 'auth', 'login', ...extraArgs], claudeEnv(account));
        if (code !== 0) throw new Error(`claude auth login exited ${code}`);
    } else if (service === 'codex') {
        ensureToolProfile('codex', account);
        fs.mkdirSync(codexConfigDir(account), { recursive: true });
        ensureNpmTool(account, '@openai/codex', 'codex', { label: 'Codex CLI' });
        const entry = codexEntry(account);
        const env = codexEnv(account);
        const code = entry
            ? run(nodeExe(), [entry, 'login', ...extraArgs], env)
            // .cmd shims only spawn through a shell on Node 22+ (CVE-2024-27980).
            : run(IS_WIN ? 'codex.cmd' : 'codex', ['login', ...extraArgs], env, { shell: IS_WIN });
        if (code !== 0) throw new Error(`codex login exited ${code}`);
    } else {
        throw new Error(`Unknown service '${service}'.`);
    }
    const id = identity(service, account);
    if (!id.loggedIn) throw new Error(`${SERVICE_LABEL[service]} login did not complete.`);
    return id.email;
}

/**
 * Existing tool profiles that follow the `<tool>-<name>` convention, grouped
 * into would-be ais profiles: [{ name, claude, codex }].
 */
export function discoverToolProfiles() {
    const groups = new Map();
    for (const dir of listProfileNames()) {
        const m = /^(claude|codex)-(.+)$/.exec(dir);
        if (!m || profileTool(dir) !== m[1]) continue;
        const g = groups.get(m[2]) || { name: m[2], claude: null, codex: null };
        g[m[1]] = dir;
        groups.set(m[2], g);
    }
    return [...groups.values()];
}
