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
const REMADATA_API_KEY  = process.env.REMADATA_API_KEY  || '';
const PAYSTACK_SECRET   = process.env.PAYSTACK_SECRET   || '';
const SELF_URL          = process.env.SELF_URL          || `http://localhost:${PORT}`;

// ─────────────────────────────────────────────
//  PAYSTACK WEBHOOK HANDLER (MOVED UP - BEFORE app.post)
// ─────────────────────────────────────────────

/**
 * Shared Paystack webhook handler
 */
async function handlePaystackWebhook(req, res) {
  console.log(`📨 Webhook received at ${req.path}`);
  
  // Verify signature
  if (PAYSTACK_SECRET && PAYSTACK_SECRET !== '') {
    const hash = crypto
      .createHmac('sha512', PAYSTACK_SECRET)
      .update(req.body)
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      console.warn('⚠️ Paystack webhook: invalid signature');
      return res.status(401).send('Unauthorized');
    }
  } else {
    console.warn('⚠️ PAYSTACK_SECRET not set in environment variables');
  }

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch (err) {
    console.error('❌ Failed to parse webhook JSON:', err);
    return res.status(400).send('Bad JSON');
  }

  // Respond immediately to Paystack
  res.sendStatus(200);

  // Process only successful charges
  if (event.event !== 'charge.success') {
    console.log(`📝 Webhook event ignored: ${event.event}`);
    return;
  }

  const { reference, metadata, amount, customer } = event.data;
  const phone = metadata?.phone;
  const volumeInMB = metadata?.volumeInMB;
  const networkType = metadata?.networkType;

  console.log(`💳 Payment confirmed: ${reference} | Amount: GH₵${(amount/100).toFixed(2)}`);

  if (!phone || !volumeInMB || !networkType) {
    console.error(`❌ Webhook missing delivery metadata for ref: ${reference}`, { metadata });
    return;
  }

  try {
    console.log(`🚀 Auto-delivering after payment: ${reference}`);
    const result = await deliverData(phone, Number(volumeInMB), networkType, reference);
    console.log(`🎉 Auto-delivery successful! RemaData Ref: ${result.remaDataRef}`);
  } catch (err) {
    console.error(`❌ Auto-delivery failed for ${reference}:`, err.message);
  }
}

// ─────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────
app.post('/paystack-webhook', express.raw({ type: 'application/json' }), handlePaystackWebhook);
app.post('/webhook/paystack', express.raw({ type: 'application/json' }), handlePaystackWebhook);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ─────────────────────────────────────────────
//  HELPER FUNCTIONS
// ─────────────────────────────────────────────

/**
 * Core delivery function - calls RemaData API
 * ✅ RETURNS the RemaData reference for tracking
 */
async function deliverData(phone, volumeInMB, networkType, reference = null) {
  const orderRef = reference || `DF-${Date.now()}`;

  // Format phone: remove spaces/dashes, add 233 prefix if starts with 0
  let formattedPhone = phone.replace(/\s+/g, '').replace(/-/g, '');
  if (formattedPhone.startsWith('0')) {
    formattedPhone = '233' + formattedPhone.substring(1);
  }
  if (formattedPhone.startsWith('+')) {
    formattedPhone = formattedPhone.substring(1);
  }

  const payload = {
    ref:         orderRef,
    phone:       formattedPhone,
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
    
    // ✅ Extract and return the RemaData reference for tracking
    const remaReference = response.data?.data?.reference || response.data?.reference || orderRef;
    
    return { 
      success: true, 
      data: response.data,
      remaDataRef: remaReference  // CRITICAL: Save this for status checks
    };
  } catch (error) {
    console.error(`❌ Delivery failed:`, error.response?.data || error.message);
    
    const enhancedError = new Error(
      error.response?.data?.message || 
      error.response?.data?.error || 
      error.message || 
      'Delivery failed'
    );
    enhancedError.status = error.response?.status || 500;
    enhancedError.details = error.response?.data || null;
    enhancedError.code = error.code;
    
    throw enhancedError;
  }
}

