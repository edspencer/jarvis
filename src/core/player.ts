// The walker: collision against the model's BVH, steps, gravity, crouching, and ghost flight.
import * as THREE from 'three';
import type { Site } from '../site';
import { P } from './units';
import type { Keys, Player, ViewState } from './types';

// The body (metres) comes from the site manifest's `walk`, with general defaults: eye height, crouched eye height,
// radius, and the highest step taken without a jump (a model with steps but no treads needs it higher).
export const HEAD = 0.15; // m of head above the eye: headroom needed to stand back up
export const WALK = 2.0,
  RUN = 5.0,
  CROUCH = 0.9,
  TURN = 1.8,
  GRAVITY = 14,
  JUMP = 4.2,
  GHOST = 6;

export function createPlayer(body: Site['walk']): Player {
  return {
    body,
    pos: new THREE.Vector3(),
    vy: 0,
    yaw: 0,
    pitch: 0,
    onGround: false,
    eyeY: 0,
    floor: null,
    eye: body.eyeHeight,
    crouched: false,
  };
}

export interface Walker {
  castDown(x: number, y: number, z: number): THREE.Intersection | null;
  headroom(pos: THREE.Vector3): boolean;
  teleport(X: number, Y: number, Z: number, yawDeg?: number): void;
  stepWalk(dt: number): void;
  /** a ray from the camera to world point p, against the collider: is p in view? */
  seen(p: THREE.Vector3): boolean;
  /** shared raycaster (first hit only) for the core's own downward probes */
  ray: THREE.Raycaster;
}

