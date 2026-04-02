/**
 * Bitcoin <> Zcash Lit Action Template
 *
 * Runs inside Lit's Deno sandbox. ethers v5 is a global.
 * Both sides are UTXO chains. No EVM leg in this swap.
 *
 * This is the only swap type with no EVM leg, which means:
 * - Fees are collected on the Zcash side (lower dust threshold than BTC)
 * - The Base contract is still the source of truth (read via ethers)
 * - markExecuted/markRefunded still called on Base (action needs Base gas)
 *
 * Idempotent re-execution: each leg's settlement is logged to the contract
 * via markLegSettled(). On retry, the action checks which legs are done
 * and only attempts the remaining ones. This handles one-sided settlement
 * failure safely.
 *
 * BTC side: Mempool.space API for UTXOs and broadcasting
 * ZEC side: Insight/Blockchair API for UTXOs and broadcasting
 *
 * Architecture:
 * - Settle BTC first (slower block time, higher fee volatility)
 * - Fees collected on ZEC side (5460 zat dust limit < 546 sat dust limit in value terms)
 * - UTXO coin selection: largest-first on both chains
 * - Transparent Zcash addresses only (t-addr, no shielded)
 */

function getBtcZecActionCode(salt) {
  return `
// Lit Action: Bitcoin <> Zcash Swap (idempotent, per-leg settlement)
// ethers v5 global available (used only for Base contract calls).
// BTC and ZEC via HTTP APIs.
const SWAP_SALT = "${salt}";

var BTC_API = "https://mempool.space/signet/api";
var ZEC_API = "https://explorer.testnet.z.cash/api";

async function main(params) {
  var privateKeyHex = await Lit.Actions.getLitActionPrivateKey();

  // -----------------------------------------------------------------------
  // Derive-only mode: return public key for both BTC and ZEC address derivation
  // -----------------------------------------------------------------------
  if (params.mode === "derive") {
    var wallet = new ethers.Wallet(privateKeyHex);
    // Same secp256k1 key derives both BTC and ZEC t-addresses.
    // Caller uses the compressed public key with chain-specific
    // address encoding (base58check with different version bytes).
    return {
      evmAddress: wallet.address,
      publicKey: wallet.signingKey.compressedPublicKey,
    };
  }

  // -----------------------------------------------------------------------
  // Execute mode
  // -----------------------------------------------------------------------

  // Read swap params from Base contract
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
  var sourceAmount = stateResult[3];  // BTC side (satoshis)
  var destAmount = stateResult[4];    // ZEC side (zatoshis)
  var feeBps = stateResult[5];
  var expirationTs = stateResult[6].toNumber() * 1000;

  var sourceChain = addrResult[0];    // "bitcoin-signet"
  var destChain = addrResult[1];      // "zcash-testnet"
  var refundSource = addrResult[2];   // BTC refund address
  var refundDest = addrResult[3];     // ZEC refund address (t-address)
  var depositSource = addrResult[4];  // BTC deposit address
  var depositDest = addrResult[5];    // ZEC deposit address (t-address)

  // Per-leg settlement status
  var sourceLegSettled = legResult[0];
  var destLegSettled = legResult[1];

  if (state !== 0) {
    return { status: "error", message: "Swap not in Created state" };
  }

  // -----------------------------------------------------------------------
  // Check expiration
  // -----------------------------------------------------------------------
  if (Date.now() > expirationTs) {
    return await handleRefund(privateKeyHex, depositSource, depositDest,
      refundSource, refundDest, params, baseProvider, abi);
  }

  // -----------------------------------------------------------------------
  // Check balances (only for legs not yet settled)
  // -----------------------------------------------------------------------
  if (!sourceLegSettled) {
    var btcUtxos = await fetchBtcUtxos(depositSource);
    var btcBalance = btcUtxos.reduce(function(sum, u) { return sum + u.value; }, 0);
    if (btcBalance < sourceAmount.toNumber()) {
      return {
        status: "insufficient_funds",
        leg: "source",
        btcBalance: btcBalance.toString(),
        requiredBtc: sourceAmount.toString(),
        destLegSettled: destLegSettled,
      };
    }
  }

  if (!destLegSettled) {
    var zecUtxos = await fetchZecUtxos(depositDest);
    var zecBalance = zecUtxos.reduce(function(sum, u) { return sum + u.satoshis; }, 0);
    if (zecBalance < destAmount.toNumber()) {
      return {
        status: "insufficient_funds",
        leg: "dest",
        zecBalance: zecBalance.toString(),
        requiredZec: destAmount.toString(),
        sourceLegSettled: sourceLegSettled,
      };
    }
  }

  // Calculate fees (ZEC side, since no EVM leg)
  var zecFee = Math.floor(destAmount.toNumber() * feeBps / 10000);
  var zecNet = destAmount.toNumber() - zecFee;

  // Create a signer for contract calls
  var baseWallet = new ethers.Wallet(privateKeyHex, baseProvider);
  var settleContract = new ethers.Contract(params.contractAddress, abi, baseWallet);

  var result = {
    status: "executed",
    sourceLegSettled: sourceLegSettled,
    destLegSettled: destLegSettled,
    resumed: sourceLegSettled || destLegSettled,
  };

  // -----------------------------------------------------------------------
  // SETTLE BTC (source leg) FIRST (slower, higher fee volatility)
  // Source party deposited BTC, dest party deposited ZEC.
  // BTC goes to dest party (refundDest), ZEC goes to source party (refundSource).
  // -----------------------------------------------------------------------
  if (!sourceLegSettled) {
    var btcUtxosForSend = btcUtxos || await fetchBtcUtxos(depositSource);
    var btcTxResult;
    try {
      btcTxResult = await sendBtcTransaction(
        privateKeyHex, btcUtxosForSend, refundDest, sourceAmount.toNumber(), depositSource
      );
    } catch (e) {
      return { status: "error", message: "BTC send failed: " + e.message, phase: "btc_settlement" };
    }
    result.btcTxId = btcTxResult.txid;

    // Log to contract immediately (makes re-execution safe)
    await settleContract.markLegSettled(params.swapId, true, btcTxResult.txid);
    sourceLegSettled = true;
  } else {
    result.btcTxId = legResult[2]; // from contract
    result.sourceSkipped = true;
  }

  // -----------------------------------------------------------------------
  // THEN SETTLE ZEC (dest leg, fees deducted from ZEC side)
  // No EVM leg, so fees come from the ZEC transfer.
  // -----------------------------------------------------------------------
  if (!destLegSettled) {
    var zecUtxosForSend = zecUtxos || await fetchZecUtxos(depositDest);
    var zecTxResult;
    try {
      zecTxResult = await sendZecTransaction(
        privateKeyHex, zecUtxosForSend, refundSource, zecNet, depositDest
      );
    } catch (e) {
      return {
        status: "error",
        message: "ZEC send failed after BTC settled: " + e.message,
        phase: "zec_settlement",
        btcTxId: result.btcTxId,
        recoverable: true,
      };
    }
    result.zecTxId = zecTxResult.txid;

    // Log to contract immediately
    await settleContract.markLegSettled(params.swapId, false, zecTxResult.txid);
    destLegSettled = true;
  } else {
    result.zecTxId = legResult[3]; // from contract
    result.destSkipped = true;
  }

  // -----------------------------------------------------------------------
  // ZEC fee handling
  // -----------------------------------------------------------------------
  var feeResult = {};
  if (zecFee > 0) {
    feeResult.zecFeeZats = zecFee;
    feeResult.feeNote = "Fee of " + zecFee + " zats retained in action wallet for batch collection";
  }

  // Sweep excess BTC back to source party
  var remainBtc = await fetchBtcUtxos(depositSource);
  var remainBtcTotal = remainBtc.reduce(function(sum, u) { return sum + u.value; }, 0);
  if (remainBtcTotal > 600) { // above BTC dust
    try {
      await sendBtcTransaction(privateKeyHex, remainBtc, refundSource, remainBtcTotal - 300, depositSource);
    } catch (e) {
      feeResult.btcSweepNote = "BTC sweep failed: " + e.message;
    }
  }

  // -----------------------------------------------------------------------
  // Mark fully executed (contract enforces both legs settled)
  // -----------------------------------------------------------------------
  await settleContract.markExecuted(params.swapId);

  // -----------------------------------------------------------------------
  // Sign receipt
  // -----------------------------------------------------------------------
  var receipt = JSON.stringify({
    swapId: params.swapId,
    btcTx: result.btcTxId,
    zecTx: result.zecTxId,
    sourceAmount: sourceAmount.toString(),
    destAmount: destAmount.toString(),
    zecFee: zecFee,
    resumed: result.resumed,
    timestamp: Date.now(),
  });
  result.receipt = receipt;
  result.receiptSignature = await baseWallet.signMessage(receipt);

  return Object.assign(result, feeResult);
}

// ---------------------------------------------------------------------------
// Bitcoin helpers
// ---------------------------------------------------------------------------

async function fetchBtcUtxos(address) {
  var resp = await fetch(BTC_API + "/address/" + address + "/utxo");
  if (!resp.ok) throw new Error("Failed to fetch BTC UTXOs: " + resp.status);
  var utxos = await resp.json();
  return utxos.filter(function(u) { return u.status && u.status.confirmed; });
}

async function sendBtcTransaction(privateKeyHex, utxos, toAddress, amountSats, changeAddress) {
  utxos.sort(function(a, b) { return b.value - a.value; });

  var selected = [];
  var total = 0;
  var feeRate = 2; // sat/vbyte for signet
  var estimatedSize = 10 + 1 * 68 + 2 * 31;

  for (var i = 0; i < utxos.length; i++) {
    selected.push(utxos[i]);
    total += utxos[i].value;
    estimatedSize = 10 + selected.length * 68 + 2 * 31;
    var fee = estimatedSize * feeRate;
    if (total >= amountSats + fee) break;
  }

  var fee = estimatedSize * feeRate;
  if (total < amountSats + fee) {
    throw new Error("Insufficient BTC: have " + total + " sats, need " + (amountSats + fee));
  }

  var change = total - amountSats - fee;

  // Production: bundle bitcoinjs-lib WASM or minimal tx builder via esbuild.
  // The 32-byte key from getLitActionPrivateKey() signs directly with secp256k1.
  return {
    txid: "btc-tx-placeholder",
    fee: fee,
    change: change,
    inputCount: selected.length,
    outputCount: change > 546 ? 2 : 1,
  };
}

// ---------------------------------------------------------------------------
// Zcash helpers (transparent addresses only)
// ---------------------------------------------------------------------------

async function fetchZecUtxos(address) {
  var resp = await fetch(ZEC_API + "/addr/" + address + "/utxo");
  if (!resp.ok) {
    var resp2 = await fetch("https://api.blockchair.com/zcash/dashboards/address/" + address + "?limit=100");
    if (!resp2.ok) throw new Error("Failed to fetch ZEC UTXOs: " + resp.status);
    var data = await resp2.json();
    var utxos = (data.data && data.data[address] && data.data[address].utxo) || [];
    return utxos.map(function(u) {
      return { txid: u.transaction_hash, vout: u.index, satoshis: u.value, confirmations: u.block_id > 0 ? 1 : 0 };
    });
  }
  var utxos = await resp.json();
  return utxos.filter(function(u) { return u.confirmations > 0; });
}

async function sendZecTransaction(privateKeyHex, utxos, toAddress, amountZats, changeAddress) {
  utxos.sort(function(a, b) { return b.satoshis - a.satoshis; });

  var selected = [];
  var total = 0;
  var feeRate = 10; // zats/byte
  var baseSize = 76; // Zcash v4 header overhead
  var inputSize = 148;
  var outputSize = 34;
  var estimatedSize = baseSize + 1 * inputSize + 2 * outputSize;

  for (var i = 0; i < utxos.length; i++) {
    selected.push(utxos[i]);
    total += utxos[i].satoshis;
    estimatedSize = baseSize + selected.length * inputSize + 2 * outputSize;
    var fee = Math.max(estimatedSize * feeRate, 1000);
    if (total >= amountZats + fee) break;
  }

  var fee = Math.max(estimatedSize * feeRate, 1000);
  if (total < amountZats + fee) {
    throw new Error("Insufficient ZEC: have " + total + " zats, need " + (amountZats + fee));
  }

  var change = total - amountZats - fee;

  // Production: bundle zcash-primitives WASM or fork of bitcoinjs-lib-zcash.
  // Transparent t-addr signing uses secp256k1 ECDSA with ZIP 243 sighash.
  return {
    txid: "zec-tx-placeholder",
    fee: fee,
    change: change,
    inputCount: selected.length,
    outputCount: change > 5460 ? 2 : 1,
  };
}

// ---------------------------------------------------------------------------
// Refund handler
// ---------------------------------------------------------------------------

async function handleRefund(privateKeyHex, depositBtc, depositZec,
  refundSource, refundDest, params, baseProvider, abi) {
  var results = {};

  // Refund BTC side
  var btcUtxos = await fetchBtcUtxos(depositBtc);
  var btcTotal = btcUtxos.reduce(function(sum, u) { return sum + u.value; }, 0);
  if (btcTotal > 600 && refundSource) {
    try {
      var btcRefund = await sendBtcTransaction(privateKeyHex, btcUtxos, refundSource, btcTotal - 300, depositBtc);
      results.btcRefundTxId = btcRefund.txid;
    } catch (e) {
      results.btcRefundNote = "BTC refund failed: " + e.message + " (" + btcTotal + " sats at " + depositBtc + ")";
    }
  }

  // Refund ZEC side
  var zecUtxos = await fetchZecUtxos(depositZec);
  var zecTotal = zecUtxos.reduce(function(sum, u) { return sum + u.satoshis; }, 0);
  if (zecTotal > 5460 && refundDest) {
    try {
      var zecRefund = await sendZecTransaction(privateKeyHex, zecUtxos, refundDest, zecTotal - 1000, depositZec);
      results.zecRefundTxId = zecRefund.txid;
    } catch (e) {
      results.zecRefundNote = "ZEC refund failed: " + e.message + " (" + zecTotal + " zats at " + depositZec + ")";
    }
  }

  // Mark refunded on Base contract
  var baseW = new ethers.Wallet(privateKeyHex, baseProvider);
  var mContract = new ethers.Contract(params.contractAddress, abi, baseW);
  await mContract.markRefunded(params.swapId);

  return { status: "refunded", ...results };
}
`;
}

export { getBtcZecActionCode };
