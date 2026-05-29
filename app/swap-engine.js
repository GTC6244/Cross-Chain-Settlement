/**
 * Action Swaps — Browser Engine
 *
 * Static web app. No backend. Talks directly to:
 * - Base RPC (via ethers.js from CDN)
 * - Lit Chipotle REST API (via fetch)
 * - User's wallet (MetaMask / injected provider)
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LIT_API_BASE = 'https://api.chipotle.litprotocol.com';

const CHAIN_RPC = {
  'base-sepolia': 'https://sepolia.base.org',
  'ethereum-sepolia': 'https://rpc.sepolia.org',
  'arbitrum-sepolia': 'https://sepolia-rollup.arbitrum.io/rpc',
  'optimism-sepolia': 'https://sepolia.optimism.io',
};

// Contract deployed on Base Sepolia
// TODO: update after deployment
const CONTRACT_ADDRESS = '0x0000000000000000000000000000000000000000';
const BASE_RPC = CHAIN_RPC['base-sepolia'];

const CONTRACT_ABI = [
  'function createSwap(string sourceChain, string destChain, uint256 sourceAmount, uint256 destAmount, string refundAddressSource, string refundAddressDest, string depositAddressSource, string depositAddressDest, uint256 confirmationBlocks, uint256 expirationTimestamp, uint16 feeBps, string litActionCid, address litActionEvmAddress, address tokenAddressSource, address tokenAddressDest) returns (uint256)',
  'function markExecuted(uint256 swapId)',
  'function markRefunded(uint256 swapId)',
  'function getSwapState(uint256 swapId) view returns (uint8 state, address creator, address litActionEvmAddress, uint256 sourceAmount, uint256 destAmount, uint16 feeBps, uint256 expirationTimestamp, string litActionCid)',
  'function getSwapAddresses(uint256 swapId) view returns (string sourceChain, string destChain, string refundAddressSource, string refundAddressDest, string depositAddressSource, string depositAddressDest, uint256 confirmationBlocks)',
  'function getSwapTokens(uint256 swapId) view returns (address tokenAddressSource, address tokenAddressDest)',
  'function swapCount() view returns (uint256)',
  'function owner() view returns (address)',
  'event SwapCreated(uint256 indexed swapId, string sourceChain, string destChain, uint256 sourceAmount, uint256 destAmount, string litActionCid, address creator)',
];

const STATE_NAMES = ['Created', 'Funded', 'Executed', 'Refunded', 'Expired'];
const STATE_CLASSES = ['badge-created', 'badge-created', 'badge-executed', 'badge-refunded', 'badge-expired'];

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

let signer = null;
let userAddress = null;

async function connectWallet() {
  const btn = document.getElementById('wallet-btn');

  if (!window.ethereum) {
    alert('No wallet detected. Install MetaMask or another web3 wallet.');
    return;
  }

  try {
    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send('eth_requestAccounts', []);
    signer = await provider.getSigner();
    userAddress = await signer.getAddress();

    btn.textContent = userAddress.slice(0, 6) + '...' + userAddress.slice(-4);
    btn.classList.add('connected');

    const createBtn = document.getElementById('create-btn');
    createBtn.disabled = false;
    createBtn.textContent = 'Create Swap';

    // Auto-fill refund addresses
    document.getElementById('refund-source').value = userAddress;
    document.getElementById('refund-dest').value = userAddress;
  } catch (err) {
    alert('Wallet connection failed: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`.tab[onclick="showTab('${name}')"]`).classList.add('active');
  document.getElementById('panel-' + name).classList.add('active');
}

// ---------------------------------------------------------------------------
// Status output helpers
// ---------------------------------------------------------------------------

function log(boxId, msg, cls) {
  const box = document.getElementById(boxId);
  box.style.display = 'block';
  const line = document.createElement('div');
  line.className = 'line' + (cls ? ' ' + cls : '');
  line.textContent = msg;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function clearLog(boxId) {
  const box = document.getElementById(boxId);
  box.innerHTML = '';
  box.style.display = 'none';
}


// ---------------------------------------------------------------------------
// Action template dispatch
// ---------------------------------------------------------------------------
// The audited per-pair generators live in app/actions/*.js and are exposed on
// window.ActionTemplates by a module script in index.html.

const CHAIN_FAMILY = {
  'base-sepolia': 'evm', 'ethereum-sepolia': 'evm', 'arbitrum-sepolia': 'evm', 'optimism-sepolia': 'evm',
  'bitcoin-signet': 'btc', 'litecoin-testnet': 'ltc', 'dogecoin-testnet': 'doge',
  'zcash-testnet': 'zec', 'solana-devnet': 'sol',
};

// Family pair -> registered template key (direction-independent).
const TEMPLATE_BY_FAMILIES = {
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

function templateKeyForChains(sourceChain, destChain) {
  const key = CHAIN_FAMILY[sourceChain] + ',' + CHAIN_FAMILY[destChain];
  return TEMPLATE_BY_FAMILIES[key];
}

function getActionCode(actionType, salt, sourceChain, destChain) {
  const templates = window.ActionTemplates || {};
  const gen = templates[actionType];
  if (!gen) throw new Error('No action template registered for "' + actionType + '"');
  return gen(salt, sourceChain, destChain);
}

// Pick a side's deposit address from a derive-mode result. The engine returns
// evmAddress plus "<label>AddressSource" / "<label>AddressDest" keys.
function pickDeposit(addresses, side) {
  const suffix = side === 'source' ? 'AddressSource' : 'AddressDest';
  for (const k of Object.keys(addresses)) if (k.endsWith(suffix)) return addresses[k];
  // Fail loud rather than silently routing funds to the EVM action identity.
  throw new Error('Derive result missing ' + suffix + ' deposit address: ' + JSON.stringify(addresses));
}

// ---------------------------------------------------------------------------
// Salt & CID
// ---------------------------------------------------------------------------

async function generateSalt(swapId, contractAddress, timestamp) {
  const data = new TextEncoder().encode(`${swapId}:${contractAddress}:${timestamp}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function computeCid(code) {
  const resp = await fetch(`${LIT_API_BASE}/core/v1/get_lit_action_ipfs_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(code),
  });
  if (!resp.ok) throw new Error('CID computation failed: ' + resp.status);
  const result = await resp.json();
  return result.ipfs_id || result.cid || result;
}

async function deriveAddresses(litApiKey, actionCode) {
  const resp = await fetch(`${LIT_API_BASE}/core/v1/lit_action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': litApiKey,
    },
    body: JSON.stringify({
      code: actionCode,
      js_params: { mode: 'derive' },
    }),
  });
  if (!resp.ok) throw new Error('Address derivation failed: ' + resp.status + ' ' + await resp.text());
  const result = await resp.json();
  return typeof result.response === 'string' ? JSON.parse(result.response) : result.response;
}

// ---------------------------------------------------------------------------
// Create Swap
// ---------------------------------------------------------------------------

async function createSwap() {
  const output = 'create-output';
  clearLog(output);

  if (!signer) {
    log(output, 'Connect wallet first.', 'error');
    return;
  }

  const sourceChain = document.getElementById('source-chain').value;
  const destChain = document.getElementById('dest-chain').value;
  const sourceAmount = document.getElementById('source-amount').value;
  const destAmount = document.getElementById('dest-amount').value;
  const refundSource = document.getElementById('refund-source').value;
  const refundDest = document.getElementById('refund-dest').value;
  const feeBps = parseInt(document.getElementById('fee-bps').value);
  const expirationHours = parseFloat(document.getElementById('expiration-hours').value);
  const actionType = document.getElementById('action-type').value;

  if (!sourceAmount || !destAmount) {
    log(output, 'Enter amounts for both sides.', 'error');
    return;
  }

  try {
    // 1. Read swapCount to predict next ID
    log(output, 'Reading contract state...', 'dim');
    const provider = new ethers.JsonRpcProvider(BASE_RPC);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
    const nextId = await contract.swapCount();
    log(output, 'Next swap ID: ' + nextId.toString());

    // 2. Generate salt and action code
    const timestamp = Date.now();
    const salt = await generateSalt(nextId.toString(), CONTRACT_ADDRESS, timestamp);
    log(output, 'Salt: ' + salt.slice(0, 16) + '...', 'dim');

    // Derive the template from the actual chains so create and execute/verify
    // always resolve the SAME (type, source, dest) -> same CID. The #action-type
    // dropdown is advisory; the selected chains are authoritative. If they
    // disagree, a swap could be created whose CID can never be reproduced at
    // execute time, locking the funds.
    const resolvedType = templateKeyForChains(sourceChain, destChain);
    if (!resolvedType) {
      log(output, 'Unsupported chain pair: ' + sourceChain + ' <> ' + destChain, 'error');
      return;
    }
    if (resolvedType !== actionType) {
      log(output, 'Swap type "' + actionType + '" does not match the selected chains; using "' + resolvedType + '".', 'warn');
    }

    let actionCode;
    try {
      actionCode = getActionCode(resolvedType, salt, sourceChain, destChain);
    } catch (e) {
      log(output, e.message, 'error');
      return;
    }

    // 3. Compute CID
    log(output, 'Computing IPFS CID...', 'dim');
    const cid = await computeCid(actionCode);
    log(output, 'CID: ' + cid);

    // 4. Derive deposit addresses
    const litApiKey = prompt('Enter your Lit Chipotle API key to derive deposit addresses:');
    if (!litApiKey) {
      log(output, 'Lit API key required for address derivation.', 'error');
      return;
    }

    log(output, 'Deriving deposit addresses via Lit...', 'dim');
    const addresses = await deriveAddresses(litApiKey, actionCode);
    const depositSourceAddr = pickDeposit(addresses, 'source');
    const depositDestAddr = pickDeposit(addresses, 'dest');
    const litActionEvmAddr = addresses.evmAddress;
    log(output, 'Source deposit (' + sourceChain + '): ' + depositSourceAddr, 'success');
    log(output, 'Dest deposit (' + destChain + '): ' + depositDestAddr, 'success');

    // 5. Create swap on contract (user's wallet signs)
    log(output, 'Creating swap on Base contract...', 'dim');

    // Switch to Base Sepolia if needed
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x14a34' }], // Base Sepolia chain ID
      });
    } catch (switchErr) {
      log(output, 'Please switch to Base Sepolia network in your wallet.', 'warn');
    }

    const walletProvider = new ethers.BrowserProvider(window.ethereum);
    const walletSigner = await walletProvider.getSigner();
    const walletContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, walletSigner);

    const expirationTs = Math.floor((timestamp + expirationHours * 3600 * 1000) / 1000);

    const tokenSource = document.getElementById('token-source').value || ethers.ZeroAddress;
    const tokenDest = document.getElementById('token-dest').value || ethers.ZeroAddress;

    const tx = await walletContract.createSwap(
      sourceChain,
      destChain,
      sourceAmount,
      destAmount,
      refundSource,
      refundDest,
      depositSourceAddr,
      depositDestAddr,
      1, // confirmation blocks
      expirationTs,
      feeBps,
      cid,
      litActionEvmAddr, // EVM identity that calls markExecuted/markRefunded on Base
      tokenSource,
      tokenDest,
    );

    log(output, 'Tx submitted: ' + tx.hash, 'dim');
    const receipt = await tx.wait();
    log(output, 'Confirmed in block ' + receipt.blockNumber, 'success');

    // Parse swap ID from event
    let swapId = nextId.toString();
    for (const eventLog of receipt.logs) {
      try {
        const parsed = walletContract.interface.parseLog(eventLog);
        if (parsed && parsed.name === 'SwapCreated') {
          swapId = parsed.args[0].toString();
          break;
        }
      } catch {}
    }

    // Store webhook URL if provided
    storeWebhookForSwap(swapId);

    log(output, '');
    log(output, '=== Swap Created ===', 'success');
    log(output, 'Swap ID: ' + swapId);
    log(output, 'Type: ' + resolvedType);
    log(output, sourceChain + ' -> ' + destChain);
    log(output, 'Expires: ' + new Date(expirationTs * 1000).toISOString());
    log(output, 'Salt: ' + salt, 'dim');
    log(output, 'CID: ' + cid, 'dim');
    log(output, '');
    log(output, 'Deposit addresses (fund both sides):');
    log(output, '  Source (' + sourceChain + '): ' + depositSourceAddr);
    log(output, '  Dest (' + destChain + '): ' + depositDestAddr);
    if (tokenSource !== ethers.ZeroAddress) {
      log(output, '  Source token: ' + tokenSource, 'dim');
    }
    if (tokenDest !== ethers.ZeroAddress) {
      log(output, '  Dest token: ' + tokenDest, 'dim');
    }
    log(output, '');
    log(output, 'SAVE THE SALT above - you need it to execute or verify this swap.');
    log(output, 'Next: fund both addresses, then execute swap #' + swapId);

  } catch (err) {
    log(output, 'Error: ' + err.message, 'error');
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Check Status
// ---------------------------------------------------------------------------

async function checkStatus() {
  const output = 'status-output';
  clearLog(output);

  const swapId = document.getElementById('status-swap-id').value;
  if (swapId === '') {
    log(output, 'Enter a swap ID.', 'error');
    return;
  }

  try {
    log(output, 'Reading swap #' + swapId + '...', 'dim');
    const provider = new ethers.JsonRpcProvider(BASE_RPC);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);

    const [state, creator, litAddr, sourceAmount, destAmount, feeBps, expiration, cid] =
      await contract.getSwapState(swapId);

    const [sourceChain, destChain, refundSource, refundDest, depositSource, depositDest, confirmBlocks] =
      await contract.getSwapAddresses(swapId);

    const stateNum = Number(state);
    const isExpired = Date.now() / 1000 > Number(expiration);

    log(output, '=== Swap #' + swapId + ' ===');
    log(output, 'State: ' + STATE_NAMES[stateNum] + (isExpired && stateNum === 0 ? ' (EXPIRED)' : ''),
      stateNum === 2 ? 'success' : stateNum >= 3 ? 'warn' : '');
    log(output, 'Creator: ' + creator, 'dim');
    log(output, 'CID: ' + cid, 'dim');
    log(output, 'Expires: ' + new Date(Number(expiration) * 1000).toISOString());
    log(output, '');
    log(output, 'Source: ' + sourceChain);
    log(output, '  Amount: ' + sourceAmount.toString());
    log(output, '  Deposit: ' + depositSource);
    log(output, '  Refund: ' + refundSource);
    log(output, '');
    log(output, 'Dest: ' + destChain);
    log(output, '  Amount: ' + destAmount.toString());
    log(output, '  Deposit: ' + depositDest);
    log(output, '  Refund: ' + refundDest);
    log(output, '');
    log(output, 'Fee: ' + Number(feeBps) + ' bps');

    // Check balances on both chains
    const srcRpc = CHAIN_RPC[sourceChain];
    const dstRpc = CHAIN_RPC[destChain];

    if (srcRpc) {
      const srcProv = new ethers.JsonRpcProvider(srcRpc);
      const srcBal = await srcProv.getBalance(depositSource);
      const needed = ethers.getBigInt(sourceAmount);
      const funded = srcBal >= needed;
      log(output, '');
      log(output, 'Source balance: ' + ethers.formatEther(srcBal) + ' ETH' +
        (funded ? ' (FUNDED)' : ' (waiting)'), funded ? 'success' : 'warn');
    }

    if (dstRpc) {
      const dstProv = new ethers.JsonRpcProvider(dstRpc);
      const dstBal = await dstProv.getBalance(depositDest);
      const needed = ethers.getBigInt(destAmount);
      const funded = dstBal >= needed;
      log(output, 'Dest balance: ' + ethers.formatEther(dstBal) + ' ETH' +
        (funded ? ' (FUNDED)' : ' (waiting)'), funded ? 'success' : 'warn');
    }

  } catch (err) {
    log(output, 'Error: ' + err.message, 'error');
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Execute Swap
// ---------------------------------------------------------------------------

async function executeSwap() {
  const output = 'execute-output';
  clearLog(output);

  const swapId = document.getElementById('execute-swap-id').value;
  const litApiKey = document.getElementById('lit-api-key').value;

  if (swapId === '') {
    log(output, 'Enter a swap ID.', 'error');
    return;
  }
  if (!litApiKey) {
    log(output, 'Enter your Lit Chipotle API key.', 'error');
    return;
  }

  try {
    // 1. Read swap details to reconstruct the action code
    log(output, 'Reading swap #' + swapId + ' from contract...', 'dim');
    const provider = new ethers.JsonRpcProvider(BASE_RPC);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);

    const [state, , , , , , , cid] = await contract.getSwapState(swapId);
    const [sourceChain, destChain] = await contract.getSwapAddresses(swapId);

    if (Number(state) !== 0) {
      log(output, 'Swap is in state ' + STATE_NAMES[Number(state)] + ', not Created.', 'error');
      return;
    }

    // 2. We need the action code. For now, reconstruct from template + CID.
    // In production, the action code would be fetched from IPFS by CID.
    // For testnet, we regenerate it (same salt = same CID = same key).
    log(output, 'Stored CID: ' + cid);
    log(output, '');
    log(output, 'NOTE: For testnet, enter the salt used when creating this swap.', 'warn');

    const salt = prompt('Enter the swap salt (shown during creation):');
    if (!salt) {
      log(output, 'Salt required to reconstruct action code.', 'error');
      return;
    }

    const actionType = templateKeyForChains(sourceChain, destChain);
    if (!actionType) {
      log(output, 'Unsupported chain pair: ' + sourceChain + ' <> ' + destChain, 'error');
      return;
    }
    let actionCode;
    try {
      actionCode = getActionCode(actionType, salt, sourceChain, destChain);
    } catch (e) {
      log(output, e.message, 'error');
      return;
    }

    // Verify CID matches
    log(output, 'Verifying CID...', 'dim');
    const computedCid = await computeCid(actionCode);
    if (computedCid !== cid) {
      log(output, 'CID MISMATCH! Computed: ' + computedCid + ' vs stored: ' + cid, 'error');
      log(output, 'The salt may be wrong, or the action template changed.', 'error');
      return;
    }
    log(output, 'CID verified.', 'success');

    // 3. Execute via Lit
    log(output, 'Executing Lit Action...', 'dim');
    log(output, 'This may take 10-30 seconds.', 'dim');

    const resp = await fetch(`${LIT_API_BASE}/core/v1/lit_action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': litApiKey,
      },
      body: JSON.stringify({
        code: actionCode,
        js_params: {
          mode: 'execute',
          swapId: parseInt(swapId),
          baseRpcUrl: BASE_RPC,
          contractAddress: CONTRACT_ADDRESS,
        },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      log(output, 'Lit API error: ' + resp.status, 'error');
      log(output, errText, 'error');
      return;
    }

    const result = await resp.json();
    log(output, '');

    const response = typeof result.response === 'string'
      ? JSON.parse(result.response)
      : result.response;

    if (response.status === 'executed') {
      log(output, '=== SWAP EXECUTED ===', 'success');
      log(output, 'Source tx: ' + response.sourceTxHash);
      log(output, 'Dest tx: ' + response.destTxHash);
      if (response.feeHash) {
        log(output, 'Fee tx: ' + response.feeHash);
      }
      if (response.receipt) {
        log(output, '');
        log(output, 'Signed receipt:', 'dim');
        log(output, response.receipt, 'dim');
        log(output, 'Signature: ' + response.receiptSignature, 'dim');
      }
    } else if (response.status === 'insufficient_funds') {
      log(output, '=== INSUFFICIENT FUNDS ===', 'warn');
      log(output, 'Source: ' + response.sourceBalance + ' / ' + response.requiredSource);
      log(output, 'Dest: ' + response.destBalance + ' / ' + response.requiredDest);
      log(output, 'Fund both deposit addresses and try again.');
    } else if (response.status === 'refunded') {
      log(output, '=== SWAP REFUNDED (expired) ===', 'warn');
      if (response.sourceRefundHash) log(output, 'Source refund: ' + response.sourceRefundHash);
      if (response.destRefundHash) log(output, 'Dest refund: ' + response.destRefundHash);
    } else {
      log(output, 'Result: ' + JSON.stringify(response, null, 2));
    }

    if (result.logs && result.logs.length > 0) {
      log(output, '');
      log(output, 'Lit logs:', 'dim');
      result.logs.forEach(l => log(output, '  ' + l, 'dim'));
    }

    // Fire webhook if configured
    const webhookUrl = localStorage.getItem('webhook_swap_' + swapId);
    if (webhookUrl && response.status) {
      fireWebhook(webhookUrl, { swapId, ...response });
    }

  } catch (err) {
    log(output, 'Error: ' + err.message, 'error');
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Gas Preview
// ---------------------------------------------------------------------------

async function gasPreview() {
  const output = 'preview-output';
  clearLog(output);

  const sourceChain = document.getElementById('preview-source-chain').value;
  const destChain = document.getElementById('preview-dest-chain').value;
  const sourceAmount = document.getElementById('preview-source-amount').value;
  const feeBps = parseInt(document.getElementById('preview-fee-bps').value) || 0;

  if (!sourceAmount) {
    log(output, 'Enter a source amount.', 'error');
    return;
  }

  try {
    log(output, 'Estimating gas costs...', 'dim');

    const srcRpc = CHAIN_RPC[sourceChain];
    const dstRpc = CHAIN_RPC[destChain];

    if (!srcRpc || !dstRpc) {
      log(output, 'Unknown chain. Only EVM testnets supported for preview.', 'error');
      return;
    }

    // Fetch gas prices from both chains + Base
    const [srcProvider, dstProvider, baseProvider] = [
      new ethers.JsonRpcProvider(srcRpc),
      new ethers.JsonRpcProvider(dstRpc),
      new ethers.JsonRpcProvider(BASE_RPC),
    ];

    const [srcFeeData, dstFeeData, baseFeeData] = await Promise.all([
      srcProvider.getFeeData(),
      dstProvider.getFeeData(),
      baseProvider.getFeeData(),
    ]);

    const buffer = 120n; // 20% buffer
    const normalize = (fee) => fee ? (fee * buffer / 100n) : 0n;

    // Gas estimates (with 20% buffer)
    const createSwapGas = 350000n; // contract call on Base
    const markExecutedGas = 50000n; // contract call on Base
    const transferGas = 21000n;     // native ETH transfer

    const createCost = createSwapGas * normalize(baseFeeData.gasPrice);
    const markCost = markExecutedGas * normalize(baseFeeData.gasPrice);
    const srcTransferCost = transferGas * normalize(srcFeeData.gasPrice);
    const dstTransferCost = transferGas * normalize(dstFeeData.gasPrice);
    const feeTransferCost = feeBps > 0 ? srcTransferCost : 0n;

    const totalBase = createCost + markCost;
    const totalSource = srcTransferCost + feeTransferCost;
    const totalDest = dstTransferCost;
    const swapFee = BigInt(sourceAmount) * BigInt(feeBps) / 10000n;

    log(output, '=== Gas Cost Estimate ===');
    log(output, '(All estimates include 20% buffer)\n');

    log(output, 'Base chain (contract ops):');
    log(output, '  Create swap:    ' + ethers.formatEther(createCost) + ' ETH');
    log(output, '  Mark executed:  ' + ethers.formatEther(markCost) + ' ETH');
    log(output, '  Subtotal:       ' + ethers.formatEther(totalBase) + ' ETH', 'success');

    log(output, '');
    log(output, 'Source chain (' + sourceChain + '):');
    log(output, '  Send to dest:   ' + ethers.formatEther(srcTransferCost) + ' ETH');
    if (feeBps > 0) {
      log(output, '  Send fee:       ' + ethers.formatEther(feeTransferCost) + ' ETH');
    }
    log(output, '  Subtotal:       ' + ethers.formatEther(totalSource) + ' ETH', 'success');

    log(output, '');
    log(output, 'Dest chain (' + destChain + '):');
    log(output, '  Send to source: ' + ethers.formatEther(dstTransferCost) + ' ETH');
    log(output, '  Subtotal:       ' + ethers.formatEther(totalDest) + ' ETH', 'success');

    log(output, '');
    log(output, 'Swap fee (' + feeBps + ' bps):');
    log(output, '  Deducted:       ' + ethers.formatEther(swapFee) + ' ETH', 'warn');

    log(output, '');
    const grandTotal = totalBase + totalSource + totalDest;
    log(output, 'TOTAL GAS:        ' + ethers.formatEther(grandTotal) + ' ETH', 'success');
    log(output, 'TOTAL WITH FEE:   ' + ethers.formatEther(grandTotal + swapFee) + ' ETH');

  } catch (err) {
    log(output, 'Error: ' + err.message, 'error');
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// CID Verification
// ---------------------------------------------------------------------------

async function verifyCid() {
  const output = 'verify-output';
  clearLog(output);

  const swapId = document.getElementById('verify-swap-id').value;
  const salt = document.getElementById('verify-salt').value;

  if (swapId === '' || !salt) {
    log(output, 'Enter swap ID and salt.', 'error');
    return;
  }

  try {
    // 1. Read CID from contract
    log(output, 'Reading swap #' + swapId + ' from contract...', 'dim');
    const provider = new ethers.JsonRpcProvider(BASE_RPC);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
    const [, , , , , , , storedCid] = await contract.getSwapState(swapId);
    const [sourceChain, destChain] = await contract.getSwapAddresses(swapId);
    log(output, 'Stored CID: ' + storedCid);

    // 2. Reconstruct action code from template + salt. Derive the template from
    // the swap's actual chains (same as execute) so a valid swap never shows a
    // false CID mismatch from a mis-picked dropdown.
    log(output, 'Reconstructing action code from template...', 'dim');
    const vType = templateKeyForChains(sourceChain, destChain);
    if (!vType) {
      log(output, 'Unsupported chain pair: ' + sourceChain + ' <> ' + destChain, 'error');
      return;
    }
    let actionCode;
    try {
      actionCode = getActionCode(vType, salt, sourceChain, destChain);
    } catch (e) {
      log(output, e.message, 'error');
      return;
    }

    // 3. Compute CID
    log(output, 'Computing CID from reconstructed code...', 'dim');
    const computedCid = await computeCid(actionCode);
    log(output, 'Computed CID: ' + computedCid);

    // 4. Compare
    log(output, '');
    if (computedCid === storedCid) {
      log(output, 'MATCH — CID verified.', 'success');
      log(output, 'The action code for swap #' + swapId + ' matches the ' + actionType + ' template with this salt.', 'success');
      log(output, 'This proves the swap action contains only the expected code.', 'dim');
    } else {
      log(output, 'MISMATCH — CIDs do not match.', 'error');
      log(output, 'Possible causes:', 'error');
      log(output, '  - Wrong salt', 'error');
      log(output, '  - Wrong action type', 'error');
      log(output, '  - Action template has been modified', 'error');
    }

  } catch (err) {
    log(output, 'Error: ' + err.message, 'error');
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

function fireWebhook(url, data) {
  // Best-effort POST, retry 3x, don't block the UI
  const payload = JSON.stringify({
    event: 'swap_' + data.status,
    timestamp: new Date().toISOString(),
    ...data,
  });

  let attempts = 0;
  function attempt() {
    attempts++;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      mode: 'no-cors', // fire-and-forget for cross-origin
    }).catch(() => {
      if (attempts < 3) setTimeout(attempt, 1000 * attempts);
      else console.warn('Webhook delivery failed after 3 attempts:', url);
    });
  }
  attempt();
}

// Store webhook URL when creating a swap
function storeWebhookForSwap(swapId) {
  const url = document.getElementById('webhook-url').value;
  if (url) {
    localStorage.setItem('webhook_swap_' + swapId, url);
  }
}
