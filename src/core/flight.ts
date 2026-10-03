// Fly the camera to look at a target (world space) over FLY_S seconds, keeping the mode. Overview: the orbit centre
// moves to it, keeping the viewing direction. Walking: ghost mode, standing ~2 m off it towards `centre` (its room's
// centroid, 4 ft over the floor; null outside, where it stands off away from the building) at no more than eye height
// over that room's floor, so a ceiling light is looked up at rather than from inside the ceiling.
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { FlyFn, Player, ViewState } from './types';
import { FT } from './units';

const FLY_S = 0.8;

type FlightState =
  | { t: number; mode?: undefined }
  | { t: number; mode: 'orbit'; p0: THREE.Vector3; p1: THREE.Vector3; q0: THREE.Vector3; q1: THREE.Vector3 }
  | {
      t: number;
      mode: 'walk';
      p0: THREE.Vector3;
      p1: THREE.Vector3;
      yaw0: number;
      yaw1: number;
      pitch0: number;
      pitch1: number;
    };

export interface Flight {
  fly: FlyFn;
  /** advance a flight in progress; true while flying (the frame skips its own movement) */
  stepFlight(dt: number): boolean;
}

export function createFlight({
  state,
  player,
  camera,
  centre: buildingCentre,
  getOrbit,
  onChange,
}: {
  state: ViewState;
  player: Player;
  camera: THREE.Camera;
  /** the building's centre, world space */
  centre: THREE.Vector3;
  getOrbit: () => OrbitControls | null;
  onChange: () => void;
}): Flight {
  let flight: FlightState = { t: 1 };
  const EYE = player.body.eyeHeight;

  function fly(target: THREE.Vector3, centre?: THREE.Vector3 | null): void {
    const orbit = getOrbit();
    if (state.mode === 'orbit' && orbit) {
      const dir = camera.position.clone().sub(orbit.target);
      const dist = THREE.MathUtils.clamp(dir.length(), 5, 10);
      dir.normalize();
      if (dir.y < 0.4) {
        dir.y = 0.4;
        dir.normalize();
      }
      flight = {
        t: 0,
        mode: 'orbit',
        p0: camera.position.clone(),
        p1: target.clone().addScaledVector(dir, dist),
        q0: orbit.target.clone(),
        q1: target.clone(),
      };
      return;
    }
    let d: THREE.Vector3,
      off = 2.2;
    if (centre) {
      d = centre.clone().sub(target).setY(0);
      if (d.length() >= 0.6) off = THREE.MathUtils.clamp(d.length(), 1.0, 2.2);
      else d = camera.position.clone().sub(target).setY(0); // the target is the centroid: come from where we are
    } else d = target.clone().sub(buildingCentre).setY(0); // outside: stand off away from the building
    if (d.lengthSq() < 1e-6) d.set(0, 0, 1);
    const eye = target.clone().addScaledVector(d.normalize(), off);
    eye.y = target.y + 0.35;
    if (centre) eye.y = Math.min(eye.y, centre.y - 4 * FT + EYE);
    const look = target.clone().sub(eye);
    const yaw1 = Math.atan2(-look.x, -look.z),
      pitch1 = Math.atan2(look.y, Math.hypot(look.x, look.z));
    let yaw0 = player.yaw;
    yaw0 += Math.round((yaw1 - yaw0) / (2 * Math.PI)) * 2 * Math.PI; // turn the short way round
    state.ghost = true;
    player.vy = 0;
    player.crouched = false;
    flight = {
      t: 0,
      mode: 'walk',
      p0: player.pos.clone(),
      p1: eye.clone().setY(eye.y - EYE),
      yaw0,
      yaw1,
      pitch0: player.pitch,
      pitch1,
    };
    onChange();
  }

  function stepFlight(dt: number): boolean {
    if (flight.t >= 1 || flight.mode !== state.mode) {
      flight.t = 1;
      return false;
    }
    flight.t = Math.min(1, flight.t + dt / FLY_S);
    const k = flight.t * flight.t * (3 - 2 * flight.t);
    if (flight.mode === 'orbit') {
      const orbit = getOrbit()!;
      camera.position.lerpVectors(flight.p0, flight.p1, k);
      orbit.target.lerpVectors(flight.q0, flight.q1, k);
      camera.lookAt(orbit.target);
      if (flight.t >= 1) orbit.update();
    } else if (flight.mode === 'walk') {
      player.pos.lerpVectors(flight.p0, flight.p1, k);
      player.eye = EYE;
      player.eyeY = player.pos.y + EYE;
      player.yaw = flight.yaw0 + (flight.yaw1 - flight.yaw0) * k;
      player.pitch = flight.pitch0 + (flight.pitch1 - flight.pitch0) * k;
    }
    return true;
  }

  return { fly, stepFlight };
}
