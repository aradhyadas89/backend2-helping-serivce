# Helping Services Sub-Backend (`backend2-helping-service`)

> **Enterprise Real-Time Telemetry Ingestion, Fleet Operations, Geospatial Engine, Device Security Analytics & User Behavioral Intelligence Sub-Backend.**
> Designed as an integrated microservice companion to [Helper-FullStack-Backend](file:///E:/Helper-FullStack-Backend).

---

## 1. System Overview

`backend2-helping-service` is the dedicated sub-backend of the Helping Services ecosystem. While the Main Backend (`Helper-FullStack-Backend`, running on port 8000) handles customer authentication, catalog commerce, orders, and payment lifecycles, this service (running on port 8001) is engineered for **ultra-low-latency real-time streaming, high-throughput telemetry processing, live geospatial fleet dispatching, device integrity detection, and asynchronous user intelligence optimization**.

```
                           +-------------------------------------+
                           |    HELPING SERVICES MAIN BACKEND    |
                           |   (Port 8000 - Core, Catalog, Auth) |
                           +-------------------------------------+
                                     |                 |
                   Non-Blocking Webhook Stream         | Pulls User Intelligence /
                   (POST /internal/locations/stream    | Instruction Overrides
                    POST /internal/devices/stream)     | (POST /internal/user-analysis/sync)
                                     |                 |
                                     v                 v
                   +===================================================+
                   |          HELPING SERVICES SUB-BACKEND             |
                   |               (Port 8001 - Node 22 + TS)          |
                   +===================================================+
                    |                |                 |              |
                    v                v                 v              v
       +--------------------+ +---------------+ +---------------+ +---------------+
       | Live Map Engine    | | Device Health | | Geofencing &  | | User Analysis |
       | & Fleet Tracking   | | & Security    | | Zone Breaches | | & Feed ML     |
       +--------------------+ +---------------+ +---------------+ +---------------+
                    \                |                 |              /
                     \               |                 |             /
                      +--------------+-----------------+------------+
                                     |
                                     v
                       +-----------------------------+
                       |   WebSocket Real-Time Stream |
                       | (Live Tracking & Alerts WS) |
                       +-----------------------------+
                                     |
                                     v
                        +---------------------------+
                        |   Admin Panel / Ops Hub   |
                        | (Real-time Fleet Monitor) |
                        +---------------------------+
```

---

## 2. Key Capabilities

### 2.1 Non-Blocking Real-Time Telemetry Ingestion
- Ingests high-throughput location updates from delivery partners and active mobile users without degrading client response time ($< 15$ ms round-trip).
- Ingests detailed OS, hardware, and client telemetry (OS name, version, device model, battery status, charging state, network carrier).
- Shared secret handshake (`x-engine-secret`, `x-admin-sub-backend-secret`) prevents unauthorized stream injection.

### 2.2 Live Map & Geospatial Operations Engine
- **In-Memory O(1) Live Map Register**: Maintains an active registry of all users and delivery partners with sub-millisecond query latency.
- **MongoDB 2dsphere Spatial Queries**: Supports `$geoNear` and `$nearSphere` geospatial proximity calculations with automatic Haversine spherical distance fallback.
- **Breadcrumb Trajectory History**: Records time-series position breadcrumbs for route playback and trip reconstruction.
- **Speed Anomaly Detection**: Automatically flags excessive movement velocity ($> 90$ km/h threshold) as operational alerts.
- **Mocked GPS / Location Spoofing Shield**: Detects mocked coordinate flags to prevent delivery driver fraud.

### 2.3 Geofencing & Boundary Breach Alerts
- Supports both **Circular** (`center` [lon, lat] + `radiusMeters`) and **Arbitrary Polygon** boundaries (Ray-Casting point-in-polygon algorithm).
- Configurable service hubs, restricted perimeters, and college campus zones.
- Automatic entry and exit alerts broadcast directly over WebSockets to fleet dispatchers.

### 2.4 Device Health & Security Intelligence
- **Root & Jailbreak Detection**: Immediately flags devices operating with escalated root permissions or altered kernels with critical security alerts.
- **Virtual Emulator Detection**: Flags non-hardware execution environments (Android SDK emulators, Xcode simulators) to prevent botting and automated scraping.
- **Critical Low Battery Warning**: Monitors delivery partner battery levels ($< 15\%$) during active shifts to prevent sudden communication blackouts.
- **Fleet Analytics Aggregations**: Comprehensive real-time breakdown of iOS vs Android share, OS version adoption, and network connectivity profiles.

### 2.5 User Behavioral Analysis & Feed Recommendation Optimization
- Processes interaction events (views, cart additions, cart dwell durations, purchases) to construct multi-dimensional user interest profiles.
- Segments users into behavioral clusters (`power_user`, `frequent_shopper`, `high_intent_hesitant`, `active_browser`).
- Computes feed ranking overrides (`boostCategories`, `suppressCategories`, `preferredPriceTier`, `customWeights`).
- Automatically pushes computed instruction vectors back into the Main Backend (`POST /api/v1/internal/user-analysis/sync`) to power Algorithm 1 (Personalized Feed Ranking) and Algorithm 2 (Cart Dwell Time Boost).

### 2.6 Real-Time WebSocket Server
- Built-in WebSocket server mounted on `/ws` and `/api/v1/ws`.
- Pub-Sub channel architecture:
  - `locations:live`: Live GPS coordinate pings for fleet map rendering.
  - `alerts:security`: Real-time notifications for root/jailbreak detection, speed violations, and low battery.
  - `devices:stream`: Hardware telemetry event feed.

---

## 3. Technology Stack

| Layer | Technology |
|---|---|
| **Runtime** | Node.js 22 LTS / 24+ |
| **Language** | TypeScript 5.7+ |
| **Framework** | Express 4.21+ |
| **Real-Time Stream** | WebSocket (`ws` 8.18+) |
| **Database** | MongoDB with Mongoose 8.9+ (Logical database segregation: `helping_services_analytics`) |
| **Caching & Tokens** | Upstash Redis REST / IORedis / In-Memory Fallback |
| **Validation** | Zod 3.24+ |
| **Security** | Helmet, CORS, Express-Rate-Limit, Shared Secret Handshake, JWT |
| **Containerization** | Docker (Multi-stage build, non-root `USER node`), Docker Compose |
| **Testing** | Jest, Supertest, MongoMemoryServer |

---

## 4. API Reference

All routes are mounted under `/api/v1`.

### 4.1 Health & Probes
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Root service identification and metadata |
| `GET` | `/api/v1/health` | Comprehensive Kubernetes readiness, liveness, and memory probe |

### 4.2 Internal Stream Webhooks (Protected by Shared Secret)
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/internal/locations/stream` | Ingests real-time GPS location event streamed from Main Backend |
| `POST` | `/api/v1/internal/devices/stream` | Ingests OS and hardware telemetry streamed from Main Backend |

### 4.3 Geospatial & Fleet Operations
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/locations/live` | Retrieve live positions of all active users & delivery partners |
| `GET` | `/api/v1/locations/nearby` | Proximity query: Find active partners within radius of a coordinate |
| `GET` | `/api/v1/locations/stream` | Poll sliding event buffer of recent location updates |
| `GET` | `/api/v1/locations/users/:userId/history` | Trajectory breadcrumbs for a specific user |
| `POST` | `/api/v1/locations/geofences` | Create a circular or polygon geofence zone |
| `GET` | `/api/v1/locations/geofences` | List all active geofence zones |

### 4.4 Device Telemetry & Fleet Analytics
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/devices/analytics` | Fleet share metrics (iOS vs Android %, brands, rooted count) |
| `GET` | `/api/v1/devices/stream` | Poll sliding event buffer of device updates |
| `GET` | `/api/v1/devices/users/:userId/history` | Device history trail for a specific user |

### 4.5 Security & Fleet Alerts
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/alerts` | List alerts (status, severity, alertType, pagination) |
| `GET` | `/api/v1/alerts/stats` | Summary statistics of active open alerts |
| `PATCH` | `/api/v1/alerts/:alertId/status` | Acknowledge, resolve, or dismiss an alert |

### 4.6 User Behavioral Intelligence
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/analysis/trigger` | Trigger ML analysis and sync with Main Backend |
| `GET` | `/api/v1/analysis/users/:userId/profile` | View calculated interest profile & engine instructions |

---

## 5. Getting Started

### 5.1 Prerequisites
- Node.js 22.0.0 or higher
- npm 10+
- MongoDB 6.0+ (or MongoDB Atlas cluster connection URI)

### 5.2 Local Setup
```bash
# 1. Clone repository
git clone https://github.com/aradhyadas89/backend2-helping-serivce.git
cd backend2-helping-serivce

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env

# 4. Start development server with live reload
npm run dev
```

### 5.3 Automated Testing
```bash
# Run test suite with in-memory MongoDB
npm test
```

### 5.4 Production Build & Start
```bash
# Build TypeScript
npm run build

# Start production server
npm start
```

### 5.5 Docker Deployment
```bash
# Build and run with docker-compose
docker-compose up --build -d
```

