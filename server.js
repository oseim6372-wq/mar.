/**
 * ═══════════════════════════════════════════════════════
 *  DataFlow Backend — Node.js + Express
 *  Data Delivery: RemaData API
 *  Payment:       Paystack
 *  Database:      Firebase Realtime Database
 * ═══════════════════════════════════════════════════════
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS Configuration ──
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://dataflow-admin.netlify.app'
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    } else {
      console.log('Blocked origin:', origin);
      return callback(null, true);
    }
  },
  credentials: true
}));

// ── API Keys ──
const REMA_API_KEY = process.env.REMA_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const REMA_BASE_URL = 'https://remadata.com/api';

const remaHeaders = () => ({
  'X-API-KEY': REMA_API_KEY,
  'Content-Type': 'application/json'
});

// ── Firebase Admin Init ──
let db;
try {
  let serviceAccount;
  
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('🔐 Using Firebase credentials from environment variable');
  } else {
    try {
      serviceAccount = require('./serviceAccountKey.json');
      console.log('📁 Using Firebase credentials from local file');
    } catch (localErr) {
      console.warn('⚠️  Local serviceAccountKey.json not found');
      serviceAccount = null;
    }
  }
  
  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DB_URL || 'https://stafford-2efd9-default-rtdb.firebaseio.com'
    });
    db = admin.database();
    console.log('✅ Firebase Admin initialized');
  } else {
    console.warn('⚠️  Firebase Admin not initialized - no credentials found');
  }
} catch (e) {
  console.warn('⚠️  Firebase Admin initialization error:', e.message);
}

// ── Webhook (needs raw body BEFORE JSON parser) ──
app.post('/paystack-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
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
    const data = event.data;
    const ref = data.reference;
    const metadata = data.metadata || {};
    const { phone, networkType, volumeInMB, orderId, firebaseKey } = metadata;

    if (phone && networkType && volumeInMB) {
      console.log(`💳 Payment confirmed for ${ref} — auto-delivering data...`);

      try {
        const remaRes = await axios.post(`${REMA_BASE_URL}/buy-data`, {
          ref: orderId || ref,
          phone,
          volumeInMB: parseInt(volumeInMB),
          networkType
        }, { headers: remaHeaders() });

        const ok = remaRes.data.status === 'success';
        const newStatus = ok ? 'completed' : 'paid-failed-delivery';

        if (db && firebaseKey) {
          await db.ref(`orders/${firebaseKey}`).update({
            status: newStatus,
            deliveryStatus: ok ? 'delivered' : 'failed',
            remaReference: remaRes.data.data?.reference || null,
            updatedAt: new Date().toISOString()
          });
        }

        console.log(`${ok ? '✅' : '❌'} Auto-delivery ${ok ? 'success' : 'failed'} for ${ref}`);
      } catch (err) {
        console.error('Auto-delivery error:', err.response?.data || err.message);
        if (db && firebaseKey) {
          await db.ref(`orders/${firebaseKey}`).update({
            status: 'paid-failed-delivery',
            deliveryError: err.message,
            updatedAt: new Date().toISOString()
          }).catch(() => {});
        }
      }
    }
  }

  res.sendStatus(200);
});

// ── Regular JSON parser ──
app.use(express.json());

// ════════════════════════════════════════════════════════
//  HEALTH CHECK
// ════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'DataFlow Backend',
    timestamp: new Date().toISOString(),
    firebase: db ? 'connected' : 'disconnected'
  });
});

// ════════════════════════════════════════════════════════
//  GET AVAILABLE BUNDLES
// ════════════════════════════════════════════════════════
app.get('/bundles', async (req, res) => {
  try {
    const { network } = req.query;
    const url = network ? `${REMA_BASE_URL}/bundles?network=${network}` : `${REMA_BASE_URL}/bundles`;
    const response = await axios.get(url, { headers: remaHeaders() });
    res.json({ success: true, data: response.data.data });
  } catch (err) {
    console.error('GET /bundles error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// ════════════════════════════════════════════════════════
//  CHECK REAL-TIME PRICE
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
//  DELIVER DATA
// ════════════════════════════════════════════════════════
app.post('/deliver', async (req, res) => {
  const { firebaseKey, orderId, phone, networkType, volumeInMB, amount } = req.body;

  if (!phone || !networkType || !volumeInMB) {
    return res.status(400).json({
      success: false,
      message: 'phone, networkType, and volumeInMB are required'
    });
  }

  console.log(`📦 Delivering ${volumeInMB}MB (${networkType}) → ${phone} | Order: ${orderId}`);

  try {
    const remaRes = await axios.post(`${REMA_BASE_URL}/buy-data`, {
      ref: orderId || `DF_${Date.now()}`,
      phone,
      volumeInMB,
      networkType
    }, { headers: remaHeaders() });

    const remaData = remaRes.data;
    console.log('RemaData response:', remaData);

    if (remaData.status === 'success') {
      if (db && firebaseKey) {
        await db.ref(`orders/${firebaseKey}`).update({
          status: 'completed',
          deliveryStatus: 'delivered',
          remaReference: remaData.data?.reference || null,
          remaBalance: remaData.data?.balance || null,
          updatedAt: new Date().toISOString()
        });
        console.log(`✅ Firebase updated for key: ${firebaseKey}`);
      }

      res.json({
        success: true,
        message: 'Data delivered successfully',
        remaReference: remaData.data?.reference,
        balance: remaData.data?.balance
      });
    } else {
      if (db && firebaseKey) {
        await db.ref(`orders/${firebaseKey}`).update({
          status: 'paid-failed-delivery',
          deliveryError: remaData.message || 'RemaData rejected order',
          updatedAt: new Date().toISOString()
        });
      }
      res.json({
        success: false,
        message: remaData.message || 'Delivery failed. Wallet refunded by RemaData.'
      });
    }
  } catch (err) {
    console.error('POST /deliver error:', err.response?.data || err.message);

    if (db && firebaseKey) {
      await db.ref(`orders/${firebaseKey}`).update({
        status: 'paid-failed-delivery',
        deliveryError: err.message,
        updatedAt: new Date().toISOString()
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
//  START SERVER
// ════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🚀 DataFlow backend running on port ${PORT}`);
  console.log(`   Rema API Key: ${REMA_API_KEY ? '✅ Set' : '❌ Missing'}`);
  console.log(`   Paystack Key: ${PAYSTACK_SECRET_KEY ? '✅ Set' : '❌ Missing'}`);
  console.log(`   Firebase DB:  ${db ? '✅ Connected' : '⚠️ Not connected'}`);
});

module.exports = app;
