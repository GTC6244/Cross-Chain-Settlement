/**
 * EVM <> Zcash Lit Action Template
 *
 * Runs inside Lit's Deno sandbox. ethers v5 is a global.
 * Zcash transparent (t-address) transactions use bitcoinjs-lib with
 * Zcash network parameters via jsdelivr ESM imports.
 *
 * Zcash t-addresses use secp256k1 (same curve as Bitcoin/Ethereum).
 * For transparent-only transactions, we use bitcoinjs-lib with Zcash
 * network config (address prefixes differ from Bitcoin).
 *
 * Idempotent re-execution via per-leg settlement logging.
 *
 * ZEC side uses block explorer API for:
 * - UTXO queries
 * - Transaction broadcasting
 *
 * Architecture:
 * - Settle ZEC first (slower chain, higher risk)
 * - Fees collected on EVM side only
 * - UTXO coin selection: largest-first
 * - Transparent addresses only (no shielded/z-address support)
 * - Amounts in zatoshis (1 ZEC = 100,000,000 zatoshis)
 */

function getEvmZecActionCode(salt) {
  return `
import * as bitcoin from "https://cdn.jsdelivr.net/npm/bitcoinjs-lib@7.0.0-rc.0/+esm";
import * as ecc from "https://cdn.jsdelivr.net/npm/tiny-secp256k1@2.2.3/+esm";
import { ECPairFactory } from "https://cdn.jsdelivr.net/npm/ecpair@3.0.0-rc.0/+esm";

// Lit Action: EVM <> Zcash Swap (idempotent, per-leg settlement)
// ethers v5 global available. ZEC via bitcoinjs-lib + block explorer API.
const SWAP_SALT = "${salt}";

var ZEC_API = "https://explorer.testnet.z.cash/api";
var ECPair = ECPairFactory(ecc);

// Zcash testnet network parameters for bitcoinjs-lib
// t-addresses use the same secp256k1 curve, just different version bytes
var zcashTestnet = {
  messagePrefix: "\\x18Zcash Signed Message:\\n",
  bech32: "ztestsapling",
  bip32: { public: 0x043587cf, private: 0x04358394 },
  pubKeyHash: 0x1d25,    // t1... on mainnet=0x1cb8, testnet=0x1d25
  scriptHash: 0x1cba,    // t3... on mainnet=0x1cbd, testnet=0x1cba
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
    var keyPair = ECPair.fromPrivateKey(Buffer.from(keyBytes), { network: zcashTestnet });
    // Zcash t-addresses use P2PKH (not SegWit)
    var p2pkh = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: zcashTestnet });
    return {
      evmAddress: evmWallet.address,
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
  var feeRecipient = await contract.owner();

  var state = stateResult[0];
  var sourceAmount = stateResult[3];  // EVM (wei)
  var destAmount = stateResult[4];    // ZEC (zatoshis)
  var feeBps = stateResult[5];
  var expirationTs = stateResult[6].toNumber() * 1000;

  var sourceChain = addrResult[0];
  var destChain = addrResult[1];
  var refundSource = addrResult[2];   // EVM refund
  var refundDest = addrResult[3];     // ZEC refund (t-address)
  var depositSource = addrResult[4];  // EVM deposit
  var depositDest = addrResult[5];    // ZEC deposit (t-address)

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
  // Expiration
  // -----------------------------------------------------------------------
  if (Date.now() > expirationTs) {
    return await handleRefund(privateKeyHex, keyBytes, evmRpc, depositSource, depositDest,
      refundSource, refundDest, params, baseProvider, abi);
  }

  // -----------------------------------------------------------------------
  // Check balances
  // -----------------------------------------------------------------------
  var evmProvider = new ethers.providers.JsonRpcProvider(evmRpc);

  if (!sourceLegSettled) {
    var evmBalance = await evmProvider.getBalance(depositSource);
    if (evmBalance.lt(sourceAmount)) {
      return { status: "insufficient_funds", leg: "source", evmBalance: evmBalance.toString(),
        requiredEvm: sourceAmount.toString(), destLegSettled: destLegSettled };
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
  // SETTLE ZEC (dest leg) FIRST
  // -----------------------------------------------------------------------
  if (!destLegSettled) {
    zecUtxos = zecUtxos || await fetchZecUtxos(depositDest);
    var zecTxResult = await buildAndBroadcastZecTx(
      keyBytes, zecUtxos, refundSource, destAmount.toNumber(), depositDest
    );
    result.zecTxId = zecTxResult.txid;
    await settleContract.markLegSettled(params.swapId, false, zecTxResult.txid);
    destLegSettled = true;
  } else {
    result.zecTxId = legResult[3];
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
    swapId: params.swapId, evmTx: result.evmTxHash, zecTx: result.zecTxId,
    sourceAmount: sourceAmount.toString(), destAmount: destAmount.toString(),
    fee: fee.toString(), resumed: result.resumed, timestamp: Date.now(),
  });
  result.receipt = receipt;
  result.receiptSignature = await baseWallet.signMessage(receipt);
  return result;
}

// ---------------------------------------------------------------------------
// Zcash transaction construction (transparent t-addr only)
// Uses bitcoinjs-lib with Zcash network parameters.
// Zcash transparent transactions are structurally identical to Bitcoin
// P2PKH transactions. The signing uses standard secp256k1 ECDSA.
// ---------------------------------------------------------------------------

async function fetchZecUtxos(address) {
  // Insight-style API
  var resp = await fetch(ZEC_API + "/addr/" + address + "/utxo");
  if (!resp.ok) {
    // Fallback: Blockchair
    var resp2 = await fetch("https://api.blockchair.com/zcash/dashboards/address/" + address + "?limit=100");
    if (!resp2.ok) throw new Error("Failed to fetch ZEC UTXOs: " + resp.status);
    var data = await resp2.json();
    var utxos = (data.data && data.data[address] && data.data[address].utxo) || [];
    return utxos.map(function(u) {
      return { txid: u.transaction_hash, vout: u.index, satoshis: u.value,
        confirmations: u.block_id > 0 ? 1 : 0, scriptPubKey: u.script_hex };
    });
  }
  var utxos = await resp.json();
  return utxos.filter(function(u) { return u.confirmations > 0; });
}

async function fetchZecTxHex(txid) {
  var resp = await fetch(ZEC_API + "/rawtx/" + txid);
  if (!resp.ok) throw new Error("Failed to fetch ZEC tx: " + txid);
  var data = await resp.json();
  return data.rawtx;
}

async function buildAndBroadcastZecTx(keyBytes, utxos, toAddress, amountZats, changeAddress) {
  var keyPair = ECPair.fromPrivateKey(Buffer.from(keyBytes), { network: zcashTestnet });
  var p2pkh = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: zcashTestnet });

  // Sort largest-first
  utxos.sort(function(a, b) { return b.satoshis - a.satoshis; });

  // Coin selection
  // P2PKH input ~148 bytes, output ~34 bytes, overhead ~10 bytes
  var selected = [];
  var total = 0;
  var feeRate = 10; // zats/byte (Zcash convention)

  for (var i = 0; i < utxos.length; i++) {
    selected.push(utxos[i]);
    total += utxos[i].satoshis;
    var estSize = 10 + selected.length * 148 + 2 * 34;
    var estFee = Math.max(estSize * feeRate, 1000); // minimum 1000 zats
    if (total >= amountZats + estFee) break;
  }

  var txSize = 10 + selected.length * 148 + 2 * 34;
  var txFee = Math.max(txSize * feeRate, 1000);
  if (total < amountZats + txFee) {
    throw new Error("Insufficient ZEC: have " + total + " zats, need " + (amountZats + txFee));
  }

  var change = total - amountZats - txFee;

  // Build transaction using bitcoinjs-lib
  // For transparent Zcash, we use standard P2PKH transaction format.
  // The transaction version and other Zcash-specific fields are handled
  // by the network when broadcasting.
  var psbt = new bitcoin.Psbt({ network: zcashTestnet });

  for (var j = 0; j < selected.length; j++) {
    var utxo = selected[j];
    // For P2PKH inputs, we need the full previous tx hex (nonWitnessUtxo)
    // or we can provide the scriptPubKey directly
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      nonWitnessUtxo: utxo.rawTx ? Buffer.from(utxo.rawTx, "hex") : undefined,
      witnessUtxo: !utxo.rawTx ? {
        script: p2pkh.output,
        value: utxo.satoshis,
      } : undefined,
    });
  }

  // Recipient
  psbt.addOutput({ address: toAddress, value: amountZats });

  // Change (skip if dust: 5460 zats for Zcash)
  if (change > 5460) {
    psbt.addOutput({ address: changeAddress, value: change });
  }

  // Sign
  for (var k = 0; k < selected.length; k++) {
    psbt.signInput(k, keyPair);
  }

  psbt.finalizeAllInputs();
  var txHex = psbt.extractTransaction().toHex();

  // Broadcast via Insight API
  var broadcastResp = await fetch(ZEC_API + "/tx/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rawtx: txHex }),
  });

  if (!broadcastResp.ok) {
    var errText = await broadcastResp.text();
    throw new Error("ZEC broadcast failed: " + broadcastResp.status + " " + errText);
  }

  var result = await broadcastResp.json();
  return { txid: result.txid || result, fee: txFee, change: change };
}

// ---------------------------------------------------------------------------
// Refund handler
// ---------------------------------------------------------------------------

async function handleRefund(privateKeyHex, keyBytes, evmRpc, depositEvm, depositZec,
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

  // Refund ZEC
  var zecUtxos = await fetchZecUtxos(depositZec);
  var zecTotal = zecUtxos.reduce(function(s, u) { return s + u.satoshis; }, 0);
  if (zecTotal > 5460 && refundDest) {
    try {
      var estFee = Math.max((10 + zecUtxos.length * 148 + 34) * 10, 1000);
      var refundResult = await buildAndBroadcastZecTx(
        keyBytes, zecUtxos, refundDest, zecTotal - estFee, depositZec
      );
      results.zecRefundTxId = refundResult.txid;
    } catch (e) {
      results.zecRefundNote = "ZEC refund failed: " + e.message;
    }
  }

  var baseW = new ethers.Wallet(privateKeyHex, baseProvider);
  var refContract = new ethers.Contract(params.contractAddress, abi, baseW);
  await refContract.markRefunded(params.swapId);
  return { status: "refunded", ...results };
}
`;
}

export { getEvmZecActionCode };
