// A fresh access code for the clients file (JARVIS_ASSISTANT_CLIENTS, docs/assistant.md "Authentication"):
//   npm run --silent new-client-secret -- <name> [screen|speaker] >> clients.yaml
// shows the code on stderr, to give to the person or device once (the panel's "Access code" field), and prints the
// clients-file entry, which holds only the code's SHA-256, on stdout (under a `clients:` line). Nothing else is kept.
import { newClientSecret } from '../src/core/auth.ts';

const [name, surface = 'screen'] = process.argv.slice(2);
if (!name || (surface !== 'screen' && surface !== 'speaker')) {
  console.error('usage: npm run --silent new-client-secret -- <name> [screen|speaker] >> clients.yaml');
  process.exit(2);
}
try {
  const { code, entry } = newClientSecret(name, surface);
  console.error(`Access code for ${name} (give it once; only its hash is kept):\n\n  ${code}\n`);
  console.log(`  - { name: ${entry.name}, secret_sha256: ${entry.secretSha256}, surface: ${entry.surface} }`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
