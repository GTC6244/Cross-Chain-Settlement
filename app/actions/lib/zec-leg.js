/**
 * Zcash transparent (t-address) leg — the ZIP-243 sighash shim.
 *
 * @scure/btc-signer and bitcoinjs-lib cannot sign Zcash: it needs ZIP-243
 * (BLAKE2b-256 personalized sighash + consensus branch id) over a Sapling v4
 * serialization. This builds that by hand with @noble/hashes (blake2b, sha256,
 * ripemd160) + @noble/curves (secp256k1) + @scure/base (base58check).
 *
 * Scope: transparent P2PKH only (no shielded). All UTXOs sit at the action's
 * own deposit address, so each input's scriptCode is our own P2PKH script —
 * no previous-tx fetch needed.
 *
 * !!! HIGHEST-RISK PATH IN THE REPO — UNVERIFIED !!!
 * Must be checked on Zcash testnet before trusting. In particular:
 *   - branchId/txVersion must match the active network upgrade (post-NU5
 *     testnet may require v5/ZIP-244 and reject this v4/ZIP-243 tx).
 *   - personalization tag bytes and field ordering follow ZIP-243; verify
 *     against a known-good signed transaction.
 *
 * Assumes selectCoins/drainCoins (UTXO_MATH_SRC) and SIZES_LEGACY are already
 * defined in the assembled action.
 */

