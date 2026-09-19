import { assertUint256 } from '../core/index.js';

/** USD price of one native token, in the same fixed-point scale as the USD limit. */
export interface PriceProvider {
  getNativeUsdPrice(chainId: string): Promise<bigint>;
}

export class MockPriceProvider implements PriceProvider {
  private readonly prices: Readonly<Record<string, bigint>>;
  constructor(prices: Readonly<Record<string, bigint>>) { this.prices = { ...prices }; }
  async getNativeUsdPrice(chainId: string): Promise<bigint> {
    const price = this.prices[chainId];
    if (price === undefined) throw new Error(`No native USD price for ${chainId}`);
    assertUint256(price, 'price');
    if (price === 0n) throw new Error('Price must be positive');
    return price;
  }
}

/** Convert once at mandate creation. Both inputs use the same USD scale. */
export function toNativeLimit(usd: bigint, price: bigint): bigint {
  assertUint256(usd, 'usd');
  assertUint256(price, 'price');
  if (price === 0n) throw new Error('Price must be positive');
  // Integer division rounds down, so rounding cannot enlarge the authorized limit.
  const wei = usd * 10n ** 18n / price;
  assertUint256(wei, 'native limit');
  return wei;
}
