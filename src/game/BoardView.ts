/**
 * Renders a `Board` onto the scene and handles input. This is the one file
 * allowed to know about NoonEngine + `theme.ts` sprite keys at once — the
 * `Board` model itself stays theme-agnostic (see AGENTS.md).
 *
 * Input model: tap-to-select-then-tap-adjacent, AND swipe/drag-to-swap — both
 * register on the same fixed grid-cell layer and never conflict (see
 * AGENTS.md's input bullets for the full rationale).
 */

import { Node, Sprite, Tween, Easing, Input, assetCache } from 'noonengine';
import { Board, ColumnMove, SpecialKind, ResolveResult, DebugLayout } from './Board';
import { theme } from '../config/theme';
import { rules } from '../config/rules';
import { BoardLayout, NodeContainer, CellCenter } from './BoardTypes';
import { AfterTween, Delay } from './AsyncUtil';
import { SpawnColorBombBeam, LIGHTNING_HOLD_DURATION, SWEEP_BOLT_LIFETIME } from './ColorBombBeamEffect';
import { SpawnPlainBurst, SpawnAreaEffect } from './TileClearEffects';

export type { BoardLayout, NodeContainer };

const SWAP_DURATION = 0.15;
const FALL_DURATION = 0.28;
const POP_UP_DURATION = 0.08;
const POP_DOWN_DURATION = 0.12;
const SPECIAL_POP_DURATION = 0.18;
const SPECIAL_SETTLE_DURATION = 0.1;
/**
 * How long a Color Bomb pass holds its cleared candies on screen (still
 * visible, not yet popping) before they start destroying — long enough that
 * the beam/ring effect is clearly seen *reaching* its targets first, instead
 * of the candies vanishing the instant the pass starts while the beam is
 * still animating toward them. Must stay comfortably under
 * `LIGHTNING_HOLD_DURATION` (see `ColorBombBeamEffect.ts`) so the beam is
 * still visible when the pop starts.
 */
const COLOR_BOMB_POP_DELAY = LIGHTNING_HOLD_DURATION;
/**
 * The Color Bomb + striped/wrapped conversion beat (see `_runCascade`). A
 * combo whose rule is "every candy of that color *turns into* that special,
 * then they all detonate" is two beats, not one — these split the single
 * model pass that reports it into: beam travels, candies visibly become
 * specials, they sit as specials long enough to read, then they go off.
 */
const CONVERT_BEAM_ARRIVE_DURATION = 0.28;
const CONVERT_POP_DURATION = 0.16;
const CONVERT_SETTLE_DURATION = 0.1;
const CONVERT_HOLD_DURATION = 0.45;
/**
 * Gap between successive detonations of a staggered combo (`cleared[].wave`),
 * and the ceiling on the total stagger — a Color Bomb that converts thirty
 * candies must still finish promptly, so late waves compress rather than
 * dragging the pass out one beat per candy.
 */
const DETONATION_STAGGER_DURATION = 0.07;
const DETONATION_STAGGER_MAX = 0.7;
/** How fast the swapped special vanishes once a Color Bomb has taken its color — see `ResolveResult.consumed`. */
const CONSUMED_POP_DURATION = 0.12;
/**
 * One beat of a `stagedAreas` combo — far longer than a detonation stagger,
 * because each beat is a whole separate effect (an explosion, then a sweep,
 * then another sweep) rather than one more tile going off. The giant candy's
 * hide/show beats below are timed inside it.
 */
const COMBO_STAGE_DURATION = 0.34;
/** How long before a sweep the giant candy ducks out of sight, and how long after it reappears. */
const COMBO_CANDY_HIDE_LEAD = 0.07;
const COMBO_CANDY_RETURN_DELAY = 0.16;
const COMBO_CANDY_FADE_DURATION = 0.09;
/** How many tiles across the grown candy is drawn — a `radius: 1` band is three tiles wide. */
const COMBO_CANDY_TILE_SPAN = 3;
/** A swept beam's lead over the pops it precedes. Its tail is `SWEEP_BOLT_LIFETIME`, so the last wave's bolt dies back as its candies pop rather than hanging over the refilled board. */
const SWEEP_POP_LEAD_DURATION = 0.12;
/** Beam hold for a staged conversion pass — it must fade as its targets detonate, not seconds later. */
const CONVERT_BEAM_HOLD_DURATION =
    CONVERT_BEAM_ARRIVE_DURATION + CONVERT_POP_DURATION + CONVERT_SETTLE_DURATION + CONVERT_HOLD_DURATION;
