'use client';
import { useDemo } from './demoStore';
import { Badge, Panel } from './ui';
import { eth } from '../lib/format';

export function Diagnostics() {
  const demo = useDemo();
  return <Panel title="Demo diagnostics" hint="Checks the actual RPC, deployed bytecode, owner, account funds, wallet gas balance and readable session storage. Nothing is marked ready from a deployment file alone.">
    <div className="row between">
      <Badge tone={demo.isConnected ? 'ok' : 'warn'}>{demo.isConnected ? 'MetaMask connected' : 'Connect MetaMask first'}</Badge>
      <button className="ghost" disabled={!!demo.busy} onClick={() => void demo.diagnose()}>Run Pre-Demo Check</button>
    </div>
    <div className="chain-grid">{demo.chains.map(chain => {
      const result = demo.readiness.find(item => item.chainId === chain.chainId);
      const record = demo.deployments.find(item => item.chainId === chain.chainId);
      return <article className="chain-card" key={chain.chainId}>
        <h3>{chain.label}</h3><Badge tone={result?.ready ? 'ok' : 'warn'}>{result ? result.ready ? 'Ready at last check' : 'Needs attention' : 'Not checked'}</Badge>
        <p className="mono">chain {chain.chainId}</p>
        <p>{record ? `Deployment: ${record.mandateAccount}` : 'Deployment record missing'}</p>
        <p>{chain.rpcUrl ? 'RPC configured' : 'RPC missing from demo/.env.local'}</p>
        {result && <p style={{ whiteSpace: 'pre-wrap' }}>{result.message}</p>}
        {result?.walletBalance !== undefined && <p>Wallet: {eth(result.walletBalance)} ETH · estimated gas reserve: {eth(result.estimatedGasReserve!)} ETH</p>}
        {result?.status && <p>Account: {eth(result.status.balance)} ETH · session reads available</p>}
      </article>;
    })}</div>
    <p className="muted">Gas reserve is an estimate for one registration, not a guarantee for the entire demo. Fund both the owner wallet and its account contract with test ETH.</p>
  </Panel>;
}
