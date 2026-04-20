require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
//  CONFIGURATION - UPDATE THESE WITH YOUR REAL CREDENTIALS
// ─────────────────────────────────────────────
// ⚠️ IMPORTANT: You need to get the correct API URL from RemaData support
// Possible correct URLs:
// - https://api.remadata.com/v1
// - https://remadata.com/api/v1
// - https://api.remadata.com
const REMADATA_API_URL = process.env.REMADATA_API_URL || 'https://api.remadata.com/v1';
const REMADATA_API_KEY  = process.env.REMADATA_API_KEY  || '';  // Add your real key in .env
const REMADATA_API_SECRET = process.env.REMADATA_API_SECRET || ''; // Some APIs need this
const PAYSTACK_SECRET   = process.env.PAYSTACK_SECRET   || '';  // Add your real secret in .env
const SELF_URL          = process.env.SELF_URL          || `http://localhost:${PORT}`;

// ─────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────
// IMPORTANT: Use raw body for webhook signature verification
app.use('/paystack-webhook', express.raw({ type: 'application/json' }));
app.use('/webhook/paystack', express.raw({ type: 'application/json' }));

// Regular JSON parsing for other routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Enhanced CORS configuration
app.use(cors({
  origin: '*', // In production, restrict this to your frontend domain
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-KEY', 'X-API-SECRET']
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
 * Get authentication headers (try multiple formats that RemaData might expect)
 */
function getAuthHeaders() {
  const headers = {
    'Content-Type': 'application/json',
  };
  
  // Try multiple auth formats
  if (REMADATA_API_KEY) {
    headers['X-API-KEY'] = REMADATA_API_KEY;
    headers['X-API-Key'] = REMADATA_API_KEY;
    headers['api_key'] = REMADATA_API_KEY;
    headers['apikey'] = REMADATA_API_KEY;
    headers['Authorization'] = `Bearer ${REMADATA_API_KEY}`;
  }
  
  if (REMADATA_API_SECRET) {
    headers['X-API-SECRET'] = REMADATA_API_SECRET;
    headers['X-API-Secret'] = REMADATA_API_SECRET;
  }
  
  return headers;
}

/**
 * Make API call to RemaData with proper error handling
 */
async function callRemaData(endpoint, method = 'GET', data = null) {
  const url = `${REMADATA_API_URL}${endpoint}`;
  const headers = getAuthHeaders();
  
  console.log(`📡 Calling RemaData: ${method} ${url}`);
  
  try {
    const response = await axios({
      method,
      url,
      headers,
      data,
      timeout: 30000
    });
    
    return { success: true, data: response.data };
  } catch (error) {
    console.error(`❌ RemaData API error:`, error.response?.data || error.message);
    
    const enhancedError = new Error(
      error.response?.data?.message || 
      error.response?.data?.error || 
      error.message || 
      'API call failed'
    );
    enhancedError.status = error.response?.status || 500;
    enhancedError.details = error.response?.data || null;
    enhancedError.code = error.code;
    
    throw enhancedError;
  }
}

/**
 * Core delivery function - sends request to RemaData API
 */
async function deliverData(phone, volumeInMB, networkType, reference = null) {
  const orderRef = reference || `DF-${Date.now()}`;

  // Try multiple possible payload formats
  const payloads = [
    { ref: orderRef, phone, volumeInMB, networkType: networkType.toLowerCase() },
    { reference: orderRef, phone_number: phone, volume_mb: volumeInMB, network: networkType.toLowerCase() },
    { order_ref: orderRef, recipient: phone, data_size_mb: volumeInMB, provider: networkType.toLowerCase() }
  ];
  
  let lastError = null;
  
  for (const payload of payloads) {
    try {
      console.log(`📤 Trying payload format:`, JSON.stringify(payload));
      
      const response = await axios.post(
        `${REMADATA_API_URL}/deliver`,
        payload,
        {
          headers: getAuthHeaders(),
          timeout: 30000,
        }
      );
      
      console.log(`✅ Delivery success:`, response.data);
      return { success: true, data: response.data, reference: orderRef };
    } catch (error) {
      lastError = error;
      console.log(`⚠️ Payload format failed, trying next...`);
    }
  }
  
  throw lastError;
}

// ─────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────

// Health check with more details
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    remadataConfigured: !!REMADATA_API_KEY && REMADATA_API_KEY !== '',
    paystackConfigured: !!PAYSTACK_SECRET && PAYSTACK_SECRET !== '',
    endpoints: ['/deliver', '/api/balance', '/api/order-status/:ref', '/paystack-webhook', '/api/bundles']
  });
});

