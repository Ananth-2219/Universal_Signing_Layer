import { ActivityLog } from '../components/ActivityLog';
import { ChainTable } from '../components/ChainTable';
import { ConfigurationPanel } from '../components/ConfigurationPanel';
import { DemoProvider } from '../components/demoStore';
import { SecurityDemo } from '../components/SecurityDemo';
import { Diagnostics } from '../components/Diagnostics';
import { SessionKeyPanel, SetupNotice } from '../components/SessionPanel';
import { TransferPanel } from '../components/TransferPanel';
import { WalletPanel } from '../components/WalletPanel';

export default function Page() {
  return (
    <main className="page">
      <header>
        <div className="eyebrow">UNIVERSAL SIGNING LAYER · TESTNET DEMO</div>
        <h1>One consent.<br /><span>Bounded on every chain.</span></h1>
        <p>
          One explicit mandate. Three independent verifiers. A browser-held session key for native ETH transfers,
          with limits enforced by contracts on Ethereum Sepolia, Base Sepolia and Arbitrum Sepolia.
        </p>
        <div className="hero-facts"><span>01 / Owner consent</span><span>02 / Session authorization</span><span>03 / On-chain enforcement</span></div>
      </header>
      <DemoProvider>
        <SetupNotice />
        <WalletPanel />
        <Diagnostics />
        <ConfigurationPanel />
        <SessionKeyPanel />
        <ChainTable />
        <TransferPanel />
        <SecurityDemo />
        <ActivityLog />
        <div className="notice">
          Public testnets or local Anvil only. This is an unaudited prototype, not production-ready, and it must not be
          used to protect real funds. RPC and relayer URLs come from demo/.env.local.
        </div>
      </DemoProvider>
    </main>
  );
}
