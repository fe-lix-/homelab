// Run: npx ts-node debug-decrypt.ts
import { getPlaybackInfo } from './src/services/joyn';
import { resolveDecryptionKeys } from './src/services/widevine';
import { downloadHls } from './src/downloader/ffmpeg';

// Set BRIGHTDATA_PROXY_URL in your environment before running:
//   export BRIGHTDATA_PROXY_URL='socks5://user:pass@host:port'

const VIDEO_ID = 'a_p1l5d4k4jwb'; // Metal Detective S4E5
const OUT_PATH = '/tmp/joyn-debug-full.mkv';

async function main() {
  console.log('[1] Getting playback info...');
  const info = await getPlaybackInfo(VIDEO_ID);
  if (!info) { console.error('FAILED: no playback info'); process.exit(1); }
  console.log('    manifest:', info.manifestUrl.slice(0, 80) + '...');

  console.log('\n[2] Fetching Widevine keys...');
  const keys = await resolveDecryptionKeys(info.manifestUrl, info.licenseUrl!);
  if (!keys?.length) { console.error('FAILED: no keys'); process.exit(1); }
  const keyPairs = keys.map(k => `${k.kid}:${k.key}`);
  console.log('    Keys:', keyPairs);

  console.log('\n[3] Downloading + decrypting → ' + OUT_PATH);
  await downloadHls(info.manifestUrl, OUT_PATH, info.licenseUrl, info.certificateUrl, keyPairs);

  console.log('\nDone. Open in VLC: open ' + OUT_PATH);
}

main().catch(e => { console.error(e); process.exit(1); });
