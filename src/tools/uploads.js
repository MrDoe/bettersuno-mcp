import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { sunoClient } from '../suno-client.js';
import { getToken } from '../ws-bridge.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

async function uploadFileToS3(url, fields, fileBuffer, contentType) {
  // Build multipart form data
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  let body = '';

  for (const [key, value] of Object.entries(fields)) {
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
    body += `${value}\r\n`;
  }

  body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="file"; filename="upload.${ext}"\r\n`;
  body += `Content-Type: ${contentType}\r\n\r\n`;

  const encoder = new TextEncoder();
  const headerBytes = encoder.encode(body);
  const footerBytes = encoder.encode(`\r\n--${boundary}--\r\n`);

  const combined = new Uint8Array(headerBytes.length + fileBuffer.length + footerBytes.length);
  combined.set(headerBytes, 0);
  combined.set(new Uint8Array(fileBuffer), headerBytes.length);
  combined.set(footerBytes, headerBytes.length + fileBuffer.length);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: combined,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`S3 upload failed: HTTP ${response.status} ${text}`);
  }
}

export function registerUploadTools(server, allTools) {
  const tools = [
    tool('upload_audio', 'Upload an audio file to Suno', {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the audio file on disk' },
        title: { type: 'string', description: 'Title for the uploaded clip' },
        upload_type: { type: 'string', description: 'Upload type (studio_file_upload, etc.)', default: 'studio_file_upload' },
        is_stem_mix: { type: 'boolean', description: 'Whether the file is a stem mix', default: false },
        initialize_clip: { type: 'boolean', description: 'Whether to initialize a clip after upload', default: false },
      },
      required: ['file_path'],
    }, async (args) => {
      const fileBuffer = await readFile(args.file_path);
      const ext = extname(args.file_path).replace('.', '') || 'mp3';

      // Step 1: Initiate upload
      const initResult = await sunoClient.POST('/api/uploads/audio/', {
        body: { extension: ext, is_stem_mix: args.is_stem_mix || false, upload_type: args.upload_type || 'studio_file_upload' },
      });
      if (!initResult.ok) throw new Error(initResult.error || 'Upload initiation failed');
      const { id: uploadId, url: s3Url, fields: s3Fields } = initResult.data;
      if (!uploadId || !s3Url) throw new Error('Invalid upload initiation response');

      // Step 2: Upload to S3
      const contentType = `audio/${ext === 'mp3' ? 'mpeg' : ext === 'wav' ? 'wav' : ext === 'm4a' ? 'mp4' : ext === 'flac' ? 'flac' : ext === 'ogg' ? 'ogg' : ext === 'aac' ? 'aac' : 'mpeg'}`;
      await uploadFileToS3(s3Url, s3Fields, fileBuffer, contentType);

      // Step 3: Finish upload
      const filename = args.file_path.split('/').pop() || 'unknown';
      const finishResult = await sunoClient.POST(`/api/uploads/audio/${encodeURIComponent(uploadId)}/upload-finish/`, {
        body: { upload_type: args.upload_type || 'studio_file_upload', upload_filename: filename },
      });
      if (!finishResult.ok) throw new Error(finishResult.error || 'Upload finish failed');

      // Step 4: Optionally initialize clip (default: false — fast path returns here)
      if (args.initialize_clip === true) {
        // Before creating the clip, snapshot existing upload-type clip IDs for diffing
        let existingClipIds = new Set();
        const snapshotResult = await sunoClient.POST('/api/feed/v3', { body: { limit: 50 } });
        if (snapshotResult.ok) {
          const clips = snapshotResult.data?.clips || [];
          for (const c of clips) {
            if (c.metadata?.type === 'upload') existingClipIds.add(c.id);
          }
        }

        // Poll upload status until audio processing is done (needed before clip can be created)
        for (let i = 0; i < 30; i++) {
          const st = await sunoClient.GET(`/api/uploads/audio/${encodeURIComponent(uploadId)}/`);
          if (st.ok && (st.data?.status === 'passed_audio_processing' || st.data?.status === 'complete')) break;
          await sleep(2000);
        }

        // Try the initialize-clip endpoint (may return 400 — clips sometimes get created automatically)
        let clipId = null;
        let initError = null;
        try {
          const clipResult = await sunoClient.POST(`/api/uploads/audio/${encodeURIComponent(uploadId)}/initialize-clip/`, {
            body: { user_reviewed_tags: true },
          });
          if (clipResult.ok) {
            const d = clipResult.data;
            clipId = d?.clip_id || d?.id || d?.clip?.id || d?.clips?.[0]?.id || null;
          } else {
            initError = `HTTP ${clipResult.status}`;
          }
        } catch (e) {
          initError = e.message;
        }

        // If initialize-clip didn't return a clip_id, look for new clips in the feed
        // (clips can be created automatically after audio processing completes)
        if (!clipId) {
          for (let i = 0; i < 15 && !clipId; i++) {
            if (i > 0) await sleep(5000);
            const feedResult = await sunoClient.POST('/api/feed/v3', { body: { limit: 50 } });
            if (!feedResult.ok) continue;
            const clips = feedResult.data?.clips || [];
            for (const c of clips) {
              if (c.metadata?.type === 'upload' && !existingClipIds.has(c.id)) {
                clipId = c.id;
                break;
              }
            }
          }
        }

        // Set title if provided
        if (args.title && clipId) {
          await sunoClient.POST(`/api/gen/${encodeURIComponent(clipId)}/set_metadata/`, {
            body: { title: args.title },
          }).catch(() => {}); // non-critical
        }

        const response = { upload_id: uploadId, clip_id: clipId, status: 'completed' };
        if (initError) response.initialize_clip_note = `initialize-clip returned ${initError}; clip discovered via feed`;
        return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify({ upload_id: uploadId, status: 'completed' }, null, 2) }] };
    }),

    tool('upload_image', 'Upload a cover image to Suno', {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the image file on disk' },
      },
      required: ['file_path'],
    }, async (args) => {
      const fileBuffer = await readFile(args.file_path);
      const ext = extname(args.file_path).replace('.', '') || 'jpg';

      const initResult = await sunoClient.POST('/api/uploads/image/', {
        body: { extension: ext },
      });
      if (!initResult.ok) throw new Error(initResult.error || 'Image upload initiation failed');
      const { id: uploadId, url: s3Url, fields: s3Fields } = initResult.data;
      if (!uploadId || !s3Url) throw new Error('Invalid upload initiation response');

      const contentType = `image/${ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext === 'png' ? 'png' : ext === 'webp' ? 'webp' : ext === 'gif' ? 'gif' : 'jpeg'}`;
      await uploadFileToS3(s3Url, s3Fields, fileBuffer, contentType);

      const finishResult = await sunoClient.POST(`/api/uploads/image/${encodeURIComponent(uploadId)}/upload-finish/`);
      if (!finishResult.ok) throw new Error(finishResult.error || 'Image upload finish failed');

      return { content: [{ type: 'text', text: JSON.stringify({ upload_id: uploadId, moderation_status: finishResult.data?.moderation_status }, null, 2) }] };
    }),

    tool('upload_video', 'Upload a video file to Suno', {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the video file on disk' },
        is_video_cover: { type: 'boolean', description: 'Whether this is a cover art video', default: false },
        clip_id: { type: 'string', description: 'Optional clip ID to associate with' },
      },
      required: ['file_path'],
    }, async (args) => {
      const fileBuffer = await readFile(args.file_path);
      const ext = extname(args.file_path).replace('.', '') || 'mp4';

      const initResult = await sunoClient.POST('/api/uploads/video/', {
        body: { extension: ext },
      });
      if (!initResult.ok) throw new Error(initResult.error || 'Video upload initiation failed');
      const { id: uploadId, url: s3Url, fields: s3Fields } = initResult.data;
      if (!uploadId || !s3Url) throw new Error('Invalid upload initiation response');

      const contentType = `video/${ext === 'mp4' ? 'mp4' : ext === 'webm' ? 'webm' : ext === 'mov' ? 'quicktime' : 'mp4'}`;
      await uploadFileToS3(s3Url, s3Fields, fileBuffer, contentType);

      const filename = args.file_path.split('/').pop() || 'unknown';
      const finishResult = await sunoClient.POST(`/api/uploads/video/${encodeURIComponent(uploadId)}/upload-finish/`, {
        body: {
          upload_type: 'studio_file_upload',
          upload_filename: filename,
          is_video_cover: args.is_video_cover || false,
          ...(args.clip_id ? { clip_id: args.clip_id } : {}),
        },
      });
      if (!finishResult.ok) throw new Error(finishResult.error || 'Video upload finish failed');

      return { content: [{ type: 'text', text: JSON.stringify({ upload_id: uploadId, status: 'uploaded' }, null, 2) }] };
    }),

    tool('get_upload_status', 'Get the current processing status of an audio upload', {
      type: 'object',
      properties: {
        upload_id: { type: 'string', description: 'Upload ID returned by upload_audio' },
      },
      required: ['upload_id'],
    }, async (args) => {
      const st = await sunoClient.GET(`/api/uploads/audio/${encodeURIComponent(args.upload_id)}/`);
      if (!st.ok) throw new Error(st.error || 'Failed to get upload status');
      return { content: [{ type: 'text', text: JSON.stringify(st.data, null, 2) }] };
    }),

    tool('initialize_upload_clip', 'Initialize a clip from a completed upload and find its clip ID', {
      type: 'object',
      properties: {
        upload_id: { type: 'string', description: 'Upload ID returned by upload_audio' },
        title: { type: 'string', description: 'Optional title to set on the resulting clip' },
      },
      required: ['upload_id'],
    }, async (args) => {
      // Snapshot existing upload-type clip IDs for diffing
      let existingClipIds = new Set();
      const snapshotResult = await sunoClient.POST('/api/feed/v3', { body: { limit: 50 } });
      if (snapshotResult.ok) {
        const clips = snapshotResult.data?.clips || [];
        for (const c of clips) {
          if (c.metadata?.type === 'upload') existingClipIds.add(c.id);
        }
      }

      // Try the initialize-clip endpoint
      let clipId = null;
      let initError = null;
      try {
        const clipResult = await sunoClient.POST(`/api/uploads/audio/${encodeURIComponent(args.upload_id)}/initialize-clip/`, {
          body: { user_reviewed_tags: true },
        });
        if (clipResult.ok) {
          const d = clipResult.data;
          clipId = d?.clip_id || d?.id || d?.clip?.id || d?.clips?.[0]?.id || null;
        } else {
          initError = `HTTP ${clipResult.status}`;
        }
      } catch (e) {
        initError = e.message;
      }

      // If initialize-clip didn't return a clip_id, look for new clips in the feed
      if (!clipId) {
        for (let i = 0; i < 5 && !clipId; i++) {
          if (i > 0) await sleep(3000);
          const feedResult = await sunoClient.POST('/api/feed/v3', { body: { limit: 50 } });
          if (!feedResult.ok) continue;
          const clips = feedResult.data?.clips || [];
          for (const c of clips) {
            if (c.metadata?.type === 'upload' && !existingClipIds.has(c.id)) {
              clipId = c.id;
              break;
            }
          }
        }
      }

      // Set title if provided
      if (args.title && clipId) {
        await sunoClient.POST(`/api/gen/${encodeURIComponent(clipId)}/set_metadata/`, {
          body: { title: args.title },
        }).catch(() => {});
      }

      const response = { upload_id: args.upload_id, clip_id: clipId, status: 'completed' };
      if (initError) response.initialize_clip_note = `initialize-clip returned ${initError}; clip discovered via feed`;
      return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
    }),
  ];

  allTools.push(...tools);
}
