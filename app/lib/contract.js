/**
 * Settled — contract config + the single browser-side ABI home.
 *
 * This is the one place the browser describes the on-chain contract. It must
 * stay in sync with contracts/src/SwapContract.sol and with the in-action ABI
 * in app/actions/lib/engine.js (which runs in the Lit sandbox). The
 * getSwapAddresses tuple order in particular is decoded positionally by the
 * engine — see the FOUR-ADDRESS MODEL note there.
 *
 * The `ethers` global (loaded from the CDN in the HTML) is only referenced
 * inside functions, so this module is importable in Node for unit tests.
 */

export const LIT_API_BASE = 'https://api.chipotle.litprotocol.com';

// Contract deployed on Base Sepolia.
// TODO: update after deployment (and set CONTRACT_DEPLOY_BLOCK for the log scan).
export const CONTRACT_ADDRESS = '0x0000000000000000000000000000000000000000';

// First block to scan for IntentAnnounced/SwapCreated. Set to the contract's
// deployment block so the order-book scan never walks the whole chain.
export const CONTRACT_DEPLOY_BLOCK = 0;

export const CHAIN_RPC = {
  'base-sepolia': 'https://sepolia.base.org',
  'ethereum-sepolia': 'https://rpc.sepolia.org',
  'arbitrum-sepolia': 'https://sepolia-rollup.arbitrum.io/rpc',
  'optimism-sepolia': 'https://sepolia.optimism.io',
};

export const BASE_RPC = CHAIN_RPC['base-sepolia'];

export const STATE_NAMES = ['Created', 'Funded', 'Executed', 'Refunded', 'Expired'];
export const STATE_CLASSES = ['badge-created', 'badge-created', 'badge-executed', 'badge-refunded', 'badge-expired'];

export const CONTRACT_ABI = [
  // intent (order-book beacon) — user calls; no funds move
  'function announceIntent(bytes32 intentId, string sourceChain, string destChain, uint256 sourceAmount, uint256 minDestAmount, uint256 expiration, uint16 feeBps, address tokenSource, address tokenDest, string userRefundSource, string userReceiveDest)',
  // fill — solver calls with the real destAmount + the four role addresses
  'function createSwap(bytes32 intentId, string sourceChain, string destChain, uint256 sourceAmount, uint256 destAmount, uint256 minDestAmount, string userRefundSource, string userReceiveDest, string solverReceiveSource, string solverRefundDest, string depositAddressSource, string depositAddressDest, uint256 confirmationBlocks, uint256 expirationTimestamp, uint16 feeBps, string litActionCid, string salt, address litActionEvmAddress, address tokenAddressSource, address tokenAddressDest) returns (uint256)',
  'function markExecuted(uint256 swapId)',
  'function markRefunded(uint256 swapId)',
  'function getSwapState(uint256 swapId) view returns (uint8 state, address creator, address litActionEvmAddress, uint256 sourceAmount, uint256 destAmount, uint16 feeBps, uint256 expirationTimestamp, string litActionCid)',
  // FOUR-ADDRESS MODEL: four role addresses then the two deposits then confirmations
  'function getSwapAddresses(uint256 swapId) view returns (string sourceChain, string destChain, string userRefundSource, string userReceiveDest, string solverReceiveSource, string solverRefundDest, string depositAddressSource, string depositAddressDest, uint256 confirmationBlocks)',
  'function getSwapIntent(uint256 swapId) view returns (bytes32 intentId, uint256 minDestAmount, string salt)',
  'function getSwapLegs(uint256 swapId) view returns (bool sourceLegSettled, bool destLegSettled, string sourceLegTxHash, string destLegTxHash)',
  'function getSwapTokens(uint256 swapId) view returns (address tokenAddressSource, address tokenAddressDest)',
  'function swapCount() view returns (uint256)',
  'function owner() view returns (address)',
  'event IntentAnnounced(bytes32 indexed intentId, address indexed creator, string sourceChain, string destChain, uint256 sourceAmount, uint256 minDestAmount, uint256 expiration, uint16 feeBps, address tokenSource, address tokenDest, string userRefundSource, string userReceiveDest)',
  'event SwapCreated(uint256 indexed swapId, bytes32 indexed intentId, string sourceChain, string destChain, uint256 sourceAmount, uint256 destAmount, uint256 minDestAmount, string litActionCid, string salt, address creator)',
];

/** Read-only contract bound to the Base RPC. */
export function readContract() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
}

/** Read+write contract bound to the user's wallet signer. */
export function writeContract(signer) {
  return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
}

/**
 * Read a swap into one plain object, decoding the four-address tuple by name
 * (never by index downstream — that is the F1-class bug).
 */
export async function readSwap(swapId) {
  const c = readContract();
  const [state, addrs, intent, legs, tokens] = await Promise.all([
    c.getSwapState(swapId),
    c.getSwapAddresses(swapId),
    c.getSwapIntent(swapId),
    c.getSwapLegs(swapId),
    c.getSwapTokens(swapId),
  ]);
  return {
    swapId: String(swapId),
    state: Number(state[0]),
    stateName: STATE_NAMES[Number(state[0])],
    creator: state[1],
    litActionEvmAddress: state[2],
    sourceAmount: state[3],
    destAmount: state[4],
    feeBps: Number(state[5]),
    expirationTimestamp: Number(state[6]),
    litActionCid: state[7],
    sourceChain: addrs[0],
    destChain: addrs[1],
    userRefundSource: addrs[2],
    userReceiveDest: addrs[3],
    solverReceiveSource: addrs[4],
    solverRefundDest: addrs[5],
    depositAddressSource: addrs[6],
    depositAddressDest: addrs[7],
    confirmationBlocks: Number(addrs[8]),
    intentId: intent[0],
    minDestAmount: intent[1],
    salt: intent[2],
    sourceLegSettled: legs[0],
    destLegSettled: legs[1],
    sourceLegTxHash: legs[2],
    destLegTxHash: legs[3],
    tokenAddressSource: tokens[0],
    tokenAddressDest: tokens[1],
  };
}
