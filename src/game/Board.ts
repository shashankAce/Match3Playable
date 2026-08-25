/**
 * Theme-agnostic match-3 board model (see AGENTS.md's config-driven rule) —
 * pure grid state and logic, no rendering, no NoonEngine imports. `rules.ts`
 * supplies board size and match/scoring thresholds; `theme.ts` supplies only
 * the tile-type count (`tileTypes.length`) — nothing here reads a sprite
 * key, a color, or any other visual/audio value.
 */

import { theme } from '../config/theme';
import { rules } from '../config/rules';

export type SpecialKind = 'striped-h' | 'striped-v' | 'wrapped' | 'color-bomb';

/** Sentinel `cells[r][c]` value for a Color Bomb — colorless, so it must never equal a real 0..typeCount-1 id or the -1 "empty" marker, or it could accidentally join/avoid a normal color run. */
const COLOR_BOMB_TYPE_ID = -2;

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

/**
 * A detonation queued to fire on the *next* `resolve()` call, after this
 * pass's gravity/refill has settled — matches candy_crush_rules.md's "Wrapped
 * Candy Effects" ("explodes... drops down as board pieces fill in, and
 * explodes a second time") and "Wrapped + Color Bomb" ("after the explosions
 * settle, it selects a second random color..."). `'burst'` is a second 3x3ish
 * explosion at a fixed board position (position, not tile — whatever fell
 * into that cell by the time it fires is what gets cleared). `'colorSweep'`
 * is the Wrapped+Color-Bomb combo's second wave: pick a random color other
 * than the one already used, then treat every candy of that color as a
 * Wrapped Candy (own explosion + its own queued second explosion).
 */
type PendingAction =
    | { kind: 'burst'; r: number; c: number; radius: number }
    /**
     * A specific bystander special discovered mid-chain this phase, but deliberately left
     * uncleared (see `_expandCaught`'s doc) so it's still there next `resolve()` call — "position,
     * not necessarily the same reason it's there," same convention `'burst'` already uses:
     * activates whatever special (if any) `this.specials` reports at `(r,c)` when this drains, a
     * no-op if it fell away or was cleared by something else before then.
     */
    | { kind: 'activate'; r: number; c: number }
    | { kind: 'colorSweep'; excludeTypeId: number };

export interface ResolveResult {
    /**
     * Cells cleared this pass (plain clears + special-detonation cells),
     * before gravity. `typeId` is captured from `cells[r][c]` right before
     * it's blanked to `-1` — same "capture before mutation" rule `spawned`
     * already follows, since callers (collect-mode target tracking) need to
     * know what color/type each cleared cell actually was.
     */
    cleared: { r: number; c: number; typeId: number }[];
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
     * in `_catchBystanders`'s chain reaction, or the deliberate swap target(s)
     * in `activateSpecialSwap` — each with position/kind/color captured
     * before its cell is cleared. Lets a renderer play a distinct effect per
     * special kind without guessing from `cleared` alone.
     */
    activatedSpecials: { r: number; c: number; kind: SpecialKind; typeId: number }[];
    /**
     * Set only when a single Color Bomb activated against one target color
     * this pass (not a Color Bomb + Color Bomb whole-board clear, which has
     * no single target color) — lets a renderer draw a "lightning" from the
     * bomb to every cell of that color.
     */
    colorBombBeam: { originR: number; originC: number; targetTypeId: number; cells: CellPos[] } | null;
    /** Score awarded for this pass alone (before any further cascade passes). */
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
    /** Same shape as `Board.cells` — `rows` arrays of `cols` tile-type ids. Not checked for pre-existing matches; a debug layout is allowed to already contain one. */
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

    constructor(debugLayout?: DebugLayout) {
        this.rows = rules.board.rows;
        this.cols = rules.board.cols;
        this.typeCount = theme.tileTypes.length;
        if (debugLayout) {
            this.cells = debugLayout.cells.map(row => row.slice());
            this.specials = new Map(debugLayout.specials ?? []);
        } else {
            this._generateNoInitialMatches();
        }
    }

