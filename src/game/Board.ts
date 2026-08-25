/**
 * Theme-agnostic match-3 board model (see AGENTS.md's config-driven rule) —
 * pure grid state and logic, no rendering, no NoonEngine imports. `rules.ts`
 * supplies board size, what counts as a match, which special each match
 * shape creates (`rules.spawn`, priority-ordered), what each special does
 * when it goes off (`rules.activation`), and what a swap of two specials
 * does (`rules.combos`, also priority-ordered); `theme.ts` supplies only the
 * tile-type count (`tileTypes.length`) — nothing here reads a sprite key, a
 * color, or any other visual/audio value.
 *
 * The division of labour is deliberate and worth keeping: this file owns
 * *how* a rule is carried out — scanning the grid for runs, phasing chain
 * reactions across `resolve()` calls so they read as separate beats, gravity
 * and refill — and never *which* rule wins or what area a special clears.
 * Every such decision is a lookup in `rules.ts`. Adding a special kind, or
 * retuning which shape beats which, should mean editing `rules.ts` only.
 *
 * ## The order of operations
 *
 * Timing is a rule too, and Candy Crush's is specific: **a blast chain
 * resolves completely on a still board, and only then does anything fall.**
 * Detonate a striped candy into a wrapped candy and the wrapped goes off a
 * beat later with nothing yet having moved. Gravity is the boundary between
 * "this explosion finished resolving" and "the board settles and we look for
 * new matches", which makes the loop nested rather than flat:
 *
 * ```
 * MOVE
 * ├─ combo pair? → activateSpecialSwap() seeds the blast
 * │  else        → hasAnyMatch(); no match = revert, move over
 * └─ CASCADE LOOP
 *    ├─ BLAST LOOP                       ← no gravity anywhere inside
 *    │    resolve()  beat 0: matched runs clear, specials spawn
 *    │    resolve()  beat 1: specials caught by beat 0 detonate
 *    │    resolve()  beat 2: specials caught by beat 1 detonate
 *    │    …while hasQueuedBlast(), i.e. until a beat catches nothing new
 *    ├─ settle()                         ← gravity + refill, once
 *    └─ resolve()   post-gravity: `_spent` repeats + `_settledQueue`
 *                   + any new match the fall created → loop, else move ends
 * ```
 *
 * `resolve()` therefore does **not** run gravity — `settle()` does, and the
 * caller (`BoardView._runCascade`) drives the two in that order. Getting this
 * wrong is not a cosmetic bug: a chain reaction deliberately defers a caught
 * special to the next beat by board position (`PendingAction`'s `'activate'`),
 * so letting gravity run in between invalidates every one of those positions
 * and the deferred detonation silently vanishes — which is exactly what used
 * to happen when a Color Bomb was caught in a striped candy's blast.
 */

import { theme } from '../config/theme';
import { rules, AreaSpec, SpecialKind, SpawnRule, FindComboRule } from '../config/rules';

export type { SpecialKind };

/** Sentinel `cells[r][c]` value for a `colorless` special (the Color Bomb) — must never equal a real 0..typeCount-1 id or `EMPTY_TYPE_ID`, or it could accidentally join/avoid a normal color run. */
const COLORLESS_TYPE_ID = -2;
/** Sentinel `cells[r][c]` value for a cleared cell awaiting the next `settle()`. Holes are visible to every scan between a `resolve()` and the fall that fills them, so nothing may treat this as a color. */
const EMPTY_TYPE_ID = -1;

export interface CellPos {
    r: number;
    c: number;
}

/** One column's post-clear gravity result: which surviving tile lands where, and which rows spawn fresh. */
export interface ColumnMove {
    col: number;
    fromRow: number | null; // null = freshly spawned, not a surviving tile
    toRow: number;
    typeId: number;
    special: SpecialKind | null;
}

/** A straight same-color run found by `_findRuns`. */
interface Run {
    cells: CellPos[];
    typeId: number;
    orientation: 'h' | 'v';
}

/** One special detonating, as reported back to the renderer. */
interface ActivatedSpecial {
    r: number;
    c: number;
    kind: SpecialKind;
    typeId: number;
    /** Which beat of a staggered detonation this belongs to — see `ResolveResult.cleared`'s `wave`. `0` for everything that goes off at once. */
    wave: number;
}

/**
 * A detonation queued to fire on a later `resolve()` call rather than in the
 * phase that discovered it — what turns a chain reaction into a sequence of
 * visible beats instead of one flattened blast.
 *
 * Which queue an action goes into is the whole timing model, and the two are
 * *not* interchangeable (see `Board`'s class doc for the full sequence):
 *
 * - `_blastQueue` — fires on the very next `resolve()`, with the board still
 *   **frozen**: no gravity, no refill, nothing has moved. This is where a
 *   `'activate'` goes, and it's why its `(r, c)` is trustworthy — the tile it
 *   names cannot have gone anywhere in between. Candy Crush resolves a whole
 *   blast chain on a still board, then drops everything at once.
 * - `_settledQueue` — fires on the first `resolve()` *after* `settle()`, i.e.
 *   after the fall. Only genuinely post-gravity effects belong here: a
 *   combo's `repeat` and its `colorSweepAfter`.
 *
 * A `'burst'` is deliberately *positional* — it re-detonates a fixed area at
 * a fixed board cell, whatever has since fallen into it, which is what a
 * Wrapped + Wrapped combo's second 5x5 at the blast site actually does.
 * Tile-bound repeats (`rules.activation[].repeats`) are emphatically *not*
 * modelled this way: they ride with the tile through gravity as `_spent`
 * entries instead, so a Wrapped Candy's second explosion follows the candy
 * down instead of firing at the square it used to occupy.
 */
type PendingAction =
    /** A fixed area re-detonating at a fixed board position, reported as the special `reportAs`. */
    | { kind: 'burst'; r: number; c: number; area: AreaSpec; reportAs: SpecialKind }
    /**
     * A specific bystander special discovered mid-chain this phase, but deliberately left
     * uncleared (see `_expandCaught`'s doc) so it's still there next `resolve()` call.
     * Queued on `_blastQueue`, so it drains against a board that has not moved and its
     * `(r,c)` still names the same tile; a no-op if something else cleared it first.
     */
    | { kind: 'activate'; r: number; c: number }
    /** Pick a random color other than `excludeTypeId`, then detonate every tile of it as the special `as`. */
    | { kind: 'colorSweep'; excludeTypeId: number; as: SpecialKind };

/**
 * A special that has already fired once and is *still on the board*, owing
 * more detonations — Candy Crush's Wrapped Candy, which "explodes, drops down
 * as board pieces fill in, and explodes a second time".
 *
 * Held as board state keyed by cell rather than as a queued action, and
 * carried through gravity by `_collapseAndRefill` alongside `specials`, which
 * is precisely what makes the second explosion follow the *candy*: it lands
 * wherever the candy lands. It also marks the tile as already-spent, so a
 * later blast catching it doesn't set it off again — two adjacent Wrapped
 * Candies would otherwise keep re-triggering each other forever, each
 * surviving its own blast only to be re-caught by the other's.
 */
interface SpentSpecial {
    kind: SpecialKind;
    /** Detonations still owed. Reaching `0` is what finally clears the tile. */
    remaining: number;
    /** The color it detonates as — its own, captured before any of this. */
    typeId: number;
}