/** Above every other tile's default 0 — so a dragged/swapping tile draws over the neighbors it slides across. */
const DEFAULT_Z_INDEX = 0;
const DRAG_TARGET_Z_INDEX = 10;
/** Above DRAG_TARGET_Z_INDEX — the tile actually under the pointer must stay visibly on top of the neighbor it's swapping toward, not tie with it. */
const DRAG_ACTIVE_Z_INDEX = 20;

export class BoardView {
    private board: Board;
    private layout: BoardLayout;
    private parent: NodeContainer;
    /**
     * Every grid cell and tile is added here, never directly to `parent`.
     * Grounded reason, not just tidiness: NoonEngine's segmented render list
     * gives each of `parent`'s own *direct* children its own top-level
     * segment, and only a full render-list rebuild reorders segments
     * relative to each other — a `zIndex` change on an already-scene-resident
     * top-level node is silently ignored until the next incidental rebuild
     * (`Scene._fullRebuildRenderList`'s `for (const child of
     * this._rootNode.children)` loop only runs then; the normal per-frame
     * dirty-patch path recompiles a changed node's *own* segment, which
     * reorders nothing among siblings). Nesting the whole board one level
     * down makes it all one shared segment, where `DFS`'s
     * `node.children.sort(_byZIndex)` on that shared parent *does* re-run on
     * the incremental path — confirmed by testing: the elevate-while-dragging
     * fix silently did nothing until this container was added.
     */
    private boardRoot: Node;
    private atlas: any;
    private nodes: (Node | null)[][];
    private baseScale: Map<Node, number> = new Map();

    private selected: { r: number; c: number } | null = null;
    private busy = false;
    private dragging: {
        r: number; c: number; node: Node; origin: { x: number; y: number };
        target: { r: number; c: number; node: Node; origin: { x: number; y: number } } | null;
    } | null = null;

    private score = 0;
    private movesLeft: number;
    private gameOver = false;
    /** typeId -> count still needed, only populated in `'collect'` mode. Never goes below 0. */
    private remaining: Map<number, number> = new Map();

    onScoreChange: ((score: number) => void) | null = null;
    onMovesChange: ((moves: number) => void) | null = null;
    onCollectChange: ((remaining: Map<number, number>) => void) | null = null;
    onGameOver: ((won: boolean) => void) | null = null;

    constructor(parent: NodeContainer, layout: BoardLayout, debugLayout?: DebugLayout) {
        this.parent = parent;
        this.layout = layout;
        this.movesLeft = rules.winCondition.moveLimit;
        this.atlas = assetCache.getAsset(theme.tilesAtlasKey);
        this.board = new Board(debugLayout);

        if (rules.winCondition.mode === 'collect') {
            for (const t of rules.winCondition.targets) this.remaining.set(t.typeId, t.count);
        }

        this.boardRoot = new Node(0, 0);
        this.parent.addChild(this.boardRoot);

        // A fixed, invisible grid of hit-test-only nodes — one per cell,
        // created once and never moved, resized, or destroyed for the life
        // of the board. Input is wired here, NOT on tile sprites: a tile
        // sprite is destroyed and recreated constantly (matches, cascades,
        // refills), so a click handler living on the sprite itself would
        // need updating on every single one of those events to stay
        // pointed at the right cell — miss one spot and a stale handler
        // fires with a stale (r,c). Routing input through cells that never
        // change makes that whole class of bug structurally impossible
        // instead of something to keep getting right by hand.
        for (let r = 0; r < this.board.rows; r++) {
            for (let c = 0; c < this.board.cols; c++) {
                this._createGridCell(r, c);
            }
        }

        this.nodes = [];
        for (let r = 0; r < this.board.rows; r++) {
            this.nodes[r] = [];
            for (let c = 0; c < this.board.cols; c++) {
                // getSpecialAt, not a hardcoded null — a random-start board
                // never has one yet, but a DebugLayout (debugLayouts.ts) can
                // seed specials from the very first frame.
                this.nodes[r][c] = this._createTileNode(r, c, this.board.cells[r][c], this.board.getSpecialAt(r, c));
            }
        }
    }

    private _createGridCell(r: number, c: number): void {
        const { x, y } = this.cellCenter(r, c);
        const cell = new Node(x, y);
        cell.width = this.layout.tileSize;
        cell.height = this.layout.tileSize;
        this.boardRoot.addChild(cell);
        // Tap-to-select and swipe-to-swap both register on the same cell and
        // never conflict: a press that moves under 5px fires CLICK, one that
        // moves past it fires DRAG_START/DRAG/DRAG_END instead (see
        // skills/input/input.md's Drag section) — exactly one of the two
        // paths runs per gesture.
        cell.on(Input.CLICK, () => this._onTileClicked(r, c), this);
        cell.on(Input.DRAG_START, (e: any) => this._onDragStart(r, c), this);
        cell.on(Input.DRAG, (e: any) => this._onDragMove(r, c, e), this);
        cell.on(Input.DRAG_END, (e: any) => this._onSwipe(r, c, e), this);
    }

