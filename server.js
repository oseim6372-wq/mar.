/**
 * MTN Customer KYC API - Backend Proxy Server
 *
 * OAuth 2.0 flow (from developers.mtn.com):
 *   POST https://api.mtn.com/v1/oauth/access_token
 *   Content-Type: application/x-www-form-urlencoded
 *   Params: grant_type=client_credentials&client_id={consumer-key}&client_secret={consumer-secret}
 *   → Response contains { access_token, expires_in, ... }
 *
 * Mandatory API call header (per MTN docs):
 *   Authorization: Bearer {access_token}
 *
 * KYC endpoint:
 *   GET https://api.mtn.com/v1/customers/customers/{customerId}/kyc
 *
 * Setup:
 *   npm install express cors dotenv uuid
 *   cp .env.example .env   ← fill in MTN_CONSUMER_KEY and MTN_CONSUMER_SECRET
 *   node server.js
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────────────────
// Hardcoded per MTN Developer Portal documentation
const MTN_TOKEN_URL = 'https://api.mtn.com/v1/oauth/access_token';
const MTN_KYC_BASE  = 'https://api.mtn.com/v1/customers';

// From your MTN Developer Portal subscription — now correctly named Consumer Key / Secret
const MTN_CONSUMER_KEY    = process.env.MTN_CONSUMER_KEY    || '';
const MTN_CONSUMER_SECRET = process.env.MTN_CONSUMER_SECRET || '';

const PORT = process.env.PORT || 3000;

// ─── OAuth token cache ────────────────────────────────────────────────────────
let cachedToken  = null;
let tokenExpires = 0; // epoch ms

/**
 * Fetches a Bearer access_token from MTN using Client Credentials grant.
 *
 * Per the MTN docs the curl call is:
 *   curl -X POST \
 *     -H "Content-Type: application/x-www-form-urlencoded" \
 *     "https://api.mtn.com/v1/oauth/access_token \
 *      ?grant_type=client_credentials \
 *      &client_id={consumer-key} \
 *      &client_secret={consumer-secret}"
 *
 * Tokens are cached and refreshed 60 s before they expire.
 */
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpires) return cachedToken;

  if (!MTN_CONSUMER_KEY || !MTN_CONSUMER_SECRET) {
    throw new Error(
      'MTN_CONSUMER_KEY and MTN_CONSUMER_SECRET must be set in your .env file. ' +
      'Obtain them from https://developers.mtn.com after subscribing to the Customer KYC API.'
    );
  }

  // Build URL — credentials go as query params (matching the documented cURL)
  const tokenUrl = new URL(MTN_TOKEN_URL);
  tokenUrl.searchParams.set('grant_type',    'client_credentials');
  tokenUrl.searchParams.set('client_id',     MTN_CONSUMER_KEY);
  tokenUrl.searchParams.set('client_secret', MTN_CONSUMER_SECRET);

  console.log(`[OAuth] Fetching access token…`);

  const res = await fetch(tokenUrl.toString(), {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    '', // params are in the URL per MTN docs
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OAuth failed [HTTP ${res.status}]: ${errText}`);
  }

  const data = await res.json();

  if (!data.access_token) {
    throw new Error(`MTN OAuth response missing access_token field. Got: ${JSON.stringify(data)}`);
  }

  cachedToken = data.access_token;
  const expiresIn = parseInt(data.expires_in, 10) || 3599; // MTN tokens are ~1 hour
  tokenExpires = Date.now() + (expiresIn - 60) * 1000;

  console.log(`[OAuth] Token obtained (expires in ${expiresIn}s)`);
  return cachedToken;
}

// ─── Build MTN request headers ────────────────────────────────────────────────
/**
 * Mandatory headers per MTN docs:
 *   Authorization: Bearer {access_token}   ← from OAuth flow
 *   transactionId: {unique-id}             ← 5-20 alphanumeric chars
 *   Content-Type: application/json
 */
async function buildMtnHeaders(transactionId) {
  const token = await getAccessToken();
  return {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${token}`,
    'transactionId': transactionId,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isValidCustomerId(id) {
  return typeof id === 'string' && id.trim().length > 0;
}

function isValidDate(d) {
  return !d || /^\d{4}-\d{2}-\d{2}$/.test(d);
}

/** Generate a transactionId meeting MTN spec: 5-20 chars, ASCII alphanumeric + +/=.- */
function makeTransactionId() {
  return uuidv4().replace(/-/g, '').slice(0, 20);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /health
 * Returns server status plus OAuth token check.
 */
app.get('/health', async (_req, res) => {
  const configured = !!(MTN_CONSUMER_KEY && MTN_CONSUMER_SECRET);
  let tokenStatus  = 'credentials_not_set';

  if (configured) {
    try {
      await getAccessToken();
      tokenStatus = 'ok';
    } catch (e) {
      tokenStatus = `error: ${e.message}`;
    }
  }

  res.json({
    status:    'ok',
    service:   'MTN KYC Proxy',
    timestamp: new Date().toISOString(),
    oauth: {
      tokenUrl:    MTN_TOKEN_URL,
      configured,
      tokenStatus,
      tokenCached: !!cachedToken,
    },
  });
});

/**
 * GET /kyc/:customerId
 *
 * Proxies to: GET https://api.mtn.com/v1/customers/customers/{customerId}/kyc
 *
 * customerId can be:
 *   - MSISDN in E.123 format e.g. +233201234567
 *   - Email address
 *   - Any MTN customer identifier
 *
 * Optional query params:
 *   startDate  YYYY-MM-DD   (defaults to 6 months ago on MTN side)
 *   endDate    YYYY-MM-DD   (defaults to today on MTN side)
 *
 * Response 200 data fields: idType, idNumber, dateOfBirth, gender, firstName, lastName
 */
app.get('/kyc/:customerId', async (req, res) => {
  const { customerId } = req.params;
  const { startDate, endDate } = req.query;

  if (!isValidCustomerId(customerId)) {
    return res.status(400).json({
      statusCode:    '4001',
      statusMessage: 'customerId is required — provide MSISDN (E.123), email, or MTN customer ID.',
      transactionId: makeTransactionId(),
    });
  }

  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    return res.status(400).json({
      statusCode:    '4002',
      statusMessage: 'Invalid date format. Use YYYY-MM-DD.',
      transactionId: makeTransactionId(),
    });
  }

  // Honour caller transactionId if valid, else generate one
  const rawTx = (req.headers['transactionid'] || req.headers['x-transaction-id'] || '').trim();
  const transactionId = /^[A-Za-z0-9+/=.\-]{5,20}$/.test(rawTx) ? rawTx : makeTransactionId();

  const mtnUrl = new URL(`${MTN_KYC_BASE}/customers/${encodeURIComponent(customerId)}/kyc`);
  if (startDate) mtnUrl.searchParams.set('startDate', startDate);
  if (endDate)   mtnUrl.searchParams.set('endDate',   endDate);

  console.log(`[${new Date().toISOString()}] KYC lookup → ${mtnUrl} | txId=${transactionId}`);

  try {
    const headers = await buildMtnHeaders(transactionId);
    const mtnRes  = await fetch(mtnUrl.toString(), { method: 'GET', headers });
    const mtnBody = await mtnRes.json();

    return res.status(mtnRes.status).json({
      ...mtnBody,
      _meta: {
        proxyTransactionId:  transactionId,
        mtnHttpStatus:       mtnRes.status,
        requestedCustomerId: customerId,
        timestamp:           new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[KYC error]', err.message);
    return res.status(500).json({
      statusCode:     '5000',
      statusMessage:  'Proxy error contacting MTN KYC API.',
      supportMessage: err.message,
      transactionId,
      timestamp:      new Date().toISOString(),
    });
  }
});

/**
 * POST /kyc/lookup
 * Alternative to GET — customerId in request body (avoids URL-encoding issues).
 *
 * Body: { "customerId": "+233201234567", "startDate": "2026-01-01", "endDate": "2026-05-15" }
 */
app.post('/kyc/lookup', async (req, res) => {
  const { customerId, startDate, endDate } = req.body || {};

  if (!isValidCustomerId(customerId)) {
    return res.status(400).json({
      statusCode:    '4001',
      statusMessage: 'customerId is required in request body.',
      transactionId: makeTransactionId(),
    });
  }

  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    return res.status(400).json({
      statusCode:    '4002',
      statusMessage: 'Invalid date format. Use YYYY-MM-DD.',
      transactionId: makeTransactionId(),
    });
  }

  const transactionId = makeTransactionId();
  const mtnUrl = new URL(`${MTN_KYC_BASE}/customers/${encodeURIComponent(customerId)}/kyc`);
  if (startDate) mtnUrl.searchParams.set('startDate', startDate);
  if (endDate)   mtnUrl.searchParams.set('endDate',   endDate);

  console.log(`[${new Date().toISOString()}] KYC (POST) → ${mtnUrl} | txId=${transactionId}`);

  try {
    const headers = await buildMtnHeaders(transactionId);
    const mtnRes  = await fetch(mtnUrl.toString(), { method: 'GET', headers });
    const mtnBody = await mtnRes.json();

    return res.status(mtnRes.status).json({
      ...mtnBody,
      _meta: {
        proxyTransactionId:  transactionId,
        mtnHttpStatus:       mtnRes.status,
        requestedCustomerId: customerId,
        timestamp:           new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[KYC POST error]', err.message);
    return res.status(500).json({
      statusCode:     '5000',
      statusMessage:  'Proxy error contacting MTN KYC API.',
      supportMessage: err.message,
      transactionId,
      timestamp:      new Date().toISOString(),
    });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const keyOk    = MTN_CONSUMER_KEY    ? '✓ set' : '✗ MISSING — add to .env';
  const secretOk = MTN_CONSUMER_SECRET ? '✓ set' : '✗ MISSING — add to .env';
  console.log(`
╔═══════════════════════════════════════════════════════╗
║         MTN KYC Proxy  →  http://localhost:${PORT}        ║
╠═══════════════════════════════════════════════════════╣
║  GET  /health                                         ║
║  GET  /kyc/:customerId?startDate=...&endDate=...      ║
║  POST /kyc/lookup   body: { customerId, ... }         ║
╠═══════════════════════════════════════════════════════╣
║  OAuth URL : https://api.mtn.com/v1/oauth/access_token║
║  Consumer Key    : ${keyOk.padEnd(34)}║
║  Consumer Secret : ${secretOk.padEnd(34)}║
╚═══════════════════════════════════════════════════════╝
`);
});
