// ============================================================
// DataFlow GH — Backend Server v2.0
// Endpoints:
//   GET  /health
//   GET  /api/bundles?network=mtn|telecel|airteltigo
//   POST /deliver
//   POST /api/webhook/paystack
//   GET  /api/kyc/lookup?phone=024XXXXXXX
//   GET  /api/order-status?orderId=DF-xxx
// ============================================================

require('dotenv').config();

const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors({ origin: '*' }));

// Raw body for Paystack webhook signature verification
app.use('/api/webhook/paystack', express.raw({ type: 'application/json' }));

// JSON for everything else
app.use(express.json());

// ============================================================
// CONFIG
// ============================================================
const PAYSTACK_SECRET      = process.env.PAYSTACK_SECRET_KEY   || '';
const REMADATA_BASE        = process.env.REMADATA_BASE         || 'https://api.remadata.net';
const REMADATA_TOKEN       = process.env.REMADATA_TOKEN        || '';
const REMADATA_SENDER      = process.env.REMADATA_SENDER       || '';
const MTN_CONSUMER_KEY     = process.env.MTN_CONSUMER_KEY      || '';
const MTN_CONSUMER_SECRET  = process.env.MTN_CONSUMER_SECRET   || '';
// Docs: https://api.mtn.com/v1/oauth/access_token?grant_type=client_credentials
// YAML: https://api.mtn.com/oauth/client_credential/accesstoken?grant_type=client_credentials
// Using docs URL (v1 path) — change to YAML path if this 400s again
const MTN_OAUTH_URL        = 'https://api.mtn.com/v1/oauth/access_token';
const MTN_KYC_BASE         = 'https://api.mtn.com/v1/customers';
const FIREBASE_DB_URL      = process.env.FIREBASE_DATABASE_URL || '';

// ============================================================
// FIREBASE ADMIN INIT
// ============================================================
let db = null;
try {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    let credential;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      // Render: paste JSON as env var string
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      credential = admin.credential.cert(sa);
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      // Local: path to service account file
      credential = admin.credential.applicationDefault();
    }
    if (credential) {
      admin.initializeApp({ credential, databaseURL: FIREBASE_DB_URL });
      db = admin.database();
      console.log('✅ Firebase Admin connected');
    } else {
      console.warn('⚠️  No Firebase credentials — orders will not be saved to DB');
    }
  }
} catch (e) {
  console.warn('⚠️  Firebase Admin init failed:', e.message);
}

// ============================================================
// MTN OAUTH — TOKEN CACHE
// ============================================================
let mtnTokenCache = { token: null, expiresAt: 0 };

async function getMtnAccessToken() {
  const now = Date.now();
  if (mtnTokenCache.token && now < mtnTokenCache.expiresAt - 60000) {
    return mtnTokenCache.token;
  }
  if (!MTN_CONSUMER_KEY || !MTN_CONSUMER_SECRET) {
    throw new Error('MTN_CONSUMER_KEY or MTN_CONSUMER_SECRET not configured');
  }
  console.log('🔑 Fetching new MTN OAuth token…');

  // Matches docs curl exactly:
  // POST /v1/oauth/access_token?grant_type=client_credentials
  // Body: client_id={key}&client_secret={secret}
  const body = new URLSearchParams();
  body.append('client_id',     MTN_CONSUMER_KEY);
  body.append('client_secret', MTN_CONSUMER_SECRET);

  let response;
  try {
    response = await axios.post(
      `${MTN_OAUTH_URL}?grant_type=client_credentials`,
      body.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
      }
    );
  } catch (err) {
    // Log full MTN error so we can debug from Render logs
    console.error('❌ MTN token request failed:');
    console.error('   Status :', err.response?.status);
    console.error('   Body   :', JSON.stringify(err.response?.data));
    console.error('   URL    :', MTN_OAUTH_URL + '?grant_type=client_credentials');
    console.error('   Key    :', MTN_CONSUMER_KEY?.substring(0, 8) + '…');
    throw err;
  }
  const { access_token, expires_in } = response.data;
  if (!access_token) throw new Error('No access_token in MTN response');

  const expiresMs = (parseInt(expires_in, 10) || 3599) * 1000;
  mtnTokenCache = { token: access_token, expiresAt: now + expiresMs };
  console.log(`✅ MTN token valid for ${Math.round(expiresMs / 60000)} min`);
  return access_token;
}

// ============================================================
// HELPERS
// ============================================================
function toE164(phone) {
  let p = phone.replace(/\s+/g, '').replace(/-/g, '');
  if (p.startsWith('+')) p = p.substring(1);
  if (p.startsWith('0')) p = '233' + p.substring(1);
  return p;
}

