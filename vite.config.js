import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { defineConfig } from 'vite';

// Loads .glsl / .vert / .frag / .wgsl files as plain string default exports —
// inlined here (not imported from noonengine/bin/) so this file works
// identically whether or not the project was scaffolded with --vendor.
function glslPlugin() {
    return {
        name: 'noonengine-glsl',
        enforce: 'pre',
        load(id) {
            if (!/\.(glsl|vert|frag|wgsl)$/.test(id)) return null;
            const src = fs.readFileSync(id, 'utf8');
            return `export default ${JSON.stringify(src)};`;
        },
    };
}

// A vendored engine/ folder (from `create --vendor`, see bin/vendor.js) means
// noonengine isn't an npm dependency at all — resolve the bare specifier to
// the vendored copy instead of node_modules, and pull the roller helpers from
// there too (they were copied alongside lib/ for exactly this reason).
const VENDORED = fs.existsSync(path.resolve('./engine'));

// Host platform this build targets — normally set for you by
// `npx noonengine pack --platform=<name>`, which exports it before invoking
// this config; set it by hand (`NOON_PLATFORM=facebook npm run build`) to get
// a platform-trimmed build without the packaging/zip step. Empty (the default
// for every plain `npm run build` and every dev-server run) means a plain web
// build, where all three platform adapters are trimmed out and
// `createPlatform()` returns the no-op base adapter.
const NOON_PLATFORM = (process.env.NOON_PLATFORM || '').trim().toLowerCase();

// Vite bundles this config file into a temp module under node_modules/.vite-temp/
// before evaluating it, so a *relative* dynamic-import specifier here (e.g.
// './engine/bin/x.js') would resolve relative to that temp file's location, not
// this file's real one. Absolute file:// URLs sidestep that entirely.
/** @param {string} relPath */
function vendoredBinUrl(relPath) {
    return pathToFileURL(path.resolve(relPath)).href;
}

