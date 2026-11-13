# Helping Services Sub-Backend — Development Rules & Guidelines (`rules.md`)

This document defines the mandatory engineering standards, security protocols, inter-service contracts, and quality requirements for **`backend2-helping-service`**.

---

## 1. Architectural & Sub-Backend Integration Rules

### Rule 1.1: Shared Secret Handshake Enforcement
- All endpoints under `/api/v1/internal/*` MUST strictly verify incoming requests using the shared secret from:
  1. `x-engine-secret` header, OR
  2. `x-admin-sub-backend-secret` header, OR
  3. `Authorization: Bearer <secret>` header.
- Permitted valid secret tokens are strictly loaded from `env.ADMIN_SUB_BACKEND_SECRET` and `env.ANALYSIS_ENGINE_SECRET`.
- Calls with missing or invalid credentials MUST be rejected immediately with HTTP 401 (`UnauthorizedException`).

### Rule 1.2: Non-Blocking Telemetry Ingestion Contract
- Webhook endpoints (`/api/v1/internal/locations/stream`, `/api/v1/internal/devices/stream`) MUST acknowledge the sender within $< 15$ ms.
- In-memory sliding buffer updates and live map registry insertions MUST be synchronous $O(1)$ operations.
- Long-running computations, external HTTP calls, or heavy analytics aggregations MUST NEVER block the response stream.

### Rule 1.3: Default Port Allocation
- `backend2-helping-service` MUST run on port `8001` in all environments, matching `env.ADMIN_SUB_BACKEND_URL="http://localhost:8001"` configured in the Main Backend.

### Rule 1.4: Strict Schema & Backward Compatibility
- Ingestion endpoints MUST support backwards-compatible payloads from the Main Backend (`userId`, `userName`, `userEmail`, `role`, `latitude`, `longitude`, `coordinates`, `speed`, `heading`, `batteryLevel`, `osName`, `deviceBrand`, `deviceModel`).
- Missing non-critical fields MUST be gracefully assigned fallback defaults via Zod schemas.

---

## 2. Real-Time Geospatial & Fleet Operations Rules

### Rule 2.1: Coordinate Validation & GeoJSON Standard
- Every latitude and longitude coordinate pair MUST pass strict spherical bounds validation:
  - Latitude: $[-90.0, +90.0]$
  - Longitude: $[-180.0, +180.0]$
  - Accuracy: $\ge 0$ meters
- All spatial documents stored in MongoDB MUST follow the GeoJSON RFC 7946 standard:
  `{ type: 'Point', coordinates: [longitude, latitude] }` (**longitude precedes latitude**).
- Spatial collections MUST maintain a `2dsphere` index for high-speed indexing.

### Rule 2.2: Speed Anomaly Thresholds
- The system enforces a standard maximum velocity threshold of `90 km/h` (`SPEED_ALERT_THRESHOLD_KMPH`).
- Pings exceeding this limit automatically generate a high-severity `speed_violation` alert.

### Rule 2.3: Mocked GPS & Coordinate Spoofing Protection
- Telemetry pings flagging `isMocked: true` MUST trigger a critical `mocked_location_spoofing` alert to prevent driver fraud and coordinate spoofing.

### Rule 2.4: Geofence Integrity
- Geofence codes MUST be unique, uppercase, and alphanumeric (e.g., `CAMPUS_MAIN_HUB`).
- Polygon geofences MUST have at least 3 vertices and automatically close (the first and last vertices must coincide).

---

## 3. Hardware Integrity & Security Rules

### Rule 3.1: Zero-Tolerance Root & Jailbreak Alerting
- Devices reporting `isRootedOrJailbroken: true` MUST immediately generate a `critical` severity security alert and broadcast to the `alerts:security` WebSocket room.

### Rule 3.2: Emulator Detection
- Any partner telemetry record flagging `isEmulator: true` MUST trigger an `emulator_detected` alert to prevent automated order bidding and virtual device scraping.

### Rule 3.3: Partner Battery Monitoring
- Active delivery partners whose battery drops to $\le 15\%$ (`LOW_BATTERY_ALERT_THRESHOLD`) while not charging trigger an operational alert to notify dispatchers of potential communication loss.

---

## 4. Behavioral Intelligence & Feed Vector Rules

### Rule 4.1: Category Affinity Normalization
- Category affinity scores MUST be normalized to the integer range $[0, 100]$.
- Top affinities ($\ge 40$) are placed in $\mathcal{C}_{\text{boost}}$ (max 3 categories).
- Categories with net negative interaction scores are placed in $\mathcal{C}_{\text{suppress}}$.

