/**
 * Fixed board layouts for manual testing — see `Board`'s `DebugLayout`
 * doc comment for why this exists. Load one via `?layout=<name>` in the
 * URL (wired in `src/index.ts`/`GameScene`); with no `layout` param the
 * game boots with the normal random board, same as any real player sees.
 *
 * Each layout was authored and checked with the same standalone
 * `Board`-model testing approach described in AGENTS.md's "Real Candy
 * Crush reference" section (`hasAnyMatch()` false on load, the intended
 * swap producing the intended result) — before adding a new one, verify it
 * the same way rather than by eyeballing the grid.
 */

import { DebugLayout } from './Board';

export function checkerboard(rows: number, cols: number): number[][] {
    const grid: number[][] = [];
    for (let r = 0; r < rows; r++) {
        grid.push(new Array(cols).fill(0).map((_, c) => (r + c) % 2 === 0 ? 2 : 3));
    }
    return grid;
}

/**
 * Swap (4,2) <-> (5,2) (a vertical swap) to complete a 5-in-a-row of type 0
 * at row 4, cols 0-4 — spawns a Color Bomb. Everything else is a
 * checkerboard filler (2/3 alternating) specifically so it can't
 * accidentally extend or pre-empt the match on its own.
 */
const colorBombReady: DebugLayout = {
    cells: (() => {
        const grid = checkerboard(8, 8);
        grid[4] = [0, 0, 1, 0, 0, grid[4][5], grid[4][6], grid[4][7]];
        grid[5][2] = 0;
        return grid;
    })(),
};

/**
 * Same 5-in-a-row as `colorBombReady` (swap (4,2) <-> (5,2)), but this time
 * col 2 also already has type-0 candies at rows 2-3 — so completing the row
 * doesn't just finish a 5-match, it also completes a *crossing* 3-in-a-column
 * at the same cell (4,2), the same L/T shape that normally produces a
 * Wrapped Candy. A Color Bomb-worthy run always outranks being folded into
 * an L/T merge (`Board.resolve()`'s hRuns/vRuns loop skips the merge
 * whenever either crossing run is already long enough for its own Color
 * Bomb) — this spawns a **Color Bomb** at (4,2), not a Wrapped Candy, even
 * though the crossing 3-in-a-column would otherwise have produced one. Was a
 * confirmed bug (spawned Wrapped instead) before that priority check existed.
 */
const colorBombBeatsWrapped: DebugLayout = {
    cells: (() => {
        const grid = checkerboard(8, 8);
        grid[4] = [0, 0, 1, 0, 0, grid[4][5], grid[4][6], grid[4][7]];
        grid[5][2] = 0;
        grid[3][2] = 0;
        grid[2][2] = 0;
        return grid;
    })(),
};

/**
 * Two specials already sitting next to each other — swap (3,3) <-> (3,4)
 * immediately to trigger their combo (striped-h + wrapped here). Change the
 * `specials` pair to test a different combination; the underlying cell
 * values (4 and 5) only exist so they don't coincidentally extend into a
 * checkerboard-adjacent match, they aren't otherwise meaningful.
 */
const comboReady: DebugLayout = {
    cells: (() => {
        const grid = checkerboard(8, 8);
        grid[3][3] = 4;
        grid[3][4] = 5;
        return grid;
    })(),
    specials: [
        ['3,3', 'striped-h'],
        ['3,4', 'wrapped'],
    ],
};

/**
 * Same idea as `comboReady`, but swap (3,3) <-> (4,3) — a *vertical* swap —
 * instead of a horizontal one. `comboReady` only exercises a horizontal
 * combo swap, which can't distinguish `BoardView._attemptSwap`'s
 * `forcesActivation` branch correctly tracking which node ends up at which
 * grid position after the swap (needed so per-cell burst/pop effects land on
 * the right sprite) from a version that doesn't — a vertical swap is a
 * distinct code path worth checking too.
 */
