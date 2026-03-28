// Set BRIGHTDATA_PROXY_URL in your environment before running:
//   export BRIGHTDATA_PROXY_URL='socks5://user:pass@host:port'

import { getLatestEpisodes } from './src/services/joyn';
import { fetch } from 'undici';
import { SocksClient } from 'socks';
import { Agent, buildConnector } from 'undici';
import * as tls from 'tls';
import { randomUUID } from 'crypto';

function parseSocksUrl(proxyUrl: string) {
  const withoutScheme = proxyUrl.replace(/^socks5?:\/\//, '');
  const lastAt = withoutScheme.lastIndexOf('@');
  const hostPort = withoutScheme.slice(lastAt + 1);
  const userInfo = withoutScheme.slice(0, lastAt);
  const portIdx = hostPort.lastIndexOf(':');
  return {
    host: hostPort.slice(0, portIdx),
    port: parseInt(hostPort.slice(portIdx + 1), 10),
    username: userInfo.slice(0, userInfo.indexOf(':')),
    password: userInfo.slice(userInfo.indexOf(':') + 1),
  };
}

function createSocksAgent(proxyUrl: string): Agent {
  const { host: proxyHost, port: proxyPort, username, password } = parseSocksUrl(proxyUrl);
  const connector: buildConnector.connector = (options, callback) => {
    const destPort = parseInt(options.port, 10) || (options.protocol === 'https:' ? 443 : 80);
    SocksClient.createConnection({
      proxy: { host: proxyHost, port: proxyPort, type: 5, userId: username, password },
      command: 'connect',
      destination: { host: options.hostname, port: destPort },
    }).then(({ socket }) => {
      if (options.protocol !== 'https:') { callback(null, socket); return; }
      const tlsSocket = tls.connect({ socket, servername: options.servername ?? options.hostname });
      tlsSocket.once('secureConnect', () => callback(null, tlsSocket));
      tlsSocket.once('error', err => callback(err, null));
    }).catch(err => callback(err, null));
  };
  return new Agent({ connect: connector });
}

async function getTokens(videoId: string) {
  const dispatcher = createSocksAgent(process.env.BRIGHTDATA_PROXY_URL!);
  const deviceId = randomUUID();

  const authResp = await fetch('https://auth.joyn.de/auth/anonymous', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.joyn.de' },
    body: JSON.stringify({ client_id: deviceId, client_name: 'web', anon_device_id: deviceId }),
    dispatcher,
  });
  const { access_token } = await authResp.json() as { access_token: string };
  console.log('[1] Anon token:', access_token.slice(0, 40) + '...');

  const entResp = await fetch('https://entitlement.p7s1.io/api/user/entitlement-token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${access_token}`,
      'Joyn-Client-Version': '5.1457.0',
      'Joyn-Platform': 'web',
      'Origin': 'https://www.joyn.de',
    },
    body: JSON.stringify({ content_id: videoId, content_type: 'VOD' }),
    dispatcher,
  });
  const { entitlement_token } = await entResp.json() as { entitlement_token: string };
  const payload = JSON.parse(Buffer.from(entitlement_token.split('.')[1], 'base64').toString());
  console.log('[2] Entitlement token payload:', JSON.stringify(payload, null, 2));

  return { access_token, entitlement_token };
}

async function main() {
  const videoId = 'a_pt5fm8rzl3q'; // from previous test
  const { entitlement_token } = await getTokens(videoId);

  // KID from Widevine PSSH in the manifest (little-endian UUID hex)
  const kid = '1ad21e5a1b503087893be19e430c9132';
  const pssh = 'AAAAQ3Bzc2gAAAAA7e+LqXnWSs6jyCfc1R0h7QAAACMIARIQGtIeWhtQMIeJN7GeQwyRMiINYV9wdDVmbThyemwzcQ==';

  console.log('\n[3] Testing playlist variants...');
  const variants = [
    { label: 'no protectionSystem', body: { platform: 'browser', streamingFormat: 'hls', enableMultiAudio: true, enableSubtitles: true } },
    { label: 'platform=a1, wv', body: { platform: 'a1', streamingFormat: 'hls', protectionSystem: 'widevine', enableMultiAudio: true } },
    { label: 'dash+widevine', body: { platform: 'browser', streamingFormat: 'dash', protectionSystem: 'widevine', enableMultiAudio: true } },
  ];

  for (const { label, body } of variants) {
    const resp = await fetch(`https://api.vod-prd.s.joyn.de/v1/asset/${videoId}/playlist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${entitlement_token}`,
        'Origin': 'https://www.joyn.de',
      },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    console.log(`  [${label}] HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
}

main().catch(console.error);
