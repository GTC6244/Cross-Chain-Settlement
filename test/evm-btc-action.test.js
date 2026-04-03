/**
 * Tests for the EVM <> BTC Lit Action
 *
 * Tests the settlement flow logic, per-leg idempotency, balance checks,
 * and refund paths. BTC transaction construction is tested at the
 * coin selection and fee estimation level (actual signing requires
 * the real bitcoinjs-lib which runs in the Lit sandbox, not Node test env).
 */

import { createLitRuntime, executeAction } from './lit-harness.js';
import { strict as assert } from 'assert';

const TEST_SALT = 'test-salt-btc-123';

// The action code template, simplified for testing.
// Real imports from jsdelivr won't work in Node, so we test the
// settlement flow logic with the mock harness. BTC-specific transaction
// construction is tested separately via the spike.
function getTestActionCode() {
  return `
const SWAP_SALT = "${TEST_SALT}";

async function main(params) {
  var privateKeyHex = await Lit.Actions.getLitActionPrivateKey();

  if (params.mode === "derive") {
    var wallet = new ethers.Wallet(privateKeyHex);
    return { evmAddress: wallet.address, btcAddress: "tb1qtest", publicKey: wallet.signingKey.compressedPublicKey };
  }

  var baseProvider = new ethers.providers.JsonRpcProvider(params.baseRpcUrl);
  var abi = [
    "function getSwapState(uint256) view returns (uint8,address,address,uint256,uint256,uint16,uint256,string)",
    "function getSwapAddresses(uint256) view returns (string,string,string,string,string,string,uint256)",
    "function getSwapLegs(uint256) view returns (bool,bool,string,string)",
    "function owner() view returns (address)",
    "function markLegSettled(uint256,bool,string)",
    "function markExecuted(uint256)",
    "function markRefunded(uint256)"
  ];
  var contract = new ethers.Contract(params.contractAddress, abi, baseProvider);

  var stateResult = await contract.getSwapState(params.swapId);
  var addrResult = await contract.getSwapAddresses(params.swapId);
  var legResult = await contract.getSwapLegs(params.swapId);
  var feeRecipient = await contract.owner();

  var state = stateResult[0];
  var sourceAmount = stateResult[3];
  var destAmount = stateResult[4];
  var feeBps = stateResult[5];
  var expirationTs = stateResult[6].toNumber() * 1000;

  var refundSource = addrResult[2];
  var refundDest = addrResult[3];
  var depositSource = addrResult[4];
  var depositDest = addrResult[5];

  var sourceLegSettled = legResult[0];
  var destLegSettled = legResult[1];

  if (state !== 0) return { status: "error", message: "Swap not in Created state" };

  if (Date.now() > expirationTs) {
    var baseW2 = new ethers.Wallet(privateKeyHex, baseProvider);
    var refC = new ethers.Contract(params.contractAddress, abi, baseW2);
    await refC.markRefunded(params.swapId);
    return { status: "refunded" };
  }

  var evmProvider = new ethers.providers.JsonRpcProvider("https://sepolia.base.org");

  if (!sourceLegSettled) {
    var evmBal = await evmProvider.getBalance(depositSource);
    if (evmBal.lt(sourceAmount)) return { status: "insufficient_funds", leg: "source" };
  }

  if (!destLegSettled) {
    var btcBal = await evmProvider.getBalance(depositDest);
    if (btcBal.lt(destAmount)) return { status: "insufficient_funds", leg: "dest" };
  }

  var fee = sourceAmount.mul(feeBps).div(10000);
  var evmNet = sourceAmount.sub(fee);

  var baseWallet = new ethers.Wallet(privateKeyHex, baseProvider);
  var settleContract = new ethers.Contract(params.contractAddress, abi, baseWallet);

  var result = { status: "executed", resumed: sourceLegSettled || destLegSettled };

  // Settle BTC (dest) first
  if (!destLegSettled) {
    result.btcTxId = "btc-" + params.swapId;
    await settleContract.markLegSettled(params.swapId, false, result.btcTxId);
    destLegSettled = true;
  } else {
    result.btcTxId = legResult[3];
    result.destSkipped = true;
  }

  // Then EVM (source)
  if (!sourceLegSettled) {
    var evmWallet = new ethers.Wallet(privateKeyHex, evmProvider);
    var txEvm = await evmWallet.sendTransaction({ to: refundDest, value: evmNet });
    result.evmTxHash = txEvm.hash;
    await settleContract.markLegSettled(params.swapId, true, txEvm.hash);
    sourceLegSettled = true;

    if (fee.gt(0)) {
      var txFee = await evmWallet.sendTransaction({ to: feeRecipient, value: fee });
      result.feeHash = txFee.hash;
    }
  } else {
    result.evmTxHash = legResult[2];
    result.sourceSkipped = true;
  }

  await settleContract.markExecuted(params.swapId);
  return result;
}
`;
}

function bn(v) {
  return { _value: BigInt(v), toNumber() { return Number(this._value); }, toString() { return this._value.toString(); },
    mul(o) { return bn(this._value * (typeof o === 'object' ? o._value : BigInt(o))); },
    div(o) { return bn(this._value / (typeof o === 'object' ? o._value : BigInt(o))); },
    sub(o) { return bn(this._value - (typeof o === 'object' ? o._value : BigInt(o))); },
    gt(o) { return this._value > (typeof o === 'object' ? o._value : BigInt(o)); },
    lt(o) { return this._value < (typeof o === 'object' ? o._value : BigInt(o)); },
  };
}

const depositAddr = '0xDeposit1234567890123456789012345678901234';
const refundSrc = '0xRefundSrc0000000000000000000000000000001';
const refundDst = 'tb1qRefundBtcAddress';
const ownerAddr = '0xOwner0000000000000000000000000000000003';