export interface ResolveResult {
    /**
     * Cells cleared this pass (plain clears + special-detonation cells),
     * before gravity. `typeId` is captured from `cells[r][c]` right before
     * it's blanked to `-1` — same "capture before mutation" rule `spawned`
     * already follows, since callers (collect-mode target tracking) need to
     * know what color/type each cleared cell actually was.
     */
    cleared: {
        r: number;
        c: number;
        typeId: number;
        /**
         * Which beat of a staggered detonation cleared this cell. A Color
         * Bomb combo converts a whole color and the converted candies then go
         * off *in sequence*, radiating out from the bomb, rather than in one
         * instant — so each detonation gets a wave index and every cell it
         * claims inherits it (the lowest, if two claim the same cell). `0`
         * everywhere else, which is every cell clearing at once.
         */
        wave: number;
    }[];
    /**
     * Newly created special tiles this pass, placed at their spawn cell (not
     * cleared). `typeId` is captured at spawn time and is not meant to be
     * re-read from `cells[r][c]` afterward — the next `settle()` can move the
     * spawned tile to a different row, and whatever falls into its old (r,c)
     * would then silently masquerade as the special's own color.
     */
    spawned: { r: number; c: number; special: SpecialKind; typeId: number }[];
    /**
     * Every special that actually detonated this pass — a bystander caught
     * in `_catchBystanders`'s chain reaction, or the deliberate swap
     * participants in `activateSpecialSwap` — each with position/kind/color
     * captured before its cell is cleared. Lets a renderer play a distinct
     * effect per special kind without guessing from `cleared` alone.
     */
    activatedSpecials: ActivatedSpecial[];
    /**
     * Set only when a combo rule with `beam: true` fired against one target
     * color this pass (not a whole-board clear, which has no single target
     * color) — lets a renderer draw a "lightning" from the bomb to every cell
     * of that color.
     */
    colorBombBeam: {
        /** Every cell a bolt fires *from* — one per Color Bomb involved (`ComboRule.beamFromBothSides` makes it two). */
        origins: CellPos[];
        /** The color being hunted, or the colorless sentinel for a combo with no single target color. */
        targetTypeId: number;
        /** `true` = the renderer should time each bolt to its target's `wave` rather than firing them all at once. */
        sweep: boolean;
        /** Every cell a bolt reaches, with the detonation beat it belongs to (see `cleared`'s `wave`). */
        cells: { r: number; c: number; wave: number }[];
    } | null;
    /**
     * Cells whose tile was *consumed* by a combo rather than detonated — the
     * special swapped into a Color Bomb (`ComboRule.partnerConsumed`). They're
     * in `cleared` like any other cell, but listed separately because they
     * come off the board on a different beat: the swap registers their color
     * and they vanish immediately, *before* the bomb's beam goes out, rather
     * than waiting for the detonation everything else is timed to.
     */
    consumed: CellPos[];
    /**
     * A combo's own blast, when its rule asked to be presented as one shape
     * (`presentAsBlast`) rather than as its two participants' individual
     * activations — the cleared `area`, where it's centred, and the color to
     * draw it in. Lets a renderer draw the cross / 5x5 / 3-wide cross that's
     * actually clearing, instead of inferring it from whichever two specials
     * happened to be swapped. `typeId` may be the colorless sentinel (a Color
     * Bomb + Color Bomb whole-board clear has no tile color of its own).
     */
    comboBlast: {
        r: number;
        c: number;
        typeId: number;
        /** The participant kind whose art stands for this combo (the striped half of a Striped + Wrapped), or `null` if neither side has one to show. */
        kind: SpecialKind | null;
        /**
         * The shapes this combo clears, in order. One entry for an ordinary
         * combo; a `stagedAreas` rule gives one per beat, each with the `wave`
         * its cells were stamped with, so a renderer can draw them in the same
         * sequence the board clears in.
         */
        stages: { area: AreaSpec; wave: number }[];
    } | null;
    /** Score awarded for this beat alone, including `rules.scoring`'s cascade multiplier and special-creation bonuses. */
    scoreDelta: number;
}

/**
 * A hand-authored board state for manual testing — a fixed starting layout
 * instead of `_generateNoInitialMatches()`'s random one, so a scenario that's
 * rare to hit by chance (a swap away from a 5-match, two specials already
 * adjacent) is there every time the page loads instead of requiring luck or
 * a long random sweep. See `debugLayouts.ts` and AGENTS.md's "Real Candy
 * Crush reference" section (the standalone `Board`-model testing approach)
 * for why this exists — this is that same idea, wired into the live game
 * instead of a throwaway script.
 */
export interface DebugLayout {
    /** Same shape as `Board.cells` — `rows` arrays of `cols` tile-type ids. Not checked for pre-existing matches; a debug layout is allowed to already contain one. A cell carrying a `colorless` special is overwritten with the sentinel id by the constructor, so a layout can put any placeholder there. */
    cells: number[][];
    /** Initial specials, as `[key, kind]` pairs (`key` = `"r,c"`, matching `Board`'s own internal key format). */
    specials?: [string, SpecialKind][];
}

export class Board {
    readonly rows: number;
    readonly cols: number;
    readonly typeCount: number;

    /** cells[r][c] = tile-type id. Row 0 is the top row. */
    cells: number[][] = [];
    /** "r,c" -> special kind, for cells currently holding a special tile. */
    specials: Map<string, SpecialKind> = new Map();
    /**
     * Detonations owed on the next `resolve()`, with the board still frozen —
     * the next beat of the current blast chain. See `PendingAction`.
     */
    private _blastQueue: PendingAction[] = [];
    /**
     * Detonations owed on the first `resolve()` *after* `settle()` — effects
     * that are meant to happen once the board has fallen. `settle()` moves
     * these onto `_blastQueue`. See `PendingAction`.
     */
    private _settledQueue: PendingAction[] = [];
    /**
     * "r,c" -> a special that has fired once and is still standing, owing
     * more blasts. Board state, not a queue: `_collapseAndRefill` carries
     * these down with the tile, so the second explosion lands wherever the
     * candy lands. See `SpentSpecial`.
     */
    private _spent: Map<string, SpentSpecial> = new Map();
    /**
     * `true` once `settle()` has run and the tiles in `_spent` are due to fire
     * again — cleared by the `resolve()` that fires them. Without this gate a
     * Wrapped Candy's second blast would follow its first on the very next
     * beat, with no fall in between, which is the one thing the real game's
     * "explodes, drops down as board pieces fill in, and explodes a second
     * time" explicitly is not.
     */
    private _repeatsDue = false;
    /**
     * Cells that detonated during the beat currently being resolved but are
     * *not* to be cleared by it — a special that survives its own blast
     * because it still owes repeats (see `_spendDetonation`). `_finalizeClear`
     * subtracts these from `toClear` as the last act of the beat, so a
     * survivor is protected from everything in its own beat, its own area
     * included; only a later beat's blast can take it.
     *
     * Phase-scoped, like the beat's `toClear`: reset at the top of every
     * `resolve()`/`activateSpecialSwap()` and consumed by the
     * `_finalizeClear` that ends it. It lives here rather than being threaded
     * through every `_expandCaught`/`_detonateAt` call for the same reason
     * `_blastQueue` does — every one of those methods already writes to
     * phase state on `this`.
     */
    private _survivors: Set<string> = new Set();
    /**
     * Every cell that has already detonated during the beat being resolved,
     * whatever found it — a queued repeat coming due, a deferred catch, a
     * bystander swept up by someone else's blast. One cell, one detonation
     * per beat.
     *
     * Not redundant with the local `seen` sets: those are scoped to a single
     * `_drainPending`/`_catchBystanders` call, and a beat runs both. A Wrapped
     * Candy firing its final blast in `_drainPending` clears its `_spent`
     * entry as it goes, so `_catchBystanders` — which reads the same cell out
     * of `toClear` moments later and still finds a registered special there —
     * would happily set it off a second time, and each of those would leave a
     * fresh repeat owed: the candy never died and marched down its column
     * exploding on every fall, forever.
     *
     * Phase-scoped like `_survivors`, reset by the `resolve()` that opens the
     * beat.
     */
    private _fired: Set<string> = new Set();
    /** How many falls have settled since `beginMove()` — indexes `rules.scoring.cascadeMultipliers`. */
    private _cascadeStep = 0;
    /** `rules.spawn`, highest priority first — sorted once, since the rule table never changes at runtime. */
    private readonly _spawnRules: SpawnRule[] = [...rules.spawn].sort((a, b) => b.priority - a.priority);

    constructor(debugLayout?: DebugLayout) {
        this.rows = rules.board.rows;
        this.cols = rules.board.cols;
        this.typeCount = theme.tileTypes.length;
        if (debugLayout) {
            this.cells = debugLayout.cells.map(row => row.slice());
            this.specials = new Map(debugLayout.specials ?? []);
            // A seeded colorless special (a pre-placed Color Bomb) must hold
            // the sentinel id exactly like one the game spawned itself —
            // otherwise it carries a real color into every color comparison
            // (`_findRuns`, a combo's target color) and a debug layout stops
            // testing the same code path the live game runs.
            for (const [key, kind] of this.specials) {
                if (!rules.activation[kind].colorless) continue;
                const [r, c] = Board.parseKey(key);
                this.cells[r][c] = COLORLESS_TYPE_ID;
            }
        } else {
            this._generateNoInitialMatches();
        }
    }

    private static key(r: number, c: number): string {
        return `${r},${c}`;
    }

    private static parseKey(key: string): [number, number] {
        const [r, c] = key.split(',').map(Number);
        return [r, c];
    }

    private _randomType(): number {
        return Math.floor(Math.random() * this.typeCount);
    }

    private _generateNoInitialMatches(): void {
        for (let r = 0; r < this.rows; r++) {
            this.cells[r] = [];
            for (let c = 0; c < this.cols; c++) {
                let t: number;
                do {
                    t = this._randomType();
                } while (this._createsMatchAt(r, c, t));
                this.cells[r][c] = t;
            }
        }
    }

    /** True if placing `t` at (r,c) would complete a `rules.matching.minMatchLength`+ run with already-placed cells to its left/above. */
    private _createsMatchAt(r: number, c: number, t: number): boolean {
        const need = rules.matching.minMatchLength - 1;
        let left = 0;
        for (let cc = c - 1; cc >= 0 && this.cells[r][cc] === t; cc--) left++;
        if (left >= need) return true;
        let up = 0;
        for (let rr = r - 1; rr >= 0 && this.cells[rr][c] === t; rr--) up++;
        if (up >= need) return true;
        return false;
    }

