/**
 * Gameplay rules — deliberately separate from `theme.ts`'s visual/audio
 * identity. A reskin of this template might want the exact same rules with
 * different art (new candies, same difficulty), or the exact same art with
 * different rules (a harder move limit, a different special-tile threshold,
 * a different scoring formula) — coupling the two into one file would force
 * a reskin to touch both every time, even when only one actually changed.
 * `src/game/` reads only from the `rules` export below for anything in this
 * file's scope — it must never hardcode a board size, a match threshold, a
 * move limit, or a score value of its own.
 *
 * ## The rule model: match -> spawn, special -> action, pair -> combo
 *
 * This file doesn't just hold loose numbers; it holds the *decisions*
 * `Board.ts` makes, as ordered data. `Board.ts` is the interpreter — it owns
 * *how* a rule is carried out (grid scanning, chain-reaction phasing,
 * gravity), never *which* rule wins or what a special does. There are four
 * tables, each covering one decision point that used to be an `if`-chain
 * inside the model:
 *
 * 1. `matching` — what counts as a match at all (`minMatchLength`).
 * 2. `spawn` — which special a completed match creates. A match can fit more
 *    than one rule (a 5-run fits both the 5-line and 4-line patterns; a
 *    crossing pair fits the intersection rule *and* each arm's own line
 *    rule), so every rule carries an explicit `priority` and the highest one
 *    wins. That single number is the whole "which special does this shape
 *    make" question — no ordering assumption buried in code.
 * 3. `activation` — what one special *does* when it goes off: the `area` it
 *    clears, whether it re-detonates a phase later (`repeats`, Candy Crush's
 *    double-exploding Wrapped Candy), whether another special's blast sets it
 *    off (`chainsWhenCaught`), and whether it holds a real colour at all
 *    (`colorless`, true only for the Color Bomb).
 * 4. `combos` — what a *deliberate swap of two specials* does, again
 *    priority-ordered, since a Color Bomb + Color Bomb swap also fits the
 *    looser "Color Bomb + anything" rule and must beat it.
 *
 * Everything geometric is an `AreaSpec` — one shared shape vocabulary used by
 * both `activation` and `combos`, so "a wrapped tile clears a 3x3" and "two
 * wrapped tiles clear a 5x5" are the same kind of statement with a different
 * radius, not two different loops in `Board.ts`.
 *
 * If you're reading `Board.ts` and find a bare number governing match/clear
 * behaviour, a hardcoded `kind === 'color-bomb'` branch, or a special's area
 * written as a loop bound, that's a bug — pull it out into this file instead
 * of leaving it hardcoded.
 *
 * See AGENTS.md's "Real Candy Crush reference" section and
 * `candy_crush_rules.md` for what the real game's rules are and which of
 * them this file (deliberately) does not implement yet (Jelly, non-Moves
 * level types, Sugar Crush) — there is no rule entry here for a feature that
 * doesn't exist in `Board.ts`.
 */

/**
 * The special tiles this game knows about. Purely a *gameplay* identity —
 * each kind's art lives in `theme.ts` (per-type striped/wrapped frames plus
 * the one colourless `colorBombSpriteKey`). Adding a kind here means adding
 * its `activation` entry below, the `spawn`/`combos` rules that involve it,
 * and its art in `theme.ts`; `Board.ts` itself needs no new branch.
 */
export type SpecialKind = 'striped-h' | 'striped-v' | 'wrapped' | 'color-bomb';

export interface BoardRules {
    rows: number;
    cols: number;
}

export interface MatchingRules {
    /** Minimum run length (row or column) that counts as a match at all — shorter runs don't clear. Real Candy Crush uses 3. */
    minMatchLength: number;
}

/**
 * A set of cells, described relative to a centre cell (and, for
 * `'same-color'`, to a trigger colour) rather than as a loop in `Board.ts`.
 * Every clear this game performs outside a plain colour match is one of
 * these — `Board._areaCells` is the single place that turns one into actual
 * coordinates, clipped to the board.
 */
