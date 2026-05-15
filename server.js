/**
 * MTN Customer KYC API - Backend Proxy Server
 * 
 * FIX: Added BOTH OAuth Bearer token AND x-api-key header
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────────────────
const MTN_TOKEN_URL = 'https://api.mtn.com/v1/oauth/access_token';
const MTN_KYC_BASE  = 'https://api.mtn.com/v1/customers';

const MTN_CONSUMER_KEY    = process.env.MTN_CONSUMER_KEY    || '';
const MTN_CONSUMER_SECRET = process.env.MTN_CONSUMER_SECRET || '';

const PORT = process.env.PORT || 3000;

// ─── OAuth token cache ────────────────────────────────────────────────────────
let cachedToken  = null;
let tokenExpires = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpires) {
    console.log('[OAuth] Using cached token');
    return cachedToken;
  }

  if (!MTN_CONSUMER_KEY || !MTN_CONSUMER_SECRET) {
    throw new Error('MTN_CONSUMER_KEY and MTN_CONSUMER_SECRET must be set in .env file');
  }

  console.log('[OAuth] Fetching new access token...');

  // Credentials as URL query params (per MTN docs)
  const tokenUrl = new URL(MTN_TOKEN_URL);
  tokenUrl.searchParams.append('grant_type', 'client_credentials');
  tokenUrl.searchParams.append('client_id', MTN_CONSUMER_KEY);
  tokenUrl.searchParams.append('client_secret', MTN_CONSUMER_SECRET);

  const response = await fetch(tokenUrl.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  const responseText = await response.text();
  console.log(`[OAuth] Response status: ${response.status}`);

  if (!response.ok) {
    throw new Error(`OAuth failed: ${responseText}`);
  }

  const data = JSON.parse(responseText);

  if (!data.access_token) {
    throw new Error(`No access_token in response`);
  }

  cachedToken = data.access_token;
  const expiresIn = parseInt(data.expires_in, 10) || 3599;
  tokenExpires = Date.now() + (expiresIn - 60) * 1000;

  console.log(`[OAuth] Token obtained (expires in ${expiresIn}s)`);
  return cachedToken;
}

// ─── Build MTN KYC request headers ───────────────────────────────────────────
async function buildMtnHeaders(transactionId) {
  const token = await getAccessToken();
  
  // IMPORTANT: MTN requires BOTH Bearer token AND x-api-key
  const headers = {
    'Content-Type': 'application/json',
    'transactionId': transactionId,
    'Authorization': `Bearer ${token}`,
    'x-api-key': MTN_CONSUMER_KEY,  // ← ADD THIS! Required by MTN
  };
  
  console.log('[KYC] Headers: Authorization=Bearer ***, x-api-key=***');
  return headers;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isValidCustomerId(id) {
  return typeof id === 'string' && id.trim().length > 0;
}

function isValidDate(d) {
  return !d || /^\d{4}-\d{2}-\d{2}$/.test(d);
}

function makeTransactionId() {
  return uuidv4().replace(/-/g, '').slice(0, 20);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /health
 */
app.get('/health', async (_req, res) => {
  const configured = !!(MTN_CONSUMER_KEY && MTN_CONSUMER_SECRET);
  let tokenStatus = 'not_tested';

  if (configured) {
    try {
      await getAccessToken();
      tokenStatus = 'ok';
    } catch (e) {
      tokenStatus = `error: ${e.message}`;
    }
  }

  res.json({
    status: 'ok',
    service: 'MTN KYC Proxy',
    environment: 'production',
    authMethods: ['OAuth Bearer', 'x-api-key'],
    timestamp: new Date().toISOString(),
    oauth: {
      configured,
      tokenStatus,
    },
  });
});

/**
 * POST /kyc/lookup
 * 
 * Correct endpoint: GET https://api.mtn.com/v1/customers/customers/{customerId}/kyc
 */
