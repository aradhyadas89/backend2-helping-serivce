# Helping Services Sub-Backend — Algorithmic Specifications (`algorithms.md`)

This document details the mathematical models, algorithmic pseudo-code, geometric formulations, and computational complexity of the core algorithms powering **`backend2-helping-service`**.

---

## Algorithm 1: Real-Time Stream Ingestion, In-Memory Sliding Buffer Ring & Non-Blocking Webhook Pipeline

### 1.1 Objective
Ingest high-throughput location updates and hardware telemetry streamed from the Main Backend without degrading mobile client response latency ($\tau_{\text{latency}} < 15\text{ ms}$). Provide an ultra-low latency $O(1)$ polling buffer for operator dashboards.

### 1.2 Mathematical Formulation
Let $\mathcal{E} = \{e_1, e_2, \dots, e_m\}$ denote a continuous stream of telemetry events arriving at time $t_i$.
The in-memory sliding ring buffer $\mathcal{B}$ with static maximum capacity $K = 2000$ operates as a FIFO (First-In, First-Out) sliding window:

$$\mathcal{B}_t = \big[ e_t, \, e_{t-1}, \, \dots, \, e_{t-\min(t, K)+1} \big]$$

When a new event $e_{t+1}$ arrives:
$$\mathcal{B}_{t+1} = \operatorname{unshift}(e_{t+1}, \mathcal{B}_t)$$
$$\text{if } |\mathcal{B}_{t+1}| > K \implies \mathcal{B}_{t+1} \leftarrow \mathcal{B}_{t+1} \setminus \{ e_{\text{oldest}} \}$$

#### Streaming Filter Metric
For query parameters $\theta = \{ t_{\text{since}}, \, \text{role}, \, L \}$ where $L \le 500$:
$$\mathcal{E}_{\text{stream}}(\theta) = \operatorname{take}\Big( \big\{ e \in \mathcal{B} \mid t(e) \ge t_{\text{since}} \land (\text{role} = \varnothing \lor \text{role}(e) = \text{role}) \big\}, \, L \Big)$$

### 1.3 Pseudo-Code
```python
class SlidingBufferRing:
    def __init__(self, max_capacity=2000):
        self.buffer = []
        self.max_capacity = max_capacity
        self.live_registry = {}  # userId -> latest event

    def ingest_event(self, event):
        # O(1) buffer push
        self.buffer.insert(0, event)
        if len(self.buffer) > self.max_capacity:
            self.buffer.pop()

        # Update O(1) live map registry
        self.live_registry[event.userId] = event

        return True

    def get_stream(self, limit=100, since=None, role=None):
        filtered = self.buffer
        if since:
            filtered = [e for e in filtered if e.timestamp >= since]
        if role:
            filtered = [e for e in filtered if e.role == role]
        return filtered[:min(limit, 500)]
```

### 1.4 Complexity Analysis
- **Time Complexity**: Insertion is $\mathcal{O}(1)$ amortized; Stream query is $\mathcal{O}(|\mathcal{B}|)$ bounded by $K = 2000$.
- **Space Complexity**: Strictly bounded to $\mathcal{O}(K + |\mathcal{U}|)$ where $|\mathcal{U}|$ is the count of distinct active users.

---

## Algorithm 2: Spherical Haversine Metric & Geospatial Proximity Clustering

### 2.1 Objective
Compute exact great-circle surface distances between moving delivery partners, client delivery addresses, and campus fulfillment centers on the WGS84 ellipsoidal Earth model.

### 2.2 Mathematical Formulation
Given two surface coordinates $P_1 = (\phi_1, \lambda_1)$ and $P_2 = (\phi_2, \lambda_2)$, where:
- $\phi$ represents latitude in radians: $\phi = \frac{\pi}{180} \times \text{lat}$
- $\lambda$ represents longitude in radians: $\lambda = \frac{\pi}{180} \times \text{lon}$

The great-circle angular distance $\Delta\sigma$ is derived via the Haversine formula:

$$\Delta\phi = \phi_2 - \phi_1, \quad \Delta\lambda = \lambda_2 - \lambda_1$$

