'use client';

import { eth, seconds, shortHex } from '../lib/format';
import { budgetWindowResetsIn } from '../lib/usl';
import { effectiveRemaining } from '../lib/judge';
import { useDemo } from './demoStore';
import { Badge, BudgetBar, Panel } from './ui';

export function ChainTable() {
  const demo = useDemo();
  const disabled = demo.busy !== undefined;
  return (
    <Panel
      title="4. On-chain status, budget and revoke"
      hint="Read straight from each account contract. Revoking is an owner transaction on that chain, so MetaMask will ask you to switch network and confirm."
    >
      <table>
        <thead>
          <tr>
            <th>Chain</th><th>Account</th><th>Owner</th><th>Session</th>
            <th>This window</th><th>Remaining</th><th>Window resets</th><th>Account balance</th><th />
          </tr>
        </thead>
        <tbody>
          {demo.views.length === 0 ? (
            <tr><td colSpan={9} className="muted">Select a chain above to see its status.</td></tr>
          ) : null}
          {demo.views.map(view => (
            <tr key={view.chain.chainId}>
              <td>
                {view.chain.label}
                <div className="muted mono">chain {view.chain.chainId}</div>
              </td>
              <td className="mono">
                {view.deployment ? shortHex(view.deployment.mandateAccount) : <span className="muted">no record</span>}
              </td>
              <td>
                {view.status
                  ? (demo.address && view.status.owner.toLowerCase() === demo.address.toLowerCase()
                    ? <Badge tone="ok">this wallet</Badge>
                    : <Badge tone="err">another wallet</Badge>)
                  : <span className="muted">—</span>}
              </td>
              <td>
                {view.status
                  ? (view.status.session.active && view.status.session.expiry > view.status.now ? <Badge tone="ok">active</Badge> : <Badge tone="warn">expired / inactive</Badge>)
                  : <span className="muted">—</span>}
              </td>
              <td>
                {view.status
                  ? <BudgetBar spent={view.status.session.spent} budget={view.status.session.budget} />
                  : <span className="muted">sign a mandate first</span>}
              </td>
              <td className="mono">{view.status ? `${eth(effectiveRemaining(view.status.session, view.status.now))} ETH` : '—'}</td>
              <td>{view.status ? seconds(budgetWindowResetsIn(view.status.session, view.status.now)) : '—'}</td>
              <td className="mono">{view.status ? `${eth(view.status.balance)} ETH` : '—'}</td>
              <td>
                <button
                  className="danger"
                  disabled={disabled || !demo.isConnected || !view.status?.session.active}
                  onClick={() => void demo.revoke(view.chain.chainId)}
                >
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {demo.views.some(view => view.error) ? (
        <p className="err">
          {demo.views.filter(view => view.error).map(view => `${view.chain.label}: ${view.error}`).join(' · ')}
        </p>
      ) : null}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="ghost" onClick={() => void demo.refreshViews()} disabled={disabled}>Refresh status</button>
        <span className="muted">Refreshes every 12 seconds. Remaining budget reflects elapsed windows; stored spend resets on the next transaction.</span>
      </div>
    </Panel>
  );
}