    /**
     * True if whatever special sits at `key` has already had its turn: it went
     * off earlier in this same beat (`_fired`), or it went off in an earlier
     * beat and is merely waiting out a repeat (`_spent`). Either way it is not
     * a fresh domino, and every catch path has to agree on that — otherwise a
     * Wrapped Candy is re-triggered by the very blast it just fired, or by a
     * neighbour it just woke, and never finishes dying.
     */
    private _hasHadItsTurn(key: string): boolean {
        return this._fired.has(key) || this._spent.has(key);
    }

    /** True only for a real tile-type id — not a Color Bomb's colorless sentinel, and not a cleared cell waiting on the next `settle()`. */
    private _isColor(typeId: number): boolean {
        return typeId >= 0 && typeId < this.typeCount;
    }

    inBounds(r: number, c: number): boolean {
        return r >= 0 && r < this.rows && c >= 0 && c < this.cols;
    }

    isAdjacent(r1: number, c1: number, r2: number, c2: number): boolean {
        return Math.abs(r1 - r2) + Math.abs(c1 - c2) === 1;
    }

    swap(r1: number, c1: number, r2: number, c2: number): void {
        const tmp = this.cells[r1][c1];
        this.cells[r1][c1] = this.cells[r2][c2];
        this.cells[r2][c2] = tmp;

        const k1 = Board.key(r1, c1);
        const k2 = Board.key(r2, c2);
        const s1 = this.specials.get(k1);
        const s2 = this.specials.get(k2);
        this.specials.delete(k1);
        this.specials.delete(k2);
        if (s2) this.specials.set(k1, s2);
        if (s1) this.specials.set(k2, s1);
    }

    hasAnyMatch(): boolean {
        return this._findRuns().length > 0;
    }

    /** The special (if any) currently sitting at (r,c) — read this *before* `swap()` if you need to know what was there pre-swap. */
    getSpecialAt(r: number, c: number): SpecialKind | null {
        return this.specials.get(Board.key(r, c)) ?? null;
    }

    /**
     * Whether swapping a `k1` tile with a `k2` tile is a combo — an effect
     * that fires unconditionally, ignoring color matching, and never reverts.
     * Straight from `rules.combos`, so the view layer's "can this swap
     * revert?" decision and the model's "what does it do?" decision can never
     * disagree about which pairs count.
     */
    static swapActivates(k1: SpecialKind | null, k2: SpecialKind | null): boolean {
        return FindComboRule(k1, k2) !== null;
    }

    /**
     * Resets the cascade counter that drives `rules.scoring.cascadeMultipliers`.
     * Call once per player move, before the first `resolve()`/`activateSpecialSwap()`
     * of that move — otherwise every pass keeps escalating for the whole game.
     */
    beginMove(): void {
        this._cascadeStep = 0;
        // A completed cascade always drains itself dry, so these should
        // already be empty — reset them anyway rather than let one stray beat
        // from a previous move fire against a board the player has since
        // changed.
        this._blastQueue = [];
        this._settledQueue = [];
        this._spent.clear();
        this._repeatsDue = false;
    }

    private _findRuns(): Run[] {
        const runs: Run[] = [];

        for (let r = 0; r < this.rows; r++) {
            let c = 0;
            while (c < this.cols) {
                const t = this.cells[r][c];
                // Only real colors can run. A Color Bomb's cell holds
                // COLORLESS_TYPE_ID and a cleared cell holds EMPTY_TYPE_ID,
                // and neither is a color — two or more sitting adjacent must
                // not be read as a run of matching "color", or the spawn it
                // triggers would carry the sentinel as its typeId.
                //
                // The empty case is live during a blast chain, not just a
                // theoretical guard: `resolve()` blanks cells and leaves them
                // blank until `settle()` runs, so mid-chain beats scan a board
                // full of holes. Without this, three cells cleared in a row
                // read as a three-match of nothing, and an L of them spawned a
                // Wrapped Candy whose color was the sentinel.
                if (!this._isColor(t)) { c++; continue; }
                let end = c;
                while (end + 1 < this.cols && this.cells[r][end + 1] === t) end++;
                if (end - c + 1 >= rules.matching.minMatchLength) {
                    const cells: CellPos[] = [];
                    for (let cc = c; cc <= end; cc++) cells.push({ r, c: cc });
                    runs.push({ cells, typeId: t, orientation: 'h' });
                }
                c = end + 1;
            }
        }

        for (let c = 0; c < this.cols; c++) {
            let r = 0;
            while (r < this.rows) {
                const t = this.cells[r][c];
                if (!this._isColor(t)) { r++; continue; }
                let end = r;
                while (end + 1 < this.rows && this.cells[end + 1][c] === t) end++;
                if (end - r + 1 >= rules.matching.minMatchLength) {
                    const cells: CellPos[] = [];
                    for (let rr = r; rr <= end; rr++) cells.push({ r: rr, c });
                    runs.push({ cells, typeId: t, orientation: 'v' });
                }
                r = end + 1;
            }
        }

        return runs;
    }

    /** Highest-priority `rules.spawn` rule whose `'line'` pattern fits this run, or `null` if it just clears. */
    private _lineRule(run: Run): SpawnRule | null {
        for (const rule of this._spawnRules) {
            if (rule.pattern.type !== 'line') continue;
            const len = run.cells.length;
            if (len < rule.pattern.minLength) continue;
            if (rule.pattern.maxLength !== undefined && len > rule.pattern.maxLength) continue;
            return rule;
        }
        return null;
    }

    /** Highest-priority `rules.spawn` rule whose `'intersection'` pattern fits this crossing pair, or `null`. */
    private _intersectionRule(h: Run, v: Run): SpawnRule | null {
        for (const rule of this._spawnRules) {
            if (rule.pattern.type !== 'intersection') continue;
            const minArm = rule.pattern.minArmLength ?? rules.matching.minMatchLength;
            if (h.cells.length < minArm || v.cells.length < minArm) continue;
            return rule;
        }
        return null;
    }

    /** A rule's priority, or `-1` for "no rule fits" — so a plain 3-run always loses a conflict to any rule that does fit. */
    private static _priorityOf(rule: SpawnRule | null): number {
        return rule ? rule.priority : -1;
    }

    /** Resolves a rule's `creates` against the matched run's direction — see `SpawnCreates`'s doc for the perpendicular rule. */
    private static _createdKind(rule: SpawnRule, orientation: 'h' | 'v'): SpecialKind {
        if (rule.creates === 'striped-perpendicular') return orientation === 'h' ? 'striped-v' : 'striped-h';
        if (rule.creates === 'striped-aligned') return orientation === 'h' ? 'striped-h' : 'striped-v';
        return rule.creates;
    }

