import { chmod, readFile, writeFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { generatePrivateKey } from 'viem/accounts';

async function main() {
  const path = new URL('../../.env', import.meta.url);
  let original = await readFile(path, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const values = parse(original);
  // Create only missing throwaway test keys, preserving all other environment data.
  for (const name of ['OWNER_TEST_KEY', 'SESSION_TEST_KEY']) {
    if (values[name]) continue;
    original = original.replace(new RegExp(`^[\\t ]*(?:export[\\t ]+)?${name}[\\t ]*=.*(?:\\r?\\n|$)`, 'gm'), '');
    original += `${original.endsWith('\n') || !original ? '' : '\n'}${name}=${generatePrivateKey()}\n`;
  }
  await chmod(path, 0o600).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await writeFile(path, original, { mode: 0o600 });
  console.log('Dedicated Foundry test keys are available in ignored .env; no values displayed.');
}
main().catch(() => { console.error('Test-key setup failed. Check file permissions and dependencies.'); process.exitCode = 1; });
