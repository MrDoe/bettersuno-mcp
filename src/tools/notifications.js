import { sunoClient } from '../suno-client.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

function normalizeNotification(n) {
  return {
    id: n.id,
    notification_type: n.notification_type || null,
    content_id: n.content_id || null,
    template: n.template || null,
    updated_at: n.updated_at || null,
    is_read: !!n.is_read,
    text: n.text || [],
    avatars: n.avatars || [],
    actions: n.actions || [],
  };
}

export function registerNotificationTools(server, allTools) {
  const tools = [
    tool('list_notifications', 'List your Suno notifications (likes, comments, follows, system messages). Returns the raw notification payload so action URLs and text are preserved.', {
      type: 'object',
      properties: {
        cursor: { type: 'string', description: 'before_datetime_utc cursor from a previous response' },
        include_hooks: { type: 'boolean', description: 'Include hook notifications', default: true },
      },
    }, async (args) => {
      const params = new URLSearchParams();
      if (args.cursor) params.set('before_datetime_utc', args.cursor);
      if (args.include_hooks !== false) params.set('include_hooks', 'true');
      const query = params.toString();
      const result = await sunoClient.GET(`/api/notification/v3${query ? `?${query}` : ''}`);
      if (!result.ok) throw new Error(result.error || 'Failed to fetch notifications');
      const data = result.data || {};
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            notifications: (data.notifications || []).map(normalizeNotification),
            next_cursor: data.next_before_datetime_utc || data.next_cursor || null,
            notified_at: data.notified_at || null,
            count: (data.notifications || []).length,
          }, null, 2),
        }],
      };
    }),

    tool('mark_notifications_read', 'Mark specific notifications as read, or mark all notifications read up to a timestamp.', {
      type: 'object',
      properties: {
        notification_ids: { type: 'array', items: { type: 'string' }, description: 'Notification IDs to mark read' },
        all: { type: 'boolean', description: 'Mark all notifications read (optionally up to before_datetime_utc)', default: false },
        before_datetime_utc: { type: 'string', description: 'Only mark notifications updated before this ISO timestamp when all=true' },
      },
    }, async (args) => {
      const ids = Array.isArray(args.notification_ids) ? args.notification_ids.filter(Boolean) : [];
      if (!args.all && ids.length === 0) {
        throw new Error('Provide notification_ids or set all=true');
      }
      const body = args.all
        ? { all: true, before_datetime_utc: args.before_datetime_utc || new Date().toISOString() }
        : { ids };
      const result = await sunoClient.POST('/api/notification/v2/read', { body });
      if (!result.ok) throw new Error(result.error || 'Failed to mark notifications read');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ marked_read: args.all ? 'all' : ids.length, ids: args.all ? undefined : ids }, null, 2),
        }],
      };
    }),

    tool('get_notification_badge', 'Get your unread notification badge count.', {
      type: 'object',
      properties: {},
    }, async () => {
      const result = await sunoClient.GET('/api/notification/v2/badge-count');
      if (!result.ok) throw new Error(result.error || 'Failed to fetch notification badge');
      return { content: [{ type: 'text', text: JSON.stringify({ badge_count: result.data?.badge_count ?? 0 }, null, 2) }] };
    }),

    tool('clear_notification_badge', 'Clear the notification badge count (does not mark individual notifications read).', {
      type: 'object',
      properties: {},
    }, async () => {
      const result = await sunoClient.POST('/api/notification/v2/clear-badge');
      if (!result.ok) throw new Error(result.error || 'Failed to clear notification badge');
      return { content: [{ type: 'text', text: JSON.stringify({ cleared: true }, null, 2) }] };
    }),
  ];

  allTools.push(...tools);
}
