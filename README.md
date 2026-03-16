<p align="center">
  <img src="admin/reolink-loxone.svg" width="120" alt="ioBroker.reolink-loxone"/>
</p>

<h1 align="center">ioBroker.reolink-loxone</h1>

<p align="center">
  Complete Reolink camera integration for ioBroker with native Loxone Miniserver bridge
</p>

<p align="center">
  <a href="https://github.com/KPIotr89/ioBroker.reolink-loxone/releases"><img src="https://img.shields.io/github/v/release/KPIotr89/ioBroker.reolink-loxone?style=flat-square&color=0071e3" alt="Release"/></a>
  <a href="https://github.com/KPIotr89/ioBroker.reolink-loxone/blob/main/LICENSE"><img src="https://img.shields.io/github/license/KPIotr89/ioBroker.reolink-loxone?style=flat-square&color=34c759" alt="License"/></a>
  <img src="https://img.shields.io/node/v/iobroker.reolink-loxone?style=flat-square&color=ff9500" alt="Node.js"/>
  <a href="https://github.com/KPIotr89/ioBroker.reolink-loxone/actions"><img src="https://img.shields.io/github/actions/workflow/status/KPIotr89/ioBroker.reolink-loxone/test-and-release.yml?style=flat-square&label=CI" alt="CI"/></a>
</p>

<br/>

---

## What it does

Connect every Reolink camera in your home to ioBroker and Loxone — without cloud, without Node-RED, without compromise. The adapter talks directly to the camera's local HTTP API, exposes all states in ioBroker's object tree, and forwards events to your Loxone Miniserver in real time.

<br/>

## Highlights

**📷 Full camera control**
Motion detection · AI detection (person, vehicle, animal, face) · White LED spotlight · IR lights · PTZ · Siren · Snapshots · Image settings

**🏠 Native Loxone integration**
Events arrive at Loxone Virtual Inputs via HTTP or UDP — the same second they happen. No intermediary, no polling on the Loxone side.

**🔔 Doorbell & visitor detection**
Reolink push webhooks deliver doorbell button presses instantly. No polling. Works exactly like a real doorbell.

**🚪 Gate trigger**
Brief spotlight flash from the Reolink app (≤ 3 s ON → OFF) detected by the adapter and forwarded to Loxone as a gate open command.

**🔌 Webhook push receiver**
Built-in HTTP server receives push alerts from cameras. The adapter auto-configures each camera's push URL on startup.

**📡 ONVIF event subscription**
Per-camera ONVIF PullPoint subscription delivers motion, person, vehicle, animal and face events without polling the Reolink API. Frees CPU and reduces latency to under 2 s.

**🔍 Auto-discovery**
One click in the admin panel probes the local network via ONVIF WS-Discovery UDP multicast and confirms every Reolink device it finds. Returns model, firmware version and serial — ready to paste into the camera list.

**🎥 Loxone Intercom**
When a doorbell button is pressed the adapter sends the camera's RTSP stream URL to a Loxone Virtual Input. Loxone Touch panels can display the live feed automatically.

**⚡ Multi-camera**
Manage 20+ cameras from a single adapter instance.

<br/>

---

## Supported cameras

Works with any Reolink camera or NVR that exposes the local HTTP API.

| Series | Models |
|--------|--------|
| PoE Bullet / Dome | RLC-810A, RLC-820A, RLC-811A, RLC-1212A, RLC-510A, RLC-410 |
| PoE PTZ | RLC-823A, RLC-823S, RLC-833A |
| Wi-Fi | E1, E1 Zoom, E1 Pro, E1 Outdoor, Argus 3 Pro, Argus PT |
| Dual-lens | Duo 2 PoE, Duo 3, TrackMix PoE, TrackMix Wi-Fi |
| Doorbell | Video Doorbell PoE, Video Doorbell Wi-Fi |
| NVR | RLN8-410, RLN16-410, RLN36 (each channel independently) |
| ColorX | CX410, CX810, CX820 |

