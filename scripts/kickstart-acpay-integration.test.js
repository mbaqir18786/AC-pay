import './test-support.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { Database, runMigrations, MerchantRepository, ReceivingAccountRepository, PaymentSessionRepository, ObservationRepository } from '@youpi/db';
import { startServer as startPaymentApi } from '../apps/payment-api/src/index.js';
import { createKickStartServer } from '../../../kick/web-development-portfolio/server/index.js';
import { getKickStartDb } from '../../../kick/web-development-portfolio/server/db.js';

describe('Phase 4: KickStart 2027 + AC-Pay End-to-End Integration Tests', () => {
  let acPayDb;
  let kickStartDb;
  let acPayServer;
  let kickStartServer;
  let acPayPort;
  let kickStartPort;
  let testMerchant;

  before(async () => {
    // 1. Initialize AC-Pay Gateway Test Database
    acPayDb = new Database({ inMemory: true });
    const seedResult = runMigrations(acPayDb);
    testMerchant = seedResult.defaultMerchant;

    // Start AC-Pay Payment API on designated test port (dynamic port)
    acPayServer = await startPaymentApi(0, acPayDb);
    acPayPort = acPayServer.port;

    // 2. Initialize KickStart Test Database in memory
    kickStartDb = getKickStartDb(':memory:');

    // Start KickStart Backend Server
    kickStartServer = createKickStartServer({
      db: kickStartDb,
      acPayApiUrl: `http://127.0.0.1:${acPayPort}`,
      acPayMerchantId: testMerchant.id,
      acPayWebhookSecret: testMerchant.webhookSecret
    });

    await new Promise(resolve => {
      kickStartServer.listen(0, '127.0.0.1', () => {
        kickStartPort = kickStartServer.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise(cb => kickStartServer.close(cb));
    await acPayServer.close();
    kickStartDb.close();
    acPayDb.close();
  });

  // Helper for HTTP requests
  const apiCall = (method, path, body = null, headers = {}) => new Promise((resolve, reject) => {
    const dataStr = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: kickStartPort,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(dataStr ? { 'Content-Length': Buffer.byteLength(dataStr) } : {}),
        ...headers
      }
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.status, statusCode: res.statusCode, data: json, raw });
      });
    });
    req.on('error', reject);
    if (dataStr) req.write(dataStr);
    req.end();
  });

  // ---------------------------------------------------------------------------
  // 1. GET /api/kickstart/tickets
  // ---------------------------------------------------------------------------
  test('GET /api/kickstart/tickets returns the 3 official interview tracks and prices', async () => {
    const res = await apiCall('GET', '/api/kickstart/tickets');
    assert.equal(res.statusCode, 200);
    assert.equal(res.data.event, 'KickStart 2027');
    assert.equal(res.data.currency, 'INR');

    const tickets = res.data.tickets;
    assert.equal(tickets.length, 3);

    const ids = tickets.map(t => t.id);
    assert.ok(ids.includes('tech'));
    assert.ok(ids.includes('non-tech'));
    assert.ok(ids.includes('mock'));

    const tech = tickets.find(t => t.id === 'tech');
    assert.equal(tech.name, 'Technical Interview');
    assert.equal(tech.price, 50);

    const nonTech = tickets.find(t => t.id === 'non-tech');
    assert.equal(nonTech.name, 'Non-Technical Interview');
    assert.equal(nonTech.price, 40);

    const mock = tickets.find(t => t.id === 'mock');
    assert.equal(mock.name, 'Mock Interview');
    assert.equal(mock.price, 30);
  });

  // ---------------------------------------------------------------------------
  // 2. POST /api/kickstart/register
  // ---------------------------------------------------------------------------
  test('POST /api/kickstart/register creates order, calculates backend total, and initializes AC-Pay session', async () => {
    const registrationPayload = {
      fullName: 'Baqir M',
      rollNumber: '16010121045',
      department: 'ce',
      year: 'te',
      collegeEmail: 'baqir.m@somaiya.edu',
      phone: '9876543210',
      selectedTicketIds: ['tech', 'mock'], // Technical (50) + Mock (30) = ₹80.00
      resumeName: 'Baqir_Resume_2027.pdf',
      whyKickstart: 'Preparing for summer placement drives and technical interviews.'
    };

    const res = await apiCall('POST', '/api/kickstart/register', registrationPayload);
    assert.equal(res.statusCode, 201);
    assert.equal(res.data.success, true);
    assert.ok(res.data.orderId.startsWith('KS27-16010121045-'));
    assert.ok(res.data.paymentId);
    assert.ok(res.data.checkoutUrl);
    assert.equal(res.data.amountRupees, 80);
    assert.equal(res.data.amountPaise, 8000);
    assert.equal(res.data.status, 'PENDING_PAYMENT');

    // Verify session was registered in AC-Pay gateway with metadata intact
    const sessionRepo = new PaymentSessionRepository(acPayDb);
    const gatewaySession = sessionRepo.findById(res.data.paymentId);
    assert.ok(gatewaySession);
    assert.equal(gatewaySession.amountPaise, 8000n);
    assert.equal(gatewaySession.metadata.rollNumber, '16010121045');
    assert.equal(gatewaySession.metadata.ticketNames, 'Technical Interview + Mock Interview');
  });

  // ---------------------------------------------------------------------------
  // 3. GET /api/kickstart/status/:orderId
  // ---------------------------------------------------------------------------
  test('GET /api/kickstart/status/:orderId retrieves pending registration status', async () => {
    // Register student
    const regRes = await apiCall('POST', '/api/kickstart/register', {
      fullName: 'Aarav Mehta',
      rollNumber: '16010121099',
      department: 'it',
      year: 'se',
      collegeEmail: 'aarav.mehta@somaiya.edu',
      phone: '9811122233',
      selectedTicketIds: ['non-tech']
    });

    const orderId = regRes.data.orderId;
    const statusRes = await apiCall('GET', `/api/kickstart/status/${encodeURIComponent(orderId)}`);

    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.data.orderId, orderId);
    assert.equal(statusRes.data.studentName, 'Aarav Mehta');
    assert.equal(statusRes.data.rollNumber, '16010121099');
    assert.equal(statusRes.data.amountRupees, 40);
    assert.equal(statusRes.data.paymentStatus, 'PENDING_PAYMENT');
  });

  // ---------------------------------------------------------------------------
  // 4. POST /api/kickstart/webhook (Signed Webhook Fulfillment)
  // ---------------------------------------------------------------------------
  test('POST /api/kickstart/webhook verifies HMAC signature and confirms registration upon verified payment', async () => {
    // 1. Create a registration
    const regRes = await apiCall('POST', '/api/kickstart/register', {
      fullName: 'Neha Gupta',
      rollNumber: '16010121088',
      department: 'aids',
      year: 'te',
      collegeEmail: 'neha.gupta@somaiya.edu',
      phone: '9822233344',
      selectedTicketIds: ['tech', 'non-tech', 'mock'] // 50 + 40 + 30 = ₹120
    });
    const { orderId, paymentId } = regRes.data;

    // 2. Dispatch simulated AC-Pay signed webhook
    const deliveryId = crypto.randomUUID();
    const timestamp = Date.now().toString();
    const webhookPayload = {
      event: 'OBSERVED_SUCCESS',
      deliveryId,
      timestamp: Number(timestamp),
      paymentId,
      orderId,
      amount: '120.00',
      amountPaise: 12000,
      currency: 'INR',
      method: 'UPI',
      utr: '624567890123',
      verificationLevel: 2
    };

    const rawPayload = JSON.stringify(webhookPayload);
    const signature = crypto.createHmac('sha256', testMerchant.webhookSecret).update(rawPayload).digest('hex');

    const hookRes = await apiCall('POST', '/api/kickstart/webhook', webhookPayload, {
      'X-Gateway-Event': 'OBSERVED_SUCCESS',
      'X-Gateway-Signature': `sha256=${signature}`,
      'X-Gateway-Delivery-Id': deliveryId,
      'X-Gateway-Timestamp': timestamp
    });

    assert.equal(hookRes.statusCode, 200);
    assert.equal(hookRes.data.received, true);

    // 3. Verify status endpoint now reflects confirmed registration
    const statusRes = await apiCall('GET', `/api/kickstart/status/${encodeURIComponent(orderId)}`);
    assert.equal(statusRes.data.paymentStatus, 'VERIFIED_PAID');
    assert.equal(statusRes.data.utr, '624567890123');
    assert.ok(statusRes.data.verifiedAt);

    // 4. Test Webhook Idempotency: Re-delivery of identical deliveryId is deduplicated
    const secondHookRes = await apiCall('POST', '/api/kickstart/webhook', webhookPayload, {
      'X-Gateway-Event': 'OBSERVED_SUCCESS',
      'X-Gateway-Signature': `sha256=${signature}`,
      'X-Gateway-Delivery-Id': deliveryId,
      'X-Gateway-Timestamp': timestamp
    });
    assert.equal(secondHookRes.data.deduplicated, true);
  });

  // ---------------------------------------------------------------------------
  // 5. DUPLICATE REGISTRATION PREVENTION
  // ---------------------------------------------------------------------------
  test('prevents duplicate registration when a student already has a confirmed pass for requested tracks', async () => {
    // Neha Gupta (16010121088) already paid for 'tech', 'non-tech', 'mock' in test 4!
    // Attempting to register again with same roll number and any of those tracks MUST be rejected
    const dupRes = await apiCall('POST', '/api/kickstart/register', {
      fullName: 'Neha Gupta',
      rollNumber: '16010121088',
      department: 'aids',
      year: 'te',
      collegeEmail: 'neha.gupta@somaiya.edu',
      phone: '9822233344',
      selectedTicketIds: ['tech']
    });

    assert.equal(dupRes.statusCode, 409);
    assert.equal(dupRes.data.code, 'DUPLICATE_REGISTRATION_EXISTS');
    assert.ok(dupRes.data.error.includes('already has a confirmed registration'));
  });

  // ---------------------------------------------------------------------------
  // 6. GET /api/kickstart/registrations (Smart Scheduler & Organizer Export)
  // ---------------------------------------------------------------------------
  test('GET /api/kickstart/registrations exports confirmed registrations compatible with Smart Scheduler', async () => {
    const exportRes = await apiCall('GET', '/api/kickstart/registrations');
    assert.equal(exportRes.statusCode, 200);
    assert.ok(exportRes.data.totalVerified >= 1);

    const neha = exportRes.data.registrations.find(r => r.rollNo === '16010121088');
    assert.ok(neha);
    assert.equal(neha.name, 'Neha Gupta');
    assert.equal(neha.department, 'aids');
    assert.equal(neha.amountPaid, 120);
    assert.equal(neha.utr, '624567890123');
    assert.equal(neha.status, 'CONFIRMED');

    // Smart Scheduler Invariant: Slots must be null (unassigned) in this phase
    assert.equal(neha.generatedSlots, null);
  });
});
