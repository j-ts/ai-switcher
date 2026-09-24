// ClaudeCodePortable -- Google Antigravity CLI (agy) launcher entry point.
//
// agy keeps its Google login in the OS credential store (Windows Credential
// Manager, macOS Keychain, libsecret on Linux) under one fixed slot, so a
// login cannot be isolated by redirecting HOME. Accounts are therefore
// managed by agm (see agm.mjs): before every launch the chosen account is
// written into that slot with `agm switch --target agy`, on every OS.
//
// Which account:
//   --account <email>   that agm account
//   --profile <name>    the Antigravity account of that ais profile
//   (neither)           the ais profile active for agy; without ais profiles,
//                       agm's accounts (picker when there is more than one)
//
// agy itself is installed portably into app/agy (agy.mjs) and runs with the
// real HOME, so its ~/.gemini state is the user's own.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { PROFILES_ROOT, APP_ROOT } from './paths.mjs';
import { color, getVersionLine, readKey } from './ui.mjs';
import { parseArgs } from './args.mjs';
import { ensureAllRuntimes } from './install.mjs';
import { exportSkills } from './skills-export.mjs';
import { setupPath, setPrivacyEnv } from './tool-launcher-core.mjs';
import { ensureAgy } from './agy.mjs';
import { listAccounts, switchAccount, loginAccount, ensureStore, credentialStoreHint } from './agm.mjs';
import { loadState } from './ais-state.mjs';

(async () => {
    const argv = process.argv.slice(2);
    let account = null;
    const i = argv.indexOf('--account');
    if (i >= 0) { account = argv[i + 1] || null; argv.splice(i, 2); }
    const args = parseArgs(argv);

    fs.mkdirSync(APP_ROOT,      { recursive: true });
    fs.mkdirSync(PROFILES_ROOT, { recursive: true });

    try { await ensureAllRuntimes(); }
    catch (e) { console.error(color('red', 'Runtime install failed: ' + e.message)); process.exit(1); }

    setupPath();
    setPrivacyEnv();

    const hint = credentialStoreHint();
    if (hint) { console.error(color('red', hint)); process.exit(1); }

    ensureStore();
    const email = account || await resolveAccount(args);
    if (!email) process.exit(0);   // picker aborted

    try { switchAccount(email); }
    catch (e) { console.error(color('red', e.message)); process.exit(1); }

    let agyBin;
    try { agyBin = await ensureAgy(); }
    catch (e) {
        console.error(color('red', 'Antigravity CLI install failed: ' + e.message));
        process.exit(1);
    }

    if (args.seedSkills) {
        const r = exportSkills('antigravity', null);
        for (const m of r.merged)  console.log(color('darkgreen', '  + ' + m));
        for (const s of r.skipped) console.log(color('gray',      '  = skipped: ' + s));
    }

    console.log('');
    console.log(color('cyan', 'Portable runtimes attached:'));
    console.log('  ' + getVersionLine().replace(/^\s*runtimes:\s*/, ''));
    console.log('');
    console.log(color('green', 'Starting Antigravity CLI (portable)...'));
    console.log('Account:  ' + email);
    console.log('Binary:   ' + agyBin);
    console.log('');

    const r = spawnSync(agyBin, args.forwarded, { stdio: 'inherit' });
    if (r.error) {
        console.error(color('red', 'Failed to start agy: ' + r.error.message));
        process.exit(1);
    }
    process.exit(r.status ?? 0);
})().catch(e => {
    console.error(color('red', 'FATAL: ' + (e && e.stack || e)));
    process.exit(1);
});

async function resolveAccount(args) {
    const state = loadState();

    if (args.profile) {
        const p = state.profiles[args.profile];
        if (p && p.agy) return p.agy;
        if (!(args.profile === 'active' && !p)) {
            console.error(color('red', p
                ? `Profile '${args.profile}' has no Antigravity account (add one: ais login ${args.profile} agy).`
                : `Unknown ais profile '${args.profile}'.`));
            process.exit(1);
        }
    }

    const active = state.active.agy;
    if (active && state.profiles[active].agy) return state.profiles[active].agy;

    const accounts = listAccounts();
    if (accounts.length === 1) return accounts[0].email;
    if (accounts.length === 0) {
        if (args.skipMenu) {
            console.error(color('red', 'No Antigravity account yet - run: ais setup'));
            process.exit(1);
        }
        console.log(color('yellow', 'No Antigravity account yet - starting Google login ...'));
        return await loginAccount();
    }
    if (args.skipMenu) return (accounts.find(a => a.activeCli) || accounts[0]).email;
    return await pickAccount(accounts);
}

async function pickAccount(accounts) {
    console.log('');
    console.log(color('magenta', 'Select Antigravity account'));
    accounts.forEach((a, n) => {
        const mark = a.activeCli ? color('green', ' (current)') : '';
        console.log(`  [${n + 1}] ${a.email}${mark}`);
    });
    console.log(color('gray', '  [Esc] abort'));
    while (true) {
        const k = await readKey();
        if (k.isEscape || (k.sequence || '').toLowerCase() === 'q') return null;
        if (k.isEnter) return (accounts.find(a => a.activeCli) || accounts[0]).email;
        const n = Number(k.sequence);
        if (n >= 1 && n <= accounts.length) return accounts[n - 1].email;
    }
}
