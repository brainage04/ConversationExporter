/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 brainage04
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface Notice {
    text: string;
    variant?: "default" | "success" | "critical";
}

export interface NotifierOptions {
    /** Shows a toast through the client. May throw: Vencord 1.15.16 cannot find Discord's toast module. */
    toast(notice: Notice): void;
    /** Shown instead once the toast has failed. May throw or reject. */
    fallback(notice: Notice): void | Promise<void>;
    log(message: string, error: unknown): void;
}

/**
 * Returns a notify function that never throws, so a broken toast cannot stop the action that reports through it.
 * After the first failed toast every notice goes to the fallback: Vencord retries a failed lazy lookup up to five
 * times, scanning every webpack module and logging each time (src/utils/lazy.ts:97 in Vencord 1.15.16).
 */
export function createNotifier({ toast, fallback, log }: NotifierOptions) {
    let toastBroken = false;

    function showFallback(notice: Notice) {
        try {
            Promise.resolve(fallback(notice)).catch(error => log(`Could not show "${notice.text}"`, error));
        } catch (error) {
            log(`Could not show "${notice.text}"`, error);
        }
    }

    return (notice: Notice) => {
        if (!toastBroken) {
            try {
                toast(notice);
                return;
            } catch (error) {
                toastBroken = true;
                log("Toasts are broken, showing notifications instead", error);
            }
        }
        showFallback(notice);
    };
}
