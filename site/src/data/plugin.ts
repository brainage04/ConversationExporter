/** Page content for this plugin. Keep it in step with the plugin's code in `revenge/`, `vencord/` and `common/`. */
export interface Card {
  title: string;
  /** Plain text; spans in backticks render as code. */
  text: string;
}

export interface Setting {
  name: string;
  defaultValue: string;
  description: string;
}

export interface Section {
  title: string;
  intro?: string;
  items: string[];
}

export interface PluginPage {
  /** GitHub repository name; also the Pages base path (`https://brainage04.github.io/<repository>/`). */
  repository: string;
  summary: string;
  /** The Vencord entry file in the repository root. */
  vencordEntry: 'index.ts' | 'index.tsx';
  /** Folder name under Vencord's `src/userplugins/`, as in DiscordPluginInstaller's catalog. */
  vencordDirectory: string;
  /** The card grid: a title naming what the cards describe (what it does, how to use it, how it works). */
  cards: { title: string; items: Card[] };
  /** The same settings exist on Revenge and Vencord unless `settingsNote` says otherwise. */
  settings: Setting[];
  settingsNote?: string;
  sections: Section[];
}

export const plugin: PluginPage = {
  repository: 'ConversationExporter',
  summary:
    'Pick the first and last message of a conversation in any text channel or DM, then copy or save every message in between as JSON, exactly as Discord’s API returns them.',
  vencordEntry: 'index.ts',
  vencordDirectory: 'conversationExporter.vesktop',
  cards: {
    title: 'How to use it',
    items: [
      {
        title: 'Open the message menu',
        text: 'On Vesktop, right-click a message and use the Conversation export group. On Revenge, long-press a message and use the actions added to its menu.',
      },
      {
        title: 'Select a range',
        text: 'Mark one message as the range start and another in the same channel as the range end. The order does not matter. The export always runs from the older message to the newer one.',
      },
      {
        title: 'Copy or save',
        text: 'Copy the range to the clipboard, or save it as `discord-conversation-<channel id>-<time>.json`. Vesktop offers the file as a download. Revenge writes it to Discord’s documents folder and shows where.',
      },
      {
        title: 'Clear the selection',
        text: 'Clear selected range forgets both messages. Disabling the plugin clears them too.',
      },
      {
        title: 'Large exports',
        text: 'History is fetched one page of 100 messages at a time, at most one request a second. Once an export passes 1,000 messages it stops and asks whether to keep going (a dialog on Vesktop, an alert on Revenge), then shows a short note for every further 1,000 messages. It never goes past 10,000 messages: a longer range ends with an error and nothing is copied or saved.',
      },
      {
        title: 'Cancel an export',
        text: 'While an export runs, the message menu has Cancel export (Cancel conversation export on Revenge). The export stops after the request that is running and nothing is copied or saved.',
      },
    ],
  },
  settings: [],
  settingsNote: 'This plugin has no settings. Everything happens from the message menu.',
  sections: [
    {
      title: 'Rate limits',
      intro: 'The export waits for Discord rather than pushing through its limits:',
      items: [
        'At most one history request a second.',
        'When Discord answers that you are sending too many requests, the export waits at least as long as Discord asks (and 2, 4, then 8 seconds at the least), and gives up with an error after 3 retries of the same page.',
        'If your Discord client passes on Discord’s rate limit headers (Vesktop does not), the next request also waits until they say requests are available again.',
      ],
    },
    {
      title: 'Export format',
      intro:
        'Messages are exported exactly as Discord returns them, oldest first, including both selected messages. If Discord’s history ends before the start message, nothing is copied or saved. The JSON file is one object:',
      items: [
        '`schemaVersion`: always `1`.',
        '`exportedAt`: when the export ran, as an ISO 8601 timestamp.',
        '`channel`: the channel’s `id`, `type`, `name`, server (`guildId`, `guildName`) and, for DMs, `recipientIds`.',
        '`range`: the two selected message IDs (`selectedStartMessageId`, `selectedEndMessageId`) and the same pair in time order (`firstMessageId`, `lastMessageId`).',
        '`messageCount` and `messages`: the raw Discord message objects, oldest first.',
      ],
    },
  ],
};

export const sourceHref = `https://github.com/brainage04/${plugin.repository}`;
