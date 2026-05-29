// Dev helper: assemble every action template and write it to /tmp/genactions
// so we can `node --check` each one for syntax validity. Not a unit test.
import { mkdirSync, writeFileSync } from 'fs';

import { getEvmEvmActionCode } from '../app/actions/evm-evm-action.js';
import { getEvmBtcActionCode } from '../app/actions/evm-btc-action.js';
import { getEvmZecActionCode } from '../app/actions/evm-zec-action.js';
import { getBtcZecActionCode } from '../app/actions/btc-zec-action.js';
import { getBtcLtcActionCode } from '../app/actions/btc-ltc-action.js';
import { getBtcDogeActionCode } from '../app/actions/btc-doge-action.js';
import { getEvmSolActionCode } from '../app/actions/evm-sol-action.js';
import { getBtcSolActionCode } from '../app/actions/btc-sol-action.js';
import { getZecSolActionCode } from '../app/actions/zec-sol-action.js';
import { getZecLtcActionCode } from '../app/actions/zec-ltc-action.js';
import { getZecDogeActionCode } from '../app/actions/zec-doge-action.js';

const gens = {
  'evm-evm': getEvmEvmActionCode,
  'evm-btc': getEvmBtcActionCode,
  'evm-zec': getEvmZecActionCode,
  'btc-zec': getBtcZecActionCode,
  'btc-ltc': getBtcLtcActionCode,
  'btc-doge': getBtcDogeActionCode,
  'evm-sol': getEvmSolActionCode,
  'btc-sol': getBtcSolActionCode,
  'zec-sol': getZecSolActionCode,
  'zec-ltc': getZecLtcActionCode,
  'zec-doge': getZecDogeActionCode,
};

const outDir = '/tmp/genactions';
mkdirSync(outDir, { recursive: true });
for (const [name, gen] of Object.entries(gens)) {
  const code = gen('test-salt-' + name);
  writeFileSync(`${outDir}/${name}.mjs`, code);
  console.log(`assembled ${name} (${code.length} bytes)`);
}
