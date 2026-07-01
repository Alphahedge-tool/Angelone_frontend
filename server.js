import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 3001);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = path.join(ROOT, 'dist');
const SMARTAPI_BASE = 'https://apiconnect.angelone.in';
const SMART_STREAM_URL = 'wss://smartapisocket.angelone.in/smart-stream';
const MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const MASTER_FILE = path.join(ROOT, 'scrip_master.json');
const INDEX_FILE = path.join(ROOT, 'scrip_index.json');

// SmartWebSocket exchangeType codes.
const WS_EXCHANGE_TYPE = { NSE: 1, NFO: 2, BSE: 3, BFO: 4, MCX: 5, CDS: 7, NCDEX: 7 };

// Set FEED_DEBUG=1 to log raw ticks while diagnosing the live feed.
const FEED_DEBUG = process.env.FEED_DEBUG === '1';

// In-memory master cache: parse the 8.8 MB scrip master once, reuse for every
// option-chain request, and re-download from Angel at most once per day.
const MASTER_TTL_MS = 24 * 60 * 60 * 1000;
const masterCache = { data: null, index: null, loadedAt: 0 };
let masterLoading = null; // de-dupes concurrent loads

// MCX commodity underlyings that trade options (exch_seg === 'MCX').
const MCX_SYMBOLS = new Set([
  'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'CRUDEOIL', 'CRUDEOILM',
  'NATURALGAS', 'NATGASMINI', 'COPPER', 'ZINC', 'MCXBULLDEX',
]);

// ─── Live market feed (Angel SmartWebSocket 2.0 → browser SSE) ───
// One upstream WebSocket to Angel; browser clients attach via SSE and get
// {token, ltp, oi} ticks. The subscription is ADDITIVE: we keep a union of all
// tokens anyone cares about (the on-screen option chain AND every basket leg,
// which may live on other expiries/symbols) so each leg ticks live like a real
// broker basket. New tokens are sent as incremental subscribe frames on the
// existing socket; the socket is only torn down on a full reset (new chain load)
// or when the last SSE listener leaves.
const sseClients = new Set();
let feedSocket = null;
let feedHeartbeat = null;
let feedCredentials = null;           // creds for the active upstream connection
const feedTokens = new Map();         // exchangeType -> Set(token) — the live union
// The on-screen chain's own tokens ("exchangeType|token"), tracked separately so
// a new chain load can drop the PREVIOUS chain's strikes from the union without
// disturbing basket-leg tokens (which may sit on other expiries/symbols).
let chainTokenKeys = new Set();

function broadcastTick(tick) {
  const line = `data: ${JSON.stringify(tick)}\n\n`;
  for (const res of sseClients) {
    res.write(line);
  }
}

function broadcastStatus(status) {
  const line = `event: status\ndata: ${JSON.stringify(status)}\n\n`;
  for (const res of sseClients) {
    res.write(line);
  }
}

// Serialize the current union map into Angel's tokenList shape, dropping any
// empty exchange groups.
function currentTokenList() {
  return [...feedTokens.entries()]
    .filter(([, set]) => set.size > 0)
    .map(([exchangeType, set]) => ({ exchangeType, tokens: [...set] }));
}

// Send a subscribe frame for a specific tokenList on the open socket. mode 3 =
// SNAP_QUOTE (LTP + OI + close). Angel ignores tokens already subscribed, so
// re-sending the union on reconnect is safe.
function sendSubscribe(socket, tokenList, tag = 'optionchain') {
  if (!tokenList.length) return;
  socket.send(JSON.stringify({
    correlationID: tag,
    action: 1, // subscribe
    params: { mode: 3, tokenList },
  }));
}

// Open the upstream Angel feed (if not already open) and subscribe the whole
// current union. Re-uses the socket when it's already live for the same creds.
function startFeed(credentials) {
  feedCredentials = credentials;

  // Socket already open → just (re)subscribe the union; no teardown needed.
  if (feedSocket && feedSocket.readyState === WebSocket.OPEN) {
    sendSubscribe(feedSocket, currentTokenList());
    return;
  }
  closeFeed();

  const socket = new WebSocket(SMART_STREAM_URL, {
    headers: {
      // Angel's SDK passes the raw JWT here (no "Bearer " prefix).
      Authorization: credentials.jwtToken,
      'x-api-key': credentials.apiKey,
      'x-client-code': credentials.clientCode,
      'x-feed-token': credentials.feedToken,
    },
  });
  feedSocket = socket;

  socket.on('upgrade', (res) => {
    if (FEED_DEBUG) console.log('[feed] handshake status', res.statusCode, res.statusMessage);
  });

  socket.on('open', () => {
    const tokenList = currentTokenList();
    if (FEED_DEBUG) console.log('[feed] WS OPEN → sending subscribe', JSON.stringify(tokenList));
    broadcastStatus({ connected: true, message: 'Live feed connected' });
    sendSubscribe(socket, tokenList);
    clearInterval(feedHeartbeat);
    feedHeartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send('ping');
    }, 10_000); // Angel requires a ping every ~10s
  });

  socket.on('message', (data, isBinary) => {
    if (FEED_DEBUG) {
      if (isBinary) {
        const head = Buffer.from(data).subarray(0, 60).toString('hex');
        console.log(`[feed] binary len=${data.length} mode=${data[0]} exch=${data[1]} head=${head}`);
      } else {
        console.log('[feed] text:', data.toString().slice(0, 200));
      }
    }
    if (!isBinary) return; // pong/text/error frames
    const tick = parseTick(data);
    if (tick) {
      if (FEED_DEBUG) console.log(`[feed] tick token=${tick.token} ltp=${tick.ltp} oi=${tick.oi}`);
      broadcastTick(tick);
    }
  });

  socket.on('close', (code, reason) => {
    if (FEED_DEBUG) console.log('[feed] WS CLOSE code=' + code, 'reason=' + (reason?.toString() || ''));
    clearInterval(feedHeartbeat);
    broadcastStatus({ connected: false, message: `Live feed closed (${code})` });
  });

  socket.on('error', (error) => {
    if (FEED_DEBUG) console.log('[feed] WS ERROR', error.message);
    broadcastStatus({ connected: false, message: `Feed error: ${error.message}` });
  });
}