    /**
     * Resolves **one beat** of the board: every currently-matched run into
     * clears + special spawns, plus whatever the previous beat queued, plus
     * any special caught in the blast. Deliberately does *not* run gravity —
     * that's `settle()`, and see this file's "The order of operations" for why
     * the two are separate calls and which order to drive them in.
     *
     * The caller loops: `resolve()` while `hasQueuedBlast()` (the chain
     * reaction, board frozen), then `settle()`, then `resolve()` again for the
     * post-fall beat, until a `resolve()` clears nothing.
     *
     * Which special a given match makes — and which of two crossing matches
     * wins when they can't both spawn — comes entirely from `rules.spawn`'s
     * priorities; see `_resolveCrossing` for how a conflict is settled.
     *
     * @param preferredCells Where a spawned special should appear if it's
     * part of the qualifying run — the swap destination(s), matching real
     * Candy Crush (the special appears where the player moved a tile to, not
     * the run's middle). Pass nothing for cascade-triggered passes, which
     * have no swap to prefer.
     */
    resolve(preferredCells?: CellPos[]): ResolveResult {
        this._survivors.clear();
        this._fired.clear();
        // Whatever the previous beat deferred (a caught special left standing
        // so it reads as its own beat), plus — only on the first beat after a
        // `settle()` — every tile that owes a repeat and the post-fall actions
        // `settle()` handed over.
        const { toClear: forcedClear, activated: forcedActivated, colorBombBeam: forcedBeam } = this._drainPending();

        const runs = this._findRuns();
        if (runs.length === 0 && forcedClear.size === 0 && this._survivors.size === 0) {
            return { cleared: [], spawned: [], activatedSpecials: [], colorBombBeam: null, comboBlast: null, consumed: [], scoreDelta: 0 };
        }

        const toClear = forcedClear;
        const spawned: { r: number; c: number; special: SpecialKind; typeId: number }[] = [];

        /**
         * Records a new spawn and — critically — registers it into
         * `this.specials` immediately, *before* `_catchBystanders` runs
         * below, not after. This is what makes a newly created special
         * behave correctly if another effect in this same pass (e.g. a
         * bystander special elsewhere in this same run) ends up touching its
         * cell: `_catchBystanders`/`_expandCaught` treat anything they find
         * in `this.specials` as a caught special regardless of when it was
         * registered, so the new one gets swept into the same "caught
         * bystander" handling as any other — destroyed immediately if it's
         * part of the *original* snapshot (e.g. the bystander sits in the
         * same matched run), or left untouched and deferred to its own next-
         * phase beat otherwise — matching real Candy Crush's behavior of
         * destroying (not protecting) a newly created special caught by
         * another special's explosion, never in a single flattened instant.
         * If its cell is never touched at all, this registration is simply
         * its permanent one.
         */
        const registerSpawn = (r: number, c: number, special: SpecialKind, typeId: number): void => {
            spawned.push({ r, c, special, typeId });
            this.specials.set(Board.key(r, c), special);
            // A colorless special's cell must stop carrying a real color the
            // moment it exists, not later — `_findRuns` on the very next pass
            // would otherwise happily run a color match straight through it.
            if (rules.activation[special].colorless) this.cells[r][c] = COLORLESS_TYPE_ID;
        };

        const hRuns = runs.filter(r => r.orientation === 'h');
        const vRuns = runs.filter(r => r.orientation === 'v');
        /** v-runs already merged into a crossing spawn — they must not also resolve on their own. */
        const consumedV = new Set<number>();
        /**
         * A run that loses a priority conflict (see `_resolveCrossing`) is
         * added here, not to `toClear` — it's left completely untouched this
         * phase, exactly as if it never matched at all. Whatever's left of
         * it (minus whatever the winning run's own clear happens to take)
         * sits on the board through gravity/refill and gets a fresh,
         * unbiased look from `_findRuns()` on the *next* `resolve()` call —
         * rather than this phase guessing whether some sub-segment of the
         * stale, pre-clear run is still a genuine match, which it may not be
         * once the shared cell is gone. `hRuns` never needs the same
         * treatment: a losing h-run just falls through to its own line rule
         * below, which independently decides its own fate without knowing
         * about `v` at all.
         */
        const skippedV = new Set<number>();

        for (const h of hRuns) {
            let resolved = false;
            for (let vi = 0; vi < vRuns.length; vi++) {
                if (consumedV.has(vi) || skippedV.has(vi)) continue;
                const v = vRuns[vi];
                if (v.typeId !== h.typeId) continue;
                const crossing = h.cells.find(hc => v.cells.some(vc => vc.r === hc.r && vc.c === hc.c));
                if (!crossing) continue;
                resolved = this._resolveCrossing(h, v, vi, crossing, toClear, consumedV, skippedV, registerSpawn);
                break; // only one crossing partner considered per run
            }
            if (resolved) continue;
            this._resolveLineRun(h, toClear, preferredCells, registerSpawn);
        }

        vRuns.forEach((v, vi) => {
            if (consumedV.has(vi) || skippedV.has(vi)) return;
            this._resolveLineRun(v, toClear, preferredCells, registerSpawn);
        });

        // A spawn cell is protected from `toClear` at the moment it's chosen
        // above, but a *different*, un-merged crossing run sharing that same
        // cell (the exact case a priority conflict can produce — a
        // higher-priority run and a shorter perpendicular one crossing at one
        // cell) processes independently afterward and would otherwise re-add
        // it via its own plain `toClear.add(cell)` loop, silently erasing the
        // special the instant it's created. Re-asserting every spawn's
        // protection here, after both loops have fully run, guarantees it
        // sticks regardless of processing order.
        for (const s of spawned) toClear.delete(Board.key(s.r, s.c));

        const { activated: bystanderActivated, colorBombBeam: bystanderBeam } = this._catchBystanders(toClear);
        const activatedSpecials = [...forcedActivated, ...bystanderActivated];

        return this._finalizeClear(toClear, activatedSpecials, forcedBeam ?? bystanderBeam, spawned);
    }

    /**
     * `true` while the current blast chain still owes a beat — a special that
     * another special's blast caught and that was deliberately left standing
     * so it reads as its own explosion.
     *
     * The cascade driver must keep calling `resolve()` while this is true and
     * only `settle()` once it goes false. That ordering is the rule, not an
     * optimisation: every queued beat names a board cell, and those cells mean
     * what they say precisely because nothing has fallen yet.
     */
    hasQueuedBlast(): boolean {
        return this._blastQueue.length > 0;
    }

    /**
     * Ends the blast phase: gravity + refill in one go, exactly as the real
     * game does it — the whole chain reaction has finished on a still board,
     * and now everything drops at once.
     *
     * Also the moment the post-fall work comes due: `_settledQueue` (a combo's
     * second blast at the site, its second-colour sweep) moves onto
     * `_blastQueue`, and every tile still owing a repeat is marked due, so the
     * very next `resolve()` fires them from wherever they landed. The cascade
     * multiplier advances here too — one step per *fall*, which is what a
     * cascade level actually is, rather than one per beat of a single chain.
     *
     * @returns One entry per tile that actually moved or spawned; empty if the
     * board had no holes to fill, which is how the driver knows there's no
     * fall to animate.
     */
    settle(): ColumnMove[] {
        const moves = this._collapseAndRefill();
        if (moves.length > 0) this._cascadeStep++;
        // Positional by design and deliberately *not* remapped through the
        // fall: `'burst'` names a board square that explodes again (a Wrapped +
        // Wrapped combo's second 5x5 at the blast site), and `'colorSweep'`
        // names a colour, not a place. Anything that has to follow a *tile*
        // through gravity lives in `_spent`, which `_collapseAndRefill`
        // re-keys, never here.
        this._blastQueue.push(...this._settledQueue);
        this._settledQueue = [];
        this._repeatsDue = this._spent.size > 0;
        return moves;
    }

    /**
     * Settles two same-color runs crossing at one cell, by `rules.spawn`
     * priority — the "which rule wins" question, in one place:
     *
     * - The crossing rule (wrapped, by default) wins ties and merges both
     *   runs into one spawn at the crossing cell.
     * - A single arm's own line rule outranking it (a 5-run Color Bomb
     *   beating the L-shape it happens to cross) takes the arm alone and
     *   leaves the *other* arm completely untouched this phase — see
     *   `skippedV`'s doc for why untouched rather than cleared.
     * - Two arms tying above the crossing rule (both Color-Bomb-worthy) each
     *   resolve independently; `_pickSpawnCell`'s already-special check keeps
     *   their two spawns off the same cell.
     *
     * Returns whether `h` was fully dealt with here (merged, or skipped as
     * the loser) — `false` means the caller should still resolve `h` on its
     * own.
     */
    private _resolveCrossing(
        h: Run,
        v: Run,
        vi: number,
        crossing: CellPos,
        toClear: Set<string>,
        consumedV: Set<number>,
        skippedV: Set<number>,
        registerSpawn: (r: number, c: number, special: SpecialKind, typeId: number) => void
    ): boolean {
        const crossRule = this._intersectionRule(h, v);
        const pCross = Board._priorityOf(crossRule);
        const pH = Board._priorityOf(this._lineRule(h));
        const pV = Board._priorityOf(this._lineRule(v));

        if (crossRule && pCross >= pH && pCross >= pV) {
            for (const cell of h.cells) toClear.add(Board.key(cell.r, cell.c));
            for (const cell of v.cells) toClear.add(Board.key(cell.r, cell.c));
            toClear.delete(Board.key(crossing.r, crossing.c));
            registerSpawn(crossing.r, crossing.c, Board._createdKind(crossRule, h.orientation), h.typeId);
            consumedV.add(vi);
            return true;
        }
        if (pH > pV) {
            skippedV.add(vi); // h wins; v is left entirely alone this phase
            return false;
        }
        if (pV > pH) return true; // v wins; h is left entirely alone this phase
        return false; // tie, no winning crossing rule — both arms resolve independently
    }

    /** Clears one straight run, spawning whatever `rules.spawn` says it creates (nothing, for a plain minimum-length run). */
    private _resolveLineRun(
        run: Run,
        toClear: Set<string>,
        preferredCells: CellPos[] | undefined,
        registerSpawn: (r: number, c: number, special: SpecialKind, typeId: number) => void
    ): void {
        const rule = this._lineRule(run);
        if (!rule) {
            for (const cell of run.cells) toClear.add(Board.key(cell.r, cell.c));
            return;
        }
        const spawnAt = this._pickSpawnCell(run.cells, preferredCells);
        for (const cell of run.cells) toClear.add(Board.key(cell.r, cell.c));
        toClear.delete(Board.key(spawnAt.r, spawnAt.c));
        registerSpawn(spawnAt.r, spawnAt.c, Board._createdKind(rule, run.orientation), run.typeId);
    }

