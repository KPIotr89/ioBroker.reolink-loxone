'use strict';

/**
 * ONVIF PullPoint event subscription.
 * Replaces polling for motion/AI/visitor events with camera-pushed notifications.
 *
 * Protocol: ONVIF WS-Eventing PullPoint (no library needed — plain HTTP POST + XML)
 *
 * Flow:
 *   1. CreatePullPointSubscription  → get subscription reference URL
 *   2. Poll PullMessages every ~2s  → receive motion/AI/visitor events
 *   3. Renew subscription before it expires (default TTL: 60s)
 *   4. Unsubscribe on adapter stop
 */

const http = require('http');
const https = require('https');

// ─── SOAP helpers ──────────────────────────────────────────────────────────

function soapEnvelope(body, auth) {
    const security = auth ? `
  <s:Header>
    <Security xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
      <UsernameToken>
        <Username>${escapeXml(auth.user)}</Username>
        <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${escapeXml(auth.pass)}</Password>
      </UsernameToken>
    </Security>
  </s:Header>` : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:a="http://www.w3.org/2005/08/addressing"
            xmlns:e="http://schemas.xmlsoap.org/ws/2004/08/eventing"
            xmlns:tev="http://www.onvif.org/ver10/events/wsdl">
  ${security}
  <s:Body>${body}</s:Body>
</s:Envelope>`;
}

function escapeXml(str) {
    return String(str || '').replace(/[<>&'"]/g, c => ({
        '<': '&lt;', '>': '&gt;', '&': '&amp;', '\'': '&apos;', '"': '&quot;',
    }[c]));
}

function postSoap(url, soapBody, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(url); } catch (e) { return reject(e); }

        const protocol = parsed.protocol === 'https:' ? https : http;
        const data = Buffer.from(soapBody, 'utf8');

        const req = protocol.request({
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/soap+xml; charset=utf-8',
                'Content-Length': data.length,
            },
            timeout: timeoutMs,
            rejectUnauthorized: false,
        }, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('SOAP request timed out')); });
        req.write(data);
        req.end();
    });
}

// ─── XML extraction helper ─────────────────────────────────────────────────

function extractAttr(xml, tag, attr) {
    const pattern = new RegExp(`<[^:>]*:?${tag}[^>]*${attr}="([^"]*)"`, 'i');
    const m = xml.match(pattern);
    return m ? m[1] : null;
}

// ─── Main class ────────────────────────────────────────────────────────────

class OnvifEventClient {
    /**
     * @param {object} opts
     * @param {string} opts.host
     * @param {number} opts.port
     * @param {string} opts.username
     * @param {string} opts.password
     * @param {boolean} [opts.useHttps]
     * @param {Function} opts.onEvent  - called with { type, active, channel }
     * @param {object} opts.log        - ioBroker logger
     */
    constructor(opts) {
        this.host = opts.host;
        this.port = opts.port || 80;
        this.auth = { user: opts.username, pass: opts.password };
        this.useHttps = opts.useHttps || false;
        this.onEvent = opts.onEvent;
        this.log = opts.log;

        this._baseUrl = `${this.useHttps ? 'https' : 'http'}://${this.host}:${this.port}`;
        this._eventServiceUrl = `${this._baseUrl}/onvif/event_service`;
        this._subscriptionUrl = null;
        this._pullTimer = null;
        this._renewTimer = null;
        this._running = false;
    }

    async start() {
        try {
            await this._createSubscription();
            this._running = true;
            this._schedulePull();
            this.log.info(`ONVIF events active for ${this.host}`);
        } catch (e) {
            throw new Error(`ONVIF subscription failed for ${this.host}: ${e.message}`);
        }
    }

    stop() {
        this._running = false;
        if (this._pullTimer) { clearTimeout(this._pullTimer); this._pullTimer = null; }
        if (this._renewTimer) { clearTimeout(this._renewTimer); this._renewTimer = null; }
        if (this._subscriptionUrl) {
            this._unsubscribe().catch(() => { /* ignore on stop */ });
            this._subscriptionUrl = null;
        }
    }