<br/>

---

## Installation

```bash
cd /opt/iobroker
iobroker url https://github.com/KPIotr89/ioBroker.reolink-loxone
```

<br/>

---

## Configuration

### Cameras

Add each camera in the **Cameras** tab. One row per camera or NVR channel.

| Field | Default | Description |
|-------|---------|-------------|
| Enabled | ✓ | Include this camera in polling |
| Name | — | Friendly name, used in state tree and Loxone VI names |
| IP / Host | — | Camera IP address or hostname |
| Port | 80 | HTTP port (443 for HTTPS) |
| Username | admin | Camera login |
| Password | — | Camera password |
| Channel | 0 | 0 for standalone cameras; 0–15 for NVR channels |
| HTTPS | off | Enable TLS |
| Poll (s) | 5 | Status polling interval |
| Gate trigger | off | Enable WhiteLed flash → gate open signal |
| ONVIF events | off | Use ONVIF PullPoint instead of API polling for motion/AI events |

> **Required for WhiteLed control:** the camera user account must have admin-level permissions. Guest accounts cannot control the spotlight.

<br/>

### Loxone

Configure the Miniserver connection in the **Loxone** tab.

| Field | Description |
|-------|-------------|
| Enable | Activate the Loxone bridge |
| Miniserver IP | IP address of your Loxone Miniserver |
| HTTP Port | Usually 80 |
| Username / Password | A Loxone user with Virtual Input write access |
| Mode | HTTP Virtual Inputs · UDP · Both |
| UDP Port | Target UDP port (default 7000) |

#### Virtual Input naming

Create these Virtual Inputs in Loxone Config to receive events:

```
Reolink_{CameraName}_Motion       →  motion detected (0 / 1)
Reolink_{CameraName}_AI_person    →  person detected (0 / 1)
Reolink_{CameraName}_AI_vehicle   →  vehicle detected (0 / 1)
Reolink_{CameraName}_AI_animal    →  animal detected (0 / 1)
Reolink_{CameraName}_Online       →  camera online (0 / 1)
Reolink_{CameraName}_Visitor      →  doorbell pressed (0 / 1)
Reolink_{CameraName}_gate_trigger →  gate trigger pulse (1)
Reolink_{CameraName}_Intercom     →  RTSP stream URL (text, on doorbell press)
```

Custom names can be changed per camera under the `loxone` channel in the ioBroker object tree.

#### Loxone Intercom

Enable **Loxone Intercom** in the Loxone tab. When a doorbell button is pressed the adapter sends the camera's main RTSP stream URL (`rtsp://user:pass@ip:554/h264Preview_01_main`) to the `Reolink_{CameraName}_Intercom` Virtual Input. Configure that VI as a "Text" type in Loxone Config and connect it to an Intercom or Camera block to display the live feed on Touch panels automatically.

<br/>

### Webhook

Enable the push receiver in the **Webhook** tab to receive doorbell and alarm events without polling.

| Field | Description |
|-------|-------------|
| Enable | Start the built-in HTTP server |
| Port | Port cameras will POST to (default 7777) |
| ioBroker IP | IP of the ioBroker machine — used to auto-configure cameras |

When both IP and port are set, the adapter calls `SetPushV20` on each camera at startup and configures the push URL automatically. If your firmware does not support `SetPushV20`, set the URL manually in the camera's web UI:

```
http://{ioBroker-IP}:7777/reolink/{CameraName}
```

<br/>

### Auto-discovery

Click the **🔍 Discover cameras** button in the Cameras tab. The adapter sends an ONVIF WS-Discovery UDP probe to `239.255.255.250:3702` and waits 3 seconds for responses. Every responding device is then verified via the Reolink HTTP API — non-Reolink ONVIF devices are silently ignored.

Results are shown in the admin panel as a table:

| IP | Port | Model | Firmware | Serial |
|----|------|-------|----------|--------|
| 192.168.0.51 | 80 | RLC-810A | v3.1.0.2368 | ... |

