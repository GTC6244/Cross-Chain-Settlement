/**
 * Settled — SOLVER app controller (the "solve" side).
 *
 * Flow: browse open intents -> quote a destAmount (>= floor) and build the swap
 * on-chain (mints a fresh TEE key per quote) -> once the user funds the source
 * leg, inject the dest asset and execute the Lit Action. Wires app/lib/*.
 */
import {
  BASE_RPC, CHAIN_RPC, LIT_API_BASE, CONTRACT_ADDRESS,
  writeContract, readSwap, readContract,
} from './lib/contract.js';
import {
  CHAIN_FAMILY, randomSalt, templateKeyForChains, getActionCode, pickDeposit, computeCid, deriveAddresses,
} from './lib/derive.js';
import { readOpenIntents } from './lib/intents.js';
import { log, clearLog, showTab, toggleTheme, initThemeLabel } from './lib/ui.js';

const CHAIN_HEX = {
  'base-sepolia': '0x14a34', 'ethereum-sepolia': '0xaa36a7',
  'arbitrum-sepolia': '0x66eee', 'optimism-sepolia': '0xaa37dc',
};

let signer = null;
let solverAddress = null;
let selectedIntent = null;

async function connectWallet() {
  const btn = document.getElementById('wallet-btn');
  if (!window.ethereum) { alert('No wallet detected. Install MetaMask or another web3 wallet.'); return; }
  try {
    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send('eth_requestAccounts', []);
    signer = await provider.getSigner();
    solverAddress = await signer.getAddress();
    btn.textContent = solverAddress.slice(0, 6) + '…' + solverAddress.slice(-4);
    btn.classList.add('connected');
    if (!document.getElementById('solver-receive-source').value) document.getElementById('solver-receive-source').value = solverAddress;
  } catch (err) { alert('Wallet connection failed: ' + err.message); }
}

async function switchChain(hex) {
  if (!hex) return;
  try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }); }
  catch (e) { /* surfaced by the failing tx */ }
}

// ---- order book -----------------------------------------------------------
function fmtExpiry(ts) {
  const s = ts - Math.floor(Date.now() / 1000);
  if (s <= 0) return ['expired', 'expired'];
  const m = Math.floor(s / 60);
  if (m < 60) return [m + 'm', m < 10 ? 'soon' : ''];
  return [Math.floor(m / 60) + 'h ' + (m % 60) + 'm', ''];
}

async function loadOrderBook() {
  const banner = document.getElementById('book-banner');
  const rows = document.getElementById('book-rows');
  banner.innerHTML = '<div class="state-banner loading"><span class="spinner"></span>Scanning the chain for open intents…</div>';
  rows.innerHTML = '';
  try {
    const { intents, complete, error } = await readOpenIntents();
    banner.innerHTML = (error || !complete)
      ? '<div class="state-banner stale">Some intents may be missing — the order-book scan was truncated by the RPC. Showing what was read; refresh to retry.</div>'
      : '';
    if (intents.length === 0) {
      rows.innerHTML = '<div class="empty-state"><p>No open intents right now. New intents appear here as users post them — hit refresh.</p></div>';
      return;
    }
    rows.innerHTML = '';
    for (const i of intents) rows.appendChild(bookRow(i));
  } catch (err) {
    banner.innerHTML = '<div class="state-banner error">Couldn\'t reach Base RPC: ' + err.message + '. Retry.</div>';
  }
}

function bookRow(i) {
  const row = document.createElement('div');
  row.className = 'ledger-row';
  const [exp, expCls] = fmtExpiry(i.expiration);
  row.innerHTML = `
    <div class="pair">${i.sourceChain} → ${i.destChain}</div>
    <div class="num recv">${i.sourceAmount.toString()}</div>
    <div class="num floor">${i.minDestAmount.toString()}</div>
    <div class="countdown ${expCls}">${exp}</div>
    <div class="act"><button class="btn btn-ghost" style="width:auto;margin:0;padding:8px 14px;min-height:40px">Quote</button></div>`;
  row.addEventListener('click', () => selectIntent(i));
  return row;
}

function selectIntent(i) {
  selectedIntent = i;
  const box = document.getElementById('quote-intent');
  box.style.display = 'block';
  box.innerHTML = `
    <p><strong>${i.sourceChain} → ${i.destChain}</strong></p>
    <p>User sends (you receive): <span class="addr">${i.sourceAmount.toString()}</span></p>
    <p>Floor (you must deliver ≥): <span class="addr">${i.minDestAmount.toString()}</span> on ${i.destChain}</p>
    <p>Fee: ${i.feeBps} bps · expires ${new Date(i.expiration * 1000).toISOString()}</p>`;
  const btn = document.getElementById('create-swap-btn');
  btn.disabled = false; btn.textContent = 'Create swap (your quote)';
  document.getElementById('quote-dest-amount').value = i.minDestAmount.toString();
  showTab('quote');
}

