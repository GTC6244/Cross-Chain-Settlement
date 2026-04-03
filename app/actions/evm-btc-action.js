/**
 * EVM <> Bitcoin Lit Action Template
 *
 * Runs inside Lit's Deno sandbox. ethers v5 is a global.
 * Bitcoin transaction construction uses real bitcoinjs-lib via jsdelivr ESM imports.
 *
 * Idempotent re-execution: each leg's settlement is logged to the contract
 * via markLegSettled(). On retry, the action checks which legs are done
 * and only attempts the remaining ones.
 *
 * BTC side uses Mempool.space API for:
 * - UTXO queries (GET /address/{addr}/utxo)
 * - Fee rate estimates (GET /api/v1/fees/recommended)
 * - Transaction broadcasting (POST /api/tx)
 *
 * Architecture:
 * - Settle BTC first (slower, higher risk)
 * - Fees collected on EVM side only
 * - UTXO coin selection: largest-first
 * - P2WPKH (native SegWit) addresses for lower fees
 */

function getEvmBtcActionCode(salt) {
  return `
import * as bitcoin from "https://cdn.jsdelivr.net/npm/bitcoinjs-lib@7.0.0-rc.0/+esm";
import * as ecc from "https://cdn.jsdelivr.net/npm/tiny-secp256k1@2.2.3/+esm";
import { ECPairFactory } from "https://cdn.jsdelivr.net/npm/ecpair@3.0.0-rc.0/+esm";

// Lit Action: EVM <> Bitcoin Swap (idempotent, per-leg settlement)
// ethers v5 global available. BTC via bitcoinjs-lib + Mempool.space API.
const SWAP_SALT = "${salt}";

var BTC_API = "https://mempool.space/signet/api";
var ECPair = ECPairFactory(ecc);

async function main(params) {
  var privateKeyHex = await Lit.Actions.getLitActionPrivateKey();
  var keyBytes = Uint8Array.from(Buffer.from(privateKeyHex.replace("0x", ""), "hex"));

  // -----------------------------------------------------------------------
  // Derive-only mode
  // -----------------------------------------------------------------------
  if (params.mode === "derive") {
    var evmWallet = new ethers.Wallet(privateKeyHex);
    var keyPair = ECPair.fromPrivateKey(Buffer.from(keyBytes), { network: bitcoin.networks.testnet });
    var p2wpkh = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: bitcoin.networks.testnet });
    return {
      evmAddress: evmWallet.address,
      btcAddress: p2wpkh.address,
      publicKey: evmWallet.signingKey.compressedPublicKey,
    };
  }

  // -----------------------------------------------------------------------
  // Execute mode
  // -----------------------------------------------------------------------
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
  var sourceAmount = stateResult[3];  // EVM (wei)
  var destAmount = stateResult[4];    // BTC (satoshis)
  var feeBps = stateResult[5];
  var expirationTs = stateResult[6].toNumber() * 1000;

  var sourceChain = addrResult[0];
  var destChain = addrResult[1];
  var refundSource = addrResult[2];   // EVM refund
  var refundDest = addrResult[3];     // BTC refund
  var depositSource = addrResult[4];  // EVM deposit
  var depositDest = addrResult[5];    // BTC deposit

  var sourceLegSettled = legResult[0];
  var destLegSettled = legResult[1];

  var rpcMap = {
    "base-sepolia": "https://sepolia.base.org",
    "ethereum-sepolia": "https://rpc.sepolia.org",
    "arbitrum-sepolia": "https://sepolia-rollup.arbitrum.io/rpc",
    "optimism-sepolia": "https://sepolia.optimism.io",
  };

  var evmRpc = rpcMap[sourceChain];
  if (!evmRpc) return { status: "error", message: "Unknown EVM chain: " + sourceChain };
  if (state !== 0) return { status: "error", message: "Swap not in Created state" };

  // -----------------------------------------------------------------------
  // Expiration -> refund
  // -----------------------------------------------------------------------
  if (Date.now() > expirationTs) {
    return await handleRefund(privateKeyHex, keyBytes, evmRpc, depositSource, depositDest,
      refundSource, refundDest, params, baseProvider, abi);
  }

  // -----------------------------------------------------------------------
  // Check balances (only unsettled legs)
  // -----------------------------------------------------------------------
  var evmProvider = new ethers.providers.JsonRpcProvider(evmRpc);

  if (!sourceLegSettled) {
    var evmBalance = await evmProvider.getBalance(depositSource);
    if (evmBalance.lt(sourceAmount)) {
      return { status: "insufficient_funds", leg: "source", evmBalance: evmBalance.toString(),
        requiredEvm: sourceAmount.toString(), destLegSettled: destLegSettled };
    }
  }

  var btcUtxos;
  if (!destLegSettled) {
    btcUtxos = await fetchUtxos(depositDest);
    var btcBalance = btcUtxos.reduce(function(s, u) { return s + u.value; }, 0);
    if (btcBalance < destAmount.toNumber()) {
      return { status: "insufficient_funds", leg: "dest", btcBalance: btcBalance.toString(),
        requiredBtc: destAmount.toString(), sourceLegSettled: sourceLegSettled };
    }
  }

  var fee = sourceAmount.mul(feeBps).div(10000);
  var evmNet = sourceAmount.sub(fee);

  var baseWallet = new ethers.Wallet(privateKeyHex, baseProvider);
  var settleContract = new ethers.Contract(params.contractAddress, abi, baseWallet);

  var result = {
    status: "executed",
    sourceLegSettled: sourceLegSettled,
    destLegSettled: destLegSettled,
    resumed: sourceLegSettled || destLegSettled,
  };

  // -----------------------------------------------------------------------
  // SETTLE BTC (dest leg) FIRST
  // -----------------------------------------------------------------------
  if (!destLegSettled) {
    btcUtxos = btcUtxos || await fetchUtxos(depositDest);
    var btcTxResult = await buildAndBroadcastBtcTx(
      keyBytes, btcUtxos, refundSource, destAmount.toNumber(), depositDest
    );
    result.btcTxId = btcTxResult.txid;
    await settleContract.markLegSettled(params.swapId, false, btcTxResult.txid);
    destLegSettled = true;
  } else {
    result.btcTxId = legResult[3];
    result.destSkipped = true;
  }

  // -----------------------------------------------------------------------
  // THEN SETTLE EVM (source leg)
  // -----------------------------------------------------------------------
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

  // Sweep excess EVM
  var remainEvm = await evmProvider.getBalance(depositSource);
  if (remainEvm.gt(0)) {
    var evmW = new ethers.Wallet(privateKeyHex, evmProvider);
    var gp = await evmProvider.getGasPrice();
    var gc = gp.mul(21000);
    var sweep = remainEvm.sub(gc);
    if (sweep.gt(0)) await evmW.sendTransaction({ to: refundSource, value: sweep, gasLimit: 21000 });
  }

  // Mark executed
  await settleContract.markExecuted(params.swapId);

  // Sign receipt
  var receipt = JSON.stringify({
    swapId: params.swapId, evmTx: result.evmTxHash, btcTx: result.btcTxId,
    sourceAmount: sourceAmount.toString(), destAmount: destAmount.toString(),
    fee: fee.toString(), resumed: result.resumed, timestamp: Date.now(),
  });
  result.receipt = receipt;
  result.receiptSignature = await baseWallet.signMessage(receipt);
  return result;
}

// ---------------------------------------------------------------------------
// Bitcoin transaction construction (real, using bitcoinjs-lib)
// ---------------------------------------------------------------------------

async function fetchUtxos(address) {
  var resp = await fetch(BTC_API + "/address/" + address + "/utxo");
  if (!resp.ok) throw new Error("Failed to fetch UTXOs: " + resp.status);
  var utxos = await resp.json();
  return utxos.filter(function(u) { return u.status && u.status.confirmed; });
}

async function getFeeRate() {
  try {
    var resp = await fetch(BTC_API + "/v1/fees/recommended");
    if (resp.ok) {
      var fees = await resp.json();
      return fees.halfHourFee || 2;
    }
  } catch (e) {}
  return 2; // fallback: 2 sat/vbyte for signet
}

async function fetchTxHex(txid) {
  var resp = await fetch(BTC_API + "/tx/" + txid + "/hex");
  if (!resp.ok) throw new Error("Failed to fetch tx hex: " + txid);
  return await resp.text();
}

async function buildAndBroadcastBtcTx(keyBytes, utxos, toAddress, amountSats, changeAddress) {
  var keyPair = ECPair.fromPrivateKey(Buffer.from(keyBytes), { network: bitcoin.networks.testnet });
  var p2wpkh = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: bitcoin.networks.testnet });
  var feeRate = await getFeeRate();

  // Sort largest-first
  utxos.sort(function(a, b) { return b.value - a.value; });

  // Coin selection
  var selected = [];
  var total = 0;
  // SegWit input ~68 vbytes, output ~31 vbytes, overhead ~11 vbytes
  for (var i = 0; i < utxos.length; i++) {
    selected.push(utxos[i]);
    total += utxos[i].value;
    var estVsize = 11 + selected.length * 68 + 2 * 31;
    var estFee = estVsize * feeRate;
    if (total >= amountSats + estFee) break;
  }

  var vsize = 11 + selected.length * 68 + 2 * 31;
  var txFee = vsize * feeRate;
  if (total < amountSats + txFee) {
    throw new Error("Insufficient BTC: have " + total + " sats, need " + (amountSats + txFee));
  }

  var change = total - amountSats - txFee;

  // Build PSBT
  var psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });

  for (var j = 0; j < selected.length; j++) {
    var utxo = selected[j];
    // For SegWit inputs, we need the full previous tx or witnessUtxo
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: p2wpkh.output,
        value: utxo.value,
      },
    });
  }

  // Recipient output
  psbt.addOutput({ address: toAddress, value: amountSats });

  // Change output (skip if dust)
  if (change > 546) {
    psbt.addOutput({ address: changeAddress, value: change });
  }

  // Sign all inputs
  for (var k = 0; k < selected.length; k++) {
    psbt.signInput(k, keyPair);
  }

  psbt.finalizeAllInputs();
  var txHex = psbt.extractTransaction().toHex();

  // Broadcast
  var broadcastResp = await fetch(BTC_API + "/tx", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: txHex,
  });

  if (!broadcastResp.ok) {
    var errText = await broadcastResp.text();
    throw new Error("Broadcast failed: " + broadcastResp.status + " " + errText);
  }

  var txid = await broadcastResp.text();
  return { txid: txid.trim(), fee: txFee, change: change };
}

// ---------------------------------------------------------------------------
// Refund handler
// ---------------------------------------------------------------------------

async function handleRefund(privateKeyHex, keyBytes, evmRpc, depositEvm, depositBtc,
  refundSource, refundDest, params, baseProvider, abi) {
  var results = {};

  // Refund EVM
  var evmProvider = new ethers.providers.JsonRpcProvider(evmRpc);
  var evmBal = await evmProvider.getBalance(depositEvm);
  if (evmBal.gt(0) && refundSource) {
    var w = new ethers.Wallet(privateKeyHex, evmProvider);
    var gp = await evmProvider.getGasPrice();
    var gc = gp.mul(21000);
    var ra = evmBal.sub(gc);
    if (ra.gt(0)) {
      var tx = await w.sendTransaction({ to: refundSource, value: ra, gasLimit: 21000 });
      results.evmRefundHash = tx.hash;
    }
  }

  // Refund BTC
  var btcUtxos = await fetchUtxos(depositBtc);
  var btcTotal = btcUtxos.reduce(function(s, u) { return s + u.value; }, 0);
  if (btcTotal > 600 && refundDest) {
    try {
      var feeRate = await getFeeRate();
      var estFee = (11 + btcUtxos.length * 68 + 31) * feeRate;
      var refundResult = await buildAndBroadcastBtcTx(
        keyBytes, btcUtxos, refundDest, btcTotal - estFee, depositBtc
      );
      results.btcRefundTxId = refundResult.txid;
    } catch (e) {
      results.btcRefundNote = "BTC refund failed: " + e.message;
    }
  }

  // Mark refunded
  var baseW = new ethers.Wallet(privateKeyHex, baseProvider);
  var refContract = new ethers.Contract(params.contractAddress, abi, baseW);
  await refContract.markRefunded(params.swapId);
  return { status: "refunded", ...results };
}
`;
}

export { getEvmBtcActionCode };
