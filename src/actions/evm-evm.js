/**
 * EVM <> EVM Cross-Chain Swap Lit Action
 *
 * This action runs inside the Lit network's Deno sandbox.
 * Available globals: Lit, ethers (v5), params (injected via js_params)
 *
 * Expected js_params:
 *   - swapId: number
 *   - sourceRpcUrl: string (e.g., "https://sepolia.base.org")
 *   - destRpcUrl: string (e.g., "https://rpc.sepolia.org")
 *   - baseRpcUrl: string (Base RPC for contract calls)
 *   - contractAddress: string (SwapContract on Base)
 *   - sourceAmount: string (wei)
 *   - destAmount: string (wei)
 *   - sourceRecipient: string (address to receive source chain funds)
 *   - destRecipient: string (address to receive dest chain funds)
 *   - refundAddressSource: string
 *   - refundAddressDest: string
 *   - depositAddressSource: string (Lit Action's address on source chain)
 *   - depositAddressDest: string (Lit Action's address on dest chain)
 *   - feeBps: number
 *   - feeRecipient: string (contract owner address)
 *   - expirationTimestamp: number (unix ms)
 *
 * SWAP_SALT is injected by the template engine for CID uniqueness.
 */

const SWAP_SALT = "{{SWAP_SALT}}";

async function main(params) {
  const privateKeyHex = await Lit.Actions.getLitActionPrivateKey();

  // 1. Check expiration
  if (Date.now() > params.expirationTimestamp) {
    // Attempt refunds for any deposited funds
    const refundResults = await refundIfNeeded(privateKeyHex, params);
    // Update contract state
    await callContract(params.baseRpcUrl, privateKeyHex, params.contractAddress,
      'function markRefunded(uint256)', [params.swapId]);
    return { status: 'refunded', ...refundResults };
  }

  // 2. Check balances on both chains
  const sourceProvider = new ethers.providers.JsonRpcProvider(params.sourceRpcUrl);
  const destProvider = new ethers.providers.JsonRpcProvider(params.destRpcUrl);

  const sourceBalance = await sourceProvider.getBalance(params.depositAddressSource);
  const destBalance = await destProvider.getBalance(params.depositAddressDest);

  const requiredSource = ethers.BigNumber.from(params.sourceAmount);
  const requiredDest = ethers.BigNumber.from(params.destAmount);

  if (sourceBalance.lt(requiredSource) || destBalance.lt(requiredDest)) {
    return {
      status: 'insufficient_funds',
      sourceBalance: sourceBalance.toString(),
      destBalance: destBalance.toString(),
      requiredSource: requiredSource.toString(),
      requiredDest: requiredDest.toString(),
    };
  }

  // 3. Calculate fees (rear-loaded: deducted from the amount sent to recipient)
  const feeBps = params.feeBps || 0;
  const sourceFee = requiredSource.mul(feeBps).div(10000);
  const destFee = requiredDest.mul(feeBps).div(10000);
  const sourceNet = requiredSource.sub(sourceFee);
  const destNet = requiredDest.sub(destFee);

  // 4. Execute swap — send funds to recipients
  const sourceWallet = new ethers.Wallet(privateKeyHex, sourceProvider);
  const destWallet = new ethers.Wallet(privateKeyHex, destProvider);

  // Send source chain funds to dest recipient (minus fee)
  const txSource = await sourceWallet.sendTransaction({
    to: params.destRecipient,
    value: sourceNet,
  });

  // Send dest chain funds to source recipient (minus fee)
  const txDest = await destWallet.sendTransaction({
    to: params.sourceRecipient,
    value: destNet,
  });

  // 5. Distribute fees to contract owner (if any)
  const feeResults = {};
  if (sourceFee.gt(0)) {
    const txSourceFee = await sourceWallet.sendTransaction({
      to: params.feeRecipient,
      value: sourceFee,
    });
    feeResults.sourceFeeHash = txSourceFee.hash;
  }
  if (destFee.gt(0)) {
    const txDestFee = await destWallet.sendTransaction({
      to: params.feeRecipient,
      value: destFee,
    });
    feeResults.destFeeHash = txDestFee.hash;
  }

  // 6. Update contract state on Base
  await callContract(params.baseRpcUrl, privateKeyHex, params.contractAddress,
    'function markExecuted(uint256)', [params.swapId]);

  return {
    status: 'executed',
    sourceTxHash: txSource.hash,
    destTxHash: txDest.hash,
    ...feeResults,
  };
}

/**
 * Helper: call a contract function on Base
 */
async function callContract(rpcUrl, privateKeyHex, contractAddress, funcSig, args) {
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKeyHex, provider);
  const contract = new ethers.Contract(contractAddress, [funcSig], wallet);
  const funcName = funcSig.split('function ')[1].split('(')[0];
  const tx = await contract[funcName](...args);
  return tx.hash;
}

/**
 * Helper: refund deposited funds if any exist
 */
async function refundIfNeeded(privateKeyHex, params) {
  const results = {};

  // Check and refund source chain
  const sourceProvider = new ethers.providers.JsonRpcProvider(params.sourceRpcUrl);
  const sourceBalance = await sourceProvider.getBalance(params.depositAddressSource);
  if (sourceBalance.gt(0) && params.refundAddressSource) {
    const wallet = new ethers.Wallet(privateKeyHex, sourceProvider);
    // Leave gas for the refund tx itself
    const gasPrice = await sourceProvider.getGasPrice();
    const gasCost = gasPrice.mul(21000);
    const refundAmount = sourceBalance.sub(gasCost);
    if (refundAmount.gt(0)) {
      const tx = await wallet.sendTransaction({
        to: params.refundAddressSource,
        value: refundAmount,
        gasLimit: 21000,
      });
      results.sourceRefundHash = tx.hash;
    }
  }

  // Check and refund dest chain
  const destProvider = new ethers.providers.JsonRpcProvider(params.destRpcUrl);
  const destBalance = await destProvider.getBalance(params.depositAddressDest);
  if (destBalance.gt(0) && params.refundAddressDest) {
    const wallet = new ethers.Wallet(privateKeyHex, destProvider);
    const gasPrice = await destProvider.getGasPrice();
    const gasCost = gasPrice.mul(21000);
    const refundAmount = destBalance.sub(gasCost);
    if (refundAmount.gt(0)) {
      const tx = await wallet.sendTransaction({
        to: params.refundAddressDest,
        value: refundAmount,
        gasLimit: 21000,
      });
      results.destRefundHash = tx.hash;
    }
  }

  return results;
}
