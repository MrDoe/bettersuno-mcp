import { sunoClient } from '../suno-client.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

function clampLimit(value, fallback = 50, max = 100) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function normalizeLyricist(item) {
  const samples = Array.isArray(item?.samples) ? item.samples : [];
  return {
    id: item?.id || null,
    name: item?.title || null,
    writing_style: item?.description || '',
    sample_lyrics: samples.map((s) => s?.text).filter(Boolean),
    is_favorited: !!item?.is_favorited,
    created_at: item?.created_at || null,
  };
}

function lyricistBody(args) {
  const body = {};
  if (args.name !== undefined) body.title = args.name;
  if (args.writing_style !== undefined) body.description = args.writing_style;
  if (args.sample_lyrics !== undefined) {
    body.samples = args.sample_lyrics.map((text) => ({ kind: 'text', text }));
  }
  return body;
}

function normalizeProject(item, { includeLyrics = false } = {}) {
  const project = {
    id: item?.id || null,
    title: item?.title || null,
    created_at: item?.created_at || null,
    updated_at: item?.updated_at || null,
    lyrics_length: typeof item?.lyrics === 'string' ? item.lyrics.length : 0,
  };
  if (includeLyrics) project.lyrics = item?.lyrics || '';
  return project;
}

export function registerLyricsProjectTools(server, allTools) {
  const tools = [
    tool('list_lyricists', 'List your saved lyricists (AI writing styles with sample lyrics).', {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 100, max 100)', default: 100 },
        cursor: { type: 'string', description: 'Pagination cursor from a previous call' },
      },
    }, async (args) => {
      const size = clampLimit(args.limit, 100);
      const cursor = args.cursor ? `&cursor=${encodeURIComponent(args.cursor)}` : '';
      const result = await sunoClient.GET(`/api/lyricists?limit=${size}${cursor}`);
      if (!result.ok) throw new Error(result.error || 'Failed to fetch lyricists');
      const data = result.data || {};
      const lyricists = (data.lyricists || []).map(normalizeLyricist);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            lyricists,
            count: lyricists.length,
            next_cursor: data.next_cursor || null,
          }, null, 2),
        }],
      };
    }),

    tool('get_lyricist', 'Get one lyricist by ID.', {
      type: 'object',
      properties: {
        lyricist_id: { type: 'string', description: 'Lyricist ID' },
      },
      required: ['lyricist_id'],
    }, async (args) => {
      const result = await sunoClient.GET(`/api/lyricists/${encodeURIComponent(args.lyricist_id)}`);
      if (!result.ok) throw new Error(result.error || 'Failed to fetch lyricist');
      return { content: [{ type: 'text', text: JSON.stringify(normalizeLyricist(result.data), null, 2) }] };
    }),

    tool('create_lyricist', 'Create a lyricist (writing style) with optional sample lyrics.', {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Lyricist name/title' },
        writing_style: { type: 'string', description: 'Description of the writing style' },
        sample_lyrics: { type: 'array', items: { type: 'string' }, description: 'Sample lyric snippets' },
      },
      required: ['name'],
    }, async (args) => {
      const body = lyricistBody(args);
      const result = await sunoClient.POST('/api/lyricists', { body });
      if (!result.ok) throw new Error(result.error || 'Failed to create lyricist');
      return { content: [{ type: 'text', text: JSON.stringify(normalizeLyricist(result.data), null, 2) }] };
    }),

    tool('update_lyricist', 'Update a lyricist name, writing style, samples, or favorite flag.', {
      type: 'object',
      properties: {
        lyricist_id: { type: 'string', description: 'Lyricist ID' },
        name: { type: 'string', description: 'New name' },
        writing_style: { type: 'string', description: 'New writing style description' },
        sample_lyrics: { type: 'array', items: { type: 'string' }, description: 'Replacement sample lyric snippets' },
        is_favorited: { type: 'boolean', description: 'Favorite flag' },
      },
      required: ['lyricist_id'],
    }, async (args) => {
      const body = lyricistBody(args);
      if (args.is_favorited !== undefined) body.is_favorited = args.is_favorited;
      if (Object.keys(body).length === 0) throw new Error('Provide at least one field to update');
      const result = await sunoClient.PATCH(`/api/lyricists/${encodeURIComponent(args.lyricist_id)}`, { body });
      if (!result.ok) throw new Error(result.error || 'Failed to update lyricist');
      return { content: [{ type: 'text', text: JSON.stringify(normalizeLyricist(result.data), null, 2) }] };
    }),

    tool('delete_lyricist', 'Delete one of your lyricists.', {
      type: 'object',
      properties: {
        lyricist_id: { type: 'string', description: 'Lyricist ID' },
      },
      required: ['lyricist_id'],
    }, async (args) => {
      const result = await sunoClient.DELETE(`/api/lyricists/${encodeURIComponent(args.lyricist_id)}`);
      if (!result.ok) throw new Error(result.error || 'Failed to delete lyricist');
      return { content: [{ type: 'text', text: JSON.stringify({ deleted: true, lyricist_id: args.lyricist_id }, null, 2) }] };
    }),

    tool('list_lyrics_projects', 'List your lyrics projects (the lyrics workspace). Lyrics are omitted by default because they can be very large.', {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Projects per page (default 50, max 100)', default: 50 },
        cursor: { type: 'string', description: 'Pagination cursor from a previous call' },
        sort: { type: 'string', enum: ['updated_at', 'created_at'], description: 'Sort field', default: 'updated_at' },
        include_lyrics: { type: 'boolean', description: 'Include full project lyrics', default: false },
      },
    }, async (args) => {
      const size = clampLimit(args.limit);
      const sort = args.sort === 'created_at' ? 'created_at' : 'updated_at';
      const cursor = args.cursor ? `&cursor=${encodeURIComponent(args.cursor)}` : '';
      const result = await sunoClient.GET(`/api/lyrics-projects?limit=${size}&sort=${sort}${cursor}`);
      if (!result.ok) throw new Error(result.error || 'Failed to fetch lyrics projects');
      const data = result.data || {};
      const projects = (data.projects || []).map((project) => normalizeProject(project, { includeLyrics: args.include_lyrics === true }));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            projects,
            count: projects.length,
            next_cursor: data.next_cursor || null,
          }, null, 2),
        }],
      };
    }),

    tool('get_lyrics_project', 'Get one lyrics project including its full lyrics.', {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Lyrics project ID' },
      },
      required: ['project_id'],
    }, async (args) => {
      const result = await sunoClient.GET(`/api/lyrics-projects/${encodeURIComponent(args.project_id)}`);
      if (!result.ok) throw new Error(result.error || 'Failed to fetch lyrics project');
      const data = result.data || {};
      return { content: [{ type: 'text', text: JSON.stringify(normalizeProject(data, { includeLyrics: true }), null, 2) }] };
    }),

    tool('create_lyrics_project', 'Create a new lyrics project (title only; write lyrics with flush_lyrics_project).', {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Project title (max 200 characters)' },
      },
      required: ['title'],
    }, async (args) => {
      const title = String(args.title || '').slice(0, 200);
      if (!title) throw new Error('title is required');
      const result = await sunoClient.POST('/api/lyrics-projects', { body: { title } });
      if (!result.ok) throw new Error(result.error || 'Failed to create lyrics project');
      return { content: [{ type: 'text', text: JSON.stringify(normalizeProject(result.data, { includeLyrics: true }), null, 2) }] };
    }),

    tool('update_lyrics_project', 'Rename a lyrics project.', {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Lyrics project ID' },
        title: { type: 'string', description: 'New title (max 200 characters)' },
      },
      required: ['project_id', 'title'],
    }, async (args) => {
      const title = String(args.title || '').slice(0, 200);
      if (!title) throw new Error('title is required');
      const result = await sunoClient.PATCH(`/api/lyrics-projects/${encodeURIComponent(args.project_id)}`, {
        body: { title },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to rename lyrics project');
      return { content: [{ type: 'text', text: JSON.stringify(normalizeProject(result.data, { includeLyrics: true }), null, 2) }] };
    }),

    tool('flush_lyrics_project', 'Save/replace the lyrics content of a lyrics project.', {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Lyrics project ID' },
        lyrics: { type: 'string', description: 'Full lyrics text' },
      },
      required: ['project_id', 'lyrics'],
    }, async (args) => {
      const result = await sunoClient.POST(`/api/lyrics-projects/${encodeURIComponent(args.project_id)}/flush`, {
        body: { lyrics: args.lyrics },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to save lyrics');
      return { content: [{ type: 'text', text: JSON.stringify({ saved: true, project_id: args.project_id, lyrics_length: String(args.lyrics || '').length }, null, 2) }] };
    }),

    tool('delete_lyrics_project', 'Delete a lyrics project.', {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Lyrics project ID' },
      },
      required: ['project_id'],
    }, async (args) => {
      const result = await sunoClient.DELETE(`/api/lyrics-projects/${encodeURIComponent(args.project_id)}`);
      if (!result.ok) throw new Error(result.error || 'Failed to delete lyrics project');
      return { content: [{ type: 'text', text: JSON.stringify({ deleted: true, project_id: args.project_id }, null, 2) }] };
    }),
  ];

  allTools.push(...tools);
}
