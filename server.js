/**
 * ═══════════════════════════════════════════════════════
 *  DataFlow Backend — Node.js + Express
 *  Data Delivery: RemaData API
 *  Payment:       Paystack
 *  Database:      Firebase Realtime Database
 * ═══════════════════════════════════════════════════════
 */

require('dotenv').config();
const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');
const admin    = require('firebase-admin');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Firebase Admin Init ───────────────────────────────
// Download your service account key from Firebase Console
// Project Settings → Service Accounts → Generate new private key
// Save as serviceAccountKey.json in the same folder
let db;
try {
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL || 'https://stafford-2efd9-default-rtdb.firebaseio.com'
  });
  db = admin.database();
  console.log('✅ Firebase Admin initialized');
} catch (e) {
  console.warn('⚠️  Firebase Admin not initialized:', e.message);
  console.warn('    Place serviceAccountKey.json in this folder to enable Firebase writes.');
}

// ── API Keys (from .env) ──────────────────────────────
const REMA_API_KEY        = process.env.REMA_API_KEY;        // rd_live_xxxxx
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY; // sk_live_xxxxx
const REMA_BASE_URL       = 'https://remadata.com/api';

const remaHeaders = () => ({
  'X-API-KEY': REMA_API_KEY,
  'Content-Type': 'application/json'
});

// ════════════════════════════════════════════════════════
//  HEALTH CHECK
// ════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'DataFlow Backend',
    timestamp: new Date().toISOString()
  });
});

