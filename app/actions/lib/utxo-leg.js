/**
 * UTXO leg driver for Bitcoin-family chains (BTC, LTC = SegWit P2WPKH;
 * DOGE = legacy P2PKH), built on @scure/btc-signer with per-chain network
 * params from the registry.
 *
 * Two exports:
 *   UTXO_MATH_SRC  - pure coin-selection / fee math as a code string. Embedded
 *                    into the action AND loaded directly by the unit tests
 *                    (single source of truth, no build step).
 *   utxoLegSrc()   - makeUtxoLeg(): address derivation, UTXO/prev-tx fetch,
 *                    transaction construction (witnessUtxo for SegWit,
 *                    nonWitnessUtxo for legacy), signing, and broadcast.
 *
 * Live-verification notes:
 *   - txid byte order passed to btc.addInput (display vs internal) must be
 *     confirmed against @scure/btc-signer on a live testnet.
 *   - the Dogecoin testnet API base in networks.js is a placeholder and must
 *     be pointed at a working explorer.
 */

export const UTXO_MATH_SRC = `
// Input/output vsize tables, shared by the UTXO and ZEC legs.
var SIZES_SEGWIT = { overhead: 11, input: 68, output: 31 };
var SIZES_LEGACY = { overhead: 10, input: 148, output: 34 };

// Vsize estimate. SegWit p2wpkh: in~68 / out~31 / overhead~11.
// Legacy p2pkh: in~148 / out~34 / overhead~10.
function txVsize(numIn, numOut, sizes) {
  return sizes.overhead + numIn * sizes.input + numOut * sizes.output;
}
function feeFor(numIn, numOut, sizes, feeRate, minFee) {
  var v = txVsize(numIn, numOut, sizes);
  var f = v * feeRate;
  return BigInt(f > minFee ? f : minFee);
}
// Largest-first selection to cover (amount + fee) assuming a change output.
// Returns { selected, fee, change }. Throws on insufficient funds.
function selectCoins(utxos, amount, feeRate, sizes, minFee) {
  var sorted = utxos.slice().sort(function (a, b) {
    return a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0;
  });
  var selected = [], total = 0n;
  for (var i = 0; i < sorted.length; i++) {
    selected.push(sorted[i]);
    total += sorted[i].amount;
    var fee = feeFor(selected.length, 2, sizes, feeRate, minFee);
    if (total >= amount + fee) break;
  }
  var feeFinal = feeFor(selected.length, 2, sizes, feeRate, minFee);
  if (total < amount + feeFinal) {
    throw new Error("insufficient utxo: have " + total + " need " + (amount + feeFinal));
  }
  return { selected: selected, fee: feeFinal, change: total - amount - feeFinal };
}
// Drain: spend every utxo to a single output (no change). Returns { selected, fee, send }.
function drainCoins(utxos, feeRate, sizes, minFee) {
  var total = 0n;
  for (var i = 0; i < utxos.length; i++) total += utxos[i].amount;
  var fee = feeFor(utxos.length, 1, sizes, feeRate, minFee);
  return { selected: utxos, fee: fee, send: total - fee };
}

// ---- Zcash ZIP-317 conventional fee (transparent only) ----
// Zcash does not use a sat/byte fee; since NU5 the network enforces ZIP-317:
//   conventional_fee = marginal_fee(5000 zat) * max(grace_actions(2), logical_actions)
// For transparent-only txs, logical_actions = max(numIn, numOut). zcashd's
// mempool rejects anything below this ("unpaid action limit exceeded"), so the
// ZEC leg must pay exactly the conventional fee. Verified on zcashd regtest.
function zip317Fee(numIn, numOut) {
  var logical = numIn > numOut ? numIn : numOut;
  var actions = logical > 2 ? logical : 2;
  return BigInt(actions) * 5000n;
}
// ZIP-317 analogue of selectCoins (fixed per-action fee instead of sat/byte).
function selectCoinsZip317(utxos, amount) {
  var sorted = utxos.slice().sort(function (a, b) {
    return a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0;
  });
  var selected = [], total = 0n;
  for (var i = 0; i < sorted.length; i++) {
    selected.push(sorted[i]);
    total += sorted[i].amount;
    if (total >= amount + zip317Fee(selected.length, 2)) break;
  }
  var fee = zip317Fee(selected.length, 2);
  if (total < amount + fee) {
    throw new Error("insufficient utxo: have " + total + " need " + (amount + fee));
  }
  return { selected: selected, fee: fee, change: total - amount - fee };
}
// ZIP-317 analogue of drainCoins.
function drainCoinsZip317(utxos) {
  var total = 0n;
  for (var i = 0; i < utxos.length; i++) total += utxos[i].amount;
  var fee = zip317Fee(utxos.length, 1);
  return { selected: utxos, fee: fee, send: total - fee };
}
`;

