import { supabase } from '../supabase';

// Week view's per-day notes (see supabase/day_notes.sql). Keys are local
// yyyy-mm-dd day keys, the same ones WeekGrid uses for its columns.

export async function fetchDayNotes(startKey: string, endKey: string): Promise<Record<string, string>> {
  const { data, error } = await supabase.from('day_notes').select('day, body').gte('day', startKey).lte('day', endKey);
  if (error) {
    console.error('Error fetching day notes:', error);
    return {};
  }
  return Object.fromEntries((data || []).map((row) => [row.day, row.body]));
}

// An empty note deletes the row rather than keeping a blank one around.
export async function saveDayNote(dayKey: string, body: string): Promise<boolean> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return false;

  const trimmed = body.trim();
  const { error } = trimmed
    ? await supabase
        .from('day_notes')
        .upsert({ user_id: userId, day: dayKey, body, updated_at: new Date().toISOString() })
    : await supabase.from('day_notes').delete().eq('user_id', userId).eq('day', dayKey);
  if (error) {
    console.error('Error saving day note:', error);
    return false;
  }
  return true;
}
