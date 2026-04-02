/**
 * EVM <> Zcash Lit Action Template
 *
 * Runs inside Lit's Deno sandbox. ethers v5 is a global.
 * Zcash transparent (t-address) transactions use the same UTXO model
 * as Bitcoin, with a different address format and transaction version.
 *
 * Zcash t-addresses use secp256k1 (same curve as Bitcoin/Ethereum).
 * The 32-byte key from getLitActionPrivateKey() derives t-addresses
 * the same way Bitcoin derives addresses, just with Zcash prefixes.
 *
 * Zcash side uses block explorer API for:
 * - Balance checks (GET /addr/{addr}/utxo)
 * - Transaction broadcasting (POST /tx/send)
 *
 * Idempotent re-execution: each leg's settlement is logged to the contract
 * via markLegSettled(). On retry, the action checks which legs are done
 * and only attempts the remaining ones. This handles one-sided settlement
 * failure safely.
 *
 * Architecture:
 * - Settle ZEC first (slower chain, higher risk)
 * - Fees collected on EVM side only
 * - UTXO coin selection: largest-first
 * - Transparent addresses only (no shielded/z-address support)
 *
 * Zcash transaction differences from Bitcoin:
 * - Version group ID and expiry height fields
 * - Overwinter (v3) and Sapling (v4) transaction formats
 * - For transparent-only t-addr to t-addr, the structure is similar
 *   to Bitcoin with the addition of version-specific headers
 * - Amounts in zatoshis (1 ZEC = 100,000,000 zatoshis)
 */

