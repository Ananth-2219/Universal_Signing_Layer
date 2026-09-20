import type { DemoChain } from './usl';

/** RPC values come only from local configuration, never bundled defaults. */
const anvilA = (process.env.NEXT_PUBLIC_ANVIL_RPC_A ?? '').trim();
const anvilB = (process.env.NEXT_PUBLIC_ANVIL_RPC_B ?? '').trim();
const anvilC = (process.env.NEXT_PUBLIC_ANVIL_RPC_C ?? '').trim();

export const DEMO_CHAINS: readonly DemoChain[] = process.env.NEXT_PUBLIC_NETWORK_MODE === 'local' ? [
  { chainId: 31337, caip2: 'eip155:31337', label: 'Anvil A', rpcUrl: anvilA },
  { chainId: 31338, caip2: 'eip155:31338', label: 'Anvil B', rpcUrl: anvilB },
  { chainId: 31339, caip2: 'eip155:31339', label: 'Anvil C', rpcUrl: anvilC },
] : [
  { chainId: 11155111, caip2: 'eip155:11155111', label: 'Ethereum Sepolia', rpcUrl: (process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? '').trim(), explorer: 'https://sepolia.etherscan.io' },
  { chainId: 84532, caip2: 'eip155:84532', label: 'Base Sepolia', rpcUrl: (process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL ?? '').trim(), explorer: 'https://sepolia.basescan.org' },
  { chainId: 421614, caip2: 'eip155:421614', label: 'Arbitrum Sepolia', rpcUrl: (process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL ?? '').trim(), explorer: 'https://sepolia.arbiscan.io' },
];

/** Same-origin gateway; Next.js reads NEXT_PUBLIC_RELAYER_URL on startup. */
export const RELAYER_URL = '/api/relayer';

export function chainById(chainId: number): DemoChain {
  const found = DEMO_CHAINS.find(candidate => candidate.chainId === chainId);
  if (!found) throw new Error(`Unsupported chain ${chainId}`);
  return found;
}

/** Chains the browser cannot reach because demo/.env.local has no RPC URL for them. */
export const UNCONFIGURED_CHAINS = DEMO_CHAINS.filter(chain => !chain.rpcUrl);
