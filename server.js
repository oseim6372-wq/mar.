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
 * Credentials are sent in the POST body (NOT as URL query params).
 * MTN gateway returns HTTP 401 / faultMessage "Client identifier is required"
 * if client_id is passed as a URL param instead of in the body.
 *
 *   curl -X POST \
 *     -H "Content-Type: application/x-www-form-urlencoded" \
 *     --data "grant_type=client_credentials&client_id=KEY&client_secret=SECRET" \
 *     https://api.mtn.com/v1/oauth/access_token
 *
 * Tokens are cached and refreshed 60 s before expiry.
 */
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpires) return cachedToken;

  if (!MTN_CONSUMER_KEY || !MTN_CONSUMER_SECRET) {
    throw new Error(
      'MTN_CONSUMER_KEY and MTN_CONSUMER_SECRET must be set in your .env file. ' +
      'Obtain them from https://developers.mtn.com after subscribing to the Customer KYC API.'
    );
  }

  // MTN OAuth supports two auth styles depending on subscription tier.
  // We try Basic Auth first (client_id:client_secret as Base64 in Authorization header)
  // then fall back to body params if that also fails.
  // The cURL from the docs shows body params but some MTN gateway configs require Basic Auth.
  const tokenBody = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     MTN_CONSUMER_KEY,
    client_secret: MTN_CONSUMER_SECRET,
  });

  const basicCredentials = Buffer.from(`${MTN_CONSUMER_KEY}:${MTN_CONSUMER_SECRET}`).toString('base64');

  console.log('[OAuth] Fetching access token (trying Basic Auth)...');

  // Attempt 1: HTTP Basic Auth header (common for MTN gateway)
  let res = await fetch(MTN_TOKEN_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicCredentials}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
  });

  // Attempt 2: credentials in body (no Basic Auth header)
  if (!res.ok) {
    console.log(`[OAuth] Basic Auth got ${res.status}, retrying with body params...`);
    res = await fetch(MTN_TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    tokenBody.toString(),
    });
  }

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

// ─── Build MTN KYC request headers ───────────────────────────────────────────
/**
 * Headers sent on every KYC API call.
 *
 * The MTN docs cURL sample shows:
 *   --header 'Content-Type: application/json'
 *   --header 'transactionId: '
 *
 * The OAuth guide says the access_token must be used as the
 * Authorization header parameter on API calls.
 * We send both; if OAuth fails we still send the other headers
 * so the request reaches MTN (some sandbox tiers don't enforce auth).
 */
async function buildMtnHeaders(transactionId) {
  const headers = {
    'Content-Type':  'application/json',
    'transactionId': transactionId,
  };

  try {
    const token = await getAccessToken();
    headers['Authorization'] = `Bearer ${token}`;
    console.log('[KYC] Authorization: Bearer token attached');
  } catch (err) {
    // Log but don't block — send request without Bearer so we can see
    // the exact MTN error rather than a proxy 500
    console.warn('[KYC] Could not obtain Bearer token:', err.message);
    console.warn('[KYC] Sending request without Authorization header');
  }

  return headers;
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
