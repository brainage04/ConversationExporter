/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 brainage04
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import { createNotifier, type Notice } from "./notify";

/** What Vencord 1.15.16's showToast throws once its lookup has found no module. */
function brokenToast(): never {
    throw new TypeError("Function.prototype.apply was called on null, which is an object and not a function");
}

function recorder(fallback: (notice: Notice) => void | Promise<void> = () => { }) {
    const toasts: Notice[] = [];
    const fallbacks: Notice[] = [];
    const logs: string[] = [];
    return {
        toasts,
        fallbacks,
        logs,
        options: {
            toast: (notice: Notice) => { toasts.push(notice); },
            fallback: (notice: Notice) => {
                fallbacks.push(notice);
                return fallback(notice);
            },
            log: (message: string) => { logs.push(message); }
        }
    };
}

test("a working toast shows the notice and nothing else", () => {
    const calls = recorder();
    const notify = createNotifier(calls.options);

    notify({ text: "Copied 3 raw messages", variant: "success" });

    assert.deepEqual(calls.toasts, [{ text: "Copied 3 raw messages", variant: "success" }]);
    assert.deepEqual(calls.fallbacks, []);
    assert.deepEqual(calls.logs, []);
});

test("a throwing toast does not throw and shows the notice through the fallback", () => {
    const calls = recorder();
    const notify = createNotifier({ ...calls.options, toast: brokenToast });

    assert.doesNotThrow(() => notify({ text: "Fetching the selected conversation range…" }));

    assert.deepEqual(calls.fallbacks, [{ text: "Fetching the selected conversation range…" }]);
    assert.deepEqual(calls.logs, ["Toasts are broken, showing notifications instead"]);
});

test("after one failed toast later notices go straight to the fallback", () => {
    const calls = recorder();
    let toastCalls = 0;
    const notify = createNotifier({
        ...calls.options,
        toast: () => {
            toastCalls++;
            brokenToast();
        }
    });

    notify({ text: "first" });
    notify({ text: "second", variant: "success" });

    assert.equal(toastCalls, 1);
    assert.deepEqual(calls.fallbacks.map(notice => notice.text), ["first", "second"]);
    assert.equal(calls.logs.length, 1);
});

test("a fallback that throws or rejects is logged, not thrown", async () => {
    const throwing = recorder(() => { throw new Error("no root"); });
    const notifyThrowing = createNotifier({ ...throwing.options, toast: brokenToast });
    assert.doesNotThrow(() => notifyThrowing({ text: "Conversation range cleared" }));
    assert.deepEqual(throwing.logs, [
        "Toasts are broken, showing notifications instead",
        "Could not show \"Conversation range cleared\""
    ]);

    const rejecting = recorder(() => Promise.reject(new Error("no root")));
    const notifyRejecting = createNotifier({ ...rejecting.options, toast: brokenToast });
    notifyRejecting({ text: "Conversation range cleared" });
    await setImmediate();
    assert.deepEqual(rejecting.logs, [
        "Toasts are broken, showing notifications instead",
        "Could not show \"Conversation range cleared\""
    ]);
});