    private _onDragStart(r: number, c: number): void {
        if (this.busy || this.gameOver) return;
        const node = this.nodes[r][c];
        if (!node) return;

        if (this.selected) {
            this._setHighlight(this.selected.r, this.selected.c, false);
            this.selected = null;
        }

        this.dragging = { r, c, node, origin: this.cellCenter(r, c), target: null };
        node.zIndex = DRAG_ACTIVE_Z_INDEX;
    }

    /** Instantly returns the previewed target neighbor (if any) to its own cell and clears it — called whenever the drag direction changes or ends. */
    private _resetDragTarget(d: NonNullable<BoardView['dragging']>): void {
        if (!d.target) return;
        d.target.node.x = d.target.origin.x;
        d.target.node.y = d.target.origin.y;
        d.target.node.zIndex = DEFAULT_Z_INDEX;
        d.target = null;
    }

    /**
     * Follows the pointer along a single axis only — whichever of dx/dy is
     * currently larger — capped at one tile's distance, and mirrors that
     * same displacement onto whichever neighbor is the current swap
     * candidate — both tiles slide toward each other's cells live, matching
     * real Candy Crush, instead of only the pressed tile moving and the
     * neighbor waiting until release to react. Axis-locked rather than
     * tracking the raw pointer vector: a candy only ever swaps into a
     * horizontal or vertical neighbor, so letting it visually drift
     * diagonally mid-drag never corresponds to a real swap target.
     */
    private _onDragMove(r: number, c: number, e: any): void {
        const d = this.dragging;
        if (!d || d.r !== r || d.c !== c) return;

        const dx = e.x - e.pointer.startX;
        const dy = e.y - e.pointer.startY;
        const useX = Math.abs(dx) > Math.abs(dy);
        const dist = useX ? dx : dy;
        const clamped = Math.max(-this.layout.tileSize, Math.min(this.layout.tileSize, dist));
        const ex = useX ? clamped : 0;
        const ey = useX ? 0 : clamped;

        d.node.x = d.origin.x + ex;
        d.node.y = d.origin.y + ey;

        let tr = r;
        let tc = c;
        if (useX) {
            tc = c + (dx > 0 ? 1 : -1);
        } else {
            tr = r + (dy > 0 ? -1 : 1);
        }

        if (!this.board.inBounds(tr, tc)) {
            this._resetDragTarget(d);
            return;
        }

        if (!d.target || d.target.r !== tr || d.target.c !== tc) {
            this._resetDragTarget(d);
            const targetNode = this.nodes[tr][tc];
            if (targetNode) {
                d.target = { r: tr, c: tc, node: targetNode, origin: this.cellCenter(tr, tc) };
                targetNode.zIndex = DRAG_TARGET_Z_INDEX;
            }
        }

        if (d.target) {
            d.target.node.x = d.target.origin.x - ex;
            d.target.node.y = d.target.origin.y - ey;
        }
    }

    /** Direction is whichever axis moved further from the press's start point — `pointer.startX/Y` is set at pointer-down regardless of gesture type. */
    private _onSwipe(r: number, c: number, e: any): void {
        const d = this.dragging;
        this.dragging = null;
        if (!d || d.r !== r || d.c !== c) return;
        if (this.busy || this.gameOver) return;

        if (!d.target) {
            // No in-bounds neighbor was ever tracked (e.g. dragged straight off
            // the board edge and released) — snap the pressed tile back.
            AfterTween(Tween.create(d.node).to(SWAP_DURATION, { x: d.origin.x, y: d.origin.y }, Easing.backOut))
                .then(() => { d.node.zIndex = DEFAULT_Z_INDEX; });
            return;
        }

        this._attemptSwap(r, c, d.target.r, d.target.c);
    }

    private cellCenter(r: number, c: number): { x: number; y: number } {
        return CellCenter(this.layout, r, c);
    }

