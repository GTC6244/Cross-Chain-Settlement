/**
 * Zcash leg — blockbook provider parsing tests.
 *
 * The ZIP-243 sign/serialize path needs the Lit sandbox + a node (covered by
 * .context/zec-verify). What CAN be unit-tested in Node is the provider I/O
 * parsing — the blockbook branches of zecFetchUtxos / zecConfirmations /
 * zecBroadcast — which is exactly where a field-name or shape mistake would
 * silently break a live settle. We load the exact embedded zecLegSrc() string
 * (single source of truth) and drive it with a mock fetch.
 *
 * The string has one top-level statement (`var ZEC_B58 = base58check(sha256)`)
 * that runs at construction, so we pass harmless stubs for the crypto symbols;
 * the blockbook functions under test only use fetch + BigInt.
 */
import { zecLegSrc } from '../app/actions/lib/zec-leg.js';
import { strict as assert } from 'assert';

let lastReq = null;
function mockFetch(url, opts) {
  lastReq = { url, opts: opts || {} };
  return MOCK_HANDLER(url, opts || {});
}
let MOCK_HANDLER = () => { throw new Error('no handler set'); };
function resp(status, jsonBody, textBody) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof jsonBody === 'function' ? jsonBody() : jsonBody),
    text: async () => (textBody != null ? textBody : JSON.stringify(jsonBody)),
  });
}

// base58check(sha256) runs at construction → stub returns a dummy codec.
const stubB58 = () => ({ encode: () => 't-stub', decode: () => new Uint8Array(22) });
const Z = new Function(
  'fetch', 'base58check', 'sha256',
  zecLegSrc() + '\n; return { zecFetchUtxos: zecFetchUtxos, zecConfirmations: zecConfirmations, zecBroadcast: zecBroadcast };'
)(mockFetch, stubB58, () => new Uint8Array(32));

const cfg = { api: { style: 'blockbook', base: 'https://bb.test', apiKeyHeader: 'api-key', apiKey: 'secret-k' } };

let passed = 0, failed = 0;
const TESTS = [];
function test(name, fn) { TESTS.push([name, fn]); }

test('utxo: maps value→BigInt, filters unconfirmed, sends api-key header + ?confirmed=true', async () => {
  MOCK_HANDLER = () => resp(200, [
    { txid: 'aa', vout: 0, value: '100000', confirmations: 3 },
    { txid: 'bb', vout: 1, value: '50000', confirmations: 0 }, // unconfirmed → dropped
  ]);
  const out = await Z.zecFetchUtxos(cfg, 'tmAddr');
  assert.equal(out.length, 1, 'unconfirmed utxo must be filtered out');
  assert.equal(out[0].txid, 'aa');
  assert.equal(out[0].vout, 0);
  assert.equal(out[0].amount, 100000n);
  assert.equal(typeof out[0].amount, 'bigint');
  assert.ok(lastReq.url.includes('/api/v2/utxo/tmAddr'), 'hits blockbook utxo path');
  assert.ok(lastReq.url.includes('confirmed=true'), 'requests confirmed-only');
  assert.equal(lastReq.opts.headers['api-key'], 'secret-k', 'attaches the api key header');
});

test('utxo: throws on a non-200 (so the engine retries rather than treating empty as done)', async () => {
  MOCK_HANDLER = () => resp(502, null, 'bad gateway');
  await assert.rejects(() => Z.zecFetchUtxos(cfg, 'tmAddr'), /blockbook utxo failed/);
});

test('confirmations: returns the numeric count from /api/v2/tx', async () => {
  MOCK_HANDLER = () => resp(200, { txid: 'cc', confirmations: 7 });
  assert.equal(await Z.zecConfirmations(cfg, 'cc'), 7);
  assert.ok(lastReq.url.includes('/api/v2/tx/cc'));
});

test('confirmations: fail-closed — returns 0 on a lookup error (never a false-confirm)', async () => {
  MOCK_HANDLER = () => resp(404, null, 'not found');
  assert.equal(await Z.zecConfirmations(cfg, 'missing'), 0);
});