const comboReadyVertical: DebugLayout = {
    cells: (() => {
        const grid = checkerboard(8, 8);
        grid[3][3] = 4;
        grid[4][3] = 5;
        return grid;
    })(),
    specials: [
        ['3,3', 'striped-h'],
        ['4,3', 'wrapped'],
    ],
};

/**
 * A Color Bomb at (4,4) next to a plain type-0 candy at (4,5) — swap them
 * immediately to activate the bomb against every type-0 candy on the board
 * (the "lightning" beam effect). A handful of isolated type-0 singletons are
 * scattered across the checkerboard filler (never adjacent to each other, so
 * they can't form their own run) purely to give the beam more than one
 * target to visibly fan out to.
 *
 * Try the swap from *both* directions (press the bomb at (4,4) and drag
 * right, then reload and press the plain candy at (4,5) and drag left) — the
 * beam's origin must visually track wherever the bomb's own sprite ends up,
 * not always the same one of the two cells; this is what the 2026-08-25
 * origin-position fix in `Board.activateSpecialSwap` covers (see AGENTS.md).
 */
const colorBombActivateReady: DebugLayout = {
    cells: (() => {
        const grid = checkerboard(8, 8);
        grid[0][0] = 0;
        grid[2][5] = 0;
        grid[5][1] = 0;
        grid[6][6] = 0;
        grid[1][7] = 0;
        grid[4][4] = 1;
        grid[4][5] = 0;
        return grid;
    })(),
    specials: [
        ['4,4', 'color-bomb'],
    ],
};

/**
 * Swap (4,2) <-> (5,2) (a vertical swap) to complete a *4*-in-a-row of type 0
 * at row 4, cols 0-3 — spawns the perpendicular striped-v tile at (4,2), the
 * swap destination (a horizontal match spawns a vertical-look, column-clearing
 * tile — see `Board.resolve()`'s doc). Col 4 is left as the checkerboard's own
 * (non-zero) value specifically so the run stops at exactly 4, not 5 — see
 * `StripedEffectTestScene`, which loads this to isolate-test the striped
 * activation effect (it should clear/beam across the *entire* column once the
 * new striped tile is itself swapped with a neighbor).
 */
const stripedH4Match: DebugLayout = {
    cells: (() => {
        const grid = checkerboard(8, 8);
        grid[4] = [0, 0, 1, 0, grid[4][4], grid[4][5], grid[4][6], grid[4][7]];
        grid[5][2] = 0;
        return grid;
    })(),
};

/**
 * Same idea as `stripedH4Match`, transposed: swap (2,2) <-> (2,3) (a
 * horizontal swap) to complete a vertical 4-in-a-row of type 0 at col 2,
 * rows 0-3 — spawns the perpendicular striped-h tile at (2,2) (a vertical
 * match spawns a horizontal-look, row-clearing tile). Row 4's col-2 cell is
 * left as the checkerboard's own value so the run stops at exactly 4.
 */
const stripedV4Match: DebugLayout = {
    cells: (() => {
        const grid = checkerboard(8, 8);
        grid[0][2] = 0;
        grid[1][2] = 0;
        grid[2][2] = 1;
        grid[3][2] = 0;
        grid[2][3] = 0;
        return grid;
    })(),
};

/**
 * A pre-existing striped-h tile at (4,1) sits inside a would-be 4-match —
 * swap (3,2) <-> (4,2) (a vertical swap, neither cell itself a special) to
 * complete a plain color match of type 0 at row 4, cols 0-3, which includes
 * the pre-existing special's own cell AND spawns a new striped-v at the swap
 * destination (4,2). This now plays out as **two** separate `resolve()`
 * passes (see `Board.ts`'s `_catchBystanders`/`_expandCaught`), not one
 * combined clear:
 *
 * - Pass 1: the 4-match's plain cells clear, AND the pre-existing striped-h
 *   at (4,1) — directly part of this same matched run — activates
 *   immediately, sweeping the *entire* row (cols 4-7, checkerboard filler,
 *   get swept too). The new striped-v at (4,2) sits inside that swept row
 *   but is left untouched this pass (deferred, not yet destroyed) rather
 *   than being silently consumed in the same instant it was created.
 * - Pass 2: the deferred striped-v at (4,2) activates on its own, as a
 *   distinct beat, sweeping column 2.
 *
 * If cols 4-7 don't clear in pass 1, the bystander catch didn't fire. If
 * column 2 doesn't clear in pass 2, the deferred chain reaction didn't fire.
 */
