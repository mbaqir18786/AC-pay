import http from 'node:http';
import { startServer as startPaymentApi } from '../apps/payment-api/src/index.js';
import { startCheckoutServer } from '../apps/checkout-portal/src/index.js';
import { startAdminServer } from '../apps/merchant-admin/src/index.js';
import { startCoinWalletStore } from '../apps/coin-wallet-store/src/index.js';

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    }).on('error', reject);
  });
}

async function main() {
  console.log('====================================================');
  console.log('🔍 AC-Pay — Live Rebranding Verification');
  console.log('====================================================');

  const instances = [];

  try {
    console.log('[1/4] Starting services for testing...');
    const api = await startPaymentApi(6100);
    instances.push(api);

    const checkout = await startCheckoutServer(7000);
    instances.push(checkout);

    const admin = await startAdminServer(6001);
    instances.push(admin);

    const store = await startCoinWalletStore(5000);
    instances.push(store);

    console.log('[✓] All 4 servers started on ports 6100, 7000, 6001, 5000\n');

    // TEST 1: Health checks
    console.log('[2/4] Testing health endpoints...');
    const hApi = await fetchUrl('http://127.0.0.1:6100/health');
    console.log(` • Payment API Health: ${hApi.status} (expected 200)`);
    if (hApi.status !== 200) throw new Error('Payment API health check failed');

    const hPortal = await fetchUrl('http://127.0.0.1:7000/health');
    console.log(` • Checkout Portal Health: ${hPortal.status} (expected 200)`);
    if (hPortal.status !== 200) throw new Error('Checkout Portal health check failed');

    const hAdmin = await fetchUrl('http://127.0.0.1:6001/health');
    console.log(` • Merchant Admin Health: ${hAdmin.status} (expected 200)`);
    if (hAdmin.status !== 200) throw new Error('Admin health check failed');

    const hStore = await fetchUrl('http://127.0.0.1:5000/health');
    console.log(` • Showcase Store Health: ${hStore.status} (expected 200)`);
    if (hStore.status !== 200) throw new Error('Store health check failed');

    // TEST 2: SDK endpoints
    console.log('\n[3/4] Testing SDK script endpoints...');
    const sdkAcpay = await fetchUrl('http://127.0.0.1:7000/acpay.js');
    console.log(` • GET /acpay.js status: ${sdkAcpay.status}, Content-Type: ${sdkAcpay.headers['content-type']}`);
    if (sdkAcpay.status !== 200 || !sdkAcpay.body.includes('ACPay')) {
      throw new Error('GET /acpay.js failed or ACPay symbol missing');
    }

    const sdkYoupi = await fetchUrl('http://127.0.0.1:7000/youpi.js');
    console.log(` • GET /youpi.js status: ${sdkYoupi.status} (backwards compatibility preserved)`);
    if (sdkYoupi.status !== 200) throw new Error('GET /youpi.js failed');

    // TEST 3: Rebranded UI Pages
    console.log('\n[4/4] Verifying Rebranded Frontend Pages...');

    // Admin Dashboard
    const adminHtml = await fetchUrl('http://127.0.0.1:6001/');
    const hasAdminTitle = adminHtml.body.includes('AC-Pay');
    const hasAdminBadge = adminHtml.body.includes('Alumni Cell · KJSSE Management Portal');
    console.log(` • Admin Dashboard: HTTP ${adminHtml.status} | Title contains AC-Pay: ${hasAdminTitle} | Badge contains Alumni Cell: ${hasAdminBadge}`);
    if (!hasAdminTitle || !hasAdminBadge) throw new Error('Admin dashboard branding missing');

    // Showcase Store
    const storeHtml = await fetchUrl('http://127.0.0.1:5000/');
    const hasStoreTitle = storeHtml.body.includes('AC-Pay Showcase');
    const hasStoreSub = storeHtml.body.includes('KJ Somaiya College of Engineering');
    const hasStoreProduct = storeHtml.body.includes('AC-Pay — Self-Hosted UPI Payment Gateway');
    console.log(` • Showcase Store: HTTP ${storeHtml.status} | Title: ${hasStoreTitle} | Somaiya subtitle: ${hasStoreSub} | Product H1: ${hasStoreProduct}`);
    if (!hasStoreTitle || !hasStoreSub || !hasStoreProduct) throw new Error('Store branding missing');

    // Order Outcome Pages
    const successHtml = await fetchUrl('http://127.0.0.1:5000/order-success?order_id=KICKSTART-101&amount=500&utr=987654321098');
    const hasSuccessBrand = successHtml.body.includes('Payment Successful · AC-Pay') && successHtml.body.includes('Alumni Cell · KJ Somaiya College of Engineering');
    console.log(` • Order Success Page: HTTP ${successHtml.status} | Branded for AC-Pay & Alumni Cell: ${hasSuccessBrand}`);
    if (!hasSuccessBrand) throw new Error('Order success branding missing');

    const failedHtml = await fetchUrl('http://127.0.0.1:5000/order-failed?order_id=KICKSTART-101');
    const hasFailedBrand = failedHtml.body.includes('Payment Failed · AC-Pay') && failedHtml.body.includes('alumnicell.engg@somaiya.edu');
    console.log(` • Order Failed Page: HTTP ${failedHtml.status} | Branded for AC-Pay & Somaiya email: ${hasFailedBrand}`);
    if (!hasFailedBrand) throw new Error('Order failed branding missing');

    const expiredHtml = await fetchUrl('http://127.0.0.1:5000/order-expired');
    const hasExpiredBrand = expiredHtml.body.includes('Session Expired · AC-Pay');
    console.log(` • Order Expired Page: HTTP ${expiredHtml.status} | Branded for AC-Pay: ${hasExpiredBrand}`);
    if (!hasExpiredBrand) throw new Error('Order expired branding missing');

    const cancelledHtml = await fetchUrl('http://127.0.0.1:5000/order-cancelled');
    const hasCancelledBrand = cancelledHtml.body.includes('Payment Cancelled · AC-Pay');
    console.log(` • Order Cancelled Page: HTTP ${cancelledHtml.status} | Branded for AC-Pay: ${hasCancelledBrand}`);
    if (!hasCancelledBrand) throw new Error('Order cancelled branding missing');

    const suspiciousHtml = await fetchUrl('http://127.0.0.1:5000/order-suspicious');
    const hasSuspiciousBrand = suspiciousHtml.body.includes('Payment Under Review · AC-Pay');
    console.log(` • Order Suspicious Page: HTTP ${suspiciousHtml.status} | Branded for AC-Pay: ${hasSuspiciousBrand}`);
    if (!hasSuspiciousBrand) throw new Error('Order suspicious branding missing');

    const walletHtml = await fetchUrl('http://127.0.0.1:5000/wallet');
    const hasWalletBrand = walletHtml.body.includes('Student & Alumni Account · AC-Pay');
    console.log(` • Wallet/Account Page: HTTP ${walletHtml.status} | Branded for AC-Pay: ${hasWalletBrand}`);
    if (!hasWalletBrand) throw new Error('Wallet branding missing');

    console.log('\n====================================================');
    console.log('✅ ALL AC-PAY REBRANDING VERIFICATIONS PASSED 100%!');
    console.log('====================================================');

  } finally {
    console.log('\nStopping test servers...');
    for (const inst of instances) {
      try { await inst.close(); } catch {}
    }
    console.log('Test servers stopped.');
  }
}

main().catch(err => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});

