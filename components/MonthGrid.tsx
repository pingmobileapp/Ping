import React, { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  SharedValue,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { colors } from '../lib/theme';
import MonthDayCell, { CELL_HEIGHT, MAX_BARS } from './MonthDayCell';
import { MonthDayBar } from '../lib/weekTimeline';

export const WEEKDAY_HEADER_HEIGHT = 24;
export const MONTH_LABEL_HEIGHT = 32;
const MONTH_GAP = 16;
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (n: number) => String(n).padStart(2, '0');
const toDateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Every day needed to render one month's full grid, grouped into rows of 7.
// Unlike react-native-calendars' own convention (which the previous
// <Calendar>-based version of this used), the leading/trailing gaps before
// day 1 and after the last day are left as `null` (blank cells) rather than
// filled with the adjacent month's real dates - since every month already
// gets its own block with its own label in this continuous-scroll layout,
// showing (say) Aug 30-31 a second time atop September's block just
// duplicated what August's own block already showed right above it. `null`
// keeps every week row a full 7 slots wide for layout purposes without
// resurrecting that duplication.
function getMonthGridWeeks(monthStart: Date): (Date | null)[][] {
  const year = monthStart.getFullYear();
  const month = monthStart.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const weekCount = Math.ceil((startOffset + daysInMonth) / 7);
  const weeks: (Date | null)[][] = [];
  for (let w = 0; w < weekCount; w++) {
    const week: (Date | null)[] = [];
    for (let i = 0; i < 7; i++) {
      const dayNum = w * 7 + i - startOffset + 1;
      week.push(dayNum >= 1 && dayNum <= daysInMonth ? new Date(year, month, dayNum) : null);
    }
    weeks.push(week);
  }
  return weeks;
}

const monthBlockHeight = (weekCount: number) => MONTH_LABEL_HEIGHT + weekCount * CELL_HEIGHT + MONTH_GAP;

export type MonthGridHandle = { scrollByMonths: (delta: number) => void };

type Props = {
  // First day of the first month in the pre-rendered window - a fixed
  // window rather than infinite scroll, same reasoning as WeekGrid's own
  // 56-day range (see that component's comment): real added complexity
  // (virtualization, re-centering) not worth it for a calendar people
  // mostly look at a handful of months around now, and a plain
  // (non-virtualized) ScrollView here sidesteps a real technical problem
  // react-native-calendars' own CalendarList has - its virtualization
  // assumes every month renders at the same height, which doesn't hold
  // once day cells are tall enough to show event bars (a 6-week month is
  // genuinely ~150px taller than a 4-week one) - this renders every month
  // in the window directly, no virtualization, so there's nothing to get
  // that assumption wrong.
  rangeStart: Date;
  monthCount: number;
  initialMonthIndex: number;
  // Per-day marks (selected/today/important) - see markedDates in
  // app/(tabs)/index.tsx.
  markedDatesByDay: Record<string, any>;
  // Per-day event bars - see buildMonthDayBars in lib/weekTimeline.ts.
  monthDayBars: Record<string, MonthDayBar[]>;
  onDayPress: (dateKey: string) => void;
  onVisibleMonthChange: (monthStart: Date) => void;
  height: number;
  dragY: SharedValue<number>;
  visibleHeight: number;
  maxExtraHeight: number;
  defaultExpansion: number;
};

// The Month-mode counterpart to WeekGrid.tsx - same drag-sheet integration
// contract (dragY/visibleHeight/maxExtraHeight/defaultExpansion), but
// scrolls vertically through consecutive months instead of horizontally
// through days. Built from scratch (not react-native-calendars' Calendar
// or CalendarList) for the same reason WeekGrid itself was: the stock
// components don't fit what this needs - see the rangeStart comment above
// for CalendarList specifically. Every month's height is computed
// analytically from its real week count (monthBlockHeight), never
// measured, so there's no onLayout-timing class of bug here at all - the
// previous <Calendar>-based version of Month hit that exact bug twice on
// real devices before this rewrite.
const MonthGrid = forwardRef<MonthGridHandle, Props>(
  (
    {
      rangeStart,
      monthCount,
      initialMonthIndex,
      markedDatesByDay,
      monthDayBars,
      onDayPress,
      onVisibleMonthChange,
      height,
      dragY,
      visibleHeight,
      maxExtraHeight,
      defaultExpansion,
    },
    ref
  ) => {
    const monthStarts = useMemo(
      () => Array.from({ length: monthCount }, (_, i) => new Date(rangeStart.getFullYear(), rangeStart.getMonth() + i, 1)),
      [rangeStart, monthCount]
    );
    const monthWeeks = useMemo(() => monthStarts.map(getMonthGridWeeks), [monthStarts]);
    const monthHeights = useMemo(() => monthWeeks.map((weeks) => monthBlockHeight(weeks.length)), [monthWeeks]);
    // monthOffsets[i] is the exact scroll-content y where month i begins -
    // the inverse (a y position back to a month index) is what
    // scrollByMonths and the visible-month reaction below need, now that
    // "index * height" alone can't locate a month (heights vary by week
    // count).
    const monthOffsets = useMemo(() => {
      const offsets: number[] = [];
      let acc = 0;
      for (const h of monthHeights) {
        offsets.push(acc);
        acc += h;
      }
      return offsets;
    }, [monthHeights]);
    const indexForOffset = (y: number) => {
      let idx = 0;
      for (let i = 0; i < monthOffsets.length; i++) {
        if (monthOffsets[i] <= y + 1) idx = i;
        else break;
      }
      return idx;
    };

    const scrollRef = useAnimatedRef<Animated.ScrollView>();
    const scrollY = useSharedValue(0);

    const scrollAreaBaseHeight = Math.max(0, visibleHeight);
    const animatedScrollAreaStyle = useAnimatedStyle(() => {
      if (maxExtraHeight <= 0) return { height: scrollAreaBaseHeight };
      return {
        height:
          scrollAreaBaseHeight +
          interpolate(dragY.value, [0, maxExtraHeight], [defaultExpansion, maxExtraHeight], Extrapolation.CLAMP),
      };
    });

    // Without this the grid would always open at the very start of the
    // pre-rendered range, not the month the user actually asked for - same
    // reasoning as WeekGrid's matching mount effect.
    React.useEffect(() => {
      const y = monthOffsets[initialMonthIndex] ?? 0;
      scrollY.value = y;
      scrollRef.current?.scrollTo({ x: 0, y, animated: false });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const scrollHandler = useAnimatedScrollHandler({
      onScroll: (event) => {
        scrollY.value = event.contentOffset.y;
      },
    });

    // Reports whichever month has scrolled at least halfway past the top,
    // so the header title (app/(tabs)/index.tsx) flips over roughly when
    // that month starts dominating the visible area, not the instant its
    // first row merely peeks into view.
    const lastReportedMonthKey = useRef<string | null>(null);
    const reportVisibleMonth = (index: number) => {
      const clamped = Math.max(0, Math.min(monthStarts.length - 1, index));
      const monthStart = monthStarts[clamped];
      const key = `${monthStart.getFullYear()}-${monthStart.getMonth()}`;
      if (key !== lastReportedMonthKey.current) {
        lastReportedMonthKey.current = key;
        onVisibleMonthChange(monthStart);
      }
    };
    useAnimatedReaction(
      () => scrollY.value,
      (y) => {
        'worklet';
        let idx = 0;
        for (let i = 0; i < monthOffsets.length; i++) {
          if (monthOffsets[i] <= y + monthHeights[i] / 2) idx = i;
        }
        runOnJS(reportVisibleMonth)(idx);
      }
    );

    useImperativeHandle(ref, () => ({
      scrollByMonths: (delta: number) => {
        const currentIndex = indexForOffset(scrollY.value);
        const targetIndex = Math.max(0, Math.min(monthStarts.length - 1, currentIndex + delta));
        const y = monthOffsets[targetIndex] ?? 0;
        scrollRef.current?.scrollTo({ x: 0, y, animated: true });
      },
    }));

    return (
      <View style={{ height }}>
        <View style={styles.weekdayHeader}>
          {WEEKDAY_LABELS.map((label) => (
            <Text key={label} style={styles.weekdayLabel}>
              {label}
            </Text>
          ))}
        </View>
        <Animated.ScrollView
          ref={scrollRef}
          onScroll={scrollHandler}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
          style={animatedScrollAreaStyle}
        >
          {monthStarts.map((monthStart, mi) => (
            <View key={`${monthStart.getFullYear()}-${monthStart.getMonth()}`} style={styles.monthBlock}>
              <Text style={styles.monthLabel}>
                {monthStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
              </Text>
              {monthWeeks[mi].map((week, wi) => {
                // Bars that share an id across two side-by-side days in this
                // same row are one multi-day span (see buildAllDayColumns'
                // pushAllDayAcrossSpan, which pushes the same id onto every
                // day it covers) - capped to MAX_BARS the same way
                // MonthDayCell itself caps what it renders, so "same index"
                // below lines up with what's actually visible, not the full
                // (possibly longer) list. Comparing by list position rather
                // than a real interval/lane layout is a real simplification -
                // it connects the common case (one ongoing span sharing the
                // week with few or no other same-day events) cleanly, but a
                // busy week can shift indices day to day and simply won't
                // connect. That's an acceptable gap, not a visible bug: an
                // unconnected span still renders exactly as it always has.
                const rowCappedBars = week.map((d) => (d ? (monthDayBars[toDateKey(d)] || []).slice(0, MAX_BARS) : []));
                return (
                  <View key={wi} style={styles.weekRow}>
                    {week.map((d, di) => {
                      if (!d) return <View key={`blank-${di}`} style={styles.blankCell} />;
                      const dateString = toDateKey(d);
                      const barConnections = rowCappedBars[di].map((bar, bi) => ({
                        connectsLeft: di > 0 && rowCappedBars[di - 1][bi]?.id === bar.id,
                        connectsRight: di < 6 && rowCappedBars[di + 1][bi]?.id === bar.id,
                      }));
                      const marking = {
                        ...(markedDatesByDay[dateString] || {}),
                        events: monthDayBars[dateString] || [],
                        barConnections,
                      };
                      return (
                        <MonthDayCell
                          key={dateString}
                          date={{ dateString, day: d.getDate() }}
                          marking={marking}
                          onPress={onDayPress}
                        />
                      );
                    })}
                  </View>
                );
              })}
            </View>
          ))}
        </Animated.ScrollView>
      </View>
    );
  }
);

export default MonthGrid;
MonthGrid.displayName = 'MonthGrid';

const styles = StyleSheet.create({
  weekdayHeader: { flexDirection: 'row', height: WEEKDAY_HEADER_HEIGHT },
  weekdayLabel: { flex: 1, textAlign: 'center', color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  monthBlock: { marginBottom: MONTH_GAP },
  monthLabel: {
    height: MONTH_LABEL_HEIGHT,
    lineHeight: MONTH_LABEL_HEIGHT,
    paddingLeft: 4,
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  weekRow: { flexDirection: 'row' },
  blankCell: { flex: 1, height: CELL_HEIGHT },
});
