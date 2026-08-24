/**
 * The Color Bomb's beam effect: a GPU-shader "lightning" flash from the
 * Color Bomb's cell to every cell of the color it targeted, plus an impact
 * ring at each target. Split out of `BoardView.ts` to keep that file focused
 * on board rendering/input; this module owns everything about how the beam
 * itself looks and animates.
 *
 * One `ColorRect` quad per bolt, stretched from the Color Bomb's cell to a
 * target and rotated to point at it, with a custom fragment shader computing
 * the sine-wave wiggle + noise + layered glow *entirely on the GPU* from
 * `v_texCoord` and a `u_time` uniform — no per-frame CPU-side re-triangulation
 * the way a `Graphics`-based polyline approach would need every frame.
 * `Graphics` can't do this itself: its tessellated vertex format is
 * position+color only (confirmed against
 * `engine/lib/shaders/webgl/VertexColorShaderGlsl.js` — no UV attribute at
 * all), so a shader keyed on `v_texCoord` needs the `Sprite`/`ColorRect` quad
 * pipeline instead. No texture is assigned to the `ColorRect` — confirmed
 * both `Sprite` and `ColorRect` still render a full quad with valid
 * `v_texCoord` even with none set (both resolve to
 * `TextureRegistry.DEFAULT_ID`/the renderer's internal white texture), so
 * this shader never needs to sample one.
 *
 * Quad placement: the node sits at the segment's *midpoint* (default anchor
 * is `0.5`, confirmed in `Transform.js`/`TransformSystem.js` — a node's
 * `x,y` places the *center* of its `[0,width]x[0,height]` local rect, not a
 * corner), with `width` = the origin-target distance and `rotation` = the
 * angle between them **in degrees** — `Node.rotation` is degrees despite
 * `Math.atan2` returning radians (confirmed in `Transform.js`'s own doc
 * comment and its `min:-360,max:360` editor schema), an easy mismatch to
 * miss since nothing type-checks the unit.
 */

import { Node, Tween, Easing, Graphics, ColorRect, BlendMode, Material, ShaderLibrary } from 'noonengine';
import { NodeContainer, BoardLayout, CellCenter } from './BoardTypes';
import { AfterTween } from './AsyncUtil';
import { Burst } from './ParticleBurst';
import { ResolveResult } from './Board';

