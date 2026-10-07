// ais - one command for many accounts across Claude Code, OpenAI Codex and
// Google Antigravity.
//
//   ais setup                     first run: runtimes, agm, first profile, logins
//   ais profile add <name>        new profile (claude-<name> + codex-<name> + agm account)
//   ais use <name> [service..]    switch every (or the given) service to a profile
//   ais next [service..]          rotate to the next profile
//   ais status                    who is active where
//   ais claude|codex|agy [args]   start a CLI as the active profile
//   ais run <service> [args]      same, rotating accounts on usage limits
//
// Claude and Codex accounts are the per-profile directories of the portable
// launchers (profiles/claude-<name>, profiles/codex-<name>); Antigravity
// accounts live in agm's store (profiles/.agm) and are applied to the OS
// credential store with `agm switch`. See ais-state.mjs for the registry.

import fs   from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { IS_WIN, PORTABLE_ROOT, PROFILES_ROOT, APP_ROOT, currentPlatformKey } from './paths.mjs';
import { color, promptYesNo, readLine, padRight } from './ui.mjs';
import { ensureAllRuntimes, winPowerShellEnv } from './install.mjs';
import { setupPath, setPrivacyEnv } from './tool-launcher-core.mjs';
import { renameProfile as renameToolProfile, deleteProfile, listProfileNames } from './profiles.mjs';
import {
    SERVICES, DIR_SERVICES, stateFile, loadState, saveState, addProfile, removeProfile,
    renameProfile, setMapping, useProfile, currentProfile, pickNext, limitUntil,
    isValidAisName, defaultToolProfileName, clearLimit,
} from './ais-state.mjs';
import {
    SERVICE_LABEL, launcherArgs, identity, loginService, ensureToolProfile, discoverToolProfiles,
} from './ais-tools.mjs';
import {
    agmBinary, agmDataDir, legacyAgmDataDir, ensureStore, listAccounts, switchAccount,
    runAgmInteractive, adoptLegacyStore, credentialStoreHint,
} from './agm.mjs';
import { ensureAgy, agyBinPath } from './agy.mjs';
import { runWithRotation } from './ais-run.mjs';
import { installShims, removeShims, defaultShimDir, whichFirst, SHIM_SERVICES } from './ais-shims.mjs';

const HELP = `ais - switch Claude, Codex and Antigravity accounts with one command

Usage:
  ais setup                              first-run setup (runtimes, agm, first profile, logins)
  ais status                             profiles, accounts and what is active
  ais use <profile> [service...]         switch all (or some) services to a profile
  ais next [service...]                  rotate to the next profile
  ais profile add <profile> [options]    add a profile   --claude <dir> --codex <dir> --agy <email> --no-login
  ais profile list                       list profiles
  ais profile rename <old> <new>         rename a profile
  ais profile set <profile> <service> <account|none>
                                         point one service at another account
  ais profile remove <profile> [--purge] forget a profile (--purge also deletes its Claude/Codex data)
  ais login <profile> [service...]       log a profile in (again)
  ais claude|codex|agy [--as|--profile <profile>] [args...]
                                         start a CLI as the active profile
  ais run <service> [--as|--profile <profile>] [args...]
                                         start a CLI and rotate accounts when it hits a usage limit
  ais agm [args...]                      run the bundled agm on ais's account store
  ais shims install|remove [--dir <dir>] plain claude/codex/agy commands that follow the active profile
  ais doctor                             check the installation
  ais update                             install the latest release in place
  ais version

Services: claude, codex, agy`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
class UsageError extends Error {}

function die(msg, code = 1) {
    console.error(color('red', msg));
    process.exit(code);
}

function parseServices(list) {
    if (!list.length || (list.length === 1 && list[0] === 'all')) return [...SERVICES];
    for (const s of list) {
        if (s === 'antigravity') continue;
        if (!SERVICES.includes(s)) throw new UsageError(`Unknown service '${s}' (want ${SERVICES.join(', ')}).`);
    }
    return [...new Set(list.map(s => (s === 'antigravity' ? 'agy' : s)))];
}

