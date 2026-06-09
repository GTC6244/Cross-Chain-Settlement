/**
 * Tests for the EVM leg's per-chain tx shaping (engine.js) — the legacy/1559
 * selection and per-chain native gas limit added so non-1559 and Arbitrum-class
 * chains can settle.
 *
 * Like engine.test.js, this loads the REAL engine source out of engineSrc() and
 * injects a mock EthTx whose prepare() captures the exact tx fields the signer
 * would build. It asserts on those fields — it does NOT exercise micro-eth-signer
 * itself (that loads from jsDelivr in the Lit runtime and needs live verification).
 */
import { engineSrc } from '../app/actions/lib/engine.js';
import { strict as assert } from 'assert';

const GWEI = 1000000000n; // mock getGasPrice returns 1 gwei

// A fresh engine instance per call (resets the module-level nonce/gasPrice
// caches), exposing evmSignSend + makeEvmLeg and the captured prepare() fields.
function makeEnv() {
  const captured = [];
  const EthTx = {
    prepare(fields) {
      captured.push(fields);
      return { signBy: () => ({ toHex: () => '0xraw', hash: '0xhash' }) };
    },
  };
  const ethers = {
    providers: {
      JsonRpcProvider: function () {
        return {
          getTransactionCount: async () => 0,
          getGasPrice: async () => ({ toString: () => String(GWEI) }),
          getBalance: async () => ({ toString: () => '5000000000000000000' }), // 5 ETH
          send: async () => '0xbroadcast',
        };
      },
    },
  };
  const ethAddr = { fromPrivateKey: () => '0xFromAddr' };
  const CHAINS = {
    base:     { family: 'evm', rpc: 'http://base', chainId: 8453 },
    metis:    { family: 'evm', rpc: 'http://metis', chainId: 1088, txType: 'legacy' },
    arbitrum: { family: 'evm', rpc: 'http://arb', chainId: 42161, nativeGasLimit: 3000000 },
  };
  const fn = new Function(
    'ethers', 'ethAddr', 'EthTx', 'eip191Signer', 'hex', 'Date', 'CHAINS',
    engineSrc() + '\n; return { evmSignSend: evmSignSend, makeEvmLeg: makeEvmLeg };'
  );
  const api = fn(ethers, ethAddr, EthTx, undefined, undefined, Date, CHAINS);
  return { ...api, captured };
}

const ctx = { keyBytes: new Uint8Array(32), params: { legRpcUrls: {} } };

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.stack || err.message}`); failed++; }
}

console.log('EVM leg per-chain tx shaping Tests\n');

// ---- evmSignSend: default (EIP-1559 type-2) — the proven path, unchanged ----
await test('default tx is EIP-1559 (maxFee 3x, maxPriority 1x, no gasPrice/type)', async () => {
  const env = makeEnv();
  await env.evmSignSend(ctx, 'http://x', 8453, '0xto', 1000n, null);
  const f = env.captured[0];
  assert.equal(f.maxFeePerGas, 3n * GWEI);
  assert.equal(f.maxPriorityFeePerGas, GWEI);
  assert.equal(f.gasPrice, undefined, 'must not set a legacy gasPrice on a 1559 tx');
  assert.equal(f.type, undefined, 'type omitted -> prepare() defaults to eip1559');
  assert.equal(f.gasLimit, 21000n);
  assert.equal(f.chainId, 8453n);
});

// ---- evmSignSend: legacy (type-0) ------------------------------------------
await test('opts.legacy builds a type-0 tx (gasPrice 2x, no maxFee fields)', async () => {
  const env = makeEnv();
  await env.evmSignSend(ctx, 'http://x', 1088, '0xto', 1000n, null, { legacy: true });
  const f = env.captured[0];
  assert.equal(f.type, 'legacy');
  assert.equal(f.gasPrice, 2n * GWEI);
  assert.equal(f.maxFeePerGas, undefined, 'legacy tx must not carry 1559 fields');
  assert.equal(f.maxPriorityFeePerGas, undefined);
  assert.equal(f.gasLimit, 21000n);
  assert.equal(f.chainId, 1088n);
});

// ---- evmSignSend: per-chain native gas limit -------------------------------
await test('opts.gasLimit overrides the native-transfer gas limit', async () => {
  const env = makeEnv();
  await env.evmSignSend(ctx, 'http://x', 42161, '0xto', 1000n, null, { gasLimit: 3000000n });
  assert.equal(env.captured[0].gasLimit, 3000000n);
});

await test('contract writes keep 200000 gas regardless of opts', async () => {
  const env = makeEnv();
  await env.evmSignSend(ctx, 'http://x', 8453, '0xc', 0n, '0xdeadbeef', { gasLimit: 3000000n });
  const f = env.captured[0];
  assert.equal(f.gasLimit, 200000n, 'data present -> contract-write headroom, not the native limit');
  assert.equal(f.data, '0xdeadbeef');
});

// ---- makeEvmLeg wires CHAINS config into the tx ----------------------------
await test('makeEvmLeg(arbitrum).settle uses nativeGasLimit, stays 1559', async () => {
  const env = makeEnv();
  const leg = env.makeEvmLeg(ctx, 'arbitrum', 'source');
  await leg.settle({ to: '0xto', amount: 1000n });
  const f = env.captured[0];
  assert.equal(f.gasLimit, 3000000n, 'arbitrum native transfer uses the raised ceiling');
  assert.equal(f.type, undefined, 'arbitrum is 1559 (no txType)');
  assert.equal(f.maxFeePerGas, 3n * GWEI);
});

await test('makeEvmLeg(metis).settle signs a legacy tx at 21000 gas', async () => {
  const env = makeEnv();
  const leg = env.makeEvmLeg(ctx, 'metis', 'dest');
  await leg.settle({ to: '0xto', amount: 1000n });
  const f = env.captured[0];
  assert.equal(f.type, 'legacy');
  assert.equal(f.gasPrice, 2n * GWEI);
  assert.equal(f.gasLimit, 21000n);
});

await test('makeEvmLeg(base).settle is the unchanged 1559 path', async () => {
  const env = makeEnv();
  const leg = env.makeEvmLeg(ctx, 'base', 'source');
  await leg.settle({ to: '0xto', amount: 1000n });
  const f = env.captured[0];
  assert.equal(f.type, undefined);
  assert.equal(f.maxFeePerGas, 3n * GWEI);
  assert.equal(f.gasLimit, 21000n);
});

// ---- drain reserves gas against the per-chain limit ------------------------
await test('drain reserve scales with the per-chain gas limit', async () => {
  const bal = 5000000000000000000n;
  // arbitrum: reserve = gasPrice * 2 * 3_000_000
  const arb = makeEnv();
  await arb.makeEvmLeg(ctx, 'arbitrum', 'source').drain({ deposit: '0xd', to: '0xto' });
  assert.equal(arb.captured[0].value, bal - GWEI * 2n * 3000000n);
  // metis (legacy): reserve = gasPrice * 2 * 21000, and the drain tx is legacy
  const met = makeEnv();
  await met.makeEvmLeg(ctx, 'metis', 'source').drain({ deposit: '0xd', to: '0xto' });
  assert.equal(met.captured[0].value, bal - GWEI * 2n * 21000n);
  assert.equal(met.captured[0].type, 'legacy');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