export function zecLegSrc() {
  return `
// ---- little-endian + varint writers ----
function u32le(n) { var b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; }
function u64le(v) {
  var b = new Uint8Array(8); var dv = new DataView(b.buffer);
  dv.setUint32(0, Number(v & 0xffffffffn), true);
  dv.setUint32(4, Number((v >> 32n) & 0xffffffffn), true);
  return b;
}
function varint(n) {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) { var b = new Uint8Array(3); b[0] = 0xfd; new DataView(b.buffer).setUint16(1, n, true); return b; }
  var b2 = new Uint8Array(5); b2[0] = 0xfe; new DataView(b2.buffer).setUint32(1, n, true); return b2;
}
function cat() {
  var total = 0, i;
  for (i = 0; i < arguments.length; i++) total += arguments[i].length;
  var out = new Uint8Array(total), off = 0;
  for (i = 0; i < arguments.length; i++) { out.set(arguments[i], off); off += arguments[i].length; }
  return out;
}
function rev(bytes) { var o = new Uint8Array(bytes.length); for (var i = 0; i < bytes.length; i++) o[i] = bytes[bytes.length - 1 - i]; return o; }

// ---- hashing ----
function hash160(pub) { return ripemd160(sha256(pub)); }
function blake2bPersonal(data, tag16) { return blake2b(data, { dkLen: 32, personalization: tag16 }); }
function tagBytes(s) { var t = new TextEncoder().encode(s); var b = new Uint8Array(16); b.set(t.slice(0, 16)); return b; }
function sigHashPersonal(branchId) {
  var b = new Uint8Array(16); b.set(new TextEncoder().encode("ZcashSigHash"));
  b.set(u32le(branchId), 12); return b;
}

// ---- scripts / addresses ----
function p2pkhScript(h160) { return cat(new Uint8Array([0x76, 0xa9, 0x14]), h160, new Uint8Array([0x88, 0xac])); }
var ZEC_B58 = base58check(sha256);
function taddrToHash160(addr) {
  var payload = ZEC_B58.decode(addr); // 2-byte prefix + 20-byte hash160
  return payload.slice(payload.length - 20);
}

// ZIP-243 transparent sighash for input #index.
function zip243Sighash(cfg, inputs, outputs, index, scriptCode, amount) {
  var header = u32le((cfg.txVersion | 0x80000000) >>> 0); // overwinter flag + v4
  var prevoutsData = cat.apply(null, inputs.map(function (i) { return cat(rev(hex.decode(i.txid)), u32le(i.vout)); }));
  var hashPrevouts = blake2bPersonal(prevoutsData, tagBytes("ZcashPrevoutHash"));
  var seqData = cat.apply(null, inputs.map(function () { return u32le(0xffffffff); }));
  var hashSequence = blake2bPersonal(seqData, tagBytes("ZcashSequencHash"));
  var outsData = cat.apply(null, outputs.map(function (o) { return cat(u64le(o.value), varint(o.script.length), o.script); }));
  var hashOutputs = blake2bPersonal(outsData, tagBytes("ZcashOutputsHash"));
  var z32 = new Uint8Array(32);

  var input = inputs[index];
  var preimage = cat(
    header,
    u32le(cfg.versionGroupId),
    hashPrevouts, hashSequence, hashOutputs,
    z32,            // hashJoinSplits
    z32,            // hashShieldedSpends
    z32,            // hashShieldedOutputs
    u32le(0),       // nLockTime
    u32le(0),       // nExpiryHeight
    u64le(0n),      // valueBalance
    u32le(1),       // nHashType = SIGHASH_ALL
    // the input being signed:
    rev(hex.decode(input.txid)), u32le(input.vout),
    varint(scriptCode.length), scriptCode,
    u64le(amount),
    u32le(0xffffffff)
  );
  return blake2bPersonal(preimage, sigHashPersonal(cfg.branchId));
}

function serializeV4(cfg, inputs, outputs, scriptSigs) {
  var parts = [u32le((cfg.txVersion | 0x80000000) >>> 0), u32le(cfg.versionGroupId), varint(inputs.length)];
  for (var i = 0; i < inputs.length; i++) {
    parts.push(rev(hex.decode(inputs[i].txid)), u32le(inputs[i].vout),
      varint(scriptSigs[i].length), scriptSigs[i], u32le(0xffffffff));
  }
  parts.push(varint(outputs.length));
  for (var j = 0; j < outputs.length; j++) parts.push(u64le(outputs[j].value), varint(outputs[j].script.length), outputs[j].script);
  parts.push(u32le(0));        // nLockTime
  parts.push(u32le(0));        // nExpiryHeight
  parts.push(u64le(0n));       // valueBalance
  parts.push(varint(0));       // nShieldedSpend
  parts.push(varint(0));       // nShieldedOutput
  parts.push(varint(0));       // nJoinSplit
  return cat.apply(null, parts);
}

async function zecFetchUtxos(cfg, address) {
  var resp = await fetch(cfg.api.base + "/addr/" + address + "/utxo");
  if (resp.ok) {
    var arr = await resp.json();
    return arr.filter(function (u) { return u.confirmations > 0; })
              .map(function (u) { return { txid: u.txid, vout: u.vout, amount: BigInt(u.satoshis) }; });
  }
  var r = await fetch(cfg.api.fallback + "/dashboards/address/" + address);
  if (!r.ok) throw new Error("zec utxo fetch failed: " + resp.status);
  var data = await r.json();
  var utxo = (data.data && data.data[address] && data.data[address].utxo) || [];
  return utxo.map(function (u) { return { txid: u.transaction_hash, vout: u.index, amount: BigInt(u.value) }; });
}

async function zecBroadcast(cfg, rawHex) {
  var resp = await fetch(cfg.api.base + "/tx/send", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rawtx: rawHex }) });
  if (!resp.ok) throw new Error("zec broadcast failed: " + (await resp.text()));
  var data = await resp.json();
  return data.txid || data;
}

function makeZecLeg(ctx, chainId_, role) {
  var cfg = CHAINS[chainId_];
  var pub = secp256k1.getPublicKey(ctx.keyBytes, true); // compressed
  var myH160 = hash160(pub);
  var myScript = p2pkhScript(myH160);
  var address = ZEC_B58.encode(cat(new Uint8Array(cfg.pubKeyHash2), myH160));

  function buildSigned(selected, outs) {
    var inputs = selected.map(function (u) { return { txid: u.txid, vout: u.vout }; });
    var scriptSigs = [];
    for (var i = 0; i < inputs.length; i++) {
      var sh = zip243Sighash(cfg, inputs, outs, i, myScript, selected[i].amount);
      var sig = secp256k1.sign(sh, ctx.keyBytes).toDERRawBytes();
      var sigWithType = cat(sig, new Uint8Array([0x01])); // SIGHASH_ALL
      scriptSigs.push(cat(varint(sigWithType.length), sigWithType, varint(pub.length), pub));
    }
    return hex.encode(serializeV4(cfg, inputs, outs, scriptSigs));
  }

  return {
    label: "zec",
    role: role,
    chainName: chainId_,
    deriveAddress: async function () { return address; },
    getBalance: async function (addr) {
      var utxos = await zecFetchUtxos(cfg, addr);
      var t = 0n; for (var i = 0; i < utxos.length; i++) t += utxos[i].amount;
      return t;
    },
    settle: async function (o) {
      var utxos = await zecFetchUtxos(cfg, o.deposit);
      var sel = selectCoins(utxos, o.amount, cfg.defaultFeeRate, SIZES_LEGACY, cfg.minFee);
      var outs = [{ value: o.amount, script: p2pkhScript(taddrToHash160(o.to)) }];
      if (sel.change > BigInt(cfg.dust)) outs.push({ value: sel.change, script: myScript });
      return zecBroadcast(cfg, buildSigned(sel.selected, outs));
    },
    drain: async function (o) {
      var utxos = await zecFetchUtxos(cfg, o.deposit);
      if (!utxos.length) return null;
      var d = drainCoins(utxos, cfg.defaultFeeRate, SIZES_LEGACY, cfg.minFee);
      if (d.send <= BigInt(cfg.dust)) return null;
      var outs = [{ value: d.send, script: p2pkhScript(taddrToHash160(o.to)) }];
      return zecBroadcast(cfg, buildSigned(d.selected, outs));
    },
  };
}
`;
}
