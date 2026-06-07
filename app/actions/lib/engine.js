/**
 * Chain-agnostic settlement engine + EVM leg, emitted as an in-action code
 * string. This is the shared core every swap action composes in.
 *
 * Design: each chain family (evm / utxo / zec / sol) provides a *leg driver*
 * with a uniform interface:
 *
 *   leg.label                      -> "evm" | "btc" | "zec" | "sol" | ...
 *   await leg.deriveAddress()      -> deposit address string
 *   await leg.getBalance(addr)     -> BigInt (smallest unit)
 *   await leg.settle({to, amount, deposit}) -> txid string
 *   await leg.drain({to, deposit}) -> txid string | null   (refund / sweep excess)
 *
 * runSwap() reads the Base contract (source of truth), handles expiration ->
 * refund, checks balances, settles legs in the configured order with per-leg
 * idempotency (markLegSettled), deducts the fee on the configured side, sweeps
 * excess, marks executed, and returns a signed receipt.
 *
 * Signing: all EVM signing (the Base contract writes + any EVM-chain value
 * transfers) is done by micro-eth-signer. The `ethers` runtime global is used
 * only for read-only RPC, nonce, gas, and broadcasting the signed raw tx.
 */

export const CONTRACT_ABI = [
  'function getSwapState(uint256) view returns (uint8,address,address,uint256,uint256,uint16,uint256,string)',
  // Returns the four role addresses (userRefundSource, userReceiveDest,
  // solverReceiveSource, solverRefundDest) then the two deposit addresses then
  // confirmationBlocks. Positional decode below MUST match this order.
  'function getSwapAddresses(uint256) view returns (string,string,string,string,string,string,string,string,uint256)',
  'function getSwapIntent(uint256) view returns (bytes32,uint256,string)',
  'function getSwapLegs(uint256) view returns (bool,bool,string,string)',
  'function getFeeStatus(uint256) view returns (bool,string)',
  'function owner() view returns (address)',
  'function markLegSettled(uint256,bool,string)',
  'function markFeeSettled(uint256,string)',
  'function markExecuted(uint256)',
  'function markRefunded(uint256)',
];

/**
 * Shared engine code. Returns a string defining: byte helpers, a per-(chain,
 * address) nonce manager, the low-level EVM signer (micro-eth-signer), the
 * Base contract writer, the EVM leg factory, and runSwap().
 */