// ════════════════════════════════════════════════════════
//  GET AVAILABLE BUNDLES
//  GET /bundles?network=mtn
// ════════════════════════════════════════════════════════
app.get('/bundles', async (req, res) => {
  try {
    const { network } = req.query;
    const url = network
      ? `${REMA_BASE_URL}/bundles?network=${network}`
      : `${REMA_BASE_URL}/bundles`;

    const response = await axios.get(url, { headers: remaHeaders() });
    res.json({ success: true, data: response.data.data });
  } catch (err) {
    console.error('GET /bundles error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// ════════════════════════════════════════════════════════
//  CHECK REAL-TIME PRICE
//  POST /check-price  { networkType, volumeInMB }
// ════════════════════════════════════════════════════════
app.post('/check-price', async (req, res) => {
  const { networkType, volumeInMB } = req.body;
  if (!networkType || !volumeInMB) {
    return res.status(400).json({ success: false, message: 'networkType and volumeInMB are required' });
  }
  try {
    const response = await axios.post(`${REMA_BASE_URL}/get-cost-price`,
      { networkType, volumeInMB },
      { headers: remaHeaders() }
    );
    res.json({ success: true, ...response.data });
  } catch (err) {
    console.error('POST /check-price error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// ════════════════════════════════════════════════════════
//  DELIVER DATA  ← Main endpoint called by admin dashboard
//  POST /deliver
//  Body: { firebaseKey, orderId, phone, networkType, volumeInMB, amount }
// ════════════════════════════════════════════════════════
app.post('/deliver', async (req, res) => {
  const { firebaseKey, orderId, phone, networkType, volumeInMB, amount } = req.body;

  // Validate
  if (!phone || !networkType || !volumeInMB) {
    return res.status(400).json({
      success: false,
      message: 'phone, networkType, and volumeInMB are required'
    });
  }

  console.log(`📦 Delivering ${volumeInMB}MB (${networkType}) → ${phone} | Order: ${orderId}`);

  try {
    // Call RemaData
    const remaRes = await axios.post(`${REMA_BASE_URL}/buy-data`, {
      ref:         orderId || `DF_${Date.now()}`,
      phone,
      volumeInMB,
      networkType
    }, { headers: remaHeaders() });

    const remaData = remaRes.data;
    console.log('RemaData response:', remaData);

    if (remaData.status === 'success') {
      // Update Firebase order status if Admin SDK is available
      if (db && firebaseKey) {
        await db.ref(`orders/${firebaseKey}`).update({
          status:          'completed',
          deliveryStatus:  'delivered',
          remaReference:   remaData.data?.reference || null,
          remaBalance:     remaData.data?.balance    || null,
          updatedAt:       new Date().toISOString()
        });
        console.log(`✅ Firebase updated for key: ${firebaseKey}`);
      }

      res.json({
        success:       true,
        message:       'Data delivered successfully',
        remaReference: remaData.data?.reference,
        balance:       remaData.data?.balance
      });

    } else {
      // RemaData returned an error / refund
      if (db && firebaseKey) {
        await db.ref(`orders/${firebaseKey}`).update({
          status:        'paid-failed-delivery',
          deliveryError: remaData.message || 'RemaData rejected order',
          updatedAt:     new Date().toISOString()
        });
      }
      res.json({
        success: false,
        message: remaData.message || 'Delivery failed. Wallet refunded by RemaData.'
      });
    }

  } catch (err) {
    console.error('POST /deliver error:', err.response?.data || err.message);

    // Mark failed in Firebase
    if (db && firebaseKey) {
      await db.ref(`orders/${firebaseKey}`).update({
        status:        'paid-failed-delivery',
        deliveryError: err.message,
        updatedAt:     new Date().toISOString()
      }).catch(() => {});
    }

    res.status(500).json({
      success: false,
      message: err.response?.data?.message || err.message
    });
  }
});

// ════════════════════════════════════════════════════════
//  WALLET BALANCE
//  GET /wallet-balance
// ════════════════════════════════════════════════════════
app.get('/wallet-balance', async (req, res) => {
  try {
    const response = await axios.get(`${REMA_BASE_URL}/wallet-balance`, {
      headers: remaHeaders()
    });
    const data = response.data;
    res.json({
      success: true,
      balance: data.data?.balance,
      currency: data.data?.currency || 'GHS',
      lastTransaction: data.data?.last_transaction_at
    });
  } catch (err) {
    console.error('GET /wallet-balance error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// ════════════════════════════════════════════════════════
//  ORDER HISTORY (from RemaData)
//  GET /rema-orders?status=completed&network=mtn&page=1
// ════════════════════════════════════════════════════════
app.get('/rema-orders', async (req, res) => {
  try {
    const params = new URLSearchParams();
    ['status', 'network', 'phone', 'start_date', 'end_date', 'page', 'per_page'].forEach(k => {
      if (req.query[k]) params.append(k, req.query[k]);
    });
    const response = await axios.get(`${REMA_BASE_URL}/orders?${params.toString()}`, {
      headers: remaHeaders()
    });
    res.json({ success: true, data: response.data });
  } catch (err) {
    console.error('GET /rema-orders error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// ════════════════════════════════════════════════════════
//  CHECK SINGLE REMA ORDER STATUS
//  GET /rema-order-status/:ref
// ════════════════════════════════════════════════════════
app.get('/rema-order-status/:ref', async (req, res) => {
  try {
    const response = await axios.get(`${REMA_BASE_URL}/order-status/${req.params.ref}`, {
      headers: remaHeaders()
    });
    res.json({ success: true, data: response.data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// ════════════════════════════════════════════════════════
//  PAYSTACK WEBHOOK
//  POST /paystack-webhook
//  Automatically triggers data delivery on successful payment
// ════════════════════════════════════════════════════════
app.post('/paystack-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  // Verify signature
  const hash = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(req.body)
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    console.warn('⚠️  Invalid Paystack webhook signature');
    return res.status(401).send('Invalid signature');
  }

  const event = JSON.parse(req.body);
  console.log('📩 Paystack webhook:', event.event);

  if (event.event === 'charge.success') {
    const data     = event.data;
    const ref      = data.reference;
    const metadata = data.metadata || {};

    // Expected metadata from your store frontend:
    // { phone, networkType, volumeInMB, orderId, firebaseKey }
    const { phone, networkType, volumeInMB, orderId, firebaseKey } = metadata;

    if (phone && networkType && volumeInMB) {
      console.log(`💳 Payment confirmed for ${ref} — auto-delivering data...`);

      try {
        // Auto-deliver via RemaData
        const remaRes = await axios.post(`${REMA_BASE_URL}/buy-data`, {
          ref:   orderId || ref,
          phone,
          volumeInMB: parseInt(volumeInMB),
          networkType
        }, { headers: remaHeaders() });

        const ok = remaRes.data.status === 'success';
        const newStatus = ok ? 'completed' : 'paid-failed-delivery';

        // Update Firebase
        if (db && firebaseKey) {
          await db.ref(`orders/${firebaseKey}`).update({
            status:        newStatus,
            deliveryStatus: ok ? 'delivered' : 'failed',
            remaReference: remaRes.data.data?.reference || null,
            updatedAt:     new Date().toISOString()
          });
        }

        console.log(`${ok ? '✅' : '❌'} Auto-delivery ${ok ? 'success' : 'failed'} for ${ref}`);

      } catch (err) {
        console.error('Auto-delivery error:', err.response?.data || err.message);
        if (db && firebaseKey) {
          await db.ref(`orders/${firebaseKey}`).update({
            status:        'paid-failed-delivery',
            deliveryError: err.message,
            updatedAt:     new Date().toISOString()
          }).catch(() => {});
        }
      }
    } else {
      console.warn('⚠️  Webhook metadata missing delivery fields — manual delivery needed');
    }
  }

  res.sendStatus(200);
});

// ── Start ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 DataFlow backend running on http://localhost:${PORT}`);
  console.log(`   Rema API Key: ${REMA_API_KEY ? '✅ Set' : '❌ Missing — check .env'}`);
  console.log(`   Paystack Key: ${PAYSTACK_SECRET_KEY ? '✅ Set' : '❌ Missing — check .env'}`);
  console.log(`   Firebase DB:  ${db ? '✅ Connected' : '⚠️  Not connected'}\n`);
});
￼Enter
