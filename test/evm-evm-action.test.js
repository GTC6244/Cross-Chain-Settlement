/**
 * Tests for the EVM <> EVM Lit Action
 * Uses the mock harness to test action logic without Lit network.
 */

import { createLitRuntime, executeAction } from './lit-harness.js';
import { strict as assert } from 'assert';
import { ethers } from 'ethers';

// Get the action code from the web app's swap engine
// We extract the getEvmEvmActionCode function and call it
const TEST_SALT = 'test-salt-abc123';

function getActionCode() {
  // Inline the action code template (same as app/swap-engine.js getEvmEvmActionCode)
  return `
const SWAP_SALT = "${TEST_SALT}";

async function main(params) {
  var privateKeyHex = await Lit.Actions.getLitActionPrivateKey();

  if (params.mode === "derive") {
    var wallet = new ethers.Wallet(privateKeyHex);
    return {
      evmAddress: wallet.address,
      publicKey: wallet.signingKey.compressedPublicKey,
    };
  }

  var baseProvider = new ethers.providers.JsonRpcProvider(params.baseRpcUrl);
  var abi = [
    "function getSwapState(uint256) view returns (uint8,address,address,uint256,uint256,uint16,uint256,string)",
    "function getSwapAddresses(uint256) view returns (string,string,string,string,string,string,uint256)",
    "function owner() view returns (address)"
  ];
  var contract = new ethers.Contract(params.contractAddress, abi, baseProvider);

  var stateResult = await contract.getSwapState(params.swapId);
  var addrResult = await contract.getSwapAddresses(params.swapId);
  var feeRecipient = await contract.owner();

  var state = stateResult[0];
  var sourceAmount = stateResult[3];
  var destAmount = stateResult[4];
  var feeBps = stateResult[5];
  var expirationTs = stateResult[6].toNumber() * 1000;

  var sourceChain = addrResult[0];
  var destChain = addrResult[1];
  var refundSource = addrResult[2];
  var refundDest = addrResult[3];
  var depositSource = addrResult[4];
  var depositDest = addrResult[5];

  var rpcMap = {
    "base-sepolia": "https://sepolia.base.org",
    "ethereum-sepolia": "https://rpc.sepolia.org",
  };

  var sourceRpc = rpcMap[sourceChain];
  var destRpc = rpcMap[destChain];

  if (!sourceRpc || !destRpc) {
    return { status: "error", message: "Unknown chain" };
  }

  if (state !== 0) {
    return { status: "error", message: "Swap not in Created state" };
  }

  if (Date.now() > expirationTs) {
    var refResults = {};
    var srcProv = new ethers.providers.JsonRpcProvider(sourceRpc);
    var srcBal = await srcProv.getBalance(depositSource);
    if (srcBal.gt(0) && refundSource) {
      var w = new ethers.Wallet(privateKeyHex, srcProv);
      var gp = await srcProv.getGasPrice();
      var gc = gp.mul(21000);
      var ra = srcBal.sub(gc);
      if (ra.gt(0)) {
        var tx = await w.sendTransaction({ to: refundSource, value: ra, gasLimit: 21000 });
        refResults.sourceRefundHash = tx.hash;
      }
    }
    var baseWallet = new ethers.Wallet(privateKeyHex, baseProvider);
    var markAbi = ["function markRefunded(uint256)"];
    var markContract = new ethers.Contract(params.contractAddress, markAbi, baseWallet);
    await markContract.markRefunded(params.swapId);
    return { status: "refunded", ...refResults };
  }

  var srcProvider = new ethers.providers.JsonRpcProvider(sourceRpc);
  var dstProvider = new ethers.providers.JsonRpcProvider(destRpc);
  var srcBalance = await srcProvider.getBalance(depositSource);
  var dstBalance = await dstProvider.getBalance(depositDest);

  if (srcBalance.lt(sourceAmount) || dstBalance.lt(destAmount)) {
    return {
      status: "insufficient_funds",
      sourceBalance: srcBalance.toString(),
      destBalance: dstBalance.toString(),
      requiredSource: sourceAmount.toString(),
      requiredDest: destAmount.toString(),
    };
  }

  var fee = sourceAmount.mul(feeBps).div(10000);
  var sourceNet = sourceAmount.sub(fee);

  var srcWallet = new ethers.Wallet(privateKeyHex, srcProvider);
  var txSrc = await srcWallet.sendTransaction({ to: refundDest, value: sourceNet });
  var dstWallet = new ethers.Wallet(privateKeyHex, dstProvider);
  var txDst = await dstWallet.sendTransaction({ to: refundSource, value: destAmount });

  var feeResult = {};
  if (fee.gt(0)) {
    var txFee = await srcWallet.sendTransaction({ to: feeRecipient, value: fee });
    feeResult.feeHash = txFee.hash;
  }

  var baseW = new ethers.Wallet(privateKeyHex, baseProvider);
  var mAbi = ["function markExecuted(uint256)"];
  var mContract = new ethers.Contract(params.contractAddress, mAbi, baseW);
  await mContract.markExecuted(params.swapId);

  return {
    status: "executed",
    sourceTxHash: txSrc.hash,
    destTxHash: txDst.hash,
    ...feeResult,
  };
}
`;
}

