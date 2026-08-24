import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors } from '../lib/theme';

type Props = {
  title: string;
  onPrev: () => void;
  onNext: () => void;
  viewMode: 'month' | 'week';
  onSelectMonth: () => void;
  onSelectWeek: () => void;
};

// Replaces react-native-calendars' own built-in header (see the
// hideArrows/customHeaderTitle collapse where <Calendar> is rendered) -
// that header's slot doesn't stretch edge-to-edge and its customHeader prop
// silently breaks enableSwipeMonths' arrow handling, so there was no clean
// way to add the Month/Week toggle inside it. This is a plain sibling row
// instead, reused unchanged by both Month and Week mode so the calendar
// area's total height never varies by mode (the drag-sheet math depends on
// that staying constant - see MIN_TOP_INSET/calFullHeight in index.tsx).
export default function CalendarHeaderRow({ title, onPrev, onNext, viewMode, onSelectMonth, onSelectWeek }: Props) {
  return (
    <View style={styles.row}>
      <TouchableOpacity onPress={onPrev} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <Text style={styles.arrow}>‹</Text>
      </TouchableOpacity>
      {/* Each gap is its own flex:1 zone, so the toggle inside it centers
          halfway between the arrow and the title regardless of title
          width - not flush against the arrow, where it's easy to fat-
          finger the arrow instead (the original complaint this fixes). */}
      <View style={styles.gap}>
        <TouchableOpacity onPress={onSelectWeek} hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}>
          <Text style={[styles.toggleGlyph, viewMode === 'week' && styles.toggleGlyphActive]}>▥</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.title} numberOfLines={1}>{title}</Text>
      <View style={styles.gap}>
        <TouchableOpacity onPress={onSelectMonth} hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}>
          <Text style={[styles.toggleGlyph, viewMode === 'month' && styles.toggleGlyphActive]}>▦</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity onPress={onNext} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <Text style={styles.arrow}>›</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    height: '100%',
  },
  arrow: { color: colors.primary, fontSize: 28, fontWeight: '700', paddingHorizontal: 8 },
  gap: { flex: 1, alignItems: 'center' },
  title: { textAlign: 'center', color: colors.textPrimary, fontSize: 16, fontWeight: '700' },
  toggleGlyph: { fontSize: 18, color: colors.textSecondary },
  toggleGlyphActive: { color: colors.primary },
});