$$a = \sin^2\left(\frac{\Delta\phi}{2}\right) + \cos(\phi_1)\cos(\phi_2)\sin^2\left(\frac{\Delta\lambda}{2}\right)$$

$$c = 2 \cdot \operatorname{atan2}\left(\sqrt{a}, \, \sqrt{1 - a}\right)$$

$$d(P_1, P_2) = R \cdot c$$

Where mean Earth radius $R = 6,371,000 \text{ meters}$.

#### Initial Bearing Angle Calculation
To determine delivery partner heading relative to true north ($[0^\circ, 360^\circ)$):

$$\theta = \operatorname{atan2}\left( \sin(\Delta\lambda)\cos(\phi_2), \; \cos(\phi_1)\sin(\phi_2) - \sin(\phi_1)\cos(\phi_2)\cos(\Delta\lambda) \right)$$

$$\text{bearing}(P_1, P_2) = (\text{toDegrees}(\theta) + 360^\circ) \pmod{360^\circ}$$

### 2.3 Proximity Clustering Formulation
For query origin $Q = (\phi_Q, \lambda_Q)$ and search radius $r_{\text{max}}$:

$$\mathcal{U}_{\text{nearby}} = \left\{ u \in \mathcal{U}_{\text{active}} \mid d\left(Q, \, u.\mathbf{x}\right) \le r_{\text{max}} \right\}$$

Sorted in ascending order of proximity:
$$\mathcal{U}_{\text{sorted}} = \operatorname{sort\_by}\left(\mathcal{U}_{\text{nearby}}, \, \lambda u: d(Q, u.\mathbf{x})\right)$$

### 2.4 Pseudo-Code
```python
import math

def haversine_distance(lat1, lon1, lat2, lon2):
    R = 6371000.0  # Earth radius in meters
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = math.sin(delta_phi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

def find_nearby_entities(origin_lat, origin_lon, radius_meters, active_entities, limit=50):
    candidates = []
    for entity in active_entities:
        dist = haversine_distance(origin_lat, origin_lon, entity.lat, entity.lon)
        if dist <= radius_meters:
            candidates.append({
                "entity": entity,
                "distanceMeters": round(dist)
            })

    candidates.sort(key=lambda x: x["distanceMeters"])
    return candidates[:limit]
```

---

## Algorithm 3: Ray-Casting Point-in-Polygon & Dynamic Circular Geofencing Evaluation

### 3.1 Objective
Determine in real time whether a GPS ping resides inside designated service boundaries, campus delivery zones, or restricted areas, and automatically trigger entry/exit alerts.

### 3.2 Mathematical Formulation

#### 1. Circular Geofence
For circle defined by center $C = (\phi_C, \lambda_C)$ and radius $r$:
$$\operatorname{IsInside}_{\text{circle}}(P, C, r) = \begin{cases}
\text{True} & \text{if } d(P, C) \le r \\
\text{False} & \text{otherwise}
\end{cases}$$

#### 2. Arbitrary Polygon Geofence (Jordan Curve Theorem via Ray-Casting)
Let polygon $\mathcal{V} = [V_0, V_1, \dots, V_{n-1}]$ be an ordered sequence of vertices where $V_i = (x_i, y_i) = (\lambda_i, \phi_i)$.
A semi-infinite horizontal ray is cast from test point $P = (x_P, y_P)$ extending along the positive $x$-axis to $+\infty$.

