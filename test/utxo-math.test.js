/**
 * Pure UTXO math tests — loads the exact UTXO_MATH_SRC string that gets
 * embedded into the actions and exercises selectCoins / drainCoins / feeFor.
 * Single source of truth: no duplicate logic, no live network.
 */
import { UTXO_MATH_SRC } from '../app/actions/lib/utxo-leg.js';
import { strict as assert } from 'assert';

const M = new Function(UTXO_MATH_SRC + '\n; return { selectCoins, drainCoins, feeFor, txVsize, SIZES_SEGWIT, SIZES_LEGACY };')();

const utxo = (n) => ({ amount: BigInt(n) });

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.stack || err.message}`); failed++; }
}

console.log('UTXO math Tests\n');

test('selectCoins picks largest-first and covers amount + fee', () => {
  const r = M.selectCoins([utxo(100000), utxo(50000), utxo(10000)], 120000n, 2, M.SIZES_SEGWIT, 0);
  // 1 input (100000) can't cover 120000; add 50000 -> 150000.
  assert.equal(r.selected.length, 2);
  // fee for 2-in/2-out segwit: (11 + 2*68 + 2*31) * 2 = 418
  assert.equal(r.fee, 418n);
  assert.equal(r.change, 150000n - 120000n - 418n);
});

test('selectCoins throws on insufficient funds', () => {
  assert.throws(() => M.selectCoins([utxo(1000), utxo(500)], 100000n, 2, M.SIZES_SEGWIT, 0), /insufficient/);
});

test('selectCoins single input when it already covers amount+fee', () => {
  const r = M.selectCoins([utxo(1000000), utxo(50000)], 100000n, 2, M.SIZES_SEGWIT, 0);
  assert.equal(r.selected.length, 1);
});

test('drainCoins spends everything minus a 1-output fee', () => {
  const r = M.drainCoins([utxo(100000), utxo(50000)], 2, M.SIZES_SEGWIT, 0);
  // fee for 2-in/1-out segwit: (11 + 2*68 + 31) * 2 = 356
  assert.equal(r.fee, 356n);
  assert.equal(r.send, 150000n - 356n);
});

test('minFee floor is enforced (Dogecoin-style)', () => {
  // tiny tx but minFee 100000 -> fee must be the floor
  const r = M.feeFor(1, 2, M.SIZES_LEGACY, 1000, 100000000);
  assert.equal(r, 100000000n);
});

test('legacy sizes differ from segwit', () => {
  assert.ok(M.txVsize(1, 1, M.SIZES_LEGACY) > M.txVsize(1, 1, M.SIZES_SEGWIT));
});

test('exact boundary: total == amount + fee -> change 0, no throw', () => {
  // 1-in/2-out segwit fee = (11 + 68 + 62) * 2 = 282
  const r = M.selectCoins([utxo(100282)], 100000n, 2, M.SIZES_SEGWIT, 0);
  assert.equal(r.selected.length, 1);
  assert.equal(r.fee, 282n);
  assert.equal(r.change, 0n);
});

test('drainCoins can return negative send when fee exceeds inputs (leg must guard)', () => {
  // 1-in/1-out segwit fee = (11 + 68 + 31) * 2 = 220 > 100
  const r = M.drainCoins([utxo(100)], 2, M.SIZES_SEGWIT, 0);
  assert.ok(r.send < 0n, 'send goes negative; the leg guards with send <= dust -> null');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