// Assumes UTXO_MATH_SRC (selectCoins/drainCoins + SIZES_*) is already embedded.
export function utxoLegSrc() {
  return `
async function utxoFetchUtxos(cfg, address) {
  if (cfg.api.style === "esplora") {
    var resp = await fetch(cfg.api.base + "/address/" + address + "/utxo");
    if (!resp.ok) throw new Error("utxo fetch failed: " + resp.status);
    var arr = await resp.json();
    return arr.filter(function (u) { return u.status && u.status.confirmed; })
              .map(function (u) { return { txid: u.txid, vout: u.vout, amount: BigInt(u[cfg.amountField]) }; });
  }
  // blockchair-style
  var r = await fetch(cfg.api.base + "/dashboards/address/" + address);
  if (!r.ok) throw new Error("utxo fetch failed: " + r.status);
  var data = await r.json();
  var utxo = (data.data && data.data[address] && data.data[address].utxo) || [];
  // block_id <= 0 means mempool/unconfirmed on blockchair — exclude so a sweep
  // right after settle can't try to spend the just-broadcast unconfirmed change.
  return utxo.filter(function (u) { return u.block_id && u.block_id > 0; })
             .map(function (u) { return { txid: u.transaction_hash, vout: u.index, amount: BigInt(u.value) }; });
}

async function utxoFetchPrevHex(cfg, txid) {
  if (cfg.api.style === "esplora") {
    var resp = await fetch(cfg.api.base + "/tx/" + txid + "/hex");
    if (!resp.ok) throw new Error("prevtx fetch failed: " + txid);
    return (await resp.text()).trim();
  }
  var r = await fetch(cfg.api.base + "/raw/transaction/" + txid);
  if (!r.ok) throw new Error("prevtx fetch failed: " + txid);
  var data = await r.json();
  return data.data[txid].raw_transaction;
}

async function utxoBroadcast(cfg, rawHex) {
  if (cfg.api.style === "esplora") {
    var resp = await fetch(cfg.api.base + "/tx", { method: "POST",
      headers: { "Content-Type": "text/plain" }, body: rawHex });
    if (!resp.ok) throw new Error("broadcast failed: " + (await resp.text()));
    return (await resp.text()).trim();
  }
  var r = await fetch(cfg.api.base + "/push/transaction", { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + rawHex });
  if (!r.ok) throw new Error("broadcast failed: " + (await r.text()));
  var data = await r.json();
  return (data.data && data.data.transaction_hash) || data;
}

async function utxoFeeRate(cfg) {
  if (cfg.feeRateField && cfg.api.style === "esplora") {
    try {
      var resp = await fetch(cfg.api.base + "/v1/fees/recommended");
      if (resp.ok) { var f = await resp.json(); return f[cfg.feeRateField] || cfg.defaultFeeRate; }
    } catch (e) {}
  }
  return cfg.defaultFeeRate;
}

function makeUtxoLeg(ctx, chainId_, role) {
  var cfg = CHAINS[chainId_];
  var isSegwit = cfg.addrType === "p2wpkh";
  var sizes = isSegwit ? SIZES_SEGWIT : SIZES_LEGACY;
  var pub = btc.utils.pubECDSA(ctx.keyBytes);
  var pay = isSegwit ? btc.p2wpkh(pub, cfg.network) : btc.p2pkh(pub, cfg.network);

  async function addInputs(tx, selected) {
    for (var i = 0; i < selected.length; i++) {
      var u = selected[i];
      if (isSegwit) {
        tx.addInput({ txid: hex.decode(u.txid), index: u.vout,
          witnessUtxo: { script: pay.script, amount: u.amount } });
      } else {
        var prevHex = await utxoFetchPrevHex(cfg, u.txid);
        tx.addInput({ txid: hex.decode(u.txid), index: u.vout,
          nonWitnessUtxo: hex.decode(prevHex) });
      }
    }
  }

  return {
    label: cfg.addrType === "p2pkh" && chainId_.indexOf("doge") === 0 ? "doge"
         : chainId_.indexOf("litecoin") === 0 ? "ltc" : "btc",
    role: role,
    chainName: chainId_,
    deriveAddress: async function () { return pay.address; },
    getBalance: async function (address) {
      var utxos = await utxoFetchUtxos(cfg, address);
      var t = 0n; for (var i = 0; i < utxos.length; i++) t += utxos[i].amount;
      return t;
    },
    settle: async function (o) {
      var utxos = await utxoFetchUtxos(cfg, o.deposit);
      var feeRate = await utxoFeeRate(cfg);
      var sel = selectCoins(utxos, o.amount, feeRate, sizes, cfg.minFee);
      var tx = new btc.Transaction({ network: cfg.network });
      await addInputs(tx, sel.selected);
      tx.addOutputAddress(o.to, o.amount, cfg.network);
      if (sel.change > BigInt(cfg.dust)) tx.addOutputAddress(o.deposit, sel.change, cfg.network);
      tx.sign(ctx.keyBytes);
      tx.finalize();
      return utxoBroadcast(cfg, tx.hex);
    },
    drain: async function (o) {
      var utxos = await utxoFetchUtxos(cfg, o.deposit);
      if (!utxos.length) return null;
      var feeRate = await utxoFeeRate(cfg);
      var d = drainCoins(utxos, feeRate, sizes, cfg.minFee);
      if (d.send <= BigInt(cfg.dust)) return null;
      var tx = new btc.Transaction({ network: cfg.network });
      await addInputs(tx, d.selected);
      tx.addOutputAddress(o.to, d.send, cfg.network);
      tx.sign(ctx.keyBytes);
      tx.finalize();
      return utxoBroadcast(cfg, tx.hex);
    },
  };
}
`;
}
