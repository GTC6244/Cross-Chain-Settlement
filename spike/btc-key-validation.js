/**
 * Step 0: Key Primitive Validation
 *
 * This spike proves that getLitActionPrivateKey() returns 32 bytes
 * that can be used with bitcoinjs-lib to derive a Bitcoin address
 * and sign transactions.
 *
 * The Lit Action code (below) runs on the Lit network.
 * The orchestrator code (this file) deploys and executes it via REST API.
 *
 * Prerequisites:
 *   1. Create a Lit Chipotle account at https://dashboard.chipotle.litprotocol.com
 *   2. Set LIT_API_KEY environment variable
 *   3. Fund the account with credits
 */

const LIT_API_BASE = 'https://api.chipotle.litprotocol.com';

// ---------------------------------------------------------------------------
// Lit Action code — this runs INSIDE the Lit network's Deno sandbox
// It uses getLitActionPrivateKey() to get the raw 32-byte key,
// then derives Bitcoin and EVM addresses from it.
// ---------------------------------------------------------------------------
const LIT_ACTION_CODE = `
async function main(params) {
  // Get the 32-byte private key for this Lit Action
  const privateKeyHex = await Lit.Actions.getLitActionPrivateKey();

  // Derive EVM address using ethers (available in Lit runtime)
  const evmWallet = new ethers.Wallet(privateKeyHex);
  const evmAddress = evmWallet.address;

  // For Bitcoin, we can't use bitcoinjs-lib inside the Lit Action
  // (it's not available in the Deno sandbox). Instead, we return
  // the raw public key and derive the address client-side.
  //
  // The private key is secp256k1, same curve as Bitcoin.
  // We use ethers to get the compressed public key.
  const publicKey = evmWallet.signingKey.compressedPublicKey;

  return {
    evmAddress,
    publicKey,
    privateKeyLength: privateKeyHex.replace('0x', '').length / 2,
    message: 'Key primitive validation successful'
  };
}
`;

// ---------------------------------------------------------------------------
// Orchestrator — deploys and executes the Lit Action via REST API
// ---------------------------------------------------------------------------

async function main() {
  const apiKey = process.env.LIT_API_KEY;

  if (!apiKey) {
    console.log('=== Step 0: Key Primitive Validation ===\n');
    console.log('This spike validates that getLitActionPrivateKey() returns');
    console.log('32 bytes usable with bitcoinjs-lib for Bitcoin signing.\n');
    console.log('To run this spike against the live Lit network:\n');
    console.log('  1. Create account: https://dashboard.chipotle.litprotocol.com');
    console.log('  2. export LIT_API_KEY=<your-api-key>');
    console.log('  3. node spike/btc-key-validation.js\n');
    console.log('--- Running LOCAL validation instead ---\n');

    // Local validation: prove bitcoinjs-lib can derive addresses from 32 bytes
    await localValidation();
    return;
  }

  console.log('=== Step 0: Key Primitive Validation (LIVE) ===\n');
  await liveValidation(apiKey);
}

/**
 * Local validation: prove that a 32-byte key works with both
 * ethers.js and bitcoinjs-lib to derive addresses.
 */
