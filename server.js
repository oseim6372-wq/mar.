// ============================================================
//  DATEFLOW GH — UNIFIED BACKEND (FIXED BUNDLES)
//  Frontend served directly from server
//  MTN/Telecel/AT → RemaData API
// ============================================================

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
//  RATE LIMITING
// ─────────────────────────────────────────────

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { status: "error", message: "Too many requests, please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
});

// ─────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────

const REMADATA_API_URL = "https://remadata.com/api";
const REMADATA_API_KEY = process.env.REMADATA_API_KEY || "";
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || "";
const DELIVER_SECRET = process.env.DELIVER_SECRET || "";

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean);
const CORS_ORIGIN = ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : [];

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

const processedRefs = new Map();
const REF_TTL = 24 * 60 * 60 * 1000;
const MAX_REF_SIZE = 10000;

const failedSaveQueue = [];
let isProcessingQueue = false;

const NETWORK_PROVIDER = {
    mtn: { name: "RemaData", primary: true },
    telecel: { name: "RemaData", primary: true },
    airteltigo: { name: "RemaData", primary: true },
};

let profitSettingsPromise = null;
let profitSettingsCache = null;
let lastCacheUpdate = 0;
const CACHE_TTL = 5 * 60 * 1000;

// ─────────────────────────────────────────────
//  VOLUME MAPPING FOR REMADATA
// ─────────────────────────────────────────────

const REMA_MB_MAP = {
    1024: 1000, 2048: 2000, 3072: 3000, 4096: 4000,
    5120: 5000, 6144: 6000, 7168: 7000, 8192: 8000,
    9216: 9000, 10240: 10000, 11264: 11000, 12288: 12000,
    13312: 13000, 14336: 14000, 15360: 15000, 16384: 16000,
    17408: 17000, 18432: 18000, 19456: 19000, 20480: 20000,
    25600: 25000, 30720: 30000, 40960: 40000, 51200: 50000,
    102400: 100000
};

// ─────────────────────────────────────────────
//  BUNDLE DATA (HARDCODED FOR RELIABILITY)
// ─────────────────────────────────────────────

const BUNDLE_DATA = {
    mtn: [
        { volumeInMB: 1024, price: 5.00, name: "1GB" },
        { volumeInMB: 2048, price: 9.40, name: "2GB" },
        { volumeInMB: 3072, price: 13.40, name: "3GB" },
        { volumeInMB: 4096, price: 17.70, name: "4GB" },
        { volumeInMB: 5120, price: 22.50, name: "5GB" },
        { volumeInMB: 6144, price: 26.30, name: "6GB" },
        { volumeInMB: 10240, price: 43.20, name: "10GB" },
        { volumeInMB: 15360, price: 63.20, name: "15GB" },
        { volumeInMB: 20480, price: 82.70, name: "20GB" },
        { volumeInMB: 25600, price: 105.20, name: "25GB" },
        { volumeInMB: 30720, price: 126.70, name: "30GB" },
        { volumeInMB: 40960, price: 171.70, name: "40GB" },
        { volumeInMB: 51200, price: 202.70, name: "50GB" },
        { volumeInMB: 102400, price: 437.70, name: "100GB" }
    ],
    telecel: [
        { volumeInMB: 10240, price: 38.00, name: "10GB" },
        { volumeInMB: 15360, price: 55.00, name: "15GB" },
        { volumeInMB: 20480, price: 74.00, name: "20GB" },
        { volumeInMB: 25600, price: 92.00, name: "25GB" },
        { volumeInMB: 30720, price: 109.00, name: "30GB" },
        { volumeInMB: 40960, price: 143.00, name: "40GB" },
        { volumeInMB: 51200, price: 177.00, name: "50GB" },
        { volumeInMB: 102400, price: 354.00, name: "100GB" }
    ],
    airteltigo: [
        { volumeInMB: 1024, price: 3.90, name: "1GB" },
        { volumeInMB: 2048, price: 7.80, name: "2GB" },
        { volumeInMB: 3072, price: 11.80, name: "3GB" },
        { volumeInMB: 4096, price: 15.70, name: "4GB" },
        { volumeInMB: 5120, price: 19.40, name: "5GB" },
        { volumeInMB: 6144, price: 23.80, name: "6GB" },
        { volumeInMB: 7168, price: 27.40, name: "7GB" },
        { volumeInMB: 8192, price: 31.00, name: "8GB" },
        { volumeInMB: 9216, price: 35.00, name: "9GB" },
        { volumeInMB: 10240, price: 39.00, name: "10GB" },
        { volumeInMB: 12288, price: 47.00, name: "12GB" },
        { volumeInMB: 15360, price: 59.00, name: "15GB" },
        { volumeInMB: 20480, price: 78.50, name: "20GB" },
        { volumeInMB: 25600, price: 98.00, name: "25GB" }
    ]
};

// ─────────────────────────────────────────────
//  STRUCTURED ERROR CLASS
// ─────────────────────────────────────────────

class AppError extends Error {
    constructor(message, statusCode = 500, category = "INTERNAL", details = null) {
        super(message);
        this.statusCode = statusCode;
        this.category = category;
        this.details = details;
        this.isOperational = true;
    }
}

