import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sunoClient } from '../suno-client.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

function sanitizeFilename(name) {
  return String(name || 'cover').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'cover';
}

function extensionForUrl(url) {
  try {
    const ext = extname(new URL(url).pathname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return ext;
  } catch { /* ignore */ }
  return '.jpg';
}

async function fetchCollectionV2(targetType, targetId) {
  const result = await sunoClient.GET(`/api/playlist/v2/${encodeURIComponent(targetId)}`);
  if (!result.ok) throw new Error(result.error || `Failed to fetch ${targetType}`);
  return result.data || {};
}

export function registerCoverTools(server, allTools) {
  const tools = [
    tool('get_visual_models', 'List the visual generation models available to your account. Visuals may be disabled for some accounts/regions (HTTP 403 feature_disabled).', {
      type: 'object',
      properties: {
        media_type: { type: 'string', enum: ['image', 'video'], description: 'Filter by media type' },
      },
    }, async (args) => {
      const result = await sunoClient.GET('/api/visual/models');
      if (!result.ok) {
        throw new Error(result.error || 'Visuals are not available for this account');
      }
      const models = result.data?.models || result.data?.items || result.data || [];
      const filtered = Array.isArray(models)
        ? models.filter((m) => !args.media_type || (m.mediaType || m.media_type) === args.media_type)
        : models;
      return { content: [{ type: 'text', text: JSON.stringify({ models: filtered }, null, 2) }] };
    }),

    tool('generate_cover_art', 'Generate cover art with the Suno visual API. This is feature-gated; if visuals are not enabled the tool reports the feature_disabled error. Poll the returned generation with get_visual_generation, then apply an image asset with set_cover.', {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Cover art prompt' },
        model: { type: 'string', description: 'Optional visual model ID (defaults to the first image model)' },
        aspect_ratio: { type: 'string', description: 'Aspect ratio, e.g. 1:1', default: '1:1' },
        takes: { type: 'number', description: 'Number of takes (default 1, max 4)', default: 1 },
      },
      required: ['prompt'],
    }, async (args) => {
      const prompt = String(args.prompt || '').trim();
      if (!prompt) throw new Error('prompt is required');

      let modelId = args.model || null;
      if (!modelId) {
        const modelsResult = await sunoClient.GET('/api/visual/models');
        if (!modelsResult.ok) {
          throw new Error(modelsResult.error || 'Visuals are not available for this account');
        }
        const models = modelsResult.data?.models || modelsResult.data?.items || modelsResult.data || [];
        const list = Array.isArray(models) ? models : [];
        const imageModel = list.find((m) => (m.mediaType || m.media_type) === 'image') || list[0];
        modelId = imageModel?.id || imageModel?.key || imageModel?.model || null;
        if (!modelId) throw new Error('No visual image model is available for this account');
      }

      const body = {
        task: 'visual_image',
        model: modelId,
        prompt,
        takes: Math.max(1, Math.min(4, parseInt(args.takes, 10) || 1)),
        aspect: args.aspect_ratio || '1:1',
        idempotencyKey: randomUUID(),
      };
      const result = await sunoClient.POST('/api/visual/generations', { body });
      if (!result.ok) throw new Error(result.error || 'Cover art generation failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_visual_generation', 'Read the status and takes of a visual generation.', {
      type: 'object',
      properties: {
        generation_id: { type: 'string', description: 'Visual generation ID' },
      },
      required: ['generation_id'],
    }, async (args) => {
      const result = await sunoClient.GET(`/api/visual/generations/${encodeURIComponent(args.generation_id)}`);
      if (!result.ok) throw new Error(result.error || 'Failed to read visual generation');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('set_cover', 'Set an album or playlist cover from an existing Suno S3 image ID (for example a generated visual asset).', {
      type: 'object',
      properties: {
        target_type: { type: 'string', enum: ['album', 'playlist'], description: 'Whether the target is an album or playlist' },
        target_id: { type: 'string', description: 'Album or playlist ID' },
        cover_image_s3_id: { type: 'string', description: 'Suno S3 image ID (image_...)' },
      },
      required: ['target_type', 'target_id', 'cover_image_s3_id'],
    }, async (args) => {
      const targetType = args.target_type === 'playlist' ? 'playlist' : 'album';
      const result = await sunoClient.PATCH(`/api/playlist/v2/${encodeURIComponent(args.target_id)}`, {
        body: { metadata: { cover_image_s3_id: args.cover_image_s3_id } },
      });
      if (!result.ok) throw new Error(result.error || `Failed to set ${targetType} cover`);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ updated: true, target_type: targetType, target_id: args.target_id, ...result.data }, null, 2),
        }],
      };
    }),

    tool('download_cover', 'Download an album or playlist cover image to disk.', {
      type: 'object',
      properties: {
        target_type: { type: 'string', enum: ['album', 'playlist'], description: 'Whether the target is an album or playlist' },
        target_id: { type: 'string', description: 'Album or playlist ID' },
        output_dir: { type: 'string', description: 'Output directory (defaults to the current directory)' },
      },
      required: ['target_type', 'target_id'],
    }, async (args) => {
      const targetType = args.target_type === 'playlist' ? 'playlist' : 'album';
      const data = await fetchCollectionV2(targetType, args.target_id);
      const url = data.metadata?.cover_url || data.metadata?.image_url || data.metadata?.image_large_url;
      if (!url) throw new Error(`${targetType} ${args.target_id} has no cover image`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to download cover (HTTP ${response.status})`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const dir = resolve(args.output_dir || process.cwd());
      mkdirSync(dir, { recursive: true });
      const name = sanitizeFilename(data.metadata?.name || args.target_id);
      const filePath = join(dir, `${name}-cover${extensionForUrl(url)}`);
      writeFileSync(filePath, buffer);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ downloaded: true, target_type: targetType, target_id: args.target_id, file_path: filePath, bytes: buffer.length }, null, 2),
        }],
      };
    }),
  ];

  allTools.push(...tools);
}