// ─────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    remadataConfigured: !!REMADATA_API_KEY && REMADATA_API_KEY !== '',
    paystackConfigured: !!PAYSTACK_SECRET && PAYSTACK_SECRET !== '',
    endpoints: ['/deliver', '/api/balance', '/api/order-status/:ref', '/paystack-webhook', '/api/bundles', '/api/orders']
  });
});

// Wallet balance
app.get('/api/balance', async (req, res) => {
  try {
    const response = await axios.get(`${REMADATA_API_URL}/wallet-balance`, {
      headers: { 'X-API-KEY': REMADATA_API_KEY },
      timeout: 10000
    });
    res.json(response.data);
  } catch (err) {
    console.error('Balance error:', err.response?.data || err.message);
    res.status(500).json({ status: 'error', message: err.response?.data?.message || 'Failed to fetch balance' });
  }
});

// Available bundles
app.get('/api/bundles', async (req, res) => {
  const { network } = req.query;
  try {
    let url = `${REMADATA_API_URL}/bundles`;
    if (network) url += `?network=${network}`;
    const response = await axios.get(url, {
      headers: { 'X-API-KEY': REMADATA_API_KEY },
      timeout: 10000
    });
    res.json(response.data);
  } catch (err) {
    console.error('Bundles error:', err.response?.data || err.message);
    res.status(500).json({ status: 'error', message: 'Failed to fetch bundles' });
  }
});