export function createWalker({
  player,
  state,
  keys,
  camera,
  getCollider,
  onCrouchChange,
}: {
  player: Player;
  state: ViewState;
  keys: Keys;
  camera: THREE.Camera;
  getCollider: () => THREE.Mesh | null;
  onCrouchChange: () => void;
}): Walker {
  const { eyeHeight: EYE, crouchEyeHeight: EYE_CROUCH, radius: RADIUS, maxStep: MAX_STEP } = player.body;
  const ray = new THREE.Raycaster();
  ray.firstHitOnly = true;
  const DOWN = new THREE.Vector3(0, -1, 0);
  const UP = new THREE.Vector3(0, 1, 0);
  const tmp = new THREE.Vector3(),
    tmpN = new THREE.Vector3();

  function castDown(x: number, y: number, z: number): THREE.Intersection | null {
    const collider = getCollider();
    if (!collider) return null;
    ray.set(tmp.set(x, y, z), DOWN);
    ray.far = 200;
    const h = ray.intersectObject(collider, false)[0];
    return h || null;
  }

  function castH(origin: THREE.Vector3, dir: THREE.Vector3, far: number): { dist: number; n: THREE.Vector3 } | null {
    ray.set(origin, dir);
    ray.far = far;
    const h = ray.intersectObject(getCollider()!, false)[0];
    if (!h || !h.face) return null;
    tmpN.copy(h.face.normal).setY(0);
    if (tmpN.lengthSq() < 0.04) return null; // near-horizontal surface (a tread or a floor edge)
    tmpN.normalize();
    if (tmpN.dot(dir) > 0) tmpN.negate();
    return { dist: h.distance, n: tmpN.clone() };
  }

  // collision probe heights: knee, waist and head (the head probe drops with a crouch, so you can duck under things)
  const bodyProbes = () => [MAX_STEP + 0.05, Math.min(1.1, player.eye - 0.1), player.eye + 0.08];
  const SIDE = [0, 0.6, -0.6];

  function slide(pos: THREE.Vector3, move: THREE.Vector3): void {
    const m = move.clone();
    for (let it = 0; it < 4; it++) {
      const len = m.length();
      if (len < 1e-6) return;
      const dir = m.clone().divideScalar(len);
      let best: { dist: number; n: THREE.Vector3 } | null = null;
      for (const h of bodyProbes()) {
        for (const a of SIDE) {
          const d = dir.clone().applyAxisAngle(THREE.Object3D.DEFAULT_UP, a);
          const hit = castH(new THREE.Vector3(pos.x, pos.y + h, pos.z), d, len + RADIUS);
          if (hit && m.dot(hit.n) < -1e-6 && (!best || hit.dist < best.dist)) best = hit;
        }
      }
      if (!best) {
        pos.add(m);
        return;
      }
      m.addScaledVector(best.n, -m.dot(best.n)); // drop the part of the move that goes into the wall
    }
  }

  function pushOut(pos: THREE.Vector3): void {
    for (const h of bodyProbes()) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const d = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
        const hit = castH(new THREE.Vector3(pos.x, pos.y + h, pos.z), d, RADIUS);
        if (hit) pos.addScaledVector(hit.n, RADIUS - hit.dist);
      }
    }
  }

  // Room to stand up at `pos`: nothing solid between the crouched head and the standing head, straight up and
  // round the body (a ray up alone misses a stair soffit you're half under).
  function headroom(pos: THREE.Vector3): boolean {
    const collider = getCollider();
    if (!collider) return true;
    const from = pos.y + EYE_CROUCH;
    ray.set(tmp.set(pos.x, from, pos.z), UP);
    ray.far = EYE + HEAD - EYE_CROUCH;
    if (ray.intersectObject(collider, false)[0]) return false;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      ray.set(tmp.set(pos.x + Math.sin(a) * RADIUS * 0.8, from, pos.z + Math.cos(a) * RADIUS * 0.8), UP);
      ray.far = EYE + HEAD - EYE_CROUCH;
      if (ray.intersectObject(collider, false)[0]) return false;
    }
    return true;
  }

  function teleport(X: number, Y: number, Z: number, yawDeg?: number): void {
    player.pos.copy(P(X, Y, Z + 1.5));
    const g = castDown(player.pos.x, player.pos.y, player.pos.z);
    if (g) player.pos.y = g.point.y;
    player.vy = 0;
    player.onGround = true;
    player.eye = EYE;
    player.crouched = false;
    player.eyeY = player.pos.y + EYE;
    if (yawDeg !== undefined) player.yaw = THREE.MathUtils.degToRad(yawDeg);
    player.pitch = 0;
  }

  function stepWalk(dt: number): void {
    const fwd = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
    const strafe = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
    player.yaw += ((keys.KeyQ ? 1 : 0) - (keys.KeyE ? 1 : 0)) * TURN * dt;
    const sy = Math.sin(player.yaw),
      cy = Math.cos(player.yaw);
    const move = new THREE.Vector3(-sy * fwd + cy * strafe, 0, -cy * fwd - sy * strafe);
    const running = keys.ShiftLeft || keys.ShiftRight;
    // crouch (walk mode): hold C to drop the eye to ~3 ft and move slowly; let go to stand, once there's headroom
    if (!state.ghost) {
      const wasCrouched = player.crouched;
      player.crouched = !!keys.KeyC || (player.crouched && !headroom(player.pos));
      if (player.crouched !== wasCrouched) onCrouchChange();
    }
    const speed = state.ghost ? GHOST * (running ? 2 : 1) : player.crouched ? CROUCH : running ? RUN : WALK;
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed * dt);

    if (state.ghost) {
      // fly where you look, no collision; Space rises, C (held) sinks
      player.pos.add(move);
      if (fwd) player.pos.y += Math.sin(player.pitch) * fwd * GHOST * dt;
      player.pos.y += ((keys.Space ? 1 : 0) - (keys.KeyC ? 1 : 0)) * GHOST * (running ? 2 : 1) * dt;
      player.eye = EYE;
      player.eyeY = player.pos.y + EYE;
      return;
    }
    // sub-step so a run can't tunnel through a thin partition
    const n = Math.max(1, Math.ceil(move.length() / 0.12));
    move.divideScalar(n);
    for (let i = 0; i < n; i++) {
      slide(player.pos, move);
      pushOut(player.pos);
    }
    const g = castDown(player.pos.x, player.pos.y + MAX_STEP, player.pos.z);
    const ground = g ? g.point.y : -0.3;
    if (player.onGround && player.vy <= 0 && ground >= player.pos.y - MAX_STEP) {
      player.pos.y = ground; // follow steps up and down
    } else {
      player.vy -= GRAVITY * dt;
      player.pos.y += player.vy * dt;
      if (player.pos.y <= ground) {
        player.pos.y = ground;
        player.vy = 0;
        player.onGround = true;
      } else player.onGround = false;
    }
    // ease the crouch, and the eye over step-ups so the stair doesn't judder
    const eyeTo = player.crouched ? EYE_CROUCH : EYE;
    player.eye += (eyeTo - player.eye) * Math.min(1, dt * 10);
    const target = player.pos.y + player.eye;
    player.eyeY =
      target < player.eyeY - 0.3 || target > player.eyeY + 1
        ? target
        : player.eyeY + (target - player.eyeY) * Math.min(1, dt * 14);
  }

  // can the camera see point p (world space)? A ray against the collider, stopping just short of p (a fixture sits in
  // the ceiling). For the light pool and pin picking: a light behind a wall would shine through it, as the pool's
  // lights cast no shadows. Ghost mode inside a wall gives false negatives; harmless.
  const seeRay = new THREE.Raycaster();
  seeRay.firstHitOnly = true;
  function seen(p: THREE.Vector3): boolean {
    const collider = getCollider();
    if (!collider) return true;
    const from = camera.getWorldPosition(new THREE.Vector3()),
      d = p.clone().sub(from),
      len = d.length();
    if (len < 0.5) return true;
    seeRay.set(from, d.divideScalar(len));
    seeRay.far = len - 0.35;
    return !seeRay.intersectObject(collider, false)[0];
  }

  return { castDown, headroom, teleport, stepWalk, seen, ray };
}
