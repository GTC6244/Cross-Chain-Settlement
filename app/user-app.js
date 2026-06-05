/**
 * Settled — USER app controller (the "send" side).
 *
 * Flow: announce an intent (no escrow) -> solvers compete by building swaps ->
 * compare quotes (best-rate first, CID auto-verified) -> fund the best one ->
 * watch the two legs settle. Wires the shared core in app/lib/*.
 */
import {
  CHAIN_RPC, BASE_RPC, STATE_NAMES, writeContract, readSwap,
} from './lib/contract.js';
import { CHAIN_FAMILY } from './lib/derive.js';
import { readQuotesForIntent, effectiveRate } from './lib/intents.js';
import { verifySwapCid } from './lib/verify.js';
import { log, clearLog, showTab, toggleTheme, initThemeLabel } from './lib/ui.js';

const CHAINS = [
  ['base-sepolia', 'Base Sepolia'], ['ethereum-sepolia', 'Ethereum Sepolia'],
  ['arbitrum-sepolia', 'Arbitrum Sepolia'], ['optimism-sepolia', 'Optimism Sepolia'],
  ['bitcoin-signet', 'Bitcoin Signet'], ['litecoin-testnet', 'Litecoin Testnet'],
  ['dogecoin-testnet', 'Dogecoin Testnet'], ['zcash-testnet', 'Zcash Testnet'],
  ['solana-devnet', 'Solana Devnet'],
];
const CHAIN_HEX = {
  'base-sepolia': '0x14a34', 'ethereum-sepolia': '0xaa36a7',
  'arbitrum-sepolia': '0x66eee', 'optimism-sepolia': '0xaa37dc',
};

let signer = null;
let userAddress = null;

// ---- setup ----------------------------------------------------------------
function fillChains() {
  for (const id of ['source-chain', 'dest-chain']) {
    const sel = document.getElementById(id);
    sel.innerHTML = CHAINS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  }
  document.getElementById('dest-chain').value = 'ethereum-sepolia';
}

async function connectWallet() {
  const btn = document.getElementById('wallet-btn');
  if (!window.ethereum) { alert('No wallet detected. Install MetaMask or another web3 wallet.'); return; }
  try {
    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send('eth_requestAccounts', []);
    signer = await provider.getSigner();
    userAddress = await signer.getAddress();
    btn.textContent = userAddress.slice(0, 6) + '…' + userAddress.slice(-4);
    btn.classList.add('connected');
    const ann = document.getElementById('announce-btn');
    ann.disabled = false; ann.textContent = 'Announce intent';
    // Helpful defaults for EVM-on-both-sides swaps
    if (!document.getElementById('user-refund-source').value) document.getElementById('user-refund-source').value = userAddress;
    if (!document.getElementById('user-receive-dest').value) document.getElementById('user-receive-dest').value = userAddress;
  } catch (err) { alert('Wallet connection failed: ' + err.message); }
}

async function switchChain(hex) {
  try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }); }
  catch (e) { /* surfaced by the failing tx if the user declines */ }
}

