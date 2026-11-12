# KickStart 2027 + AC-Pay Integration Guide
**Alumni Cell — KJ Somaiya College of Engineering**

This document describes how the KickStart 2027 student interview registration platform integrates with the self-hosted **AC-Pay (Alumni Cell Pay)** payment gateway.

---

## 1. Architecture Overview

```
[ KickStart Frontend (Vite) ]
  • Multi-track Interview Selection (Technical, Non-Technical, Mock)
  • Student Roll Number & @somaiya.edu Email Validation
  • Real-time Backend Price Calculation Display
        │
        ▼ (POST /api/kickstart/register)
[ KickStart Backend Server (:5050) ]
  • Computes order total strictly on backend
  • Validates against duplicate confirmed registrations
  • Generates cryptographically unique Order ID (KS27-<ROLL>-<HEX>)
        │
        ▼ (POST /api/v1/payments with X-Merchant-Id & X-Merchant-Key)
[ AC-Pay Gateway (:6100) ]
  • Validates merchant signature & allowlisted return URL
  • Creates session with KickStart attendee metadata
  • Returns checkoutUrl (:7000/pay/:id)
        │
        ▼ (Browser redirected to AC-Pay Checkout)
[ Student Scans UPI Dynamic QR & Pays ]
        │
        ▼ (Bank Notification to SMS, Gmail, or Android Observer)
[ AC-Pay Observer Engine Verifies Transaction ]
  • Matches exact amount, account slot, and authentic bank UTR
  • Transitions session to OBSERVED_SUCCESS / RECONCILED
        │
        ▼ (Signed HMAC-SHA256 Webhook: POST /api/kickstart/webhook)
[ KickStart Backend ]
  • Verifies HMAC signature with X-Gateway-Signature header
  • Deduplicates delivery ID in kickstart_webhook_receipts
  • Sets registration status = 'VERIFIED_PAID' with bank UTR and timestamp
        │
        ▼ (Live Polling: GET /api/kickstart/status/:orderId)
[ KickStart Frontend E-Pass Screen ]
  • Displays Official KickStart 2027 E-Pass with Roll No and UTR proof
  • Allows student to download or print their pass
```

---

## 2. Configuration & Environment Variables

### KickStart Backend (`kick/web-development-portfolio/server/config.js`)

| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `KICKSTART_PORT` | `5050` | Port for the KickStart backend HTTP server |
| `KICKSTART_PUBLIC_URL` | `http://localhost:5173/kSTART` | Public base URL for the KickStart frontend |
| `AC_PAY_API_URL` | `http://127.0.0.1:6100` | AC-Pay Payment API base URL |
| `AC_PAY_MERCHANT_ID` | `00000000-0000-0000-0000-000000000001` | AC-Pay Merchant UUID |
| `AC_PAY_WEBHOOK_SECRET`| `youpi_test_webhook_secret_for_coin_store_123` | Shared HMAC-SHA256 secret for webhook validation |
| `KICKSTART_PRICE_TECH` | `50` | Price in INR for Technical Interview track |
| `KICKSTART_PRICE_NON_TECH` | `40` | Price in INR for Non-Technical Interview track |
| `KICKSTART_PRICE_MOCK` | `30` | Price in INR for Mock Interview track |
| `KICKSTART_DB_PATH` | `./data/kickstart-registrations.sqlite` | SQLite database path |

### AC-Pay Gateway (`AC-Pay/.env`)

Ensure the KickStart frontend and backend origins are present in `YOUPI_ALLOWED_RETURN_ORIGINS`:
```env
YOUPI_ALLOWED_RETURN_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://localhost:5050,http://127.0.0.1:5050,http://localhost:5000,https://shop.example.com
```

---

## 3. Running Locally

### Step 1: Start AC-Pay Gateway Services
In the `AC_Pay/AC-Pay` directory:
```bash
npm run start
```
Starts:
- Payment API on port `6100`
- Checkout Portal on port `7000`
- Merchant Admin on port `6001`