test('broadcast: POSTs raw hex to /api/v2/sendtx and returns the result txid', async () => {
  MOCK_HANDLER = () => resp(200, { result: 'broadcast-txid' });
  const txid = await Z.zecBroadcast(cfg, 'deadbeef');
  assert.equal(txid, 'broadcast-txid');
  assert.ok(lastReq.url.endsWith('/api/v2/sendtx/'));
  assert.equal(lastReq.opts.method, 'POST');
  assert.equal(lastReq.opts.body, 'deadbeef');
  assert.equal(lastReq.opts.headers['api-key'], 'secret-k');
  assert.equal(lastReq.opts.headers['Content-Type'], 'text/plain');
});

test('broadcast: throws on a blockbook {error} (consensus reject) instead of returning it', async () => {
  MOCK_HANDLER = () => resp(200, { error: { message: 'tx-already-known' } });
  await assert.rejects(() => Z.zecBroadcast(cfg, 'deadbeef'), /blockbook broadcast failed/);
});

// ---- Tatum style: RPC gateway (zcashd-compatible) for broadcast/confirm/
// branch-id; UTXO listing delegates to api.utxoApi because the gateway has no
// address index and Tatum's Data API doesn't serve Zcash (verified live). ----
const cfgTatum = { decimals: 8, api: { style: 'tatum',
  rpc: 'https://zcash-testnet.gateway.tatum.io', apiKey: 'tatum-k' } };

test('tatum utxo: throws a clear error when no api.utxoApi source is configured', async () => {
  MOCK_HANDLER = () => resp(200, []);
  await assert.rejects(() => Z.zecFetchUtxos(cfgTatum, 'tmAddr'), /no UTXO source/);
});

test('tatum utxo: delegates to api.utxoApi (blockbook) for listing', async () => {
  const cfgHybrid = { decimals: 8, api: { style: 'tatum',
    rpc: 'https://zcash-testnet.gateway.tatum.io', apiKey: 'tatum-k',
    utxoApi: { style: 'blockbook', base: 'https://bb.test', apiKeyHeader: 'api-key', apiKey: 'bb-k' } } };
  MOCK_HANDLER = () => resp(200, [{ txid: 'cc', vout: 0, value: '70000', confirmations: 2 }]);
  const out = await Z.zecFetchUtxos(cfgHybrid, 'tmAddr');
  assert.equal(out.length, 1);
  assert.equal(out[0].txid, 'cc');
  assert.equal(out[0].amount, 70000n);
  assert.ok(lastReq.url.includes('/api/v2/utxo/tmAddr'), 'delegated to the blockbook utxo endpoint');
  assert.equal(lastReq.opts.headers['api-key'], 'bb-k', 'uses the delegated provider key, not the tatum key');
});

test('tatum broadcast: JSON-RPC sendrawtransaction via the gateway, x-api-key', async () => {
  MOCK_HANDLER = (url, opts) => { const b = JSON.parse(opts.body); return resp(200, { result: b.method === 'sendrawtransaction' ? 'ta-txid' : null }); };
  const txid = await Z.zecBroadcast(cfgTatum, 'deadbeef');
  assert.equal(txid, 'ta-txid');
  assert.equal(lastReq.url, 'https://zcash-testnet.gateway.tatum.io');
  assert.equal(lastReq.opts.method, 'POST');
  assert.equal(JSON.parse(lastReq.opts.body).method, 'sendrawtransaction');
  assert.equal(lastReq.opts.headers['x-api-key'], 'tatum-k');
});

test('tatum confirmations: getrawtransaction verbose via the gateway', async () => {
  MOCK_HANDLER = () => resp(200, { result: { confirmations: 5 } });
  assert.equal(await Z.zecConfirmations(cfgTatum, 'cc'), 5);
  assert.equal(JSON.parse(lastReq.opts.body).method, 'getrawtransaction');
});

test('tatum broadcast: surfaces a JSON-RPC error (consensus reject)', async () => {
  MOCK_HANDLER = () => resp(200, { error: { code: -26, message: 'mandatory-script-verify-flag-failed' } });
  await assert.rejects(() => Z.zecBroadcast(cfgTatum, 'deadbeef'), /mandatory-script-verify/);
});

// Sequential runner — these assert on the shared lastReq, so they must not
// interleave.
console.log('Zcash blockbook provider Tests\n');
for (const [name, fn] of TESTS) {
  try { await fn(); console.log('  PASS  ' + name); passed++; }
  catch (err) { console.log('  FAIL  ' + name + '\n        ' + (err.stack || err.message)); failed++; }
}
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