export type AreaSpec =
    /** The whole row the centre cell sits in. */
    | { shape: 'row' }
    /** The whole column the centre cell sits in. */
    | { shape: 'column' }
    /** Row + column through the centre cell — a full-board `+`. */
    | { shape: 'cross' }
    /** A square block `radius` cells out in every direction (`radius: 1` = 3x3). */
    | { shape: 'box'; radius: number }
    /** A thick `+`: every row within `radius` of the centre, and every column within `radius` (`radius: 1` = 3 full rows + 3 full columns). */
    | { shape: 'band-cross'; radius: number }
    /** Just the horizontal half of a `band-cross`: every row within `radius` of the centre, full width. */
    | { shape: 'row-band'; radius: number }
    /** Just the vertical half: every column within `radius` of the centre, full height. */
    | { shape: 'column-band'; radius: number }
    /** Every cell on the board holding the trigger colour — the Color Bomb's signature effect. Ignores the centre cell. */
    | { shape: 'same-color' }
    /** Literally everything. */
    | { shape: 'whole-board' };

/**
 * What one special does when it detonates — in place, from wherever it
 * currently sits. Used identically whether it was set off by a deliberate
 * swap, by being caught in another special's blast, or by a queued
 * re-detonation.
 */
export interface ActivationRule {
    /** Cells cleared immediately, centred on the special's own cell. */
    area: AreaSpec;
    /**
     * Extra detonations queued for the *next* resolve phase (after this
     * phase's gravity/refill has settled), at the same board position —
     * Candy Crush's "explodes, drops down as board pieces fill in, and
     * explodes a second time". `0` = fires once and is done.
     */
    repeats: number;
    /** Area those repeats clear, if it differs from `area`. */
    repeatArea?: AreaSpec;
    /**
     * Whether another special's blast catching this one sets it off too.
     * `true` for the Color Bomb as well: passively caught, it has no swap
     * partner to take a color from, so it hunts the board's own most common
     * color instead (ties broken at random) and clears every candy of that
     * color — a plain clear, never converting them into new specials the
     * way a deliberate bomb+striped/bomb+wrapped swap does. See
     * `Board._expandCaughtColorBomb`.
     */
    chainsWhenCaught: boolean;
    /**
     * `true` = this special holds no real colour; its board cell gets a
     * colourless sentinel id instead of a tile type, so it can never join or
     * be joined by a normal colour run. Only the Color Bomb.
     */
    colorless: boolean;
}

/** The shape of a completed match, as a `spawn` rule pattern. */
export type SpawnPattern =
    /** A single straight run of `minLength`..`maxLength` same-colour tiles. */
    | { type: 'line'; minLength: number; maxLength?: number }
    /** Two same-colour runs (one horizontal, one vertical) crossing at a cell — an L, T, or +. */
    | { type: 'intersection'; minArmLength?: number };

/**
 * What a `spawn` rule creates. The two `striped-*` pseudo-values resolve
 * against the matched run's own direction — `'striped-perpendicular'` is
 * real Candy Crush's counterintuitive rule (a horizontal match makes the
 * vertical-look, column-clearing tile), `'striped-aligned'` is there so a
 * reskin can flip that without touching `Board.ts`.
 */
export type SpawnCreates = SpecialKind | 'striped-perpendicular' | 'striped-aligned';

export interface SpawnRule {
    /** Human-readable id — only used in comments/debugging, never matched on. */
    id: string;
    /**
     * Higher wins when several rules fit the same match. This is the *only*
     * thing deciding e.g. "a 5-in-a-row makes a Color Bomb, not a striped
     * tile" or "a 5-line beats the L-shape it happens to cross". Two rules
     * tying on a crossing pair means neither arm yields to the other and both
     * resolve independently.
     */
    priority: number;
    pattern: SpawnPattern;
    creates: SpawnCreates;
}

/**
 * Which side(s) of a swap a `combo` rule applies to. `'striped'` means
 * either stripe orientation; `'any-special'` any non-plain tile; `'plain'` a
 * normal candy; `'any'` anything at all (used for "Color Bomb + whatever").
 */
export type SpecialSelector = SpecialKind | 'striped' | 'any-special' | 'plain' | 'any';

/**
 * What a *deliberate swap of two specials* does — the effects that fire
 * unconditionally, ignoring colour matching entirely (`candy_crush_rules.md`
 * §3's "Swapping Special Candies Together" and §4's combo matrix).
 *
 * A swap whose two sides don't fit any rule here is not a combo at all: it
 * goes through the normal match/revert path instead. That's what gives a
 * lone striped/wrapped candy swapped with a plain one its three real
 * outcomes (revert / slide in inert / activate) for free — there's simply no
 * rule matching `['striped', 'plain']`.
 */
