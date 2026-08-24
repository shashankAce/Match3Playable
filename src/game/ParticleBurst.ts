import { Node, ParticleEmitter } from 'noonengine';
import { NodeContainer } from './BoardTypes';
import { Delay } from './AsyncUtil';

export interface BurstOptions {
    count: number;
    lifetime: number;
    speedMin: number;
    speedMax: number;
    angleMin: number;
    angleMax: number;
}

/** Shared one-shot `ParticleEmitter` burst — spawns, fires, and removes itself once its longest-lived particle has died. */
export function Burst(parent: NodeContainer, pos: { x: number; y: number }, color: string, opts: BurstOptions): void {
    const node = new Node(pos.x, pos.y);
    parent.addChild(node);
    const emitter = node.addComponent(ParticleEmitter);
    emitter.emitting = false;
    emitter.lifetimeMin = opts.lifetime * 0.7;
    emitter.lifetimeMax = opts.lifetime;
    emitter.speedMin = opts.speedMin;
    emitter.speedMax = opts.speedMax;
    emitter.angleMin = opts.angleMin;
    emitter.angleMax = opts.angleMax;
    emitter.scaleStart = 1;
    emitter.scaleEnd = 0.2;
    emitter.alphaStart = 1;
    emitter.alphaEnd = 0;
    emitter.colorStart = color;
    emitter.colorEnd = color;
    emitter.burst(opts.count);
    Delay(opts.lifetime + 0.05).then(() => node.removeFromParent());
}