    /**
     * Shared tail for both `resolve()` and `activateSpecialSwap()`: releases
     * the beat's survivors, scores, clears cells, drops any spawned special
     * whose cell ended up in `toClear` after all (see `registerSpawn`'s doc —
     * a freshly-spawned special caught within this same phase's own snapshot
     * is destroyed, not protected, matching real Candy Crush), and builds the
     * `ResolveResult`. Runs **no gravity**; that's `settle()`'s job, called by
     * the cascade driver once the whole blast chain is dry.
     */
    private _finalizeClear(
        toClear: Set<string>,
        activatedSpecials: ActivatedSpecial[],
        colorBombBeam: ResolveResult['colorBombBeam'],
        spawned: { r: number; c: number; special: SpecialKind; typeId: number }[] = [],
        comboBlast: ResolveResult['comboBlast'] = null,
        waves: Map<string, number> = new Map(),
        consumed: CellPos[] = []
    ): ResolveResult {
        // A special that fired but still owes repeats stays standing, even if
        // its own area (or another blast this same beat) put it in `toClear`.
        // Applied here, after every contributor to the beat has had its say,
        // for the same reason `spawned`'s protection is re-asserted late:
        // whichever effect claims the cell last must not be the one that
        // decides its fate.
        for (const k of this._survivors) toClear.delete(k);

        const cleared: ResolveResult['cleared'] = [];
        for (const k of toClear) {
            const [r, c] = Board.parseKey(k);
            // Already a hole from an earlier beat of this same chain — the
            // board hasn't fallen yet, so blasts routinely overlap ground that
            // is already gone. Reporting it again would pop a tile that isn't
            // there, score it twice and decrement a collect target twice.
            if (this.cells[r][c] === EMPTY_TYPE_ID) continue;
            cleared.push({ r, c, typeId: this.cells[r][c], wave: waves.get(k) ?? 0 });
            this.cells[r][c] = EMPTY_TYPE_ID;
            this.specials.delete(k);
            // A spent special caught by someone else's blast before it could
            // fire again goes with everything else, and the repeat it owed
            // goes with it — never left behind as a phantom explosion.
            this._spent.delete(k);
        }
        const survivingSpawned = spawned.filter(s => !toClear.has(Board.key(s.r, s.c)));
        const scoreDelta = this._score(toClear.size, survivingSpawned);

        return { cleared, spawned: survivingSpawned, activatedSpecials, colorBombBeam, comboBlast, consumed, scoreDelta };
    }

    /**
     * `rules.scoring`, applied: every cleared cell at `pointsPerTile`, scaled
     * by this move's cascade depth, plus a flat bonus per special created.
     * Reads the cascade counter without advancing it — `settle()` advances it
     * once per *fall*, so a chain reaction's separate beats all score at the
     * same multiplier (they're one cascade level, not several) and
     * `beginMove()` resets it.
     */
    private _score(clearedCount: number, spawned: { special: SpecialKind }[]): number {
        if (clearedCount === 0) return 0;
        const multipliers = rules.scoring.cascadeMultipliers;
        const multiplier = multipliers[Math.min(this._cascadeStep, multipliers.length - 1)] ?? 1;
        let score = Math.round(clearedCount * rules.scoring.pointsPerTile * multiplier);
        for (const s of spawned) score += rules.scoring.specialCreateBonus[s.special] ?? 0;
        return score;
    }

    /**
     * Accounts for one detonation of `kind` at (r,c) and answers the only
     * question that matters to the caller: **which area does this blast
     * clear**. It also decides the tile's own fate, which is the whole of
     * Candy Crush's double-explosion rule:
     *
     * - Nothing owed (`repeats: 0` — stripes, Color Bombs): the tile is spent
     *   the instant it fires and clears with its own area.
     * - Repeats owed (`repeats: 1` — the Wrapped Candy): the tile **survives**
     *   this blast. It's recorded in `_spent`, protected from this beat's
     *   `toClear` via `_survivors`, and stays a registered special so it keeps
     *   its art and rides gravity like any other tile. `settle()` then marks
     *   it due and the next `resolve()` fires it again — "explodes, drops down
     *   as board pieces fill in, and explodes a second time", with the second
     *   explosion following the *candy* rather than the square it started in.
     * - Firing a repeat: the owed count drops, and `repeatArea` (if the rule
     *   gives one) is what goes off this time. Reaching zero clears the tile.
     *
     * Because a surviving tile is left in `_spent`, every catch path treats it
     * as already-spent and will not set it off again — see `_expandCaught`.
     */
    private _spendDetonation(kind: SpecialKind, r: number, c: number, typeId: number): AreaSpec {
        const activation = rules.activation[kind];
        const key = Board.key(r, c);
        const spent = this._spent.get(key);
        this._fired.add(key);
        // Blasts still to come after this one: `repeats` on a first firing,
        // one fewer each time a repeat is spent.
        const remaining = spent ? spent.remaining - 1 : activation.repeats;
        if (remaining > 0) {
            this._spent.set(key, { kind, remaining, typeId });
            this.specials.set(key, kind);
            this._survivors.add(key);
        } else {
            this._spent.delete(key);
        }
        return spent ? (activation.repeatArea ?? activation.area) : activation.area;
    }

    /**
     * Everything owed to *this* beat: the previous beat's deferred catches
     * (`_blastQueue`), and — only on the first beat after a `settle()` — every
     * tile in `_spent` firing again. Resolved into a forced-clear set against
     * the board exactly as it stands now.
     *
     * A `'colorSweep'` re-detonates each swept cell as `as`, so a combo's
     * second wave follows the same detonation (and repeat) rules as any other.
     * `'activate'` runs the caught special through `_expandCaught` the same
     * way `_catchBystanders` does, via a `seen`/`deferred` pair scoped to this
     * one drain call — not a simpler "just dump the whole area in" path — so
     * anything *it* in turn catches defers to yet another beat instead of
     * flattening back into this one.
     */
    private _drainPending(): { toClear: Set<string>; activated: ActivatedSpecial[]; colorBombBeam: ResolveResult['colorBombBeam'] } {
        const toClear = new Set<string>();
        const seen = new Set<string>();
        const deferred = new Set<string>();
        const activated: ActivatedSpecial[] = [];
        let colorBombBeam: ResolveResult['colorBombBeam'] = null;
        const pending = this._blastQueue;
        this._blastQueue = [];

        // The board has fallen, so every tile still owing a blast fires from
        // wherever it landed. Snapshotted first: `_spendDetonation` rewrites
        // `_spent` as it goes.
        if (this._repeatsDue) {
            this._repeatsDue = false;
            for (const [key, owed] of Array.from(this._spent)) {
                const [r, c] = Board.parseKey(key);
                const area = this._spendDetonation(owed.kind, r, c, owed.typeId);
                toClear.add(key);
                seen.add(key);
                for (const cell of this._areaCells(area, r, c, owed.typeId)) {
                    toClear.add(Board.key(cell.r, cell.c));
                }
                activated.push({ r, c, kind: owed.kind, typeId: owed.typeId, wave: 0 });
            }
        }

        for (const action of pending) {
            if (action.kind === 'burst') {
                for (const cell of this._areaCells(action.area, action.r, action.c)) {
                    toClear.add(Board.key(cell.r, cell.c));
                }
                activated.push({ r: action.r, c: action.c, kind: action.reportAs, typeId: this.cells[action.r][action.c], wave: 0 });
            } else if (action.kind === 'activate') {
                const key = Board.key(action.r, action.c);
                const kind = this.specials.get(key);
                // Cleared by something else in the meantime, a kind that never
                // chain-reacts, or a tile that has already fired and is just
                // waiting out its repeat — nothing to do.
                if (!kind || !rules.activation[kind].chainsWhenCaught || this._hasHadItsTurn(key)) continue;
                toClear.add(key);
                seen.add(key);
                activated.push({ r: action.r, c: action.c, kind, typeId: this.cells[action.r][action.c], wave: 0 });
                if (kind === 'color-bomb') {
                    colorBombBeam = colorBombBeam ?? this._expandCaughtColorBomb(action.r, action.c, toClear, seen, deferred);
                } else {
                    this._expandCaught(kind, action.r, action.c, toClear, seen, deferred);
                }
            } else {
                const candidates: number[] = [];
                for (let t = 0; t < this.typeCount; t++) {
                    if (t !== action.excludeTypeId) candidates.push(t);
                }
                if (candidates.length === 0) continue;
                const typeId = candidates[Math.floor(Math.random() * candidates.length)];
                for (const cell of this._sameColorCells(typeId)) {
                    this._detonateAt(action.as, cell.r, cell.c, typeId, toClear, activated);
                }
            }
        }

        return { toClear, activated, colorBombBeam };
    }

