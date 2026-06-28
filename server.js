import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

const PORT = Number(process.env.PORT || 3001);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SMARTAPI_BASE = 'https://apiconnect.angelone.in';

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
});

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
  const requested = path.normalize(path.join(ROOT, decodeURIComponent(urlPath)));

  if (!requested.startsWith(ROOT) || path.basename(requested) === 'sessions.json') {
    sendJson(res, 403, { status: false, message: 'Forbidden' });
    return;
  }

  const content = await fs.readFile(requested);
  const ext = path.extname(requested);
  const type = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
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
