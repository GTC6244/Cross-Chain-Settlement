/**
 * Solana leg driver (micro-sol-signer).
 *
 * The Lit Action's 32-byte secp256k1 key doubles as an Ed25519 seed, so the
 * action derives a Solana keypair from the SAME secret it uses for EVM/BTC and
 * signs the SOL transfer itself in-sandbox. No dependency on Lit's roadmap
 * native Ed25519 signing.
 *
 * RPC: plain Solana JSON-RPC via fetch (getBalance / getLatestBlockhash /
 * sendTransaction). Amounts are lamports (BigInt).
 *
 * Live-verification notes: exact micro-sol-signer createTransferSol/signTx
 * argument shapes and the drain fee reserve should be confirmed on devnet.
 */

export function solLegSrc() {
  return `
var SOL_FEE_RESERVE = 5000n; // lamports per signature, approx

async function solRpc(cfg, method, params) {
  var resp = await fetch(cfg.rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }),
  });
  if (!resp.ok) throw new Error("solana rpc " + method + " failed: " + resp.status);
  var json = await resp.json();
  if (json.error) throw new Error("solana rpc " + method + ": " + JSON.stringify(json.error));
  return json.result;
}

function makeSolLeg(ctx, chainId_, role) {
  var cfg = CHAINS[chainId_];
  var address = sol.getAddress(ctx.keyBytes);

  async function send(to, amount) {
    var bh = await solRpc(cfg, "getLatestBlockhash", [{ commitment: "finalized" }]);
    var blockhash = bh.value.blockhash;
    var tx = sol.createTransferSol(address, to, amount, blockhash);
    var signed = sol.signTx(ctx.keyBytes, tx);     // -> [txHash, base64Tx]
    var base64Tx = signed[1];
    var sig = await solRpc(cfg, "sendTransaction", [base64Tx, { encoding: "base64" }]);
    return sig;
  }

  return {
    label: "sol",
    role: role,
    chainName: chainId_,
    deriveAddress: async function () { return address; },
    getBalance: async function (addr) {
      var r = await solRpc(cfg, "getBalance", [addr]);
      return BigInt((r && r.value !== undefined ? r.value : r) || 0);
    },
    settle: async function (o) { return send(o.to, o.amount); },
    drain: async function (o) {
      var bal = await this.getBalance(o.deposit);
      var amt = bal - SOL_FEE_RESERVE;
      if (amt <= 0n) return null;
      return send(o.to, amt);
    },
  };
}
`;
}