// ---- quote + create -------------------------------------------------------
async function createSwapForIntent() {
  const out = 'quote-output';
  clearLog(out);
  if (!signer) { log(out, 'Connect wallet first.', 'error'); return; }
  if (!selectedIntent) { log(out, 'Select an intent from the order book.', 'error'); return; }
  const i = selectedIntent;
  const destAmount = document.getElementById('quote-dest-amount').value.trim();
  const solverReceiveSource = document.getElementById('solver-receive-source').value.trim();
  const solverRefundDest = document.getElementById('solver-refund-dest').value.trim();
  const litKey = document.getElementById('quote-lit-key').value;
  if (!destAmount) { log(out, 'Enter the dest amount you will deliver.', 'error'); return; }
  if (BigInt(destAmount) < BigInt(i.minDestAmount)) { log(out, 'Quote is below the floor (' + i.minDestAmount.toString() + ').', 'error'); return; }
  if (!solverReceiveSource || !solverRefundDest) { log(out, 'Enter your receive (source) and refund (dest) addresses.', 'error'); return; }
  if (!litKey) { log(out, 'Lit API key required to derive deposit addresses.', 'error'); return; }

  try {
    const tkey = templateKeyForChains(i.sourceChain, i.destChain);
    if (!tkey) { log(out, 'Unsupported chain pair.', 'error'); return; }
    const salt = randomSalt();
    log(out, 'Building action + computing CID…', 'dim');
    const code = getActionCode(tkey, salt, i.sourceChain, i.destChain);
    const cid = await computeCid(code);
    log(out, 'CID: ' + cid, 'dim');
    log(out, 'Deriving deposit addresses via Lit…', 'dim');
    const derived = await deriveAddresses(litKey, code);
    const depositSource = pickDeposit(derived, 'source');
    const depositDest = pickDeposit(derived, 'dest');
    const litActionEvmAddr = derived.evmAddress;

    log(out, 'Switch to Base Sepolia to create the swap…', 'dim');
    await switchChain(CHAIN_HEX['base-sepolia']);
    const c = writeContract(signer);
    const tx = await c.createSwap(
      i.intentId, i.sourceChain, i.destChain, i.sourceAmount, destAmount, i.minDestAmount,
      i.userRefundSource, i.userReceiveDest, solverReceiveSource, solverRefundDest,
      depositSource, depositDest, 1, i.expiration, i.feeBps,
      cid, salt, litActionEvmAddr, i.tokenSource, i.tokenDest,
    );
    log(out, 'Tx submitted: ' + tx.hash, 'dim');
    const receipt = await tx.wait();
    let swapId = '';
    for (const lg of receipt.logs) {
      try { const p = c.interface.parseLog(lg); if (p && p.name === 'SwapCreated') { swapId = p.args.swapId.toString(); break; } } catch {}
    }
    log(out, '');
    log(out, '=== Quote posted — swap #' + swapId + ' ===', 'success');
    log(out, 'You deliver: ' + destAmount + ' on ' + i.destChain);
    log(out, 'Source deposit (user funds): ' + depositSource, 'dim');
    log(out, 'Dest deposit (you fund): ' + depositDest, 'dim');
    log(out, '');
    log(out, 'Wait for the user to fund the source leg, then go to My Fills (swap #' + swapId + ') to fund dest and execute.');
    document.getElementById('fill-swap-id').value = swapId;
    document.getElementById('fill-lit-key').value = litKey;
  } catch (err) { log(out, 'Error: ' + err.message, 'error'); console.error(err); }
}

// ---- fills: check / fund dest / execute -----------------------------------
function renderFillLegs(s) {
  const el = document.getElementById('fill-legs');
  const destState = s.destLegSettled ? 'done' : (s.sourceLegSettled ? 'active' : '');
  el.innerHTML = `
    <div class="leg ${s.sourceLegSettled || s.state === 2 ? 'done' : 'active'}"><span class="dot"></span><span class="leg-label">Source leg — user funds (${s.sourceChain})</span><span class="leg-tx">${s.sourceLegTxHash || ''}</span></div>
    <div class="leg ${destState}"><span class="dot"></span><span class="leg-label">Dest leg — you fund (${s.destChain})</span><span class="leg-tx">${s.destLegTxHash || ''}</span></div>
    <div class="leg ${s.state === 2 ? 'done' : ''}"><span class="dot"></span><span class="leg-label">Receipt ${s.state === 2 ? 'signed' : 'pending'}</span></div>`;
}

async function checkFill() {
  const out = 'fill-output';
  clearLog(out);
  const swapId = document.getElementById('fill-swap-id').value;
  if (swapId === '') { log(out, 'Enter a swap ID.', 'error'); return; }
  try {
    const s = await readSwap(swapId);
    renderFillLegs(s);
    log(out, '=== Swap #' + swapId + ' (' + s.stateName + ') ===');
    log(out, s.sourceChain + ' → ' + s.destChain);
    // source funded?
    if (CHAIN_FAMILY[s.sourceChain] === 'evm' && CHAIN_RPC[s.sourceChain]) {
      const prov = new ethers.JsonRpcProvider(CHAIN_RPC[s.sourceChain]);
      const bal = await prov.getBalance(s.depositAddressSource);
      const funded = bal >= s.sourceAmount;
      log(out, 'Source deposit: ' + bal.toString() + ' / ' + s.sourceAmount.toString() + (funded ? ' — FUNDED, safe to fund dest' : ' — waiting on the user'), funded ? 'success' : 'warn');
    } else {
      log(out, 'Source is ' + s.sourceChain + ' — verify the user funded ' + s.depositAddressSource + ' before funding dest.', 'warn');
    }
    log(out, 'You deliver ' + s.destAmount.toString() + ' to ' + s.depositAddressDest + ' on ' + s.destChain, 'dim');
  } catch (err) { log(out, 'Error: ' + err.message, 'error'); console.error(err); }
}

