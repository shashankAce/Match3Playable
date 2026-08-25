# AGENTS.md

Project-specific rules for **match3-playable**. This is the canonical rules
doc for this project — read it before writing any game code. Generic
NoonEngine API-grounding rules (how to verify an API exists, the
skills/-lookup table) live in [AI_WORKFLOW.md](AI_WORKFLOW.md); this file only
covers what's specific to this game and its template role.

## What this is

A Candy-Crush-type match-3 game, built as one piece of a **playables
portfolio** (short interactive HTML5 demos pitched to game studios as a
B2B service). Its Candy Crush skin is not the point — the point is that this
project is meant to become a **reusable template**: later, a different themed
game (different tiles, colors, sounds) gets built by copying this project and
changing as little as possible.

## Hard constraint: 2D + TypeScript only

This project was scaffolded with `--ts --vendor` and **no** `--3d`,
`--physics`, or `--physics3d`. Do not add `three`, `matter-js`, or
`@dimforge/rapier3d` as dependencies, and do not import anything from
`engine/lib/3d/`, `engine/lib/physics/`, or `engine/lib/physics3d/` — none of
it is installed, and this game has no use for it. If a future task genuinely
needs one of those, that's a decision to raise explicitly, not something to
silently add.

## Config-driven architecture — the reskinning contract

The whole reason this template is worth reusing is that config and game
logic are kept apart — and the config itself is split in two, because a
reskin might want the same *rules* with new art, or the same art with new
*rules*, independently:

- **`src/config/theme.ts`** — visual/audio identity only: tile sprite/atlas
  keys, SFX asset keys. `tileTypes.length` also implicitly defines the
  tile-type count (never stored as a separate number).
- **`src/config/rules.ts`** — gameplay rules only, and not just loose
  numbers: it holds the *decisions* `Board.ts` makes, as four ordered
  tables, so retuning the game never means editing the model. Board
  dimensions (`board.rows/cols`), the base match rule
  (`matching.minMatchLength` — the "3" a clear needs at all), then:
    - **`spawn`** — which special a completed match creates, as
      priority-ordered pattern rules (`{type:'line', minLength}` /
      `{type:'intersection'}` → `creates`). A match usually fits several
      rules at once (a 5-run fits both the 5-line and the 4-line pattern; a
      crossing pair fits the intersection rule *and* each arm's own line
      rule), and the explicit `priority` number is the entire tie-break —
      including "a 5-line beats the L it crosses" and "two 5-lines tie, so
      both spawn". `creates: 'striped-perpendicular'` carries real Candy
      Crush's counterintuitive orientation rule; `'striped-aligned'` is
      there so a reskin can flip it without touching `Board.ts`.
    - **`activation`** — what one special does when it goes off: the `area`
      it clears (an `AreaSpec`, see below), how many times it re-detonates a
      phase later (`repeats` — Wrapped Candy's double explosion),
      whether another special's blast sets it off (`chainsWhenCaught` —
      `false` for the Color Bomb), and whether it holds a real color at all
      (`colorless`).
    - **`combos`** — what a deliberate swap of two specials does, again
      priority-ordered (Color Bomb + Color Bomb has to outrank the looser
      Color Bomb + anything). A pair matching *no* rule here isn't a combo
      at all and goes through the normal match/revert path — which is
      exactly what gives a lone striped/wrapped candy swapped with a plain
      one its three real outcomes, with no special-casing anywhere.
      `Board.swapActivates()` is the single shared answer to "is this pair a
      combo?", so the view's revert decision and the model's effect can't
      disagree.
    - **`winCondition`** / **`scoring`** — move limit, target score or
      collect targets; `pointsPerTile`, per-pass `cascadeMultipliers`, and a
      `specialCreateBonus` per kind.

  Every geometric effect in the game is an `AreaSpec` — one shared shape
  vocabulary (`row`, `column`, `cross`, `box`, `band-cross`, `same-color`,
  `whole-board`) used by both `activation` and `combos`, resolved in exactly
  one place (`Board._areaCells`). "A wrapped tile clears a 3x3" and "two
  wrapped tiles clear a 5x5" are therefore the same statement with a
  different radius, not two loops in the model. See `rules.ts`'s header
  comment and AGENTS.md's "Real Candy Crush reference" section below for
  what's in scope versus deliberately left out.
- **`src/game/`** is agnostic to both: board state/model, match detection,
  special-tile (striped/wrapped) logic, swap input handling, board
  rendering/animation, and scene wiring. This code reads values only from
  `theme.ts`/`rules.ts`'s exported config — it must never contain a literal
  color name, a candy-specific term (no `Candy`, `Jelly`, etc. in
  identifiers), or a hardcoded grid number, match threshold, or score value.
- **To reskin this template**: scaffold or copy a new project from this one,
  then only touch `src/config/theme.ts` + `res/` (new art/audio, same rules),
  `src/config/rules.ts` (new difficulty/scoring, same art), or both — never
  `src/game/`. If reskinning ever requires editing `src/game/`, that's a sign
  something theme- or rule-specific leaked into the shared layer — fix the
  leak there rather than patching around it in the copy.
