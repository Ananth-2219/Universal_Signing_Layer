'use client';

import { useDemo } from './demoStore';
import { Badge, Panel } from './ui';

export function WalletPanel() {
  const demo = useDemo();
  const disabled = demo.busy !== undefined;
  return (
    <Panel
      title="1. Connect the owner wallet"
      hint="MetaMask owns the account: it signs the mandate once and can revoke. Its private key stays in MetaMask. Test ETH only."
    >
      <div className="row between">
        <div className="row">
          {demo.isConnected && demo.address ? (
            <>
              <Badge tone="ok">connected</Badge>
              <span className="mono">{demo.address}</span>
              <span className="muted">wallet chain id {demo.walletChainId ?? 'unknown'}</span>
            </>
          ) : (
            <Badge tone="warn">no wallet</Badge>
          )}
        </div>
        <div className="row">
          {demo.isConnected ? (
            <button className="ghost" onClick={() => void demo.disconnect()} disabled={disabled}>Disconnect</button>
          ) : (
            <button onClick={() => void demo.connect()} disabled={demo.connecting || disabled}>
              {demo.connecting ? 'Connecting…' : 'Connect MetaMask'}
            </button>
          )}
          {demo.chains.map(chain => (
            <button
              key={chain.chainId}
              className="ghost"
              disabled={!demo.isConnected || disabled || !chain.rpcUrl}
              onClick={() => void demo.switchWalletChain(chain)}
            >
              Use {chain.label}
            </button>
          ))}
        </div>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <label>Submission mode{' '}
          <select value={demo.submissionMode} disabled={disabled}
            onChange={event => demo.setSubmissionMode(event.target.value as 'direct' | 'relayer')}>
            <option value="relayer">Relayer Mode (recommended)</option>
            <option value="direct">Direct Wallet Mode (manual)</option>
          </select>
        </label>
        {demo.submissionMode === 'relayer' && <Badge tone={demo.relayerUp ? 'ok' : 'err'}>{demo.relayerUp ? 'relayer online' : 'relayer offline'}</Badge>}
        <span className="muted">
          {demo.submissionMode === 'direct'
            ? 'Direct Wallet Mode is a manual fallback: the session key still authorizes transfers, but MetaMask submits each outer transaction and pays gas. Use Relayer Mode to avoid transfer popups.'
            : 'The session key signs routine transfers locally. The relayer submits the signed call and pays gas, so MetaMask is not asked after mandate signing. Failed requests are never automatically resubmitted through another mode.'}
        </span>
      </div>
    </Panel>
  );
}