    private static key(r: number, c: number): string {
        return `${r},${c}`;
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

    private _findRuns(): { cells: CellPos[]; typeId: number; orientation: 'h' | 'v' }[] {
        const runs: { cells: CellPos[]; typeId: number; orientation: 'h' | 'v' }[] = [];

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

    /**
     * Resolves every currently-matched run into clears + special spawns +
     * gravity/refill, expanding into any specials caught in the blast
     * (chained detonation). Call repeatedly (cascade) until it returns an
     * empty `cleared` list.
     *
     * @param preferredCells Where a spawned special should appear if it's
     * part of the qualifying run — the swap destination(s), matching real
     * Candy Crush (the special appears where the player moved a tile to, not
     * the run's middle). Pass nothing for cascade-triggered passes, which
     * have no swap to prefer.
     */
    resolve(preferredCells?: CellPos[]): ResolveResult {
        // Any second explosion queued by a previous pass's wrapped detonation
        // (or a Wrapped+Color Bomb combo's second-color wave) fires now,
        // against the board as it stands after that pass's own refill.
        const { toClear: forcedClear, activated: forcedActivated } = this._drainPending();

        const runs = this._findRuns();
        if (runs.length === 0 && forcedClear.size === 0) {
            return { cleared: [], spawned: [], activatedSpecials: [], colorBombBeam: null, scoreDelta: 0, moves: [] };
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
        };

        // Merge same-typeId h/v run pairs sharing a cell into a wrapped spawn;
        // otherwise a 4+ run spawns striped; a plain 3-run just clears.
        const hRuns = runs.filter(r => r.orientation === 'h');
        const vRuns = runs.filter(r => r.orientation === 'v');
        const consumedV = new Set<number>();
        /**
         * A run that loses a length-priority conflict (see below) is added
         * here, not to `toClear` — it's left completely untouched this
         * phase, exactly as if it never matched at all. Whatever's left of
         * it (minus whatever the winning run's own clear happens to take)
         * sits on the board through gravity/refill and gets a fresh,
         * unbiased look from `_findRuns()` on the *next* `resolve()` call —
         * rather than this phase guessing whether some sub-segment of the
         * stale, pre-clear run is still a genuine 3+ match, which it may not
         * be once the shared cell is gone. `hRuns` never needs the same
         * treatment: a losing h-run just falls through to its own
         * length-based branch below, which independently decides its own
         * fate without knowing about `v` at all — see the loop body.
         */
        const skippedV = new Set<number>();

        for (const h of hRuns) {
            let merged = false;
            let hLoses = false;
            for (let vi = 0; vi < vRuns.length; vi++) {
                if (consumedV.has(vi) || skippedV.has(vi)) continue;
                const v = vRuns[vi];
                if (v.typeId !== h.typeId) continue;
                const intersection = h.cells.find(hc => v.cells.some(vc => vc.r === hc.r && vc.c === hc.c));
                if (!intersection) continue;

                const hWorthyOfBomb = h.cells.length >= rules.special.colorBombMatchLength;
                const vWorthyOfBomb = v.cells.length >= rules.special.colorBombMatchLength;

                if (!hWorthyOfBomb && !vWorthyOfBomb) {
                    // Neither side is Color-Bomb-worthy on its own — genuine
                    // L/T merge, same as always.
                    for (const cell of h.cells) toClear.add(Board.key(cell.r, cell.c));
                    for (const cell of v.cells) toClear.add(Board.key(cell.r, cell.c));
                    toClear.delete(Board.key(intersection.r, intersection.c));
                    registerSpawn(intersection.r, intersection.c, 'wrapped', h.typeId);
                    consumedV.add(vi);
                    merged = true;
                } else if (hWorthyOfBomb && !vWorthyOfBomb) {
                    // h wins — v (short on its own) is left entirely alone
                    // this phase; h falls through to its own color-bomb
                    // branch below undisturbed.
                    skippedV.add(vi);
                } else if (!hWorthyOfBomb && vWorthyOfBomb) {
                    // v wins — h (short on its own) is left entirely alone
                    // this phase; v will independently reach its own
                    // color-bomb branch below via the normal `vRuns.forEach`.
                    hLoses = true;
                }
                // Both worthy: neither is skipped, both independently reach
                // their own color-bomb branch below — if they'd spawn on the
                // exact same shared cell, `_pickSpawnCell`'s existing
                // already-special check (see its own doc) already makes the
                // second one pick a different cell instead of colliding.
                break; // only one crossing partner considered per run
            }
            if (merged || hLoses) continue;

            if (h.cells.length >= rules.special.colorBombMatchLength) {
                const spawnAt = this._pickSpawnCell(h.cells, preferredCells);
                for (const cell of h.cells) toClear.add(Board.key(cell.r, cell.c));
                toClear.delete(Board.key(spawnAt.r, spawnAt.c));
                registerSpawn(spawnAt.r, spawnAt.c, 'color-bomb', h.typeId);
                this.cells[spawnAt.r][spawnAt.c] = COLOR_BOMB_TYPE_ID;
            } else if (h.cells.length >= rules.special.stripedMatchLength) {
                const spawnAt = this._pickSpawnCell(h.cells, preferredCells);
                for (const cell of h.cells) toClear.add(Board.key(cell.r, cell.c));
                toClear.delete(Board.key(spawnAt.r, spawnAt.c));
                // Perpendicular to the match: a horizontal run spawns the
                // vertical-look tile (clears the column) — see `_areaFor`'s doc.
                registerSpawn(spawnAt.r, spawnAt.c, 'striped-v', h.typeId);
            } else {
                for (const cell of h.cells) toClear.add(Board.key(cell.r, cell.c));
            }
        }

        vRuns.forEach((v, vi) => {
            if (consumedV.has(vi) || skippedV.has(vi)) return;
            if (v.cells.length >= rules.special.colorBombMatchLength) {
                const spawnAt = this._pickSpawnCell(v.cells, preferredCells);
                for (const cell of v.cells) toClear.add(Board.key(cell.r, cell.c));
                toClear.delete(Board.key(spawnAt.r, spawnAt.c));
                registerSpawn(spawnAt.r, spawnAt.c, 'color-bomb', v.typeId);
                this.cells[spawnAt.r][spawnAt.c] = COLOR_BOMB_TYPE_ID;
            } else if (v.cells.length >= rules.special.stripedMatchLength) {
                const spawnAt = this._pickSpawnCell(v.cells, preferredCells);
                for (const cell of v.cells) toClear.add(Board.key(cell.r, cell.c));
                toClear.delete(Board.key(spawnAt.r, spawnAt.c));
                // Perpendicular to the match: a vertical run spawns the
                // horizontal-look tile (clears the row) — see `_areaFor`'s doc.
                registerSpawn(spawnAt.r, spawnAt.c, 'striped-h', v.typeId);
            } else {
                for (const cell of v.cells) toClear.add(Board.key(cell.r, cell.c));
            }
        });

        // A spawn cell is protected from `toClear` at the moment it's chosen
        // above, but a *different*, un-merged crossing run sharing that same
        // cell (the exact case the length-priority check above can produce —
        // a Color-Bomb-worthy run and a shorter perpendicular run crossing at
        // one cell) processes independently afterward and would otherwise
        // re-add it via its own plain `toClear.add(cell)` loop, silently
        // erasing the special the instant it's created. Re-asserting every
        // spawn's protection here, after both loops have fully run,
        // guarantees it sticks regardless of processing order.
        for (const s of spawned) toClear.delete(Board.key(s.r, s.c));

        const activatedSpecials = [...forcedActivated, ...this._catchBystanders(toClear)];

        return this._finalizeClear(toClear, activatedSpecials, null, spawned);
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
        activatedSpecials: { r: number; c: number; kind: SpecialKind; typeId: number }[],
        colorBombBeam: ResolveResult['colorBombBeam'],
        spawned: { r: number; c: number; special: SpecialKind; typeId: number }[] = []
    ): ResolveResult {
        const scoreDelta = toClear.size * rules.scoring.pointsPerTile;

        const cleared: { r: number; c: number; typeId: number }[] = [];
        for (const k of toClear) {
            const [r, c] = k.split(',').map(Number);
            cleared.push({ r, c, typeId: this.cells[r][c] });
            this.cells[r][c] = -1;
            this.specials.delete(k);
        }
        const survivingSpawned = spawned.filter(s => !toClear.has(Board.key(s.r, s.c)));

        const moves = this._collapseAndRefill();

        return { cleared, spawned: survivingSpawned, activatedSpecials, colorBombBeam, scoreDelta, moves };
    }

    /**
     * Pops every queued `PendingAction` and resolves it against the board's
     * *current* state (post-refill, since this only ever runs at the top of
     * the next `resolve()` call) into a forced-clear set — see
     * `PendingAction`'s own doc for why these exist. A `'colorSweep'` re-queues
     * a `'burst'` per swept cell (its own second explosion), so a Wrapped +
     * Color Bomb combo's second wave follows the same "always double-detonate"
     * rule as any other wrapped detonation. `'activate'` runs the caught
     * special through `_expandCaught` the same as `_catchBystanders` does, via
     * a `seen`/`deferred` pair scoped to this one drain call — not a simpler
     * "just dump the whole area in" path — so anything *it* in turn catches
     * defers to yet another phase instead of flattening back into this one.
     */
    private _drainPending(): { toClear: Set<string>; activated: { r: number; c: number; kind: SpecialKind; typeId: number }[] } {
        const toClear = new Set<string>();
        const seen = new Set<string>();
        const deferred = new Set<string>();
        const activated: { r: number; c: number; kind: SpecialKind; typeId: number }[] = [];
        const pending = this._pending;
        this._pending = [];

        for (const action of pending) {
            if (action.kind === 'burst') {
                for (const cell of this._boxArea(action.r, action.c, action.radius)) {
                    toClear.add(Board.key(cell.r, cell.c));
                }
                activated.push({ r: action.r, c: action.c, kind: 'wrapped', typeId: this.cells[action.r][action.c] });
            } else if (action.kind === 'activate') {
                const key = Board.key(action.r, action.c);
                const kind = this.specials.get(key);
                if (!kind || kind === 'color-bomb') continue; // fell away, or never chain-reacts — nothing to do
                toClear.add(key);
                seen.add(key);
                activated.push({ r: action.r, c: action.c, kind, typeId: this.cells[action.r][action.c] });
                this._expandCaught(kind, action.r, action.c, toClear, seen, deferred);
            } else {
                const candidates: number[] = [];
                for (let t = 0; t < this.typeCount; t++) {
                    if (t !== action.excludeTypeId) candidates.push(t);
                }
                if (candidates.length === 0) continue;
                const typeId = candidates[Math.floor(Math.random() * candidates.length)];
                for (let r = 0; r < this.rows; r++) {
                    for (let c = 0; c < this.cols; c++) {
                        if (this.cells[r][c] !== typeId) continue;
                        for (const cell of this._boxArea(r, c, rules.special.wrappedRadius)) {
                            toClear.add(Board.key(cell.r, cell.c));
                        }
                        activated.push({ r, c, kind: 'wrapped', typeId });
                        this._pending.push({ kind: 'burst', r, c, radius: rules.special.wrappedRadius });
                    }
                }
            }
        }

        return { toClear, activated };
    }

    /**
     * Called instead of `resolve()` for the two swap shapes that always
     * activate unconditionally, match or not: a Color Bomb on either side
     * (candy_crush_rules.md's "Color Bomb Effects" — a Color Bomb detonates
     * on any swap, full stop), or two non-Color-Bomb specials swapped
     * together (a deliberate combo, ignoring color-matching rules entirely).
     * A lone striped/wrapped special swapped with a plain candy does *not*
     * come through here — its activation depends on whether/where a match
     * forms, so `BoardView._attemptSwap` routes that case through the normal
     * `swap()`/`hasAnyMatch()`/`resolve()` path instead, where a match run
     * that happens to include the special's cell picks it up for free via
     * `resolve()`'s `_catchBystanders` bystander logic. `s1`/`s2` must be read
     * (via `getSpecialAt`) *before* calling `swap()`, since this method reads
     * `cells[r1][c1]`/`cells[r2][c2]` directly rather than requiring the
     * positional swap to have already been committed to the model.
     */
    activateSpecialSwap(r1: number, c1: number, s1: SpecialKind | null, r2: number, c2: number, s2: SpecialKind | null): ResolveResult {
        const t1 = this.cells[r1][c1];
        const t2 = this.cells[r2][c2];
        const toClear = new Set<string>([Board.key(r1, c1), Board.key(r2, c2)]);
        const activatedSpecials: { r: number; c: number; kind: SpecialKind; typeId: number }[] = [];
        let colorBombBeam: { originR: number; originC: number; targetTypeId: number; cells: CellPos[] } | null = null;

        if (s1 === 'color-bomb' && s2 === 'color-bomb') {
            activatedSpecials.push({ r: r1, c: c1, kind: 'color-bomb', typeId: t1 });
            activatedSpecials.push({ r: r2, c: c2, kind: 'color-bomb', typeId: t2 });
            for (let r = 0; r < this.rows; r++) {
                for (let c = 0; c < this.cols; c++) toClear.add(Board.key(r, c));
            }
        } else if (s1 === 'color-bomb' || s2 === 'color-bomb') {
            // Color Bomb + normal candy: clear every candy of that color. Color
            // Bomb + striped/wrapped: every candy of that color also detonates
            // as if it were that special (a simplified stand-in for "they all
            // turn into that special and go off").
            const otherTypeId = s1 === 'color-bomb' ? t2 : t1;
            const otherSpecial = s1 === 'color-bomb' ? s2 : s1;
            // The *other* cell's position, not the bomb's own original cell:
            // BoardView._attemptSwap tweens both sprites to each other's
            // screen position before this method runs (this method never
            // calls board.swap() itself, so the model's own r1,c1/r2,c2 never
            // change meaning) — so by the time this fires, the bomb's sprite
            // is visually sitting where the *other* tile started, not where
            // the bomb itself started. Using the bomb's own original cell drew
            // the beam from the wrong tile on screen.
            const bombPos = s1 === 'color-bomb' ? { r: r2, c: c2 } : { r: r1, c: c1 };
            const beamCells: CellPos[] = [];
            for (let r = 0; r < this.rows; r++) {
                for (let c = 0; c < this.cols; c++) {
                    if (this.cells[r][c] !== otherTypeId) continue;
                    toClear.add(Board.key(r, c));
                    beamCells.push({ r, c });
                    if (otherSpecial) {
                        for (const cell of this._areaFor(otherSpecial, r, c)) toClear.add(Board.key(cell.r, cell.c));
                        // Every wrapped detonation double-explodes, including
                        // this combo's first wave — queue each one's second blast.
                        if (otherSpecial === 'wrapped') {
                            this._pending.push({ kind: 'burst', r, c, radius: rules.special.wrappedRadius });
                        }
                    }
                }
            }
            activatedSpecials.push({ r: bombPos.r, c: bombPos.c, kind: 'color-bomb', typeId: otherTypeId });
            colorBombBeam = { originR: bombPos.r, originC: bombPos.c, targetTypeId: otherTypeId, cells: beamCells };
            // Wrapped + Color Bomb only: after this wave settles, a second
            // random color also gets the full wrapped-and-detonate treatment.
            if (otherSpecial === 'wrapped') {
                this._pending.push({ kind: 'colorSweep', excludeTypeId: otherTypeId });
            }
        } else if (s1 && s2) {
            activatedSpecials.push({ r: r1, c: c1, kind: s1, typeId: t1 });
            activatedSpecials.push({ r: r2, c: c2, kind: s2, typeId: t2 });
            const bothStriped = s1.startsWith('striped') && s2.startsWith('striped');
            const bothWrapped = s1 === 'wrapped' && s2 === 'wrapped';
            if (bothStriped) {
                // Full row AND column through the swap point, regardless of either one's own orientation.
                for (const cell of this._areaFor('striped-h', r1, c1)) toClear.add(Board.key(cell.r, cell.c));
                for (const cell of this._areaFor('striped-v', r1, c1)) toClear.add(Board.key(cell.r, cell.c));
            } else if (bothWrapped) {
                const big = rules.special.wrappedRadius * 2;
                for (const cell of this._boxArea(r1, c1, big)) toClear.add(Board.key(cell.r, cell.c));
                // Wrapped detonations always double-explode — queue the second, same-size blast.
                this._pending.push({ kind: 'burst', r: r1, c: c1, radius: big });
            } else {
                // One striped + one wrapped: a thick plus through the swap
                // point, `wrappedRadius`-cells wide in each direction.
                const w = rules.special.wrappedRadius;
                for (let rr = r1 - w; rr <= r1 + w; rr++) {
                    if (!this.inBounds(rr, c1)) continue;
                    for (let cc = 0; cc < this.cols; cc++) toClear.add(Board.key(rr, cc));
                }
                for (let cc = c1 - w; cc <= c1 + w; cc++) {
                    if (!this.inBounds(r1, cc)) continue;
                    for (let rr = 0; rr < this.rows; rr++) toClear.add(Board.key(rr, cc));
                }
                // This combo involves a wrapped tile too — every wrapped
                // detonation always double-explodes, same as `bothWrapped`
                // above; this one was previously missing its second blast.
                this._pending.push({ kind: 'burst', r: r1, c: c1, radius: w });
            }
        }
        // (No fallback branch: per this method's precondition, it's only ever
        // called with a Color Bomb on one side or two non-bomb specials
        // together — never with exactly one non-bomb special, which
        // `BoardView._attemptSwap` routes through the normal match path instead.)

        // The two swapped cells are deliberate participants, already fully
        // accounted for above (including, for the color-bomb branches, using
        // `otherSpecial`'s area) — remove their own map entries *before*
        // catching bystanders so they aren't also treated as incidentally-
        // caught bystanders re-contributing their own base area a second time.
        this.specials.delete(Board.key(r1, c1));
        this.specials.delete(Board.key(r2, c2));
        // `toClear` at this point already holds every cell this combo
        // deliberately, immediately affects (both participants, plus — for
        // the color-bomb branches — every same-color/synthetic-shape cell
        // built above) — passing the whole thing as `_catchBystanders`'s
        // snapshot treats all of it as "this phase," and only a genuinely
        // different special incidentally caught within that blast (not one
        // of this combo's own deliberate cells) defers to the next phase.
        activatedSpecials.push(...this._catchBystanders(toClear));

        return this._finalizeClear(toClear, activatedSpecials, colorBombBeam);
    }

    /**
     * Merges one activating special's own declared area (`_areaFor`) into
     * `toClear` — the atomic, instant consequence of it going off, all in
     * this one phase (matches how a striped candy's activation reads as one
     * beat, not a slow reveal). `seen` is every cell already decided as
     * active this same phase (the caller's snapshot, plus this special's own
     * key); a newly-touched cell already in `toClear` or `seen` merges
     * directly — it's already part of this phase for some other reason, not
     * a new discovery.
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
     * `kind === 'wrapped'` additionally queues its own unconditional next-
     * phase `'burst'` re-detonation (self, not defer-checked against another
     * special) — the guaranteed always-double-explodes rule, unaffected by
     * any of the above.
     */
    private _expandCaught(kind: SpecialKind, r: number, c: number, toClear: Set<string>, seen: Set<string>, deferred: Set<string>): void {
        if (kind === 'wrapped') {
            this._pending.push({ kind: 'burst', r, c, radius: rules.special.wrappedRadius });
        }
        for (const cell of this._areaFor(kind, r, c)) {
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
     * a special (a Color Bomb caught passively is just a bystander — it
     * doesn't chain its own effect) activates immediately via
     * `_expandCaught`, contributing its own area to *this* phase. Anything
     * *that* newly reveals gets deferred to the next `resolve()` call
     * instead of being expanded further here — see `_expandCaught`'s doc for
     * why. This is what turns a chain of catches into a sequence of separate
     * visual beats (one per `resolve()` call) instead of one flattened blast.
     */
    private _catchBystanders(toClear: Set<string>): { r: number; c: number; kind: SpecialKind; typeId: number }[] {
        const activated: { r: number; c: number; kind: SpecialKind; typeId: number }[] = [];
        const seen = new Set<string>();
        const deferred = new Set<string>();
        for (const k of Array.from(toClear)) {
            const kind = this.specials.get(k);
            if (!kind || kind === 'color-bomb' || seen.has(k)) continue;
            seen.add(k);
            const [r, c] = k.split(',').map(Number);
            activated.push({ r, c, kind, typeId: this.cells[r][c] });
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
     * clobbered by `spawned`'s write in `resolve()`) *before* `_catchBystanders`
     * ever gets a chance to see it in `toClear` and activate it — the
     * pre-existing special would vanish having never burst. This bites
     * specifically when the player swaps the special tile itself into a
     * match (its own new cell is a `preferred` swap destination), not the
     * plain-bystander case where the special sits elsewhere in the run
     * untouched by the swap (see `debugLayouts.ts`'s `stripedBystanderCatch`).
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
     * Area an activated special clears. Never called with `'color-bomb'` — it
     * has no fixed area of its own, only the whole-board/whole-color effects
     * `activateSpecialSwap` computes directly.
     *
     * `'striped-h'`/`'striped-v'` clear in the direction they visually point
     * — a horizontally-striped tile clears the row it's in, a
     * vertically-striped tile clears the column (candy_crush_rules.md's
     * "Blast Effect" rule; also matches `BoardView.frameKeyFor`'s sprite
     * choice and `res/candies.png`'s actual art, confirmed by cropping
     * `candy_082`/`candy_084`). The *perpendicular* part of the real rule —
     * a horizontal match produces the vertical-look tile, and vice versa —
     * lives entirely at the two spawn sites in `resolve()`, not here; this
     * method only cares what a kind's own name/art already commits it to.
     */
    private _areaFor(kind: SpecialKind, r: number, c: number): CellPos[] {
        const cells: CellPos[] = [];
        if (kind === 'striped-h') {
            for (let cc = 0; cc < this.cols; cc++) cells.push({ r, c: cc });
        } else if (kind === 'striped-v') {
            for (let rr = 0; rr < this.rows; rr++) cells.push({ r: rr, c });
        } else if (kind === 'wrapped') {
            return this._boxArea(r, c, rules.special.wrappedRadius);
        }
        return cells;
    }

    /** A square block of cells `radius` out from `(r, c)` in every direction (a `radius`-1 wrapped tile clears a 3x3), clipped to the board. */
    private _boxArea(r: number, c: number, radius: number): CellPos[] {
        const cells: CellPos[] = [];
        for (let rr = r - radius; rr <= r + radius; rr++) {
            for (let cc = c - radius; cc <= c + radius; cc++) {
                if (this.inBounds(rr, cc)) cells.push({ r: rr, c: cc });
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
