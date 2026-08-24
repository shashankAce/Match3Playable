# match3-playable

A Candy-Crush-type match-3 game built with [NoonEngine](https://github.com/),
one piece of a playables portfolio pitched to game studios. It doubles as a
reusable template — see "Reskinning this template" below.

## Getting started

```
npm install
npm run dev
```

Then open http://localhost:8000 (falls back to the next free port if 8000 is taken). Edit `src/index.js` (or `src/index.ts`) and reload.

### Testing specific match-3 scenarios

Some scenarios (a 5-match, two special tiles landing next to each other)
are rare to hit by chance on a random board. Add `?layout=<name>` to the
dev URL to load a fixed board set up for one instead — see
`src/game/debugLayouts.ts` for the available names and what swap to try.
No `layout` param plays a completely normal random game.

## Build

```
npm run build
```

Produces a minified, trimmed bundle in `build/` — `npm run build` auto-detects which `noonengine` imports your game actually uses and excludes unused renderer backends/systems. Use `npm run build:notrim` to skip trimming.

## Publishing to a platform

`src/index.js`/`.ts` already calls `createPlatform()` — one wrapper that works
for Facebook Instant Games, Telegram, YouTube Playables, Google Ads and Meta
playable creatives, or plain web (a no-op) without any code changes between targets. To
build and package for one:

```
npm run pack:facebook      # → build-facebook/   + build-facebook.zip
npm run pack:telegram      # → build-telegram/   (host it yourself)
npm run pack:youtube       # → build-youtube/    + build-youtube.zip
npm run pack:google-playables     # → build-google-playables/ + build-google-playables.zip
npm run pack:meta-playables       # → build-meta-playables.html   (ONE self-contained file)
npm run pack:applovin-playables   # → build-applovin-playables.html
npm run pack:unity-playables      # → build-unity-playables.html   (use for ironSource too)
npm run pack:standalone     # → build-standalone.html (same, but no host at all)
```

`standalone` gives you that same single self-contained `.html` with no host SDK
and no size limits — useful for an ad network not listed here, a portable demo,
or an embedded webview.

`google-playables` and `meta-playables` are playable *ad creatives* rather than hosted
games: wire your call-to-action button to `platform.triggerCTA(STORE_URL)` — always
pass the URL, since MRAID networks (AppLovin/Unity Ads) require it while Meta and
Google ignore it (and use
`platform.isAdCreative` to decide whether to show that button at all).

Neither accepts audio/webp/JSON as *files*, but you don't need to do anything
about that — `pack` embeds them as data URIs automatically and `assetCache`
resolves them transparently. `meta-playables` goes further and produces a single
self-contained `.html` with the JS/CSS folded in too; upload that one file. Its
2MB cap is on the raw file, so embedded assets cost 1.33× there (~1.4MB of raw
assets is about the ceiling), and nothing can be lazy-loaded.

This works the same whether or not the project was scaffolded with `--vendor`
— unlike `update` (below), `pack` never needs to reach the engine repo itself,
only whatever engine version this project already has, so `bin/create.js`
already pointed these scripts at the right place for either case.

Need something specific to this game for one platform (custom loading screen,
favicon, a hand-tuned config field)? `npm run pack:facebook:init` (or
`:telegram:init`/`:youtube:init`/`:google-playables:init`/`:meta-playables:init`/`:standalone:init`) scaffolds a `platform-templates/<name>/`
folder with an editable starting point instead of guessing file names, then
exits without building.

See `skills/build/platform-targets.md` for what each target needs and what
`pack` checks/injects for you.

## Updating the engine

If this project depends on `noonengine` via a local `file:` path (the default, no `--vendor` flag at scaffold time), just `npm install` again after the engine repo changes — it's a symlink, so you already have the latest code.

If this project was scaffolded with `--vendor` (engine source copied into `engine/`, committed to git, no npm dependency on it), re-sync it from inside this project with:

```
npx /path/to/NoonEngine update
```

This overwrites `engine/` with whatever the engine repo currently looks like. Run it whenever the engine has a fix you want. Note it only touches `engine/` — it never modifies this project's `package.json` dependencies, so if you're adding 3D/physics support after the fact, install the real dependency yourself (see below).

## Adding 3D or physics later

3D (`Mesh3D`, `Camera3D`, lights) and physics (`RigidBody2D`/`RigidBody3D`, colliders, joints) are opt-in — this project only has the real npm dependency installed if it was scaffolded with `--3d`/`--physics`/`--physics3d`. To add one after the fact:

```
npm install three                    # enable3D / three: — Mesh3D, Camera3D, lights
npm install matter-js                # enablePhysics / physics: — RigidBody2D, BoxCollider2D, Joint2D
npm install @dimforge/rapier3d       # enablePhysics3D / physics3D: — RigidBody3D, BoxCollider3D, Joint3D (requires 3D)
npm install -D @types/three @types/matter-js   # TypeScript projects only — rapier3d ships its own types
```

`@dimforge/rapier3d` needs an explicit init step (its native ESM `.wasm` import doesn't work in WeChat Mini Games) — use `noonengine/bin/rapier-wasm-loader.js`'s `initRapierFromUrl`/`initRapierForWeChat` instead of importing it directly, and wire `rapierLoaderRedirectPlugin()` into `vite.config.js` if not already present. See `enablePhysics3D`'s config comment in the engine's `lib/core/GameConfig.js` for the exact snippet.

## Project layout

- `src/index.js` (or `.ts`) — your game's entry point, run by `npm run dev`/`npm run build`
- `src/` — your game code
- `engine/` — vendored engine source, only present if scaffolded with `--vendor`
- `vite.config.js` — dev server + build config, including Roller trimming and (if `--physics3d`) the Rapier WASM loader plugin

## Reskinning this template

Config is split in two: visual/audio identity (tile sprite/SFX keys) lives in
`src/config/theme.ts`, and gameplay rules (grid size, match thresholds,
win-condition numbers, scoring) live separately in `src/config/rules.ts` —
the rest of the game (`src/game/`) is written against both, not against any
specific theme or difficulty. To build a differently-themed match-3 game
from this project: copy it, then edit `src/config/theme.ts` + swap the
assets in `res/` (new look), `src/config/rules.ts` (new difficulty/scoring),
or both. See [AGENTS.md](AGENTS.md) for the full rule and the v1 gameplay
scope this template targets.
