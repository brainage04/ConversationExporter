/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 brainage04
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { copyToClipboard } from "@utils/clipboard";
import type { PluginDef } from "@utils/types";
import { saveFile } from "@utils/web";
import type { Channel, Message } from "@vencord/discord-types";
import {
    Alerts,
    ChannelStore,
    Constants,
    GuildStore,
    Menu,
    RestAPI,
    showToast
} from "@webpack/common";

import {
    buildConversationExport,
    type ConversationChannelMetadata,
    conversationExportFilename,
    type ConversationRangeSelection,
    EXPORT_LIMITS,
    ExportCancellation,
    ExportCancelledError,
    fetchConversationRange,
    serializeConversationExport
} from "../common/exportRange";

interface SelectionState {
    channelId: string;
    endMessageId?: string;
    startMessageId: string;
}

let selection: SelectionState | undefined;
/** The running export, if any. */
let exporting: ExportCancellation | undefined;

function selectedRange(): ConversationRangeSelection | undefined {
    if (!selection?.endMessageId) return;
    return {
        channelId: selection.channelId,
        startMessageId: selection.startMessageId,
        endMessageId: selection.endMessageId
    };
}

function channelMetadata(channelId: string): ConversationChannelMetadata {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) throw new Error("The selected channel is no longer available");

    const guildId = channel.guild_id ?? undefined;
    const guildName = guildId ? GuildStore.getGuild(guildId)?.name : undefined;
    return {
        id: channel.id,
        type: channel.type,
        name: channel.name || undefined,
        guildId,
        guildName,
        recipientIds: channel.recipients
    };
}

async function exportSelectedRange(mode: "copy" | "save") {
    const range = selectedRange();
    if (!range) {
        showToast({ text: "Select both range boundaries first", variant: "critical" });
        return;
    }
    if (exporting) {
        showToast({ text: "A conversation export is already running" });
        return;
    }

    const cancellation = new ExportCancellation();
    exporting = cancellation;
    showToast({ text: "Fetching the selected conversation range…" });
    try {
        const messages = await fetchConversationRange(
            range,
            (channelId, beforeMessageId, limit) => RestAPI.get({
                url: Constants.Endpoints.MESSAGES(channelId),
                query: { before: beforeMessageId, limit }
            }),
            {
                cancellation,
                confirmLargeExport,
                onProgress: count => showToast({ text: `Fetched ${count.toLocaleString("en-US")} messages so far…` })
            }
        );
        const exportedAt = new Date();
        const payload = serializeConversationExport(
            buildConversationExport(channelMetadata(range.channelId), range, messages, exportedAt)
        );

        if (mode === "copy") {
            copyToClipboard(payload);
            showToast({ text: `Copied ${messages.length} raw messages`, variant: "success" });
        } else {
            const filename = conversationExportFilename(range.channelId, exportedAt);
            saveFile(new File([payload], filename, { type: "application/json" }));
            showToast({ text: `Prepared ${messages.length} raw messages for saving`, variant: "success" });
        }
    } catch (error) {
        if (error instanceof ExportCancelledError) {
            showToast({ text: "Conversation export cancelled" });
            return;
        }
        const reason = error instanceof Error ? error.message : "Unknown export error";
        showToast({ text: `Conversation export failed: ${reason}`, variant: "critical" });
    } finally {
        if (exporting === cancellation) exporting = undefined;
    }
}

function confirmLargeExport(count: number) {
    return new Promise<boolean>(resolve => {
        Alerts.show({
            title: "Large conversation export",
            body: `The export has passed ${count.toLocaleString("en-US")} messages and is not done yet. It fetches about 100 messages a second and stops with an error at ${EXPORT_LIMITS.maxMessages.toLocaleString("en-US")}. Keep going?`,
            confirmText: "Keep going",
            cancelText: "Stop export",
            onConfirm: () => resolve(true),
            onCancel: () => resolve(false),
            // Closing the dialog any other way stops the export; a second resolve is ignored.
            onCloseCallback: () => resolve(false)
        });
    });
}

const messageContextMenuPatch: NavContextMenuPatchCallback = (
    children,
    { channel, message }: { channel: Channel; message: Message }
) => {
    if (!channel?.id || !message?.id) return;

    const sameChannel = selection?.channelId === channel.id;
    const rangeReady = sameChannel && Boolean(selection?.endMessageId);
    children.push(
        <Menu.MenuGroup id="conversation-exporter" label="Conversation export">
            <Menu.MenuItem
                id="conversation-exporter-start"
                label="Set as range start"
                action={() => {
                    selection = { channelId: channel.id, startMessageId: message.id };
                    showToast({ text: "Conversation range start selected", variant: "success" });
                }}
            />
            {sameChannel && (
                <Menu.MenuItem
                    id="conversation-exporter-end"
                    label="Set as range end"
                    action={() => {
                        selection = { ...selection!, endMessageId: message.id };
                        showToast({ text: "Conversation range ready to export", variant: "success" });
                    }}
                />
            )}
            {rangeReady && (
                <Menu.MenuItem
                    id="conversation-exporter-copy"
                    label="Copy selected range as JSON"
                    action={() => { void exportSelectedRange("copy"); }}
                />
            )}
            {rangeReady && (
                <Menu.MenuItem
                    id="conversation-exporter-save"
                    label="Save selected range as JSON"
                    action={() => { void exportSelectedRange("save"); }}
                />
            )}
            {exporting && (
                <Menu.MenuItem
                    id="conversation-exporter-cancel"
                    label="Cancel export"
                    color="danger"
                    action={() => {
                        exporting?.cancel();
                        showToast({ text: "Cancelling the conversation export after the current request…" });
                    }}
                />
            )}
            {selection && (
                <Menu.MenuItem
                    id="conversation-exporter-clear"
                    label="Clear selected range"
                    color="danger"
                    action={() => {
                        selection = undefined;
                        showToast({ text: "Conversation range cleared" });
                    }}
                />
            )}
        </Menu.MenuGroup>
    );
};

export const vencordPlugin = {
    description: "Select two messages in any text channel and copy or save the inclusive raw-message range as JSON.",
    tags: ["Chat", "Utility"],
    authors: [{ name: "brainage04", id: 0n }],
    contextMenus: {
        message: messageContextMenuPatch
    },
    stop() {
        selection = undefined;
        exporting?.cancel();
        exporting = undefined;
    }
} satisfies Omit<PluginDef, "name">;
