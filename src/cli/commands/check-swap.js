import { ethers } from 'ethers';

const SWAP_CONTRACT_ABI = [
  'function getSwapState(uint256 swapId) view returns (uint8 state, address creator, address litActionEvmAddress, uint256 sourceAmount, uint256 destAmount, uint16 feeBps, uint256 expirationTimestamp, string litActionCid)',
  'function getSwapAddresses(uint256 swapId) view returns (string sourceChain, string destChain, string refundAddressSource, string refundAddressDest, string depositAddressSource, string depositAddressDest, uint256 confirmationBlocks)',
];

// Chain ID to RPC URL mapping
const CHAIN_RPC = {
  'base-sepolia': 'https://sepolia.base.org',
  'ethereum-sepolia': 'https://rpc.sepolia.org',
  'arbitrum-sepolia': 'https://sepolia-rollup.arbitrum.io/rpc',
  'optimism-sepolia': 'https://sepolia.optimism.io',
};

/**
 * Check deposit status for both sides of a swap
 */
export async function checkSwap(opts) {
  const contractAddress = process.env.SWAP_CONTRACT_ADDRESS;
  const baseRpcUrl = process.env.BASE_RPC_URL || 'https://sepolia.base.org';

  if (!contractAddress) {
    console.error('Error: SWAP_CONTRACT_ADDRESS environment variable required');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(baseRpcUrl);
  const contract = new ethers.Contract(contractAddress, SWAP_CONTRACT_ABI, provider);

  const swapId = parseInt(opts.swapId);

  const [state, creator, litAddr, sourceAmount, destAmount, feeBps, expiration, cid] =
    await contract.getSwapState(swapId);

  const [sourceChain, destChain, , , depositSource, depositDest, confirmBlocks] =
    await contract.getSwapAddresses(swapId);

  const stateNames = ['Created', 'Funded', 'Executed', 'Refunded', 'Expired'];
  console.log(`=== Swap #${swapId} ===`);
  console.log(`State: ${stateNames[Number(state)]}`);
  console.log(`CID: ${cid}`);
  console.log(`Expires: ${new Date(Number(expiration) * 1000).toISOString()}`);

  // Check balances on both chains
  const sourceRpc = CHAIN_RPC[sourceChain];
  const destRpc = CHAIN_RPC[destChain];

  if (sourceRpc) {
    const srcProvider = new ethers.JsonRpcProvider(sourceRpc);
    const srcBalance = await srcProvider.getBalance(depositSource);
    const needed = ethers.getBigInt(sourceAmount);
    const funded = srcBalance >= needed;
    console.log(`\nSource (${sourceChain}):`);
    console.log(`  Deposit address: ${depositSource}`);
    console.log(`  Balance: ${ethers.formatEther(srcBalance)} ETH`);
    console.log(`  Required: ${ethers.formatEther(needed)} ETH`);
    console.log(`  Status: ${funded ? 'FUNDED' : 'WAITING'}`);
  } else {
    console.log(`\nSource (${sourceChain}): RPC not configured — check manually`);
    console.log(`  Deposit address: ${depositSource}`);
  }

  if (destRpc) {
    const dstProvider = new ethers.JsonRpcProvider(destRpc);
    const dstBalance = await dstProvider.getBalance(depositDest);
    const needed = ethers.getBigInt(destAmount);
    const funded = dstBalance >= needed;
    console.log(`\nDest (${destChain}):`);
    console.log(`  Deposit address: ${depositDest}`);
    console.log(`  Balance: ${ethers.formatEther(dstBalance)} ETH`);
    console.log(`  Required: ${ethers.formatEther(needed)} ETH`);
    console.log(`  Status: ${funded ? 'FUNDED' : 'WAITING'}`);
  } else {
    console.log(`\nDest (${destChain}): RPC not configured — check manually`);
    console.log(`  Deposit address: ${depositDest}`);
  }
}
