'use client';

import { useDemo } from './demoStore';
import { Panel } from './ui';
import { transactionLink } from '../lib/judge';

export function ActivityLog() {
  const demo = useDemo();
  return (
    <Panel
      title="Activity timeline"
      hint="Errors include the operation, provider messages, error codes and decoded contract revert. URLs and secret-sized hex data are redacted."
    >
      <div className="log">
        {demo.entries.length === 0 ? <div className="muted">Nothing yet.</div> : null}
        {demo.entries.map(entry => (
          <div key={entry.id}>
            <time>{entry.at}</time>
            <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} className={entry.level === 'info' ? 'muted' : entry.level}>{entry.message}</span>
            {entry.hash && (() => {
              const chain = demo.chains.find(item => item.chainId === entry.chainId);
              const link = chain && transactionLink(chain, entry.hash!);
              return link ? <a href={link} target="_blank" rel="noreferrer" className="mono">{entry.hash}</a> : <span className="mono">{entry.hash}</span>;
            })()}
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="ghost" onClick={demo.clearLog} disabled={demo.entries.length === 0}>Clear</button>
        <button className="ghost" onClick={() => void demo.refreshDeployments()} disabled={demo.busy !== undefined}>
          Re-read deployments
        </button>
      </div>
    </Panel>
  );
}
