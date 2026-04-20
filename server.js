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
const REMADATA_API_URL = 'https://remadata.com';
const REMADATA_API_KEY = process.env.REMADATA_API_KEY || '';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET || '';
const SELF_URL = process.env.SELF_URL || `http://localhost:${PORT}`;

// ─────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────
app.use('/paystack-webhook', express.raw({ type: 'application/json' }));
app.use('/webhook/paystack', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-KEY', 'X-API-SECRET']
}));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ─────────────────────────────────────────────
//  HELPER FUNCTIONS
// ─────────────────────────────────────────────

function getAuthHeaders() {
  return {
    'X-API-KEY': REMADATA_API_KEY,
    'Content-Type': 'application/json'
  };
}

async function deliverData(phone, volumeInMB, networkType, reference = null) {
  const orderRef = reference || `DF-${Date.now()}`;
  
  let formattedPhone = phone;
  if (formattedPhone.startsWith('0')) {
    formattedPhone = '233' + formattedPhone.substring(1);
  }

  const payload = {
    phone: formattedPhone,
    volume: volumeInMB,
    network: networkType.toLowerCase(),
    reference: orderRef
  };
  
  console.log(`📤 Delivery payload:`, JSON.stringify(payload));
  
  try {
    const response = await axios.post(
      `${REMADATA_API_URL}/api/data/purchase`,
      payload,
      {
        headers: getAuthHeaders(),
        timeout: 30000,
      }
    );
    
    console.log(`✅ Delivery success:`, response.data);
    return { success: true, data: response.data, reference: orderRef };
  } catch (error) {
    console.error(`❌ Delivery failed:`, error.response?.data || error.message);
    throw error;
  }
}

// ─────────────────────────────────────────────
//  HEALTH CHECK
// ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    remadataConfigured: !!REMADATA_API_KEY && REMADATA_API_KEY !== '',
    paystackConfigured: !!PAYSTACK_SECRET && PAYSTACK_SECRET !== ''
  });
});

