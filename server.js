/**
 * MTN Customer KYC API - Backend Proxy Server (FIXED)
 * 
 * FIX: buildMtnHeaders now THROWS error instead of silently continuing
 * FIX: Proper OAuth implementation matching MTN docs
 * FIX: Clear error messages for debugging
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
const MTN_KYC_BASE  = 'https://api.mtn.com/v1';

const MTN_CONSUMER_KEY    = process.env.MTN_CONSUMER_KEY    || '';
const MTN_CONSUMER_SECRET = process.env.MTN_CONSUMER_SECRET || '';

const PORT = process.env.PORT || 3000;

// ─── OAuth token cache ────────────────────────────────────────────────────────
let cachedToken  = null;
let tokenExpires = 0;

/**
 * Fetches Bearer access_token from MTN.
 * 
 * Based on MTN docs: credentials as URL query parameters
 * curl -X POST "https://api.mtn.com/v1/oauth/access_token?grant_type=client_credentials&client_id=KEY&client_secret=SECRET"
 */
async function getAccessToken() {
  // Return cached token if still valid
  if (cachedToken && Date.now() < tokenExpires) {
    console.log('[OAuth] Using cached token');
    return cachedToken;
  }

  if (!MTN_CONSUMER_KEY || !MTN_CONSUMER_SECRET) {
    throw new Error(
      'MTN_CONSUMER_KEY and MTN_CONSUMER_SECRET must be set in .env file.\n' +
      'Get them from https://developers.mtn.com → My Apps → Your App'
    );
  }

  console.log('[OAuth] Fetching new access token...');
  console.log(`[OAuth] Consumer Key: ${MTN_CONSUMER_KEY.substring(0, 10)}...`);

  // Method 1: Credentials as URL query params (as shown in MTN documentation)
  const tokenUrl = new URL(MTN_TOKEN_URL);
  tokenUrl.searchParams.append('grant_type', 'client_credentials');
  tokenUrl.searchParams.append('client_id', MTN_CONSUMER_KEY);
  tokenUrl.searchParams.append('client_secret', MTN_CONSUMER_SECRET);

  try {
    const response = await fetch(tokenUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const responseText = await response.text();
    console.log(`[OAuth] Response status: ${response.status}`);

    if (!response.ok) {
      console.error(`[OAuth] Failed response: ${responseText.substring(0, 300)}`);
      throw new Error(`OAuth HTTP ${response.status}: ${responseText.substring(0, 200)}`);
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      throw new Error(`MTN returned non-JSON: ${responseText.substring(0, 200)}`);
    }

    if (!data.access_token) {
      throw new Error(`No access_token in response. Got: ${JSON.stringify(data)}`);
    }

    cachedToken = data.access_token;
    const expiresIn = parseInt(data.expires_in, 10) || 3599;
    tokenExpires = Date.now() + (expiresIn - 60) * 1000;

    console.log(`[OAuth] ✅ Token obtained (expires in ${expiresIn}s)`);
    console.log(`[OAuth] Token preview: ${cachedToken.substring(0, 30)}...`);
    
    return cachedToken;
  } catch (error) {
    console.error(`[OAuth] ❌ Error:`, error.message);
    throw error;
  }
}

/**
 * Build MTN KYC request headers with Bearer token.
 * 
 * FIX: Now THROWS error if token cannot be obtained (no more silent failures)
 */
async function buildMtnHeaders(transactionId) {
  const headers = {
    'Content-Type': 'application/json',
    'transactionId': transactionId,
  };

  // Get token - this will throw if fails (FIXED)
  const token = await getAccessToken();
  headers['Authorization'] = `Bearer ${token}`;
  console.log('[KYC] Authorization header attached');

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
 * Returns server status and tests OAuth token generation
 */
app.get('/health', async (_req, res) => {
  const configured = !!(MTN_CONSUMER_KEY && MTN_CONSUMER_SECRET);
  let tokenStatus = 'not_tested';
  let tokenError = null;
  let tokenPreview = null;

  if (configured) {
    try {
      const token = await getAccessToken();
      tokenStatus = 'ok';
      tokenPreview = token.substring(0, 30) + '...';
    } catch (e) {
      tokenStatus = 'error';
      tokenError = e.message;
    }
  }

  res.json({
    status: 'ok',
    service: 'MTN KYC Proxy',
    timestamp: new Date().toISOString(),
    config: {
      tokenUrl: MTN_TOKEN_URL,
      kycBase: MTN_KYC_BASE,
      hasConsumerKey: !!MTN_CONSUMER_KEY,
      hasConsumerSecret: !!MTN_CONSUMER_SECRET,
    },
    oauth: {
      configured,
      tokenStatus,
      tokenError,
      tokenPreview,
      tokenCached: !!cachedToken,
    },
  });
});

/**
 * POST /kyc/lookup
 * 
 * KYC endpoint: GET https://api.mtn.com/v1/customers/{customerId}/kyc
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

  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    return res.status(400).json({
      statusCode: '4002',
      statusMessage: 'Invalid date format. Use YYYY-MM-DD.',
      transactionId: makeTransactionId(),
    });
  }

  const transactionId = makeTransactionId();
  
  // Clean customerId (remove any double encoding)
  const cleanCustomerId = customerId.replace(/^%2B/, '+');
  
  // Build KYC URL
  const mtnUrl = new URL(`${MTN_KYC_BASE}/customers/${encodeURIComponent(cleanCustomerId)}/kyc`);
  if (startDate) mtnUrl.searchParams.set('startDate', startDate);
  if (endDate) mtnUrl.searchParams.set('endDate', endDate);

  console.log(`\n[KYC] ========== REQUEST ==========`);
  console.log(`[KYC] URL: ${mtnUrl.toString()}`);
  console.log(`[KYC] Transaction ID: ${transactionId}`);
  console.log(`[KYC] Customer ID: ${cleanCustomerId}`);

  try {
    // This will throw if token generation fails (FIXED)
    const headers = await buildMtnHeaders(transactionId);
    console.log(`[KYC] Headers: Authorization=${headers.Authorization ? 'Bearer ***' : 'MISSING'}`);

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
      
      // Check for common HTML error pages
      let suggestion = 'Check your MTN credentials and IP whitelist.';
      if (rawText.includes('418') || rawText.includes('teapot')) {
        suggestion = 'HTTP 418 - Your IP may be blocked. Try using a VPN or contact MTN support.';
      } else if (rawText.includes('401') || rawText.includes('Unauthorized')) {
        suggestion = 'Invalid Consumer Key/Secret or wrong environment (sandbox vs production).';
      }
      
      return res.status(mtnRes.status || 502).json({
        statusCode: '5020',
        statusMessage: 'MTN API returned non-JSON response',
        supportMessage: `HTTP ${mtnRes.status} — ${suggestion}`,
        rawPreview: rawText.substring(0, 300),
        transactionId,
        timestamp: new Date().toISOString(),
      });
    }

    // Return successful response with metadata
    return res.status(mtnRes.status).json({
      ...mtnBody,
      _meta: {
        proxyTransactionId: transactionId,
        mtnHttpStatus: mtnRes.status,
        requestedCustomerId: cleanCustomerId,
        mtnUrl: mtnUrl.toString(),
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error(`[KYC] ❌ Error:`, err.message);
    
    // Check if it's an OAuth error
    if (err.message.includes('OAuth') || err.message.includes('token')) {
      return res.status(401).json({
        statusCode: '4000',
        statusMessage: 'Unauthorised - Token generation failed',
        supportMessage: err.message,
        transactionId,
        timestamp: new Date().toISOString(),
        debug: {
          hasConsumerKey: !!MTN_CONSUMER_KEY,
          hasConsumerSecret: !!MTN_CONSUMER_SECRET,
          consumerKeyPrefix: MTN_CONSUMER_KEY ? MTN_CONSUMER_KEY.substring(0, 8) : null,
        },
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
 * GET /kyc/:customerId - Legacy GET endpoint
 */
app.get('/kyc/:customerId', async (req, res) => {
  const { customerId } = req.params;
  const { startDate, endDate } = req.query;
  
  // Forward to POST handler
  req.body = { customerId, startDate, endDate };
  return app._router.handle(req, res, '/kyc/lookup');
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const keyOk = MTN_CONSUMER_KEY ? '✓ SET' : '✗ MISSING';
  const secretOk = MTN_CONSUMER_SECRET ? '✓ SET' : '✗ MISSING';
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║                    MTN KYC Proxy Server v3.0 (FIXED)                  ║
╠═══════════════════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                                           ║
║  Token URL: ${MTN_TOKEN_URL}
║  KYC Base:  ${MTN_KYC_BASE}
╠═══════════════════════════════════════════════════════════════════════╣
║  Consumer Key:    ${keyOk.padEnd(38)}║
║  Consumer Secret: ${secretOk.padEnd(38)}║
╠═══════════════════════════════════════════════════════════════════════╣
║  ✅ FIX: buildMtnHeaders now THROWS on OAuth failure                  ║
║  ✅ FIX: Clear error messages for debugging                          ║
║  ✅ FIX: Proper OAuth with URL query params (per MTN docs)           ║
╚═══════════════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
