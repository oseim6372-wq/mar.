/**
 * DataFlow GH — KYC Backend Server (v2)
 *
 * Supports TWO MTN KYC APIs:
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ API A — MTN Direct (api.mtn.com)  ← PRIMARY, USE THIS FIRST   │
 * │   GET /v1/customers/{msisdn}/kyc                                │
 * │   Auth: MTN OAuth only (no API key) ✅                          │
 * │   Returns: name instantly, no SMS consent needed               │
 * ├─────────────────────────────────────────────────────────────────┤
 * │ API B — Chenosis (api.chenosis.io) ← FALLBACK                  │
 * │   POST /v1/gha/kyc-details + callback flow                      │
 * │   Returns: name after customer approves SMS consent             │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Routes your frontend calls:
 *   POST /kyc/lookup          → MTN Direct: returns name instantly
 *   POST /kyc/details         → Chenosis consent flow (fallback)
 *   POST /kyc/callback        → Chenosis posts here after consent
 *   GET  /kyc/result/:txnId   → poll for Chenosis consent result
 *   GET  /kyc/health          → health check
 */

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

// ─── CONFIG — set in Render → Environment Variables ───────────────────────────
// MTN Direct API (api.mtn.com) — OAuth only, no API key needed
const MTN_CLIENT_ID      = process.env.MTN_CLIENT_ID      || 'YOUR_MTN_CLIENT_ID';
const MTN_CLIENT_SECRET  = process.env.MTN_CLIENT_SECRET  || 'YOUR_MTN_CLIENT_SECRET';
const MTN_OAUTH_URL      = 'https://api.mtn.com/v1/oauth/access_token';
const MTN_KYC_BASE       = 'https://api.mtn.com/v1/customers';

// Chenosis API (fallback — needs separate credentials)
const CHENOSIS_CLIENT_ID     = process.env.CHENOSIS_CLIENT_ID     || 'YOUR_CHENOSIS_CLIENT_ID';
const CHENOSIS_CLIENT_SECRET = process.env.CHENOSIS_CLIENT_SECRET || 'YOUR_CHENOSIS_CLIENT_SECRET';
const CHENOSIS_OAUTH_URL     = 'https://api.chenosis.io/oauth/client/accesstoken?grant_type=client_credentials';
const CHENOSIS_KYC_BASE      = 'https://api.chenosis.io/v1/gha/kyc-details';

const MY_SERVER_URL = process.env.MY_SERVER_URL || 'https://YOUR-SERVER.onrender.com';
const COMPANY_NAME  = process.env.COMPANY_NAME  || 'DataFlow GH';
const PORT          = process.env.PORT          || 3001;
// ─────────────────────────────────────────────────────────────────────────────


// ─── Token caches (one per API) ───────────────────────────────────────────────
const tokenCache = {
  mtn:      { token: null, expiresAt: 0 },
  chenosis: { token: null, expiresAt: 0 },
};