export interface ComboRule {
    id: string;
    /**
     * Higher wins when several rules fit the same pair. Color Bomb + Color
     * Bomb must outrank Color Bomb + anything, or the whole-board clear would
     * never fire.
     */
    priority: number;
    /**
     * Order-insensitive: `[a, b]` matches a swap either way round. `a` is the
     * side the effect is *centred* on (the beam's origin, the `+`'s middle)
     * and `b` the side that supplies the trigger colour, so put the Color
     * Bomb first in any rule involving one.
     */
    match: [SpecialSelector, SpecialSelector];
    /** Cleared by this combo, resolved against `a`'s cell and `b`'s colour. All at once, unless `stagedAreas` says otherwise. */
    areas: AreaSpec[];
    /**
     * `true` = `areas` is a *sequence*, not a set: each entry is a beat of its
     * own, cleared (and drawn) after the one before it. Which cells clear is
     * unchanged — only when. This is what lets Striped + Wrapped read the way
     * it does in the real game: the 3x3 goes off, then the giant candy sweeps
     * one axis, then the other, instead of the whole 39-cell cross blinking
     * out at once.
     */
    stagedAreas?: boolean;
    /**
     * `true` = `'row-band'`/`'column-band'` entries in `areas` are stated for
     * a *horizontal* stripe and get swapped when the striped participant is
     * vertical, so the combo always sweeps along the stripe's own direction
     * first and across it second.
     */
    orientToPartner?: boolean;
    /**
     * Set = every cell `'same-color'` picked out also detonates as if it were
     * `b`'s own special (Candy Crush's "turns every candy of that colour into
     * a Striped/Wrapped Candy, then detonates them all"), including `b`'s own
     * `repeats`. No-op when `b` is a plain candy.
     *
     * `stripeOrientation` only matters when `b` is striped: `'random'` gives
     * each converted tile its own coin-flip orientation, which is what the
     * real game does (the board ends up crosshatched with row and column
     * clears, not all one direction); `'partner'` copies the swapped tile's
     * own orientation for every one of them.
     */
    spreadPartnerActivation?: { stripeOrientation?: 'partner' | 'random' };
    /**
     * `true` = the non-bomb side is *consumed* by the swap instead of
     * detonating. It hands over its color (and, with
     * `spreadPartnerActivation`, its special kind) and then simply vanishes
     * from its square — no area of its own, no `repeats`, and no conversion
     * either, since it's already a special. Its cell still clears, as one of
     * the `'same-color'` cells.
     *
     * This is what a Color Bomb swap actually looks like: the swapped candy
     * disappears the instant the bomb registers its color, the bomb holds
     * position while the lightning goes out, and the effect you then see is
     * the *converted* candies going off — not a bonus row or 3x3 fired from
     * wherever the partner happened to land.
     */
    partnerConsumed?: boolean;
    /**
     * `true` = present this combo as one blast shaped like `areas[0]`,
     * centred on `a`'s cell, instead of as its two participants' individual
     * special effects. A Striped + Striped cross has to read as a cross; left
     * to the participants it would draw whatever two stripe directions
     * happened to be swapped, which is often neither of the lines actually
     * clearing. Purely presentational — it changes what the renderer is told,
     * never which cells clear.
     */
    presentAsBlast?: boolean;
    /** `true` = report a Color-Bomb beam from `a`'s cell to every cell this combo's `areas` picked out, for the renderer to draw. */
    beam?: boolean;
    /** `true` = the beam fires from *both* swapped cells, not just `a` — two Color Bombs each light up the board. */
    beamFromBothSides?: boolean;
    /**
     * Detonate in waves along an axis instead of all at once: `'column'`
     * sweeps left to right, `'row'` top to bottom. Each targeted cell's beam
     * bolt and its pop are timed to its own wave, so a whole-board clear reads
     * as a front crossing the grid rather than one instant blank-out.
     */
    sweep?: { axis: 'column' | 'row' };
    /** A second blast at `a`'s cell one phase later, reported as the special `as`. */
    repeat?: { area: AreaSpec; as: SpecialKind };
    /**
     * After this combo settles, pick one random colour *other* than the
     * trigger colour and detonate every tile of it as `as` — Candy Crush's
     * Wrapped + Color Bomb second wave.
     */
    colorSweepAfter?: { as: SpecialKind };
}

