/**
 * Live RPC smoke check for every EVM chain in networks.js. NOT a unit test (it
 * hits the network and is not part of the offline suite) — run it on demand:
 *
 *     node test/rpc-smoke.mjs
 *
 * For each EVM chain it verifies the two things the engine's EVM leg assumes,
 * which "EVM-compatible" alone does not guarantee:
 *   1. the endpoint is live AND its eth_chainId matches the configured chainId
 *      (catches dead / keyed / wrong-network / typo'd RPCs — the most likely
 *      real-world failure for a freshly added chain), and
 *   2. the latest block carries baseFeePerGas, i.e. the chain supports EIP-1559
 *      type-2 txs — which is exactly what evmSignSend builds. A "no-1559" chain
 *      is a compatibility WARN, not a config error.
 *
 * It spends no funds and signs nothing. A chainId MISMATCH is a hard FAIL (exit
 * 1); an unreachable RPC or a no-1559 chain is a WARN (could be transient/geo or
 * an engine-compat gap) and does not fail the run.
 */
import { CHAINS } from '../app/actions/lib/networks.js';

const TIMEOUT_MS = 9000;
const CONCURRENCY = 6;

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}

async function probe(id, cfg) {
  try {
    const got = parseInt(await rpc(cfg.rpc, 'eth_chainId', []), 16);
    if (got !== cfg.chainId) {
      return { id, status: 'FAIL', note: `chainId mismatch: configured ${cfg.chainId}, RPC reports ${got}` };
    }
    let has1559 = null;
    try {
      const blk = await rpc(cfg.rpc, 'eth_getBlockByNumber', ['latest', false]);
      has1559 = !!(blk && blk.baseFeePerGas != null);
    } catch { /* chainId already proved liveness; treat 1559 as unknown */ }
    if (has1559 === false) {
      return { id, status: 'WARN', note: `chainId ${got} OK, but no EIP-1559 baseFeePerGas — engine builds type-2 txs (compat risk)` };
    }
    return { id, status: 'OK', note: `chainId ${got}, 1559 ${has1559 === null ? 'unknown' : 'yes'}` };
  } catch (err) {
    return { id, status: 'WARN', note: `unreachable: ${err.message}` };
  }
}

async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

const evm = Object.entries(CHAINS).filter(([, c]) => c.family === 'evm');
console.log(`Live EVM RPC smoke — ${evm.length} chains\n`);

const results = await pooled(evm, CONCURRENCY, ([id, cfg]) => probe(id, cfg));
const icon = { OK: ' ok ', WARN: 'warn', FAIL: 'FAIL' };
for (const r of results.sort((a, b) => a.status.localeCompare(b.status) || a.id.localeCompare(b.id))) {
  console.log(`  [${icon[r.status]}]  ${r.id.padEnd(14)} ${r.note}`);
}

const fails = results.filter((r) => r.status === 'FAIL').length;
const warns = results.filter((r) => r.status === 'WARN').length;
const oks = results.filter((r) => r.status === 'OK').length;
console.log(`\n${oks} ok, ${warns} warn, ${fails} fail (chainId mismatch)`);
process.exit(fails > 0 ? 1 : 0);