Copy the IP, port and any details you need directly into the camera list.

<br/>

### ONVIF event subscription

Enable the **ONVIF** checkbox for individual cameras. The adapter creates a WS-Eventing PullPoint subscription on startup:

1. `CreatePullPointSubscription` — opens a subscription with a 60 s TTL
2. `PullMessages` every 2 s — receives queued events immediately
3. `Renew` at 50 s — keeps the subscription alive indefinitely

When ONVIF events are active for a camera, API-based motion and AI polling is disabled for that camera. Events still update the same ioBroker states and trigger the same Loxone Virtual Inputs.

> **Note:** ONVIF requires the camera user to have ONVIF/admin rights. The same username and password from the Cameras tab are used.

<br/>

---

## State tree

```
reolink-loxone.0.
└── {camera_name}/
    ├── info/
    │   ├── connection          boolean   Camera reachable
    │   ├── model               string    Camera model
    │   ├── firmware            string    Firmware version
    │   └── serial              string    Serial number
    ├── status/
    │   ├── motionDetected      boolean   Motion active
    │   ├── personDetected      boolean   Person detected (AI)
    │   ├── vehicleDetected     boolean   Vehicle detected (AI)
    │   ├── animalDetected      boolean   Animal detected (AI)
    │   ├── faceDetected        boolean   Face detected (AI)
    │   ├── whiteLed            boolean   Spotlight state (live)
    │   ├── whiteLedTrigger     boolean   Gate trigger pulse
    │   ├── visitorDetected     boolean   Doorbell pressed
    │   ├── doorbellRing        boolean   Physical button state
    │   └── lastMotionTime      number    Last motion timestamp
    ├── control/              ← writable
    │   ├── snapshot            button    Capture snapshot
    │   ├── reboot              button    Reboot camera
    │   ├── irLights            string    Auto / On / Off
    │   ├── whiteLed            boolean   Spotlight on/off
    │   └── siren               button    Trigger alarm
    ├── ptz/                  ← writable (PTZ cameras only)
    │   ├── command             string    Left/Right/Up/Down/ZoomInc…
    │   ├── speed               number    1–64
    │   ├── goToPreset          number    Preset index
    │   ├── patrol              boolean   Start/stop patrol
    │   └── stop                button    Stop movement
    ├── streams/
    │   ├── rtspMain            string    RTSP main stream URL
    │   ├── rtspSub             string    RTSP sub stream URL
    │   ├── rtmpMain            string    RTMP stream URL
    │   └── snapshotUrl         string    Snapshot endpoint URL
    ├── image/                ← writable
    │   ├── brightness          number    0–255
    │   ├── contrast            number    0–255
    │   ├── saturation          number    0–255
    │   └── sharpness           number    0–255
    ├── snapshot/
    │   ├── image               string    Last snapshot (base64)
    │   ├── timestamp           number    Capture time
    │   └── file                string    Saved file path
    ├── storage/
    │   ├── hddCapacity         number    Total SD/HDD capacity (MB)
    │   └── hddUsed             number    Used space (MB)
    └── loxone/               ← writable (when Loxone enabled)
        ├── motionInputName     string    Custom VI name for motion
        ├── personInputName     string    Custom VI name for person
        ├── vehicleInputName    string    Custom VI name for vehicle
        ├── onlineInputName     string    Custom VI name for status
        └── visitorInputName    string    Custom VI name for doorbell
```

<br/>

---

## How events flow

```
Reolink Camera
│
├─ HTTP API polling (motion, AI, WhiteLed)
│         │
│         ▼
│   ioBroker Adapter  ──────────────────────► ioBroker state tree
│         │                                   (scripts, VIS, Grafana)
│         │
│         ▼
│   Loxone Bridge
│         │
│         ├─ HTTP ──► Loxone Virtual Input
│         └─ UDP  ──► Loxone UDP Monitor
│
├─ Push webhook (doorbell, visitor)
│         │
│         ▼
│   Built-in HTTP server :7777
│         │
│         ▼
│   ioBroker Adapter  ──────────────────────► Loxone Virtual Input
│
└─ Fast WhiteLed poll 1 s (gate trigger cameras)
          │
          ▼  ON → OFF  ≤ 3 s
    Gate trigger pulse ─────────────────────► Loxone gate_trigger
```