/**
 * Two win-condition shapes, matching real Candy Crush's Moves-type ('score')
 * and Candy Order-type ('collect') levels (see AGENTS.md's "Real Candy Crush
 * reference" section) — `src/game/` branches on `mode` rather than assuming
 * one shape.
 */
export type WinConditionRules =
    | { mode: 'score'; moveLimit: number; targetScore: number }
    | { mode: 'collect'; moveLimit: number; targets: { typeId: number; count: number }[] };

export interface ScoringRules {
    /** Points awarded per cleared cell — plain clears and detonation cells alike. */
    pointsPerTile: number;
    /**
     * Multiplier applied to each successive resolve pass within one move: the
     * first pass uses `[0]`, the first cascade `[1]`, and so on, with the last
     * entry repeating for deeper chains. `[1]` alone disables cascade bonuses.
     */
    cascadeMultipliers: number[];
    /** One-off bonus for *creating* a special, on top of the tiles its match cleared. */
    specialCreateBonus: Record<SpecialKind, number>;
}

export interface GameRules {
    board: BoardRules;
    matching: MatchingRules;
    spawn: SpawnRule[];
    activation: Record<SpecialKind, ActivationRule>;
    combos: ComboRule[];
    winCondition: WinConditionRules;
    scoring: ScoringRules;
}

export const rules: GameRules = {
    board: {
        rows: 8,
        cols: 8,
    },

    matching: {
        minMatchLength: 3,
    },

    // Priority-ordered, highest first (the order here is documentation only —
    // `Board.ts` sorts by `priority`, so inserting a rule anywhere is safe).
    spawn: [
        // 5+ in a straight line beats everything, including an L/T it crosses.
        { id: 'line-5-color-bomb', priority: 30, pattern: { type: 'line', minLength: 5 }, creates: 'color-bomb' },
        // Two crossing runs (L, T or +) beat either arm's own 4-line rule.
        { id: 'intersection-wrapped', priority: 20, pattern: { type: 'intersection' }, creates: 'wrapped' },
        // Exactly 4 in a line — perpendicular stripe, per candy_crush_rules.md §1.
        { id: 'line-4-striped', priority: 10, pattern: { type: 'line', minLength: 4, maxLength: 4 }, creates: 'striped-perpendicular' },
        // A plain 3-run fits no rule and simply clears.
    ],

    activation: {
        // A stripe clears in the direction it visually points (Blast Effect) —
        // `frameKeyFor`'s art choice and this area must always agree; which
        // *kind* a match spawns is the `spawn` table's job, not this one's.
        'striped-h': { area: { shape: 'row' }, repeats: 0, chainsWhenCaught: true, colorless: false },
        'striped-v': { area: { shape: 'column' }, repeats: 0, chainsWhenCaught: true, colorless: false },
        // 3x3, twice — the second blast fires a phase later, after the board refills.
        wrapped: { area: { shape: 'box', radius: 1 }, repeats: 1, chainsWhenCaught: true, colorless: false },
        // `area` here is unused for a passive catch — a Color Bomb has no
        // fixed shape of its own, so `chainsWhenCaught: true` routes it
        // through `Board._expandCaughtColorBomb`'s "board's most common
        // color" hunt instead of this `area`. A deliberate swap still goes
        // through a `combos` rule, never this table.
        'color-bomb': { area: { shape: 'box', radius: 0 }, repeats: 0, chainsWhenCaught: true, colorless: true },
    },

    // Priority-ordered, highest first (again documentation only — `Board.ts`
    // sorts by `priority`). A pair matching no rule here isn't a combo swap.
    combos: [
        // Both bombs light up the whole board, and it clears as a wave crossing
        // column by column — not one flat flash, and not a single origin.
        {
            id: 'bomb+bomb',
            priority: 100,
            match: ['color-bomb', 'color-bomb'],
            areas: [{ shape: 'whole-board' }],
            beam: true,
            beamFromBothSides: true,
            sweep: { axis: 'column' },
        },
        {
            id: 'bomb+wrapped',
            priority: 90,
            match: ['color-bomb', 'wrapped'],
            areas: [{ shape: 'same-color' }],
            spreadPartnerActivation: {},
            partnerConsumed: true,
            beam: true,
            // No `colorSweepAfter`: this combo's famous "two waves" are the
            // converted candies' own double explosion (every wrapped candy
            // blasts, the board settles, they blast again) — not a second
            // random color. `candy_crush_rules.md` §4 claims the second-color
            // wave and secondary guides disagree with each other about it;
            // King appears to have changed the combo at some point. Confirmed
            // against the live game 2026-08-25: it is the double detonation.
        },
        {
            id: 'bomb+striped',
            priority: 90,
            match: ['color-bomb', 'striped'],
            areas: [{ shape: 'same-color' }],
            // Real Candy Crush hands each converted candy its own stripe
            // direction, not the swapped tile's — see `stripeOrientation`.
            spreadPartnerActivation: { stripeOrientation: 'random' },
            partnerConsumed: true,
            beam: true,
        },
        // Color Bomb + plain candy (or anything with no rule of its own):
        // every tile of that colour goes.
        { id: 'bomb+any', priority: 50, match: ['color-bomb', 'any'], areas: [{ shape: 'same-color' }], beam: true },
        // Full row AND column through the swap point, whatever the two stripes' own orientations were.
        { id: 'striped+striped', priority: 40, match: ['striped', 'striped'], areas: [{ shape: 'cross' }], presentAsBlast: true },
        // 5x5, twice.
        {
            id: 'wrapped+wrapped',
            priority: 40,
            match: ['wrapped', 'wrapped'],
            areas: [{ shape: 'box', radius: 2 }],
            repeat: { area: { shape: 'box', radius: 2 }, as: 'wrapped' },
            presentAsBlast: true,
        },
        // 3 full rows + 3 full columns, fired once, but in three beats: the
        // wrapped half's 3x3 goes off, then the striped half — grown to three
        // tiles wide — sweeps along its own direction, then across it. Same 39
        // cells as one flat `band-cross`, sequenced. Deliberately no `repeat`:
        // candy_crush_rules.md §4 describes this combo as a single giant beam,
        // not a double explosion — the wrapped half's own double-detonation
        // rule applies to a wrapped tile going off *as a wrapped tile*, which
        // is not what this combo does.
        {
            id: 'striped+wrapped',
            priority: 40,
            match: ['striped', 'wrapped'],
            areas: [
                { shape: 'box', radius: 1 },
                { shape: 'row-band', radius: 1 },
                { shape: 'column-band', radius: 1 },
            ],
            stagedAreas: true,
            orientToPartner: true,
            presentAsBlast: true,
        },
    ],

    winCondition: {
        mode: 'collect',
        moveLimit: 20,
        targets: [
            { typeId: 0, count: 30 }, // red
            { typeId: 2, count: 10 }, // green
            { typeId: 5, count: 20 }, // yellow
        ],
    },

    scoring: {
        pointsPerTile: 10,
        cascadeMultipliers: [1, 1.5, 2, 2.5, 3],
        specialCreateBonus: {
            'striped-h': 60,
            'striped-v': 60,
            wrapped: 120,
            'color-bomb': 200,
        },
    },
};

