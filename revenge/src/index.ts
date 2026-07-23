import { find, findByProps } from "@vendetta/metro";
import { React, ReactNative as RN, clipboard } from "@vendetta/metro/common";
import { after, before } from "@vendetta/patcher";
import { showToast } from "@vendetta/ui/toasts";
import { findInReactTree } from "@vendetta/utils";

import {
    buildConversationExport,
    type ConversationChannelMetadata,
    conversationExportFilename,
    type ConversationRangeSelection,
    fetchConversationRange,
    serializeConversationExport
} from "../../common/exportRange";

interface RawMessageContext {
    message?: {
        channel_id?: string;
        id?: string;
    };
}

interface SelectionState {
    channelId: string;
    endMessageId?: string;
    startMessageId: string;
}

interface RestClient {
    get(options: {
        query?: Record<string, number | string>;
        retries?: number;
        url: string;
    }): Promise<{ body?: unknown }>;
}

interface NativeFileManager {
    writeFile(
        storageDirectory: "cache" | "documents",
        filename: string,
        data: string,
        encoding: "base64" | "utf8"
    ): Promise<string>;
}

interface LazyActionSheetApi {
    hideActionSheet?(): void;
    openLazy(...args: unknown[]): unknown;
}

interface ChannelRecord {
    guild_id?: string;
    id: string;
    name?: string;
    recipients?: string[];
    type?: number;
}

let lazyActionSheet: LazyActionSheetApi | undefined;
const ChannelStore = findByProps("getChannel", "hasChannel");
const GuildStore = findByProps("getGuild", "getGuilds");
const NativeFileModule = (
    RN.NativeModules.RTNFileManager
    ?? RN.NativeModules.DCDFileManager
    ?? RN.NativeModules.NativeFileModule
) as NativeFileManager | undefined;

let selection: SelectionState | undefined;
let exporting = false;
let actionSheetPoll: number | undefined;
let unpatchLazy: (() => void) | undefined;
const sheetUnpatches = new Set<() => void>();

function findRestClient(): RestClient | undefined {
    const isCandidate = (module: unknown): module is RestClient => {
        if (!module || typeof module !== "object") return false;
        if (!("get" in module) || typeof module.get !== "function") return false;
        return "post" in module && typeof module.post === "function";
    };

    return find(isCandidate) as RestClient | undefined;
}

function selectedRange(): ConversationRangeSelection | undefined {
    if (!selection?.endMessageId) return;
    return {
        channelId: selection.channelId,
        startMessageId: selection.startMessageId,
        endMessageId: selection.endMessageId
    };
}

function channelMetadata(channelId: string): ConversationChannelMetadata {
    const channel = ChannelStore.getChannel(channelId) as ChannelRecord | undefined;
    if (!channel) throw new Error("The selected channel is no longer available");

    const guildName = channel.guild_id
        ? (GuildStore.getGuild(channel.guild_id) as { name?: string } | undefined)?.name
        : undefined;
    return {
        id: channel.id,
        type: channel.type,
        name: channel.name,
        guildId: channel.guild_id,
        guildName,
        recipientIds: channel.recipients
    };
}

async function exportSelectedRange(mode: "copy" | "save") {
    const range = selectedRange();
    if (!range) {
        showToast("Select both conversation range boundaries first");
        return;
    }
    if (exporting) {
        showToast("A conversation export is already running");
        return;
    }

    const rest = findRestClient();
    if (!rest) {
        showToast("ConversationExporter could not locate Discord's REST client");
        return;
    }

    exporting = true;
    showToast("Fetching the selected conversation range…");
    try {
        const messages = await fetchConversationRange(range, async (channelId, beforeMessageId, limit) => {
            const response = await rest.get({
                url: `/channels/${channelId}/messages`,
                query: { before: beforeMessageId, limit },
                retries: 1
            });
            return Array.isArray(response?.body) ? response.body : [];
        });
        const exportedAt = new Date();
        const payload = serializeConversationExport(
            buildConversationExport(channelMetadata(range.channelId), range, messages, exportedAt)
        );

        if (mode === "copy") {
            clipboard.setString(payload);
            showToast(`Copied ${messages.length} raw messages`);
        } else {
            if (!NativeFileModule?.writeFile)
                throw new Error("This Revenge build does not expose Discord's native file manager");

            const filename = conversationExportFilename(range.channelId, exportedAt);
            const location = await NativeFileModule.writeFile("documents", filename, payload, "utf8");
            showToast(`Saved ${messages.length} raw messages to ${location || filename}`);
        }
    } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown export error";
        showToast(`Conversation export failed: ${reason}`);
    } finally {
        exporting = false;
    }
}

