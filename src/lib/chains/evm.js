/**
 * EVM chain utilities for use inside Lit Actions.
 * These functions use the globally available `ethers` (v5) in the Lit runtime.
 */

/**
 * Check balance of an address on an EVM chain
 * @param {string} rpcUrl - RPC endpoint
 * @param {string} address - EVM address to check
 * @returns {Promise<bigint>} Balance in wei
 */
export async function checkBalance(rpcUrl, address) {
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const balance = await provider.getBalance(address);
  return balance;
}

/**
 * Send native token (ETH/etc) on an EVM chain
 * @param {string} rpcUrl - RPC endpoint
 * @param {string} privateKeyHex - 32-byte hex private key
 * @param {string} to - Destination address
 * @param {string} amountWei - Amount in wei (as string)
 * @returns {Promise<string>} Transaction hash
 */
export async function sendFunds(rpcUrl, privateKeyHex, to, amountWei) {
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKeyHex, provider);

  const tx = await wallet.sendTransaction({
    to,
    value: ethers.BigNumber.from(amountWei),
  });

  return tx.hash;
}

/**
 * Call markExecuted on the SwapContract
 * @param {string} rpcUrl - Base RPC endpoint
 * @param {string} privateKeyHex - Lit Action's private key
 * @param {string} contractAddress - SwapContract address on Base
 * @param {number} swapId - Swap ID to mark
 * @returns {Promise<string>} Transaction hash
 */
export async function markExecuted(rpcUrl, privateKeyHex, contractAddress, swapId) {
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKeyHex, provider);

  const abi = ['function markExecuted(uint256 swapId)'];
  const contract = new ethers.Contract(contractAddress, abi, wallet);
  const tx = await contract.markExecuted(swapId);
  return tx.hash;
}

/**
 * Call markRefunded on the SwapContract
 */
export async function markRefunded(rpcUrl, privateKeyHex, contractAddress, swapId) {
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKeyHex, provider);

  const abi = ['function markRefunded(uint256 swapId)'];
  const contract = new ethers.Contract(contractAddress, abi, wallet);
  const tx = await contract.markRefunded(swapId);
  return tx.hash;
}

/**
 * Derive EVM address from a hex private key
 * @param {string} privateKeyHex - 32-byte hex key
 * @returns {string} EVM address
 */
export function deriveAddress(privateKeyHex) {
  const wallet = new ethers.Wallet(privateKeyHex);
  return wallet.address;
}
