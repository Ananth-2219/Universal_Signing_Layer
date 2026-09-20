'use client';

import { useDemo } from './demoStore';
import { Badge, Panel } from './ui';

export function SessionKeyPanel() {
  const demo = useDemo();
  return (
    <Panel
      title="3. Browser session key"
      hint="A random secp256k1 key created inside this page. Memory only: no cookie, localStorage, file or server custody. Reloading destroys the key; destroying it does not revoke its on-chain grants. Revoke first."
    >
      {demo.sessionKey && demo.limits ? (
        <div className="row between">
          <div className="row">
            <Badge tone="ok">in memory</Badge>
            <span className="mono">{demo.sessionKey.address}</span>
            <span className="muted">
              in-memory signer expires {new Date(Number(demo.sessionKey.expiry) * 1000).toLocaleTimeString()}; each chain applies its own signed expiry and budget below
            </span>
          </div>
          <button className="ghost" onClick={demo.clearSessionKey}>Destroy key</button>
        </div>
      ) : (
        <p>No session key yet: one fresh key is created for each mandate, on purpose.</p>
      )}
    </Panel>
  );
}

export function SetupNotice() {
  const demo = useDemo();
  const problems: string[] = [];
  if (demo.unconfigured.length > 0) {
    problems.push(`Configure RPCs for ${demo.unconfigured.map(chain => chain.label).join(', ')} in demo/.env.local, then restart. Run Pre-Demo Check before signing.`);
  }
  if (demo.deploymentsError) problems.push(demo.deploymentsError);
  if (demo.submissionMode === 'relayer' && !demo.relayerUp) {
    problems.push('The relayer is not answering. Select Direct Wallet Mode to submit with MetaMask and pay gas, or start it with `npm run relayer`.');
  }
  if (problems.length === 0) return null;
  return (
    <div className="notice">
      {problems.map(problem => <div key={problem}>{problem}</div>)}
    </div>
  );
}
