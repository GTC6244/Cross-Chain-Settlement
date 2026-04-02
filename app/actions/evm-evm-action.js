/**
 * EVM <> EVM Cross-Chain Swap Lit Action
 *
 * Runs inside Lit Protocol's Chipotle Deno sandbox.
 * Available globals: Lit, ethers (v5 API), params (injected via js_params)
 *
 * Idempotent re-execution: each leg's settlement is logged to the contract
 * via markLegSettled(). On retry, the action checks which legs are done
 * and only attempts the remaining ones. This handles one-sided settlement
 * failure safely.
 *
 * js_params accepted:
 *   - mode: "derive" | "execute"
 *   - swapId: number (only for execute mode)
 *   - baseRpcUrl: string (only for execute mode)
 *   - contractAddress: string (only for execute mode)
 *
 * Security: ALL swap parameters (amounts, addresses, fees) are read from
 * the on-chain contract. js_params only carries the swap ID and RPC config.
 */

function getEvmEvmActionCode(salt) {
  return `
// Lit Action: EVM <> EVM Swap (idempotent, per-leg settlement)
// ethers v5 is available as a global in the Lit runtime.
const SWAP_SALT = "${salt}";

async function main(params) {
  var privateKeyHex = await Lit.Actions.getLitActionPrivateKey();

  // -----------------------------------------------------------------------
  // Derive-only mode
  // -----------------------------------------------------------------------
  if (params.mode === "derive") {
    var wallet = new ethers.Wallet(privateKeyHex);
    return {
      evmAddress: wallet.address,
      publicKey: wallet.signingKey.compressedPublicKey,
    };
  }

  // -----------------------------------------------------------------------
  // Execute mode: read contract, check legs, settle remaining, update state
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

  // Read swap state
  var stateResult = await contract.getSwapState(params.swapId);
  var addrResult = await contract.getSwapAddresses(params.swapId);
  var legResult = await contract.getSwapLegs(params.swapId);
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

  // Per-leg settlement status
  var sourceLegSettled = legResult[0];
  var destLegSettled = legResult[1];

  var rpcMap = {
    "base-sepolia": "https://sepolia.base.org",
    "ethereum-sepolia": "https://rpc.sepolia.org",
    "arbitrum-sepolia": "https://sepolia-rollup.arbitrum.io/rpc",
    "optimism-sepolia": "https://sepolia.optimism.io",
  };

  var sourceRpc = rpcMap[sourceChain];
  var destRpc = rpcMap[destChain];

  if (!sourceRpc || !destRpc) {
    return { status: "error", message: "Unknown chain: " + sourceChain + " or " + destChain };
  }

  if (state !== 0) {
    return { status: "error", message: "Swap not in Created state (state=" + state + ")" };
  }

  // -----------------------------------------------------------------------
  // 1. Check expiration -> refund if expired
  // -----------------------------------------------------------------------
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
    var dstProv = new ethers.providers.JsonRpcProvider(destRpc);
    var dstBal = await dstProv.getBalance(depositDest);
    if (dstBal.gt(0) && refundDest) {
      var w2 = new ethers.Wallet(privateKeyHex, dstProv);
      var gp2 = await dstProv.getGasPrice();
      var gc2 = gp2.mul(21000);
      var ra2 = dstBal.sub(gc2);
      if (ra2.gt(0)) {
        var tx2 = await w2.sendTransaction({ to: refundDest, value: ra2, gasLimit: 21000 });
        refResults.destRefundHash = tx2.hash;
      }
    }
    var baseWallet = new ethers.Wallet(privateKeyHex, baseProvider);
    var refContract = new ethers.Contract(params.contractAddress, abi, baseWallet);
    await refContract.markRefunded(params.swapId);
    return { status: "refunded", ...refResults };
  }

  // -----------------------------------------------------------------------
  // 2. Check balances (only for legs not yet settled)
  // -----------------------------------------------------------------------
  var srcProvider = new ethers.providers.JsonRpcProvider(sourceRpc);
  var dstProvider = new ethers.providers.JsonRpcProvider(destRpc);

  if (!sourceLegSettled) {
    var srcBalance = await srcProvider.getBalance(depositSource);
    if (srcBalance.lt(sourceAmount)) {
      return {
        status: "insufficient_funds",
        leg: "source",
        balance: srcBalance.toString(),
        required: sourceAmount.toString(),
        destLegSettled: destLegSettled,
      };
    }
  }

  if (!destLegSettled) {
    var dstBalance = await dstProvider.getBalance(depositDest);
    if (dstBalance.lt(destAmount)) {
      return {
        status: "insufficient_funds",
        leg: "dest",
        balance: dstBalance.toString(),
        required: destAmount.toString(),
        sourceLegSettled: sourceLegSettled,
      };
    }
  }

  // -----------------------------------------------------------------------
  // 3. Calculate fees (rear-loaded, source/EVM side only)
  // -----------------------------------------------------------------------
  var fee = sourceAmount.mul(feeBps).div(10000);
  var sourceNet = sourceAmount.sub(fee);

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
  // 4. Settle source leg (if not already done)
  //    Source chain funds -> dest party (refundDest)
  // -----------------------------------------------------------------------
  if (!sourceLegSettled) {
    var srcWallet = new ethers.Wallet(privateKeyHex, srcProvider);
    var txSrc = await srcWallet.sendTransaction({ to: refundDest, value: sourceNet });
    result.sourceTxHash = txSrc.hash;

    // Log to contract immediately (makes re-execution safe)
    await settleContract.markLegSettled(params.swapId, true, txSrc.hash);
    sourceLegSettled = true;

    // Send fee to owner
    if (fee.gt(0)) {
      var txFee = await srcWallet.sendTransaction({ to: feeRecipient, value: fee });
      result.feeHash = txFee.hash;
    }
  } else {
    result.sourceTxHash = legResult[2]; // from contract
    result.sourceSkipped = true;
  }

  // -----------------------------------------------------------------------
  // 5. Settle dest leg (if not already done)
  //    Dest chain funds -> source party (refundSource)
  // -----------------------------------------------------------------------
  if (!destLegSettled) {
    var dstWallet = new ethers.Wallet(privateKeyHex, dstProvider);
    var txDst = await dstWallet.sendTransaction({ to: refundSource, value: destAmount });
    result.destTxHash = txDst.hash;

    // Log to contract immediately
    await settleContract.markLegSettled(params.swapId, false, txDst.hash);
    destLegSettled = true;
  } else {
    result.destTxHash = legResult[3]; // from contract
    result.destSkipped = true;
  }

  // -----------------------------------------------------------------------
  // 6. Sweep excess deposits
  // -----------------------------------------------------------------------
  var remainSrc = await srcProvider.getBalance(depositSource);
  if (remainSrc.gt(0)) {
    var srcW = new ethers.Wallet(privateKeyHex, srcProvider);
    var gp3 = await srcProvider.getGasPrice();
    var gc3 = gp3.mul(21000);
    var sweep = remainSrc.sub(gc3);
    if (sweep.gt(0)) {
      await srcW.sendTransaction({ to: refundSource, value: sweep, gasLimit: 21000 });
    }
  }
  var remainDst = await dstProvider.getBalance(depositDest);
  if (remainDst.gt(0)) {
    var dstW = new ethers.Wallet(privateKeyHex, dstProvider);
    var gp4 = await dstProvider.getGasPrice();
    var gc4 = gp4.mul(21000);
    var sweepDst = remainDst.sub(gc4);
    if (sweepDst.gt(0)) {
      await dstW.sendTransaction({ to: refundDest, value: sweepDst, gasLimit: 21000 });
    }
  }

  // -----------------------------------------------------------------------
  // 7. Mark fully executed (contract enforces both legs settled)
  // -----------------------------------------------------------------------
  await settleContract.markExecuted(params.swapId);

  // -----------------------------------------------------------------------
  // 8. Sign receipt
  // -----------------------------------------------------------------------
  var receipt = JSON.stringify({
    swapId: params.swapId,
    sourceTx: result.sourceTxHash,
    destTx: result.destTxHash,
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
`;
}

export { getEvmEvmActionCode };