- **Tile art scheme**: each `TileTypeConfig` carries four *real* per-color
  frames — `spriteKey` (base), `stripedHorizontalSpriteKey`,
  `stripedVerticalSpriteKey`, and `wrappedSpriteKey` — no tinting, no
  rotation trick. The source pack (`res/candies.png`) turned out to have a
  full base/striped-h/striped-v/wrapped set per type, each keeping the same
  candy *shape* across all four states (e.g. red is a jellybean in every
  state, blue is a ball in every state) — picked by hand against the sheet,
  not auto-matched. A reskin needs a full 4-frames-per-type set; there is no
  shared/tinted fallback to lean on if a new theme's art pack is missing one.
  One exception: `theme.colorBombSpriteKey` is a single top-level frame, not
  per-type — a Color Bomb represents no one color, so it doesn't belong in
  `TileTypeConfig` at all.
- **Special spawn location**: `Board.resolve(preferredCells?)` spawns a
  striped tile at a swap's destination cell when that cell is part of the
  qualifying run, falling back to the run's middle only for cascade-triggered
  matches (no swap to prefer) — matches real Candy Crush, where the special
  appears where you moved a tile to, not at an arbitrary run position.
  Wrapped tiles always spawn at the h/v run intersection cell regardless,
  since that's the shape's own natural position, not an arbitrary choice.
- **`res/candies.json`** (the atlas backing `tilesAtlasSrc` above) was
  auto-generated, not hand-authored or produced by TexturePacker: the source
  `res/candies.png` was a pre-packed sheet with no accompanying manifest, so
  its frames were recovered by connected-component detection on the alpha
  channel (script discarded after use, not checked in) and given
  position-sorted, non-semantic names (`candy_000`...`candy_113`). If
  `candies.png` is ever replaced, `candies.json` must be regenerated the same
  way (or hand-authored in TexturePacker) — the two files are only valid
  together, and the frame indices `theme.ts` currently points at were picked
  visually against this specific JSON.

## Implementation status

`src/game/Board.ts` (pure model), `src/game/BoardView.ts` (rendering + input),
and `src/game/GameScene.ts` (HUD + wiring) implement the v1 scope below and
are verified working live (`npm run dev`, Playwright — swap, match, cascade,
striped spawn, score/moves HUD all confirmed on screen with no console
errors). Known gaps, deliberately left for a follow-up rather than silently
skipped:

- **Input supports both tap-to-select-then-tap-adjacent-to-swap AND
  swipe-to-swap, registered on the same cells.** They don't conflict:
  `Input.CLICK` fires for a press that moves under 5px, `Input.DRAG_END`
  fires instead once it moves past that (see `skills/input/input.md`'s Drag
  section) — exactly one path runs per gesture, no flag or mode needed to
  pick between them. `Input.DRAG` (fired continuously between `DRAG_START`
  and `DRAG_END`) moves the pressed tile to follow the pointer live, capped
  at one tile's distance from its own cell so it never strays past a
  neighbor — **and mirrors that same displacement onto whichever neighbor is
  the current swap candidate**, so both tiles visibly slide toward each
  other's cells during the drag itself (matches real Candy Crush), not just
  the pressed tile moving while its neighbor waits for release. The
  candidate neighbor is recomputed every `DRAG` tick from whichever axis has
  moved further so far; if the drag's direction changes mid-gesture, the
  previously-previewed neighbor snaps back instantly (no tween — it can
  retrigger every frame while the direction is ambiguous) and the new one
  takes over. `DRAG_END` reuses whatever neighbor was last tracked rather
  than recomputing direction itself. Off the board edge (no neighbor ever
  tracked), the dragged tile tweens back to its own cell instead of a swap
  attempt — `_attemptSwap`'s own swap/revert tweens already animate from
  each node's *current* position (mid-drag or not), so no extra reset is
  needed once a real swap starts.
- **The actively-dragged tile outranks its previewed target neighbor in
  zIndex** (`DRAG_ACTIVE_Z_INDEX` > `DRAG_TARGET_Z_INDEX`, both above the
  default 0) — not the same elevated value for both. They're both moving
  toward each other's cells and pass through the same overlap region;
  giving them equal zIndex just moves the original sibling-order tie-break
  bug (see below) to a new pair of nodes instead of fixing it — confirmed by
  testing: with one shared constant, the tile actually under the pointer
  intermittently vanished behind the neighbor it was crossing.
