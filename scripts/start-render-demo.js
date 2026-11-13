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
process.env.YOUPI_ENFORCE_OBSERVER_HEALTH = 'false';
process.env.YOUPI_ALLOWED_RETURN_ORIGINS = 'https://kickstart-drab.vercel.app,http://localhost:5173,http://127.0.0.1:5173,http://localhost:5050';

console.log('============================================================');
console.log('🚀 Starting AC-Pay All-in-One Cloud Gateway for Render');
console.log('============================================================');

// 1. Initialize SQLite Database & Migrations
const db = getDatabase();
ensureDatabaseInitialized(db);
const migrationResult = runMigrations(db);
const defaultMerchant = migrationResult?.defaultMerchant;
const defaultApiKey = defaultMerchant?.apiKey || 'youpi_dev_api_key_for_testing_purposes_only';
const defaultMerchantId = defaultMerchant?.id || '00000000-0000-0000-0000-000000000001';
console.log('[✓] Database initialized & migrations applied.');

// Initialize KickStart tables in the production SQLite DB
db.exec(`
  CREATE TABLE IF NOT EXISTS kickstart_registrations (
    id TEXT PRIMARY KEY,
    order_id TEXT UNIQUE NOT NULL,
    student_name TEXT NOT NULL,
    roll_number TEXT NOT NULL,
    department TEXT NOT NULL,
    year TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    selected_ticket_ids TEXT NOT NULL,
    ticket_names TEXT NOT NULL,
    amount_paise INTEGER NOT NULL,
    amount_rupees REAL NOT NULL,
    payment_id TEXT,
    checkout_url TEXT,
    payment_status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
    payment_method TEXT,
    utr TEXT,
    verification_level INTEGER DEFAULT 0,
    resume_name TEXT,
    why_kickstart TEXT,
    registered_at TEXT NOT NULL,
    verified_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ks_reg_roll ON kickstart_registrations (roll_number);
  CREATE INDEX IF NOT EXISTS idx_ks_reg_order ON kickstart_registrations (order_id);
`);
console.log('[✓] KickStart registration schema initialized.');

// Ticket Definitions & Official Prices
const TICKET_DEFS = {
  tech: { id: 'tech', name: 'Technical Interview', price: 50, desc: 'Technical domain round covering DSA, System Design, and Core Branch concepts.', tags: 'Core / Tech', badge: 'Popular', icon: '💻' },
  'non-tech': { id: 'non-tech', name: 'Non-Technical Interview', price: 40, desc: 'Managerial, behavioral, case study, and HR preparation with corporate alumni leaders.', tags: 'Consulting / Product / HR', badge: 'Essential', icon: '📊' },
  mock: { id: 'mock', name: 'Mock Interview', price: 30, desc: 'Full-simulation trial interview with real-time alumni feedback and scoring rubrics.', tags: 'Aptitude + Simulation + GD', badge: 'Recommended', icon: '🎯' }
};