<br/>

---

## Automation examples

### JavaScript (ioBroker)

```javascript
// Turn on porch light when person detected
on('reolink-loxone.0.front_door.status.personDetected', obj => {
    if (obj.state.val) setState('hue.0.porch.on', true);
});

// Capture snapshot on motion
on('reolink-loxone.0.driveway.status.motionDetected', obj => {
    if (obj.state.val) setState('reolink-loxone.0.driveway.control.snapshot', true);
});

// Rotate PTZ camera to entrance preset when doorbell rings
on('reolink-loxone.0.doorbell.status.visitorDetected', obj => {
    if (obj.state.val) setState('reolink-loxone.0.garden.ptz.goToPreset', 2);
});
```

### Loxone Config

| Trigger | Action |
|---------|--------|
| `Reolink_FrontDoor_AI_person = 1` | Switch on entrance light |
| `Reolink_Garage_Motion = 1` AND alarm armed | Trigger alarm zone |
| `Reolink_Driveway_gate_trigger = 1` | Open gate |
| `Reolink_Doorbell_Visitor = 1` | Play doorbell chime |

<br/>

---

## Troubleshooting

**Camera not connecting**
Verify the IP is reachable (`ping`), the HTTP API is enabled on the camera (default: yes), and credentials are correct. Some firmware versions require HTTPS.

**WhiteLed control returns "ability error"**
The camera user account is set to Guest level. Change it to Admin in the camera settings under Device Settings → User Management.

**Motion detection not updating**
Confirm motion detection is enabled in the Reolink app or web UI. AI detection (person/vehicle) requires cameras with an "A" suffix in the model name (e.g., RLC-810A).

**Doorbell push not received**
Check that the webhook port (7777) is accessible from the camera's network. Verify in the adapter log that the push URL was configured successfully. If auto-config failed, set the URL manually in the camera web UI under Alarm → Push.

**Loxone Virtual Input not updating**
Virtual Input names are case-sensitive. Make sure the name in Loxone Config matches exactly. Verify the Loxone user has write access.

**Gate trigger not firing**
Enable the "Gate trigger" checkbox for that camera in adapter settings. The camera user must have admin permissions for WhiteLed control.

<br/>

---

## API coverage

| Category | Commands |
|----------|----------|
| Auth | Login, Logout, token renewal |
| Device | GetDevInfo, GetAbility, GetHddInfo, Reboot |
| Network | GetLocalLink, GetWifi, GetDdns, GetNtp, GetP2p, GetNetPort |
| Video | GetEnc, SetEnc, GetIsp, SetIsp |
| Streams | RTSP main/sub/ext, RTMP, FLV, Snap |
| Motion | GetMdState, GetAlarm, SetAlarm |
| AI | GetAiState, GetAiCfg, SetAiCfg |
| PTZ | PtzCtrl, GetPtzPreset, SetPtzPreset, GetPtzPatrol |
| LED | GetIrLights, SetIrLights, GetWhiteLed, SetWhiteLed |
| Siren | AudioAlarmPlay |
| Push | GetPushV20, SetPushV20 |
| Doorbell | GetDoorbell |
| Recording | GetRec, SetRec |
| OSD | GetOsd, SetOsd, GetMask |
| System | GetTime, SetTime, GetUser, GetOnline |

<br/>

---

## Development

```bash
git clone https://github.com/KPIotr89/ioBroker.reolink-loxone.git
cd ioBroker.reolink-loxone
npm install
npm run lint
npm test
```

<br/>

---

## License

MIT © [Piotr Kalbarczyk](https://github.com/KPIotr89)

---

<p align="center">
  Built for the ioBroker · Loxone · Reolink community
</p>
