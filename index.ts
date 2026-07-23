import definePlugin from "@utils/types";

import { vencordPlugin } from "./vencord";

export default definePlugin({
    name: "ConversationExporter",
    ...vencordPlugin
});
