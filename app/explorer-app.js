/**
 * Settled — EXPLORER app controller (the read-only "look" side).
 *
 * Lists every swap the contract has recorded and, on click, expands the full
 * on-chain record: state, the four role addresses, deposit addresses, both
 * legs, the fee, and the Lit Action that custodied it. No wallet, no writes —
 * it binds only to the Base RPC through the shared read helpers in app/lib/*.
 */
import {
  CONTRACT_ADDRESS, STATE_NAMES, STATE_CLASSES, readContract, readSwap,
} from './lib/contract.js';
import { toggleTheme, initThemeLabel } from './lib/ui.js';

// Human labels for the chain identifiers the contract stores as strings.
const CHAIN_LABELS = {
  // mainnet (live)
  'base': 'Base', 'ethereum': 'Ethereum', 'bitcoin': 'Bitcoin',
  'litecoin': 'Litecoin', 'dogecoin': 'Dogecoin', 'zcash': 'Zcash', 'solana': 'Solana',
  // testnets
  'base-sepolia': 'Base Sepolia', 'ethereum-sepolia': 'Ethereum Sepolia',
  'arbitrum-sepolia': 'Arbitrum Sepolia', 'optimism-sepolia': 'Optimism Sepolia',
  'bitcoin-signet': 'Bitcoin Signet', 'litecoin-testnet': 'Litecoin Testnet',
  'dogecoin-testnet': 'Dogecoin Testnet', 'zcash-testnet': 'Zcash Testnet',
  'solana-devnet': 'Solana Devnet',
};
const chainLabel = (id) => CHAIN_LABELS[id] || id || '—';

// Cap how many swaps we hydrate in one pass so a busy contract never walks the
// whole history; we always show the newest first and log what was withheld.
const MAX_RENDER = 100;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

const expanded = new Set(); // swapIds whose detail panel is open
let swaps = [];             // hydrated, newest-first

// ---- helpers --------------------------------------------------------------
function banner(html, cls) {
  const el = document.getElementById('explore-banner');
  if (!html) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="state-banner ${cls || ''}">${cls === 'loading' ? '<span class="spinner"></span>' : ''}<span>${html}</span></div>`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const iso = (sec) => (sec ? new Date(sec * 1000).toISOString().replace('.000Z', 'Z') : '—');
const feePct = (bps) => (bps / 100).toFixed(2).replace(/\.00$/, '') + '%';

/** Run `fn` over `items` with a small concurrency cap (keeps the RPC happy). */
async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// ---- load -----------------------------------------------------------------
async function load() {
  const rowsEl = document.getElementById('explore-rows');
  const emptyEl = document.getElementById('explore-empty');
  const ledgerEl = document.getElementById('explore-ledger');
  document.getElementById('contract-addr').textContent = CONTRACT_ADDRESS;

  if (CONTRACT_ADDRESS === ZERO_ADDR) {
    ledgerEl.style.display = 'none'; emptyEl.style.display = 'none';
    banner('Contract address is not set yet (still <span class="addr">0x000…000</span>). Set <span class="k">CONTRACT_ADDRESS</span> in <span class="addr">app/lib/contract.js</span> after deployment to populate the explorer.', 'stale');
    document.getElementById('swap-count').textContent = '0';
    return;
  }

  banner('Loading swaps from the contract…', 'loading');
  try {
    const c = readContract();
    const count = Number(await c.swapCount());
    document.getElementById('swap-count').textContent = String(count);

    if (count === 0) {
      ledgerEl.style.display = 'none'; emptyEl.style.display = 'block';
      banner('');
      return;
    }

    // Newest first, capped.
    const ids = [];
    for (let id = count - 1; id >= 0 && ids.length < MAX_RENDER; id--) ids.push(id);
    const hidden = count - ids.length;

    const loaded = await pooled(ids, 6, async (id) => {
      try { return await readSwap(id); }
      catch (err) { console.error('swap', id, err); return { swapId: String(id), _error: err.message }; }
    });
    swaps = loaded;

    ledgerEl.style.display = 'block'; emptyEl.style.display = 'none';
    renderRows(rowsEl);
    banner(hidden > 0
      ? `Showing the ${ids.length} most recent swaps. ${hidden} older swap${hidden === 1 ? '' : 's'} not loaded — use “Jump to #”.`
      : '', hidden > 0 ? 'stale' : '');
  } catch (err) {
    banner('Could not reach the contract: ' + esc(err.message), 'error');
    console.error(err);
  }
}

// ---- render ---------------------------------------------------------------
function renderRows(rowsEl) {
  rowsEl.innerHTML = swaps.map(rowHtml).join('');
  rowsEl.querySelectorAll('.ledger-row').forEach((row) => {
    row.addEventListener('click', () => toggle(row.dataset.id));
  });
}

