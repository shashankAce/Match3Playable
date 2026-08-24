/** Per-clear visual flourishes for plain matches and the striped/wrapped specials — everything the Color Bomb doesn't own (see `ColorBombBeamEffect.ts` for that one). */

import { Node, ColorRect, Tween, Easing } from 'noonengine';
import { NodeContainer, BoardLayout, CellCenter } from './BoardTypes';
import { AfterTween } from './AsyncUtil';
import { Burst } from './ParticleBurst';

const STRIPE_BEAM_HOLD_DURATION = 0.12;
const STRIPE_BEAM_FADE_DURATION = 0.18;

/** Small radial puff at a plain match's cell — the "3-match" effect. */
export function SpawnPlainBurst(parent: NodeContainer, pos: { x: number; y: number }, color: string): void {
    Burst(parent, pos, color, { count: 8, lifetime: 0.3, speedMin: 40, speedMax: 90, angleMin: 0, angleMax: Math.PI * 2 });
}

/** A bigger radial burst for a wrapped tile's area detonation. */
export function SpawnWrappedBurst(parent: NodeContainer, pos: { x: number; y: number }, color: string): void {
    Burst(parent, pos, color, { count: 22, lifetime: 0.4, speedMin: 100, speedMax: 190, angleMin: 0, angleMax: Math.PI * 2 });
}

/**
 * A bright flash spanning the *entire* row or column the stripe clears — not
 * a burst confined near the tile's own cell. Matches real Candy Crush's
 * striped-candy activation, which reads as a beam sweeping the whole line,
 * not a puff at one point on it. Built as a plain `Node`+`ColorRect` sized to
 * the board's full width (or height) rather than a particle effect, since
 * "cover the whole line" is a rectangle, not a radiating burst.
 */
export function SpawnStripedBeam(
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
    const boardWidth = boardCols * tileSize;
    const boardHeight = boardRows * tileSize;
    const thickness = tileSize * 0.5;

    const node = orientation === 'h'
        ? new Node(left + boardWidth / 2, CellCenter(layout, r, 0).y)
        : new Node(CellCenter(layout, 0, c).x, top - boardHeight / 2);
    node.width = orientation === 'h' ? boardWidth : thickness;
    node.height = orientation === 'h' ? thickness : boardHeight;
    parent.addChild(node);

    const rect = node.addComponent(ColorRect);
    rect.color = color;

    AfterTween(
        Tween.create(node).delay(STRIPE_BEAM_HOLD_DURATION).to(STRIPE_BEAM_FADE_DURATION, { opacity: 0 }, Easing.cubicIn)
    ).then(() => node.removeFromParent());
}