// Drop the upstream socket. Does NOT clear the token union — a reconnect
// re-subscribes it. Pass reset=true (last listener gone) to also forget tokens
// and credentials so a stale union can't be re-subscribed on the next chain load.
function closeFeed(reset = false) {
  clearInterval(feedHeartbeat);
  if (feedSocket) {
    try { feedSocket.removeAllListeners(); feedSocket.terminate(); } catch {}
    feedSocket = null;
  }
  if (reset) {
    feedTokens.clear();
    chainTokenKeys = new Set();
    feedCredentials = null;
  }
}

// Merge tokens into the live union. Returns only the tokens that are NEW (not
// already subscribed) grouped by exchangeType, so callers can send a minimal
// incremental subscribe frame.
function mergeFeedTokens(entries) {
  const added = new Map(); // exchangeType -> [token]
  for (const { exchangeType, token } of entries) {
    if (!token) continue;
    const key = String(token);
    if (!feedTokens.has(exchangeType)) feedTokens.set(exchangeType, new Set());
    const set = feedTokens.get(exchangeType);
    if (set.has(key)) continue;
    set.add(key);
    if (!added.has(exchangeType)) added.set(exchangeType, []);
    added.get(exchangeType).push(key);
  }
  return [...added.entries()].map(([exchangeType, tokens]) => ({ exchangeType, tokens }));
}

