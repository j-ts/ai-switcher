// ais profile registry.
//
// An ais profile bundles one account per service under a single name:
//   claude -> a Claude profile directory      (profiles/claude-<name>)
//   codex  -> a Codex profile directory       (profiles/codex-<name>)
//   agy    -> an Antigravity account in agm   (Google account email)
//
// The registry records those mappings, the rotation order, which ais profile
// is active per service, and when a service last hit its usage limit on a
// profile. Everything below the load/save pair is a pure function over a
// plain object so it can be tested without touching disk.

import fs   from 'node:fs';
import path from 'node:path';
import { PROFILES_ROOT } from './paths.mjs';
import { isValidProfileName } from './profiles.mjs';

export const SERVICES = ['claude', 'codex', 'agy'];

// Words that would make `ais next <x>` / `ais use <x> <y>` ambiguous.
const RESERVED = new Set([...SERVICES, 'all', 'antigravity']);

// Services whose account lives in a per-profile directory of its own.
export const DIR_SERVICES = ['claude', 'codex'];

/** Dot-prefixed so listProfileNames() never mistakes it for a tool profile. */
export function aisDataDir() {
    return process.env.AIS_STATE_DIR || path.join(PROFILES_ROOT, '.ais');
}

export function stateFile() {
    return path.join(aisDataDir(), 'state.json');
}

export function emptyState() {
    return {
        version: 1,
        order: [],
        profiles: {},
        active: { claude: null, codex: null, agy: null },
        limits: {},
    };
}

function str(v) { return typeof v === 'string' && v.length ? v : null; }

/**
 * Coerce whatever is on disk into a well-formed state: unknown fields are
 * dropped, missing ones filled, order made consistent with profiles, and
 * dangling active/limit entries cleared.
 */
export function normalizeState(raw) {
    const s = emptyState();
    if (!raw || typeof raw !== 'object') return s;

    const profiles = raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : {};
    for (const [name, p] of Object.entries(profiles)) {
        if (!isValidAisName(name) || !p || typeof p !== 'object') continue;
        s.profiles[name] = { claude: str(p.claude), codex: str(p.codex), agy: str(p.agy) };
    }

    const order = Array.isArray(raw.order) ? raw.order : [];
    for (const name of order) {
        if (s.profiles[name] && !s.order.includes(name)) s.order.push(name);
    }
    for (const name of Object.keys(s.profiles)) {
        if (!s.order.includes(name)) s.order.push(name);
    }

    const active = raw.active && typeof raw.active === 'object' ? raw.active : {};
    for (const svc of SERVICES) {
        const a = str(active[svc]);
        s.active[svc] = a && s.profiles[a] && s.profiles[a][svc] ? a : null;
    }

    const limits = raw.limits && typeof raw.limits === 'object' ? raw.limits : {};
    for (const svc of SERVICES) {
        const perSvc = limits[svc];
        if (!perSvc || typeof perSvc !== 'object') continue;
        for (const [name, until] of Object.entries(perSvc)) {
            if (!s.profiles[name] || !Number.isFinite(Date.parse(until))) continue;
            (s.limits[svc] ||= {})[name] = new Date(Date.parse(until)).toISOString();
        }
    }
    return s;
}

/**
 * Read the registry. A missing file is an empty registry; a corrupt one is
 * moved aside (never silently overwritten) and an empty registry returned.
 */
export function loadState(file = stateFile()) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch { return emptyState(); }
    try { return normalizeState(JSON.parse(text)); }
    catch {
        try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
        return emptyState();
    }
}

/** Atomic write: a crash mid-save leaves the previous registry intact. */
export function saveState(state, file = stateFile()) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(normalizeState(state), null, 2) + '\n');
    fs.renameSync(tmp, file);
}

export function isValidAisName(name) {
    return isValidProfileName(name)
        && !/\s/.test(name)
        && !RESERVED.has(String(name).toLowerCase());
}

/** Directory name of the tool profile an ais profile uses by default. */
export function defaultToolProfileName(service, name) {
    return `${service}-${name}`;
}

function requireProfile(state, name) {
    if (!state.profiles[name]) throw new Error(`Unknown profile '${name}'.`);
    return state.profiles[name];
}

function requireService(service) {
    if (!SERVICES.includes(service)) {
        throw new Error(`Unknown service '${service}' (want ${SERVICES.join(', ')}).`);
    }
}

export function addProfile(state, name, mapping = {}) {
    if (!isValidAisName(name)) throw new Error(`Invalid profile name '${name}'.`);
    if (state.profiles[name])  throw new Error(`Profile '${name}' already exists.`);
    state.profiles[name] = {
        claude: str(mapping.claude), codex: str(mapping.codex), agy: str(mapping.agy),
    };
    state.order.push(name);
    for (const svc of SERVICES) {
        if (!state.active[svc] && state.profiles[name][svc]) state.active[svc] = name;
    }
    return state;
}

