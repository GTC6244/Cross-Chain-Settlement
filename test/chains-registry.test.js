/**
 * Registry-integrity tests for the chain config (no network).
 *
 * These guard the realistic regression class introduced by adding many chains:
 * a dropdown id with no networks.js entry, a typo'd or duplicate chainId, a
 * label/icon gap, a family-map hole, or a keyed RPC leaking into the embedded
 * (CID-bound) config. They do NOT prove a chain actually settles — that needs a
 * live tx (see test/rpc-smoke.mjs for the liveness/1559 layer and the manual
 * funded-settlement flow). Adding a chain to networks.js + the dropdown keeps
 * these green automatically; forgetting one side turns them red.
 */
import { strict as assert } from 'assert';
import { CHAINS } from '../app/actions/lib/networks.js';
import { CHAIN_FAMILY, templateKeyForChains } from '../app/lib/derive.js';
import {
  CHAIN_GROUPS, chainLabel, iconUrl, evmChainHex, chainOptionsHtml,
} from '../app/lib/chains.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.stack || err.message}`); failed++; }
}

console.log('Chain registry integrity Tests\n');

const dropdownIds = CHAIN_GROUPS.flatMap(([, ids]) => ids);
const evmEntries = Object.entries(CHAINS).filter(([, c]) => c.family === 'evm');

// ---- dropdown <-> networks.js coherence -----------------------------------
await test('every dropdown chain id has a networks.js entry', async () => {
  for (const id of dropdownIds) {
    assert.ok(CHAINS[id], `dropdown offers "${id}" but networks.js has no CHAINS["${id}"]`);
  }
});

await test('no duplicate ids across dropdown groups', async () => {
  const seen = new Set();
  for (const id of dropdownIds) {
    assert.ok(!seen.has(id), `"${id}" appears in more than one dropdown group`);
    seen.add(id);
  }
});

await test('every dropdown id has a human label and an icon url', async () => {
  for (const id of dropdownIds) {
    assert.notEqual(chainLabel(id), id, `"${id}" has no label (falls back to the id)`);
    assert.ok(iconUrl(id), `"${id}" has no icon slug`);
  }
});

await test('chainOptionsHtml emits one <option> per dropdown id, grouped', async () => {
  const html = chainOptionsHtml();
  const opts = (html.match(/<option /g) || []).length;
  const groups = (html.match(/<optgroup /g) || []).length;
  assert.equal(opts, dropdownIds.length);
  assert.equal(groups, CHAIN_GROUPS.length);
});

// ---- EVM chainId / hex integrity ------------------------------------------
await test('every EVM chain has a positive integer chainId', async () => {
  for (const [id, c] of evmEntries) {
    assert.equal(typeof c.chainId, 'number', `${id}.chainId is not a number`);
    assert.ok(Number.isInteger(c.chainId) && c.chainId > 0, `${id}.chainId invalid: ${c.chainId}`);
  }
});

await test('EVM chainIds are unique (no two chains share one)', async () => {
  const byId = new Map();
  for (const [id, c] of evmEntries) {
    assert.ok(!byId.has(c.chainId), `chainId ${c.chainId} used by both "${byId.get(c.chainId)}" and "${id}"`);
    byId.set(c.chainId, id);
  }
});

await test('evmChainHex round-trips to the decimal chainId for every EVM chain', async () => {
  for (const [id, c] of evmEntries) {
    const hex = evmChainHex(id);
    assert.ok(hex && hex.startsWith('0x'), `${id} produced no hex`);
    assert.equal(parseInt(hex, 16), c.chainId, `${id}: hex ${hex} != chainId ${c.chainId}`);
  }
});

await test('evmChainHex returns null for non-EVM chains', async () => {
  for (const [id, c] of Object.entries(CHAINS)) {
    if (c.family !== 'evm') assert.equal(evmChainHex(id), null, `${id} (${c.family}) should have no EVM hex`);
  }
});

// ---- family map + template dispatch ---------------------------------------
await test('CHAIN_FAMILY covers every networks.js chain, consistently', async () => {
  for (const [id, c] of Object.entries(CHAINS)) {
    const fam = CHAIN_FAMILY[id];
    assert.ok(fam, `CHAIN_FAMILY has no entry for "${id}"`);
    if (c.family === 'evm') assert.equal(fam, 'evm', `${id} is evm in networks.js but ${fam} in CHAIN_FAMILY`);
    if (c.family === 'utxo') assert.ok(['btc', 'ltc', 'doge'].includes(fam), `${id} utxo -> unexpected family ${fam}`);
    if (c.family === 'zec') assert.equal(fam, 'zec');
    if (c.family === 'sol') assert.equal(fam, 'sol');
  }
});

await test('evm-evm template resolves for the new mainnet chains', async () => {
  // A representative spread of the freshly added chains.
  for (const pair of [['ethereum', 'base'], ['polygon', 'linea'], ['avalanche', 'optimism']]) {
    assert.equal(templateKeyForChains(pair[0], pair[1]), 'evm-evm', `${pair.join('->')} did not resolve to evm-evm`);
  }
});

// ---- key-free RPC invariant (these strings get embedded in the CID) -------
await test('embedded EVM RPCs are key-free (no api keys leak into the action)', async () => {
  for (const [id, c] of evmEntries) {
    assert.ok(/^https:\/\//.test(c.rpc), `${id} rpc is not https: ${c.rpc}`);
    assert.ok(!/(api[-_]?key|apikey|access[-_]?token)/i.test(c.rpc), `${id} rpc looks keyed: ${c.rpc}`);
    // Long hex/uuid path segment = almost certainly an embedded key.
    assert.ok(!/[0-9a-f]{24,}/i.test(c.rpc) && !/[0-9a-f-]{32,}/i.test(c.rpc), `${id} rpc has a key-like segment: ${c.rpc}`);
  }
});

// ---- regression guards: chains excluded pending live verification ----------
// These 6 top EVM chains are intentionally NOT shipped until a live funded
// settlement test confirms them (see TODOS.md). zkSync Era can't be signed at
// all by the engine; the other five have a tx-shape the engine now supports but
// that hasn't been proven on-chain. Re-adding any of them must go through that
// test — this guard fails loudly if one is re-added to config or the dropdown.
const EXCLUDED = {
  'zksync-era': 324, 'arbitrum': 42161, 'polygon-zkevm': 1101,
  'metis': 1088, 'kava': 2222, 'aurora': 1313161554,
};
await test('excluded chains are absent from both networks.js and the dropdown', async () => {
  for (const [id, chainId] of Object.entries(EXCLUDED)) {
    assert.equal(CHAINS[id], undefined, `${id} is back in networks.js but not yet live-verified`);
    assert.ok(!dropdownIds.includes(id), `${id} is offered in the dropdown but not yet live-verified`);
    for (const [, c] of evmEntries) assert.notEqual(c.chainId, chainId, `chainId ${chainId} (${id}) is present`);
  }
});

// Forward guard: if a future chain DOES set these, they must be well-formed.
await test('any txType is "legacy" and any nativeGasLimit is a positive int', async () => {
  for (const [id, c] of evmEntries) {
    if (c.txType !== undefined) assert.equal(c.txType, 'legacy', `${id} has an unknown txType: ${c.txType}`);
    if (c.nativeGasLimit !== undefined) {
      assert.ok(Number.isInteger(c.nativeGasLimit) && c.nativeGasLimit > 21000, `${id} nativeGasLimit invalid: ${c.nativeGasLimit}`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
