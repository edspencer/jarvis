// The assistant assembled from its configuration: policy, Home Assistant backend (the mock unless JARVIS_HA_MODE=live),
// gate, site knowledge, tools, agent, hub and HTTP server. main.ts runs it; the integration tests build it in-process.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createAudit } from './core/audit.ts';
import { boxed, type AssistantConfig } from './core/config.ts';
import { createGate, type Gate } from './core/gate.ts';
import { createMockHa } from './core/ha-mock.ts';
import { createHub, type Hub } from './core/hub.ts';
import { buildSystemPrompt, formatTurn, loadSite, type SiteKnowledge } from './core/knowledge.ts';
import { EMPTY_POLICY, parsePolicy, type Policy } from './core/policy.ts';
import { createTools } from './core/tools.ts';
import type { Agent, HaBackend } from './core/types.ts';
import { createSdkAgent } from './agent-sdk.ts';
import { createScriptedAgent } from './agent-scripted.ts';
import { createLiveHa } from './ha-live.ts';
import { authenticate, createAssistantServer } from './server.ts';

/** The policy file, or EMPTY_POLICY (everything refused, with a loud warning) when the default file is missing.
 * Throws on an invalid file: better no assistant than one with the wrong rules. */
export function loadPolicy(
  config: Pick<AssistantConfig, 'policyPath' | 'policyExplicit'>,
  log: (m: string) => void = console.error,
): Policy {
  if (!existsSync(config.policyPath)) {
    if (config.policyExplicit) throw new Error(`no policy file at ${config.policyPath}`);
    log(
      boxed('NO ASSISTANT POLICY', [
        `${config.policyPath} does not exist, so EVERY Home Assistant action is refused.`,
        'Copy server/policy.example.yaml there (or set JARVIS_ASSISTANT_POLICY) and edit it.',
      ]),
    );
    return EMPTY_POLICY;
  }
  return parsePolicy(parseYaml(readFileSync(config.policyPath, 'utf8')), config.policyPath);
}

export interface Assistant {
  config: AssistantConfig;
  site: SiteKnowledge;
  ha: HaBackend;
  gate: Gate;
  agent: Agent;
  hub: Hub;
  server: ReturnType<typeof createAssistantServer>;
  policy: Policy;
  /** re-read the policy file; keeps the old one (and throws) if the new one is invalid */
  reloadPolicy(): Policy;
  close(): Promise<void>;
}

export interface AssistantOverrides {
  ha?: HaBackend;
  agent?: Agent;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
}

export function createAssistant(config: AssistantConfig, o: AssistantOverrides = {}): Assistant {
  const log = o.log ?? ((m: string) => console.error(m));
  const policy = loadPolicy(config, log);
  const site = loadSite(config.siteDir);
  for (const w of site.warnings) log(`site: ${w}`);

  let ha: HaBackend;
  if (o.ha) ha = o.ha;
  else if (config.ha.mode === 'live') {
    const live = createLiveHa({ url: config.ha.url!, token: config.ha.token!, log });
    live.ready().catch((e) => log(`home assistant: ${(e as Error).message}`));
    ha = live;
  } else ha = createMockHa();

  const audit = createAudit(join(config.dataDir, 'audit.jsonl'));
  let hub: Hub | null = null;
  const gate = createGate({
    policy,
    backend: ha,
    onPending: (p) => hub?.onPending(p),
    onResolved: (id, outcome, detail) => hub?.onResolved(id, outcome, detail),
    audit: (r) =>
      audit.write({
        kind: 'gate',
        client: r.clientId,
        surface: r.surface,
        utterance: r.utterance,
        tool: 'ha_act',
        args: r.request,
        tier: r.tier,
        decision: r.outcome,
        detail: r.reason,
        call: r.detail,
        ...(r.pendingId ? { pendingId: r.pendingId } : {}),
        ...(r.timer ? { timer: true } : {}),
      }),
  });

  const tools = createTools({ gate, ha, site, dataDir: config.dataDir });
  const agent: Agent =
    o.agent ??
    (config.agent === 'scripted'
      ? createScriptedAgent()
      : createSdkAgent({
          tools,
          systemPrompt: buildSystemPrompt(site, { knowledge: !!config.knowledgeDir }),
          model: config.model,
          effort: config.effort,
          dataDir: config.dataDir,
          knowledgeDir: config.knowledgeDir,
          log,
        }));

  hub = createHub({
    agent,
    tools,
    gate,
    info: { agent: agent.name, ha: ha.kind, transcribe: !!config.stt },
    formatTurn: (turn) => formatTurn(turn, site),
    authenticate,
    audit,
    log,
  });
  const theHub = hub;

  const server = createAssistantServer({
    host: config.host,
    port: config.port,
    base: config.base,
    origins: config.origins,
    stt: config.stt,
    hub,
    health: () => ({ agent: agent.name, ha: ha.kind, transcribe: !!config.stt }),
    fetchImpl: o.fetchImpl,
    log,
  });

  const a: Assistant = {
    config,
    site,
    ha,
    gate,
    agent,
    hub,
    server,
    policy,
    reloadPolicy() {
      const p = loadPolicy(config, log);
      gate.setPolicy(p);
      a.policy = p;
      return p;
    },
    async close() {
      await theHub.close();
      await agent.close();
      await server.close();
      ha.close?.();
    },
  };
  return a;
}
