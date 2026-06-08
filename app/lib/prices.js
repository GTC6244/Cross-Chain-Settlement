/**
 * Settled — live market price quotes for the solver.
 *
 * Pulls each leg asset's USD spot from THREE independent, key-free public
 * sources (CoinGecko, Coinbase, CryptoCompare) so a solver can sanity-check a
 * quote against the market before committing real funds. No source is trusted
 * alone: the cross-rate is the MEDIAN of whatever sources answered, and every
 * source is shown so an outlier stands out. CORS-friendly endpoints only — this
 * runs entirely in the browser, no backend, no API key.
 *
 * Prices are ADVISORY display only — the on-chain floor and the solver's own
 * judgement govern. Never feed these Numbers into value math that moves funds
 * (Number() of 18-decimal wei loses precision; that's fine for a display rate).
 */

// chain id -> the native asset its leg settles in (testnets price as mainnet).
export const ASSET_BY_CHAIN = {
  'base': 'ETH', 'base-sepolia': 'ETH', 'ethereum-sepolia': 'ETH',
  'arbitrum-sepolia': 'ETH', 'optimism-sepolia': 'ETH',
  'bitcoin-signet': 'BTC',
  'litecoin-testnet': 'LTC',
  'dogecoin-testnet': 'DOGE',
  'zcash-testnet': 'ZEC', 'zcash-mainnet': 'ZEC',
  'solana-devnet': 'SOL',
};

// smallest-unit decimals per native asset (must track networks.js CHAINS).
export const DECIMALS_BY_ASSET = { ETH: 18, BTC: 8, LTC: 8, DOGE: 8, ZEC: 8, SOL: 9 };

// CoinGecko coin ids for the assets we settle.
const COINGECKO_ID = { ETH: 'ethereum', BTC: 'bitcoin', LTC: 'litecoin', DOGE: 'dogecoin', ZEC: 'zcash', SOL: 'solana' };

const TIMEOUT_MS = 8000;

/** fetch with an abort timeout so one slow source can't hang the panel. */
async function timedFetch(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try { return await fetch(url, Object.assign({ signal: ctrl.signal }, opts)); }
  finally { clearTimeout(t); }
}

// ---- the three sources. Each: (symbols[]) -> { SYM: usdPrice } -------------

/** Source 1 — CoinGecko simple price (one batched call). */
async function coingecko(symbols) {
  const ids = symbols.map((s) => COINGECKO_ID[s]).filter(Boolean).join(',');
  const r = await timedFetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const out = {};
  for (const s of symbols) { const v = j[COINGECKO_ID[s]] && j[COINGECKO_ID[s]].usd; if (v) out[s] = v; }
  return out;
}

/** Source 2 — Coinbase spot price (one call per asset). */
async function coinbase(symbols) {
  const out = {};
  await Promise.all(symbols.map(async (s) => {
    try {
      const r = await timedFetch(`https://api.coinbase.com/v2/prices/${s}-USD/spot`);
      if (!r.ok) return;
      const j = await r.json();
      const v = Number(j && j.data && j.data.amount);
      if (v) out[s] = v;
    } catch (e) { /* leave this symbol unset; aggregate flags it */ }
  }));
  return out;
}

/** Source 3 — CryptoCompare multi-price (one batched call). */
async function cryptocompare(symbols) {
  const r = await timedFetch(`https://min-api.cryptocompare.com/data/pricemulti?fsyms=${symbols.join(',')}&tsyms=USD`);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.Response === 'Error') throw new Error(j.Message || 'source error');
  const out = {};
  for (const s of symbols) { const v = j[s] && j[s].USD; if (v) out[s] = v; }
  return out;
}

export const PRICE_SOURCES = [
  { id: 'coingecko', label: 'CoinGecko', fetch: coingecko },
  { id: 'coinbase', label: 'Coinbase', fetch: coinbase },
  { id: 'cryptocompare', label: 'CryptoCompare', fetch: cryptocompare },
];

/** Median of a numeric array (mean of the two middles for even length). */
export function median(nums) {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Raw smallest-unit amount -> human Number (display only — may lose precision). */
export function toHuman(rawAmount, asset) {
  return Number(rawAmount) / Math.pow(10, DECIMALS_BY_ASSET[asset]);
}

/** Human Number -> raw smallest-unit Number (display only). */
export function toRaw(humanAmount, asset) {
  return humanAmount * Math.pow(10, DECIMALS_BY_ASSET[asset]);
}

/**
 * Fetch the market cross-rate for a sourceChain -> destChain pair across all
 * three sources concurrently. Returns:
 *   { sourceAsset, destAsset,
 *     sources: [{ id, label, ok, srcUsd, destUsd, rate, error }],
 *     count, medianRate, medianSrcUsd, medianDestUsd }
 * `rate` is "dest units per 1 source unit" = srcUsd / destUsd. A source that
 * fails or is missing either leg's price comes back ok:false (never throws).
 */
export async function fetchMarketRate(sourceChain, destChain) {
  const sourceAsset = ASSET_BY_CHAIN[sourceChain];
  const destAsset = ASSET_BY_CHAIN[destChain];
  if (!sourceAsset || !destAsset) throw new Error('No market asset mapping for this pair.');
  const symbols = [...new Set([sourceAsset, destAsset])];

  const sources = await Promise.all(PRICE_SOURCES.map(async (src) => {
    try {
      const px = await src.fetch(symbols);
      const srcUsd = px[sourceAsset];
      const destUsd = px[destAsset];
      if (!srcUsd || !destUsd) {
        return { id: src.id, label: src.label, ok: false, error: 'no ' + (!srcUsd ? sourceAsset : destAsset) + ' price' };
      }
      return { id: src.id, label: src.label, ok: true, srcUsd, destUsd, rate: srcUsd / destUsd };
    } catch (e) {
      return { id: src.id, label: src.label, ok: false, error: String((e && e.message) || e) };
    }
  }));

  const ok = sources.filter((s) => s.ok);
  return {
    sourceAsset, destAsset, sources,
    count: ok.length,
    medianRate: median(ok.map((s) => s.rate)),
    medianSrcUsd: median(ok.map((s) => s.srcUsd)),
    medianDestUsd: median(ok.map((s) => s.destUsd)),
  };
}