export function removeProfile(state, name) {
    requireProfile(state, name);
    delete state.profiles[name];
    state.order = state.order.filter(n => n !== name);
    for (const svc of SERVICES) {
        if (state.active[svc] === name) {
            state.active[svc] = state.order.find(n => state.profiles[n][svc]) || null;
        }
        if (state.limits[svc]) delete state.limits[svc][name];
    }
    return state;
}

export function renameProfile(state, from, to) {
    requireProfile(state, from);
    if (!isValidAisName(to)) throw new Error(`Invalid profile name '${to}'.`);
    if (state.profiles[to])  throw new Error(`Profile '${to}' already exists.`);
    state.profiles[to] = state.profiles[from];
    delete state.profiles[from];
    state.order = state.order.map(n => (n === from ? to : n));
    for (const svc of SERVICES) {
        if (state.active[svc] === from) state.active[svc] = to;
        if (state.limits[svc] && state.limits[svc][from]) {
            state.limits[svc][to] = state.limits[svc][from];
            delete state.limits[svc][from];
        }
    }
    return state;
}

/** Point one service of a profile at an account (null unlinks it). */
export function setMapping(state, name, service, value) {
    requireService(service);
    const p = requireProfile(state, name);
    p[service] = str(value);
    if (!p[service] && state.active[service] === name) {
        state.active[service] = state.order.find(n => state.profiles[n][service]) || null;
    } else if (p[service] && !state.active[service]) {
        state.active[service] = name;
    }
    if (state.limits[service]) delete state.limits[service][name];
    return state;
}

/**
 * Activate a profile for the given services. Services the profile has no
 * account for are left alone. Returns [{ service, from, to }] for every
 * service the profile covers (from === to when it already was active).
 */
export function useProfile(state, name, services = SERVICES) {
    const p = requireProfile(state, name);
    const changes = [];
    for (const svc of services) {
        requireService(svc);
        if (!p[svc]) continue;
        changes.push({ service: svc, from: state.active[svc], to: name });
        state.active[svc] = name;
    }
    return changes;
}

/**
 * The profile `ais next` (all services) advances from: the one active for
 * the most services, ties broken in SERVICES order; else the first profile.
 */
export function currentProfile(state) {
    const votes = new Map();
    for (const svc of SERVICES) {
        const a = state.active[svc];
        if (a) votes.set(a, (votes.get(a) || 0) + 1);
    }
    let best = null, bestVotes = 0;
    for (const svc of SERVICES) {
        const a = state.active[svc];
        if (a && votes.get(a) > bestVotes) { best = a; bestVotes = votes.get(a); }
    }
    return best || state.order[0] || null;
}

/** Profiles after `from` in rotation order, wrapping around, `from` last. */
export function rotationFrom(state, from) {
    const order = state.order;
    const i = order.indexOf(from);
    if (i < 0) return [...order];
    return [...order.slice(i + 1), ...order.slice(0, i), from];
}

export function limitUntil(state, service, name, now = Date.now()) {
    const iso = state.limits[service] && state.limits[service][name];
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) && t > now ? t : null;
}

export function markLimited(state, service, name, untilMs) {
    requireService(service);
    requireProfile(state, name);
    (state.limits[service] ||= {})[name] = new Date(untilMs).toISOString();
    return state;
}

export function clearLimit(state, service, name) {
    if (state.limits[service]) delete state.limits[service][name];
    return state;
}

/**
 * Choose the profile a service should move to next.
 *   isUsable(name)  extra filter (e.g. "is logged in"); default accepts all
 *   avoidLimited    skip profiles still inside a recorded usage-limit window
 * Returns { name, limitedUntil } or null when no other profile has the
 * service. When every candidate is limited, the one whose limit ends first
 * is returned with its limitedUntil set, so callers can say when to retry.
 */
export function pickNext(state, service, { now = Date.now(), isUsable = () => true, avoidLimited = true } = {}) {
    requireService(service);
    const from = state.active[service];
    const candidates = rotationFrom(state, from)
        .filter(n => n !== from && state.profiles[n][service] && isUsable(n));
    if (!candidates.length) return null;
    if (!avoidLimited) return { name: candidates[0], limitedUntil: limitUntil(state, service, candidates[0], now) };

    const free = candidates.find(n => !limitUntil(state, service, n, now));
    if (free) return { name: free, limitedUntil: null };

    let soonest = candidates[0];
    for (const n of candidates) {
        if (limitUntil(state, service, n, now) < limitUntil(state, service, soonest, now)) soonest = n;
    }
    return { name: soonest, limitedUntil: limitUntil(state, service, soonest, now) };
}