    /**
     * Fires `kind`'s own `rules.activation` effect at (r,c) as a flat,
     * non-chaining detonation: its area joins `toClear`, and `_spendDetonation`
     * decides whether the cell itself survives to fire again. Used where a
     * cell is being detonated *as if* it held a special it doesn't actually
     * hold — a combo's `spreadPartnerActivation` and a `colorSweep`'s wave —
     * so unlike `_expandCaught` there's no bystander/defer bookkeeping to do.
     *
     * A Color Bomb + Wrapped swap leans on the survival half of that: every
     * candy of the colour becomes a Wrapped Candy and blasts, the survivors
     * ride the fall, and they all blast a second time. That double wave *is*
     * the combo (see `rules.ts`'s `bomb+wrapped` note), not a bonus colour.
     */
    private _detonateAt(
        kind: SpecialKind,
        r: number,
        c: number,
        typeId: number,
        toClear: Set<string>,
        activated: ActivatedSpecial[],
        wave = 0,
        waves?: Map<string, number>
    ): void {
        const area = this._spendDetonation(kind, r, c, typeId);
        for (const cell of this._areaCells(area, r, c, typeId)) {
            const key = Board.key(cell.r, cell.c);
            toClear.add(key);
            // Lowest wins: a cell in two detonations' paths belongs to
            // whichever goes off first, so it can't pop twice or pop late.
            if (waves && wave < (waves.get(key) ?? Infinity)) waves.set(key, wave);
        }
        activated.push({ r, c, kind, typeId, wave });
    }

    /** Swaps a band's axis — see `ComboRule.orientToPartner`. Anything that isn't a band is returned untouched. */
    private static _flipBand(area: AreaSpec): AreaSpec {
        if (area.shape === 'row-band') return { shape: 'column-band', radius: area.radius };
        if (area.shape === 'column-band') return { shape: 'row-band', radius: area.radius };
        return area;
    }

    /** Chebyshev-ish ordering key: how far a cell is from the combo's origin, for radiating a staggered detonation outward. */
    private static _distanceTo(origin: { r: number; c: number }, cell: CellPos): number {
        return Math.hypot(cell.r - origin.r, cell.c - origin.c);
    }

    /**
     * Which special a `spreadPartnerActivation` cell actually turns into.
     * Only interesting for a striped partner: real Candy Crush gives each
     * converted candy its own orientation (the board ends up crosshatched
     * with row and column clears), so `'random'` coin-flips per cell;
     * `'partner'`/unset copies the swapped tile's own direction for all of
     * them. Anything non-striped is itself either way.
     */
    private _spreadKind(partner: SpecialKind, orientation: 'partner' | 'random' | undefined): SpecialKind {
        if (orientation !== 'random') return partner;
        if (partner !== 'striped-h' && partner !== 'striped-v') return partner;
        return Math.random() < 0.5 ? 'striped-h' : 'striped-v';
    }

    /**
     * Called instead of `resolve()` for a swap whose two sides match a
     * `rules.combos` rule — a Color Bomb on either side, or two non-bomb
     * specials together, by default. These activate unconditionally, match or
     * not, and never revert (candy_crush_rules.md §3's "Swapping Special
     * Candies Together"). A lone striped/wrapped special swapped with a plain
     * candy matches no combo rule and so does *not* come through here — its
     * activation depends on whether/where a match forms, so
     * `BoardView._attemptSwap` routes that case through the normal
     * `swap()`/`hasAnyMatch()`/`resolve()` path instead, where a match run
     * that happens to include the special's cell picks it up for free via
     * `resolve()`'s `_catchBystanders` bystander logic.
     *
     * **The positional swap must already have been applied** (call
     * `board.swap()` first, exactly as the normal match path does). This
     * method then reads both cells as they now stand, so the model and the
     * view agree on which tile is where: the beam fires from the cell the
     * bomb's sprite actually occupies, the partner candy is cleared at the
     * cell its own sprite actually occupies, and every reported
     * position/color lands on the right tile on screen. Running the combo
     * against pre-swap coordinates instead is what used to leave the swapped
     * candy visually untouched — no beam, no burst — while every other tile
     * of its color detonated around it.
     */
    activateSpecialSwap(r1: number, c1: number, r2: number, c2: number): ResolveResult {
        this._survivors.clear();
        this._fired.clear();
        const k1 = this.getSpecialAt(r1, c1);
        const k2 = this.getSpecialAt(r2, c2);
        const toClear = new Set<string>([Board.key(r1, c1), Board.key(r2, c2)]);
        const activated: ActivatedSpecial[] = [];
        /** Per-cell detonation beat, for a combo that goes off in sequence rather than all at once — see `ResolveResult.cleared`'s `wave`. */
        const waves = new Map<string, number>();
        /** The swapped special a `partnerConsumed` rule takes off the board up front — see `ResolveResult.consumed`. */
        const consumed: CellPos[] = [];
        let colorBombBeam: ResolveResult['colorBombBeam'] = null;
        let comboBlast: ResolveResult['comboBlast'] = null;

        const combo = FindComboRule(k1, k2);
        if (combo) {
            // `a` is the side the rule centres its effect on (the beam's
            // origin), `b` the side supplying the trigger color — see
            // `ComboRule.match`'s doc.
            const a = combo.firstIsA ? { r: r1, c: c1, kind: k1 } : { r: r2, c: c2, kind: k2 };
            const b = combo.firstIsA ? { r: r2, c: c2, kind: k2 } : { r: r1, c: c1, kind: k1 };
            const targetTypeId = this.cells[b.r][b.c];
            const rule = combo.rule;

            /** The `'same-color'` cells this combo picked out — what `spreadPartnerActivation` detonates. */
            const colorTargets: CellPos[] = [];
            /** Every cell any of this combo's areas reached, deduped — what a `beam` draws to. */
            const beamTargets: CellPos[] = [];
            const seenTarget = new Set<string>();
            // Stated for a horizontal stripe; a vertical one sweeps the other
            // way round, so the combo always runs along the stripe first.
            const flipBands = rule.orientToPartner && (a.kind === 'striped-v' || b.kind === 'striped-v');
            const areas = flipBands ? rule.areas.map(Board._flipBand) : rule.areas;
            areas.forEach((area, stage) => {
                const cells = this._areaCells(area, a.r, a.c, targetTypeId);
                // `stagedAreas`: each entry is its own beat, and a cell belongs
                // to the first beat that claims it (so the 3x3 at the centre
                // goes with the explosion, not with the sweep that crosses it).
                const wave = rule.stagedAreas ? stage : 0;
                for (const cell of cells) {
                    const key = Board.key(cell.r, cell.c);
                    toClear.add(key);
                    if (wave < (waves.get(key) ?? Infinity)) waves.set(key, wave);
                    if (seenTarget.has(key)) continue;
                    seenTarget.add(key);
                    beamTargets.push(cell);
                }
                if (area.shape === 'same-color') colorTargets.push(...cells);
            });

            // A `presentAsBlast` combo reports one blast of its own shape
            // instead of its two participants' individual activations —
            // otherwise a renderer would draw, say, two horizontal stripe
            // beams for a swap that's actually clearing a full cross.
            if (rule.presentAsBlast) {
                const aTypeId = this.cells[a.r][a.c];
                comboBlast = {
                    r: a.r,
                    c: a.c,
                    // The blast takes its color from whichever participant has
                    // one; both being colorless (bomb + bomb) leaves the
                    // sentinel, which a renderer treats as "no tile color".
                    typeId: aTypeId === COLORLESS_TYPE_ID ? targetTypeId : aTypeId,
                    kind: a.kind ?? b.kind,
                    stages: areas.map((area, stage) => ({ area, wave: rule.stagedAreas ? stage : 0 })),
                };
            } else {
                if (a.kind) activated.push({ r: a.r, c: a.c, kind: a.kind, typeId: this.cells[a.r][a.c], wave: 0 });
                // A consumed partner hands over its color and vanishes — it
                // never detonates, so it's never reported as one; it's
                // reported as consumed instead, so the renderer takes it off
                // the board before the beam rather than with the blast.
                if (b.kind && rule.partnerConsumed) consumed.push({ r: b.r, c: b.c });
                else if (b.kind) activated.push({ r: b.r, c: b.c, kind: b.kind, typeId: targetTypeId, wave: 0 });
            }


            // A swept combo detonates along an axis instead of all at once —
            // the wave index *is* the column (or row), so the front crosses the
            // board in one pass and every cell in a line goes together.
            if (rule.sweep) {
                for (const cell of beamTargets) {
                    waves.set(Board.key(cell.r, cell.c), rule.sweep.axis === 'column' ? cell.c : cell.r);
                }
            }

            // "Turns every candy of that color into a <partner special> and
            // detonates them all" — each one fires the partner's own area and
            // queues the partner's own repeats, so a wrapped partner still
            // double-explodes everywhere it landed.
            if (rule.spreadPartnerActivation && b.kind) {
                const spread = rule.spreadPartnerActivation;
                // The bomb converts the *normal* candies of that color; the
                // partner itself is either consumed (nothing to convert — it's
                // already a special) or detonates in place, per the rule.
                const converts = colorTargets.filter(cell => !(cell.r === b.r && cell.c === b.c));
                // Ordered by distance from the bomb, and detonated in that
                // order, so the wave radiates outward from where the lightning
                // came from instead of sweeping in arbitrary grid-scan order.
                converts.sort((p, q) => Board._distanceTo(a, p) - Board._distanceTo(a, q));
                converts.forEach((cell, i) => {
                    this._detonateAt(
                        this._spreadKind(b.kind!, spread.stripeOrientation),
                        cell.r, cell.c, targetTypeId, toClear, activated, i + 1, waves
                    );
                });
                if (!rule.partnerConsumed) {
                    // Not consumed: the partner fires its own area from its own
                    // cell, keeping its own orientation, and owes its repeats.
                    const area = this._spendDetonation(b.kind, b.r, b.c, targetTypeId);
                    for (const cell of this._areaCells(area, b.r, b.c, targetTypeId)) {
                        toClear.add(Board.key(cell.r, cell.c));
                    }
                }
            }

            if (rule.beam) {
                const origins: CellPos[] = rule.beamFromBothSides
                    ? [{ r: a.r, c: a.c }, { r: b.r, c: b.c }]
                    : [{ r: a.r, c: a.c }];
                colorBombBeam = {
                    origins,
                    targetTypeId,
                    sweep: !!rule.sweep,
                    cells: beamTargets
                        // A bolt from a bomb to itself is a zero-length quad —
                        // the origins are cleared, just never shot at.
                        .filter(cell => !origins.some(o => o.r === cell.r && o.c === cell.c))
                        .map(cell => ({ r: cell.r, c: cell.c, wave: waves.get(Board.key(cell.r, cell.c)) ?? 0 })),
                };
            }
            // Both are post-fall by definition ("a second blast one phase
            // later", "after this combo settles") and so go on `_settledQueue`,
            // which `settle()` hands over once the board has dropped — not on
            // `_blastQueue`, which fires within this same still-frozen chain.
            if (rule.repeat) {
                this._settledQueue.push({ kind: 'burst', r: a.r, c: a.c, area: rule.repeat.area, reportAs: rule.repeat.as });
            }
            if (rule.colorSweepAfter) {
                this._settledQueue.push({ kind: 'colorSweep', excludeTypeId: targetTypeId, as: rule.colorSweepAfter.as });
            }
        }

        // The two swapped cells are deliberate participants, already fully
        // accounted for above — remove their own map entries *before*
        // catching bystanders so they aren't also treated as incidentally-
        // caught bystanders re-contributing their own base area a second time.
        this.specials.delete(Board.key(r1, c1));
        this.specials.delete(Board.key(r2, c2));
        // `toClear` at this point already holds every cell this combo
        // deliberately, immediately affects — passing the whole thing as
        // `_catchBystanders`'s snapshot treats all of it as "this phase," and
        // only a genuinely different special incidentally caught within that
        // blast (not one of this combo's own deliberate cells) defers to the
        // next phase.
        const bystanders = this._catchBystanders(toClear);
        activated.push(...bystanders.activated);
        colorBombBeam = colorBombBeam ?? bystanders.colorBombBeam;

        return this._finalizeClear(toClear, activated, colorBombBeam, [], comboBlast, waves, consumed);
    }

