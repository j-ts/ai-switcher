// Usage-limit detection for `ais run`: pure functions that look at one line
// of a tool's own session log and say whether the account just ran out.
//
// Signals, as the tools actually write them:
//   claude  session .jsonl entry with isApiErrorMessage + error "rate_limit",
//           text "You've hit your session limit · resets 12:50pm (Europe/London)"
//   codex   rollout .jsonl token_count event whose rate_limits carry a
//           non-null rate_limit_reached_type, or an error event saying so.
//           (used_percent: 100 alone is NOT a signal - sessions routinely
//           keep working at 100%.)
//   agy     cli log line "RESOURCE_EXHAUSTED (code 429): Individual quota
//           reached. ... Resets in 4h46m9s."
//
// Every detector returns null or { message, resetAt, sessionId? } where
// resetAt is a ms timestamp or null when the text names no reset time.

const LIMIT_TEXT = /usage limit|rate limit|hit your .*limit|limit reached|quota (reached|exceeded)|RESOURCE_EXHAUSTED/i;

function parseJson(line) {
    if (typeof line !== 'string' || line[0] !== '{') return null;
    try { return JSON.parse(line); } catch { return null; }
}

function contentText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(c => (c && typeof c.text === 'string' ? c.text : '')).join(' ').trim();
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------
export function detectClaudeLimit(line, now = Date.now()) {
    const j = parseJson(line);
    if (!j || j.error !== 'rate_limit') return null;
    if (j.isApiErrorMessage === false) return null;
    const message = contentText(j.message && j.message.content) || 'usage limit reached';
    return {
        message,
        resetAt: parseClaudeReset(message, now),
        sessionId: typeof j.sessionId === 'string' ? j.sessionId : null,
    };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * "resets 12:50pm (Europe/London)", "resets 6pm", "resets Oct 3, 9am (UTC)".
 * Returns the next instant at or after `now` showing that wall-clock time in
 * the named zone (local zone when none is given), or null.
 */
export function parseClaudeReset(message, now = Date.now()) {
    const m = /resets\s+(?:(?:on\s+)?([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(String(message));
    if (!m) return null;
    let hour = Number(m[3]);
    const minute = m[4] ? Number(m[4]) : 0;
    const ampm = m[5] && m[5].toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
    const tz = validTimeZone(m[6]);

    if (m[1] && m[2]) {
        const month = MONTHS.indexOf(m[1].toLowerCase());
        if (month < 0) return null;
        const today = zonedParts(now, tz);
        let t = zonedToUtc(today.year, month + 1, Number(m[2]), hour, minute, tz);
        if (t < now - 36 * 3600e3) t = zonedToUtc(today.year + 1, month + 1, Number(m[2]), hour, minute, tz);
        return t;
    }
    const today = zonedParts(now, tz);
    let t = zonedToUtc(today.year, today.month, today.day, hour, minute, tz);
    if (t <= now) {
        const tomorrow = zonedParts(now + 24 * 3600e3, tz);
        t = zonedToUtc(tomorrow.year, tomorrow.month, tomorrow.day, hour, minute, tz);
    }
    return t;
}

function validTimeZone(tz) {
    if (!tz) return undefined;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; }
    catch { return undefined; }
}

function zonedParts(t, tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(new Date(t));
    const get = type => Number(parts.find(p => p.type === type).value);
    return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

/** UTC ms for a wall-clock time in `tz` (two passes settle DST edges). */
function zonedToUtc(year, month, day, hour, minute, tz) {
    const wall = Date.UTC(year, month - 1, day, hour, minute);
    let t = wall;
    for (let i = 0; i < 2; i++) {
        const p = zonedParts(t, tz);
        const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
        t += wall - shown;
    }
    return t;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------
export function detectCodexLimit(line, now = Date.now()) {
    const j = parseJson(line);
    if (!j) return null;
    const p = j.payload && typeof j.payload === 'object' ? j.payload : j;

    if (p.type === 'token_count' && p.rate_limits && p.rate_limits.rate_limit_reached_type) {
        return {
            message: `usage limit reached (${p.rate_limits.rate_limit_reached_type})`,
            resetAt: codexResetAt(p.rate_limits, now),
        };
    }
    if (p.type === 'error' || p.type === 'stream_error' || j.type === 'error') {
        const message = String(p.message || p.error || '');
        if (LIMIT_TEXT.test(message)) {
            return { message, resetAt: parseRelativeReset(message, now) };
        }
    }
    return null;
}

/** Latest reset among the windows that are full (else among all windows). */
export function codexResetAt(rateLimits, now = Date.now()) {
    const windows = [rateLimits.primary, rateLimits.secondary].filter(w => w && typeof w === 'object');
    const full = windows.filter(w => Number(w.used_percent) >= 100);
    let best = null;
    for (const w of (full.length ? full : windows)) {
        let t = null;
        if (Number.isFinite(w.resets_at))             t = w.resets_at * 1000;
        else if (Number.isFinite(w.resets_in_seconds)) t = now + w.resets_in_seconds * 1000;
        if (t && t > now && (best === null || t > best)) best = t;
    }
    return best;
}

// ---------------------------------------------------------------------------
// Antigravity (agy)
// ---------------------------------------------------------------------------
export function detectAgyLimit(line, now = Date.now()) {
    const s = String(line || '');
    if (!/RESOURCE_EXHAUSTED|quota reached|quota exceeded/i.test(s)) return null;
    if (!/quota|429|exhausted/i.test(s)) return null;
    const m = /\(([^()]*(?:RESOURCE_EXHAUSTED|quota)[^()]*(?:\([^()]*\)[^()]*)*)\)/i.exec(s);
    return { message: (m ? m[1] : s).trim().slice(0, 300), resetAt: parseRelativeReset(s, now) };
}

/** "Resets in 4h46m9s", "try again in 2 hours 5 minutes", "in 37m". */
export function parseRelativeReset(text, now = Date.now()) {
    // Longest unit spellings first so "2 hours 5 minutes" is not cut at "2 h".
    const UNIT = 'days?|d|hours?|hrs?|h|min(?:ute)?s?|m|sec(?:ond)?s?|s';
    const m = new RegExp(`(?:resets?|again|retry)\\s+in\\s+((?:\\d+\\s*(?:${UNIT})\\s*,?\\s*(?:and\\s+)?)+)`, 'i').exec(String(text));
    if (!m) return null;
    let ms = 0;
    const re = new RegExp(`(\\d+)\\s*(${UNIT})`, 'gi');
    let part;
    while ((part = re.exec(m[1]))) {
        const n = Number(part[1]);
        const u = part[2].toLowerCase();
        if (u.startsWith('d'))      ms += n * 86400e3;
        else if (u.startsWith('h')) ms += n * 3600e3;
        else if (u.startsWith('m')) ms += n * 60e3;
        else                        ms += n * 1e3;
    }
    return ms > 0 ? now + ms : null;
}

export const DETECTORS = { claude: detectClaudeLimit, codex: detectCodexLimit, agy: detectAgyLimit };
