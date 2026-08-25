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
 *
 * ## Combo test matrix
 *
 * One row per rule in `rules.ts`'s `combos` table, plus the single-special
 * activations they're built out of. Load `?layout=<name>`, make the listed
 * swap, and check the "expect" column — both the cells that clear (the
 * rule) and the effect that plays (the presentation), since those are two
 * separate mechanisms and either can regress without the other.
 *
 * | `?layout=` | swap | expect |
 * | --- | --- | --- |
 * | `striped-h-4match` | (4,2)<->(5,2) | 4-run spawns a **striped-v** at (4,2) — perpendicular to the match |
 * | `striped-v-4match` | (2,2)<->(2,3) | 4-run spawns a **striped-h** at (2,2) |
 * | `colorbomb` | (4,2)<->(5,2) | 5-run spawns a **Color Bomb** at (4,2) |
 * | `colorbomb-beats-wrapped` | (4,2)<->(5,2) | priority check: **Color Bomb**, not Wrapped, despite the crossing 3-run |
 * | `striped-bystander` | (3,2)<->(4,2) | two beats on a still board: row sweep, then the deferred striped-v sweeps its column, and only then the fall |
 * | `wrapped-bystander` | (3,2)<->(4,2) | wrapped caught in a plain match: **3x3** panel, the candy survives, the board falls, then a second 3x3 from where it landed |
 * | `colorbomb-bystander` | (3,2)<->(4,2) | wrapped's 3x3 catches a Color Bomb at (5,1), which fires on the next beat **before any fall** — its own beam, clearing the board's most common color, **not** a plain casualty |
 * | `colorbomb-activate` | (4,4)<->(4,5) | every type-0 candy clears; beam from the bomb's sprite, ring on each target **including the swapped candy** |
 * | `colorbomb-striped` | (4,4)<->(4,5) | every type-0 candy detonates as a stripe, each with **its own random orientation** (rows *and* columns clear) |
 * | `colorbomb-wrapped` | (4,4)<->(4,5) | every type-0 candy 3x3-blasts twice, then a **second random color** does the same |
 * | `colorbomb-colorbomb` | (4,4)<->(4,5) | **whole board** clears under one board-sized flash |
 * | `combo-striped-striped` | (3,3)<->(3,4) | full row 3 + full column 3 (**15 cells**), drawn as one cross of split stripe trails |
 * | `combo-wrapped-wrapped` | (3,3)<->(3,4) | **5x5** (rows 1-5, cols 1-5) panel, then the same 5x5 again one pass later |
 * | `combo-striped-wrapped` | (3,3)<->(3,4) | three beats: 3x3 blast, the candy grows to 3 tiles and sweeps **along its own stripe**, then across it. 39 cells, fired **once**. The giant candy hides for each sweep, returns between them, and never returns after the last |
 * | `combo-vertical` | (3,3)<->(4,3) | same combo as above through a *vertical* swap (different node-relabelling path) |
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

/**
 * Striped-h at (3,3) next to striped-v at (3,4) — swap them to fire the
 * Striped + Striped combo. Deliberately one of each orientation: the combo
 * clears a full row *and* column regardless of what the two tiles' own
 * directions were, so a pair that already points both ways can't accidentally
 * pass a renderer that just draws the participants instead of the cross. The
 * cross centres on the cell you *pressed*, so pressing (3,3) clears row 3 and
 * column 3.
 */
const comboStripedStriped: DebugLayout = {
    cells: (() => {
        const grid = checkerboard(8, 8);
        grid[3][3] = 4;
        grid[3][4] = 5;
        return grid;
    })(),
    specials: [
        ['3,3', 'striped-h'],
        ['3,4', 'striped-v'],
    ],
};

/**
 * Two wrapped tiles at (3,3)/(3,4) — swap them for the 5x5-twice combo.
 * Centred at (3,3) the whole 5x5 (rows 1-5, cols 1-5) lands on-board with
 * nothing clipped, so the blast panel's size can be checked against the grid
 * directly: it must cover five cells across, not the three a single wrapped
 * tile takes.
 */
const comboWrappedWrapped: DebugLayout = {
    cells: (() => {
        const grid = checkerboard(8, 8);
        grid[3][3] = 4;
        grid[3][4] = 5;
        return grid;
    })(),
    specials: [
        ['3,3', 'wrapped'],
        ['3,4', 'wrapped'],
    ],
};

/**
 * A pre-existing wrapped tile at (4,1) inside a would-be 4-match — swap
 * (3,2) <-> (4,2) to complete a plain type-0 match at row 4 that includes the
 * wrapped tile's own cell, so it activates as a caught bystander. The wrapped
 * counterpart to `stripedBystanderCatch`, and the only layout that exercises a
 * *lone* wrapped detonation (every other wrapped scenario here goes through a
 * combo): beat 1 clears the match plus a 3x3 around (4,1) while the wrapped
 * tile itself *stays on the board*, then the board falls, then it explodes a
 * second time from wherever it landed — `rules.activation.wrapped.repeats`,
 * and Candy Crush's "explodes, drops down as board pieces fill in, and
 * explodes a second time". Watch that the second blast is centred on the
 * candy, not on (4,1).
 */
const wrappedBystanderCatch: DebugLayout = {
    cells: (() => {
        const grid = checkerboard(8, 8);
        grid[4] = [0, 0, 1, 0, grid[4][4], grid[4][5], grid[4][6], grid[4][7]];
        grid[3][2] = 0;
        return grid;
    })(),
    specials: [
        ['4,1', 'wrapped'],
    ],
};

/**
 * Same board/swap as `wrappedBystanderCatch`, plus a Color Bomb at (5,1)
 * sitting inside the wrapped tile's 3x3 blast at (4,1) — swap (3,2)<->(4,2)
 * exactly as before. Verifies a passively-caught Color Bomb explodes like a
 * Color Bomb (hunts the board's most common color and clears it, firing its
 * own beam) instead of vanishing as a plain casualty of the wrapped blast —
 * see AGENTS.md's `chainsWhenCaught` note and `Board._expandCaughtColorBomb`.
 *
 * - Beat 1: the match clears, and the wrapped tile at (4,1) — directly part
 *   of the matched run — fires its first 3x3, which reaches (5,1) but only
 *   *reveals* the bomb there (a different special, not part of the original
 *   matched snapshot) — deferred to the next beat, same as any other
 *   newly-revealed special.
 * - Beat 2, on a board that has **not** moved: the deferred Color Bomb fires
 *   from (5,1), beam and all, and clears whichever color has the most tiles
 *   left. This is the case the whole blast-before-gravity ordering exists for
 *   — when gravity ran between the beats instead, the bomb dropped a row out
 *   from under its own queued detonation and silently never went off.
 * - Then the fall, and only then the wrapped tile's second 3x3 (`repeats`),
 *   fired from wherever the candy landed rather than from (4,1).
 */
const colorBombBystanderCatch: DebugLayout = {
    cells: (() => {
        const grid = checkerboard(8, 8);
        grid[4] = [0, 0, 1, 0, grid[4][4], grid[4][5], grid[4][6], grid[4][7]];
        grid[3][2] = 0;
        return grid;
    })(),
    specials: [
        ['4,1', 'wrapped'],
        ['5,1', 'color-bomb'],
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
    'wrapped-bystander': wrappedBystanderCatch,
    'colorbomb-bystander': colorBombBystanderCatch,
    'combo-striped-striped': comboStripedStriped,
    'combo-wrapped-wrapped': comboWrappedWrapped,
    // Same layout as `combo`, under the name the combo test matrix uses.
    'combo-striped-wrapped': comboReady,
};
