# Role-Based Access Control (RBAC) Matrix

Home Automation implements strict role-based access control across all tiers of the architecture: the web dashboard, the REST and WebSocket gateway APIs, and the microcontroller firmware command verifier.

---

## 1. Role Capabilities Summary

| Role | Target User | UI View Access | Allowed Control Scope |
| :--- | :--- | :--- | :--- |
| **Owner** | Primary Administrator | Home, Energy, Vision, Hardware | Full system authority across all rooms, rules, security arming, safety reset, and hardware diagnostics. |
| **Family** | Resident / Family Member | Home, Energy, Vision | Daily comfort controls for lights, climate, and appliances across all rooms. Cannot alter safety trips, security arming, or run hardware diagnostics. |
| **Guest** | Visitor / Temporary User | Home Only (Filtered) | Limited to the living room lights and television. Cannot view other rooms, cannot see camera clips, cannot inspect audit logs, and cannot alter rules. |

---

## 2. Web Dashboard Views

| Dashboard Tab | Owner | Family | Guest | Description |
| :--- | :--- | :--- | :--- | :--- |
| `Home Command Center` | Full View | Full View | Living Room Only | Live telemetry tiles, quick scene triggers, and individual room appliance cards. |
| `Energy & Automation` | Full View | Full View | Hidden | SQLite consumption charts, device rankings, and rule policy toggles. |
| `Vision & Security` | Full View | Full View | Hidden | Browser-local camera motion monitor, consent-gated clip review, and Away mode alerts. |
| `Hardware & Flash Lab` | Full View | Hidden | Hidden | SPI flash audit records, memory ring inspection, CAN diagnostics, and simulation controls. |

---

## 3. Gateway REST and WebSocket Endpoints

| Endpoint | Method | Owner | Family | Guest | Enforcement Logic |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `/api/snapshot` | GET | Full | Full (No Audit) | Filtered | Guest snapshot contains only Living Room appliances; audit, vision, and rule arrays are stripped. |
| `/api/telemetry` | GET | Allowed | Allowed | 403 Forbidden | Telemetry history is restricted to Family and Owner. |
| `/api/energy/daily` | GET | Allowed | Allowed | 403 Forbidden | Whole-home historical consumption is restricted to Family and Owner. |
| `/api/audit` | GET | Allowed | 403 Forbidden | 403 Forbidden | Access to the SPI flash and SQLite audit log is strictly restricted to Owner. |
| `/api/alerts` | GET | Allowed | Allowed | 403 Forbidden | System safety and overload alerts are hidden from Guest sessions. |
| `/api/rules` | GET | Allowed | Allowed | 403 Forbidden | Rule policies can only be viewed by Family and Owner. |
| `/api/rules/toggle` | POST | Allowed | Allowed | 403 Forbidden | Rule enabling and threshold adjustments are restricted to Family and Owner. |
| `/api/vision/events` | GET | Allowed | Allowed | 403 Forbidden | Security motion events and timestamps are hidden from Guest sessions. |
| `/api/vision/event` | POST | Allowed | Allowed | 403 Forbidden | Only authorized resident sessions can record detected visual motion events. |
| `/api/vision/prune` | POST | Allowed | Allowed | 403 Forbidden | Clearing or purging vision event history is restricted to Family and Owner. |
| `/api/cmd` | POST | Filtered | Filtered | Filtered | Enforces role-based command whitelist before signing and dispatching. |

---

## 4. Appliance Control Permissions

| Appliance ID | Room Location | Owner | Family | Guest |
| :--- | :--- | :--- | :--- | :--- |
| `light_hub` | Living Room | Allowed | Allowed | Allowed |
| `lamp_living` | Living Room | Allowed | Allowed | Allowed |
| `plug_tv` | Living Room | Allowed | Allowed | Allowed |
| `ac_living` | Bedroom | Allowed | Allowed | Denied |
| `fan_bed` | Bedroom | Allowed | Allowed | Denied |
| `lamp_bed` | Bedroom | Allowed | Allowed | Denied |
| `fridge` | Kitchen | Allowed | Allowed | Denied |
| `plug_kettle` | Kitchen | Allowed | Allowed | Denied |
| `pad_tx` | Office | Allowed | Allowed | Denied |
| `plug_desk` | Office | Allowed | Allowed | Denied |

---

## 5. Microcontroller Firmware Command Permissions

| Command | Owner | Family | Guest | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `emergency` | Allowed | Allowed | Allowed | Safety critical: anyone in the house can hit Emergency Stop. |
| `privacy:on` | Allowed | Allowed | Allowed | Privacy critical: anyone in the house can immediately kill camera tracking. |
| `privacy:off` | Allowed | Allowed | Denied | Only permanent residents can restore camera tracking. |
| `light` | Allowed | Allowed | Allowed | Living room RGB PWM brightness control. |
| `rgb` | Allowed | Allowed | Allowed | Living room RGB PWM color selection. |
| `fan` | Allowed | Allowed | Denied | Bedroom ceiling fan speed control. |
| `ac` | Allowed | Allowed | Denied | Bedroom climate control. |
| `eco` | Allowed | Allowed | Denied | Energy saving profile toggle. |
| `night` | Allowed | Allowed | Denied | Night mode scene trigger. |
| `all_off` | Allowed | Allowed | Denied | Master house-wide shutdown. |
| `away_arm` | Allowed | Denied | Denied | Perimeter security arming. |
| `away_disarm`| Allowed | Denied | Denied | Perimeter security disarming. |
| `safety_clear`| Allowed | Denied | Denied | Reset of latched hardware safety trips. |
| `vacancy` | Allowed | Denied | Denied | Occupancy sensor timing configuration. |
| `audit_dump` | Allowed | Denied | Denied | SPI flash audit trail streaming. |
| `backfill_sync`| Allowed | Denied | Denied | Offline telemetry synchronization. |
| `can_diag` | Allowed | Denied | Denied | CAN transceiver hardware loopback test. |
| `flash_id` | Allowed | Denied | Denied | External SPI flash JEDEC ID query. |
| `ping` | Allowed | Denied | Denied | Microcontroller diagnostic ping. |
