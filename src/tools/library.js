import { sunoClient } from '../suno-client.js';
import { getCurrentUser } from '../auth.js';
import { requestFromExtension } from '../ws-bridge.js';

const V6_MODELS = new Set(['chirp-hawk', 'chirp-hawk-wild', 'chirp-goose']);

function isV6Clip(clip) {
  return clip.major_model_version === 'v6' || V6_MODELS.has(clip.model_name);
}

function isPlayedClip(clip) {
  return typeof clip.play_count === 'number' && clip.play_count > 0;
}

function isUnplayedClip(clip) {
  return typeof clip.play_count === 'number' && clip.play_count === 0;
}

function matchesDbModel(song, model) {
  if (!model) return true;
  const wanted = String(model).toLowerCase();
  if (wanted === 'v6') return isV6Clip(song);
  return String(song.major_model_version || '').toLowerCase() === wanted
    || String(song.model_name || '').toLowerCase() === wanted;
}

async function loadExtensionDbSongs() {
  const res = await requestFromExtension('get_db_songs');
  if (!res.ok) throw new Error(res.error || 'Failed to read the BetterSuno extension database');
  return { songs: res.data?.songs || [], fetchedAt: res.data?.fetchedAt || null };
}

function getSongTimestamp(song) {
  const ts = Date.parse(song.created_at || '');
  return Number.isFinite(ts) ? ts : 0;
}

function summarizeDbSongs(songs) {
  const byModel = {};
  let publicCount = 0;
  let likedCount = 0;
  let playedCount = 0;
  let unplayedCount = 0;
  let v6Count = 0;
  for (const song of songs) {
    const model = song.model_name || 'unknown';
    const version = song.major_model_version || 'unknown';
    const key = `${model} (${version})`;
    byModel[key] = (byModel[key] || 0) + 1;
    if (song.is_public) publicCount += 1;
    if (song.is_liked) likedCount += 1;
    if (isPlayedClip(song)) playedCount += 1;
    else if (isUnplayedClip(song)) unplayedCount += 1;
    if (isV6Clip(song)) v6Count += 1;
  }
  return {
    total: songs.length,
    public: publicCount,
    private: songs.length - publicCount,
    liked: likedCount,
    played: playedCount,
    unplayed: unplayedCount,
    play_count_unknown: songs.length - playedCount - unplayedCount,
    v6_count: v6Count,
    non_v6_count: songs.length - v6Count,
    by_model: byModel,
  };
}

const DB_SONG_FIELDS = ['id', 'title', 'model_name', 'major_model_version', 'play_count', 'is_played', 'is_public', 'is_liked', 'upvote_count', 'created_at', 'task', 'cover_clip_id'];

function toSlimDbSong(song) {
  const slim = {};
  for (const key of DB_SONG_FIELDS) {
    if (key === 'is_played') slim[key] = isPlayedClip(song);
    else if (song[key] !== undefined) slim[key] = song[key];
  }
  return slim;
}

const MONTH_ONLY_RE = /^\d{4}-\d{2}$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const LYRIC_CLIP_BATCH_SIZE = 100;

function parseDateBound(value, { endOfDay = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (MONTH_ONLY_RE.test(raw)) {
    const [year, month] = raw.split('-').map(Number);
    if (month < 1 || month > 12) throw new Error(`Invalid date: ${raw}`);
    const start = Date.UTC(year, month - 1, 1);
    return endOfDay ? Date.UTC(year, month, 1) - 1 : start;
  }
  if (DATE_ONLY_RE.test(raw)) {
    const start = Date.parse(`${raw}T00:00:00.000Z`);
    if (!Number.isFinite(start)) throw new Error(`Invalid date: ${raw}`);
    return endOfDay ? start + 86400000 - 1 : start;
  }
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) throw new Error(`Invalid date: ${raw}`);
  return ts;
}