// Check price
app.post('/api/check-price', async (req, res) => {
  const { networkType, volumeInMB } = req.body;
  if (!networkType || !volumeInMB) {
    return res.status(400).json({ status: 'error', message: 'Missing required fields' });
  }
  try {
    const response = await axios.post(`${REMADATA_API_URL}/get-cost-price`, 
      { networkType, volumeInMB: Number(volumeInMB) },
      { headers: { 'X-API-KEY': REMADATA_API_KEY, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Price check failed' });
  }
});

// ✅ MAIN DELIVERY ENDPOINT - Returns RemaData reference
app.post('/deliver', async (req, res) => {
  console.log('📦 Received delivery request:', req.body);
  
  let { phone, volumeInMB, networkType, ref } = req.body;

  if (!phone || !volumeInMB || !networkType) {
    return res.status(400).json({ status: 'error', message: 'Missing required fields: phone, volumeInMB, networkType' });
  }

  // Clean and validate phone
  phone = phone.replace(/\s+/g, '').replace(/-/g, '');
  if (!/^(0|233)[0-9]{9}$/.test(phone)) {
    return res.status(400).json({ status: 'error', message: 'Invalid phone number format' });
  }
  if (phone.startsWith('233')) phone = '0' + phone.substring(3);

  const validNetworks = ['mtn', 'telecel', 'airteltigo'];
  const normalizedNetwork = networkType.toLowerCase();
  if (!validNetworks.includes(normalizedNetwork)) {
    return res.status(400).json({ status: 'error', message: `Invalid network. Must be: ${validNetworks.join(', ')}` });
  }

  const volumeNum = Number(volumeInMB);
  if (isNaN(volumeNum) || volumeNum <= 0 || volumeNum < 10) {
    return res.status(400).json({ status: 'error', message: 'volumeInMB must be at least 10MB' });
  }

  try {
    const result = await deliverData(phone, volumeNum, normalizedNetwork, ref || null);
    
    // ✅ Return the RemaData reference to the frontend
    res.json({ 
      status: 'success', 
      message: 'Data delivered successfully', 
      data: result.data,
      reference: result.remaDataRef  // CRITICAL: For frontend to store
    });
  } catch (err) {
    console.error(`❌ POST /deliver error:`, err.message);
    let statusCode = err.status === 402 ? 402 : err.status === 401 ? 401 : 500;
    let errorMessage = err.message;
    if (err.status === 402) errorMessage = 'Insufficient wallet balance. Please top up.';
    res.status(statusCode).json({ status: 'error', message: errorMessage });
  }
});

// ✅ ORDER STATUS - Uses RemaData's correct endpoint
app.get('/api/order-status/:ref', async (req, res) => {
  const { ref } = req.params;
  
  if (!ref) {
    return res.status(400).json({ status: 'error', message: 'Reference is required' });
  }
  
  try {
    console.log(`🔍 Checking order status for ref: ${ref}`);
    
    // ✅ Correct RemaData endpoint as per docs: /api/order-status/{reference}
    const response = await axios.get(
      `${REMADATA_API_URL}/order-status/${encodeURIComponent(ref)}`,
      { 
        headers: { 'X-API-KEY': REMADATA_API_KEY },
        timeout: 10000
      }
    );
    
    console.log(`✅ Status for ${ref}:`, response.data?.data?.status || response.data?.status);
    res.json(response.data);
  } catch (err) {
    console.error(`❌ Status check failed for ${ref}:`, err.response?.data || err.message);
    
    if (err.response?.status === 404) {
      return res.status(404).json({ 
        status: 'error', 
        message: 'Order not found. The delivery may not have been initiated yet.' 
      });
    }
    
    res.status(500).json({
      status: 'error',
      message: err.response?.data?.message || 'Failed to fetch order status'
    });
  }
});

// Order history with filters
app.get('/api/orders', async (req, res) => {
  const { page = 1, per_page = 15, status, network, phone, ref_number, start_date, end_date } = req.query;
  const params = new URLSearchParams();
  if (page) params.append('page', page);
  if (per_page) params.append('per_page', per_page);
  if (status) params.append('status', status);
  if (network) params.append('network', network);
  if (phone) params.append('phone', phone);
  if (ref_number) params.append('ref_number', ref_number);
  if (start_date) params.append('start_date', start_date);
  if (end_date) params.append('end_date', end_date);

  try {
    const url = `${REMADATA_API_URL}/orders${params.toString() ? '?' + params.toString() : ''}`;
    const response = await axios.get(url, { 
      headers: { 'X-API-KEY': REMADATA_API_KEY },
      timeout: 15000
    });
    res.json(response.data);
  } catch (err) {
    console.error('Orders fetch error:', err.response?.data || err.message);
    res.status(500).json({ status: 'error', message: 'Failed to fetch orders' });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ status: 'error', message: `Route ${req.method} ${req.url} not found` });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('💥 Server error:', err.stack);
  res.status(500).json({ status: 'error', message: 'Internal server error' });
});

// ─────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║   🚀 DataFlow Backend Server Running                     ║
║   📡 Port: ${PORT}                                          ║
║   🌐 URL:  ${SELF_URL}                                    ║
║   🔑 RemaData API: ${REMADATA_API_KEY ? '✅ Configured' : '❌ NOT SET'}        ║
║   💳 Paystack: ${PAYSTACK_SECRET ? '✅ Configured' : '❌ NOT SET'}          ║
║                                                          ║
║   📮 Endpoints:                                          ║
║      POST /deliver                → Manual delivery      ║
║      GET  /api/balance            → Wallet balance       ║
║      GET  /api/order-status/:ref  → Order status ✓       ║
║      POST /paystack-webhook       → Payment webhook      ║
║      GET  /api/bundles            → Available bundles    ║
║      GET  /api/orders             → Order history        ║
║      GET  /health                 → Health check         ║
╚══════════════════════════════════════════════════════════╝
  `);
});

// Keep-alive ping for production
if (process.env.NODE_ENV === 'production') {
  setInterval(async () => {
    try {
      await axios.get(`${SELF_URL}/health`, { timeout: 10000 });
      console.log(`💓 Keep-alive ping - ${new Date().toISOString()}`);
    } catch (err) {
      console.error(`⚠️ Keep-alive ping failed:`, err.message);
    }
  }, 4 * 60 * 1000);
}

module.exports = app;