    /**
     * Merges one activating special's own declared area into `toClear` — the
     * atomic, instant consequence of it going off, all in this one beat
     * (matches how a striped candy's activation reads as one beat, not a slow
     * reveal). Which area that is, and whether the special itself survives to
     * fire again, is `_spendDetonation`'s call.
     *
     * `seen` is every cell already decided as active this same beat (the
     * caller's snapshot, plus this special's own key); a newly-touched cell
     * already in `toClear` or `seen` merges directly — it's already part of
     * this beat for some other reason, not a new discovery.
     *
     * A newly-touched cell that isn't already decided but *does* hold a
     * different, unspent special is the actual "next domino": rather than
     * expanding it right here (which is what used to flatten an entire chain
     * reaction into one instantaneous blob), it's left **completely
     * untouched** — not added to `toClear`, not cleared — and a
     * `{kind:'activate', r, c}` goes on `_blastQueue` instead.
     *
     * That queue is the one that fires on the very next `resolve()` with the
     * board still frozen, which is what makes the `(r, c)` it carries sound:
     * nothing falls in between, so the tile is guaranteed to still be exactly
     * there. It was not always so — the deferral used to survive a
     * gravity/refill pass, and any deferred special whose column had a hole
     * under it silently fell out from under its own queued detonation and
     * never went off at all. A Color Bomb caught in a striped candy's blast
     * was the common way to see it: the stripe fired, the bomb dropped a row,
     * and nothing happened.
     *
     * A cell whose special has already had its turn (`_hasHadItsTurn` — it
     * fired earlier this beat, or is mid-double-explosion) is not a domino, so
     * it clears like any plain tile, taking any repeat it still owed with it.
     *
     * `deferred` dedupes the queuing per call: if two different catches this
     * beat both reach the same not-yet-decided cell, it's only queued once
     * (otherwise a caught wrapped tile could end up double-queued from two
     * directions).
     */
    private _expandCaught(kind: SpecialKind, r: number, c: number, toClear: Set<string>, seen: Set<string>, deferred: Set<string>): void {
        const area = this._spendDetonation(kind, r, c, this.cells[r][c]);
        for (const cell of this._areaCells(area, r, c, this.cells[r][c])) {
            const ek = Board.key(cell.r, cell.c);
            if (toClear.has(ek) || seen.has(ek)) {
                toClear.add(ek);
                continue;
            }
            const otherKind = this.specials.get(ek);
            if (!otherKind || this._hasHadItsTurn(ek)) {
                toClear.add(ek);
            } else if (!deferred.has(ek)) {
                deferred.add(ek);
                this._blastQueue.push({ kind: 'activate', r: cell.r, c: cell.c });
            }
            // else: a different special, already deferred by another catch
            // this same beat — left untouched, already queued.
        }
    }

    /**
     * Single pass (not a recursive flood-fill) over a snapshot of `toClear`
     * as it stands right now: every cell already queued to clear that holds
     * a special with `chainsWhenCaught` activates immediately, contributing
     * its own area to *this* phase — a caught Color Bomb hunts the board's
     * most common color via `_expandCaughtColorBomb` instead of `rules.ts`'s
     * shape-based area, since it has no area of its own to look up. Anything
     * that catch newly reveals gets deferred to the next `resolve()` beat
     * instead of being expanded further here — see `_expandCaught`'s doc for
     * why. This is what turns a chain of catches into a sequence of separate
     * visual beats (one per `resolve()` call, all on a still board) instead of
     * one flattened blast.
     */
    private _catchBystanders(toClear: Set<string>): { activated: ActivatedSpecial[]; colorBombBeam: ResolveResult['colorBombBeam'] } {
        const activated: ActivatedSpecial[] = [];
        const seen = new Set<string>();
        const deferred = new Set<string>();
        let colorBombBeam: ResolveResult['colorBombBeam'] = null;
        for (const k of Array.from(toClear)) {
            const kind = this.specials.get(k);
            // `_hasHadItsTurn`: already fired, this beat or an earlier one, so
            // it's not a fresh domino — without this check a Wrapped Candy is
            // re-triggered by its own blast, and two adjacent ones re-trigger
            // each other forever, neither ever finishing dying.
            if (!kind || !rules.activation[kind].chainsWhenCaught || seen.has(k) || this._hasHadItsTurn(k)) continue;
            seen.add(k);
            const [r, c] = Board.parseKey(k);
            activated.push({ r, c, kind, typeId: this.cells[r][c], wave: 0 });
            if (kind === 'color-bomb') {
                colorBombBeam = colorBombBeam ?? this._expandCaughtColorBomb(r, c, toClear, seen, deferred);
            } else {
                this._expandCaught(kind, r, c, toClear, seen, deferred);
            }
        }
        return { activated, colorBombBeam };
    }

    /**
     * A preferred cell that's part of `cells` wins, provided it isn't already
     * occupied by an existing special; otherwise the first special-free cell
     * in `cells`; otherwise (every cell in the run already holds a special —
     * rare) falls back to the run's middle regardless. Never picks an
     * already-special cell while a special-free one is available: spawning
     * the new special there would silently overwrite whatever bystander
     * special was already sitting on it (its own `this.specials` entry gets
     * clobbered by the spawn's write) *before* `_catchBystanders` ever gets a
     * chance to see it in `toClear` and activate it — the pre-existing
     * special would vanish having never burst. This bites specifically when
     * the player swaps the special tile itself into a match (its own new cell
     * is a `preferred` swap destination), not the plain-bystander case where
     * the special sits elsewhere in the run untouched by the swap (see
     * `debugLayouts.ts`'s `stripedBystanderCatch`).
     */
    private _pickSpawnCell(cells: CellPos[], preferred?: CellPos[]): CellPos {
        const free = (p: CellPos): boolean => !this.specials.has(Board.key(p.r, p.c));
        if (preferred) {
            const hit = preferred.find(p => free(p) && cells.some(c => c.r === p.r && c.c === p.c));
            if (hit) return hit;
        }
        return cells.find(free) ?? cells[Math.floor(cells.length / 2)];
    }

