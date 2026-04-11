require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const morgan = require('morgan');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const app = express();

// Trust the first proxy (HAProxy / nginx / k8s ingress)
// Required for express-rate-limit to work correctly behind a reverse proxy
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;

if (!JWT_SECRET) console.warn('[GATEWAY] WARNING: JWT_SECRET is not set');
if (!INTERNAL_SERVICE_TOKEN) console.warn('[GATEWAY] WARNING: INTERNAL_SERVICE_TOKEN is not set');

// ── Rate limiting ─────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, please slow down' },
});

app.use(globalLimiter);

// ── CORS + preflight ──────────────────────────────────────────
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Idempotency-Key,X-Internal-Token');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.sendStatus(204);
  }
  next();
});

app.use(cors({
  origin: (origin, callback) => callback(null, true),
  credentials: true,
}));

// ── Logging ───────────────────────────────────────────────────
app.use(morgan('[:date[iso]] [GATEWAY] :method :url -> :status | :response-time ms'));

// ── Health check (before JWT middleware) ─────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', gateway: 'running', timestamp: new Date().toISOString() });
});

// ── Public routes (no JWT required) ──────────────────────────
const PUBLIC_PREFIXES = [
  '/api/auth/token',
  '/api/auth/register',
  '/api/auth/forgot-password',
  '/health',
];

function isPublic(path) {
  return PUBLIC_PREFIXES.some(prefix => path.startsWith(prefix));
}

// ── JWT middleware ────────────────────────────────────────────
function jwtMiddleware(req, res, next) {
  if (isPublic(req.path)) return next();

  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

app.use(jwtMiddleware);

// ── Proxy factory ─────────────────────────────────────────────
function makeProxy(pathPrefix, targetUrl) {
  return createProxyMiddleware({
    target: targetUrl,
    changeOrigin: true,
    xfwd: true,

    pathRewrite: (path) => path.replace(new RegExp(`^${pathPrefix}`), '') || '/',

    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('X-Internal-Token', INTERNAL_SERVICE_TOKEN || '');

        if (req.user) {
          proxyReq.setHeader('X-User-Id',  String(req.user.user_id || ''));
          proxyReq.setHeader('X-User-Role', String(req.user.role   || ''));
        }

        if (req.headers.authorization) {
          proxyReq.setHeader('Authorization', req.headers.authorization);
        }
      },

      error: (err, req, res) => {
        console.error(`[Proxy Error] ${req.method} ${req.url}`, err.message);
        res.status(503).json({ error: 'Service unavailable' });
      },
    },
  });
}

// ── Route table ───────────────────────────────────────────────
const routes = {
  '/api/auth':         process.env.AUTH_SERVICE_URL,
  '/api/admin/emi':    process.env.EMI_SERVICE_URL,
  '/api/loans':        process.env.LOAN_SERVICE_URL,
  '/api/customer':     process.env.LOAN_SERVICE_URL,
  '/api/emi':          process.env.EMI_SERVICE_URL,
  '/api/wallet':       process.env.WALLET_SERVICE_URL,
  '/api/transactions': process.env.WALLET_SERVICE_URL,
  '/api/payments':     process.env.PAYMENT_SERVICE_URL,
  '/api/verification': process.env.VERIFICATION_SERVICE_URL,
  '/api/admin':        process.env.ADMIN_SERVICE_URL,
  '/api/support':      process.env.ADMIN_SERVICE_URL,
  '/api/manager':      process.env.MANAGER_SERVICE_URL,
};

app.use('/api/auth', authLimiter);

for (const [prefix, url] of Object.entries(routes)) {
  if (url) {
    app.use(prefix, makeProxy(prefix, url));
  } else {
    console.warn(`[GATEWAY] No URL configured for ${prefix}`);
  }
}

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 API Gateway running on http://localhost:${PORT}`);
  console.log(`   JWT auth:      ${JWT_SECRET ? 'enabled' : 'DISABLED (no JWT_SECRET)'}`);
  console.log(`   Rate limiting: enabled (200 global / 20 auth per minute)`);
});