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
import { SpawnColorBombBeam, LIGHTNING_HOLD_DURATION } from './ColorBombBeamEffect';
import { SpawnPlainBurst, SpawnWrappedBurst, SpawnStripedBeam } from './TileClearEffects';

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
            // A Color Bomb pass holds its candies briefly before popping them,
            // so the beam/ring effect is seen reaching its targets instead of
            // the candies vanishing the instant the beam fires — see
            // `COLOR_BOMB_POP_DELAY`'s doc. Every other pass pops immediately,
            // same as before.
            const popDelay = result.colorBombBeam ? COLOR_BOMB_POP_DELAY : 0;

            const popPromises: Promise<void>[] = [];
            for (const cell of result.cleared) {
                const key = `${cell.r},${cell.c}`;
                if (spawnedKeys.has(key)) continue;

                // Fire-and-forget visual flourish — never awaited, so it never
                // affects cascade pacing. A cleared cell that was a detonating
                // special gets that special's own burst shape; everything else
                // (including every candy a Color Bomb's beam picked out) gets
                // the plain small burst in its own color. A `'color-bomb'`-kind
                // cell falls through to that same plain burst deliberately:
                // the bomb's own cell holds the colorless sentinel id, so
                // `_spawnPlainBurst` finds no color and skips — the beam
                // effect already playing from that exact cell is its flourish.
                const activated = activatedByKey.get(key);
                if (activated?.kind === 'striped-h' || activated?.kind === 'striped-v') {
                    this._spawnStripedBeam(activated.r, activated.c, activated.typeId, activated.kind === 'striped-h' ? 'h' : 'v');
                } else if (activated?.kind === 'wrapped') {
                    this._spawnWrappedBurst(activated.r, activated.c, activated.typeId);
                } else if (!activated || activated.kind === 'color-bomb') {
                    this._spawnPlainBurst(cell.r, cell.c, cell.typeId);
                }

                const node = this.nodes[cell.r][cell.c];
                if (!node) continue;
                this.nodes[cell.r][cell.c] = null;
                const base = this.baseScale.get(node) ?? 1;
                popPromises.push(
                    AfterTween(
                        Tween.create(node)
                            .delay(popDelay)
                            .to(POP_UP_DURATION, { scaleX: base * 1.15, scaleY: base * 1.15 }, Easing.backOut)
                            .to(POP_DOWN_DURATION, { scaleX: 0, scaleY: 0, opacity: 0 }, Easing.cubicIn)
                    ).then(() => {
                        node.removeFromParent();
                        this.baseScale.delete(node);
                    })
                );
            }

            if (result.colorBombBeam) {
                SpawnColorBombBeam(this.boardRoot, this.layout, result.colorBombBeam);
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

    /** A bright flash spanning the *entire* row or column the stripe clears — see `TileClearEffects.SpawnStripedBeam`'s doc. */
    private _spawnStripedBeam(r: number, c: number, typeId: number, orientation: 'h' | 'v'): void {
        const type = theme.tileTypes[typeId];
        if (!type) return;
        SpawnStripedBeam(this.boardRoot, this.layout, this.board.rows, this.board.cols, r, c, type.effectColor, orientation);
    }

    /** A bigger radial burst for a wrapped tile's area detonation. */
    private _spawnWrappedBurst(r: number, c: number, typeId: number): void {
        const type = theme.tileTypes[typeId];
        if (!type) return;
        SpawnWrappedBurst(this.boardRoot, this.cellCenter(r, c), type.effectColor);
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
