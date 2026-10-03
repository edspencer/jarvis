// The optional layers, each imported on demand once the model is in, so a missing data file or a broken layer leaves
// the walkthrough exactly as it was. Each starts only if the site manifest has a section for it (plugins.<id>), and
// gets that section as its config. (A proper plugin API comes later; for now these are the four built-in layers.)
import type { Site } from '../site';
import type { Escape, DomLookup, FlyFn, PluginSlots, SeenFn, ViewState } from './types';
import type { Inspect } from './inspect';
import type { Model } from './model';
import type { Stage } from './stage';
import { query } from './dom';

export interface PluginHost {
  site: Site;
  stage: Stage;
  state: ViewState;
  model: Model;
  plugins: PluginSlots;
  /** the console hook (window.twin): each layer adds itself */
  twin: Record<string, unknown>;
  $: DomLookup;
  esc: Escape;
  seen: SeenFn;
  fly: FlyFn;
  flags: () => void;
  hereRoom: () => string | null;
  inspect: Inspect;
}

export function startPlugins(host: PluginHost): void {
  if (host.site.plugins['home-assistant']) startHA(host);
  else host.$('harow')?.classList.add('hidden');
  startPins(host); // ?pins shows them, ?pinswall through walls, ?pin=<id> flies there
  startSwitches(host); // ?plates highlights them, ?plateswall through walls, ?plate=<box id>
}

// ------------------------------------------------------------------ Home Assistant (live light state)
async function startHA(host: PluginHost): Promise<void> {
  const { site, stage, model, plugins, $, inspect } = host;
  let infoT = 0;
  try {
    const { createHA } = await import('../plugins/home-assistant/ha');
    const ha = createHA({
      config: site.plugins['home-assistant']!,
      scene: stage.scene,
      camera: stage.camera,
      fixtures: model.fixtures,
      $,
      onChange: () => {
        host.flags();
        infoT = 0.3;
      },
      room: host.hereRoom,
      seen: host.seen,
    });
    plugins.ha = ha;
    host.twin.ha = ha;
    // refresh an open inspect panel on a fixture shortly after its state changes (throttled: the stream can be busy)
    setInterval(() => {
      if (infoT > 0 && inspect.info.shown?.node.userData.fixture_id) inspect.showInfo(inspect.info.shown);
      infoT = 0;
    }, 300);
    await ha.start();
    if (site.plugins.faults) await startFaults(host);
  } catch (err) {
    console.warn(`Home Assistant off (${(err as Error).message}); the walkthrough works without it`);
    $('harow')?.classList.add('hidden');
  }
}

// ------------------------------------------------------------------ device faults through walls
// Every Home Assistant device's health, drawn over everything with V. Needs the HA layer (the state stream).
async function startFaults(host: PluginHost): Promise<void> {
  const { site, stage, state, model, plugins, $, esc, inspect } = host;
  try {
    const { createFaults } = await import('../plugins/faults/faults');
    const faults = createFaults({
      config: site.plugins.faults!,
      site,
      scene: stage.scene,
      camera: stage.camera,
      renderer: stage.renderer,
      fixtures: model.fixtures,
      $,
      esc,
      state,
      fly: host.fly,
      getHA: () => plugins.ha,
      getPins: () => plugins.pins,
      getSwitches: () => plugins.switches,
      onShow: () => {
        inspect.info.shown = null;
      },
      onChange: host.flags,
    });
    plugins.faults = faults;
    await faults.load();
    const ha = plugins.ha!;
    ha.listeners.push(faults.onEntities);
    ha.covers = faults.covers;
    host.twin.faults = faults;
    if (ha.mode === 'mock') faults.mock();
    faults.recompute(faults.devices);
    host.flags();
  } catch (err) {
    plugins.faults = null;
    console.warn(`device faults off (${(err as Error).message}); the lights' own fault markers still work`);
  }
}

// ------------------------------------------------------------------ equipment pins
async function startPins(host: PluginHost): Promise<void> {
  const { site, stage, state, model, plugins, $, esc, inspect } = host;
  if (!site.plugins.pins) return;
  try {
    const { createPins } = await import('../plugins/pins/pins');
    const pins = createPins({
      config: site.plugins.pins,
      site,
      scene: stage.scene,
      camera: stage.camera,
      renderer: stage.renderer,
      fixtures: model.fixtures,
      $,
      esc,
      state,
      seen: host.seen,
      fly: host.fly,
      onShow: () => {
        inspect.info.shown = null;
      },
    });
    plugins.pins = pins;
    host.twin.pins = pins;
    await pins.load();
    host.flags();
  } catch (err) {
    plugins.pins = null;
    console.warn(`equipment pins off (${(err as Error).message}); the walkthrough works without them`);
  }
}

// ------------------------------------------------------------------ wall plates
async function startSwitches(host: PluginHost): Promise<void> {
  const { site, stage, model, plugins, $, esc, inspect } = host;
  if (!model.switchRoot) return;
  try {
    const { createSwitches } = await import('../plugins/switches/switches');
    const switches = createSwitches({
      config: site.plugins.switches || {},
      site,
      root: model.root,
      scene: stage.scene,
      camera: stage.camera,
      fixtures: model.fixtures,
      $,
      esc,
      fly: host.fly,
      getPins: () => plugins.pins,
      getHA: () => plugins.ha,
      showPanel: (p) => {
        if (!p) inspect.info.shown = null;
      },
    });
    switches.adopt(model.switchRoot);
    switches.buildUI();
    plugins.switches = switches;
    host.twin.switches = switches;
    const q = query();
    if (q.get('plate')) switches.go(q.get('plate')!);
    host.flags();
  } catch (err) {
    plugins.switches = null;
    console.warn(`wall plates: instancing off (${(err as Error).message}); they are drawn as plain meshes`);
  }
}
