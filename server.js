require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────
const REMADATA_API_URL = 'https://remadata.com/api';
const REMADATA_API_KEY  = process.env.REMADATA_API_KEY  || 'rd_live_your_key_here';
const PAYSTACK_SECRET   = process.env.PAYSTACK_SECRET   || 'sk_live_your_paystack_secret';
const SELF_URL          = process.env.SELF_URL          || `http://localhost:${PORT}`;

// ─────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────
app.use('/webhook/paystack', express.raw({ type: 'application/json' }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────────
//  HELPER FUNCTIONS
// ─────────────────────────────────────────────

/**
 * Core delivery function - sends request to RemaData API
 * @param {string} phone        - Recipient phone number (10 digits)
 * @param {number} volumeInMB   - Data volume in MB (e.g. 1024, 2048)
 * @param {string} networkType  - 'mtn', 'telecel', or 'airteltigo'
 * @param {string} reference    - Paystack ref — used as RemaData order ref so
 *                                status lookups work via /api/order-status/:ref
 */
async function deliverData(phone, volumeInMB, networkType, reference = null) {
  // ✅ Always use the Paystack ref so Firebase ref == RemaData ref
  const orderRef = reference || `DF-${Date.now()}`;

  const payload = {
    ref:         orderRef,
    phone:       phone,
    volumeInMB:  Number(volumeInMB),
    networkType: networkType.toLowerCase()
  };

  console.log(`📦 Delivering ${volumeInMB}MB (${networkType}) → ${phone} | Ref: ${orderRef}`);
  console.log(`📤 Payload:`, JSON.stringify(payload));

  try {
    const response = await axios.post(
      `${REMADATA_API_URL}/buy-data`,
      payload,
      {
        headers: {
          'X-API-KEY':    REMADATA_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );
    console.log(`✅ Delivery success:`, response.data);
    return { success: true, data: response.data };
  } catch (error) {
    console.error(`❌ Delivery failed:`, error.response?.data || error.message);
    throw error;
  }
}

// ─────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Wallet balance
app.get('/api/balance', async (req, res) => {
  try {
    const response = await axios.get(`${REMADATA_API_URL}/wallet-balance`, {
      headers: { 'X-API-KEY': REMADATA_API_KEY },
    });
    res.json(response.data);
  } catch (err) {
    console.error('Balance error:', err.response?.data || err.message);
    res.status(500).json({
      status:  'error',
      message: err.response?.data?.message || 'Failed to fetch balance'
    });
  }
});

// Available bundles
app.get('/api/bundles', async (req, res) => {
  const { network } = req.query;
  try {
    let url = `${REMADATA_API_URL}/bundles`;
    if (network) url += `?network=${network}`;
    const response = await axios.get(url, {
      headers: { 'X-API-KEY': REMADATA_API_KEY }
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({
      status:  'error',
      message: err.response?.data?.message || 'Failed to fetch bundles'
    });
  }
});

// Check price
app.post('/api/check-price', async (req, res) => {
  const { networkType, volumeInMB } = req.body;
  if (!networkType || !volumeInMB) {
    return res.status(400).json({ status: 'error', message: 'Missing required fields: networkType, volumeInMB' });
  }
  try {
    const response = await axios.post(
      `${REMADATA_API_URL}/get-cost-price`,
      { networkType, volumeInMB: Number(volumeInMB) },
      { headers: { 'X-API-KEY': REMADATA_API_KEY, 'Content-Type': 'application/json' } }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.response?.data?.message || 'Price check failed' });
  }
});

// ─────────────────────────────────────────────
//  MAIN DELIVERY ENDPOINT  POST /deliver
//  ✅ NOW accepts `ref` from frontend so the
//     Paystack ref, Firebase ref, and RemaData
//     ref are all the same — enabling live
//     status lookups via /api/order-status/:ref
// ─────────────────────────────────────────────
app.post('/deliver', async (req, res) => {
  // ✅ FIXED: destructure `ref` from body
  let { phone, volumeInMB, networkType, ref } = req.body;

  if (!phone) return res.status(400).json({ status: 'error', message: 'Phone number is required' });
  if (!volumeInMB) return res.status(400).json({ status: 'error', message: 'volumeInMB is required (e.g. 1024 for 1GB)' });
  if (!networkType) return res.status(400).json({ status: 'error', message: 'networkType is required (mtn, telecel, airteltigo)' });

  if (!/^0[0-9]{9}$/.test(phone)) {
    return res.status(400).json({ status: 'error', message: 'Phone must be 10 digits starting with 0' });
  }

  const validNetworks = ['mtn', 'telecel', 'airteltigo'];
  if (!validNetworks.includes(networkType.toLowerCase())) {
    return res.status(400).json({ status: 'error', message: 'networkType must be: mtn, telecel, or airteltigo' });
  }

  const volumeNum = Number(volumeInMB);
  if (isNaN(volumeNum) || volumeNum <= 0) {
    return res.status(400).json({ status: 'error', message: 'volumeInMB must be a positive number (e.g. 1024, 2048)' });
  }

  try {
    // ✅ FIXED: pass ref so RemaData stores it under the same ref as Firebase/Paystack
    const result = await deliverData(phone, volumeNum, networkType, ref || null);
    res.json({ status: 'success', message: 'Order placed successfully', data: result.data });
  } catch (err) {
    const errorMsg = err.response?.data?.message || err.message || 'Delivery failed';
    console.error(`❌ POST /deliver error:`, errorMsg);
    res.status(500).json({ status: 'error', message: errorMsg, details: err.response?.data || null });
  }
});

// ─────────────────────────────────────────────
//  PAYSTACK WEBHOOK  POST /webhook/paystack
// ─────────────────────────────────────────────
app.post('/webhook/paystack', async (req, res) => {
  const hash = crypto
    .createHmac('sha512', PAYSTACK_SECRET)
    .update(req.body)
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    console.warn('⚠️ Paystack webhook: invalid signature');
    return res.status(401).send('Unauthorized');
  }

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).send('Bad JSON');
  }

  res.sendStatus(200);

  if (event.event !== 'charge.success') return;

  const { reference, metadata } = event.data;
  const phone       = metadata?.phone;
  const volumeInMB  = metadata?.volumeInMB;
  const networkType = metadata?.networkType;

  if (!phone || !volumeInMB || !networkType) {
    console.error(`❌ Webhook missing delivery metadata for ref: ${reference}`, metadata);
    return;
  }

  console.log(`💳 Payment confirmed: ref=${reference} | ${phone}`);

  try {
    // ✅ Pass the Paystack reference so RemaData ref matches
    await deliverData(phone, Number(volumeInMB), networkType, reference);
    console.log(`🎉 Auto-delivered after payment: ${reference}`);
  } catch (err) {
    console.error(`❌ Auto-delivery failed after payment ${reference}:`, err.response?.data || err.message);
  }
});

// ─────────────────────────────────────────────
//  ORDER STATUS  GET /api/order-status/:ref
//  Used by track-order page and admin dashboard
//  to get live delivery status from RemaData
// ─────────────────────────────────────────────
app.get('/api/order-status/:ref', async (req, res) => {
  try {
    const response = await axios.get(
      `${REMADATA_API_URL}/order-status/${req.params.ref}`,
      { headers: { 'X-API-KEY': REMADATA_API_KEY } }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({
      status:  'error',
      message: err.response?.data?.message || 'Failed to fetch order status'
    });
  }
});

// Order history with filters
app.get('/api/orders', async (req, res) => {
  const { page, limit, status, network, phone } = req.query;
  const params = new URLSearchParams();
  if (page)    params.append('page', page);
  if (limit)   params.append('per_page', limit);
  if (status)  params.append('status', status);
  if (network) params.append('network', network);
  if (phone)   params.append('phone', phone);

  try {
    const url = `${REMADATA_API_URL}/orders${params.toString() ? '?' + params.toString() : ''}`;
    const response = await axios.get(url, { headers: { 'X-API-KEY': REMADATA_API_KEY } });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.response?.data?.message || 'Failed to fetch orders' });
  }
});

// ─────────────────────────────────────────────
//  ERROR HANDLERS
// ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ status: 'error', message: `Route ${req.method} ${req.url} not found` });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ status: 'error', message: 'Internal server error' });
});

