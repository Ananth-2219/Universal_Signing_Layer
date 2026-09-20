import { config } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelayer } from './src/server.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
// The documented relayer configuration is root .env. Older local-demo files
// must not silently replace its testnet RPCs and gas payer.
const envPath = [resolve(projectRoot, '.env'), resolve(projectRoot, '.env.local')]
  .find(existsSync);
if (!envPath) {
  throw new Error('Root .env or .env.local is missing. Add RELAYER_PRIVATE_KEY, ANVIL_RPC, and ANVIL_RPC_B.');
}
if (config({ path: envPath }).error) {
  throw new Error('Root relayer environment file could not be read. Check that it is valid and readable.');
}

const key = process.env.RELAYER_PRIVATE_KEY?.trim();
const local = [
  { chainId: 31337, variable: 'ANVIL_RPC', rpcUrl: process.env.ANVIL_RPC?.trim() },
  { chainId: 31338, variable: 'ANVIL_RPC_B', rpcUrl: process.env.ANVIL_RPC_B?.trim() },
];
const testnets = [
  { chainId: 11155111, variable: 'SEPOLIA_RPC_URL', rpcUrl: process.env.SEPOLIA_RPC_URL?.trim() },
  { chainId: 84532, variable: 'BASE_SEPOLIA_RPC_URL', rpcUrl: process.env.BASE_SEPOLIA_RPC_URL?.trim() },
  { chainId: 421614, variable: 'ARBITRUM_SEPOLIA_RPC_URL', rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL?.trim() },
];
const requestedMode = process.env.RELAYER_NETWORK_MODE?.trim();
if (requestedMode && requestedMode !== 'local' && requestedMode !== 'testnet') {
  throw new Error('RELAYER_NETWORK_MODE must be local or testnet.');
}
const selected = requestedMode === 'local'
  ? local
  : requestedMode === 'testnet' || testnets.every(chain => chain.rpcUrl)
    ? testnets
    : local;
const missing = [!key && 'RELAYER_PRIVATE_KEY', ...selected.filter(chain => !chain.rpcUrl).map(chain => chain.variable)]
  .filter(Boolean).join(', ');
if (!key || selected.some(chain => !chain.rpcUrl)) throw new Error(`Root relayer environment is missing: ${missing}`);
if (!/^0x[\da-fA-F]{64}$/.test(key)) {
  throw new Error('RELAYER_PRIVATE_KEY must be a 32-byte, 0x-prefixed hexadecimal value.');
}
for (const { variable, rpcUrl } of selected) {
  try {
    const url = new URL(rpcUrl!);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
  } catch {
    throw new Error(`${variable} must be an HTTP(S) URL.`);
  }
}
function deployed(chainId: number) {
  const record = JSON.parse(readFileSync(new URL(`../deployments/${chainId}.json`, import.meta.url), 'utf8')) as { mandateAccount: `0x${string}` };
  return [record.mandateAccount];
}
const app = createRelayer({ privateKey: key as `0x${string}`, chains: [
  ...selected.map(chain => ({
    chainId: chain.chainId, rpcUrl: chain.rpcUrl!, accounts: deployed(chain.chainId), gasPriceCap: 100_000_000_000n,
  })),
] });
app.server.listen(Number(process.env.RELAYER_PORT ?? 8787), () => {
  console.log(`Relayer ready; config=${envPath === resolve(projectRoot, '.env') ? '.env' : '.env.local'}; chains=${selected.map(chain => chain.chainId).join(',')}; port=${Number(process.env.RELAYER_PORT ?? 8787)}`);
});