- **Hit-testing lives on a fixed, invisible per-cell grid, never on tile
  sprites.** `BoardView` creates one plain `Node` per board cell up front
  (just `width`/`height` set, no render component — confirmed grounded:
  `InputListener._hitAABB` only reads a node's transform + `width`/`height`,
  never whether it has a visual component) and registers each cell's
  `Input.CLICK`/`Input.DRAG_END` exactly once, for the life of the board.
  Tile sprites are never made interactive at all. This was a real bug found in testing: an
  earlier version put the click listener on the tile sprite itself, captured
  its (r,c) once at creation, and never updated it — so after a tile moved
  during a swap or cascade fall, its stale handler kept reporting its
  *original* cell. Fixing it by re-syncing the captured (r,c) on every move
  worked but was fragile (miss one call site, the bug's back); routing input
  through cells that structurally never move removes the whole bug class
  instead of relying on remembering to update it everywhere. If you ever
  find yourself attaching `Input.CLICK` to a tile sprite again, that's a
  sign this rule is being violated — don't.
- **All grid cells and tiles live under one `boardRoot` container `Node`
  (added to `parent` once) — never added to `parent` directly.** This isn't
  just organization, it's a real engine constraint: NoonEngine gives each of
  a node's *direct* children its own top-level render segment, and only a
  full render-list rebuild reorders segments relative to each other —
  changing `zIndex` on an already-scene-resident top-level node is silently
  ignored by the normal per-frame incremental path (confirmed by testing:
  the drag-elevation fix below visibly did nothing — dragged tile stayed
  *behind* the neighbor it crossed — until `boardRoot` was introduced).
  Nesting the whole board one level down puts every tile/cell under one
  shared parent, where a `zIndex` change *does* get picked up incrementally.
  Any new node this file adds directly to the scene (HUD, overlays) doesn't
  need this — only the board's own many same-parent, dynamically-reordered
  children do.
- **Elevate a tile's `zIndex` while it's dragging or mid-swap, reset once it
  settles.** Otherwise a tile sliding across a neighbor (drag-follow, or the
  swap/revert tween) can render *behind* it, since z-order among same-parent
  siblings is otherwise just child-array order (unstable across cascades —
  don't rely on it). `_onDragStart` sets it, `_onSwipe`'s edge-snap-back and
  both of `_attemptSwap`'s exit paths reset it once the tile is back at rest
  and no longer overlapping anything.
- **A spawned special's color/type must be captured at spawn time, in
  `Board.resolve()`'s own `spawned` array — never re-read from
  `board.cells[r][c]` afterward.** This was a real bug (matching 4 blue
  tiles rendered *red* stripes): `resolve()` runs gravity/refill on the same
  call before returning, and gravity can move the just-spawned special to a
  different row in its column; whatever value falls into its *old* (r,c)
  afterward has nothing to do with the special's own color. `spawned` now
  carries `typeId` explicitly (from the matched run's own `typeId`, known
  before gravity touches anything) precisely so `BoardView` never needs to
  re-derive it from post-gravity board state. Confirmed fixed by logging
  every spawn's `(typeId, chosen frame)` pair across a live swipe sweep and
  checking each against `theme.ts`'s mapping by hand — all consistent.
- **No deadlock detection.** If a generated/cascaded board ends up with zero
  legal moves, nothing currently reshuffles it — not in the v1 scope below,
  not implemented. Worth adding before this template ships anywhere real.
- **Wrapped-tile spawning is confirmed live**, and its detonation area size
  is confirmed correct via the direct `Board`-model tests described in "Real
  Candy Crush reference" (`_areaCells('wrapped', ...)`, exercised by the
  wrapped+wrapped and striped+wrapped combo tests). **Not yet seen live**:
  a wrapped tile detonating via `_catchBystanders`'s passive chain-reaction
  path specifically (i.e. an *ordinary* new match happening to clear a cell
  that already held a wrapped tile from an earlier turn) — the deliberate
  swap-activation path is what's been exercised so far, live and in tests.
- **No audio wired yet.** `theme.sfx` keys are placeholders — there are no
  real SFX files in `res/` yet, so `BoardView` doesn't call into
  `AudioEngine`/`AudioSource` at all. Wire it once real SFX assets exist (see
  this doc's "Audio" section above for the grounding rule).
- **HUD/end-screen are functional but not fully art-directed** — flat
  `ColorRect` bars/overlays (now 3 HUD columns and an end-card, shipped
  2026-08-24 — see "Presentation & juice"'s HUD bullet), no animation on
  score/moves/target changes yet beyond the tile-level juice in this doc's
  "Presentation & juice" section (which *is* implemented: pop/fade clears,
  backOut cascade falls, elasticOut special spawns, cubicOut swaps).
- **Drag is axis-locked** (shipped 2026-08-24, `BoardView._onDragMove`) — a
  dragged tile's sprite follows only whichever of dx/dy is currently
  larger, zeroing the other axis, instead of tracking the raw pointer
  vector; a candy only ever swaps into a horizontal or vertical neighbor,
  so letting it visually drift diagonally never corresponded to a real
  swap target anyway.
- **End-card CTA popup** (shipped 2026-08-24, `GameScene._showEndCard`) —
  shows on both win and lose (playable-ad end cards conventionally always
  land the player on a CTA regardless of outcome): a message, and a
  download control wired to `platform.triggerCTA(url)` so the destination
  URL is never rendered as visible text — built as a plain `Node`+
  `ColorRect`+`Label` with a raw `Input.CLICK` listener rather than the
  `Button` component, to keep this template's component/bundle footprint
  small. `CTA_URL` in `GameScene.ts` is a placeholder
  (`https://example.com/download`) pending a real store/pitch link.
  **No close/cross button is drawn** — confirmed via this session's web
  research (Google Ads playable specs, Meta Audience Network's playable
  guide, Unity Ads' playable end-card docs) that every major network's own
  host container draws that control, not the creative; this doc previously
  only had that confirmed for AppLovin/Unity's MRAID path specifically.
- **Rules turned into data, and the Color-Bomb-swap position bug fixed
  (2026-08-25)** — two changes, one cause. `Board.activateSpecialSwap()` used
  to run a combo against *pre-swap* coordinates (`BoardView` deliberately
  skipped `board.swap()` on that path) while the two sprites had already
  tweened into each other's cells. Every position it reported was therefore
  off by one tile: the Color Bomb's beam fired at the bomb's own sprite, and
  the candy the player swapped in got no bolt, no impact ring and no burst —
  it just vanished when the pass popped, while every other candy of its color
  detonated properly. The visible symptom was "the swapped item isn't
  destroyed". Fixed by making that path swap the model first, exactly like
  the normal match path, so `activateSpecialSwap(r1, c1, r2, c2)` now reads
  both cells as they stand (its `s1`/`s2` parameters are gone — it looks the
  specials up itself). **If you touch this path, keep model and view in
  agreement: swap, relabel `this.nodes`, then activate.** The same audit
  turned up the reason such bugs kept recurring — the "which rule wins" and
  "what does this special do" decisions were `if`-chains inside the model
  with only their thresholds in `rules.ts`, so priority questions had no
  single place to live. They're now the `spawn`/`activation`/`combos` tables
  described under "Config-driven architecture" above, with explicit
  `priority` numbers, one shared `AreaSpec` vocabulary and one resolver
  (`Board._areaCells`). Behavior is unchanged except for the position fix
  and two additions the tables made trivial: `rules.scoring.cascadeMultipliers`
  / `specialCreateBonus` (a move's cascade is scored by depth now —
  `Board.beginMove()` resets it, called once per swap), and a Color Bomb +
  striped/wrapped combo now reports each converted tile's own detonation, so
  the renderer draws a real beam/burst at each instead of a plain pop.
  Verified with the standalone `Board`-model method below (31 assertions
  across all four combos, both spawn conflicts, and the scoring maths) plus a
  Playwright pass over every `?layout=` combo scene — no console errors, and
  the swapped candy now visibly takes a bolt, a ring and a burst of its own.
- **Four rule mismatches against `candy_crush_rules.md` fixed 2026-08-25**,
  found by a direct cross-check of that doc against `Board.ts`/`BoardView.ts`
  (see "Real Candy Crush reference" above for the corrected behavior in each
  case, "Special-tile swap activation" and the updated combo-effects bullets
  in particular): the striped-tile clear direction was inverted, a lone
  striped/wrapped special always activated on swap regardless of match
  outcome instead of following the real 3-case rule, wrapped tiles only
  detonated once instead of twice, and Wrapped+Color-Bomb never ran its
  second-random-color wave. The last two required a small addition to
  `Board.ts` — a private `_pending: PendingAction[]` queue, drained by
  `_drainPending()` at the top of every `resolve()` call — so a detonation
  can force a second explosion on the *next* pass, after gravity has
  refilled the board (there was no way to express "explode, wait for
  refill, explode again at the same spot" with `resolve()`'s prior
  single-pass shape). Verified the same way the original combo matrix was
  (standalone `tsc`-compiled `Board`, hand-set `cells`/`specials`,
  assertions on `resolve()`/`activateSpecialSwap()` — see "Verification
  approach used" below) — six scenarios covering all four fixes, re-run
  several times to rule out RNG-driven flakiness in the double-detonation
  cell counts (refill can coincidentally add an extra incidental match on
  top of a forced explosion; the assertion checks the forced area is a
  *subset* of what cleared, not an exact count, for that reason).
- **Striped-tile fix corrected again, same day** — the first pass at the
  stripe-direction fix above flipped the wrong side of the mapping: it made
  `Board._areaCells` clear in the "corrected" direction per-kind, which broke
  self-consistency with `BoardView.frameKeyFor`'s sprite choice (confirmed by
  cropping `res/candies.png` — see "Special candy creation" above) — a
  horizontal-*looking* striped tile ended up clearing a column, contradicting
  candy_crush_rules.md's own "Blast Effect" rule ("the candy always clears a
  path in the direction its stripes point"). The real fix moves the
  perpendicular mapping to `Board.resolve()`'s two spawn sites instead (which
  kind a given match orientation spawns), leaving the per-kind area lookup (`_areaCells` today, `_areaFor` then) and
  `frameKeyFor` exactly as they always were. Re-verified with the same
  standalone-script method, including two new spawn-side assertions (a
  horizontal run spawns `'striped-v'`, a vertical run spawns `'striped-h'`)
  — 5 clean runs. Worth remembering: a "the clear direction is wrong" bug can
  have two different correct fixes (which end clears which way, vs. which
  kind gets spawned by which match) that produce the same clear-direction
  outcome but differ in whether they stay consistent with the sprite/art
  mapping — check both ends before picking one.

## Real Candy Crush reference (researched, not all adopted)

Written down before extending gameplay further, per the user's request —
this is what the real game actually does, sourced from King's own support
site, the Candy Crush Saga Fandom wiki, and secondary guides (links at the
bottom of this section). `candy_crush_rules.md` (repo root) is the
follow-up, hand-authored rule book checked directly against `Board.ts` on
2026-08-25 — where the two disagreed, `Board.ts` was brought in line with
it (stripe clear direction, the three-case special-swap rule, wrapped's
double-detonation, Wrapped+Color-Bomb's second-color wave — all below).
"v1 gameplay scope" below states what *this project* actually implements;
treat any remaining gap between the two sections (Jelly, the other
non-Moves level types) as deliberate scope-narrowing for a playable-ad
template, not something accidentally missed.

**Basic rule**: swap two adjacent candies; a swap that doesn't produce a
3+ match reverts. Limited moves (or time, depending on level type — see
below). This part matches our v1 scope exactly — the "3" is
`rules.matching.minMatchLength`, not a literal in `Board.ts`.

**Special candy creation**:
- **Striped candy** — exactly 4 in a row or column, spawning the
  **perpendicular** orientation: a horizontal match produces a
  vertical-look/column-clearing tile, a vertical match produces a
  horizontal-look/row-clearing tile — the "counterintuitive rule" multiple
  secondary sources describe for the official game, and the one
  `candy_crush_rules.md` states explicitly (Perpendicular Line Rule / Swipe
  Motion Rule / Blast Effect). Confirmed against our own art too, not just
  taken on faith: cropping `res/candies.png`'s `candy_082`/`candy_084` (the
  green square's two striped frames) shows `candy_082` (`theme.ts`'s
  `stripedVerticalSpriteKey`) is visually vertical bars and `candy_084`
  (`stripedHorizontalSpriteKey`) is visually horizontal bars — i.e. each
  kind's own name/sprite/clear-direction are already self-consistent
  (`'striped-h'` always looks horizontal *and* always clears the row it
  points along, matching candy_crush_rules.md's Blast Effect: "the candy
  always clears a path in the direction its stripes point"). The
  perpendicular part of the rule — *which* kind a given match spawns — lives
  entirely at the two `spawned.push(...)` call sites in `Board.resolve()` (an
  `h`-orientation run spawns `'striped-v'`, a `v`-orientation run spawns
  `'striped-h'`); `Board._areaCells` and `BoardView.frameKeyFor` never
  special-case match direction at all, only the kind's own kind string. (An
  earlier pass at this fix, 2026-08-25, made the mistake of flipping
  the area-per-kind lookup's own clear direction instead of the spawn-side
  mapping — which produced the *right* clear direction but broke the Blast
  Effect rule, since it left a horizontal-*looking* tile clearing a column.
  Corrected the same day once caught.)
- **Wrapped candy** — 5 candies in an L, T, or plus shape (two runs of 3+
  crossing at one cell). Matches our `Board.resolve()`'s h/v-run-intersection
  merge logic. Its blast radius on detonation
  (`rules.activation.wrapped.area`, a `box` of radius 1 = a 3x3 area) is a
  rule knob too, not a hardcoded loop bound, and its double explosion is
  `repeats: 1` on that same entry rather than a special case in the model.
- **Color Bomb** — 5 in a straight line (row or column) of the same color.
  **Implemented**: `rules.spawn`'s `line-5-color-bomb` rule, whose higher
  `priority` is what stops a 5+ run falling through to the striped rule (or
  yielding to an L it happens to cross) — no ordering assumption baked into
  `Board.resolve()`. Its board-model color is the
  `COLOR_BOMB_TYPE_ID` sentinel (`-2`) — never a real 0..typeCount-1 id — so
  it can never accidentally join or be joined by a normal color run. Its
  single colorless frame is `theme.colorBombSpriteKey` (not per-`TileTypeConfig`,
  since it represents no one color) — checked *before* any
  `theme.tileTypes[typeId]` lookup in `BoardView.frameKeyFor`, since a Color
  Bomb's `typeId` is only meaningful at spawn time (for scoring/bookkeeping)
  and becomes the sentinel once it falls during a cascade.

**Special-tile swap activation** (fixed 2026-08-25 to match
`candy_crush_rules.md` §3 exactly) — three different rules depending on
what's on each side of a deliberate swap:
- **A Color Bomb on either side, or two non-Color-Bomb specials swapped
  together** — always activates unconditionally, ignoring color-matching
  entirely, and never reverts. `BoardView._attemptSwap` routes these through
  `Board.activateSpecialSwap()` instead of the normal match path (see below
  for its combo matrix).
- **A lone striped/wrapped special swapped with a plain candy** — its
  activation depends on whether/where a match forms, same as the real game:
  no match at all (either color) reverts, special doesn't activate; a match
  forms using the *other* candy's color only (not touching the special's own
  new cell) clears normally and the special just slides into its new
  position, inert; a match forms that includes the special's own color *at
  its new cell* and it activates from there. `BoardView._attemptSwap` gets
  all three for free by routing this case through the exact same
  `swap()`/`hasAnyMatch()`/`resolve()` path as two plain candies — a match
  that happens to include the special's cell picks it up via
  `resolve()`'s `_catchBystanders` bystander logic, no special-casing needed.
  (Previously *every* special swap — lone or combo — always activated
  unconditionally; that matched Color Bomb's real rule but not
  striped/wrapped's.)

**Special + special combination effects** (swapping two specials into each
other) — **implemented**, in `Board.activateSpecialSwap()` (see above for
when it's called). Effects (intentionally simplified versions of the real
game's, not claimed to be pixel-exact except where noted):
- Striped + Striped → clears a full row *and* column through the swap point
  (`r1,c1`) — 15 cells on an 8-wide/tall board, verified directly against
  `Board`.
- Striped + Wrapped → the same row+column, but thickened to a `band-cross`
  of radius 1 (3 full rows + 3 full columns) instead of a single line, and (since this combo involves
  a wrapped tile) **also double-explodes** the same way Wrapped+Wrapped does
  below — verified directly.
- Wrapped + Wrapped → a bigger area, a `box` of radius 2 instead of the
  lone wrapped tile's radius 1 (25 cells), that **explodes twice**
  — matches candy_crush_rules.md's "5x5 blast area that explodes twice"
  exactly (previously a single explosion; the second explosion is queued via
  `Board`'s `PendingAction` queue, described below, and fires on the very
  next `resolve()` pass, after gravity has refilled the first blast). Both
  explosions verified directly.
- Color Bomb + Striped/Wrapped → every candy of the *other* candy's color is
  cleared, each also triggering that special's own area from its own
  position (a simplified stand-in for "they all turn into that special and
  detonate") — verified directly. When the other special is **Wrapped**
  specifically, this also matches candy_crush_rules.md's fuller description:
  each of those wrapped detonations double-explodes (queued the same way as
  a standalone Wrapped+Wrapped), and once that settles, a **second random
  color** (excluding the first) gets the same full wrapped-and-detonate
  (and double-explode) treatment — queued as a `'colorSweep'` `PendingAction`.
  Striped+Color-Bomb has no such second-color step; that's Wrapped+Color-Bomb
  only, per the rule book.
- Color Bomb + Color Bomb → clears the entire board — verified directly.
- Color Bomb + a normal candy → clears every candy of that normal candy's
  color — verified directly (the exact mechanism, `activateSpecialSwap`'s
  `s1===color-bomb || s2===color-bomb` branch, scanning `cells` for
  matching `typeId`).
- **Any wrapped detonation always double-explodes** — not just the
  Wrapped+Wrapped and Wrapped+Color-Bomb combos above, but a lone wrapped
  tile too, whether caught passively in another special's blast, or
  activated via the swap-activation rule above (its own-color match at its
  new cell). `_expandCaught`/`_drainPending` queue the second explosion at
  the same origin cell whenever a `'wrapped'` bystander detonates;
  `Board.resolve()` drains that queue (`Board._drainPending()`) at the start
  of its very next call, against whatever fell into that spot by then. This
  is the `PendingAction` mechanism referenced throughout this section — see
  its own doc comment in `Board.ts` for the full contract.
- A special caught *passively* in another special's blast (not deliberately
  swapped) always just clears as a bystander — a Color Bomb never
  chain-reacts this way (`_catchBystanders` explicitly skips it), since it
  has no fixed "area of its own" the way striped/wrapped do.
- **Chain reactions resolve as a sequence of phases, not one flattened
  instant** — a bystander directly part of the *originally* matched/forced
  cells activates immediately (its own area clears the same phase, one
  visual beat, same as before), but anything that activation's own area
  newly *reveals* (a different special sitting somewhere within its sweep,
  not part of the original cells) is left untouched and deferred to the
  *next* `resolve()` call instead of being expanded in the same instant —
  `Board._catchBystanders`/`_expandCaught`, replacing the old
  `_floodDetonate` recursive flood-fill. `BoardView._runCascade`'s existing
  per-`resolve()`-call loop already animates each phase as its own beat with
  no changes needed there. This is also why a freshly-created special (from
  `resolve()`'s `registerSpawn`) is destroyed, never protected, if caught
  this way — matching real Candy Crush — but the *chain reaction it in turn
  causes* is its own later beat, not simultaneous with its own destruction.
- **Not implemented**: the two swapped cells' *own* special entries are
  deleted from `Board.specials` before flooding, specifically so they don't
  *also* independently re-contribute their own base area as if they were an
  incidentally-caught third party — this was a real bug caught by direct
  `Board`-model testing (striped+striped measured 22 cells instead of the
  correct 15, before the fix), not by chance during manual play. If you
  touch `activateSpecialSwap`, re-verify against a script like the one
  described in "Verification approach used" below rather than trusting
  random play to expose a miscount.

**Level types**: the official game has five — Moves (reach a target score
within a move limit), Jelly (clear all jelly tiles), Ingredients (carry
ingredients to the bottom), Timed (reach a target score before time runs
out), and Candy Order (clear a specified count of specific candies/specials
within a move limit) — plus Mixed levels combining two or more. **Our v1
scope is the Moves type only** — `rules.winCondition.moveLimit` +
`targetScore` — the other four (and their board mechanics: jelly layers,
ingredient-drop physics, order-tracking HUD) are not implemented and not
currently planned for this template.

**Verification approach used for this section**: random live play can't
reliably exercise a 5-match or a deliberate special+special swap (both are
rare to hit by chance), and even when it does, eyeballing a screenshot can't
confirm an exact cleared-cell count. Instead, `Board.ts` + `theme.ts` +
`rules.ts` (pure data/logic, zero NoonEngine imports) were compiled
standalone with `tsc` (`module: commonjs`) into a scratch directory and
exercised directly with `new Board()`, hand-set `cells`/`specials`, and
assertions on `resolve()`/`activateSpecialSwap()`'s returned counts — no
UI, no engine, no randomness to fight. This is the right tool whenever
you need to check an exact number `Board.ts` produces (a match tier
threshold, a combo's cleared-cell count) rather than "does it look right on
screen" — reach for it instead of trying to force a rare board state
through the live game.

That same idea is also wired into the *live* game, for manually testing in
a real browser rather than only in a standalone script:
**`src/game/debugLayouts.ts`** holds hand-authored, pre-validated fixed
board layouts (checked the same way — `hasAnyMatch()` false on load, the
intended swap producing the intended result — before being trusted), loaded
via `?layout=<name>` in the URL (`GameScene._build()`, threaded through
`new BoardView(..., debugLayout)` into `new Board(debugLayout)`). No
`layout` param plays a completely normal random game — this is purely
additive and never active unless explicitly requested. Current layouts:
`colorbomb` (one vertical swap away from a 5-match), `combo` (a striped-h
and a wrapped tile already sitting adjacent, ready to swap into each
other), and `colorbomb-activate` (added 2026-08-24 — a Color Bomb next to
a plain candy, plus scattered same-typeId singletons elsewhere on the
board, to exercise the Color Bomb's own activation and its "lightning"
beam effect without needing a rare 5-match to happen first). Confirmed
live: `?layout=colorbomb` + the swap scored exactly 40 (4 cleared cells,
matching the standalone test); `?layout=combo` + the swap scored exactly
390 (39 cleared cells, also matching); `?layout=colorbomb-activate` + the
swap correctly decremented the collect-mode target by the cleared count
and rendered a beam line to every same-color cell on the board.

Building `debugLayouts.ts` surfaced one more real bug: `BoardView`'s
initial tile-node creation loop hardcoded `special: null` for every
starting tile (harmless for a random board, which never starts with a
special) instead of reading `board.getSpecialAt(r, c)` — so a
`DebugLayout`'s seeded specials rendered as plain base tiles until fixed.
If you add a `DebugLayout` field that seeds *new* initial state (not just
`cells`/`specials`), check whether every place that reads initial board
state has a matching hardcoded assumption like this one.

**Isolated effect-testing scenes** (added 2026-08-25,
`src/game/StripedEffectTestScene.ts`, run via `?scene=striped-test` in
`src/index.ts` instead of the normal `GameScene`) — for when even a
`?layout=` debug layout inside the real game isn't isolated enough: a
plain `GameScene` run has HUD/win-condition noise, and (the actual reason
this one exists) a checkerboard-filler debug layout's post-clear gravity
refill draws from the *full* random type pool, not just the checkerboard's
own 2 types — so it's genuinely common for one deliberate match to kick off
several incidental chained cascades (new specials spawning by chance) that
make it hard to tell which effect belongs to which tile, and can leave a
cascade still running well past a naive ~1s wait. `StripedEffectTestScene`
sidesteps this by reusing the real `Board`/`BoardView` production code with
nothing else running, loading `debugLayouts.ts`'s `striped-h-4match`/
`striped-v-4match` (`?dir=h`/`?dir=v`) — each one swap away from a 4-match —
so the striped tile's activation effect can be checked on its own. This is
exactly how the `_spawnStripedBeam` fix above was found and verified: the
first implementation looked plausible in the full game but was wrong once
isolated and actually measured against "does it cover the whole line."
Model state (`board.specials`) is the source of truth for where a special
actually is if a screenshot is ambiguous — reading tile position off a
screenshot by eye misjudged the row by one more than once while debugging
this, exactly the kind of mistake worth checking against `board.specials`
directly instead of re-guessing from pixels.

**Scoring**: base points per cleared candy (matches our
`rules.scoring.pointsPerTile` approach), plus an end-of-level "Sugar Crush"
bonus mechanic (unused moves
convert into bonus special-candy detonations for extra points) that we don't
implement — our v1 just stops at win/lose the instant the score/moves
condition is met, no bonus phase.

Sources: [How can I create Special Candies? – Candy Crush Saga](https://candycrush.zendesk.com/hc/en-us/articles/211939685-How-can-I-create-Special-Candies), [Special Candy Combos – Without the Sarcasm](https://www.withoutthesarcasm.com/posts/candy-crush-saga-special-candy-combos/), [How do I make stripes go the way I want? – Candy Crush Saga All Help](https://candycrushsagaallhelp.blogspot.com/2013/12/how-do-i-make-stripes-go-way-i-want.html), [Learn all about the Color Bomb – Candy Crush Saga](https://candycrush.zendesk.com/hc/en-us/articles/13940218109469-Learn-all-about-the-Color-Bomb), [Level Types – Candy Crush Saga Wiki](https://candycrush.fandom.com/wiki/Level_Types)

## v1 gameplay scope

For whoever implements the game logic next (this doc describes the target,
it does not mean it's already built):

1. Swap two adjacent tiles on input.
2. A swap that creates a 3+ run (row or column) of the same tile type is
   valid; clear the run, award score, and cascade-refill the board from the
   top. An invalid swap (no resulting match, and neither tile is a special)
   reverts.
3. A run of 4-in-a-row produces a **striped tile**; an L/T-shape match
   produces a **wrapped tile**; a run of 5-in-a-row produces a **Color
   Bomb** — matching the classic Candy Crush mechanics (see "Real Candy
   Crush reference" above for the exact effect each one has and the
   simplifications we made).
4. Swapping a Color Bomb with anything, or two non-Color-Bomb specials
   together, always activates unconditionally, even if the swap wouldn't
   otherwise have formed a match — this never reverts, and two specials
   together combine their effects per the combo matrix in "Real Candy Crush
   reference". Swapping a lone striped/wrapped special with a plain candy
   instead depends on whether/where a match forms — see "Special-tile swap
   activation" in "Real Candy Crush reference" for the exact three-case rule.
5. The game is **moves-limited**, with two win-condition shapes
   (`rules.winCondition.mode`, a discriminated union — see `rules.ts`):
   `'score'` (reach a target score) or `'collect'` (collect a target count
   of one or more specific tile types, decrementing as matching-typeId
   tiles clear, floored at 0 — the current default). Either way it ends in
   a win once its target is met, or a loss once moves run out — every
   number comes from `rules.ts`, not hardcoded in `src/game/`.

## Presentation & juice

Also part of the v1 scope (not built yet), covering the parts of the game
that aren't board logic:

- **HUD**: shipped 2026-08-24 as 3 columns in the top bar — moves (left),
  score (center), target (right). The target column is mode-dependent
  (`GameScene._buildScoreTargetColumn`/`_buildCollectTargetColumn`): a
  manual-fill progress bar (plain `Node`+`ColorRect`, same technique as the
  bar itself — no `ProgressBar` component) in `'score'` mode, or one
  icon+count row per target (top-to-bottom in `rules.ts`'s array order) in
  `'collect'` mode, counting down and floored at 0. Numbers come from game
  state driven by `rules.ts`'s win-condition config, not hardcoded.
- **Tile destroy**: on a match, don't cut straight to scale-down — give
  matched tiles a quick "pop" first, like Candy Crush does: scale
  `1→1.15` with `Easing.backOut`, then immediately `1.15→0` with opacity
  `1→0` on `Easing.cubicIn`. Match/detonation effects shipped 2026-08-24
  (`BoardView._burst`/`_spawnPlainBurst`/`_spawnWrappedBurst`/
  `_spawnLightningBeam`, driven by `Board.ts`'s
  `ResolveResult.activatedSpecials`/`colorBombBeam` and
  `theme.tileTypes[].effectColor`) — one-shot, fire-and-forget nodes that
  clean themselves up, never awaited by the cascade loop, so they stay
  cheap against ad-network size budgets (see
  `skills/build/platform-targets.md`) without affecting cascade pacing.
  **Striped-tile activation is `_spawnStripedBeam`, not a particle burst**
  (fixed 2026-08-25, after live testing surfaced that the first
  implementation — a small directional particle streak near the tile's own
  cell — didn't read as "the effect covers the whole line" the way real
  Candy Crush's does): a plain `Node`+`ColorRect` sized to the board's
  *entire* width (horizontal) or height (vertical), flashed and faded —
  "cover the whole row/column" is a rectangle, not a radiating burst.
  Verified with `StripedEffectTestScene.ts` (below).
- **Cascade-refill landing**: falling tiles use `Easing.quadOut` for the
  fall itself, but end on a small settle-bounce (`Easing.backOut`, a slight
  overshoot past the final position before easing back) instead of stopping
  dead — this is the "tiles thump into place" feel Candy Crush has.
- **Special tile creation**: when a 4-in-a-row/L-shape match spawns a
  striped/wrapped tile, pop it in with `Easing.elasticOut` (or `backOut` if
  `elasticOut` reads as too bouncy in practice) — this moment is meant to
  read as a reward, so it's the one place an overshoot curve is the
  intended choice, not the exception.
- **Swap**: stays snappy and plain — `Easing.cubicOut`, no overshoot. Swap
  happens on every single move, so keep it quick and low-key; save the
  bounce/pop juice for match/refill/special-tile moments, which are the
  rarer, rewarding beats.

## Audio

Use the 2D audio system for SFX (swap, match, combo, win/lose) —
`AudioEngine` (`engine/lib/audio/AudioEngine.js`), `AudioSource`
(`engine/lib/components/audio/AudioSource.js`), and `AudioClip`
(`engine/lib/assets/AudioClip.js`).

There is **no `skills/audio/*.md` doc yet** for this system (only
`skills/3d/audio3d.md`, which is the unrelated 3D positional-audio system
gated behind `--3d`/Three.js — not what this project uses). Per
`AI_WORKFLOW.md`'s Rule 1 fallback order, ground every audio API call
directly against `engine/types/audio/*.d.ts` and
`engine/types/components/audio/*.d.ts` (this project is `--vendor`'d, so
`engine/`, not `node_modules/noonengine/`) instead of a skill doc.

## Playable-ad framing

Game code calls `createPlatform()` unconditionally (already wired in
`src/index.ts`) and never branches on which platform/ad-network a build
targets, except the one documented exception in `CLAUDE.md`
(`platform.isAdCreative`, for showing/hiding a CTA button). No specific ad
network is targeted yet for this project — `npm run pack:<network>` is for
later, once a specific studio pitch needs a real size-budgeted, CTA-wired
build.
