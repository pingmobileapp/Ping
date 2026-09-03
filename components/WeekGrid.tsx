import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Pressable, StyleSheet, Dimensions } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  scrollTo,
  SharedValue,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { HOUR_BLOCK_HEIGHT } from 'react-native-calendars/src/timeline/Packer';
import { colors } from '../lib/theme';
import { DayColumnEvent, AllDayItem } from '../lib/weekTimeline';

const TIMELINE_LEFT_INSET = 50;
const DAY_LABEL_ROW_HEIGHT = 36;
const ALL_DAY_ROW_HEIGHT = 32;
const GRID_HEIGHT = 24 * HOUR_BLOCK_HEIGHT;
// How far each card in a same-time cascade is nudged right of the one
// behind it - see the stackIndex/stackSize comment where it's used below.
const STACK_OFFSET = 10;
// How long the "+ Add Personal Item" pill stays up before it quietly goes
// away on its own, if it isn't tapped.
const EMPTY_SLOT_PROMPT_TIMEOUT_MS = 5000;

const pad = (n: number) => String(n).padStart(2, '0');
const toDayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfWeek = (d: Date) => {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  r.setDate(r.getDate() - r.getDay());
  return r;
};
const formatHour = (hour: number) => {
  if (hour === 0) return '';
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return '12 PM';
  return `${hour - 12} PM`;
};

export type WeekGridHandle = { scrollByDays: (delta: number) => void };

type Props = {
  rangeStart: Date;
  dayCount: number;
  // How many days into the range the initially-visible week starts - the
  // range extends both before and after it (see weekGridRangeStart in
  // app/(tabs)/index.tsx), so without this the grid would always open
  // showing the very start of the range instead of the week the user
  // actually asked for.
  initialDayIndex: number;
  eventsByDay: Record<string, DayColumnEvent[]>;
  allDayByDay: Record<string, AllDayItem[]>;
  height: number;
  onEventPress: (id: string) => void;
  onVisibleWeekChange: (weekStart: Date) => void;
  // Long-pressing empty space in a day column (not on top of an existing
  // event - see isFreeSlot) shows a pill right where the press landed;
  // tapping it calls this with the day and the exact minutes-since-midnight
  // it landed at, opening Add Personal Item prefilled to that specific
  // time - a quick personal reminder that can always be converted to a
  // real Ping later if it turns out to need one.
  onEmptySlotLongPress: (dayKey: string, minutes: number) => void;
  // Long-pressing a day's header cell (the "Sun 30" label above the grid,
  // not the grid body itself) - opens Discover scoped to that whole day,
  // no specific free-time gap.
  onDateHeaderLongPress: (dayKey: string) => void;
  // The hour grid's own vertical ScrollView is given this as its actual
  // frame height (visibleHeight at rest, growing 1:1 with dragY up to
  // maxExtraHeight) rather than being left unbounded - a ScrollView with no
  // explicit height takes on its full content size, which is what silently
  // made it un-scrollable before (frame == content, nothing to scroll) and
  // left dragging the Upcoming handle down as the only way to see more
  // hours. Bounding it here restores normal swipe-to-scroll at rest, on top
  // of (not instead of) the drag-to-grow behavior.
  dragY: SharedValue<number>;
  visibleHeight: number;
  maxExtraHeight: number;
  // How much taller than visibleHeight the scroll area already starts at
  // rest (dragY=0) - see the matching boost on the Upcoming sheet's own
  // rest position in app/(tabs)/index.tsx (animatedCardsSheetStyle).
  defaultExpansion: number;
};

