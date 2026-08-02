import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { sunoClient } from '../suno-client.js';
import { getToken } from '../ws-bridge.js';
import { assertOwned } from '../auth.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
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

// Suno serves true lossless/WAV via its download endpoint, not by rewriting
// the CDN URL extension. It returns `{status:"processing"}` first and later
// `{status:"ready", download_url}` (mirrors the suno.com web client).
async function resolveSunoDownloadUrl(clipId, format) {
  const path = `/api/download/clip/${encodeURIComponent(clipId)}?format=${encodeURIComponent(format)}`;
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await sunoClient.GET(path);
    if (!result.ok) throw new Error(result.error || `Download URL request failed: HTTP ${result.status}`);
    const data = result.data || {};
    if (data.status === 'ready' && data.download_url) return data.download_url;
    if (data.status === 'error') throw new Error(data.error || 'Suno download failed');
    if (attempt >= 2 && (data.ok === false || data.status === 'not_available')) {
      throw new Error(data.detail || data.error || 'Suno download not available');
    }
    await sleep(3000);
  }
  throw new Error('Timed out waiting for Suno download URL');
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
            // WAV is served via GET /api/download/clip/{clip_id}?format=wav (returns
            // a real .wav URL once ready), not by rewriting audio_url.
            wav_via_download_endpoint: true,
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

      let audioUrl = null;
      if (requestedExt === 'wav') {
        audioUrl = await resolveSunoDownloadUrl(args.clip_id, 'wav');
      } else {
        audioUrl = getAudioUrlForFormat(song, requestedExt) || song.audio_url;
      }
      if (!audioUrl) throw new Error('No audio URL available for this song');

      let response = await fetch(audioUrl, {
        headers: { 'Authorization': `Bearer ${getToken()}` },
        credentials: 'include',
      });

      if (!response.ok && requestedExt === 'm4a') {
        const fallbackUrl = song.stream_audio_url || song.audio_url;
        response = await fetch(fallbackUrl, {
          headers: { 'Authorization': `Bearer ${getToken()}` },
          credentials: 'include',
        });
      }

      if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);

      const buffer = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type');
      const actualExt = inferAudioExtension(response.url, contentType, requestedExt);
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
        headers: { 'Authorization': `Bearer ${getToken()}` },
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
