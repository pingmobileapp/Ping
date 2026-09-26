import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { colors } from '../lib/theme';
import { ExternalEvent } from '../lib/calendarConflicts';

type Props = {
  event: ExternalEvent;
  onEdit?: () => void;
  // Present in the normal Upcoming view - tapping hides this event from
  // Upcoming going forward (see lib/hiddenEvents). Not a calendar mutation,
  // just a local display preference, so it works regardless of `editable`.
  onHide?: () => void;
  // Long-pressing the row is the discoverable route to the same hide
  // action plus, for a recurring event, the choice to hide the whole
  // series - see showHideOptions in app/(tabs)/index.tsx. Independent of
  // onEdit/disabled: hiding never requires edit permission.
  onLongPressHide?: () => void;
  // Present instead of onEdit/onHide when this row is rendered inside the
  // "Hidden" view - tapping the whole row restores it.
  onUnhide?: () => void;
};

// Deliberately plain (no card, no border) so a phone-calendar event reads as
// a quick reference line rather than a full Ping event. Anything on a
// writable calendar (see ExternalEvent.editable) opens for editing when the
// row is tapped - personal items Ping wrote itself, or any other calendar
// event the user can already edit in their own Calendar app. No separate
// edit icon: next to the hide ✕ it was too easy to hit the wrong one.
export default function ExternalEventRow({ event, onEdit, onHide, onLongPressHide, onUnhide }: Props) {
  const dateLabel = event.startDate.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const timeLabel = event.allDay
    ? 'All day'
    : event.startDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  if (onUnhide) {
    return (
      <TouchableOpacity style={styles.row} onPress={onUnhide} activeOpacity={0.6}>
        <Text style={styles.text} numberOfLines={1}>
          <Text style={styles.meta}>
            {dateLabel} · {timeLabel} —{' '}
          </Text>
          {event.title}
        </Text>
        <Text style={styles.unhideText}>Unhide</Text>
      </TouchableOpacity>
    );
  }

  const editable = event.editable && !!onEdit;
  // Long-press-to-hide works regardless of edit permission (same rule
  // onHide already follows), so a read-only row still needs to accept
  // touches when onLongPressHide is given, not just when editable.
  const pressable = editable || !!onLongPressHide;

  return (
    <TouchableOpacity
      style={styles.row}
      onPress={editable ? onEdit : undefined}
      onLongPress={onLongPressHide}
      disabled={!pressable}
      activeOpacity={pressable ? 0.6 : 1}
    >
      <Text style={styles.text} numberOfLines={1}>
        <Text style={styles.meta}>
          {dateLabel} · {timeLabel} —{' '}
        </Text>
        {event.title}
      </Text>
      {!!onHide && (
        <TouchableOpacity onPress={onHide} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={styles.hideIcon}>✕</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 24 },
  text: { flex: 1, fontSize: 14, color: colors.textSecondary },
  meta: { color: colors.textMuted },
  hideIcon: { fontSize: 12, color: colors.textMuted, marginLeft: 10 },
  unhideText: { color: colors.primary, fontSize: 13, fontWeight: '600', marginLeft: 10 },
});
