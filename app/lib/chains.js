/**
 * Settled — browser-side chain registry (labels, logos, dropdown UI).
 *
 * This is the ONE place the apps turn a chain id into something a human reads:
 * a display label and a logo. It is deliberately separate from
 * app/actions/lib/networks.js — that module is the signing/RPC source of truth
 * and its contents get embedded in the Lit Action (and therefore the CID), so
 * UI-only fluff (labels, icon URLs) must never leak into it. Here we IMPORT
 * networks.js purely to read each EVM chain's numeric chainId (for wallet
 * `wallet_switchEthereumChain`) so the hex map never has to be hand-maintained.
 *
 * Logos load from DefiLlama's chain-icon CDN. Any miss (404, offline, unknown
 * slug) falls back to an on-brand monogram chip via bindIconFallbacks() — the UI
 * never shows a broken image. Real brand marks are intentional here: the user
 * asked for them, and recognising "the type of crypto" at a glance is the point.
 * They are contained in small circular chips (DESIGN.md's pill radius for chain
 * selectors) so the multicolor marks read as controlled tokens, not decoration.
 */
import { CHAINS } from '../actions/lib/networks.js';

// id -> [label, defillama-icon-slug]. The slug is best-effort; unknown slugs
// degrade to a monogram chip, so a wrong guess is cosmetic, never broken.
const META = {
  // EVM mainnet (curated top chains by activity/volume)
  'ethereum':      ['Ethereum', 'ethereum'],
  'bnb-chain':     ['BNB Chain', 'bsc'],
  'base':          ['Base', 'base'],
  'polygon':       ['Polygon', 'polygon'],
  'optimism':      ['OP Mainnet', 'optimism'],
  'avalanche':     ['Avalanche', 'avalanche'],
  'linea':         ['Linea', 'linea'],
  'scroll':        ['Scroll', 'scroll'],
  'mantle':        ['Mantle', 'mantle'],
  'blast':         ['Blast', 'blast'],
  'gnosis':        ['Gnosis', 'xdai'],
  'celo':          ['Celo', 'celo'],
  'cronos':        ['Cronos', 'cronos'],
  'sonic':         ['Sonic', 'sonic'],
  'fantom':        ['Fantom', 'fantom'],
  'moonbeam':      ['Moonbeam', 'moonbeam'],
  'opbnb':         ['opBNB', 'op_bnb'],
  'mode':          ['Mode', 'mode'],
  'manta-pacific': ['Manta Pacific', 'manta'],
  'berachain':     ['Berachain', 'berachain'],
  'unichain':      ['Unichain', 'unichain'],
  'world-chain':   ['World Chain', 'wc'],
  'taiko':         ['Taiko', 'taiko'],
  'sei':           ['Sei', 'sei'],

  // EVM testnet (reuse the mainnet brand logo)
  'base-sepolia':      ['Base Sepolia', 'base'],
  'ethereum-sepolia':  ['Ethereum Sepolia', 'ethereum'],
  'arbitrum-sepolia':  ['Arbitrum Sepolia', 'arbitrum'],
  'optimism-sepolia':  ['Optimism Sepolia', 'optimism'],

  // non-EVM testnet
  'bitcoin-signet':    ['Bitcoin Signet', 'bitcoin'],
  'litecoin-testnet':  ['Litecoin Testnet', 'litecoin'],
  'dogecoin-testnet':  ['Dogecoin Testnet', 'dogecoin'],
  'zcash-testnet':     ['Zcash Testnet', 'zcash'],
  'solana-devnet':     ['Solana Devnet', 'solana'],

  // mainnet aliases the explorer may store on-chain as bare names
  'bitcoin':  ['Bitcoin', 'bitcoin'],
  'litecoin': ['Litecoin', 'litecoin'],
  'dogecoin': ['Dogecoin', 'dogecoin'],
  'zcash':    ['Zcash', 'zcash'],
  'solana':   ['Solana', 'solana'],
};

// Grouped order for the selector. Mainnets lead (the headline of this change);
// the testnets the live demos use stay grouped below.
export const CHAIN_GROUPS = [
  ['EVM · Mainnet', [
    'ethereum', 'bnb-chain', 'base', 'polygon', 'optimism', 'avalanche',
    'linea', 'scroll', 'mantle', 'blast', 'gnosis', 'celo', 'cronos',
    'sonic', 'fantom', 'moonbeam', 'opbnb', 'mode',
    'manta-pacific', 'berachain', 'unichain', 'world-chain', 'taiko', 'sei',
  ]],
  ['EVM · Testnet', [
    'base-sepolia', 'ethereum-sepolia', 'arbitrum-sepolia', 'optimism-sepolia',
  ]],
  ['Bitcoin & others · Testnet', [
    'bitcoin-signet', 'litecoin-testnet', 'dogecoin-testnet', 'zcash-testnet', 'solana-devnet',
  ]],
];

const ICON_BASE = 'https://icons.llamao.fi/icons/chains/rsz_';

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Human label for a chain id (falls back to the id itself). */
export function chainLabel(id) {
  return (META[id] && META[id][0]) || id || '—';
}

/** DefiLlama icon URL for a chain id, or null if we have no slug. */
export function iconUrl(id) {
  const slug = META[id] && META[id][1];
  return slug ? ICON_BASE + slug + '.jpg' : null;
}

