/**
 * DataFlow GH — Chenosis KYC Backend Server
 * Handles both KYC endpoints from Chenosis (MTN Ghana):
 *
 *  1. KYC Details  (/v1/gha/kyc-details)
 *     → Sends SMS/USSD consent to customer → MTN calls back with full name/DOB/ID
 *     → Best for auto-filling name at checkout (needs customer approval)
 *
 *  2. KYC Verify  (/kycVerify/gh/v1)
 *     → You submit known customer data, API returns match % scores
 *     → Best for verifying info you already have
 *
 * Routes exposed to your frontend (index.html):
 *   POST /kyc/details          → trigger consent + wait for callback
 *   POST /kyc/verify           → verify submitted data
 *   POST /kyc/callback         → Chenosis posts KYC data here after consent
 *   GET  /kyc/result/:txnId    → frontend polls this to get name after consent
 *   GET  /kyc/health           → health check
 */

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

// ─── CONFIG — set all of these in Render → Environment Variables ──────────────
const CHENOSIS_CLIENT_ID     = process.env.CHENOSIS_CLIENT_ID     || 'YOUR_CLIENT_ID';
const CHENOSIS_CLIENT_SECRET = process.env.CHENOSIS_CLIENT_SECRET || 'YOUR_CLIENT_SECRET';
const CHENOSIS_OAUTH_URL     = 'https://api.chenosis.io/oauth/client/accesstoken?grant_type=client_credentials';
const KYC_DETAILS_BASE       = 'https://api.chenosis.io/v1/gha/kyc-details';
const KYC_VERIFY_BASE        = 'https://api.chenosis.io/kycVerify/gh/v1';
const MY_SERVER_URL          = process.env.MY_SERVER_URL || 'https://YOUR-SERVER.onrender.com';
const COMPANY_NAME           = process.env.COMPANY_NAME  || 'DataFlow GH';
const PORT                   = process.env.PORT          || 3001;
// ─────────────────────────────────────────────────────────────────────────────

// ─── In-memory store for pending consent results ──────────────────────────────
// Key: transactionId  Value: { status, name, data, resolvedAt, createdAt }
const consentResults = new Map();

// Clean up entries older than 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [key, val] of consentResults) {
    if (val.createdAt < cutoff) consentResults.delete(key);
  }
}, 30 * 60 * 1000);
// ─────────────────────────────────────────────────────────────────────────────

