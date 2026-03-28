import { fetch } from 'undici';

// pywidevine RemoteCDM endpoint (cdrm-project.com hosts a public one)
const REMOTE_CDM_HOST = process.env.REMOTE_CDM_HOST ?? 'https://cdrm-project.com/remotecdm/widevine';
const REMOTE_CDM_SECRET = process.env.REMOTE_CDM_SECRET ?? 'CDRM';
const REMOTE_CDM_DEVICE = process.env.REMOTE_CDM_DEVICE ?? 'public';

function timestamp(): string {
  return new Date().toISOString();
}

function cdmUrl(path: string): string {
  return `${REMOTE_CDM_HOST}/${REMOTE_CDM_DEVICE}${path}`;
}

function cdmHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Secret-Key': REMOTE_CDM_SECRET,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  };
}

/**
 * Fetch an HLS master manifest and extract the Widevine PSSH (base64).
 * Looks for an EXT-X-SESSION-KEY / EXT-X-KEY line with the Widevine UUID
 * keyformat and a data: URI containing the PSSH.
 */
export async function getPsshFromManifest(manifestUrl: string): Promise<string | null> {
  const response = await fetch(manifestUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
  });
  if (!response.ok) throw new Error(`Failed to fetch manifest: HTTP ${response.status}`);

  const text = await response.text();

  for (const line of text.split('\n')) {
    // Widevine UUID: edef8ba9-79d6-4ace-a3c8-27dcd51d21ed
    if (!line.includes('KEYFORMAT="urn:uuid:edef8ba9')) continue;
    const m = line.match(/URI="data:text\/plain;base64,([^"]+)"/);
    if (m) return m[1];
  }

  return null;
}

export interface ContentKey {
  kid: string;
  key: string;
}

/**
 * Obtain Widevine content keys using a pywidevine-compatible RemoteCDM server.
 *
 * Actual API paths (traced from pywidevine's RemoteCdm class):
 *   GET  /{device}/open
 *   POST /{device}/get_license_challenge/STREAMING  body: { session_id, init_data, privacy_mode }
 *   POST /{device}/parse_license                    body: { session_id, license_message }
 *   POST /{device}/get_keys/ALL                     body: { session_id }
 *   GET  /{device}/close/{session_id}
 */