function isValidMtn(phone) {
  const clean = phone.replace(/\s+/g, '').replace(/-/g, '');
  const mtnPrefixes = ['024', '054', '055', '059', '053'];
  if (clean.startsWith('0'))   return mtnPrefixes.includes(clean.substring(0, 3));
  if (clean.startsWith('233')) return mtnPrefixes.includes(clean.substring(3, 6));
  return false;
}

const NETWORK_MAP = {
  mtn:        'MTN',
  telecel:    'TELECEL',
  airteltigo: 'AIRTELTIGO',
  at:         'AIRTELTIGO'
};

async function saveOrder(orderId, data) {
  if (!db) return;
  try {
    await db.ref('orders/' + orderId).set(data);
  } catch (e) {
    console.warn('Firebase write failed:', e.message);
  }
}

async function updateOrder(orderId, data) {
  if (!db) return;
  try {
    await db.ref('orders/' + orderId).update(data);
  } catch (e) {
    console.warn('Firebase update failed:', e.message);
  }
}

// ============================================================
// GET /health
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status:             'OK',
    version:            '2.0.0',
    timestamp:          new Date().toISOString(),
    firebase:           !!db,
    kycConfigured:      !!(MTN_CONSUMER_KEY && MTN_CONSUMER_SECRET),
    remaDataConfigured: !!REMADATA_TOKEN,
    paystackConfigured: !!PAYSTACK_SECRET,
    endpoints: [
      'GET  /health',
      'GET  /api/bundles?network=mtn|telecel|airteltigo',
      'POST /deliver',
      'POST /api/webhook/paystack',
      'GET  /api/kyc/lookup?phone=024XXXXXXX',
      'GET  /api/order-status?orderId=DF-xxx'
    ]
  });
});

// ============================================================
// GET /api/bundles?network=mtn|telecel|airteltigo
// ============================================================
app.get('/api/bundles', async (req, res) => {
  const { network } = req.query;
  if (!network) {
    return res.status(400).json({ status: 'error', message: 'network param required' });
  }
  const remaNetwork = NETWORK_MAP[network.toLowerCase()];
  if (!remaNetwork) {
    return res.status(400).json({ status: 'error', message: `Unknown network: ${network}` });
  }
  if (!REMADATA_TOKEN) {
    return res.status(503).json({ status: 'error', message: 'Bundle provider not configured' });
  }
  try {
    console.log(`📦 Fetching ${remaNetwork} bundles from RemaData…`);
    const response = await axios.get(`${REMADATA_BASE}/api/v1/bundles`, {
      headers: { 'Authorization': `Bearer ${REMADATA_TOKEN}`, 'Accept': 'application/json' },
      params:  { network: remaNetwork },
      timeout: 12000
    });
    const raw     = response.data?.data || response.data || [];
    const bundles = (Array.isArray(raw) ? raw : [])
      .map(b => ({
        volumeInMB: Number(b.volume || b.volumeInMB || b.size || 0),
        price:      parseFloat(b.price || b.amount || 0),
        name:       b.name || b.description || '',
        network:    remaNetwork
      }))
      .filter(b => b.volumeInMB > 0 && b.price > 0);

    console.log(`✅ ${bundles.length} bundles returned for ${remaNetwork}`);
    res.json({ status: 'success', data: bundles });
  } catch (err) {
    console.error('❌ Bundles error:', err.response?.status, err.message);
    res.status(502).json({
      status:  'error',
      message: err.response?.data?.message || 'Failed to fetch bundles'
    });
  }
});

