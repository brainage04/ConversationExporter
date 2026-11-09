/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 brainage04
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
    buildConversationExport,
    ExportCancellation,
    ExportCancelledError,
    type ExportControls,
    fetchConversationRange,
    type FetchMessagePage,
    orderSelectedMessageIds,
    type PageResponse,
    serializeConversationExport
} from "./exportRange";

const BASE_ID = BigInt("100000000000000000");
const messageId = (offset: number) => (BASE_ID + BigInt(offset)).toString();
const channelId = "200000000000000000";

function rawMessages(count: number) {
    return Array.from({ length: count }, (_, offset) => ({
        id: messageId(offset),
        channel_id: channelId,
        content: `message ${offset}`,
        attachments: [{ id: `attachment-${offset}` }]
    }));
}

const range = (start: number, end: number) => ({ channelId, startMessageId: messageId(start), endMessageId: messageId(end) });

/** Serves `count` messages like Discord's history endpoint and records when each request was made. */
function history(count: number, respond?: (page: unknown[], call: number) => PageResponse | Promise<PageResponse>) {
    const source = rawMessages(count);
    const times: number[] = [];
    const fetchPage: FetchMessagePage = async (_channelId, before, limit) => {
        times.push(Date.now());
        const end = Math.min(source.length, Number(BigInt(before) - BASE_ID));
        const page = source.slice(Math.max(0, end - limit), end).reverse();
        return respond ? respond(page, times.length) : { body: page };
    };
    return { fetchPage, times };
}

function controls(overrides: Partial<ExportControls> = {}): ExportControls {
    return { cancellation: new ExportCancellation(), confirmLargeExport: async () => true, ...overrides };
}

/** Runs microtasks and pending I/O callbacks without moving the fake clock. */
const flush = () => new Promise(resolve => setImmediate(resolve));

function useFakeTimers(t: TestContext) {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    return {
        /** Moves the fake clock forward in small steps, letting promise chains schedule their next timer. */
        async advance(ms: number, step = 50) {
            await flush();
            for (let passed = 0; passed < ms; passed += step) {
                t.mock.timers.tick(Math.min(step, ms - passed));
                await flush();
            }
        },
        /** Advances the clock until `promise` settles, and returns its outcome. */
        async settle<T>(promise: Promise<T>, limitMs = 600_000) {
            let outcome: { value?: T; error?: unknown; } | undefined;
            promise.then(value => { outcome = { value }; }, error => { outcome = { error }; });
            await flush();
            for (let passed = 0; !outcome && passed < limitMs; passed += 50) {
                t.mock.timers.tick(50);
                await flush();
            }
            assert.ok(outcome, "the export did not finish");
            return outcome;
        }
    };
}

test("paginates backward and returns the inclusive range in chronological order", async t => {
    const { settle } = useFakeTimers(t);
    const { fetchPage } = history(205);
    const { value: messages } = await settle(fetchConversationRange(range(10, 190), fetchPage, controls()));

    assert.equal(messages!.length, 181);
    assert.equal(messages![0].id, messageId(10));
    assert.equal(messages!.at(-1)?.id, messageId(190));
    assert.deepEqual(messages![0].attachments, [{ id: "attachment-10" }]);
});

test("accepts boundaries selected in reverse chronological order", () => {
    assert.deepEqual(orderSelectedMessageIds(messageId(9), messageId(2)), {
        firstMessageId: messageId(2),
        lastMessageId: messageId(9)
    });
});

test("rejects partial history instead of silently writing a partial export", async t => {
    const { settle } = useFakeTimers(t);
    const { error } = await settle(fetchConversationRange(range(1, 150), async () => ({ body: rawMessages(20).slice(10).reverse() }), controls()));
    assert.match((error as Error).message, /no partial export was written/);
});

test("requests history at most once per second", async t => {
    const { settle } = useFakeTimers(t);
    const { fetchPage, times } = history(500);
    const { value } = await settle(fetchConversationRange(range(50, 499), fetchPage, controls()));

    assert.equal(value!.length, 450);
    assert.deepEqual(times, [0, 1000, 2000, 3000, 4000]);
});

test("waits as long as a 429 asks before trying the page again", async t => {
    const { settle } = useFakeTimers(t);
    const { fetchPage, times } = history(150, (page, call) =>
        call === 1 ? Promise.reject({ status: 429, body: { retry_after: 3.5 } }) : { body: page }
    );
    const { value } = await settle(fetchConversationRange(range(0, 149), fetchPage, controls()));

    assert.equal(value!.length, 150);
    assert.deepEqual(times, [0, 3500, 4500]);
});

