import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fetch } from 'undici';
import * as stream from 'stream';

const execFileAsync = promisify(execFile);

const FFMPEG_LINUX_URL =
  'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz';

let cachedFfmpegPath: string | null = null;
let cachedMp4DecryptPath: string | null | undefined = undefined;

function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Check whether a command exists in the system PATH.
 */
async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync(os.platform() === 'win32' ? 'where' : 'which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download and extract the static FFmpeg binary for Linux (amd64).
 */
async function downloadFfmpegLinux(destDir: string): Promise<string> {
  console.log(`[${timestamp()}] [FFmpeg] Downloading static FFmpeg from ${FFMPEG_LINUX_URL}...`);

  // Ensure destination directory exists
  fs.mkdirSync(destDir, { recursive: true });

  const tarPath = path.join(destDir, 'ffmpeg.tar.xz');

  // Stream download to file
  const response = await fetch(FFMPEG_LINUX_URL);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download FFmpeg: HTTP ${response.status}`);
  }

  const fileStream = fs.createWriteStream(tarPath);
  await stream.promises.pipeline(
    stream.Readable.fromWeb(response.body as Parameters<typeof stream.Readable.fromWeb>[0]),
    fileStream,
  );

  console.log(`[${timestamp()}] [FFmpeg] Extracting FFmpeg archive...`);

  // Extract the tar.xz — tar is available in all our supported Linux environments
  await execFileAsync('tar', ['-xJf', tarPath, '-C', destDir, '--strip-components=1', '--wildcards', '*/ffmpeg']);

  fs.unlinkSync(tarPath);

  const ffmpegBin = path.join(destDir, 'ffmpeg');
  if (!fs.existsSync(ffmpegBin)) {
    throw new Error(`FFmpeg binary not found at ${ffmpegBin} after extraction`);
  }

  fs.chmodSync(ffmpegBin, 0o755);
  console.log(`[${timestamp()}] [FFmpeg] FFmpeg installed at ${ffmpegBin}`);
  return ffmpegBin;
}

/**
 * Ensure FFmpeg is available. Checks (in order):
 *   1. Previously resolved path (in-memory cache)
 *   2. ./ffmpeg/ffmpeg relative to cwd
 *   3. System PATH
 *   4. Auto-download (Linux only)
 *
 * Returns the resolved path to the ffmpeg binary.
 */
export async function ensureFfmpeg(): Promise<string> {
  if (cachedFfmpegPath) return cachedFfmpegPath;

  const localPath = path.join(process.cwd(), 'ffmpeg', 'ffmpeg');
  if (fs.existsSync(localPath)) {
    console.log(`[${timestamp()}] [FFmpeg] Using local binary at ${localPath}`);
    cachedFfmpegPath = localPath;
    return localPath;
  }

  if (await commandExists('ffmpeg')) {
    console.log(`[${timestamp()}] [FFmpeg] Using system FFmpeg from PATH`);
    cachedFfmpegPath = 'ffmpeg';
    return 'ffmpeg';
  }

  const platform = os.platform();

  if (platform === 'darwin') {
    throw new Error(
      'FFmpeg not found. On macOS, install it via Homebrew: brew install ffmpeg'
    );
  }

  if (platform === 'win32') {
    console.warn(
      `[${timestamp()}] [FFmpeg] WARNING: Windows is not supported in Docker deployment. ` +
      'Please install FFmpeg manually and ensure it is in your PATH.'
    );
    throw new Error('FFmpeg not found on Windows. Please install FFmpeg and add it to PATH.');
  }

  // Linux: auto-download
  const ffmpegDir = path.join(process.cwd(), 'ffmpeg');
  const ffmpegBin = await downloadFfmpegLinux(ffmpegDir);
  cachedFfmpegPath = ffmpegBin;
  return ffmpegBin;
}

/**
 * Ensure mp4decrypt (from Bento4) is available.
 * Returns the path or null if not found (caller decides whether to throw).
 */
export async function ensureMp4Decrypt(): Promise<string | null> {
  if (cachedMp4DecryptPath !== undefined) return cachedMp4DecryptPath;

  if (await commandExists('mp4decrypt')) {
    cachedMp4DecryptPath = 'mp4decrypt';
    return 'mp4decrypt';
  }

  // Linux: check common Bento4 install paths
  for (const candidate of ['/usr/local/bin/mp4decrypt', '/usr/bin/mp4decrypt']) {
    if (fs.existsSync(candidate)) {
      cachedMp4DecryptPath = candidate;
      return candidate;
    }
  }

  cachedMp4DecryptPath = null;
  return null;
}

/**
 * Decrypt a CENC-encrypted MP4 file using mp4decrypt (Bento4).
 * @param keyPairs  Array of "KID:KEY" hex strings.
 */
async function mp4DecryptFile(
  inputPath: string,
  outputPath: string,
  keyPairs: string[],
): Promise<void> {
  const bin = await ensureMp4Decrypt();
  if (!bin) {
    throw new Error(
      'mp4decrypt not found. Install Bento4: brew install bento4 (macOS) or apt-get install bento4 (Linux)'
    );
  }

  const args: string[] = [];
  for (const pair of keyPairs) {
    args.push('--key', pair);
  }
  args.push(inputPath, outputPath);

  console.log(`[${timestamp()}] [mp4decrypt] Decrypting: ${path.basename(inputPath)}`);
  await execFileAsync(bin, args);
  console.log(`[${timestamp()}] [mp4decrypt] Done: ${path.basename(outputPath)}`);
}

/**
 * Run an ffmpeg command, capturing stderr. Resolves on exit code 0, rejects otherwise.
 */
function spawnFfmpeg(ffmpegBin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderrBuf.slice(-500)}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn FFmpeg: ${err.message}`));
    });
  });
}

