import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { colors } from '../lib/theme';
import { MonthDayBar } from '../lib/weekTimeline';

export const MAX_BARS = 3;
// Fixed, not content-driven - see the comment on `cell` below for why every
// cell (0 events or MAX_BARS) must render at exactly this height. Exported
// so MonthGrid.tsx can compute each month's exact rendered height
// analytically (rows * CELL_HEIGHT + fixed label heights) instead of ever
// needing to measure it - see MonthGrid's own header comment for why that
// matters.
export const CELL_HEIGHT = 88;

type DayDate = { dateString: string; day: number };

type Props = {
  date: DayDate;
  marking?: any;
  onPress?: (dateString: string) => void;
};

// One day cell in MonthGrid.tsx's month grids - a taller cell than a plain
// calendar's usual bare circle, showing up to MAX_BARS colored, titled
// event bars per day, Apple-Calendar-style. `marking`'s
// selected/customStyles/important fields are exactly what markedDates
// already produces - the selected-day circle, today's ring, and the
// "important" date marker all keep working unchanged from before this
// component was called directly instead of through react-native-calendars.
// Every cell belongs to the month it's rendered in - MonthGrid never pads a
// month's grid with an adjacent month's real days (see getMonthGridWeeks),
// so there's no "disabled" (dimmed, belongs-to-another-month) state to
// render here anymore.
export default function MonthDayCell({ date, marking, onPress }: Props) {
  const dayEvents: MonthDayBar[] = marking?.events || [];
  const visibleBars = dayEvents.slice(0, MAX_BARS);
  const moreCount = dayEvents.length - visibleBars.length;

  return (
    <TouchableOpacity style={styles.cell} activeOpacity={0.7} onPress={() => onPress?.(date.dateString)}>
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
  // A fixed height (not flex/content-driven) is what makes every cell
  // uniform regardless of event count (0 events or MAX_BARS - Apple
  // Calendar's own convention) - this is also what lets MonthGrid compute
  // each month's exact total height analytically (rows * CELL_HEIGHT) with
  // zero measurement/layout-timing risk, a real bug class the previous
  // react-native-calendars-based version of this feature hit twice on
  // real devices. `overflow: 'hidden'` is the belt-and-suspenders backstop
  // against any content that still somehow doesn't fit.
  // flex:1 (not a fixed/content-driven width) is what makes all 7 columns
  // in a week row divide the row's width evenly - without it, a cell with
  // no explicit width shrinks/grows to fit its own content (an event bar's
  // text length), which is what made day columns visibly uneven width and
  // let long titles push a row wider than the screen.
  cell: { flex: 1, height: CELL_HEIGHT, overflow: 'hidden', alignItems: 'stretch', paddingTop: 2, paddingHorizontal: 1, paddingBottom: 4 },
  numberContainer: {
    alignSelf: 'center',
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  numberText: { fontSize: 13, color: colors.textPrimary, fontWeight: '600' },
  importantBar: {
    alignSelf: 'center',
    width: 16,
    height: 2.5,
    borderRadius: 1.5,
    backgroundColor: colors.success,
    marginTop: 1.5,
  },
  bars: { marginTop: 2, gap: 1 },
  bar: { borderRadius: 3, paddingHorizontal: 3, paddingVertical: 1 },
  barText: { fontSize: 9, color: colors.white, fontWeight: '600' },
  moreText: { fontSize: 9, color: colors.textMuted, textAlign: 'center', marginTop: 1 },
});
