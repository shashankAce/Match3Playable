# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this repository.

> **Before writing any code, read [AI_WORKFLOW.md](AI_WORKFLOW.md) in full.**
> It has the concrete rules and step-by-step workflow for finding real
> NoonEngine APIs instead of guessing from Cocos/Unity/Phaser/PixiJS
> conventions — the most common source of broken code in this repo.

> **Also read [AGENTS.md](AGENTS.md) before writing any game code.** It has
> this project's own rules — the config-driven reskinning contract between
> `src/config/theme.ts` (art/audio) + `src/config/rules.ts` (gameplay rules)
> and `src/game/`, the 2D-TS-only constraint, and the v1 gameplay scope.
> `AI_WORKFLOW.md` covers generic NoonEngine API usage; `AGENTS.md` covers
> what's specific to this game.

## What this is

**match3-playable** is a game built with [NoonEngine](https://github.com/) — a lightweight, dependency-light 2D/3D game engine. This is **not** a Cocos Creator, Unity, or Cocos2d-x project, even though some naming (`Scene`, `Node`, `Component`, a `res/` assets folder) looks similar to those engines' conventions. Do not apply Cocos Creator/Unity-specific APIs, file formats (`.meta` files, `.scene`/`.prefab` assets, `project.json` Cocos config), or workflows here — none of that exists in this codebase.

All engine code is imported from the `noonengine` package (see `src/index.js`/`src/index.ts`). If unsure whether an API belongs to NoonEngine, check `node_modules/noonengine` (or `engine/` if this project was scaffolded with `--vendor`) rather than assuming Cocos/Unity conventions.

## Architecture (Node / Component / System)

- **`Node`** is a plain container: hierarchy (`addChild`) + lifecycle (`onLoad`/`onStart`/`update`) + attached components.
- **`Component`** subclasses (e.g. `Sprite`, `Label`, `Graphics`, layout/physics components) attach to a `Node` via `node.addComponent(ComponentClass)`.
- **`Scene`** (extend it, like `MainScene` in `src/index.js`) is the root container passed to `engine.runScene(new MainScene())`.
- **`GameEngine`** is the top-level object — construct it once with renderer/config options and call `engine.start()`.
- **`assetCache`** (imported directly, e.g. `import { assetCache } from 'noonengine'`) preloads and retrieves image/audio assets, typically declared as a list and preloaded in `onLoad()`.
- **`createPlatform()`** (imported directly, `import { createPlatform } from 'noonengine'`) is already wired into `src/index.js` — one wrapper covering hosted platforms (Facebook Instant Games, Telegram, YouTube Playables), ad-network playable creatives (Google Ads, Meta, AppLovin, Unity Ads), or none (a working no-op), so game code never branches on which target this build is. See `skills/build/platform-targets.md` before changing any of its call sites (`initialize`/`reportProgress`/`notifyReady` have a required order) or adding `sendScore`/`saveData`/`triggerCTA` calls. The single exception to "never branch": `platform.isAdCreative`, since an ad creative needs a call-to-action button and a hosted game must not show one.

## Project layout

- `AI_WORKFLOW.md` — **read first**: the rules/workflow for verifying a NoonEngine API before using it, plus a lookup table from "what I want to build" to the right `skills/` doc
- `src/index.js` (or `.ts`) — the game's entry point, run by `npm run dev`/`npm run build`
- `src/` — game code
- `res/` — game assets (images, audio, etc.) — this is a plain asset folder for `AssetCache`, not a Cocos Creator `assets/` project
- `engine/` — vendored engine source, only present if scaffolded with `--vendor`
- `skills/` — NoonEngine reference docs (engine APIs by domain: rendering, layout, assets, animation, materials, UI, scenes, 3D, build) — check here for API details before guessing
- `vite.config.js` — dev server + build config

## Commands

```
npm install
npm run dev      # Vite dev server, http://localhost:8000 (or next free port)
npm run build     # production build to build/, trimmed via Roller (npm run build:notrim to skip trimming)
npm run pack:facebook   # or pack:telegram / pack:youtube / pack:google-playables / pack:meta-playables / pack:applovin-playables / pack:unity-playables / pack:standalone — build + package for one target (works the same with or without --vendor) — see skills/build/platform-targets.md
```

There is no unit test runner — verify changes by running `npm run dev` and viewing the game in the browser.

## Git

Commit messages must **not** include a `Co-Authored-By` trailer.