// ─── Raw HLS segment downloader (CENC-safe) ──────────────────────────────────
// ffmpeg's HLS demuxer strips CENC encryption metadata (tenc/senc boxes) when
// muxing to MP4, making mp4decrypt unable to decrypt the output.
// Solution: download raw segment bytes and concatenate directly, preserving
// all CENC boxes so mp4decrypt can decrypt correctly.

const HLS_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0';

async function fetchBytes(url: string, retries = 3): Promise<Buffer> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': HLS_USER_AGENT } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return Buffer.from(await resp.arrayBuffer());
    } catch (err) {
      if (attempt === retries) throw new Error(`Segment fetch failed after ${retries} attempts (${url}): ${err}`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error('unreachable');
}

interface HlsVariantPlaylist {
  initUrl: string | null;
  segments: string[];
}

function resolveHlsUrl(base: string, relative: string): string {
  return new URL(relative, base).href;
}

async function parseVariantPlaylist(playlistUrl: string): Promise<HlsVariantPlaylist> {
  const resp = await fetch(playlistUrl, { headers: { 'User-Agent': HLS_USER_AGENT } });
  if (!resp.ok) throw new Error(`Failed to fetch variant playlist: HTTP ${resp.status}`);
  const text = await resp.text();

  let initUrl: string | null = null;
  const segments: string[] = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) initUrl = resolveHlsUrl(playlistUrl, m[1]);
    } else if (!line.startsWith('#')) {
      segments.push(resolveHlsUrl(playlistUrl, line));
    }
  }

  return { initUrl, segments };
}

