import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors } from '../lib/theme';
import { AllDayItem } from '../lib/weekTimeline';

type Props = {
  weekStart: Date;
  items: AllDayItem[];
  leftInset: number;
  onPress: (item: AllDayItem) => void;
};

const pad = (n: number) => String(n).padStart(2, '0');
const dayKeyFor = (weekStart: Date, offset: number) => {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Timeline has no all-day row of its own - this sits above it, sharing the
// same 7-cell layout (behind the same leftInset) so a chip under "Wed"
// lines up with that day's column. Always rendered at a fixed height (see
// ALL_DAY_ROW_HEIGHT in index.tsx) even with nothing to show, so the Week
// body's total height never varies and the drag-sheet math stays untouched.
export default function WeekAllDayStrip({ weekStart, items, leftInset, onPress }: Props) {
  return (
    <View style={styles.row}>
      <View style={{ width: leftInset }} />
      {Array.from({ length: 7 }).map((_, i) => {
        const key = dayKeyFor(weekStart, i);
        const dayItems = items.filter((it) => it.dayKey === key);
        const first = dayItems[0];
        return (
          <View key={key} style={styles.cell}>
            {first && (
              <TouchableOpacity style={styles.chip} onPress={() => onPress(first)}>
                <Text style={styles.chipText} numberOfLines={1}>
                  {first.title}
                  {dayItems.length > 1 ? ` +${dayItems.length - 1}` : ''}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 2 },
  cell: { flex: 1, paddingHorizontal: 2 },
  chip: {
    backgroundColor: colors.primaryPale,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  chipText: { color: colors.textPrimary, fontSize: 10, fontWeight: '600' },
});
