import { decodeAccountError } from '@usl/sdk/adapters';
import { revertDataOf } from './usl';

export function redactErrorText(text: string): string {
  return text
    .replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, '[URL redacted]')
    .replace(/\b(?:0x)?[a-f\d]{64,}\b/gi, '[hex data redacted]')
    .replace(/((?:privateKey|mnemonic|seedPhrase|signature|envelope)["']?\s*[:=]\s*)["'][^"']*["']/gi, '$1"[redacted]');
}

/** Preserve provider messages/codes without dumping error objects or signed request payloads. */
export function describeActionError(operation: string, error: unknown): string {
  const messages: string[] = [];
  const codes = new Set<string>();
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || value == null) return;
    if (typeof value === 'string') { messages.push(value); return; }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const entry = value as Record<string, unknown>;
    const message = typeof entry.message === 'string' ? entry.message : entry.shortMessage;
    if (typeof message === 'string' && !messages.includes(message)) messages.push(message);
    if (typeof entry.code === 'string' || typeof entry.code === 'number') codes.add(String(entry.code));
    for (const key of ['cause', 'error', 'info', 'data', 'originalError']) visit(entry[key], depth + 1);
  };
  visit(error, 0);
  const revert = decodeAccountError(revertDataOf(error));
  return redactErrorText([
    `Operation: ${operation}`,
    `Error code: ${[...codes].join(', ') || 'not provided'}`,
    `Contract revert: ${revert ?? 'not provided'}`,
    ...messages.length ? messages : ['No error message was provided'],
  ].join('\n'));
}
