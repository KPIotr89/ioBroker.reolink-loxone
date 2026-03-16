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
    // Reolink uses SOAP 1.1 (schemas.xmlsoap.org) + WS-Addressing 2004/08
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
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:e="http://schemas.xmlsoap.org/ws/2004/08/eventing"
            xmlns:tev="http://www.onvif.org/ver10/events/wsdl"
            xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2">
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
                'Content-Type': 'text/xml; charset=utf-8',
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
        this._subscriptionUrl = null;
        this._pullTimer = null;
        this._renewTimer = null;
        this._running = false;
    }

    async start() {
        // Step 1: ask the camera which event service URL it actually exposes
        const discovered = await this._discoverEventServiceUrl();

        // Step 2: build candidate list — discovered URL first, then fallbacks
        const candidates = discovered
            ? [discovered, `${this._baseUrl}/onvif/event_service`, `${this._baseUrl}/onvif/Events`]
            : [`${this._baseUrl}/onvif/event_service`, `${this._baseUrl}/onvif/Events`, `${this._baseUrl}/onvif/events`];

        // Deduplicate
        const seen = new Set();
        const urls = candidates.filter(u => seen.has(u) ? false : seen.add(u));

        let lastErr = null;
        for (const url of urls) {
            this._eventServiceUrl = url;
            try {
                await this._createSubscription();
                this._running = true;
                this._schedulePull();
                this.log.info(`ONVIF events active for ${this.host} (${url})`);
                return;
            } catch (e) {
                this.log.debug(`ONVIF ${this.host}: tried ${url} — ${e.message}`);
                lastErr = e;
            }
        }
        throw new Error(`ONVIF subscription failed for ${this.host}: ${lastErr ? lastErr.message : 'unknown'}`);
    }

    /** Query /onvif/device_service for GetCapabilities to find the real event service URL */
    async _discoverEventServiceUrl() {
        const deviceUrl = `${this._baseUrl}/onvif/device_service`;
        const soap = soapEnvelope(`
    <tds:GetCapabilities xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
      <tds:Category>Events</tds:Category>
    </tds:GetCapabilities>`, this.auth);

        try {
            const res = await postSoap(deviceUrl, soap, 5000);
            this.log.debug(`ONVIF GetCapabilities from ${this.host}: ${res.body.substring(0, 800)}`);

            // Look for XAddr inside Events capabilities block
            const eventsBlock = res.body.match(/<[^:>]*:?Events[^>]*>([\s\S]*?)<\/[^:>]*:?Events>/i);
            if (eventsBlock) {
                const xaddrMatch = eventsBlock[1].match(/<[^:>]*:?XAddr[^>]*>\s*([^<\s]+)\s*<\/[^:>]*:?XAddr>/i);
                if (xaddrMatch) {
                    this.log.debug(`ONVIF ${this.host}: event service XAddr = ${xaddrMatch[1]}`);
                    return xaddrMatch[1].trim();
                }
            }

            // Fallback: any XAddr with /event in path
            const anyXAddr = res.body.match(/<[^:>]*:?XAddr[^>]*>\s*(https?:\/\/[^<\s]*event[^<\s]*)\s*<\/[^:>]*:?XAddr>/i);
            if (anyXAddr) return anyXAddr[1].trim();

        } catch (e) {
            this.log.debug(`ONVIF ${this.host}: GetCapabilities failed — ${e.message}`);
        }
        return null;
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

        // SOAP Fault = camera rejected the request (wrong URL or unsupported)
        if (res.status >= 400 || res.body.includes('Fault>')) {
            const faultMatch = res.body.match(/<faultstring[^>]*>([^<]+)<\/faultstring>/i)
                || res.body.match(/<faultcode[^>]*>([^<]+)<\/faultcode>/i);
            const msg = faultMatch ? faultMatch[1].trim() : `HTTP ${res.status}`;
            throw new Error(`SOAP Fault: ${msg}`);
        }

        // Extract subscription URL — Reolink may return it in several ways:
        // 1. <SubscriptionReference><Address>http://...</Address></SubscriptionReference>
        // 2. <wsa:Address>http://...</wsa:Address> anywhere in response
        // 3. Relative path like /onvif/pullpoint/...
        let subscriptionUrl = null;

        // Try SubscriptionReference block first (all Address tags inside it)
        const subRefMatch = res.body.match(/<[^:>]*:?SubscriptionReference[^>]*>([\s\S]*?)<\/[^:>]*:?SubscriptionReference>/i);
        if (subRefMatch) {
            const addrMatch = subRefMatch[1].match(/<[^:>]*:?Address[^>]*>\s*([^<\s]+)\s*<\/[^:>]*:?Address>/i);
            if (addrMatch) subscriptionUrl = addrMatch[1].trim();
        }

        // Fallback: first http(s) Address tag anywhere in body
        if (!subscriptionUrl) {
            const anyAddr = res.body.match(/<[^:>]*:?Address[^>]*>\s*(https?:\/\/[^<\s]+)\s*<\/[^:>]*:?Address>/i);
            if (anyAddr) subscriptionUrl = anyAddr[1].trim();
        }

        // Fallback: relative path in Address tag
        if (!subscriptionUrl) {
            const relAddr = res.body.match(/<[^:>]*:?Address[^>]*>\s*(\/[^<\s]+)\s*<\/[^:>]*:?Address>/i);
            if (relAddr) subscriptionUrl = `${this._baseUrl}${relAddr[1].trim()}`;
        }

        // No URL found — use event_service as last resort
        if (!subscriptionUrl) {
            subscriptionUrl = this._eventServiceUrl;
        }

        this._subscriptionUrl = subscriptionUrl;

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