const COLOR_BOMB_BEAM_SHADER_FRAG = /* glsl */`#version 300 es
precision mediump float;

uniform vec4  u_color;
uniform float u_time;
uniform float u_seed;
// How many tile-widths long this specific bolt is (dist / tileSize, set per
// bolt in SpawnColorBombBeam). t (below) is always 0..1 regardless of a
// bolt's actual on-screen length, so a fixed t*12.0-style frequency packs the
// exact same cycle count onto every bolt — dense/tight on a short one (the
// "two waves merging" look), stretched sparse and thin on a long one. Scaling
// frequency by this uniform keeps the wave density consistent in world-space
// instead of in fractional-t space, so every bolt reads the same regardless
// of how far its target is.
uniform float u_lengthScale;

in vec2 v_texCoord;
out vec4 fragColor;

float hash(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
    // Based on the very first version of this shader, after several rounds
    // of jaggedness/edge tuning (higher spatial frequency, segmented value
    // noise, narrower/wider smoothstep bands) never landed on something
    // better than that original look — noise/core/aura below are back to
    // those original values, with two deliberate exceptions: aura's radius
    // is 0.22, not the original 0.5 (0.5 let the quad's straight edge clip
    // the still-bright glow before it faded to zero whenever the wiggle
    // pushed the centerline off-center — a real geometric bug, not a style
    // choice), and wave/noise below use different frequencies than the
    // original single sine, to fix "looks like a curve" without touching
    // anything that caused the earlier broken-beam bug (see their own docs).
    float t = v_texCoord.x;               // 0 at the Color Bomb, 1 at the target
    float damp = sin(t * 3.14159265);      // 0 at both ends, pins the endpoints exactly
    // Subtracting t*freq (not adding) makes each wave travel outward from
    // the bomb to the target as u_time grows — a point of constant phase
    // needs t to grow with u_time, which only happens with a minus sign
    // here.
    // Two sine octaves (a "sum of sines," the standard trick for a
    // busier-looking waveform without discontinuities) instead of a single
    // low-frequency sine — one sine alone only completed about 1.4 cycles
    // across the whole beam, reading as one gentle bend/curve. A first
    // attempt at this used a *third*, much higher-frequency octave (t*41)
    // plus the noise term's original t*131.0 spatial frequency (see noise
    // below) — that packed in too many small, tightly-spaced ripples,
    // reading as dense flicker/static rather than a few clear zigzag bends
    // ("the zigzag flickering is too close"). Dropped the third octave and
    // pulled both remaining frequencies much closer together (12/20 instead
    // of 9/23) for a couple of clearly-spaced bends instead of either one
    // smooth curve or a blur of tiny ones. Still just a sum of continuous
    // sin() terms — no floor()/segmentation, so this can't reintroduce the
    // broken-beam bug no matter how the frequencies are tuned.
    // freqScale = 1.0 at a ~3-tile-long bolt (roughly the length that
    // produced the liked "merging" look), scaling up for longer bolts and
    // down for shorter ones so every bolt gets the same wave density per
    // tile of travel, not the same total cycle count regardless of length.
    float freqScale = u_lengthScale / 3.0;
    float wave = sin(u_time * 10.0 - t * 12.0 * freqScale + u_seed) * 0.14
               + sin(u_time * 16.0 - t * 20.0 * freqScale + u_seed * 1.7) * 0.06;
    // Disabled to test whether noise (not wave) was the source of the "too
    // close" flicker — wave alone is fully deterministic (driven only by
    // u_time, no hash() involved), so with this at 0.0 the beam should
    // animate as a clean, smooth-moving zigzag with no grainy shimmer at
    // all. Multiplied by 0.0 rather than deleted so it's a one-number
    // change to bring back (restore the 0.08 to re-enable).
    float noise = (hash(floor(u_time * 30.0) + t * 18.0 + u_seed) - 0.5) * 0.0;
    float centerline = 0.5 + (wave + noise) * damp;

    float dist = abs(v_texCoord.y - centerline);
    float aura = smoothstep(0.22, 0.0, dist);  // 0.22, not the original 0.5 — see the note above main()
    float core = smoothstep(0.06, 0.0, dist);

    vec3 auraColor = vec3(0.0, 0.78, 1.0);
    vec3 coreColor = vec3(0.9, 1.0, 1.0);
    vec3 color = auraColor * aura * 0.6 + coreColor * core;
    float alpha = clamp(aura * 0.55 + core, 0.0, 1.0);

    fragColor = vec4(color, alpha) * u_color;
}`;

let colorBombBeamShaderRegistered = false;
/** Registers `COLOR_BOMB_BEAM_SHADER_FRAG` with `ShaderLibrary` on first use — idempotent. */
function EnsureColorBombBeamShaderRegistered(): void {
    if (colorBombBeamShaderRegistered) return;
    ShaderLibrary.register('color-bomb-beam', { glsl: { FRAG: COLOR_BOMB_BEAM_SHADER_FRAG } });
    colorBombBeamShaderRegistered = true;
}

/** How long the beam+ring hold on screen before fading — see `BoardView`'s `COLOR_BOMB_POP_DELAY` doc for why the pop delay it drives must stay under this. */
export const LIGHTNING_HOLD_DURATION = 3.7;
const LIGHTNING_FADE_DURATION = 0.3;
/**
 * Color Bomb beam palette — aqua with transparency, fixed regardless of the
 * targeted color (unlike the striped/wrapped effects, which tint from
 * `theme.tileTypes[].effectColor`): the Color Bomb's own identity is meant to
 * read as one consistent "energy" effect, not blend into whichever color it
 * happens to be clearing this time.
 */
const COLOR_BOMB_RING_COLOR = 'rgba(0, 225, 255, 0.8)';