// ─── OAuth Token Cache ────────────────────────────────────────────────────────
let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  if (tokenCache.token && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }

  const b64 = Buffer.from(`${CHENOSIS_CLIENT_ID}:${CHENOSIS_CLIENT_SECRET}`).toString('base64');

  const res = await fetch(CHENOSIS_OAUTH_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${b64}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OAuth ${res.status}: ${txt}`);
  }

  const json = await res.json();
  tokenCache = {
    token:     json.access_token,
    expiresAt: Date.now() + (parseInt(json.expires_in, 10) || 3599) * 1000,
  };

  console.log('[KYC] Token refreshed, expires in', json.expires_in, 's');
  return tokenCache.token;
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Phone helpers ────────────────────────────────────────────────────────────
function toE164(phone) {
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('233')) return d;
  if (d.startsWith('0'))   return '233' + d.slice(1);
  if (d.length === 9)      return '233' + d;
  return d;
}

function isMTNGhana(msisdn) {
  const prefix = msisdn.slice(3, 5);
  return ['24','25','53','54','55','59'].includes(prefix);
}
// ─────────────────────────────────────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 1: POST /kyc/details
// Sends an SMS or USSD consent prompt to the customer.
// Chenosis calls /kyc/callback when the customer approves.
// Frontend then polls /kyc/result/:txnId for the name.
//
// Body: { phone: "024XXXXXXX", consentType: "sms" | "ussd" }
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/kyc/details', async (req, res) => {
  const { phone, consentType = 'sms' } = req.body;

  if (!phone) return res.status(400).json({ status: 'error', message: 'phone required' });

  const msisdn = toE164(phone);

  if (!isMTNGhana(msisdn)) {
    return res.json({
      status:  'not_mtn',
      message: 'KYC Details only available for MTN Ghana numbers',
      name:    null,
    });
  }

  const transactionId = crypto.randomUUID();

  consentResults.set(transactionId, {
    status:    'pending',
    name:      null,
    data:      null,
    createdAt: Date.now(),
  });

  try {
    const token       = await getToken();
    const callbackUrl = `${MY_SERVER_URL}/kyc/callback?txn=${transactionId}`;

    const chRes = await fetch(`${KYC_DETAILS_BASE}/customers/${msisdn}`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'transactionId': transactionId,
      },
      body: JSON.stringify({
        consentType,
        companyName: COMPANY_NAME,
        callbackUrl,
      }),
    });

    const chData = await chRes.json();
    console.log('[KYC Details] Chenosis:', chRes.status, JSON.stringify(chData));

    if (chRes.ok && chData.statusCode === '0000') {
      return res.json({
        status:        'consent_sent',
        transactionId,
        message:       `Consent request sent to ${phone} via ${consentType.toUpperCase()}`,
        chenosisMsg:   chData.statusMessage,
      });
    }

    consentResults.delete(transactionId);
    return res.status(chRes.status).json({
      status:  'error',
      message: chData.statusMessage || 'Chenosis error',
      code:    chData.statusCode,
    });

  } catch (err) {
    console.error('[KYC Details] Error:', err.message);
    consentResults.delete(transactionId);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 2: POST /kyc/callback
// Chenosis POSTs here after customer approves the consent SMS/USSD.
// Stores the name so the frontend can retrieve it via /kyc/result/:txnId
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/kyc/callback', (req, res) => {
  const txnId = req.query.txn;
  const body  = req.body;

  console.log('[KYC Callback] txn:', txnId, JSON.stringify(body));

  // Always 200 immediately so Chenosis doesn't retry
  res.status(200).json({ statusCode: '0000', statusMessage: 'Received' });

  if (!txnId || !consentResults.has(txnId)) {
    console.warn('[KYC Callback] Unknown txnId:', txnId);
    return;
  }

  const data      = body?.data || body;
  const firstName = data?.firstName || '';
  const lastName  = data?.lastName  || '';
  const fullName  = `${firstName} ${lastName}`.trim() || null;

  consentResults.set(txnId, {
    status:     fullName ? 'resolved' : 'no_data',
    name:       fullName,
    data,
    resolvedAt: Date.now(),
    createdAt:  consentResults.get(txnId)?.createdAt || Date.now(),
  });

  console.log('[KYC Callback] Resolved:', fullName, 'for txn:', txnId);
});


// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 3: GET /kyc/result/:txnId
// Frontend polls this every 3 seconds waiting for consent approval.
// Returns: { status: "pending" | "resolved" | "no_data" | "not_found", name }
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/kyc/result/:txnId', (req, res) => {
  const result = consentResults.get(req.params.txnId);
  if (!result) return res.status(404).json({ status: 'not_found' });

  return res.json({ status: result.status, name: result.name });
});


// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 4: POST /kyc/verify
// Cross-checks data the customer typed against MTN's records.
// Returns a match score per field (0–100). 100 = exact match.
// Useful for fraud-checking after checkout.
//
// Body: { phone, firstName, lastName, emailAddress, nationalIdNumber,
//          streetAddress, city, postCode, country }
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/kyc/verify', async (req, res) => {
  const { phone, firstName, lastName, emailAddress = '',
          nationalIdNumber = '', streetAddress = '',
          city = '', postCode = '', country = 'Ghana' } = req.body;

  if (!phone || !firstName || !lastName) {
    return res.status(400).json({
      status: 'error', message: 'phone, firstName, and lastName are required',
    });
  }

  const msisdn = toE164(phone);

  try {
    const token = await getToken();

    const chRes = await fetch(`${KYC_VERIFY_BASE}/customers/${msisdn}`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        firstName, lastName,
        phoneNumber:      msisdn,
        emailAddress,
        nationalIdNumber,
        streetAddress,
        city, postCode, country,
      }),
    });

    const chData = await chRes.json();
    console.log('[KYC Verify] Chenosis:', chRes.status, JSON.stringify(chData));

    if (!chRes.ok) {
      return res.status(chRes.status).json({
        status:  'error',
        message: chData.statusMessage || 'Verification failed',
        code:    chData.statusCode,
      });
    }

    const scores    = chData?.data || {};
    const nameScore = Math.round(((scores.firstName || 0) + (scores.lastName || 0)) / 2);

    return res.json({
      status:        'verified',
      nameScore,
      scores,
      customerId:    chData.customerId,
      transactionId: chData.transactionId,
    });

  } catch (err) {
    console.error('[KYC Verify] Error:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/kyc/health', (_req, res) => {
  res.json({
    status:          'ok',
    service:         'DataFlow GH KYC Server',
    tokenCached:     !!tokenCache.token,
    tokenExpiresIn:  Math.max(0, Math.round((tokenCache.expiresAt - Date.now()) / 1000)) + 's',
    pendingConsents: consentResults.size,
  });
});

app.listen(PORT, () => console.log(`✅ DataFlow KYC server on port ${PORT}`));