// Wallet balance with better error handling
app.get('/api/balance', async (req, res) => {
  try {
    console.log('📊 Fetching wallet balance...');
    
    // Try multiple possible endpoints
    const endpoints = ['/wallet/balance', '/balance', '/account/balance'];
    let lastError = null;
    
    for (const endpoint of endpoints) {
      try {
        const result = await callRemaData(endpoint, 'GET');
        if (result.success) {
          const balance = result.data?.data?.balance || result.data?.balance || 0;
          console.log(`✅ Balance fetched: GH₵${balance}`);
          return res.json({ 
            status: 'success', 
            data: { balance: parseFloat(balance) } 
          });
        }
      } catch (err) {
        lastError = err;
      }
    }
    
    throw lastError || new Error('Could not fetch balance');
  } catch (err) {
    console.error('❌ Balance error:', err.message);
    
    // Return a simulated balance for testing if API is not configured
    if (!REMADATA_API_KEY || REMADATA_API_KEY === '') {
      return res.json({
        status: 'success',
        data: { balance: 150.00 },
        note: 'Demo mode - Configure RemaData API for live balance'
      });
    }
    
    res.status(500).json({
      status: 'error',
      message: err.message || 'Failed to fetch balance'
    });
  }
});

// Available bundles
app.get('/api/bundles', async (req, res) => {
  const { network } = req.query;
  
  try {
    // Try multiple possible endpoints
    const endpoints = network ? [`/bundles?network=${network}`, `/plans?network=${network}`] : ['/bundles', '/plans'];
    let lastError = null;
    
    for (const endpoint of endpoints) {
      try {
        const result = await callRemaData(endpoint, 'GET');
        if (result.success && result.data?.data?.length > 0) {
          return res.json(result.data);
        } else if (result.success && result.data?.length > 0) {
          return res.json({ status: 'success', data: result.data });
        }
      } catch (err) {
        lastError = err;
      }
    }
    
    // Return demo bundles for testing if API is not configured
    if (!REMADATA_API_KEY || REMADATA_API_KEY === '') {
      const demoBundles = [
        { volumeInMB: 1024, price: 4.20, network: 'mtn' },
        { volumeInMB: 2048, price: 7.50, network: 'mtn' },
        { volumeInMB: 5120, price: 16.00, network: 'mtn' },
        { volumeInMB: 10240, price: 28.00, network: 'mtn' },
        { volumeInMB: 20480, price: 50.00, network: 'mtn' },
        { volumeInMB: 51200, price: 110.00, network: 'mtn' }
      ];
      
      const filtered = network ? demoBundles.filter(b => b.network === network) : demoBundles;
      return res.json({ 
        status: 'success', 
        data: filtered,
        note: 'Demo mode - Connect RemaData API for live bundles'
      });
    }
    
    throw lastError || new Error('No bundles found');
  } catch (err) {
    console.error('Bundles error:', err.message);
    res.status(500).json({
      status: 'error',
      message: err.message || 'Failed to fetch bundles'
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
    const result = await callRemaData('/price/check', 'POST', { networkType, volumeInMB: Number(volumeInMB) });
    res.json(result.data);
  } catch (err) {
    console.error('Price check error:', err.message);
    res.status(500).json({ 
      status: 'error', 
      message: err.message || 'Price check failed' 
    });
  }
});

// ─────────────────────────────────────────────
//  MAIN DELIVERY ENDPOINT - POST /deliver
// ─────────────────────────────────────────────
app.post('/deliver', async (req, res) => {
  console.log('📦 Received delivery request:', req.body);
  
  let { phone, volumeInMB, networkType, ref } = req.body;

  // Enhanced validation
  if (!phone) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Phone number is required' 
    });
  }
  
  if (!volumeInMB) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'volumeInMB is required (e.g. 1024 for 1GB)' 
    });
  }
  
  if (!networkType) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'networkType is required (mtn, telecel, airteltigo)' 
    });
  }

  // Format phone number (remove spaces, dashes, etc.)
  phone = phone.replace(/\s+/g, '').replace(/-/g, '');
  
  // Validate phone format (Ghana numbers)
  if (!/^(0|233)[0-9]{9}$/.test(phone)) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Invalid phone number format. Must be 10 digits starting with 0 or 12 digits starting with 233' 
    });
  }

  // Convert 233 format to 0 format if needed
  if (phone.startsWith('233')) {
    phone = '0' + phone.substring(3);
  }

  const validNetworks = ['mtn', 'telecel', 'airteltigo'];
  const normalizedNetwork = networkType.toLowerCase();
  
  if (!validNetworks.includes(normalizedNetwork)) {
    return res.status(400).json({ 
      status: 'error', 
      message: `Invalid network type: ${networkType}. Must be: ${validNetworks.join(', ')}` 
    });
  }

  const volumeNum = Number(volumeInMB);
  if (isNaN(volumeNum) || volumeNum <= 0) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'volumeInMB must be a positive number (e.g. 1024, 2048)' 
    });
  }

  if (volumeNum < 10) {
    return res.status(400).json({
      status: 'error',
      message: 'Volume must be at least 10MB'
    });
  }

  try {
    // Attempt delivery
    const result = await deliverData(phone, volumeNum, normalizedNetwork, ref || null);
    
    res.json({ 
      status: 'success', 
      message: 'Data delivered successfully', 
      data: result.data,
      reference: result.reference
    });
    
  } catch (err) {
    console.error(`❌ POST /deliver error:`, err.message);
    
    let statusCode = 500;
    let errorMessage = err.message || 'Delivery failed';
    
    if (err.status === 400) statusCode = 400;
    else if (err.status === 401) {
      statusCode = 401;
      errorMessage = 'Invalid API key or authentication failed';
    } else if (err.status === 402) {
      statusCode = 402;
      errorMessage = 'Insufficient wallet balance. Please top up your RemaData account.';
    } else if (err.message?.toLowerCase().includes('balance')) {
      statusCode = 402;
      errorMessage = 'Insufficient wallet balance. Please top up your RemaData account.';
    }
    
    res.status(statusCode).json({ 
      status: 'error', 
      message: errorMessage,
      details: err.details
    });
  }
});