/** Selectors, widest first — used by `MatchesSelector` and nothing else. */
function SelectorMatches(selector: SpecialSelector, kind: SpecialKind | null): boolean {
    if (selector === 'any') return true;
    if (selector === 'plain') return kind === null;
    if (kind === null) return false;
    if (selector === 'any-special') return true;
    if (selector === 'striped') return kind === 'striped-h' || kind === 'striped-v';
    return selector === kind;
}

/**
 * The highest-priority `combos` rule covering a swap of `k1` with `k2`
 * (either may be `null` for a plain candy), or `null` if this pair isn't a
 * combo at all and should go through the normal match path instead.
 * `orderedAsMatched` says which side ended up as the rule's `a` — the side
 * effects centre on.
 *
 * Lives here rather than in `Board.ts` because both `Board` (to run the
 * combo) and the view layer (to decide, before animating, whether a swap can
 * revert) need the exact same answer, and neither should re-derive it.
 */
export function FindComboRule(
    k1: SpecialKind | null,
    k2: SpecialKind | null
): { rule: ComboRule; firstIsA: boolean } | null {
    let best: { rule: ComboRule; firstIsA: boolean } | null = null;
    for (const rule of rules.combos) {
        const [a, b] = rule.match;
        let firstIsA: boolean;
        if (SelectorMatches(a, k1) && SelectorMatches(b, k2)) firstIsA = true;
        else if (SelectorMatches(a, k2) && SelectorMatches(b, k1)) firstIsA = false;
        else continue;
        if (!best || rule.priority > best.rule.priority) best = { rule, firstIsA };
    }
    return best;
}
