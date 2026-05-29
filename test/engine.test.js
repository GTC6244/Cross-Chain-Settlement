/**
 * Engine tests — drive the REAL runSwap settlement state machine (from
 * lib/engine.js) with mock legs and a mock Base writer. This exercises the
 * actual code that ships, not a simplified copy: settle order, per-leg
 * idempotency/resume, fee math + placement, refund on expiry, and excess
 * sweeping with the retain rule.
 *
 * The in-sandbox crypto (micro-eth-signer / @scure/btc-signer / micro-sol-signer
 * / the ZIP-243 shim) is NOT exercised here — those run only in the Lit runtime
 * and need live-testnet verification. The legs are mocked at their interface.
 */
import { engineSrc } from '../app/actions/lib/engine.js';
import { strict as assert } from 'assert';

// Load runSwap out of the engine source string, injecting only the globals the
// execute/derive paths actually touch (ethAddr for derive, eip191Signer for the
// receipt). ethers/EthTx/hex are unused because we inject the Base writer.
function loadRunSwap() {
  const ethAddr = { fromPrivateKey: () => '0xEvmActionAddr' };
  const eip191Signer = { sign: () => '0xReceiptSig' };
  const fn = new Function(
    'ethers', 'ethAddr', 'EthTx', 'eip191Signer', 'hex', 'Date',
    engineSrc() + '\n; return { runSwap: runSwap };'
  );
  return fn(undefined, ethAddr, undefined, eip191Signer, undefined, Date).runSwap;
}
const runSwap = loadRunSwap();

const REFUND_SRC = 'refund-source-addr';
const REFUND_DST = 'refund-dest-addr';
const DEP_SRC = 'deposit-source-addr';
const DEP_DST = 'deposit-dest-addr';
const OWNER = '0xOwner';

function mockBase(o = {}) {
  const calls = [];
  const future = Math.floor(Date.now() / 1000) + 3600;
  return {
    calls,
    read: {
      getSwapState: async () => [
        o.state ?? 0, '0xcreator', '0xlit',
        String(o.sourceAmount ?? '1000000'),
        String(o.destAmount ?? '500000'),
        o.feeBps ?? 100,
        o.expirationTs ?? future,
        'QmCid',
      ],
      getSwapAddresses: async () => [
        'source-chain', 'dest-chain', REFUND_SRC, REFUND_DST, DEP_SRC, DEP_DST, 1,
      ],
      getSwapLegs: async () => [
        o.sourceLegSettled ?? false, o.destLegSettled ?? false,
        o.sourceLegTx ?? '', o.destLegTx ?? '',
      ],
      owner: async () => OWNER,
    },
    getFeeStatus: async () => [o.feeSettled ?? false, o.feeTxHash ?? ''],
    markLegSettled: async (isSource, txid) => { calls.push({ type: 'markLegSettled', isSource, txid }); },
    markFeeSettled: async (txid) => { calls.push({ type: 'markFeeSettled', txid }); },
    markExecuted: async () => { calls.push({ type: 'markExecuted' }); },
    markRefunded: async () => { calls.push({ type: 'markRefunded' }); },
  };
}

function mockLeg(label, role, opts = {}) {
  const calls = [];
  return {
    label, role, calls,
    deriveAddress: async () => label + '-addr',
    getBalance: async () => BigInt(opts.balance ?? '1000000000'),
    settle: async (a) => { calls.push({ type: 'settle', ...a }); return label + '-settle-tx'; },
    drain: async (a) => { calls.push({ type: 'drain', ...a }); return opts.drainTx ?? null; },
    sendFee: async (a) => { calls.push({ type: 'sendFee', ...a }); return label + '-fee-tx'; },
  };
}

