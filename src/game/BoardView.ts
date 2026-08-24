/**
 * Renders a `Board` onto the scene and handles input. This is the one file
 * allowed to know about NoonEngine + `theme.ts` sprite keys at once — the
 * `Board` model itself stays theme-agnostic (see AGENTS.md).
 *
 * Input model: tap-to-select-then-tap-adjacent, AND swipe/drag-to-swap — both
 * register on the same fixed grid-cell layer and never conflict (see
 * AGENTS.md's input bullets for the full rationale).
 */

import { Node, Sprite, Tween, Easing, Input, assetCache, ParticleEmitter, Graphics, ColorRect, BlendMode, Material, ShaderLibrary } from 'noonengine';
import { Board, ColumnMove, SpecialKind, ResolveResult, DebugLayout } from './Board';
import { theme } from '../config/theme';
import { rules } from '../config/rules';

/**
 * EXPERIMENTAL, curiosity-driven alternative to `BoardView._spawnLightningBeam`
 * (2026-08-25) — a GPU-shader version of the Color Bomb beam, toggled via
 * `?beam=shader` in the URL (see `_runCascade`'s call site) and never used by
 * default; `_spawnLightningBeam` remains the real effect. See
 * `_spawnLightningBeamShader`'s own doc for why this needs `ColorRect`
 * (not `Graphics`) and the reasoning behind each shader line.
 */
const COLOR_BOMB_BEAM_SHADER_FRAG = /* glsl */`#version 300 es
precision mediump float;

uniform vec4  u_color;
uniform float u_time;
uniform float u_seed;
// How many tile-widths long this specific bolt is (dist / tileSize, set per
// bolt in _spawnLightningBeamShader). t (below) is always 0..1 regardless of
// a bolt's actual on-screen length, so a fixed t*12.0-style frequency packs
// the exact same cycle count onto every bolt — dense/tight on a short one
// (the "two waves merging" look), stretched sparse and thin on a long one.
// Scaling frequency by this uniform keeps the wave density consistent in
// world-space instead of in fractional-t space, so every bolt reads the same
// regardless of how far its target is.
uniform float u_lengthScale;

in vec2 v_texCoord;
out vec4 fragColor;

float hash(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
    // Based on the very first version of this shader, after several rounds
    // of jaggedness/edge tuning (higher spatial frequency, segmented value
    // noise, narrower/wider smoothstep bands) never landed on something
    // better than that original look — noise/core/aura below are back to
    // those original values, with two deliberate exceptions: aura's radius
    // is 0.22, not the original 0.5 (0.5 let the quad's straight edge clip
    // the still-bright glow before it faded to zero whenever the wiggle
    // pushed the centerline off-center — a real geometric bug, not a style
    // choice), and wave/noise below use different frequencies than the
    // original single sine, to fix "looks like a curve" without touching
    // anything that caused the earlier broken-beam bug (see their own docs).
    float t = v_texCoord.x;               // 0 at the Color Bomb, 1 at the target
    float damp = sin(t * 3.14159265);      // 0 at both ends, pins the endpoints exactly
    // Subtracting t*freq (not adding) makes each wave travel outward from
    // the bomb to the target as u_time grows — same reasoning as the CPU
    // version's _sineJitteredPoints fix (a point of constant phase needs t
    // to grow with u_time, which only happens with a minus sign here).
    // Two sine octaves (a "sum of sines," the standard trick for a
    // busier-looking waveform without discontinuities) instead of a single
    // low-frequency sine — one sine alone only completed about 1.4 cycles
    // across the whole beam, reading as one gentle bend/curve. A first
    // attempt at this used a *third*, much higher-frequency octave (t*41)
    // plus the noise term's original t*131.0 spatial frequency (see noise
    // below) — that packed in too many small, tightly-spaced ripples,
    // reading as dense flicker/static rather than a few clear zigzag bends
    // ("the zigzag flickering is too close"). Dropped the third octave and
    // pulled both remaining frequencies much closer together (12/20 instead
    // of 9/23) for a couple of clearly-spaced bends instead of either one
    // smooth curve or a blur of tiny ones. Still just a sum of continuous
    // sin() terms — no floor()/segmentation, so this can't reintroduce the
    // broken-beam bug no matter how the frequencies are tuned.
    // freqScale = 1.0 at a ~3-tile-long bolt (roughly the length that
    // produced the liked "merging" look), scaling up for longer bolts and
    // down for shorter ones so every bolt gets the same wave density per
    // tile of travel, not the same total cycle count regardless of length.
    float freqScale = u_lengthScale / 3.0;
    float wave = sin(u_time * 10.0 - t * 12.0 * freqScale + u_seed) * 0.14
               + sin(u_time * 16.0 - t * 20.0 * freqScale + u_seed * 1.7) * 0.06;
    // Disabled to test whether noise (not wave) was the source of the "too
    // close" flicker — wave alone is fully deterministic (driven only by
    // u_time, no hash() involved), so with this at 0.0 the beam should
    // animate as a clean, smooth-moving zigzag with no grainy shimmer at
    // all. Multiplied by 0.0 rather than deleted so it's a one-number
    // change to bring back (restore the 0.08 to re-enable).
    float noise = (hash(floor(u_time * 30.0) + t * 18.0 + u_seed) - 0.5) * 0.0;
    float centerline = 0.5 + (wave + noise) * damp;

    float dist = abs(v_texCoord.y - centerline);
    float aura = smoothstep(0.22, 0.0, dist);  // 0.22, not the original 0.5 — see the note above main()
    float core = smoothstep(0.06, 0.0, dist);

    vec3 auraColor = vec3(0.0, 0.78, 1.0);
    vec3 coreColor = vec3(0.9, 1.0, 1.0);
    vec3 color = auraColor * aura * 0.6 + coreColor * core;
    float alpha = clamp(aura * 0.55 + core, 0.0, 1.0);

    fragColor = vec4(color, alpha) * u_color;
}`;