// ============================================================
// POST /deliver
// Body: { phone, networkType, volumeInMB, ref, orderId? }
// ============================================================
app.post('/deliver', async (req, res) => {
  const { phone, networkType, volumeInMB, ref, orderId } = req.body;

  console.log('\n📦 Deliver request:', { phone, networkType, volumeInMB, ref });

  if (!phone || !networkType || !volumeInMB || !ref) {
    return res.status(400).json({
      status:  'error',
      message: 'Missing required fields: phone, networkType, volumeInMB, ref'
    });
  }
  if (!REMADATA_TOKEN) {
    return res.status(503).json({ status: 'error', message: 'Delivery provider not configured' });
  }

  const remaNetwork = NETWORK_MAP[networkType.toLowerCase()] || networkType.toUpperCase();
  const e164phone   = toE164(phone);

  const payload = {
    phone:   e164phone,
    network: remaNetwork,
    volume:  Number(volumeInMB),
    ref:     ref,
    sender:  REMADATA_SENDER
  };

  console.log('📤 RemaData payload:', payload);

  try {
    const response = await axios.post(`${REMADATA_BASE}/api/v1/send`, payload, {
      headers: {
        'Authorization': `Bearer ${REMADATA_TOKEN}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json'
      },
      timeout: 30000
    });

    const result = response.data;
    console.log('✅ RemaData response:', JSON.stringify(result));

    if (result.status === 'success' || result.success === true) {
      const providerRef = result.reference || result.data?.reference || ref;
      if (orderId) {
        await updateOrder(orderId, {
          status:         'completed',
          deliveryStatus: 'delivered',
          deliveryTime:   new Date().toISOString(),
          providerRef
        });
      }
      return res.json({
        status:    'success',
        message:   result.message || 'Bundle delivered successfully',
        reference: providerRef,
        orderId:   orderId || ref
      });
    } else {
      console.warn('⚠️ RemaData non-success:', result);
      if (orderId) await updateOrder(orderId, { status: 'paid-pending-delivery', deliveryError: result.message });
      return res.status(400).json({
        status:  'error',
        message: result.message || 'Delivery failed at provider'
      });
    }
  } catch (err) {
    console.error('❌ Delivery error:', err.response?.status, err.response?.data || err.message);
    if (orderId) await updateOrder(orderId, { status: 'paid-pending-delivery', error: err.message });
    return res.status(502).json({
      status:  'error',
      message: err.response?.data?.message || 'Delivery request failed — payment was received'
    });
  }
});

// ============================================================
// POST /api/webhook/paystack
// Verifies Paystack signature, auto-delivers on charge.success
// ============================================================
app.post('/api/webhook/paystack', async (req, res) => {
  // Verify signature
  const signature = req.headers['x-paystack-signature'];
  if (!PAYSTACK_SECRET || !signature) {
    return res.status(400).json({ error: 'Missing signature or secret' });
  }
  const hash = crypto
    .createHmac('sha512', PAYSTACK_SECRET)
    .update(req.body)
    .digest('hex');

  if (hash !== signature) {
    console.warn('⚠️ Invalid Paystack webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Parse event
  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  console.log(`\n🔔 Paystack webhook: ${event.event}`);

  // Acknowledge immediately
  res.json({ received: true });

  if (event.event !== 'charge.success') return;

  const data       = event.data;
  const ref        = data.reference;
  const meta       = data.metadata || {};
  const phone      = meta.phone      || data.customer?.phone || '';
  const networkType= meta.networkType|| 'mtn';
  const volumeInMB = Number(meta.volumeInMB || 0);
  const orderId    = meta.orderId    || ('DF-' + Date.now());
  const name       = meta.custom_fields?.find(f => f.variable_name === 'name')?.value || '';
  const email      = data.customer?.email || '';
  const amount     = data.amount / 100;

  console.log(`✅ Payment confirmed: ${ref} | ${phone} | ${volumeInMB}MB | ${networkType}`);

  // Save order to Firebase if not already there
  if (db) {
    const existing = await db.ref('orders/' + orderId).once('value');
    if (!existing.val()) {
      await saveOrder(orderId, {
        orderId, ref, phone, email, name,
        networkType, volumeInMB,
        amount, status: 'paid',
        deliveryStatus: 'pending',
        timestamp: new Date().toISOString(),
        source: 'webhook'
      });
    }
  }

  if (!phone || !volumeInMB) {
    console.warn('⚠️ Webhook missing phone or volumeInMB — skipping delivery');
    return;
  }

  // Deliver
  try {
    const remaNetwork = NETWORK_MAP[networkType.toLowerCase()] || 'MTN';
    const payload = {
      phone:   toE164(phone),
      network: remaNetwork,
      volume:  volumeInMB,
      ref:     ref,
      sender:  REMADATA_SENDER
    };
    const response = await axios.post(`${REMADATA_BASE}/api/v1/send`, payload, {
      headers: {
        'Authorization': `Bearer ${REMADATA_TOKEN}`,
        'Content-Type':  'application/json'
      },
      timeout: 30000
    });
    const result = response.data;
    if (result.status === 'success' || result.success === true) {
      await updateOrder(orderId, {
        status: 'completed', deliveryStatus: 'delivered',
        deliveryTime: new Date().toISOString(),
        providerRef: result.reference || result.data?.reference || ref
      });
      console.log(`✅ Webhook delivery success for ${orderId}`);
    } else {
      await updateOrder(orderId, { status: 'paid-pending-delivery', deliveryError: result.message });
      console.warn('⚠️ Webhook delivery failed:', result.message);
    }
  } catch (err) {
    await updateOrder(orderId, { status: 'paid-pending-delivery', error: err.message });
    console.error('❌ Webhook delivery error:', err.message);
  }
});

// ============================================================
// GET /api/kyc/lookup?phone=024XXXXXXX
// MTN KYC — OAuth 2.0 Bearer token (auto-refresh)
// ============================================================
app.get('/api/kyc/lookup', async (req, res) => {
  const { phone } = req.query;

  if (!phone) {
    return res.status(400).json({ success: false, error: 'phone param required', code: 'MISSING_PHONE' });
  }
  if (!isValidMtn(phone)) {
    return res.status(400).json({
      success: false,
      error:   'Not an MTN number. MTN numbers start with 024, 054, 055, 053, or 059',
      code:    'INVALID_NETWORK'
    });
  }
  if (!MTN_CONSUMER_KEY || !MTN_CONSUMER_SECRET) {
    return res.status(503).json({
      success: false,
      error:   'KYC service not configured — contact support',
      code:    'NOT_CONFIGURED'
    });
  }

  const formattedPhone  = toE164(phone);
  const transactionId   = `DF-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  const url             = `${MTN_KYC_BASE}/${formattedPhone}/kyc`;

  console.log(`\n📞 KYC lookup: ${phone} → ${formattedPhone}`);

  let accessToken;
  try {
    accessToken = await getMtnAccessToken();
  } catch (tokenErr) {
    console.error('❌ Token error:', tokenErr.message);
    if (tokenErr.response) {
      console.error('   Status:', tokenErr.response.status);
      console.error('   Body:',   JSON.stringify(tokenErr.response.data));
    }
    return res.status(503).json({
      success: false,
      error:   'Could not authenticate with MTN. Check consumer credentials.',
      code:    'TOKEN_ERROR'
    });
  }

  try {
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'x-api-key':     MTN_CONSUMER_KEY,   // YAML supports both; send both for safety
        'Accept':        'application/json',
        'transactionId': transactionId
      },
      timeout: 20000
    });

    const kycData = response.data?.data || response.data;
    const firstName = kycData?.firstName || '';
    const lastName  = kycData?.lastName  || '';

    console.log(`✅ KYC success: ${firstName} ${lastName}`);

    return res.json({
      success: true,
      data: {
        firstName,
        lastName,
        fullName:    `${firstName} ${lastName}`.trim(),
        idType:      kycData?.idType      || null,
        idNumber:    kycData?.idNumber    || null,
        dateOfBirth: kycData?.dateOfBirth || null,
        gender:      kycData?.gender      || null
      },
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    const status = err.response?.status;
    console.error(`❌ KYC error ${status}:`, err.response?.data || err.message);

    // Clear token cache on 401 so next call re-fetches
    if (status === 401) mtnTokenCache = { token: null, expiresAt: 0 };

    const errorMap = {
      401: 'MTN session expired — please try again',
      403: 'KYC permission not enabled on your MTN app',
      404: 'Customer not found in MTN records',
      400: 'Invalid phone number format'
    };
    return res.status(status || 502).json({
      success: false,
      error:   errorMap[status] || err.response?.data?.message || 'KYC lookup failed',
      code:    'KYC_ERROR'
    });
  }
});

// ============================================================
// GET /api/order-status?orderId=DF-xxx
// ============================================================
app.get('/api/order-status', async (req, res) => {
  const { orderId, phone } = req.query;
  if (!orderId && !phone) {
    return res.status(400).json({ status: 'error', message: 'orderId or phone required' });
  }
  if (!db) {
    return res.status(503).json({ status: 'error', message: 'Database not configured' });
  }
  try {
    if (orderId) {
      const snap = await db.ref('orders/' + orderId).once('value');
      const order = snap.val();
      if (!order) return res.status(404).json({ status: 'error', message: 'Order not found' });
      return res.json({ status: 'success', data: order });
    }
    // Search by phone
    const snap = await db.ref('orders').orderByChild('phone').equalTo(phone).once('value');
    const data  = snap.val();
    if (!data) return res.status(404).json({ status: 'error', message: 'No orders found for this number' });
    const orders = Object.values(data).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return res.json({ status: 'success', data: orders });
  } catch (err) {
    console.error('Order status error:', err.message);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║   🚀 DataFlow Backend v2.0                                   ║
║   📡 Port:      ${String(PORT).padEnd(45)}║
║   🔥 Firebase:  ${(db ? '✅ Connected' : '❌ Not configured').padEnd(45)}║
║   🔑 MTN KYC:   ${((MTN_CONSUMER_KEY && MTN_CONSUMER_SECRET) ? '✅ Configured' : '❌ Missing KEY/SECRET').padEnd(45)}║
║   📦 RemaData:  ${(REMADATA_TOKEN ? '✅ Configured' : '❌ Missing TOKEN').padEnd(45)}║
║   💳 Paystack:  ${(PAYSTACK_SECRET ? '✅ Configured' : '❌ Missing SECRET').padEnd(45)}║
╚══════════════════════════════════════════════════════════════╝`);
});

module.exports = app;
