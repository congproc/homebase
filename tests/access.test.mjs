import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {requestAccess, peerUid} from '../server/access.mjs';

const origin = 'https://server.example.ts.net:8443', owner = 'owner@example.com', SELF = 1000;
const check = (headers, uid = SELF) => requestAccess(headers, {uid, selfUid: SELF, remoteOrigin: origin, owner}).allowed;
const tailnet = {host: 'server.example.ts.net:8443', origin, 'tailscale-user-login': owner};

test('the owner account can use the dashboard on loopback', () => assert.equal(check({host: '127.0.0.1:8787'}), true));
test('other local accounts are refused even with a loopback Host', () => {
  for (const uid of [0, 113, 65534]) assert.equal(check({host: '127.0.0.1:8787'}, uid), false);
});
test('a peer whose account cannot be determined is refused', () => {
  for (const uid of [null, undefined, -1]) assert.equal(requestAccess({host: '127.0.0.1:8787'}, {uid, selfUid: SELF, remoteOrigin: origin, owner}).allowed, false);
});
test('authorized Tailscale identity via tailscaled (root) can use the dashboard', () => assert.equal(check(tailnet, 0), true));
test('unidentified or other tailnet users are rejected', () => {
  for (const login of [undefined, 'other@example.com']) assert.equal(check({...tailnet, 'tailscale-user-login': login}, 0), false);
});
test('a Serve-proxied request carrying a loopback Host cannot skip the identity check', () => {
  assert.equal(check({host: '127.0.0.1:8787'}, 0), false);
  assert.equal(check({host: 'localhost:8787', 'tailscale-user-login': 'other@example.com'}, 0), false);
});
test('another local account cannot claim the tailnet host and forge the identity header', () => assert.equal(check(tailnet, 113), false));
test('wrong host and public finance port are rejected', () => {
  for (const host of ['evil.example', 'server.example.ts.net', 'server.example.ts.net:443']) assert.equal(check({host, 'tailscale-user-login': owner}, 0), false);
});
test('cross-origin requests are rejected', () => {
  assert.equal(check({host: 'server.example.ts.net:8443', origin: 'https://evil.example', 'tailscale-user-login': owner}, 0), false);
  assert.equal(check({host: '127.0.0.1:8787', origin}), false);
});
test('unconfigured remote access fails closed', () =>
  assert.equal(requestAccess({host: 'server.example.ts.net:8443'}, {uid: 0, selfUid: SELF}).allowed, false));

test('peerUid resolves the connecting process owner on loopback', async () => {
  const server = http.createServer(async (req, res) => res.end(String(await peerUid(req.socket))));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const body = await fetch(`http://127.0.0.1:${server.address().port}/`).then(r => r.text());
    assert.equal(Number(body), process.getuid());
  } finally { server.close(); }
});
