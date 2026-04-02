import { ethers } from 'ethers';

const SWAP_CONTRACT_ABI = [
  'function getSwapState(uint256 swapId) view returns (uint8 state, address creator, address litActionEvmAddress, uint256 sourceAmount, uint256 destAmount, uint16 feeBps, uint256 expirationTimestamp, string litActionCid)',
  'function getSwapAddresses(uint256 swapId) view returns (string sourceChain, string destChain, string refundAddressSource, string refundAddressDest, string depositAddressSource, string depositAddressDest, uint256 confirmationBlocks)',
  'function swapCount() view returns (uint256)',
];

/**
 * Show swap status from the contract
 */
export async function statusSwap(opts) {
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

  const [sourceChain, destChain, refundSource, refundDest, depositSource, depositDest, confirmBlocks] =
    await contract.getSwapAddresses(swapId);

  const stateNames = ['Created', 'Funded', 'Executed', 'Refunded', 'Expired'];
  const isExpired = Date.now() / 1000 > Number(expiration);

  console.log(`=== Swap #${swapId} ===`);
  console.log(`State: ${stateNames[Number(state)]}${isExpired && Number(state) === 0 ? ' (EXPIRED — needs refund)' : ''}`);
  console.log(`Creator: ${creator}`);
  console.log(`Lit Action EVM Address: ${litAddr}`);
  console.log(`CID: ${cid}`);
  console.log();
  console.log(`Source: ${sourceChain}`);
  console.log(`  Amount: ${sourceAmount.toString()}`);
  console.log(`  Deposit: ${depositSource}`);
  console.log(`  Refund: ${refundSource}`);
  console.log();
  console.log(`Dest: ${destChain}`);
  console.log(`  Amount: ${destAmount.toString()}`);
  console.log(`  Deposit: ${depositDest}`);
  console.log(`  Refund: ${refundDest}`);
  console.log();
  console.log(`Fee: ${Number(feeBps)} bps`);
  console.log(`Confirmations: ${confirmBlocks.toString()}`);
  console.log(`Expires: ${new Date(Number(expiration) * 1000).toISOString()}`);
}
