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
const REMADATA_API_KEY  = process.env.REMADATA_API_KEY  || 'rd_live_your_key_here';   // ⚠️ set in Render env vars
const PAYSTACK_SECRET   = process.env.PAYSTACK_SECRET   || 'sk_live_your_paystack_secret'; // ⚠️ set in Render env vars
const SELF_URL          = process.env.SELF_URL          || `http://localhost:${PORT}`;

// ─────────────────────────────────────────────
//  MIDDLEWARE
//  Raw body must be captured BEFORE json() for
//  Paystack webhook signature verification
// ─────────────────────────────────────────────
app.use('/webhook/paystack', express.raw({ type: 'application/json' }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────────
//  BUNDLE SIZE MAP
//  Maps common MB values so the frontend can
//  send either a number or a label like "1GB"
// ─────────────────────────────────────────────
const BUNDLE_MAP = {
  '100':   100,
  '200':   200,
  '500':   500,
  '1gb':   1024,  '1024': 1024,
  '2gb':   2048,  '2048': 2048,
  '3gb':   3072,  '3072': 3072,
  '4gb':   4096,  '4096': 4096,
  '5gb':   5120,  '5120': 5120,
  '10gb':  10240, '10240': 10240,
  '15gb':  15360, '15360': 15360,
  '20gb':  20480, '20480': 20480,
};

/**
 * Resolve volumeInMB from whatever the frontend sends.
 * Accepts: 1024 (number), "1024" (string), "1GB" (label)
 */
function resolveVolume(raw) {
  if (raw === null || raw === undefined) return null;
  const key = String(raw).toLowerCase().replace(/\s/g, '');
  if (BUNDLE_MAP[key]) return BUNDLE_MAP[key];
  const num = Number(raw);
  if (!isNaN(num) && num > 0) return num;
  return null;
}

// ─────────────────────────────────────────────
//  CORE DELIVERY HELPER
// ─────────────────────────────────────────────
async function deliverData(phone, volumeInMB, networkType, reference) {
  const orderRef = reference || `DF-${Date.now()}`;

  const payload = {
    ref:         orderRef,
    phone:       phone,
    volumeInMB:  Number(volumeInMB),
    networkType: networkType.toLowerCase(),
  };

  console.log(`📦 Delivering ${volumeInMB}MB (${networkType}) → ${phone} | Order: ${orderRef}`);

  const response = await axios.post(
    `${REMADATA_API_URL}/buy-data`,
    payload,
    {
      headers: {
        'X-API-KEY':     REMADATA_API_KEY,
        'Content-Type':  'application/json',
      },
      timeout: 30000,
    }
  );

  console.log(`✅ Delivery success:`, response.data);
  return { success: true, data: response.data };
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
    const r = await axios.get(`${REMADATA_API_URL}/wallet-balance`, {
      headers: { 'X-API-KEY': REMADATA_API_KEY },
    });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.response?.data?.message || 'Failed to fetch balance' });
  }
});

// Available bundles
app.get('/api/bundles', async (req, res) => {
  const { network } = req.query;
  try {
    const url = `${REMADATA_API_URL}/bundles${network ? `?network=${network}` : ''}`;
    const r = await axios.get(url, { headers: { 'X-API-KEY': REMADATA_API_KEY } });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.response?.data?.message || 'Failed to fetch bundles' });
  }
});

// Check price
app.post('/api/check-price', async (req, res) => {
  const { networkType, volumeInMB } = req.body;
  const volume = resolveVolume(volumeInMB);

  if (!networkType || !volume) {
    return res.status(400).json({ status: 'error', message: 'Missing required fields: networkType, volumeInMB' });
  }

  try {
    const r = await axios.post(
      `${REMADATA_API_URL}/get-cost-price`,
      { networkType, volumeInMB: volume },
      { headers: { 'X-API-KEY': REMADATA_API_KEY, 'Content-Type': 'application/json' } }
    );
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.response?.data?.message || 'Price check failed' });
  }
});

// ─────────────────────────────────────────────
//  MAIN DELIVERY ENDPOINT  POST /deliver
//  Called directly by your frontend/admin panel
// ─────────────────────────────────────────────
app.post('/deliver', async (req, res) => {
  let { phone, volumeInMB, networkType, ref, network, capacity, phoneNumber } = req.body;

  // Accept alternate field names from older frontend code
  phone       = phone       || phoneNumber;
  networkType = networkType || network;

  // Resolve volume — accepts number, string, or "1GB" label
  const volume = resolveVolume(volumeInMB || capacity);

  // ── Validation ──
  if (!phone) {
    return res.status(400).json({ status: 'error', message: 'Phone number is required' });
  }
  if (!volume) {
    return res.status(400).json({ status: 'error', message: 'volumeInMB is required (e.g. 1024 for 1GB)' });
  }
  if (!networkType) {
    return res.status(400).json({ status: 'error', message: 'networkType is required (mtn, telecel, airteltigo)' });
  }
  if (!/^0[0-9]{9}$/.test(phone)) {
    return res.status(400).json({ status: 'error', message: 'Phone must be 10 digits starting with 0' });
  }
  if (!['mtn', 'telecel', 'airteltigo'].includes(networkType.toLowerCase())) {
    return res.status(400).json({ status: 'error', message: 'networkType must be: mtn, telecel, or airteltigo' });
  }

  try {
    const result = await deliverData(phone, volume, networkType, ref);
    res.json({ status: 'success', message: 'Order placed successfully', data: result.data });
  } catch (err) {
    console.error(`❌ POST /deliver error:`, err.response?.data || err.message);
    res.status(500).json({
      status:  'error',
      message: err.response?.data?.message || 'Delivery failed',
      details: err.response?.data || null,
    });
  }
});

