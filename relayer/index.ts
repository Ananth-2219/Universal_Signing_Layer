import { config } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelayer } from './src/server.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const envPath = [resolve(projectRoot, '.env.local'), resolve(projectRoot, '.env')]
  .find(existsSync);
if (!envPath) {
  throw new Error('Root .env or .env.local is missing. Add RELAYER_PRIVATE_KEY, ANVIL_RPC, and ANVIL_RPC_B.');
}
if (config({ path: envPath }).error) {
  throw new Error('Root relayer environment file could not be read. Check that it is valid and readable.');
}

const key = process.env.RELAYER_PRIVATE_KEY?.trim();
const a = process.env.ANVIL_RPC?.trim(); const b = process.env.ANVIL_RPC_B?.trim();
const missing = [
  !key && 'RELAYER_PRIVATE_KEY', !a && 'ANVIL_RPC', !b && 'ANVIL_RPC_B',
].filter(Boolean).join(', ');
if (!key || !a || !b) throw new Error(`Root relayer environment is missing: ${missing}`);
if (!/^0x[\da-fA-F]{64}$/.test(key)) {
  throw new Error('RELAYER_PRIVATE_KEY must be a 32-byte, 0x-prefixed hexadecimal value.');
}
for (const [name, value] of [['ANVIL_RPC', a], ['ANVIL_RPC_B', b]] as const) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
  } catch {
    throw new Error(`${name} must be an HTTP(S) URL.`);
  }
}
function deployed(chainId: number) {
  const record = JSON.parse(readFileSync(new URL(`../deployments/${chainId}.json`, import.meta.url), 'utf8')) as { mandateAccount: `0x${string}` };
  return [record.mandateAccount];
}
const app = createRelayer({ privateKey: key as `0x${string}`, chains: [
  { chainId: 31337, rpcUrl: a, accounts: deployed(31337), gasPriceCap: 100_000_000_000n },
  { chainId: 31338, rpcUrl: b, accounts: deployed(31338), gasPriceCap: 100_000_000_000n },
] });
app.server.listen(Number(process.env.RELAYER_PORT ?? 8787));
