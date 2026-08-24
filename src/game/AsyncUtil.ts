/**
 * Small `Promise`-wrapping helpers shared by `BoardView` and the tile-effect
 * modules — both engine-frame-driven (via `Tween.updateAll`, called once per
 * frame by the engine's own loop), never `setTimeout`/`setInterval`: a real-
 * time timer keeps firing at wall-clock speed regardless of the engine's
 * actual frame rate, so it drifts out of sync with everything animated by
 * `Tween` (tab backgrounding, a slow device dropping frames, etc. all change
 * the engine's effective fps but not a native timer's).
 */

import { Tween } from 'noonengine';

export function AfterTween(t: any): Promise<void> {
    return new Promise(resolve => {
        t.onComplete(() => resolve());
        t.start();
    });
}

/** A no-op tween whose only job is to resolve after `seconds` of engine time. */
export function Delay(seconds: number): Promise<void> {
    return new Promise(resolve => {
        Tween.create({}).delay(seconds).call(() => resolve()).start();
    });
}
