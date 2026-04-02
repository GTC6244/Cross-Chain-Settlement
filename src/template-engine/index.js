import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { ethers } from 'ethers';

const LIT_API_BASE = process.env.LIT_API_BASE || 'https://api.chipotle.litprotocol.com';

/**
 * Generate a unique salt for a swap
 * @param {string} swapId - Numeric swap ID
 * @param {string} contractAddress - SwapContract address
 * @param {number} timestamp - Creation timestamp
 * @returns {string} SHA-256 hex hash
 */
export function generateSalt(swapId, contractAddress, timestamp) {
  return createHash('sha256')
    .update(`${swapId}:${contractAddress}:${timestamp}`)
    .digest('hex');
}

/**
 * Load a Lit Action template and inject the swap salt
 * @param {string} templatePath - Path to the action JS file
 * @param {string} salt - Unique salt for this swap
 * @returns {string} Action code with salt injected
 */
export function injectSalt(templatePath, salt) {
  const template = readFileSync(templatePath, 'utf8');
  return template.replace('{{SWAP_SALT}}', salt);
}

/**
 * Compute the IPFS CID for action code via the Lit API
 * (No authentication required)
 * @param {string} code - JavaScript action code
 * @returns {Promise<string>} IPFS CID
 */
export async function computeCid(code) {
  const resp = await fetch(`${LIT_API_BASE}/core/v1/get_lit_action_ipfs_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(code),
  });

  if (!resp.ok) {
    throw new Error(`Failed to compute CID: ${resp.status} ${await resp.text()}`);
  }

  const result = await resp.json();
  return result.ipfs_id || result.cid || result;
}

/**
 * Register an action with the Lit API
 * @param {string} apiKey - Lit API key
 * @param {string} cid - IPFS CID
 * @param {string} name - Action name
 * @param {string} description - Action description
 */
export async function registerAction(apiKey, cid, name, description) {
  const resp = await fetch(`${LIT_API_BASE}/core/v1/add_action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify({
      action_ipfs_cid: cid,
      name,
      description,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Failed to register action: ${resp.status} ${await resp.text()}`);
  }

  return resp.json();
}

/**
 * Execute a Lit Action via the REST API
 * @param {string} apiKey - Lit usage API key
 * @param {string} code - Action JavaScript code
 * @param {object} jsParams - Parameters to pass to main()
 * @returns {Promise<{response: any, logs: string[]}>}
 */
export async function executeAction(apiKey, code, jsParams) {
  const resp = await fetch(`${LIT_API_BASE}/core/v1/lit_action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify({
      code,
      js_params: jsParams,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Failed to execute action: ${resp.status} ${await resp.text()}`);
  }

  return resp.json();
}

/**
 * Derive deposit addresses for a swap from the action code's implied key.
 *
 * Since we can't get the private key without executing on Lit,
 * we execute a minimal action that just returns the derived addresses.
 *
 * @param {string} apiKey - Lit API key
 * @param {string} actionCode - The full action code (with salt injected)
 * @returns {Promise<{evmAddress: string, publicKey: string}>}
 */
export async function deriveAddresses(apiKey, actionCode) {
  const addressAction = `
    async function main() {
      const key = await Lit.Actions.getLitActionPrivateKey();
      const wallet = new ethers.Wallet(key);
      return {
        evmAddress: wallet.address,
        publicKey: wallet.signingKey.compressedPublicKey,
      };
    }
  `;

  // The address derivation action needs the same salt to get the same CID/key
  // We append the salt from the real action to make the CID unique
  const saltMatch = actionCode.match(/const SWAP_SALT = "([^"]+)"/);
  const salt = saltMatch ? saltMatch[1] : '';
  const uniqueAddressAction = `const _SALT = "${salt}";\n${addressAction}`;

  const result = await executeAction(apiKey, uniqueAddressAction, {});
  const response = typeof result.response === 'string'
    ? JSON.parse(result.response)
    : result.response;

  return response;
}

/**
 * Full pipeline: generate action for a swap, compute CID, derive addresses
 * @param {object} opts
 * @param {string} opts.actionType - "evm-evm", "evm-btc", "evm-zec", "btc-zec"
 * @param {string} opts.swapId
 * @param {string} opts.contractAddress
 * @param {number} opts.timestamp
 * @param {string} [opts.apiKey] - Required for address derivation
 * @returns {Promise<{code: string, cid: string, salt: string, addresses?: object}>}
 */
export async function prepareAction(opts) {
  const { actionType, swapId, contractAddress, timestamp, apiKey } = opts;

  // Map action type to template file
  const templateMap = {
    'evm-evm': new URL('../actions/evm-evm.js', import.meta.url).pathname,
    'evm-btc': new URL('../actions/evm-btc.js', import.meta.url).pathname,
    'evm-zec': new URL('../actions/evm-zec.js', import.meta.url).pathname,
    'btc-zec': new URL('../actions/btc-zec.js', import.meta.url).pathname,
  };

  const templatePath = templateMap[actionType];
  if (!templatePath) {
    throw new Error(`Unknown action type: ${actionType}`);
  }

  // Generate unique salt and inject into template
  const salt = generateSalt(swapId, contractAddress, timestamp);
  const code = injectSalt(templatePath, salt);

  // Compute IPFS CID
  const cid = await computeCid(code);

  const result = { code, cid, salt };

  // Derive addresses if API key is provided
  if (apiKey) {
    result.addresses = await deriveAddresses(apiKey, code);
  }

  return result;
}
