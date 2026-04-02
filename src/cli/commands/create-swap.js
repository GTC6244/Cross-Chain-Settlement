import { ethers } from 'ethers';
import { prepareAction } from '../../template-engine/index.js';

const SWAP_CONTRACT_ABI = [
  'function createSwap(string sourceChain, string destChain, uint256 sourceAmount, uint256 destAmount, string refundAddressSource, string refundAddressDest, string depositAddressSource, string depositAddressDest, uint256 confirmationBlocks, uint256 expirationTimestamp, uint16 feeBps, string litActionCid, address litActionEvmAddress) returns (uint256)',
  'function swapCount() view returns (uint256)',
];

/**
 * Create a new cross-chain swap
 */
export async function createSwap(opts) {
  const litApiKey = process.env.LIT_API_KEY;
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  const contractAddress = process.env.SWAP_CONTRACT_ADDRESS;
  const baseRpcUrl = process.env.BASE_RPC_URL || 'https://sepolia.base.org';

  if (!litApiKey) {
    console.error('Error: LIT_API_KEY environment variable required');
    process.exit(1);
  }
  if (!privateKey) {
    console.error('Error: DEPLOYER_PRIVATE_KEY environment variable required');
    process.exit(1);
  }
  if (!contractAddress) {
    console.error('Error: SWAP_CONTRACT_ADDRESS environment variable required');
    process.exit(1);
  }

  const timestamp = Date.now();
  const expirationTimestamp = timestamp + (parseInt(opts.expiration) * 1000);

  console.log('Preparing Lit Action...');

  // Prepare the action (inject salt, compute CID, derive addresses)
  const action = await prepareAction({
    actionType: opts.actionType,
    swapId: '0', // temporary, will be replaced after contract call
    contractAddress,
    timestamp,
    apiKey: litApiKey,
  });

  console.log(`  IPFS CID: ${action.cid}`);
  console.log(`  Salt: ${action.salt}`);

  if (action.addresses) {
    console.log(`  EVM deposit address: ${action.addresses.evmAddress}`);
    if (action.addresses.btcAddress) {
      console.log(`  BTC deposit address: ${action.addresses.btcAddress}`);
    }
  }

  // For EVM-EVM, deposit addresses are the same on both chains
  const depositAddressSource = action.addresses?.evmAddress || 'pending-lit-execution';
  const depositAddressDest = action.addresses?.evmAddress || 'pending-lit-execution';
  const litActionEvmAddress = action.addresses?.evmAddress || ethers.ZeroAddress;

  console.log('\nCreating swap on Base contract...');

  const provider = new ethers.JsonRpcProvider(baseRpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(contractAddress, SWAP_CONTRACT_ABI, wallet);

  const tx = await contract.createSwap(
    opts.sourceChain,
    opts.destChain,
    opts.sourceAmount,
    opts.destAmount,
    opts.refundSource,
    opts.refundDest,
    depositAddressSource,
    depositAddressDest,
    parseInt(opts.confirmations),
    Math.floor(expirationTimestamp / 1000),
    parseInt(opts.feeBps),
    action.cid,
    litActionEvmAddress,
  );

  console.log(`  Tx hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  Confirmed in block: ${receipt.blockNumber}`);

  // Parse the SwapCreated event to get the swap ID
  const swapCreatedEvent = receipt.logs.find(log => {
    try {
      const parsed = contract.interface.parseLog(log);
      return parsed?.name === 'SwapCreated';
    } catch { return false; }
  });

  const swapId = swapCreatedEvent
    ? contract.interface.parseLog(swapCreatedEvent).args[0]
    : 'unknown';

  console.log(`\n=== Swap Created ===`);
  console.log(`Swap ID: ${swapId}`);
  console.log(`Type: ${opts.actionType}`);
  console.log(`Source: ${opts.sourceChain} (${opts.sourceAmount})`);
  console.log(`Dest: ${opts.destChain} (${opts.destAmount})`);
  console.log(`Fee: ${opts.feeBps} bps`);
  console.log(`Expires: ${new Date(expirationTimestamp).toISOString()}`);
  console.log(`\nDeposit addresses:`);
  console.log(`  Source (${opts.sourceChain}): ${depositAddressSource}`);
  console.log(`  Dest (${opts.destChain}): ${depositAddressDest}`);
  console.log(`\nNext: Fund both deposit addresses, then run:`);
  console.log(`  action-swaps execute --swap-id ${swapId}`);
}
