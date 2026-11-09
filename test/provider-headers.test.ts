import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaResetAt, RetryableError } from '../src/errors';
import { Providers } from '../src/providers';
import { Store } from '../src/store';
test('successful last-quota response pauses new endpoints across clients while allowing cached data', async () => {
    const store = await Store.open(':memory:'), original = process.env.FOOTBALL_DATA_TOKEN;
    process.env.FOOTBALL_DATA_TOKEN = 'test-only';
    let now = Date.parse('2026-11-07T12:00:00.000Z'), calls = 0;
    const fetcher: typeof fetch = async (_url, init) => {
        assert.equal((init!.headers as Record<string, string>)['X-Auth-Token'], 'test-only');
        calls++;
        return new Response('{"matches":[]}', { headers: { 'X-RequestsAvailable': '0', 'X-RequestCounter-Reset': '23' } });
    };
    try {
        const first = new Providers(store, { fetch: fetcher, now: () => new Date(now) });
        assert.equal((await first.syncFootballData('PL')).cached, false);
        assert.equal((await first.syncFootballData('PL')).cached, true);
        const second = new Providers(store, { fetch: fetcher, now: () => new Date(now) });
        await assert.rejects(async () => await second.syncFootballData('PD'), error => error instanceof RetryableError && error.retryAt === '2026-11-07T12:00:23.000Z');
        assert.equal(calls, 1);
        now += 24000;
        await second.syncFootballData('PD');
        assert.equal(calls, 2);
    }
    finally {
        if (original === undefined)
            delete process.env.FOOTBALL_DATA_TOKEN;
        else
            process.env.FOOTBALL_DATA_TOKEN = original;
        await store.close();
    }
});
test('both documented counter names and malformed header fallbacks are handled conservatively', () => {
    const now = Date.parse('2026-11-07T12:00:00.000Z');
    assert.equal(quotaResetAt(new Headers({ 'X-Requests-Available-Minute': '0', 'X-RequestCounter-Reset': '23' }), now), '2026-11-07T12:00:23.000Z');
    assert.equal(quotaResetAt(new Headers({ 'X-RequestsAvailable': '1' }), now), undefined);
    assert.equal(quotaResetAt(new Headers({ 'X-RequestsAvailable': 'garbage' }), now), undefined);
    assert.equal(quotaResetAt(new Headers({ 'X-RequestsAvailable': '0', 'X-RequestCounter-Reset': 'garbage' }), now), '2026-11-07T12:01:00.000Z');
    assert.equal(quotaResetAt(new Headers({ 'X-RequestsAvailable': '0', 'X-RequestCounter-Reset': '0' }), now), '2026-11-07T12:00:01.000Z');
});
test('HTTP retry deadline never precedes either the server reset or Retry-After', async () => {
    const store = await Store.open(':memory:'), original = process.env.FOOTBALL_DATA_TOKEN;
    process.env.FOOTBALL_DATA_TOKEN = 'test-only';
    try {
        const providers = new Providers(store, { now: () => new Date('2026-11-07T12:00:00.000Z'), fetch: async () => new Response(null, { status: 429, headers: { 'X-RequestsAvailable': '0', 'X-RequestCounter-Reset': '90', 'Retry-After': '20' } }) });
        await assert.rejects(async () => await providers.syncFootballData('PL'), error => error instanceof RetryableError && error.retryAt === '2026-11-07T12:01:30.000Z');
    }
    finally {
        if (original === undefined)
            delete process.env.FOOTBALL_DATA_TOKEN;
        else
            process.env.FOOTBALL_DATA_TOKEN = original;
        await store.close();
    }
});