    /** Every state (base/striped-h/striped-v/wrapped) is real per-type art — no tinting or rotation trick needed. */
    private frameKeyFor(typeId: number, special: SpecialKind | null): string {
        // Checked before touching `theme.tileTypes[typeId]` — a Color Bomb's
        // `typeId` is only meaningful at spawn time (the run's color, for
        // scoring/bookkeeping); once it falls during a cascade, its cell
        // holds Board's colorless sentinel id, which isn't a valid tileTypes index.
        if (special === 'color-bomb') return theme.colorBombSpriteKey;
        const type = theme.tileTypes[typeId];
        if (!special) return type.spriteKey;
        if (special === 'striped-h') return type.stripedHorizontalSpriteKey;
        if (special === 'striped-v') return type.stripedVerticalSpriteKey;
        return type.wrappedSpriteKey;
    }

    /** Assigns the correct frame for (typeId, special) and returns the normalized display scale. */
    private applyFrame(node: Node, sprite: Sprite, typeId: number, special: SpecialKind | null): number {
        const frame = this.atlas.getFrame(this.frameKeyFor(typeId, special));
        sprite.spriteFrame = frame;
        const scale = (this.layout.tileSize * 0.86) / Math.max(node.width, node.height);
        node.scaleX = scale;
        node.scaleY = scale;
        this.baseScale.set(node, scale);
        return scale;
    }

    private _createTileNode(r: number, c: number, typeId: number, special: SpecialKind | null): Node {
        const { x, y } = this.cellCenter(r, c);
        const node = new Node(x, y);
        const sprite = node.addComponent(Sprite);
        this.applyFrame(node, sprite, typeId, special);
        this.boardRoot.addChild(node);
        return node;
    }

    private _onTileClicked(r: number, c: number): void {
        if (this.busy || this.gameOver) return;

        if (!this.selected) {
            this.selected = { r, c };
            this._setHighlight(r, c, true);
            return;
        }

        const sel = this.selected;
        if (sel.r === r && sel.c === c) {
            this._setHighlight(r, c, false);
            this.selected = null;
            return;
        }

        this._setHighlight(sel.r, sel.c, false);

        if (!this.board.isAdjacent(sel.r, sel.c, r, c)) {
            this.selected = { r, c };
            this._setHighlight(r, c, true);
            return;
        }

        this.selected = null;
        this._attemptSwap(sel.r, sel.c, r, c);
    }

    private _setHighlight(r: number, c: number, on: boolean): void {
        const node = this.nodes[r][c];
        if (!node) return;
        const base = this.baseScale.get(node) ?? 1;
        node.scaleX = on ? base * 1.12 : base;
        node.scaleY = on ? base * 1.12 : base;
    }