### Rule 4.2: Inter-Service Sync Contract
- Sync dispatches to the Main Backend MUST target `POST ${env.MAIN_BACKEND_URL}/api/v1/internal/user-analysis/sync` with headers `x-engine-secret: ${env.ANALYSIS_ENGINE_SECRET}`.
- If the Main Backend is unreachable, the Sub-Backend MUST log a warning and continue normal operations without throwing fatal exceptions.

---

## 5. API Response Envelope & Error Handling Rules

### Rule 5.1: Uniform API Response Contract
All successful responses MUST be wrapped using `sendSuccess`:
```json
{
  "success": true,
  "message": "Live locations retrieved successfully",
  "data": [...],
  "count": 10,
  "meta": {}
}
```

### Rule 5.2: Structured Custom AppError Classes
- **Never throw raw strings or generic untyped errors**. Raise structured exception subclasses from `src/middlewares/errorHandler.ts`:
  - `BadRequestException(message, details)` (HTTP 400)
  - `UnauthorizedException(message)` (HTTP 401)
  - `ForbiddenException(message)` (HTTP 403)
  - `NotFoundException(message)` (HTTP 404)
  - `ConflictException(message)` (HTTP 409)
  - `InternalServerErrorException(message)` (HTTP 500)
- All errors are formatted into uniform JSON:
  ```json
  {
    "success": false,
    "error": {
      "code": 400,
      "message": "Validation failed",
      "details": []
    }
  }
  ```

---

## 6. Real-Time WebSocket Pub/Sub Rules

### Rule 6.1: Heartbeat & Connection Hygiene
- A 30-second ping/pong cycle MUST monitor all active client sockets.
- Unresponsive sockets MUST be terminated immediately to prevent resource exhaustion.

### Rule 6.2: Channel Isolation
- WebSocket broadcasts MUST only be transmitted to clients subscribed to the corresponding channel (`locations:live`, `alerts:security`, `devices:stream`, or wildcard `*`).

---

## 7. Testing & Quality Assurance Pipeline

### Rule 7.1: 100% Test Pass Requirement
Before committing or submitting changes:
```bash
# 1. Type check and build
npm run build

# 2. Run automated test suite
npm test
```
- All test suites in `tests/` MUST pass with **0 failures (100% pass rate)**.
- New endpoints or business logic MUST be accompanied by unit or integration tests utilizing `MongoMemoryServer`.



---

## 8. User Order System, Pricing & Billing Rules

### Rule 8.1: Minimum Order Value Gate
- Every order submitted via `POST /api/v1/orders` MUST satisfy:
  $$\text{Subtotal} \ge 30.00\text{ INR}$$
- Any order with items subtotal $< ₹30.00$ MUST be rejected with HTTP 400 (`BadRequestException`) specifying the minimum order threshold.

### Rule 8.2: 1-Minute Payment Selection Window
- Once a partner accepts an order, the user is granted exactly **60 seconds (1 minute)** to select either `ONLINE` or `OFFLINE` payment mode.
- Failure to select payment mode within 60 seconds triggers automatic order cancellation (`CANCELLED_PAYMENT_TIMEOUT`) and increments the user's unpaid cancellation counter.

### Rule 8.3: 30-Paisa Cancellation Surcharge Penalty
- The first unpaid order cancellation by any user is forgiven as a **one-time mercy**.
- Upon the **second ($\ge 2$) and subsequent cancellations**, a surcharge penalty of **+₹0.30 (30 paisa)** is automatically appended to the billing breakdown of all future orders placed by that user.

---

## 9. Partner Crisis Gate & 2.5 km Ring Partitioning Rules

### Rule 9.1: Partner Crisis Ratio Gate
- An order can only be initiated if there are at least **2 online partners** available within the 2.5 km dispatch radius.
- If fewer than 2 active partners are online, the system MUST return HTTP 503 (`Service Unavailable`) with:
  `"Service temporarily unavailable due to partner crisis. At least 2 active delivery partners must be online in your zone."`

### Rule 9.2: 2.5 km Concentric Ring Staggered Delays
- Candidate partners within 2.5 km are partitioned into 4 distance boxes:
  - **Box 1** ($0 - 500\text{ m}$): $0\text{ s}$ delay
  - **Box 2** ($500 - 1000\text{ m}$): $5\text{ s}$ delay
  - **Box 3** ($1000 - 1750\text{ m}$): $10\text{ s}$ delay
  - **Box 4** ($1750 - 2500\text{ m}$): $15\text{ s}$ delay
