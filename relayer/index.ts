import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { createRelayer } from './src/server.js';

config();
const key = process.env.RELAYER_PRIVATE_KEY;
const a = process.env.ANVIL_RPC; const b = process.env.ANVIL_RPC_B;
if (!key || !a || !b) throw new Error('RELAYER_PRIVATE_KEY, ANVIL_RPC, and ANVIL_RPC_B are required');
function deployed(chainId: number) {
  const record = JSON.parse(readFileSync(new URL(`../deployments/${chainId}.json`, import.meta.url), 'utf8')) as { mandateAccount: `0x${string}` };
  return [record.mandateAccount];
}
const app = createRelayer({ privateKey: key as `0x${string}`, chains: [
  { chainId: 31337, rpcUrl: a, accounts: deployed(31337), gasPriceCap: 100_000_000_000n },
  { chainId: 31338, rpcUrl: b, accounts: deployed(31338), gasPriceCap: 100_000_000_000n },
] });
app.server.listen(Number(process.env.RELAYER_PORT ?? 8787));
