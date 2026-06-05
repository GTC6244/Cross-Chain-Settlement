/**
 * Registers the audited per-pair action-template generators on window so the
 * classic dispatch (derive.getActionCode) can reach them. Both apps load this.
 *
 * Loading these modules does NOT fetch jsDelivr — the jsDelivr imports live only
 * inside the generated action strings, which run in the Lit sandbox.
 */
import { getEvmEvmActionCode } from '../actions/evm-evm-action.js';
import { getEvmBtcActionCode } from '../actions/evm-btc-action.js';
import { getEvmZecActionCode } from '../actions/evm-zec-action.js';
import { getBtcZecActionCode } from '../actions/btc-zec-action.js';
import { getBtcLtcActionCode } from '../actions/btc-ltc-action.js';
import { getBtcDogeActionCode } from '../actions/btc-doge-action.js';
import { getEvmSolActionCode } from '../actions/evm-sol-action.js';
import { getBtcSolActionCode } from '../actions/btc-sol-action.js';
import { getZecSolActionCode } from '../actions/zec-sol-action.js';
import { getZecLtcActionCode } from '../actions/zec-ltc-action.js';
import { getZecDogeActionCode } from '../actions/zec-doge-action.js';

export const ActionTemplates = {
  'evm-evm': getEvmEvmActionCode,
  'evm-btc': getEvmBtcActionCode,
  'evm-zec': getEvmZecActionCode,
  'btc-zec': getBtcZecActionCode,
  'btc-ltc': getBtcLtcActionCode,
  'btc-doge': getBtcDogeActionCode,
  'evm-sol': getEvmSolActionCode,
  'btc-sol': getBtcSolActionCode,
  'zec-sol': getZecSolActionCode,
  'zec-ltc': getZecLtcActionCode,
  'zec-doge': getZecDogeActionCode,
};

if (typeof window !== 'undefined') window.ActionTemplates = ActionTemplates;
