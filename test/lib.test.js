/**
 * Unit tests for the browser shared-core pure helpers (app/lib/*).
 * Network/ethers-bound functions are not exercised here (they run in the
 * browser); these cover the salt, template dispatch, deposit picking, order-book
 * paging math, quote grouping/sorting, and CID compare.
 */
import { strict as assert } from 'assert';
import { randomSalt, templateKeyForChains, pickDeposit, confirmationBlocksFor } from '../app/lib/derive.js';
import { chunkRanges, effectiveRate, groupQuotesByIntent, sortQuotesByRate } from '../app/lib/intents.js';
import { compareCid, intentMatches } from '../app/lib/verify.js';
import { zecHybridProvider, ZEC_PROVIDER_HOSTS, CHAIN_API } from '../app/lib/contract.js';
import { median, toHuman, toRaw, ASSET_BY_CHAIN, DECIMALS_BY_ASSET } from '../app/lib/prices.js';

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

// ---- intent cross-check (H-2) ----
const INTENT = {
  sourceChain: 'base-sepolia', destChain: 'bitcoin-signet',
  userRefundSource: '0xUser', userReceiveDest: 'tb1qUser',
  sourceAmount: 1000000n, minDestAmount: 100000n, feeBps: 50,
  tokenAddressSource: '0x0000000000000000000000000000000000000000',
  tokenAddressDest: '0x0000000000000000000000000000000000000000',
};
function swapFrom(over = {}) { return { ...INTENT, ...over }; }

await test('intentMatches: identical fill matches', async () => {
  assert.equal(intentMatches(swapFrom(), INTENT).match, true);
});

await test('intentMatches: a HIGHER floor is allowed (solver may quote better)', async () => {
  assert.equal(intentMatches(swapFrom({ minDestAmount: 150000n }), INTENT).match, true);
});

await test('intentMatches: a LOWER floor is rejected', async () => {
  const r = intentMatches(swapFrom({ minDestAmount: 99999n }), INTENT);
  assert.equal(r.match, false);
  assert.ok(r.mismatches.includes('minDestAmount'));
});

await test('intentMatches: tampered userReceiveDest is rejected', async () => {
  const r = intentMatches(swapFrom({ userReceiveDest: 'tb1qAttacker' }), INTENT);
  assert.equal(r.match, false);
  assert.ok(r.mismatches.includes('userReceiveDest'));
});

await test('intentMatches: tampered sourceAmount / feeChain flagged', async () => {
  assert.ok(intentMatches(swapFrom({ sourceAmount: 999999n }), INTENT).mismatches.includes('sourceAmount'));
  assert.ok(intentMatches(swapFrom({ feeBps: 300 }), INTENT).mismatches.includes('feeBps'));
});

// ---- Zcash hybrid provider builder (solver app legApiConfig) ----
await test('zecHybridProvider: builds the proven tatum+blockbook hybrid from keys', async () => {
  const p = zecHybridProvider('zcash-mainnet', { tatumKey: 'TK', nownodesKey: 'NK' });
  assert.equal(p.style, 'tatum');
  assert.equal(p.rpc, ZEC_PROVIDER_HOSTS['zcash-mainnet'].gateway);
  assert.equal(p.apiKey, 'TK', 'gateway uses the tatum key');
  assert.equal(p.utxoApi.style, 'blockbook');
  assert.equal(p.utxoApi.base, ZEC_PROVIDER_HOSTS['zcash-mainnet'].blockbook);
  assert.equal(p.utxoApi.apiKeyHeader, 'api-key');
  assert.equal(p.utxoApi.apiKey, 'NK', 'utxo source uses the nownodes key');
});

await test('zecHybridProvider: returns null without both keys or for an unknown chain', async () => {
  assert.equal(zecHybridProvider('zcash-mainnet', { tatumKey: 'TK' }), null, 'needs nownodes key');
  assert.equal(zecHybridProvider('zcash-mainnet', null), null);
  assert.equal(zecHybridProvider('zcash-testnet', { tatumKey: 'TK', nownodesKey: 'NK' }), null, 'no testnet blockbook host');
});

await test('CHAIN_API ships empty/key-free (no committed secrets)', async () => {
  assert.deepEqual(CHAIN_API, {});
});

// ---- chain-aware confirmation depth ----
await test('confirmationBlocksFor: deep for ZEC mainnet, shallow for testnets', async () => {
  assert.equal(confirmationBlocksFor('base', 'zcash-mainnet'), 5, 'zec mainnet leg → 5');
  assert.equal(confirmationBlocksFor('zcash-mainnet', 'base'), 5, 'direction-independent');
  assert.equal(confirmationBlocksFor('base', 'zcash-testnet'), 1, 'zec testnet → 1');
  assert.equal(confirmationBlocksFor('base', 'bitcoin-signet'), 1, 'signet → 1');
});

await test('confirmationBlocksFor: all-EVM swap floors at 1 (gate never disabled, but no UTXO/ZEC leg to gate)', async () => {
  assert.equal(confirmationBlocksFor('base', 'base-sepolia'), 1);
});

// ---- market price helpers (app/lib/prices.js) ----
await test('median: odd length returns the middle element', async () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([5]), 5);
});

await test('median: even length averages the two middles', async () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([10, 20]), 15);
});

await test('median: empty array -> null (no sources answered)', async () => {
  assert.equal(median([]), null);
});

await test('toHuman: raw smallest units -> human amount per asset decimals', async () => {
  assert.equal(toHuman('1000000000000000000', 'ETH'), 1);   // 1e18 wei = 1 ETH (18)
  assert.equal(toHuman('100000000', 'ZEC'), 1);             // 1e8 zat = 1 ZEC (8)
  assert.equal(toHuman('1000000000', 'SOL'), 1);            // 1e9 lamports = 1 SOL (9)
});

await test('toRaw: human amount -> raw smallest units per asset decimals', async () => {
  assert.equal(toRaw(1, 'ETH'), 1e18);
  assert.equal(toRaw(2.5, 'ZEC'), 250000000);
});

await test('toHuman/toRaw: round-trip a whole-unit amount', async () => {
  for (const asset of ['ETH', 'BTC', 'ZEC', 'SOL']) {
    assert.equal(toHuman(toRaw(3, asset), asset), 3, asset);
  }
});

await test('ASSET_BY_CHAIN / DECIMALS_BY_ASSET cover every swap chain', async () => {
  // every chain maps to an asset, and every mapped asset has a decimals entry
  for (const chain of Object.keys(ASSET_BY_CHAIN)) {
    const asset = ASSET_BY_CHAIN[chain];
    assert.ok(asset, `${chain} has an asset`);
    assert.ok(DECIMALS_BY_ASSET[asset] >= 0, `${asset} has decimals`);
  }
  assert.equal(ASSET_BY_CHAIN['base'], 'ETH');
  assert.equal(ASSET_BY_CHAIN['zcash-mainnet'], 'ZEC');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