/**
 * A brief flash of a jittered energy bolt from the Color Bomb's cell to every
 * cell of the color it targeted, plus a small aqua ring pulsing at each
 * target on impact and a burst flashing at the origin.
 *
 * Every bolt's `ColorRect` shares a *single* `Material` for the whole
 * activation, not one each — a batch's uniforms are read from whichever
 * material sits in its slot 0, so per-bolt materials (each with its own
 * `u_seed`/`u_lengthScale`) forced one draw call per targeted cell (measured:
 * a Color Bomb clearing a color with ~30 cells on the board pushed the
 * frame's draw calls from 2 to 60). One shared material collapses every
 * bolt's quad back into a single batch/draw call, at the cost of every bolt
 * animating with the same wiggle phase and wave density instead of its own
 * randomized one — `u_lengthScale` is the *average* target distance across
 * the whole activation rather than each bolt's own, for the same reason.
 *
 * All beam quads are added to `root` *before* any impact ring, in two
 * separate loops rather than one interleaved one — the renderer routes
 * `ColorRect` (general path) and `Graphics` (tessellated) through different
 * channels and only batches a *contiguous* run of same-channel items in true
 * scene-graph draw order (no re-sorting), so alternating quad/ring/quad/ring
 * would force a channel-switch flush between every single pair regardless of
 * the shared material above. Two contiguous runs — all quads, then all rings
 * — let each batch fully.
 */
export function SpawnColorBombBeam(parent: NodeContainer, layout: BoardLayout, beam: NonNullable<ResolveResult['colorBombBeam']>): void {
    EnsureColorBombBeamShaderRegistered();
    if (beam.cells.length === 0) return;
    const { tileSize } = layout;
    const origin = CellCenter(layout, beam.originR, beam.originC);
    const root = new Node(0, 0);
    parent.addChild(root);

    const targets = beam.cells.map(cell => CellCenter(layout, cell.r, cell.c));

    let totalDist = 0;
    for (const target of targets) totalDist += Math.hypot(target.x - origin.x, target.y - origin.y);
    const sharedMat = new Material('color-bomb-beam', { u_time: 0, u_seed: Math.random() * Math.PI * 2, u_lengthScale: (totalDist / targets.length) / tileSize });
    sharedMat.blend = BlendMode.ADDITIVE;

    for (const target of targets) {
        const dx = target.x - origin.x;
        const dy = target.y - origin.y;
        const dist = Math.hypot(dx, dy);
        const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI);
        const mid = { x: (origin.x + target.x) / 2, y: (origin.y + target.y) / 2 };

        const beamNode = new Node(mid.x, mid.y);
        beamNode.width = dist;
        beamNode.height = tileSize * 0.8;
        beamNode.rotation = angleDeg;
        root.addChild(beamNode);

        const rect = beamNode.addComponent(ColorRect);
        rect.material = sharedMat;
    }

    for (const target of targets) {
        const ringNode = new Node(target.x, target.y);
        root.addChild(ringNode);
        const ring = ringNode.addComponent(Graphics);
        ring.tessellate = true;
        ring.setLineWidth(tileSize * 0.04);
        ring.drawCircle(tileSize * 0.32, null, COLOR_BOMB_RING_COLOR);
        ring.material.blend = BlendMode.ADDITIVE;
    }

    const driver = Tween.create(root).to(LIGHTNING_HOLD_DURATION, { x: root.x }, Easing.linear);
    driver.onUpdate((_target: Node, progress: number) => {
        sharedMat.uniforms.u_time = progress * LIGHTNING_HOLD_DURATION;
    });

    Burst(parent, origin, COLOR_BOMB_RING_COLOR, { count: 16, lifetime: 0.35, speedMin: 90, speedMax: 200, angleMin: 0, angleMax: Math.PI * 2 });

    AfterTween(driver)
        .then(() => AfterTween(Tween.create(root).to(LIGHTNING_FADE_DURATION, { opacity: 0 }, Easing.cubicIn)))
        .then(() => root.removeFromParent());
}
