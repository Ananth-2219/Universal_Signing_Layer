'use client';
import { useDemo } from './demoStore';
import { Badge, Panel } from './ui';

export function SecurityDemo() {
  const demo = useDemo();
  const disabled = !!demo.busy || !demo.sessionKey || !demo.mandate || !demo.isConnected;
  return <Panel title="6. Security demo" hint="Test the real account contract. Rejection probes use eth_call with a real session signature: no fabricated result, no gas spent on a failing transaction.">
    <div className="row"><Badge tone="warn">Selected chain: {demo.chains.find(chain => chain.chainId === demo.form.transferChainId)?.label}</Badge></div>
    <div className="security-grid">
      <article><h3>1 · Limited, even if compromised</h3><p>Simulate a caller with access to the in-memory session signer. A valid small action uses the recipient and amount above and really transfers test ETH. MetaMask only submits and pays gas.</p>
        <button disabled={disabled} onClick={() => void demo.send(false)}>Run valid small action</button>
        <button className="ghost" disabled={disabled} onClick={() => void demo.security('over')}>Probe oversized action</button></article>
      <article><h3>2 · Budget and replay</h3><p>Use equal cap and budget for the shortest demonstration. Spend that budget, then probe one extra wei. Replay uses the exact last confirmed signed operation, including its nonce.</p>
        <button className="ghost" disabled={disabled} onClick={() => void demo.security('budget')}>Probe budget violation</button>
        <button className="ghost" disabled={disabled} onClick={() => void demo.security('replay')}>Replay exact operation</button></article>
      <article><h3>3 · Revoke its authority</h3><p>Revoke on this chain, wait for the receipt, then probe a newly signed operation. Revoke separately on every chain. The private key is never displayed or exported.</p>
        <button className="danger" disabled={disabled} onClick={() => void demo.revoke(demo.form.transferChainId)}>Revoke selected session</button>
        <button className="ghost" disabled={disabled} onClick={() => void demo.security('post-revoke')}>Probe after revocation</button></article>
    </div>
    <p>Results appear in the timeline as the actual custom error (for example BudgetExceeded or OperationNonceUsed). A network failure is reported as an error, never as a successful defense.</p>
  </Panel>;
}