async function fundDest() {
  const out = 'fill-output';
  clearLog(out);
  if (!signer) { log(out, 'Connect wallet first.', 'error'); return; }
  const swapId = document.getElementById('fill-swap-id').value;
  if (swapId === '') { log(out, 'Enter a swap ID.', 'error'); return; }
  try {
    const s = await readSwap(swapId);
    if (CHAIN_FAMILY[s.destChain] === 'evm' && s.tokenAddressDest === ethers.ZeroAddress) {
      await switchChain(CHAIN_HEX[s.destChain]);
      const tx = await signer.sendTransaction({ to: s.depositAddressDest, value: s.destAmount });
      log(out, 'Tx submitted: ' + tx.hash, 'dim');
      await tx.wait();
      log(out, '=== Dest leg funded ===', 'success');
      log(out, 'Now hit Execute to settle both legs.');
    } else {
      log(out, '=== Send the dest asset manually ===', 'warn');
      log(out, 'Send exactly ' + s.destAmount.toString() + ' (smallest unit)');
      log(out, 'on ' + s.destChain);
      log(out, 'to: ' + s.depositAddressDest);
      log(out, '');
      log(out, 'Once it confirms, hit Execute.');
    }
  } catch (err) { log(out, 'Error: ' + err.message, 'error'); console.error(err); }
}

async function executeSwap() {
  const out = 'fill-output';
  clearLog(out);
  const swapId = document.getElementById('fill-swap-id').value;
  const litKey = document.getElementById('fill-lit-key').value;
  if (swapId === '') { log(out, 'Enter a swap ID.', 'error'); return; }
  if (!litKey) { log(out, 'Enter your Lit API key.', 'error'); return; }
  try {
    const s = await readSwap(swapId);
    const tkey = templateKeyForChains(s.sourceChain, s.destChain);
    if (!tkey) { log(out, 'Unsupported chain pair.', 'error'); return; }
    // Regenerate the action from the on-chain salt and confirm the CID matches.
    const code = getActionCode(tkey, s.salt, s.sourceChain, s.destChain);
    log(out, 'Verifying CID before execute…', 'dim');
    const computed = await computeCid(code);
    if (computed !== s.litActionCid) { log(out, 'CID mismatch — refusing to execute.', 'error'); return; }
    log(out, 'CID verified. Executing Lit Action (10-30s)…', 'dim');
    const resp = await fetch(`${LIT_API_BASE}/core/v1/lit_action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': litKey },
      body: JSON.stringify({ code, js_params: { mode: 'execute', swapId: Number(swapId), baseRpcUrl: BASE_RPC, contractAddress: CONTRACT_ADDRESS } }),
    });
    if (!resp.ok) { log(out, 'Lit API error: ' + resp.status, 'error'); log(out, await resp.text(), 'error'); return; }
    const result = await resp.json();
    const r = typeof result.response === 'string' ? JSON.parse(result.response) : result.response;
    log(out, '');
    if (r.status === 'executed') {
      log(out, '=== SWAP EXECUTED ===', 'success');
      log(out, 'Source tx (your receipt): ' + r.sourceTxId);
      log(out, 'Dest tx (paid to user): ' + r.destTxId);
      if (r.feeTxId) log(out, 'Fee tx: ' + r.feeTxId, 'dim');
      if (r.receiptSignature) log(out, 'Signed receipt: ' + r.receiptSignature, 'dim');
    } else if (r.status === 'insufficient_funds') {
      log(out, '=== INSUFFICIENT FUNDS (' + r.leg + ') ===', 'warn');
      log(out, 'balance ' + r.balance + ' / required ' + r.required);
      log(out, 'Fund the ' + r.leg + ' leg and retry.');
    } else {
      log(out, 'Result: ' + JSON.stringify(r, null, 2));
    }
    renderFillLegs(await readSwap(swapId));
  } catch (err) { log(out, 'Error: ' + err.message, 'error'); console.error(err); }
}

// ---- wiring ----------------------------------------------------------------
initThemeLabel();
document.getElementById('theme-btn').addEventListener('click', toggleTheme);
document.getElementById('wallet-btn').addEventListener('click', connectWallet);
document.getElementById('refresh-book').addEventListener('click', loadOrderBook);
document.getElementById('create-swap-btn').addEventListener('click', createSwapForIntent);
document.getElementById('check-fill-btn').addEventListener('click', checkFill);
document.getElementById('fund-dest-btn').addEventListener('click', fundDest);
document.getElementById('execute-btn').addEventListener('click', executeSwap);
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
loadOrderBook();