export function engineSrc() {
  return `
// ---- byte / encoding helpers ----------------------------------------------
function stripHex(s) { return s.indexOf("0x") === 0 ? s.slice(2) : s; }
function keyToBytes(privHex) { return hex.decode(stripHex(privHex)); }

var ABI = ${JSON.stringify(CONTRACT_ABI)};

// ---- shared nonce manager (keyed by chainId|address) ----------------------
// Critical: when the swap's EVM chain IS the contract chain, the same address
// signs both contract writes and value transfers — they MUST share a nonce.
// Key on chainId (not the rpcUrl string, which can differ by slash/case for the
// same chain and split the counter -> nonce collision / dropped tx).
// Peek with getNonce; only bumpNonce after a successful broadcast, so a failed
// send leaves the nonce reusable instead of opening an unfillable gap.
var __nonces = {};
async function getNonce(provider, chainId, address) {
  var key = chainId + "|" + address.toLowerCase();
  if (__nonces[key] === undefined) {
    __nonces[key] = await provider.getTransactionCount(address, "pending");
  }
  return __nonces[key];
}
function bumpNonce(chainId, address) {
  var key = chainId + "|" + address.toLowerCase();
  __nonces[key] = (__nonces[key] || 0) + 1;
}

// ---- RPC resilience helpers -----------------------------------------------
// Public/load-balanced RPCs are eventually-consistent and occasionally drop a
// response. These helpers absorb transient faults so a flaky RPC does not turn
// a settlement step into a hard failure (the cause of the intermittent 500s).
function sleepMs(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function rpcErrText(e) { return String((e && (e.message || e.code)) || e).toLowerCase(); }
function isTransientRpc(e) {
  var m = rpcErrText(e);
  return m.indexOf("missing response") >= 0 || m.indexOf("timeout") >= 0 ||
         m.indexOf("server_error") >= 0 || m.indexOf("bad result") >= 0 ||
         m.indexOf("502") >= 0 || m.indexOf("503") >= 0 || m.indexOf("504") >= 0 ||
         m.indexOf("econn") >= 0 || m.indexOf("network") >= 0 ||
         m.indexOf("rate limit") >= 0 || m.indexOf("too many") >= 0;
}
// A broadcast that "fails" because the tx is already in the mempool/mined is a
// success: the signed tx is deterministic, so its hash is already valid.
function isAlreadyBroadcast(e) {
  var m = rpcErrText(e);
  return m.indexOf("already known") >= 0 || m.indexOf("known transaction") >= 0 ||
         m.indexOf("already imported") >= 0 || m.indexOf("nonce too low") >= 0 ||
         m.indexOf("replacement transaction underpriced") >= 0;
}
async function rpcRetry(fn, tries) {
  var last;
  for (var i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; if (!isTransientRpc(e)) throw e; await sleepMs(600 * (i + 1)); }
  }
  throw last;
}
// Gas price is fetched at most once per chain per run and reused for every tx,
// to stay within the sandbox's ~24-call outbound-HTTP budget.
var __gasPrice = {};
async function getGasPriceCached(provider, chainId) {
  if (__gasPrice[chainId] === undefined) {
    var g = await provider.getGasPrice();
    __gasPrice[chainId] = BigInt(g.toString());
  }
  return __gasPrice[chainId];
}

// ---- low-level EVM signer (micro-eth-signer) ------------------------------
// Builds + signs with micro-eth-signer; uses the ethers provider for nonce,
// gas, and broadcast only.
async function evmSignSend(ctx, rpcUrl, chainId, to, value, data) {
  // Pin a static network so the provider never does an eth_chainId auto-detect
  // round-trip per call (that detect intermittently failed with "could not
  // detect network" and added latency that pushed txs past the receipt budget).
  var provider = new ethers.providers.JsonRpcProvider(rpcUrl, { chainId: Number(chainId), name: "evm" });
  var from = ethAddr.fromPrivateKey(ctx.keyBytes);
  var nonce = await getNonce(provider, chainId, from);
  var gp = await getGasPriceCached(provider, chainId); // fetched once per chain/run
  // EIP-1559 fields. Generous maxFee (3x) so txs mine within a couple blocks.
  var maxPriorityFeePerGas = gp;
  var maxFeePerGas = gp * 3n;
  // Fixed gas limits -- no estimateGas call. estimateGas both costs an HTTP
  // request (the sandbox caps outbound calls ~24/run) AND reverts on
  // read-after-write lag for contract writes. Value transfers need 21000;
  // contract writes get generous headroom.
  var gasLimit = (data && data !== "0x") ? 200000n : 21000n;
  // micro-eth-signer rejects an explicit undefined data field ("fields had
  // validation errors"); the key must be ABSENT for plain value transfers.
  var txFields = {
    to: to,
    value: value,
    nonce: BigInt(nonce),
    maxFeePerGas: maxFeePerGas,
    maxPriorityFeePerGas: maxPriorityFeePerGas,
    gasLimit: gasLimit,
    chainId: BigInt(chainId),
  };
  if (data && data !== "0x") txFields.data = data;
  var tx = EthTx.prepare(txFields);
  var signed = tx.signBy(ctx.keyBytes);
  var raw = signed.toHex();
  var rawHex = raw.indexOf("0x") === 0 ? raw : "0x" + raw;
  var txHash = signed.hash.indexOf("0x") === 0 ? signed.hash : "0x" + signed.hash;
  // Broadcast only -- do NOT poll for the receipt here. The sandbox's ~24-call
  // HTTP budget can't afford per-tx polling (it starved later legs and stranded
  // them). Safety comes from NONCE ORDERING instead: every tx is from this one
  // EOA with sequential nonces, so the final markExecuted (highest nonce) cannot
  // be mined until all the value transfers (lower nonces) have mined. Plain ETH
  // value transfers from a funded address cannot revert. The caller confirms
  // completion by polling the contract state.
  for (var i = 0; i < 3; i++) {
    try { await provider.send("eth_sendRawTransaction", [rawHex]); break; }
    catch (e) {
      if (isAlreadyBroadcast(e)) break;                  // already in mempool/mined
      if (!isTransientRpc(e) || i === 2) throw e;
      await sleepMs(500 * (i + 1));
    }
  }
  bumpNonce(chainId, from);
  return txHash;
}

// ---- Base contract writer -------------------------------------------------
function makeBaseWriter(ctx) {
  // Pin a static network so reads/writes never trigger a per-call eth_chainId
  // auto-detect (that intermittently failed and wasted HTTP budget). The Base
  // chainId is read once, with retry, then reused.
  var detectProvider = new ethers.providers.JsonRpcProvider(ctx.params.baseRpcUrl);
  var providerPromise = rpcRetry(function () { return detectProvider.getNetwork(); }, 5).then(function (n) {
    return new ethers.providers.JsonRpcProvider(ctx.params.baseRpcUrl, { chainId: n.chainId, name: "evm" });
  });
  var iface = new ethers.utils.Interface(ABI);
  var read = new ethers.Contract(ctx.params.contractAddress, ABI, detectProvider);
  var swapId = ctx.params.swapId;
  async function write(method, args) {
    var data = iface.encodeFunctionData(method, args);
    var p = await providerPromise;
    var net = await p.getNetwork();
    return evmSignSend(ctx, ctx.params.baseRpcUrl, net.chainId, ctx.params.contractAddress, 0n, data);
  }
  // Plain broadcasts (no per-write idempotency reads): re-issuing a done step is
  // prevented by the top-level state read in runSwap (settled legs / Executed
  // state are skipped before any write), and nonce ordering makes markExecuted
  // safe. Keeping writes call-light is what keeps a full run under the ~24-call
  // sandbox HTTP budget.
  return {
    provider: detectProvider,
    read: read,
    getFeeStatus: function () { return read.getFeeStatus(swapId); },
    markLegSettled: function (isSource, txid) { return write("markLegSettled", [swapId, isSource, txid]); },
    markFeeSettled: function (txid) { return write("markFeeSettled", [swapId, txid]); },
    markExecuted: function () { return write("markExecuted", [swapId]); },
    markRefunded: function () { return write("markRefunded", [swapId]); },
  };
}

// ---- EVM leg factory ------------------------------------------------------
function makeEvmLeg(ctx, chainId_, role) {
  var cfg = CHAINS[chainId_];
  var rpcUrl = cfg.rpc;
  var chainId = cfg.chainId;
  // Pin a static network so the provider never does an eth_chainId auto-detect
  // round-trip per call (that detect intermittently failed with "could not
  // detect network" and added latency that pushed txs past the receipt budget).
  var provider = new ethers.providers.JsonRpcProvider(rpcUrl, { chainId: Number(chainId), name: "evm" });
  return {
    label: "evm",
    role: role,
    chainName: chainId_,
    deriveAddress: async function () { return ethAddr.fromPrivateKey(ctx.keyBytes); },
    getBalance: async function (address) {
      var b = await provider.getBalance(address);
      return BigInt(b.toString());
    },
    settle: async function (o) {
      return evmSignSend(ctx, rpcUrl, chainId, o.to, o.amount, null);
    },
    // Drain entire balance minus a gas reserve to "to".
    drain: async function (o) {
      var bal = await this.getBalance(o.deposit);
      var gasPrice = await provider.getGasPrice();
      var reserve = BigInt(gasPrice.toString()) * 2n * 21000n;
      var send = bal - reserve;
      if (send <= 0n) return null;
      return evmSignSend(ctx, rpcUrl, chainId, o.to, send, null);
    },
    // EVM is the only family that can pay the fee to an on-chain owner address.
    sendFee: async function (o) {
      if (o.amount <= 0n) return null;
      return evmSignSend(ctx, rpcUrl, chainId, o.to, o.amount, null);
    },
  };
}

// ---- the generic swap engine ----------------------------------------------
// CFG = { settleOrder: ["dest","source"]|["source","dest"],
//         feeLeg: "source"|"dest", feeMode: "send-evm"|"retain" }
async function runSwap(ctx, CFG, sourceLeg, destLeg, baseOverride) {
  var params = ctx.params;

  // ---- derive mode: return every address this action controls ----
  // Must short-circuit BEFORE makeBaseWriter: derive callers do not pass a
  // contractAddress (none exists yet), and makeBaseWriter eagerly constructs an
  // ethers.Contract from it — which throws on undefined. Derive needs only the
  // action key + per-leg derivation, never the Base contract.
  if (params.mode === "derive") {
    var out = { evmAddress: ethAddr.fromPrivateKey(ctx.keyBytes) };
    out[sourceLeg.label + "AddressSource"] = await sourceLeg.deriveAddress();
    out[destLeg.label + "AddressDest"] = await destLeg.deriveAddress();
    return out;
  }

  var base = baseOverride || makeBaseWriter(ctx);

  // ---- read contract state (retry-wrapped: the first read triggers the
  // provider's network detection, which can transiently fail) ----
  var state = await rpcRetry(function () { return base.read.getSwapState(params.swapId); }, 5);
  var addrs = await rpcRetry(function () { return base.read.getSwapAddresses(params.swapId); }, 5);
  var intent = await rpcRetry(function () { return base.read.getSwapIntent(params.swapId); }, 5);
  var legs = await rpcRetry(function () { return base.read.getSwapLegs(params.swapId); }, 5);
  var owner = await rpcRetry(function () { return base.read.owner(); }, 5);

  var swapState = state[0];
  var sourceAmount = BigInt(state[3].toString());
  var destAmount = BigInt(state[4].toString());
  var feeBps = BigInt(state[5].toString ? state[5].toString() : state[5]);
  var expirationTs = Number(state[6].toString()) * 1000;
  var minDestAmount = BigInt(intent[1].toString());

  // FOUR-ADDRESS MODEL (see SwapContract.sol). Decoded positionally from
  // getSwapAddresses; the role names are explicit so a wrong slot can't quietly
  // route funds to the wrong chain.
  //                      success (settle)         failure (refund)
  //   source asset ────► solverReceiveSource ───  userRefundSource
  //   dest   asset ────► userReceiveDest     ───  solverRefundDest
  var userRefundSource = addrs[2];
  var userReceiveDest = addrs[3];
  var solverReceiveSource = addrs[4];
  var solverRefundDest = addrs[5];
  var depositSource = addrs[6];
  var depositDest = addrs[7];

  var sourceLegSettled = legs[0];
  var destLegSettled = legs[1];

  if (swapState !== 0) return { status: "error", message: "Swap not in Created state (state=" + swapState + ")" };

  // ---- expiration -> refund both deposits to their refund addresses ----
  if (Date.now() > expirationTs) {
    var ref = {};
    var refundFailed = false;
    try { var r1 = await sourceLeg.drain({ to: userRefundSource, deposit: depositSource }); if (r1) ref.sourceRefund = r1; }
    catch (e) { ref.sourceRefundNote = String(e.message || e); refundFailed = true; }
    try { var r2 = await destLeg.drain({ to: solverRefundDest, deposit: depositDest }); if (r2) ref.destRefund = r2; }
    catch (e) { ref.destRefundNote = String(e.message || e); refundFailed = true; }
    if (refundFailed) {
      // Do NOT finalize. markRefunded is terminal (inState Created), so marking
      // now would strand any funds whose drain failed (e.g. RPC down). Leave the
      // swap Created so a later run can retry the refund.
      return Object.assign({ status: "refund_incomplete" }, ref);
    }
    await base.markRefunded();
    return Object.assign({ status: "refunded" }, ref);
  }

  // ---- floor check (defense in depth) ----
  // The contract enforces destAmount >= minDestAmount at createSwap; re-assert
  // here so a settlement never honors a sub-floor swap even if a bad swap row
  // somehow exists. Errors out before any value moves.
  if (destAmount < minDestAmount) {
    return { status: "error", message: "destAmount below floor (" + destAmount.toString() + " < " + minDestAmount.toString() + ")" };
  }

  // ---- balance checks for unsettled legs ----
  if (!sourceLegSettled) {
    var sb = await sourceLeg.getBalance(depositSource);
    if (sb < sourceAmount) return { status: "insufficient_funds", leg: "source",
      balance: sb.toString(), required: sourceAmount.toString(), destLegSettled: destLegSettled };
  }
  if (!destLegSettled) {
    var db = await destLeg.getBalance(depositDest);
    if (db < destAmount) return { status: "insufficient_funds", leg: "dest",
      balance: db.toString(), required: destAmount.toString(), sourceLegSettled: sourceLegSettled };
  }

  // ---- fee math (rear-loaded, basis points on the fee leg's amount) ----
  var fee = (CFG.feeLeg === "source" ? sourceAmount : destAmount) * feeBps / 10000n;
  var sourceNet = sourceAmount - (CFG.feeLeg === "source" ? fee : 0n);
  var destNet = destAmount - (CFG.feeLeg === "dest" ? fee : 0n);

  var result = {
    status: "executed",
    sourceLegSettled: sourceLegSettled,
    destLegSettled: destLegSettled,
    resumed: sourceLegSettled || destLegSettled,
  };

  // Settlement cross: source-chain funds pay the solver (solverReceiveSource);
  // dest-chain funds pay the user (userReceiveDest).
  async function settleSource() {
    if (!sourceLegSettled) {
      var txid = await sourceLeg.settle({ to: solverReceiveSource, amount: sourceNet, deposit: depositSource });
      result.sourceTxId = txid;
      await base.markLegSettled(true, txid);
      sourceLegSettled = true;
    } else { result.sourceTxId = legs[2]; result.sourceSkipped = true; }
  }
  async function settleDest() {
    if (!destLegSettled) {
      var txid = await destLeg.settle({ to: userReceiveDest, amount: destNet, deposit: depositDest });
      result.destTxId = txid;
      await base.markLegSettled(false, txid);
      destLegSettled = true;
    } else { result.destTxId = legs[3]; result.destSkipped = true; }
  }

  for (var i = 0; i < CFG.settleOrder.length; i++) {
    if (CFG.settleOrder[i] === "source") await settleSource(); else await settleDest();
  }

  // ---- fee step (idempotent + recoverable) ----
  // Decoupled from leg settlement and keyed on the on-chain feeSettled flag, so
  // a crash between a leg settling and the fee being paid is recovered on the
  // next run instead of silently dropping the fee.
  if (CFG.feeMode === "send-evm" && fee > 0n) {
    var feeStatus = await base.getFeeStatus(); // [feeSettled, feeTxHash]
    if (feeStatus[0]) {
      result.feeTxId = feeStatus[1];
      result.feeSkipped = true;
    } else {
      var feeLeg = CFG.feeLeg === "source" ? sourceLeg : destLeg;
      var feeDeposit = CFG.feeLeg === "source" ? depositSource : depositDest;
      if (feeLeg.sendFee) {
        var feeTx = await feeLeg.sendFee({ to: owner, amount: fee, deposit: feeDeposit });
        result.feeTxId = feeTx;
        await base.markFeeSettled(feeTx);
      }
    }
  } else if (CFG.feeMode === "retain" && fee > 0n) {
    result.feeRetained = fee.toString();
    result.feeNote = "Fee retained in action wallet for batch collection (no EVM payout leg)";
  }

  // ---- sweep excess deposits back to depositors ----
  // Each leg returns its overfunded remainder to its refund address. The fee
  // leg is skipped when fees are retained (no EVM payout), so the fee stays in
  // the action wallet for batch collection. UTXO drains naturally no-op right
  // after settle (the spent/change outputs aren't confirmed yet); the EVM drain
  // is best-effort and only catches excess once the settle tx is mined.
  async function sweepLeg(leg, depositAddr, refundAddr, isFeeLeg) {
    if (isFeeLeg && CFG.feeMode === "retain") return;
    // Never sweep an EVM (account-model) leg after settlement: settle() already
    // sent the exact net amount from this same address, and drain() reads the
    // (likely still-unmined) balance and would re-send nearly all of it ->
    // double-spend / nonce wedge. EVM overfunding is recovered via the expiry
    // refund path instead. UTXO/ZEC legs are safe (drain only spends confirmed
    // UTXOs, so the just-broadcast change is invisible and drain no-ops).
    if (leg.label === "evm") return;
    try { var s = await leg.drain({ to: refundAddr, deposit: depositAddr }); if (s) result[leg.role + "Sweep"] = s; }
    catch (e) { result[leg.role + "SweepNote"] = String(e.message || e); }
  }
  await sweepLeg(sourceLeg, depositSource, userRefundSource, CFG.feeLeg === "source");
  await sweepLeg(destLeg, depositDest, solverRefundDest, CFG.feeLeg === "dest");

  // ---- mark fully executed (contract enforces both legs settled) ----
  await base.markExecuted();

  // ---- signed receipt (EIP-191 via micro-eth-signer) ----
  // Receipt must be byte-identical across every Lit node so the threshold
  // signature aggregates. Do NOT put Date.now() here — use the deterministic
  // on-chain expiration. (Tx hashes are read from contract/leg results, which
  // are also deterministic once both legs are settled.)
  var receipt = JSON.stringify({
    swapId: params.swapId, sourceTx: result.sourceTxId, destTx: result.destTxId,
    sourceAmount: sourceAmount.toString(), destAmount: destAmount.toString(),
    fee: fee.toString(), resumed: result.resumed, expiration: expirationTs,
  });
  result.receipt = receipt;
  result.receiptSignature = eip191Signer.sign(receipt, ctx.keyBytes);
  return result;
}
`;
}
