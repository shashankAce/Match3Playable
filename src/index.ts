import { GameEngine, createPlatform, ResolutionPolicy, RendererType } from 'noonengine';
import { GameScene, GAME_WIDTH, GAME_HEIGHT } from './game/GameScene';
import { StripedEffectTestScene } from './game/StripedEffectTestScene';

// Host-platform wrapper — the same three calls (initialize / reportProgress /
// notifyReady) work for every target, so nothing below ever branches on which
// platform this is. With no platform targeted (a plain `npm run dev`/`npm run
// build`) this is a working no-op, so leave it in even if you only ship to the
// open web: it costs nothing, and it's what makes `noonengine pack
// --platform=facebook|telegram|youtube` work later without touching this file.
const platform = createPlatform();
await platform.initialize();  // must be awaited BEFORE constructing GameEngine

const engine = new GameEngine({
    renderType: RendererType.WEBGL,
    showStats: true,
});

engine.setDesignResolution(GAME_WIDTH, GAME_HEIGHT, ResolutionPolicy.FIXED_HEIGHT);

// `?scene=striped-test` boots an isolated effect-testing scene instead of the
// real game — see StripedEffectTestScene.ts. No `scene` param (or an unknown
// one) always plays the normal game, same as any real player sees.
const sceneName = new URLSearchParams(location.search).get('scene');
engine.runScene(sceneName === 'striped-test' ? new StripedEffectTestScene(platform) : new GameScene(platform));
engine.start();
