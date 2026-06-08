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
 * VERIFICATION STATUS (2026-06-04, zcashd 6.20.0 regtest):
 *   - The ZIP-243 v4 sighash + serialization is CORRECT: shim-signed txs are
 *     accepted + mined by zcashd consensus on both a Canopy chain (branch
 *     e9ff75a6) and a NU6 chain (branch c8e71055). v4 is NOT obsolete post-NU5.
 *   - branchId MUST equal the deployment's active network upgrade. A mismatch
 *     fails zcashd's mandatory-script-verify (the branch id feeds the sighash).
 *     See networks.js for the branch-id table; a live-fetch is the robust fix.
 *   - Fees use ZIP-317 (selectCoinsZip317/drainCoinsZip317), not sat/byte —
 *     zcashd's mempool rejects sub-conventional fees ("unpaid action limit").
 *   See .context/zec-verify/FINDINGS.md for the full reproduction.
 *
 * Assumes selectCoinsZip317/drainCoinsZip317 (UTXO_MATH_SRC) are already
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

// ZIP-243 transparent sighash for input #index. branchId is passed in (resolved
// live from the node when available) rather than read from cfg, so it always
// matches the chain's active consensus branch.
function zip243Sighash(cfg, branchId, inputs, outputs, index, scriptCode, amount) {
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
  return blake2bPersonal(preimage, sigHashPersonal(branchId));
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

// JSON-RPC call to a zcashd-compatible node. Used by style "zcashd" (a
// self-hosted node, cfg.api.rpc + optional Basic cfg.api.rpcAuth) AND by style
// "tatum" (the Tatum RPC gateway, zcash-{net}.gateway.tatum.io, authed with an
// x-api-key header via cfg.api.apiKey). Both speak the same getblockchaininfo /
// getrawtransaction / sendrawtransaction surface; only UTXO listing differs
// (Tatum has no address index on the node — see zecFetchUtxos).
async function zecRpc(cfg, method, params) {
  var headers = { "Content-Type": "application/json" };
  if (cfg.api.rpcAuth) headers["Authorization"] = cfg.api.rpcAuth;
  if (cfg.api.apiKey) headers[cfg.api.apiKeyHeader || "x-api-key"] = cfg.api.apiKey;
  var resp = await fetch(cfg.api.rpc, { method: "POST", headers: headers,
    body: JSON.stringify({ jsonrpc: "1.0", id: "zec", method: method, params: params || [] }) });
  // zcashd returns a JSON body (with .error) even on HTTP 500 for RPC errors, so
  // parse first; a non-JSON body (proxy 502 HTML, auth text) is the failure to surface.
  var text = await resp.text();
  var data;
  try { data = JSON.parse(text); }
  catch (e) { throw new Error("zec rpc " + method + " non-JSON (http " + resp.status + "): " + text.slice(0, 200)); }
  if (data.error) throw new Error("zec rpc " + method + ": " + JSON.stringify(data.error));
  return data.result;
}

// Active consensus branch id for the sighash. From a zcashd node it's read live
// (consensus.nextblock) so it always matches the active upgrade; otherwise the
// configured cfg.branchId is used (must be kept current — see networks.js).
async function zecBranchId(cfg) {
  if (cfg.api.style === "zcashd" || cfg.api.style === "tatum") {
    var info = await zecRpc(cfg, "getblockchaininfo", []);
    var nb = info && info.consensus && info.consensus.nextblock;
    var id = parseInt(nb, 16);
    // Never fall through to a NaN->0 branch id (would silently sign a tx the
    // network rejects with no clear cause); fail loudly instead.
    if (!Number.isFinite(id)) throw new Error("zec: bad branch id from node: " + nb);
    return id >>> 0;
  }
  return cfg.branchId;
}

// Blockbook (Trezor) REST is what the live hosted providers expose for Zcash
// (NOWNodes, GetBlock). It gives the full transparent-address shape the leg
// needs — UTXO list, tx confirmations, and raw broadcast — over plain HTTPS.
// Auth (when required, e.g. NOWNodes' "api-key" header) is passed via
// cfg.api.apiKeyHeader + cfg.api.apiKey; GetBlock instead bakes the token into
// cfg.api.base (go.getblock.io/<token>) and needs no header. The whole api
// object is injected at runtime (params.legApiConfig) so no key is embedded in
// the published action — see makeZecLeg.
function bbHeaders(cfg) {
  var h = {};
  if (cfg.api.apiKey && cfg.api.apiKeyHeader) h[cfg.api.apiKeyHeader] = cfg.api.apiKey;
  return h;
}

async function zecFetchUtxos(cfg, address) {
  if (cfg.api.style === "zcashd") {
    var u = await zecRpc(cfg, "getaddressutxos", [{ addresses: [address] }]);
    return u.filter(function (x) { return x.height > 0; })
            .map(function (x) { return { txid: x.txid, vout: x.outputIndex, amount: BigInt(x.satoshis) }; });
  }
  if (cfg.api.style === "tatum") {
    // The Tatum gateway is a zcashd-compatible RPC node WITHOUT an address index
    // (getaddressutxos → "method not found"), and Tatum's v4 Data API does not
    // serve Zcash at all (verified 2026-06-07: supported chains are only
    // btc/ltc/doge/cardano). So the gateway can't enumerate a t-address's UTXOs.
    // Use it for broadcast/confirmations/branch-id (those work + live-resolve the
    // branch id), and delegate UTXO listing to a separate indexed source via
    // api.utxoApi (a blockbook/insight provider). Fail loudly if none is set
    // rather than silently returning no UTXOs (which would look like "unfunded").
    if (cfg.api.utxoApi) {
      return zecFetchUtxos(Object.assign({}, cfg, { api: cfg.api.utxoApi }), address);
    }
    throw new Error("zec tatum: no UTXO source — the gateway has no address index and Tatum's Data API has no Zcash. Set api.utxoApi to a blockbook/insight provider.");
  }
  if (cfg.api.style === "blockbook") {
    // Blockbook returns confirmed UTXOs with ?confirmed=true; value is a decimal
    // string in zatoshis. Guard on confirmations>0 too (unconfirmed change must
    // not be spent before the network sees it).
    var bbResp = await fetch(cfg.api.base + "/api/v2/utxo/" + address + "?confirmed=true", { headers: bbHeaders(cfg) });
    if (!bbResp.ok) throw new Error("zec blockbook utxo failed (http " + bbResp.status + "): " + (await bbResp.text()).slice(0, 200));
    var bbArr = await bbResp.json();
    return bbArr.filter(function (u) { return (u.confirmations || 0) > 0; })
                .map(function (u) { return { txid: u.txid, vout: u.vout, amount: BigInt(u.value) }; });
  }
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

// Confirmations for a broadcast txid (see utxoConfirmations — same fail-closed
// contract: 0 means keep waiting). zcashd reports confirmations directly.
async function zecConfirmations(cfg, txid) {
  if (cfg.api.style === "zcashd" || cfg.api.style === "tatum") {
    var t = await zecRpc(cfg, "getrawtransaction", [txid, 1]);
    return (t && t.confirmations > 0) ? t.confirmations : 0;
  }
  if (cfg.api.style === "blockbook") {
    var bbResp = await fetch(cfg.api.base + "/api/v2/tx/" + txid, { headers: bbHeaders(cfg) });
    if (!bbResp.ok) return 0;
    var bbData = await bbResp.json();
    return (bbData && bbData.confirmations > 0) ? bbData.confirmations : 0;
  }
  var resp = await fetch(cfg.api.base + "/tx/" + txid);
  if (!resp.ok) return 0;
  var data = await resp.json();
  return (data && data.confirmations > 0) ? data.confirmations : 0;
}

async function zecBroadcast(cfg, rawHex) {
  if (cfg.api.style === "zcashd" || cfg.api.style === "tatum") {
    return zecRpc(cfg, "sendrawtransaction", [rawHex]);
  }
  if (cfg.api.style === "blockbook") {
    // POST (not the GET /sendtx/<hex> form) so a multi-input tx can't blow the
    // URL length limit. Body is the raw hex as text/plain. Blockbook replies
    // { result: txid } on success or { error: {...} } on a consensus reject.
    var bbHead = bbHeaders(cfg); bbHead["Content-Type"] = "text/plain";
    var bbResp = await fetch(cfg.api.base + "/api/v2/sendtx/", { method: "POST", headers: bbHead, body: rawHex });
    var bbData = null;
    try { bbData = await bbResp.json(); } catch (e) { bbData = null; }
    if (!bbResp.ok || !bbData || bbData.error) {
      throw new Error("zec blockbook broadcast failed: " + (bbData && bbData.error ? JSON.stringify(bbData.error) : "http " + bbResp.status));
    }
    return bbData.result || bbData;
  }
  var resp = await fetch(cfg.api.base + "/tx/send", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rawtx: rawHex }) });
  if (!resp.ok) throw new Error("zec broadcast failed: " + (await resp.text()));
  var data = await resp.json();
  return data.txid || data;
}

