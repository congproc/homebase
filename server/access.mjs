// Who may use the dashboard API. Two ways in, both bound to the connecting peer rather than to headers alone:
//  - Local: a loopback Host, and the TCP peer is a process owned by the same Unix user as Homebase.
//  - Tailnet: the configured https://<host>.ts.net origin, the peer is tailscaled (root) or the owner, and
//    Tailscale Serve's identity header names the authorized login.
// Every other local account (service users, host-network containers) is refused, even with a forged Host.
import {readFile} from 'node:fs/promises';
import {config} from './config.mjs';

const PORT = config.port;
const localHosts = new Set([...new Set([PORT, 5173])].flatMap(p => [`localhost:${p}`, `127.0.0.1:${p}`]));
const localOrigins = new Set([...localHosts].map(host => 'http://' + host));
const SELF_UID = typeof process.getuid === 'function' ? process.getuid() : -1;

/**
 * Owning uid of the client end of a loopback TCP connection (Linux /proc/net/tcp{,6}).
 * Returns null when it cannot be determined, which callers treat as "deny".
 */
export async function peerUid(socket) {
  if (!socket?.remotePort || !socket.localPort) return null;
  const client = ':' + socket.remotePort.toString(16).toUpperCase().padStart(4, '0');
  const server = ':' + socket.localPort.toString(16).toUpperCase().padStart(4, '0');
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const text = await readFile(table, 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      const c = line.trim().split(/\s+/);
      // Client row: local address = client port, remote address = our listening port.
      if (c.length > 7 && c[1].endsWith(client) && c[2].endsWith(server)) return Number(c[7]);
    }
  }
  return null;
}

/** Peer uid for a request, cached on the socket so keep-alive connections are looked up once. */
const UID = Symbol('homebase.peerUid');
export function socketUid(socket) {
  return (socket[UID] ??= peerUid(socket));
}

export function requestAccess(headers, {
  uid,
  selfUid = SELF_UID,
  remoteOrigin = config.tailscale.origin,
  owner = config.tailscale.login,
} = {}) {
  const host = headers.host || '';
  const origin = headers.origin;
  let remoteHost;
  if (remoteOrigin) { try { const u = new URL(remoteOrigin); if (u.protocol === 'https:' && u.origin === remoteOrigin && u.hostname.endsWith('.ts.net')) remoteHost = u.host; } catch {} }
  const remote = !!remoteHost && host === remoteHost;
  if (!localHosts.has(host) && !remote) return {allowed: false, error: 'Unrecognized dashboard host'};
  if (!Number.isInteger(uid) || uid < 0) return {allowed: false, error: 'Unable to verify the connecting user'};
  if (remote) {
    // Serve traffic arrives from tailscaled (root). Anything else claiming the tailnet host is refused.
    if (uid !== 0 && uid !== selfUid) return {allowed: false, error: 'Access requires your authorized Tailscale account'};
    if (!owner || headers['tailscale-user-login'] !== owner) return {allowed: false, error: 'Access requires your authorized Tailscale account'};
  } else if (uid !== selfUid) {
    // Includes root/tailscaled: a proxied request carrying a loopback Host must not skip the identity check.
    return {allowed: false, error: 'Only the account running Homebase can use this dashboard'};
  }
  if (origin && !localOrigins.has(origin) && !(remote && origin === remoteOrigin)) return {allowed: false, error: 'Origin denied'};
  return {allowed: true};
}