app.post('/kyc/lookup', async (req, res) => {
  const { customerId, startDate, endDate } = req.body || {};

  if (!isValidCustomerId(customerId)) {
    return res.status(400).json({
      statusCode: '4001',
      statusMessage: 'customerId is required in request body.',
      transactionId: makeTransactionId(),
    });
  }

  const transactionId = makeTransactionId();
  
  // Clean customerId (remove any double encoding)
  const cleanCustomerId = customerId.replace(/^%2B/, '+');
  
  // IMPORTANT: Double /customers/ in the path as per MTN docs
  const mtnUrl = new URL(`${MTN_KYC_BASE}/customers/${encodeURIComponent(cleanCustomerId)}/kyc`);
  
  if (startDate && isValidDate(startDate)) {
    mtnUrl.searchParams.set('startDate', startDate);
  }
  if (endDate && isValidDate(endDate)) {
    mtnUrl.searchParams.set('endDate', endDate);
  }

  console.log(`\n[KYC] ========== REQUEST ==========`);
  console.log(`[KYC] URL: ${mtnUrl.toString()}`);
  console.log(`[KYC] Transaction ID: ${transactionId}`);
  console.log(`[KYC] Customer ID: ${cleanCustomerId}`);

  try {
    // Get headers with BOTH authentication methods
    const headers = await buildMtnHeaders(transactionId);

    const mtnRes = await fetch(mtnUrl.toString(), { 
      method: 'GET', 
      headers 
    });
    
    const rawText = await mtnRes.text();
    console.log(`[KYC] MTN status: ${mtnRes.status}`);

    // Try to parse JSON response
    let mtnBody;
    try {
      mtnBody = JSON.parse(rawText);
    } catch (e) {
      console.error(`[KYC] Non-JSON response: ${rawText.substring(0, 300)}`);
      
      return res.status(mtnRes.status || 502).json({
        statusCode: '5020',
        statusMessage: 'MTN API returned non-JSON response',
        supportMessage: `HTTP ${mtnRes.status} - Check if your IP is whitelisted`,
        rawPreview: rawText.substring(0, 300),
        transactionId,
        timestamp: new Date().toISOString(),
      });
    }

    // Return successful response
    return res.status(mtnRes.status).json({
      ...mtnBody,
      _meta: {
        proxyTransactionId: transactionId,
        mtnHttpStatus: mtnRes.status,
        requestedCustomerId: cleanCustomerId,
        mtnUrl: mtnUrl.toString(),
        authMethods: ['Bearer', 'x-api-key'],
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error(`[KYC] ❌ Error:`, err.message);
    
    if (err.message.includes('OAuth') || err.message.includes('token')) {
      return res.status(401).json({
        statusCode: '4000',
        statusMessage: 'Unauthorised - Token generation failed',
        supportMessage: err.message,
        transactionId,
        timestamp: new Date().toISOString(),
      });
    }
    
    return res.status(500).json({
      statusCode: '5000',
      statusMessage: 'Proxy error contacting MTN KYC API.',
      supportMessage: err.message,
      transactionId,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /kyc/:customerId - Legacy endpoint
 */
app.get('/kyc/:customerId', async (req, res) => {
  const { customerId } = req.params;
  const { startDate, endDate } = req.query;
  
  req.body = { customerId, startDate, endDate };
  return app._router.handle(req, res, '/kyc/lookup');
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const keyOk = MTN_CONSUMER_KEY ? '✓ SET' : '✗ MISSING';
  const secretOk = MTN_CONSUMER_SECRET ? '✓ SET' : '✗ MISSING';
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║                    MTN KYC Proxy Server v4.0                          ║
╠═══════════════════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                                           ║
║  Base URL: ${MTN_KYC_BASE}
╠═══════════════════════════════════════════════════════════════════════╣
║  Consumer Key:    ${keyOk.padEnd(38)}║
║  Consumer Secret: ${secretOk.padEnd(38)}║
╠═══════════════════════════════════════════════════════════════════════╣
║  ✅ FIX: Added x-api-key header (required by MTN)                     ║
║  ✅ FIX: Double /customers/ in URL path                               ║
║  ✅ FIX: Both OAuth Bearer + API Key authentication                   ║
╚═══════════════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