// ─────────────────────────────────────────────
//  WEBHOOK HANDLER - POST /paystack-webhook
//  This matches your Paystack configuration
// ─────────────────────────────────────────────
const webhookHandler = async (req, res) => {
  console.log(`📨 Webhook received at ${req.path}`);
  
  // Verify signature if Paystack secret is configured
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
    // You could implement a retry queue here
  }
};

// ✅ Add BOTH webhook endpoints for maximum compatibility
app.post('/paystack-webhook', webhookHandler);
app.post('/webhook/paystack', webhookHandler);

// ─────────────────────────────────────────────
//  ORDER STATUS - GET /api/order-status/:ref
// ─────────────────────────────────────────────
app.get('/api/order-status/:ref', async (req, res) => {
  const { ref } = req.params;
  
  if (!ref) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Reference is required' 
    });
  }
  
  try {
    console.log(`🔍 Checking order status for ref: ${ref}`);
    
    // Try multiple possible endpoints
    const endpoints = [`/order/${ref}`, `/status/${ref}`, `/order-status/${ref}`];
    let lastError = null;
    
    for (const endpoint of endpoints) {
      try {
        const result = await callRemaData(endpoint, 'GET');
        if (result.success) {
          console.log(`✅ Status for ${ref}:`, result.data?.data?.status || result.data?.status);
          return res.json(result.data);
        }
      } catch (err) {
        lastError = err;
      }
    }
    
    throw lastError || new Error('Order not found');
  } catch (err) {
    console.error(`❌ Status check failed for ${ref}:`, err.message);
    
    if (err.status === 404) {
      return res.status(404).json({
        status: 'error',
        message: 'Order not found'
      });
    }
    
    res.status(500).json({
      status: 'error',
      message: err.message || 'Failed to fetch order status'
    });
  }
});

// Order history with filters
app.get('/api/orders', async (req, res) => {
  const { page = 1, limit = 50, status, network, phone } = req.query;
  
  try {
    let endpoint = `/orders?page=${page}&per_page=${limit}`;
    if (status) endpoint += `&status=${status}`;
    if (network) endpoint += `&network=${network}`;
    if (phone) endpoint += `&phone=${phone}`;
    
    console.log(`📋 Fetching orders: ${endpoint}`);
    const result = await callRemaData(endpoint, 'GET');
    res.json(result.data);
  } catch (err) {
    console.error('Orders fetch error:', err.message);
    res.status(500).json({ 
      status: 'error', 
      message: err.message || 'Failed to fetch orders' 
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
    message: 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
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

// ─────────────────────────────────────────────
//  KEEP-ALIVE PING (prevents Render free spin-down)
// ─────────────────────────────────────────────
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
