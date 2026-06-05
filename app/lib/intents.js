/**
 * Settled — order book reader.
 *
 * No backend: the book is a client-side scan of IntentAnnounced (open intents)
 * and SwapCreated (competing quotes per intent) logs on Base. RPCs cap getLogs
 * block ranges, so the scan is chunked and ALWAYS reports whether it reached the
 * chain head. A partial scan is surfaced as `complete: false` — the UI must show
 * "some may be missing" and never present a truncated book as the whole book
 * (a solver acting on a stale book loses money).
 *
 * Pure helpers (chunkRanges, groupQuotesByIntent, sortQuotesByRate,
 * effectiveRate) are exported separately and unit-tested in Node.
 */

import { readContract, CONTRACT_DEPLOY_BLOCK } from './contract.js';

const DEFAULT_CHUNK = 9000; // under common 10k getLogs range caps

/** Split [from, to] into inclusive [start, end] windows of at most `size` blocks. */
export function chunkRanges(from, to, size = DEFAULT_CHUNK) {
  const ranges = [];
  if (to < from) return ranges;
  for (let start = from; start <= to; start += size) {
    ranges.push([start, Math.min(start + size - 1, to)]);
  }
  return ranges;
}

/**
 * Effective rate a quote offers the user = destAmount / sourceAmount, as a
 * Number for sorting/display only (never for value math). Higher = better for
 * the user.
 */
export function effectiveRate(quote) {
  const src = Number(quote.sourceAmount);
  if (!src) return 0;
  return Number(quote.destAmount) / src;
}

/** Group SwapCreated quote rows by their intentId. Returns Map<intentId, quote[]>. */
export function groupQuotesByIntent(quotes) {
  const byIntent = new Map();
  for (const q of quotes) {
    const list = byIntent.get(q.intentId) || [];
    list.push(q);
    byIntent.set(q.intentId, list);
  }
  return byIntent;
}

/** Sort quotes best-for-user first (highest effective rate). Does not mutate input. */
export function sortQuotesByRate(quotes) {
  return [...quotes].sort((a, b) => effectiveRate(b) - effectiveRate(a));
}

/**
 * Query an event in chunked block windows. Returns { events, complete, scannedTo }.
 * If any chunk throws (range too large / RPC hiccup), the scan stops and reports
 * complete:false with the last fully-scanned block, rather than silently dropping.
 */
export async function scanEvents(contract, filter, fromBlock, toBlock, chunkSize = DEFAULT_CHUNK) {
  const events = [];
  let scannedTo = fromBlock - 1;
  for (const [start, end] of chunkRanges(fromBlock, toBlock, chunkSize)) {
    try {
      const batch = await contract.queryFilter(filter, start, end);
      events.push(...batch);
      scannedTo = end;
    } catch (e) {
      return { events, complete: false, scannedTo, error: String(e.message || e) };
    }
  }
  return { events, complete: true, scannedTo };
}

function intentFromLog(log) {
  const a = log.args;
  return {
    intentId: a.intentId,
    creator: a.creator,
    sourceChain: a.sourceChain,
    destChain: a.destChain,
    sourceAmount: a.sourceAmount,
    minDestAmount: a.minDestAmount,
    expiration: Number(a.expiration),
    feeBps: Number(a.feeBps),
    tokenSource: a.tokenSource,
    tokenDest: a.tokenDest,
    userRefundSource: a.userRefundSource,
    userReceiveDest: a.userReceiveDest,
    blockNumber: log.blockNumber,
  };
}

function quoteFromLog(log) {
  const a = log.args;
  return {
    swapId: String(a.swapId),
    intentId: a.intentId,
    sourceChain: a.sourceChain,
    destChain: a.destChain,
    sourceAmount: a.sourceAmount,
    destAmount: a.destAmount,
    minDestAmount: a.minDestAmount,
    litActionCid: a.litActionCid,
    salt: a.salt,
    solver: a.creator,
    blockNumber: log.blockNumber,
  };
}

/**
 * Read the open order book: every announced intent that does not yet have a
 * settled (Executed) swap. Returns { intents, complete }. `complete:false` means
 * the scan was truncated — surface it, don't hide it.
 */
export async function readOpenIntents(fromBlock = CONTRACT_DEPLOY_BLOCK, toBlock = 'latest') {
  const c = readContract();
  const provider = c.runner.provider ?? c.runner; // a provider-runner has no `.provider`; a signer-runner does
  const head = toBlock === 'latest' ? await provider.getBlockNumber() : toBlock;
  const res = await scanEvents(c, c.filters.IntentAnnounced(), fromBlock, head);
  const now = Math.floor(Date.now() / 1000);
  const intents = res.events.map(intentFromLog).filter((i) => i.expiration > now);
  return { intents, complete: res.complete, scannedTo: res.scannedTo, error: res.error };
}

/** Read all competing quotes (SwapCreated) for a given intentId, best rate first. */
export async function readQuotesForIntent(intentId, fromBlock = CONTRACT_DEPLOY_BLOCK, toBlock = 'latest') {
  const c = readContract();
  const provider = c.runner.provider ?? c.runner; // a provider-runner has no `.provider`; a signer-runner does
  const head = toBlock === 'latest' ? await provider.getBlockNumber() : toBlock;
  const res = await scanEvents(c, c.filters.SwapCreated(null, intentId), fromBlock, head);
  return { quotes: sortQuotesByRate(res.events.map(quoteFromLog)), complete: res.complete, error: res.error };
}
