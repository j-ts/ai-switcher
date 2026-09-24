import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    detectClaudeLimit, detectCodexLimit, detectAgyLimit,
    parseClaudeReset, parseRelativeReset, codexResetAt,
} from '../launcher/ais-limits.mjs';

const NOW = Date.parse('2026-09-24T10:00:00Z');   // 11:00 in London (BST)

function claudeLine(text, extra = {}) {
    return JSON.stringify({
        type: 'assistant', isApiErrorMessage: true, error: 'rate_limit',
        sessionId: '0b7e8f2c-1111-2222-3333-444455556666',
        message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra,
    });
}

// --- claude -----------------------------------------------------------------
test('claude: session limit entry is detected with its reset time', () => {
    const hit = detectClaudeLimit(claudeLine("You've hit your session limit · resets 12:50pm (Europe/London)"), NOW);
    assert.equal(hit.sessionId, '0b7e8f2c-1111-2222-3333-444455556666');
    assert.match(hit.message, /session limit/);
    assert.equal(new Date(hit.resetAt).toISOString(), '2026-09-24T11:50:00.000Z');
});

test('claude: spend limit without a reset time still counts', () => {
    const hit = detectClaudeLimit(claudeLine("You've hit your monthly spend limit · raise it at claude.ai/settings/usage"), NOW);
    assert.ok(hit);
    assert.equal(hit.resetAt, null);
});

test('claude: other API errors and normal lines are ignored', () => {
    assert.equal(detectClaudeLimit(claudeLine('API Error: 529 Overloaded', { error: 'server_error' }), NOW), null);
    assert.equal(detectClaudeLimit(claudeLine('Prompt is too long', { error: 'invalid_request' }), NOW), null);
    assert.equal(detectClaudeLimit(JSON.stringify({ type: 'user', message: { content: 'rate_limit please' } }), NOW), null);
    assert.equal(detectClaudeLimit('not json at all', NOW), null);
    assert.equal(detectClaudeLimit('{"broken', NOW), null);
});

test('claude reset: a time already past today rolls to tomorrow', () => {
    const t = parseClaudeReset('resets 7:50am (Europe/London)', NOW);
    assert.equal(new Date(t).toISOString(), '2026-09-25T06:50:00.000Z');
});

test('claude reset: hour-only, 12am/12pm, and explicit dates', () => {
    assert.equal(new Date(parseClaudeReset('resets 6pm (UTC)', NOW)).toISOString(), '2026-09-24T18:00:00.000Z');
    assert.equal(new Date(parseClaudeReset('resets 12pm (UTC)', NOW)).toISOString(), '2026-09-24T12:00:00.000Z');
    assert.equal(new Date(parseClaudeReset('resets 12am (UTC)', NOW)).toISOString(), '2026-09-25T00:00:00.000Z');
    assert.equal(new Date(parseClaudeReset('weekly limit · resets Oct 3, 9am (America/New_York)', NOW)).toISOString(),
                 '2026-10-03T13:00:00.000Z');
});

test('claude reset: unknown zone falls back to local time, garbage gives null', () => {
    assert.ok(Number.isFinite(parseClaudeReset('resets 6pm (Mars/Olympus)', NOW)));
    assert.equal(parseClaudeReset('no reset mentioned', NOW), null);
    assert.equal(parseClaudeReset('resets 27:99', NOW), null);
});

// --- codex ------------------------------------------------------------------
function tokenCount(rateLimits) {
    return JSON.stringify({ timestamp: 'x', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: rateLimits } });
}

test('codex: rate_limit_reached_type marks the account as spent', () => {
    const reset = Math.floor(NOW / 1000) + 3600;
    const hit = detectCodexLimit(tokenCount({
        limit_id: 'codex', rate_limit_reached_type: 'primary',
        primary: { used_percent: 100, window_minutes: 300, resets_at: reset },
        secondary: { used_percent: 40, window_minutes: 10080, resets_at: reset + 86400 },
    }), NOW);
    assert.match(hit.message, /primary/);
    assert.equal(hit.resetAt, reset * 1000);
});

test('codex: used_percent 100 alone is not a limit (sessions keep working)', () => {
    assert.equal(detectCodexLimit(tokenCount({
        limit_id: 'codex', rate_limit_reached_type: null,
        primary: { used_percent: 100, window_minutes: 10080, resets_at: 1 },
    }), NOW), null);
});

test('codex: error events that talk about usage limits', () => {
    const line = JSON.stringify({ type: 'event_msg', payload: { type: 'error', message: "You've hit your usage limit. Try again in 3 hours 20 minutes." } });
    const hit = detectCodexLimit(line, NOW);
    assert.ok(hit);
    assert.equal(hit.resetAt, NOW + (3 * 60 + 20) * 60e3);
    const other = JSON.stringify({ type: 'event_msg', payload: { type: 'error', message: 'stream disconnected' } });
    assert.equal(detectCodexLimit(other, NOW), null);
});

test('codexResetAt: latest full window, else latest window, ignoring the past', () => {
    const s = Math.floor(NOW / 1000);
    assert.equal(codexResetAt({ primary: { used_percent: 100, resets_at: s + 60 }, secondary: { used_percent: 100, resets_at: s + 600 } }, NOW), (s + 600) * 1000);
    assert.equal(codexResetAt({ primary: { used_percent: 50, resets_in_seconds: 90 } }, NOW), NOW + 90e3);
    assert.equal(codexResetAt({ primary: { used_percent: 100, resets_at: s - 60 } }, NOW), null);
    assert.equal(codexResetAt({}, NOW), null);
});

// --- agy --------------------------------------------------------------------
const AGY = 'I0918 15:02:01.123456 244 run.go:395] Run: attempt 1 failed (RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h46m9s.), retrying in 2m51.19615s';

test('agy: quota exhaustion from the cli log, with the reset countdown', () => {
    const hit = detectAgyLimit(AGY, NOW);
    assert.match(hit.message, /^RESOURCE_EXHAUSTED \(code 429\): Individual quota reached/);
    assert.equal(hit.resetAt, NOW + (4 * 3600 + 46 * 60 + 9) * 1000);
});

test('agy: unrelated log lines are ignored', () => {
    assert.equal(detectAgyLimit('I0924 03:11:57.479783 243 quota_manager.go:45] doRefreshQuota: starting reload (force=true)', NOW), null);
    assert.equal(detectAgyLimit('server_oauth.go:196] applyAuthResult: email=x@y.z, authMethod=consumer, quotaProject=', NOW), null);
    assert.equal(detectAgyLimit('', NOW), null);
});

test('parseRelativeReset: compact and spelled-out durations', () => {
    assert.equal(parseRelativeReset('Resets in 37m', NOW), NOW + 37 * 60e3);
    assert.equal(parseRelativeReset('try again in 1 day, 2 hours and 3 minutes', NOW), NOW + (26 * 60 + 3) * 60e3);
    assert.equal(parseRelativeReset('retrying in 2m51s', NOW), null);   // agy's own retry is not a reset
    assert.equal(parseRelativeReset('no time here', NOW), null);
});
