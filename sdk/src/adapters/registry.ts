import { assertUint256 } from '../core/index.js';
import type { ChainAdapter } from './types.js';

export function parseCaip2(chainId: string) {
  const [namespace, reference, ...extra] = chainId.split(':');
  if (namespace !== 'eip155') throw new Error('Only the eip155 namespace is supported');
  if (extra.length || !reference || !/^(0|[1-9][0-9]*)$/.test(reference)) throw new Error('Invalid eip155 CAIP-2 chain ID');
  const numericChainId = BigInt(reference);
  assertUint256(numericChainId, 'chainId');
  return { namespace, reference, numericChainId };
}

export class AdapterRegistry {
  #adapters = new Map<string, ChainAdapter>();
  register(adapter: ChainAdapter): void {
    if (this.#adapters.has(adapter.chainId)) throw new Error(`Adapter already registered: ${adapter.chainId}`);
    this.#adapters.set(adapter.chainId, adapter);
  }
  get(chainId: string): ChainAdapter {
    const adapter = this.#adapters.get(chainId);
    if (!adapter) throw new Error(`Unknown chain ${chainId}; known chains: ${[...this.#adapters.keys()].join(', ') || '(none)'}`);
    return adapter;
  }
}