/** Pull `--flag value` pairs and bare `--switch`es out of argv. */
function takeOptions(argv, valued = [], switches = []) {
    const opts = {}, rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (valued.includes(a)) {
            if (argv[i + 1] === undefined) throw new UsageError(`${a} needs a value.`);
            opts[a.slice(2)] = argv[++i];
        } else if (switches.includes(a)) {
            opts[a.slice(2)] = true;
        } else rest.push(a);
    }
    return { opts, rest };
}

function versionString() {
    for (const f of ['ais-version.txt', 'VERSION']) {
        try {
            const v = fs.readFileSync(path.join(PORTABLE_ROOT, f), 'utf8').trim();
            if (v) return f === 'VERSION' ? `${v}-dev` : v;
        } catch {}
    }
    return 'unknown';
}

function agmAccountsOrEmpty() {
    if (!agmBinary()) return [];
    try { return listAccounts(); } catch { return []; }
}

function describe(service, account, agyAccounts) {
    if (!account) return color('gray', '-');
    const id = identity(service, account, { agyAccounts });
    if (id.missing) return color('red', service === 'agy' ? `${account} (not in agm)` : `${account} (missing)`);
    if (!id.loggedIn) return color('yellow', 'not logged in');
    return id.email;
}

function prepareRuntimes() {
    setupPath();
    setPrivacyEnv();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function cmdStatus(argv) {
    const { opts } = takeOptions(argv, [], ['--json']);
    const state = loadState();
    const agyAccounts = agmAccountsOrEmpty();

    if (opts.json) {
        const out = { active: state.active, profiles: {} };
        for (const name of state.order) {
            out.profiles[name] = {};
            for (const svc of SERVICES) {
                const account = state.profiles[name][svc];
                const id = identity(svc, account, { agyAccounts });
                out.profiles[name][svc] = account ? {
                    account, email: id.email, loggedIn: id.loggedIn,
                    limitedUntil: limitUntil(state, svc, name) ? new Date(limitUntil(state, svc, name)).toISOString() : null,
                } : null;
            }
        }
        console.log(JSON.stringify(out, null, 2));
        return 0;
    }

    if (!state.order.length) {
        console.log('No ais profiles yet. Start with:  ais setup');
        return 0;
    }

    const rows = state.order.map(name => {
        const cells = SERVICES.map(svc => {
            const account = state.profiles[name][svc];
            const on = state.active[svc] === name && account;
            let text = describe(svc, account, agyAccounts);
            if (svc === 'agy' && account) {
                const a = agyAccounts.find(x => x.email.toLowerCase() === account.toLowerCase());
                if (a && a.quota.claude !== null) text += color('gray', ` (claude ${a.quota.claude}%)`);
            }
            const until = limitUntil(state, svc, name);
            if (until) text += color('yellow', ` [limited until ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}]`);
            return (on ? color('green', '● ') : '  ') + text;
        });
        return { name, cells };
    });

    const visible = s => s.replace(/\x1b\[[0-9;]*m/g, '');
    const widths = [Math.max(7, ...rows.map(r => r.name.length))];
    SERVICES.forEach((svc, i) => {
        widths.push(Math.max(SERVICE_LABEL[svc].length + 2, ...rows.map(r => visible(r.cells[i]).length)));
    });
    const pad = (s, n) => s + ' '.repeat(Math.max(0, n - visible(s).length));

    console.log('');
    console.log('  ' + color('cyan', [pad('PROFILE', widths[0]), ...SERVICES.map((s, i) => pad('  ' + SERVICE_LABEL[s].toUpperCase(), widths[i + 1]))].join('   ')));
    for (const r of rows) {
        const cur = SERVICES.some(s => state.active[s] === r.name);
        console.log('  ' + [pad(cur ? color('green', r.name) : r.name, widths[0]), ...r.cells.map((c, i) => pad(c, widths[i + 1]))].join('   '));
    }
    console.log('');
    console.log(color('gray', '  ● = active    switch: ais use <profile>    rotate: ais next [service]'));
    return 0;
}

function activeAgyEmail(state) {
    const a = state.active.agy;
    return a && state.profiles[a] ? state.profiles[a].agy : null;
}

/**
 * Registry edits (add/set/remove) can change which Antigravity account is
 * active; write it to the credential store so agy agrees. Best effort.
 */
function syncActiveAgy(previousEmail, state) {
    const now = activeAgyEmail(state);
    if (!now || now === previousEmail) return;
    if (!agmAccountsOrEmpty().some(a => a.email.toLowerCase() === now.toLowerCase())) return;
    try { switchAccount(now); console.log(color('gray', `  agy     now signed in as ${now}`)); }
    catch (e) { console.log(color('yellow', `  agy: ${e.message}`)); }
}

/** Apply `changes` (from useProfile) to the outside world, then persist. */
function applyChanges(state, changes) {
    let failed = false;
    for (const ch of changes) {
        const account = state.profiles[ch.to][ch.service];
        if (ch.service === 'agy') {
            try { switchAccount(account); }
            catch (e) {
                console.error(color('red', `  agy: ${e.message}`));
                state.active.agy = ch.from;   // leave the registry matching the credential store
                failed = true;
                continue;
            }
        }
        const arrow = ch.from === ch.to ? `${ch.to} (unchanged)` : `${ch.from || '-'} → ${ch.to}`;
        const id = identity(ch.service, account, { agyAccounts: ch.service === 'agy' ? agmAccountsOrEmpty() : [] });
        const who = id.loggedIn ? color('gray', `  ${id.email}`) : color('yellow', `  not logged in (ais login ${ch.to} ${ch.service})`);
        console.log(`  ${padRight(ch.service, 7)} ${arrow}${who}`);
    }
    saveState(state);
    return failed ? 1 : 0;
}

function cmdUse(argv) {
    const [name, ...svcArgs] = argv;
    if (!name) throw new UsageError('Usage: ais use <profile> [service...]');
    const state = loadState();
    if (!state.profiles[name]) die(`Unknown profile '${name}'. Known: ${state.order.join(', ') || '(none)'}`);
    const services = parseServices(svcArgs);
    const changes = useProfile(state, name, services);
    if (!changes.length) die(`Profile '${name}' has no account for ${services.join(', ')}.`);
    return applyChanges(state, changes);
}

function cmdNext(argv) {
    const state = loadState();
    if (!state.order.length) die('No ais profiles yet. Start with:  ais setup');

    if (!argv.length) {
        const cur = currentProfile(state);
        const order = state.order;
        const target = order[(order.indexOf(cur) + 1) % order.length];
        if (target === cur) die(`Only one profile ('${cur}') - add another with: ais profile add <name>`);
        console.log(`Switching to '${target}':`);
        return applyChanges(state, useProfile(state, target, SERVICES));
    }

    const changes = [];
    for (const svc of parseServices(argv)) {
        const next = pickNext(state, svc, { avoidLimited: false });
        if (!next) { console.log(color('yellow', `  ${padRight(svc, 7)} no other profile has a ${SERVICE_LABEL[svc]} account`)); continue; }
        changes.push(...useProfile(state, next.name, [svc]));
    }
    if (!changes.length) return 1;
    return applyChanges(state, changes);
}

function mappingFromOptions(name, opts) {
    return {
        claude: opts.claude === 'none' ? null : (opts.claude || defaultToolProfileName('claude', name)),
        codex:  opts.codex  === 'none' ? null : (opts.codex  || defaultToolProfileName('codex', name)),
        agy:    opts.agy    && opts.agy !== 'none' ? opts.agy : null,
    };
}

async function cmdProfile(argv) {
    const [sub, ...rest] = argv;
    switch (sub) {
        case 'add': {
            const { opts, rest: pos } = takeOptions(rest, ['--claude', '--codex', '--agy'], ['--no-login', '--login']);
            const name = pos[0];
            if (!name) throw new UsageError('Usage: ais profile add <profile> [--claude <dir>] [--codex <dir>] [--agy <email>] [--no-login]');
            const state = loadState();
            if (!isValidAisName(name)) die(`'${name}' can't be a profile name (letters, digits, - and _; not claude/codex/agy/all).`);
            if (state.profiles[name]) die(`Profile '${name}' already exists.`);
            const mapping = mappingFromOptions(name, opts);
            for (const svc of DIR_SERVICES) {
                if (!mapping[svc]) continue;
                const r = ensureToolProfile(svc, mapping[svc]);
                console.log(color('darkgreen', `  ${padRight(svc, 7)} profiles/${mapping[svc]}${r.created ? ' (new)' : ' (existing)'}`));
            }
            if (mapping.agy) console.log(color('darkgreen', `  agy     ${mapping.agy}`));
            const before = activeAgyEmail(state);
            addProfile(state, name, mapping);
            saveState(state);
            syncActiveAgy(before, state);
            console.log(color('green', `Profile '${name}' added.`));
            const wantLogin = opts.login || (!opts['no-login'] && process.stdin.isTTY
                && await promptYesNo(`Log '${name}' in to its services now?`));
            if (wantLogin) return await loginFlow(name, SERVICES);
            console.log(color('gray', `Log in later with: ais login ${name}`));
            return 0;
        }
        case 'list':
        case 'ls': {
            const state = loadState();
            for (const name of state.order) {
                const p = state.profiles[name];
                console.log(`${name}\tclaude=${p.claude || '-'}\tcodex=${p.codex || '-'}\tagy=${p.agy || '-'}`);
            }
            return 0;
        }
        case 'rename': {
            const [from, to] = rest;
            if (!from || !to) throw new UsageError('Usage: ais profile rename <old> <new>');
            const state = loadState();
            renameProfile(state, from, to);
            // Keep conventional directory names in step with the profile name.
            for (const svc of DIR_SERVICES) {
                const dir = state.profiles[to][svc];
                const wanted = defaultToolProfileName(svc, to);
                if (dir === defaultToolProfileName(svc, from) && !listProfileNames().includes(wanted)) {
                    try { renameToolProfile(dir, wanted); state.profiles[to][svc] = wanted; }
                    catch (e) { console.log(color('yellow', `  kept profiles/${dir} (${e.message})`)); }
                }
            }
            saveState(state);
            console.log(color('green', `Renamed '${from}' to '${to}'.`));
            return 0;
        }
        case 'set': {
            const [name, svc, value] = rest;
            if (!name || !svc || !value) throw new UsageError('Usage: ais profile set <profile> <service> <account|none>');
            const [service] = parseServices([svc]);
            const state = loadState();
            const account = value === 'none' ? null : value;
            if (account && DIR_SERVICES.includes(service)) ensureToolProfile(service, account);
            if (account && service === 'agy' && !agmAccountsOrEmpty().some(a => a.email.toLowerCase() === account.toLowerCase())) {
                console.log(color('yellow', `  note: ${account} is not in the agm store yet - log in with: ais login ${name} agy`));
            }
            const before = activeAgyEmail(state);
            setMapping(state, name, service, account);
            saveState(state);
            console.log(color('green', `${name}: ${service} → ${account || '(none)'}`));
            syncActiveAgy(before, state);
            return 0;
        }
        case 'remove':
        case 'rm': {
            const { opts, rest: pos } = takeOptions(rest, [], ['--purge', '--yes']);
            const name = pos[0];
            if (!name) throw new UsageError('Usage: ais profile remove <profile> [--purge]');
            const state = loadState();
            if (!state.profiles[name]) die(`Unknown profile '${name}'.`);
            const p = state.profiles[name];
            if (opts.purge) {
                const dirs = DIR_SERVICES.map(s => p[s]).filter(d => d && listProfileNames().includes(d))
                    .filter(d => !state.order.some(n => n !== name && Object.values(state.profiles[n]).includes(d)));
                if (dirs.length) {
                    console.log(color('yellow', 'This deletes, including their logins and session history:'));
                    for (const d of dirs) console.log(`  ${path.join(PROFILES_ROOT, d)}`);
                    if (!opts.yes && !await promptYesNo('Delete them?')) return 1;
                    for (const d of dirs) deleteProfile(d);
                }
                if (p.agy) console.log(color('gray', `The Antigravity account stays in agm; drop it with: ais agm remove ${p.agy}`));
            }
            const before = activeAgyEmail(state);
            removeProfile(state, name);
            saveState(state);
            console.log(color('green', `Removed profile '${name}'.`));
            syncActiveAgy(before, state);
            return 0;
        }
        default:
            throw new UsageError('Usage: ais profile add|list|rename|set|remove ...');
    }
}

/** Log `name` in to each service; offers agm import when agy already has a login. */
async function loginFlow(name, services, extraArgs = []) {
    prepareRuntimes();
    let failed = 0;
    for (const svc of services) {
        const state = loadState();
        const p = state.profiles[name];
        if (!p) die(`Unknown profile '${name}'.`);
        if (svc !== 'agy' && !p[svc]) {
            setMapping(state, name, svc, defaultToolProfileName(svc, name));
            saveState(state);
        }
        console.log('');
        console.log(color('cyan', `── ${SERVICE_LABEL[svc]} login for '${name}' ──`));
        try {
            if (svc === 'agy') {
                const hint = credentialStoreHint();
                if (hint) throw new Error(hint);
                ensureStore();
                const email = await loginService('agy', null);
                const s = loadState();
                const owner = s.order.find(n => n !== name && s.profiles[n].agy
                    && s.profiles[n].agy.toLowerCase() === email.toLowerCase());
                if (owner) console.log(color('yellow', `  note: ${email} is also profile '${owner}''s Antigravity account`));
                setMapping(s, name, 'agy', email);
                saveState(s);
                if (s.active.agy === name) switchAccount(email);
                console.log(color('green', `  Antigravity: ${email}`));
            } else {
                const email = await loginService(svc, loadState().profiles[name][svc], extraArgs);
                const s = loadState();
                clearLimit(s, svc, name);
                saveState(s);
                console.log(color('green', `  ${SERVICE_LABEL[svc]}: ${email}`));
            }
        } catch (e) {
            failed++;
            console.error(color('red', `  ${SERVICE_LABEL[svc]} login failed: ${e.message}`));
        }
    }
    return failed ? 1 : 0;
}

async function cmdLogin(argv) {
    const dash = argv.indexOf('--');
    const extra = dash >= 0 ? argv.slice(dash + 1) : [];
    const [name, ...svcArgs] = dash >= 0 ? argv.slice(0, dash) : argv;
    if (!name) throw new UsageError('Usage: ais login <profile> [service...] [-- extra login args]');
    if (!loadState().profiles[name]) die(`Unknown profile '${name}'.`);
    return await loginFlow(name, parseServices(svcArgs), extra);
}

function cmdLaunch(service, argv) {
    const { opts, rest } = takeOptions(argv, ['--as', '--profile']);
    const state = loadState();
    const name = opts.as || opts.profile || state.active[service];
    if (!name) die(`No ${SERVICE_LABEL[service]} account is active - run: ais setup`);
    const p = state.profiles[name];
    if (!p) die(`Unknown profile '${name}'.`);
    if (!p[service]) die(`Profile '${name}' has no ${SERVICE_LABEL[service]} account (add one: ais login ${name} ${service}).`);
    const r = spawnSync(process.execPath, launcherArgs(service, p[service], rest), { stdio: 'inherit' });
    if (r.error) die(r.error.message);
    return r.status ?? 0;
}

async function cmdRun(argv) {
    const [svc, ...rest] = argv;
    if (!svc) throw new UsageError('Usage: ais run <claude|codex|agy> [--as|--profile <profile>] [args...]');
    const [service] = parseServices([svc]);
    // --profile is what the per-tool launchers take; passed through, it lost to the active account.
    const { opts, rest: args } = takeOptions(rest, ['--as', '--profile']);
    return await runWithRotation(service, args, { as: opts.as || opts.profile || null });
}

async function cmdSetup(argv) {
    const { opts } = takeOptions(argv, ['--name'], ['--skip-runtimes', '--no-login', '--yes']);
    // Optional steps: asked on a terminal, assumed with --yes, skipped otherwise
    // (a browser login cannot finish in a pipe nobody is watching).
    const interactive = process.stdin.isTTY && !opts.yes;
    const ask = async q => (opts.yes ? true : process.stdin.isTTY ? await promptYesNo(q) : false);
    console.log(color('cyan', '\nais setup\n'));

    // 1. Runtimes
    if (!opts['skip-runtimes']) {
        console.log(color('cyan', '[1/4] Portable runtimes'));
        fs.mkdirSync(APP_ROOT, { recursive: true });
        await ensureAllRuntimes();
        prepareRuntimes();
        try { await ensureAgy(); }
        catch (e) { console.log(color('yellow', `  Antigravity CLI not installed yet (${e.message}); it will be retried on first launch.`)); }
    }

    // 2. agm
    console.log(color('cyan', '[2/4] Antigravity account store (agm)'));
    if (!agmBinary()) die('agm is missing from this installation - reinstall ais.');
    const hint = credentialStoreHint();
    if (hint) console.log(color('yellow', '  ' + hint));
    if (fs.existsSync(path.join(legacyAgmDataDir(), 'cloud_accounts.db'))
        && !fs.existsSync(path.join(agmDataDir(), 'cloud_accounts.db'))) {
        if (await ask(`  Found an existing agm store at ${legacyAgmDataDir()} - import its accounts?`) && adoptLegacyStore()) {
            console.log(color('darkgreen', '  imported existing agm accounts'));
        }
    }
    ensureStore();
    console.log(color('darkgreen', `  store: ${agmDataDir()}`));

    // 3. Profiles
    console.log(color('cyan', '[3/4] Profiles'));
    let state = loadState();
    if (!state.order.length) {
        const found = discoverToolProfiles();
        if (found.length) {
            console.log('  Existing Claude/Codex profiles:');
            for (const g of found) console.log(`    ${padRight(g.name, 12)} claude=${g.claude || '-'}  codex=${g.codex || '-'}`);
            if (await ask('  Adopt them as ais profiles?')) {
                for (const g of found) {
                    if (!isValidAisName(g.name)) continue;
                    addProfile(state, g.name, { claude: g.claude, codex: g.codex });
                }
                saveState(state);
            }
        }
    }
    if (!state.order.length) {
        let name = opts.name || 'main';
        if (interactive && !opts.name) {
            const answer = (await readLine(color('yellow', '  Name for your first profile [main]: '))).trim();
            if (answer) name = answer;
        }
        if (!isValidAisName(name)) die(`'${name}' can't be a profile name.`);
        for (const svc of DIR_SERVICES) ensureToolProfile(svc, defaultToolProfileName(svc, name));
        addProfile(state, name, mappingFromOptions(name, {}));
        saveState(state);
        console.log(color('green', `  created profile '${name}'`));
    } else {
        console.log(`  profiles: ${state.order.join(', ')}`);
    }

    // 4. Logins
    console.log(color('cyan', '[4/4] Logins'));
    if (opts['no-login']) {
        console.log(color('gray', '  skipped (--no-login); later: ais login <profile>'));
    } else {
        state = loadState();
        const agyAccounts = agmAccountsOrEmpty();
        for (const name of state.order) {
            // A profile's own Claude/Codex directories, plus Antigravity (whose
            // mapping only comes into being with the login itself). An adopted
            // Codex-only profile is not pushed into a Claude login.
            const p = state.profiles[name];
            const wanted = SERVICES.filter(svc => svc === 'agy' || p[svc]);
            const missing = wanted.filter(svc => !identity(svc, p[svc], { agyAccounts }).loggedIn);
            if (!missing.length) { console.log(`  ${name}: logged in`); continue; }
            const labels = missing.map(s => SERVICE_LABEL[s]).join(', ');
            if (!await ask(`  Log '${name}' in to ${labels} now?`)) {
                console.log(color('gray', `  later: ais login ${name}`));
                continue;
            }
            await loginFlow(name, missing);
        }
    }

    // Make the OS credential store agree with the registry from the start.
    state = loadState();
    const cur = currentProfile(state);
    if (cur) {
        console.log(`\nActive profile: ${cur}`);
        applyChanges(state, useProfile(state, cur, SERVICES));
    }

    while (interactive && await promptYesNo('\nAdd another profile?')) {
        const name = (await readLine(color('yellow', 'Profile name: '))).trim();
        if (!name) break;
        try { await cmdProfile(['add', name, '--login']); }
        catch (e) { console.error(color('red', e.message)); }
    }

    console.log(color('green', '\nDone. Next:'));
    console.log('  ais status              see profiles and accounts');
    console.log('  ais use <profile>       switch everything to a profile');
    console.log('  ais claude | codex | agy   start a CLI as the active profile');
    return 0;
}

function cmdDoctor() {
    const results = [];
    const add = (ok, name, msg) => results.push({ ok, name, msg });
    add(true, 'node', `${process.version} (${process.execPath})`);
    add(true, 'root', PORTABLE_ROOT);

    const agm = agmBinary();
    add(agm ? true : false, 'agm', agm || `missing for ${currentPlatformKey()}`);
    let agyAccounts = [];
    if (agm) {
        try { agyAccounts = listAccounts(); add(true, 'agm store', `${agmDataDir()} (${agyAccounts.length} account(s))`); }
        catch (e) { add(false, 'agm store', e.message); }
    }
    const hint = credentialStoreHint();
    add(hint ? false : true, 'keyring', hint || (IS_WIN ? 'Windows Credential Manager' : process.platform === 'darwin' ? 'macOS Keychain' : 'secret-tool'));
    add(fs.existsSync(agyBinPath()) ? true : null, 'agy', fs.existsSync(agyBinPath()) ? agyBinPath() : 'not installed yet (installed on first launch)');

    const state = loadState();
    add(state.order.length ? true : null, 'profiles', state.order.length ? `${state.order.length} in ${stateFile()}` : 'none (run ais setup)');
    for (const name of state.order) {
        for (const svc of SERVICES) {
            const account = state.profiles[name][svc];
            if (!account) continue;
            const id = identity(svc, account, { agyAccounts });
            const ok = id.missing ? false : id.loggedIn ? true : null;
            add(ok, `${name}/${svc}`, id.missing ? `${account} missing` : id.loggedIn ? id.email : `${account}: not logged in`);
        }
    }

    let red = 0, yellow = 0;
    for (const r of results) {
        const tag = r.ok === true ? color('green', '[ ok ]') : r.ok === false ? color('red', '[fail]') : color('yellow', '[warn]');
        if (r.ok === false) red++; else if (r.ok === null) yellow++;
        console.log(`  ${tag}  ${padRight(r.name, 16)} ${r.msg}`);
    }
    console.log(`\n${results.length - red - yellow} ok, ${yellow} warning(s), ${red} failure(s)`);
    return red ? 1 : 0;
}

function cmdShims(argv) {
    const { opts, rest } = takeOptions(argv, ['--dir']);
    const dir = opts.dir ? path.resolve(opts.dir) : defaultShimDir();
    if (rest[0] === 'remove') {
        const removed = removeShims(dir);
        for (const f of removed) console.log(color('darkgreen', `  removed ${f}`));
        if (!removed.length) console.log(`No ais shims in ${dir}.`);
        return 0;
    }
    if (rest[0] !== 'install') throw new UsageError('Usage: ais shims install|remove [--dir <dir>]');
    let skipped = 0;
    for (const r of installShims(dir)) {
        if (r.status === 'skipped') { skipped++; console.log(color('yellow', `  skipped ${r.file}: ${r.reason}`)); }
        else console.log(color('darkgreen', `  ${r.status} ${r.file}`));
    }
    for (const svc of SHIM_SERVICES) {
        const first = whichFirst(svc);
        if (first && path.dirname(path.resolve(first)).toLowerCase() !== dir.toLowerCase()) {
            console.log(color('yellow', `  note: \`${svc}\` currently resolves to ${first} - put ${dir} earlier on PATH to use the shim.`));
        }
    }
    return skipped ? 1 : 0;
}

function cmdUpdate(argv) {
    if (fs.existsSync(path.join(PORTABLE_ROOT, '.git'))) {
        die('This is a git checkout - update it with: git pull');
    }
    const { opts } = takeOptions(argv, ['--version']);
    const env = { ...winPowerShellEnv(), AIS_HOME: PORTABLE_ROOT, AIS_NO_BOOTSTRAP: '1' };
    if (opts.version) env.AIS_VERSION = opts.version;
    const r = IS_WIN
        ? spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PORTABLE_ROOT, 'install.ps1')], { stdio: 'inherit', env })
        : spawnSync('sh', [path.join(PORTABLE_ROOT, 'install.sh')], { stdio: 'inherit', env });
    return r.status ?? 1;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