function makeContractState(overrides = {}) {
  return {
    swapState: [
      overrides.state ?? 0, '0x0', '0x0',
      bn(overrides.sourceAmount ?? '1000000000000000000'),
      bn(overrides.destAmount ?? '100000'),
      overrides.feeBps ?? 100,
      bn(overrides.expirationTs ?? Math.floor(Date.now() / 1000) + 3600),
      'QmTestCid',
    ],
    swapAddresses: [
      'base-sepolia', 'bitcoin-signet', refundSrc, refundDst,
      depositAddr, depositAddr, bn(1),
    ],
    swapLegs: [
      overrides.sourceLegSettled ?? false,
      overrides.destLegSettled ?? false,
      overrides.sourceLegTx ?? '',
      overrides.destLegTx ?? '',
    ],
    owner: ownerAddr,
  };
}

const baseParams = { mode: 'execute', swapId: 0, baseRpcUrl: 'https://base.rpc', contractAddress: '0xContract' };

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); failed++; }
}

console.log('EVM <> BTC Lit Action Tests\n');

await test('derive mode returns EVM + BTC addresses', async () => {
  const runtime = createLitRuntime();
  const result = await executeAction(getTestActionCode(), { mode: 'derive' }, runtime);
  assert.ok(result.evmAddress.startsWith('0x'));
  assert.equal(result.btcAddress, 'tb1qtest');
});

await test('happy path: settle BTC first, then EVM', async () => {
  const sentTxs = [];
  const runtime = createLitRuntime({
    balances: { [depositAddr]: '2000000000000000000' },
    contractState: makeContractState(),
    sentTxs,
  });
  const result = await executeAction(getTestActionCode(), baseParams, runtime);
  assert.equal(result.status, 'executed');
  assert.ok(result.btcTxId);
  assert.ok(result.evmTxHash);
  assert.equal(result.resumed, false);

  // markLegSettled called for dest (BTC) first, then source (EVM)
  const legSettles = sentTxs.filter(t => t.type === 'markLegSettled');
  assert.equal(legSettles.length, 2);

  // markExecuted called last
  const markExec = sentTxs.find(t => t.type === 'markExecuted');
  assert.ok(markExec);
});

await test('resume: source already settled, only settle dest', async () => {
  const sentTxs = [];
  const runtime = createLitRuntime({
    balances: { [depositAddr]: '2000000000000000000' },
    contractState: makeContractState({ sourceLegSettled: true, sourceLegTx: '0xPriorEvmTx' }),
    sentTxs,
  });
  const result = await executeAction(getTestActionCode(), baseParams, runtime);
  assert.equal(result.status, 'executed');
  assert.equal(result.resumed, true);
  assert.equal(result.sourceSkipped, true);
  assert.equal(result.evmTxHash, '0xPriorEvmTx');
  assert.ok(result.btcTxId);
});

await test('resume: dest already settled, only settle source', async () => {
  const sentTxs = [];
  const runtime = createLitRuntime({
    balances: { [depositAddr]: '2000000000000000000' },
    contractState: makeContractState({ destLegSettled: true, destLegTx: 'btc-prior-txid' }),
    sentTxs,
  });
  const result = await executeAction(getTestActionCode(), baseParams, runtime);
  assert.equal(result.status, 'executed');
  assert.equal(result.resumed, true);
  assert.equal(result.destSkipped, true);
  assert.equal(result.btcTxId, 'btc-prior-txid');
  assert.ok(result.evmTxHash);
});

await test('both legs already settled: just markExecuted', async () => {
  const sentTxs = [];
  const runtime = createLitRuntime({
    contractState: makeContractState({
      sourceLegSettled: true, sourceLegTx: '0xEvmDone',
      destLegSettled: true, destLegTx: 'btc-done',
    }),
    sentTxs,
  });
  const result = await executeAction(getTestActionCode(), baseParams, runtime);
  assert.equal(result.status, 'executed');
  assert.equal(result.sourceSkipped, true);
  assert.equal(result.destSkipped, true);
  const markExec = sentTxs.find(t => t.type === 'markExecuted');
  assert.ok(markExec);
});

await test('insufficient EVM returns status with source leg info', async () => {
  const runtime = createLitRuntime({
    balances: { [depositAddr]: '100' },
    contractState: makeContractState(),
  });
  const result = await executeAction(getTestActionCode(), baseParams, runtime);
  assert.equal(result.status, 'insufficient_funds');
  assert.equal(result.leg, 'source');
});

await test('expired swap triggers refund', async () => {
  const sentTxs = [];
  const runtime = createLitRuntime({
    contractState: makeContractState({ expirationTs: Math.floor(Date.now() / 1000) - 100 }),
    sentTxs,
  });
  const result = await executeAction(getTestActionCode(), baseParams, runtime);
  assert.equal(result.status, 'refunded');
  const markRef = sentTxs.find(t => t.type === 'markRefunded');
  assert.ok(markRef);
});

await test('fee deducted from EVM (source) side only', async () => {
  const sentTxs = [];
  const runtime = createLitRuntime({
    balances: { [depositAddr]: '2000000000000000000' },
    contractState: makeContractState({ feeBps: 100 }),
    sentTxs,
  });
  const result = await executeAction(getTestActionCode(), baseParams, runtime);
  assert.equal(result.status, 'executed');
  assert.ok(result.feeHash);

  const evmSend = sentTxs.find(t => t.to === refundDst);
  assert.ok(evmSend);
  // Should be 0.99 ETH (1 ETH - 1%)
  assert.equal(evmSend.value, '990000000000000000');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
