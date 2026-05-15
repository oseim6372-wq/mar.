/**
 * MTN Customer KYC API - Backend Proxy Server (PRODUCTION READY)
 * 
 * Based on MTN documentation - credentials in URL query parameters
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

// Get credentials from environment
const MTN_CONSUMER_KEY    = process.env.MTN_CONSUMER_KEY    || '';
const MTN_CONSUMER_SECRET = process.env.MTN_CONSUMER_SECRET || '';

const PORT = process.env.PORT || 3000;

let cachedToken  = null;
let tokenExpires = 0;

/**
 * Fetches access_token using URL query parameters (per MTN docs)
 * 
 * The correct format from MTN documentation:
 * POST https://api.mtn.com/v1/oauth/access_token?grant_type=client_credentials&client_id=KEY&client_secret=SECRET
 */
async function getAccessToken() {
  // Return cached token if still valid
  if (cachedToken && Date.now() < tokenExpires) {
    console.log('[OAuth] Using cached token (valid for', Math.round((tokenExpires - Date.now()) / 1000), 'seconds)');
    return cachedToken;
  }

  if (!MTN_CONSUMER_KEY || !MTN_CONSUMER_SECRET) {
    console.error('[OAuth] ERROR: Missing credentials');
    throw new Error('MTN_CONSUMER_KEY and MTN_CONSUMER_SECRET must be set in .env file');
  }

  // URL encode credentials to handle special characters
  const encodedKey = encodeURIComponent(MTN_CONSUMER_KEY);
  const encodedSecret = encodeURIComponent(MTN_CONSUMER_SECRET);
  
  // Build URL with credentials as query parameters (EXACTLY as MTN docs show)
  const tokenUrl = `${MTN_TOKEN_URL}?grant_type=client_credentials&client_id=${encodedKey}&client_secret=${encodedSecret}`;
  
  console.log('[OAuth] Fetching new token...');
  console.log(`[OAuth] Token URL: ${MTN_TOKEN_URL}?grant_type=client_credentials&client_id=${MTN_CONSUMER_KEY.substring(0, 10)}...&client_secret=***`);
  
  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      // Empty body because all params are in URL
    });

    const responseText = await response.text();
    console.log(`[OAuth] Response status: ${response.status}`);
    console.log(`[OAuth] Response body preview: ${responseText.substring(0, 300)}`);

    if (!response.ok) {
      // Parse the error response if possible
      let errorDetail = responseText;
      try {
        const errorJson = JSON.parse(responseText);
        errorDetail = errorJson.supportMessage || errorJson.statusMessage || responseText;
      } catch(e) {}
      
      throw new Error(`${errorDetail}`);
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

    console.log(`[OAuth] ✅ TOKEN OBTAINED SUCCESSFULLY!`);
    console.log(`[OAuth] Token: ${cachedToken.substring(0, 40)}...`);
    console.log(`[OAuth] Expires in: ${expiresIn} seconds`);
    console.log(`[OAuth] API Products: ${data.api_product_list || 'Not specified'}`);
    
    return cachedToken;
  } catch (error) {
    console.error(`[OAuth] ❌ ERROR:`, error.message);
    throw error;
  }
}

/**
 * Build MTN KYC request headers
 */
async function buildMtnHeaders(transactionId) {
  const token = await getAccessToken();
  
  const headers = {
    'Content-Type': 'application/json',
    'transactionId': transactionId,
    'Authorization': `Bearer ${token}`,
  };
  
  console.log('[KYC] Headers prepared (Bearer token present)');
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
 * GET /health - Comprehensive health check
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
    environment: 'production',
    timestamp: new Date().toISOString(),
    credentials: {
      hasConsumerKey: !!MTN_CONSUMER_KEY,
      hasConsumerSecret: !!MTN_CONSUMER_SECRET,
      consumerKeyPrefix: MTN_CONSUMER_KEY ? MTN_CONSUMER_KEY.substring(0, 10) : null,
    },
    oauth: {
      tokenUrl: MTN_TOKEN_URL,
      method: 'URL query parameters (grant_type, client_id, client_secret)',
      configured,
      tokenStatus,
      tokenError,
      tokenPreview,
    },
  });
});

