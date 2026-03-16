'use strict';

/**
 * Reolink camera auto-discovery via ONVIF WS-Discovery (UDP multicast).
 * No external dependencies — uses Node.js built-in dgram module.
 *
 * Sends a WS-Discovery Probe to 239.255.255.250:3702 and collects
 * ProbeMatch responses. Then probes each found IP for Reolink API
 * to confirm it is a Reolink device and get model info.
 */

const dgram = require('dgram');
const http = require('http');
const https = require('https');
const { randomUUID } = require('crypto');

/**
 * Send ONVIF WS-Discovery probe and collect camera IPs.
 * @param {number} [timeoutMs=4000]
 * @returns {Promise<Array<{ip:string, port:number, onvifUrl:string}>>}
 */
function probeOnvif(timeoutMs = 4000) {
    return new Promise((resolve) => {
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        const found = new Map();

        const probe = `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
            xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
            xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>uuid:${randomUUID()}</w:MessageID>
    <w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body>
    <d:Probe>
      <d:Types>dn:NetworkVideoTransmitter</d:Types>
    </d:Probe>
  </e:Body>
</e:Envelope>`;

        socket.on('error', () => { /* ignore socket errors */ });

        socket.on('message', (msg, rinfo) => {
            const text = msg.toString();

            // Extract XAddrs (ONVIF service URL) from ProbeMatch
            const xaddrMatch = text.match(/<[^:>]*:?XAddrs[^>]*>\s*([^<]+)\s*<\/[^:>]*:?XAddrs>/i);
            if (xaddrMatch) {
                const urls = xaddrMatch[1].trim().split(/\s+/);
                for (const url of urls) {
                    try {
                        const parsed = new URL(url);
                        const ip = parsed.hostname;
                        if (!found.has(ip)) {
                            found.set(ip, {
                                ip,
                                port: parseInt(parsed.port, 10) || 80,
                                onvifUrl: url,
                            });
                        }
                    } catch (_) { /* ignore malformed URLs */ }
                }
            }

            // Also register source IP even if XAddrs parsing fails
            if (!found.has(rinfo.address)) {
                found.set(rinfo.address, {
                    ip: rinfo.address,
                    port: 80,
                    onvifUrl: null,
                });
            }
        });

        socket.bind(0, () => {
            try {
                socket.setMulticastTTL(4);
                socket.addMembership('239.255.255.250');
            } catch (_) { /* ignore if multicast not available */ }

            const buf = Buffer.from(probe, 'utf8');
            socket.send(buf, 0, buf.length, 3702, '239.255.255.250', (err) => {
                if (err) {
                    // Also try broadcast as fallback
                    socket.setBroadcast(true);
                    socket.send(buf, 0, buf.length, 3702, '255.255.255.255');
                }
            });
        });

        setTimeout(() => {
            try { socket.close(); } catch (_) { /* ignore */ }
            resolve(Array.from(found.values()));
        }, timeoutMs);
    });
}

/**
 * Try to identify a found IP as a Reolink camera by calling the Reolink HTTP API.
 * @param {string} ip
 * @param {number} port
 * @param {boolean} useHttps
 * @returns {Promise<{ip:string, port:number, model:string, name:string, firmware:string}|null>}
 */
function probeReolink(ip, port, useHttps = false) {
    return new Promise((resolve) => {
        const protocol = useHttps ? https : http;
        const url = `${useHttps ? 'https' : 'http'}://${ip}:${port}/api.cgi?cmd=GetDevInfo&user=&password=`;

        const body = JSON.stringify([{ cmd: 'GetDevInfo', action: 0, param: {} }]);

        const req = protocol.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 2000,
            rejectUnauthorized: false,
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    const devInfo = arr[0]?.value?.DevInfo || arr[0]?.DevInfo;
                    if (devInfo) {
                        resolve({
                            ip,
                            port,
                            model: devInfo.model || 'Reolink',
                            name: devInfo.name || ip,
                            firmware: devInfo.firmVer || '',
                            serial: devInfo.serial || '',
                        });
                    } else {
                        resolve(null);
                    }
                } catch (_) {
                    resolve(null);
                }
            });
        });

        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(body);
        req.end();
    });
}

/**
 * Discover Reolink cameras on the local network.
 * 1. ONVIF WS-Discovery probe (UDP multicast)
 * 2. Probe each found IP for Reolink API
 *
 * @param {object} options
 * @param {number} [options.timeoutMs=5000]  Total discovery timeout
 * @param {Function} [options.log]           Logger (optional)
 * @returns {Promise<Array>}  Array of found camera descriptors
 */
async function discoverReolinkCameras({ timeoutMs = 5000, log } = {}) {
    if (log) log.debug('Starting ONVIF WS-Discovery probe...');

    const candidates = await probeOnvif(Math.min(timeoutMs - 1000, 4000));

    if (log) log.debug(`ONVIF found ${candidates.length} device(s): ${candidates.map(c => c.ip).join(', ')}`);

    const cameras = [];
    const probes = candidates.map(async (c) => {
        // Try HTTP first, then HTTPS
        let info = await probeReolink(c.ip, c.port || 80, false);
        if (!info && c.port !== 443) {
            info = await probeReolink(c.ip, 443, true);
        }
        if (info) {
            cameras.push({ ...info, onvifUrl: c.onvifUrl });
            if (log) log.info(`Discovered: ${info.model} "${info.name}" at ${info.ip}:${info.port}`);
        }
    });

    await Promise.allSettled(probes);
    return cameras;
}

module.exports = { discoverReolinkCameras };