const ctx = { keyBytes: new Uint8Array(32), params: { mode: 'execute', swapId: 0 } };

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.stack || err.message}`); failed++; }
}

console.log('Engine (runSwap) Tests\n');

await test('happy path: settle order source->dest, fee on source paid to owner', async () => {
  const base = mockBase();
  const src = mockLeg('evm', 'source'), dst = mockLeg('eth', 'dest');
  const r = await runSwap(ctx, { settleOrder: ['source', 'dest'], feeLeg: 'source', feeMode: 'send-evm' }, src, dst, base);
  assert.equal(r.status, 'executed');
  // fee = 1000000 * 100 / 10000 = 10000; sourceNet = 990000
  const srcSettle = src.calls.find(c => c.type === 'settle');
  assert.equal(srcSettle.to, REFUND_DST);
  assert.equal(srcSettle.amount, 990000n);
  const dstSettle = dst.calls.find(c => c.type === 'settle');
  assert.equal(dstSettle.to, REFUND_SRC);
  assert.equal(dstSettle.amount, 500000n);            // no fee on dest
  const fee = src.calls.find(c => c.type === 'sendFee');
  assert.equal(fee.amount, 10000n);
  assert.equal(fee.to, OWNER);
  // markLegSettled true (source) then false (dest), markExecuted last
  const ml = base.calls.filter(c => c.type === 'markLegSettled');
  assert.equal(ml[0].isSource, true);
  assert.equal(ml[1].isSource, false);
  assert.equal(base.calls[base.calls.length - 1].type, 'markExecuted');
  assert.ok(r.receiptSignature);
});

await test('settle order dest->source is honored', async () => {
  const base = mockBase();
  const src = mockLeg('evm', 'source'), dst = mockLeg('btc', 'dest');
  await runSwap(ctx, { settleOrder: ['dest', 'source'], feeLeg: 'source', feeMode: 'send-evm' }, src, dst, base);
  const ml = base.calls.filter(c => c.type === 'markLegSettled');
  assert.equal(ml[0].isSource, false); // dest settled first
  assert.equal(ml[1].isSource, true);
});

await test('resume: source already settled -> only dest settles', async () => {
  const base = mockBase({ sourceLegSettled: true, sourceLegTx: 'prior-src-tx' });
  const src = mockLeg('evm', 'source'), dst = mockLeg('btc', 'dest');
  const r = await runSwap(ctx, { settleOrder: ['source', 'dest'], feeLeg: 'source', feeMode: 'send-evm' }, src, dst, base);
  assert.equal(r.resumed, true);
  assert.equal(r.sourceSkipped, true);
  assert.equal(r.sourceTxId, 'prior-src-tx');
  assert.equal(src.calls.filter(c => c.type === 'settle').length, 0);
  assert.equal(dst.calls.filter(c => c.type === 'settle').length, 1);
});

await test('resume: dest already settled -> only source settles', async () => {
  const base = mockBase({ destLegSettled: true, destLegTx: 'prior-dst-tx' });
  const src = mockLeg('evm', 'source'), dst = mockLeg('btc', 'dest');
  const r = await runSwap(ctx, { settleOrder: ['dest', 'source'], feeLeg: 'source', feeMode: 'send-evm' }, src, dst, base);
  assert.equal(r.destSkipped, true);
  assert.equal(r.destTxId, 'prior-dst-tx');
  assert.equal(dst.calls.filter(c => c.type === 'settle').length, 0);
  assert.equal(src.calls.filter(c => c.type === 'settle').length, 1);
});

await test('both legs settled -> only markExecuted', async () => {
  const base = mockBase({ sourceLegSettled: true, sourceLegTx: 'a', destLegSettled: true, destLegTx: 'b' });
  const src = mockLeg('evm', 'source'), dst = mockLeg('btc', 'dest');
  const r = await runSwap(ctx, { settleOrder: ['source', 'dest'], feeLeg: 'source', feeMode: 'send-evm' }, src, dst, base);
  assert.equal(r.sourceSkipped, true);
  assert.equal(r.destSkipped, true);
  assert.ok(base.calls.some(c => c.type === 'markExecuted'));
  assert.equal(base.calls.filter(c => c.type === 'markLegSettled').length, 0);
});

await test('insufficient source funds -> insufficient_funds', async () => {
  const base = mockBase({ sourceAmount: '1000000' });
  const src = mockLeg('evm', 'source', { balance: '10' }), dst = mockLeg('btc', 'dest');
  const r = await runSwap(ctx, { settleOrder: ['source', 'dest'], feeLeg: 'source', feeMode: 'send-evm' }, src, dst, base);
  assert.equal(r.status, 'insufficient_funds');
  assert.equal(r.leg, 'source');
  assert.equal(base.calls.length, 0);
});

await test('expired -> drains both legs to refunds, markRefunded', async () => {
  const base = mockBase({ expirationTs: Math.floor(Date.now() / 1000) - 100 });
  const src = mockLeg('evm', 'source', { drainTx: 'src-refund' });
  const dst = mockLeg('btc', 'dest', { drainTx: 'dst-refund' });
  const r = await runSwap(ctx, { settleOrder: ['source', 'dest'], feeLeg: 'source', feeMode: 'send-evm' }, src, dst, base);
  assert.equal(r.status, 'refunded');
  assert.equal(src.calls[0].type, 'drain');
  assert.equal(src.calls[0].to, REFUND_SRC);
  assert.equal(dst.calls[0].to, REFUND_DST);
  assert.ok(base.calls.some(c => c.type === 'markRefunded'));
});

await test('fee retain (no EVM leg): no sendFee, fee leg not swept, other leg swept', async () => {
  const base = mockBase();
  // btc-zec style: feeLeg dest, retain. dst should NOT be drained (sweep skipped); src should be.
  const src = mockLeg('btc', 'source', { drainTx: 'src-sweep' });
  const dst = mockLeg('zec', 'dest', { drainTx: 'dst-sweep' });
  const r = await runSwap(ctx, { settleOrder: ['source', 'dest'], feeLeg: 'dest', feeMode: 'retain' }, src, dst, base);
  assert.equal(r.status, 'executed');
  assert.equal(src.calls.filter(c => c.type === 'sendFee').length, 0);
  assert.equal(dst.calls.filter(c => c.type === 'sendFee').length, 0);
  assert.ok(r.feeRetained, 'feeRetained should be reported');
  // dest is the fee leg + retain -> not drained; source is swept
  assert.equal(dst.calls.filter(c => c.type === 'drain').length, 0);
  assert.equal(src.calls.filter(c => c.type === 'drain').length, 1);
  // fee deducted on dest: destNet = 500000 - (500000*100/10000=5000) = 495000
  const dstSettle = dst.calls.find(c => c.type === 'settle');
  assert.equal(dstSettle.amount, 495000n);
});

await test('derive mode returns controlled addresses', async () => {
  const base = mockBase();
  const src = mockLeg('btc', 'source'), dst = mockLeg('zec', 'dest');
  const r = await runSwap({ keyBytes: new Uint8Array(32), params: { mode: 'derive' } },
    { settleOrder: ['source', 'dest'], feeLeg: 'source', feeMode: 'retain' }, src, dst, base);
  assert.equal(r.evmAddress, '0xEvmActionAddr');
  assert.equal(r.btcAddressSource, 'btc-addr');
  assert.equal(r.zecAddressDest, 'zec-addr');
});

await test('insufficient DEST funds -> insufficient_funds leg=dest', async () => {
  const base = mockBase({ destAmount: '500000' });
  const src = mockLeg('evm', 'source', { balance: '1000000000' });
  const dst = mockLeg('btc', 'dest', { balance: '10' });
  const r = await runSwap(ctx, { settleOrder: ['source', 'dest'], feeLeg: 'source', feeMode: 'send-evm' }, src, dst, base);
  assert.equal(r.status, 'insufficient_funds');
  assert.equal(r.leg, 'dest');
  assert.equal(base.calls.length, 0);
});

await test('swap not in Created state -> error, no writes', async () => {
  const base = mockBase({ state: 2 });
  const src = mockLeg('evm', 'source'), dst = mockLeg('btc', 'dest');
  const r = await runSwap(ctx, { settleOrder: ['source', 'dest'], feeLeg: 'source', feeMode: 'send-evm' }, src, dst, base);
  assert.equal(r.status, 'error');
  assert.equal(base.calls.length, 0);
});

await test('feeBps=0 -> no fee sent, net == gross, no feeRetained', async () => {
  const base = mockBase({ feeBps: 0 });
  const src = mockLeg('btc', 'source'), dst = mockLeg('zec', 'dest');
  const r = await runSwap(ctx, { settleOrder: ['source', 'dest'], feeLeg: 'source', feeMode: 'retain' }, src, dst, base);
  assert.equal(r.status, 'executed');
  assert.equal(src.calls.find(c => c.type === 'settle').amount, 1000000n); // full gross
  assert.equal(src.calls.filter(c => c.type === 'sendFee').length, 0);
  assert.equal(r.feeRetained, undefined);
});

await test('EVM leg is NOT swept after settle (no double-spend)', async () => {
  const base = mockBase();
  const src = mockLeg('evm', 'source', { drainTx: 'should-not-happen' });
  const dst = mockLeg('btc', 'dest', { drainTx: 'btc-sweep' });
  const r = await runSwap(ctx, { settleOrder: ['source', 'dest'], feeLeg: 'source', feeMode: 'send-evm' }, src, dst, base);
  assert.equal(r.status, 'executed');
  assert.equal(src.calls.filter(c => c.type === 'drain').length, 0, 'EVM leg must not be drained');
  assert.equal(dst.calls.filter(c => c.type === 'drain').length, 1, 'UTXO leg should be swept');
});

await test('settle failure throws and does NOT markExecuted', async () => {
  const base = mockBase();
  const src = mockLeg('evm', 'source');
  const dst = mockLeg('btc', 'dest');
  dst.settle = async () => { throw new Error('rpc down'); };
  let threw = false;
  try {
    await runSwap(ctx, { settleOrder: ['source', 'dest'], feeLeg: 'source', feeMode: 'send-evm' }, src, dst, base);
  } catch (e) { threw = true; }
  assert.ok(threw, 'runSwap should propagate settle failure');
  assert.equal(base.calls.filter(c => c.type === 'markExecuted').length, 0, 'must not mark executed on partial settlement');
});

await test('fee recovered on resume: legs settled but fee not yet settled', async () => {
  const base = mockBase({ sourceLegSettled: true, sourceLegTx: 'a', destLegSettled: true, destLegTx: 'b', feeSettled: false });
  const src = mockLeg('evm', 'source'), dst = mockLeg('btc', 'dest');
  const r = await runSwap(ctx, { settleOrder: ['source', 'dest'], feeLeg: 'source', feeMode: 'send-evm' }, src, dst, base);
  assert.equal(r.status, 'executed');
  assert.equal(src.calls.filter(c => c.type === 'settle').length, 0); // legs skipped
  assert.equal(src.calls.filter(c => c.type === 'sendFee').length, 1); // fee re-sent
  assert.ok(base.calls.some(c => c.type === 'markFeeSettled'));
  assert.ok(base.calls.some(c => c.type === 'markExecuted'));
});

await test('fee skipped when already settled on-chain', async () => {
  const base = mockBase({ feeSettled: true, feeTxHash: 'prior-fee-tx' });
  const src = mockLeg('evm', 'source'), dst = mockLeg('btc', 'dest');
  const r = await runSwap(ctx, { settleOrder: ['source', 'dest'], feeLeg: 'source', feeMode: 'send-evm' }, src, dst, base);
  assert.equal(r.feeSkipped, true);
  assert.equal(r.feeTxId, 'prior-fee-tx');
  assert.equal(src.calls.filter(c => c.type === 'sendFee').length, 0);
  assert.equal(base.calls.filter(c => c.type === 'markFeeSettled').length, 0);
});

await test('expiry refund_incomplete when a drain hard-fails (no markRefunded)', async () => {
  const base = mockBase({ expirationTs: Math.floor(Date.now() / 1000) - 100 });
  const src = mockLeg('evm', 'source');
  src.drain = async () => { throw new Error('rpc down'); };
  const dst = mockLeg('btc', 'dest', { drainTx: 'dst-refund' });
  const r = await runSwap(ctx, { settleOrder: ['source', 'dest'], feeLeg: 'source', feeMode: 'send-evm' }, src, dst, base);
  assert.equal(r.status, 'refund_incomplete');
  assert.equal(base.calls.filter(c => c.type === 'markRefunded').length, 0, 'must not finalize a partial refund');
});

await test('markLegSettled failure mid-run throws before markExecuted', async () => {
  const base = mockBase();
  base.markLegSettled = async () => { throw new Error('contract write reverted'); };
  const src = mockLeg('evm', 'source'), dst = mockLeg('btc', 'dest');
  let threw = false;
  try {
    await runSwap(ctx, { settleOrder: ['source', 'dest'], feeLeg: 'source', feeMode: 'send-evm' }, src, dst, base);
  } catch (e) { threw = true; }
  assert.ok(threw);
  assert.equal(base.calls.filter(c => c.type === 'markExecuted').length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
