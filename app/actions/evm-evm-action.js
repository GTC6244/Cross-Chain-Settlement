/**
 * EVM <> EVM Cross-Chain Swap Lit Action
 *
 * Runs inside Lit Protocol's Chipotle Deno sandbox.
 * Available globals: Lit, ethers (v5 API), params (injected via js_params)
 *
 * This file is the canonical template. The swap engine injects a unique
 * SWAP_SALT before IPFS upload to produce a unique CID per swap, which
 * gives each swap its own private key and deposit addresses.
 *
 * js_params accepted:
 *   - mode: "derive" | "execute"
 *   - swapId: number (only for execute mode)
 *   - baseRpcUrl: string (only for execute mode)
 *   - contractAddress: string (only for execute mode)
 *
 * Security: ALL swap parameters (amounts, addresses, fees) are read from
 * the on-chain contract. js_params only carries the swap ID and RPC config.
 * This prevents parameter manipulation attacks.
 */

function getEvmEvmActionCode(salt) {
  return `
// Lit Action: EVM <> EVM Swap
// ethers v5 is available as a global in the Lit runtime.
// getLitActionPrivateKey() returns 32 raw bytes for this action's unique key.
const SWAP_SALT = "${salt}";

async function main(params) {
  var privateKeyHex = await Lit.Actions.getLitActionPrivateKey();

  // -----------------------------------------------------------------------
  // Derive-only mode: return deposit addresses without executing the swap.
  // Used during swap creation to show users where to deposit.
  // -----------------------------------------------------------------------
  if (params.mode === "derive") {
    var wallet = new ethers.Wallet(privateKeyHex);
    return {
      evmAddress: wallet.address,
      publicKey: wallet.signingKey.compressedPublicKey,
    };
  }

  // -----------------------------------------------------------------------
  // Execute mode: read contract, check balances, settle, update state.
  // -----------------------------------------------------------------------

  // Read swap params from on-chain contract (not from js_params)
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

  // Map chain identifiers to RPC endpoints
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

  // Verify swap is in Created state
  if (state !== 0) {
    return { status: "error", message: "Swap not in Created state (state=" + state + ")" };
  }

  // -----------------------------------------------------------------------
  // 1. Check expiration -> refund if expired
  // -----------------------------------------------------------------------
  if (Date.now() > expirationTs) {
    var refResults = {};

    // Refund source chain deposits
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

    // Refund dest chain deposits
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

    // Update contract state
    var baseWallet = new ethers.Wallet(privateKeyHex, baseProvider);
    var markAbi = ["function markRefunded(uint256)"];
    var markContract = new ethers.Contract(params.contractAddress, markAbi, baseWallet);
    await markContract.markRefunded(params.swapId);

    return { status: "refunded", ...refResults };
  }

  // -----------------------------------------------------------------------
  // 2. Check balances on both chains
  // -----------------------------------------------------------------------
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

  // -----------------------------------------------------------------------
  // 3. Calculate fees (rear-loaded, deducted from source/EVM side only)
  // -----------------------------------------------------------------------
  var fee = sourceAmount.mul(feeBps).div(10000);
  var sourceNet = sourceAmount.sub(fee);

  // -----------------------------------------------------------------------
  // 4. Execute swap: send funds to each party
  //    Source chain funds -> dest party (refundDest)
  //    Dest chain funds   -> source party (refundSource)
  // -----------------------------------------------------------------------
  var srcWallet = new ethers.Wallet(privateKeyHex, srcProvider);
  var txSrc = await srcWallet.sendTransaction({ to: refundDest, value: sourceNet });

  var dstWallet = new ethers.Wallet(privateKeyHex, dstProvider);
  var txDst = await dstWallet.sendTransaction({ to: refundSource, value: destAmount });

  // -----------------------------------------------------------------------
  // 5. Send fee to contract owner (source chain only)
  // -----------------------------------------------------------------------
  var feeResult = {};
  if (fee.gt(0)) {
    var txFee = await srcWallet.sendTransaction({ to: feeRecipient, value: fee });
    feeResult.feeHash = txFee.hash;
  }

  // -----------------------------------------------------------------------
  // 6. Sweep any excess deposits back to refund address
  // -----------------------------------------------------------------------
  var remainSrc = await srcProvider.getBalance(depositSource);
  if (remainSrc.gt(0)) {
    var gp3 = await srcProvider.getGasPrice();
    var gc3 = gp3.mul(21000);
    var sweep = remainSrc.sub(gc3);
    if (sweep.gt(0)) {
      await srcWallet.sendTransaction({ to: refundSource, value: sweep, gasLimit: 21000 });
    }
  }

  var remainDst = await dstProvider.getBalance(depositDest);
  if (remainDst.gt(0)) {
    var gp4 = await dstProvider.getGasPrice();
    var gc4 = gp4.mul(21000);
    var sweepDst = remainDst.sub(gc4);
    if (sweepDst.gt(0)) {
      await dstWallet.sendTransaction({ to: refundDest, value: sweepDst, gasLimit: 21000 });
    }
  }

  // -----------------------------------------------------------------------
  // 7. Mark executed on Base contract
  // -----------------------------------------------------------------------
  var baseW = new ethers.Wallet(privateKeyHex, baseProvider);
  var mAbi = ["function markExecuted(uint256)"];
  var mContract = new ethers.Contract(params.contractAddress, mAbi, baseW);
  await mContract.markExecuted(params.swapId);

  // -----------------------------------------------------------------------
  // 8. Sign cryptographic receipt (verifiable proof of settlement)
  // -----------------------------------------------------------------------
  var receipt = JSON.stringify({
    swapId: params.swapId,
    sourceTx: txSrc.hash,
    destTx: txDst.hash,
    sourceAmount: sourceAmount.toString(),
    destAmount: destAmount.toString(),
    fee: fee.toString(),
    timestamp: Date.now(),
  });
  var receiptSig = await baseW.signMessage(receipt);

  return {
    status: "executed",
    sourceTxHash: txSrc.hash,
    destTxHash: txDst.hash,
    receipt: receipt,
    receiptSignature: receiptSig,
    ...feeResult,
  };
}
`;
}

export { getEvmEvmActionCode };