function rowHtml(s) {
  if (s._error) {
    return `<div class="ledger-row" data-id="${s.swapId}"><span class="id">#${s.swapId}</span><span class="pair">unreadable</span><span class="state-cell"><span class="badge badge-expired">error</span></span><span class="num">—</span><span class="num">—</span><span class="num">—</span></div>`;
  }
  const expiredCreated = s.state === 0 && Date.now() / 1000 > s.expirationTimestamp;
  const stateName = expiredCreated ? 'Expired' : s.stateName;
  const stateCls = expiredCreated ? 'badge-expired' : (STATE_CLASSES[s.state] || 'badge-created');
  const pips = `<span class="legpips" title="source · dest legs"><i class="${s.sourceLegSettled ? 'on' : ''}"></i><i class="${s.destLegSettled ? 'on' : ''}"></i></span>`;
  const open = expanded.has(s.swapId);
  const row = `<div class="ledger-row${open ? ' selected' : ''}" data-id="${s.swapId}">
    <span class="id">#${s.swapId}</span>
    <span class="pair">${esc(chainLabel(s.sourceChain))} → ${esc(chainLabel(s.destChain))}${pips}</span>
    <span class="state-cell"><span class="badge ${stateCls}">${stateName}</span></span>
    <span class="num">${s.sourceAmount.toString()}</span>
    <span class="num">${s.destAmount.toString()}</span>
    <span class="num">${feePct(s.feeBps)}</span>
  </div>`;
  return row + (open ? detailHtml(s) : '');
}

function field(label, val, cls) {
  return `<div class="field"><div class="label">${label}</div><div class="val ${cls || ''}">${val === '' || val == null ? '—' : esc(val)}</div></div>`;
}
const tokenVal = (a) => (a === ZERO_ADDR ? 'native' : a);
const legVal = (settled, tx) => (settled ? `settled${tx ? ' · ' + tx : ''}` : 'pending');

function detailHtml(s) {
  const expiredCreated = s.state === 0 && Date.now() / 1000 > s.expirationTimestamp;
  return `<div class="swap-detail"><div class="grid">
    <div class="detail-section">Settlement</div>
    ${field('State', expiredCreated ? s.stateName + ' (expired)' : s.stateName)}
    ${field('Pair', chainLabel(s.sourceChain) + ' → ' + chainLabel(s.destChain))}
    ${field('Source sends', s.sourceAmount.toString(), 'mono')}
    ${field('Dest receives', s.destAmount.toString(), 'mono')}
    ${field('Floor (min dest)', s.minDestAmount.toString(), 'mono')}
    ${field('Fee', feePct(s.feeBps) + ' (' + s.feeBps + ' bps)')}
    ${field('Confirmations', String(s.confirmationBlocks))}
    ${field('Created', iso(s.createdAt), 'muted')}
    ${field('Expires', iso(s.expirationTimestamp), 'muted')}

    <div class="detail-section">Roles — four-address model</div>
    ${field('User refund (source)', s.userRefundSource, 'mono')}
    ${field('User receive (dest)', s.userReceiveDest, 'mono')}
    ${field('Solver receive (source)', s.solverReceiveSource, 'mono')}
    ${field('Solver refund (dest)', s.solverRefundDest, 'mono')}

    <div class="detail-section">Deposit addresses</div>
    ${field('Deposit (source)', s.depositAddressSource, 'mono')}
    ${field('Deposit (dest)', s.depositAddressDest, 'mono')}

    <div class="detail-section">Legs &amp; fee</div>
    ${field('Source leg', legVal(s.sourceLegSettled, s.sourceLegTxHash), 'mono')}
    ${field('Dest leg', legVal(s.destLegSettled, s.destLegTxHash), 'mono')}
    ${field('Fee', legVal(s.feeSettled, s.feeTxHash), 'mono')}

    <div class="detail-section">Lit Action &amp; linkage</div>
    ${field('Lit Action CID', s.litActionCid, 'mono')}
    ${field('Salt', s.salt, 'mono')}
    ${field('Lit Action address', s.litActionEvmAddress, 'mono')}
    ${field('Intent ID', s.intentId, 'mono')}
    ${field('Creator', s.creator, 'mono')}

    <div class="detail-section">Tokens</div>
    ${field('Source token', tokenVal(s.tokenAddressSource), 'mono')}
    ${field('Dest token', tokenVal(s.tokenAddressDest), 'mono')}
  </div></div>`;
}

function toggle(id) {
  if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  renderRows(document.getElementById('explore-rows'));
}

// ---- jump-to-id (loads a swap outside the recent window) ------------------
async function jump() {
  const raw = document.getElementById('jump-id').value.trim();
  if (raw === '') return;
  const id = Number(raw);
  if (CONTRACT_ADDRESS === ZERO_ADDR) return;
  if (swaps.some((s) => s.swapId === String(id))) { // already loaded — just open it
    expanded.add(String(id));
    renderRows(document.getElementById('explore-rows'));
    document.querySelector(`.ledger-row[data-id="${id}"]`)?.scrollIntoView({ block: 'center' });
    return;
  }
  banner(`Loading swap #${id}…`, 'loading');
  try {
    const s = await readSwap(id);
    swaps = [s, ...swaps.filter((x) => x.swapId !== String(id))]
      .sort((a, b) => Number(b.swapId) - Number(a.swapId));
    expanded.add(String(id));
    document.getElementById('explore-ledger').style.display = 'block';
    document.getElementById('explore-empty').style.display = 'none';
    renderRows(document.getElementById('explore-rows'));
    banner('');
    document.querySelector(`.ledger-row[data-id="${id}"]`)?.scrollIntoView({ block: 'center' });
  } catch (err) {
    banner(`Swap #${id} could not be loaded (does it exist?): ` + esc(err.message), 'error');
  }
}

// ---- wiring ----------------------------------------------------------------
initThemeLabel();
document.getElementById('theme-btn').addEventListener('click', toggleTheme);
document.getElementById('refresh-btn').addEventListener('click', load);
document.getElementById('jump-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') jump(); });
load();
