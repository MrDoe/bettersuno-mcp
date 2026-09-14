import { requestFromExtension } from '../ws-bridge.js';
import { sunoClient } from '../suno-client.js';
import { assertCanCover } from '../auth.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

// `variety` maps to Suno's aug_creativity (V6-only): an integer level 0-4
// (0=off, 1=normal, 2=high, 3=extra, 4=max) sent in metadata.control_sliders.
function buildControlSliders(args) {
  const controlSliders = {};
  const canControl = [];
  if (args.weirdness !== undefined) { controlSliders.weirdness_constraint = args.weirdness / 100; canControl.push('weirdness_constraint'); }
  if (args.style_weight !== undefined) { controlSliders.style_weight = args.style_weight / 100; canControl.push('style_weight'); }
  if (args.audio_weight !== undefined) { controlSliders.audio_weight = args.audio_weight / 100; canControl.push('audio_weight'); }
  // The web UI forces Variety on before Personalize; mirror that by defaulting
  // aug_creativity to level 1 when personalization is requested without one.
  const variety = args.variety !== undefined ? args.variety : (wantsPersonalization(args) ? 1 : undefined);
  if (variety !== undefined) {
    controlSliders.aug_creativity = Math.max(0, Math.min(4, Math.round(Number(variety) || 0)));
    canControl.push('aug_creativity');
  }
  return { controlSliders, canControl };
}

// Suno's V6 era model catalog (session.billingModels external_key / major_model_version):
//   chirp-hawk      = v6     (default)
//   chirp-hawk-wild = v6-wild
//   chirp-goose     = v6-mini
//   chirp-fenix     = v5.5
const MODEL_HELP = 'Model version — V6 chirp-hawk (default), V6-wild chirp-hawk-wild, V6-mini chirp-goose, V5.5 chirp-fenix, V5 chirp-crow, V4.5+ chirp-bluejay, V4.5 chirp-auk, V4 chirp-v4, V3.5 chirp-v3-5';
const DEFAULT_MV = 'chirp-hawk';

function wantsPersonalization(args) {
  return args.personalize === true || args.personalize_lyrics === true || !!args.personalize_user_uuid;
}

function maxModeField(args) {
  return args.max_mode ? { is_max_mode: true } : {};
}

function vocalGenderField(args) {
  if (args.vocal_gender !== 'm' && args.vocal_gender !== 'f') return {};
  return { vocal_gender: args.vocal_gender };
}

// Top-level V6 generation fields: `duration` (song length in seconds, the
// web client's slider range is 10-360 in 5s steps) and the "Personalize"
// (Chameleon) flags `use_personalization`, `do_personalize_lyrics`,
// `personalization_user_uuid`.
function v6OptionFields(args) {
  const f = {};
  if (args.duration !== undefined && args.duration !== null) {
    const seconds = Math.round(Number(args.duration));
    if (Number.isFinite(seconds)) f.duration = Math.max(10, Math.min(360, seconds));
  }
  if (wantsPersonalization(args)) {
    f.use_personalization = true;
    if (args.personalize_user_uuid) f.personalization_user_uuid = args.personalize_user_uuid;
    if (args.personalize_lyrics !== undefined) f.do_personalize_lyrics = !!args.personalize_lyrics;
  }
  return f;
}

// Suno's web client never sends a `persona_model` field; the backend only links
// a clip to its persona (and the GUI shows the voice chip) when the generation
// payload carries the correct `task`. Voice (Vox) personas use `vox` /
// `vox_cover` / `vox_extend`, style personas use `artist_consistency` /
// `artist_cover` / `artist_extend`.
const PERSONA_TASK = {
  vox: { create: 'vox', cover: 'vox_cover', extend: 'vox_extend' },
  style: { create: 'artist_consistency', cover: 'artist_cover', extend: 'artist_extend' },
};

function personaFields(args, operation = 'create') {
  const f = {};
  if (args.persona_id) {
    f.persona_id = args.persona_id;
    const variant = args.persona_model === 'style_persona' ? 'style' : 'vox';
    f.task = PERSONA_TASK[variant][operation];
  }
  return f;
}

