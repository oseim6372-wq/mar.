/**
 * MTN Customer KYC API - Backend Proxy Server
 * Based on official MTN Developer Portal documentation
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────────────────
// CORRECTED endpoints based on MTN documentation screenshots
const MTN_TOKEN_URL = 'https://api.mtn.com/v1/oauth/access_token';
const MTN_KYC_BASE = 'https://api.mtn.com/v1/customers';

// From your MTN Developer Portal - these should be your Production key and secret
const MTN_CONSUMER_KEY = process.env.MTN_CONSUMER_KEY || '';
const MTN_CONSUMER_SECRET = process.env.MTN_CONSUMER_SECRET || '';

const PORT = process.env.PORT || 3000;

// ─── OAuth token cache ────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpires = 0; // epoch ms

/**
 * Fetches a Bearer access_token from MTN OAuth endpoint.
 * Based on MTN documentation: credentials are passed as URL query parameters
 * 
 * curl -X POST "https://api.mtn.com/v1/oauth/access_token?grant_type=client_credentials&client_id={consumer-key}&client_secret={consumer-secret}"
 */
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpires) {
    console.log('[OAuth] Using cached token');
    return cachedToken;
  }

  if (!MTN_CONSUMER_KEY || !MTN_CONSUMER_SECRET) {
    throw new Error(
      'MTN_CONSUMER_KEY and MTN_CONSUMER_SECRET must be set in .env file.\n' +
      'Get these from MTN Developer Portal under your app credentials.'
    );
  }

  // Build URL with query parameters as shown in MTN docs
  const tokenUrl = new URL(MTN_TOKEN_URL);
  tokenUrl.searchParams.append('grant_type', 'client_credentials');
  tokenUrl.searchParams.append('client_id', MTN_CONSUMER_KEY);
  tokenUrl.searchParams.append('client_secret', MTN_CONSUMER_SECRET);

  console.log('[OAuth] Fetching token from:', MTN_TOKEN_URL);

  try {
    const response = await fetch(tokenUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[OAuth] Token request failed:', response.status, errorText);
      throw new Error(`OAuth failed [${response.status}]: ${errorText.substring(0, 200)}`);
    }

    const data = await response.json();

    if (!data.access_token) {
      console.error('[OAuth] Response missing access_token:', data);
      throw new Error(`MTN OAuth response missing access_token. Got: ${JSON.stringify(data)}`);
    }

    cachedToken = data.access_token;
    const expiresIn = parseInt(data.expires_in, 10) || 3599;
    // Cache until 60 seconds before expiry
    tokenExpires = Date.now() + (expiresIn - 60) * 1000;

    console.log(`[OAuth] Token obtained successfully (expires in ${expiresIn}s)`);
    return cachedToken;
  } catch (error) {
    console.error('[OAuth] Error:', error.message);
    throw error;
  }
}

/**
 * Generate a transactionId meeting MTN spec: 5-20 chars, ASCII alphanumeric + +/=.-
 */
function makeTransactionId() {
  return uuidv4().replace(/-/g, '').substring(0, 20);
}

/**
 * Build headers for MTN KYC API call
 */
async function buildMtnHeaders(transactionId) {
  const headers = {
    'Content-Type': 'application/json',
    'transactionId': transactionId,
  };

  try {
    const token = await getAccessToken();
    headers['Authorization'] = `Bearer ${token}`;
    console.log('[KYC] Authorization header added');
  } catch (err) {
    console.warn('[KYC] Could not obtain Bearer token:', err.message);
    // Don't throw - let the request fail gracefully with MTN's error
  }

  return headers;
}

function isValidCustomerId(id) {
  return typeof id === 'string' && id.trim().length > 0;
}

function isValidDate(d) {
  return !d || /^\d{4}-\d{2}-\d{2}$/.test(d);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /health
 * Returns server status and OAuth configuration check
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
    timestamp: new Date().toISOString(),
    oauth: {
      tokenUrl: MTN_TOKEN_URL,
      configured,
      tokenStatus,
      tokenCached: !!cachedToken,
    },
    endpoints: {
      kyc: `${MTN_KYC_BASE}/customers/{customerId}/kyc`,
    },
  });
});

