import { supabase } from '../supabase';

// Week view's per-day notes (see supabase/day_notes.sql). Keys are local
// yyyy-mm-dd day keys, the same ones WeekGrid uses for its columns.

// A note is a to-do checklist stored as plain text, one item per line in
// "- [ ] item" / "- [x] item" form - readable as-is, and a line in any other
// form (older free-text notes, "- Gary Allen") reads as an unchecked item.
export type NoteItem = { text: string; done: boolean };

export function parseNoteItems(body: string): NoteItem[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const task = line.match(/^[-*]\s*\[( |x|X)\]\s*(.*)$/);
      if (task) return { text: task[2].trim(), done: task[1] !== ' ' };
      return { text: line.replace(/^[-*•]\s*/, ''), done: false };
    })
    .filter((item) => item.text);
}

// Unchecked items first, checked ones after - each group keeps its order.
export function serializeNoteItems(items: NoteItem[]): string {
  const ordered = [...items.filter((i) => !i.done && i.text.trim()), ...items.filter((i) => i.done && i.text.trim())];
  return ordered.map((i) => `- [${i.done ? 'x' : ' '}] ${i.text.trim()}`).join('\n');
}

// What the collapsed bar shows: the first unchecked item, or a done count.
export function notePreview(body: string): string {
  const items = parseNoteItems(body);
  const open = items.filter((i) => !i.done);
  if (open.length > 0) return open.length > 1 ? `${open[0].text} +${open.length - 1}` : open[0].text;
  return items.length > 0 ? `✓ ${items.length} done` : '';
}

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
