import http from 'node:http';
import { runMigrations, getDatabase, ensureDatabaseInitialized } from '../packages/db/src/index.js';
import { startServer as startPaymentApi } from '../apps/payment-api/src/index.js';
import { startCheckoutServer } from '../apps/checkout-portal/src/index.js';
import { startAdminServer } from '../apps/merchant-admin/src/index.js';

// Render automatically assigns PORT (typically 10000)
const PUBLIC_PORT = Number(process.env.PORT || 10000);

process.env.YOUPI_MODE = 'localhost';
process.env.YOUPI_ALLOW_LOCALHOST_MODE = 'true';
process.env.USE_SQLITE_FALLBACK = 'true';
process.env.ADMIN_PIN = process.env.ADMIN_PIN || '2026';

console.log('============================================================');
console.log('🚀 Starting AC-Pay All-in-One Cloud Gateway for Render');
console.log('============================================================');

// 1. Initialize SQLite Database & Migrations
const db = getDatabase();
ensureDatabaseInitialized(db);
runMigrations(db);
console.log('[✓] Database initialized & migrations applied.');

// 2. Launch Core Microservices on internal ephemeral ports (0 = OS assigns free port)
const apiInstance = await startPaymentApi(0, db);
const apiPort = apiInstance.port;
console.log(`[✓] Payment Core API online on internal port ${apiPort}`);

const checkoutInstance = await startCheckoutServer(0, {
  apiBaseUrl: `http://127.0.0.1:${apiPort}`
});
const checkoutPort = checkoutInstance.port;
console.log(`[✓] Checkout Portal online on internal port ${checkoutPort}`);

const adminInstance = await startAdminServer(0, {
  db,
  apiBaseUrl: `http://127.0.0.1:${apiPort}`
});
const adminPort = adminInstance.port;
console.log(`[✓] Merchant Admin online on internal port ${adminPort}`);

// Helper to proxy requests to internal service
function proxyRequest(req, res, targetPort) {
  const options = {
    hostname: '127.0.0.1',
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      'x-forwarded-host': req.headers.host || '',
      'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https',
      host: `127.0.0.1:${targetPort}`
    }
  };

  const proxy = http.request(options, (targetRes) => {
    res.writeHead(targetRes.statusCode, targetRes.headers);
    targetRes.pipe(res, { end: true });
  });

  proxy.on('error', (err) => {
    console.error(`[Gateway Proxy Error] target:${targetPort} path:${req.url}`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Service Unavailable', details: err.message }));
    }
  });

  req.pipe(proxy, { end: true });
}

// 3. Start Public Unified Gateway on Render's assigned port
const gateway = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  // Health check endpoint for Render & UptimeRobot
  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'UP',
      service: 'ac-pay-cloud',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // Route: Admin Dashboard & Admin APIs -> Merchant Admin
  if (urlPath === '/admin' || urlPath.startsWith('/admin/')) {
    return proxyRequest(req, res, adminPort);
  }

  // Route: Payment APIs, SSE, Callbacks, Devices -> Payment API
  if (
    urlPath.startsWith('/api/') ||
    urlPath.startsWith('/sse') ||
    urlPath.startsWith('/v1/') ||
    urlPath.startsWith('/merchant/') ||
    urlPath.startsWith('/counter/') ||
    urlPath.startsWith('/auth/') ||
    urlPath.startsWith('/device/')
  ) {
    return proxyRequest(req, res, apiPort);
  }

  // Route: Everything else (Checkout, Stand, Assets, CSS, Fonts) -> Checkout Portal
  return proxyRequest(req, res, checkoutPort);
});

gateway.listen(PUBLIC_PORT, '0.0.0.0', () => {
  console.log(`\n🎉 AC-Pay Cloud Gateway successfully listening on port ${PUBLIC_PORT}`);
  console.log('============================================================\n');
});
