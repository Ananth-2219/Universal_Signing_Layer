'use client';

import { shortHex } from '../lib/format';
import { useDemo } from './demoStore';
import { Badge, Field, Panel, TextInput } from './ui';
import { eth } from '../lib/format';

export function ConfigurationPanel() {
  const demo = useDemo();
  const disabled = demo.busy !== undefined;
  const limitsLocked = demo.sessionKey !== undefined;
  const hasSelectedChain = demo.selected.length > 0;
  const selectedChainsReadyToSign = hasSelectedChain && demo.selected.every(id => {
    const chain = demo.chains.find(candidate => candidate.chainId === id);
    return Boolean(chain?.rpcUrl) && demo.deployments.some(record => record.chainId === id);
  });
  const signBlocker = !hasSelectedChain
    ? 'Select at least one chain.'
    : demo.selected.some(id => !demo.chains.find(chain => chain.chainId === id)?.rpcUrl)
      ? 'Add an RPC URL for every selected chain in demo/.env.local and restart.'
      : demo.selected.some(id => !demo.deployments.some(record => record.chainId === id))
        ? 'Deploy an account and add its deployment record for every selected chain before signing.'
        : undefined;

  return (
    <Panel
      title="2. Configure and sign the mandate"
      hint="These numbers become the signed grant. They are read from the form when the session key is created, so change them before generating a key. One signature covers every selected chain: no per-chain signing."
    >
      <h3>Chains covered by this mandate</h3>
      <div className="row">
        {demo.chains.map(chain => {
          const record = demo.deployments.find(candidate => candidate.chainId === chain.chainId);
          return (
            <label key={chain.chainId} className="row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={demo.selected.includes(chain.chainId)}
                onChange={() => demo.toggleChain(chain.chainId)}
                disabled={disabled}
              />
              <span>{chain.label}</span>
              {record
                ? <Badge tone="ok">account {shortHex(record.mandateAccount)}</Badge>
                : <Badge tone="warn">no deployment record</Badge>}
              {chain.rpcUrl ? null : <Badge tone="err">no RPC URL</Badge>}
            </label>
          );
        })}
      </div>

      <div className="chain-grid">
        {demo.chains.filter(chain => demo.selected.includes(chain.chainId)).map(chain => (
          <div className="chain-card" key={chain.chainId}>
            <h3>{chain.label}</h3>
            {([['perTxLimitEth', 'Per-transfer cap (ETH)'], ['budgetEth', 'Window budget (ETH)'],
              ['windowSeconds', 'Fixed window (seconds)'], ['expiryMinutes', 'Expires in (minutes)']] as const).map(([field, label]) => (
              <Field key={field} label={label}>
                <TextInput value={demo.chainForms[chain.chainId]![field]}
                  onChange={value => demo.updateChain(chain.chainId, field, value)} disabled={limitsLocked || disabled} />
              </Field>
            ))}
          </div>
        ))}
      </div>
      <div className="mandate-preview">
        <h3>What you authorize</h3>
        <p>One signature · USLMandate / 1 · explicit chain grants · native ETH only</p>
        <p className="mono">Session: {demo.sessionKey?.address ?? 'Generate a local session key to preview its address'}</p>
        {demo.chains.filter(chain => demo.selected.includes(chain.chainId)).map(chain => {
          const grant = demo.limitsByChain[chain.chainId];
          return <p key={chain.chainId}><strong>{chain.label} ({chain.chainId})</strong><br />
            Account: <span className="mono">{demo.deployments.find(item => item.chainId === chain.chainId)?.mandateAccount ?? 'Deployment missing'}</span><br />
            {grant ? `${eth(grant.perTxLimit)} ETH per transfer · ${eth(grant.budget)} ETH per ${grant.windowSeconds}s · expires ${new Date(Number(grant.expiry) * 1000).toLocaleString()}` : 'Configure this grant above, then generate the session key.'}
          </p>;
        })}
        <p>Each chain enforces its own budget. A fixed-window boundary can permit nearly two budgets in a short burst.</p>
      </div>

      <div className="row" style={{ marginTop: 14 }}>
        <button onClick={() => void demo.generateSessionKey()} disabled={disabled || !hasSelectedChain}>
          Generate session key
        </button>
        <button className="ghost" onClick={() => void demo.sign()} disabled={disabled || !demo.sessionKey || !selectedChainsReadyToSign}>
          Sign mandate with MetaMask (one signature)
        </button>
        <button onClick={() => void demo.register()} disabled={disabled || !demo.mandate || !demo.signature}>
          Register / retry remaining chains via {demo.submissionMode === 'direct' ? 'MetaMask' : 'relayer'}
        </button>
        {demo.mandate ? <Badge tone="ok">mandate id {demo.mandate.nonce.toString()}</Badge> : null}
        {demo.signature ? <Badge tone="ok">signed once</Badge> : null}
      </div>
      {signBlocker ? <p className="muted" style={{ marginTop: 10 }}>Signing is unavailable: {signBlocker}</p> : null}
      {!demo.sessionKey && !signBlocker ? <p className="muted" style={{ marginTop: 10 }}>Generate a session key before signing.</p> : null}
      <div className="row">{demo.chains.map(chain => <Badge key={chain.chainId} tone={demo.registrations[chain.chainId] === 'confirmed' ? 'ok' : 'info'}>
        {chain.label}: {demo.registrations[chain.chainId] ?? 'not registered in this run'}
      </Badge>)}</div>
    </Panel>
  );
}
