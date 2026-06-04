/**
 * Pure UTXO math tests — loads the exact UTXO_MATH_SRC string that gets
 * embedded into the actions and exercises selectCoins / drainCoins / feeFor.
 * Single source of truth: no duplicate logic, no live network.
 */
import { UTXO_MATH_SRC } from '../app/actions/lib/utxo-leg.js';
import { strict as assert } from 'assert';

const M = new Function(UTXO_MATH_SRC + '\n; return { selectCoins, drainCoins, feeFor, txVsize, SIZES_SEGWIT, SIZES_LEGACY, zip317Fee, selectCoinsZip317, drainCoinsZip317 };')();

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

// ---- Zcash ZIP-317 conventional fee (verified against zcashd regtest) ----

test('zip317Fee: grace floor of 2 actions for small txs (1-in/2-out = 10000 zat)', () => {
  assert.equal(M.zip317Fee(1, 2), 10000n);
  assert.equal(M.zip317Fee(1, 1), 10000n);
  assert.equal(M.zip317Fee(2, 2), 10000n);
});

test('zip317Fee: scales by max(numIn, numOut) above the grace floor', () => {
  assert.equal(M.zip317Fee(3, 2), 15000n); // 5000 * 3
  assert.equal(M.zip317Fee(2, 5), 25000n); // 5000 * 5
});

test('selectCoinsZip317: covers amount + conventional fee', () => {
  const r = M.selectCoinsZip317([utxo(1000000000)], 500000000n);
  assert.equal(r.selected.length, 1);
  assert.equal(r.fee, 10000n); // 1-in/2-out
  assert.equal(r.change, 1000000000n - 500000000n - 10000n);
});

test('selectCoinsZip317: pulls more inputs and fee grows with action count', () => {
  // 3 inputs needed: 2 cover 16000 < 8000+10000; the 3rd lifts the fee to
  // zip317Fee(3,2)=15000 and total 24000 >= 8000+15000.
  const r = M.selectCoinsZip317([utxo(8000n), utxo(8000n), utxo(8000n)], 8000n);
  assert.equal(r.selected.length, 3);
  assert.equal(r.fee, 15000n);
  assert.equal(r.change, 24000n - 8000n - 15000n);
});

test('selectCoinsZip317: throws on insufficient funds', () => {
  assert.throws(() => M.selectCoinsZip317([utxo(5000n)], 1000n), /insufficient/);
});

test('drainCoinsZip317: single output, fee = conventional for the input count', () => {
  const r = M.drainCoinsZip317([utxo(1000000000n), utxo(2000000000n)]);
  assert.equal(r.fee, 10000n); // 2-in/1-out -> max(2,1)=2 -> 10000
  assert.equal(r.send, 3000000000n - 10000n);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
