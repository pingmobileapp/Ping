import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { DateData } from 'react-native-calendars';
import { colors } from '../lib/theme';
import { MonthDayBar } from '../lib/weekTimeline';

const MAX_BARS = 3;
// Fixed, not content-driven - see the comment on `cell` below for why every
// cell (0 events or MAX_BARS) must render at exactly this height.
const CELL_HEIGHT = 88;

type Props = {
  date?: DateData;
  marking?: any;
  state?: '' | 'disabled' | 'today' | 'selected' | 'inactive';
  onPress?: (date?: DateData) => void;
  onLongPress?: (date?: DateData) => void;
  // Not part of react-native-calendars' own DayProps - closed over by the
  // wrapper function index.tsx passes as `dayComponent`, so every cell can
  // look up its own day's bars without threading it through `marking`
  // (which stays scoped to the pre-existing selected/today/important
  // styling it already carried before this component existed).
  eventsByDay: Record<string, MonthDayBar[]>;
};

// The dayComponent passed to <Calendar> in app/(tabs)/index.tsx - replaces
// the library's stock BasicDay (a bare 32x32 circle, one dot/mark max) with
// a taller cell showing up to MAX_BARS colored, titled event bars per day,
// Apple-Calendar-style. `marking`'s selected/customStyles/important fields
// are exactly what markedDates already produces - applied here the same
// way, so the selected-day circle, today's ring, and the "important" date
// marker all keep working unchanged.
export default function MonthDayCell({ date, marking, state, onPress, onLongPress, eventsByDay }: Props) {
  const dayEvents = (date && eventsByDay[date.dateString]) || [];
  const visibleBars = dayEvents.slice(0, MAX_BARS);
  const moreCount = dayEvents.length - visibleBars.length;
  const disabled = state === 'disabled';

  return (
    <TouchableOpacity
      style={styles.cell}
      activeOpacity={0.7}
      onPress={() => onPress?.(date)}
      onLongPress={() => onLongPress?.(date)}
    >
      <View
        style={[
          styles.numberContainer,
          marking?.selected && { backgroundColor: marking.selectedColor || colors.primary },
          marking?.customStyles?.container,
        ]}
      >
        <Text
          style={[
            styles.numberText,
            disabled && styles.numberTextDisabled,
            marking?.selected && { color: marking.selectedTextColor || colors.textOnPrimary },
            marking?.customStyles?.text,
          ]}
        >
          {date?.day ?? ''}
        </Text>
      </View>
      {/* A real drawn bar, not a CSS text-decoration underline on the day
          number - that rendered too thin/close to the glyph to actually
          notice. This sits in its own row below the number circle instead,
          so it's clearly a separate "important" signal, not part of the
          number itself. */}
      {marking?.important && <View style={styles.importantBar} />}
      <View style={styles.bars}>
        {visibleBars.map((ev) => (
          <View key={ev.id} style={[styles.bar, { backgroundColor: ev.color }]}>
            <Text style={styles.barText} numberOfLines={1}>
              {ev.title}
            </Text>
          </View>
        ))}
        {moreCount > 0 && <Text style={styles.moreText}>+{moreCount} more</Text>}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  // `flex: 1` here was the actual bug behind the squished/overlapping rows
  // seen on-device: this cell sits inside react-native-calendars' own
  // dayContainer/week row, and that row's own height is itself derived from
  // its children's content (no fixed height anywhere in the library's
  // stylesheet) - `flex: 1` asked this cell to fill a height that hadn't
  // been resolved yet, and RN doesn't clip a View's overflow by default, so
  // the bars just painted straight past this cell's actual (tiny) box into
  // the row below. A fixed height sidesteps the whole circular-sizing
  // problem, keeps every cell uniform regardless of event count (0 events
  // or MAX_BARS - Apple Calendar's own convention), and `overflow: 'hidden'`
  // is the belt-and-suspenders backstop against any content that still
  // somehow doesn't fit (a long single word numberOfLines can't quite
  // truncate cleanly, an unusually tall locale's day-number glyph, etc).
  cell: { height: CELL_HEIGHT, overflow: 'hidden', alignItems: 'stretch', paddingTop: 2, paddingHorizontal: 1, paddingBottom: 4 },
  numberContainer: {
    alignSelf: 'center',
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  numberText: { fontSize: 13, color: colors.textPrimary, fontWeight: '600' },
  numberTextDisabled: { color: colors.textMuted, opacity: 0.4 },
  importantBar: {
    alignSelf: 'center',
    width: 16,
    height: 2.5,
    borderRadius: 1.5,
    backgroundColor: colors.success,
    marginTop: 3,
  },
  bars: { marginTop: 2, gap: 1 },
  bar: { borderRadius: 3, paddingHorizontal: 3, paddingVertical: 1 },
  barText: { fontSize: 9, color: colors.white, fontWeight: '600' },
  moreText: { fontSize: 9, color: colors.textMuted, textAlign: 'center', marginTop: 1 },
});