// Parse one SmartWebSocket V2 binary packet → { token, ltp, oi, close }.
// Official layout (little-endian): [0]=mode, [1]=exchangeType, [2:27]=token
// (null-terminated ascii), [43:51]=LTP int64 (paise → ÷100). SNAP_QUOTE
// (mode 3) adds closed_price at [115:123] and open_interest at [131:139].
function parseTick(buffer) {
  if (buffer.length < 51) return null;
  const token = buffer.toString('ascii', 2, 27).replace(/\0.*$/, '').trim();
  if (!token) return null;
  const ltp = Number(buffer.readBigInt64LE(43)) / 100;
  let oi = null;
  let close = null;
  if (buffer.length >= 123) close = Number(buffer.readBigInt64LE(115)) / 100;
  if (buffer.length >= 139) oi = Number(buffer.readBigInt64LE(131));
  return { token, ltp, oi, close };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      sendCors(res, 204);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/angel/auto-login') {
      const body = await readJson(req);
      const result = await autoLogin(body.client || {});
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/angel/logout') {
      sendJson(res, 200, { status: true, message: 'Logged out' });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/angel/master-index') {
      const index = await getMasterIndex();
      sendJson(res, 200, index);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/angel/refresh-master') {
      const result = await refreshMaster();
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/angel/option-chain') {
      const body = await readJson(req);
      const result = await getOptionChain(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/angel/margin') {
      const body = await readJson(req);
      const result = await getMargin(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/angel/charges') {
      const body = await readJson(req);
      const result = await getCharges(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/angel/resolve-leg') {
      const body = await readJson(req);
      const result = await resolveLeg(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'GET' && req.url === '/api/angel/stream') {
      handleStream(req, res);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/angel/subscribe') {
      const body = await readJson(req);
      const result = subscribeFeed(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/angel/subscribe-more') {
      const body = await readJson(req);
      const result = addFeedTokens(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'GET') {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 404, { status: false, message: 'Not found' });
  } catch (error) {
    sendJson(res, 500, { status: false, message: error.message || 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Angel One panel running at http://localhost:${PORT}`);
  // Warm the master cache on boot so the first option-chain load is instant.
  ensureMaster().catch((error) => console.error('Master warm-up failed:', error.message));
});

// SSE: keep the connection open and register it for tick broadcasts.
function handleStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('retry: 3000\n\n');
  res.write(`event: status\ndata: ${JSON.stringify({ connected: !!feedSocket, message: 'Stream open' })}\n\n`);
  sseClients.add(res);

  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
    if (!sseClients.size) closeFeed(true); // no listeners → drop feed + forget tokens
  });
}

// Turn a flat token list (+ optional spot) into {exchangeType, token} entries,
// grouping by SmartWebSocket exchangeType. The spot/underlying may sit on a
// different exchange (e.g. NSE index vs NFO options).
function toFeedEntries({ exchange = 'NFO', tokens = [], spot = null }) {
  const entries = [];
  const type = (exch) => WS_EXCHANGE_TYPE[exch] || WS_EXCHANGE_TYPE.NFO;
  for (const token of tokens) if (token) entries.push({ exchangeType: type(exchange), token });
  if (spot?.token) entries.push({ exchangeType: type(spot.exchange || exchange), token: spot.token });
  return entries;
}

// Point the feed at a freshly loaded option chain. Drops the PREVIOUS chain's
// strikes from the union (so old, off-screen strikes stop ticking) but PRESERVES
// basket-leg tokens — the basket may hold contracts on other expiries/symbols
// that this chain doesn't include, and they must keep ticking. The socket stays
// alive if it's already open. Basket legs are (re)added by the client via
// addFeedTokens right after; the two are order-independent because we never wipe
// non-chain tokens here.
// Body: { credentials, exchange, tokens:[], spot:{token,exchange} }
function subscribeFeed({ credentials = {}, exchange = 'NFO', tokens = [], spot = null } = {}) {
  if (!credentials.jwtToken || !credentials.feedToken) {
    throw new Error('Live feed needs an active session (jwtToken + feedToken)');
  }
  if (!tokens.length) throw new Error('No tokens to subscribe');

  const entries = toFeedEntries({ exchange, tokens, spot });
  const newChainKeys = new Set(entries.map((e) => `${e.exchangeType}|${e.token}`));
  // Remove the old chain's tokens that neither belong to the new chain nor were
  // added by anything else (basket legs live outside chainTokenKeys, so they're
  // never in this set and thus never removed).
  for (const key of chainTokenKeys) {
    if (newChainKeys.has(key)) continue;
    const [type, token] = key.split('|');
    feedTokens.get(Number(type))?.delete(token);
  }
  chainTokenKeys = newChainKeys;
  const added = mergeFeedTokens(entries);

  if (FEED_DEBUG) {
    const mask = (v) => (v ? `${String(v).slice(0, 6)}…(${String(v).length})` : 'MISSING');
    console.log(`[feed] subscribe(reset) exchange=${exchange} groups=${added.length} tokens=${tokens.length}+spot`, tokens.slice(0, 3));
    console.log('[feed] spot token=' + (spot?.token || 'none') + ' exch=' + (spot?.exchange || '-'));
    console.log('[feed] creds: jwt=' + mask(credentials.jwtToken),
      'feedToken=' + mask(credentials.feedToken),
      'apiKey=' + mask(credentials.apiKey),
      'client=' + (credentials.clientCode || 'MISSING'));
  }
  startFeed(credentials); // opens (or re-subscribes the union on) the socket
  return { status: true, subscribed: tokens.length, exchange };
}

// Additively subscribe more tokens (the basket's legs) WITHOUT disturbing the
// on-screen chain feed. Legs may sit on other expiries/symbols, so each carries
// its own exchange. Only genuinely new tokens hit the wire (incremental frame).
// Body: { credentials?, items:[{ exchange, token }] }
function addFeedTokens({ credentials = null, items = [] } = {}) {
  const creds = credentials?.jwtToken ? credentials : feedCredentials;
  if (!creds?.jwtToken || !creds?.feedToken) {
    throw new Error('Live feed needs an active session (jwtToken + feedToken)');
  }
  const entries = (items || [])
    .filter((it) => it && it.token)
    .map((it) => ({
      exchangeType: WS_EXCHANGE_TYPE[it.exchange] || WS_EXCHANGE_TYPE.NFO,
      token: it.token,
    }));
  const added = mergeFeedTokens(entries);

  if (!added.length) {
    // Nothing new — but make sure the socket is alive so existing legs still tick.
    if (!feedSocket) startFeed(creds);
    return { status: true, added: 0 };
  }

  if (feedSocket && feedSocket.readyState === WebSocket.OPEN) {
    // Socket already up → send just the new tokens.
    if (FEED_DEBUG) console.log('[feed] add tokens (incremental)', JSON.stringify(added));
    sendSubscribe(feedSocket, added, 'basket');
  } else {
    // No socket yet (basket populated before any chain) → open it on the union.
    if (FEED_DEBUG) console.log('[feed] add tokens (open socket)', JSON.stringify(added));
    startFeed(creds);
  }
  const total = added.reduce((n, g) => n + g.tokens.length, 0);
  return { status: true, added: total };
}

// Returns the client's existing session as-is when it carries a JWT, so the
// option chain can skip the getRMS round-trip. Null when no usable session.
function resolveSession(client) {
  const session = client.session;
  if (session?.jwtToken) {
    return { ...session, apiKey: client.apiKey, feedToken: session.feedToken || null };
  }
  return null;
}

async function autoLogin(client) {
  validateClient(client);

  const headers = smartHeaders(client.apiKey);
  const existingSession = client.session || null;
  if (existingSession?.jwtToken) {
    const sessionResult = await trySessionRms(client, headers, existingSession);
    if (sessionResult) return sessionResult;
  }

  const login = await loginWithTotp(client, headers);
  return rmsResultFromLogin(client, headers, login, 'totp-login');
}

async function getOptionChain({ client = {}, symbol = 'NIFTY', expiry = '', window = 12 } = {}) {
  if (!expiry) throw new Error('Expiry is required');

  // Reuse the client's existing JWT directly — no getRMS re-validation on every
  // load. If the quote calls later 401, we re-login once and retry.
  let session = resolveSession(client);
  let jwtToken = session?.jwtToken;
  if (!jwtToken) {
    const login = await autoLogin(client);
    session = login.session;
    jwtToken = session?.jwtToken;
  }
  if (!jwtToken) throw new Error('Angel session unavailable');
  const login = { session };

  const master = await getMasterData();
  const upperSymbol = String(symbol).toUpperCase();
  const upperExpiry = String(expiry).toUpperCase();
  const spotTokens = {
    NIFTY: ['NSE', '99926000'],
    BANKNIFTY: ['NSE', '99926009'],
    FINNIFTY: ['NSE', '99926037'],
    MIDCPNIFTY: ['NSE', '99926074'],
    SENSEX: ['BSE', '99919000'],
  };

  const ceTokens = new Map();
  const peTokens = new Map();
  const ceSymbols = new Map(); // strike -> tradingsymbol (for charges)
  const peSymbols = new Map();
  let lotSize = 1; // units per lot — needed for realistic margin/charges
  // Pick the F&O segment the symbol's contracts live in.
  const exchange = upperSymbol === 'SENSEX'
    ? 'BFO'
    : MCX_SYMBOLS.has(upperSymbol)
      ? 'MCX'
      : 'NFO';

  // For MCX there's no index spot token, so we read the underlying price from
  // the nearest FUTURE contract. Collect candidate futures while scanning.
  const futCandidates = []; // { token, expiryMs }
  for (const row of master) {
    if (row.n !== upperSymbol || row.g !== exchange) continue;
    const symbol = String(row.s);
    if (exchange === 'MCX' && /FUT$/.test(symbol)) {
      futCandidates.push({ token: String(row.t), expiryMs: Date.parse(row.e) || Infinity });
    }
    if (row.e !== upperExpiry) continue;
    const strike = normalizeStrike(Number(row.k || 0), exchange);
    if (Number(row.l) > 0) lotSize = Number(row.l); // same lot size for all strikes of an expiry
    if (symbol.endsWith('CE')) { ceTokens.set(strike, String(row.t)); ceSymbols.set(strike, symbol); }
    if (symbol.endsWith('PE')) { peTokens.set(strike, String(row.t)); peSymbols.set(strike, symbol); }
  }

  // Nearest future on/after the option expiry, else the earliest available.
  const optionExpiryMs = Date.parse(upperExpiry) || 0;
  futCandidates.sort((a, b) => a.expiryMs - b.expiryMs);
  const futToken = (
    futCandidates.find((f) => f.expiryMs >= optionExpiryMs) || futCandidates[0]
  )?.token || null;

  if (!ceTokens.size && !peTokens.size) {
    throw new Error(`No option tokens found for ${upperSymbol} ${upperExpiry}`);
  }

  const strikes = [...new Set([...ceTokens.keys(), ...peTokens.keys()])].sort((a, b) => a - b);
  const headers = smartHeaders(client.apiKey);

  // Real spot: index LTP token for NSE/BSE; the future's LTP for MCX. Only
  // fall back to the median strike if neither is available.
  let spot = strikes.length ? strikes[Math.floor(strikes.length / 2)] : 0;
  const spotPair = spotTokens[upperSymbol] || (futToken ? [exchange, futToken] : null);
  let spotExchange = null;
  let spotToken = null;
  if (spotPair) {
    [spotExchange, spotToken] = spotPair;
    const spotRes = await smartFetch('/rest/secure/angelbroking/market/v1/quote', {
      method: 'POST',
      headers: authHeaders(headers, jwtToken),
      body: { mode: 'LTP', exchangeTokens: { [spotExchange]: [spotToken] } },
    });
    spot = Number(spotRes.data?.fetched?.[0]?.ltp || 0) || spot;
  }

  let atm = strikes[0];
  for (const strike of strikes) {
    if (Math.abs(strike - spot) < Math.abs(atm - spot)) atm = strike;
  }

  const atmIndex = Math.max(0, strikes.indexOf(atm));
  const sideWindow = Math.max(1, Math.min(Number(window) || 12, 30));
  const finalStrikes = strikes.slice(Math.max(0, atmIndex - sideWindow), atmIndex + sideWindow + 1);
  const tokensForLive = [];
  // Per-strike token arrays (aligned with finalStrikes) so the live feed can
  // map an incoming tick's token back to its row + call/put side. Symbol arrays
  // ride along so a basket leg can carry its tradingsymbol for charge estimates.
  const callTokens = [];
  const putTokens = [];
  const callSymbols = [];
  const putSymbols = [];
  for (const strike of finalStrikes) {
    const ce = ceTokens.get(strike) || null;
    const pe = peTokens.get(strike) || null;
    callTokens.push(ce);
    putTokens.push(pe);
    callSymbols.push(ceSymbols.get(strike) || null);
    putSymbols.push(peSymbols.get(strike) || null);
    if (ce) tokensForLive.push(ce);
    if (pe) tokensForLive.push(pe);
  }

  // The live FULL quote is mandatory — it's also where a dead cached JWT shows
  // up. On failure, re-login once and retry with a fresh token.
  let liveRes;
  try {
    liveRes = await smartFetch('/rest/secure/angelbroking/market/v1/quote', {
      method: 'POST',
      headers: authHeaders(headers, jwtToken),
      body: { mode: 'FULL', exchangeTokens: { [exchange]: tokensForLive } },
    });
  } catch (error) {
    const relogin = await autoLogin({ ...client, session: null });
    jwtToken = relogin.session?.jwtToken;
    if (!jwtToken) throw error;
    login.session = relogin.session;
    liveRes = await smartFetch('/rest/secure/angelbroking/market/v1/quote', {
      method: 'POST',
      headers: authHeaders(headers, jwtToken),
      body: { mode: 'FULL', exchangeTokens: { [exchange]: tokensForLive } },
    });
  }

  const greekRes = await smartFetch('/rest/secure/angelbroking/marketData/v1/optionGreek', {
    method: 'POST',
    headers: authHeaders(headers, jwtToken),
    body: { name: upperSymbol, expirydate: upperExpiry },
  }).catch(() => ({ data: [] }));

  const callOI = new Map();
  const putOI = new Map();
  const callLtp = new Map();
  const putLtp = new Map();
  const callClose = new Map();
  const putClose = new Map();
  for (const quote of liveRes.data?.fetched || []) {
    const token = String(quote.symbolToken);
    const oi = Number(quote.opnInterest || 0);
    const ltp = Number(
      quote.ltp ??
      quote.lastTradePrice ??
      quote.lastPrice ??
      quote.close ??
      0
    );
    const close = Number(quote.close ?? quote.previousClose ?? 0); // prev-day close for Chng%
    const ceStrike = findStrikeByToken(ceTokens, token);
    const peStrike = findStrikeByToken(peTokens, token);
    if (ceStrike != null) {
      callOI.set(ceStrike, oi);
      callLtp.set(ceStrike, ltp);
      callClose.set(ceStrike, close);
    }
    if (peStrike != null) {
      putOI.set(peStrike, oi);
      putLtp.set(peStrike, ltp);
      putClose.set(peStrike, close);
    }
  }

  const callDelta = new Map();
  const putDelta = new Map();
  for (const greek of greekRes.data || []) {
    const strike = Math.trunc(Number(greek.strikePrice || 0));
    if (String(greek.optionType || '').includes('CE')) callDelta.set(strike, Number(greek.delta || 0));
    if (String(greek.optionType || '').includes('PE')) putDelta.set(strike, Number(greek.delta || 0));
  }

  const outCall = [];
  const outPut = [];
  const exposureCall = [];
  const exposurePut = [];
  const outCallLtp = [];
  const outPutLtp = [];
  const outCallClose = [];
  const outPutClose = [];
  for (const strike of finalStrikes) {
    const coi = callOI.get(strike) || 0;
    const poi = putOI.get(strike) || 0;
    outCall.push(coi);
    outPut.push(poi);
    outCallLtp.push(callLtp.get(strike) || 0);
    outPutLtp.push(putLtp.get(strike) || 0);
    outCallClose.push(callClose.get(strike) || 0);
    outPutClose.push(putClose.get(strike) || 0);
    exposureCall.push(Math.abs(coi * (callDelta.get(strike) || 0)));
    exposurePut.push(Math.abs(poi * (putDelta.get(strike) || 0)));
  }

  const totalPut = outPut.reduce((sum, value) => sum + value, 0);
  const totalCall = outCall.reduce((sum, value) => sum + value, 0);

  return {
    status: true,
    symbol: upperSymbol,
    expiry: upperExpiry,
    spot,
    atm,
    pcr: totalCall ? Number((totalPut / totalCall).toFixed(2)) : 0,
    strikes: finalStrikes,
    callOI: outCall,
    putOI: outPut,
    callLtp: outCallLtp,
    putLtp: outPutLtp,
    callClose: outCallClose,
    putClose: outPutClose,
    manipulatedCallOI: exposureCall,
    manipulatedPutOI: exposurePut,
    // Live-feed wiring for the browser:
    exchange,
    lotSize,
    callTokens,
    putTokens,
    callSymbols,
    putSymbols,
    liveTokens: tokensForLive,
    spotToken,
    spotExchange,
    feed: {
      jwtToken,
      feedToken: login.session?.feedToken || null,
      apiKey: client.apiKey,
      clientCode: client.clientCode,
    },
    session: login.session,
  };
}

// Resolve one option leg's contract for a (symbol, expiry, strike, optionType)
// from the scrip master — returns its token, tradingsymbol, exchange and lot
// size. Used when the basket changes a leg's expiry, so the leg points at the
// correct new contract (and margin/charges stay accurate).
async function resolveLeg({ client = {}, symbol = '', expiry = '', strike, optionType = 'CE' } = {}) {
  const upperSymbol = String(symbol).toUpperCase();
  const upperExpiry = String(expiry).toUpperCase();
  const side = String(optionType).toUpperCase().endsWith('PE') ? 'PE' : 'CE';
  const wantStrike = Math.trunc(Number(strike) || 0);
  if (!upperSymbol || !upperExpiry || !wantStrike) {
    throw new Error('symbol, expiry and strike are required');
  }

  const exchange = upperSymbol === 'SENSEX'
    ? 'BFO'
    : MCX_SYMBOLS.has(upperSymbol)
      ? 'MCX'
      : 'NFO';

  // Collect every available strike for this expiry+side, then take the exact
  // match — or snap to the NEAREST one. Strike steps differ across expiries and
  // symbols, so an arrow-step (+50) may land off-grid; snapping avoids a hard
  // failure and mirrors how the real basket behaves.
  const master = await getMasterData();
  const candidates = []; // { strike, token, tradingSymbol, lotSize }
  for (const row of master) {
    if (row.n !== upperSymbol || row.g !== exchange || row.e !== upperExpiry) continue;
    const rowSymbol = String(row.s);
    if (!rowSymbol.endsWith(side)) continue;
    candidates.push({
      strike: normalizeStrike(Number(row.k || 0), exchange),
      token: String(row.t),
      tradingSymbol: rowSymbol,
      lotSize: Number(row.l) || 1,
    });
  }

  if (!candidates.length) {
    throw new Error(`No ${side} contracts for ${upperSymbol} ${upperExpiry}`);
  }

  let found = candidates.find((c) => c.strike === wantStrike);
  let snappedStrike = wantStrike;
  if (!found) {
    // nearest available strike to the requested one
    found = candidates.reduce((best, c) =>
      Math.abs(c.strike - wantStrike) < Math.abs(best.strike - wantStrike) ? c : best);
    snappedStrike = found.strike;
  }

  // Fetch the live LTP/close for the new contract so the basket row refreshes
  // its price + change% on expiry change. Best-effort: if the session is
  // missing or the quote fails (e.g. market closed), we still return the
  // resolved contract with ltp = null.
  let ltp = null;
  let close = null;
  let quoteError = null;
  const session = resolveSession(client);
  const jwtToken = session?.jwtToken;
  if (!jwtToken) {
    quoteError = 'no session (log in to fetch price)';
  } else {
    try {
      const headers = smartHeaders(client.apiKey);
      const quote = await smartFetch('/rest/secure/angelbroking/market/v1/quote', {
        method: 'POST',
        headers: authHeaders(headers, jwtToken),
        body: { mode: 'FULL', exchangeTokens: { [exchange]: [found.token] } },
      });
      const row = quote.data?.fetched?.[0];
      if (row) {
        // After hours ltp may be 0 — fall back to the day's close so the row
        // still shows a real number for the new contract.
        const rawLtp = Number(row.ltp ?? row.lastTradePrice ?? 0);
        close = Number(row.close ?? row.previousClose ?? 0) || null;
        ltp = rawLtp || close || 0;
      } else {
        quoteError = quote.message || 'quote returned no rows';
      }
      if (FEED_DEBUG) console.log(`[resolve] ${found.tradingSymbol} token=${found.token} ltp=${ltp} close=${close}`);
    } catch (error) {
      quoteError = error.message || 'quote failed';
    }
  }

  const changePct = (ltp && close) ? Number((((ltp - close) / close) * 100).toFixed(2)) : null;

  return {
    status: true,
    token: found.token,
    tradingSymbol: found.tradingSymbol,
    exchange,
    lotSize: found.lotSize,
    strike: snappedStrike, // the actual available strike (snapped if off-grid)
    expiry: upperExpiry,
    optionType: side,
    ltp,
    close,
    changePct,
    quoteError,
  };
}

// Real basket margin via Angel's batch margin calculator. Maps each basket
// leg → an Angel position { exchange, token, qty, price, productType, tradeType }
// and returns the netted totalMarginRequired for the whole basket (Angel applies
// spread/offset benefits across the legs). Up to 50 positions per call.
//
// Body: { client, legs:[{ token, exchange, qty, price, tradeType, productType }] }
async function getMargin({ client = {}, legs = [] } = {}) {
  const positions = (legs || [])
    .filter((leg) => leg && leg.token)
    .slice(0, 50)
    .map((leg) => ({
      exchange: String(leg.exchange || 'NFO'),
      // The basket shows quantity in LOTS; Angel's margin API expects UNITS, so
      // multiply by the contract's lot size (defaults to 1 for cash/unknown).
      qty: Math.max(0, Math.trunc((Number(leg.qty) || 0) * (Number(leg.lotSize) || 1))),
      price: Number(leg.price) || 0,
      productType: mapProductType(leg.productType),
      token: String(leg.token),
      tradeType: String(leg.tradeType || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      // Angel's batch endpoint requires an order type per position ("Order type
      // is required" otherwise). LIMIT when a price is given, else MARKET.
      orderType: String(leg.orderType || '').toUpperCase() === 'LIMIT' ? 'LIMIT' : 'MARKET',
    }))
    .filter((position) => position.qty > 0);

  if (!positions.length) {
    return { status: true, totalMarginRequired: 0, marginComponents: null, empty: true };
  }

  // Reuse the client's JWT (same account that drives the chain); re-login once
  // if it's missing or the batch call rejects a stale token.
  let session = resolveSession(client);
  let jwtToken = session?.jwtToken;
  if (!jwtToken) {
    const login = await autoLogin(client);
    session = login.session;
    jwtToken = session?.jwtToken;
  }
  if (!jwtToken) throw new Error('Angel session unavailable for margin');

  const headers = smartHeaders(client.apiKey);
  const callBatch = (token) => smartFetch('/rest/secure/angelbroking/margin/v1/batch', {
    method: 'POST',
    headers: authHeaders(headers, token),
    body: { positions },
  });

  let result;
  try {
    result = await callBatch(jwtToken);
  } catch (error) {
    const relogin = await autoLogin({ ...client, session: null });
    jwtToken = relogin.session?.jwtToken;
    if (!jwtToken) throw error;
    session = relogin.session;
    result = await callBatch(jwtToken);
  }

  const data = result.data || {};
  return {
    status: true,
    totalMarginRequired: Number(data.totalMarginRequired || 0),
    marginComponents: data.marginComponents || null,
    positionCount: positions.length,
    session,
  };
}

// Real brokerage + statutory charges via Angel's estimateCharges calculator.
// Each leg → an order { product_type, transaction_type, quantity, price,
// exchange, symbol_name, token }. Angel is picky: quantity and price must be
// STRINGS, and price must be an INTEGER string ("600", not "600.00") or it
// returns AB2001. Total is read from data.summary.total_charges.
//
// Body: { client, legs:[{ token, symbol, exchange, qty, lotSize, price, tradeType, productType }] }
async function getCharges({ client = {}, legs = [] } = {}) {
  const orders = (legs || [])
    .filter((leg) => leg && leg.token && leg.symbol)
    .slice(0, 50)
    .map((leg) => {
      const units = Math.max(0, Math.trunc((Number(leg.qty) || 0) * (Number(leg.lotSize) || 1)));
      return {
        product_type: mapChargeProduct(leg.productType, leg.exchange),
        transaction_type: String(leg.tradeType || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
        quantity: String(units),
        price: String(Math.max(0, Math.round(Number(leg.price) || 0))), // integer string
        exchange: String(leg.exchange || 'NFO'),
        symbol_name: String(leg.symbol),
        token: String(leg.token),
        _units: units,
      };
    })
    .filter((order) => order._units > 0)
    .map(({ _units, ...order }) => order);

  if (!orders.length) {
    return { status: true, totalCharges: 0, breakup: null, empty: true };
  }

  let session = resolveSession(client);
  let jwtToken = session?.jwtToken;
  if (!jwtToken) {
    const login = await autoLogin(client);
    session = login.session;
    jwtToken = session?.jwtToken;
  }
  if (!jwtToken) throw new Error('Angel session unavailable for charges');

  const headers = smartHeaders(client.apiKey);
  const callCharges = (token) => smartFetch('/rest/secure/angelbroking/brokerage/v1/estimateCharges', {
    method: 'POST',
    headers: authHeaders(headers, token),
    body: { orders },
  });

  let result;
  try {
    result = await callCharges(jwtToken);
  } catch (error) {
    const relogin = await autoLogin({ ...client, session: null });
    jwtToken = relogin.session?.jwtToken;
    if (!jwtToken) throw error;
    session = relogin.session;
    result = await callCharges(jwtToken);
  }

  const summary = result.data?.summary || {};
  return {
    status: true,
    totalCharges: Number(summary.total_charges || 0),
    breakup: summary.breakup || result.data?.charges || null,
    orderCount: orders.length,
    session,
  };
}

// estimateCharges product_type enum. Options/futures carry forward → CARRYFORWARD;
// intraday → INTRADAY. Cash buys default to DELIVERY.
function mapChargeProduct(value, exchange) {
  const v = String(value || 'CF').toUpperCase();
  if (v === 'MIS' || v === 'INTRADAY') return 'INTRADAY';
  const derivative = ['NFO', 'BFO', 'MCX', 'CDS'].includes(String(exchange || '').toUpperCase());
  if (v === 'CF' || v === 'NRML' || v === 'CARRYFORWARD') return derivative ? 'CARRYFORWARD' : 'DELIVERY';
  if (v === 'DELIVERY' || v === 'CNC') return 'DELIVERY';
  return derivative ? 'CARRYFORWARD' : 'DELIVERY';
}

// Basket products → Angel margin productType enum. The basket uses CF (carry
// forward) and MIS (intraday); Angel expects CARRYFORWARD / INTRADAY.
function mapProductType(value) {
  const v = String(value || 'CF').toUpperCase();
  if (v === 'MIS' || v === 'INTRADAY') return 'INTRADAY';
  if (v === 'DELIVERY' || v === 'CNC') return 'DELIVERY';
  if (v === 'MARGIN') return 'MARGIN';
  return 'CARRYFORWARD'; // CF / NRML default
}

// Master strikes are stored scaled. MCX commodities are consistently ×100;
// NSE/BSE index options only over-scale on some rows (>200000), so keep the
// original heuristic there.
function normalizeStrike(rawStrike, exchange) {
  if (exchange === 'MCX') return Math.trunc(rawStrike / 100);
  return rawStrike > 200000 ? Math.trunc(rawStrike / 100) : Math.trunc(rawStrike);
}

function findStrikeByToken(map, token) {
  for (const [strike, value] of map.entries()) {
    if (value === token) return strike;
  }
  return null;
}

async function trySessionRms(client, headers, session) {
  try {
    const rms = await getRms(headers, session.jwtToken);
    const nextSession = {
      ...session,
      apiKey: client.apiKey,
      lastRms: rms.data,
      lastUsedAt: new Date().toISOString(),
    };
    return buildRmsResponse(client.clientCode, rms.data, 'saved-session', nextSession);
  } catch {
    if (!session.refreshToken) return null;
  }

  try {
    const refreshed = await refreshTokens(headers, session.refreshToken);
    if (!refreshed.status || !refreshed.data?.jwtToken) return null;

    const refreshedSession = {
      ...session,
      apiKey: client.apiKey,
      jwtToken: refreshed.data.jwtToken,
      refreshToken: refreshed.data.refreshToken || session.refreshToken,
      feedToken: refreshed.data.feedToken || session.feedToken,
      refreshedAt: new Date().toISOString(),
    };

    const rms = await getRms(headers, refreshed.data.jwtToken);
    const nextSession = {
      ...refreshedSession,
      lastRms: rms.data,
      lastUsedAt: new Date().toISOString(),
    };
    return buildRmsResponse(client.clientCode, rms.data, 'refreshed-session', nextSession);
  } catch {
    return null;
  }
}

async function loginWithTotp(client, headers) {
  validateTotpLoginClient(client);
  const totp = generateTotp(client.totpSecret);
  const login = await smartFetch('/rest/auth/angelbroking/user/v1/loginByPassword', {
    method: 'POST',
    headers,
    body: {
      clientcode: client.clientCode,
      password: client.pin,
      totp,
    },
  });

  if (!login.status || !login.data?.jwtToken) {
    throw new Error(login.message || 'SmartAPI login failed');
  }

  return login;
}

async function rmsResultFromLogin(client, headers, login, source) {
  const rms = await getRms(headers, login.data.jwtToken);
  const session = {
    apiKey: client.apiKey,
    jwtToken: login.data.jwtToken,
    refreshToken: login.data.refreshToken,
    feedToken: login.data.feedToken,
    loginSource: source,
    loginAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    lastRms: rms.data,
  };

  return buildRmsResponse(client.clientCode, rms.data, source, session);
}

async function getRms(headers, jwtToken) {
  const rms = await smartFetch('/rest/secure/angelbroking/user/v1/getRMS', {
    method: 'GET',
    headers: {
      ...headers,
      Authorization: `Bearer ${jwtToken}`,
    },
  });

  if (!rms.status) {
    throw new Error(rms.message || 'RMS margin request failed');
  }

  return rms;
}

function buildRmsResponse(clientCode, data, sessionSource, session) {
  return {
    status: true,
    clientCode,
    availableMargin: pickMargin(data),
    marginSource: pickMarginSource(data),
    sessionSource,
    session,
    data,
  };
}

async function refreshTokens(headers, refreshToken) {
  return smartFetch('/rest/auth/angelbroking/jwt/v1/generateTokens', {
    method: 'POST',
    headers,
    body: { refreshToken },
  });
}

function pickMargin(data = {}) {
  const value =
    data.net ??
    data.availablecash ??
    data.availablelimitmargin ??
    data.collateral ??
    0;

  return Number(value);
}

function pickMarginSource(data = {}) {
  if (data.net != null) return 'net';
  if (data.availablecash != null) return 'availablecash';
  if (data.availablelimitmargin != null) return 'availablelimitmargin';
  if (data.collateral != null) return 'collateral';
  return 'unknown';
}

function validateClient(client) {
  const required = [
    ['clientCode', 'User ID'],
    ['apiKey', 'API key'],
  ];

  for (const [field, label] of required) {
    if (!client[field]) throw new Error(`${label} is required`);
  }
}

function validateTotpLoginClient(client) {
  const required = [
    ['pin', 'PIN'],
    ['totpSecret', 'TOTP secret'],
  ];

  for (const [field, label] of required) {
    if (!client[field]) throw new Error(`${label} is required`);
  }
}

async function smartFetch(endpoint, options) {
  const response = await fetch(`${SMARTAPI_BASE}${endpoint}`, {
    method: options.method,
    headers: options.headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.message || `SmartAPI HTTP ${response.status}`);
  }

  return body;
}

function smartHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': process.env.ANGEL_LOCAL_IP || getLocalIp(),
    'X-ClientPublicIP': process.env.ANGEL_PUBLIC_IP || getLocalIp(),
    'X-MACAddress': process.env.ANGEL_MAC_ADDRESS || '',
    'X-PrivateKey': apiKey,
  };
}

function authHeaders(headers, jwtToken) {
  return {
    ...headers,
    Authorization: `Bearer ${jwtToken}`,
  };
}

// Ensure the cache is populated and fresh (≤ 1 day old). Loads the parsed
// master once and reuses it; concurrent callers share a single load.
async function ensureMaster() {
  const fresh = masterCache.data && (Date.now() - masterCache.loadedAt) < MASTER_TTL_MS;
  if (fresh) return masterCache;
  if (masterLoading) return masterLoading;

  masterLoading = (async () => {
    // Prefer the on-disk slim files; only re-download from Angel when missing
    // or older than a day.
    try {
      const stat = await fs.stat(MASTER_FILE);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < MASTER_TTL_MS) {
        const [rawMaster, rawIndex] = await Promise.all([
          fs.readFile(MASTER_FILE, 'utf8'),
          fs.readFile(INDEX_FILE, 'utf8'),
        ]);
        masterCache.data = JSON.parse(rawMaster);
        masterCache.index = JSON.parse(rawIndex);
        masterCache.loadedAt = Date.now();
        if (FEED_DEBUG) console.log(`[master] loaded from disk: ${masterCache.data.length} tokens`);
        return masterCache;
      }
    } catch {
      // no usable disk cache — fall through to a network refresh
    }
    await refreshMaster();
    return masterCache;
  })();

  try {
    return await masterLoading;
  } finally {
    masterLoading = null;
  }
}

async function getMasterIndex() {
  return (await ensureMaster()).index;
}

async function getMasterData() {
  return (await ensureMaster()).data;
}

async function refreshMaster() {
  const response = await fetch(MASTER_URL);
  if (!response.ok) throw new Error(`Master download failed: HTTP ${response.status}`);

  const data = await response.json();
  const neededSpotSymbols = new Set(['Nifty 50', 'Nifty Bank', 'Nifty Fin Service', 'Nifty Mid Select', 'SENSEX']);
  const slimData = [];
  const dropdownIndex = {};

  for (const row of data) {
    const seg = row.exch_seg;
    const name = row.name || '';
    const isDerivative = seg === 'NFO' || seg === 'BFO' || seg === 'MCX';
    const isNeededSpot = (seg === 'NSE' || seg === 'BSE') && neededSpotSymbols.has(name);

    if (!isDerivative && !isNeededSpot) continue;

    slimData.push({
      t: String(row.token),
      s: String(row.symbol),
      n: String(name),
      e: String(row.expiry || '').toUpperCase(),
      k: Number(row.strike || 0),
      g: seg,
      l: Number(row.lotsize || 0) || 1, // lot size (units per lot) for margin/charges
    });

    if (isDerivative && row.expiry) {
      dropdownIndex[name] ||= [];
      dropdownIndex[name].push(String(row.expiry).toUpperCase());
    }
  }

  for (const [name, expiries] of Object.entries(dropdownIndex)) {
    dropdownIndex[name] = [...new Set(expiries)].sort((a, b) => Date.parse(a) - Date.parse(b));
  }

  await fs.writeFile(MASTER_FILE, JSON.stringify(slimData));
  await fs.writeFile(INDEX_FILE, JSON.stringify(dropdownIndex));

  // Update the in-memory cache so the fresh data is served immediately.
  masterCache.data = slimData;
  masterCache.index = dropdownIndex;
  masterCache.loadedAt = Date.now();

  return {
    status: true,
    masterSizeKb: Math.round(JSON.stringify(slimData).length / 1024),
    indexSizeKb: Math.round(JSON.stringify(dropdownIndex).length / 1024),
    symbolCount: Object.keys(dropdownIndex).length,
    totalTokens: slimData.length,
  };
}

function generateTotp(secret) {
  const key = base32Decode(secret.replace(/\s+/g, '').toUpperCase());
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 1_000_000).padStart(6, '0');
}

function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';

  for (const char of value.replace(/=+$/, '')) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error('Invalid TOTP secret');
    bits += index.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function getLocalIp() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return '127.0.0.1';
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const cleanPath = decodeURIComponent(urlPath.split('?')[0]);
  const requested = path.normalize(path.join(STATIC_ROOT, cleanPath));

  if (!requested.startsWith(STATIC_ROOT) || path.basename(requested) === 'sessions.json') {
    sendJson(res, 403, { status: false, message: 'Forbidden' });
    return;
  }

  let filePath = requested;
  let content;
  try {
    content = await fs.readFile(filePath);
  } catch {
    filePath = path.join(STATIC_ROOT, 'index.html');
    content = await fs.readFile(filePath);
  }

  const ext = path.extname(filePath);
  const type = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
  }[ext] || 'application/octet-stream';

  sendCors(res, 200, type);
  res.end(content);
}

function sendJson(res, statusCode, payload) {
  sendCors(res, statusCode, 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function sendCors(res, statusCode, contentType = 'text/plain') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  });
}
