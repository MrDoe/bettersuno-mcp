import { sunoClient } from '../suno-client.js';
import { assertOwned } from '../auth.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

export function registerMetadataTools(server, allTools) {
  const tools = [
    tool('delete_song', 'Permanently delete songs', {
      type: 'object',
      properties: {
        clip_ids: { type: 'array', items: { type: 'string' }, description: 'Array of song clip IDs to delete' },
        reason: { type: 'string', description: 'Optional reason for deletion' },
      },
      required: ['clip_ids'],
    }, async (args) => {
      for (const id of args.clip_ids) await assertOwned(id);
      const body = { ids: args.clip_ids };
      if (args.reason) body.reason = args.reason;
      const result = await sunoClient.POST('/api/clips/delete/', { body });
      if (!result.ok) throw new Error(result.error || 'Failed to delete songs');
      return { content: [{ type: 'text', text: JSON.stringify({ deleted: true, clip_ids: args.clip_ids }, null, 2) }] };
    }),

    tool('trash_song', 'Move songs to/from trash', {
      type: 'object',
      properties: {
        clip_ids: { type: 'array', items: { type: 'string' }, description: 'Array of song clip IDs' },
        trash: { type: 'boolean', description: 'True to trash, false to restore', default: true },
      },
      required: ['clip_ids'],
    }, async (args) => {
      for (const id of args.clip_ids) await assertOwned(id);
      const result = await sunoClient.POST('/api/gen/trash', {
        body: { clip_ids: args.clip_ids, trash: args.trash !== false },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to update trash status');
      return { content: [{ type: 'text', text: JSON.stringify({ trashed: args.trash !== false, clip_ids: args.clip_ids }, null, 2) }] };
    }),

    tool('set_visibility', 'Make a song public or private', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
        is_public: { type: 'boolean', description: 'True for public, false for private' },
        submit_to_contest: { type: 'boolean', description: 'Also submit to contest', default: false },
      },
      required: ['clip_id', 'is_public'],
    }, async (args) => {
      await assertOwned(args.clip_id);
      const result = await sunoClient.POST(`/api/gen/${encodeURIComponent(args.clip_id)}/set_visibility/`, {
        body: { is_public: args.is_public, submit_to_contest: args.submit_to_contest || false },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to update visibility');
      return { content: [{ type: 'text', text: JSON.stringify({ clip_id: args.clip_id, is_public: args.is_public }, null, 2) }] };
    }),

    tool('like_song', 'Like or unlike a song', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
        like: { type: 'boolean', description: 'True to like, false to unlike' },
      },
      required: ['clip_id', 'like'],
    }, async (args) => {
      const result = await sunoClient.POST(`/api/gen/${encodeURIComponent(args.clip_id)}/update_reaction_type/`, {
        body: { reaction: args.like ? 'LIKE' : null },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to update reaction');
      return { content: [{ type: 'text', text: JSON.stringify({ clip_id: args.clip_id, liked: args.like }, null, 2) }] };
    }),

    tool('update_song_metadata', 'Update a song\'s title, tags, or lyrics', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
        title: { type: 'string', description: 'New title' },
        tags: { type: 'string', description: 'New style tags' },
        lyrics: { type: 'string', description: 'New lyrics' },
        negative_tags: { type: 'string', description: 'New negative/exclude style tags' },
        is_public: { type: 'boolean', description: 'Update visibility' },
      },
      required: ['clip_id'],
    }, async (args) => {
      await assertOwned(args.clip_id);
      const body = {};
      if (args.title !== undefined) body.title = args.title;
      if (args.tags !== undefined) body.tags = args.tags;
      if (args.lyrics !== undefined) body.prompt = args.lyrics;
      if (args.negative_tags !== undefined) body.negative_tags = args.negative_tags;
      if (args.is_public !== undefined) body.is_public = args.is_public;

      let result = await sunoClient.POST(`/api/gen/${encodeURIComponent(args.clip_id)}/set_metadata/`, { body });
      if (!result.ok) throw new Error(result.error || 'Failed to update metadata');

      if (args.is_public !== undefined) {
        result = await sunoClient.POST(`/api/gen/${encodeURIComponent(args.clip_id)}/set_visibility/`, {
          body: { is_public: args.is_public },
        });
      }

      return { content: [{ type: 'text', text: JSON.stringify({ updated: true, clip_id: args.clip_id }, null, 2) }] };
    }),

    tool('generate_video', 'Generate a lyric video for a song', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
      },
      required: ['clip_id'],
    }, async (args) => {
      await assertOwned(args.clip_id);
      const result = await sunoClient.POST(`/api/video/generate/${encodeURIComponent(args.clip_id)}/`);
      if (!result.ok) throw new Error(result.error || 'Video generation failed');
      return { content: [{ type: 'text', text: JSON.stringify({ generating: true, clip_id: args.clip_id }, null, 2) }] };
    }),

    tool('create_custom_model', 'Create a custom AI model from a set of clips', {
      type: 'object',
      properties: {
        clip_ids: { type: 'array', items: { type: 'string' }, description: 'Array of clip IDs (minimum 6)' },
        name: { type: 'string', description: 'Custom model name', default: 'Custom Model' },
      },
      required: ['clip_ids'],
    }, async (args) => {
      for (const id of args.clip_ids) await assertOwned(id);
      if (args.clip_ids.length < 6) throw new Error('At least 6 clips are required to create a custom model');
      const result = await sunoClient.POST('/api/custom-model/create/', {
        body: { clip_ids: args.clip_ids, name: args.name || 'Custom Model' },
      });
      if (!result.ok) throw new Error(result.error || 'Custom model creation failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    // --- Edit/Crop/Fade tools ---
    tool('crop_clip', 'Crop a clip to a specific time range', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
        crop_start_s: { type: 'number', description: 'Start time in seconds' },
        crop_end_s: { type: 'number', description: 'End time in seconds' },
        title: { type: 'string', description: 'Title for the cropped clip' },
        is_crop_remove: { type: 'boolean', description: 'Whether to remove the selected range instead of keeping it', default: false },
      },
      required: ['clip_id', 'crop_start_s', 'crop_end_s'],
    }, async (args) => {
      await assertOwned(args.clip_id);
      const body = {
        crop_start_s: args.crop_start_s,
        crop_end_s: args.crop_end_s,
        is_crop_remove: args.is_crop_remove || false,
        title: args.title || '',
        ui_surface: 'mcp',
      };
      const result = await sunoClient.POST(`/api/edit/crop/${encodeURIComponent(args.clip_id)}/`, { body });
      if (!result.ok) throw new Error(result.error || 'Crop failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('fade_clip', 'Add fade in/out to a clip', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
        fade_in_time: { type: 'number', description: 'Fade in duration in seconds' },
        fade_out_time: { type: 'number', description: 'Fade out duration in seconds' },
        title: { type: 'string', description: 'Title for the faded clip' },
      },
      required: ['clip_id'],
    }, async (args) => {
      await assertOwned(args.clip_id);
      const body = {
        fade_in_time: args.fade_in_time || 0,
        fade_out_time: args.fade_out_time || 0,
        title: args.title || '',
      };
      const result = await sunoClient.POST(`/api/edit/fade/${encodeURIComponent(args.clip_id)}/`, { body });
      if (!result.ok) throw new Error(result.error || 'Fade failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('reverse_clip', 'Reverse a clip\'s audio', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID to reverse' },
      },
      required: ['clip_id'],
    }, async (args) => {
      await assertOwned(args.clip_id);
      const result = await sunoClient.POST('/api/clips/reverse-clip/', { body: { clip_id: args.clip_id } });
      if (!result.ok) throw new Error(result.error || 'Reverse failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('adjust_speed', 'Adjust the playback speed of a clip', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
        speed_multiplier: { type: 'number', description: 'Speed multiplier (e.g. 1.0 = normal, 1.5 = faster, 0.75 = slower)' },
        keep_pitch: { type: 'boolean', description: 'Whether to preserve pitch', default: false },
      },
      required: ['clip_id'],
    }, async (args) => {
      await assertOwned(args.clip_id);
      const body = {
        clip_id: args.clip_id,
        speed_multiplier: args.speed_multiplier || 1.0,
        keep_pitch: args.keep_pitch || false,
      };
      const result = await sunoClient.POST('/api/clips/adjust-speed/', { body });
      if (!result.ok) throw new Error(result.error || 'Speed adjustment failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('set_clip_prompt', 'Set/edit the prompt metadata for a clip', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
        prompt: { type: 'string', description: 'New prompt text' },
        title: { type: 'string', description: 'New title' },
        tags: { type: 'string', description: 'New style tags' },
        negative_tags: { type: 'string', description: 'New negative style tags' },
      },
      required: ['clip_id'],
    }, async (args) => {
      await assertOwned(args.clip_id);
      const body = {};
      if (args.prompt !== undefined) body.prompt = args.prompt;
      if (args.title !== undefined) body.title = args.title;
      if (args.tags !== undefined) body.tags = args.tags;
      if (args.negative_tags !== undefined) body.negative_tags = args.negative_tags;
      const result = await sunoClient.POST(`/api/gen/${encodeURIComponent(args.clip_id)}/set_clip_prompt/`, { body });
      if (!result.ok) throw new Error(result.error || 'Failed to set clip prompt');
      return { content: [{ type: 'text', text: JSON.stringify({ updated: true, clip_id: args.clip_id }, null, 2) }] };
    }),

    tool('set_clip_configurations', 'Set configurations for a clip (display tags, etc.)', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
        display_tags: { type: 'string', description: 'Display tags for the clip' },
      },
      required: ['clip_id'],
    }, async (args) => {
      await assertOwned(args.clip_id);
      const body = {};
      if (args.display_tags !== undefined) body.display_tags = args.display_tags;
      const result = await sunoClient.POST(`/api/gen/${encodeURIComponent(args.clip_id)}/set_configurations/`, { body });
      if (!result.ok) throw new Error(result.error || 'Failed to set configurations');
      return { content: [{ type: 'text', text: JSON.stringify({ updated: true, clip_id: args.clip_id }, null, 2) }] };
    }),
  ];

  allTools.push(...tools);
}
