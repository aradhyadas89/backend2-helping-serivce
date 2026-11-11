# Helping Services Sub-Backend â€” System & Engineering Rules (`rule.md`)

This document defines the mandatory engineering standards, security protocols, API contracts, and operational policies governing **`backend2-helping-service`**.

---

## 1. Architectural & Sub-Backend Integration Rules

### Rule 1.1: Shared Secret Verification
- All endpoints under `/api/v1/internal/*` MUST strictly verify the shared secret from either the `x-engine-secret` or `x-admin-sub-backend-secret` header, or a `Bearer <secret>` token.
- Valid secrets are loaded strictly from `env.ADMIN_SUB_BACKEND_SECRET` and `env.ANALYSIS_ENGINE_SECRET`.
- Missing or invalid secret credentials MUST immediately terminate with `401 Unauthorized`.

### Rule 1.2: Non-Blocking Telemetry Ingestion
- Webhook endpoints (`/api/v1/internal/locations/stream`, `/api/v1/internal/devices/stream`) MUST respond within $< 15$ ms.
- In-memory ring buffer insertion and live map updates occur synchronously in $O(1)$ time.
- Heavy aggregations or external calls MUST NEVER block the response stream.

### Rule 1.3: Port Allocation
- `backend2-helping-service` runs by default on port `8001`, as configured in the Main Backend (`env.ADMIN_SUB_BACKEND_URL="http://localhost:8001"`).

---

## 2. Geospatial & Fleet Operations Rules

### Rule 2.1: Coordinate Validation
- All incoming coordinates MUST satisfy GeoJSON standards:
  - Latitude: $[-90.0, +90.0]$
  - Longitude: $[-180.0, +180.0]$
  - Accuracy: $\ge 0$ meters
- Point coordinates MUST be indexed with a `2dsphere` spatial index.

### Rule 2.2: Speed Violation Anomaly Detection
- The system enforces a default speed limit threshold of `90 km/h` (`SPEED_ALERT_THRESHOLD_KMPH`).
- Pings exceeding this threshold automatically trigger a high-severity `speed_violation` alert.

### Rule 2.3: Location Spoofing & Mocked GPS Protection
- Client payloads flagging `isMocked: true` MUST trigger a critical `mocked_location_spoofing` alert to prevent driver fraud and coordinate spoofing.

---

## 3. Hardware & Security Intelligence Rules

### Rule 3.1: Root & Jailbreak Alerting
- Any device telemetry record flagging `isRootedOrJailbroken: true` MUST immediately generate a critical `rooted_or_jailbroken` security alert and broadcast to the `alerts:security` WebSocket room.

### Rule 3.2: Emulator Detection
- Pings with `isEmulator: true` are recorded and flagged with `emulator_detected` alerts to prevent botting on delivery order bidding.

### Rule 3.3: Partner Battery Monitoring
- Active delivery partners whose battery drops to $\le 15\%$ (`LOW_BATTERY_ALERT_THRESHOLD`) while not charging trigger an operational alert to notify dispatchers of potential communication loss.

---

## 4. Error Handling & Standardized Responses

### Rule 4.1: Standardized Error Format
All errors MUST conform to:
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

### Rule 4.2: Structured Custom AppError Classes
- Never throw raw strings or generic untyped errors in controllers or services:
  - `BadRequestException` (HTTP 400)
  - `UnauthorizedException` (HTTP 401)
  - `ForbiddenException` (HTTP 403)
  - `NotFoundException` (HTTP 404)
  - `ConflictException` (HTTP 409)
  - `InternalServerErrorException` (HTTP 500)

---

## 5. Testing & Code Quality Assurance

### Rule 5.1: 100% Test Pass Requirement
- Every new feature, endpoint, or calculation rule MUST include automated tests in `tests/`.
- All tests MUST pass cleanly with 0 failures prior to code commits.