### Step 2: Start KickStart Backend Server
In the `kick/web-development-portfolio` directory:
```bash
npm run server
```
Listens on port `5050` and auto-initializes the SQLite database schema.

### Step 3: Start KickStart Frontend Dev Server
In the `kick/web-development-portfolio` directory:
```bash
npm run dev
```
Listens on `http://localhost:5173`. Proxies `/api/kickstart/*` to `http://127.0.0.1:5050`.

---

## 4. API Endpoints Reference

### 1. `GET /api/kickstart/tickets`
Returns active interview tracks and backend-enforced prices.
```json
{
  "event": "KickStart 2027",
  "currency": "INR",
  "tickets": [
    { "id": "tech", "name": "Technical Interview", "price": 50, ... },
    { "id": "non-tech", "name": "Non-Technical Interview", "price": 40, ... },
    { "id": "mock", "name": "Mock Interview", "price": 30, ... }
  ]
}
```

### 2. `POST /api/kickstart/register`
Creates an order, computes total, and initiates AC-Pay payment.
**Request Body:**
```json
{
  "fullName": "Baqir M",
  "rollNumber": "16010121045",
  "department": "ce",
  "year": "te",
  "collegeEmail": "baqir.m@somaiya.edu",
  "phone": "9876543210",
  "selectedTicketIds": ["tech", "mock"],
  "resumeName": "Baqir_Resume_2027.pdf",
  "whyKickstart": "Placement preparation"
}
```
**Response (201 Created):**
```json
{
  "success": true,
  "registrationId": "uuid",
  "orderId": "KS27-16010121045-A1B2C3D4",
  "paymentId": "ps_...",
  "checkoutUrl": "http://localhost:7000/pay/ps_...",
  "amountRupees": 80,
  "amountPaise": 8000,
  "status": "PENDING_PAYMENT"
}
```

### 3. `GET /api/kickstart/status/:orderId`
Retrieves live status of a registration. Polled by the frontend pass screen.
```json
{
  "orderId": "KS27-16010121045-A1B2C3D4",
  "studentName": "Baqir M",
  "rollNumber": "16010121045",
  "amountRupees": 80,
  "paymentStatus": "VERIFIED_PAID",
  "utr": "624567890123",
  "verifiedAt": "2026-11-12T09:00:00.000Z"
}
```

### 4. `POST /api/kickstart/webhook`
Receives authentic HMAC-SHA256 signed webhooks from AC-Pay.
- Validates `X-Gateway-Signature: sha256=<hmac>` using `AC_PAY_WEBHOOK_SECRET`.
- On `OBSERVED_SUCCESS`, updates registration status to `VERIFIED_PAID`.

### 5. `GET /api/kickstart/registrations`
Smart Scheduler & Organizer Export API. Returns confirmed attendee records.
```json
{
  "success": true,
  "totalVerified": 42,
  "registrations": [
    {
      "id": "uuid",
      "orderId": "KS27-16010121045-...",
      "rollNo": "16010121045",
      "name": "Baqir M",
      "department": "ce",
      "selectedTracks": ["tech", "mock"],
      "amountPaid": 80,
      "utr": "624567890123",
      "status": "CONFIRMED",
      "generatedSlots": null
    }
  ]
}
```
> **Note on Smart Scheduler Compatibility:**
> `generatedSlots` is explicitly set to `null` on new registrations, ensuring interview slots are unassigned until the KickStart smart scheduler or committee runs panel allocations.

---

## 5. Automated Tests

Run integration and verification suites anytime:

```bash
# In AC_Pay/AC-Pay:
npm run test:kickstart   # Runs KickStart + AC-Pay end-to-end integration tests (6/6 passing)
npm run test:phase3      # Runs Phase 3 workflow hardening verification (15/15 passing)
npm test                 # Runs all 57 AC-Pay gateway regression suites
```
