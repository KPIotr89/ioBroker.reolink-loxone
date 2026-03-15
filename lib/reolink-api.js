'use strict';

const axios = require('axios');
const https = require('https');

/**
 * ReolinkAPI - Full-featured HTTP API client for Reolink cameras
 * Supports authentication, device info, video streams, PTZ, motion/AI detection,
 * alarms, recording, snapshots, network config, OSD, encoding, user management,
 * IR lights, white lights, audio, FTP, email, push notifications, and more.
 *
 * Compatible with all Reolink cameras exposing the HTTP API (PoE & WiFi).
 */
class ReolinkAPI {
    /**
     * @param {object} config
     * @param {string} config.host - Camera IP or hostname
     * @param {number} [config.port=443] - Camera HTTP(S) port
     * @param {string} config.username - Login username
     * @param {string} config.password - Login password
     * @param {number} [config.channel=0] - Default channel
     * @param {boolean} [config.useHttps=false] - Use HTTPS
     * @param {object} [config.log] - Logger instance
     */
    constructor(config) {
        this.host = config.host;
        this.port = config.port || (config.useHttps ? 443 : 80);
        this.username = config.username;
        this.password = config.password;
        this.channel = config.channel || 0;
        this.useHttps = config.useHttps || false;
        this.token = null;
        this.tokenExpiry = null;
        this.log = config.log || console;

        this.baseUrl = `${this.useHttps ? 'https' : 'http'}://${this.host}:${this.port}`;

        this.client = axios.create({
            baseURL: this.baseUrl,
            timeout: 15000,
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // ─── AUTHENTICATION ───────────────────────────────────────────────

    /**
     * Login and obtain session token
     * @returns {Promise<string>} token
     */
    async login() {
        try {
            const res = await this.client.post('/cgi-bin/api.cgi?cmd=Login', [
                {
                    cmd: 'Login',
                    action: 0,
                    param: {
                        User: {
                            userName: this.username,
                            password: this.password,
                        },
                    },
                },
            ]);

            const data = res.data[0];
            if (data && data.code === 0 && data.value && data.value.Token) {
                this.token = data.value.Token.name;
                // Token valid for ~3600s typically; refresh at 80%
                const leaseTime = data.value.Token.leaseTime || 3600;
                this.tokenExpiry = Date.now() + leaseTime * 800; // 80% of lease
                this.log.debug(`[ReolinkAPI] Logged in to ${this.host}, token lease: ${leaseTime}s`);
                return this.token;
            }
            throw new Error(`Login failed: ${JSON.stringify(data)}`);
        } catch (err) {
            this.token = null;
            this.tokenExpiry = null;
            throw new Error(`Login error for ${this.host}: ${err.message}`);
        }
    }

    /**
     * Logout and invalidate token
     */
    async logout() {
        if (!this.token) return;
        try {
            await this._cmd('Logout');
        } catch (_) {
            // ignore
        }
        this.token = null;
        this.tokenExpiry = null;
    }

    /**
     * Ensure token is valid, re-login if expired
     */
    async ensureAuth() {
        if (!this.token || (this.tokenExpiry && Date.now() > this.tokenExpiry)) {
            await this.login();
        }
    }

    // ─── CORE REQUEST HELPERS ─────────────────────────────────────────

    /**
     * Execute a single API command
     * @param {string} cmd - Command name
     * @param {object} [param] - Command parameters
     * @param {number} [action=0] - 0=get, 1=set
     * @returns {Promise<object>} response value
     */
    async _cmd(cmd, param = {}, action = 0) {
        await this.ensureAuth();
        const url = `/cgi-bin/api.cgi?cmd=${cmd}&token=${this.token}`;
        const body = [{ cmd, action, param }];

        try {
            const res = await this.client.post(url, body);
            const data = res.data[0];
            if (data && data.code === 0) {
                return data.value || {};
            }
            // Some commands return data without code field
            if (data && data.value) {
                return data.value;
            }
            throw new Error(`Command ${cmd} failed: code=${data?.code}, error=${JSON.stringify(data?.error || data)}`);
        } catch (err) {
            if (err.response && err.response.status === 401) {
                // Token expired, retry once
                await this.login();
                const res2 = await this.client.post(
                    `/cgi-bin/api.cgi?cmd=${cmd}&token=${this.token}`,
                    body,
                );
                const data2 = res2.data[0];
                if (data2 && (data2.code === 0 || data2.value)) {
                    return data2.value || {};
                }
            }
            throw err;
        }
    }

    /**
     * Execute multiple commands in a single request (batch)
     * @param {Array<{cmd: string, param?: object, action?: number}>} commands
     * @returns {Promise<Array>}
     */
    async _batchCmd(commands) {
        await this.ensureAuth();
        const cmdNames = commands.map((c) => c.cmd).join('&cmd=');
        const url = `/cgi-bin/api.cgi?cmd=${cmdNames}&token=${this.token}`;
        const body = commands.map((c) => ({
            cmd: c.cmd,
            action: c.action || 0,
            param: c.param || {},
        }));
        const res = await this.client.post(url, body);
        return res.data;
    }

    /**
     * URL-based GET request (for snap, etc.)
     * @param {string} cmd
     * @param {object} [extraParams]
     * @returns {Promise<Buffer>}
     */
    async _getBuffer(cmd, extraParams = {}) {
        await this.ensureAuth();
        const params = new URLSearchParams({
            cmd,
            token: this.token,
            ...extraParams,
        });
        const url = `/cgi-bin/api.cgi?${params.toString()}`;
        const res = await this.client.get(url, { responseType: 'arraybuffer' });
        return Buffer.from(res.data);
    }

    /**
     * Execute API command using direct user/password auth (no token)
     * Some commands work more reliably this way (e.g. SetWhiteLed, AudioAlarmPlay)
     * @param {string} cmd - Command name
     * @param {object} [param] - Command parameters
     * @param {number} [action=0]
     * @returns {Promise<object>} response value
     */
    async _cmdDirect(cmd, param = {}, action = null, urlParams = {}) {
        let url = `/api.cgi?cmd=${cmd}&user=${encodeURIComponent(this.username)}&password=${encodeURIComponent(this.password)}`;
        for (const [key, val] of Object.entries(urlParams)) {
            url += `&${key}=${encodeURIComponent(val)}`;
        }
        // Don't include 'action' field unless explicitly provided — some cameras
        // (e.g. CX810, CX820) reject commands that include unexpected fields
        const bodyEntry = action !== null ? { cmd, action, param } : { cmd, param };
        const body = [bodyEntry];

        try {
            const res = await this.client.post(url, body);
            const data = res.data[0] || res.data;
            if (data && (data.code === 0 || data.value)) {
                return data.value || {};
            }
            throw new Error(`Command ${cmd} failed: code=${data?.code}, error=${JSON.stringify(data?.error || data)}`);
        } catch (err) {
            throw new Error(`Direct command ${cmd} error: ${err.message}`);
        }
    }

    // ─── DEVICE INFORMATION ───────────────────────────────────────────

    /** Get device information (model, firmware, etc.) */
    async getDevInfo() {
        return this._cmd('GetDevInfo');
    }

    /** Get device ability/capabilities */
    async getAbility() {
        return this._cmd('GetAbility', { User: { userName: this.username } });
    }

    /** Get HDD/SD card information */
    async getHddInfo() {
        return this._cmd('GetHddInfo');
    }

    /** Get device performance/status */
    async getPerformance() {
        return this._cmd('GetPerformance');
    }

    /** Reboot camera */
    async reboot() {
        return this._cmd('Reboot');
    }

    // ─── NETWORK ──────────────────────────────────────────────────────

    /** Get network general info */
    async getNetworkGeneral() {
        return this._cmd('GetLocalLink');
    }

    /** Get WiFi info */
    async getWifi() {
        return this._cmd('GetWifi');
    }

    /** Scan WiFi networks */
    async scanWifi() {
        return this._cmd('ScanWifi');
    }

    /** Get DDNS config */
    async getDdns() {
        return this._cmd('GetDdns');
    }

    /** Get NTP config */
    async getNtp() {
        return this._cmd('GetNtp');
    }

    /** Set NTP config */
    async setNtp(ntpConfig) {
        return this._cmd('SetNtp', { Ntp: ntpConfig }, 0);
    }

    /** Get P2P info */
    async getP2p() {
        return this._cmd('GetP2p');
    }

    /** Get network ports */
    async getNetPort() {
        return this._cmd('GetNetPort');
    }

    /** Get UPnP status */
    async getUpnp() {
        return this._cmd('GetUpnp');
    }

    // ─── VIDEO & ENCODING ─────────────────────────────────────────────

    /** Get encoding configuration for channel */
    async getEnc(channel) {
        const ch = channel !== undefined ? channel : this.channel;
        return this._cmd('GetEnc', { channel: ch });
    }

    /** Set encoding configuration */
    async setEnc(encConfig) {
        return this._cmd('SetEnc', { Enc: encConfig }, 0);
    }

    /** Get ISP (image signal processing) settings */
    async getIsp(channel) {
        const ch = channel !== undefined ? channel : this.channel;
        return this._cmd('GetIsp', { channel: ch });
    }

    /** Set ISP settings (brightness, contrast, etc.) */
    async setIsp(ispConfig) {
        return this._cmd('SetIsp', { Isp: ispConfig }, 0);
    }

    /** Get OSD (on-screen display) config */
    async getOsd(channel) {
        const ch = channel !== undefined ? channel : this.channel;
        return this._cmd('GetOsd', { channel: ch });
    }

    /** Set OSD config */
    async setOsd(osdConfig) {
        return this._cmd('SetOsd', { Osd: osdConfig }, 0);
    }

    /** Get image/mask config */
    async getMask(channel) {
        const ch = channel !== undefined ? channel : this.channel;
        return this._cmd('GetMask', { channel: ch });
    }

    // ─── STREAMS ──────────────────────────────────────────────────────

    /**
     * Get RTSP stream URL
     * @param {number} [channel]
     * @param {'main'|'sub'|'ext'} [stream='main']
     * @returns {string} RTSP URL
     */
    getRtspUrl(channel, stream = 'main') {
        const ch = channel !== undefined ? channel : this.channel;
        const streamPath = stream === 'sub' ? `h264Preview_0${ch + 1}_sub` : (stream === 'ext' ? `h264Preview_0${ch + 1}_ext` : `h264Preview_0${ch + 1}_main`);
        return `rtsp://${this.username}:${this.password}@${this.host}:554/${streamPath}`;
    }

    /**
     * Get RTMP stream URL
     * @param {number} [channel]
     * @param {'main'|'sub'} [stream='main']
     * @returns {string}
     */
    getRtmpUrl(channel, stream = 'main') {
        const ch = channel !== undefined ? channel : this.channel;
        const streamPath = stream === 'sub' ? 'bcs/channel${ch}_sub.bcs' : `bcs/channel${ch}_main.bcs`;
        return `rtmp://${this.host}:1935/${streamPath}?channel=${ch}&stream=0&user=${this.username}&password=${this.password}`;
    }

    /**
     * Get FLV stream URL
     * @param {number} [channel]
     * @param {'main'|'sub'} [stream='main']
     * @returns {string}
     */
    getFlvUrl(channel, stream = 'main') {
        const ch = channel !== undefined ? channel : this.channel;
        const s = stream === 'sub' ? 'sub' : 'main';
        return `${this.baseUrl}/flv?port=1935&app=bcs&stream=channel${ch}_${s}.bcs&user=${this.username}&password=${this.password}`;
    }

    // ─── SNAPSHOTS ────────────────────────────────────────────────────

    /**
     * Capture a JPEG snapshot
     * @param {number} [channel]
     * @returns {Promise<Buffer>} JPEG image data
     */
    async getSnapshot(channel) {
        const ch = channel !== undefined ? channel : this.channel;
        return this._getBuffer('Snap', { channel: String(ch), rs: `snap_${Date.now()}` });
    }

    // ─── MOTION DETECTION ─────────────────────────────────────────────

    /** Get motion detection state (0=no motion, 1=motion detected) */
    async getMdState(channel) {
        const ch = channel !== undefined ? channel : this.channel;
        return this._cmd('GetMdState', { channel: ch });
    }

    /** Get motion detection alarm config */
    async getMdAlarm(channel) {
        const ch = channel !== undefined ? channel : this.channel;
        return this._cmd('GetAlarm', { Alarm: { channel: ch, type: 'md' } }, 1);
    }

    /** Set motion detection alarm config */
    async setMdAlarm(alarmConfig) {
        return this._cmd('SetAlarm', { Alarm: alarmConfig }, 0);
    }

    // ─── AI DETECTION ─────────────────────────────────────────────────

    /** Get AI detection state (person, vehicle, animal, face) */
    async getAiState(channel) {
        const ch = channel !== undefined ? channel : this.channel;
        return this._cmd('GetAiState', { channel: ch });
    }

    /** Get AI detection alarm config */
    async getAiAlarm(channel) {
        const ch = channel !== undefined ? channel : this.channel;
        return this._cmd('GetAiCfg', { channel: ch });
    }

    /** Set AI detection config */
    async setAiAlarm(aiConfig) {
        return this._cmd('SetAiCfg', { AiCfg: aiConfig }, 0);
    }

    // ─── AUDIO ALARM ──────────────────────────────────────────────────

    /** Get audio alarm state */
    async getAudioAlarmState(channel) {
        const ch = channel !== undefined ? channel : this.channel;
        return this._cmd('GetAudioAlarmV20', { channel: ch });
    }

    /** Set audio alarm config */
    async setAudioAlarm(audioConfig) {
        return this._cmd('SetAudioAlarmV20', { AudioAlarmV20: audioConfig }, 0);
    }

    // ─── PTZ CONTROL ──────────────────────────────────────────────────

    /**
     * Execute PTZ command
     * @param {'Left'|'Right'|'Up'|'Down'|'LeftUp'|'LeftDown'|'RightUp'|'RightDown'|'ZoomInc'|'ZoomDec'|'FocusInc'|'FocusDec'|'Auto'|'Stop'|'ToPos'|'StartPatrol'|'StopPatrol'} op
     * @param {number} [speed=32] - Speed 1-64
     * @param {number} [channel]
     * @param {number} [presetIdx] - Preset index for ToPos
     */
    async ptzCtrl(op, speed = 32, channel, presetIdx) {
        const ch = channel !== undefined ? channel : this.channel;
        const param = {
            PtzCtrl: {
                channel: ch,
                op,
                speed,
            },
        };
        if (presetIdx !== undefined) {
            param.PtzCtrl.id = presetIdx;
        }
        return this._cmd('PtzCtrl', param, 0);
    }

    /** Get PTZ presets list */
    async getPtzPresets(channel) {
        const ch = channel !== undefined ? channel : this.channel;
        return this._cmd('GetPtzPreset', { channel: ch });
    }

    /** Set/Save PTZ preset */
    async setPtzPreset(presetConfig) {
        return this._cmd('SetPtzPreset', { PtzPreset: presetConfig }, 0);
    }

    /** Get PTZ patrol config */
    async getPtzPatrol(channel) {
        const ch = channel !== undefined ? channel : this.channel;
        return this._cmd('GetPtzPatrol', { channel: ch });
    }

    /** Get PTZ guard (home position) config */
    async getPtzGuard(channel) {
        const ch = channel !== undefined ? channel : this.channel;
        return this._cmd('GetPtzGuard', { channel: ch });
    }

    /** Set PTZ guard config */
    async setPtzGuard(guardConfig) {
        return this._cmd('SetPtzGuard', { PtzGuard: guardConfig }, 0);
    }

    /** Get zoom/focus settings */
    async getZoomFocus(channel) {
        const ch = channel !== undefined ? channel : this.channel;
        return this._cmd('GetZoomFocus', { channel: ch });
    }

    /** Start zoom (inc/dec) */
    async startZoom(direction, channel) {
        const op = direction === 'in' ? 'ZoomInc' : 'ZoomDec';
        return this.ptzCtrl(op, 32, channel);
    }

    /** Stop any PTZ operation */
    async stopPtz(channel) {
        return this.ptzCtrl('Stop', 0, channel);
    }

    // ─── RECORDING & PLAYBACK ─────────────────────────────────────────

    /** Get recording configuration */
    async getRec(channel) {
        const ch = channel !== undefined ? channel : this.channel;
        return this._cmd('GetRec', { channel: ch });
    }

    /** Set recording configuration */
    async setRec(recConfig) {
        return this._cmd('SetRec', { Rec: recConfig }, 0);
    }

    /** Search for recordings */
    async searchRecordings(searchConfig) {
        return this._cmd('Search', { Search: searchConfig });
    }

    /** Get recording schedule */
    async getRecSchedule(channel) {
        const ch = channel !== undefined ? channel : this.channel;
        return this._cmd('GetRecV20', { channel: ch });
    }

    // ─── IR / WHITE LIGHT ─────────────────────────────────────────────

    /** Get IR light settings */
    async getIrLights(channel) {
        const ch = channel !== undefined ? channel : this.channel;
        return this._cmd('GetIrLights', { channel: ch });
    }

    /** Set IR light settings */
    async setIrLights(irConfig) {
        return this._cmd('SetIrLights', { IrLights: irConfig }, 0);
    }

    /** Get white light (spotlight) settings — per API docs section 3.10.5 */
    async getWhiteLed(channel) {
        const ch = channel !== undefined ? channel : this.channel;
        return this._cmdDirect('GetWhiteLed', { channel: ch }, 0, {});
    }

    /**
     * Set white light (spotlight) - reads current config first, then updates
     * Uses direct auth (user/password in URL) per Reolink API v1.0.8 docs
     * @param {object} ledConfig
     * @param {number} ledConfig.channel - Channel number
     * @param {number} ledConfig.state - 0=off, 1=on
     * @param {number} [ledConfig.mode] - 0=auto, 1=manual, 3=schedule
     * @param {number} [ledConfig.bright] - Brightness 0-100
     */
    async setWhiteLed(ledConfig) {
        const ch = ledConfig.channel || 0;

        // Read current config from camera to use as base
        // This ensures LightingSchedule, LightAlarm, wlAiDetectType, etc. match
        let current = {};
        try {
            const res = await this.getWhiteLed(ch);
            current = (res && res.WhiteLed) ? res.WhiteLed : {};
        } catch (_) {
            // If GetWhiteLed fails, use safe defaults
        }

        const payload = {
            WhiteLed: {
                state: ledConfig.state !== undefined ? ledConfig.state : 0,
                channel: ch,
                mode: ledConfig.mode !== undefined ? ledConfig.mode : (current.mode !== undefined ? current.mode : 1),
                bright: ledConfig.bright !== undefined ? ledConfig.bright : (current.bright !== undefined ? current.bright : 100),
                LightingSchedule: current.LightingSchedule || {
                    EndHour: 0, EndMin: 0, StartHour: 0, StartMin: 0,
                },
                wlAiDetectType: current.wlAiDetectType || {
                    dog_cat: 1, face: 0, people: 1, vehicle: 0,
                },
            },
        };

        // Include LightAlarm if camera uses it (CX810/CX820)
        if (current.LightAlarm) {
            payload.WhiteLed.LightAlarm = current.LightAlarm;
        }

        // No channel in URL, no action field — per official API docs
        return this._cmdDirect('SetWhiteLed', payload, null, {});
    }

    // ─── AUDIO ────────────────────────────────────────────────────────

    /** Get audio config */
    async getAudioCfg(channel) {
        const ch = channel !== undefined ? channel : this.channel;
        return this._cmd('GetAudioCfg', { channel: ch });
    }

    /** Set audio config */
    async setAudioCfg(audioConfig) {
        return this._cmd('SetAudioCfg', { AudioCfg: audioConfig }, 0);
    }

    // ─── EMAIL / FTP / PUSH ───────────────────────────────────────────

    /** Get email notification config */
    async getEmail() {
        return this._cmd('GetEmail');
    }

    /** Set email notification config */
    async setEmail(emailConfig) {
        return this._cmd('SetEmail', { Email: emailConfig }, 0);
    }

    /** Test email sending */
    async testEmail() {
        return this._cmd('TestEmail');
    }

    /** Get FTP config */
    async getFtp() {
        return this._cmd('GetFtp');
    }

    /** Set FTP config */
    async setFtp(ftpConfig) {
        return this._cmd('SetFtp', { Ftp: ftpConfig }, 0);
    }

    /** Test FTP connection */
    async testFtp() {
        return this._cmd('TestFtp');
    }

    /** Get push notification config */
    async getPush() {
        return this._cmd('GetPush');
    }

    /** Set push notification config */
    async setPush(pushConfig) {
        return this._cmd('SetPush', { Push: pushConfig }, 0);
    }

    // ─── USER MANAGEMENT ──────────────────────────────────────────────

    /** Get online users */
    async getOnline() {
        return this._cmd('GetOnline');
    }

    /** Get user list */
    async getUser() {
        return this._cmd('GetUser');
    }

    // ─── TIME / SYSTEM ────────────────────────────────────────────────

    /** Get system time */
    async getTime() {
        return this._cmd('GetTime');
    }

    /** Set system time */
    async setTime(timeConfig) {
        return this._cmd('SetTime', { Time: timeConfig }, 0);
    }

    // ─── BATCH STATUS (for polling) ───────────────────────────────────

    /**
     * Fetch comprehensive status in one batch request
     * @param {number} [channel]
     * @returns {Promise<object>} Parsed status object
     */
    async getFullStatus(channel) {
        const ch = channel !== undefined ? channel : this.channel;
        const commands = [
            { cmd: 'GetDevInfo' },
            { cmd: 'GetMdState', param: { channel: ch } },
            { cmd: 'GetAiState', param: { channel: ch } },
            { cmd: 'GetIrLights', param: { channel: ch } },
        ];

        try {
            const results = await this._batchCmd(commands);
            const status = {};
            for (const r of results) {
                if (r && r.value) {
                    status[r.cmd] = r.value;
                }
            }
            return status;
        } catch (err) {
            this.log.warn(`[ReolinkAPI] Batch status failed for ${this.host}: ${err.message}`);
            // Fallback: individual calls
            const status = {};
            try { status.GetDevInfo = await this.getDevInfo(); } catch (_) { /* skip */ }
            try { status.GetMdState = await this.getMdState(ch); } catch (_) { /* skip */ }
            try { status.GetAiState = await this.getAiState(ch); } catch (_) { /* skip */ }
            return status;
        }
    }

    /**
     * Quick connectivity check
     * @returns {Promise<boolean>}
     */
    async isAlive() {
        try {
            await this.getDevInfo();
            return true;
        } catch (_) {
            return false;
        }
    }
}

module.exports = ReolinkAPI;