    private async _attemptSwap(r1: number, c1: number, r2: number, c2: number): Promise<void> {
        this.busy = true;
        // One player move starts here — resets the cascade multiplier this
        // move's passes escalate through (`rules.scoring.cascadeMultipliers`).
        this.board.beginMove();

        // Read before board.swap() — the special (if any) sitting at each
        // original cell. Whether this pair is a combo (activates
        // unconditionally, never reverts) is `rules.combos`' call, not a
        // hardcoded shape test here: a lone striped/wrapped special swapped
        // with a plain candy matches no combo rule and so follows the normal
        // match path below (see the comment at its branch).
        const s1 = this.board.getSpecialAt(r1, c1);
        const s2 = this.board.getSpecialAt(r2, c2);
        const forcesActivation = Board.swapActivates(s1, s2);

        const n1 = this.nodes[r1][c1]!;
        const n2 = this.nodes[r2][c2]!;
        const p1 = this.cellCenter(r1, c1);
        const p2 = this.cellCenter(r2, c2);

        await Promise.all([
            AfterTween(Tween.create(n1).to(SWAP_DURATION, { x: p2.x, y: p2.y }, Easing.cubicOut)),
            AfterTween(Tween.create(n2).to(SWAP_DURATION, { x: p1.x, y: p1.y }, Easing.cubicOut)),
        ]);

        if (forcesActivation) {
            // A combo swap — always valid, never reverts. The model is
            // swapped first, exactly like the normal match path below, and
            // only then activated: `activateSpecialSwap` reads both cells as
            // they now stand, so model coordinates and on-screen sprites
            // agree about which tile is where. (They didn't always: the combo
            // used to run against pre-swap coordinates while the sprites had
            // already traded places, which aimed the Color Bomb's beam at the
            // bomb's own sprite and left the candy it was swapped with
            // clearing silently, with no beam and no burst.) `this.nodes` is
            // relabelled for the same reason — `_runCascade` looks nodes up
            // by grid label, and every burst/pop effect has to land on the
            // sprite actually sitting there.
            n1.zIndex = DEFAULT_Z_INDEX;
            n2.zIndex = DEFAULT_Z_INDEX;
            this.board.swap(r1, c1, r2, c2);
            this.nodes[r1][c1] = n2;
            this.nodes[r2][c2] = n1;
            const firstResult = this.board.activateSpecialSwap(r1, c1, r2, c2);
            await this._runCascade(undefined, firstResult);
            this.movesLeft--;
            this.onMovesChange?.(this.movesLeft);
            this._checkGameOver();
            this.busy = false;
            return;
        }

        // Either both plain, or exactly one lone striped/wrapped special
        // swapped with a plain candy — both go through the normal match path.
        // For the lone-special case this is what gives the three real Candy
        // Crush outcomes for free: no match at all reverts (special doesn't
        // activate, matches candy_crush_rules.md); a match formed by the
        // *other* candy's color clears normally while the special's cell
        // isn't touched, so it just sits there unactivated at its new
        // position; a match formed using the special's *own* color includes
        // its cell in the matched run, and resolve()'s _floodDetonate treats
        // it as a bystander caught in the clear — activating it from its new
        // position, same as a genuine chain-reaction catch.
        this.board.swap(r1, c1, r2, c2);
        this.nodes[r1][c1] = n2;
        this.nodes[r2][c2] = n1;

        if (!this.board.hasAnyMatch()) {
            // Invalid swap — swap the model back and animate the nodes back too.
            this.board.swap(r1, c1, r2, c2);
            this.nodes[r1][c1] = n1;
            this.nodes[r2][c2] = n2;
            await Promise.all([
                AfterTween(Tween.create(n1).to(SWAP_DURATION, { x: p1.x, y: p1.y }, Easing.cubicOut)),
                AfterTween(Tween.create(n2).to(SWAP_DURATION, { x: p2.x, y: p2.y }, Easing.cubicOut)),
            ]);
            n1.zIndex = DEFAULT_Z_INDEX;
            n2.zIndex = DEFAULT_Z_INDEX;
            this.busy = false;
            return;
        }

        // Both tiles have reached their swapped resting positions and are no
        // longer overlapping — safe to drop back to normal draw order before
        // whichever of them the cascade destroys/replaces next.
        n1.zIndex = DEFAULT_Z_INDEX;
        n2.zIndex = DEFAULT_Z_INDEX;

        await this._runCascade([{ r: r1, c: c1 }, { r: r2, c: c2 }]);

        this.movesLeft--;
        this.onMovesChange?.(this.movesLeft);
        this._checkGameOver();
        this.busy = false;
    }