let colorBombBeamShaderRegistered = false;
/** Registers `COLOR_BOMB_BEAM_SHADER_FRAG` with `ShaderLibrary` on first use — idempotent, safe to call every time `?beam=shader` fires. */
function ensureColorBombBeamShaderRegistered(): void {
    if (colorBombBeamShaderRegistered) return;
    ShaderLibrary.register('color-bomb-beam', { glsl: { FRAG: COLOR_BOMB_BEAM_SHADER_FRAG } });
    colorBombBeamShaderRegistered = true;
}

export interface BoardLayout {
    left: number;
    top: number;
    tileSize: number;
}

/** `Scene` isn't a `Node` subclass but exposes the same `addChild` — this is all BoardView needs from its container. */
export interface NodeContainer {
    addChild(node: Node, zIndex?: number): void;
}

function afterTween(t: any): Promise<void> {
    return new Promise(resolve => {
        t.onComplete(() => resolve());
        t.start();
    });
}

function delay(seconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

const SWAP_DURATION = 0.15;
const FALL_DURATION = 0.28;
const POP_UP_DURATION = 0.08;
const POP_DOWN_DURATION = 0.12;
const SPECIAL_POP_DURATION = 0.18;
const SPECIAL_SETTLE_DURATION = 0.1;
// TEMPORARY, testing-only values (requested 2026-08-25 to eyeball the beam
// itself without candies popping mid-inspection) — a real 4s hold/pop-delay
// would feel unacceptably unresponsive in actual play. Dial back down to
// something like 0.45/0.3/0.2 once the beam's position/color/style is confirmed.
const LIGHTNING_HOLD_DURATION = 3.7;
const LIGHTNING_FADE_DURATION = 0.3;
/**
 * How long a Color Bomb pass holds its cleared candies on screen (still
 * visible, not yet popping) before they start destroying — long enough that
 * the beam/ring effect is clearly seen *reaching* its targets first, instead
 * of the candies vanishing the instant the pass starts while the beam is
 * still animating toward them. Must stay comfortably under
 * `LIGHTNING_HOLD_DURATION` so the beam is still visible when the pop starts.
 */
const COLOR_BOMB_POP_DELAY = 3.7;
/**
 * Color Bomb beam palette — aqua with transparency, fixed regardless of the
 * targeted color (unlike the striped/wrapped effects, which tint from
 * `theme.tileTypes[].effectColor`): the Color Bomb's own identity is meant to
 * read as one consistent "energy" effect, not blend into whichever color it
 * happens to be clearing this time.
 */
const COLOR_BOMB_BEAM_AURA_COLOR = 'rgba(0, 200, 255, 0.35)';
const COLOR_BOMB_BEAM_MID_COLOR = 'rgba(120, 235, 255, 0.75)';
const COLOR_BOMB_BEAM_CORE_COLOR = 'rgba(230, 255, 255, 0.95)';
const COLOR_BOMB_RING_COLOR = 'rgba(0, 225, 255, 0.8)';
const COLOR_BOMB_BEAM_SEGMENTS = 14;
const STRIPE_BEAM_HOLD_DURATION = 0.12;
const STRIPE_BEAM_FADE_DURATION = 0.18;
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
    /** `?beam=shader` opts into the experimental GPU-shader Color Bomb beam (`_spawnLightningBeamShader`) instead of the real one (`_spawnLightningBeam`) — see either method's doc. */
    private useShaderBeam = new URLSearchParams(location.search).get('beam') === 'shader';
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
            afterTween(Tween.create(d.node).to(SWAP_DURATION, { x: d.origin.x, y: d.origin.y }, Easing.backOut))
                .then(() => { d.node.zIndex = DEFAULT_Z_INDEX; });
            return;
        }

        this._attemptSwap(r, c, d.target.r, d.target.c);
    }

    private cellCenter(r: number, c: number): { x: number; y: number } {
        const { left, top, tileSize } = this.layout;
        return { x: left + c * tileSize + tileSize / 2, y: top - r * tileSize - tileSize / 2 };
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

        // Must be read before board.swap() — the special (if any) that was
        // sitting at each original cell. A Color Bomb on either side, or two
        // specials swapped together, always activates unconditionally; a lone
        // striped/wrapped special swapped with a plain candy instead follows
        // the normal match path below (see the comment at its branch).
        const s1 = this.board.getSpecialAt(r1, c1);
        const s2 = this.board.getSpecialAt(r2, c2);
        const forcesActivation = s1 === 'color-bomb' || s2 === 'color-bomb' || (s1 !== null && s2 !== null);

        const n1 = this.nodes[r1][c1]!;
        const n2 = this.nodes[r2][c2]!;
        const p1 = this.cellCenter(r1, c1);
        const p2 = this.cellCenter(r2, c2);

        await Promise.all([
            afterTween(Tween.create(n1).to(SWAP_DURATION, { x: p2.x, y: p2.y }, Easing.cubicOut)),
            afterTween(Tween.create(n2).to(SWAP_DURATION, { x: p1.x, y: p1.y }, Easing.cubicOut)),
        ]);

        if (forcesActivation) {
            // Color Bomb on either side, or two specials together — always
            // valid, never reverts. activateSpecialSwap reads the original
            // cells directly, so the board's own swap() never needs to run
            // for this path; both original cells always end up cleared
            // regardless.
            n1.zIndex = DEFAULT_Z_INDEX;
            n2.zIndex = DEFAULT_Z_INDEX;
            const firstResult = this.board.activateSpecialSwap(r1, c1, s1, r2, c2, s2);
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
                afterTween(Tween.create(n1).to(SWAP_DURATION, { x: p1.x, y: p1.y }, Easing.cubicOut)),
                afterTween(Tween.create(n2).to(SWAP_DURATION, { x: p2.x, y: p2.y }, Easing.cubicOut)),
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
                // gets the plain small burst.
                const activated = activatedByKey.get(key);
                if (activated?.kind === 'striped-h' || activated?.kind === 'striped-v') {
                    this._spawnStripedBeam(activated.r, activated.c, activated.typeId, activated.kind === 'striped-h' ? 'h' : 'v');
                } else if (activated?.kind === 'wrapped') {
                    this._spawnWrappedBurst(activated.r, activated.c, activated.typeId);
                } else if (!activated) {
                    this._spawnPlainBurst(cell.r, cell.c, cell.typeId);
                }

                const node = this.nodes[cell.r][cell.c];
                if (!node) continue;
                this.nodes[cell.r][cell.c] = null;
                const base = this.baseScale.get(node) ?? 1;
                popPromises.push(
                    afterTween(
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
                if (this.useShaderBeam) this._spawnLightningBeamShader(result.colorBombBeam);
                else this._spawnLightningBeam(result.colorBombBeam);
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
                    afterTween(
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
                    fallPromises.push(afterTween(Tween.create(node).to(FALL_DURATION, { x: target.x, y: target.y }, Easing.backOut)));
                } else {
                    const spawnStart = this.cellCenter(0, move.col);
                    const node = new Node(spawnStart.x, this.layout.top + this.layout.tileSize);
                    const sprite = node.addComponent(Sprite);
                    this.applyFrame(node, sprite, move.typeId, null);
                    this.boardRoot.addChild(node);
                    this.nodes[move.toRow][move.col] = node;
                    const target = this.cellCenter(move.toRow, move.col);
                    fallPromises.push(afterTween(Tween.create(node).to(FALL_DURATION, { x: target.x, y: target.y }, Easing.backOut)));
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

            await delay(0.05);
        }
    }

    /** Small radial puff at a plain match's cell — the "3-match" effect. */
    private _spawnPlainBurst(r: number, c: number, typeId: number): void {
        const type = theme.tileTypes[typeId];
        if (!type) return; // e.g. a cleared Color Bomb sentinel cell — no color to burst with
        this._burst(this.cellCenter(r, c), type.effectColor, { count: 8, lifetime: 0.3, speedMin: 40, speedMax: 90, angleMin: 0, angleMax: Math.PI * 2 });
    }

    /**
     * A bright flash spanning the *entire* row or column the stripe clears —
     * not a burst confined near the tile's own cell. Matches real Candy
     * Crush's striped-candy activation, which reads as a beam sweeping the
     * whole line, not a puff at one point on it. Built as a plain `Node`+
     * `ColorRect` sized to the board's full width (or height) rather than a
     * particle effect, since "cover the whole line" is a rectangle, not a
     * radiating burst.
     */
    private _spawnStripedBeam(r: number, c: number, typeId: number, orientation: 'h' | 'v'): void {
        const type = theme.tileTypes[typeId];
        if (!type) return;
        const { left, top, tileSize } = this.layout;
        const boardWidth = this.board.cols * tileSize;
        const boardHeight = this.board.rows * tileSize;
        const thickness = tileSize * 0.5;

        const node = orientation === 'h'
            ? new Node(left + boardWidth / 2, this.cellCenter(r, 0).y)
            : new Node(this.cellCenter(0, c).x, top - boardHeight / 2);
        node.width = orientation === 'h' ? boardWidth : thickness;
        node.height = orientation === 'h' ? thickness : boardHeight;
        this.boardRoot.addChild(node);

        const rect = node.addComponent(ColorRect);
        rect.color = type.effectColor;

        afterTween(
            Tween.create(node).delay(STRIPE_BEAM_HOLD_DURATION).to(STRIPE_BEAM_FADE_DURATION, { opacity: 0 }, Easing.cubicIn)
        ).then(() => node.removeFromParent());
    }

    /** A bigger radial burst for a wrapped tile's area detonation. */
    private _spawnWrappedBurst(r: number, c: number, typeId: number): void {
        const type = theme.tileTypes[typeId];
        if (!type) return;
        this._burst(this.cellCenter(r, c), type.effectColor, { count: 22, lifetime: 0.4, speedMin: 100, speedMax: 190, angleMin: 0, angleMax: Math.PI * 2 });
    }

    /** Shared one-shot `ParticleEmitter` burst — spawns, fires, and removes itself once its longest-lived particle has died. */
    private _burst(pos: { x: number; y: number }, color: string, opts: { count: number; lifetime: number; speedMin: number; speedMax: number; angleMin: number; angleMax: number }): void {
        const node = new Node(pos.x, pos.y);
        this.boardRoot.addChild(node);
        const emitter = node.addComponent(ParticleEmitter);
        emitter.emitting = false;
        emitter.lifetimeMin = opts.lifetime * 0.7;
        emitter.lifetimeMax = opts.lifetime;
        emitter.speedMin = opts.speedMin;
        emitter.speedMax = opts.speedMax;
        emitter.angleMin = opts.angleMin;
        emitter.angleMax = opts.angleMax;
        emitter.scaleStart = 1;
        emitter.scaleEnd = 0.2;
        emitter.alphaStart = 1;
        emitter.alphaEnd = 0;
        emitter.colorStart = color;
        emitter.colorEnd = color;
        emitter.burst(opts.count);
        delay(opts.lifetime + 0.05).then(() => node.removeFromParent());
    }

    /**
     * A brief flash of jittered energy bolts from the Color Bomb's cell to
     * every cell of the color it targeted. Each bolt is 3 layered `Graphics`
     * polyline nodes (wide low-alpha aura, mid colored strand, thin bright
     * core) sharing one animated jittered point path per bolt, all
     * additive-blended (`BlendMode.ADDITIVE`) for a glowing look — `Graphics`
     * has no shadow/glow or gradient support of its own (checked against
     * `engine/types/components/rendering/Graphics.d.ts`), so the glow comes
     * from stacking passes, not a blur parameter. `drawPolygon` sets its
     * owning node to a *single* shape (re-calling it replaces the previous
     * one, it doesn't accumulate a path — same reason the old single-line
     * version used one node per target), so a 3-layer bolt needs 3 separate
     * nodes, not 3 calls on one; each is re-callable in place every frame
     * though (`_drawBeamLayer`), which is how the animation works.
     * `tessellate` draws each layer as raw geometry with no async bake
     * round-trip — required here since the shape changes every frame (the
     * docs' own recommended use case for `tessellate=true`).
     *
     * The animated wiggle (matching the reference demo's sine+noise beam,
     * not a one-shot static jitter) is driven by a single `Tween.onUpdate`
     * callback re-drawing every bolt's 3 layers each frame with
     * `_sineJitteredPoints` — see that method's doc for the wave formula.
     *
     * A small aqua ring pulses at each target on impact, and a burst flashes
     * at the origin — both reuse `_burst`'s existing radial `ParticleEmitter`
     * for the sparkle, kept aqua-tinted regardless of the target color for
     * the same one-consistent-effect reason the beam colors are fixed (see
     * the `COLOR_BOMB_BEAM_*` constants).
     */
    private _spawnLightningBeam(beam: NonNullable<ResolveResult['colorBombBeam']>): void {
        if (beam.cells.length === 0) return;
        const { tileSize } = this.layout;
        const origin = this.cellCenter(beam.originR, beam.originC);
        const root = new Node(0, 0);
        this.boardRoot.addChild(root);

        interface Bolt { target: { x: number; y: number }; seed: number; aura: Graphics; mid: Graphics; core: Graphics; }
        const bolts: Bolt[] = [];

        const makeLayer = (width: number): Graphics => {
            const node = new Node(0, 0);
            root.addChild(node);
            const gfx = node.addComponent(Graphics);
            gfx.tessellate = true;
            gfx.setLineWidth(width);
            gfx.material.blend = BlendMode.ADDITIVE;
            return gfx;
        };

        for (const cell of beam.cells) {
            const target = this.cellCenter(cell.r, cell.c);
            bolts.push({
                target,
                seed: Math.random() * Math.PI * 2,
                aura: makeLayer(tileSize * 0.16),
                mid: makeLayer(tileSize * 0.07),
                core: makeLayer(tileSize * 0.025),
            });

            const ringNode = new Node(target.x, target.y);
            root.addChild(ringNode);
            const ring = ringNode.addComponent(Graphics);
            ring.tessellate = true;
            ring.setLineWidth(tileSize * 0.04);
            ring.drawCircle(tileSize * 0.32, null, COLOR_BOMB_RING_COLOR);
            ring.material.blend = BlendMode.ADDITIVE;
        }

        const redraw = (time: number) => {
            for (const bolt of bolts) {
                this._drawBeamLayer(bolt.aura, this._sineJitteredPoints(origin, bolt.target, tileSize, time, bolt.seed, 1), COLOR_BOMB_BEAM_AURA_COLOR);
                this._drawBeamLayer(bolt.mid, this._sineJitteredPoints(origin, bolt.target, tileSize, time, bolt.seed, 0.7), COLOR_BOMB_BEAM_MID_COLOR);
                this._drawBeamLayer(bolt.core, this._sineJitteredPoints(origin, bolt.target, tileSize, time, bolt.seed, 0.4), COLOR_BOMB_BEAM_CORE_COLOR);
            }
        };
        redraw(0);

        // A no-op `x` tween purely to get a `duration`-long, per-frame
        // `onUpdate(target, progress)` ticker — the animation itself lives
        // entirely in `redraw`, this tween's own target property never
        // actually needs to change.
        const driver = Tween.create(root).to(LIGHTNING_HOLD_DURATION, { x: root.x }, Easing.linear);
        driver.onUpdate((_target: Node, progress: number) => redraw(progress * LIGHTNING_HOLD_DURATION));

        this._burst(origin, COLOR_BOMB_RING_COLOR, { count: 16, lifetime: 0.35, speedMin: 90, speedMax: 200, angleMin: 0, angleMax: Math.PI * 2 });

        afterTween(driver)
            .then(() => afterTween(Tween.create(root).to(LIGHTNING_FADE_DURATION, { opacity: 0 }, Easing.cubicIn)))
            .then(() => root.removeFromParent());
    }

    /**
     * EXPERIMENTAL — see the module-level doc above `COLOR_BOMB_BEAM_SHADER_FRAG`
     * for how to opt into this (`?beam=shader`); `_spawnLightningBeam` above
     * is the real, always-on effect.
     *
     * One `ColorRect` quad per bolt, stretched from the Color Bomb's cell to
     * a target and rotated to point at it, with a custom fragment shader
     * computing the sine-wave wiggle + noise + layered glow *entirely on the
     * GPU* from `v_texCoord` and a `u_time` uniform — no per-frame CPU-side
     * re-triangulation the way `_spawnLightningBeam`'s 3 `Graphics` layers
     * need every frame. `Graphics` can't do this itself: its tessellated
     * vertex format is position+color only (confirmed against
     * `engine/lib/shaders/webgl/VertexColorShaderGlsl.js` — no UV attribute
     * at all), so a shader keyed on `v_texCoord` needs the `Sprite`/`ColorRect`
     * quad pipeline instead. No texture is assigned to the `ColorRect` — confirmed
     * both `Sprite` and `ColorRect` still render a full quad with valid
     * `v_texCoord` even with none set (both resolve to
     * `TextureRegistry.DEFAULT_ID`/the renderer's internal white texture), so
     * this shader never needs to sample one.
     *
     * Quad placement: the node sits at the segment's *midpoint* (default
     * anchor is `0.5`, confirmed in `Transform.js`/`TransformSystem.js` — a
     * node's `x,y` places the *center* of its `[0,width]x[0,height]` local
     * rect, not a corner), with `width` = the origin-target distance and
     * `rotation` = the angle between them **in degrees** — `Node.rotation`
     * is degrees despite `Math.atan2` returning radians (confirmed in
     * `Transform.js`'s own doc comment and its `min:-360,max:360` editor
     * schema), an easy mismatch to miss since nothing type-checks the unit.
     */
    private _spawnLightningBeamShader(beam: NonNullable<ResolveResult['colorBombBeam']>): void {
        ensureColorBombBeamShaderRegistered();
        if (beam.cells.length === 0) return;
        const { tileSize } = this.layout;
        const origin = this.cellCenter(beam.originR, beam.originC);
        const root = new Node(0, 0);
        this.boardRoot.addChild(root);

        const materials: Material[] = [];
        for (const cell of beam.cells) {
            const target = this.cellCenter(cell.r, cell.c);
            const dx = target.x - origin.x;
            const dy = target.y - origin.y;
            const dist = Math.hypot(dx, dy);
            const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI);
            const mid = { x: (origin.x + target.x) / 2, y: (origin.y + target.y) / 2 };

            const beamNode = new Node(mid.x, mid.y);
            beamNode.width = dist;
            beamNode.height = tileSize * 0.8; // reverted to the original value alongside the shader formula revert (was briefly 1.1 for a "make it wider" pass)
            beamNode.rotation = angleDeg;
            root.addChild(beamNode);

            const rect = beamNode.addComponent(ColorRect);
            const mat = new Material('color-bomb-beam', { u_time: 0, u_seed: Math.random() * Math.PI * 2, u_lengthScale: dist / tileSize });
            mat.blend = BlendMode.ADDITIVE;
            rect.material = mat;
            materials.push(mat);

            const ringNode = new Node(target.x, target.y);
            root.addChild(ringNode);
            const ring = ringNode.addComponent(Graphics);
            ring.tessellate = true;
            ring.setLineWidth(tileSize * 0.04);
            ring.drawCircle(tileSize * 0.32, null, COLOR_BOMB_RING_COLOR);
            ring.material.blend = BlendMode.ADDITIVE;
        }

        const driver = Tween.create(root).to(LIGHTNING_HOLD_DURATION, { x: root.x }, Easing.linear);
        driver.onUpdate((_target: Node, progress: number) => {
            const t = progress * LIGHTNING_HOLD_DURATION;
            for (const mat of materials) mat.uniforms.u_time = t;
        });

        this._burst(origin, COLOR_BOMB_RING_COLOR, { count: 16, lifetime: 0.35, speedMin: 90, speedMax: 200, angleMin: 0, angleMax: Math.PI * 2 });

        afterTween(driver)
            .then(() => afterTween(Tween.create(root).to(LIGHTNING_FADE_DURATION, { opacity: 0 }, Easing.cubicIn)))
            .then(() => root.removeFromParent());
    }

    /**
     * Redraws one beam layer's `Graphics` in place with new points, keeping
     * the node correctly positioned every time.
     *
     * `drawPolygon` never touches `node.x`/`node.y` itself — it only
     * re-expresses `points` relative to their own bounding box internally
     * (`Graphics._normalizePolygon`) and resizes the node to fit. The
     * resulting local shape spans `[0,width]x[0,height]`, same convention
     * every other shape in this engine uses (confirmed against
     * `TessellationUtil.js`'s circle tessellator, which centers its own
     * geometry at local `(radius,radius)` for exactly this reason) — and per
     * `Transform`'s default `anchorX`/`anchorY` of `0.5` (confirmed in
     * `engine/lib/components/core/Transform.js`, applied every frame in
     * `TransformSystem.js`), a node's `(x,y)` places the *center* of that
     * local span, not its top-left corner. Positioning the node at the
     * point-set's bounding-box *center* (not its min corner — an earlier,
     * broken version of this code assumed no-anchor/top-left placement,
     * which scattered every bolt's rendered origin since each one's
     * bounding box is a different size) is what makes the rendered shape
     * land at its intended world position.
     */
    private _drawBeamLayer(gfx: Graphics, points: { x: number; y: number }[], color: string): void {
        let minX = points[0].x, maxX = points[0].x, minY = points[0].y, maxY = points[0].y;
        for (const p of points) {
            if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
        const node = gfx.node as Node;
        node.x = (minX + maxX) / 2;
        node.y = (minY + maxY) / 2;
        gfx.drawPolygon(points, null, color, false);
    }

    /**
     * Points from `origin` to `target` with a continuous two-octave
     * sine-wave perpendicular offset per intermediate point, damped to zero
     * at both endpoints (`Math.sin(t * Math.PI)`) so the bolt always
     * visibly connects the two exactly — matches the reference demo's
     * animated "electric arc" look (a live wiggle, not a single static
     * jitter held for the whole flash) rather than being a literal port of
     * its numbers, since its amplitudes were tuned for a fixed 600x600
     * canvas and this project's tile size varies. `strength` scales the
     * wave amplitude — used to make the outer aura layer wander more than
     * the tight inner core, same hierarchy the demo's multi-pass beams
     * have. `seed` offsets the sine phase per-bolt so multiple simultaneous
     * bolts don't wiggle in lockstep. No per-point random noise (there used
     * to be one) — dropped after comparing against the shader beam
     * (`_spawnLightningBeamShader`), which the same call turned out to look
     * better without it.
     */
    private _sineJitteredPoints(origin: { x: number; y: number }, target: { x: number; y: number }, tileSize: number, time: number, seed: number, strength: number): { x: number; y: number }[] {
        const dx = target.x - origin.x;
        const dy = target.y - origin.y;
        const angle = Math.atan2(dy, dx);
        const dist = Math.hypot(dx, dy);
        // Ported from the shader beam (`_spawnLightningBeamShader`) after
        // comparing both side by side — two sine octaves instead of one,
        // no random per-point noise (dropped there too, after "the zigzag
        // flickering is too close" turned out to be the noise term rather
        // than the wave), and frequency scaled by this bolt's own length so
        // a short bolt and a long one get the same wave density per tile of
        // travel instead of the same fixed cycle count stretched or
        // compressed to fit — see freqScale below, and the shader's
        // u_lengthScale doc for the fuller explanation.
        const freqScale = (dist / tileSize) / 3;
        const points: { x: number; y: number }[] = [origin];
        for (let i = 1; i < COLOR_BOMB_BEAM_SEGMENTS; i++) {
            const t = i / COLOR_BOMB_BEAM_SEGMENTS;
            const px = origin.x + dx * t;
            const py = origin.y + dy * t;
            const damp = Math.sin(t * Math.PI);
            // Subtracting the `t` term (not adding) is what makes each wave
            // travel outward from origin to target as `time` increases: a
            // point of constant phase satisfies `time*freq - t*freq*scale =
            // const`, so t must grow with time. Adding the two terms instead
            // (the bug this replaced) makes t *shrink* as time grows — the
            // wave visibly drifts from the target back toward the bomb
            // instead of shooting outward from it.
            const wave = (
                Math.sin(time * 10 - t * 12 * freqScale + seed) * 0.14 +
                Math.sin(time * 16 - t * 20 * freqScale + seed * 1.7) * 0.06
            ) * tileSize * strength;
            const offset = wave * damp;
            points.push({ x: px - Math.sin(angle) * offset, y: py + Math.cos(angle) * offset });
        }
        points.push(target);
        return points;
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
