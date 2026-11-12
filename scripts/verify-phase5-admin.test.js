import './test-support.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database, runMigrations, AuditLogRepository, PaymentSessionRepository } from '@youpi/db';
import { PaymentStatus, PaymentMethod } from '@youpi/common';
import { startServer as startPaymentApi } from '../apps/payment-api/src/index.js';
import { createKickStartServer } from '../../../kick/web-development-portfolio/server/index.js';
import { getKickStartDb } from '../../../kick/web-development-portfolio/server/db.js';

describe('Phase 5: AC-Pay Admin Dashboard & Management Verification', () => {
  let acPayDb;
  let kickStartDb;
  let acPayServer;
  let kickStartServer;
  let acPayPort;
  let kickStartPort;
  let testMerchant;
  let adminToken = process.env.ADMIN_API_TOKEN;

  // Session IDs for tracking test scenarios
  let successSessionId;
  let manualReviewSessionId;
  let pendingSessionId;
  let failedSessionId;

  before(async () => {
    // 1. Initialize AC-Pay Gateway Test Database
    acPayDb = new Database({ inMemory: true });
    const seedResult = runMigrations(acPayDb);
    testMerchant = seedResult.defaultMerchant;

    // Start AC-Pay Payment API on dynamic port
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

    // Seed diverse test payment sessions in AC-Pay database
    const sessionRepo = new PaymentSessionRepository(acPayDb);

    // 1. Successful student payment (Technical + Mock, ₹80)
    const s1 = sessionRepo.create({
      merchantId: testMerchant.id,
      orderId: 'KS27-16010121045-A101',
      amountPaise: 8000n,
      currency: 'INR',
      method: PaymentMethod.UPI,
      status: PaymentStatus.ACTIVE,
      metadata: {
        studentName: 'Baqir M',
        rollNumber: '16010121045',
        department: 'ce',
        year: 'te',
        collegeEmail: 'baqir.m@somaiya.edu',
        selectedTicketIds: ['tech', 'mock'],
        ticketNames: 'Technical Interview + Mock Interview'
      }
    });
    sessionRepo.transitionToTerminal(s1.id, PaymentStatus.SUCCESS, {
      attributedObservationId: 'obs_101'
    });
    // Mark UTR
    acPayDb.execute('UPDATE payment_sessions SET customer_utr = ? WHERE id = ?', ['624567890101', s1.id]);
    successSessionId = s1.id;

    // 2. Manual Review student payment (Non-Technical, ₹40, customer submitted UTR)
    const s2 = sessionRepo.create({
      merchantId: testMerchant.id,
      orderId: 'KS27-16010121088-B202',
      amountPaise: 4000n,
      currency: 'INR',
      method: PaymentMethod.UPI,
      status: PaymentStatus.ACTIVE,
      metadata: {
        studentName: 'Aarav Mehta',
        rollNumber: '16010121088',
        department: 'it',
        year: 'se',
        collegeEmail: 'aarav.mehta@somaiya.edu',
        selectedTicketIds: ['non-tech'],
        ticketNames: 'Non-Technical Interview'
      }
    });
    sessionRepo.transitionToTerminal(s2.id, PaymentStatus.MANUAL_REVIEW);
    acPayDb.execute('UPDATE payment_sessions SET customer_utr = ? WHERE id = ?', ['624567890202', s2.id]);
    manualReviewSessionId = s2.id;

    // 3. Pending payment (Mock Interview, ₹30)
    const s3 = sessionRepo.create({
      merchantId: testMerchant.id,
      orderId: 'KS27-16010121099-C303',
      amountPaise: 3000n,
      currency: 'INR',
      method: PaymentMethod.UPI,
      status: PaymentStatus.ACTIVE,
      metadata: {
        studentName: 'Priya Sharma',
        rollNumber: '16010121099',
        department: 'extc',
        year: 'fe',
        collegeEmail: 'priya.sharma@somaiya.edu',
        selectedTicketIds: ['mock'],
        ticketNames: 'Mock Interview'
      }
    });
    pendingSessionId = s3.id;

    // 4. Failed/Expired payment (Technical Interview, ₹50)
    const s4 = sessionRepo.create({
      merchantId: testMerchant.id,
      orderId: 'KS27-16010121011-D404',
      amountPaise: 5000n,
      currency: 'INR',
      method: PaymentMethod.UPI,
      status: PaymentStatus.ACTIVE,
      metadata: {
        studentName: 'Rohan Joshi',
        rollNumber: '16010121011',
        department: 'mech',
        year: 'be',
        collegeEmail: 'rohan.joshi@somaiya.edu',
        selectedTicketIds: ['tech'],
        ticketNames: 'Technical Interview'
      }
    });
    sessionRepo.transitionToTerminal(s4.id, PaymentStatus.EXPIRED);
    failedSessionId = s4.id;
  });

  after(async () => {
    await new Promise(cb => kickStartServer.close(cb));
    await acPayServer.close();
    kickStartDb.close();
    acPayDb.close();
  });

  // Helper for HTTP requests
  const apiCall = (port, method, path, body = null, headers = {}) => new Promise((resolve, reject) => {
    const dataStr = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
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
        resolve({ status: res.status, statusCode: res.statusCode, data: json, raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (dataStr) req.write(dataStr);
    req.end();
  });

  // ---------------------------------------------------------------------------
  // 1. SECURITY: UNSECURED REQUESTS ARE STRICTLY REJECTED
  // ---------------------------------------------------------------------------
  test('unauthorized requests without admin bearer token are strictly rejected with 401', async () => {
    // Calling AC-Pay Admin API without Bearer token
    const res = await apiCall(acPayPort, 'GET', '/api/v1/admin/payments');
    assert.equal(res.statusCode, 401);
    assert.equal(res.data.error, 'Unauthorized');
  });

  test('students cannot mark their own payments as successful', async () => {
    // Attempting to call confirm route without admin credentials
    const confirmRes = await apiCall(acPayPort, 'POST', `/api/v1/admin/payments/${pendingSessionId}/confirm`, {
      operatorId: 'student_trying_to_hack',
      notes: 'Fake self approval'
    });
    assert.equal(confirmRes.statusCode, 401);

    // Verify session remains ACTIVE and unconfirmed in database
    const sessionRepo = new PaymentSessionRepository(acPayDb);
    const session = sessionRepo.findById(pendingSessionId);
    assert.equal(session.status, PaymentStatus.ACTIVE);
  });

  // ---------------------------------------------------------------------------
  // 2. METRICS & STATS SUMMARY
  // ---------------------------------------------------------------------------
  test('returns total orders, successful, pending, and failed payment metrics', async () => {
    const res = await apiCall(acPayPort, 'GET', '/api/v1/admin/payments', null, {
      Authorization: `Bearer ${adminToken}`
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.data.stats);
    const stats = res.data.stats;

    assert.equal(stats.totalOrders, 4);
    assert.equal(stats.successfulPayments, 1); // Baqir (s1)
    assert.equal(stats.pendingPayments, 2);    // Aarav (s2 - MANUAL_REVIEW) + Priya (s3 - ACTIVE)
    assert.equal(stats.failedPayments, 1);     // Rohan (s4 - EXPIRED)
    assert.equal(stats.totalAmountCollected, '80.00'); // 8000 paise = 80.00
  });

  // ---------------------------------------------------------------------------
  // 3. SEARCH BY STUDENT NAME, ROLL NUMBER, AND ORDER ID
  // ---------------------------------------------------------------------------
  test('searches payments by student name', async () => {
    const res = await apiCall(acPayPort, 'GET', '/api/v1/admin/payments?q=Aarav', null, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.data.payments.length, 1);
    assert.equal(res.data.payments[0].studentName, 'Aarav Mehta');
  });

  test('searches payments by Roll Number', async () => {
    const res = await apiCall(acPayPort, 'GET', '/api/v1/admin/payments?q=16010121045', null, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.data.payments.length, 1);
    assert.equal(res.data.payments[0].rollNumber, '16010121045');
    assert.equal(res.data.payments[0].studentName, 'Baqir M');
  });

  test('searches payments by order ID', async () => {
    const res = await apiCall(acPayPort, 'GET', '/api/v1/admin/payments?q=C303', null, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.data.payments.length, 1);
    assert.equal(res.data.payments[0].orderId, 'KS27-16010121099-C303');
    assert.equal(res.data.payments[0].studentName, 'Priya Sharma');
  });

  // ---------------------------------------------------------------------------
  // 4. VIEW TICKET DETAILS, TRANSACTION REFERENCES, AND TIMESTAMPS
  // ---------------------------------------------------------------------------
  test('returns ticket details, transaction references (UTR), and timestamps', async () => {
    const res = await apiCall(acPayPort, 'GET', '/api/v1/admin/payments?q=16010121045', null, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(res.statusCode, 200);
    const p = res.data.payments[0];

    // Ticket details
    assert.equal(p.ticketNames, 'Technical Interview + Mock Interview');
    assert.deepEqual(p.selectedTicketIds, ['tech', 'mock']);

    // Transaction reference
    assert.equal(p.customerUtr, '624567890101');
    assert.equal(p.transactionReference, '624567890101');

    // Timestamps
    assert.ok(p.createdAt);
    assert.ok(p.completedAt);
  });

  // ---------------------------------------------------------------------------
  // 5. FILTER BY TICKET TYPE AND PAYMENT STATUS
  // ---------------------------------------------------------------------------
  test('filters payments by status (SUCCESS vs PENDING)', async () => {
    // Filter SUCCESS
    const succRes = await apiCall(acPayPort, 'GET', '/api/v1/admin/payments?status=SUCCESS', null, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(succRes.statusCode, 200);
    assert.equal(succRes.data.payments.length, 1);
    assert.equal(succRes.data.payments[0].orderId, 'KS27-16010121045-A101');

    // Filter PENDING
    const pendRes = await apiCall(acPayPort, 'GET', '/api/v1/admin/payments?status=PENDING', null, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(pendRes.statusCode, 200);
    assert.equal(pendRes.data.payments.length, 2); // Aarav (MANUAL_REVIEW) and Priya (ACTIVE)
  });

  test('filters payments by ticket track (mock vs non-tech)', async () => {
    const mockRes = await apiCall(acPayPort, 'GET', '/api/v1/admin/payments?ticket=mock', null, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(mockRes.statusCode, 200);
    // Baqir (tech + mock) and Priya (mock)
    assert.equal(mockRes.data.payments.length, 2);

    const nonTechRes = await apiCall(acPayPort, 'GET', '/api/v1/admin/payments?ticket=non-tech', null, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(nonTechRes.statusCode, 200);
    assert.equal(nonTechRes.data.payments.length, 1);
    assert.equal(nonTechRes.data.payments[0].studentName, 'Aarav Mehta');
  });

  // ---------------------------------------------------------------------------
  // 6. CSV EXPORT
  // ---------------------------------------------------------------------------
  test('exports payment records to CSV with correct headers and escaped fields', async () => {
    const res = await apiCall(acPayPort, 'GET', '/api/v1/admin/payments/export.csv', null, {
      Authorization: `Bearer ${adminToken}`
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/csv'));
    assert.ok(res.headers['content-disposition'].includes('attachment'));

    const lines = res.raw.split('\r\n');
    assert.ok(lines.length >= 5); // Header + 4 records

    // Header validation
    const headerLine = lines[0];
    assert.ok(headerLine.includes('"Order ID"'));
    assert.ok(headerLine.includes('"Student Name"'));
    assert.ok(headerLine.includes('"Roll Number"'));
    assert.ok(headerLine.includes('"Interview Tracks"'));
    assert.ok(headerLine.includes('"Transaction Ref / Bank UTR"'));

    // Record line verification
    const baqirLine = lines.find(l => l.includes('16010121045'));
    assert.ok(baqirLine);
    assert.ok(baqirLine.includes('"Baqir M"'));
    assert.ok(baqirLine.includes('"Technical Interview + Mock Interview"'));
    assert.ok(baqirLine.includes('"80.00"'));
    assert.ok(baqirLine.includes('"624567890101"'));
  });

  // ---------------------------------------------------------------------------
  // 7. MANUAL PAYMENT REVIEW & RECONCILIATION WITH AUDIT TRAIL
  // ---------------------------------------------------------------------------
  test('manual payment review confirms payment and generates a persistent audit trail', async () => {
    // Aarav Mehta (s2) is currently in MANUAL_REVIEW
    const operatorId = 'Prof. K. Sharma (Alumni Cell Convenor)';
    const reviewNotes = 'Verified against Somaiya Alumni Cell HDFC bank account statement ending in 4102.';

    const confirmRes = await apiCall(acPayPort, 'POST', `/api/v1/admin/payments/${manualReviewSessionId}/confirm`, {
      operatorId,
      notes: reviewNotes
    }, {
      Authorization: `Bearer ${adminToken}`
    });

    assert.equal(confirmRes.statusCode, 200);
    assert.equal(confirmRes.data.success, true);
    assert.equal(confirmRes.data.status, PaymentStatus.RECONCILED);
    assert.equal(confirmRes.data.reconciledBy, operatorId);

    // 1. Verify session record in DB reflects reviewer and terminal state
    const sessionRepo = new PaymentSessionRepository(acPayDb);
    const session = sessionRepo.findById(manualReviewSessionId);
    assert.equal(session.status, PaymentStatus.RECONCILED);
    assert.equal(session.manualReviewedBy, operatorId);
    assert.equal(session.manualReviewReason, reviewNotes);
    assert.ok(session.manualReviewedAt);

    // 2. Verify Audit Trail in audit_logs
    const auditRepo = new AuditLogRepository(acPayDb);
    const logs = auditRepo.findByEntity('PAYMENT_SESSION', manualReviewSessionId);
    assert.ok(logs.length >= 1);
    const reconcileLog = logs.find(l => l.action === 'PAYMENT_MANUALLY_RECONCILED');
    assert.ok(reconcileLog);
    assert.equal(reconcileLog.actorId, operatorId);
    assert.equal(reconcileLog.actorType, 'ADMIN');
    assert.equal(reconcileLog.details.notes, reviewNotes);
  });

  // ---------------------------------------------------------------------------
  // 8. KICKSTART SERVER ADMIN API INTEGRATION & SECURITY
  // ---------------------------------------------------------------------------
  test('KickStart admin orders endpoint rejects unauthenticated access with 401', async () => {
    const res = await apiCall(kickStartPort, 'GET', '/api/kickstart/admin/orders');
    assert.equal(res.statusCode, 401);
    assert.equal(res.data.code, 'ADMIN_AUTH_REQUIRED');
  });

  test('KickStart admin orders endpoint returns metrics and order list when authenticated', async () => {
    // 1. First create a registration in KickStart
    const regRes = await apiCall(kickStartPort, 'POST', '/api/kickstart/register', {
      fullName: 'Aanya Shah',
      rollNumber: '16010121055',
      department: 'ce',
      year: 'te',
      collegeEmail: 'aanya.shah@somaiya.edu',
      phone: '9833344455',
      selectedTicketIds: ['tech']
    });
    assert.equal(regRes.statusCode, 201);
    const orderId = regRes.data.orderId;

    // 2. Query admin orders with secret
    const adminRes = await apiCall(kickStartPort, 'GET', '/api/kickstart/admin/orders', null, {
      'x-admin-key': testMerchant.webhookSecret
    });
    assert.equal(adminRes.statusCode, 200);
    assert.ok(adminRes.data.stats);
    assert.ok(adminRes.data.orders.length >= 1);

    const found = adminRes.data.orders.find(o => o.orderId === orderId);
    assert.ok(found);
    assert.equal(found.studentName, 'Aanya Shah');
    assert.equal(found.rollNumber, '16010121055');
    assert.equal(found.amountRupees, 50);

    // 3. Test KickStart Admin CSV export
    const csvRes = await apiCall(kickStartPort, 'GET', '/api/kickstart/admin/orders/export.csv', null, {
      'x-admin-key': testMerchant.webhookSecret
    });
    assert.equal(csvRes.statusCode, 200);
    assert.ok(csvRes.headers['content-type'].includes('text/csv'));
    assert.ok(csvRes.raw.includes('16010121055'));
    assert.ok(csvRes.raw.includes('Aanya Shah'));

    // 4. Test KickStart Admin Order Verification
    const verifyRes = await apiCall(kickStartPort, 'POST', `/api/kickstart/admin/orders/${encodeURIComponent(orderId)}/verify`, {
      notes: 'Fee confirmed at Somaiya Accounts Section',
      utr: 'CASH-REC-10492'
    }, {
      'x-admin-key': testMerchant.webhookSecret
    });
    assert.equal(verifyRes.statusCode, 200);
    assert.equal(verifyRes.data.verified, true);

    // 5. Verify public status page reflects verified status
    const statusRes = await apiCall(kickStartPort, 'GET', `/api/kickstart/status/${encodeURIComponent(orderId)}`);
    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.data.paymentStatus, 'VERIFIED_PAID');
    assert.equal(statusRes.data.utr, 'CASH-REC-10492');
  });
});