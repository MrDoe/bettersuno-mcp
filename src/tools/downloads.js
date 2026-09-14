import { writeFile, mkdir } from 'node:fs/promises';
import { createDecipheriv, createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { sunoClient } from '../suno-client.js';
import { getToken } from '../ws-bridge.js';
import { assertOwned } from '../auth.js';
import { config } from '../config.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

// S3/CDN download URLs are self-authenticating (presigned). Sending the Suno
// Bearer token to S3 makes it reject the request (HTTP 400 "only one auth
// mechanism allowed"), so only attach it for the Suno API host itself.
function authHeadersForUrl(url) {
  try {
    const host = new URL(url).hostname;
    const apiHost = new URL(config.apiBaseUrl).hostname;
    if (host === apiHost) {
      return { Authorization: `Bearer ${getToken()}` };
    }
  } catch { /* relative URL or unparsable — send no auth */ }
  return {};
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim() || 'untitled';
}

async function ensureDir(dir) {
  try {
    await mkdir(dir, { recursive: true });
  } catch {}
}

function getAudioUrlForFormat(song, format) {
  if (!song || !song.audio_url) return null;
  const requested = String(format || '').trim().toLowerCase();
  const originalUrl = String(song.audio_url || '').trim();
  if (!requested || !originalUrl) return originalUrl;

  const urlCandidates = [
    song.audio_url,
    song.stream_audio_url,
    song.song_path,
    song.metadata?.audio_url,
    song.metadata?.stream_audio_url,
    song.metadata?.song_path,
    song.meta?.audio_url,
    song.meta?.stream_audio_url,
    song.meta?.song_path,
  ].filter(Boolean);

  for (const candidate of urlCandidates) {
    const normalized = String(candidate || '').toLowerCase();
    if (requested === 'm4a' && normalized.includes('.m4a')) return candidate;
    if (requested === 'wav' && normalized.includes('.wav')) return candidate;
    if (requested === 'mp3' && normalized.includes('.mp3')) return candidate;
  }

  const queryIndex = originalUrl.indexOf('?');
  const base = queryIndex >= 0 ? originalUrl.slice(0, queryIndex) : originalUrl;
  const query = queryIndex >= 0 ? originalUrl.slice(queryIndex) : '';

  const converted = base.replace(/\.([a-z0-9]{2,5})$/i, `.${requested}`);
  if (converted !== base) {
    return converted + query;
  }

  if (!/\bformat=/i.test(originalUrl)) {
    return originalUrl + (originalUrl.includes('?') ? '&' : '?') + `format=${encodeURIComponent(requested)}`;
  }

  return originalUrl;
}

function inferAudioExtension(url, contentType, fallback) {
  const normalizedType = String(contentType || '').toLowerCase();
  if (normalizedType.includes('audio/wav') || normalizedType.includes('audio/x-wav') || normalizedType.includes('audio/wave')) return 'wav';
  if (normalizedType.includes('audio/mpeg') || normalizedType.includes('audio/mp3')) return 'mp3';
  if (normalizedType.includes('audio/mp4') || normalizedType.includes('audio/x-m4a')) return 'm4a';
  if (normalizedType.includes('audio/ogg')) return 'ogg';

  const normalizedUrl = String(url || '').split('?')[0].toLowerCase();
  const match = normalizedUrl.match(/\.([a-z0-9]{2,5})$/);
  if (match) return match[1];

  return String(fallback || 'm4a').toLowerCase();
}

function replaceFilenameExtension(filename, ext) {
  const clean = String(ext || '').trim().replace(/^\./, '').toLowerCase();
  if (!clean) return filename;
  return filename.replace(/\.[^./]+$/, `.${clean}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Suno's V6 web client no longer serves WAV by rewriting the CDN URL. It uses
// the generation endpoints instead:
//   POST /api/gen/{clip_id}/convert_wav/   -> 204 (starts conversion)
//   GET  /api/gen/{clip_id}/wav_file/      -> {} until ready, then {wav_file_url}
// (polled every 5s, up to ~24 tries). The older
// GET /api/download/clip/{clip_id}?format=wav route still responds and is kept
// as a fallback.
async function resolveGenWavUrl(clipId) {
  const wavPath = `/api/gen/${encodeURIComponent(clipId)}/wav_file/`;

  const initial = await sunoClient.GET(wavPath);
  if (initial.ok && initial.data?.wav_file_url) return initial.data.wav_file_url;

  const trigger = await sunoClient.POST(`/api/gen/${encodeURIComponent(clipId)}/convert_wav/`);
  if (!trigger.ok && trigger.status !== 204) {
    throw new Error(trigger.error || `WAV conversion request failed: HTTP ${trigger.status}`);
  }

  for (let attempt = 0; attempt < 24; attempt++) {
    await sleep(5000);
    const result = await sunoClient.GET(wavPath);
    if (result.ok && result.data?.wav_file_url) return result.data.wav_file_url;
  }
  throw new Error('Timed out waiting for Suno WAV conversion');
}

async function resolveLegacyDownloadUrl(clipId, format) {
  const path = `/api/download/clip/${encodeURIComponent(clipId)}?format=${encodeURIComponent(format)}`;
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await sunoClient.GET(path);
    if (!result.ok) throw new Error(result.error || `Download URL request failed: HTTP ${result.status}`);
    const data = result.data || {};
    if (data.download_url) return data.download_url;
    if (data.status === 'error') throw new Error(data.error || 'Suno download failed');
    if (attempt >= 2 && (data.ok === false || data.status === 'not_available')) {
      throw new Error(data.detail || data.error || 'Suno download not available');
    }
    await sleep(3000);
  }
  throw new Error('Timed out waiting for Suno download URL');
}

async function resolveSunoDownloadUrl(clipId, format) {
  if (format === 'wav') {
    try {
      return await resolveGenWavUrl(clipId);
    } catch (err) {
      console.error('[downloads] convert_wav flow failed, falling back to legacy download endpoint:', err.message);
    }
  }
  return resolveLegacyDownloadUrl(clipId, format);
}

// ─── media_urls / encrypted ("mango") stream support ────────────────────────
//
// V6-era clips have `audio_url: /api/forbidden`; the real audio lives in
// `media_urls[]`. Entries without `encoding` are plain progressive files
// (downloadable directly); entries WITH `encoding` are AES-encrypted
// fragmented MP4 and require the license flow the web player uses:
//   POST {mangoHost}/api/mango/rights -> {key, iv, glt}
//   userKey  = SHA-256(bearer token) (or SHA-256(glt) for guests)
//   key/iv   = AES-256-GCM unwrap (iv = first 12 bytes, AAD = clip id)
//   content  = AES-256-CTR decrypt of the whole encrypted media stream
// Mirrors the BetterSuno extension's `resolveSunoAudioBytes`.

function extractMediaEntries(song) {
  const media = Array.isArray(song?.media_urls) ? song.media_urls
    : Array.isArray(song?.metadata?.media_urls) ? song.metadata.media_urls
    : Array.isArray(song?.meta?.media_urls) ? song.meta.media_urls
    : [];
  return media.filter(m => m && typeof m.url === 'string' && m.url);
}

function pickProgressiveMediaEntry(entries, format) {
  const requested = String(format || '').trim().toLowerCase();
  const matches = (entry) => {
    const type = String(entry?.content_type || '').toLowerCase();
    const url = String(entry?.url || '').toLowerCase().split('?')[0];
    if (requested === 'mp3') return type.includes('mp3') || url.endsWith('.mp3');
    if (requested === 'm4a') return type.includes('m4a') || type.includes('mp4') || url.endsWith('.m4a');
    return false;
  };
  return entries.find(e => !e.encoding && matches(e)) || null;
}

function findEncryptedMediaEntry(entries) {
  return entries.find(e => !!e.encoding) || null;
}

async function fetchMediaEntries(clipId, song) {
  const direct = extractMediaEntries(song);
  if (direct.length > 0) return direct;

  // Older/stale clips may not carry media_urls — refetch via feed/v3 by id
  // (same lookup the web player and the extension use).
  const result = await sunoClient.POST('/api/feed/v3', {
    body: { limit: 1, filters: { ids: { presence: 'True', clipIds: [clipId] } } },
  });
  if (!result.ok) return [];
  const clips = result.data?.clips || result.data?.results || result.data?.items || [];
  const clip = clips.find(c => c?.id === clipId) || clips[0];
  return extractMediaEntries(clip);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest();
}

function unwrapGcmKey(wrappedB64, contentId, userKey) {
  const wrapped = Buffer.from(wrappedB64, 'base64');
  const iv = wrapped.subarray(0, 12);
  const rest = wrapped.subarray(12);
  const tag = rest.subarray(rest.length - 16);
  const ciphertext = rest.subarray(0, rest.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', userKey, iv);
  decipher.setAAD(Buffer.from(contentId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function resolveSunoAudioBytes(clipId, song) {
  const token = getToken();
  if (!token) throw new Error('No auth token. Is BetterSuno extension running and connected?');

  let entries = await fetchMediaEntries(clipId, song);
  let encrypted = findEncryptedMediaEntry(entries);
  if (!encrypted) {
    entries = await fetchMediaEntries(clipId, null);
    encrypted = findEncryptedMediaEntry(entries);
  }
  if (!encrypted) throw new Error('No encrypted media URL available for this clip');

  const rightsResp = await fetch(`${config.mangoBaseUrl}/api/mango/rights`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_params: { content_id: clipId, content_type: 'clip' } }),
  });
  if (!rightsResp.ok) throw new Error(`Suno license request failed: HTTP ${rightsResp.status}`);
  const rights = await rightsResp.json();
  if (!rights?.key || !rights?.iv) throw new Error('Suno license response missing key/iv');

  const userKey = sha256(token || rights.glt);
  const aesKey = unwrapGcmKey(rights.key, clipId, userKey);
  const aesIv = unwrapGcmKey(rights.iv, clipId, userKey);

  const mediaResp = await fetch(encrypted.url);
  if (!mediaResp.ok) throw new Error(`Suno media fetch failed: HTTP ${mediaResp.status}`);
  const encryptedBytes = Buffer.from(await mediaResp.arrayBuffer());

  const decipher = createDecipheriv('aes-256-ctr', aesKey, aesIv);
  return Buffer.concat([decipher.update(encryptedBytes), decipher.final()]);
}

async function fetchBuffer(url) {
  const response = await fetch(url, { headers: authHeadersForUrl(url) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type'),
    finalUrl: response.url || url,
  };
}

export function registerDownloadTools(server, allTools) {
  const tools = [
    tool('get_song_urls', 'Get all downloadable URLs for a song', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
      },
      required: ['clip_id'],
    }, async (args) => {
      const s = await assertOwned(args.clip_id);
      const mediaEntries = extractMediaEntries(s);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            id: s.id,
            title: s.title,
            audio_url: s.audio_url,
            image_url: s.image_url,
            video_url: s.video_url,
            video_cover_url: s.metadata?.video_cover_url,
            lyrics: s.metadata?.prompt || s.lyrics,
            // V6 clips expose audio via media_urls. Entries with `encoding` are
            // AES-encrypted and are decrypted by download_song; entries without
            // `encoding` are plain progressive files.
            media_urls: mediaEntries,
            has_encrypted_media: !!findEncryptedMediaEntry(mediaEntries),
            // WAV is materialized via POST /api/gen/{clip_id}/convert_wav/ and
            // then fetched from GET /api/gen/{clip_id}/wav_file/
            // ({wav_file_url}); the legacy /api/download/clip route is a fallback.
            wav_via_convert_endpoint: true,
            owner_handle: s.user?.username || s.metadata?.user?.username,
          }, null, 2),
        }],
      };
    }),

    tool('download_song', 'Download a song\'s audio to disk', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
        format: { type: 'string', enum: ['m4a', 'wav'], description: 'Audio format', default: 'm4a' },
        output_dir: { type: 'string', description: 'Output directory (defaults to current dir)' },
      },
      required: ['clip_id'],
    }, async (args) => {
      const song = await assertOwned(args.clip_id);
      const requestedExt = (args.format || 'm4a').toLowerCase();

      let buffer;
      let contentType = null;
      let actualUrl = null;

      if (requestedExt === 'wav') {
        const wavUrl = await resolveSunoDownloadUrl(args.clip_id, 'wav');
        const fetched = await fetchBuffer(wavUrl);
        buffer = fetched.buffer;
        contentType = fetched.contentType;
        actualUrl = fetched.finalUrl;
      } else {
        // Prefer a plain progressive media asset; otherwise decrypt the
        // encrypted stream (V6 clips have `audio_url: /api/forbidden`).
        let entries = await fetchMediaEntries(args.clip_id, song);
        const progressive = pickProgressiveMediaEntry(entries, 'm4a');
        if (progressive) {
          const fetched = await fetchBuffer(progressive.url);
          buffer = fetched.buffer;
          contentType = fetched.contentType;
          actualUrl = fetched.finalUrl;
        } else {
          try {
            if (findEncryptedMediaEntry(entries) || /forbidden/i.test(String(song.audio_url || '')) || !song.audio_url) {
              buffer = await resolveSunoAudioBytes(args.clip_id, song);
              contentType = 'audio/mp4';
              actualUrl = `${args.clip_id}.m4a`;
            } else {
              const legacyUrl = getAudioUrlForFormat(song, requestedExt) || song.audio_url;
              const fetched = await fetchBuffer(legacyUrl);
              buffer = fetched.buffer;
              contentType = fetched.contentType;
              actualUrl = fetched.finalUrl;
            }
          } catch (err) {
            console.error('[downloads] stream resolution failed, falling back to official download endpoint:', err.message);
            const legacyUrl = await resolveSunoDownloadUrl(args.clip_id, requestedExt);
            const fetched = await fetchBuffer(legacyUrl);
            buffer = fetched.buffer;
            contentType = fetched.contentType;
            actualUrl = fetched.finalUrl;
          }
        }
      }

      const actualExt = inferAudioExtension(actualUrl, contentType, requestedExt);
      const title = sanitizeFilename(song.title || `song_${args.clip_id.slice(-4)}`);
      let filename = `${title}_${args.clip_id.slice(-4)}.${requestedExt}`;
      if (actualExt !== requestedExt) {
        filename = replaceFilenameExtension(filename, actualExt);
      }
      const outputDir = args.output_dir ? resolve(args.output_dir) : process.cwd();
      await ensureDir(outputDir);
      const filePath = join(outputDir, filename);
      await writeFile(filePath, buffer);

      const note = actualExt !== requestedExt ? ` (Suno returned ${actualExt.toUpperCase()})` : '';
      return { content: [{ type: 'text', text: `Downloaded to ${filePath} (${buffer.length} bytes${note})` }] };
    }),

    tool('download_lyrics', 'Download a song\'s lyrics as a text file', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
        output_dir: { type: 'string', description: 'Output directory (defaults to current dir)' },
      },
      required: ['clip_id'],
    }, async (args) => {
      const song = await assertOwned(args.clip_id);
      const lyrics = song.metadata?.prompt || song.lyrics;
      if (!lyrics) throw new Error('No lyrics available for this song');

      const title = sanitizeFilename(song.title || `song_${args.clip_id.slice(-4)}`);
      const filename = `${title}_${args.clip_id.slice(-4)}.txt`;
      const outputDir = args.output_dir ? resolve(args.output_dir) : process.cwd();
      await ensureDir(outputDir);
      const filePath = join(outputDir, filename);
      await writeFile(filePath, lyrics, 'utf-8');

      return { content: [{ type: 'text', text: `Lyrics saved to ${filePath}` }] };
    }),

    tool('download_cover_image', 'Download a song\'s cover image', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
        output_dir: { type: 'string', description: 'Output directory (defaults to current dir)' },
      },
      required: ['clip_id'],
    }, async (args) => {
      const song = await assertOwned(args.clip_id);
      let imageUrl = song.image_url || song.metadata?.image_url;
      if (!imageUrl) throw new Error('No cover image available for this song');

      const response = await fetch(imageUrl);
      if (!response.ok) throw new Error(`Image download failed: HTTP ${response.status}`);

      const buffer = Buffer.from(await response.arrayBuffer());
      const ext = (imageUrl.split('?')[0].match(/\.([a-z0-9]{2,5})$/i)?.[1] || 'jpg').toLowerCase();
      const title = sanitizeFilename(song.title || `song_${args.clip_id.slice(-4)}`);
      const filename = `${title}_${args.clip_id.slice(-4)}.${ext}`;
      const outputDir = args.output_dir ? resolve(args.output_dir) : process.cwd();
      await ensureDir(outputDir);
      const filePath = join(outputDir, filename);
      await writeFile(filePath, buffer);

      return { content: [{ type: 'text', text: `Cover image saved to ${filePath} (${buffer.length} bytes)` }] };
    }),

    tool('download_sample_pack', 'Download a sample pack for a song (Suno Samples)', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
        output_dir: { type: 'string', description: 'Output directory (defaults to current dir)' },
      },
      required: ['clip_id'],
    }, async (args) => {
      const song = await assertOwned(args.clip_id);
      const result = await sunoClient.GET(`/api/download/sample-pack/${encodeURIComponent(args.clip_id)}`);
      if (!result.ok) throw new Error(result.error || 'Sample pack download failed');

      const data = result.data;
      let downloadUrl = null;
      if (typeof data === 'string') downloadUrl = data;
      else if (data?.url) downloadUrl = data.url;
      else if (data?.download_url) downloadUrl = data.download_url;
      if (!downloadUrl) throw new Error('No download URL in response');

      const response = await fetch(downloadUrl, {
        headers: authHeadersForUrl(downloadUrl),
      });
      if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);

      const buffer = Buffer.from(await response.arrayBuffer());
      const title = sanitizeFilename(song.title || `song_${args.clip_id.slice(-4)}`);
      const filename = `${title}_${args.clip_id.slice(-4)}_sample_pack.zip`;
      const outputDir = args.output_dir ? resolve(args.output_dir) : process.cwd();
      await ensureDir(outputDir);
      const filePath = join(outputDir, filename);
      await writeFile(filePath, buffer);

      return { content: [{ type: 'text', text: `Sample pack saved to ${filePath} (${buffer.length} bytes)` }] };
    }),
  ];

  allTools.push(...tools);
}