async function attemptGetContentKeys(pssh: string, licenseUrl: string): Promise<ContentKey[]> {
  // --- 1. Open session ---
  const openResp = await fetch(cdmUrl('/open'), {
    method: 'GET',
    headers: cdmHeaders(),
  });
  if (!openResp.ok) {
    const body = await openResp.text().catch(() => '');
    throw new Error(`RemoteCDM /open failed HTTP ${openResp.status}: ${body.slice(0, 200)}`);
  }
  const openData = await openResp.json() as { data: { session_id: string } };
  const sessionId = openData.data.session_id;
  console.log(`[${timestamp()}] [Widevine] Session: ${sessionId}`);

  try {
    // Note: set_service_certificate is deliberately skipped — cdrm-project.com's server
    // invalidates the session if that endpoint is called.

    // --- 2. Get license challenge ---
    const challengeResp = await fetch(cdmUrl('/get_license_challenge/STREAMING'), {
      method: 'POST',
      headers: cdmHeaders(),
      body: JSON.stringify({ session_id: sessionId, init_data: pssh, privacy_mode: false }),
    });
    if (!challengeResp.ok) {
      const body = await challengeResp.text().catch(() => '');
      throw new Error(`RemoteCDM challenge failed HTTP ${challengeResp.status}: ${body.slice(0, 200)}`);
    }
    const { data: challengeData } = await challengeResp.json() as { data: { challenge_b64: string } };
    const challengeBytes = Buffer.from(challengeData.challenge_b64, 'base64');
    console.log(`[${timestamp()}] [Widevine] Challenge generated (${challengeBytes.length} bytes)`);

    // --- 3. POST challenge to Joyn license server ---
    const licResp = await fetch(licenseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Origin': 'https://www.joyn.de',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      body: challengeBytes,
    });
    if (!licResp.ok) {
      const body = await licResp.text().catch(() => '');
      throw new Error(`Joyn license server failed HTTP ${licResp.status}: ${body.slice(0, 200)}`);
    }
    const licenseBytes = await licResp.arrayBuffer();
    const licenseB64 = Buffer.from(licenseBytes).toString('base64');
    console.log(`[${timestamp()}] [Widevine] License response received (${licenseBytes.byteLength} bytes)`);

    // --- 4. Parse license ---
    const parseResp = await fetch(cdmUrl('/parse_license'), {
      method: 'POST',
      headers: cdmHeaders(),
      body: JSON.stringify({ session_id: sessionId, license_message: licenseB64 }),
    });
    if (!parseResp.ok) {
      const body = await parseResp.text().catch(() => '');
      throw new Error(`RemoteCDM parse_license failed HTTP ${parseResp.status}: ${body.slice(0, 200)}`);
    }

    // --- 5. Get content keys ---
    const keysResp = await fetch(cdmUrl('/get_keys/ALL'), {
      method: 'POST',
      headers: cdmHeaders(),
      body: JSON.stringify({ session_id: sessionId }),
    });
    if (!keysResp.ok) {
      const body = await keysResp.text().catch(() => '');
      throw new Error(`RemoteCDM get_keys failed HTTP ${keysResp.status}: ${body.slice(0, 200)}`);
    }
    const { data: keysData } = await keysResp.json() as {
      data: { keys: Array<{ key_id: string; key: string; type: string }> }
    };

    const contentKeys = keysData.keys
      .filter(k => k.type === 'CONTENT' && k.key_id && k.key)
      .map(k => ({ kid: k.key_id.replace(/-/g, ''), key: k.key }));

    console.log(`[${timestamp()}] [Widevine] Got ${contentKeys.length} content key(s):`);
    for (const k of contentKeys) {
      console.log(`[${timestamp()}] [Widevine]   ${k.kid}:${k.key}`);
    }

    return contentKeys;
  } finally {
    // Always close the session
    await fetch(cdmUrl(`/close/${sessionId}`), {
      method: 'GET',
      headers: cdmHeaders(),
    }).catch(() => { /* ignore close errors */ });
  }
}

export async function getContentKeys(
  pssh: string,
  licenseUrl: string,
  maxAttempts = 3,
): Promise<ContentKey[]> {
  console.log(`[${timestamp()}] [Widevine] Opening RemoteCDM session at ${REMOTE_CDM_HOST}...`);

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await attemptGetContentKeys(pssh, licenseUrl);
    } catch (err) {
      lastError = err as Error;
      const isInvalidSession = lastError.message.includes('Invalid Session ID') ||
        lastError.message.includes('expired');
      if (isInvalidSession && attempt < maxAttempts) {
        console.warn(`[${timestamp()}] [Widevine] Session invalid (attempt ${attempt}/${maxAttempts}), retrying...`);
        await new Promise(r => setTimeout(r, 500 * attempt));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError!;
}

/**
 * High-level helper: fetch PSSH from manifest, then get content keys via RemoteCDM.
 * Returns null if no PSSH found (stream is unencrypted).
 */
export async function resolveDecryptionKeys(
  manifestUrl: string,
  licenseUrl: string,
): Promise<ContentKey[] | null> {
  console.log(`[${timestamp()}] [Widevine] Extracting PSSH from manifest...`);
  const pssh = await getPsshFromManifest(manifestUrl);

  if (!pssh) {
    console.warn(`[${timestamp()}] [Widevine] No Widevine PSSH found in manifest — stream may be unencrypted`);
    return null;
  }

  console.log(`[${timestamp()}] [Widevine] PSSH: ${pssh.slice(0, 40)}...`);
  return getContentKeys(pssh, licenseUrl);
}
