import { sunoClient } from '../suno-client.js';
import { getCurrentUser } from '../auth.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

const ALBUM_TYPES = ['lp', 'ep'];

function clampPageSize(value, fallback = 50, max = 100) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function normalizeAlbum(input) {
  const album = input?.content_item || input || {};
  return {
    id: album.id || input?.content_id || null,
    name: album.name || null,
    image_url: album.image_url || null,
    song_count: album.song_count ?? null,
    total_duration_seconds: album.total_duration_seconds ?? null,
    is_owned: album.is_owned ?? null,
    user_handle: album.user_handle || null,
    user_display_name: album.user_display_name || null,
    lifecycle_state: album.lifecycle_state || null,
    album_type: album.album_type || null,
    feed_id: album.feed_id || (album.id ? `album:${album.id}` : null),
  };
}

function normalizeTrack(input) {
  const clip = input?.content_item || input?.clip || input || {};
  return {
    id: clip.id || input?.content_id || null,
    title: clip.title || null,
    status: clip.status || null,
    created_at: clip.created_at || null,
    model_name: clip.model_name || null,
    major_model_version: clip.major_model_version || null,
    duration: clip.metadata?.duration ?? null,
    is_public: !!clip.is_public,
    image_url: clip.image_url || null,
    audio_url: clip.audio_url || null,
  };
}

function normalizeAlbumMetadata(feed, albumId) {
  const metadata = feed.feed_metadata || {};
  return {
    id: feed.feed_container_id || albumId,
    name: feed.feed_title || null,
    image_url: feed.feed_image_url || null,
    description: metadata.description || '',
    owner: metadata.owner ? {
      user_id: metadata.owner.external_user_id || null,
      handle: metadata.owner.handle || null,
      display_name: metadata.owner.display_name || null,
    } : null,
    is_public: !!metadata.is_public,
    is_owned: !!metadata.is_owned,
    is_trashed: !!metadata.is_trashed,
    can_edit: !!metadata.can_edit,
    album_type: metadata.album_type || null,
    lifecycle_state: metadata.lifecycle_state || null,
    song_count: metadata.song_count ?? null,
    total_duration_seconds: metadata.total_duration_seconds ?? null,
    like_count: metadata.like_count ?? null,
    play_count: metadata.play_count ?? null,
    created_at: metadata.created_at || null,
    published_at: metadata.published_at || null,
    last_published_at: metadata.last_published_at || null,
    unpublished_clip_ids: metadata.unpublished_clip_ids || [],
    use_album_cover: !!metadata.use_album_cover,
    feed_id: feed.feed_id || `album:${albumId}`,
  };
}

async function fetchAlbumFeed(albumId, { cursor = null, pageSize = 50, includeTracks = true } = {}) {
  const result = await sunoClient.POST('/api/unified/feed', {
    body: {
      feed_id: `album:${albumId}`,
      cursor: cursor || null,
      page_size: clampPageSize(pageSize),
    },
  });
  if (!result.ok) throw new Error(result.error || 'Failed to fetch album');

  const feed = result.data?.feed;
  if (!feed) throw new Error(`Album ${albumId} not found`);

  const tracks = includeTracks
    ? (feed.items || [])
      .filter((item) => item?.content_type === 'clip' && item?.content_item)
      .map((item) => normalizeTrack(item.content_item))
    : [];

  return {
    album: normalizeAlbumMetadata(feed, albumId),
    tracks,
    next_cursor: feed.next_cursor || null,
    item_count: feed.item_count ?? tracks.length,
  };
}

