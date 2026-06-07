/**
 * Settled — read-only swap explorer.
 *
 * Wallet-free. Reads swapCount from the Base-mainnet SwapContract, then loads
 * every swap (getSwapState/getSwapAddresses/getSwapIntent/getSwapLegs/getSwapTokens
 * via readSwap) and renders them. No signer, no writes — purely a viewer.
 */
import { readContract, readSwap, CONTRACT_ADDRESS, STATE_NAMES, STATE_CLASSES } from './lib/contract.js';

const elSwaps = document.getElementById('swaps');
const elMeta = document.getElementById('refresh-meta');
const elRefresh = document.getElementById('refresh-btn');
const elNewest = document.getElementById('newest-first');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (s, n = 6) => !s ? '—' : (s.length > n * 2 + 3 ? s.slice(0, n) + '…' + s.slice(-n) : s);

// Build a block-explorer link for a chain-specific tx hash.
function txLink(chain, hash) {
  if (!hash) return '—';
  const c = String(chain || '');
  let url = null;
  if (c.startsWith('base')) url = 'https://basescan.org/tx/' + hash;
  else if (c.includes('sepolia')) url = 'https://sepolia.etherscan.io/tx/' + hash;
  else if (c.includes('solana')) url = 'https://explorer.solana.com/tx/' + hash + '?cluster=devnet';
  else if (c.includes('bitcoin')) url = 'https://mempool.space/signet/tx/' + hash;
  else if (c.includes('litecoin')) url = 'https://litecoinspace.org/testnet/tx/' + hash;
  return url ? `<a href="${url}" target="_blank" rel="noopener">${esc(short(hash, 8))}</a>` : esc(short(hash, 8));
}

function fmtAmount(v) { try { return BigInt(v).toString(); } catch { return String(v); } }

const COLUMNS = ['#', 'State', 'Route', 'Source amt', 'Dest amt', 'Floor', 'Source leg', 'Dest leg', 'Fee', 'CID', 'Expires'];

function leg(settled, chain, hash) {
  const cls = settled ? 'leg-ok' : 'leg-no';
  const label = settled ? '✓' : '–';
  return `<span class="${cls}">${label}</span> ${txLink(chain, hash)}`;
}

// One <tr> per swap.
function row(s) {
  const badge = STATE_CLASSES[s.state] || 'badge-created';
  const expires = s.expirationTimestamp ? new Date(s.expirationTimestamp * 1000).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '—';
  return `<tr>
    <td class="num">${esc(s.swapId)}</td>
    <td><span class="badge ${badge}">${esc(s.stateName || ('state ' + s.state))}</span></td>
    <td class="mono">${esc(s.sourceChain)} → ${esc(s.destChain)}</td>
    <td class="num">${esc(fmtAmount(s.sourceAmount))}</td>
    <td class="num">${esc(fmtAmount(s.destAmount))}</td>
    <td class="num">${esc(fmtAmount(s.minDestAmount))}</td>
    <td class="mono">${leg(s.sourceLegSettled, s.sourceChain, s.sourceLegTxHash)}</td>
    <td class="mono">${leg(s.destLegSettled, s.destChain, s.destLegTxHash)}</td>
    <td class="num">${s.feeBps ? (s.feeBps / 100) + '%' : '—'}</td>
    <td class="mono" title="${esc(s.litActionCid)}">${esc(short(s.litActionCid, 6))}</td>
    <td class="mono">${esc(expires)}</td>
  </tr>`;
}

function table(rows) {
  return `<table class="swaps-table">
    <thead><tr>${COLUMNS.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function load() {
  elSwaps.innerHTML = '<div class="empty-state swaps-msg"><p>Loading swaps from the contract…</p></div>';
  elMeta.textContent = '';
  let count;
  try {
    count = Number(await readContract().swapCount());
  } catch (e) {
    elSwaps.innerHTML = `<div class="status-box swaps-msg" style="display:block">Failed to read contract: ${esc(e.message || e)}</div>`;
    return;
  }
  if (count === 0) { elSwaps.innerHTML = '<div class="empty-state swaps-msg"><p>No swaps recorded yet.</p></div>'; return; }

  // Load all swaps with light concurrency (publicnode RPC).
  const ids = Array.from({ length: count }, (_, i) => i);
  const results = new Array(count);
  const CONC = 4;
  let next = 0;
  async function worker() {
    while (next < count) {
      const i = ids[next++];
      try { results[i] = await readSwap(i); }
      catch (e) { results[i] = { swapId: String(i), state: -1, stateName: 'read error: ' + (e.message || e), sourceChain: '?', destChain: '?' }; }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  let list = results.filter(Boolean);
  if (elNewest.checked) list = list.slice().reverse();
  elSwaps.innerHTML = table(list.map(row).join(''));
  const executed = results.filter((s) => s && s.state === 2).length;
  elMeta.textContent = `${count} swaps · ${executed} executed · contract ${short(CONTRACT_ADDRESS, 6)} (Base mainnet)`;
}

elRefresh.addEventListener('click', load);
elNewest.addEventListener('change', load);
load();
