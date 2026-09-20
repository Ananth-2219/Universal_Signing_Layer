import { formatEther } from 'viem';

/** 0x1234…abcd style shortening. Only ever applied to public values. */
export function shortHex(value: string, size = 6): string {
  return value.length <= 2 + size * 2 ? value : `${value.slice(0, 2 + size)}…${value.slice(-size)}`;
}

/** Exact decimal ETH, trailing zeros removed (never a floating-point number). */
export function eth(wei: bigint): string {
  const text = formatEther(wei);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

export function seconds(value: bigint): string {
  if (value <= 0n) return '0s';
  if (value < 60n) return `${value}s`;
  const minutes = value / 60n;
  if (minutes < 60n) return `${minutes}m ${value % 60n}s`;
  return `${minutes / 60n}h ${minutes % 60n}m`;
}

export function clockTime(date: Date): string {
  return date.toTimeString().slice(0, 8);
}