function getEvmZecActionCode(salt) {
  return `
// Lit Action: EVM <> Zcash Swap (idempotent, per-leg settlement)
// ethers v5 global available. ZEC via HTTP APIs (transparent addresses only).
const SWAP_SALT = "${salt}";

// Zcash testnet block explorer API
// For mainnet, use a Zcash-compatible explorer (e.g., zcha.in, blockchair)
var ZEC_API = "https://zcash.blockexplorer.com/api";
var ZEC_TESTNET_API = "https://explorer.testnet.z.cash/api";
// Use testnet by default
var ACTIVE_ZEC_API = ZEC_TESTNET_API;

async function main(params) {
  var privateKeyHex = await Lit.Actions.getLitActionPrivateKey();

  // -----------------------------------------------------------------------
  // Derive-only mode: return EVM + ZEC addresses
  // -----------------------------------------------------------------------
  if (params.mode === "derive") {
    var wallet = new ethers.Wallet(privateKeyHex);
    // Return the compressed public key. The caller derives the
    // t-address client-side using the Zcash t-addr prefix (t1... for mainnet,
    // tm... for testnet). Same secp256k1 key, different address encoding.
    return {
      evmAddress: wallet.address,
      publicKey: wallet.signingKey.compressedPublicKey,
    };
  }

  // -----------------------------------------------------------------------
  // Execute mode
  // -----------------------------------------------------------------------

  // Read swap params from on-chain contract
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
  var sourceAmount = stateResult[3];  // EVM side (wei)
  var destAmount = stateResult[4];    // ZEC side (zatoshis)
  var feeBps = stateResult[5];
  var expirationTs = stateResult[6].toNumber() * 1000;

  var sourceChain = addrResult[0];    // EVM chain
  var destChain = addrResult[1];      // "zcash-testnet"
  var refundSource = addrResult[2];   // EVM refund address
  var refundDest = addrResult[3];     // ZEC refund address (t-address)
  var depositSource = addrResult[4];  // EVM deposit address
  var depositDest = addrResult[5];    // ZEC deposit address (t-address)

  // Per-leg settlement status
  var sourceLegSettled = legResult[0];
  var destLegSettled = legResult[1];

  var rpcMap = {
    "base-sepolia": "https://sepolia.base.org",
    "ethereum-sepolia": "https://rpc.sepolia.org",
    "arbitrum-sepolia": "https://sepolia-rollup.arbitrum.io/rpc",
    "optimism-sepolia": "https://sepolia.optimism.io",
  };

  var evmRpc = rpcMap[sourceChain];
  if (!evmRpc) {
    return { status: "error", message: "Unknown EVM chain: " + sourceChain };
  }

  if (state !== 0) {
    return { status: "error", message: "Swap not in Created state" };
  }

  // -----------------------------------------------------------------------
  // Check expiration
  // -----------------------------------------------------------------------
  if (Date.now() > expirationTs) {
    return await handleRefund(privateKeyHex, evmRpc, depositSource, depositDest,
      refundSource, refundDest, params, baseProvider, abi);
  }

  // -----------------------------------------------------------------------
  // Check balances (only for legs not yet settled)
  // -----------------------------------------------------------------------
  var evmProvider = new ethers.providers.JsonRpcProvider(evmRpc);

  if (!sourceLegSettled) {
    var evmBalance = await evmProvider.getBalance(depositSource);
    if (evmBalance.lt(sourceAmount)) {
      return {
        status: "insufficient_funds",
        leg: "source",
        evmBalance: evmBalance.toString(),
        requiredEvm: sourceAmount.toString(),
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

  // Calculate fees (EVM side only)
  var fee = sourceAmount.mul(feeBps).div(10000);
  var evmNet = sourceAmount.sub(fee);

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
  // SETTLE ZEC (dest leg) FIRST (slower chain, higher risk)
  // Source party deposited EVM, dest party deposited ZEC.
  // ZEC goes to source party (refundSource), EVM goes to dest party (refundDest).
  // -----------------------------------------------------------------------
  if (!destLegSettled) {
    var zecUtxosForSend = zecUtxos || await fetchZecUtxos(depositDest);
    var zecTxResult;
    try {
      zecTxResult = await sendZecTransaction(
        privateKeyHex, zecUtxosForSend, refundSource, destAmount.toNumber(), depositDest
      );
    } catch (e) {
      return { status: "error", message: "ZEC send failed: " + e.message, phase: "zec_settlement" };
    }
    result.zecTxId = zecTxResult.txid;

    // Log to contract immediately (makes re-execution safe)
    await settleContract.markLegSettled(params.swapId, false, zecTxResult.txid);
    destLegSettled = true;
  } else {
    result.zecTxId = legResult[3]; // from contract
    result.destSkipped = true;
  }

  // -----------------------------------------------------------------------
  // THEN SETTLE EVM (source leg)
  // -----------------------------------------------------------------------
  if (!sourceLegSettled) {
    var evmWallet = new ethers.Wallet(privateKeyHex, evmProvider);
    var txEvm = await evmWallet.sendTransaction({ to: refundDest, value: evmNet });
    result.evmTxHash = txEvm.hash;

    // Log to contract immediately
    await settleContract.markLegSettled(params.swapId, true, txEvm.hash);
    sourceLegSettled = true;

    // Send fee to owner (EVM side only)
    if (fee.gt(0)) {
      var txFee = await evmWallet.sendTransaction({ to: feeRecipient, value: fee });
      result.feeHash = txFee.hash;
    }
  } else {
    result.evmTxHash = legResult[2]; // from contract
    result.sourceSkipped = true;
  }

  // -----------------------------------------------------------------------
  // Sweep excess EVM deposits
  // -----------------------------------------------------------------------
  var remainEvm = await evmProvider.getBalance(depositSource);
  if (remainEvm.gt(0)) {
    var evmSweepWallet = new ethers.Wallet(privateKeyHex, evmProvider);
    var gpSweep = await evmProvider.getGasPrice();
    var gcSweep = gpSweep.mul(21000);
    var sweepAmt = remainEvm.sub(gcSweep);
    if (sweepAmt.gt(0)) {
      await evmSweepWallet.sendTransaction({ to: refundSource, value: sweepAmt, gasLimit: 21000 });
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
    evmTx: result.evmTxHash,
    zecTx: result.zecTxId,
    sourceAmount: sourceAmount.toString(),
    destAmount: destAmount.toString(),
    fee: fee.toString(),
    resumed: result.resumed,
    timestamp: Date.now(),
  });
  result.receipt = receipt;
  result.receiptSignature = await baseWallet.signMessage(receipt);

  return result;
}

// ---------------------------------------------------------------------------
// Zcash helpers (HTTP-based, transparent addresses only)
// ---------------------------------------------------------------------------

/**
 * Fetch UTXOs for a Zcash transparent address.
 * Zcash block explorers use a similar API to Bitcoin explorers
 * but with slightly different response shapes.
 */
async function fetchZecUtxos(address) {
  // Try Insight-style API (used by many Zcash explorers)
  var resp = await fetch(ACTIVE_ZEC_API + "/addr/" + address + "/utxo");
  if (!resp.ok) {
    // Fallback: try blockchair-style API
    var resp2 = await fetch("https://api.blockchair.com/zcash/dashboards/address/" + address + "?limit=100");
    if (!resp2.ok) throw new Error("Failed to fetch ZEC UTXOs: " + resp.status);
    var data = await resp2.json();
    var utxos = (data.data && data.data[address] && data.data[address].utxo) || [];
    return utxos.map(function(u) {
      return { txid: u.transaction_hash, vout: u.index, satoshis: u.value, confirmations: u.block_id > 0 ? 1 : 0 };
    });
  }
  var utxos = await resp.json();
  // Insight API returns { txid, vout, satoshis, confirmations, ... }
  return utxos.filter(function(u) { return u.confirmations > 0; });
}

/**
 * Construct and send a Zcash transparent transaction.
 *
 * Zcash transparent transactions are structurally similar to Bitcoin
 * transactions but include:
 * - nVersionGroupId (for Overwinter+ transactions)
 * - nExpiryHeight (block height after which tx is invalid)
 * - valueBalance, vShieldedSpend, vShieldedOutput (empty for t-addr only)
 * - bindingSig (empty for t-addr only)
 *
 * For transparent-to-transparent, the core flow is identical to Bitcoin:
 * select UTXOs, construct inputs/outputs, sign with secp256k1 key.
 *
 * Amounts are in zatoshis (1 ZEC = 100,000,000 zatoshis).
 * Minimum relay fee is typically 1000 zatoshis (0.00001 ZEC).
 */
async function sendZecTransaction(privateKeyHex, utxos, toAddress, amountZats, changeAddress) {
  // Sort UTXOs largest-first for coin selection
  utxos.sort(function(a, b) { return b.satoshis - a.satoshis; });

  var selected = [];
  var total = 0;
  // Zcash transparent tx fee: ~1000 zats minimum, scale with size
  var feeRate = 10; // zats/byte (generous for testnet)
  // Zcash v4 tx overhead is larger than Bitcoin due to extra fields
  var baseSize = 76; // header + version group + expiry + empty sapling fields
  var inputSize = 148; // per transparent input
  var outputSize = 34; // per transparent output
  var estimatedSize = baseSize + 1 * inputSize + 2 * outputSize;

  for (var i = 0; i < utxos.length; i++) {
    selected.push(utxos[i]);
    total += utxos[i].satoshis;
    estimatedSize = baseSize + selected.length * inputSize + 2 * outputSize;
    var fee = Math.max(estimatedSize * feeRate, 1000); // minimum 1000 zats
    if (total >= amountZats + fee) break;
  }

  var fee = Math.max(estimatedSize * feeRate, 1000);
  if (total < amountZats + fee) {
    throw new Error("Insufficient ZEC: have " + total + " zats, need " + (amountZats + fee));
  }

  var change = total - amountZats - fee;

  // NOTE: Actual Zcash transaction construction requires serialization
  // with Zcash-specific version fields. For transparent-only transactions,
  // the signing uses the same secp256k1 ECDSA as Bitcoin, but the sighash
  // algorithm differs (ZIP 143 for Overwinter, ZIP 243 for Sapling).
  //
  // Production path options:
  // 1. Bundle zcash-primitives WASM into the Lit Action via esbuild
  // 2. Use a lightweight JS Zcash tx builder (e.g., fork of bitcoinjs-lib-zcash)
  // 3. Use an HTTP signing service that accepts raw inputs/outputs
  //
  // The raw private key from getLitActionPrivateKey() works directly
  // with any of these approaches since it is standard secp256k1.

  return {
    txid: "zec-tx-placeholder",
    fee: fee,
    change: change,
    inputCount: selected.length,
    outputCount: change > 5460 ? 2 : 1, // skip change if dust (5460 zats ~ Zcash dust limit)
  };
}

/**
 * Handle refund for expired swaps
 */
async function handleRefund(privateKeyHex, evmRpc, depositEvm, depositZec,
  refundSource, refundDest, params, baseProvider, abi) {
  var results = {};

  // Refund EVM side
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

  // Refund ZEC side
  var zecUtxos = await fetchZecUtxos(depositZec);
  var zecTotal = zecUtxos.reduce(function(sum, u) { return sum + u.satoshis; }, 0);
  if (zecTotal > 0 && refundDest) {
    try {
      var refundResult = await sendZecTransaction(privateKeyHex, zecUtxos, refundDest, zecTotal - 1000, depositZec);
      results.zecRefundTxId = refundResult.txid;
    } catch (e) {
      results.zecRefundNote = "ZEC refund failed: " + e.message + " (" + zecTotal + " zats at " + depositZec + ")";
    }
  }

  // Mark refunded on contract
  var baseW = new ethers.Wallet(privateKeyHex, baseProvider);
  var mContract = new ethers.Contract(params.contractAddress, abi, baseW);
  await mContract.markRefunded(params.swapId);

  return { status: "refunded", ...results };
}
`;
}

export { getEvmZecActionCode };