    /**
     * Polls `board.resolve()` until a pass clears nothing, animating each
     * pass's pop/fall in between. `firstResult` lets a caller that already
     * computed its own first pass (e.g. `activateSpecialSwap`, which isn't a
     * normal color-match) feed it in directly instead of this method calling
     * `resolve()` for that pass — every pass after the first still comes
     * from `resolve()`, since a special activation can itself trigger a
     * normal cascade afterward.
     */
    private async _runCascade(preferredCells?: { r: number; c: number }[], firstResult?: ResolveResult): Promise<void> {
        let first = true;
        for (;;) {
            const result = first && firstResult ? firstResult : this.board.resolve(first ? preferredCells : undefined);
            first = false;
            if (result.cleared.length === 0) break;

            const spawnedKeys = new Set(result.spawned.map(s => `${s.r},${s.c}`));
            const activatedByKey = new Map(result.activatedSpecials.map(a => [`${a.r},${a.c}`, a]));

            // A Color Bomb + striped/wrapped swap doesn't merely clear its
            // targets: the rule is "every candy of that color *turns into*
            // that special, then they all detonate" — two beats, reported by
            // the model in a single pass (one `resolve()` is one visual pass,
            // and splitting the rule across two model passes would let gravity
            // run in between, which the real game doesn't do). So the view
            // stages them here: fire the beam, let it reach its targets,
            // re-frame each converted candy to the special it just became,
            // hold long enough for a board full of stripes to read as such,
            // and only then run the detonation below — which is itself
            // staggered, wave by wave, via `cleared[].wave`. Skipping the beat
            // is what made the combo look wrong — the candies kept their plain
            // art and simply vanished while stripe beams fired out of nowhere.
            const converted = result.colorBombBeam
                ? result.activatedSpecials.filter(a => a.kind !== 'color-bomb')
                : [];
            const staged = converted.length > 0;
            const popPromises: Promise<void>[] = [];
            /**
             * Seconds a given `wave` waits before it fires. A `stagedAreas`
             * combo's beats are whole effects and need room to be read; every
             * other stagger (a Color Bomb's conversions radiating outward, a
             * bomb+bomb sweep crossing the columns) is one tile-beat apart and
             * capped so a large one still finishes promptly.
             */
            const stageCount = result.comboBlast?.stages.length ?? 1;
            const waveTime = (wave: number): number => (stageCount > 1
                ? wave * COMBO_STAGE_DURATION
                : Math.min(wave * DETONATION_STAGGER_DURATION, DETONATION_STAGGER_MAX));

            // The swapped special a Color Bomb consumed goes *first*, before
            // the beam: the swap registers its color and it's gone from its
            // square, rather than sitting there through the beam and the
            // conversion only to pop with everything else at the end.
            const consumedKeys = new Set(result.consumed.map(p => `${p.r},${p.c}`));
            const consumedPromises: Promise<void>[] = [];
            for (const p of result.consumed) {
                const node = this.nodes[p.r][p.c];
                if (!node) continue;
                this.nodes[p.r][p.c] = null;
                // The color it had when it was taken, from `cleared` — the
                // model has already run gravity, so its board cell now holds
                // whatever fell into it.
                const taken = result.cleared.find(cell => cell.r === p.r && cell.c === p.c);
                if (taken) this._spawnPlainBurst(p.r, p.c, taken.typeId);
                consumedPromises.push(
                    AfterTween(
                        Tween.create(node).to(CONSUMED_POP_DURATION, { scaleX: 0, scaleY: 0, opacity: 0 }, Easing.cubicIn)
                    ).then(() => {
                        node.removeFromParent();
                        this.baseScale.delete(node);
                    })
                );
            }

            // Awaited, not merely started: the candy is gone *before* the
            // lightning goes out, not fading out underneath it.
            if (consumedPromises.length) await Promise.all(consumedPromises);

            // A swept beam is timed to the detonation waves it precedes, so it
            // must hold only as long as the sweep takes; a staged conversion
            // beam holds for the conversion; everything else uses the default.
            const maxWave = result.cleared.reduce((m, cell) => Math.max(m, cell.wave), 0);
            const sweepSpan = Math.min(maxWave * DETONATION_STAGGER_DURATION, DETONATION_STAGGER_MAX);
            if (result.colorBombBeam) {
                const hold = staged
                    ? CONVERT_BEAM_HOLD_DURATION
                    : result.colorBombBeam.sweep
                        ? sweepSpan + SWEEP_BOLT_LIFETIME
                        : undefined;
                SpawnColorBombBeam(
                    this.boardRoot, this.layout, result.colorBombBeam,
                    hold, DETONATION_STAGGER_DURATION
                );
            }

            if (staged) {
                await Delay(CONVERT_BEAM_ARRIVE_DURATION);
                for (const a of converted) {
                    const node = this.nodes[a.r][a.c];
                    if (!node) continue;
                    const sprite = node.getComponent(Sprite) as Sprite;
                    // a.typeId, not the board cell — same capture-before-mutation
                    // rule `spawned` follows; the model has already run gravity.
                    const base = this.applyFrame(node, sprite, a.typeId, a.kind);
                    Tween.create(node)
                        .to(CONVERT_POP_DURATION, { scaleX: base * 1.28, scaleY: base * 1.28 }, Easing.backOut)
                        .to(CONVERT_SETTLE_DURATION, { scaleX: base, scaleY: base }, Easing.quadOut)
                        .start();
                }
                await Delay(CONVERT_POP_DURATION + CONVERT_SETTLE_DURATION + CONVERT_HOLD_DURATION);
            }

            // A Color Bomb pass with nothing to convert (a plain-candy target)
            // still holds its candies while the beam reaches them — see
            // `COLOR_BOMB_POP_DELAY`'s doc. A staged pass has already spent
            // that time on the conversion beat above, so it pops immediately,
            // as does every non-beam pass.
            const popDelay = !result.colorBombBeam || staged
                ? 0
                : result.colorBombBeam.sweep
                    ? SWEEP_POP_LEAD_DURATION
                    : COLOR_BOMB_POP_DELAY;

            for (const cell of result.cleared) {
                const key = `${cell.r},${cell.c}`;
                if (spawnedKeys.has(key) || consumedKeys.has(key)) continue;

                // Fire-and-forget visual flourish — never awaited, so it never
                // affects cascade pacing. A cleared cell that was a detonating
                // special gets that special's own burst shape; everything else
                // (including every candy a Color Bomb's beam picked out) gets
                // the plain small burst in its own color. A `'color-bomb'`-kind
                // cell falls through to that same plain burst deliberately:
                // the bomb's own cell holds the colorless sentinel id, so
                // `_spawnPlainBurst` finds no color and skips — the beam
                // effect already playing from that exact cell is its flourish.
                // A staggered combo detonates in sequence — the model assigns
                // each cell the beat that claimed it, so the effect and the
                // pop for that cell both wait for it.
                const waveDelay = waveTime(cell.wave);
                const activated = activatedByKey.get(key);
                const spawnEffect = (): void => {
                    if (activated && activated.kind !== 'color-bomb') {
                        this._spawnActivationEffect(activated.r, activated.c, activated.kind, activated.typeId);
                    } else {
                        this._spawnPlainBurst(cell.r, cell.c, cell.typeId);
                    }
                };
                if (waveDelay > 0) void Delay(waveDelay).then(spawnEffect);
                else spawnEffect();

                const node = this.nodes[cell.r][cell.c];
                if (!node) continue;
                this.nodes[cell.r][cell.c] = null;
                const base = this.baseScale.get(node) ?? 1;
                popPromises.push(
                    AfterTween(
                        Tween.create(node)
                            .delay(popDelay + waveDelay)
                            .to(POP_UP_DURATION, { scaleX: base * 1.15, scaleY: base * 1.15 }, Easing.backOut)
                            .to(POP_DOWN_DURATION, { scaleX: 0, scaleY: 0, opacity: 0 }, Easing.cubicIn)
                    ).then(() => {
                        node.removeFromParent();
                        this.baseScale.delete(node);
                    })
                );
            }

            // A combo that asked to be drawn as one blast (`presentAsBlast`)
            // reports the shape it actually cleared, so the cross / 5x5 /
            // 3-wide cross is drawn as itself rather than as whichever two
            // specials happened to be swapped into each other.
            if (result.comboBlast) {
                const blast = result.comboBlast;
                const color = this._effectColorFor(blast.typeId);
                for (const stage of blast.stages) {
                    const at = waveTime(stage.wave);
                    const draw = (): void => SpawnAreaEffect(
                        this.boardRoot, this.layout, this.board.rows, this.board.cols,
                        blast.r, blast.c, stage.area, color
                    );
                    if (at > 0) void Delay(at).then(draw);
                    else draw();
                }
                if (blast.stages.length > 1 && blast.kind) {
                    this._playComboCandy(blast.r, blast.c, blast.typeId, blast.kind, blast.stages.map(st => waveTime(st.wave)));
                }
            }

            for (const s of result.spawned) {
                const node = this.nodes[s.r][s.c];
                if (!node) continue;
                const sprite = node.getComponent(Sprite) as Sprite;
                // s.typeId, not board.cells[s.r][s.c] — resolve() already ran
                // gravity by the time we get here, so whatever fell into this
                // (r,c) afterward would silently overwrite which color renders.
                const base = this.applyFrame(node, sprite, s.typeId, s.special);
                popPromises.push(
                    AfterTween(
                        Tween.create(node)
                            .to(SPECIAL_POP_DURATION, { scaleX: base * 1.3, scaleY: base * 1.3 }, Easing.elasticOut)
                            .to(SPECIAL_SETTLE_DURATION, { scaleX: base, scaleY: base }, Easing.quadOut)
                    )
                );
            }

            await Promise.all(popPromises);

            const fallPromises: Promise<void>[] = [];
            for (const move of result.moves) {
                if (move.fromRow !== null) {
                    const node = this.nodes[move.fromRow][move.col];
                    this.nodes[move.fromRow][move.col] = null;
                    if (!node) continue;
                    this.nodes[move.toRow][move.col] = node;
                    const target = this.cellCenter(move.toRow, move.col);
                    fallPromises.push(AfterTween(Tween.create(node).to(FALL_DURATION, { x: target.x, y: target.y }, Easing.backOut)));
                } else {
                    const spawnStart = this.cellCenter(0, move.col);
                    const node = new Node(spawnStart.x, this.layout.top + this.layout.tileSize);
                    const sprite = node.addComponent(Sprite);
                    this.applyFrame(node, sprite, move.typeId, null);
                    this.boardRoot.addChild(node);
                    this.nodes[move.toRow][move.col] = node;
                    const target = this.cellCenter(move.toRow, move.col);
                    fallPromises.push(AfterTween(Tween.create(node).to(FALL_DURATION, { x: target.x, y: target.y }, Easing.backOut)));
                }
            }

            await Promise.all(fallPromises);

            this.score += result.scoreDelta;
            this.onScoreChange?.(this.score);

            if (rules.winCondition.mode === 'collect') {
                for (const cell of result.cleared) {
                    const left = this.remaining.get(cell.typeId);
                    if (left !== undefined) this.remaining.set(cell.typeId, Math.max(0, left - 1));
                }
                this.onCollectChange?.(this.remaining);
            }

            await Delay(0.05);
        }
    }

