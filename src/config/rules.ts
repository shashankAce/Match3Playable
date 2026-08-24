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
 * Every number a real match actually depends on lives here, not as a magic
 * literal in `Board.ts` — including the base "3+ in a row clears at all"
 * rule (`matching.minMatchLength`) and how big a wrapped tile's blast is
 * (`special.wrappedRadius`), not just the thresholds for *creating* a
 * special. If you're reading `Board.ts` and find a bare number governing
 * match/clear behavior that isn't read from here, that's a bug — pull it
 * out into this file instead of leaving it hardcoded.
 *
 * See AGENTS.md's "Real Candy Crush reference" section for what the real
 * game's rules are and which of them this file (deliberately) does not
 * implement yet (non-Moves level types, Sugar Crush) — there is no rule
 * entry here for a feature that doesn't exist in `Board.ts`.
 */

export interface BoardRules {
    rows: number;
    cols: number;
}

export interface MatchingRules {
    /** Minimum run length (row or column) that counts as a match at all — shorter runs don't clear. Real Candy Crush uses 3. */
    minMatchLength: number;
}

export interface SpecialRules {
    /** A row/column run of exactly this length produces a striped tile — must be >= `matching.minMatchLength` and < `colorBombMatchLength`. */
    stripedMatchLength: number;
    /** An L or T shaped match produces a wrapped tile. */
    wrappedMatchShape: 'L_OR_T';
    /** Cells outward from the spawn point a wrapped tile clears in each direction when it detonates — 1 = a 3x3 area. */
    wrappedRadius: number;
    /** A row/column run of at least this length produces a Color Bomb instead of a striped tile — must be > `stripedMatchLength`. */
    colorBombMatchLength: number;
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
}

export interface GameRules {
    board: BoardRules;
    matching: MatchingRules;
    special: SpecialRules;
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

    special: {
        stripedMatchLength: 4,
        wrappedMatchShape: 'L_OR_T',
        wrappedRadius: 1,
        colorBombMatchLength: 5,
    },

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
    },
};
