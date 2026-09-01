import { supabase } from '../supabase';
import { notify } from './notify';

// Only one admin account exists (see supabase/moderation.sql's is_admin
// column) - hardcoded rather than queried on every report/block, since
// looking it up would just be an extra round trip for a value that never
// changes in practice. If a second admin is ever added, this becomes a
// list.
const ADMIN_USER_ID = '48728f10-a8ac-42b1-8d67-ed57a0b88eca';

type ContentType = 'event' | 'message' | 'group_message' | 'block';

async function notifyAdmin(title: string, body: string) {
  await notify([ADMIN_USER_ID], title, body, { type: 'report' });
}

// User-initiated report (see the "Report" actions on Discover events and
// chat messages) or an automatic one from lib/contentFilter.ts matching
// on newly-created content - either way this is what feeds the admin
// screen's queue (app/admin.tsx), and Apple's Guideline 1.2 review
// requires the developer act on it within 24 hours.
export async function reportContent(opts: {
  reporterId: string;
  reportedUserId: string | null;
  contentType: ContentType;
  contentId: string;
  eventId?: string | null;
  groupId?: string | null;
  reason: string;
  source?: 'user' | 'auto_filter' | 'block';
}): Promise<{ error: string | null }> {
  const { error } = await supabase.from('reports').insert({
    reporter_id: opts.reporterId,
    reported_user_id: opts.reportedUserId,
    content_type: opts.contentType,
    content_id: opts.contentId,
    event_id: opts.eventId ?? null,
    group_id: opts.groupId ?? null,
    reason: opts.reason,
    source: opts.source ?? 'user',
  });
  if (error) {
    console.error('Error creating report:', error);
    return { error: error.message };
  }
  await notifyAdmin('New report', opts.reason);
  return { error: null };
}

// Blocking instantly removes the blocked user's content from the
// blocker's feed (enforced at the RLS level - see events_select_discoverable
// / messages_select_host_or_member / group_messages' two SELECT policies
// in supabase/moderation.sql), and per Apple's Guideline 1.2 review, must
// also notify the developer - hence the report row alongside the block
// itself.
export async function blockUser(opts: {
  blockerId: string;
  blockedId: string;
  blockedName: string;
}): Promise<{ error: string | null }> {
  const { error } = await supabase.from('blocked_users').insert({
    blocker_id: opts.blockerId,
    blocked_id: opts.blockedId,
  });
  if (error) {
    console.error('Error blocking user:', error);
    return { error: error.message };
  }
  await reportContent({
    reporterId: opts.blockerId,
    reportedUserId: opts.blockedId,
    contentType: 'block',
    contentId: opts.blockedId,
    reason: `Blocked ${opts.blockedName}`,
    source: 'block',
  });
  return { error: null };
}
