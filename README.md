# ConversationExporter

A Discord plugin for Revenge (Android) and Vencord (Vesktop). Pick the first and last message of a conversation in any text channel or DM, then copy or save every message in between as JSON, exactly as Discord's API returns them.

Page with the full description and install steps: <https://brainage04.github.io/ConversationExporter/>

## Install

- **Revenge:** in Discord, open Settings, go to Revenge's **Plugins** page, tap **+** and paste `https://brainage04.github.io/ConversationExporter/`. Revenge checks that URL for a new version every time Discord starts.
- **Vesktop (Vencord):** use [DiscordPluginInstaller](https://github.com/brainage04/DiscordPluginInstaller):

  ```bash
  git clone https://github.com/brainage04/DiscordPluginInstaller.git
  cd DiscordPluginInstaller
  node src/cli.mjs vencord install --plugins ConversationExporter --enable --restart
  ```

  Or copy `index.ts`, `common/` and `vencord/` into Vencord's `src/userplugins/conversationExporter.vesktop/` and build Vencord yourself; the page has the steps.

## Build and test

```bash
npm ci
npm test        # tests for the shared code in common/
npm run build   # Revenge build: dist/manifest.json and dist/index.js
```

`common/` holds the code both clients share, `revenge/` the Revenge plugin and its manifest, and `index.ts` with `vencord/` the Vencord userplugin. `site/` is the GitHub Pages site, which also serves the Revenge build; see [site/README.md](site/README.md).

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