export default defineConfig(async ({ command, mode }) => {
    // Swaps @dimforge/rapier3d's native-ESM-only wasm loader for an
    // explicit-init one that also works in WeChat Mini Games — see
    // noonengine/bin/rapier-wasm-loader.js's header comment for why. Safe
    // to register unconditionally (dev and build): a no-op unless the
    // project actually imports @dimforge/rapier3d (i.e. --physics3d).
    const rapierLoaderPluginPath = VENDORED ? vendoredBinUrl('./engine/bin/rapier-loader-plugin.js') : 'noonengine/bin/rapier-loader-plugin.js';
    const { rapierLoaderRedirectPlugin } = await import(/* @vite-ignore */ rapierLoaderPluginPath);

    // Shared with noonengine/vite.config.js and synced via `noonengine update`
    // (bin/ → engine/bin/) — see that file's own header comment for why this
    // is a synced constant instead of a hardcoded array: a project scaffolded
    // before a new exclusion was added here would otherwise stay silently
    // stale forever, since `update` never overwrites a project's own
    // vite.config.js.
    const optimizeDepsExcludePath = VENDORED ? vendoredBinUrl('./engine/bin/vite-optimize-deps.js') : 'noonengine/bin/vite-optimize-deps.js';
    const { OPTIMIZE_DEPS_EXCLUDE } = await import(/* @vite-ignore */ optimizeDepsExcludePath);

    /** @type {import('vite').PluginOption[]} */
    const plugins = [glslPlugin(), rapierLoaderRedirectPlugin()];

    if (command === 'build') {
        const debugStripPluginPath = VENDORED ? vendoredBinUrl('./engine/bin/debug-strip-plugin.js') : 'noonengine/bin/debug-strip-plugin.js';
        const { debugStripPlugin } = await import(/* @vite-ignore */ debugStripPluginPath);
        plugins.push(debugStripPlugin({ mode }));

        const copyResPluginPath = VENDORED ? vendoredBinUrl('./engine/bin/vite-copy-res-plugin.js') : 'noonengine/bin/vite-copy-res-plugin.js';
        const { copyResPlugin } = await import(/* @vite-ignore */ copyResPluginPath);
        plugins.push(copyResPlugin({
            // Set to true to only ship res/ files this build's code actually
            // references (useful e.g. for a shared repo with multiple
            // per-vendor res/ folders, where a given build only needs one).
            // See noonengine/bin/roller-asset-scan.js's header comment for
            // how "used" is detected, and list any file/folder here that the
            // scan can't prove used on its own (e.g. a path built at runtime
            // from a value not known until the browser runs).
            trimAssets: mode !== 'debug' && false,
            include: [],
        }));

        // detectUsage() always runs (cheap static analysis, no GPU/build cost)
        // — even in --mode notrim, which intentionally skips the *size*
        // trimming below — because GLTFModelLoader.js's/FBXModelLoader.js's
        // `three/examples/jsm/...` imports are a hard resolution requirement,
        // not a size optimization: a project scaffolded without --3d has no
        // `three` dependency installed at all, so Rolldown/Rollup fails to
        // resolve them outright ("Failed to resolve import ...", not just a
        // bigger bundle) the moment either file is reachable at all, which
        // they always are via the barrel. A notrim build still needs that
        // one stub applied even though every other system/renderer backend
        // stays untrimmed.
        const rollerDetectPath = VENDORED ? vendoredBinUrl('./engine/bin/roller-detect.js') : 'noonengine/bin/roller-detect.js';
        const rollerPluginPath = VENDORED ? vendoredBinUrl('./engine/bin/roller-plugin.js') : 'noonengine/bin/roller-plugin.js';
        const rollerManifestPath = VENDORED ? vendoredBinUrl('./engine/bin/roller-manifest.js') : 'noonengine/bin/roller-manifest.js';
        const { detectUsage } = await import(/* @vite-ignore */ rollerDetectPath);
        const { rollerExcludePlugin } = await import(/* @vite-ignore */ rollerPluginPath);
        const { resolvePlatformExclude } = await import(/* @vite-ignore */ rollerManifestPath);
        console.log('🔍 Detecting noonengine usage for auto-trim...');
        const { renderer, exclude, usedSymbols, notes } = await detectUsage('./src/index.js');
        console.log(`   Used symbols: ${usedSymbols.join(', ') || '(none detected)'}`);
        for (const note of notes) console.log(`   ${note}`);

        // `--mode debug` trims exactly like production — trimming is "which
        // modules ship", an orthogonal concern from minification/sourcemaps,
        // and a debug build is the right place to actually catch a bad
        // exclusion (readable/sourcemapped) instead of only surfacing as
        // breakage in the fully-minified prod build. `--mode notrim` is the
        // one true escape hatch that ships every module regardless of
        // usage, for when trimming itself needs to be ruled out as a variable.
        // Platform exclusion is target-driven, not usage-detected (detectUsage
        // can't see which host a build is for — that's an env var, not an
        // import), so it's merged in here rather than derived above.
        const platformExclude = resolvePlatformExclude(NOON_PLATFORM);
        console.log(`   Platform: ${NOON_PLATFORM || '(none — plain web)'}`);

        if (mode !== 'notrim') {
            console.log(`   Renderers: ${renderer.join(', ')}`);
            const allExclude = [...exclude, ...platformExclude];
            console.log(`   Excluded: ${allExclude.length ? allExclude.join(', ') : '(none)'}`);
            plugins.push(rollerExcludePlugin({ renderer, exclude: allExclude }));
        } else if (exclude.includes('3d')) {
            console.log('   Stubbing 3D-only files (no enable3D usage detected) — required even in an untrimmed build.');
            plugins.push(rollerExcludePlugin({ renderer: ['canvas', 'webgl', 'webgpu'], exclude: ['3d'] }));
        }
    }

    return {
        plugins,
        // Relative base so `index.html`'s emitted asset references (e.g.
        // `/assets/index-<hash>.js`) become `./assets/index-<hash>.js` instead
        // — the default absolute `/` base only resolves correctly when `build/`
        // is served from an actual domain root. It 404s the moment `build/` is
        // deployed under a subpath, embedded (itch.io), opened via `file://`,
        // or packaged into an instant-game sandbox (WeChat/Facebook/LINE) that
        // has no real root to resolve an absolute path against.
        base: './',
        // `__DEV__` — a bare, bundler-agnostic global that solely backs
        // noonengine's build-time `DEBUG` flag (see noonengine/vite.config.js
        // and types/globals.d.ts), `false` only for a real `npm run build`
        // (mode 'production'), `true` for dev/`--mode debug`/`--mode notrim`.
        define: {
            __DEV__: JSON.stringify(mode !== 'production'),
            // Backs noonengine's `PLATFORM` export / `createPlatform()`'s
            // default target, the same way `__DEV__` backs its `DEBUG` —
            // see NOON_PLATFORM's comment at the top of this file.
            __NOON_PLATFORM__: JSON.stringify(NOON_PLATFORM),
        },
        publicDir: false,
        resolve: {
            alias: VENDORED ? { noonengine: path.resolve('./engine/lib/index.js') } : undefined,
        },
        optimizeDeps: {
            // See bin/vite-optimize-deps.js's header comment for why each of
            // these specifiers must never reach Vite's dependency scanner.
            exclude: OPTIMIZE_DEPS_EXCLUDE,
        },
        server: {
            port: 8000,
            strictPort: false,
            cors: true,
        },
        preview: {
            port: 8000,
            strictPort: false,
            cors: true,
            open: true, // Optional: Automatically opens the browser
        },
        build: {
            outDir: 'build',
            target: 'es2022',
            // `--mode debug` (see package.json's `build:debug`) is a real production
            // build (same asset/roller pipeline above, including trimming) except
            // unminified + sourcemapped — for debugging an actual `build/` bundle
            // instead of the dev server, without wading through minified/mangled code.
            minify: mode !== 'development' && mode !== 'debug',
            sourcemap: mode === 'development' || mode === 'debug',
        },
    };
});