// ---- 1. announce ----------------------------------------------------------
async function announceIntent() {
  const out = 'announce-output';
  clearLog(out);
  if (!signer) { log(out, 'Connect wallet first.', 'error'); return; }

  const sourceChain = document.getElementById('source-chain').value;
  const destChain = document.getElementById('dest-chain').value;
  const sourceAmount = document.getElementById('source-amount').value.trim();
  const minDestAmount = document.getElementById('min-dest-amount').value.trim();
  const userRefundSource = document.getElementById('user-refund-source').value.trim();
  const userReceiveDest = document.getElementById('user-receive-dest').value.trim();
  const feeBps = parseInt(document.getElementById('fee-bps').value);
  const hours = parseFloat(document.getElementById('expiration-hours').value);
  const tokenSource = document.getElementById('token-source').value.trim() || ethers.ZeroAddress;
  const tokenDest = document.getElementById('token-dest').value.trim() || ethers.ZeroAddress;

  if (!sourceAmount || !minDestAmount) { log(out, 'Enter the amount you send and your minimum receive.', 'error'); return; }
  if (!userRefundSource || !userReceiveDest) { log(out, 'Enter your refund (source) and receive (dest) addresses.', 'error'); return; }

  try {
    const intentId = ethers.hexlify(ethers.randomBytes(32));
    const expiration = Math.floor(Date.now() / 1000 + hours * 3600);
    log(out, 'Switch to Base Sepolia to announce…', 'dim');
    await switchChain(CHAIN_HEX['base-sepolia']);
    const c = writeContract(signer);
    log(out, 'Announcing intent…', 'dim');
    const tx = await c.announceIntent(
      intentId, sourceChain, destChain, sourceAmount, minDestAmount,
      expiration, feeBps, tokenSource, tokenDest, userRefundSource, userReceiveDest,
    );
    log(out, 'Tx submitted: ' + tx.hash, 'dim');
    await tx.wait();
    log(out, '');
    log(out, '=== Intent announced ===', 'success');
    log(out, 'Intent ID: ' + intentId);
    log(out, sourceChain + ' → ' + destChain);
    log(out, 'You send: ' + sourceAmount + ' · floor: ' + minDestAmount);
    log(out, 'Solvers can now compete to fill it.');
    document.getElementById('quotes-intent-id').value = intentId;
    showTab('quotes');
    loadQuotes();
  } catch (err) { log(out, 'Error: ' + err.message, 'error'); console.error(err); }
}

// ---- 2. compare quotes ----------------------------------------------------
async function loadQuotes() {
  const intentId = document.getElementById('quotes-intent-id').value.trim();
  const banner = document.getElementById('quotes-banner');
  const listEl = document.getElementById('quotes-list');
  if (!intentId) { banner.innerHTML = '<div class="state-banner error">Enter an intent ID.</div>'; return; }
  banner.innerHTML = '<div class="state-banner loading"><span class="spinner"></span>Scanning for competing quotes…</div>';
  listEl.innerHTML = '';
  try {
    const { quotes, complete, error } = await readQuotesForIntent(intentId);
    if (error || !complete) {
      banner.innerHTML = '<div class="state-banner stale">Some quotes may be missing (order-book scan was truncated). Showing what was read — refresh to retry.</div>';
    } else {
      banner.innerHTML = '';
    }
    if (quotes.length === 0) {
      listEl.innerHTML = '<div class="empty-state"><p>No quotes yet. Solvers usually respond within a few minutes. This view refreshes when you reload.</p></div>';
      return;
    }
    // Render best-first; quotes[0] is the best rate.
    listEl.innerHTML = '';
    for (let i = 0; i < quotes.length; i++) {
      listEl.appendChild(await quoteRow(quotes[i], i === 0));
    }
  } catch (err) {
    banner.innerHTML = '<div class="state-banner error">Couldn\'t read quotes: ' + err.message + '</div>';
  }
}

async function quoteRow(q, isBest) {
  const row = document.createElement('div');
  row.className = 'quote-row' + (isBest ? ' best' : '');
  const rate = effectiveRate(q).toPrecision(4);
  // Auto-verify the CID against the audited template before offering to fund.
  let verify = '<span class="verify-bad">verifying…</span>';
  row.innerHTML = `
    <div>${isBest ? '<span class="best-tag">Best</span>' : ''}</div>
    <div>
      <div class="recv">${q.destAmount.toString()}</div>
      <div class="rate">rate ${rate} · solver ${q.solver.slice(0, 6)}…${q.solver.slice(-4)} · ${verify}</div>
    </div>
    <button class="btn btn-primary fund-btn" data-swap="${q.swapId}">Fund this quote</button>`;
  row.querySelector('.fund-btn').addEventListener('click', () => fundQuote(q.swapId));
  // verify async, then patch the badge
  verifySwapCid(q).then((v) => {
    const span = row.querySelector('.rate');
    const badge = v.match ? '<span class="verify-ok">✓ CID verified</span>' : '<span class="verify-bad">✗ CID mismatch — do not fund</span>';
    span.innerHTML = `rate ${rate} · solver ${q.solver.slice(0, 6)}…${q.solver.slice(-4)} · ${badge}`;
    if (!v.match) row.querySelector('.fund-btn').disabled = true;
  }).catch(() => {});
  return row;
}

