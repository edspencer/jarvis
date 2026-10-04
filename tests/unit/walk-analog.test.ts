// The walker's analog input (the touch thumb-stick): it moves like the keys, scaled by how far the stick is pushed;
// a key held moves at full speed. Ghost mode, so no collider is needed.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { GHOST, createPlayer, createWalker } from '../../src/core/player';
import type { Analog, Keys, ViewState } from '../../src/core/types';

function setup() {
  const player = createPlayer({ eyeHeight: 1.6, crouchEyeHeight: 0.9, radius: 0.25, maxStep: 0.3 });
  const state = { mode: 'walk', ghost: true } as ViewState;
  const keys: Keys = {};
  const analog: Analog = { x: 0, y: 0 };
  const walker = createWalker({
    player,
    state,
    keys,
    analog,
    camera: new THREE.PerspectiveCamera(),
    getCollider: () => null,
    onCrouchChange: () => {},
  });
  return { player, keys, analog, walker };
}

describe('walker: analog input', () => {
  it('stands still with the stick centred', () => {
    const { player, walker } = setup();
    walker.stepWalk(0.1);
    expect(player.pos.length()).toBe(0);
  });

  it('pushed fully forward, moves as W does (yaw 0 looks down -Z)', () => {
    const { player, analog, walker } = setup();
    analog.y = 1;
    walker.stepWalk(0.1);
    expect(player.pos.z).toBeCloseTo(-GHOST * 0.1);
    expect(player.pos.x).toBeCloseTo(0);
  });

  it('half pushed, right: strafes at half speed', () => {
    const { player, analog, walker } = setup();
    analog.x = 0.5;
    walker.stepWalk(0.1);
    expect(player.pos.x).toBeCloseTo(GHOST * 0.05);
    expect(player.pos.z).toBeCloseTo(0);
  });

  it('a key held moves at full speed, whatever the stick', () => {
    const { player, keys, analog, walker } = setup();
    keys.KeyW = true;
    analog.y = 0.2;
    walker.stepWalk(0.1);
    expect(player.pos.z).toBeCloseTo(-GHOST * 0.1);
  });
});