- Rings are dispatched via WebSocket with respective delays to give closer partners priority.

### Rule 9.3: Atomic First-Pick Order Acceptance
- Order claim by a partner MUST be executed as an atomic database condition (`assignedPartnerId == null`).
- Concurrent attempts by other partners MUST return HTTP 409 (`ConflictException`).

---

## 10. Partner Payment Mode Ratio & Delivery Rules

### Rule 10.1: 5:1 Online-to-Offline Fairness Balancer
- Each partner is allocated an offline cash delivery quota governed by:
  $$\operatorname{MaxOfflineAllowed} = \left\lfloor \frac{\text{onlineOrdersCompleted}}{5} \right\rfloor + 1$$
- Partners exceeding this quota cannot accept additional offline cash orders until sufficient online orders are completed.

### Rule 10.2: Transport Mode Physics & One-Time Mercy Extension
- Travel ETAs are computed according to partner transport mode:
  - `cycle`: $15.0\text{ km/h} \approx 4.167\text{ m/s}$
  - `walk`: $4.5\text{ km/h} \approx 1.250\text{ m/s}$
- If partner is delayed, they are granted **exactly one mercy extension**.
- Subsequent unexcused delays deduct $5$ points from the partner's reputation score.

### Rule 10.3: Dual OTP Verification & Ring Handshake
- **Cash Pickup Handshake**:
  1. Partner marks reached near user.
  2. User phone rings via WebSocket.
  3. 6-digit numeric OTP is emailed to user.
  4. Partner collects physical cash and verifies the OTP via `POST /api/v1/orders/:orderId/verify-cash-otp`.
- **Delivery Handshake**:
  1. Partner marks arrival at delivery point.
  2. User phone rings via WebSocket.
  3. 6-digit delivery OTP is emailed to user.
  4. Partner submits OTP via `POST /api/v1/orders/:orderId/verify-delivery-otp` to complete the delivery.

### Rule 10.4: Virtual Wallet & Real Money Separation
- Customer payments (via Razorpay gateway or cash) belong to the platform.
- Delivery fees earned by partners are credited as **virtual balances** in their in-app wallet (`PartnerWallet.virtualBalance`).

---

## 11. Multi-Database Interconnect & Data Governance Rules

### Rule 11.1: 3 Dedicated Sub-Backend 2 Database Boundaries
- All persistent data in Sub-Backend 2 MUST be routed to its designated database instance (completely separate from Main Backend):
  1. **Orders & Billing Database (`helping_sub2_orders`)**:
     - `Order` (state machine, ring delays, OTPs, timer countdowns, 5:1 ratio), `Product` (pricing in ₹, catalog), and `UserOrderProfile` (cancellations & ₹0.30 surcharge penalty).
  2. **Partner Fleet & Wallets Database (`helping_sub2_fleet`)**:
     - `Partner` (fleet profiles, live state, vehicle dynamics, ratings, mercy extensions) and `PartnerWallet` (virtual ledger balances, cash holds).
  3. **Real-Time Telemetry & Geofencing Database (`helping_sub2_telemetry`)**:
     - `UserLocation` (live GPS, breadcrumbs, 2dsphere), `UserDevice` (battery, OS distribution), `GeofenceZone`, `SecurityAlert`, `UserInterestProfile`, `ProductEvent`.

### Rule 11.2: Dynamic Model Compilation via Connection Getters
- Mongoose models MUST NEVER be registered on the global default `mongoose` connection object.
- Every model file in `src/models/*.ts` MUST export a dynamic getter function (`getOrdersDb()`, `getFleetDb()`, or `getTelemetryDb()`) that compiles and caches the schema onto its dedicated connection instance.

### Rule 11.3: Cross-Database Referential Integrity
- Because models reside on distinct database clusters in production Atlas environments, MongoDB `$lookup` aggregations across separate databases are strictly prohibited.
- Cross-database relationships (e.g., `Order` referencing `Partner.partnerId` or `Product.sku`) MUST be resolved application-side using asynchronous service queries.

### Rule 11.4: In-Memory Multi-Database Test Isolation
- During test execution (`NODE_ENV === 'test'`), all 3 logical databases MUST run on `mongodb-memory-server` isolated via `useDb(dbName, { useCache: true })`.
- Test cleanup hooks (`afterEach`) MUST sweep and truncate collections across all 3 logical databases to prevent state leakage between test suites.

