/**
 * The single source of visual/audio identity for this game — sprite keys,
 * atlas info, SFX keys. Gameplay *rules* (board size, special thresholds,
 * win condition, scoring) live in the separate `rules.ts` instead — see its
 * header comment for why the split exists. `src/game/` reads only from the
 * `theme` export below for anything in this file's scope — it must never
 * hardcode a tile-type count or an asset key of its own.
 *
 * To reskin this template: change the values in this file and the assets
 * they point to in `res/`. `src/game/` should not need to change.
 */

export interface TileTypeConfig {
    /** Stable numeric id — used as the board's cell value, never re-derived. */
    id: number;
    /** Frame name inside the `tilesAtlasKey` atlas — this type's base tile art. */
    spriteKey: string;
    /** Real per-color art for a horizontal-run special — not a rotated/tinted reuse of another key. */
    stripedHorizontalSpriteKey: string;
    /** Real per-color art for a vertical-run special. */
    stripedVerticalSpriteKey: string;
    /** Real per-color wrapped-candy art (the source pack has a full set per type — no shared/tinted overlay needed). */
    wrappedSpriteKey: string;
    /** Hex tint for this type's match/detonation particle & lightning-beam effects — the only place `src/game/` gets a color from, instead of a literal in game code. */
    effectColor: string;
}

export interface SfxConfig {
    swap: string;
    invalidSwap: string;
    match: string;
    combo: string;
    specialCreate: string;
    win: string;
    lose: string;
}

export interface ThemeConfig {
    /** TexturePacker JSON path, loaded via `assetCache.preloadAssets` as an `'atlas'` entry. */
    tilesAtlasSrc: string;
    /** Alias the atlas is preloaded under — pass to `assetCache.getAsset()`/`atlas.getFrame()`. */
    tilesAtlasKey: string;
    tileTypes: TileTypeConfig[];
    /** The one colorless Color Bomb frame — not per-type, since a Color Bomb represents no single color. */
    colorBombSpriteKey: string;
    /**
     * Tint for effects that belong to no single tile color: the Color Bomb's
     * beam/rings, and any blast centred on a colorless tile (the whole-board
     * flash of a Color Bomb + Color Bomb swap). The Color Bomb is meant to
     * read as one consistent "energy" identity rather than borrowing whichever
     * color it happens to be clearing, so this is deliberately not derived
     * from `tileTypes[].effectColor`.
     */
    colorBombEffectColor: string;
    sfx: SfxConfig;
}

export const theme: ThemeConfig = {
    tilesAtlasSrc: 'res/candies.json',
    tilesAtlasKey: 'candies',

    // Tile-type count is `tileTypes.length` — never stored as a separate
    // number, so it can't drift out of sync with the array. (`rules.ts`'s
    // `board.rows/cols` is independent of this count — nothing here assumes
    // they're related, and a reskin can change one without the other.)
    //
    // Every sprite key points at a frame inside res/candies.json (see that
    // file's generation notes) — picked by hand against the actual sheet, so
    // each type's base/striped-h/striped-v/wrapped art is the same candy
    // shape carried through every state (e.g. red is a jellybean in all four
    // forms, blue is a ball in all four, etc.) — never mixed shape families.
    tileTypes: [
        { id: 0, spriteKey: 'candy_081', stripedHorizontalSpriteKey: 'candy_083', stripedVerticalSpriteKey: 'candy_073', wrappedSpriteKey: 'candy_052', effectColor: '#ff4d4d' }, // red jellybean
        { id: 1, spriteKey: 'candy_047', stripedHorizontalSpriteKey: 'candy_085', stripedVerticalSpriteKey: 'candy_087', wrappedSpriteKey: 'candy_064', effectColor: '#ff9d3d' }, // orange oval
        { id: 2, spriteKey: 'candy_069', stripedHorizontalSpriteKey: 'candy_084', stripedVerticalSpriteKey: 'candy_082', wrappedSpriteKey: 'candy_032', effectColor: '#4dd964' }, // green square
        { id: 3, spriteKey: 'candy_065', stripedHorizontalSpriteKey: 'candy_072', stripedVerticalSpriteKey: 'candy_071', wrappedSpriteKey: 'candy_006', effectColor: '#4d9fff' }, // blue ball
        { id: 4, spriteKey: 'candy_048', stripedHorizontalSpriteKey: 'candy_070', stripedVerticalSpriteKey: 'candy_063', wrappedSpriteKey: 'candy_038', effectColor: '#b34dff' }, // purple flower
        { id: 5, spriteKey: 'candy_061', stripedHorizontalSpriteKey: 'candy_076', stripedVerticalSpriteKey: 'candy_015', wrappedSpriteKey: 'candy_014', effectColor: '#ffe14d' }, // yellow drop
    ],

    colorBombSpriteKey: 'candy_062',
    colorBombEffectColor: 'rgba(0, 225, 255, 0.8)',

    sfx: {
        swap: 'sfx-swap',
        invalidSwap: 'sfx-invalid-swap',
        match: 'sfx-match',
        combo: 'sfx-combo',
        specialCreate: 'sfx-special-create',
        win: 'sfx-win',
        lose: 'sfx-lose',
    },
};
