// server/policy.example.yaml as a plain object (core has no YAML parser): the policy most tests run against.
// policy.test.ts checks the two stay the same when the server's `yaml` package is installed.
export const EXAMPLE_POLICY = {
  version: 1,
  default: 'deny',
  bulk: { confirm_over: 8 },
  rules: [
    { deny: { domain: 'lock', service: 'unlock' }, reason: 'Unlocking is never done by the assistant' },
    {
      deny: { domain: 'cover', device_class: 'garage', service: 'open_cover' },
      reason: "The assistant doesn't open the garage door",
    },
    { deny: { entity: ['switch.*network*', 'switch.*camera*'] }, reason: 'That switch powers the network or a camera' },
    { deny: { domain: ['homeassistant', 'automation', 'update', 'button'], service: '*' } },
    {
      confirm: { domain: 'cover', device_class: 'garage', service: 'close_cover', surface: 'screen' },
      reason: 'Closing the garage door; make sure nothing is in the way',
      risk: 'high',
    },
    { deny: { domain: 'cover', device_class: 'garage' }, reason: 'The garage door can only be closed from a screen' },
    { confirm: { domain: 'lock', service: 'lock' } },
    {
      confirm: { domain: 'climate', service: ['set_temperature', 'set_hvac_mode'] },
      bounds: { temperature: [60, 85] },
      data: ['hvac_mode'],
    },
    {
      confirm: { entity: 'script.goodnight', service: 'turn_on' },
      reason: 'Good night turns off every light in the house',
    },
    { confirm: { domain: 'valve', service: ['open_valve', 'close_valve'] }, max_minutes: 30 },
    {
      allow: { domain: 'light', service: ['turn_on', 'turn_off', 'toggle'] },
      bounds: { brightness_pct: [1, 100], color_temp_kelvin: [2000, 6500] },
    },
    { allow: { entity: 'switch.bathroom_vanity', service: ['turn_on', 'turn_off', 'toggle'] } },
    { allow: { entity: 'scene.evening', service: 'turn_on' } },
    { allow: { entity: 'script.film_night', service: 'turn_on' } },
    { allow: { domain: 'fan', service: ['turn_on', 'turn_off', 'set_percentage'] }, bounds: { percentage: [0, 100] } },
    { allow: { entity: 'switch.pond_pump', service: ['turn_on', 'turn_off'] }, max_minutes: 60 },
    {
      confirm: { domain: 'script', service: 'turn_on' },
      reason: "Scripts can do anything; this one isn't on the harmless list",
    },
    {
      confirm: { domain: 'scene', service: 'turn_on' },
      reason: "A scene can set anything (locks, covers, the alarm); this one isn't on the harmless list",
    },
  ],
};
