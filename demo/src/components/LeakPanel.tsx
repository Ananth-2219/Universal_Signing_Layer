'use client';

import { eth } from '../lib/format';
import { useDemo } from './demoStore';
import { Badge, Panel } from './ui';

export function LeakPanel() {
  const demo = useDemo();
  const disabled = demo.busy !== undefined;
  return (
    <Panel
      title="6. Local-only key-leak simulation"
      hint="A demonstration, not a real attack. The page plays a thief who somehow holds the session key: it signs with that key and submits straight to the account contract, with no relayer and no SDK pre-check. Only values that must be refused are attempted, so the demo cannot drain the mandate."
    >
      <div className="row">
        <select
          value={demo.form.leakChainId}
          onChange={event => demo.update('leakChainId', Number(event.target.value))}
          disabled={disabled}
        >
          {demo.chains.map(chain => (
            <option key={chain.chainId} value={chain.chainId}>{chain.label}</option>
          ))}
        </select>
        <button className="ghost" onClick={() => void demo.simulateLeak(demo.form.leakChainId)} disabled={disabled || !demo.sessionKey}>
          Simulate key leak
        </button>
        <Badge tone="warn">local anvil only</Badge>
      </div>
      <p className="muted" style={{ marginTop: 10 }}>
        MetaMask only funds a throwaway local account (0.1 test ETH) so the “attacker” pays its own gas. The session private
        key is never printed, stored or transmitted: the page can only ask the key object to sign. Anything a leaked key could
        really steal is bounded by the budget you signed.
      </p>
      {demo.leakRows.length > 0 ? (
        <table>
          <thead>
            <tr><th>#</th><th>Attempt</th><th>Value (wei)</th><th>Result</th><th>Reason</th><th>Drained</th><th>Budget left</th></tr>
          </thead>
          <tbody>
            {demo.leakRows.map(row => (
              <tr key={row.attempt}>
                <td>{row.attempt}</td>
                <td>{row.kind}</td>
                <td className="mono">{row.valueWei.toString()}</td>
                <td>{row.result === 'rejected'
                  ? <Badge tone="ok">rejected</Badge>
                  : row.result === 'sent' ? <Badge tone="err">sent</Badge> : <Badge tone="warn">skipped</Badge>}</td>
                <td>{row.reason}</td>
                <td className="mono">{eth(row.drainedWei)} ETH</td>
                <td className="mono">{eth(row.remainingBudgetWei)} ETH</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Panel>
  );
}