// Case-, punctuation-, and whitespace-insensitive text used for lyric matching.
function normalizeLyricText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['\u2018\u2019\u02BC]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function findLyricExcerpt(prompt, normalizedQuery) {
  const text = String(prompt || '');
  const words = normalizedQuery.split(' ').filter(word => word.length >= 3);
  let best = '';
  let bestScore = -1;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const normalizedLine = normalizeLyricText(line);
    let score = 0;
    if (normalizedLine.includes(normalizedQuery)) score += words.length + 1;
    for (const word of words) {
      if (normalizedLine.includes(word)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = line;
    }
  }
  const excerpt = best || text.trim().slice(0, 300);
  return excerpt.length > 500 ? `${excerpt.slice(0, 497)}...` : excerpt;
}

async function fetchClipsByIds(ids) {
  const clipsById = new Map();
  for (let index = 0; index < ids.length; index += LYRIC_CLIP_BATCH_SIZE) {
    const batch = ids.slice(index, index + LYRIC_CLIP_BATCH_SIZE);
    const result = await sunoClient.POST('/api/feed/v3', {
      body: {
        limit: batch.length,
        filters: { ids: { presence: 'True', clipIds: batch } },
      },
    });
    if (!result.ok) throw new Error(result.error || 'Failed to fetch clips for lyric search');
    for (const clip of result.data?.clips || []) {
      if (clip?.id) clipsById.set(clip.id, clip);
    }
    if (index + LYRIC_CLIP_BATCH_SIZE < ids.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  return clipsById;
}

function lyricMatch(clip, normalizedQuery, includeLyrics) {
  const prompt = clip.metadata?.prompt || '';
  const match = {
    id: clip.id,
    title: clip.title || null,
    created_at: clip.created_at || null,
    model_name: clip.model_name || null,
    major_model_version: clip.major_model_version || null,
    is_public: !!clip.is_public,
    duration: clip.metadata?.duration ?? null,
    tags: clip.metadata?.tags || null,
    excerpt: findLyricExcerpt(prompt, normalizedQuery),
  };
  if (includeLyrics) match.lyrics = prompt;
  return match;
}

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

export function registerLibraryTools(server, allTools) {
  const tools = [
    tool('list_library', 'List the user\'s song library', {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of songs per page', default: 50 },
        cursor: { type: 'string', description: 'Pagination cursor from previous response' },
        liked_only: { type: 'boolean', description: 'Show only liked songs' },
        public_only: { type: 'boolean', description: 'Show only public songs' },
        stems_only: { type: 'boolean', description: 'Show only stems' },
        sort: { type: 'string', description: 'Sort order', enum: ['newest', 'oldest'] },
      },
    }, async (args) => {
      const filters = {};
      if (args.liked_only) filters.liked = 'True';
      // V6 feed filter key is `public` (BooleanFilter), not `is_public`.
      if (args.public_only) filters.public = 'True';
      if (args.stems_only) filters.stem = { presence: 'True' };
      if (args.sort === 'oldest') filters.sort = 'created_asc';

      const body = {
        limit: args.limit || 50,
        cursor: args.cursor || null,
        filters: Object.keys(filters).length > 0 ? filters : undefined,
      };

      const result = await sunoClient.POST('/api/feed/v3', { body });
      if (!result.ok) throw new Error(result.error || 'Failed to fetch library');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_song', 'Get details for a single song', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
      },
      required: ['clip_id'],
    }, async (args) => {
      const result = await sunoClient.GET(`/api/clip/${encodeURIComponent(args.clip_id)}`);
      if (!result.ok) throw new Error(result.error || 'Failed to fetch song');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_songs_by_ids', 'Batch get multiple songs by their IDs', {
      type: 'object',
      properties: {
        clip_ids: { type: 'array', items: { type: 'string' }, description: 'Array of song clip IDs' },
      },
      required: ['clip_ids'],
    }, async (args) => {
      const result = await sunoClient.POST('/api/clips/get_songs_by_ids', { body: { ids: args.clip_ids } });
      if (!result.ok) throw new Error(result.error || 'Failed to fetch songs');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('search_songs', 'Search the current user\'s own songs by query text', {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        page: { type: 'number', description: 'Page number', default: 1 },
        limit: { type: 'number', description: 'Max results per page', default: 50 },
      },
      required: ['query'],
    }, async (args) => {
      const me = await getCurrentUser();
      const size = Math.min(Math.max(parseInt(args.limit, 10) || 50, 100), 100);
      const fromIndex = ((parseInt(args.page, 10) || 1) - 1) * size;
      const result = await sunoClient.POST('/api/search/', {
        body: {
          search_queries: [{
            name: 'songs',
            search_type: 'song',
            term: args.query,
            from_index: fromIndex,
            size,
            rank_by: 'most_relevant',
          }],
          tune_results: false,
          tuned_offset: 0,
        },
      });
      if (!result.ok) throw new Error(result.error || 'Search failed');

      const data = result.data || {};
      let raw = [];
      if (Array.isArray(data?.result?.song?.result)) raw = data.result.song.result;
      else if (Array.isArray(data?.result?.songs?.result)) raw = data.result.songs.result;
      else if (Array.isArray(data?.result?.song)) raw = data.result.song;
      else if (Array.isArray(data?.songs)) raw = data.songs;
      else if (Array.isArray(data?.result)) raw = data.result;

      const own = raw
        .map((item) => item?.clip || item?.song || item)
        .filter((clip) => clip && clip.user_id === me.user_id);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ query: args.query, owner_user_id: me.user_id, count: own.length, clips: own }, null, 2),
        }],
      };
    }),

    tool('search_users', 'Search Suno users by query text', {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'User search query' },
      },
      required: ['query'],
    }, async (args) => {
      const result = await sunoClient.POST('/api/search/', {
        search_queries: [
          {
            name: 'users',
            search_type: 'user',
            term: args.query,
            from_index: 0,
            size: 100,
            rank_by: 'most_relevant',
          },
        ],
        tune_results: false,
        tuned_offset: 0,
      });
      if (!result.ok) throw new Error(result.error || 'User search failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_profile', 'Get a user profile by handle', {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'User handle (e.g. @username)' },
      },
      required: ['handle'],
    }, async (args) => {
      const result = await sunoClient.GET(`/api/profiles/${encodeURIComponent(args.handle)}`);
      if (!result.ok) throw new Error(result.error || 'Failed to fetch profile');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_current_user', 'Get the current user\'s account info (credits, subscription, plan)', {
      type: 'object',
      properties: {},
    }, async () => {
      const result = await sunoClient.GET('/api/user/me');
      if (!result.ok) throw new Error(result.error || 'Failed to fetch user info');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_user_session', 'Get current user session info', {
      type: 'object',
      properties: {},
    }, async () => {
      const result = await sunoClient.GET('/api/session/');
      if (!result.ok) throw new Error(result.error || 'Failed to fetch session');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_library_stats', 'Aggregate library statistics: song counts per model/version, public/private split, played status, and V6 coverage (optionally returns the non-V6 song list). source="api" walks feed/v3; source="db" reads the BetterSuno extension IndexedDB (no API calls, needs the extension connected).', {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['all', 'public', 'liked'], description: 'Which songs to scan (default all)', default: 'all' },
        source: { type: 'string', enum: ['api', 'db'], description: 'Data source: Suno API feed (api, default) or the extension\'s cached database (db)', default: 'api' },
        max_songs: { type: 'number', description: 'Safety cap on songs scanned (default 2500, max 20000). Set truncated=true in the result means more remain.', default: 2500 },
        include_songs: { type: 'boolean', description: 'Also return the non-V6 song list (id, title, model, created_at, is_public, play_count)', default: false },
      },
    }, async (args) => {
      const scope = ['public', 'liked'].includes(args.scope) ? args.scope : 'all';

      if (args.source === 'db') {
        const { songs, fetchedAt } = await loadExtensionDbSongs();
        let scoped = songs;
        if (scope === 'public') scoped = songs.filter(s => s.is_public);
        else if (scope === 'liked') scoped = songs.filter(s => s.is_liked);

        const summary = {
          source: 'db',
          scope,
          db_total: songs.length,
          db_fetched_at: fetchedAt,
          songs_scanned: scoped.length,
          truncated: false,
          ...summarizeDbSongs(scoped),
        };
        if (args.include_songs) {
          summary.non_v6_songs = scoped.filter(s => !isV6Clip(s)).map(s => ({
            id: s.id,
            title: s.title,
            model_name: s.model_name || 'unknown',
            major_model_version: s.major_model_version || 'unknown',
            created_at: s.created_at || null,
            is_public: !!s.is_public,
            play_count: s.play_count ?? null,
            is_played: isPlayedClip(s),
            task: s.task || null,
            cover_clip_id: s.cover_clip_id || null,
          }));
        }
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
      }

      const maxSongs = Math.max(1, Math.min(20000, parseInt(args.max_songs, 10) || 2500));
      const filters = scope === 'public' ? { public: 'True' } : scope === 'liked' ? { liked: 'True' } : undefined;

      const byModel = {};
      const nonV6Songs = [];
      let cursor = null;
      let scanned = 0;
      let publicCount = 0;
      let privateCount = 0;
      let v6Count = 0;

      while (scanned < maxSongs) {
        const body = { limit: 50, cursor };
        if (filters) body.filters = filters;
        const result = await sunoClient.POST('/api/feed/v3', { body });
        if (!result.ok) throw new Error(result.error || 'Failed to fetch library');
        const clips = result.data?.clips || [];
        if (clips.length === 0) break;

        for (const clip of clips) {
          scanned += 1;
          const model = clip.model_name || 'unknown';
          const version = clip.major_model_version || 'unknown';
          const key = `${model} (${version})`;
          byModel[key] = (byModel[key] || 0) + 1;
          if (clip.is_public) publicCount += 1; else privateCount += 1;
          if (isV6Clip(clip)) v6Count += 1;
          else if (args.include_songs) {
            nonV6Songs.push({
              id: clip.id,
              title: clip.title,
              model_name: model,
              major_model_version: version,
              created_at: clip.created_at,
              is_public: !!clip.is_public,
            });
          }
        }

        cursor = result.data?.next_cursor || null;
        if (!cursor) break;
        await new Promise(r => setTimeout(r, 750));
      }

      const summary = {
        source: 'api',
        scope,
        songs_scanned: scanned,
        truncated: !!cursor,
        public: publicCount,
        private: privateCount,
        v6_count: v6Count,
        non_v6_count: scanned - v6Count,
        by_model: byModel,
      };
      if (args.include_songs) summary.non_v6_songs = nonV6Songs;
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    }),

    tool('get_db_songs', 'Read the song library cached in the BetterSuno extension\'s IndexedDB (songsList) — no Suno API calls. Includes Suno model version and played status. Populate the cache with the extension\'s "Fetch Songs" button first; requires the extension to be connected.', {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Case-insensitive title substring filter' },
        model: { type: 'string', description: 'Filter by model version or name, e.g. "v6", "v5.5", "chirp-hawk", "chirp-fenix"' },
        played: { type: 'string', enum: ['any', 'played', 'unplayed'], description: 'Played-status filter based on play_count', default: 'any' },
        liked_only: { type: 'boolean', description: 'Only liked songs', default: false },
        public_only: { type: 'boolean', description: 'Only public songs', default: false },
        sort: { type: 'string', enum: ['created_desc', 'created_asc', 'plays_desc', 'upvotes_desc', 'title'], description: 'Sort order', default: 'created_desc' },
        limit: { type: 'number', description: 'Max songs to return (default 100, max 5000)', default: 100 },
        offset: { type: 'number', description: 'Pagination offset', default: 0 },
        include_stats: { type: 'boolean', description: 'Include aggregate stats over all matching songs (per-model, V6 coverage, played/unplayed)', default: false },
      },
    }, async (args) => {
      const { songs, fetchedAt } = await loadExtensionDbSongs();
      let filtered = songs;

      if (args.search) {
        const q = String(args.search).toLowerCase();
        filtered = filtered.filter(s => (s.title || '').toLowerCase().includes(q));
      }
      if (args.model) filtered = filtered.filter(s => matchesDbModel(s, args.model));
      if (args.played === 'played') filtered = filtered.filter(isPlayedClip);
      else if (args.played === 'unplayed') filtered = filtered.filter(isUnplayedClip);
      if (args.liked_only) filtered = filtered.filter(s => s.is_liked === true);
      if (args.public_only) filtered = filtered.filter(s => s.is_public === true);

      const sort = args.sort || 'created_desc';
      filtered = [...filtered].sort((a, b) => {
        if (sort === 'created_asc') return getSongTimestamp(a) - getSongTimestamp(b);
        if (sort === 'plays_desc') return (b.play_count || 0) - (a.play_count || 0) || getSongTimestamp(b) - getSongTimestamp(a);
        if (sort === 'upvotes_desc') return (b.upvote_count || 0) - (a.upvote_count || 0) || getSongTimestamp(b) - getSongTimestamp(a);
        if (sort === 'title') return (a.title || '').localeCompare(b.title || '');
        return getSongTimestamp(b) - getSongTimestamp(a);
      });

      const limit = Math.max(1, Math.min(5000, parseInt(args.limit, 10) || 100));
      const offset = Math.max(0, parseInt(args.offset, 10) || 0);
      const page = filtered.slice(offset, offset + limit).map(toSlimDbSong);

      const result = {
        source: 'extension_indexeddb',
        db_total: songs.length,
        db_fetched_at: fetchedAt,
        total_matching: filtered.length,
        offset,
        returned: page.length,
      };
      if (args.include_stats) result.stats = summarizeDbSongs(filtered);
      result.songs = page;
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }),

    tool('search_by_lyrics', 'Search the user\'s own songs for a lyric phrase. Matching is case-, punctuation-, and whitespace-insensitive. When the BetterSuno extension is connected, candidates come from its IndexedDB cache (fast, no feed pagination) and can be narrowed with created_after/created_before; full clips are then fetched in batches to inspect metadata.prompt. Falls back to paginating feed/v3 when the extension is unavailable.', {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Lyric phrase to find (case- and punctuation-insensitive; line breaks and extra whitespace are ignored)' },
        created_after: { type: 'string', description: 'Only songs created on/after this date. Accepts ISO 8601, YYYY-MM-DD, or YYYY-MM (month start)' },
        created_before: { type: 'string', description: 'Only songs created on/before this date. Accepts ISO 8601, YYYY-MM-DD, or YYYY-MM (date-only values include the whole day/month)' },
        source: { type: 'string', enum: ['auto', 'db', 'api'], description: 'Candidate source: auto (extension DB, fall back to feed), db (extension DB only), api (paginate feed/v3)', default: 'auto' },
        max_songs: { type: 'number', description: 'Maximum candidate songs to inspect (default 2500). Applies to DB candidates and the API fallback.', default: 2500 },
        limit: { type: 'number', description: 'Maximum matching songs to return (default 100)', default: 100 },
        include_lyrics: { type: 'boolean', description: 'Include the full lyrics (metadata.prompt) for each match', default: false },
      },
      required: ['query'],
    }, async (args) => {
      const query = String(args.query || '').trim();
      if (!query) throw new Error('query is required');
      const normalizedQuery = normalizeLyricText(query);
      if (!normalizedQuery) throw new Error('query must contain at least one letter or number');

      const createdAfter = parseDateBound(args.created_after, { endOfDay: false });
      const createdBefore = parseDateBound(args.created_before, { endOfDay: true });
      if (createdAfter !== null && createdBefore !== null && createdAfter > createdBefore) {
        throw new Error('created_after must be before created_before');
      }

      const source = ['auto', 'db', 'api'].includes(args.source) ? args.source : 'auto';
      const maxSongs = Math.max(1, Math.min(50000, parseInt(args.max_songs, 10) || 2500));
      const limit = Math.max(1, Math.min(1000, parseInt(args.limit, 10) || 100));
      const includeLyrics = args.include_lyrics === true;

      let candidates = null;
      let dbError = null;
      if (source !== 'api') {
        try {
          const { songs, fetchedAt } = await loadExtensionDbSongs();
          const inRange = [];
          for (const song of songs) {
            const ts = getSongTimestamp(song);
            if (!ts) continue;
            if (createdAfter !== null && ts < createdAfter) continue;
            if (createdBefore !== null && ts > createdBefore) continue;
            inRange.push(song);
          }
          inRange.sort((a, b) => getSongTimestamp(b) - getSongTimestamp(a));
          const selected = inRange.slice(0, maxSongs);
          candidates = {
            ids: [...new Set(selected.map(song => song.id).filter(Boolean))],
            source: 'extension_indexeddb',
            db_total: songs.length,
            db_fetched_at: fetchedAt,
            candidates_total: inRange.length,
            truncated: inRange.length > selected.length,
          };
        } catch (err) {
          dbError = err.message;
          if (source === 'db') throw err;
        }
      }

      const allMatches = [];
      let scanned = 0;
      let withLyrics = 0;
      let truncated = !!(candidates && candidates.truncated);

      if (candidates) {
        const clipsById = await fetchClipsByIds(candidates.ids);
        for (const id of candidates.ids) {
          const clip = clipsById.get(id);
          if (!clip) continue;
          scanned += 1;
          const prompt = clip.metadata?.prompt || '';
          if (!prompt) continue;
          withLyrics += 1;
          if (normalizeLyricText(prompt).includes(normalizedQuery)) {
            allMatches.push(lyricMatch(clip, normalizedQuery, includeLyrics));
          }
        }
      } else {
        // Feed pagination is newest-first, so a created_after bound lets us stop
        // as soon as we reach older songs.
        let cursor = null;
        let reachedOlder = false;
        let reachedMax = false;
        while (scanned < maxSongs && !reachedOlder) {
          const result = await sunoClient.POST('/api/feed/v3', { body: { limit: 50, cursor } });
          if (!result.ok) throw new Error(result.error || 'Failed to fetch library');
          const clips = result.data?.clips || [];
          if (clips.length === 0) break;
          for (const clip of clips) {
            if (scanned >= maxSongs) {
              reachedMax = true;
              break;
            }
            const ts = Date.parse(clip.created_at || '');
            const hasTs = Number.isFinite(ts);
            if (createdBefore !== null && hasTs && ts > createdBefore) continue;
            if (createdAfter !== null && hasTs && ts < createdAfter) {
              reachedOlder = true;
              continue;
            }
            scanned += 1;
            const prompt = clip.metadata?.prompt || '';
            if (!prompt) continue;
            withLyrics += 1;
            if (normalizeLyricText(prompt).includes(normalizedQuery)) {
              allMatches.push(lyricMatch(clip, normalizedQuery, includeLyrics));
            }
          }
          cursor = result.data?.next_cursor || null;
          if (!cursor) break;
          if (scanned < maxSongs && !reachedOlder) {
            await new Promise(resolve => setTimeout(resolve, 750));
          }
        }
        if (reachedMax || (scanned >= maxSongs && cursor)) truncated = true;
      }

      const matches = allMatches.slice(0, limit);
      if (allMatches.length > limit) truncated = true;

      const response = {
        query,
        normalized_query: normalizedQuery,
        created_after: args.created_after ?? null,
        created_before: args.created_before ?? null,
        source: candidates?.source || 'api_feed',
        scanned,
        with_lyrics: withLyrics,
        match_count: matches.length,
        truncated,
        matches,
      };
      if (candidates) {
        response.db_total = candidates.db_total;
        response.db_fetched_at = candidates.db_fetched_at;
        response.candidates_total = candidates.candidates_total;
      }
      if (dbError) response.db_fallback_reason = dbError;
      return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
    }),
  ];

  allTools.push(...tools);
}
