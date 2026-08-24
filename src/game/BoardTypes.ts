/**
 * Small shared types used by `BoardView` and the tile-effect modules it
 * delegates to (`ColorBombBeamEffect.ts`, `TileClearEffects.ts`,
 * `ParticleBurst.ts`) — pulled out here so those modules don't need to import
 * from `BoardView.ts` itself (which would be circular, since `BoardView.ts`
 * imports them).
 */

import { Node } from 'noonengine';

export interface BoardLayout {
    left: number;
    top: number;
    tileSize: number;
}

/** `Scene` isn't a `Node` subclass but exposes the same `addChild` — this is all these modules need from their container. */
export interface NodeContainer {
    addChild(node: Node, zIndex?: number): void;
}

export function CellCenter(layout: BoardLayout, r: number, c: number): { x: number; y: number } {
    const { left, top, tileSize } = layout;
    return { x: left + c * tileSize + tileSize / 2, y: top - r * tileSize - tileSize / 2 };
}