test("gives up after 3 retries of a rate-limited page", async t => {
    const { settle } = useFakeTimers(t);
    const { fetchPage, times } = history(150, () => Promise.reject({ status: 429, body: { retry_after: 0.5 } }));
    const { error } = await settle(fetchConversationRange(range(0, 149), fetchPage, controls()));

    assert.match((error as Error).message, /kept rate limiting/);
    // Never shorter than Discord asks, and backing off 2 s, 4 s, 8 s.
    assert.deepEqual(times, [0, 2000, 6000, 14_000]);
});

test("waits for the rate limit bucket to refill when the headers say it is empty", async t => {
    const { settle } = useFakeTimers(t);
    const { fetchPage, times } = history(250, (page, call) => ({
        body: page,
        headers: call === 1 ? { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "2.5" } : { "x-ratelimit-remaining": "4" }
    }));
    await settle(fetchConversationRange(range(0, 249), fetchPage, controls()));

    assert.deepEqual(times, [0, 2500, 3500]);
});

test("asks once past 1,000 messages and keeps going when confirmed", async t => {
    const { settle } = useFakeTimers(t);
    const asked: number[] = [];
    const progress: number[] = [];
    const { fetchPage } = history(3500);
    const { value } = await settle(fetchConversationRange(range(0, 3499), fetchPage, controls({
        confirmLargeExport: async count => { asked.push(count); return true; },
        onProgress: count => progress.push(count)
    })));

    assert.equal(value!.length, 3500);
    assert.deepEqual(asked, [1100]);
    // One update per further 1,000 messages; the question covered the first.
    assert.deepEqual(progress, [2000, 3000]);
});

test("stops without exporting when the large-export question is declined", async t => {
    const { settle } = useFakeTimers(t);
    const { fetchPage, times } = history(1500);
    const { error } = await settle(fetchConversationRange(range(0, 1499), fetchPage, controls({
        confirmLargeExport: async () => false
    })));

    assert.ok(error instanceof ExportCancelledError);
    assert.equal(times.length, 11);
});

test("does not ask when the export finishes at the page that passes 1,000 messages", async t => {
    const { settle } = useFakeTimers(t);
    let asked = false;
    const { fetchPage } = history(1050);
    const { value } = await settle(fetchConversationRange(range(0, 1049), fetchPage, controls({
        confirmLargeExport: async () => { asked = true; return true; }
    })));
    assert.equal(value!.length, 1050);
    assert.equal(asked, false);
});

test("ends with an error once the range passes 10,000 messages", async t => {
    const { settle } = useFakeTimers(t);
    const { fetchPage, times } = history(10_050);
    const { error } = await settle(fetchConversationRange(range(0, 10_049), fetchPage, controls()));

    assert.match((error as Error).message, /more than 10,000 messages; select a shorter range/);
    assert.equal(times.length, 101);
});

test("cancelling stops after the request that is running", async t => {
    const { advance, settle } = useFakeTimers(t);
    const cancellation = new ExportCancellation();
    const { fetchPage, times } = history(500, page => new Promise(resolve => setTimeout(() => resolve({ body: page }), 400)));
    const exporting = fetchConversationRange(range(0, 499), fetchPage, controls({ cancellation }));

    await advance(1200);
    assert.equal(times.length, 2);
    cancellation.cancel();
    const { error } = await settle(exporting);

    assert.ok(error instanceof ExportCancelledError);
    assert.equal(times.length, 2);
});

test("cancelling during the pause between requests ends the export at once", async t => {
    const { advance } = useFakeTimers(t);
    const cancellation = new ExportCancellation();
    const { fetchPage, times } = history(500);
    let outcome: unknown;
    fetchConversationRange(range(0, 499), fetchPage, controls({ cancellation })).catch(error => { outcome = error; });

    await advance(100);
    cancellation.cancel();
    await advance(0);

    assert.ok(outcome instanceof ExportCancelledError);
    assert.equal(times.length, 1);
});

test("serializes raw message objects with channel and range metadata", () => {
    const messages = rawMessages(2);
    const selection = {
        channelId,
        startMessageId: messages[0].id,
        endMessageId: messages[1].id
    };
    const exported = buildConversationExport(
        { id: channelId, type: 1, name: "example-dm", recipientIds: ["300000000000000000"] },
        selection,
        messages,
        new Date("2026-07-21T12:00:00.000Z")
    );
    const parsed = JSON.parse(serializeConversationExport(exported));

    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.messageCount, 2);
    assert.equal(parsed.messages[1].content, "message 1");
    assert.equal(parsed.channel.name, "example-dm");
});