// ─────────────────────────────────────────────
//  ✅ FIXED: WALLET BALANCE ENDPOINT
//  Uses correct RemaData API: GET /wallet/balance
// ─────────────────────────────────────────────
app.get('/api/balance', async (req, res) => {
  console.log('📊 Fetching wallet balance from RemaData...');
  
  if (!REMADATA_API_KEY || REMADATA_API_KEY === '') {
    console.warn('⚠️ RemaData API key not configured');
    return res.json({
      status: 'success',
      data: { balance: 0, currency: 'GHS' },
      message: 'API key not configured'
    });
  }
  
  try {
    // Correct RemaData endpoint for wallet balance
    const response = await axios.get('https://remadata.com/wallet/balance', {
      headers: {
        'X-API-KEY': REMADATA_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    console.log('✅ Balance response received:', JSON.stringify(response.data));
    
    // Parse response based on RemaData documentation
    // Expected format: { status: "success", data: { balance: "150.00", currency: "GHS" } }
    if (response.data?.status === 'success' && response.data?.data) {
      const balance = parseFloat(response.data.data.balance) || 0;
      const currency = response.data.data.currency || 'GHS';
      
      console.log(`💰 Wallet balance: ${currency} ${balance.toFixed(2)}`);
      
      return res.json({
        status: 'success',
        data: {
          balance: balance,
          currency: currency
        }
      });
    } else {
      // Try alternative response format
      const balance = parseFloat(response.data?.balance || response.data?.amount || 0);
      console.log(`💰 Extracted balance: ${balance}`);
      
      return res.json({
        status: 'success',
        data: {
          balance: balance,
          currency: 'GHS'
        }
      });
    }
    
  } catch (err) {
    console.error('❌ Balance fetch error:', err.response?.data || err.message);
    
    // Return a helpful error response
    if (err.response?.status === 401) {
      return res.status(401).json({
        status: 'error',
        message: 'Invalid API key. Please check your RemaData API credentials.',
        data: { balance: 0, currency: 'GHS' }
      });
    }
    
    if (err.code === 'ECONNABORTED') {
      return res.status(504).json({
        status: 'error',
        message: 'Request timeout. RemaData API is not responding.',
        data: { balance: 0, currency: 'GHS' }
      });
    }
    
    // Fallback: return 0 balance with error message
    return res.status(200).json({
      status: 'success',
      data: { balance: 0, currency: 'GHS' },
      message: err.message || 'Failed to fetch balance'
    });
  }
});

// ─────────────────────────────────────────────
//  AVAILABLE BUNDLES
// ─────────────────────────────────────────────
app.get('/api/bundles', async (req, res) => {
  const { network } = req.query;
  
  try {
    let url = `${REMADATA_API_URL}/api/bundles`;
    if (network) url += `?network=${network}`;
    
    const response = await axios.get(url, {
      headers: getAuthHeaders(),
      timeout: 10000
    });
    
    res.json(response.data);
  } catch (err) {
    console.error('Bundles error:', err.response?.data || err.message);
    
    // Fallback demo bundles
    const demoBundles = [
      { volumeInMB: 1024, price: 4.20, network: 'mtn' },
      { volumeInMB: 2048, price: 7.50, network: 'mtn' },
      { volumeInMB: 5120, price: 16.00, network: 'mtn' },
      { volumeInMB: 10240, price: 28.00, network: 'mtn' },
      { volumeInMB: 20480, price: 50.00, network: 'mtn' },
      { volumeInMB: 51200, price: 110.00, network: 'mtn' }
    ];
    
    const filtered = network ? demoBundles.filter(b => b.network === network) : demoBundles;
    res.json({ 
      status: 'success', 
      data: filtered,
      message: 'Demo bundles - Configure API for live data'
    });
  }
});

// ─────────────────────────────────────────────
//  MAIN DELIVERY ENDPOINT
// ─────────────────────────────────────────────
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
      message: 'Invalid phone number format. Must be 10 digits starting with 0' 
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

  try {
    const result = await deliverData(phone, volumeNum, normalizedNetwork, ref || null);
    
    res.json({ 
      status: 'success', 
      message: 'Data delivered successfully', 
      data: result.data,
      reference: result.reference
    });
    
  } catch (err) {
    console.error(`❌ Delivery error:`, err.message);
    
    let statusCode = 500;
    let errorMessage = err.response?.data?.message || err.message || 'Delivery failed';
    
    if (err.response?.status === 400) statusCode = 400;
    else if (err.response?.status === 401) {
      statusCode = 401;
      errorMessage = 'Invalid API key';
    } else if (err.response?.status === 402 || errorMessage.toLowerCase().includes('balance')) {
      statusCode = 402;
      errorMessage = 'Insufficient wallet balance. Please top up your RemaData account.';
    }
    
    res.status(statusCode).json({ 
      status: 'error', 
      message: errorMessage
    });
  }
});

// ─────────────────────────────────────────────
//  ORDER STATUS
// ─────────────────────────────────────────────
app.get('/api/order-status/:ref', async (req, res) => {
  const { ref } = req.params;
  
  if (!ref) {
    return res.status(400).json({ status: 'error', message: 'Reference is required' });
  }
  
  try {
    const response = await axios.get(`${REMADATA_API_URL}/api/order-status/${ref}`, {
      headers: getAuthHeaders(),
      timeout: 10000
    });
    
    res.json(response.data);
  } catch (err) {
    console.error(`Status check failed:`, err.message);
    
    if (err.response?.status === 404) {
      return res.status(404).json({ status: 'error', message: 'Order not found' });
    }
    
    res.status(500).json({ 
      status: 'error', 
      message: err.response?.data?.message || 'Failed to fetch order status' 
    });
  }
});

// ─────────────────────────────────────────────
//  WEBHOOK HANDLER - POST /paystack-webhook
// ─────────────────────────────────────────────
const webhookHandler = async (req, res) => {
  console.log(`📨 Webhook received at ${req.path}`);
  
  if (PAYSTACK_SECRET && PAYSTACK_SECRET !== '') {
    const hash = crypto
      .createHmac('sha512', PAYSTACK_SECRET)
      .update(req.body)
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      console.warn('⚠️ Paystack webhook: invalid signature');
      return res.status(401).send('Unauthorized');
    }
  }

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch (err) {
    console.error('❌ Failed to parse webhook JSON:', err);
    return res.status(400).send('Bad JSON');
  }

  res.sendStatus(200);

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
    console.error(`❌ Webhook missing delivery metadata`);
    return;
  }

  try {
    console.log(`🚀 Auto-delivering after payment: ${reference}`);
    await deliverData(phone, Number(volumeInMB), networkType, reference);
    console.log(`🎉 Auto-delivery successful: ${reference}`);
  } catch (err) {
    console.error(`❌ Auto-delivery failed:`, err.message);
  }
};

app.post('/paystack-webhook', webhookHandler);
app.post('/webhook/paystack', webhookHandler);

// ─────────────────────────────────────────────
//  404 HANDLER
// ─────────────────────────────────────────────
app.use((req, res) => {
  console.log(`❌ 404 - Route not found: ${req.method} ${req.url}`);
  res.status(404).json({ 
    status: 'error', 
    message: `Route ${req.method} ${req.url} not found` 
  });
});

// ─────────────────────────────────────────────
//  ERROR HANDLER
// ─────────────────────────────────────────────
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
║      GET  /health                 → Health check         ║
║      GET  /api/balance            → Wallet balance ✓     ║
║      POST /deliver                → Manual delivery      ║
║      GET  /api/order-status/:ref  → Order status        ║
║      POST /paystack-webhook       → Payment webhook     ║
║      GET  /api/bundles            → Available bundles   ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
  `);
});

// Keep-alive ping for Render (prevents spin-down)
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
