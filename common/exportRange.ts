/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 brainage04
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

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

/** A REST response, or what Discord's REST client rejects with; `headers` may be a plain object or a `Headers`. */
export interface PageResponse {
    body?: unknown;
    headers?: unknown;
}

export type FetchMessagePage = (
    channelId: string,
    beforeMessageId: string,
    limit: number
) => Promise<PageResponse>;

export const EXPORT_LIMITS = {
    /** At most one history request per this many milliseconds. */
    requestIntervalMs: 1000,
    /** Retries of one page after Discord answers 429, each waiting at least as long as Discord asks. */
    maxRetries: 3,
    /** Wait before the first retry when Discord gives no `retry_after`; doubles for each further retry. */
    retryBaseMs: 2000,
    /** Past this many messages the export stops and asks whether to go on. */
    confirmAfter: 1000,
    /** An export never collects more messages than this. */
    maxMessages: 10_000,
    /** Past `confirmAfter`, a progress update is shown each time this many more messages have been fetched. */
    progressEvery: 1000
};

export type ExportLimits = typeof EXPORT_LIMITS;

/** Thrown when an export is cancelled from the menu or the large-export question is answered with no. */
export class ExportCancelledError extends Error {
    constructor() {
        super("The conversation export was cancelled");
        this.name = "ExportCancelledError";
    }
}

/** Lets the message menu stop a running export; waits end early once it is cancelled. */
export class ExportCancellation {
    private isCancelled = false;
    private readonly wakers = new Set<() => void>();

    get cancelled() {
        return this.isCancelled;
    }

    cancel() {
        this.isCancelled = true;
        for (const wake of this.wakers) wake();
        this.wakers.clear();
    }

    /** Waits `ms`, or until cancelled if that comes first. */
    wait(ms: number) {
        if (ms <= 0 || this.isCancelled) return Promise.resolve();
        return new Promise<void>(resolve => {
            const wake = () => {
                clearTimeout(timer);
                this.wakers.delete(wake);
                resolve();
            };
            const timer = setTimeout(wake, ms);
            this.wakers.add(wake);
        });
    }
}

export interface ExportControls {
    cancellation: ExportCancellation;
    /** Asked once, when the export passes `confirmAfter` messages before it is done; false stops it. */
    confirmLargeExport(messageCount: number): Promise<boolean>;
    /** Called past `confirmAfter` each time another `progressEvery` messages have been fetched. */
    onProgress?(messageCount: number): void;
    limits?: Partial<ExportLimits>;
}

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

function header(headers: unknown, name: string) {
    if (!headers || typeof headers !== "object") return undefined;
    const value = "get" in headers && typeof headers.get === "function"
        ? headers.get(name)
        : (headers as Record<string, unknown>)[name];
    const number = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
    return Number.isFinite(number) ? number : undefined;
}

/** The milliseconds Discord asks to wait after a 429 (null for any other failure). */
function retryAfterMs(error: unknown) {
    const response = error as { status?: number; body?: { retry_after?: unknown; }; headers?: unknown; } | undefined;
    if (response?.status !== 429) return null;
    const seconds = typeof response.body?.retry_after === "number"
        ? response.body.retry_after
        : header(response.headers, "retry-after");
    return seconds && seconds > 0 ? seconds * 1000 : 0;
}

/** When Discord says the rate limit bucket is empty, the milliseconds until it refills. */
function bucketResetMs(headers: unknown) {
    if (header(headers, "x-ratelimit-remaining") !== 0) return 0;
    return (header(headers, "x-ratelimit-reset-after") ?? 0) * 1000;
}

function formatCount(count: number) {
    return count.toLocaleString("en-US");
}

/**
 * Fetches the selected range page by page, newest first, at about one request per second. It waits
 * as long as Discord's rate limit answers and headers ask, gives up after a few 429s in a row for one
 * page, asks before going past `confirmAfter` messages, and refuses ranges above `maxMessages`.
 */
export async function fetchConversationRange(
    selection: ConversationRangeSelection,
    fetchPage: FetchMessagePage,
    controls: ExportControls
): Promise<RawDiscordMessage[]> {
    const limits = { ...EXPORT_LIMITS, ...controls.limits };
    const { cancellation } = controls;
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
    let nextRequestAt = 0;
    let confirmed = false;
    let reported = 0;

    async function pacedPage(beforeMessageId: string) {
        for (let retry = 0; ; retry++) {
            await cancellation.wait(nextRequestAt - Date.now());
            if (cancellation.cancelled) throw new ExportCancelledError();
            nextRequestAt = Date.now() + limits.requestIntervalMs;
            try {
                const response = await fetchPage(selection.channelId, beforeMessageId, 100);
                nextRequestAt = Math.max(nextRequestAt, Date.now() + bucketResetMs(response?.headers));
                return response?.body;
            } catch (error) {
                const asked = retryAfterMs(error);
                if (asked === null) throw error;
                if (retry >= limits.maxRetries)
                    throw new Error("Discord kept rate limiting the export; try again later");
                nextRequestAt = Math.max(nextRequestAt, Date.now() + Math.max(asked, limits.retryBaseMs * 2 ** retry));
            }
        }
    }

    while (!reachedFirst) {
        if (seenCursors.has(before)) throw new Error("Discord returned a repeated pagination cursor");
        seenCursors.add(before);

        const page = await pacedPage(before);
        // Cancelling stops after the request that was running.
        if (cancellation.cancelled) throw new ExportCancelledError();
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
        if (messages.size > limits.maxMessages)
            throw new Error(`The selected range has more than ${formatCount(limits.maxMessages)} messages; select a shorter range`);
        if (oldestInPage <= first) {
            reachedFirst = true;
            break;
        }

        const step = Math.floor(messages.size / limits.progressEvery);
        if (!confirmed && messages.size > limits.confirmAfter) {
            if (!await controls.confirmLargeExport(messages.size)) throw new ExportCancelledError();
            confirmed = true;
            if (cancellation.cancelled) throw new ExportCancelledError();
            // The question already said how far the export got.
            reported = step;
        } else if (confirmed && step > reported) {
            reported = step;
            controls.onProgress?.(messages.size);
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
