import assert from "node:assert/strict";
import test from "node:test";

import {
    buildConversationExport,
    fetchConversationRange,
    orderSelectedMessageIds,
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

test("paginates backward and returns the inclusive range in chronological order", async () => {
    const source = rawMessages(205);
    const messages = await fetchConversationRange(
        {
            channelId,
            startMessageId: messageId(10),
            endMessageId: messageId(190)
        },
        async (_channelId, before, limit) => source
            .filter(message => BigInt(message.id) < BigInt(before))
            .sort((left, right) => BigInt(left.id) > BigInt(right.id) ? -1 : 1)
            .slice(0, limit)
    );

    assert.equal(messages.length, 181);
    assert.equal(messages[0].id, messageId(10));
    assert.equal(messages.at(-1)?.id, messageId(190));
    assert.deepEqual(messages[0].attachments, [{ id: "attachment-10" }]);
});

test("accepts boundaries selected in reverse chronological order", () => {
    assert.deepEqual(orderSelectedMessageIds(messageId(9), messageId(2)), {
        firstMessageId: messageId(2),
        lastMessageId: messageId(9)
    });
});

test("rejects partial history instead of silently writing a partial export", async () => {
    await assert.rejects(
        fetchConversationRange(
            {
                channelId,
                startMessageId: messageId(1),
                endMessageId: messageId(150)
            },
            async () => rawMessages(20).slice(10).reverse()
        ),
        /no partial export was written/
    );
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