// ─────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 RemaData API: ${REMADATA_API_URL}`);
  console.log(`🔑 API Key: ${REMADATA_API_KEY !== 'rd_live_your_key_here' ? 'Configured ✅' : 'NOT SET ⚠️'}`);
  console.log(`💳 Paystack: ${PAYSTACK_SECRET !== 'sk_live_your_paystack_secret' ? 'Configured ✅' : 'NOT SET ⚠️'}`);
  console.log(`\n📮 Endpoints:`);
  console.log(`   POST /deliver                → manual delivery`);
  console.log(`   GET  /api/balance            → wallet balance`);
  console.log(`   GET  /api/order-status/:ref  → live order status from RemaData`);
  console.log(`   POST /webhook/paystack       → auto-delivery on payment`);
  console.log(`   GET  /api/bundles            → available bundles`);
  console.log(`   GET  /api/orders             → order history`);
});

// ─────────────────────────────────────────────
//  KEEP-ALIVE PING (prevents Render free spin-down)
// ─────────────────────────────────────────────
setInterval(async () => {
  try {
    await axios.get(`${SELF_URL}/health`, { timeout: 10000 });
    console.log(`💓 Keep-alive ping → ${SELF_URL}`);
  } catch { /* silently fail */ }
}, 4 * 60 * 1000);

module.exports = app;
