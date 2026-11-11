# Helping Services Sub-Backend â€” Architectural Topology (`arcitrauture.md`)

This document details the architectural design, memory buffer patterns, inter-service contracts, and data pipelines of the **Helping Services Sub-Backend (`backend2-helping-service`)**.

---

## 1. High-Level Architectural Role

`backend2-helping-service` functions as the specialized **Real-Time Telemetry Ingestion, Fleet Operations, Geospatial Engine, Device Health & Security Analytics, and Behavioral Intelligence Sub-Backend** of the Helping Services ecosystem.

```
+----------------------------------------------------------------------------------------------------+
|                                    HELPING SERVICES ECOSYSTEM                                      |
+----------------------------------------------------------------------------------------------------+
|                                                                                                    |
|  [ Mobile Users / Partners ] ----(HTTP / REST / Port 8000)----> [ Helping Services Main Backend ]   |
|                                                                                |                   |
|                                                     Async Non-Blocking Stream  |                   |
|                                                     (POST /internal/.../stream)|                   |
|                                                                                v                   |
|                                                     +===========================================+  |
|                                                     |       SUB-BACKEND 2 (PORT 8001)           |  |
|                                                     +===========================================+  |
|                                                     | 1. High-Throughput Stream Ingestion Engine|  |
|                                                     | 2. Sliding Buffer Memory Rings (1000 items|  |
|                                                     | 3. O(1) Real-Time Live Map Registry       |  |
|                                                     | 4. Geofencing (Circular & Polygon Raycast)|  |
|                                                     | 5. Hardware Integrity & Root/Jailbreak Det|  |
|                                                     | 6. Behavioral Intelligence & Feed ML      |  |
|                                                     +===========================================+  |
|                                                                   |             ^                  |
|                                                WebSocket Broadcast|             | Async Sync       |
|                                                (ws://host:8001/ws)|             | (POST /sync)     |
|                                                                   v             |                  |
|                                                     [ Admin Panel / Ops ] [ Main Backend Feed ]    |
+----------------------------------------------------------------------------------------------------+
```

---

## 2. Ingestion & Sliding Window Pipeline

### 2.1 The Ingestion Decoupling Pattern
To ensure mobile clients posting GPS location pings or hardware telemetry never experience latency degradation:
1. The client sends pings to the Main Backend (`/api/v1/users/location`).
2. The Main Backend responds within $< 15$ ms and forwards the telemetry event via HTTP POST to the Sub-Backend (`/api/v1/internal/locations/stream`).
3. The Sub-Backend validates the shared secret (`x-engine-secret` or `x-admin-sub-backend-secret`) in constant time ($O(1)$).
4. The event is pushed into an in-memory sliding buffer ring (`recentEvents`, max 2000 capacity).
5. Fast in-memory state updates occur immediately:
   - `livePositions.set(userId, position)`
   - Geofence boundary checks
   - Anomaly checks (speed $> 90$ km/h, mocked GPS, rooted hardware)
6. Asynchronously persists records to MongoDB (`UserLocation`, `UserDevice`) without blocking the stream pipeline.

---

## 3. Real-Time WebSocket Pub/Sub Topology

The Sub-Backend exposes a dedicated WebSocket server on `/ws` and `/api/v1/ws`.

```
           +-----------------------------+
           |   WebSocket Server (Port 8001)|
           +-----------------------------+
             /             |             \
            /              |              \
           v               v               v
  [ Channel: locations:live ] [ Channel: alerts:security ] [ Channel: devices:stream ]
           |                       |                               |
  - Live GPS pings         - Root/Jailbreak detection      - Hardware updates
  - Driver speed & heading - Speed violation alerts        - OS fleet share
  - Geofence entry/exit    - Low battery warnings          - Network status
```

### Heartbeat & Cleanup
- A 30-second ping/pong heartbeat cycle monitors all socket connections.
- Unresponsive or broken TCP sockets are automatically pruned to prevent file descriptor leaks.

---

## 4. Multi-Database Interconnect

The Sub-Backend connects to the dedicated **User Intelligence & Analytics MongoDB Cluster** (`helping_services_analytics`):
- `UserLocation`: Real-time and historical GPS telemetry indexed by `{ location: '2dsphere' }` and `{ userId: 1, timestamp: -1 }`.
- `UserDevice`: Immutable time-series hardware and operating system telemetry indexed by `{ userId: 1, timestamp: -1 }` and `{ osName: 1, timestamp: -1 }`.
- `GeofenceZone`: Geospatial polygon and circular containment zones.
- `SecurityAlert`: Operational and security incidents lifecycle (open $\rightarrow$ acknowledged $\rightarrow$ resolved).
- `UserInterestProfile`: Computed user affinity vectors, segments, and engine feed overrides.

---

## 5. Security & Isolation Boundaries

1. **Shared Secret Authentication**:
   - Internal webhook endpoints require an exact match against `ADMIN_SUB_BACKEND_SECRET` or `ANALYSIS_ENGINE_SECRET`.
   - Unauthorized calls receive immediate `401 Unauthorized`.
2. **Container Non-Root Security**:
   - The production container drops all root privileges, running strictly as `USER node` (UID 1000).
3. **Correlation ID Tracing**:
   - Every inbound HTTP request carries or receives a unique `X-Request-Id` UUID for end-to-end distributed tracing across microservices.