/**
 * POST /kyc/lookup - Main KYC lookup endpoint
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
  const cleanCustomerId = customerId.replace(/^%2B/, '+');
  
  // Build KYC URL
  const mtnUrl = new URL(`${MTN_KYC_BASE}/${encodeURIComponent(cleanCustomerId)}/kyc`);
  if (startDate && isValidDate(startDate)) {
    mtnUrl.searchParams.set('startDate', startDate);
  }
  if (endDate && isValidDate(endDate)) {
    mtnUrl.searchParams.set('endDate', endDate);
  }

  console.log(`\n[KYC] ========== NEW REQUEST ==========`);
  console.log(`[KYC] Timestamp: ${new Date().toISOString()}`);
  console.log(`[KYC] URL: ${mtnUrl.toString()}`);
  console.log(`[KYC] Transaction ID: ${transactionId}`);
  console.log(`[KYC] Customer ID: ${cleanCustomerId}`);

  try {
    const headers = await buildMtnHeaders(transactionId);
    console.log(`[KYC] Making request to MTN...`);

    const mtnRes = await fetch(mtnUrl.toString(), { 
      method: 'GET', 
      headers 
    });
    
    const rawText = await mtnRes.text();
    console.log(`[KYC] MTN Response Status: ${mtnRes.status}`);
    console.log(`[KYC] MTN Response Size: ${rawText.length} bytes`);

    // Try to parse JSON response
    let mtnBody;
    try {
      mtnBody = JSON.parse(rawText);
      console.log(`[KYC] ✅ Successfully parsed JSON response`);
    } catch (e) {
      console.error(`[KYC] ❌ Failed to parse JSON: ${rawText.substring(0, 200)}`);
      
      return res.status(mtnRes.status || 502).json({
        statusCode: '5020',
        statusMessage: 'MTN API returned non-JSON response',
        supportMessage: `HTTP ${mtnRes.status}. This may indicate an API gateway error or invalid endpoint.`,
        rawPreview: rawText.substring(0, 400),
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
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error(`[KYC] ❌ Fatal Error:`, err.message);
    
    // Provide specific error messages based on error type
    if (err.message.includes('OAuth') || err.message.includes('token') || err.message.includes('invalid_client')) {
      return res.status(401).json({
        statusCode: '4000',
        statusMessage: 'Unauthorised - OAuth token generation failed',
        supportMessage: err.message,
        actionRequired: 'Verify your MTN Consumer Key and Secret in Render environment variables. Check MTN Developer Portal for subscription status.',
        transactionId,
        timestamp: new Date().toISOString(),
      });
    }
    
    if (err.message.includes('fetch') || err.message.includes('network')) {
      return res.status(503).json({
        statusCode: '5030',
        statusMessage: 'Network error - Cannot reach MTN API',
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
 * GET /kyc/:customerId - Legacy GET endpoint
 */
app.get('/kyc/:customerId', async (req, res) => {
  const { customerId } = req.params;
  const { startDate, endDate } = req.query;
  
  const transactionId = makeTransactionId();
  
  // Forward to POST handler logic
  const mtnUrl = new URL(`${MTN_KYC_BASE}/${encodeURIComponent(customerId)}/kyc`);
  if (startDate) mtnUrl.searchParams.set('startDate', startDate);
  if (endDate) mtnUrl.searchParams.set('endDate', endDate);

  try {
    const headers = await buildMtnHeaders(transactionId);
    const mtnRes = await fetch(mtnUrl.toString(), { method: 'GET', headers });
    const rawText = await mtnRes.text();
    
    let mtnBody;
    try {
      mtnBody = JSON.parse(rawText);
    } catch (e) {
      return res.status(mtnRes.status).json({
        statusCode: '5020',
        statusMessage: 'Non-JSON response',
        rawPreview: rawText.substring(0, 300),
        transactionId,
      });
    }
    
    res.status(mtnRes.status).json(mtnBody);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║                          MTN KYC PROXY SERVER v5.0                            ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║  Status:     Running                                                          ║
║  Port:       ${PORT}                                                              ║
║  OAuth URL:  ${MTN_TOKEN_URL}                         ║
║  KYC Base:   ${MTN_KYC_BASE}                                          ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║  Authentication Method:                                                       ║
║    → OAuth: Credentials as URL query parameters (per MTN docs)               ║
║    → KYC:   Bearer token in Authorization header                              ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║  Credentials Status:                                                          ║
║    Consumer Key:    ${MTN_CONSUMER_KEY ? '✅ CONFIGURED' : '❌ MISSING'} (${MTN_CONSUMER_KEY ? MTN_CONSUMER_KEY.substring(0, 15) + '...' : 'N/A'})
║    Consumer Secret: ${MTN_CONSUMER_SECRET ? '✅ CONFIGURED' : '❌ MISSING'} (${MTN_CONSUMER_SECRET ? '***' : 'N/A'})
╚═══════════════════════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