async function parseMasterPlaylist(masterUrl: string): Promise<{ videoUrl: string; audioUrl: string | null }> {
  const resp = await fetch(masterUrl, { headers: { 'User-Agent': HLS_USER_AGENT } });
  if (!resp.ok) throw new Error(`Failed to fetch master playlist: HTTP ${resp.status}`);
  const text = await resp.text();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const audioUrls = new Map<string, string>(); // groupId → playlist URL
  const variants: Array<{ bandwidth: number; audioGroup?: string; url: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=AUDIO')) {
      const gm = line.match(/GROUP-ID="([^"]+)"/);
      const um = line.match(/URI="([^"]+)"/);
      if (gm && um && !audioUrls.has(gm[1])) {
        audioUrls.set(gm[1], resolveHlsUrl(masterUrl, um[1]));
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const bm = line.match(/BANDWIDTH=(\d+)/);
      const am = line.match(/AUDIO="([^"]+)"/);
      const next = lines[i + 1];
      if (next && !next.startsWith('#')) {
        variants.push({
          bandwidth: bm ? parseInt(bm[1]) : 0,
          audioGroup: am?.[1],
          url: resolveHlsUrl(masterUrl, next),
        });
      }
    }
  }

  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  const best = variants[0];
  if (!best) throw new Error('No variants found in master playlist');

  return {
    videoUrl: best.url,
    audioUrl: best.audioGroup ? (audioUrls.get(best.audioGroup) ?? null) : null,
  };
}

async function downloadPlaylistToFile(
  playlist: HlsVariantPlaylist,
  outputPath: string,
  label: string,
): Promise<void> {
  const output = fs.createWriteStream(outputPath);

  const writeChunk = (buf: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      if (!output.write(buf)) {
        output.once('drain', () => { output.removeListener('error', onError); resolve(); });
        output.once('error', onError);
      } else {
        resolve();
      }
    });

  try {
    if (playlist.initUrl) {
      await writeChunk(await fetchBytes(playlist.initUrl));
    }

    const total = playlist.segments.length;
    console.log(`[${timestamp()}] [HLS] ${label}: ${total} segments`);

    for (let i = 0; i < total; i++) {
      await writeChunk(await fetchBytes(playlist.segments[i]));
      if ((i + 1) % 100 === 0 || i + 1 === total) {
        console.log(`[${timestamp()}] [HLS] ${label}: ${i + 1}/${total}`);
      }
    }

    await new Promise<void>((resolve, reject) => output.end((err: Error | null | undefined) => err ? reject(err) : resolve()));
  } catch (err) {
    output.destroy();
    throw err;
  }
}

/**
 * Download an HLS stream (.m3u8) to an MKV file.
 *
 * If decryptionKeys are provided (KID:KEY hex pairs), the pipeline is:
 *   1. Raw segment download → preserves CENC tenc/senc boxes (video + audio separately)
 *   2. mp4decrypt → decrypt each track using content keys
 *   3. ffmpeg  → remux decrypted tracks → final .mkv with language metadata
 *
 * If no decryptionKeys, direct single-step ffmpeg download (clear stream).
 *
 * @param decryptionKeys  KID:KEY pairs (hex, no dashes). Falls back to JOYN_DECRYPTION_KEYS env var.
 */