/** 2-letter monogram used by the fallback chip. */
function monogram(id) {
  const label = chainLabel(id).replace(/[^A-Za-z0-9 ]/g, '');
  const parts = label.split(/\s+/).filter(Boolean);
  const txt = parts.length > 1 ? parts[0][0] + parts[1][0] : label.slice(0, 2);
  return txt.toUpperCase();
}

/**
 * Markup for a chain logo chip. Renders the brand image with a monogram baked in
 * as the data-mono fallback; call bindIconFallbacks() on a container afterwards
 * to swap to the monogram when an image fails to load.
 */
export function chainIconHtml(id) {
  const url = iconUrl(id);
  const mono = escapeHtml(monogram(id));
  const img = url ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async">` : '';
  return `<span class="chain-ic${url ? '' : ' ic-failed'}" data-mono="${mono}" aria-hidden="true">${img}</span>`;
}

/** Wire onerror fallbacks for every logo chip inside `root` (idempotent). */
export function bindIconFallbacks(root) {
  if (!root) return;
  root.querySelectorAll('.chain-ic img').forEach((img) => {
    if (img.dataset.bound) return;
    img.dataset.bound = '1';
    img.addEventListener('error', () => img.closest('.chain-ic').classList.add('ic-failed'));
  });
}

/** Hex chainId for wallet_switchEthereumChain, or null for non-EVM chains. */
export function evmChainHex(id) {
  const c = CHAINS[id];
  if (!c || c.family !== 'evm' || typeof c.chainId !== 'number') return null;
  return '0x' + c.chainId.toString(16);
}

/** <optgroup>/<option> markup for a native <select> (the value source of truth). */
export function chainOptionsHtml() {
  return CHAIN_GROUPS.map(([group, ids]) => {
    const opts = ids
      .filter((id) => META[id])
      .map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(chainLabel(id))}</option>`)
      .join('');
    return `<optgroup label="${escapeHtml(group)}">${opts}</optgroup>`;
  }).join('');
}

/**
 * Progressive-enhancement custom select: keeps the native <select> as the hidden
 * value source of truth (so every `el.value` read and `change` listener keeps
 * working) and overlays a styled, keyboard-navigable listbox that can show logos
 * — which native <option> elements cannot. Safe to call once per select.
 */
export function enhanceChainSelect(select) {
  if (!select || select.dataset.enhanced) return;
  select.dataset.enhanced = '1';

  const wrap = document.createElement('div');
  wrap.className = 'chain-select';
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);
  select.classList.add('cs-native'); // visually hidden, still focusable/labelled

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'cs-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const panel = document.createElement('div');
  panel.className = 'cs-panel';
  panel.setAttribute('role', 'listbox');
  panel.hidden = true;

  wrap.appendChild(trigger);
  wrap.appendChild(panel);

  let active = -1; // highlighted option index within `opts`
  let opts = [];   // .cs-opt elements, in display order

  function renderTrigger() {
    const id = select.value;
    trigger.innerHTML = chainIconHtml(id)
      + `<span class="cs-label">${escapeHtml(chainLabel(id))}</span>`
      + '<span class="cs-caret" aria-hidden="true">▾</span>';
    bindIconFallbacks(trigger);
  }

  function buildPanel() {
    panel.innerHTML = '';
    opts = [];
    Array.from(select.children).forEach((node) => {
      if (node.tagName === 'OPTGROUP') {
        const h = document.createElement('div');
        h.className = 'cs-group';
        h.textContent = node.label;
        panel.appendChild(h);
        Array.from(node.children).forEach((o) => panel.appendChild(optEl(o)));
      } else if (node.tagName === 'OPTION') {
        panel.appendChild(optEl(node));
      }
    });
    bindIconFallbacks(panel);
  }

  function optEl(o) {
    const el = document.createElement('div');
    el.className = 'cs-opt';
    el.setAttribute('role', 'option');
    el.dataset.value = o.value;
    el.tabIndex = -1;
    el.innerHTML = chainIconHtml(o.value)
      + `<span class="cs-label">${escapeHtml(o.textContent)}</span>`;
    if (o.value === select.value) el.setAttribute('aria-selected', 'true');
    el.addEventListener('click', () => { setValue(o.value); close(); trigger.focus(); });
    opts.push(el);
    return el;
  }

  function setValue(v) {
    if (select.value !== v) {
      select.value = v;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    renderTrigger();
    opts.forEach((e) => e.toggleAttribute('aria-selected', e.dataset.value === v));
  }

  function setActive(i) {
    if (!opts.length) return;
    active = Math.max(0, Math.min(i, opts.length - 1));
    opts.forEach((e, idx) => e.classList.toggle('active', idx === active));
    opts[active].scrollIntoView({ block: 'nearest' });
  }

  function open() {
    if (!panel.hidden) return;
    buildPanel();
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    wrap.classList.add('open');
    const sel = opts.findIndex((e) => e.dataset.value === select.value);
    setActive(sel < 0 ? 0 : sel);
  }

  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    wrap.classList.remove('open');
  }

  trigger.addEventListener('click', () => (panel.hidden ? open() : close()));
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(opts.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (opts[active]) { setValue(opts[active].dataset.value); close(); trigger.focus(); } }
    else if (e.key === 'Escape') { e.preventDefault(); close(); trigger.focus(); }
  });
  // Keep panel keyboard-reachable: focus it when opened.
  trigger.addEventListener('click', () => { if (!panel.hidden) panel.focus(); });
  panel.tabIndex = -1;
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });
  // The native select can still change (e.g. programmatic default): mirror it.
  select.addEventListener('change', renderTrigger);

  renderTrigger();
}
