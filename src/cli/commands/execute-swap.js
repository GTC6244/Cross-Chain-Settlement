import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { executeAction, generateSalt, injectSalt } from '../../template-engine/index.js';

const SWAP_CONTRACT_ABI = [
  'function getSwapState(uint256 swapId) view returns (uint8 state, address creator, address litActionEvmAddress, uint256 sourceAmount, uint256 destAmount, uint16 feeBps, uint256 expirationTimestamp, string litActionCid)',
  'function getSwapAddresses(uint256 swapId) view returns (string sourceChain, string destChain, string refundAddressSource, string refundAddressDest, string depositAddressSource, string depositAddressDest, uint256 confirmationBlocks)',
  'function owner() view returns (address)',
];

const CHAIN_RPC = {
  'base-sepolia': 'https://sepolia.base.org',
  'ethereum-sepolia': 'https://rpc.sepolia.org',
  'arbitrum-sepolia': 'https://sepolia-rollup.arbitrum.io/rpc',
  'optimism-sepolia': 'https://sepolia.optimism.io',
};

// Map chain pair to action type
function getActionType(sourceChain, destChain) {
  const isEvmSource = sourceChain.includes('sepolia') || sourceChain.includes('base') || sourceChain.includes('ethereum') || sourceChain.includes('arbitrum') || sourceChain.includes('optimism');
  const isEvmDest = destChain.includes('sepolia') || destChain.includes('base') || destChain.includes('ethereum') || destChain.includes('arbitrum') || destChain.includes('optimism');

  if (isEvmSource && isEvmDest) return 'evm-evm';
  if (isEvmSource && destChain.includes('bitcoin')) return 'evm-btc';
  if (isEvmSource && destChain.includes('zcash')) return 'evm-zec';
  if (sourceChain.includes('bitcoin') && destChain.includes('zcash')) return 'btc-zec';

  throw new Error(`Unsupported chain pair: ${sourceChain} <> ${destChain}`);
}

/**
 * Execute a funded swap by triggering its Lit Action
 */
export async function executeSwap(opts) {
  const litApiKey = process.env.LIT_API_KEY;
  const contractAddress = process.env.SWAP_CONTRACT_ADDRESS;
  const baseRpcUrl = process.env.BASE_RPC_URL || 'https://sepolia.base.org';

  if (!litApiKey) {
    console.error('Error: LIT_API_KEY environment variable required');
    process.exit(1);
  }
  if (!contractAddress) {
    console.error('Error: SWAP_CONTRACT_ADDRESS environment variable required');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(baseRpcUrl);
  const contract = new ethers.Contract(contractAddress, SWAP_CONTRACT_ABI, provider);

  const swapId = parseInt(opts.swapId);

  // Read swap details from contract
  const [state, creator, litAddr, sourceAmount, destAmount, feeBps, expiration, cid] =
    await contract.getSwapState(swapId);

  if (Number(state) !== 0) {
    const stateNames = ['Created', 'Funded', 'Executed', 'Refunded', 'Expired'];
    console.error(`Error: Swap is in state ${stateNames[Number(state)]}, not Created`);
    process.exit(1);
  }

  const [sourceChain, destChain, refundSource, refundDest, depositSource, depositDest, confirmBlocks] =
    await contract.getSwapAddresses(swapId);

  const feeRecipient = await contract.owner();

  const actionType = getActionType(sourceChain, destChain);
  const sourceRpcUrl = CHAIN_RPC[sourceChain];
  const destRpcUrl = CHAIN_RPC[destChain];

  if (!sourceRpcUrl || !destRpcUrl) {
    console.error(`Error: No RPC URL configured for ${sourceChain} or ${destChain}`);
    console.error('Only EVM chains are supported for automatic execution currently.');
    process.exit(1);
  }

  // Load and prepare the action code
  // The CID was computed at creation time with a specific salt
  // We need to reconstruct the same code
  const templatePath = new URL(`../../actions/${actionType}.js`, import.meta.url).pathname;

  console.log(`=== Executing Swap #${swapId} ===`);
  console.log(`Type: ${actionType}`);
  console.log(`Source: ${sourceChain} -> ${destChain}`);
  console.log(`CID: ${cid}`);

  // Build js_params for the Lit Action
  const jsParams = {
    swapId,
    sourceRpcUrl,
    destRpcUrl,
    baseRpcUrl,
    contractAddress,
    sourceAmount: sourceAmount.toString(),
    destAmount: destAmount.toString(),
    sourceRecipient: refundDest,  // Source chain funds go to dest party
    destRecipient: refundSource,   // Dest chain funds go to source party
    refundAddressSource: refundSource,
    refundAddressDest: refundDest,
    depositAddressSource: depositSource,
    depositAddressDest: depositDest,
    feeBps: Number(feeBps),
    feeRecipient,
    expirationTimestamp: Number(expiration) * 1000,
  };

  console.log('\nExecuting Lit Action...');

  // Read the action code — in production this would be fetched from IPFS by CID
  // For now, we read from disk and the Lit API verifies the CID matches
  const actionCode = readFileSync(templatePath, 'utf8');

  const result = await executeAction(litApiKey, actionCode, jsParams);

  console.log('\nResult:');
  console.log(JSON.stringify(result, null, 2));

  if (result.response) {
    const response = typeof result.response === 'string'
      ? JSON.parse(result.response)
      : result.response;

    if (response.status === 'executed') {
      console.log('\n=== SWAP EXECUTED SUCCESSFULLY ===');
      console.log(`Source tx: ${response.sourceTxHash}`);
      console.log(`Dest tx: ${response.destTxHash}`);
    } else if (response.status === 'insufficient_funds') {
      console.log('\n=== INSUFFICIENT FUNDS ===');
      console.log(`Source: ${response.sourceBalance} / ${response.requiredSource}`);
      console.log(`Dest: ${response.destBalance} / ${response.requiredDest}`);
    } else if (response.status === 'refunded') {
      console.log('\n=== SWAP REFUNDED (expired) ===');
    }
  }
}