    /** Small radial puff at a plain match's cell — the "3-match" effect. */
    private _spawnPlainBurst(r: number, c: number, typeId: number): void {
        const type = theme.tileTypes[typeId];
        if (!type) return; // e.g. a cleared Color Bomb sentinel cell — no color to burst with
        SpawnPlainBurst(this.boardRoot, this.cellCenter(r, c), type.effectColor);
    }

    /**
     * Draws one activating special's effect as the *shape it clears*, read
     * from the same `rules.activation[kind].area` the model used to decide
     * which cells go — never from a per-kind branch here. A retuned rule (a
     * bigger wrapped radius, a stripe that clears a cross) therefore changes
     * the visual and the clear together, with no second place to update.
     */
    private _spawnActivationEffect(r: number, c: number, kind: SpecialKind, typeId: number): void {
        SpawnAreaEffect(
            this.boardRoot, this.layout, this.board.rows, this.board.cols,
            r, c, rules.activation[kind].area, this._effectColorFor(typeId)
        );
    }

    /**
     * The combo candy of a `stagedAreas` combo: the striped half, grown to
     * span the band it's about to clear, standing in for both swapped tiles
     * once they've popped.
     *
     * It doesn't just sit there through the sequence — it *takes* each sweep.
     * `stageTimes[0]` is the wrapped half's explosion, after which it appears;
     * then before every later stage it ducks out of sight, the sweep for that
     * stage plays, and it returns — except after the last one, which it never
     * comes back from. That hide/return is what sells the sweeps as the candy
     * itself firing rather than as unrelated beams crossing its square.
     */
    private _playComboCandy(r: number, c: number, typeId: number, kind: SpecialKind, stageTimes: number[]): void {
        const { x, y } = this.cellCenter(r, c);
        const node = new Node(x, y);
        const sprite = node.addComponent(Sprite);
        const base = this.applyFrame(node, sprite, typeId, kind);
        const grown = base * COMBO_CANDY_TILE_SPAN;
        node.scaleX = 0;
        node.scaleY = 0;
        this.boardRoot.addChild(node);
        node.zIndex = DRAG_ACTIVE_Z_INDEX; // over the tiles it's about to clear

        const appearAt = stageTimes[0] + COMBO_CANDY_RETURN_DELAY;
        const tween = Tween.create(node)
            .delay(appearAt)
            .to(COMBO_CANDY_FADE_DURATION, { scaleX: grown, scaleY: grown, opacity: 1 }, Easing.backOut);

        let cursor = appearAt + COMBO_CANDY_FADE_DURATION;
        stageTimes.slice(1).forEach((sweepAt, i) => {
            const last = i === stageTimes.length - 2;
            const hideAt = sweepAt - COMBO_CANDY_HIDE_LEAD;
            tween.delay(Math.max(0.001, hideAt - cursor))
                .to(COMBO_CANDY_FADE_DURATION, { opacity: 0 }, Easing.cubicIn);
            cursor = hideAt + COMBO_CANDY_FADE_DURATION;
            if (last) return; // hidden before the final sweep, and gone for good
            const backAt = sweepAt + COMBO_CANDY_RETURN_DELAY;
            tween.delay(Math.max(0.001, backAt - cursor))
                .to(COMBO_CANDY_FADE_DURATION, { opacity: 1 }, Easing.quadOut);
            cursor = backAt + COMBO_CANDY_FADE_DURATION;
        });

        AfterTween(tween).then(() => {
            node.removeFromParent();
            this.baseScale.delete(node);
        });
    }

    /** A tile type's own effect tint, falling back to the colorless one for a Color Bomb's sentinel id (`theme.colorBombEffectColor`). */
    private _effectColorFor(typeId: number): string {
        return theme.tileTypes[typeId]?.effectColor ?? theme.colorBombEffectColor;
    }

    private _checkGameOver(): void {
        if (this.gameOver) return;
        if (rules.winCondition.mode === 'score') {
            if (this.score >= rules.winCondition.targetScore) {
                this.gameOver = true;
                this.onGameOver?.(true);
            } else if (this.movesLeft <= 0) {
                this.gameOver = true;
                this.onGameOver?.(false);
            }
            return;
        }

        const allCollected = Array.from(this.remaining.values()).every(v => v <= 0);
        if (allCollected) {
            this.gameOver = true;
            this.onGameOver?.(true);
        } else if (this.movesLeft <= 0) {
            this.gameOver = true;
            this.onGameOver?.(false);
        }
    }
}