const stripedBystanderCatch: DebugLayout = {
    cells: (() => {
        const grid = checkerboard(8, 8);
        grid[4] = [0, 0, 1, 0, grid[4][4], grid[4][5], grid[4][6], grid[4][7]];
        grid[3][2] = 0;
        return grid;
    })(),
    specials: [
        ['4,1', 'striped-h'],
    ],
};

/**
 * A Color Bomb at (4,4) next to a Color Bomb at (4,5) — swap them
 * immediately to trigger the whole-board clear. No scattered singles needed
 * (this combo doesn't target one color, it clears everything), but the rest
 * of the board is still the normal checkerboard filler so the "everything
 * clears" result is obvious against a busy board rather than an already-empty one.
 */
const colorBombVsColorBomb: DebugLayout = {
    cells: (() => {
        const grid = checkerboard(8, 8);
        grid[4][4] = 4;
        grid[4][5] = 5;
        return grid;
    })(),
    specials: [
        ['4,4', 'color-bomb'],
        ['4,5', 'color-bomb'],
    ],
};

/**
 * A Color Bomb at (4,4) next to a striped-h tile at (4,5) — swap them
 * immediately to trigger the combo (every type-0 candy also gets a
 * striped-h-style row detonation). Scattered type-0 singles, same technique
 * as `colorBombActivateReady`, give the effect more than one place to fire.
 */
const colorBombVsStriped: DebugLayout = {
    cells: (() => {
        const grid = checkerboard(8, 8);
        grid[0][0] = 0;
        grid[2][6] = 0;
        grid[6][1] = 0;
        grid[1][7] = 0;
        grid[4][4] = 4;
        grid[4][5] = 0;
        return grid;
    })(),
    specials: [
        ['4,4', 'color-bomb'],
        ['4,5', 'striped-h'],
    ],
};

/**
 * A Color Bomb at (4,4) next to a wrapped tile at (4,5) — swap them
 * immediately to trigger the combo: every type-0 candy gets a wrapped-style
 * blast (each one double-exploding — see `Board`'s `PendingAction` queue),
 * then once that settles, a second random color gets the same treatment.
 * Scattered type-0 singles give the first wave multiple targets; the second
 * wave's color is chosen at random from whatever's left on the board, so
 * there's nothing to pre-place for it.
 */
const colorBombVsWrapped: DebugLayout = {
    cells: (() => {
        const grid = checkerboard(8, 8);
        grid[0][0] = 0;
        grid[2][6] = 0;
        grid[6][1] = 0;
        grid[1][7] = 0;
        grid[4][4] = 4;
        grid[4][5] = 0;
        return grid;
    })(),
    specials: [
        ['4,4', 'color-bomb'],
        ['4,5', 'wrapped'],
    ],
};

export const debugLayouts: Record<string, DebugLayout> = {
    colorbomb: colorBombReady,
    'colorbomb-beats-wrapped': colorBombBeatsWrapped,
    combo: comboReady,
    'combo-vertical': comboReadyVertical,
    'colorbomb-activate': colorBombActivateReady,
    'colorbomb-colorbomb': colorBombVsColorBomb,
    'colorbomb-striped': colorBombVsStriped,
    'colorbomb-wrapped': colorBombVsWrapped,
    'striped-h-4match': stripedH4Match,
    'striped-v-4match': stripedV4Match,
    'striped-bystander': stripedBystanderCatch,
};
