'use client';

import { useDemo } from './demoStore';
import { Field, Panel, TextInput } from './ui';

export function TransferPanel() {
  const demo = useDemo();
  const disabled = demo.busy !== undefined;
  const ready = demo.mandate !== undefined && demo.sessionKey !== undefined;
  return (
    <Panel
      title="5. Small transfer and over-limit transfer"
      hint={demo.submissionMode === 'direct'
        ? 'Direct Wallet Mode: the session key signs, the contract call is simulated, then MetaMask submits it. You pay gas. Over-limit attempts are rejected; they never become unrestricted wallet transfers.'
        : 'The session key signs; the relayer simulates the exact call, then submits and pays gas. The contract refuses over-limit attempts.'}
    >
      <div className="grid">
        <Field label="Send on chain">
          <select
            value={demo.form.transferChainId}
            onChange={event => demo.update('transferChainId', Number(event.target.value))}
            disabled={disabled}
          >
            {demo.chains.map(chain => (
              <option key={chain.chainId} value={chain.chainId}>{chain.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Recipient address" hint="Tip: your own MetaMask address works, so you can watch the balance move.">
          <TextInput value={demo.form.recipient} onChange={value => demo.update('recipient', value)} placeholder="0x…" disabled={disabled} />
        </Field>
        <Field label="Amount (ETH)" hint="At or below the per-transfer limit.">
          <TextInput value={demo.form.amountEth} onChange={value => demo.update('amountEth', value)} disabled={disabled} />
        </Field>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={() => void demo.send(false)} disabled={disabled || !ready}>Send session transfer</button>
        <button className="ghost" onClick={() => void demo.send(true)} disabled={disabled || !ready}>
          Attempt over-limit transfer (limit + 0.001 ETH)
        </button>
      </div>
      {demo.limitsByChain[demo.form.transferChainId] ? (
        <p className="muted" style={{ marginTop: 10 }}>
          Signed limits: {demo.limitsByChain[demo.form.transferChainId]!.perTxLimit.toString()} wei per transfer, {demo.limitsByChain[demo.form.transferChainId]!.budget.toString()} wei per{' '}
          {demo.limitsByChain[demo.form.transferChainId]!.windowSeconds.toString()}-second window. The account contract enforces these on every call.
        </p>
      ) : null}
    </Panel>
  );
}