// Mock BigNumber helper for contract state
function bn(v) {
  return { _value: BigInt(v), toNumber() { return Number(this._value); }, toString() { return this._value.toString(); },
    mul(o) { return bn(this._value * (typeof o === 'object' ? o._value : BigInt(o))); },
    div(o) { return bn(this._value / (typeof o === 'object' ? o._value : BigInt(o))); },
    sub(o) { return bn(this._value - (typeof o === 'object' ? o._value : BigInt(o))); },
    add(o) { return bn(this._value + (typeof o === 'object' ? o._value : BigInt(o))); },
    gt(o) { return this._value > (typeof o === 'object' ? o._value : BigInt(o)); },
    lt(o) { return this._value < (typeof o === 'object' ? o._value : BigInt(o)); },
    eq(o) { return this._value === (typeof o === 'object' ? o._value : BigInt(o)); },
  };
}

const depositAddr = '0xDeposit1234567890123456789012345678901234';
const refundSrc = '0xRefundSrc0000000000000000000000000000001';
const refundDst = '0xRefundDst0000000000000000000000000000002';
const ownerAddr = '0xOwner0000000000000000000000000000000003';

function makeContractState(overrides = {}) {
  return {
    swapState: [
      overrides.state ?? 0,                    // state: Created
      '0x0000000000000000000000000000000000000000', // creator
      '0x0000000000000000000000000000000000000000', // litActionEvmAddress
      bn(overrides.sourceAmount ?? '1000000000000000000'), // 1 ETH
      bn(overrides.destAmount ?? '500000000000000000'),    // 0.5 ETH
      overrides.feeBps ?? 100,                 // 1%
      bn(overrides.expirationTs ?? Math.floor(Date.now() / 1000) + 3600), // 1 hour from now
      'QmTestCid',
    ],
    swapAddresses: [
      'base-sepolia',
      'ethereum-sepolia',
      refundSrc,
      refundDst,
      depositAddr,
      depositAddr,
      bn(1),
    ],
    owner: ownerAddr,
  };
}