export async function downloadHls(
  m3u8Url: string,
  outputPath: string,
  licenseUrl?: string,
  _certificateUrl?: string,
  decryptionKeys?: string[],
): Promise<void> {
  const ffmpegBin = await ensureFfmpeg();

  // Prefer explicitly passed keys; fall back to env var
  const envKeys = process.env.JOYN_DECRYPTION_KEYS
    ? process.env.JOYN_DECRYPTION_KEYS.split(',').map(k => k.trim()).filter(Boolean)
    : [];
  const resolvedKeys = decryptionKeys?.length ? decryptionKeys : envKeys;

  console.log(`[${timestamp()}] [FFmpeg] HLS download: ${path.basename(outputPath)}`);

  if (!resolvedKeys.length) {
    if (licenseUrl) {
      console.warn(
        `[${timestamp()}] [FFmpeg] Stream is Widevine-encrypted but no decryption keys available. ` +
        `License URL: ${licenseUrl.slice(0, 80)}...`
      );
    }
    // Direct download (unencrypted / best-effort)
    await spawnFfmpeg(ffmpegBin, [
      '-allowed_extensions', 'ALL',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data',
      '-i', m3u8Url,
      '-map', '0:v',
      '-map', '0:a',
      '-c', 'copy',
      '-metadata:s:v:0', 'language=ger',
      '-metadata:s:a:0', 'language=ger',
      '-y',
      outputPath,
    ]);
    console.log(`[${timestamp()}] [FFmpeg] HLS download complete: ${path.basename(outputPath)}`);
    return;
  }

  // CENC-encrypted path: raw segment download → mp4decrypt → remux
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'joynarr-'));
  const baseName = path.basename(outputPath);
  const videoEncPath = path.join(tmpDir, baseName + '.enc.video.mp4');
  const audioEncPath = path.join(tmpDir, baseName + '.enc.audio.mp4');
  const videoDecPath = path.join(tmpDir, baseName + '.dec.video.mp4');
  const audioDecPath = path.join(tmpDir, baseName + '.dec.audio.mp4');

  try {
    console.log(`[${timestamp()}] [HLS] Parsing manifest...`);
    const master = await parseMasterPlaylist(m3u8Url);
    const videoPlaylist = await parseVariantPlaylist(master.videoUrl);
    const audioPlaylist = master.audioUrl ? await parseVariantPlaylist(master.audioUrl) : null;

    // Download raw segments (preserves CENC senc/tenc boxes)
    await Promise.all([
      downloadPlaylistToFile(videoPlaylist, videoEncPath, 'video'),
      audioPlaylist
        ? downloadPlaylistToFile(audioPlaylist, audioEncPath, 'audio')
        : Promise.resolve(),
    ]);

    // Decrypt each track
    console.log(`[${timestamp()}] [HLS] Decrypting tracks...`);
    await mp4DecryptFile(videoEncPath, videoDecPath, resolvedKeys);
    if (audioPlaylist) {
      await mp4DecryptFile(audioEncPath, audioDecPath, resolvedKeys);
    }

    // Remux to final output with language metadata
    console.log(`[${timestamp()}] [FFmpeg] Remuxing to ${path.basename(outputPath)}...`);
    const hasAudio = audioPlaylist != null;
    await spawnFfmpeg(ffmpegBin, [
      '-i', videoDecPath,
      ...(hasAudio ? ['-i', audioDecPath] : []),
      '-map', '0:v',
      '-map', hasAudio ? '1:a' : '0:a',
      '-c', 'copy',
      '-metadata:s:v:0', 'language=ger',
      '-metadata:s:a:0', 'language=ger',
      '-y',
      outputPath,
    ]);

    console.log(`[${timestamp()}] [FFmpeg] HLS download complete: ${path.basename(outputPath)}`);
  } finally {
    for (const tmp of [videoEncPath, audioEncPath, videoDecPath, audioDecPath]) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
    try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
  }
}

/**
 * Convert an MP4 file to MKV, preserving all streams and tagging audio/video
 * tracks as German. The input file is NOT deleted by this function.
 */
export async function convertToMkv(inputPath: string, outputPath: string): Promise<void> {
  const ffmpegBin = await ensureFfmpeg();

  const args = [
    '-i', inputPath,
    '-map', '0:v',
    '-map', '0:a',
    '-c', 'copy',
    '-metadata:s:v:0', 'language=ger',
    '-metadata:s:a:0', 'language=ger',
    '-y', // overwrite output without asking
    outputPath,
  ];

  console.log(`[${timestamp()}] [FFmpeg] Converting: ${path.basename(inputPath)} → ${path.basename(outputPath)}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`[${timestamp()}] [FFmpeg] Conversion complete: ${path.basename(outputPath)}`);
        resolve();
      } else {
        const errSummary = stderrBuf.slice(-500); // last 500 chars of stderr
        reject(new Error(`FFmpeg exited with code ${code}: ${errSummary}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn FFmpeg: ${err.message}`));
    });
  });
}