    /**
     * The one place an `AreaSpec` becomes actual coordinates — every clear
     * this game performs outside a plain color match goes through here, so a
     * special's reach, a combo's blast and a queued re-detonation all speak
     * the same vocabulary and are all clipped to the board identically.
     *
     * `'row'`/`'column'` are deliberately the direction the *kind* points, not
     * the direction its match ran: a horizontally-striped tile clears the row
     * it's in, a vertically-striped tile clears the column
     * (candy_crush_rules.md's "Blast Effect"; also matches
     * `BoardView.frameKeyFor`'s sprite choice and `res/candies.png`'s actual
     * art). The *perpendicular* part of the real rule — a horizontal match
     * producing the vertical-look tile — is `rules.spawn`'s
     * `'striped-perpendicular'`, decided at spawn time, never here.
     *
     * @param typeId The trigger color, required only by `'same-color'`.
     */
    private _areaCells(spec: AreaSpec, r: number, c: number, typeId?: number): CellPos[] {
        const cells: CellPos[] = [];
        switch (spec.shape) {
            case 'row':
                for (let cc = 0; cc < this.cols; cc++) cells.push({ r, c: cc });
                return cells;
            case 'column':
                for (let rr = 0; rr < this.rows; rr++) cells.push({ r: rr, c });
                return cells;
            case 'cross':
                for (let cc = 0; cc < this.cols; cc++) cells.push({ r, c: cc });
                for (let rr = 0; rr < this.rows; rr++) cells.push({ r: rr, c });
                return cells;
            case 'box':
                for (let rr = r - spec.radius; rr <= r + spec.radius; rr++) {
                    for (let cc = c - spec.radius; cc <= c + spec.radius; cc++) {
                        if (this.inBounds(rr, cc)) cells.push({ r: rr, c: cc });
                    }
                }
                return cells;
            case 'band-cross':
                return [
                    ...this._areaCells({ shape: 'row-band', radius: spec.radius }, r, c),
                    ...this._areaCells({ shape: 'column-band', radius: spec.radius }, r, c),
                ];
            case 'row-band':
                for (let rr = r - spec.radius; rr <= r + spec.radius; rr++) {
                    if (!this.inBounds(rr, c)) continue;
                    for (let cc = 0; cc < this.cols; cc++) cells.push({ r: rr, c: cc });
                }
                return cells;
            case 'column-band':
                for (let cc = c - spec.radius; cc <= c + spec.radius; cc++) {
                    if (!this.inBounds(r, cc)) continue;
                    for (let rr = 0; rr < this.rows; rr++) cells.push({ r: rr, c: cc });
                }
                return cells;
            case 'same-color':
                return typeId === undefined ? cells : this._sameColorCells(typeId);
            case 'whole-board':
                for (let rr = 0; rr < this.rows; rr++) {
                    for (let cc = 0; cc < this.cols; cc++) cells.push({ r: rr, c: cc });
                }
                return cells;
        }
    }

    /**
     * Every cell currently holding `typeId` — the Color Bomb's target list.
     * Answers with nothing at all unless `typeId` is a real color, so a
     * sentinel can never be swept as if it were one: bombs are not collected
     * by another bomb's color, and mid-chain holes are not "matched".
     */
    private _sameColorCells(typeId: number): CellPos[] {
        const cells: CellPos[] = [];
        if (!this._isColor(typeId)) return cells;
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                if (this.cells[r][c] === typeId) cells.push({ r, c });
            }
        }
        return cells;
    }

    /**
     * The color with the most cells on the board right now, ties broken
     * uniformly at random — what a passively-caught Color Bomb hunts, since
     * (unlike a deliberate swap) it has no partner candy to take a color
     * from. Falls back to a uniformly random color if none is present at
     * all (an all-colorless board, in practice never reachable).
     */
    private _mostCommonTypeId(): number {
        const counts = new Array<number>(this.typeCount).fill(0);
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                const t = this.cells[r][c];
                if (t >= 0 && t < this.typeCount) counts[t]++;
            }
        }
        const max = Math.max(...counts);
        if (max === 0) return Math.floor(Math.random() * this.typeCount);
        const top: number[] = [];
        for (let t = 0; t < this.typeCount; t++) if (counts[t] === max) top.push(t);
        return top[Math.floor(Math.random() * top.length)];
    }

    /**
     * A passively-caught Color Bomb's own expansion: picks its target color
     * via `_mostCommonTypeId` and clears every cell of that color, the same
     * way `_expandCaught` clears an area — a not-yet-decided plain cell
     * clears directly, a not-yet-decided special defers to the next phase.
     * Deliberately does NOT convert same-color specials into anything (no
     * `spreadPartnerActivation`-style upgrade) — a passive catch is a plain
     * color clear, never a combo.
     */
    private _expandCaughtColorBomb(
        r: number, c: number,
        toClear: Set<string>, seen: Set<string>, deferred: Set<string>
    ): NonNullable<ResolveResult['colorBombBeam']> {
        this._spendDetonation('color-bomb', r, c, this.cells[r][c]);
        const targetTypeId = this._mostCommonTypeId();
        const cells: { r: number; c: number; wave: number }[] = [];
        for (const cell of this._sameColorCells(targetTypeId)) {
            if (cell.r === r && cell.c === c) continue;
            const ek = Board.key(cell.r, cell.c);
            cells.push({ r: cell.r, c: cell.c, wave: 0 });
            if (toClear.has(ek) || seen.has(ek)) {
                toClear.add(ek);
                continue;
            }
            const otherKind = this.specials.get(ek);
            if (!otherKind || this._hasHadItsTurn(ek)) {
                toClear.add(ek);
            } else if (!deferred.has(ek)) {
                deferred.add(ek);
                this._blastQueue.push({ kind: 'activate', r: cell.r, c: cell.c });
            }
        }
        return { origins: [{ r, c }], targetTypeId, sweep: false, cells };
    }

    /**
     * Gravity + refill, and the one place a tile's per-cell state travels with
     * it: `specials` *and* `_spent` are both re-keyed to the tile's new row.
     * Carrying `_spent` is what makes a Wrapped Candy's second explosion
     * follow the candy down instead of firing at the square it launched from.
     *
     * Only tiles that actually change row (and freshly spawned ones) are
     * reported as `ColumnMove`s — a full column of untouched tiles produces no
     * moves at all, so the caller has nothing to animate and `settle()` can
     * tell a real fall from a no-op.
     */
    private _collapseAndRefill(): ColumnMove[] {
        const moves: ColumnMove[] = [];

        for (let c = 0; c < this.cols; c++) {
            const survivors: { r: number; typeId: number; special: SpecialKind | null; spent: SpentSpecial | null }[] = [];
            for (let r = 0; r < this.rows; r++) {
                if (this.cells[r][c] !== EMPTY_TYPE_ID) {
                    const key = Board.key(r, c);
                    survivors.push({
                        r,
                        typeId: this.cells[r][c],
                        special: this.specials.get(key) ?? null,
                        spent: this._spent.get(key) ?? null,
                    });
                }
            }

            // Collected above from old positions — clear the whole column's
            // per-cell entries now so a surviving tile's old key doesn't linger
            // as a stale duplicate once it's re-added at its new row below.
            for (let r = 0; r < this.rows; r++) {
                const key = Board.key(r, c);
                this.specials.delete(key);
                this._spent.delete(key);
            }

            const newCol = new Array(this.rows).fill(EMPTY_TYPE_ID);
            let destRow = this.rows - 1;
            for (let i = survivors.length - 1; i >= 0; i--) {
                const s = survivors[i];
                newCol[destRow] = s.typeId;
                const destKey = Board.key(destRow, c);
                if (s.special) this.specials.set(destKey, s.special);
                if (s.spent) this._spent.set(destKey, s.spent);
                // Same row it was already in — nothing fell, nothing to report.
                if (s.r !== destRow) {
                    moves.push({ col: c, fromRow: s.r, toRow: destRow, typeId: s.typeId, special: s.special });
                }
                destRow--;
            }

            for (let r = destRow; r >= 0; r--) {
                const t = this._randomType();
                newCol[r] = t;
                moves.push({ col: c, fromRow: null, toRow: r, typeId: t, special: null });
            }

            for (let r = 0; r < this.rows; r++) this.cells[r][c] = newCol[r];
        }

        return moves;
    }
}
