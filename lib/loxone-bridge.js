'use strict';

const http = require('http');
const dgram = require('dgram');

/**
 * LoxoneBridge - Sends camera events directly to Loxone Miniserver
 * Supports both HTTP Virtual Inputs and UDP Virtual Inputs
 */
class LoxoneBridge {
    /**
     * @param {object} config
     * @param {string} config.host - Loxone Miniserver IP
     * @param {number} [config.port=80] - HTTP port
     * @param {string} config.username - Loxone user
     * @param {string} config.password - Loxone password
     * @param {number} [config.udpPort=7000] - UDP target port
     * @param {'http'|'udp'|'both'} [config.mode='http'] - Communication mode
     * @param {object} [config.log] - Logger
     */
    constructor(config) {
        this.host = config.host;
        this.port = config.port || 80;
        this.username = config.username;
        this.password = config.password;
        this.udpPort = config.udpPort || 7000;
        this.mode = config.mode || 'http';
        this.log = config.log || console;
        this.enabled = !!(config.host && config.host.trim());

        if (this.enabled && (this.mode === 'udp' || this.mode === 'both')) {
            this.udpClient = dgram.createSocket('udp4');
        }
    }

    /**
     * Send a value to a Loxone Virtual Input via HTTP
     * @param {string} inputName - Virtual Input name in Loxone
     * @param {string|number} value - Value to send
     */
    async sendHttp(inputName, value) {
        if (!this.enabled) return;

        return new Promise((resolve, reject) => {
            const encodedValue = encodeURIComponent(String(value));
            const encodedInput = encodeURIComponent(inputName);
            const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');

            const options = {
                hostname: this.host,
                port: this.port,
                path: `/dev/sps/io/${encodedInput}/${encodedValue}`,
                method: 'GET',
                headers: {
                    Authorization: `Basic ${auth}`,
                },
                timeout: 5000,
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        this.log.debug(`[LoxoneBridge] HTTP sent: ${inputName}=${value}`);
                        resolve(data);
                    } else {
                        this.log.warn(`[LoxoneBridge] HTTP error ${res.statusCode}: ${data}`);
                        reject(new Error(`HTTP ${res.statusCode}`));
                    }
                });
            });

            req.on('error', (err) => {
                this.log.warn(`[LoxoneBridge] HTTP request failed: ${err.message}`);
                reject(err);
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.end();
        });
    }

    /**
     * Send a value to Loxone via UDP
     * @param {string} inputName - Virtual Input name
     * @param {string|number} value - Value to send
     */
    async sendUdp(inputName, value) {
        if (!this.enabled || !this.udpClient) return;

        return new Promise((resolve, reject) => {
            const message = Buffer.from(`${inputName}=${value}`);
            this.udpClient.send(message, this.udpPort, this.host, (err) => {
                if (err) {
                    this.log.warn(`[LoxoneBridge] UDP send failed: ${err.message}`);
                    reject(err);
                } else {
                    this.log.debug(`[LoxoneBridge] UDP sent: ${inputName}=${value}`);
                    resolve();
                }
            });
        });
    }

    /**
     * Send event using configured mode
     * @param {string} inputName
     * @param {string|number} value
     */
    async sendEvent(inputName, value) {
        if (!this.enabled) return;

        const promises = [];
        if (this.mode === 'http' || this.mode === 'both') {
            promises.push(this.sendHttp(inputName, value).catch((e) => {
                this.log.warn(`[LoxoneBridge] HTTP send error: ${e.message}`);
            }));
        }
        if (this.mode === 'udp' || this.mode === 'both') {
            promises.push(this.sendUdp(inputName, value).catch((e) => {
                this.log.warn(`[LoxoneBridge] UDP send error: ${e.message}`);
            }));
        }
        await Promise.all(promises);
    }

    /**
     * Send camera motion event to Loxone
     * @param {string} cameraName
     * @param {boolean} motionDetected
     */
    async sendMotionEvent(cameraName, motionDetected) {
        const safeName = cameraName.replace(/[^a-zA-Z0-9_-]/g, '_');
        await this.sendEvent(`Reolink_${safeName}_Motion`, motionDetected ? 1 : 0);
    }

    /**
     * Send AI detection event to Loxone
     * @param {string} cameraName
     * @param {'person'|'vehicle'|'animal'|'face'} aiType
     * @param {boolean} detected
     */
    async sendAiEvent(cameraName, aiType, detected) {
        const safeName = cameraName.replace(/[^a-zA-Z0-9_-]/g, '_');
        await this.sendEvent(`Reolink_${safeName}_AI_${aiType}`, detected ? 1 : 0);
    }

    /**
     * Send camera online/offline status to Loxone
     * @param {string} cameraName
     * @param {boolean} online
     */
    async sendStatusEvent(cameraName, online) {
        const safeName = cameraName.replace(/[^a-zA-Z0-9_-]/g, '_');
        await this.sendEvent(`Reolink_${safeName}_Online`, online ? 1 : 0);
    }

    /**
     * Close UDP client
     */
    destroy() {
        if (this.udpClient) {
            try {
                this.udpClient.close();
            } catch (_) {
                // ignore
            }
            this.udpClient = null;
        }
    }
}

module.exports = LoxoneBridge;