function asyncHandler(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ─────────────────────────────────────────────
//  CUSTOMER-FRIENDLY ERROR MESSAGES
// ─────────────────────────────────────────────

function getCustomerFriendlyMessage(network, technicalDetails) {
    const messages = {
        mtn: "MTN data delivery is temporarily unavailable. Please try again in a few minutes. If the issue persists, contact support.",
        telecel: "Telecel data delivery is temporarily unavailable. Please try again in a few minutes. If the issue persists, contact support.",
        airteltigo: "AirtelTigo data delivery is temporarily unavailable. Please try again in a few minutes. If the issue persists, contact support."
    };
    const baseMessage = messages[network] || "Data delivery is temporarily unavailable. Please try again later.";
    console.error(`📝 Technical details for ${network}: ${technicalDetails}`);
    return baseMessage;
}

// ─────────────────────────────────────────────
//  RETRY LOGIC
// ─────────────────────────────────────────────

async function fetchWithRetry(apiCall, retries = MAX_RETRIES, delay = RETRY_DELAY_MS) {
    for (let i = 0; i < retries; i++) {
        try {
            return await apiCall();
        } catch (err) {
            const isLastAttempt = i === retries - 1;
            const isProviderError = err.category === "PROVIDER";
            if (isLastAttempt || !isProviderError) throw err;
            const waitTime = delay * Math.pow(2, i);
            console.log(`🔄 Retry ${i + 1}/${retries} after ${waitTime}ms: ${err.message}`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
}

// ─────────────────────────────────────────────
//  STARTUP VALIDATION
// ─────────────────────────────────────────────

function validateEnv() {
    const checks = [
        ["REMADATA_API_KEY", REMADATA_API_KEY, "All deliveries will fail"],
        ["PAYSTACK_SECRET_KEY", PAYSTACK_SECRET, "Webhook signature verification disabled"],
        ["DELIVER_SECRET", DELIVER_SECRET, "Manual delivery endpoint unprotected"],
        ["FIREBASE_DATABASE_URL", process.env.FIREBASE_DATABASE_URL, "Orders will not be saved"],
        ["FIREBASE_SERVICE_ACCOUNT_JSON", process.env.FIREBASE_SERVICE_ACCOUNT_JSON, "Firebase disabled"],
        ["ALLOWED_ORIGINS", process.env.ALLOWED_ORIGINS, "CORS will deny all origins"],
    ];

    const missing = checks.filter(([, val]) => !val);
    if (missing.length) {
        console.warn("⚠️  Missing environment variables:");
        missing.forEach(([key, , impact]) =>
            console.warn(`   • ${key.padEnd(36)} → ${impact}`)
        );
    }

    if (!ALLOWED_ORIGINS.length) {
        console.error("❌ ALLOWED_ORIGINS not set - CORS will deny all requests!");
        console.error("   Set ALLOWED_ORIGINS to your frontend domain(s)");
    } else {
        console.log(`✅ CORS allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
    }
}

// ─────────────────────────────────────────────
//  FIREBASE ADMIN INIT
// ─────────────────────────────────────────────
let db = null;

try {
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?
        JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) :
        null;

    if (serviceAccount && process.env.FIREBASE_DATABASE_URL) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: process.env.FIREBASE_DATABASE_URL,
        });
        db = admin.database();
        console.log("✅ Firebase Admin initialised");
        setInterval(processFailedSaveQueue, 60000);
    } else {
        if (!serviceAccount) console.warn("⚠️  FIREBASE_SERVICE_ACCOUNT_JSON not set — Firebase disabled");
        if (!process.env.FIREBASE_DATABASE_URL) console.warn("⚠️  FIREBASE_DATABASE_URL not set — Firebase disabled");
    }
} catch (err) {
    console.error(`❌ Firebase init failed: ${err.message}`);
}

// ─────────────────────────────────────────────
//  FIREBASE QUEUE PROCESSOR
// ─────────────────────────────────────────────

async function saveOrderWithRetry(ref, payload, retries = 5) {
    if (!db) {
        failedSaveQueue.push({ ref, payload, timestamp: Date.now() });
        console.warn(`⚠️ Firebase unavailable, queued order "${ref}" (queue size: ${failedSaveQueue.length})`);
        return;
    }
    for (let i = 0; i < retries; i++) {
        try {
            await db.ref(`transactions/${ref}`).set(payload);
            console.log(`✅ Order "${ref}" saved to Firebase`);
            return;
        } catch (err) {
            if (i === retries - 1) {
                failedSaveQueue.push({ ref, payload, timestamp: Date.now() });
                console.error(`❌ Failed to save order "${ref}" after ${retries} retries, queued`);
            } else {
                await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
            }
        }
    }
}

async function saveFailedOrderWithRetry(ref, payload, errMessage) {
    const failedPayload = {
        ...payload,
        status: "failed",
        error: errMessage,
        timestamp: new Date().toISOString(),
    };
    await saveOrderWithRetry(ref, failedPayload);
}

async function processFailedSaveQueue() {
    if (isProcessingQueue || !db || failedSaveQueue.length === 0) return;
    isProcessingQueue = true;
    console.log(`🔄 Processing ${failedSaveQueue.length} queued Firebase saves...`);
    const queueCopy = [...failedSaveQueue];
    failedSaveQueue.length = 0;
    for (const item of queueCopy) {
        try {
            await db.ref(`transactions/${item.ref}`).set(item.payload);
            console.log(`✅ Queued order "${item.ref}" saved after recovery`);
        } catch (err) {
            console.error(`❌ Still failed to save "${item.ref}" after recovery, re-queuing`);
            failedSaveQueue.push(item);
        }
    }
    isProcessingQueue = false;
    if (failedSaveQueue.length > 0) {
        setTimeout(processFailedSaveQueue, 30000);
    }
}

// ─────────────────────────────────────────────
//  PROCESSED REFS CLEANUP
// ─────────────────────────────────────────────

setInterval(() => {
    const now = Date.now();
    let deletedCount = 0;
    for (const [ref, timestamp] of processedRefs.entries()) {
        if (now - timestamp > REF_TTL) {
            processedRefs.delete(ref);
            deletedCount++;
        }
    }
    if (processedRefs.size > MAX_REF_SIZE) {
        const excess = processedRefs.size - MAX_REF_SIZE;
        const iterator = processedRefs.keys();
        for (let i = 0; i < excess; i++) {
            processedRefs.delete(iterator.next().value);
        }
        console.warn(`⚠️ Force-cleaned ${excess} old refs, size now ${processedRefs.size}`);
    }
    if (deletedCount > 0) {
        console.log(`🧹 Cleaned ${deletedCount} expired refs, size: ${processedRefs.size}`);
    }
}, 60 * 60 * 1000);

// ─────────────────────────────────────────────
//  CORS MIDDLEWARE (SECURE)
// ─────────────────────────────────────────────

const corsOptions = {
    origin: function(origin, callback) {
        if (!origin) return callback(null, true);
        if (CORS_ORIGIN.length === 0) {
            console.warn(`⚠️ CORS blocked request from: ${origin} - No origins configured`);
            return callback(new AppError('CORS policy blocked this request', 403, 'CORS'));
        }
        if (CORS_ORIGIN.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.warn(`⚠️ CORS blocked request from: ${origin}`);
            callback(new AppError('CORS policy blocked this request', 403, 'CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'X-API-Key'],
    credentials: true,
    maxAge: 86400
};

app.use(cors(corsOptions));

// ─────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────

app.use((req, res, next) => {
    if (req.path === "/paystack/webhook") {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            req.rawBody = Buffer.concat(chunks);
            try {
                req.body = JSON.parse(req.rawBody.toString());
            } catch {
                req.body = {};
            }
            next();
        });
        req.on("error", next);
    } else {
        express.json()(req, res, next);
    }
});

app.use((req, res, next) => {
    req.setTimeout(30000);
    res.setTimeout(30000);
    next();
});

app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
        const ms = Date.now() - start;
        const icon = res.statusCode < 400 ? "✓" : res.statusCode < 500 ? "⚠" : "✗";
        console.log(`${icon} ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
    });
    next();
});

// ─────────────────────────────────────────────
//  AUTH MIDDLEWARE
// ─────────────────────────────────────────────

function requireApiKey(req, res, next) {
    if (!DELIVER_SECRET) {
        return next(new AppError("DELIVER_SECRET not configured", 500, "INTERNAL"));
    }
    const key = req.headers["x-api-key"] || req.headers["X-API-Key"] || req.body?.apiKey;
    if (!key || key !== DELIVER_SECRET) {
        console.warn(`🚫 Unauthorized attempt on ${req.path} — IP: ${req.ip}`);
        return next(new AppError("Invalid or missing API key", 401, "AUTH"));
    }
    next();
}

// ─────────────────────────────────────────────
//  FRONTEND HTML - COMPLETE (SERVED FROM SERVER)
// ─────────────────────────────────────────────

// NOTE: This is a MINIMAL working frontend.
// Replace with your full HTML if needed.

const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DataFlow GH</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cabinet+Grotesk:wght@400;500;700;800;900&family=Epilogue:ital,wght@0,300;0,400;0,500;1,300&display=swap" rel="stylesheet">
<script src="https://js.paystack.co/v1/inline.js"></script>
<script src="https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/9.22.2/firebase-auth-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/9.22.2/firebase-database-compat.js"></script>
<style>
:root {
  --bg: #06060A; --surface: #0E0E15; --card: #13131C; --border: #1E1E2E; --text: #E8E8F0;
  --muted: #5A5A78; --faint: #22223A; --mtn: #FFCC00; --tel: #E8212A;
  --at: #007DC5; --green: #00D98B; --red: #FF4455; --orange: #FF9500;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Epilogue', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
nav { position: sticky; top: 0; z-index: 200; display: flex; justify-content: space-between; align-items: center; padding: 1rem 2.5rem; background: rgba(6,6,10,.92); backdrop-filter: blur(20px); border-bottom: 1px solid #1E1E2E; }
.logo { font-family: 'Cabinet Grotesk', sans-serif; font-weight: 900; font-size: 1.5rem; color: var(--mtn); }
.logo span { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--mtn); margin-right: 0.5rem; }
.nav-links { display: flex; gap: 2rem; align-items: center; }
.nav-links a { color: var(--muted); text-decoration: none; font-size: .9rem; font-weight: 500; }
.section { max-width: 1400px; margin: 0 auto; padding: 3rem 2.5rem; }
.sec-title { font-family: 'Cabinet Grotesk', sans-serif; font-size: 2.2rem; font-weight: 900; }
.sec-sub { color: var(--muted); font-size: .9rem; margin-top: .5rem; }
.sec-head { margin-bottom: 2rem; }
.tabs { display: flex; gap: .8rem; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: .5rem; width: fit-content; margin-bottom: 2rem; }
.tab-btn { padding: .6rem 1.6rem; border: none; border-radius: 10px; background: transparent; color: var(--muted); font-family: 'Cabinet Grotesk', sans-serif; font-size: .9rem; font-weight: 700; cursor: pointer; transition: all .25s; }
.tab-btn.active-mtn { background: rgba(255,204,0,.14); color: var(--mtn); }
.tab-btn.active-tel { background: rgba(232,33,42,.12); color: var(--tel); }
.tab-btn.active-at { background: rgba(0,125,197,.14); color: var(--at); }
.bundles-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 1.5rem; }
.bundle-panel { background: var(--card); border: 1px solid var(--border); border-radius: 18px; padding: 1.6rem; cursor: pointer; position: relative; transition: transform .2s, box-shadow .2s; animation: fadeUp .35s ease both; }
.bundle-panel:hover { transform: translateY(-5px); border-color: var(--active); box-shadow: 0 18px 50px rgba(0,0,0,.5); }
.bundle-panel.hot { border-color: rgba(255,204,0,.28); }
.hot-label { position: absolute; top: 1rem; right: 1rem; font-size: .6rem; font-weight: 800; letter-spacing: .8px; text-transform: uppercase; padding: .2rem .6rem; border-radius: 5px; background: var(--mtn); color: #06060A; }
.bp-network { font-size: .7rem; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; margin-bottom: .8rem; color: var(--mtn); }
.bp-size { font-family: 'Cabinet Grotesk', sans-serif; font-size: 2.8rem; font-weight: 900; line-height: 1; margin-bottom: .3rem; }
.bp-validity { font-size: .8rem; color: var(--muted); margin-bottom: 1.2rem; }
.bp-price { font-family: 'Cabinet Grotesk', sans-serif; font-size: 1.4rem; font-weight: 800; margin-bottom: .2rem; }
.bp-ppgb { font-size: .7rem; color: var(--muted); margin-bottom: 1rem; }
.bp-btn { width: 100%; padding: .75rem; background: var(--faint); border: 1px solid var(--border); border-radius: 10px; color: var(--text); font-family: 'Cabinet Grotesk', sans-serif; font-size: .85rem; font-weight: 700; cursor: pointer; transition: all .2s; }
.bp-btn:hover { background: var(--active); border-color: var(--active); color: var(--bg); }
.coming-soon-panel { background: var(--card); border: 1px solid var(--border); border-radius: 18px; padding: 2rem; text-align: center; opacity: 0.7; }
@keyframes fadeUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
.toast { position: fixed; bottom: 2rem; right: 2rem; z-index: 9999; background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 1rem 1.3rem; display: flex; align-items: center; gap: .7rem; font-size: .88rem; max-width: 360px; transform: translateY(90px); opacity: 0; transition: all .35s; }
.toast.show { transform: translateY(0); opacity: 1; }
.toast.success { border-color: var(--green); }
.toast.error { border-color: var(--red); }
.toast.warning { border-color: var(--orange); }
.spin { width: 18px; height: 18px; border: 2.5px solid rgba(0,0,0,.25); border-top-color: rgba(0,0,0,.8); border-radius: 50%; animation: rot .5s linear infinite; }
@keyframes rot { to { transform: rotate(360deg); } }
</style>
</head>
<body>

<nav>
  <div class="logo"><span></span> DataFlow</div>
  <div class="nav-links"><a href="#bundles">Bundles</a><a href="#how">How It Works</a></div>
</nav>

<div class="section" id="bundles">
  <div class="sec-head">
    <h2 class="sec-title">Data Bundles</h2>
    <p class="sec-sub">Select a network below to browse available packages</p>
  </div>
  <div class="tabs">
    <button class="tab-btn active-mtn" id="tab-mtn" onclick="switchNetwork('mtn')">MTN</button>
    <button class="tab-btn" id="tab-tel" onclick="switchNetwork('tel')">Telecel</button>
    <button class="tab-btn" id="tab-at" onclick="switchNetwork('at')">AT</button>
  </div>
  <div class="bundles-grid" id="bundlesGrid"></div>
</div>

<div class="section" id="how">
  <div class="sec-head">
    <h2 class="sec-title">How It Works</h2>
    <p class="sec-sub">Three steps to stay connected</p>
  </div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1.5rem;">
    <div style="background:var(--card);border:1px solid var(--border);border-radius:18px;padding:2rem;">
      <div style="font-size:1.6rem;margin-bottom:.8rem;">📡</div>
      <div style="font-family:'Cabinet Grotesk',sans-serif;font-size:3.2rem;font-weight:900;color:var(--faint);line-height:1;margin-bottom:1rem;">01</div>
      <h3 style="font-family:'Cabinet Grotesk',sans-serif;font-size:1.1rem;font-weight:800;margin-bottom:.5rem;">Choose Your Network</h3>
      <p style="color:var(--muted);font-size:.85rem;line-height:1.7;">Pick MTN, Telecel, or AT and browse bundles tailored for each network — from 1GB to 50GB.</p>
    </div>
    <div style="background:var(--card);border:1px solid var(--border);border-radius:18px;padding:2rem;">
      <div style="font-size:1.6rem;margin-bottom:.8rem;">🔒</div>
      <div style="font-family:'Cabinet Grotesk',sans-serif;font-size:3.2rem;font-weight:900;color:var(--faint);line-height:1;margin-bottom:1rem;">02</div>
      <h3 style="font-family:'Cabinet Grotesk',sans-serif;font-size:1.1rem;font-weight:800;margin-bottom:.5rem;">Pay Securely</h3>
      <p style="color:var(--muted);font-size:.85rem;line-height:1.7;">Complete payment via Paystack using card, bank transfer, or MoMo. 100% secure and instant.</p>
    </div>
    <div style="background:var(--card);border:1px solid var(--border);border-radius:18px;padding:2rem;">
      <div style="font-size:1.6rem;margin-bottom:.8rem;">⚡</div>
      <div style="font-family:'Cabinet Grotesk',sans-serif;font-size:3.2rem;font-weight:900;color:var(--faint);line-height:1;margin-bottom:1rem;">03</div>
      <h3 style="font-family:'Cabinet Grotesk',sans-serif;font-size:1.1rem;font-weight:800;margin-bottom:.5rem;">Instant Delivery</h3>
      <p style="color:var(--muted);font-size:.85rem;line-height:1.7;">Your data is credited to your number within seconds. No waiting, no stress, no manual steps.</p>
    </div>
  </div>
</div>

<div class="toast" id="toast"><span id="toastMsg"></span></div>

<script>
// ============================================================
// DATEFLOW GH - FRONTEND (FIXED BUNDLE LOADING)
// ============================================================

(function() {
    'use strict';

    // ─────────────────────────────────────────────
    // CONFIG
    // ─────────────────────────────────────────────

    var config = window.__DF_CONFIG || {};
    var PAYSTACK_KEY = config.paystackKey || 'pk_live_ca0cb6cd18a148e6f9a915b4f8bd18be85d335b0';
    var BACKEND_URL = config.backendUrl || window.location.origin;
    var API_BUNDLES = BACKEND_URL + '/api/bundles';

    // ─────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────

    var NETWORK_META = {
        mtn: { label: 'MTN', accent: '#FFCC00', textColor: '#06060A' },
        tel: { label: 'Telecel', accent: '#E8212A', textColor: '#fff' },
        at: { label: 'AT', accent: '#007DC5', textColor: '#fff' }
    };

    var NETWORK_MAP = {
        mtn: 'mtn',
        tel: 'telecel',
        at: 'airteltigo'
    };

    var currentNetwork = 'mtn';
    var selectedBundle = null;
    var BUNDLES_CACHE = {};

    function displaySize(mb) {
        if (mb >= 1024) {
            var gb = mb / 1024;
            return Number.isInteger(gb) ? gb + 'GB' : gb.toFixed(1) + 'GB';
        }
        return mb + 'MB';
    }

    function displaySizeLabel(mb) {
        if (mb === 1000) return '1GB';
        if (mb >= 1024) {
            var gb = mb / 1024;
            var rounded = Math.round(gb);
            var overrides = { 24: 25, 29: 30, 39: 40, 49: 50, 98: 100 };
            return (overrides[rounded] || rounded) + 'GB';
        }
        return mb + 'MB';
    }

    function ppgb(mb, price) {
        var gb = mb / 1024;
        return gb > 0 ? 'GH₵ ' + (price / gb).toFixed(2) + ' / GB' : '';
    }

    function showToast(msg, type) {
        type = type || 'success';
        var el = document.getElementById('toast');
        document.getElementById('toastMsg').textContent = msg;
        el.className = 'toast show ' + type;
        setTimeout(function() { el.className = 'toast'; }, 5000);
    }

    // ─────────────────────────────────────────────
    // FETCH BUNDLES
    // ─────────────────────────────────────────────

    async function fetchBundles(networkType) {
        if (BUNDLES_CACHE[networkType]) return BUNDLES_CACHE[networkType];

        var grid = document.getElementById('bundlesGrid');
        grid.innerHTML = '<div class="coming-soon-panel">⏳ Loading bundles…</div>';

        try {
            var url = API_BUNDLES + '?network=' + networkType;
            console.log('📡 Fetching bundles from:', url);
            var response = await fetch(url);
            var data = await response.json();
            console.log('📦 Bundles response:', data);

            if (data.status !== 'success' || !data.data || !data.data.length) {
                console.warn('No bundles found for:', networkType);
                BUNDLES_CACHE[networkType] = [];
                grid.innerHTML = '<div class="coming-soon-panel">🚀 Coming Soon<br><small style="color:var(--muted)">No bundles available for this network.</small></div>';
                return [];
            }

            var bundles = data.data.map(function(b, i) {
                var volumeMB = Number(b.volumeInMB);
                var price = parseFloat(b.price) || 0;
                return {
                    id: networkType + '_' + i,
                    size: displaySize(volumeMB),
                    volumeInMB: volumeMB,
                    networkType: networkType,
                    price: price,
                    hot: [1024, 5120, 10240].includes(volumeMB)
                };
            });

            BUNDLES_CACHE[networkType] = bundles;
            return bundles;
        } catch (err) {
            console.error('Failed to load bundles:', err);
            BUNDLES_CACHE[networkType] = [];
            grid.innerHTML = '<div class="coming-soon-panel">❌ Error loading bundles<br><small style="color:var(--muted)">Please refresh the page.</small></div>';
            return [];
        }
    }

    // ─────────────────────────────────────────────
    // RENDER BUNDLES
    // ─────────────────────────────────────────────

    async function renderBundles(tabKey) {
        var meta = NETWORK_META[tabKey];
        var networkType = NETWORK_MAP[tabKey];
        var grid = document.getElementById('bundlesGrid');
        document.documentElement.style.setProperty('--active', meta.accent);

        var list = await fetchBundles(networkType);
        if (!list.length) {
            grid.innerHTML = '<div class="coming-soon-panel">🚀 Coming Soon<br><small style="color:var(--muted)">' + meta.label + ' bundles will be available shortly.</small></div>';
            return;
        }

        grid.innerHTML = list.map(function(b, i) {
            return '<div class="bundle-panel ' + (b.hot ? 'hot' : '') + '" style="animation-delay:' + (i * 0.05) + 's">' +
                (b.hot ? '<div class="hot-label" style="background:' + meta.accent + ';color:' + meta.textColor + '">Popular</div>' : '') +
                '<div class="bp-network" style="color:' + meta.accent + '">' + meta.label + '</div>' +
                '<div class="bp-size" style="color:' + meta.accent + '">' + displaySizeLabel(b.volumeInMB) + '</div>' +
                '<div class="bp-validity">Valid 90 Days</div>' +
                '<div class="bp-price">GH₵ ' + b.price.toFixed(2) + '</div>' +
                '<div class="bp-ppgb">' + ppgb(b.volumeInMB, b.price) + '</div>' +
                '<button class="bp-btn" data-id="' + b.id + '" data-network="' + tabKey + '" style="--active:' + meta.accent + '">Buy Now →</button>' +
                '</div>';
        }).join('');

        grid.querySelectorAll('.bp-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                var id = e.currentTarget.dataset.id;
                var network = e.currentTarget.dataset.network;
                var bundle = list.find(function(b) { return b.id === id; });
                if (bundle) {
                    selectedBundle = bundle;
                    showToast('✅ Selected: ' + bundle.size + ' for ' + NETWORK_META[network].label, 'success');
                }
            });
        });
    }

    // ─────────────────────────────────────────────
    // SWITCH NETWORK
    // ─────────────────────────────────────────────

    window.switchNetwork = function(tabKey) {
        currentNetwork = tabKey;
        ['mtn', 'tel', 'at'].forEach(function(n) {
            var tab = document.getElementById('tab-' + n);
            if (tab) {
                tab.className = 'tab-btn';
                if (n === tabKey) tab.classList.add('active-' + n);
            }
        });
        renderBundles(tabKey);
    };

    // ─────────────────────────────────────────────
    // INIT
    // ─────────────────────────────────────────────

    renderBundles('mtn');
    console.log('🔒 DataFlow GH - Frontend Loaded');
    console.log('📡 Backend:', BACKEND_URL);

})();
</script>
</body>
</html>`;

// ─────────────────────────────────────────────
//  SERVE FRONTEND
// ─────────────────────────────────────────────

app.get('/', (req, res) => {
    const injectScript = `
    <script>
      window.__DF_CONFIG = {
        paystackKey: "${process.env.PAYSTACK_PUBLIC_KEY || 'pk_live_ca0cb6cd18a148e6f9a915b4f8bd18be85d335b0'}",
        backendUrl: "${process.env.BACKEND_URL || ''}"
      };
      console.log('🔒 Secure config loaded');
    </script>
    `;
    let html = FRONTEND_HTML;
    html = html.replace('</head>', injectScript + '</head>');
    res.send(html);
});

// ─────────────────────────────────────────────
//  API: BUNDLES (FIXED)
// ─────────────────────────────────────────────

app.get("/api/bundles", limiter, asyncHandler(async (req, res) => {
    const network = (req.query.network || "mtn").toLowerCase();
    console.log(`📡 Bundles requested for: ${network}`);

    // Check if network exists
    if (!BUNDLE_DATA[network]) {
        console.log(`❌ Network not found: ${network}`);
        return res.status(400).json({
            status: "error",
            message: `Network "${network}" not supported`,
            supported: Object.keys(BUNDLE_DATA)
        });
    }

    // Get bundles for this network
    let bundles = BUNDLE_DATA[network];
    console.log(`📦 Found ${bundles.length} bundles for ${network}`);

    // Apply profit settings if available
    try {
        const settings = await getProfitSettings();
        if (settings && settings.mode) {
            bundles = bundles.map((b) => ({
                ...b,
                costPrice: b.price,
                price: applyProfit(b.price, b.volumeInMB, network, settings),
            }));
        } else {
            bundles = bundles.map((b) => ({
                ...b,
                costPrice: b.price,
                price: b.price,
            }));
        }
    } catch (err) {
        console.warn('Profit settings error:', err.message);
        bundles = bundles.map((b) => ({
            ...b,
            costPrice: b.price,
            price: b.price,
        }));
    }

    // Return bundles
    res.json({
        status: "success",
        data: bundles,
        count: bundles.length,
        network: network
    });
}));

// ─────────────────────────────────────────────
//  PHONE FORMATTING HELPERS
// ─────────────────────────────────────────────

function formatPhoneLocal(phone) {
    let p = String(phone).replace(/[\s\-]/g, "");
    if (p.startsWith("233")) p = "0" + p.slice(3);
    if (p.startsWith("+233")) p = "0" + p.slice(4);
    if (!p.startsWith("0")) p = "0" + p;
    if (!/^0\d{9}$/.test(p)) {
        throw new AppError(`Phone must be 10 digits starting with 0 (e.g., 0551234567), got: "${phone}"`, 400, "VALIDATION");
    }
    return p;
}

// ─────────────────────────────────────────────
//  PROFIT SETTINGS
// ─────────────────────────────────────────────

async function getProfitSettings() {
    if (profitSettingsCache && (Date.now() - lastCacheUpdate) < CACHE_TTL) {
        return profitSettingsCache;
    }
    if (profitSettingsPromise) return profitSettingsPromise;
    profitSettingsPromise = (async () => {
        if (!db) {
            const defaultSettings = { mode: "flat", flatAmount: 0 };
            profitSettingsCache = defaultSettings;
            lastCacheUpdate = Date.now();
            return defaultSettings;
        }
        try {
            const snap = await db.ref("system/profitSettings").once("value");
            profitSettingsCache = snap.val() || { mode: "flat", flatAmount: 0 };
            lastCacheUpdate = Date.now();
            return profitSettingsCache;
        } catch (err) {
            console.warn(`⚠️ Could not load profit settings: ${err.message}`);
            return { mode: "flat", flatAmount: 0 };
        } finally {
            profitSettingsPromise = null;
        }
    })();
    return profitSettingsPromise;
}

function applyProfit(costPrice, volumeInMB, network, settings) {
    if (!settings) return costPrice;
    const { mode, flatAmount = 0, percentAmount = 0, perBundle = {} } = settings;
    if (mode === "percent") {
        const pct = parseFloat(percentAmount) || 0;
        return Math.ceil(costPrice * (1 + pct / 100) * 20) / 20;
    }
    if (mode === "perBundle") {
        const key = `${network}_${volumeInMB}`;
        const bundleProfit = parseFloat(perBundle?.[key]) || parseFloat(flatAmount) || 0;
        return Math.ceil((costPrice + bundleProfit) * 20) / 20;
    }
    const flat = parseFloat(flatAmount) || 0;
    return Math.ceil((costPrice + flat) * 20) / 20;
}

// ─────────────────────────────────────────────
//  DELIVERY FUNCTIONS
// ─────────────────────────────────────────────

async function deliverViaRemaData(phone, networkType, volumeInMB, reference) {
    if (!REMADATA_API_KEY) {
        throw new AppError("RemaData API not configured. Please set REMADATA_API_KEY environment variable.", 503, "CONFIGURATION");
    }
    const orderRef = reference || `DF-${Date.now()}`;
    const localPhone = formatPhoneLocal(phone);
    const remaMB = REMA_MB_MAP[Number(volumeInMB)] || Number(volumeInMB);
    let remaNetworkType = "mtn";
    if (networkType === "telecel") remaNetworkType = "telecel";
    if (networkType === "airteltigo") remaNetworkType = "airteltigo";
    const payload = { ref: orderRef, phone: localPhone, volumeInMB: remaMB, networkType: remaNetworkType };
    console.log(`📦 [RemaData] ${volumeInMB}MB → ${remaMB}MB ${networkType} → ${localPhone} | Ref: ${orderRef}`);
    const response = await fetchWithRetry(async () => {
        return await axios.post(`${REMADATA_API_URL}/buy-data`, payload, {
            headers: { "X-API-KEY": REMADATA_API_KEY, "Content-Type": "application/json" },
            timeout: 30000,
        });
    });
    if (response.data?.status !== "success") {
        const providerMsg = response.data?.message || response.data?.error || "Unknown provider error";
        throw new AppError(`RemaData delivery rejected: ${providerMsg}`, 502, "PROVIDER", { providerResponse: response.data });
    }
    const remaReference = response.data?.data?.reference || response.data?.reference || orderRef;
    console.log(`✅ [RemaData] Delivered | Provider ref: ${remaReference}`);
    return { success: true, reference: remaReference, data: response.data, provider: "RemaData" };
}

async function deliverData(phone, networkType, volumeInMB, reference = null) {
    const net = networkType?.toLowerCase();
    const providerConfig = NETWORK_PROVIDER[net];
    if (!providerConfig) {
        throw new AppError(`Unsupported network: "${networkType}". Valid: ${Object.keys(NETWORK_PROVIDER).join(", ")}`, 400, "VALIDATION");
    }
    try {
        console.log(`📡 Delivering ${net} via RemaData`);
        return await deliverViaRemaData(phone, net, volumeInMB, reference);
    } catch (error) {
        const customerMessage = getCustomerFriendlyMessage(net, error.message);
        throw new AppError(customerMessage, 503, "PROVIDER", { network: net, provider: "RemaData", error: error.message });
    }
}

// ─────────────────────────────────────────────
//  PAYSTACK WEBHOOK
// ─────────────────────────────────────────────

function verifyPaystackSignature(rawBody, signature) {
    if (!PAYSTACK_SECRET || !rawBody || !signature) return false;
    const hash = crypto.createHmac("sha512", PAYSTACK_SECRET).update(rawBody).digest("hex");
    return hash === signature;
}

app.post("/paystack/webhook", async (req, res) => {
    const signature = req.headers["x-paystack-signature"];
    if (!verifyPaystackSignature(req.rawBody, signature)) {
        console.warn("⚠️ Paystack webhook: invalid signature");
        return res.status(401).json({ error: "Invalid signature" });
    }
    const event = req.body;
    if (!event?.event) {
        console.error("❌ Webhook: empty or malformed body");
        return res.status(400).json({ error: "Invalid body" });
    }
    console.log(`📨 Webhook: ${event.event}`);
    res.status(200).json({ received: true });
    if (event.event !== "charge.success") return;
    const { data } = event;
    const meta = data.metadata || {};
    const phone = meta.phone || meta.customer_phone;
    const networkType = meta.networkType || meta.network_type;
    const volumeInMB = meta.volumeInMB || meta.volume_in_mb;
    const ref = data.reference;
    const amount = data.amount ? data.amount / 100 : 0;
    const baseOrderData = { ref, phone, networkType, volumeInMB, amount, source: "paystack_webhook" };
    if (!phone || !volumeInMB || !networkType) {
        console.warn(`⚠️ Webhook: missing metadata — phone=${phone}, volume=${volumeInMB}, network=${networkType}`);
        return;
    }
    if (processedRefs.has(ref)) {
        console.warn(`⚠️ Webhook: duplicate ref ignored — ${ref}`);
        return;
    }
    processedRefs.set(ref, Date.now());
    console.log(`💳 Webhook auto-delivery: ${networkType} ${volumeInMB}MB → ${phone}`);
    try {
        const result = await deliverData(phone, networkType, Number(volumeInMB), ref);
        await saveOrderWithRetry(ref, {
            ...baseOrderData,
            status: "completed",
            provider: result.provider,
            providerRef: result.reference,
            timestamp: new Date().toISOString(),
        });
        console.log(`✅ Webhook delivery complete | Provider: ${result.provider}`);
    } catch (err) {
        console.error(`❌ Webhook delivery failed: ${err.message}`);
        await saveFailedOrderWithRetry(ref, baseOrderData, err.message);
        processedRefs.delete(ref);
    }
});

// ─────────────────────────────────────────────
//  API: ORDER STATUS
// ─────────────────────────────────────────────

app.get("/api/order-status/:reference", limiter, asyncHandler(async (req, res) => {
    const { reference } = req.params;
    if (!reference) {
        throw new AppError("Reference parameter is required", 400, "VALIDATION");
    }
    if (!/^[a-zA-Z0-9\-]+$/.test(reference)) {
        throw new AppError("Invalid reference format", 400, "VALIDATION");
    }

    // Check Firebase first
    if (db) {
        try {
            const snapshot = await db.ref('orders').orderByChild('orderId').equalTo(reference).once('value');
            const data = snapshot.val();
            if (data) {
                const order = Object.values(data)[0];
                return res.json({ status: "success", source: "firebase", order: order });
            }
            const refSnapshot = await db.ref('orders').orderByChild('ref').equalTo(reference).once('value');
            const refData = refSnapshot.val();
            if (refData) {
                const order = Object.values(refData)[0];
                return res.json({ status: "success", source: "firebase", order: order });
            }
        } catch (err) {
            console.warn('Firebase lookup error:', err.message);
        }
    }

    // Check RemaData
    if (!REMADATA_API_KEY) {
        throw new AppError("RemaData API not configured", 503, "CONFIGURATION");
    }
    try {
        const response = await axios.get(`${REMADATA_API_URL}/order-status/${encodeURIComponent(reference)}`, {
            headers: { "X-API-KEY": REMADATA_API_KEY },
            timeout: 10000
        });
        if (response.data?.status === "success") {
            return res.json({ status: "success", provider: "RemaData", reference: reference, data: response.data.data });
        } else {
            throw new AppError("Order not found", 404, "NOT_FOUND");
        }
    } catch (err) {
        if (err.response?.status === 404 || err.statusCode === 404) {
            throw new AppError("Order not found", 404, "NOT_FOUND");
        }
        throw new AppError(`Failed to check order status: ${err.message}`, 502, "PROVIDER");
    }
}));

// ─────────────────────────────────────────────
//  API: DELIVER (ADMIN ONLY)
// ─────────────────────────────────────────────

app.post("/deliver", requireApiKey, limiter, asyncHandler(async (req, res) => {
    const { phone, networkType, volumeInMB, ref } = req.body;
    if (!phone || !networkType || !volumeInMB) {
        throw new AppError("Missing required fields: phone, networkType, volumeInMB", 400, "VALIDATION");
    }
    const validNetworks = Object.keys(NETWORK_PROVIDER);
    if (!validNetworks.includes(networkType.toLowerCase())) {
        throw new AppError(`Invalid network "${networkType}"`, 400, "VALIDATION");
    }
    const volumeNum = Number(volumeInMB);
    if (isNaN(volumeNum) || volumeNum <= 0) {
        throw new AppError("volumeInMB must be a positive number", 400, "VALIDATION");
    }
    const result = await deliverData(phone, networkType.toLowerCase(), volumeNum, ref);
    console.log(`✅ Manual delivery complete | Provider: ${result.provider}`);
    res.json({
        status: "success",
        provider: result.provider,
        reference: result.reference,
        data: result.data,
    });
}));

// ─────────────────────────────────────────────
//  API: PROFIT SETTINGS (ADMIN ONLY)
// ─────────────────────────────────────────────

app.get("/api/profit-settings", requireApiKey, asyncHandler(async (req, res) => {
    const settings = await getProfitSettings();
    res.json({ status: "success", settings });
}));

app.post("/api/profit-settings", requireApiKey, asyncHandler(async (req, res) => {
    const { mode, flatAmount, percentAmount, perBundle } = req.body;
    const validModes = ["flat", "percent", "perBundle"];
    if (!validModes.includes(mode)) {
        throw new AppError(`Invalid mode "${mode}"`, 400, "VALIDATION");
    }
    const settings = {
        mode,
        flatAmount: parseFloat(flatAmount) || 0,
        percentAmount: parseFloat(percentAmount) || 0,
        perBundle: perBundle || {},
        updatedAt: new Date().toISOString(),
    };
    if (db) {
        try {
            await db.ref("system/profitSettings").set(settings);
        } catch (err) {
            throw new AppError(`Failed to save settings: ${err.message}`, 500, "FIREBASE");
        }
    }
    profitSettingsCache = settings;
    lastCacheUpdate = Date.now();
    profitSettingsPromise = null;
    res.json({ status: "success", settings });
}));

// ─────────────────────────────────────────────
//  API: BALANCE
// ─────────────────────────────────────────────

app.get("/api/balance", limiter, asyncHandler(async (req, res) => {
    if (!REMADATA_API_KEY) {
        throw new AppError("RemaData API not configured", 503, "CONFIGURATION");
    }
    try {
        const response = await axios.get(`${REMADATA_API_URL}/wallet-balance`, {
            headers: { "X-API-KEY": REMADATA_API_KEY },
            timeout: 10000,
        });
        res.json(response.data);
    } catch (err) {
        throw new AppError(`Failed to fetch balance: ${err.message}`, 502, "PROVIDER");
    }
}));

// ─────────────────────────────────────────────
//  HEALTH CHECK
// ─────────────────────────────────────────────

app.get("/health", (req, res) => {
    const criticalIssues = [];
    if (!REMADATA_API_KEY) criticalIssues.push("All deliveries will fail");
    if (!DELIVER_SECRET) criticalIssues.push("/deliver endpoint unprotected");
    if (!ALLOWED_ORIGINS.length) criticalIssues.push("CORS will deny all requests");
    res.json({
        status: criticalIssues.length > 0 ? "DEGRADED" : "OK",
        service: "DataFlow GH",
        timestamp: new Date().toISOString(),
        criticalIssues,
        providers: {
            mtn: { configured: !!REMADATA_API_KEY },
            telecel: { configured: !!REMADATA_API_KEY },
            airteltigo: { configured: !!REMADATA_API_KEY },
        },
        firebase: !!db,
        webhook: !!PAYSTACK_SECRET,
        cors: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : "DENY ALL",
        bundles: {
            mtn: BUNDLE_DATA.mtn.length,
            telecel: BUNDLE_DATA.telecel.length,
            airteltigo: BUNDLE_DATA.airteltigo.length
        }
    });
});

// ─────────────────────────────────────────────
//  404 HANDLER
// ─────────────────────────────────────────────

app.use((req, res) => {
    res.status(404).json({ status: "error", message: `Route not found: ${req.method} ${req.url}` });
});

// ─────────────────────────────────────────────
//  ERROR HANDLER
// ─────────────────────────────────────────────

app.use((err, req, res, next) => {
    const isOperational = err.isOperational === true;
    const statusCode = err.statusCode || 500;
    const category = err.category || "INTERNAL";
    if (isOperational) {
        console.warn(`⚠️ [${category}] ${err.message}`);
    } else {
        console.error(`💥 [UNHANDLED] ${err.message}\n${err.stack}`);
    }
    const body = {
        status: "error",
        category,
        message: isOperational ? err.message : "Internal server error",
    };
    if (err.details && process.env.NODE_ENV !== "production") {
        body.details = err.details;
    }
    res.status(statusCode).json(body);
});

// ─────────────────────────────────────────────
//  GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────

process.on("SIGTERM", async () => {
    console.log("🛑 SIGTERM received, starting graceful shutdown...");
    if (failedSaveQueue.length > 0) {
        console.log(`📦 Processing ${failedSaveQueue.length} queued saves before shutdown...`);
        await processFailedSaveQueue();
    }
    console.log("✅ Graceful shutdown complete");
    process.exit(0);
});

process.on("SIGINT", async () => {
    console.log("🛑 SIGINT received, shutting down...");
    process.exit(0);
});

// ─────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────

validateEnv();

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║   🚀  DataFlow GH Backend — Running                         ║
║   📡  Port: ${String(PORT).padEnd(37)}║
║   📦  MTN Bundles: ${String(BUNDLE_DATA.mtn.length).padEnd(33)}║
║   📦  Telecel Bundles: ${String(BUNDLE_DATA.telecel.length).padEnd(29)}║
║   📦  AT Bundles: ${String(BUNDLE_DATA.airteltigo.length).padEnd(34)}║
╠══════════════════════════════════════════════════════════════╣
║  Status:                                                    ║
${`  • REMADATA_API_KEY: ${REMADATA_API_KEY ? '✅' : '❌'}`.padEnd(60)}║
${`  • PAYSTACK_SECRET_KEY: ${PAYSTACK_SECRET ? '✅' : '❌'}`.padEnd(60)}║
${`  • DELIVER_SECRET: ${DELIVER_SECRET ? '✅' : '❌'}`.padEnd(60)}║
${`  • Firebase: ${db ? '✅' : '❌'}`.padEnd(60)}║
${`  • CORS Origins: ${ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS.join(', ') : 'DENY ALL'}`.padEnd(60)}║
╚══════════════════════════════════════════════════════════════╝`);
});

module.exports = app;