async function fetchAlbumFallback(albumId, { includeTracks = true } = {}) {
  const metaResult = await sunoClient.GET(`/api/playlist/v2/${encodeURIComponent(albumId)}`);
  if (!metaResult.ok) throw new Error(metaResult.error || 'Failed to fetch album');
  const data = metaResult.data || {};
  const metadata = data.metadata || {};
  const album = {
    id: metadata.id || albumId,
    name: metadata.name || null,
    image_url: metadata.cover_url || null,
    description: data.bio?.description || '',
    owner: metadata.owner ? {
      user_id: metadata.owner.external_user_id || null,
      handle: metadata.owner.handle || null,
      display_name: metadata.owner.display_name || null,
    } : null,
    is_public: !!metadata.is_public,
    is_owned: !!data.relationship?.is_owned,
    is_trashed: !!data.relationship?.is_trashed,
    can_edit: !!data.relationship?.can_edit,
    album_type: metadata.album_type || null,
    lifecycle_state: metadata.lifecycle_state || null,
    song_count: metadata.song_count ?? null,
    total_duration_seconds: data.stats?.total_duration_seconds ?? null,
    like_count: data.stats?.like_count ?? null,
    play_count: data.stats?.play_count ?? null,
    created_at: metadata.created_at || null,
    feed_id: `album:${albumId}`,
  };

  let tracks = [];
  if (includeTracks) {
    const tracksResult = await sunoClient.GET(`/api/playlist/${encodeURIComponent(albumId)}?page=1&page_size=50`);
    if (tracksResult.ok) {
      const clips = tracksResult.data?.playlist_clips || [];
      tracks = clips.map((entry) => normalizeTrack(entry));
    }
  }

  return { album, tracks, next_cursor: null, item_count: tracks.length };
}

async function fetchAlbumMetadata(albumId) {
  const result = await sunoClient.GET(`/api/playlist/v2/${encodeURIComponent(albumId)}`);
  if (!result.ok) throw new Error(result.error || 'Failed to fetch album');
  const data = result.data || {};
  if (!data.metadata) throw new Error(`Album ${albumId} not found`);
  return data;
}

async function assertAlbumOwned(albumId, { allowTrashed = false } = {}) {
  const data = await fetchAlbumMetadata(albumId);
  const relationship = data.relationship || {};
  if (relationship.is_owned === false) {
    throw new Error(`Access denied: album ${albumId} is not owned by you`);
  }
  if (!allowTrashed && relationship.is_trashed) {
    throw new Error(`Album ${albumId} is in the trash; restore it first`);
  }
  if (relationship.is_owned === undefined && data.metadata?.owner?.external_user_id) {
    const me = await getCurrentUser();
    if (me.user_id && data.metadata.owner.external_user_id !== me.user_id) {
      throw new Error(`Access denied: album ${albumId} is not owned by you`);
    }
  }
  return data;
}

function albumType(value) {
  const type = value || 'lp';
  if (!ALBUM_TYPES.includes(type)) {
    throw new Error(`album_type must be one of: ${ALBUM_TYPES.join(', ')}`);
  }
  return type;
}

function ensureMutationSuccess(result, fallbackMessage) {
  if (!result.ok) throw new Error(result.error || fallbackMessage);
  if (result.data && result.data.success === false) {
    const detail = result.data.detail || result.data.message || result.data.errors;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail || result.data));
  }
  return result.data;
}

