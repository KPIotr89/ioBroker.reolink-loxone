'use strict';

const utils = require('@iobroker/adapter-core');
const ReolinkAPI = require('./lib/reolink-api');
const LoxoneBridge = require('./lib/loxone-bridge');
const fs = require('fs');
const path = require('path');

/**
 * ioBroker.reolink-loxone - Full Reolink camera integration for ioBroker + Loxone
 * Supports up to 20+ cameras with complete API coverage.
 */
class ReolinkLoxoneAdapter extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'reolink-loxone' });

        /** @type {Map<string, ReolinkAPI>} */
        this.cameras = new Map();

        /** @type {LoxoneBridge|null} */
        this.loxoneBridge = null;

        /** @type {Map<string, NodeJS.Timeout>} */
        this.pollingTimers = new Map();

        /** @type {Map<string, object>} */
        this.lastStates = new Map();

        /** @type {Map<string, object>} Camera capabilities from GetAbility */
        this.capabilities = new Map();

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ─── LIFECYCLE ────────────────────────────────────────────────────

    async onReady() {
        this.log.info('Starting Reolink-Loxone adapter...');

        // Initialize Loxone bridge if configured
        if (this.config.loxoneEnabled && this.config.loxoneHost) {
            this.loxoneBridge = new LoxoneBridge({
                host: this.config.loxoneHost,
                port: this.config.loxonePort || 80,
                username: this.config.loxoneUser || '',
                password: this.config.loxonePassword || '',
                udpPort: this.config.loxoneUdpPort || 7000,
                mode: this.config.loxoneMode || 'http',
                log: this.log,
            });
            this.log.info(`Loxone bridge initialized: ${this.config.loxoneHost} (mode: ${this.config.loxoneMode})`);
        }

        // Initialize cameras
        const cameras = this.config.cameras || [];
        if (cameras.length === 0) {
            this.log.warn('No cameras configured. Please add cameras in the adapter settings.');
            return;
        }

        this.log.info(`Initializing ${cameras.length} camera(s)...`);

        for (const camConfig of cameras) {
            if (!camConfig.enabled) continue;
            await this.initCamera(camConfig);
        }

        // Subscribe to all control states
        this.subscribeStates('*');
    }

    async onUnload(callback) {
        try {
            // Stop all polling
            for (const [id, timer] of this.pollingTimers) {
                clearInterval(timer);
                this.log.debug(`Stopped polling for ${id}`);
            }
            this.pollingTimers.clear();

            // Logout from all cameras
            for (const [id, api] of this.cameras) {
                try {
                    await api.logout();
                    this.log.debug(`Logged out from camera ${id}`);
                } catch (e) {
                    this.log.debug(`Logout error for ${id}: ${e.message}`);
                }
            }
            this.cameras.clear();

            // Destroy Loxone bridge
            if (this.loxoneBridge) {
                this.loxoneBridge.destroy();
            }

            callback();
        } catch (e) {
            callback();
        }
    }

    // ─── CAMERA INITIALIZATION ────────────────────────────────────────

    async initCamera(camConfig) {
        const camId = this.sanitizeId(camConfig.name || `cam_${camConfig.host}`);
        this.log.info(`Initializing camera "${camId}" at ${camConfig.host}...`);

        const api = new ReolinkAPI({
            host: camConfig.host,
            port: camConfig.port || (camConfig.useHttps ? 443 : 80),
            username: camConfig.username,
            password: camConfig.password,
            channel: camConfig.channel || 0,
            useHttps: camConfig.useHttps || false,
            log: this.log,
        });

        try {
            await api.login();
            this.cameras.set(camId, api);

            // Get device info
            const devInfo = await api.getDevInfo();
            this.log.info(`Connected to ${devInfo.DevInfo?.model || 'Reolink'} (${devInfo.DevInfo?.name || camId}) FW: ${devInfo.DevInfo?.firmVer || 'unknown'}`);

            // Get camera capabilities to know which features are supported
            await this.detectCapabilities(camId, api);

            // Create object tree for this camera
            await this.createCameraObjects(camId, camConfig, devInfo);

            // Initial status fetch
            await this.updateCameraStatus(camId, api, camConfig);

            // Start polling
            const pollInterval = (camConfig.pollInterval || this.config.defaultPollInterval || 5) * 1000;
            const timer = setInterval(async () => {
                await this.updateCameraStatus(camId, api, camConfig);
            }, pollInterval);
            this.pollingTimers.set(camId, timer);

            this.log.info(`Camera "${camId}" ready. Polling every ${pollInterval / 1000}s`);
        } catch (err) {
            this.log.error(`Failed to initialize camera "${camId}": ${err.message}`);
            await this.setStateAsync(`${camId}.info.connection`, false, true);
        }
    }

    // ─── CAPABILITY DETECTION ─────────────────────────────────────────

    /**
     * Detect camera capabilities via GetAbility API
     * This prevents sending unsupported commands (e.g. WhiteLed on CX810/CX820)
     */
    async detectCapabilities(camId, api) {
        // Default: assume most features are available.
        // SetWhiteLed on CX-series cameras requires direct auth + full payload —
        // GetWhiteLed/GetAbility may report "ability error" even though the hardware
        // supports it. We therefore default whiteLed=true and catch errors at runtime.
        const caps = {
            ptz: false,
            whiteLed: true,   // assume ON — SetWhiteLed works via direct auth
            siren: true,      // assume ON — try at runtime, catch if unsupported
            aiDetection: false,
            motionDetection: true,
            irLights: true,
            recording: true,
            snapshot: true,
        };

        try {
            const ability = await api.getAbility();
            const ab = ability?.Ability || ability || {};

            // PTZ support
            if (ab.ptz && ab.ptz.ver > 0) caps.ptz = true;
            if (ab.ptzCtrl && ab.ptzCtrl.ver > 0) caps.ptz = true;

            // AI detection
            if (ab.aiTrack && ab.aiTrack.ver > 0) caps.aiDetection = true;
            if (ab.ai && ab.ai.ver > 0) caps.aiDetection = true;

            // Only disable whiteLed/siren if GetAbility explicitly reports ver=0
            if (ab.whiteLed && ab.whiteLed.ver === 0) caps.whiteLed = false;
            if (ab.audioAlarm && ab.audioAlarm.ver === 0) caps.siren = false;

            this.log.info(`Camera "${camId}" capabilities: PTZ=${caps.ptz}, WhiteLED=${caps.whiteLed}, Siren=${caps.siren}, AI=${caps.aiDetection}`);
        } catch (e) {
            // GetAbility not available — probe PTZ and AI, keep whiteLed/siren defaults
            this.log.debug(`GetAbility unavailable for "${camId}", probing PTZ/AI: ${e.message}`);
            try { await api.getPtzPresets(); caps.ptz = true; } catch (_) { /* not supported */ }
            try { await api.getAiState(); caps.aiDetection = true; } catch (_) { /* not supported */ }

            this.log.info(`Camera "${camId}" capabilities (probed): PTZ=${caps.ptz}, WhiteLED=${caps.whiteLed}, Siren=${caps.siren}, AI=${caps.aiDetection}`);
        }

        this.capabilities.set(camId, caps);
    }

    /**
     * Check if a camera supports a given capability
     */
    hasCapability(camId, capability) {
        const caps = this.capabilities.get(camId);
        return caps ? !!caps[capability] : false;
    }

    // ─── OBJECT CREATION ──────────────────────────────────────────────

    async createCameraObjects(camId, camConfig, devInfo) {
        const info = devInfo?.DevInfo || {};

        // Camera root device
        await this.setObjectNotExistsAsync(camId, {
            type: 'device',
            common: { name: camConfig.name || camId },
            native: { host: camConfig.host },
        });

        // ── Info channel
        await this.createChannel(camId, 'info', 'Device Information');
        await this.createStateObj(camId, 'info.connection', 'Connection status', 'boolean', 'indicator.connected', false, false);
        await this.createStateObj(camId, 'info.model', 'Camera model', 'string', 'info.name', '', false);
        await this.createStateObj(camId, 'info.name', 'Camera name', 'string', 'info.name', '', false);
        await this.createStateObj(camId, 'info.firmware', 'Firmware version', 'string', 'info.firmware', '', false);
        await this.createStateObj(camId, 'info.serial', 'Serial number', 'string', 'info.serial', '', false);
        await this.createStateObj(camId, 'info.hardwareVersion', 'Hardware version', 'string', 'info.hardware', '', false);
        await this.createStateObj(camId, 'info.channelCount', 'Number of channels', 'number', 'value', 0, false);

        // Set known info
        await this.setStateAsync(`${camId}.info.model`, info.model || '', true);
        await this.setStateAsync(`${camId}.info.name`, info.name || '', true);
        await this.setStateAsync(`${camId}.info.firmware`, info.firmVer || '', true);
        await this.setStateAsync(`${camId}.info.serial`, info.serial || '', true);
        await this.setStateAsync(`${camId}.info.hardwareVersion`, info.hardVer || '', true);
        await this.setStateAsync(`${camId}.info.channelCount`, info.channelNum || 1, true);

        // ── Status channel
        await this.createChannel(camId, 'status', 'Camera Status');
        await this.createStateObj(camId, 'status.motionDetected', 'Motion detected', 'boolean', 'sensor.motion', false, false);
        await this.createStateObj(camId, 'status.personDetected', 'Person detected (AI)', 'boolean', 'sensor.motion', false, false);
        await this.createStateObj(camId, 'status.vehicleDetected', 'Vehicle detected (AI)', 'boolean', 'sensor.motion', false, false);
        await this.createStateObj(camId, 'status.animalDetected', 'Animal detected (AI)', 'boolean', 'sensor.motion', false, false);
        await this.createStateObj(camId, 'status.faceDetected', 'Face detected (AI)', 'boolean', 'sensor.motion', false, false);
        await this.createStateObj(camId, 'status.lastMotionTime', 'Last motion timestamp', 'number', 'date', 0, false);

        // ── Streams channel
        await this.createChannel(camId, 'streams', 'Video Streams');
        await this.createStateObj(camId, 'streams.rtspMain', 'RTSP Main stream URL', 'string', 'url', '', false);
        await this.createStateObj(camId, 'streams.rtspSub', 'RTSP Sub stream URL', 'string', 'url', '', false);
        await this.createStateObj(camId, 'streams.rtmpMain', 'RTMP Main stream URL', 'string', 'url', '', false);
        await this.createStateObj(camId, 'streams.flvMain', 'FLV Main stream URL', 'string', 'url', '', false);
        await this.createStateObj(camId, 'streams.snapshotUrl', 'Snapshot URL', 'string', 'url', '', false);

        // Generate stream URLs
        const api = this.cameras.get(camId);
        if (api) {
            await this.setStateAsync(`${camId}.streams.rtspMain`, api.getRtspUrl(camConfig.channel, 'main'), true);
            await this.setStateAsync(`${camId}.streams.rtspSub`, api.getRtspUrl(camConfig.channel, 'sub'), true);
            await this.setStateAsync(`${camId}.streams.rtmpMain`, api.getRtmpUrl(camConfig.channel, 'main'), true);
            await this.setStateAsync(`${camId}.streams.flvMain`, api.getFlvUrl(camConfig.channel, 'main'), true);
            await this.setStateAsync(`${camId}.streams.snapshotUrl`, `${api.baseUrl}/cgi-bin/api.cgi?cmd=Snap&channel=${camConfig.channel || 0}&user=${camConfig.username}&password=${camConfig.password}`, true);
        }

        // ── Control channel (writable)
        await this.createChannel(camId, 'control', 'Camera Control');
        await this.createStateObj(camId, 'control.snapshot', 'Trigger snapshot capture', 'boolean', 'button', false, true);
        await this.createStateObj(camId, 'control.reboot', 'Reboot camera', 'boolean', 'button', false, true);
        await this.createStateObj(camId, 'control.irLights', 'IR lights (Auto/On/Off)', 'string', 'switch', 'Auto', true, { states: { Auto: 'Auto', On: 'On', Off: 'Off' } });

        // Only create WhiteLed control if camera supports it
        if (this.hasCapability(camId, 'whiteLed')) {
            await this.createStateObj(camId, 'control.whiteLed', 'White LED / spotlight', 'boolean', 'switch', false, true);
        }

        // Only create siren control if camera supports it
        if (this.hasCapability(camId, 'siren')) {
            await this.createStateObj(camId, 'control.siren', 'Trigger siren/alarm', 'boolean', 'button', false, true);
        }

        // ── PTZ channel (only if camera supports PTZ)
        if (this.hasCapability(camId, 'ptz')) {
            await this.createChannel(camId, 'ptz', 'PTZ Control');
            await this.createStateObj(camId, 'ptz.command', 'PTZ command', 'string', 'text', '', true, {
                states: {
                    Left: 'Left', Right: 'Right', Up: 'Up', Down: 'Down',
                    LeftUp: 'LeftUp', LeftDown: 'LeftDown', RightUp: 'RightUp', RightDown: 'RightDown',
                    ZoomInc: 'Zoom In', ZoomDec: 'Zoom Out',
                    FocusInc: 'Focus +', FocusDec: 'Focus -',
                    Stop: 'Stop', Auto: 'Auto Patrol',
                },
            });
            await this.createStateObj(camId, 'ptz.speed', 'PTZ speed (1-64)', 'number', 'level', 32, true, { min: 1, max: 64 });
            await this.createStateObj(camId, 'ptz.goToPreset', 'Go to preset index', 'number', 'value', 0, true);
            await this.createStateObj(camId, 'ptz.patrol', 'Start/stop patrol', 'boolean', 'switch', false, true);
            await this.createStateObj(camId, 'ptz.stop', 'Stop PTZ movement', 'boolean', 'button', false, true);
        }

        // ── Image settings channel
        await this.createChannel(camId, 'image', 'Image Settings');
        await this.createStateObj(camId, 'image.brightness', 'Brightness (0-255)', 'number', 'level', 128, true, { min: 0, max: 255 });
        await this.createStateObj(camId, 'image.contrast', 'Contrast (0-255)', 'number', 'level', 128, true, { min: 0, max: 255 });
        await this.createStateObj(camId, 'image.saturation', 'Saturation (0-255)', 'number', 'level', 128, true, { min: 0, max: 255 });
        await this.createStateObj(camId, 'image.sharpness', 'Sharpness (0-255)', 'number', 'level', 128, true, { min: 0, max: 255 });

        // ── Snapshot data channel
        await this.createChannel(camId, 'snapshot', 'Snapshot Data');
        await this.createStateObj(camId, 'snapshot.image', 'Last snapshot (base64)', 'string', 'text', '', false);
        await this.createStateObj(camId, 'snapshot.timestamp', 'Last snapshot time', 'number', 'date', 0, false);
        await this.createStateObj(camId, 'snapshot.file', 'Last snapshot file path', 'string', 'text', '', false);

        // ── Storage info
        await this.createChannel(camId, 'storage', 'Storage Info');
        await this.createStateObj(camId, 'storage.hddCapacity', 'HDD/SD total capacity (MB)', 'number', 'value', 0, false);
        await this.createStateObj(camId, 'storage.hddUsed', 'HDD/SD used space (MB)', 'number', 'value', 0, false);

        // ── Loxone virtual inputs mapping
        if (this.config.loxoneEnabled) {
            await this.createChannel(camId, 'loxone', 'Loxone Integration');
            await this.createStateObj(camId, 'loxone.motionInputName', 'Loxone VI name for motion', 'string', 'text', `Reolink_${camId}_Motion`, true);
            await this.createStateObj(camId, 'loxone.personInputName', 'Loxone VI name for person', 'string', 'text', `Reolink_${camId}_AI_person`, true);
            await this.createStateObj(camId, 'loxone.vehicleInputName', 'Loxone VI name for vehicle', 'string', 'text', `Reolink_${camId}_AI_vehicle`, true);
            await this.createStateObj(camId, 'loxone.onlineInputName', 'Loxone VI name for status', 'string', 'text', `Reolink_${camId}_Online`, true);
        }

        this.log.debug(`Object tree created for camera "${camId}"`);
    }

    // ─── STATUS POLLING ───────────────────────────────────────────────

    async updateCameraStatus(camId, api, camConfig) {
        try {
            const ch = camConfig.channel || 0;

            // Motion detection state
            try {
                const mdState = await api.getMdState(ch);
                const motion = !!(mdState?.state || mdState?.MdState?.state);
                const prev = this.lastStates.get(`${camId}.motion`);

                await this.setStateAsync(`${camId}.status.motionDetected`, motion, true);

                if (motion !== prev) {
                    this.lastStates.set(`${camId}.motion`, motion);
                    if (motion) {
                        await this.setStateAsync(`${camId}.status.lastMotionTime`, Date.now(), true);
                    }
                    // Send to Loxone
                    if (this.loxoneBridge) {
                        await this.loxoneBridge.sendMotionEvent(camConfig.name || camId, motion);
                    }
                }
            } catch (e) {
                this.log.debug(`Motion state unavailable for ${camId}: ${e.message}`);
            }

            // AI detection state (only if camera supports AI)
            if (this.hasCapability(camId, 'aiDetection')) {
                try {
                    const aiState = await api.getAiState(ch);
                    const aiData = aiState?.AiState || aiState;
                    const detections = {
                        person: !!(aiData?.people?.alarm_state || aiData?.dog_cat?.people_state),
                        vehicle: !!(aiData?.vehicle?.alarm_state),
                        animal: !!(aiData?.dog_cat?.alarm_state),
                        face: !!(aiData?.face?.alarm_state),
                    };

                    for (const [type, detected] of Object.entries(detections)) {
                        const stateId = `${camId}.status.${type}Detected`;
                        const prevKey = `${camId}.ai.${type}`;
                        const prev = this.lastStates.get(prevKey);

                        await this.setStateAsync(stateId, detected, true);

                        if (detected !== prev) {
                            this.lastStates.set(prevKey, detected);
                            if (this.loxoneBridge) {
                                await this.loxoneBridge.sendAiEvent(camConfig.name || camId, type, detected);
                            }
                        }
                    }
                } catch (e) {
                    this.log.debug(`AI state unavailable for ${camId}: ${e.message}`);
                }
            }

            // Connection alive
            await this.setStateAsync(`${camId}.info.connection`, true, true);

            const prevOnline = this.lastStates.get(`${camId}.online`);
            if (prevOnline !== true) {
                this.lastStates.set(`${camId}.online`, true);
                if (this.loxoneBridge) {
                    await this.loxoneBridge.sendStatusEvent(camConfig.name || camId, true);
                }
            }
        } catch (err) {
            this.log.warn(`Status update failed for "${camId}": ${err.message}`);
            await this.setStateAsync(`${camId}.info.connection`, false, true);

            const prevOnline = this.lastStates.get(`${camId}.online`);
            if (prevOnline !== false) {
                this.lastStates.set(`${camId}.online`, false);
                if (this.loxoneBridge) {
                    const camConfig2 = (this.config.cameras || []).find(
                        (c) => this.sanitizeId(c.name || `cam_${c.host}`) === camId,
                    );
                    await this.loxoneBridge.sendStatusEvent(camConfig2?.name || camId, false);
                }
            }

            // Try to re-login
            try {
                await api.login();
                this.log.info(`Re-authenticated camera "${camId}"`);
            } catch (e) {
                this.log.debug(`Re-login failed for ${camId}: ${e.message}`);
            }
        }
    }

    // ─── STATE CHANGE HANDLER (user commands) ─────────────────────────

    async onStateChange(id, state) {
        if (!state || state.ack) return;

        const parts = id.split('.');
        // reolink-loxone.0.camId.channel.state
        if (parts.length < 5) return;

        const camId = parts[2];
        const channel = parts[3];
        const stateName = parts.slice(4).join('.');
        const api = this.cameras.get(camId);

        if (!api) {
            this.log.warn(`Camera "${camId}" not found for state change`);
            return;
        }

        const camConfig = (this.config.cameras || []).find(
            (c) => this.sanitizeId(c.name || `cam_${c.host}`) === camId,
        );
        const ch = camConfig?.channel || 0;

        try {
            switch (`${channel}.${stateName}`) {
                // ── Control commands
                case 'control.snapshot':
                    if (state.val) {
                        await this.captureSnapshot(camId, api, ch);
                        await this.setStateAsync(id, false, true);
                    }
                    break;

                case 'control.reboot':
                    if (state.val) {
                        this.log.info(`Rebooting camera "${camId}"...`);
                        await api.reboot();
                        await this.setStateAsync(id, false, true);
                    }
                    break;

                case 'control.irLights': {
                    const mode = String(state.val);
                    const irState = mode === 'On' ? 1 : mode === 'Off' ? 0 : 2; // 2=Auto
                    await api.setIrLights({ channel: ch, state: irState });
                    await this.setStateAsync(id, mode, true);
                    break;
                }

                case 'control.whiteLed': {
                    const caps = this.capabilities.get(camId) || {};
                    try {
                        await api.setWhiteLed({
                            channel: ch,
                            state: state.val ? 1 : 0,
                            mode: 0,
                            bright: 100,
                        });
                        this.log.info(`White LED ${state.val ? 'ON' : 'OFF'} for camera "${camId}"`);
                        await this.setStateAsync(id, !!state.val, true);
                        caps.whiteLed = true;
                        this.capabilities.set(camId, caps);
                    } catch (wlErr) {
                        this.log.debug(`Camera "${camId}" SetWhiteLed not supported: ${wlErr.message}`);
                        caps.whiteLed = false;
                        this.capabilities.set(camId, caps);
                    }
                    break;
                }

                case 'control.siren':
                    if (state.val) {
                        try {
                            await api._cmdDirect('AudioAlarmPlay', {
                                AudioAlarmPlay: { channel: ch, manualSwitch: 1, duration: 5 },
                            }, null, { channel: ch });
                            this.log.info(`Siren triggered on camera "${camId}"`);
                        } catch (sirenErr) {
                            this.log.debug(`Camera "${camId}" Siren not supported: ${sirenErr.message}`);
                        }
                        await this.setStateAsync(id, false, true);
                    }
                    break;

                // ── PTZ commands
                case 'ptz.command': {
                    if (!this.hasCapability(camId, 'ptz')) {
                        this.log.debug(`Camera "${camId}" does not support PTZ — skipping`);
                        break;
                    }
                    const speedState = await this.getStateAsync(`${camId}.ptz.speed`);
                    const speed = speedState?.val || 32;
                    await api.ptzCtrl(String(state.val), speed, ch);
                    break;
                }

                case 'ptz.goToPreset':
                    if (!this.hasCapability(camId, 'ptz')) break;
                    await api.ptzCtrl('ToPos', 32, ch, Number(state.val));
                    await this.setStateAsync(id, state.val, true);
                    break;

                case 'ptz.patrol':
                    if (!this.hasCapability(camId, 'ptz')) break;
                    if (state.val) {
                        await api.ptzCtrl('StartPatrol', 0, ch);
                    } else {
                        await api.ptzCtrl('StopPatrol', 0, ch);
                    }
                    await this.setStateAsync(id, !!state.val, true);
                    break;

                case 'ptz.stop':
                    if (!this.hasCapability(camId, 'ptz')) break;
                    if (state.val) {
                        await api.stopPtz(ch);
                        await this.setStateAsync(id, false, true);
                    }
                    break;

                // ── Image settings
                case 'image.brightness':
                case 'image.contrast':
                case 'image.saturation':
                case 'image.sharpness': {
                    const prop = stateName; // brightness, contrast, etc.
                    const ispConfig = { channel: ch };
                    ispConfig[prop] = Number(state.val);
                    await api.setIsp(ispConfig);
                    await this.setStateAsync(id, state.val, true);
                    break;
                }

                default:
                    this.log.debug(`Unhandled state change: ${id} = ${state.val}`);
            }
        } catch (err) {
            this.log.error(`Error handling command ${channel}.${stateName} for "${camId}": ${err.message}`);
        }
    }

    // ─── SNAPSHOT CAPTURE ─────────────────────────────────────────────

    async captureSnapshot(camId, api, channel) {
        try {
            const buffer = await api.getSnapshot(channel);

            // Save to file
            const snapshotDir = path.join(this.getDataDir(), 'snapshots');
            if (!fs.existsSync(snapshotDir)) {
                fs.mkdirSync(snapshotDir, { recursive: true });
            }
            const filename = `${camId}_${Date.now()}.jpg`;
            const filepath = path.join(snapshotDir, filename);
            fs.writeFileSync(filepath, buffer);

            // Update states
            const base64 = buffer.toString('base64');
            await this.setStateAsync(`${camId}.snapshot.image`, `data:image/jpeg;base64,${base64}`, true);
            await this.setStateAsync(`${camId}.snapshot.timestamp`, Date.now(), true);
            await this.setStateAsync(`${camId}.snapshot.file`, filepath, true);

            this.log.info(`Snapshot saved: ${filepath}`);
        } catch (err) {
            this.log.error(`Snapshot failed for "${camId}": ${err.message}`);
        }
    }

    // ─── HELPER METHODS ───────────────────────────────────────────────

    getDataDir() {
        return utils.getAbsoluteInstanceDataDir(this);
    }

    sanitizeId(name) {
        return name
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .replace(/_{2,}/g, '_')
            .replace(/^_|_$/g, '')
            .toLowerCase();
    }

    async createChannel(camId, channelName, label) {
        await this.setObjectNotExistsAsync(`${camId}.${channelName}`, {
            type: 'channel',
            common: { name: label },
            native: {},
        });
    }

    async createStateObj(camId, stateId, name, type, role, def, writable, extra = {}) {
        const common = {
            name,
            type,
            role,
            def,
            read: true,
            write: writable,
            ...extra,
        };
        await this.setObjectNotExistsAsync(`${camId}.${stateId}`, {
            type: 'state',
            common,
            native: {},
        });
    }
}

// Main entry
if (require.main !== module) {
    module.exports = (options) => new ReolinkLoxoneAdapter(options);
} else {
    new ReolinkLoxoneAdapter();
}
