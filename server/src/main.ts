// jarvis-assistant: start-up and shutdown. Reads the configuration, checks the model credential, builds the assistant
// (app.ts; an invalid policy file stops it here) and serves it. SIGHUP reloads the policy; SIGINT / SIGTERM shut down
// cleanly.
import { createAssistant, type Assistant } from './app.ts';
import { existsSync } from 'node:fs';
import {
  authWarnings,
  boxed,
  ConfigError,
  loadConfig,
  loginCredentialsFile,
  type AssistantConfig,
} from './core/config.ts';

const log = (m: string) => console.error(m);

async function main() {
  let config: AssistantConfig;
  try {
    config = loadConfig();
  } catch (e) {
    log(e instanceof ConfigError ? e.message : String(e));
    process.exit(2);
  }

  const auth = authWarnings(process.env, config.agent, existsSync(loginCredentialsFile(process.env)));
  if (auth.level === 'error') {
    log(boxed('CANNOT START THE ASSISTANT', auth.lines));
    process.exit(2);
  }
  if (auth.level === 'warn') log(boxed('WARNING: MODEL BILLING', auth.lines));
  if (auth.level === 'info') log(auth.lines.join('\n'));

  let a: Assistant;
  try {
    a = createAssistant(config, { log });
  } catch (e) {
    log(`assistant: refusing to start:\n${(e as Error).message}`);
    process.exit(2);
  }
  const addr = await a.server.listen();
  log(
    `jarvis-assistant: http://${addr.address}:${addr.port}${config.base}/ws · agent ${a.agent.name} · ` +
      `HA ${a.ha.kind} · site ${a.site.name} · policy ${a.policy.source ?? config.policyPath} ` +
      `(${a.policy.rules.length} rules) · transcribe ${config.stt ? 'on' : 'off'}`,
  );

  process.on('SIGHUP', () => {
    try {
      const p = a.reloadPolicy();
      log(`assistant: policy reloaded (${p.rules.length} rules)`);
    } catch (e) {
      log(`assistant: policy NOT reloaded, keeping the old one:\n${(e as Error).message}`);
    }
  });
  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    log(`assistant: ${sig}, shutting down`);
    await a.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

void main();
