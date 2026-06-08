/**
 * Settled — salt, action-template dispatch, CID + deposit-address derivation.
 *
 * F2: the salt is now a client-random 32-byte value (was derived from the
 * predicted next swapId, which raced when two creators acted at once). The salt
 * is not secret — security comes from the TEE key bound to the CID — so it is
 * published in the swap (emitted in SwapCreated) for CID verification.
 *
 * `crypto`/`fetch` are used via globalThis so this module works in both the
 * browser and Node tests. The audited per-pair generators live on
 * window.ActionTemplates (browser only); getActionCode is not called in Node.
 */

import { LIT_API_BASE } from './contract.js';
import { CHAINS } from '../actions/lib/networks.js';

/** F2: a fresh random salt, 32 bytes as lowercase hex. */
export function randomSalt() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Every EVM chain (mainnet + testnet) is enumerated in networks.js, so pull the
// 'evm' entries straight from there — adding a chain to the registry can never
// desync this map. The non-EVM families stay explicit because networks.js groups
// Bitcoin/Litecoin/Dogecoin under one 'utxo' family, while the template dispatch
// needs them split into btc/ltc/doge.
const EVM_FAMILY = Object.fromEntries(
  Object.entries(CHAINS).filter(([, c]) => c.family === 'evm').map(([id]) => [id, 'evm']),
);

export const CHAIN_FAMILY = {
  // EVM mainnet + testnet (incl. Base, the contract host) derive from networks.js.
  ...EVM_FAMILY,
  'bitcoin-signet': 'btc', 'litecoin-testnet': 'ltc', 'dogecoin-testnet': 'doge',
  'zcash-testnet': 'zec', 'zcash-mainnet': 'zec', 'solana-devnet': 'sol',
};

// Family pair -> registered template key (direction-independent).
export const TEMPLATE_BY_FAMILIES = {
  'evm,evm': 'evm-evm',
  'evm,btc': 'evm-btc', 'btc,evm': 'evm-btc',
  'evm,zec': 'evm-zec', 'zec,evm': 'evm-zec',
  'btc,zec': 'btc-zec', 'zec,btc': 'btc-zec',
  'btc,ltc': 'btc-ltc', 'ltc,btc': 'btc-ltc',
  'btc,doge': 'btc-doge', 'doge,btc': 'btc-doge',
  'evm,sol': 'evm-sol', 'sol,evm': 'evm-sol',
  'btc,sol': 'btc-sol', 'sol,btc': 'btc-sol',
  'zec,sol': 'zec-sol', 'sol,zec': 'zec-sol',
  'zec,ltc': 'zec-ltc', 'ltc,zec': 'zec-ltc',
  'zec,doge': 'zec-doge', 'doge,zec': 'zec-doge',
};

/** Resolve the template key from the actual chains (authoritative over any UI dropdown). */
export function templateKeyForChains(sourceChain, destChain) {
  const key = CHAIN_FAMILY[sourceChain] + ',' + CHAIN_FAMILY[destChain];
  return TEMPLATE_BY_FAMILIES[key];
}

// Confirmation depth a leg's settlement tx must reach before the engine
// finalizes. The conf gate (engine runSwap) applies ONLY to legs that expose
// confirmations() — UTXO + ZEC; EVM/SOL legs finalize immediately and ignore
// this. Mainnet UTXO/ZEC need reorg protection; testnets are shallow (1 is fine
// on signet/regtest-like nets). Per-chain values take precedence; the family
// fallback covers any UTXO/ZEC *mainnet* chain added later.
const CONF_BY_CHAIN = {
  'zcash-mainnet': 5,
  'zcash-testnet': 1, 'bitcoin-signet': 1, 'litecoin-testnet': 1, 'dogecoin-testnet': 1,
};
const CONF_BY_FAMILY = { btc: 4, ltc: 4, doge: 10, zec: 5 }; // mainnet defaults

/**
 * Chain-aware confirmationBlocks for a swap: the deepest requirement across its
 * two legs, floored at 1 so the gate is never created disabled (0). EVM/SOL
 * legs contribute 0 (no gate), so an all-EVM swap returns the floor of 1.
 */
export function confirmationBlocksFor(sourceChain, destChain) {
  const depth = (c) => (c in CONF_BY_CHAIN ? CONF_BY_CHAIN[c] : (CONF_BY_FAMILY[CHAIN_FAMILY[c]] || 0));
  return Math.max(1, depth(sourceChain), depth(destChain));
}

/** Build the action code string from the audited per-pair generator (browser only). */
export function getActionCode(actionType, salt, sourceChain, destChain) {
  const templates = (typeof window !== 'undefined' && window.ActionTemplates) || {};
  const gen = templates[actionType];
  if (!gen) throw new Error('No action template registered for "' + actionType + '"');
  return gen(salt, sourceChain, destChain);
}

/**
 * Pick a side's deposit address from a derive-mode result. The engine returns
 * evmAddress plus "<label>AddressSource" / "<label>AddressDest" keys. Fails loud
 * rather than silently routing funds to the EVM action identity.
 */
export function pickDeposit(addresses, side) {
  const suffix = side === 'source' ? 'AddressSource' : 'AddressDest';
  for (const k of Object.keys(addresses)) if (k.endsWith(suffix)) return addresses[k];
  throw new Error('Derive result missing ' + suffix + ' deposit address: ' + JSON.stringify(addresses));
}

/** Compute the IPFS CID for an action's code via the Lit API. */
export async function computeCid(code) {
  const resp = await globalThis.fetch(`${LIT_API_BASE}/core/v1/get_lit_action_ipfs_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(code),
  });
  if (!resp.ok) throw new Error('CID computation failed: ' + resp.status);
  const result = await resp.json();
  return result.ipfs_id || result.cid || result;
}

/** Run the action in derive mode to get the deposit addresses it controls. */
export async function deriveAddresses(litApiKey, actionCode) {
  const resp = await globalThis.fetch(`${LIT_API_BASE}/core/v1/lit_action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': litApiKey },
    body: JSON.stringify({ code: actionCode, js_params: { mode: 'derive' } }),
  });
  if (!resp.ok) throw new Error('Address derivation failed: ' + resp.status + ' ' + await resp.text());
  const result = await resp.json();
  return typeof result.response === 'string' ? JSON.parse(result.response) : result.response;
}
