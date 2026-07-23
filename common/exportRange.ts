export interface RawDiscordMessage {
    id: string;
    channel_id?: string;
    [key: string]: unknown;
}

export interface ConversationChannelMetadata {
    guildId?: string;
    guildName?: string;
    id: string;
    name?: string;
    recipientIds?: string[];
    type?: number;
}

export interface ConversationRangeSelection {
    channelId: string;
    endMessageId: string;
    startMessageId: string;
}

export interface ConversationExport {
    channel: ConversationChannelMetadata;
    exportedAt: string;
    messageCount: number;
    messages: RawDiscordMessage[];
    range: {
        firstMessageId: string;
        lastMessageId: string;
        selectedEndMessageId: string;
        selectedStartMessageId: string;
    };
    schemaVersion: 1;
}

export type FetchMessagePage = (
    channelId: string,
    beforeMessageId: string,
    limit: number
) => Promise<unknown[]>;

function toSnowflake(value: string, label: string) {
    if (!/^\d{17,20}$/.test(value)) throw new Error(`${label} is not a Discord message ID`);
    return BigInt(value);
}

function isRawDiscordMessage(value: unknown): value is RawDiscordMessage {
    if (!value || typeof value !== "object" || !("id" in value)) return false;
    return typeof value.id === "string" && /^\d{17,20}$/.test(value.id);
}

export function orderSelectedMessageIds(startMessageId: string, endMessageId: string) {
    const start = toSnowflake(startMessageId, "Start message");
    const end = toSnowflake(endMessageId, "End message");
    return start <= end
        ? { firstMessageId: startMessageId, lastMessageId: endMessageId }
        : { firstMessageId: endMessageId, lastMessageId: startMessageId };
}

export async function fetchConversationRange(
    selection: ConversationRangeSelection,
    fetchPage: FetchMessagePage
): Promise<RawDiscordMessage[]> {
    const { firstMessageId, lastMessageId } = orderSelectedMessageIds(
        selection.startMessageId,
        selection.endMessageId
    );
    const first = BigInt(firstMessageId);
    const last = BigInt(lastMessageId);
    const messages = new Map<string, RawDiscordMessage>();
    const seenCursors = new Set<string>();
    let before = (last + BigInt(1)).toString();
    let reachedFirst = false;

    while (!reachedFirst) {
        if (seenCursors.has(before)) throw new Error("Discord returned a repeated pagination cursor");
        seenCursors.add(before);

        const page = await fetchPage(selection.channelId, before, 100);
        if (!Array.isArray(page) || page.length === 0) break;

        let oldestInPage: bigint | undefined;
        for (const candidate of page) {
            if (!isRawDiscordMessage(candidate)) continue;
            if (candidate.channel_id && candidate.channel_id !== selection.channelId) continue;

            const id = BigInt(candidate.id);
            if (oldestInPage === undefined || id < oldestInPage) oldestInPage = id;
            if (id >= first && id <= last) messages.set(candidate.id, candidate);
        }

        if (oldestInPage === undefined) throw new Error("Discord returned a page without message IDs");
        if (oldestInPage <= first) {
            reachedFirst = true;
            break;
        }

        before = oldestInPage.toString();
        if (page.length < 100) break;
    }

    if (!reachedFirst)
        throw new Error("Discord history ended before the selected start message; no partial export was written");

    return [...messages.values()].sort((left, right) => {
        const leftId = BigInt(left.id);
        const rightId = BigInt(right.id);
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
}

export function buildConversationExport(
    channel: ConversationChannelMetadata,
    selection: ConversationRangeSelection,
    messages: RawDiscordMessage[],
    exportedAt = new Date()
): ConversationExport {
    if (channel.id !== selection.channelId) throw new Error("Channel metadata does not match the selected range");
    if (!messages.length) throw new Error("The selected range contains no exportable messages");

    const { firstMessageId, lastMessageId } = orderSelectedMessageIds(
        selection.startMessageId,
        selection.endMessageId
    );
    return {
        schemaVersion: 1,
        exportedAt: exportedAt.toISOString(),
        channel,
        range: {
            selectedStartMessageId: selection.startMessageId,
            selectedEndMessageId: selection.endMessageId,
            firstMessageId,
            lastMessageId
        },
        messageCount: messages.length,
        messages
    };
}

export function serializeConversationExport(value: ConversationExport) {
    return JSON.stringify(value, null, 2);
}

export function conversationExportFilename(channelId: string, exportedAt = new Date()) {
    const timestamp = exportedAt.toISOString().replace(/[:.]/g, "-");
    return `discord-conversation-${channelId}-${timestamp}.json`;
}
