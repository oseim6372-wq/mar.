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
//  MIDDLEWARE ORDER - IMPORTANT!
//  Webhook raw body parsers MUST come BEFORE express.json()
// ─────────────────────────────────────────────

// ✅ Webhook routes with raw body parser (for signature verification)
app.post('/paystack-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  await handlePaystackWebhook(req, res);
});

app.post('/webhook/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
  await handlePaystackWebhook(req, res);
});

// Regular JSON middleware for all other routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-KEY']
}));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ─────────────────────────────────────────────
//  HELPER FUNCTIONS
// ─────────────────────────────────────────────

/**
 * Core delivery function - sends request to RemaData API
 */
async function deliverData(phone, volumeInMB, networkType, reference = null) {
  const orderRef = reference || `DF-${Date.now()}`;

  // Format phone number to international format
  let formattedPhone = phone;
  if (formattedPhone.startsWith('0')) {
    formattedPhone = '233' + formattedPhone.substring(1);
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
    return { success: true, data: response.data };
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
    console.warn('⚠️ Paystack secret not configured, skipping signature verification');
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

  console.log(`💳 Payment confirmed: ${reference} | Amount: GH₵${(amount/100).toFixed(2)} | Customer: ${customer?.email}`);

  if (!phone || !volumeInMB || !networkType) {
    console.error(`❌ Webhook missing delivery metadata for ref: ${reference}`, { metadata });
    return;
  }

  try {
    console.log(`🚀 Auto-delivering after payment: ${reference}`);
    await deliverData(phone, Number(volumeInMB), networkType, reference);
    console.log(`🎉 Auto-delivery successful: ${reference}`);
  } catch (err) {
    console.error(`❌ Auto-delivery failed for ${reference}:`, err.message);
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
    endpoints: ['/deliver', '/api/balance', '/api/order-status/:ref', '/paystack-webhook', '/webhook/paystack', '/api/bundles']
  });
});

// Wallet balance
app.get('/api/balance', async (req, res) => {
  try {
    console.log('📊 Fetching wallet balance...');
    const response = await axios.get(`${REMADATA_API_URL}/wallet-balance`, {
      headers: { 'X-API-KEY': REMADATA_API_KEY },
      timeout: 10000
    });
    
    console.log('✅ Balance fetched successfully');
    res.json(response.data);
  } catch (err) {
    console.error('❌ Balance error:', err.response?.data || err.message);
    
    if (err.response?.status === 401) {
      return res.status(401).json({
        status: 'error',
        message: 'Invalid API key. Please check your RemaData API credentials.'
      });
    }
    
    if (err.code === 'ECONNABORTED') {
      return res.status(504).json({
        status: 'error',
        message: 'Request timeout. RemaData API is not responding.'
      });
    }
    
    res.status(500).json({
      status: 'error',
      message: err.response?.data?.message || err.message || 'Failed to fetch balance'
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
      headers: { 'X-API-KEY': REMADATA_API_KEY },
      timeout: 10000
    });
    res.json(response.data);
  } catch (err) {
    console.error('Bundles error:', err.response?.data || err.message);
    res.status(500).json({
      status: 'error',
      message: err.response?.data?.message || 'Failed to fetch bundles'
    });
  }
});

// Check price
app.post('/api/check-price', async (req, res) => {
  const { networkType, volumeInMB } = req.body;
  
  if (!networkType || !volumeInMB) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Missing required fields: networkType, volumeInMB' 
    });
  }
  
  try {
    const response = await axios.post(
      `${REMADATA_API_URL}/get-cost-price`,
      { networkType, volumeInMB: Number(volumeInMB) },
      { 
        headers: { 
          'X-API-KEY': REMADATA_API_KEY, 
          'Content-Type': 'application/json' 
        },
        timeout: 10000
      }
    );
    res.json(response.data);
  } catch (err) {
    console.error('Price check error:', err.response?.data || err.message);
    res.status(500).json({ 
      status: 'error', 
      message: err.response?.data?.message || 'Price check failed' 
    });
  }
});

