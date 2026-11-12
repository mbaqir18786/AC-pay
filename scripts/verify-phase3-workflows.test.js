import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Database, runMigrations, MerchantRepository, ReceivingAccountRepository, PaymentSessionRepository, ObservationRepository, AuditLogRepository } from '@youpi/db';
import {
  PaymentStatus,
  PaymentMethod,
  ObserverSource,
  toRupeesString,
  toPaise,
  buildUpiUri,
  buildStandUpiUri,
  isValidVpa,
  generateHmac,
  verifyHmac
} from '@youpi/common';
import {
  AttributionEngine,
  ObservationNormalizer,
  StatementReconciliation,
  generateQrSvg,
  BankSmsParser,
  BankEmailParser
} from '@youpi/core';
import { YoupiPaymentClient, ACPayPaymentClient, ACPayClient } from '@youpi/merchant-sdk';

const RECEIVING_ACCOUNT_ID = '00000000-0000-0000-0000-000000000002';

describe('Phase 3: AC-Pay Payment Workflow Verification & Invariants', () => {
  let db;
  let merchantRepo;
  let accountRepo;
  let sessionRepo;
  let obsRepo;
  let auditRepo;
  let attribution;
  let testMerchant;

  beforeEach(() => {
    db = new Database({ inMemory: true });
    const seedResult = runMigrations(db);
    merchantRepo = new MerchantRepository(db);
    accountRepo = new ReceivingAccountRepository(db);
    sessionRepo = new PaymentSessionRepository(db);
    obsRepo = new ObservationRepository(db);
    auditRepo = new AuditLogRepository(db);

    testMerchant = seedResult.defaultMerchant;
    attribution = new AttributionEngine({
      sessionRepo,
      obsRepo,
      auditRepo,
      eventEmitter: { emit: () => {} }
    });
  });

  afterEach(() => {
    attribution.destroy();
    db.close();
  });

  // ---------------------------------------------------------------------------
  // 1. PAYMENT SESSION CREATION & METADATA
  // ---------------------------------------------------------------------------
  describe('1. Payment Session Creation & KickStart Metadata', () => {
    test('creates payment session with custom attendee registration metadata', () => {
      const kickstartMetadata = {
        studentName: 'Aarav Sharma',
        rollNumber: '16010121001',
        department: 'Computer Engineering',
        year: 'TE',
        contactNumber: '9876543210',
        email: 'aarav.sharma@somaiya.edu',
        ticketTier: 'TECH_INTERVIEW_PASS'
      };

      const session = sessionRepo.create({
        merchantId: testMerchant.id,
        receivingAccountId: RECEIVING_ACCOUNT_ID,
        orderId: 'KS-REG-2026-001',
        amountPaise: 15000n, // Rs. 150.00
        currency: 'INR',
        method: PaymentMethod.UPI,
        status: PaymentStatus.INITIATED,
        metadata: kickstartMetadata
      });

      assert.ok(session.id);
      assert.equal(session.orderId, 'KS-REG-2026-001');
      assert.equal(session.amountPaise, 15000n);
      assert.equal(session.status, PaymentStatus.INITIATED);
      assert.equal(session.metadata.studentName, 'Aarav Sharma');
      assert.equal(session.metadata.ticketTier, 'TECH_INTERVIEW_PASS');
      assert.equal(session.metadata.rollNumber, '16010121001');
    });

    test('enforces atomic slot acquisition: only one session holds active slot on receiving account', () => {
      const s1 = sessionRepo.create({
        merchantId: testMerchant.id,
        receivingAccountId: RECEIVING_ACCOUNT_ID,
        orderId: 'SLOT-TEST-001',
        amountPaise: 10000n
      });
      const s2 = sessionRepo.create({
        merchantId: testMerchant.id,
        receivingAccountId: RECEIVING_ACCOUNT_ID,
        orderId: 'SLOT-TEST-002',
        amountPaise: 10000n
      });

      const res1 = sessionRepo.acquireSlotAtomic(s1.id, RECEIVING_ACCOUNT_ID, 300000);
      assert.equal(res1.status, PaymentStatus.ACTIVE);
      assert.equal(res1.queuePosition, 0);

      // Second session attempting to acquire the slot MUST be placed in QUEUED
      const res2 = sessionRepo.acquireSlotAtomic(s2.id, RECEIVING_ACCOUNT_ID, 300000);
      assert.equal(res2.status, PaymentStatus.QUEUED);
      assert.ok(res2.queuePosition > 0);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. UPI QR GENERATION & NPCI PARAMETERS
  // ---------------------------------------------------------------------------
  describe('2. UPI QR Generation & NPCI Compliance', () => {
    test('builds canonical UPI URI with correct payee, amount, and note', () => {
      const uri = buildUpiUri({
        payeeVpa: 'alumnicell@somaiya',
        payeeName: 'Alumni Cell KJSSE',
        amountPaise: 25000n,
        transactionRef: 'KS-ORD-101'
      });

      assert.ok(uri.startsWith('upi://pay?'));
      const parsed = new URL(uri);
      assert.equal(parsed.searchParams.get('pa'), 'alumnicell@somaiya');
      assert.equal(parsed.searchParams.get('pn'), 'Alumni Cell KJSSE');
      assert.equal(parsed.searchParams.get('am'), '250.00');
      assert.equal(parsed.searchParams.get('tn'), 'KS-ORD-101');
    });

    test('supports optional transaction reference (tr) parameter', () => {
      const uri = buildUpiUri({
        payeeVpa: 'alumnicell@somaiya',
        payeeName: 'Alumni Cell KJSSE',
        amountPaise: 5000n,
        transactionRef: 'KickStart Entry',
        tr: 'TXN-REF-789'
      });

      const parsed = new URL(uri);
      assert.equal(parsed.searchParams.get('tn'), 'KickStart Entry');
      assert.equal(parsed.searchParams.get('tr'), 'TXN-REF-789');
    });

    test('builds stand UPI URI with mode=04, merchant category code, and currency', () => {
      const uri = buildStandUpiUri({
        payeeVpa: 'alumnicell@somaiya',
        payeeName: 'Alumni Cell KJSSE',
        amountPaise: 10000n,
        merchantCategoryCode: '8220', // Educational institutions / colleges
        transactionRef: 'STAND-001',
        currency: 'INR'
      });

      const parsed = new URL(uri);
      assert.equal(parsed.searchParams.get('pa'), 'alumnicell@somaiya');
      assert.equal(parsed.searchParams.get('mc'), '8220');
      assert.equal(parsed.searchParams.get('mode'), '04');
      assert.equal(parsed.searchParams.get('cu'), 'INR');
      assert.equal(parsed.searchParams.get('am'), '100.00');
    });

    test('generates valid scannable SVG QR markup', () => {
      const svg = generateQrSvg('upi://pay?pa=alumnicell@somaiya&pn=Alumni+Cell&am=100.00');
      assert.ok(svg.includes('<svg'));
      assert.ok(svg.includes('viewBox="0 0 240 240"'));
      assert.ok(svg.includes('<rect'));
    });
  });

  // ---------------------------------------------------------------------------
  // 3. INVARIANT: CUSTOMER CLAIMS / UTR NEVER MARK ORDER PAID
  // ---------------------------------------------------------------------------
  describe('3. Invariant: Customer Claims & UTR Submissions Never Mark Paid', () => {
    test('submitting a manual UTR strictly transitions to MANUAL_REVIEW, NEVER SUCCESS', () => {
      const session = sessionRepo.create({
        merchantId: testMerchant.id,
        receivingAccountId: RECEIVING_ACCOUNT_ID,
        orderId: 'CLAIM-ORD-001',
        amountPaise: 20000n,
        method: PaymentMethod.MANUAL_UPI,
        status: PaymentStatus.ACTIVE
      });
      sessionRepo.acquireSlotAtomic(session.id, RECEIVING_ACCOUNT_ID, 300000);

      const submitted = sessionRepo.submitManualUtr(session.id, '123456789012');
      assert.equal(submitted.status, PaymentStatus.MANUAL_REVIEW);
      assert.notEqual(submitted.status, PaymentStatus.SUCCESS);
      assert.notEqual(submitted.status, PaymentStatus.OBSERVED_SUCCESS);
      assert.notEqual(submitted.status, PaymentStatus.RECONCILED);
      assert.equal(submitted.customerUtr, '123456789012');

      // Invariant: Slot must be released so subsequent customers are not blocked
      const account = accountRepo.findById(RECEIVING_ACCOUNT_ID);
      assert.equal(account.isSlotBusy, false);
      assert.equal(account.currentActiveSessionId, null);
    });

    test('duplicate submission of the same manual UTR on the same receiving account is rejected', () => {
      const firstSession = sessionRepo.create({
        merchantId: testMerchant.id,
        receivingAccountId: RECEIVING_ACCOUNT_ID,
        orderId: 'CLAIM-ORD-002A',
        amountPaise: 20000n,
        method: PaymentMethod.MANUAL_UPI,
        status: PaymentStatus.ACTIVE
      });
      sessionRepo.acquireSlotAtomic(firstSession.id, RECEIVING_ACCOUNT_ID, 300000);
      sessionRepo.submitManualUtr(firstSession.id, '123456789012');

      const secondSession = sessionRepo.create({
        merchantId: testMerchant.id,
        receivingAccountId: RECEIVING_ACCOUNT_ID,
        orderId: 'CLAIM-ORD-002B',
        amountPaise: 20000n,
        method: PaymentMethod.MANUAL_UPI,
        status: PaymentStatus.ACTIVE
      });
      sessionRepo.acquireSlotAtomic(secondSession.id, RECEIVING_ACCOUNT_ID, 300000);

      assert.throws(
        () => sessionRepo.submitManualUtr(secondSession.id, '123456789012'),
        /UNIQUE constraint failed/
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 4. DUPLICATE PAYMENT & NOTIFICATION HANDLING
  // ---------------------------------------------------------------------------
  describe('4. Duplicate Notification & UTR Reuse Prevention', () => {
    test('drops redundant duplicate observation from the same channel family via fingerprint deduplication', () => {
      const session = sessionRepo.create({
        merchantId: testMerchant.id,
        receivingAccountId: RECEIVING_ACCOUNT_ID,
        orderId: 'DUP-ORD-001',
        amountPaise: 35000n
      });
      sessionRepo.acquireSlotAtomic(session.id, RECEIVING_ACCOUNT_ID, 300000);
      sessionRepo.transitionToProcessing(session.id, 30000);

      const obs1 = ObservationNormalizer.normalize({
        source: ObserverSource.GOOGLE_MESSAGES,
        receivingAccountId: RECEIVING_ACCOUNT_ID,
        amountPaise: 35000n,
        bankReferenceNumber: '778899001122',
        observedAt: new Date(),
        rawPayload: { text: 'Rs. 350.00 credited via UPI Ref 778899001122' }
      });

      const res1 = attribution.processObservation(obs1);
      assert.equal(res1.attributed, true);
      assert.equal(res1.outcomeStatus, PaymentStatus.OBSERVED_SUCCESS);

      // Re-delivery of identical notification is caught by fingerprint deduplication
      const res2 = attribution.processObservation(obs1);
      assert.equal(res2.duplicate, true);
      assert.equal(res2.attributed, false);
      assert.equal(res2.outcomeStatus, 'DUPLICATE_IGNORED');
    });

    test('rejects an observation referencing a UTR already consumed by a prior payment', () => {
      const s1 = sessionRepo.create({
        merchantId: testMerchant.id,
        receivingAccountId: RECEIVING_ACCOUNT_ID,
        orderId: 'CONSUMED-ORD-001',
        amountPaise: 40000n
      });
      sessionRepo.acquireSlotAtomic(s1.id, RECEIVING_ACCOUNT_ID, 300000);
      sessionRepo.transitionToProcessing(s1.id, 30000);

      const obs = ObservationNormalizer.normalize({
        source: ObserverSource.GOOGLE_MESSAGES,
        receivingAccountId: RECEIVING_ACCOUNT_ID,
        amountPaise: 40000n,
        bankReferenceNumber: '889900112233',
        observedAt: new Date(),
        rawPayload: { text: 'Credited Rs. 400 Ref 889900112233' }
      });
      const firstAttribution = attribution.processObservation(obs);
      assert.equal(firstAttribution.attributed, true);

      // Release s1 terminal status
      sessionRepo.transitionToTerminal(s1.id, PaymentStatus.RECONCILED);

      // Now create a different session s2 and attempt to attribute the same UTR
      const s2 = sessionRepo.create({
        merchantId: testMerchant.id,
        receivingAccountId: RECEIVING_ACCOUNT_ID,
        orderId: 'CONSUMED-ORD-002',
        amountPaise: 40000n
      });
      sessionRepo.acquireSlotAtomic(s2.id, RECEIVING_ACCOUNT_ID, 300000);
      sessionRepo.transitionToProcessing(s2.id, 30000);

      const secondObs = ObservationNormalizer.normalize({
        source: ObserverSource.GMAIL,
        receivingAccountId: RECEIVING_ACCOUNT_ID,
        amountPaise: 40000n,
        bankReferenceNumber: '889900112233',
        observedAt: new Date(Date.now() + 60000),
        rawPayload: { text: 'Credited Rs. 400 Ref 889900112233' }
      });
      const secondAttribution = attribution.processObservation(secondObs);
      // Invariant: The UTR was already bound to s1. The second observation MUST NOT attribute to s2!
      assert.equal(secondAttribution.paymentSessionId, s1.id);
      assert.notEqual(secondAttribution.paymentSessionId, s2.id);

      // Verify s2 remains non-terminal and was NOT falsely paid
      const s2Current = sessionRepo.findById(s2.id);
      assert.equal(s2Current.status, PaymentStatus.PROCESSING);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. BANK NOTIFICATION PARSERS (SMS & GMAIL)
  // ---------------------------------------------------------------------------
  describe('5. Bank Notification Observers & Extraction', () => {
    test('BankSmsParser extracts amount and UTR from authentic HDFC/SBI alerts', () => {
      const smsText = 'Dear UPI user A/C 1234 credited by Rs. 250.00 on 12-Nov-26 by UPI/CR/634567890123/KickStart. Avl Bal Rs 5200.50';
      const parsed = BankSmsParser.parse({ text: smsText, timestamp: new Date() });

      assert.ok(parsed);
      assert.equal(parsed.amount, '250.00');
      assert.equal(parsed.amountPaise, 25000n);
      assert.equal(parsed.bankReferenceNumber, '634567890123');
    });

    test('BankSmsParser rejects debit messages even if credit word is mentioned later', () => {
      const debitText = 'Rs 500 debited from A/C 1234. If not done by you, credited back in 48 hrs.';
      const parsed = BankSmsParser.parse({ text: debitText, timestamp: new Date() });
      assert.equal(parsed, null);
    });

    test('BankEmailParser extracts credit amount and reference from Gmail bank alert', () => {
      const email = {
        subject: 'Credit Alert: INR 150.00 deposited to your account',
        body: 'Your Account **5678 has been credited with INR 150.00 on 12-Nov-2026. UPI Ref No: 998877665544.',
        date: new Date()
      };
      const parsed = BankEmailParser.parse(email);

      assert.ok(parsed);
      assert.equal(parsed.amountPaise, 15000n);
      assert.equal(parsed.bankReferenceNumber, '998877665544');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. BANK STATEMENT RECONCILIATION
  // ---------------------------------------------------------------------------
  describe('6. Authoritative Bank Statement Reconciliation', () => {
    test('statement reconciliation reconciles observed session only with matching UTR and amount', () => {
      const session = sessionRepo.create({
        merchantId: testMerchant.id,
        receivingAccountId: RECEIVING_ACCOUNT_ID,
        orderId: 'STMT-ORD-001',
        amountPaise: 49900n
      });
      sessionRepo.acquireSlotAtomic(session.id, RECEIVING_ACCOUNT_ID, 300000);
      sessionRepo.transitionToProcessing(session.id, 30000);

      attribution.processObservation(ObservationNormalizer.normalize({
        source: ObserverSource.GOOGLE_MESSAGES,
        receivingAccountId: RECEIVING_ACCOUNT_ID,
        amountPaise: 49900n,
        bankReferenceNumber: '112233445566',
        observedAt: new Date(),
        rawPayload: { text: 'Credited 499 Ref 112233445566' }
      }));

      assert.equal(sessionRepo.findById(session.id).status, PaymentStatus.OBSERVED_SUCCESS);

      const engine = new StatementReconciliation({
        db,
        sessionRepo,
        auditRepo,
        eventEmitter: { emit: () => {} }
      });

      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
      const [year, month, day] = today.split('-');
      const istSlash = `${day}/${month}/${year}`;

      const hdfcCsv = [
        'HDFC Bank Limited',
        'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
        `${istSlash},"UPI-CREDIT-payer@bank-HDFC001-112233445566-STMT",0,${istSlash},,"499.00",50000.00`
      ].join('\n');

      const result = engine.importCsv({ receivingAccountId: RECEIVING_ACCOUNT_ID, csvText: hdfcCsv });
      assert.equal(result.reconciled, 1);
      assert.equal(sessionRepo.findById(session.id).status, PaymentStatus.RECONCILED);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. WEBHOOK VERIFICATION & SDK CLIENT ALIASES
  // ---------------------------------------------------------------------------
  describe('7. Webhook Verification & Merchant SDK Replay Protection', () => {
    test('ACPayPaymentClient and ACPayClient verify authentic HMAC-SHA256 signatures', () => {
      assert.equal(ACPayPaymentClient, YoupiPaymentClient);
      assert.equal(ACPayClient, YoupiPaymentClient);

      const client = new ACPayPaymentClient({
        merchantId: testMerchant.id,
        webhookSecret: 'somaiya_acpay_webhook_secret_key_123'
      });

      const payload = {
        event: 'SUCCESS',
        deliveryId: 'del-12345',
        timestamp: Date.now(),
        paymentId: 'pay-uuid-001',
        orderId: 'KS-REG-2026-001',
        amount: '150.00',
        amountPaise: 15000,
        currency: 'INR',
        method: 'UPI',
        utr: '998877665544',
        metadata: { studentName: 'Aarav Sharma' }
      };

      const rawPayload = JSON.stringify(payload);
      const signature = `sha256=${generateHmac(rawPayload, 'somaiya_acpay_webhook_secret_key_123')}`;

      // Verification succeeds with matching secret
      const verified = client.verifyWebhook(rawPayload, signature, payload.timestamp);
      assert.equal(verified.orderId, 'KS-REG-2026-001');
      assert.equal(verified.metadata.studentName, 'Aarav Sharma');

      // Verification fails if payload is tampered
      const tampered = JSON.stringify({ ...payload, amount: '1.00' });
      assert.throws(
        () => client.verifyWebhook(tampered, signature, payload.timestamp),
        /signature mismatch/
      );

      // Verification fails if timestamp is expired (outside tolerance window)
      const expiredTimestamp = Date.now() - (3 * 60 * 60 * 1000); // 3 hours ago
      assert.throws(
        () => client.verifyWebhook(rawPayload, signature, expiredTimestamp, { toleranceMs: 300000 }),
        /timestamp missing or outside tolerance window/
      );
    });
  });
});
