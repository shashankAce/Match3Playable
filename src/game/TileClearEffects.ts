/**
 * Per-clear visual flourishes for plain matches, the striped/wrapped specials
 * and combo blasts — everything the Color Bomb's beam doesn't own (see
 * `ColorBombBeamEffect.ts` for that one).
 *
 * The entry point is `SpawnAreaEffect`, which takes the same `AreaSpec` the
 * *model* used to decide which cells clear, and draws that exact shape. That
 * coupling is the point: a wrapped tile's 3x3 and a Wrapped+Wrapped combo's
 * 5x5 are one `box` spec with a different radius, so they can't drift apart
 * into "the model cleared 25 cells but the effect still looked like 9". A
 * renderer that instead guessed from *which special went off* can only ever
 * draw the participants, not the shape they actually produced together.
 */

import { Node, ColorRect, Tween, Easing } from 'noonengine';
import { AreaSpec } from '../config/rules';
import { NodeContainer, BoardLayout, CellCenter } from './BoardTypes';
import { AfterTween } from './AsyncUtil';
import { Burst } from './ParticleBurst';

/** How long a stripe's two halves take to reach the board edge, and how long the trail lingers after. */
const STRIPE_TRAVEL_DURATION = 0.22;
const STRIPE_FADE_DURATION = 0.16;
/** Box/whole-board blast: expand-from-the-centre, then hold briefly so the covered cells are readable, then fade. */
const BLAST_EXPAND_DURATION = 0.14;
const BLAST_HOLD_DURATION = 0.1;
const BLAST_FADE_DURATION = 0.22;

/** Small radial puff at a plain match's cell — the "3-match" effect. */
export function SpawnPlainBurst(parent: NodeContainer, pos: { x: number; y: number }, color: string): void {
    Burst(parent, pos, color, { count: 8, lifetime: 0.3, speedMin: 40, speedMax: 90, angleMin: 0, angleMax: Math.PI * 2 });
}

/**
 * Draws whatever `area` describes, centred on cell (r,c), in `color`. One
 * call covers every non-Color-Bomb effect in the game: a striped tile's row
 * or column, a wrapped tile's 3x3, a combo's cross / 5x5 / 3-wide cross, and
 * a Color Bomb + Color Bomb whole-board clear.
 *
 * `'same-color'` deliberately draws nothing — those cells are scattered all
 * over the board, and `ColorBombBeamEffect`'s bolts and rings are already the
 * effect for them.
 */
export function SpawnAreaEffect(
    parent: NodeContainer,
    layout: BoardLayout,
    boardRows: number,
    boardCols: number,
    r: number,
    c: number,
    area: AreaSpec,
    color: string
): void {
    switch (area.shape) {
        case 'row':
            SpawnStripeSplit(parent, layout, boardRows, boardCols, r, c, color, 'h');
            return;
        case 'column':
            SpawnStripeSplit(parent, layout, boardRows, boardCols, r, c, color, 'v');
            return;
        case 'cross':
            SpawnStripeSplit(parent, layout, boardRows, boardCols, r, c, color, 'h');
            SpawnStripeSplit(parent, layout, boardRows, boardCols, r, c, color, 'v');
            return;
        // One stripe pair per line the band actually clears — three rows or
        // three columns at radius 1 — so a "3-candy-wide beam" reads as three
        // beams, not as one line with a vague glow around it.
        case 'row-band':
            for (let rr = r - area.radius; rr <= r + area.radius; rr++) {
                if (rr < 0 || rr >= boardRows) continue;
                SpawnStripeSplit(parent, layout, boardRows, boardCols, rr, c, color, 'h');
            }
            return;
        case 'column-band':
            for (let cc = c - area.radius; cc <= c + area.radius; cc++) {
                if (cc < 0 || cc >= boardCols) continue;
                SpawnStripeSplit(parent, layout, boardRows, boardCols, r, cc, color, 'v');
            }
            return;
        case 'band-cross':
            SpawnAreaEffect(parent, layout, boardRows, boardCols, r, c, { shape: 'row-band', radius: area.radius }, color);
            SpawnAreaEffect(parent, layout, boardRows, boardCols, r, c, { shape: 'column-band', radius: area.radius }, color);
            return;
        case 'box':
            SpawnBoxBlast(parent, layout, boardRows, boardCols, r, c, area.radius, color);
            return;
        case 'whole-board':
            // The whole board is just the box that covers it — radius large
            // enough to clip to every edge, so one code path draws both.
            SpawnBoxBlast(parent, layout, boardRows, boardCols, r, c, Math.max(boardRows, boardCols), color);
            return;
        case 'same-color':
            return;
    }
}

/**
 * A striped tile's activation: the tile splits and its two halves fly apart
 * along the line it clears, each dragging a trail behind it, matching how the
 * real game reads (two stripes separating and racing to opposite edges) — not
 * the whole line lighting up at once, which gave no sense of direction or
 * travel.
 *
 * Each half is two nodes: a *trail* rect whose inner edge is pinned to the
 * tile's own cell while its outer edge races to the board edge (width and
 * position tween together — with a centre anchor, a rect of width `w` centred
 * at `start + dir * w / 2` always has its inner edge exactly at `start`), and
 * a smaller, brighter *head* travelling at the leading edge. No per-color art
 * needed: both are plain `ColorRect`s tinted with the candy's own
 * `effectColor`.
 */