export function registerAlbumTools(server, allTools) {
  const tools = [
    tool('list_albums', 'List albums in your Suno library (drafts and published), or a user\'s public albums via user_id. Uses the library_albums/user_albums unified feed; falls back to the library album search endpoint for your own library.', {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Albums per page (default 50, max 100)', default: 50 },
        cursor: { type: 'string', description: 'Pagination cursor from a previous call' },
        user_id: { type: 'string', description: 'Optional user UUID to list that user\'s public albums instead of your library' },
      },
    }, async (args) => {
      const pageSize = clampPageSize(args.limit);
      try {
        const feedBody = {
          feed_id: args.user_id ? 'user_albums' : 'library_albums',
          cursor: args.cursor || null,
          page_size: pageSize,
        };
        if (args.user_id) feedBody.target_user_id = args.user_id;
        const result = await sunoClient.POST('/api/unified/feed', { body: feedBody });
        if (!result.ok) throw new Error(result.error || 'Failed to fetch albums');
        const feed = result.data?.feed;
        if (!feed) throw new Error('Albums feed was empty');
        const albums = (feed.items || [])
          .filter((item) => item?.content_type === 'album' && item?.content_item)
          .map((item) => normalizeAlbum(item));
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              albums,
              total: feed.item_count ?? albums.length,
              next_cursor: feed.next_cursor || null,
              source: 'unified_feed',
              user_id: args.user_id || null,
            }, null, 2),
          }],
        };
      } catch (err) {
        if (args.user_id) throw err;
        const fallback = await sunoClient.POST('/api/search/', {
          body: {
            search_queries: [{
              name: 'albums',
              search_type: 'library_album',
              term: '',
              from_index: 0,
              size: pageSize,
              rank_by: 'most_relevant',
            }],
            tune_results: false,
            tuned_offset: 0,
          },
        });
        if (!fallback.ok) throw new Error(err.message || fallback.error || 'Failed to fetch albums');
        const raw = fallback.data?.result?.albums?.result || fallback.data?.result?.album?.result || [];
        const albums = raw.map((album) => normalizeAlbum(album));
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              albums,
              total: fallback.data?.result?.albums?.total_hits ?? albums.length,
              next_cursor: null,
              source: 'library_album_search',
            }, null, 2),
          }],
        };
      }
    }),

    tool('get_album', 'Get Suno album metadata and tracks. Works for your own albums, drafts, and public albums by other users. Uses the album:<id> unified feed with a playlist-endpoint fallback.', {
      type: 'object',
      properties: {
        album_id: { type: 'string', description: 'Album ID' },
        include_tracks: { type: 'boolean', description: 'Include album tracks (default true)', default: true },
        limit: { type: 'number', description: 'Tracks per page (default 50, max 100)', default: 50 },
        cursor: { type: 'string', description: 'Pagination cursor from a previous call' },
      },
      required: ['album_id'],
    }, async (args) => {
      let feed;
      try {
        feed = await fetchAlbumFeed(args.album_id, {
          cursor: args.cursor,
          pageSize: args.limit,
          includeTracks: args.include_tracks !== false,
        });
      } catch (err) {
        feed = await fetchAlbumFallback(args.album_id, { includeTracks: args.include_tracks !== false });
      }
      const response = { album: feed.album };
      if (args.include_tracks !== false) {
        response.tracks = feed.tracks;
        response.track_count = feed.tracks.length;
        response.total_tracks = feed.item_count;
        response.next_cursor = feed.next_cursor;
      }
      return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
    }),

    tool('search_albums', 'Search Suno albums. scope="public" searches public albums; scope="library" searches your own albums (including drafts).', {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Album search query' },
        scope: { type: 'string', enum: ['public', 'library'], description: 'public (default) or library', default: 'public' },
        limit: { type: 'number', description: 'Max results (default 50, max 100)', default: 50 },
      },
      required: ['query'],
    }, async (args) => {
      const scope = args.scope === 'library' ? 'library' : 'public';
      const searchType = scope === 'library' ? 'library_album' : 'album';
      const size = clampPageSize(args.limit);
      const result = await sunoClient.POST('/api/search/', {
        body: {
          search_queries: [{
            name: 'albums',
            search_type: searchType,
            term: args.query,
            from_index: 0,
            size,
            rank_by: 'most_relevant',
          }],
          tune_results: false,
          tuned_offset: 0,
        },
      });
      if (!result.ok) throw new Error(result.error || 'Album search failed');
      const raw = result.data?.result?.albums?.result || result.data?.result?.album?.result || [];
      const albums = raw.map((album) => normalizeAlbum(album));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            query: args.query,
            scope,
            total: result.data?.result?.albums?.total_hits ?? albums.length,
            albums,
          }, null, 2),
        }],
      };
    }),

    tool('create_album', 'Create a new Suno album as a draft. Optionally copy the tracks of an existing owned playlist into the new album via source_playlist_id (the source playlist is left intact). Use publish_album to make it public.', {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Album name' },
        description: { type: 'string', description: 'Album description' },
        album_type: { type: 'string', enum: ALBUM_TYPES, description: 'Album type: lp or ep', default: 'lp' },
        source_playlist_id: { type: 'string', description: 'Optional owned playlist ID whose tracks are copied into the new album' },
      },
      required: ['name'],
    }, async (args) => {
      const name = String(args.name || '').trim();
      if (!name) throw new Error('name is required');
      const type = albumType(args.album_type);

      if (args.source_playlist_id) {
        const source = await sunoClient.GET(`/api/playlist/v2/${encodeURIComponent(args.source_playlist_id)}`);
        if (!source.ok) throw new Error(source.error || 'Failed to fetch source playlist');
        if (source.data?.relationship?.is_owned === false) {
          throw new Error(`Access denied: source playlist ${args.source_playlist_id} is not owned by you`);
        }
      }

      const body = { name, playlist_type: 'album', album_type: type };
      if (args.description !== undefined) body.description = args.description;
      if (args.source_playlist_id) body.source_playlist_id = args.source_playlist_id;

      const result = await sunoClient.POST('/api/playlist/create/', { body });
      if (!result.ok) throw new Error(result.error || 'Album creation failed');
      const created = result.data || {};
      const albumId = created.id;

      let album = {
        id: albumId,
        name: created.name || name,
        image_url: created.image_url || null,
        song_count: created.song_count ?? null,
        album_type: type,
        lifecycle_state: 'draft',
        feed_id: albumId ? `album:${albumId}` : null,
      };
      if (albumId) {
        try {
          const feed = await fetchAlbumFeed(albumId, { includeTracks: false });
          album = feed.album;
        } catch { /* keep the create response */ }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            created: true,
            album,
            source_playlist_id: args.source_playlist_id || null,
          }, null, 2),
        }],
      };
    }),

    tool('update_album_metadata', 'Update an owned album\'s name, description, album type, or cover image S3 ID.', {
      type: 'object',
      properties: {
        album_id: { type: 'string', description: 'Album ID' },
        name: { type: 'string', description: 'New album name' },
        description: { type: 'string', description: 'New album description' },
        album_type: { type: 'string', enum: ALBUM_TYPES, description: 'Album type: lp or ep' },
        cover_image_s3_id: { type: 'string', description: 'Suno S3 image ID for the cover (for example image_...), from an existing upload' },
      },
      required: ['album_id'],
    }, async (args) => {
      const hasUpdate = args.name !== undefined || args.description !== undefined
        || args.album_type !== undefined || args.cover_image_s3_id !== undefined;
      if (!hasUpdate) throw new Error('Provide at least one field to update');

      const data = await assertAlbumOwned(args.album_id);
      const meta = { name: args.name !== undefined ? args.name : data.metadata.name };
      if (args.cover_image_s3_id !== undefined) meta.cover_image_s3_id = args.cover_image_s3_id;

      const body = { metadata: meta };
      if (args.description !== undefined) body.bio = { description: args.description };
      if (args.album_type !== undefined) body.album = { album_type: albumType(args.album_type) };

      const result = await sunoClient.PATCH(`/api/playlist/v2/${encodeURIComponent(args.album_id)}`, { body });
      const updated = ensureMutationSuccess(result, 'Failed to update album');
      return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
    }),

    tool('add_songs_to_album', 'Add owned songs to one of your albums.', {
      type: 'object',
      properties: {
        album_id: { type: 'string', description: 'Album ID' },
        clip_ids: { type: 'array', items: { type: 'string' }, description: 'Array of song clip IDs to add' },
      },
      required: ['album_id', 'clip_ids'],
    }, async (args) => {
      if (!Array.isArray(args.clip_ids) || args.clip_ids.length === 0) {
        throw new Error('clip_ids must be a non-empty array');
      }
      await assertAlbumOwned(args.album_id);
      const result = await sunoClient.POST(`/api/playlist/v2/${encodeURIComponent(args.album_id)}/tracks/add`, {
        body: { clip_ids: args.clip_ids },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to add songs to album');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('remove_songs_from_album', 'Remove songs from one of your albums (the songs remain in your library).', {
      type: 'object',
      properties: {
        album_id: { type: 'string', description: 'Album ID' },
        clip_ids: { type: 'array', items: { type: 'string' }, description: 'Array of song clip IDs to remove' },
      },
      required: ['album_id', 'clip_ids'],
    }, async (args) => {
      if (!Array.isArray(args.clip_ids) || args.clip_ids.length === 0) {
        throw new Error('clip_ids must be a non-empty array');
      }
      await assertAlbumOwned(args.album_id);
      const result = await sunoClient.POST(`/api/playlist/v2/${encodeURIComponent(args.album_id)}/tracks/remove`, {
        body: { clip_ids: args.clip_ids },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to remove songs from album');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('reorder_album_tracks', 'Reorder tracks in one of your albums by clip ID or current index.', {
      type: 'object',
      properties: {
        album_id: { type: 'string', description: 'Album ID' },
        to_index: { type: 'number', description: 'Target index (0-based)' },
        clip_id: { type: 'string', description: 'Clip ID to move (alternative to from_index)' },
        from_index: { type: 'number', description: 'Current index of the track to move (alternative to clip_id)' },
      },
      required: ['album_id', 'to_index'],
    }, async (args) => {
      await assertAlbumOwned(args.album_id);
      const albumId = encodeURIComponent(args.album_id);
      let clipId = args.clip_id || null;

      if (!clipId) {
        if (typeof args.from_index !== 'number') {
          throw new Error('Provide either clip_id or from_index');
        }
        const pageSize = 50;
        const page = Math.floor(args.from_index / pageSize) + 1;
        const tracksResult = await sunoClient.GET(`/api/playlist/${albumId}?page=${page}&page_size=${pageSize}`);
        if (!tracksResult.ok) throw new Error(tracksResult.error || 'Failed to load album tracks');
        const clips = tracksResult.data?.playlist_clips || [];
        const entry = clips[args.from_index % pageSize];
        clipId = entry?.clip?.id || entry?.id || null;
        if (!clipId) throw new Error(`No track found at index ${args.from_index}`);
      }

      const result = await sunoClient.POST(`/api/playlist/v2/${albumId}/tracks/reorder-by-index`, {
        body: { positions: [{ clip_id: clipId, index: args.to_index }] },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to reorder album');
      return { content: [{ type: 'text', text: JSON.stringify({ ...result.data, clip_id: clipId, index: args.to_index }, null, 2) }] };
    }),

    tool('publish_album', 'Publish a draft album, making its tracks public. This is a visibility mutation: all tracks in the album are published unless Suno reports otherwise.', {
      type: 'object',
      properties: {
        album_id: { type: 'string', description: 'Album ID' },
        use_album_cover: { type: 'boolean', description: 'Use the album cover as the cover for the published tracks', default: false },
      },
      required: ['album_id'],
    }, async (args) => {
      await assertAlbumOwned(args.album_id);
      const result = await sunoClient.POST(`/api/playlist/v2/${encodeURIComponent(args.album_id)}/album/publish`, {
        body: { use_album_cover: args.use_album_cover === true },
      });
      const data = ensureMutationSuccess(result, 'Failed to publish album');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }),

    tool('unpublish_album', 'Revert a published album to draft. By default individual songs stay published; set unpublish_songs=true to also unpublish them.', {
      type: 'object',
      properties: {
        album_id: { type: 'string', description: 'Album ID' },
        unpublish_songs: { type: 'boolean', description: 'Also unpublish the album tracks', default: false },
      },
      required: ['album_id'],
    }, async (args) => {
      await assertAlbumOwned(args.album_id);
      const result = await sunoClient.POST(`/api/playlist/v2/${encodeURIComponent(args.album_id)}/album/unpublish`, {
        body: { unpublish_songs: args.unpublish_songs === true },
      });
      const data = ensureMutationSuccess(result, 'Failed to unpublish album');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }),

    tool('delete_album', 'Move an owned album to the trash. Use restore_album to undo.', {
      type: 'object',
      properties: {
        album_id: { type: 'string', description: 'Album ID' },
      },
      required: ['album_id'],
    }, async (args) => {
      await assertAlbumOwned(args.album_id);
      const result = await sunoClient.POST(`/api/playlist/v2/${encodeURIComponent(args.album_id)}/trash`, {
        body: { undo: false },
      });
      ensureMutationSuccess(result, 'Failed to delete album');
      return { content: [{ type: 'text', text: JSON.stringify({ deleted: true, album_id: args.album_id }, null, 2) }] };
    }),

    tool('restore_album', 'Restore an album from the trash.', {
      type: 'object',
      properties: {
        album_id: { type: 'string', description: 'Album ID' },
      },
      required: ['album_id'],
    }, async (args) => {
      await assertAlbumOwned(args.album_id, { allowTrashed: true });
      const result = await sunoClient.POST(`/api/playlist/v2/${encodeURIComponent(args.album_id)}/trash`, {
        body: { undo: true },
      });
      ensureMutationSuccess(result, 'Failed to restore album');
      return { content: [{ type: 'text', text: JSON.stringify({ restored: true, album_id: args.album_id }, null, 2) }] };
    }),
  ];

  allTools.push(...tools);
}
