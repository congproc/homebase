// Local (LAN) client for TP-Link Tapo smart plugs with energy monitoring (P110, P110M, P115, ...).
// Speaks the KLAP v2 protocol the plugs use on port 80: a two-step seed handshake proves both sides know
// sha256(sha1(email) + sha1(password)), then every request is AES-128-CBC encrypted and signed with keys
// derived from both seeds. Nothing leaves the LAN, and the Tapo cloud is never contacted.
// Newer firmware answers only when "Third-Party Compatibility" is on (Tapo app → Me → Third-Party Services).
import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';
import http from 'node:http';

const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
const sha1 = s => createHash('sha1').update(s, 'utf8').digest();

/** Credential proof shared with the plug (KLAP v2). */
export const authHash = (email, password) => sha256(sha1(email), sha1(password));

/** Per-session AES key, IV prefix, starting sequence number and signing key, derived from both seeds. */
export function deriveSession(localSeed, remoteSeed, auth) {
  const base = Buffer.concat([localSeed, remoteSeed, auth]);
  const iv = sha256(Buffer.from('iv'), base);
  return {key: sha256(Buffer.from('lsk'), base).subarray(0, 16), ivPrefix: iv.subarray(0, 12), seq: iv.readInt32BE(28), sig: sha256(Buffer.from('ldk'), base).subarray(0, 28)};
}

const seqBytes = seq => { const b = Buffer.alloc(4); b.writeInt32BE(seq); return b; };

/** Encrypts one request with sequence number `seq`: 32-byte signature followed by the ciphertext. */
export function encrypt(session, seq, text) {
  const c = createCipheriv('aes-128-cbc', session.key, Buffer.concat([session.ivPrefix, seqBytes(seq)]));
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([sha256(session.sig, seqBytes(seq), body), body]);
}

export function decrypt(session, seq, data) {
  if (data.length < 48) throw Error('Short reply from the plug');
  const d = createDecipheriv('aes-128-cbc', session.key, Buffer.concat([session.ivPrefix, seqBytes(seq)]));
  return Buffer.concat([d.update(data.subarray(32)), d.final()]).toString('utf8');
}

const SESSION_ERRORS = new Set([-1012, 9999, -1301]); // session expired / invalid: handshake again
const ERRORS = {'-1501': 'The plug rejected the email or password', '-1008': 'The plug did not accept the request', '-1002': 'The plug did not understand the request'};

export class TapoClient {
  constructor({host, email, password, timeout = 4000}) {
    if (!host || !email || !password) throw Error('Tapo host, email and password are required');
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw Error('Invalid Tapo host');
    this.host = host;
    this.auth = authHash(email, password);
    this.timeout = timeout;
    this.session = null; // {key, ivPrefix, seq, sig, cookie, expires}
    this.queue = Promise.resolve(); // requests are serialized: each one advances the shared sequence number
  }

  // node:http rather than fetch: the plug's embedded server answers HTTP 400 to the extra headers fetch always adds.
  post(path, body, cookie) {
    return new Promise((resolve, reject) => {
      const req = http.request({host: this.host, port: 80, path, method: 'POST', timeout: this.timeout, agent: false,
        headers: {'Content-Length': body.length, ...(cookie ? {Cookie: cookie} : {})}}, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({status: res.statusCode, data: Buffer.concat(chunks), cookie: [res.headers['set-cookie'] || []].flat().join('; ')}));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(Error('The plug did not answer in time')));
      req.on('error', e => reject(e.code === 'EHOSTUNREACH' || e.code === 'ECONNREFUSED' ? Error(`Cannot reach the plug at ${this.host}`) : e));
      req.end(body);
    });
  }

  async handshake() {
    this.session = null;
    const localSeed = randomBytes(16);
    const h1 = await this.post('/app/handshake1', localSeed);
    if (h1.status !== 200 || h1.data.length !== 48) throw Error(`The plug refused the connection (HTTP ${h1.status}). Is Third-Party Compatibility on in the Tapo app?`);
    const cookie = /TP_SESSIONID=[^;]+/.exec(h1.cookie || '')?.[0];
    const timeout = Number(/TIMEOUT=(\d+)/.exec(h1.cookie || '')?.[1]) || 86400;
    const remoteSeed = h1.data.subarray(0, 16), serverHash = h1.data.subarray(16);
    if (!sha256(localSeed, remoteSeed, this.auth).equals(serverHash))
      throw Error('Wrong Tapo email or password (use the Tapo account the plug is registered to)');
    const h2 = await this.post('/app/handshake2', sha256(remoteSeed, localSeed, this.auth), cookie);
    if (h2.status !== 200) throw Error(`The plug rejected the login (HTTP ${h2.status})`);
    // Renew a little before the plug forgets the session.
    this.session = {...deriveSession(localSeed, remoteSeed, this.auth), cookie, expires: Date.now() + Math.max(60, timeout - 300) * 1000};
  }

  /** Sends one {method, params} request and returns its `result`. Re-authenticates once if the session lapsed. */
  request(method, params) {
    const run = this.queue.then(() => this.send(method, params, true));
    this.queue = run.catch(() => {});
    return run;
  }

  async send(method, params, retry) {
    if (!this.session || Date.now() > this.session.expires) await this.handshake();
    const s = this.session;
    s.seq = (s.seq + 1) | 0;
    const seq = s.seq;
    const r = await this.post(`/app/request?seq=${seq}`, encrypt(s, seq, JSON.stringify(params === undefined ? {method} : {method, params})), s.cookie);
    if (r.status !== 200) {
      this.session = null;
      if (retry) return this.send(method, params, false);
      throw Error(`The plug answered HTTP ${r.status}`);
    }
    const reply = JSON.parse(decrypt(s, seq, r.data));
    if (reply.error_code !== 0) {
      if (SESSION_ERRORS.has(reply.error_code) && retry) { this.session = null; return this.send(method, params, false); }
      throw Error(ERRORS[reply.error_code] || `The plug returned error ${reply.error_code} for ${method}`);
    }
    return reply.result ?? {};
  }
}
