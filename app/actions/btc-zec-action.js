/**
 * Bitcoin <> Zcash Lit Action Template
 *
 * Runs inside Lit's Deno sandbox. ethers v5 is a global.
 * Both sides are UTXO chains. No EVM leg in this swap.
 * Uses real bitcoinjs-lib for both BTC and ZEC transaction construction.
 *
 * This is the only swap type with no EVM leg, which means:
 * - Fees are collected on the Zcash side (lower dust threshold than BTC)
 * - The Base contract is still the source of truth (read via ethers)
 * - markExecuted/markRefunded still called on Base (action needs Base gas)
 *
 * Idempotent re-execution via per-leg settlement logging.
 *
 * BTC: Mempool.space API + bitcoinjs-lib (P2WPKH native SegWit)
 * ZEC: Insight API + bitcoinjs-lib with Zcash network params (P2PKH)
 *
 * Architecture:
 * - Settle BTC first (slower block time, higher fee volatility)
 * - Fees collected on ZEC side (5460 zat dust < 546 sat dust in value terms)
 * - UTXO coin selection: largest-first on both chains
 * - Transparent Zcash addresses only (t-addr, no shielded)
 */

function getBtcZecActionCode(salt) {
  return `
import * as bitcoin from "https://cdn.jsdelivr.net/npm/bitcoinjs-lib@7.0.0-rc.0/+esm";
import * as ecc from "https://cdn.jsdelivr.net/npm/tiny-secp256k1@2.2.3/+esm";
import { ECPairFactory } from "https://cdn.jsdelivr.net/npm/ecpair@3.0.0-rc.0/+esm";

// Lit Action: Bitcoin <> Zcash Swap (idempotent, per-leg settlement)
// ethers v5 global available (used only for Base contract calls).
// BTC and ZEC via bitcoinjs-lib + HTTP APIs.
const SWAP_SALT = "${salt}";

var BTC_API = "https://mempool.space/signet/api";
var ZEC_API = "https://explorer.testnet.z.cash/api";
var ECPair = ECPairFactory(ecc);

// Zcash testnet network parameters
var zcashTestnet = {
  messagePrefix: "\\x18Zcash Signed Message:\\n",
  bech32: "ztestsapling",
  bip32: { public: 0x043587cf, private: 0x04358394 },
  pubKeyHash: 0x1d25,
  scriptHash: 0x1cba,
  wif: 0xef,
};

async function main(params) {
  var privateKeyHex = await Lit.Actions.getLitActionPrivateKey();
  var keyBytes = Uint8Array.from(Buffer.from(privateKeyHex.replace("0x", ""), "hex"));

  // -----------------------------------------------------------------------
  // Derive-only mode
  // -----------------------------------------------------------------------
  if (params.mode === "derive") {
    var evmWallet = new ethers.Wallet(privateKeyHex);

    var btcKeyPair = ECPair.fromPrivateKey(Buffer.from(keyBytes), { network: bitcoin.networks.testnet });
    var p2wpkh = bitcoin.payments.p2wpkh({ pubkey: btcKeyPair.publicKey, network: bitcoin.networks.testnet });

    var zecKeyPair = ECPair.fromPrivateKey(Buffer.from(keyBytes), { network: zcashTestnet });
    var p2pkh = bitcoin.payments.p2pkh({ pubkey: zecKeyPair.publicKey, network: zcashTestnet });

    return {
      evmAddress: evmWallet.address,
      btcAddress: p2wpkh.address,
      zecAddress: p2pkh.address,
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

  var state = stateResult[0];
  var sourceAmount = stateResult[3];  // BTC (satoshis)
  var destAmount = stateResult[4];    // ZEC (zatoshis)
  var feeBps = stateResult[5];
  var expirationTs = stateResult[6].toNumber() * 1000;

  var refundSource = addrResult[2];   // BTC refund
  var refundDest = addrResult[3];     // ZEC refund (t-address)
  var depositSource = addrResult[4];  // BTC deposit
  var depositDest = addrResult[5];    // ZEC deposit (t-address)

  var sourceLegSettled = legResult[0];
  var destLegSettled = legResult[1];

  if (state !== 0) return { status: "error", message: "Swap not in Created state" };

  // -----------------------------------------------------------------------
  // Expiration
  // -----------------------------------------------------------------------
  if (Date.now() > expirationTs) {
    return await handleRefund(privateKeyHex, keyBytes, depositSource, depositDest,
      refundSource, refundDest, params, baseProvider, abi);
  }

  // -----------------------------------------------------------------------
  // Check balances (unsettled legs only)
  // -----------------------------------------------------------------------
  var btcUtxos;
  if (!sourceLegSettled) {
    btcUtxos = await fetchBtcUtxos(depositSource);
    var btcBalance = btcUtxos.reduce(function(s, u) { return s + u.value; }, 0);
    if (btcBalance < sourceAmount.toNumber()) {
      return { status: "insufficient_funds", leg: "source", btcBalance: btcBalance.toString(),
        requiredBtc: sourceAmount.toString(), destLegSettled: destLegSettled };
    }
  }

  var zecUtxos;
  if (!destLegSettled) {
    zecUtxos = await fetchZecUtxos(depositDest);
    var zecBalance = zecUtxos.reduce(function(s, u) { return s + u.satoshis; }, 0);
    if (zecBalance < destAmount.toNumber()) {
      return { status: "insufficient_funds", leg: "dest", zecBalance: zecBalance.toString(),
        requiredZec: destAmount.toString(), sourceLegSettled: sourceLegSettled };
    }
  }

  // Fees on ZEC side (no EVM leg)
  var zecFee = Math.floor(destAmount.toNumber() * feeBps / 10000);
  var zecNet = destAmount.toNumber() - zecFee;

  var baseWallet = new ethers.Wallet(privateKeyHex, baseProvider);
  var settleContract = new ethers.Contract(params.contractAddress, abi, baseWallet);

  var result = {
    status: "executed",
    sourceLegSettled: sourceLegSettled,
    destLegSettled: destLegSettled,
    resumed: sourceLegSettled || destLegSettled,
  };

  // -----------------------------------------------------------------------
  // SETTLE BTC (source leg) FIRST
  // BTC goes to dest party (refundDest), ZEC goes to source party (refundSource)
  // -----------------------------------------------------------------------
  if (!sourceLegSettled) {
    btcUtxos = btcUtxos || await fetchBtcUtxos(depositSource);
    var btcTxResult = await buildAndBroadcastBtcTx(
      keyBytes, btcUtxos, refundDest, sourceAmount.toNumber(), depositSource
    );
    result.btcTxId = btcTxResult.txid;
    await settleContract.markLegSettled(params.swapId, true, btcTxResult.txid);
    sourceLegSettled = true;
  } else {
    result.btcTxId = legResult[2];
    result.sourceSkipped = true;
  }

  // -----------------------------------------------------------------------
  // THEN SETTLE ZEC (dest leg, fees deducted from ZEC side)
  // -----------------------------------------------------------------------
  if (!destLegSettled) {
    zecUtxos = zecUtxos || await fetchZecUtxos(depositDest);
    var zecTxResult = await buildAndBroadcastZecTx(
      keyBytes, zecUtxos, refundSource, zecNet, depositDest
    );
    result.zecTxId = zecTxResult.txid;
    await settleContract.markLegSettled(params.swapId, false, zecTxResult.txid);
    destLegSettled = true;
  } else {
    result.zecTxId = legResult[3];
    result.destSkipped = true;
  }

  if (zecFee > 0) {
    result.zecFeeZats = zecFee;
    result.feeNote = "Fee of " + zecFee + " zats retained in action wallet for batch collection";
  }

  // Sweep excess BTC
  var remainBtc = await fetchBtcUtxos(depositSource);
  var remainBtcTotal = remainBtc.reduce(function(s, u) { return s + u.value; }, 0);
  if (remainBtcTotal > 600) {
    try {
      var feeRate = await getBtcFeeRate();
      var sweepFee = (11 + remainBtc.length * 68 + 31) * feeRate;
      await buildAndBroadcastBtcTx(keyBytes, remainBtc, refundSource, remainBtcTotal - sweepFee, depositSource);
    } catch (e) {
      result.btcSweepNote = "BTC sweep failed: " + e.message;
    }
  }

  // Mark executed
  await settleContract.markExecuted(params.swapId);

  // Sign receipt
  var receipt = JSON.stringify({
    swapId: params.swapId, btcTx: result.btcTxId, zecTx: result.zecTxId,
    sourceAmount: sourceAmount.toString(), destAmount: destAmount.toString(),
    zecFee: zecFee, resumed: result.resumed, timestamp: Date.now(),
  });
  result.receipt = receipt;
  result.receiptSignature = await baseWallet.signMessage(receipt);
  return result;
}

// ---------------------------------------------------------------------------
// Bitcoin helpers
// ---------------------------------------------------------------------------

async function fetchBtcUtxos(address) {
  var resp = await fetch(BTC_API + "/address/" + address + "/utxo");
  if (!resp.ok) throw new Error("Failed to fetch BTC UTXOs: " + resp.status);
  return (await resp.json()).filter(function(u) { return u.status && u.status.confirmed; });
}

async function getBtcFeeRate() {
  try {
    var resp = await fetch(BTC_API + "/v1/fees/recommended");
    if (resp.ok) return (await resp.json()).halfHourFee || 2;
  } catch (e) {}
  return 2;
}

async function buildAndBroadcastBtcTx(keyBytes, utxos, toAddress, amountSats, changeAddress) {
  var keyPair = ECPair.fromPrivateKey(Buffer.from(keyBytes), { network: bitcoin.networks.testnet });
  var p2wpkh = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: bitcoin.networks.testnet });
  var feeRate = await getBtcFeeRate();

  utxos.sort(function(a, b) { return b.value - a.value; });

  var selected = [];
  var total = 0;
  for (var i = 0; i < utxos.length; i++) {
    selected.push(utxos[i]);
    total += utxos[i].value;
    var estFee = (11 + selected.length * 68 + 2 * 31) * feeRate;
    if (total >= amountSats + estFee) break;
  }

  var txFee = (11 + selected.length * 68 + 2 * 31) * feeRate;
  if (total < amountSats + txFee) {
    throw new Error("Insufficient BTC: have " + total + ", need " + (amountSats + txFee));
  }

  var change = total - amountSats - txFee;
  var psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });

  for (var j = 0; j < selected.length; j++) {
    psbt.addInput({
      hash: selected[j].txid,
      index: selected[j].vout,
      witnessUtxo: { script: p2wpkh.output, value: selected[j].value },
    });
  }

  psbt.addOutput({ address: toAddress, value: amountSats });
  if (change > 546) psbt.addOutput({ address: changeAddress, value: change });

  for (var k = 0; k < selected.length; k++) psbt.signInput(k, keyPair);
  psbt.finalizeAllInputs();

  var resp = await fetch(BTC_API + "/tx", {
    method: "POST", headers: { "Content-Type": "text/plain" },
    body: psbt.extractTransaction().toHex(),
  });
  if (!resp.ok) throw new Error("BTC broadcast failed: " + (await resp.text()));
  return { txid: (await resp.text()).trim(), fee: txFee, change: change };
}

// ---------------------------------------------------------------------------
// Zcash helpers
// ---------------------------------------------------------------------------

async function fetchZecUtxos(address) {
  var resp = await fetch(ZEC_API + "/addr/" + address + "/utxo");
  if (!resp.ok) {
    var resp2 = await fetch("https://api.blockchair.com/zcash/dashboards/address/" + address + "?limit=100");
    if (!resp2.ok) throw new Error("Failed to fetch ZEC UTXOs: " + resp.status);
    var data = await resp2.json();
    return ((data.data && data.data[address] && data.data[address].utxo) || []).map(function(u) {
      return { txid: u.transaction_hash, vout: u.index, satoshis: u.value, confirmations: 1 };
    });
  }
  return (await resp.json()).filter(function(u) { return u.confirmations > 0; });
}

async function buildAndBroadcastZecTx(keyBytes, utxos, toAddress, amountZats, changeAddress) {
  var keyPair = ECPair.fromPrivateKey(Buffer.from(keyBytes), { network: zcashTestnet });
  var p2pkh = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: zcashTestnet });

  utxos.sort(function(a, b) { return b.satoshis - a.satoshis; });

  var selected = [];
  var total = 0;
  var feeRate = 10;

  for (var i = 0; i < utxos.length; i++) {
    selected.push(utxos[i]);
    total += utxos[i].satoshis;
    var estFee = Math.max((10 + selected.length * 148 + 2 * 34) * feeRate, 1000);
    if (total >= amountZats + estFee) break;
  }

  var txFee = Math.max((10 + selected.length * 148 + 2 * 34) * feeRate, 1000);
  if (total < amountZats + txFee) {
    throw new Error("Insufficient ZEC: have " + total + ", need " + (amountZats + txFee));
  }

  var change = total - amountZats - txFee;
  var psbt = new bitcoin.Psbt({ network: zcashTestnet });

  for (var j = 0; j < selected.length; j++) {
    psbt.addInput({
      hash: selected[j].txid,
      index: selected[j].vout,
      witnessUtxo: { script: p2pkh.output, value: selected[j].satoshis },
    });
  }

  psbt.addOutput({ address: toAddress, value: amountZats });
  if (change > 5460) psbt.addOutput({ address: changeAddress, value: change });

  for (var k = 0; k < selected.length; k++) psbt.signInput(k, keyPair);
  psbt.finalizeAllInputs();

  var resp = await fetch(ZEC_API + "/tx/send", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rawtx: psbt.extractTransaction().toHex() }),
  });
  if (!resp.ok) throw new Error("ZEC broadcast failed: " + (await resp.text()));
  var result = await resp.json();
  return { txid: result.txid || result, fee: txFee, change: change };
}

// ---------------------------------------------------------------------------
// Refund handler
// ---------------------------------------------------------------------------

async function handleRefund(privateKeyHex, keyBytes, depositBtc, depositZec,
  refundSource, refundDest, params, baseProvider, abi) {
  var results = {};

  // Refund BTC
  var btcUtxos = await fetchBtcUtxos(depositBtc);
  var btcTotal = btcUtxos.reduce(function(s, u) { return s + u.value; }, 0);
  if (btcTotal > 600 && refundSource) {
    try {
      var feeRate = await getBtcFeeRate();
      var btcFee = (11 + btcUtxos.length * 68 + 31) * feeRate;
      var r = await buildAndBroadcastBtcTx(keyBytes, btcUtxos, refundSource, btcTotal - btcFee, depositBtc);
      results.btcRefundTxId = r.txid;
    } catch (e) { results.btcRefundNote = "BTC refund failed: " + e.message; }
  }

  // Refund ZEC
  var zecUtxos = await fetchZecUtxos(depositZec);
  var zecTotal = zecUtxos.reduce(function(s, u) { return s + u.satoshis; }, 0);
  if (zecTotal > 5460 && refundDest) {
    try {
      var zecFee = Math.max((10 + zecUtxos.length * 148 + 34) * 10, 1000);
      var r2 = await buildAndBroadcastZecTx(keyBytes, zecUtxos, refundDest, zecTotal - zecFee, depositZec);
      results.zecRefundTxId = r2.txid;
    } catch (e) { results.zecRefundNote = "ZEC refund failed: " + e.message; }
  }

  var baseW = new ethers.Wallet(privateKeyHex, baseProvider);
  var refContract = new ethers.Contract(params.contractAddress, abi, baseW);
  await refContract.markRefunded(params.swapId);
  return { status: "refunded", ...results };
}
`;
}

export { getBtcZecActionCode };