/**
 * POST /kyc/lookup
 * 
 * According to MTN docs:
 * GET https://api.mtn.com/v1/customers/customers/{customerId}/kyc?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * 
 * Headers required:
 * - Content-Type: application/json
 * - transactionId: 5-20 chars (alphanumeric + +/=.-)
 * - Authorization: Bearer {access_token}
 */
app.post('/kyc/lookup', async (req, res) => {
  const { customerId, startDate, endDate } = req.body || {};

  if (!isValidCustomerId(customerId)) {
    return res.status(400).json({
      statusCode: '4001',
      statusMessage: 'customerId is required. Provide MSISDN (E.123 format like +233201234567), email, or MTN customer ID.',
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
  
  // IMPORTANT: MTN endpoint has double "/customers/" as shown in their docs
  // GET /v1/customers/customers/{customerId}/kyc
  const mtnUrl = new URL(`${MTN_KYC_BASE}/customers/${encodeURIComponent(customerId)}/kyc`);
  
  if (startDate) mtnUrl.searchParams.set('startDate', startDate);
  if (endDate) mtnUrl.searchParams.set('endDate', endDate);

  console.log(`[${new Date().toISOString()}] KYC request → ${mtnUrl.toString()}`);
  console.log(`[${new Date().toISOString()}] Transaction ID: ${transactionId}`);
  console.log(`[${new Date().toISOString()}] Customer ID: ${customerId}`);

  try {
    const headers = await buildMtnHeaders(transactionId);
    console.log('[KYC] Headers:', Object.keys(headers));

    const mtnResponse = await fetch(mtnUrl.toString(), {
      method: 'GET',
      headers: headers,
    });

    const responseBody = await mtnResponse.text();
    let parsedBody;
    
    try {
      parsedBody = JSON.parse(responseBody);
    } catch (e) {
      console.error('[KYC] Non-JSON response from MTN:', responseBody.substring(0, 500));
      return res.status(502).json({
        statusCode: '5020',
        statusMessage: 'MTN API returned non-JSON response',
        supportMessage: 'The MTN API may be unavailable or returned an error page.',
        transactionId,
        timestamp: new Date().toISOString(),
      });
    }

    // Return the response with metadata
    return res.status(mtnResponse.status).json({
      ...parsedBody,
      _meta: {
        proxyTransactionId: transactionId,
        mtnHttpStatus: mtnResponse.status,
        requestedCustomerId: customerId,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('[KYC Error]', error.message);
    return res.status(500).json({
      statusCode: '5000',
      statusMessage: 'Proxy error contacting MTN KYC API',
      supportMessage: error.message,
      transactionId,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /kyc/:customerId - Legacy GET endpoint for compatibility
 */
app.get('/kyc/:customerId', async (req, res) => {
  const { customerId } = req.params;
  const { startDate, endDate } = req.query;

  // Reuse the POST logic by creating a synthetic request
  req.body = { customerId, startDate, endDate };
  return app.handle(req, res, '/kyc/lookup');
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const keyOk = MTN_CONSUMER_KEY ? '✓ configured' : '✗ MISSING';
  const secretOk = MTN_CONSUMER_SECRET ? '✓ configured' : '✗ MISSING';
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║                    MTN KYC Proxy Server v2.0                          ║
╠═══════════════════════════════════════════════════════════════════════╣
║  Server running on:  http://localhost:${PORT}                            ║
║                                                                       ║
║  Endpoints:                                                           ║
║    POST /kyc/lookup     - Main KYC lookup endpoint                    ║
║    GET  /kyc/:id        - Legacy GET endpoint                         ║
║    GET  /health         - Health check                                ║
║                                                                       ║
║  MTN API Configuration:                                               ║
║    Token URL: ${MTN_TOKEN_URL}              ║
║    KYC Base:  ${MTN_KYC_BASE}                          ║
║                                                                       ║
║  Credentials:                                                         ║
║    Consumer Key:  ${keyOk.padEnd(38)}║
║    Consumer Secret: ${secretOk.padEnd(37)}║
║                                                                       ║
║  ⚠️  Make sure MTN_CONSUMER_KEY and MTN_CONSUMER_SECRET are set in .env ║
╚═══════════════════════════════════════════════════════════════════════╝
  `);
});

// Export for testing
module.exports = app;
