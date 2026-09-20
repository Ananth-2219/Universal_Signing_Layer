import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-dynamic';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Address-only deployment records written by contracts/script/DeployMandateAccount.s.sol.
 * These are exactly the files the Phase 8 relayer allow-list reads, so the browser and the
 * relayer can never disagree about which account contract belongs to a chain. Only the
 * chain id, account address and owner address are returned; no key material exists here.
 */
export async function GET() {
  const directory = path.join(process.cwd(), '..', 'deployments');
  try {
    const files = (await readdir(directory)).filter(name => /^\d+\.json$/.test(name));
    const deployments: { chainId: number; mandateAccount: string; owner: string }[] = [];
    for (const file of files) {
      const record = JSON.parse(await readFile(path.join(directory, file), 'utf8')) as Record<string, unknown>;
      const { chainId, mandateAccount, owner } = record;
      if (Number.isInteger(chainId) && chainId === Number(file.slice(0, -5)) && typeof mandateAccount === 'string' && ADDRESS.test(mandateAccount)
        && typeof owner === 'string' && ADDRESS.test(owner)) {
        deployments.push({ chainId: chainId as number, mandateAccount, owner });
      }
    }
    deployments.sort((left, right) => left.chainId - right.chainId);
    return Response.json({ deployments });
  } catch (error) {
    return Response.json({
      deployments: [],
      error: `Could not read deployments/: ${(error as Error).message}. Run the Phase 6 deploy script first.`,
    });
  }
}