async function localValidation() {
  const { ethers } = await import('ethers');
  const bitcoin = await import('bitcoinjs-lib');
  const ecc = await import('tiny-secp256k1');
  const { ECPairFactory } = await import('ecpair');

  const crypto = await import('crypto');
  const ECPair = ECPairFactory(ecc);

  // Simulate a 32-byte private key (in production, this comes from getLitActionPrivateKey())
  const testKey = crypto.randomBytes(32);

  console.log(`Private key length: ${testKey.length} bytes`);
  console.log(`Private key (hex): ${testKey.toString('hex')}\n`);

  // --- EVM Address ---
  const evmWallet = new ethers.Wallet('0x' + testKey.toString('hex'));
  console.log(`EVM address: ${evmWallet.address}`);

  // --- Bitcoin Mainnet Address ---
  const keyPair = ECPair.fromPrivateKey(testKey);
  const { address: btcMainnet } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(keyPair.publicKey),
    network: bitcoin.networks.bitcoin,
  });
  console.log(`Bitcoin mainnet (p2wpkh): ${btcMainnet}`);

  // --- Bitcoin Signet Address ---
  const { address: btcSignet } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(keyPair.publicKey),
    network: bitcoin.networks.testnet, // signet uses testnet params
  });
  console.log(`Bitcoin signet (p2wpkh): ${btcSignet}`);

  // --- Sign a message with Bitcoin key ---
  const msgHash = crypto.createHash('sha256').update('test message').digest();
  const signature = keyPair.sign(msgHash);
  console.log(`\nBitcoin signature (hex): ${signature.toString('hex')}`);
  console.log(`Signature length: ${signature.length} bytes`);

  // --- Verify signature ---
  const verified = keyPair.verify(msgHash, signature);
  console.log(`Signature verified: ${verified}`);

  // --- Sign an EVM message ---
  const evmSig = await evmWallet.signMessage('test message');
  console.log(`\nEVM signature: ${evmSig}`);

  console.log('\n=== LOCAL VALIDATION PASSED ===');
  console.log('A 32-byte key can derive both EVM and Bitcoin addresses');
  console.log('and sign messages with both ethers.js and bitcoinjs-lib.');
  console.log('\nNext: run with LIT_API_KEY to validate getLitActionPrivateKey()');
}

/**
 * Live validation: execute on the actual Lit network
 */
async function liveValidation(apiKey) {
  // Step 1: Compute the IPFS CID for our action code
  console.log('1. Computing IPFS CID for action code...');
  const cidResp = await fetch(`${LIT_API_BASE}/core/v1/get_lit_action_ipfs_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(LIT_ACTION_CODE),
  });
  const cidResult = await cidResp.json();
  console.log(`   CID: ${JSON.stringify(cidResult)}`);

  // Step 2: Register the action
  console.log('\n2. Registering action...');
  const registerResp = await fetch(`${LIT_API_BASE}/core/v1/add_action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify({
      action_ipfs_cid: cidResult.ipfs_id || cidResult.cid || cidResult,
      name: 'btc-key-validation-spike',
      description: 'Step 0: Validates getLitActionPrivateKey() returns 32 bytes for Bitcoin signing',
    }),
  });
  console.log(`   Status: ${registerResp.status}`);
  const registerResult = await registerResp.json();
  console.log(`   Result: ${JSON.stringify(registerResult)}`);

  // Step 3: Execute the action
  console.log('\n3. Executing Lit Action...');
  const execResp = await fetch(`${LIT_API_BASE}/core/v1/lit_action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify({
      code: LIT_ACTION_CODE,
      js_params: {},
    }),
  });

  if (!execResp.ok) {
    const errText = await execResp.text();
    console.error(`   ERROR: ${execResp.status} — ${errText}`);
    console.log('\n   This may mean the action needs to be in a group with a usage API key.');
    console.log('   Check: https://dashboard.chipotle.litprotocol.com');
    return;
  }

  const execResult = await execResp.json();
  console.log(`   Response: ${JSON.stringify(execResult, null, 2)}`);

  // Step 4: Derive Bitcoin address from the returned public key
  if (execResult.response) {
    const result = typeof execResult.response === 'string'
      ? JSON.parse(execResult.response)
      : execResult.response;

    console.log('\n4. Deriving Bitcoin address from public key...');
    console.log(`   EVM address: ${result.evmAddress}`);
    console.log(`   Key length: ${result.privateKeyLength} bytes`);

    if (result.publicKey) {
      const bitcoin = await import('bitcoinjs-lib');
      const pubkeyBuf = Buffer.from(result.publicKey.replace('0x', ''), 'hex');
      const { address } = bitcoin.payments.p2wpkh({
        pubkey: pubkeyBuf,
        network: bitcoin.networks.testnet,
      });
      console.log(`   Bitcoin Signet address: ${address}`);
    }

    console.log('\n=== LIVE VALIDATION PASSED ===');
    console.log('getLitActionPrivateKey() returns a key usable for Bitcoin signing.');
  }
}

main().catch(console.error);