// Main delivery endpoint
app.post('/deliver', async (req, res) => {
  console.log('📦 Received delivery request:', req.body);
  
  let { phone, volumeInMB, networkType, ref } = req.body;

  if (!phone) {
    return res.status(400).json({ status: 'error', message: 'Phone number is required' });
  }
  
  if (!volumeInMB) {
    return res.status(400).json({ status: 'error', message: 'volumeInMB is required' });
  }
  
  if (!networkType) {
    return res.status(400).json({ status: 'error', message: 'networkType is required' });
  }

  phone = phone.replace(/\s+/g, '').replace(/-/g, '');
  
  if (!/^(0|233)[0-9]{9}$/.test(phone)) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Invalid phone number format. Must be 10 digits starting with 0 or 12 digits starting with 233' 
    });
  }

  if (phone.startsWith('233')) {
    phone = '0' + phone.substring(3);
  }

  const validNetworks = ['mtn', 'telecel', 'airteltigo'];
  const normalizedNetwork = networkType.toLowerCase();
  
  if (!validNetworks.includes(normalizedNetwork)) {
    return res.status(400).json({ 
      status: 'error', 
      message: `Invalid network type. Must be: ${validNetworks.join(', ')}` 
    });
  }

  const volumeNum = Number(volumeInMB);
  if (isNaN(volumeNum) || volumeNum <= 0) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'volumeInMB must be a positive number' 
    });
  }

  if (volumeNum < 10) {
    return res.status(400).json({
      status: 'error',
      message: 'Volume must be at least 10MB'
    });
  }

  try {
    const result = await deliverData(phone, volumeNum, normalizedNetwork, ref || null);
    
    res.json({ 
      status: 'success', 
      message: 'Data delivered successfully', 
      data: result.data 
    });
    
  } catch (err) {
    console.error(`❌ POST /deliver error:`, err.message);
    
    let statusCode = 500;
    let errorMessage = err.message || 'Delivery failed';
    
    if (err.status === 400) statusCode = 400;
    else if (err.status === 401) {
      statusCode = 401;
      errorMessage = 'Invalid API key or authentication failed';
    } else if (err.status === 402 || err.message.toLowerCase().includes('balance')) {
      statusCode = 402;
      errorMessage = 'Insufficient wallet balance. Please top up your RemaData account.';
    } else if (err.code === 'ECONNABORTED') {
      statusCode = 504;
      errorMessage = 'Request timeout. The service is taking too long to respond.';
    }
    
    res.status(statusCode).json({ 
      status: 'error', 
      message: errorMessage
    });
  }
});

// Order status
app.get('/api/order-status/:ref', async (req, res) => {
  const { ref } = req.params;
  
  if (!ref) {
    return res.status(400).json({ status: 'error', message: 'Reference is required' });
  }
  
  try {
    console.log(`🔍 Checking order status for ref: ${ref}`);
    const response = await axios.get(
      `${REMADATA_API_URL}/order-status/${ref}`,
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
      return res.status(404).json({ status: 'error', message: 'Order not found' });
    }
    
    res.status(500).json({
      status: 'error',
      message: err.response?.data?.message || 'Failed to fetch order status'
    });
  }
});

// Order history
app.get('/api/orders', async (req, res) => {
  const { page = 1, limit = 50, status, network, phone } = req.query;
  const params = new URLSearchParams();
  
  if (page)    params.append('page', page);
  if (limit)   params.append('per_page', limit);
  if (status)  params.append('status', status);
  if (network) params.append('network', network);
  if (phone)   params.append('phone', phone);

  try {
    const url = `${REMADATA_API_URL}/orders${params.toString() ? '?' + params.toString() : ''}`;
    console.log(`📋 Fetching orders: ${url}`);
    
    const response = await axios.get(url, { 
      headers: { 'X-API-KEY': REMADATA_API_KEY },
      timeout: 15000
    });
    
    res.json(response.data);
  } catch (err) {
    console.error('Orders fetch error:', err.response?.data || err.message);
    res.status(500).json({ 
      status: 'error', 
      message: err.response?.data?.message || 'Failed to fetch orders' 
    });
  }
});

// ─────────────────────────────────────────────
//  ERROR HANDLERS
// ─────────────────────────────────────────────
app.use((req, res) => {
  console.log(`❌ 404 - Route not found: ${req.method} ${req.url}`);
  res.status(404).json({ 
    status: 'error', 
    message: `Route ${req.method} ${req.url} not found` 
  });
});

app.use((err, req, res, next) => {
  console.error('💥 Server error:', err.stack);
  res.status(500).json({ 
    status: 'error', 
    message: 'Internal server error'
  });
});

// ─────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   🚀 DataFlow Backend Server Running                     ║
║                                                          ║
║   📡 Port: ${PORT}                                          ║
║   🌐 URL:  ${SELF_URL}                                    ║
║                                                          ║
║   🔑 RemaData API: ${REMADATA_API_KEY && REMADATA_API_KEY !== '' ? '✅ Configured' : '❌ NOT SET'}        ║
║   💳 Paystack: ${PAYSTACK_SECRET && PAYSTACK_SECRET !== '' ? '✅ Configured' : '❌ NOT SET'}          ║
║                                                          ║
║   📮 Endpoints:                                          ║
║      POST /deliver                → Manual delivery      ║
║      GET  /api/balance            → Wallet balance       ║
║      GET  /api/order-status/:ref  → Order status         ║
║      POST /paystack-webhook       → Payment webhook ✓    ║
║      POST /webhook/paystack       → Payment webhook      ║
║      GET  /api/bundles            → Available bundles    ║
║      GET  /api/orders             → Order history        ║
║      GET  /health                 → Health check         ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
  `);
});

// Keep-alive ping
if (process.env.NODE_ENV === 'production') {
  setInterval(async () => {
    try {
      await axios.get(`${SELF_URL}/health`, { timeout: 10000 });
      console.log(`💓 Keep-alive ping successful - ${new Date().toISOString()}`);
    } catch (err) {
      console.error(`⚠️ Keep-alive ping failed:`, err.message);
    }
  }, 4 * 60 * 1000);
}

module.exports = app;
