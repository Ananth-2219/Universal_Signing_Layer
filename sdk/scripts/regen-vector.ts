import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import {
  chainDomainHash, domainSeparator, encodeEnvelope, grantStructHash, mandateDigest,
  mandateStructHash, signMandate, structsArrayHash,
} from '../src/core/index.js';
import { VECTOR_APPLICATION, VECTOR_NOW, vectorMandate } from '../test/vector-inputs.js';

async function main() {
  const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
  const original = await readFile(envPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  // Restrict permissions before storing the new dedicated test key.
  await chmod(envPath, 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  const retained = original.replace(/^[\t ]*(?:export[\t ]+)?TEST_VECTOR_KEY[\t ]*=.*(?:\r?\n|$)/gm, '');
  await writeFile(envPath, `${retained}${retained.endsWith('\n') || !retained ? '' : '\n'}TEST_VECTOR_KEY=${generatePrivateKey()}\n`, { mode: 0o600 });
  // Read signing secrets from .env; fixtures contain only public values.
  const account = privateKeyToAccount(parse(await readFile(envPath, 'utf8')).TEST_VECTOR_KEY as Hex);
  const mandate = vectorMandate();
  const signature = await signMandate(mandate, account);
  const hashes = mandate.grants.map(grantStructHash);
  const vector = {
    owner: account.address, application: VECTOR_APPLICATION, now: VECTOR_NOW, mandate,
    chainDomainHashes: mandate.grants.map(chainDomainHash), grantStructHashes: hashes,
    arrayHash: structsArrayHash(hashes), mandateStructHash: mandateStructHash(mandate),
    domainSeparator: domainSeparator(), digest: mandateDigest(mandate), signature,
    envelopes: mandate.grants.map(g => encodeEnvelope({
      mandate, signature, chainId: g.domain.chainId,
      verifyingContract: g.domain.verifyingContract, application: VECTOR_APPLICATION,
    })),
  };
  const vectorsDir = new URL('../test/vectors/', import.meta.url);
  await mkdir(vectorsDir, { recursive: true });
  await writeFile(new URL('mandate.json', vectorsDir), JSON.stringify(vector,
    (_name, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');

  const lines = [
    '// SPDX-License-Identifier: MIT', 'pragma solidity ^0.8.20;',
    '// Generated public test constants. No signing key is needed to verify them.',
    'library Phase1Vector {',
  ];
  function constant(type: string, name: string, value: string | bigint) {
    lines.push(`    ${type} internal constant ${name} = ${type === 'bytes' ? `hex"${String(value).slice(2)}"` : value};`);
  }
  constant('address', 'OWNER', vector.owner);
  constant('address', 'APPLICATION', vector.application);
  constant('uint256', 'NONCE', mandate.nonce);
  constant('uint256', 'DEADLINE', mandate.deadline);
  mandate.grants.forEach((g, i) => {
    constant('uint256', `G${i}_CHAIN_ID`, g.domain.chainId);
    constant('address', `G${i}_VERIFYING_CONTRACT`, g.domain.verifyingContract);
    constant('address', `G${i}_SESSION_KEY`, g.sessionKey);
    constant('uint256', `G${i}_PER_TX_LIMIT`, g.perTxLimit);
    constant('uint256', `G${i}_BUDGET`, g.budget);
    constant('uint256', `G${i}_WINDOW_SECONDS`, g.windowSeconds);
    constant('uint256', `G${i}_EXPIRY`, g.expiry);
    constant('bytes32', `G${i}_DOMAIN_HASH`, vector.chainDomainHashes[i]!);
    constant('bytes32', `G${i}_STRUCT_HASH`, hashes[i]!);
  });
  constant('bytes32', 'ARRAY_HASH', vector.arrayHash);
  constant('bytes32', 'MANDATE_STRUCT_HASH', vector.mandateStructHash);
  constant('bytes32', 'DOMAIN_SEPARATOR', vector.domainSeparator);
  constant('bytes32', 'DIGEST', vector.digest);
  constant('bytes', 'SIGNATURE', signature);
  vector.envelopes.forEach((envelope, i) => constant('bytes', `ENVELOPE_${i}`, envelope));
  lines.push('}', '');
  const docsDir = new URL('../../docs/vectors/', import.meta.url);
  await mkdir(docsDir, { recursive: true });
  await writeFile(new URL('Phase1Vector.sol', docsDir), lines.join('\n'));
  console.log('Updated public fixtures. Dedicated test key stored only in ignored .env.');
}
main().catch(() => {
  // Do not log raw library exceptions: they may include sensitive inputs.
  console.error('Vector regeneration failed. Check dependencies and local file permissions.');
  process.exitCode = 1;
});