async function main(argv) {
    const [cmd, ...rest] = argv;
    fs.mkdirSync(PROFILES_ROOT, { recursive: true });
    switch (cmd) {
        case undefined:
            return loadState().order.length ? cmdStatus([]) : (console.log(HELP), 0);
        case 'help': case '-h': case '--help':
            console.log(HELP); return 0;
        case 'version': case '-v': case '--version': {
            console.log(`ais ${versionString()}`);
            if (cmd === 'version') {
                try { console.log(`agm ${fs.readFileSync(path.join(PORTABLE_ROOT, 'bin', 'agm-source.txt'), 'utf8').trim()}`); }
                catch { console.log(`agm ${agmBinary() || '(not found)'}`); }
            }
            return 0;
        }
        case 'status': case 'st':  return cmdStatus(rest);
        case 'use':                return cmdUse(rest);
        case 'next':               return cmdNext(rest);
        case 'profile': case 'profiles': return await cmdProfile(rest.length ? rest : ['list']);
        case 'login':              return await cmdLogin(rest);
        case 'setup':              return await cmdSetup(rest);
        case 'run':                return await cmdRun(rest);
        case 'claude': case 'codex': case 'agy':
            return cmdLaunch(cmd, rest);
        case 'antigravity':        return cmdLaunch('agy', rest);
        case 'agm':                return runAgmInteractive(rest);
        case 'shims':              return cmdShims(rest);
        case 'doctor':             return cmdDoctor();
        case 'update':             return cmdUpdate(rest);
        default:
            throw new UsageError(`Unknown command '${cmd}'. See: ais help`);
    }
}

main(process.argv.slice(2)).then(
    code => process.exit(code ?? 0),
    e => {
        if (e instanceof UsageError) die(e.message, 2);
        die(e && e.message ? e.message : String(e));
    },
);