// ---- fund the chosen quote (source leg) -----------------------------------
async function fundQuote(swapId) {
  const out = 'quotes-output';
  clearLog(out);
  if (!signer) { log(out, 'Connect wallet first.', 'error'); return; }
  try {
    const s = await readSwap(swapId);
    log(out, 'Funding swap #' + swapId + ' source leg', 'dim');
    log(out, 'Send ' + s.sourceAmount.toString() + ' on ' + s.sourceChain);
    log(out, 'Deposit address: ' + s.depositAddressSource);
    if (CHAIN_FAMILY[s.sourceChain] === 'evm' && s.tokenAddressSource === ethers.ZeroAddress) {
      await switchChain(CHAIN_HEX[s.sourceChain]);
      const tx = await signer.sendTransaction({ to: s.depositAddressSource, value: s.sourceAmount });
      log(out, 'Tx submitted: ' + tx.hash, 'dim');
      await tx.wait();
      log(out, '');
      log(out, '=== Source leg funded ===', 'success');
      log(out, 'The solver will now fund the dest leg and settle. Track it in Status (swap #' + swapId + ').');
      document.getElementById('status-swap-id').value = swapId;
    } else {
      // Non-EVM (or ERC-20) source: manual send (3A).
      log(out, '');
      log(out, '=== Send manually from your wallet ===', 'warn');
      log(out, 'Send exactly ' + s.sourceAmount.toString() + ' (smallest unit)');
      log(out, 'on ' + s.sourceChain);
      log(out, 'to: ' + s.depositAddressSource);
      log(out, '');
      log(out, 'Once it confirms, the solver settles. Track it in Status (swap #' + swapId + ').');
      document.getElementById('status-swap-id').value = swapId;
    }
  } catch (err) { log(out, 'Error: ' + err.message, 'error'); console.error(err); }
}

// ---- 3. status / settlement progress --------------------------------------
async function checkStatus() {
  const out = 'status-output';
  const legsEl = document.getElementById('status-legs');
  clearLog(out);
  legsEl.innerHTML = '';
  const swapId = document.getElementById('status-swap-id').value;
  if (swapId === '') { log(out, 'Enter a swap ID.', 'error'); return; }
  try {
    const s = await readSwap(swapId);
    const expired = Date.now() / 1000 > s.expirationTimestamp;
    renderLegs(legsEl, s);
    log(out, '=== Swap #' + swapId + ' ===');
    log(out, 'State: ' + s.stateName + (expired && s.state === 0 ? ' (EXPIRED)' : ''),
      s.state === 2 ? 'success' : s.state >= 3 ? 'warn' : '');
    log(out, s.sourceChain + ' → ' + s.destChain);
    log(out, 'You receive (dest): ' + s.destAmount.toString());
    log(out, 'Receive address: ' + s.userReceiveDest, 'dim');
    log(out, 'Expires: ' + new Date(s.expirationTimestamp * 1000).toISOString(), 'dim');
  } catch (err) { log(out, 'Error: ' + err.message, 'error'); console.error(err); }
}

function renderLegs(el, s) {
  const sourceState = s.sourceLegSettled ? 'done' : (s.state === 2 ? 'done' : 'active');
  const destState = s.destLegSettled ? 'done' : (s.sourceLegSettled ? 'active' : '');
  el.innerHTML = `
    <div class="leg ${sourceState}"><span class="dot"></span><span class="leg-label">Source leg (${s.sourceChain})</span><span class="leg-tx">${s.sourceLegTxHash || ''}</span></div>
    <div class="leg ${destState}"><span class="dot"></span><span class="leg-label">Dest leg (${s.destChain}) — you receive</span><span class="leg-tx">${s.destLegTxHash || ''}</span></div>
    <div class="leg ${s.state === 2 ? 'done' : ''}"><span class="dot"></span><span class="leg-label">Receipt ${s.state === 2 ? 'signed' : 'pending'}</span></div>`;
}

// ---- wiring ----------------------------------------------------------------
fillChains();
initThemeLabel();
document.getElementById('theme-btn').addEventListener('click', toggleTheme);
document.getElementById('wallet-btn').addEventListener('click', connectWallet);
document.getElementById('announce-btn').addEventListener('click', announceIntent);
document.getElementById('load-quotes-btn').addEventListener('click', loadQuotes);
document.getElementById('status-btn').addEventListener('click', checkStatus);
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