function metadataWithSliders(args, createMode) {
  const { controlSliders, canControl } = buildControlSliders(args);
  return {
    web_client_pathname: '/create',
    create_mode: createMode || 'custom',
    create_session_token: crypto.randomUUID(),
    ...maxModeField(args),
    ...vocalGenderField(args),
    ...(Object.keys(controlSliders).length > 0 ? { control_sliders: controlSliders } : {}),
    ...(canControl.length > 0 ? { can_control_sliders: canControl } : {}),
  };
}

const MAX_MODE_PROP = { type: 'boolean', description: 'V6 Max Mode — generates the full-length, highest-quality take (requires a plan with max-mode access)' };
const VOCAL_GENDER_PROP = { type: 'string', enum: ['m', 'f'], description: 'Vocal gender for generated vocals ("m" or "f"; omit to let Suno choose)' };
const DURATION_PROP = { type: 'number', description: 'Target song duration in seconds (V6, 10-360; omit for model default/auto-length)' };
const VARIETY_PROP = { type: 'number', description: 'V6 Variety (aug_creativity) level 0-4: 0=off, 1=normal, 2=high, 3=extra, 4=max' };
const PERSONALIZE_PROP = { type: 'boolean', description: 'Enable V6 Personalize ("My Taste") — requires a Suno account with personalization data' };
const PERSONALIZE_LYRICS_PROP = { type: 'boolean', description: 'Let Personalize also adapt the lyrics (do_personalize_lyrics)' };
const PERSONALIZE_USER_PROP = { type: 'string', description: 'Optional target user UUID for Personalize (personalization_user_uuid)' };

const V6_OPTION_PROPS = {
  duration: DURATION_PROP,
  variety: VARIETY_PROP,
  personalize: PERSONALIZE_PROP,
  personalize_lyrics: PERSONALIZE_LYRICS_PROP,
  personalize_user_uuid: PERSONALIZE_USER_PROP,
};