// KickStart API Request Handler
async function handleKickStartApi(req, res, pathname, query, apiPort) {
  // Enable full CORS for KickStart frontend on Vercel
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const sendJson = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // 1. GET /api/kickstart/tickets
  if (req.method === 'GET' && pathname === '/api/kickstart/tickets') {
    return sendJson(200, {
      tickets: Object.values(TICKET_DEFS),
      currency: 'INR',
      event: 'KickStart 2027',
      institution: 'KJ Somaiya College of Engineering — Alumni Cell'
    });
  }

  // Helper to read JSON body
  const readJsonBody = async () => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try { return JSON.parse(raw || '{}'); } catch { return null; }
  };

  // 2. POST /api/kickstart/register
  if (req.method === 'POST' && pathname === '/api/kickstart/register') {
    const body = await readJsonBody();
    if (!body) return sendJson(400, { error: 'Invalid JSON body.' });

    const { fullName, rollNumber, department, year, collegeEmail, phone, selectedTicketIds, resumeName, whyKickstart } = body;
    if (!fullName?.trim() || !rollNumber?.trim()) return sendJson(400, { error: 'Full name and Roll Number are required.' });
    if (!collegeEmail?.trim()) return sendJson(400, { error: 'Valid college email is required.' });
    if (!Array.isArray(selectedTicketIds) || selectedTicketIds.length === 0) return sendJson(400, { error: 'Select at least one ticket track.' });

    const cleanRoll = rollNumber.trim().toUpperCase();
    const cleanEmail = collegeEmail.trim().toLowerCase();
    const distinctTicketIds = Array.from(new Set(selectedTicketIds));

    // Calculate total on the backend
    let totalRupees = 0;
    const ticketNamesArr = [];
    for (const tid of distinctTicketIds) {
      const def = TICKET_DEFS[tid];
      if (def) {
        totalRupees += def.price;
        ticketNamesArr.push(def.name);
      }
    }
    const ticketNames = ticketNamesArr.join(' + ');
    const totalPaise = totalRupees * 100;

    const uniqueSuffix = Math.random().toString(36).substring(2, 7).toUpperCase();
    const orderId = `KS27-${cleanRoll}-${uniqueSuffix}`;
    const regId = `reg_${Date.now()}_${uniqueSuffix}`;
    const returnUrl = `https://kickstart-drab.vercel.app/#/registration-status?orderId=${encodeURIComponent(orderId)}`;

    // Call AC-Pay to create session
    let gatewaySession;
    try {
      const gatewayPayload = {
        orderId,
        amount: totalRupees.toFixed(2),
        currency: 'INR',
        returnUrl,
        customer: {
          fullName: fullName.trim(),
          email: cleanEmail,
          mobileNumber: (phone || '7620009616').replace(/\D/g, '').slice(-10)
        },
        metadata: {
          source: 'KICKSTART_EVENT_PORTAL',
          rollNumber: cleanRoll,
          studentName: fullName.trim(),
          selectedTicketIds: distinctTicketIds,
          ticketNames
        }
      };

      const gatewayRes = await fetch(`http://127.0.0.1:${apiPort}/api/v1/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Merchant-Id': defaultMerchantId,
          'Authorization': `Bearer ${process.env.ADMIN_PIN || '2026'}`
        },
        body: JSON.stringify(gatewayPayload)
      });

      if (!gatewayRes.ok) {
        const errText = await gatewayRes.text();
        throw new Error(`AC-Pay error [${gatewayRes.status}]: ${errText}`);
      }
      gatewaySession = await gatewayRes.json();
    } catch (err) {
      console.error('[KickStart Register Error]:', err.message);
      return sendJson(502, { error: 'Failed to create payment session.', details: err.message });
    }

    // Persist registration in SQLite
    const nowIso = new Date().toISOString();
    try {
      db.run(`
        INSERT INTO kickstart_registrations (
          id, order_id, student_name, roll_number, department, year, email, phone,
          selected_ticket_ids, ticket_names, amount_paise, amount_rupees,
          payment_id, checkout_url, payment_status, registered_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_PAYMENT', ?, ?)
      `, [
        regId, orderId, fullName.trim(), cleanRoll, department || '', year || '', cleanEmail, phone || '',
        JSON.stringify(distinctTicketIds), ticketNames, totalPaise, totalRupees,
        gatewaySession.id || gatewaySession.sessionId || null,
        gatewaySession.checkoutUrl, nowIso, nowIso
      ]);
    } catch (dbErr) {
      console.error('[DB Insert Error]:', dbErr.message);
    }

    const publicGatewayHost = req.headers['x-forwarded-host'] || req.headers.host || 'ac-pay-gateway.onrender.com';
    const publicProto = req.headers['x-forwarded-proto'] || 'https';
    const publicCheckoutUrl = `${publicProto}://${publicGatewayHost}/checkout/${gatewaySession.id || gatewaySession.sessionId}`;

    return sendJson(200, {
      success: true,
      orderId,
      checkoutUrl: publicCheckoutUrl,
      amountRupees: totalRupees,
      selectedTickets: distinctTicketIds
    });
  }

  // 3. GET /api/kickstart/status/:orderId
  if (req.method === 'GET' && pathname.startsWith('/api/kickstart/status/')) {
    const orderId = pathname.replace('/api/kickstart/status/', '').trim();
    const row = db.queryOne('SELECT * FROM kickstart_registrations WHERE order_id = ?', [orderId]);
    if (!row) return sendJson(404, { error: 'Order not found.' });

    // Check payment status from payment_sessions table if still pending
    let liveStatus = row.payment_status;
    let utr = row.utr || null;
    if (liveStatus === 'PENDING_PAYMENT') {
      try {
        const sess = db.queryOne('SELECT status, customer_utr FROM payment_sessions WHERE order_id = ?', [orderId]);
        if (sess) {
          if (sess.status === 'OBSERVED_SUCCESS' || sess.status === 'RECONCILED' || sess.status === 'SUCCESS') {
            liveStatus = 'VERIFIED_PAID';
            utr = sess.customer_utr || utr;
            db.run('UPDATE kickstart_registrations SET payment_status = ?, utr = ?, verified_at = ? WHERE order_id = ?', [
              liveStatus, utr, new Date().toISOString(), orderId
            ]);
          }
        }
      } catch {}
    }

    return sendJson(200, {
      orderId: row.order_id,
      studentName: row.student_name,
      rollNumber: row.roll_number,
      paymentStatus: liveStatus,
      amountRupees: row.amount_rupees,
      ticketNames: row.ticket_names,
      utr,
      registeredAt: row.registered_at
    });
  }

  return sendJson(404, { error: `Endpoint not found: ${pathname}` });
}

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

  // Route: KickStart Integration API (Tickets, Register, Status)
  if (urlPath.startsWith('/api/kickstart/')) {
    return handleKickStartApi(req, res, urlPath, req.url.split('?')[1] || '', apiPort);
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