async function getToken(api) {
  const cache = tokenCache[api];
  if (cache.token && cache.expiresAt > Date.now() + 60_000) return cache.token;

  const configs = {
    mtn:      { url: MTN_OAUTH_URL,      id: MTN_CLIENT_ID,      secret: MTN_CLIENT_SECRET },
    chenosis: { url: CHENOSIS_OAUTH_URL, id: CHENOSIS_CLIENT_ID, secret: CHENOSIS_CLIENT_SECRET },
  };
  const { url, id, secret } = configs[api];

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}`,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`[${api}] OAuth ${res.status}: ${txt}`);
  }

  const json = await res.json();
  cache.token     = json.access_token;
  cache.expiresAt = Date.now() + (parseInt(json.expires_in, 10) || 3599) * 1000;
  console.log(`[KYC] ${api} token refreshed, expires in ${json.expires_in}s`);
  return cache.token;
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
  const prefix = msisdn.slice(3, 5); // digits after 233
  return ['24','25','53','54','55','59'].includes(prefix);
}
// ─────────────────────────────────────────────────────────────────────────────


// ─── Chenosis consent store ───────────────────────────────────────────────────
const consentResults = new Map();
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of consentResults) if (v.createdAt < cutoff) consentResults.delete(k);
}, 30 * 60 * 1000);
// ─────────────────────────────────────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 1 — POST /kyc/lookup  ← FRONTEND CALLS THIS
//
// Uses MTN Direct API (api.mtn.com/v1/customers/{msisdn}/kyc)
// Simple GET — no SMS, no polling, returns name immediately.
// Auth: Bearer token only (no API key needed)
//
// Body:     { phone: "024XXXXXXX" }
// Response: { status: "found"|"not_found"|"not_mtn"|"error", name }
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/kyc/lookup', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ status: 'error', message: 'phone required' });

  const msisdn = toE164(phone);

  if (!isMTNGhana(msisdn)) {
    return res.json({ status: 'not_mtn', name: null,
      message: 'KYC only available for MTN Ghana numbers' });
  }

  try {
    const token = await getToken('mtn');
    // transactionId: 5–20 ASCII chars per MTN spec
    const txnId = crypto.randomBytes(8).toString('hex'); // 16 chars

    const mtnRes = await fetch(`${MTN_KYC_BASE}/${msisdn}/kyc`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'transactionId': txnId,
        'Content-Type':  'application/json',
      },
    });

    console.log('[KYC Lookup] MTN status:', mtnRes.status, 'msisdn:', msisdn);

    if (mtnRes.status === 404) {
      return res.json({ status: 'not_found', name: null });
    }

    if (!mtnRes.ok) {
      const errText = await mtnRes.text();
      console.error('[KYC Lookup] MTN error:', mtnRes.status, errText);
      return res.status(502).json({ status: 'error', message: `MTN KYC error: ${mtnRes.status}` });
    }

    const body      = await mtnRes.json();
    const kycData   = body?.data || body;
    const firstName = kycData?.firstName || '';
    const lastName  = kycData?.lastName  || '';
    const fullName  = `${firstName} ${lastName}`.trim() || null;

    console.log('[KYC Lookup] Name resolved:', fullName);

    return res.json({
      status: fullName ? 'found' : 'not_found',
      name:   fullName,
      msisdn,
    });

  } catch (err) {
    console.error('[KYC Lookup] Error:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 2 — POST /kyc/details  (Chenosis fallback — requires SMS consent)
//
// Body:     { phone: "024XXXXXXX", consentType: "sms" | "ussd" }
// Response: { status: "consent_sent", transactionId }
// Then poll GET /kyc/result/:txnId every 3s for the name.
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/kyc/details', async (req, res) => {
  const { phone, consentType = 'sms' } = req.body;
  if (!phone) return res.status(400).json({ status: 'error', message: 'phone required' });

  const msisdn = toE164(phone);
  if (!isMTNGhana(msisdn)) return res.json({ status: 'not_mtn', name: null });

  const transactionId = crypto.randomUUID();
  consentResults.set(transactionId, { status: 'pending', name: null, data: null, createdAt: Date.now() });

  try {
    const token       = await getToken('chenosis');
    const callbackUrl = `${MY_SERVER_URL}/kyc/callback?txn=${transactionId}`;

    const chRes = await fetch(`${CHENOSIS_KYC_BASE}/customers/${msisdn}`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'transactionId': transactionId,
      },
      body: JSON.stringify({ consentType, companyName: COMPANY_NAME, callbackUrl }),
    });

    const chData = await chRes.json();
    console.log('[KYC Details] Chenosis:', chRes.status, JSON.stringify(chData));

    if (chRes.ok && chData.statusCode === '0000') {
      return res.json({ status: 'consent_sent', transactionId,
        message: `Consent SMS sent to ${phone}` });
    }

    consentResults.delete(transactionId);
    return res.status(chRes.status).json({
      status: 'error', message: chData.statusMessage || 'Chenosis error', code: chData.statusCode,
    });

  } catch (err) {
    consentResults.delete(transactionId);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 3 — POST /kyc/callback  (Chenosis posts here after customer approves)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/kyc/callback', (req, res) => {
  const txnId = req.query.txn;
  res.status(200).json({ statusCode: '0000', statusMessage: 'Received' });

  if (!txnId || !consentResults.has(txnId)) return;

  const data     = req.body?.data || req.body;
  const fullName = `${data?.firstName || ''} ${data?.lastName || ''}`.trim() || null;

  consentResults.set(txnId, {
    status:     fullName ? 'resolved' : 'no_data',
    name:       fullName, data,
    resolvedAt: Date.now(),
    createdAt:  consentResults.get(txnId)?.createdAt || Date.now(),
  });
  console.log('[KYC Callback] Resolved:', fullName, 'txn:', txnId);
});


// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 4 — GET /kyc/result/:txnId  (frontend polls for Chenosis consent result)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/kyc/result/:txnId', (req, res) => {
  const result = consentResults.get(req.params.txnId);
  if (!result) return res.status(404).json({ status: 'not_found' });
  return res.json({ status: result.status, name: result.name });
});


// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/kyc/health', (_req, res) => {
  res.json({
    status:              'ok',
    service:             'DataFlow GH KYC Server v2',
    mtnTokenCached:      !!tokenCache.mtn.token,
    chenosisTokenCached: !!tokenCache.chenosis.token,
    pendingConsents:     consentResults.size,
  });
});

app.listen(PORT, () => console.log(`✅ DataFlow KYC server v2 on port ${PORT}`));