function makeZecLeg(ctx, chainId_, role) {
  var cfg = CHAINS[chainId_];
  // Prefer a runtime-injected provider (params.legApiConfig[chain]) over the
  // embedded default — the EVM leg does the same with legRpcUrls. The embedded
  // CHAINS.api is a key-free placeholder (the public testnet explorer is dead),
  // so a live run MUST pass legApiConfig, e.g.
  //   legApiConfig: { 'zcash-testnet': { style: 'blockbook',
  //     base: 'https://zec-testnet.blockbook.example', apiKeyHeader: 'api-key',
  //     apiKey: '<key>' } }
  // Keeping the key in a runtime param (never in CHAINS) is what keeps the
  // published action CID free of any secret.
  var apiOverride = (ctx.params && ctx.params.legApiConfig || {})[chainId_];
  if (apiOverride) cfg = Object.assign({}, cfg, { api: apiOverride });
  var pub = secp256k1.getPublicKey(ctx.keyBytes, true); // compressed
  var myH160 = hash160(pub);
  var myScript = p2pkhScript(myH160);
  var address = ZEC_B58.encode(cat(new Uint8Array(cfg.pubKeyHash2), myH160));

  function buildSigned(selected, outs, branchId) {
    var inputs = selected.map(function (u) { return { txid: u.txid, vout: u.vout }; });
    var scriptSigs = [];
    for (var i = 0; i < inputs.length; i++) {
      var sh = zip243Sighash(cfg, branchId, inputs, outs, i, myScript, selected[i].amount);
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
    // See the UTXO leg's confirmations(): gate finalize on settlement depth.
    confirmations: function (txid) { return zecConfirmations(cfg, txid); },
    settle: async function (o) {
      var branchId = await zecBranchId(cfg);
      var utxos = await zecFetchUtxos(cfg, o.deposit);
      var sel = selectCoinsZip317(utxos, o.amount);
      var outs = [{ value: o.amount, script: p2pkhScript(taddrToHash160(o.to)) }];
      if (sel.change > BigInt(cfg.dust)) outs.push({ value: sel.change, script: myScript });
      return zecBroadcast(cfg, buildSigned(sel.selected, outs, branchId));
    },
    drain: async function (o) {
      var branchId = await zecBranchId(cfg);
      var utxos = await zecFetchUtxos(cfg, o.deposit);
      if (!utxos.length) return null;
      var d = drainCoinsZip317(utxos);
      if (d.send <= BigInt(cfg.dust)) return null;
      var outs = [{ value: d.send, script: p2pkhScript(taddrToHash160(o.to)) }];
      return zecBroadcast(cfg, buildSigned(d.selected, outs, branchId));
    },
  };
}
`;
}
