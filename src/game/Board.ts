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
 */

import { theme } from '../config/theme';
import { rules, AreaSpec, SpecialKind, SpawnRule, FindComboRule } from '../config/rules';

export type { SpecialKind };

/** Sentinel `cells[r][c]` value for a `colorless` special (the Color Bomb) — must never equal a real 0..typeCount-1 id or the -1 "empty" marker, or it could accidentally join/avoid a normal color run. */
const COLORLESS_TYPE_ID = -2;

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
 * A detonation queued to fire on the *next* `resolve()` call, after this
 * pass's gravity/refill has settled — this is what turns a chain reaction
 * into a sequence of visible beats instead of one flattened blast, and what
 * implements `rules.activation[].repeats` (candy_crush_rules.md's "explodes...
 * drops down as board pieces fill in, and explodes a second time") and a
 * combo's `colorSweepAfter` ("after the explosions settle, it selects a
 * second random color...").
 *
 * All three are *positional*: they name a board cell, not a tile. Whatever
 * has fallen into that cell by the time they fire is what they act on.
 */
type PendingAction =
    /** A fixed area re-detonating at a fixed board position, reported as the special `reportAs`. */
    | { kind: 'burst'; r: number; c: number; area: AreaSpec; reportAs: SpecialKind }
    /**
     * A specific bystander special discovered mid-chain this phase, but deliberately left
     * uncleared (see `_expandCaught`'s doc) so it's still there next `resolve()` call:
     * activates whatever special (if any) `this.specials` reports at `(r,c)` when this drains, a
     * no-op if it fell away or was cleared by something else before then.
     */
    | { kind: 'activate'; r: number; c: number }
    /** Pick a random color other than `excludeTypeId`, then detonate every tile of it as the special `as`. */
    | { kind: 'colorSweep'; excludeTypeId: number; as: SpecialKind };

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
     * cleared). `typeId` is captured at spawn time, not meant to be re-read
     * from `cells[r][c]` afterward — gravity (this same `resolve()` call)
     * can move the spawned tile to a different row, and whatever falls into
     * its old (r,c) afterward would silently masquerade as the special's own
     * color otherwise.
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
    /** Score awarded for this pass alone (before any further cascade passes), including `rules.scoring`'s cascade multiplier and special-creation bonuses. */
    scoreDelta: number;
    /** Gravity/refill result, one entry per moved-or-spawned cell, empty if `cleared` was empty. */
    moves: ColumnMove[];
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
    /** Queued detonations to apply at the start of the next `resolve()` call — see `PendingAction`. */
    private _pending: PendingAction[] = [];
    /** How many clearing passes have already run since `beginMove()` — indexes `rules.scoring.cascadeMultipliers`. */
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
    }

    private _findRuns(): Run[] {
        const runs: Run[] = [];

        for (let r = 0; r < this.rows; r++) {
            let c = 0;
            while (c < this.cols) {
                const t = this.cells[r][c];
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
     * Resolves every currently-matched run into clears + special spawns +
     * gravity/refill, expanding into any specials caught in the blast
     * (chained detonation). Call repeatedly (cascade) until it returns an
     * empty `cleared` list.
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
        // Any second explosion queued by a previous pass's detonation (or a
        // combo's second-color wave) fires now, against the board as it
        // stands after that pass's own refill.
        const { toClear: forcedClear, activated: forcedActivated } = this._drainPending();

        const runs = this._findRuns();
        if (runs.length === 0 && forcedClear.size === 0) {
            return { cleared: [], spawned: [], activatedSpecials: [], colorBombBeam: null, comboBlast: null, consumed: [], scoreDelta: 0, moves: [] };
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

        const activatedSpecials = [...forcedActivated, ...this._catchBystanders(toClear)];

        return this._finalizeClear(toClear, activatedSpecials, null, spawned);
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
     * Shared tail for both `resolve()` and `activateSpecialSwap()`: scores,
     * clears cells, drops any spawned special whose cell ended up in
     * `toClear` after all (see `registerSpawn`'s doc — a freshly-spawned
     * special caught within this same phase's own snapshot is destroyed, not
     * protected, matching real Candy Crush), runs gravity/refill, and builds
     * the `ResolveResult`.
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
        const cleared: ResolveResult['cleared'] = [];
        for (const k of toClear) {
            const [r, c] = Board.parseKey(k);
            cleared.push({ r, c, typeId: this.cells[r][c], wave: waves.get(k) ?? 0 });
            this.cells[r][c] = -1;
            this.specials.delete(k);
        }
        const survivingSpawned = spawned.filter(s => !toClear.has(Board.key(s.r, s.c)));
        const scoreDelta = this._score(toClear.size, survivingSpawned);

        const moves = this._collapseAndRefill();

        return { cleared, spawned: survivingSpawned, activatedSpecials, colorBombBeam, comboBlast, consumed, scoreDelta, moves };
    }

    /**
     * `rules.scoring`, applied: every cleared cell at `pointsPerTile`, scaled
     * by this move's cascade depth, plus a flat bonus per special created.
     * Advances the cascade counter, so the next pass within the same move
     * scores higher — `beginMove()` is what resets it.
     */
    private _score(clearedCount: number, spawned: { special: SpecialKind }[]): number {
        if (clearedCount === 0) return 0;
        const multipliers = rules.scoring.cascadeMultipliers;
        const multiplier = multipliers[Math.min(this._cascadeStep, multipliers.length - 1)] ?? 1;
        this._cascadeStep++;
        let score = Math.round(clearedCount * rules.scoring.pointsPerTile * multiplier);
        for (const s of spawned) score += rules.scoring.specialCreateBonus[s.special] ?? 0;
        return score;
    }

    /**
     * Pops every queued `PendingAction` and resolves it against the board's
     * *current* state (post-refill, since this only ever runs at the top of
     * the next `resolve()` call) into a forced-clear set — see
     * `PendingAction`'s own doc for why these exist. A `'colorSweep'` re-queues
     * each swept cell's own `repeats`, so a combo's second wave follows the
     * same detonation rules as any other. `'activate'` runs the caught
     * special through `_expandCaught` the same as `_catchBystanders` does, via
     * a `seen`/`deferred` pair scoped to this one drain call — not a simpler
     * "just dump the whole area in" path — so anything *it* in turn catches
     * defers to yet another phase instead of flattening back into this one.
     */
    private _drainPending(): { toClear: Set<string>; activated: ActivatedSpecial[] } {
        const toClear = new Set<string>();
        const seen = new Set<string>();
        const deferred = new Set<string>();
        const activated: ActivatedSpecial[] = [];
        const pending = this._pending;
        this._pending = [];

        for (const action of pending) {
            if (action.kind === 'burst') {
                for (const cell of this._areaCells(action.area, action.r, action.c)) {
                    toClear.add(Board.key(cell.r, cell.c));
                }
                activated.push({ r: action.r, c: action.c, kind: action.reportAs, typeId: this.cells[action.r][action.c], wave: 0 });
            } else if (action.kind === 'activate') {
                const key = Board.key(action.r, action.c);
                const kind = this.specials.get(key);
                // Fell away, or is a kind that never chain-reacts — nothing to do.
                if (!kind || !rules.activation[kind].chainsWhenCaught) continue;
                toClear.add(key);
                seen.add(key);
                activated.push({ r: action.r, c: action.c, kind, typeId: this.cells[action.r][action.c], wave: 0 });
                this._expandCaught(kind, action.r, action.c, toClear, seen, deferred);
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

        return { toClear, activated };
    }

    /**
     * Fires `kind`'s own `rules.activation` effect at (r,c) as a flat,
     * non-chaining detonation: its area joins `toClear` and its `repeats` are
     * queued for the next phase. Used where a cell is being detonated *as if*
     * it held a special it doesn't actually hold — a combo's
     * `spreadPartnerActivation` and a `colorSweep`'s wave — so unlike
     * `_expandCaught` there's no bystander/defer bookkeeping to do.
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
        const activation = rules.activation[kind];
        for (const cell of this._areaCells(activation.area, r, c, typeId)) {
            const key = Board.key(cell.r, cell.c);
            toClear.add(key);
            // Lowest wins: a cell in two detonations' paths belongs to
            // whichever goes off first, so it can't pop twice or pop late.
            if (waves && wave < (waves.get(key) ?? Infinity)) waves.set(key, wave);
        }
        activated.push({ r, c, kind, typeId, wave });
        this._queueRepeats(kind, r, c);
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

    /** Queues a special's `repeats` re-detonations at (r,c) for the next phase — the always-double-explodes rule, as data. */
    private _queueRepeats(kind: SpecialKind, r: number, c: number): void {
        const activation = rules.activation[kind];
        for (let i = 0; i < activation.repeats; i++) {
            this._pending.push({ kind: 'burst', r, c, area: activation.repeatArea ?? activation.area, reportAs: kind });
        }
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
                    for (const cell of this._areaCells(rules.activation[b.kind].area, b.r, b.c, targetTypeId)) {
                        toClear.add(Board.key(cell.r, cell.c));
                    }
                    this._queueRepeats(b.kind, b.r, b.c);
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
            if (rule.repeat) {
                this._pending.push({ kind: 'burst', r: a.r, c: a.c, area: rule.repeat.area, reportAs: rule.repeat.as });
            }
            if (rule.colorSweepAfter) {
                this._pending.push({ kind: 'colorSweep', excludeTypeId: targetTypeId, as: rule.colorSweepAfter.as });
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
        activated.push(...this._catchBystanders(toClear));

        return this._finalizeClear(toClear, activated, colorBombBeam, [], comboBlast, waves, consumed);
    }

    /**
     * Merges one activating special's own declared area
     * (`rules.activation[kind].area`) into `toClear` — the atomic, instant
     * consequence of it going off, all in this one phase (matches how a
     * striped candy's activation reads as one beat, not a slow reveal).
     * `seen` is every cell already decided as active this same phase (the
     * caller's snapshot, plus this special's own key); a newly-touched cell
     * already in `toClear` or `seen` merges directly — it's already part of
     * this phase for some other reason, not a new discovery.
     *
     * A newly-touched cell that isn't already decided but *does* hold a
     * different special is the actual "next domino": rather than expanding
     * it right here (which is what used to flatten an entire chain reaction
     * into one instantaneous blob), it's left **completely untouched** —
     * not added to `toClear`, not cleared, not moved by gravity this pass —
     * and a `{kind:'activate', r, c}` is queued instead, so `_drainPending`'s
     * lookup on the *next* `resolve()` call is guaranteed to still find it
     * exactly where it is. `deferred` dedupes that queuing per call: if two
     * different catches this phase both reach the same not-yet-decided cell,
     * it's only queued once (otherwise a caught wrapped tile could end up
     * double-reburst-queued from two directions).
     *
     * The special's own `repeats` are queued unconditionally on top of all
     * that (self, not defer-checked against another special) — the
     * always-double-explodes rule, unaffected by any of the above.
     */
    private _expandCaught(kind: SpecialKind, r: number, c: number, toClear: Set<string>, seen: Set<string>, deferred: Set<string>): void {
        this._queueRepeats(kind, r, c);
        for (const cell of this._areaCells(rules.activation[kind].area, r, c, this.cells[r][c])) {
            const ek = Board.key(cell.r, cell.c);
            if (toClear.has(ek) || seen.has(ek)) {
                toClear.add(ek);
                continue;
            }
            const otherKind = this.specials.get(ek);
            if (!otherKind) {
                toClear.add(ek);
            } else if (!deferred.has(ek)) {
                deferred.add(ek);
                this._pending.push({ kind: 'activate', r: cell.r, c: cell.c });
            }
            // else: a different special, already deferred by another catch
            // this same phase — left untouched, already queued.
        }
    }

    /**
     * Single pass (not a recursive flood-fill) over a snapshot of `toClear`
     * as it stands right now: every cell already queued to clear that holds
     * a special with `chainsWhenCaught` activates immediately via
     * `_expandCaught`, contributing its own area to *this* phase. (A Color
     * Bomb caught passively is just a bystander — `chainsWhenCaught: false`.)
     * Anything *that* newly reveals gets deferred to the next `resolve()`
     * call instead of being expanded further here — see `_expandCaught`'s doc
     * for why. This is what turns a chain of catches into a sequence of
     * separate visual beats (one per `resolve()` call) instead of one
     * flattened blast.
     */
    private _catchBystanders(toClear: Set<string>): ActivatedSpecial[] {
        const activated: ActivatedSpecial[] = [];
        const seen = new Set<string>();
        const deferred = new Set<string>();
        for (const k of Array.from(toClear)) {
            const kind = this.specials.get(k);
            if (!kind || !rules.activation[kind].chainsWhenCaught || seen.has(k)) continue;
            seen.add(k);
            const [r, c] = Board.parseKey(k);
            activated.push({ r, c, kind, typeId: this.cells[r][c], wave: 0 });
            this._expandCaught(kind, r, c, toClear, seen, deferred);
        }
        return activated;
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

    /** Every cell currently holding `typeId` — the Color Bomb's target list. A colorless special's sentinel id never matches a real one, so bombs are never swept up by another bomb's color. */
    private _sameColorCells(typeId: number): CellPos[] {
        const cells: CellPos[] = [];
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                if (this.cells[r][c] === typeId) cells.push({ r, c });
            }
        }
        return cells;
    }

    private _collapseAndRefill(): ColumnMove[] {
        const moves: ColumnMove[] = [];

        for (let c = 0; c < this.cols; c++) {
            const survivors: { r: number; typeId: number; special: SpecialKind | null }[] = [];
            for (let r = 0; r < this.rows; r++) {
                if (this.cells[r][c] !== -1) {
                    survivors.push({ r, typeId: this.cells[r][c], special: this.specials.get(Board.key(r, c)) ?? null });
                }
            }

            // Collected above from old positions — clear the whole column's
            // special entries now so a surviving tile's old key doesn't linger
            // as a stale duplicate once it's re-added at its new row below.
            for (let r = 0; r < this.rows; r++) this.specials.delete(Board.key(r, c));

            const newCol = new Array(this.rows).fill(-1);
            let destRow = this.rows - 1;
            for (let i = survivors.length - 1; i >= 0; i--) {
                const s = survivors[i];
                newCol[destRow] = s.typeId;
                if (s.special) this.specials.set(Board.key(destRow, c), s.special);
                moves.push({ col: c, fromRow: s.r, toRow: destRow, typeId: s.typeId, special: s.special });
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
