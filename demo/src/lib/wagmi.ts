import type { Chain } from 'viem';
import { cookieStorage, createConfig, createStorage, http, injected } from 'wagmi';
import { DEMO_CHAINS } from './chains';
import { walletChainFor } from './usl';

const chainA: Chain = walletChainFor(DEMO_CHAINS[0]!);
const chainB: Chain = walletChainFor(DEMO_CHAINS[1]!);
const chainC: Chain = walletChainFor(DEMO_CHAINS[2]!);

/**
 * MetaMask-only wagmi config. The wagmi cookie keeps the connector id and chain id so the
 * page hydrates consistently; the session key is never persisted by wagmi or anyone else.
 */
export const wagmiConfig = createConfig({
  chains: [chainA, chainB, chainC],
  connectors: [injected({ target: 'metaMask' })],
  transports: {
    [chainA.id]: http(DEMO_CHAINS[0]!.rpcUrl || undefined),
    [chainB.id]: http(DEMO_CHAINS[1]!.rpcUrl || undefined),
    [chainC.id]: http(DEMO_CHAINS[2]!.rpcUrl || undefined),
  },
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
});

export const WALLET_CHAINS: readonly Chain[] = [chainA, chainB, chainC];

export function walletChainById(chainId: number): Chain | undefined {
  return WALLET_CHAINS.find(chain => chain.id === chainId);
}
