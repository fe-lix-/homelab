// Run: npx ts-node test-proxy-auth.ts
// (BRIGHTDATA_PROXY_URL is set programmatically below, before any auth calls)

import { getLatestEpisodes, getPlaybackInfo } from './src/services/joyn';
import { resolveDecryptionKeys } from './src/services/widevine';
import { downloadHls } from './src/downloader/ffmpeg';
import * as fs from 'fs';

// Set BRIGHTDATA_PROXY_URL in your environment before running:
//   export BRIGHTDATA_PROXY_URL='socks5://user:pass@host:port'

function step(n: number, msg: string) {
  console.log(`\n[Step ${n}] ${msg}`);
}

async function main() {
  step(1, 'Fetching latest episodes from Joyn GraphQL...');
  const episodes = await getLatestEpisodes(10);
  console.log(`  Found ${episodes.length} episodes`);

  const ep = episodes.find(e => e.streamUrl?.startsWith('joyn-vod://'));
  if (!ep) {
    console.error('  No episode with joyn-vod:// stream URL found. Cannot test auth.');
    process.exit(1);
  }

  const videoId = ep.streamUrl!.slice('joyn-vod://'.length);
  console.log(`  Using: "${ep.showTitle}" S${ep.season}E${ep.episode} — ${ep.title}`);
  console.log(`  Video ID: ${videoId}`);

  step(2, 'Resolving playback URLs via 3-step auth (using SOCKS5 proxy for auth)...');
  const info = await getPlaybackInfo(videoId);
  if (!info) {
    console.error('  FAILED: getPlaybackInfo returned null. Check proxy or entitlement.');
    process.exit(1);
  }
  console.log(`  manifestUrl:    ${info.manifestUrl.slice(0, 80)}...`);
  console.log(`  licenseUrl:     ${info.licenseUrl?.slice(0, 80)}...`);
  console.log(`  certificateUrl: ${info.certificateUrl}`);
  const m3u8Url = info.manifestUrl;

  step(3, 'Fetching Widevine decryption keys via cdrm-project.com...');
  let decryptionKeys: string[] | undefined;
  if (info.licenseUrl) {
    const keys = await resolveDecryptionKeys(m3u8Url, info.licenseUrl);
    if (keys?.length) {
      decryptionKeys = keys.map(k => `${k.kid}:${k.key}`);
      console.log(`  Got ${decryptionKeys.length} key(s): ${decryptionKeys.join(', ')}`);
    } else {
      console.warn('  No keys returned — stream may be unencrypted or key fetch failed');
    }
  } else {
    console.log('  No licenseUrl — skipping key fetch');
  }

  step(4, 'Downloading 30-second clip via ffmpeg to /tmp/joyn-test.mkv...');
  const outPath = '/tmp/joyn-test.mkv';
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

  await downloadHls(m3u8Url, outPath, info.licenseUrl, info.certificateUrl, decryptionKeys);

  const sizeKb = Math.round(fs.statSync(outPath).size / 1024);
  console.log(`  Downloaded: ${outPath} (${sizeKb} KB)`);
  console.log('\n=== ALL STEPS PASSED ===\n');
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
