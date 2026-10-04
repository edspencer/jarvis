// The core's material overrides (src/core/material-stack.ts): any order of push / dispose shows what the remaining
// layers say and the mesh's own material when none is left; a function layer works from the one beneath; a plugin's
// scoped overrides go when it stops. The blueprint fade and energy mode are the two plugins that met here.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createMaterialStack } from '../../src/core/material-stack';

function setup() {
  const own = new THREE.MeshStandardMaterial({ name: 'oak', opacity: 1 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), own);
  const stack = createMaterialStack();
  const ghost = new THREE.MeshBasicMaterial({ name: 'ghost' });
  const faded = new Map<THREE.Material, THREE.Material>();
  /** the blueprint fade: a faded copy of whatever is beneath */
  const fade = (below: THREE.Material) => {
    if (!faded.has(below))
      faded.set(below, Object.assign(below.clone(), { name: `faded ${below.name}`, opacity: 0.2 }));
    return faded.get(below)!;
  };
  return { own, mesh, stack, ghost, fade };
}
const name = (m: THREE.Mesh) => (m.material as THREE.Material).name;

describe('material overrides', () => {
  it("A on, B on, A off, B off: back to the mesh's own", () => {
    const { own, mesh, stack, ghost, fade } = setup();
    const a = stack.push(mesh, fade, { priority: -5 });
    expect(name(mesh)).toBe('faded oak');
    const b = stack.push(mesh, ghost);
    expect(mesh.material).toBe(ghost);
    a.dispose();
    expect(mesh.material).toBe(ghost); // the fade going doesn't take the ghost with it
    b.dispose();
    expect(mesh.material).toBe(own);
    expect(mesh.userData.baseMaterial).toBeUndefined();
    expect(stack.size()).toBe(0);
  });

  it('A on, B on, B off first, then A off', () => {
    const { own, mesh, stack, ghost, fade } = setup();
    const a = stack.push(mesh, fade, { priority: -5 });
    const b = stack.push(mesh, ghost);
    b.dispose();
    expect(name(mesh)).toBe('faded oak'); // the fade is still on
    a.dispose();
    expect(mesh.material).toBe(own);
  });

  it('B on, then A on beneath it, A off, B off', () => {
    const { own, mesh, stack, ghost, fade } = setup();
    const b = stack.push(mesh, ghost);
    const a = stack.push(mesh, fade, { priority: -5 });
    expect(mesh.material).toBe(ghost); // priority, not order, decides
    a.dispose();
    expect(mesh.material).toBe(ghost);
    b.dispose();
    expect(mesh.material).toBe(own);
  });

  it('equal priorities: the later push is on top', () => {
    const { mesh, stack, ghost, fade } = setup();
    stack.push(mesh, ghost);
    stack.push(mesh, fade);
    expect(name(mesh)).toBe('faded ghost');
  });

  it('a function layer works from the layer beneath, and refresh / set run it again', () => {
    const { mesh, stack, fade } = setup();
    const glow = new THREE.MeshStandardMaterial({ name: 'glow' });
    const g = stack.push(mesh, glow, { priority: -10 });
    stack.push(mesh, (below) => fade(below), { priority: -5 });
    expect(name(mesh)).toBe('faded glow');
    let calls = 0;
    const counted = stack.push(mesh, (below) => (calls++, below), { priority: 5 });
    g.refresh();
    expect(calls).toBe(2);
    const other = new THREE.MeshStandardMaterial({ name: 'other' });
    g.set(other);
    expect(name(mesh)).toBe('faded other');
    counted.dispose();
    g.dispose();
    expect(name(mesh)).toBe('faded oak');
  });

  it("keeps the mesh's own in base() and userData.baseMaterial while covered; disposing twice is harmless", () => {
    const { own, mesh, stack, ghost } = setup();
    expect(stack.base(mesh)).toBe(own);
    const o = stack.push([mesh, mesh], ghost);
    expect(stack.base(mesh)).toBe(own);
    expect(mesh.userData.baseMaterial).toBe(own);
    o.dispose();
    o.dispose();
    o.set(new THREE.MeshBasicMaterial()); // a disposed override does nothing
    expect(mesh.material).toBe(own);
  });

  it("a plugin's scoped overrides are disposed when it stops; another plugin's stay", () => {
    const { own, mesh, stack, ghost, fade } = setup();
    const owned: { dispose(): void }[] = [];
    const energy = stack.scoped((d) => owned.push(d));
    const blueprints = stack.scoped(() => {});
    blueprints.push(mesh, fade, { priority: -5 });
    energy.push(mesh, ghost);
    energy.push(mesh, ghost).dispose(); // one taken off by hand: not disposed again
    expect(mesh.material).toBe(ghost);
    owned.forEach((d) => d.dispose()); // energy stops
    expect(name(mesh)).toBe('faded oak');
    expect(stack.base(mesh)).toBe(own);
  });

  it('skips what is not a mesh with one material, warning once per plugin; takes a single Object3D', () => {
    const { own, mesh, stack, ghost } = setup();
    const said: string[] = [];
    const plugin = stack.scoped(
      () => {},
      (m) => said.push(m),
    );
    const group = new THREE.Group();
    const multi = new THREE.Mesh(new THREE.BoxGeometry(), [own, own]);
    const o = plugin.push([group, multi, mesh], ghost);
    plugin.push(group, ghost);
    expect(said).toHaveLength(1);
    expect((group as unknown as { material?: unknown }).material).toBeUndefined();
    expect(multi.material).toEqual([own, own]);
    expect(mesh.material).toBe(ghost);
    o.dispose();
    expect(mesh.material).toBe(own);
    expect(stack.size()).toBe(0);
  });
});