    async _createSubscription() {
        const soap = soapEnvelope(`
    <tev:CreatePullPointSubscription>
      <tev:InitialTerminationTime>PT60S</tev:InitialTerminationTime>
    </tev:CreatePullPointSubscription>`, this.auth);

        const res = await postSoap(this._eventServiceUrl, soap);

        // Extract subscription URL from response
        const urlMatch = res.body.match(/<[^:>]*:?Address[^>]*>\s*(http[^<]+)<\/[^:>]*:?Address>/i);
        if (!urlMatch) throw new Error('No subscription address in ONVIF response');

        this._subscriptionUrl = urlMatch[1].trim();

        // Schedule renewal at 50s (before 60s TTL expires)
        this._renewTimer = setTimeout(() => this._renew(), 50000);
    }

    _schedulePull() {
        if (!this._running) return;
        this._pullTimer = setTimeout(async () => {
            if (!this._running) return;
            try {
                await this._pullMessages();
            } catch (e) {
                this.log.debug(`ONVIF pull error for ${this.host}: ${e.message}`);
            }
            this._schedulePull();
        }, 2000);
    }

    async _pullMessages() {
        if (!this._subscriptionUrl) return;

        const soap = soapEnvelope(`
    <tev:PullMessages xmlns:tev="http://www.onvif.org/ver10/events/wsdl">
      <tev:Timeout>PT5S</tev:Timeout>
      <tev:MessageLimit>10</tev:MessageLimit>
    </tev:PullMessages>`, this.auth);

        const res = await postSoap(this._subscriptionUrl, soap, 8000);
        this._parseNotifications(res.body);
    }

    _parseNotifications(xml) {
        // Find all NotificationMessage blocks
        const notifPattern = /<[^:>]*:?NotificationMessage[^>]*>([\s\S]*?)<\/[^:>]*:?NotificationMessage>/gi;
        let m;

        while ((m = notifPattern.exec(xml)) !== null) {
            const block = m[1];
            this._parseNotificationBlock(block);
        }
    }

    _parseNotificationBlock(block) {
        // Extract Topic (event type)
        const topicMatch = block.match(/<[^:>]*:?Topic[^>]*>\s*([^<]+)\s*<\/[^:>]*:?Topic>/i);
        if (!topicMatch) return;

        const topic = topicMatch[1].trim().toLowerCase();

        // Extract IsMotion / State simple items
        const stateMatch = block.match(/Name="IsMotion"[^>]*Value="([^"]+)"/i)
            || block.match(/Name="State"[^>]*Value="([^"]+)"/i)
            || block.match(/Name="alarm_state"[^>]*Value="([^"]+)"/i);

        const active = stateMatch
            ? (stateMatch[1].toLowerCase() === 'true' || stateMatch[1] === '1')
            : true; // no state value = event fired = active

        const channel = parseInt(extractAttr(block, 'SimpleItem', 'VideoSourceToken') || '0', 10) || 0;

        let type = null;

        if (topic.includes('motion') || topic.includes('motiondetector') || topic.includes('celltrigger')) {
            type = 'motion';
        } else if (topic.includes('visitor') || topic.includes('doorbell')) {
            type = 'visitor';
        } else if (topic.includes('people') || topic.includes('person') || topic.includes('humanoid')) {
            type = 'person';
        } else if (topic.includes('vehicle')) {
            type = 'vehicle';
        } else if (topic.includes('animal') || topic.includes('dog') || topic.includes('cat')) {
            type = 'animal';
        } else if (topic.includes('face')) {
            type = 'face';
        }

        if (type) {
            this.log.debug(`ONVIF event from ${this.host}: ${type} = ${active} (topic: ${topic})`);
            this.onEvent({ type, active, channel });
        }
    }

    async _renew() {
        if (!this._running || !this._subscriptionUrl) return;
        try {
            const soap = soapEnvelope(`
    <tev:Renew xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2">
      <wsnt:TerminationTime>PT60S</wsnt:TerminationTime>
    </tev:Renew>`, this.auth);

            await postSoap(this._subscriptionUrl, soap);
            this._renewTimer = setTimeout(() => this._renew(), 50000);
        } catch (e) {
            this.log.debug(`ONVIF renew failed for ${this.host}, resubscribing: ${e.message}`);
            try {
                await this._createSubscription();
            } catch (_) { /* subscription dead — keep trying on next pull */ }
        }
    }

    async _unsubscribe() {
        if (!this._subscriptionUrl) return;
        const soap = soapEnvelope('<tev:Unsubscribe/>', this.auth);
        await postSoap(this._subscriptionUrl, soap, 3000).catch(() => { /* ignore */ });
    }
}

module.exports = { OnvifEventClient };