// A continuously horizontally-scrollable multi-day hourly grid - built from
// scratch rather than on top of react-native-calendars' Timeline, which has
// no horizontal scroll of its own at all (its one ScrollView is
// vertical-only; day columns are laid out via absolute `left` positioning
// in a fixed-width container) and doesn't forward a ref, so its position
// can't be driven or read from outside. See the plan this was built from
// for the full reasoning.
//
// Structure: one vertical ScrollView (hours) containing a row of
// [hour-label sidebar | horizontal ScrollView (days, day-snapping)] - the
// sidebar shares the SAME vertical scroll as the day columns for free
// (same content, no sync code needed) since it's a sibling inside that one
// vertical ScrollView, not a separate scroll view of its own. The day-label
// header and all-day strip sit OUTSIDE that vertical scroll (so they never
// move vertically) but need their OWN horizontal position kept in sync with
// the main grid's horizontal scroll - that's the one place real syncing is
// needed, done via useAnimatedScrollHandler + scrollTo (both run on the UI
// thread, so there's no visible lag between the header/strip and the grid).
const WeekGrid = forwardRef<WeekGridHandle, Props>(
  (
    {
      rangeStart,
      dayCount,
      initialDayIndex,
      eventsByDay,
      allDayByDay,
      height,
      onEventPress,
      onVisibleWeekChange,
      onEmptySlotLongPress,
      onDateHeaderLongPress,
      dragY,
      visibleHeight,
      maxExtraHeight,
      defaultExpansion,
    },
    ref,
  ) => {
    const columnWidth = Dimensions.get('window').width - TIMELINE_LEFT_INSET;
    // Tapping a day's header widens just that one column - the others stay
    // their normal size and simply don't all fit on screen together
    // anymore (scroll to see them, same as always), rather than a "zoom"
    // that resizes every column together. Only one day can be focused at a
    // time; tapping the already-focused day un-focuses it, tapping a
    // different one moves the focus there instead.
    const NORMAL_DAY_WIDTH = columnWidth / 7;
    const FOCUSED_DAY_WIDTH = columnWidth * 0.45;
    const [focusedDayKey, setFocusedDayKey] = useState<string | null>(null);

    const [emptySlotPrompt, setEmptySlotPrompt] = useState<{ dayKey: string; top: number; minutes: number } | null>(
      null,
    );

    useEffect(() => {
      if (!emptySlotPrompt) return;
      const timeout = setTimeout(() => setEmptySlotPrompt(null), EMPTY_SLOT_PROMPT_TIMEOUT_MS);
      return () => clearTimeout(timeout);
    }, [emptySlotPrompt]);

    // The header row and all-day strip above the scroll area are fixed
    // height - only the remainder is this ScrollView's own frame.
    const scrollAreaBaseHeight = Math.max(0, visibleHeight - DAY_LABEL_ROW_HEIGHT - ALL_DAY_ROW_HEIGHT);
    const animatedScrollAreaStyle = useAnimatedStyle(() => {
      if (maxExtraHeight <= 0) {
        return { height: scrollAreaBaseHeight };
      }
      // Mirrors the same rest-position boost as the Upcoming sheet's top
      // (see animatedCardsSheetStyle) - at dragY<=0 this is already
      // scrollAreaBaseHeight + defaultExpansion, growing up to
      // scrollAreaBaseHeight + maxExtraHeight as the handle is dragged down.
      return {
        height:
          scrollAreaBaseHeight +
          interpolate(dragY.value, [0, maxExtraHeight], [defaultExpansion, maxExtraHeight], Extrapolation.CLAMP),
      };
    });

    // Minutes-since-midnight a long-press at locationY falls at, or null if
    // it landed on top of an existing event - the pill shouldn't offer to
    // add something new right on top of something already there.
    const freeSlotMinutes = (locationY: number, dayEvents: DayColumnEvent[]): number | null => {
      const minutes = Math.max(0, Math.min(24 * 60 - 1, (locationY / HOUR_BLOCK_HEIGHT) * 60));
      const insideEvent = dayEvents.some((ev) => minutes >= ev.startMinutes && minutes < ev.endMinutes);
      return insideEvent ? null : minutes;
    };

    const handleColumnLongPress = (key: string, dayEvents: DayColumnEvent[], locationY: number) => {
      const minutes = freeSlotMinutes(locationY, dayEvents);
      if (minutes === null) return;
      setEmptySlotPrompt({ dayKey: key, top: Math.max(0, locationY - 18), minutes });
    };

    const dayKeys = useMemo(
      () =>
        Array.from({ length: dayCount }, (_, i) => {
          const d = new Date(rangeStart);
          d.setDate(d.getDate() + i);
          return d;
        }),
      [rangeStart, dayCount],
    );

    // One day's width can now differ from the rest (see FOCUSED_DAY_WIDTH)
    // - dayWidths/dayOffsets are what every width- and position-dependent
    // calculation below reads instead of a single uniform column width.
    // dayOffsets[i] is the running total of every width before day i - each
    // day's actual left edge in the scroll content, used both to render at
    // the right x position and to convert between a scroll offset and a day
    // index (snapToOffsets, scrollByDays) now that "index * width" alone
    // can't locate a day anymore.
    const dayWidths = useMemo(
      () => dayKeys.map((d) => (toDayKey(d) === focusedDayKey ? FOCUSED_DAY_WIDTH : NORMAL_DAY_WIDTH)),
      [dayKeys, focusedDayKey, FOCUSED_DAY_WIDTH, NORMAL_DAY_WIDTH]
    );
    const dayOffsets = useMemo(() => {
      const offsets: number[] = [];
      let acc = 0;
      for (const w of dayWidths) {
        offsets.push(acc);
        acc += w;
      }
      return offsets;
    }, [dayWidths]);
    // The day whose left edge is at or just before a given scroll offset -
    // the inverse of dayOffsets, used to turn a scroll position back into a
    // day index (scrollByDays).
    const indexForOffset = (x: number) => {
      let idx = 0;
      for (let i = 0; i < dayOffsets.length; i++) {
        if (dayOffsets[i] <= x + 1) idx = i;
        else break;
      }
      return idx;
    };

    const mainScrollRef = useAnimatedRef<Animated.ScrollView>();
    const dayHeaderRef = useAnimatedRef<Animated.ScrollView>();
    const allDayRef = useAnimatedRef<Animated.ScrollView>();
    const verticalScrollRef = useRef<Animated.ScrollView>(null);
    const scrollX = useSharedValue(0);

    const horizontalScrollHandler = useAnimatedScrollHandler({
      onScroll: (event) => {
        scrollX.value = event.contentOffset.x;
        scrollTo(dayHeaderRef, event.contentOffset.x, 0, false);
        scrollTo(allDayRef, event.contentOffset.x, 0, false);
      },
    });

    // The day-label row used to only ever be driven programmatically
    // (scrollEnabled={false}, moved by the handler above) - dragging it
    // directly did nothing. This mirrors the same sync the other direction,
    // so swiping the dates themselves now scrolls the grid and all-day
    // strip too. Calling scrollTo with a position a ScrollView is already
    // at doesn't re-fire its own onScroll, so this doesn't ping-pong with
    // the handler above.
    const dayHeaderScrollHandler = useAnimatedScrollHandler({
      onScroll: (event) => {
        scrollX.value = event.contentOffset.x;
        scrollTo(mainScrollRef, event.contentOffset.x, 0, false);
        scrollTo(allDayRef, event.contentOffset.x, 0, false);
      },
    });

    // Without this the grid would always open at the very start of the
    // pre-rendered range (rangeStart), not the week the user actually
    // asked for - jumps once, on mount, no animation (a visible slide from
    // the range's edge to the right week on every open would be jarring).
    // Also scrolls vertically to roughly the current time, matching what
    // Timeline's own scrollToNow did before this replaced it. No day is
    // focused yet at mount, so every column is still NORMAL_DAY_WIDTH here.
    useEffect(() => {
      const x = initialDayIndex * NORMAL_DAY_WIDTH;
      scrollX.value = x;
      mainScrollRef.current?.scrollTo({ x, y: 0, animated: false });
      dayHeaderRef.current?.scrollTo({ x, y: 0, animated: false });
      allDayRef.current?.scrollTo({ x, y: 0, animated: false });
      const now = new Date();
      const nowY = Math.max(0, (now.getHours() - 1) * HOUR_BLOCK_HEIGHT);
      verticalScrollRef.current?.scrollTo({ x: 0, y: nowY, animated: false });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Re-centers on the tapped day once dayOffsets has actually recomputed
    // to reflect its new (focused/unfocused) width - doing this inside the
    // tap handler itself would still be scrolling by the OLD offsets,
    // landing just short of or past the day the instant its column resizes.
    const pendingFocusIndexRef = useRef<number | null>(null);
    useEffect(() => {
      if (pendingFocusIndexRef.current === null) return;
      const idx = pendingFocusIndexRef.current;
      pendingFocusIndexRef.current = null;
      const x = dayOffsets[idx] ?? 0;
      scrollX.value = x;
      mainScrollRef.current?.scrollTo({ x, y: 0, animated: true });
      dayHeaderRef.current?.scrollTo({ x, y: 0, animated: true });
      allDayRef.current?.scrollTo({ x, y: 0, animated: true });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusedDayKey]);

    const handleDayHeaderTap = (dayKey: string, dayIndex: number) => {
      pendingFocusIndexRef.current = dayIndex;
      setFocusedDayKey((prev) => (prev === dayKey ? null : dayKey));
    };

    // Reports which week is leading the viewport back up to the header
    // title (app/(tabs)/index.tsx) - only when it actually changes, not on
    // every pixel of scroll. Uses NORMAL_DAY_WIDTH rather than the true
    // (variable) dayOffsets - this only drives a text label, and being off
    // by at most one day for the moment a focused column is scrolled near
    // isn't worth threading the real offsets into a UI-thread reaction for.
    const lastReportedWeekKey = useRef<string | null>(null);
    const reportVisibleWeek = (dayIndex: number) => {
      const clamped = Math.max(0, Math.min(dayCount - 1, dayIndex));
      const day = new Date(rangeStart);
      day.setDate(day.getDate() + clamped);
      const weekStart = startOfWeek(day);
      const key = toDayKey(weekStart);
      if (key !== lastReportedWeekKey.current) {
        lastReportedWeekKey.current = key;
        onVisibleWeekChange(weekStart);
      }
    };
    useAnimatedReaction(
      () => Math.round(scrollX.value / NORMAL_DAY_WIDTH),
      (dayIndex) => {
        runOnJS(reportVisibleWeek)(dayIndex);
      },
    );

    useImperativeHandle(ref, () => ({
      // scrollTo here is the ScrollView instance's own imperative method
      // (via the ref's .current, same as any plain ref), not Reanimated's
      // standalone worklet-only scrollTo helper used above in the scroll
      // handler and mount effect - this runs from a normal onPress in
      // app/(tabs)/index.tsx, on the JS thread, so it needs the version
      // that's actually callable from there.
      scrollByDays: (delta: number) => {
        const currentIndex = indexForOffset(scrollX.value);
        const targetIndex = Math.max(0, Math.min(dayCount - 1, currentIndex + delta));
        const target = dayOffsets[targetIndex] ?? 0;
        mainScrollRef.current?.scrollTo({ x: target, y: 0, animated: true });
      },
    }));

    const now = new Date();
    const today = toDayKey(now);
    const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_BLOCK_HEIGHT;

    return (
      <View style={{ height }}>
        <View style={styles.headerRow}>
          <View style={{ width: TIMELINE_LEFT_INSET }} />
          <Animated.ScrollView
            ref={dayHeaderRef}
            horizontal
            onScroll={dayHeaderScrollHandler}
            scrollEventThrottle={16}
            snapToOffsets={dayOffsets}
            decelerationRate="fast"
            showsHorizontalScrollIndicator={false}
          >
            {dayKeys.map((d, i) => {
              const key = toDayKey(d);
              return (
                <Pressable
                  key={key}
                  style={[styles.dayLabelCell, { width: dayWidths[i] }]}
                  delayLongPress={450}
                  onPress={() => handleDayHeaderTap(key, i)}
                  onLongPress={() => onDateHeaderLongPress(key)}
                >
                  <Text style={styles.dayLabelDow}>{d.toLocaleDateString(undefined, { weekday: 'short' })}</Text>
                  <Text style={[styles.dayLabelNum, key === today && styles.dayLabelNumToday]}>{d.getDate()}</Text>
                </Pressable>
              );
            })}
          </Animated.ScrollView>
        </View>

        <View style={styles.allDayRow}>
          <View style={{ width: TIMELINE_LEFT_INSET }} />
          <Animated.ScrollView ref={allDayRef} horizontal scrollEnabled={false} showsHorizontalScrollIndicator={false}>
            {dayKeys.map((d, i) => {
              const key = toDayKey(d);
              const dayItems = allDayByDay[key] || [];
              const first = dayItems[0];
              return (
                <View key={key} style={[styles.allDayCell, { width: dayWidths[i] }]}>
                  {first && (
                    <TouchableOpacity style={styles.allDayChip} onPress={() => onEventPress(first.id)}>
                      <Text style={styles.allDayChipText} numberOfLines={1}>
                        {first.title}
                        {dayItems.length > 1 ? ` +${dayItems.length - 1}` : ''}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}
          </Animated.ScrollView>
        </View>

        <Animated.ScrollView ref={verticalScrollRef} showsVerticalScrollIndicator={false} style={animatedScrollAreaStyle}>
          <View style={{ flexDirection: 'row' }}>
            <View style={{ width: TIMELINE_LEFT_INSET, height: GRID_HEIGHT }}>
              {Array.from({ length: 24 }, (_, hour) => (
                <Text key={hour} style={[styles.hourLabel, { top: hour * HOUR_BLOCK_HEIGHT - 6 }]}>
                  {formatHour(hour)}
                </Text>
              ))}
            </View>
            <Animated.ScrollView
              ref={mainScrollRef}
              horizontal
              snapToOffsets={dayOffsets}
              decelerationRate="fast"
              onScroll={horizontalScrollHandler}
              scrollEventThrottle={16}
              showsHorizontalScrollIndicator={false}
              style={{ height: GRID_HEIGHT }}
            >
              {dayKeys.map((d, i) => {
                const key = toDayKey(d);
                const dayEvents = eventsByDay[key] || [];
                return (
                  <Pressable
                    key={key}
                    style={[styles.dayColumn, { width: dayWidths[i] }]}
                    delayLongPress={450}
                    onLongPress={(e) => handleColumnLongPress(key, dayEvents, e.nativeEvent.locationY)}
                  >
                    {Array.from({ length: 23 }, (_, i) => (
                      <View key={i} style={[styles.hourLine, { top: (i + 1) * HOUR_BLOCK_HEIGHT }]} />
                    ))}
                    {key === today && (
                      <View style={[styles.nowLine, { top: nowTop }]}>
                        <View style={styles.nowDot} />
                      </View>
                    )}
                    {dayEvents.map((ev, i) => {
                      // Same-time events cascade as offset cards rather than
                      // fully overlapping - each later card in the stack is
                      // nudged right so the one(s) behind it still show
                      // their left edge (where they start), and sits on top
                      // via render order (later siblings win touch priority
                      // in RN for overlapping absolutely-positioned views).
                      // The right edge stays fixed for every card rather
                      // than also pulling in with stackIndex, so it's a
                      // simple cascade of same-width cards, not a split
                      // into narrower side-by-side lanes.
                      return (
                        <TouchableOpacity
                          key={`${ev.id}-${i}`}
                          style={[
                            styles.eventBlock,
                            {
                              top: (ev.startMinutes / 60) * HOUR_BLOCK_HEIGHT,
                              height: Math.max(18, ((ev.endMinutes - ev.startMinutes) / 60) * HOUR_BLOCK_HEIGHT),
                              left: 2 + ev.stackIndex * STACK_OFFSET,
                              right: 2,
                              backgroundColor: ev.color || colors.primary,
                              zIndex: ev.stackIndex,
                            },
                          ]}
                          onPress={() => onEventPress(ev.id)}
                        >
                          <Text style={styles.eventBlockText} numberOfLines={2}>
                            {ev.title}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                    {emptySlotPrompt?.dayKey === key && (
                      <TouchableOpacity
                        style={[styles.emptySlotPill, { top: emptySlotPrompt.top }]}
                        onPress={() => {
                          onEmptySlotLongPress(key, emptySlotPrompt.minutes);
                          setEmptySlotPrompt(null);
                        }}
                      >
                        <Text style={styles.emptySlotPillText}>+ Add Personal Item</Text>
                      </TouchableOpacity>
                    )}
                  </Pressable>
                );
              })}
            </Animated.ScrollView>
          </View>
        </Animated.ScrollView>
      </View>
    );
  },
);

export default WeekGrid;

const styles = StyleSheet.create({
  headerRow: { height: DAY_LABEL_ROW_HEIGHT, flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.divider },
  dayLabelCell: { alignItems: 'center', justifyContent: 'center' },
  dayLabelDow: { color: colors.textSecondary, fontSize: 11, fontWeight: '600' },
  dayLabelNum: { color: colors.textPrimary, fontSize: 13, fontWeight: '700' },
  dayLabelNumToday: { color: colors.primary },
  allDayRow: { height: ALL_DAY_ROW_HEIGHT, flexDirection: 'row', alignItems: 'center' },
  allDayCell: { paddingHorizontal: 2, justifyContent: 'center' },
  allDayChip: { backgroundColor: colors.primaryPale, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 },
  allDayChipText: { color: colors.textPrimary, fontSize: 10, fontWeight: '600' },
  hourLabel: { position: 'absolute', left: 0, right: 8, textAlign: 'right', fontSize: 11, color: colors.textSecondary },
  dayColumn: { height: GRID_HEIGHT },
  hourLine: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: colors.divider },
  nowLine: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: colors.danger, flexDirection: 'row', alignItems: 'center' },
  nowDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.danger, marginLeft: -4 },
  eventBlock: {
    position: 'absolute',
    borderRadius: 6,
    padding: 4,
    overflow: 'hidden',
    // A visible seam between cascaded cards - without it, two same-color
    // cards butted up against each other read as one oddly-shaped block
    // rather than two separate ones.
    borderWidth: 1,
    borderColor: colors.background,
    shadowColor: colors.textPrimary,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.25,
    shadowRadius: 2,
    elevation: 2,
  },
  eventBlockText: { color: colors.textOnPrimary, fontSize: 11, fontWeight: '600' },
  emptySlotPill: {
    position: 'absolute',
    left: 4,
    right: 4,
    backgroundColor: colors.primary,
    borderRadius: 8,
    paddingVertical: 6,
    alignItems: 'center',
    zIndex: 50,
    shadowColor: colors.textPrimary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
  emptySlotPillText: { color: colors.textOnPrimary, fontSize: 12, fontWeight: '700' },
});