function SpawnStripeSplit(
    parent: NodeContainer,
    layout: BoardLayout,
    boardRows: number,
    boardCols: number,
    r: number,
    c: number,
    color: string,
    orientation: 'h' | 'v'
): void {
    const { left, top, tileSize } = layout;
    const start = CellCenter(layout, r, c);
    const horizontal = orientation === 'h';
    const thickness = tileSize * 0.44;
    const headSize = tileSize * 0.5;

    // Distance from this tile's centre to each board edge along the axis of travel.
    const distances = horizontal
        ? [start.x - left, left + boardCols * tileSize - start.x]
        : [top - start.y, start.y - (top - boardRows * tileSize)];

    // dir -1 = left / up-screen, +1 = right / down-screen. In board space y
    // grows upward (see `CellCenter`), so a "down the column" half moves in -y.
    const dirs: [number, number][] = horizontal ? [[-1, 0], [1, 0]] : [[0, 1], [0, -1]];

    dirs.forEach(([dx, dy], i) => {
        const dist = Math.max(distances[i], tileSize * 0.5);

        const trail = new Node(start.x, start.y);
        trail.width = horizontal ? tileSize * 0.5 : thickness;
        trail.height = horizontal ? thickness : tileSize * 0.5;
        parent.addChild(trail);
        const trailRect = trail.addComponent(ColorRect);
        trailRect.color = color;
        trail.opacity = 0.85;

        const grown = horizontal
            ? { width: dist, x: start.x + dx * dist / 2 }
            : { height: dist, y: start.y + dy * dist / 2 };
        AfterTween(
            Tween.create(trail)
                .to(STRIPE_TRAVEL_DURATION, grown, Easing.quadOut)
                .to(STRIPE_FADE_DURATION, { opacity: 0 }, Easing.cubicIn)
        ).then(() => trail.removeFromParent());

        const head = new Node(start.x, start.y);
        head.width = headSize;
        head.height = headSize;
        parent.addChild(head);
        const headRect = head.addComponent(ColorRect);
        headRect.color = color;

        AfterTween(
            Tween.create(head)
                .to(STRIPE_TRAVEL_DURATION, { x: start.x + dx * dist, y: start.y + dy * dist }, Easing.quadOut)
                .to(STRIPE_FADE_DURATION * 0.6, { opacity: 0, scaleX: 1.6, scaleY: 1.6 }, Easing.cubicOut)
        ).then(() => head.removeFromParent());
    });
}

/**
 * A wrapped tile's (or a combo's) area blast, drawn as a panel covering the
 * cells that actually clear — clipped to the board exactly the way
 * `Board._areaCells` clips them, so a 3x3 near a corner shows the 4 cells it
 * really takes, not a symmetrical 9-cell square hanging off the edge.
 *
 * The size *is* the information here: the previous version was one fixed-size
 * particle puff, so a 3x3 and a 5x5 were indistinguishable and nothing on
 * screen said how far a blast reached. This scales from the centre out to the
 * full covered rect, holds a beat, then fades — with the particle burst kept
 * on top and scaled by radius for the impact.
 */
function SpawnBoxBlast(
    parent: NodeContainer,
    layout: BoardLayout,
    boardRows: number,
    boardCols: number,
    r: number,
    c: number,
    radius: number,
    color: string
): void {
    const { tileSize } = layout;
    const r0 = Math.max(0, r - radius);
    const r1 = Math.min(boardRows - 1, r + radius);
    const c0 = Math.max(0, c - radius);
    const c1 = Math.min(boardCols - 1, c + radius);

    const topLeft = CellCenter(layout, r0, c0);
    const bottomRight = CellCenter(layout, r1, c1);
    const width = (c1 - c0 + 1) * tileSize;
    const height = (r1 - r0 + 1) * tileSize;

    const panel = new Node((topLeft.x + bottomRight.x) / 2, (topLeft.y + bottomRight.y) / 2);
    panel.width = width;
    panel.height = height;
    panel.scaleX = 0.35;
    panel.scaleY = 0.35;
    panel.opacity = 0.75;
    parent.addChild(panel);
    const rect = panel.addComponent(ColorRect);
    rect.color = color;

    AfterTween(
        Tween.create(panel)
            .to(BLAST_EXPAND_DURATION, { scaleX: 1, scaleY: 1 }, Easing.backOut)
            .delay(BLAST_HOLD_DURATION)
            .to(BLAST_FADE_DURATION, { opacity: 0 }, Easing.cubicIn)
    ).then(() => panel.removeFromParent());

    const reach = Math.max(width, height) / 2;
    Burst(parent, CellCenter(layout, r, c), color, {
        count: Math.min(48, 14 + radius * 10),
        lifetime: 0.45,
        speedMin: reach * 1.2,
        speedMax: reach * 3,
        angleMin: 0,
        angleMax: Math.PI * 2,
    });
}