// ─────────────────────────────────────────────
//  PAYSTACK WEBHOOK  POST /webhook/paystack
//  Auto-delivers data when payment is confirmed
//  Set this URL in your Paystack dashboard
// ─────────────────────────────────────────────
app.post('/webhook/paystack', async (req, res) => {
  // 1. Verify signature
  const hash = crypto
    .createHmac('sha512', PAYSTACK_SECRET)
    .update(req.body)
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    console.warn('⚠️ Paystack webhook: invalid signature');
    return res.status(401).send('Unauthorized');
  }

  // 2. Parse event
  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).send('Bad JSON');
  }

  // Acknowledge immediately — Paystack requires fast response
  res.sendStatus(200);

  // 3. Only handle successful charges
  if (event.event !== 'charge.success') return;

  const { reference, metadata, amount, customer } = event.data;

  // Your frontend must pass these in Paystack metadata when initializing payment:
  // metadata: { phone, volumeInMB, networkType, orderId }
  const phone       = metadata?.phone       || metadata?.custom_fields?.find(f => f.variable_name === 'phone')?.value;
  const volumeInMB  = metadata?.volumeInMB  || metadata?.custom_fields?.find(f => f.variable_name === 'volumeInMB')?.value;
  const networkType = metadata?.networkType || metadata?.custom_fields?.find(f => f.variable_name === 'networkType')?.value;
  const orderId     = metadata?.orderId     || reference;

  if (!phone || !volumeInMB || !networkType) {
    console.error(`❌ Webhook missing delivery metadata for ref: ${reference}`, metadata);
    return;
  }

  const volume = resolveVolume(volumeInMB);
  if (!volume) {
    console.error(`❌ Webhook: invalid volumeInMB "${volumeInMB}" for ref: ${reference}`);
    return;
  }

  console.log(`💳 Payment confirmed: ${amount / 100} GHS | ref: ${reference} | ${phone}`);

  try {
    await deliverData(phone, volume, networkType, orderId);
    console.log(`🎉 Auto-delivered after payment: ${reference}`);
  } catch (err) {
    console.error(`❌ Auto-delivery failed after payment ${reference}:`, err.response?.data || err.message);
    // TODO: Save failed deliveries to Firebase for manual retry
  }
});

// Order status
app.get('/api/order-status/:ref', async (req, res) => {
  try {
    const r = await axios.get(`${REMADATA_API_URL}/order-status/${req.params.ref}`, {
      headers: { 'X-API-KEY': REMADATA_API_KEY },
    });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.response?.data?.message || 'Failed to fetch order status' });
  }
});

// Order history with filters
app.get('/api/orders', async (req, res) => {
  const { page, limit, status, network, phone } = req.query;
  const params = new URLSearchParams();
  if (page)    params.append('page',     page);
  if (limit)   params.append('per_page', limit);
  if (status)  params.append('status',   status);
  if (network) params.append('network',  network);
  if (phone)   params.append('phone',    phone);

  try {
    const url = `${REMADATA_API_URL}/orders${params.toString() ? '?' + params.toString() : ''}`;
    const r = await axios.get(url, { headers: { 'X-API-KEY': REMADATA_API_KEY } });
    res.json(r.data);
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
  console.log(`   POST /deliver           → manual delivery`);
  console.log(`   POST /webhook/paystack  → auto-delivery on payment`);
  console.log(`   GET  /api/balance       → wallet balance`);
  console.log(`   GET  /api/bundles       → available bundles`);
  console.log(`   GET  /api/orders        → order history`);
});

// ─────────────────────────────────────────────
//  KEEP-ALIVE PING (prevents Render free spin-down)
//  Set SELF_URL env var to your Render URL
//  e.g. https://your-app.onrender.com
// ─────────────────────────────────────────────
setInterval(async () => {
  try {
    await axios.get(`${SELF_URL}/health`, { timeout: 10000 });
    console.log(`💓 Keep-alive ping → ${SELF_URL}`);
  } catch {
    // silently fail
  }
}, 4 * 60 * 1000); // every 4 minutes

module.exports = app;