The ray intersects a line segment between $V_i$ and $V_j$ (where $j = (i - 1) \pmod n$) if and only if:
1. $(y_i > y_P) \ne (y_j > y_P)$ (the segment straddles the ray's $y$-level).
2. The $x$-coordinate of the intersection point is strictly greater than $x_P$:
   $$x_{\text{intersect}} = \frac{(x_j - x_i)(y_P - y_i)}{y_j - y_i} + x_i > x_P$$

The point is strictly internal if the total count of ray crossings is odd:
$$\operatorname{IsInside}_{\text{polygon}}(P, \mathcal{V}) = \left( \sum_{i=0}^{n-1} \mathbb{I}\left( \text{Segment}(V_i, V_{i-1}) \text{ intersects Ray}(P) \right) \right) \pmod 2 \equiv 1$$

### 3.3 Pseudo-Code
```python
def is_point_in_polygon(point_lon, point_lat, polygon_coordinates):
    inside = False
    n = len(polygon_coordinates)
    j = n - 1

    for i in range(n):
        xi, yi = polygon_coordinates[i]
        xj, yj = polygon_coordinates[j]

        intersect = ((yi > point_lat) != (yj > point_lat)) and \
                    (point_lon < (xj - xi) * (point_lat - yi) / (yj - yi) + xi)
        if intersect:
            inside = not inside
        j = i

    return inside
```

### 3.4 Complexity Analysis
- **Circular Geofence**: $\mathcal{O}(1)$ time.
- **Polygon Geofence**: $\mathcal{O}(V)$ time where $V$ is the vertex count.

---

## Algorithm 4: Real-Time Speed Anomaly, Mocked GPS Spoofing & Critical Low-Battery Alerting

### 4.1 Objective
Protect delivery partner safety and prevent delivery fraud by identifying abnormal travel velocity, artificial coordinate spoofing, and sudden battery drainage.

### 4.2 Mathematical Formulation

#### 1. Metric Velocity Calculation
For GPS speed reported in meters per second ($v_{\text{mps}}$):
$$v_{\text{kmph}} = v_{\text{mps}} \times 3.6$$

If speed is not provided directly by the hardware sensor, it is computed between consecutive pings:
$$\Delta t = t_k - t_{k-1}, \quad \Delta d = d(P_k, P_{k-1})$$
$$v_{\text{computed}} = \left(\frac{\Delta d}{\Delta t}\right) \times 3.6 \text{ km/h}$$

#### 2. Alert Conditions
$$\text{TriggerSpeedAlert} \iff v_{\text{kmph}} > 90.0 \text{ km/h}$$
$$\text{TriggerMockedGpsAlert} \iff \text{event}.\text{isMocked} \equiv \text{True}$$
$$\text{TriggerLowBatteryAlert} \iff \text{role} = \text{'partner'} \land \text{battery} \le 15\% \land \neg \text{isCharging}$$

#### 3. Temporal Deduplication Window
To prevent operator alert fatigue, duplicate alerts for the same user and alert type are suppressed within a sliding window of $\Delta T_{\text{cooldown}} = 300\text{ seconds}$ (5 minutes):
$$\text{PermitAlert}(u, \alpha) \iff \nexists \, \text{Alert}(u, \alpha, \text{status} = \text{'open'}) \text{ with } (t_{\text{now}} - t_{\text{created}}) < 300\text{s}$$

---

## Algorithm 5: OS Market Share, Version Adoption & Hardware Integrity Risk Aggregation

### 5.1 Objective
Synthesize real-time hardware telemetry into statistical metrics for ecosystem stability, security audit compliance, and mobile client version management.

### 5.2 Mathematical Formulation
Let $\mathcal{D} = \{d_1, d_2, \dots, d_N\}$ be the set of device telemetry events recorded within window $\mathcal{T} \in \{24\text{h}, 7\text{d}, 30\text{d}\}$.

#### 1. Platform Market Share
$$N(\text{OS}_k) = \sum_{d \in \mathcal{D}} \mathbb{I}(d.\text{osName} = \text{OS}_k)$$
$$P(\text{OS}_k) = \left( \frac{N(\text{OS}_k)}{N} \right) \times 100\%$$

#### 2. Ranked Frequency Distributions
$$\text{TopBrands} = \operatorname{argTop}_{10} \left( \sum_{d \in \mathcal{D}} \mathbb{I}(d.\text{deviceBrand} = B) \right)$$
$$\text{TopModels} = \operatorname{argTop}_{10} \left( \sum_{d \in \mathcal{D}} \mathbb{I}(d.\text{deviceModel} = M) \right)$$

#### 3. Hardware Compromise Risk Index
$$S_{\text{risk}} = \frac{\sum_{d \in \mathcal{D}} \mathbb{I}(d.\text{isRootedOrJailbroken}) + 0.5 \sum_{d \in \mathcal{D}} \mathbb{I}(d.\text{isEmulator})}{N}$$

---

## Algorithm 6: User Behavioral Intelligence, Interaction Hierarchy Scoring & Feed Instruction Synthesis

### 6.1 Objective
Transform interaction telemetry (product views, cart additions, cart removals, dwell times, purchases) into normalized category affinity weights and feed instruction overrides. Synchronize computed vectors with the Main Backend (`POST /api/v1/internal/user-analysis/sync`).

### 6.2 Mathematical Model & Interaction Hierarchy

For any user $u$ and category $c$, interaction events carry hierarchical weights reflecting purchase intent:

$$\mathcal{W}_{\text{event}} = \begin{cases}
+25 & \text{Purchase} \\
+15 & \text{Cart Addition} \\
+10 & \text{Accessory Interaction} \\
+3  & \text{Product View} \\
-10 & \text{Cart Removal}
\end{cases}$$

Raw category affinity score:
$$S_{\text{raw}}(u, c) = \sum_{e \in \mathcal{E}(u, c)} \mathcal{W}_{\text{event}}(e)$$

Normalized category affinity weight $\mathcal{A}_{\text{norm}}(u, c) \in [0, 100]$:
$$\mathcal{A}_{\text{norm}}(u, c) = \min\left(100, \, \max\left(0, \, \left\lfloor \frac{S_{\text{raw}}(u, c)}{\max_{k} S_{\text{raw}}(u, k)} \times 100 \right\rfloor\right)\right)$$

### 6.3 Behavioral User Segmentation Logic
1. **`frequent_shopper`**: $\sum \mathbb{I}(\text{purchase}) \ge 3$
2. **`high_intent_hesitant`**: $\sum \mathbb{I}(\text{cart\_add}) \ge 2 \land \sum \mathbb{I}(\text{purchase}) = 0$
3. **`active_browser`**: $\sum \mathbb{I}(\text{view}) \ge 15 \land \sum \mathbb{I}(\text{cart\_add}) = 0$
4. **`power_user`**: $|\mathcal{E}(u)| \ge 30$

### 6.4 Synthesis of Sub-Backend Feed Instructions
- **$\mathcal{C}_{\text{boost}}$**: Top 3 categories where $\mathcal{A}_{\text{norm}}(u, c) \ge 40$.
- **$\mathcal{C}_{\text{suppress}}$**: Categories where $S_{\text{raw}}(u, c) < 0$ (cart removals exceeding interest).
- **Custom Weights**:
  - `academicAlignmentBonus`: $25.0$
  - `cartDwellBonus`: $30.0$
  - `popularityWeight`: $10.0$



---

## Algorithm 7: Partner Crisis Gate & 2.5 km Concentric Ring Delay Partitioning Engine

### 7.1 Objective
Ensure order fulfillment reliability by enforcing an online partner crisis gate (at least 2 online partners required per order in the zone) and partitioning the 2.5 km dispatch radius into 4 concentric distance bands. Partners closer to the user receive order notifications earlier, providing proximity priority while ensuring full coverage during order rushes.

### 7.2 Mathematical Formulation & Crisis Gate

#### 1. Partner Availability & Crisis Gate Check
Let $\mathcal{P}_{\text{online}}$ be the set of active delivery partners where:
$$\mathcal{P}_{\text{active}} = \{ p \in \mathcal{P} \mid p.\text{isOnline} = \text{True} \land p.\text{isBlocked} = \text{False} \land p.\text{activeOrderId} = \text{None} \}$$

For user order location $U = (\phi_U, \lambda_U)$ and maximum dispatch radius $R_{\text{dispatch}} = 2500\text{ meters}$ (2.5 km):
$$\mathcal{P}_{\text{candidate}} = \{ p \in \mathcal{P}_{\text{active}} \mid d(U, \, p.\mathbf{x}) \le R_{\text{dispatch}} \}$$

$$\operatorname{CrisisGate}(\mathcal{P}_{\text{candidate}}) = \begin{cases}
\text{PERMIT} & \text{if } |\mathcal{P}_{\text{candidate}}| \ge 2 \\
\text{REJECT (HTTP 503)} & \text{if } |\mathcal{P}_{\text{candidate}}| < 2
\end{cases}$$

#### 2. 2.5 km Concentric Ring Delay Partitioning
The circular dispatch zone $\mathcal{Z}(U, 2.5\text{km})$ is partitioned into 4 concentric distance boxes:

$$\mathcal{B}_1 = \{ p \in \mathcal{P}_{\text{candidate}} \mid 0 \le d(U, p.\mathbf{x}) \le 500\text{ m} \} \implies \Delta t_{\text{delay}} = 0\text{ s (Immediate)}$$
$$\mathcal{B}_2 = \{ p \in \mathcal{P}_{\text{candidate}} \mid 500 < d(U, p.\mathbf{x}) \le 1000\text{ m} \} \implies \Delta t_{\text{delay}} = 5\text{ s}$$
$$\mathcal{B}_3 = \{ p \in \mathcal{P}_{\text{candidate}} \mid 1000 < d(U, p.\mathbf{x}) \le 1750\text{ m} \} \implies \Delta t_{\text{delay}} = 10\text{ s}$$
$$\mathcal{B}_4 = \{ p \in \mathcal{P}_{\text{candidate}} \mid 1750 < d(U, p.\mathbf{x}) \le 2500\text{ m} \} \implies \Delta t_{\text{delay}} = 15\text{ s}$$

#### 3. Atomic First-Pick Order Claim (Concurrency Protection)
To prevent race conditions when multiple partners tap "Accept Order" concurrently:
$$\text{ClaimOrder}(O, p) = \operatorname{atomic\_swap}\big( O.\text{status} == \text{'SEARCHING\_PARTNER'} \land O.\text{assignedPartnerId} == \text{None} \implies O.\text{status} \leftarrow \text{'PAYMENT\_PENDING'}, \, O.\text{assignedPartnerId} \leftarrow p.\text{id} \big)$$

---

## Algorithm 8: 1-Minute Payment Selection Expiration & 30-Paisa Cancellation Surcharge Engine

### 8.1 Objective
Enforce rapid order commitment by granting the user exactly 60 seconds (1 minute) to select their payment mode (`ONLINE` or `OFFLINE`). If unpaid or expired, apply cancellation tracking: grant 1 initial cancellation as mercy, and apply a 30 paisa (+₹0.30) penalty surcharge on all subsequent orders.

### 8.2 Mathematical Formulation & Surcharge Rules

Let $C_u$ be the user's historical count of unpaid/timeout order cancellations.

$$\tau_{\text{deadline}} = \tau_{\text{partner\_accepted}} + 60\text{ seconds}$$

#### Expiration Evaluation:
$$\text{Status}(O) = \begin{cases}
\text{'CANCELLED\_PAYMENT\_TIMEOUT'} & \text{if } \tau_{\text{now}} > \tau_{\text{deadline}} \land O.\text{paymentMode} = \text{None} \\
\text{'PROCEED'} & \text{otherwise}
\end{cases}$$

Upon timeout cancellation:
$$C_u \leftarrow C_u + 1$$

#### Pricing & Billing Surcharge Calculation:
For any subsequent order placed by user $u$:
$$\mathcal{S}_{\text{cancellation}}(u) = \begin{cases}
0.00 & \text{if } C_u \le 1 \quad (\text{1st Cancellation Mercy}) \\
0.30 & \text{if } C_u \ge 2 \quad (\text{30 Paisa Penalty Surcharge})
\end{cases}$$

$$\text{OrderTotal} = \text{Subtotal} + \text{DeliveryFee} + \mathcal{S}_{\text{cancellation}}(u)$$
$$\text{Subject to: } \text{Subtotal} \ge 30.00\text{ INR}$$

---

## Algorithm 9: Mode-Specific Travel ETA (Cycle vs Walk) & One-Time Mercy Extension Algorithm

### 9.1 Objective
Model partner transit physics according to transport mode (`cycle` vs `walk`), compute realistic travel ETAs with buffer, and provide a one-time mercy extension if delayed, penalizing partner reputation only on repeated unexcused delays.

### 9.2 Velocity Profiles & Initial ETA Formulation
$$v_{\text{mode}} = \begin{cases}
4.167\text{ m/s} \quad (15.0\text{ km/h}) & \text{if mode} = \text{'cycle'} \\
1.250\text{ m/s} \quad (4.5\text{ km/h}) & \text{if mode} = \text{'walk'}
\end{cases}$$

$$\text{ETA}_{\text{seconds}} = \left\lfloor \frac{d(P_{\text{partner}}, P_{\text{user}})}{v_{\text{mode}}} \right\rfloor + T_{\text{buffer}} \quad (T_{\text{buffer}} = 180\text{ s})$$
$$t_{\text{expires}} = t_{\text{start}} + \text{ETA}_{\text{seconds}}$$

### 9.3 One-Time Mercy Extension & Reputation Penalty
If partner fails to reach arrival perimeter ($d \le 50\text{ m}$) before $t_{\text{expires}}$:

$$\operatorname{HandleDelay}(p, O) = \begin{cases}
\text{Grant Mercy Extension: } \Delta t_{\text{ext}} = \left\lfloor \frac{d_{\text{remaining}}}{v_{\text{mode}}} \right\rfloor + 120\text{s}, \quad O.\text{mercyUsed} \leftarrow \text{True} & \text{if } \neg O.\text{mercyUsed} \\
\text{Penalize Partner: } p.\text{reputationScore} \leftarrow \max(0, p.\text{reputationScore} - 5) & \text{if } O.\text{mercyUsed} \equiv \text{True}
\end{cases}$$

---

## Algorithm 10: 5:1 Online-to-Offline Partner Payment Fairness Balancer

### 10.1 Objective
Prevent delivery partners from being overwhelmed with cash collection risks and cash-handling disputes by maintaining a strict **5:1 ratio of online to offline orders**.

### 10.2 Mathematical Model
Let:
- $N_{\text{online}}(p)$: Number of completed online payment deliveries.
- $N_{\text{offline}}(p)$: Number of completed offline cash deliveries.

The maximum allowed offline orders for partner $p$ is governed by:
$$\operatorname{MaxOfflineAllowed}(p) = \left\lfloor \frac{N_{\text{online}}(p)}{5} \right\rfloor + 1$$

$$\operatorname{IsEligibleForOffline}(p) = \begin{cases}
\text{True} & \text{if } N_{\text{offline}}(p) < \operatorname{MaxOfflineAllowed}(p) \\
\text{False} & \text{otherwise}
\end{cases}$$

If user selects `OFFLINE` and the partner is ineligible, the partner must complete $(N_{\text{offline}} + 1) \times 5 - N_{\text{online}}$ more online orders to rebalance their ratio.

---

## Algorithm 11: Dual-Phase OTP Handshake & Virtual Wallet Ledger Settlement

### 11.1 Objective
Guarantee cash collection safety and proof-of-delivery through a cryptographically random two-phase 6-digit OTP verification protocol paired with virtual ledger separation from gateway payments.

### 11.2 Mathematical Formulation & State Machine

```
[ OFFLINE Order Initiated ]
            |
            v
[ Phase 1: Cash Collection ]
  Partner reaches user (d <= 50m)
  -> User Phone Rings (WS)
  -> OTP_cash in [100000, 999999] emailed to user
  -> Partner collects physical cash & submits OTP_cash
  -> Verify(OTP_cash) == True
  -> Order transitions to CASH_COLLECTED
            |
            v
[ Partner Picks Up Product from Vendor/Hub ]
            |
            v
[ Phase 2: Final Delivery ]
  Partner reaches user delivery location (d <= 50m)
  -> User Phone Rings (WS)
  -> OTP_deliv in [100000, 999999] emailed to user
  -> Partner delivers product & submits OTP_deliv
  -> Verify(OTP_deliv) == True
  -> Order transitions to DELIVERED
            |
            v
[ Virtual Wallet Credit ]
  Real Money: Resides in Razorpay Merchant Account
  Partner Virtual Balance: W_v(p) <- W_v(p) + Fee_delivery
```
