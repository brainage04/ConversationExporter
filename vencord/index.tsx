import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { copyToClipboard } from "@utils/clipboard";
import type { PluginDef } from "@utils/types";
import { saveFile } from "@utils/web";
import type { Channel, Message } from "@vencord/discord-types";
import {
    ChannelStore,
    Constants,
    GuildStore,
    Menu,
    RestAPI,
    showToast,
    Toasts
} from "@webpack/common";

import {
    buildConversationExport,
    type ConversationChannelMetadata,
    conversationExportFilename,
    type ConversationRangeSelection,
    fetchConversationRange,
    serializeConversationExport
} from "../common/exportRange";

interface SelectionState {
    channelId: string;
    endMessageId?: string;
    startMessageId: string;
}

let selection: SelectionState | undefined;
let exporting = false;

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
        showToast("Select both range boundaries first", Toasts.Type.FAILURE);
        return;
    }
    if (exporting) {
        showToast("A conversation export is already running", Toasts.Type.MESSAGE);
        return;
    }

    exporting = true;
    showToast("Fetching the selected conversation range…", Toasts.Type.MESSAGE);
    try {
        const messages = await fetchConversationRange(range, async (channelId, beforeMessageId, limit) => {
            const response = await RestAPI.get({
                url: Constants.Endpoints.MESSAGES(channelId),
                query: { before: beforeMessageId, limit }
            });
            return Array.isArray(response.body) ? response.body : [];
        });
        const exportedAt = new Date();
        const payload = serializeConversationExport(
            buildConversationExport(channelMetadata(range.channelId), range, messages, exportedAt)
        );

        if (mode === "copy") {
            copyToClipboard(payload);
            showToast(`Copied ${messages.length} raw messages`, Toasts.Type.SUCCESS);
        } else {
            const filename = conversationExportFilename(range.channelId, exportedAt);
            saveFile(new File([payload], filename, { type: "application/json" }));
            showToast(`Prepared ${messages.length} raw messages for saving`, Toasts.Type.SUCCESS);
        }
    } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown export error";
        showToast(`Conversation export failed: ${reason}`, Toasts.Type.FAILURE);
    } finally {
        exporting = false;
    }
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
                    showToast("Conversation range start selected", Toasts.Type.SUCCESS);
                }}
            />
            {sameChannel && (
                <Menu.MenuItem
                    id="conversation-exporter-end"
                    label="Set as range end"
                    action={() => {
                        selection = { ...selection!, endMessageId: message.id };
                        showToast("Conversation range ready to export", Toasts.Type.SUCCESS);
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
            {selection && (
                <Menu.MenuItem
                    id="conversation-exporter-clear"
                    label="Clear selected range"
                    color="danger"
                    action={() => {
                        selection = undefined;
                        showToast("Conversation range cleared", Toasts.Type.MESSAGE);
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
        exporting = false;
    }
} satisfies Omit<PluginDef, "name">;
