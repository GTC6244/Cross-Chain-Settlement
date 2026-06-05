/**
 * Unit tests for the browser shared-core pure helpers (app/lib/*).
 * Network/ethers-bound functions are not exercised here (they run in the
 * browser); these cover the salt, template dispatch, deposit picking, order-book
 * paging math, quote grouping/sorting, and CID compare.
 */
import { strict as assert } from 'assert';
import { randomSalt, templateKeyForChains, pickDeposit } from '../app/lib/derive.js';
import { chunkRanges, effectiveRate, groupQuotesByIntent, sortQuotesByRate } from '../app/lib/intents.js';
import { compareCid } from '../app/lib/verify.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.stack || err.message}`); failed++; }
}

console.log('Browser shared-core (app/lib) Tests\n');

// ---- F2 random salt ----
await test('randomSalt: 32 bytes as 64 lowercase hex chars', async () => {
  const s = randomSalt();
  assert.equal(s.length, 64);
  assert.ok(/^[0-9a-f]{64}$/.test(s), 'hex only');
});

await test('randomSalt: two calls differ (no swapId prediction race)', async () => {
  assert.notEqual(randomSalt(), randomSalt());
});

// ---- template dispatch ----
await test('templateKeyForChains: evm<>evm', async () => {
  assert.equal(templateKeyForChains('base-sepolia', 'ethereum-sepolia'), 'evm-evm');
});

await test('templateKeyForChains: direction-independent (btc<>zec both ways)', async () => {
  assert.equal(templateKeyForChains('bitcoin-signet', 'zcash-testnet'), 'btc-zec');
  assert.equal(templateKeyForChains('zcash-testnet', 'bitcoin-signet'), 'btc-zec');
});

await test('templateKeyForChains: unsupported pair -> undefined', async () => {
  assert.equal(templateKeyForChains('base-sepolia', 'not-a-chain'), undefined);
});

// ---- deposit picking ----
await test('pickDeposit: returns the matching side, throws when absent', async () => {
  const derived = { evmAddress: '0xEVM', btcAddressSource: 'tb1qSrc', zecAddressDest: 'tzDest' };
  assert.equal(pickDeposit(derived, 'source'), 'tb1qSrc');
  assert.equal(pickDeposit(derived, 'dest'), 'tzDest');
  assert.throws(() => pickDeposit({ evmAddress: '0xEVM' }, 'source'), /missing AddressSource/);
});

// ---- order-book paging math ----
await test('chunkRanges: splits inclusive windows', async () => {
  assert.deepEqual(chunkRanges(0, 10, 5), [[0, 4], [5, 9], [10, 10]]);
});

await test('chunkRanges: single window when range fits', async () => {
  assert.deepEqual(chunkRanges(0, 4, 9000), [[0, 4]]);
});

await test('chunkRanges: empty when to < from', async () => {
  assert.deepEqual(chunkRanges(5, 4, 100), []);
});

// ---- quotes: rate, group, sort ----
await test('effectiveRate: destAmount/sourceAmount, 0 when no source', async () => {
  assert.equal(effectiveRate({ sourceAmount: 1000n, destAmount: 500n }), 0.5);
  assert.equal(effectiveRate({ sourceAmount: 0n, destAmount: 500n }), 0);
});

await test('groupQuotesByIntent: groups by intentId', async () => {
  const q = [
    { intentId: 'i1', destAmount: 1n, sourceAmount: 1n },
    { intentId: 'i2', destAmount: 1n, sourceAmount: 1n },
    { intentId: 'i1', destAmount: 1n, sourceAmount: 1n },
  ];
  const g = groupQuotesByIntent(q);
  assert.equal(g.get('i1').length, 2);
  assert.equal(g.get('i2').length, 1);
});

await test('sortQuotesByRate: best (highest dest/source) first, input not mutated', async () => {
  const q = [
    { swapId: 'a', sourceAmount: 1000n, destAmount: 500n },
    { swapId: 'b', sourceAmount: 1000n, destAmount: 600n },
    { swapId: 'c', sourceAmount: 1000n, destAmount: 550n },
  ];
  const sorted = sortQuotesByRate(q);
  assert.deepEqual(sorted.map((x) => x.swapId), ['b', 'c', 'a']);
  assert.equal(q[0].swapId, 'a', 'original array not mutated');
});

// ---- CID compare ----
await test('compareCid: match / mismatch', async () => {
  assert.equal(compareCid('Qm123', 'Qm123').match, true);
  assert.equal(compareCid('Qm123', 'Qm999').match, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