const baseParams = {
  mode: 'execute',
  swapId: 0,
  baseRpcUrl: 'https://base.rpc',
  contractAddress: '0xContract',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

console.log('EVM <> EVM Lit Action Tests\n');

await test('derive mode returns EVM address and public key', async () => {
  const runtime = createLitRuntime();
  const result = await executeAction(getActionCode(), { mode: 'derive' }, runtime);
  assert.ok(result.evmAddress.startsWith('0x'));
  assert.ok(result.publicKey.startsWith('0x'));
  assert.equal(result.evmAddress.length, 42);
});

await test('derive mode address is deterministic for same key', async () => {
  const key = 'a'.repeat(64);
  const r1 = createLitRuntime({ privateKey: key });
  const r2 = createLitRuntime({ privateKey: key });
  const res1 = await executeAction(getActionCode(), { mode: 'derive' }, r1);
  const res2 = await executeAction(getActionCode(), { mode: 'derive' }, r2);
  assert.equal(res1.evmAddress, res2.evmAddress);
});

await test('insufficient funds returns correct status', async () => {
  const runtime = createLitRuntime({
    balances: { [depositAddr]: '100' }, // way too low
    contractState: makeContractState(),
  });
  const result = await executeAction(getActionCode(), baseParams, runtime);
  assert.equal(result.status, 'insufficient_funds');
  assert.ok(result.sourceBalance);
  assert.ok(result.requiredSource);
});

await test('happy path executes swap and marks executed', async () => {
  const sentTxs = [];
  const runtime = createLitRuntime({
    balances: { [depositAddr]: '2000000000000000000' }, // 2 ETH on both chains
    contractState: makeContractState(),
    sentTxs,
  });
  const result = await executeAction(getActionCode(), baseParams, runtime);
  assert.equal(result.status, 'executed');
  assert.ok(result.sourceTxHash);
  assert.ok(result.destTxHash);
  assert.ok(result.feeHash); // 1% fee

  // Verify transactions were sent
  const sendTxs = sentTxs.filter(t => t.to);
  assert.ok(sendTxs.length >= 3); // source + dest + fee

  // Verify markExecuted was called
  const markTx = sentTxs.find(t => t.type === 'markExecuted');
  assert.ok(markTx);
});

await test('zero fee skips fee transaction', async () => {
  const sentTxs = [];
  const runtime = createLitRuntime({
    balances: { [depositAddr]: '2000000000000000000' },
    contractState: makeContractState({ feeBps: 0 }),
    sentTxs,
  });
  const result = await executeAction(getActionCode(), baseParams, runtime);
  assert.equal(result.status, 'executed');
  assert.equal(result.feeHash, undefined);
  // Should have source + dest + markExecuted but no fee tx
  const feeTxs = sentTxs.filter(t => t.to === ownerAddr);
  assert.equal(feeTxs.length, 0);
});

await test('expired swap triggers refund', async () => {
  const sentTxs = [];
  const runtime = createLitRuntime({
    balances: { [depositAddr]: '1000000000000000000' },
    contractState: makeContractState({
      expirationTs: Math.floor(Date.now() / 1000) - 100, // expired 100s ago
    }),
    sentTxs,
  });
  const result = await executeAction(getActionCode(), baseParams, runtime);
  assert.equal(result.status, 'refunded');

  // Verify markRefunded was called
  const markTx = sentTxs.find(t => t.type === 'markRefunded');
  assert.ok(markTx);
});

await test('expired swap with no deposits still marks refunded', async () => {
  const sentTxs = [];
  const runtime = createLitRuntime({
    balances: {}, // no deposits
    contractState: makeContractState({
      expirationTs: Math.floor(Date.now() / 1000) - 100,
    }),
    sentTxs,
  });
  const result = await executeAction(getActionCode(), baseParams, runtime);
  assert.equal(result.status, 'refunded');
  assert.equal(result.sourceRefundHash, undefined); // nothing to refund
});

await test('non-Created state returns error', async () => {
  const runtime = createLitRuntime({
    contractState: makeContractState({ state: 2 }), // Executed
  });
  const result = await executeAction(getActionCode(), baseParams, runtime);
  assert.equal(result.status, 'error');
  assert.ok(result.message.includes('not in Created state'));
});

await test('fee is deducted from source side only', async () => {
  const sentTxs = [];
  const runtime = createLitRuntime({
    balances: { [depositAddr]: '2000000000000000000' },
    contractState: makeContractState({
      sourceAmount: '1000000000000000000', // 1 ETH
      destAmount: '500000000000000000',    // 0.5 ETH
      feeBps: 100,                          // 1%
    }),
    sentTxs,
  });
  const result = await executeAction(getActionCode(), baseParams, runtime);
  assert.equal(result.status, 'executed');

  // Source send should be 0.99 ETH (1 ETH - 1% fee)
  const srcSend = sentTxs.find(t => t.to === refundDst && t.rpcUrl === 'https://sepolia.base.org');
  assert.ok(srcSend);
  assert.equal(srcSend.value, '990000000000000000');

  // Dest send should be full 0.5 ETH (no fee deduction)
  const dstSend = sentTxs.find(t => t.to === refundSrc && t.rpcUrl === 'https://rpc.sepolia.org');
  assert.ok(dstSend);
  assert.equal(dstSend.value, '500000000000000000');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