interface ActionRowElement {
    props?: Record<string, unknown>;
    type?: unknown;
}

function isActionRow(value: unknown): value is ActionRowElement {
    if (!value || typeof value !== "object" || !("props" in value)) return false;
    const props = value.props;
    if (!props || typeof props !== "object") return false;
    return ("onPress" in props && typeof props.onPress === "function")
        && (("label" in props && typeof props.label === "string")
            || ("message" in props && typeof props.message === "string"));
}

function findActionRows(tree: unknown): unknown[] | undefined {
    const rows = findInReactTree(tree, node =>
        Array.isArray(node) && node.length > 0 && node.some(isActionRow)
    );
    return Array.isArray(rows) ? rows : undefined;
}

function rowLabel(row: unknown) {
    if (!isActionRow(row)) return;
    const label = row.props?.label ?? row.props?.message;
    return typeof label === "string" ? label : undefined;
}

function createActionRow(template: unknown, label: string, action: () => void) {
    if (!isActionRow(template)) return;
    return React.cloneElement(template, {
        key: `conversation-exporter-${label}`,
        label,
        message: label,
        onPress: () => {
            lazyActionSheet?.hideActionSheet?.();
            action();
        }
    });
}

function injectRangeActions(tree: unknown, message: { channel_id?: string; id?: string }) {
    const channelId = message.channel_id;
    const messageId = message.id;
    if (!channelId || !messageId) return;

    const rows = findActionRows(tree);
    const template = rows?.find(isActionRow);
    if (!rows || !template || rows.some(row => rowLabel(row) === "Set as conversation range start")) return;

    const sameChannel = selection?.channelId === channelId;
    const rangeReady = sameChannel && Boolean(selection?.endMessageId);
    const additions = [
        createActionRow(template, "Set as conversation range start", () => {
            selection = { channelId, startMessageId: messageId };
            showToast("Conversation range start selected");
        }),
        sameChannel
            ? createActionRow(template, "Set as conversation range end", () => {
                const current = selection;
                if (!current || current.channelId !== channelId) return;
                selection = { ...current, endMessageId: messageId };
                showToast("Conversation range ready to export");
            })
            : undefined,
        rangeReady
            ? createActionRow(template, "Copy selected conversation as JSON", () => {
                void exportSelectedRange("copy");
            })
            : undefined,
        rangeReady
            ? createActionRow(template, "Save selected conversation as JSON", () => {
                void exportSelectedRange("save");
            })
            : undefined,
        selection
            ? createActionRow(template, "Clear selected conversation range", () => {
                selection = undefined;
                showToast("Conversation range cleared");
            })
            : undefined
    ].filter((row): row is NonNullable<typeof row> => Boolean(row));

    rows.unshift(...additions);
}

function patchMessageActionSheet() {
    if (unpatchLazy) return true;

    const candidate = findByProps("openLazy", "hideActionSheet") as LazyActionSheetApi | undefined;
    if (!candidate || typeof candidate.openLazy !== "function") return false;

    lazyActionSheet = candidate;
    unpatchLazy = before("openLazy", candidate, ([component, key, context]) => {
        const message = (context as RawMessageContext | undefined)?.message;
        if (typeof key !== "string" || !key.includes("MessageLongPress") || !message?.id) return;
        if (!component || typeof component.then !== "function") return;

        component.then((instance: { default?: unknown }) => {
            if (!instance?.default) return;

            const module = instance as Record<string, unknown>;
            const unpatchSheet = after("default", module, ([props], tree) => {
                React.useEffect(() => () => {
                    unpatchSheet();
                    sheetUnpatches.delete(unpatchSheet);
                }, []);
                const currentMessage = (props as RawMessageContext | undefined)?.message ?? message;
                injectRangeActions(tree, currentMessage);
            });
            sheetUnpatches.add(unpatchSheet);
        });
    });
    return true;
}


function onLoad() {
    if (patchMessageActionSheet()) return;

    actionSheetPoll = setInterval(() => {
        if (!patchMessageActionSheet()) return;
        clearInterval(actionSheetPoll);
        actionSheetPoll = undefined;
    }, 250);
}

function onUnload() {
    clearInterval(actionSheetPoll);
    actionSheetPoll = undefined;
    lazyActionSheet = undefined;
    unpatchLazy?.();
    unpatchLazy = undefined;
    for (const unpatch of sheetUnpatches) unpatch();
    sheetUnpatches.clear();
    selection = undefined;
    exporting = false;
}

export default { onLoad, onUnload };