export function registerGenerationTools(server, allTools) {
  const tools = [
    tool('create_song', 'Generate a song from lyrics and style tags (Custom mode)', {
      type: 'object',
      properties: {
        lyrics: { type: 'string', description: 'Song lyrics with section markers like [Verse], [Chorus]' },
        title: { type: 'string', description: 'Song title' },
        tags: { type: 'string', description: 'Style/genre tags (e.g. "pop, upbeat, synth")' },
        negative_tags: { type: 'string', description: 'Styles to avoid' },
        instrumental: { type: 'boolean', description: 'Make instrumental (no vocals)' },
        mv: { type: 'string', description: MODEL_HELP, default: DEFAULT_MV },
        weirdness: { type: 'number', description: 'Weirdness 0-100' },
        style_weight: { type: 'number', description: 'Style influence 0-100' },
        audio_weight: { type: 'number', description: 'Audio influence 0-100' },
        persona_id: { type: 'string', description: 'Persona ID for voice consistency' },
        persona_model: { type: 'string', description: 'Persona model type (voice_persona for Vox/voice, style_persona for style)', default: 'voice_persona' },
        max_mode: MAX_MODE_PROP,
        vocal_gender: VOCAL_GENDER_PROP,
        ...V6_OPTION_PROPS,
      },
      required: ['lyrics'],
    }, async (args) => {
      const payload = {
        mv: args.mv || DEFAULT_MV,
        gpt_description_prompt: '',
        prompt: args.lyrics,
        make_instrumental: args.instrumental || false,
        title: args.title || '',
        tags: args.tags || '',
        negative_tags: args.negative_tags || '',
        generation_type: 'TEXT',
        continue_at: null,
        continue_clip_id: null,
        task: null,
        ...personaFields(args, 'create'),
        ...v6OptionFields(args),
        metadata: metadataWithSliders(args, 'custom'),
      };

      try {
        const relayResult = await requestFromExtension('relay_generate', { payload }, 30000);
        if (relayResult?.ok) {
          return { content: [{ type: 'text', text: JSON.stringify(relayResult.data, null, 2) }] };
        }
      } catch (_e) {}
      const result = await sunoClient.generate(payload);
      if (!result.ok) throw new Error(result.error || 'Generation failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('inspire_song', 'Generate a song from a description (Suno auto-writes the lyrics)', {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Style/description text (e.g. "a sad ballad about losing a pet")' },
        title: { type: 'string', description: 'Song title' },
        instrumental: { type: 'boolean', description: 'Make instrumental' },
        mv: { type: 'string', description: MODEL_HELP, default: DEFAULT_MV },
        tags: { type: 'string', description: 'Additional style tags' },
        negative_tags: { type: 'string', description: 'Styles to avoid' },
        weirdness: { type: 'number', description: 'Weirdness 0-100' },
        style_weight: { type: 'number', description: 'Style influence 0-100' },
        audio_weight: { type: 'number', description: 'Audio influence 0-100' },
        persona_id: { type: 'string', description: 'Persona ID for voice consistency' },
        persona_model: { type: 'string', description: 'Persona model type (voice_persona for Vox/voice, style_persona for style)', default: 'voice_persona' },
        max_mode: MAX_MODE_PROP,
        vocal_gender: VOCAL_GENDER_PROP,
        ...V6_OPTION_PROPS,
      },
      required: ['description'],
    }, async (args) => {
      const payload = {
        mv: args.mv || DEFAULT_MV,
        gpt_description_prompt: args.description,
        prompt: '',
        make_instrumental: args.instrumental || false,
        title: args.title || '',
        tags: args.tags || '',
        negative_tags: args.negative_tags || '',
        generation_type: 'TEXT',
        continue_at: null,
        continue_clip_id: null,
        task: null,
        ...personaFields(args, 'create'),
        ...v6OptionFields(args),
        metadata: metadataWithSliders(args, 'inspiration'),
      };

      try {
        const relayResult = await requestFromExtension('relay_generate', { payload }, 30000);
        if (relayResult?.ok) {
          return { content: [{ type: 'text', text: JSON.stringify(relayResult.data, null, 2) }] };
        }
      } catch (_e) {}
      const result = await sunoClient.generate(payload);
      if (!result.ok) throw new Error(result.error || 'Generation failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('cover_song', 'Create a cover version of an existing song (optionally with new lyrics)', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'ID of the song to cover' },
        lyrics: { type: 'string', description: 'Optional new lyrics for the cover (if empty, uses original lyrics)' },
        title: { type: 'string', description: 'Song title for the cover' },
        tags: { type: 'string', description: 'Style tags for the cover' },
        negative_tags: { type: 'string', description: 'Styles to avoid' },
        start_s: { type: 'number', description: 'Start time in seconds (optional)' },
        end_s: { type: 'number', description: 'End time in seconds (optional)' },
        mv: { type: 'string', description: MODEL_HELP, default: DEFAULT_MV },
        instrumental: { type: 'boolean', description: 'Make instrumental' },
        weirdness: { type: 'number', description: 'Weirdness 0-100' },
        style_weight: { type: 'number', description: 'Style influence 0-100' },
        audio_weight: { type: 'number', description: 'Audio influence 0-100' },
        persona_id: { type: 'string', description: 'Persona ID for voice consistency' },
        persona_model: { type: 'string', description: 'Persona model type (voice_persona for Vox/voice, style_persona for style)', default: 'voice_persona' },
        max_mode: MAX_MODE_PROP,
        vocal_gender: VOCAL_GENDER_PROP,
        ...V6_OPTION_PROPS,
      },
      required: ['clip_id'],
    }, async (args) => {
      await assertCanCover(args.clip_id);
      const payload = {
        mv: args.mv || DEFAULT_MV,
        gpt_description_prompt: '',
        prompt: args.lyrics || '',
        make_instrumental: args.instrumental || false,
        title: args.title || '',
        tags: args.tags || '',
        negative_tags: args.negative_tags || '',
        generation_type: 'TEXT',
        cover_clip_id: args.clip_id,
        cover_start_s: args.start_s ?? null,
        cover_end_s: args.end_s ?? null,
        continue_at: null,
        continue_clip_id: null,
        task: 'cover',
        ...personaFields(args, 'cover'),
        ...v6OptionFields(args),
        metadata: metadataWithSliders(args, 'custom'),
      };

      const result = await sunoClient.generate(payload);
      if (!result.ok) throw new Error(result.error || 'Cover generation failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('extend_song', 'Extend a song from a specific point', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'ID of the song to extend' },
        continue_at: { type: 'number', description: 'Time in seconds to extend from' },
        lyrics: { type: 'string', description: 'Optional lyrics for the extension' },
        mv: { type: 'string', description: MODEL_HELP, default: DEFAULT_MV },
        tags: { type: 'string', description: 'Style tags for the extension' },
        negative_tags: { type: 'string', description: 'Styles to avoid' },
        instrumental: { type: 'boolean', description: 'Make instrumental' },
        weirdness: { type: 'number', description: 'Weirdness 0-100' },
        style_weight: { type: 'number', description: 'Style influence 0-100' },
        audio_weight: { type: 'number', description: 'Audio influence 0-100' },
        persona_id: { type: 'string', description: 'Persona ID for voice consistency' },
        persona_model: { type: 'string', description: 'Persona model type (voice_persona for Vox/voice, style_persona for style)', default: 'voice_persona' },
        max_mode: MAX_MODE_PROP,
        vocal_gender: VOCAL_GENDER_PROP,
        ...V6_OPTION_PROPS,
      },
      required: ['clip_id', 'continue_at'],
    }, async (args) => {
      await assertCanCover(args.clip_id);
      const payload = {
        mv: args.mv || DEFAULT_MV,
        gpt_description_prompt: '',
        prompt: args.lyrics || '',
        make_instrumental: args.instrumental || false,
        title: '',
        tags: args.tags || '',
        negative_tags: args.negative_tags || '',
        generation_type: 'TEXT',
        continue_clip_id: args.clip_id,
        continue_at: args.continue_at,
        cover_clip_id: null,
        task: 'extend',
        ...personaFields(args, 'extend'),
        ...v6OptionFields(args),
        metadata: metadataWithSliders(args, 'custom'),
      };

      const result = await sunoClient.generate(payload);
      if (!result.ok) throw new Error(result.error || 'Extend failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('mashup_song', 'Blend two or more songs into a mashup', {
      type: 'object',
      properties: {
        clip_ids: { type: 'array', items: { type: 'string' }, description: 'Song clip IDs to blend (2 or more)' },
        title: { type: 'string', description: 'Mashup title' },
        tags: { type: 'string', description: 'Style tags for the mashup' },
        mv: { type: 'string', description: MODEL_HELP, default: DEFAULT_MV },
      },
      required: ['clip_ids'],
    }, async (args) => {
      if (!Array.isArray(args.clip_ids) || args.clip_ids.length < 2) {
        throw new Error('Provide at least 2 clip IDs to mashup');
      }
      for (const id of args.clip_ids) await assertCanCover(id);
      const payload = {
        mv: args.mv || DEFAULT_MV,
        gpt_description_prompt: '',
        prompt: '',
        make_instrumental: false,
        title: args.title || '',
        tags: args.tags || '',
        generation_type: 'TEXT',
        mashup_clip_ids: args.clip_ids,
        task: 'mashup_condition',
        cover_clip_id: null,
        continue_clip_id: null,
        continue_at: null,
        metadata: {
          web_client_pathname: '/create',
          create_mode: 'custom',
          create_session_token: crypto.randomUUID(),
        },
      };
      const result = await sunoClient.generate(payload);
      if (!result.ok) throw new Error(result.error || 'Mashup generation failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('concat_songs', 'Concatenate/replace section of a song (used for add vocals, add instrumental, replace section)', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'ID of the source song clip' },
        is_infill: { type: 'boolean', description: 'Whether this is an infill (replace section) operation', default: false },
        edit_session_id: { type: 'string', description: 'Optional edit session ID for tracking' },
      },
      required: ['clip_id'],
    }, async (args) => {
      const body = {
        clip_id: args.clip_id,
        is_infill: args.is_infill || false,
      };
      if (args.edit_session_id) body.edit_session_id = args.edit_session_id;

      const result = await sunoClient.POST('/api/generate/concat/v2/', { body });
      if (!result.ok) throw new Error(result.error || 'Concat failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('remaster_song', 'Remaster/upsample a song to higher quality', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'ID of the song to remaster' },
        model_name: { type: 'string', description: 'Target model (optional)' },
        tags: { type: 'string', description: 'Style tags to apply' },
        freedom: { type: 'number', description: 'Variation freedom 0.0-1.0' },
        tone: { type: 'number', description: 'Tone adjustment 0.0-1.0' },
        clarity: { type: 'number', description: 'Clarity 0.0-1.0' },
        strength: { type: 'number', description: 'Strength 0.0-1.0' },
        stereo_width: { type: 'number', description: 'Stereo width 0.0-1.0' },
        variation_category: { type: 'string', description: 'Variation category' },
      },
      required: ['clip_id'],
    }, async (args) => {
      const body = { clip_id: args.clip_id };
      if (args.model_name) body.model_name = args.model_name;
      if (args.tags) body.tags = args.tags;
      if (args.freedom !== undefined) body.freedom = Math.max(0, Math.min(1, args.freedom));
      if (args.tone !== undefined) body.tone = Math.max(0, Math.min(1, args.tone));
      if (args.clarity !== undefined) body.clarity = Math.max(0, Math.min(1, args.clarity));
      if (args.strength !== undefined) body.strength = Math.max(0, Math.min(1, args.strength));
      if (args.stereo_width !== undefined) body.stereo_width = Math.max(0, Math.min(1, args.stereo_width));
      if (args.variation_category) body.variation_category = args.variation_category;

      const result = await sunoClient.POST('/api/generate/upsample', { body });
      if (!result.ok) throw new Error(result.error || 'Remaster failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('make_stems', 'Extract stems (vocals, instrumental, drums, bass) from a song', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'ID of the song to extract stems from' },
      },
      required: ['clip_id'],
    }, async (args) => {
      const result = await sunoClient.POST(`/api/edit/stems/${encodeURIComponent(args.clip_id)}/`);
      if (!result.ok) throw new Error(result.error || 'Stem extraction failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('generate_lyrics', 'Generate lyrics from a description using AI', {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Description of the lyrics you want (genre, theme, mood, etc.)' },
        title: { type: 'string', description: 'Song title (optional)' },
        style: { type: 'string', description: 'Music style/genre for the lyrics' },
        lyrics_model: { type: 'string', description: 'Lyrics generation model (default, remi-v1)', default: 'default' },
      },
      required: ['prompt'],
    }, async (args) => {
      const body = {
        prompt: args.prompt,
        ...(args.title ? { title: args.title } : {}),
        ...(args.style ? { tags: args.style } : {}),
        lyrics_model: args.lyrics_model || 'default',
      };
      const result = await sunoClient.POST('/api/generate/cowrite-lyrics', { body });
      if (!result.ok) throw new Error(result.error || 'Lyrics generation failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('lyrics_infill', 'Infill/generate missing lyrics in a partially written lyric', {
      type: 'object',
      properties: {
        lyrics: { type: 'string', description: 'Partial lyrics with [...] placeholders for sections to infill' },
        style: { type: 'string', description: 'Music style context' },
        lyrics_model: { type: 'string', description: 'Lyrics model (default, remi-v1)', default: 'default' },
      },
      required: ['lyrics'],
    }, async (args) => {
      const body = {
        prompt: args.lyrics,
        ...(args.style ? { tags: args.style } : {}),
        lyrics_model: args.lyrics_model || 'default',
      };
      const result = await sunoClient.POST('/api/generate/lyrics-infill/', { body });
      if (!result.ok) throw new Error(result.error || 'Lyrics infill failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('lyrics_mashup', 'Mashup two sets of lyrics into one', {
      type: 'object',
      properties: {
        lyrics_a: { type: 'string', description: 'First set of lyrics' },
        lyrics_b: { type: 'string', description: 'Second set of lyrics' },
      },
      required: ['lyrics_a', 'lyrics_b'],
    }, async (args) => {
      const body = {
        lyrics_a: args.lyrics_a,
        lyrics_b: args.lyrics_b,
        create_session_token: crypto.randomUUID(),
        source: 'mcp',
      };
      const result = await sunoClient.POST('/api/generate/lyrics-mashup', { body });
      if (!result.ok) throw new Error(result.error || 'Lyrics mashup failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_recommended_styles', 'Get recommended style tags for inspiration', {
      type: 'object',
      properties: {},
    }, async () => {
      const result = await sunoClient.GET('/api/generate/get_recommend_styles');
      if (!result.ok) throw new Error(result.error || 'Failed to fetch styles');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('upsample_tags', 'Expand and enhance style tags with AI suggestions', {
      type: 'object',
      properties: {
        tags: { type: 'string', description: 'Base style tags to expand' },
      },
      required: ['tags'],
    }, async (args) => {
      const result = await sunoClient.POST('/api/prompts/upsample', { body: { prompt: args.tags } });
      if (!result.ok) throw new Error(result.error || 'Tag upsample failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),


  ];

  allTools.push(...tools);
}
