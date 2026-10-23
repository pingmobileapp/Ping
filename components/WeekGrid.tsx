import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Pressable, StyleSheet, Dimensions, Modal, Platform } from 'react-native';
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
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import * as Haptics from 'expo-haptics';
import { HOUR_BLOCK_HEIGHT } from 'react-native-calendars/src/timeline/Packer';
import { colors } from '../lib/theme';
import { DayColumnEvent, AllDayItem } from '../lib/weekTimeline';
import { notePreview } from '../lib/dayNotes';
import { contentWidthFor } from './ResponsiveContainer';

const TIMELINE_LEFT_INSET = 50;
const DAY_LABEL_ROW_HEIGHT = 36;
const ALL_DAY_ROW_HEIGHT = 32;
const NOTES_BAR_HEIGHT = 22;
const GRID_HEIGHT = 24 * HOUR_BLOCK_HEIGHT;
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

export type WeekGridHandle = { scrollByDays: (delta: number) => void; scrollToToday: () => void };

// How many days fit across the screen: a full week, two days, or one -
// like Apple Calendar's week, 2-day and day views (2026-10-22).
export type DaysVisible = 7 | 2 | 1;

// Dragging an event snaps its start to this many minutes, like Apple
// Calendar and Outlook.
const DRAG_SNAP_MINUTES = 15;
// Apple Calendar's today red, for the date circle and the Today button.
const TODAY_RED = '#E5383B';
// How long an event has to be held before it lifts for dragging. Moving
// the finger sooner than this is a scroll, not a drag.
const DRAG_HOLD_MS = 400;
// Only days within this many of the one on screen get their event blocks
// drawn. The grid spans ~210 days so swiping is instant, but drawing every
// block for all of them meant thousands of views redrawn on every tap with
// a busy phone calendar - a widen-the-day tap took seconds (TestFlight
// 1.1.10, 2026-10-22). Further days fill in as you scroll toward them.
const RENDER_RADIUS_DAYS = 14;
const NO_EVENTS: DayColumnEvent[] = [];

const formatClock = (minutes: number) => {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${suffix}`;
};

// Where an event block sits inside its day column - shared by the render
// below and the drag gesture's hit test, so the two can't disagree.
// Overlapping events always sit side by side in lanes, on every day, the
// way Apple Calendar draws them (2026-10-22) - no more offset cascade.
function blockGeometry(ev: DayColumnEvent, dayWidth: number, _focused: boolean) {
  const sideBySide = ev.laneCount > 1;
  const laneWidth = (dayWidth - 2) / ev.laneCount;
  const left = 1 + ev.lane * laneWidth;
  const width = laneWidth - 1;
  const top = (ev.startMinutes / 60) * HOUR_BLOCK_HEIGHT;
  const height = Math.max(18, ((ev.endMinutes - ev.startMinutes) / 60) * HOUR_BLOCK_HEIGHT);
  return { sideBySide, left, width, top, height };
}

type DragState = {
  ev: DayColumnEvent;
  fromIndex: number;
  fromDayKey: string;
  // Where the block starts, in the day-row's own coordinates.
  x: number;
  y: number;
  width: number;
  height: number;
};

type DragGhostHandle = { setLabel: (label: string) => void };

// The copy of the block that follows the finger while dragging. It keeps
// its own label state, so the "Fri 7:15 PM" readout updating at every
// 15-minute step only redraws this one view - not the whole grid, which
// holds every block for ~210 days.
const DragGhost = forwardRef<
  DragGhostHandle,
  { drag: DragState; tx: SharedValue<number>; ty: SharedValue<number>; initialLabel: string }
>(({ drag, tx, ty, initialLabel }, ref) => {
  const [label, setLabel] = useState(initialLabel);
  useImperativeHandle(ref, () => ({ setLabel }), []);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: 1.04 }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.eventBlock,
        styles.dragGhost,
        {
          left: drag.x,
          top: drag.y,
          width: drag.width,
          height: drag.height,
          backgroundColor: drag.ev.fill,
          borderLeftColor: drag.ev.stripe,
        },
        style,
      ]}
    >
      <Text style={[styles.eventBlockText, { color: drag.ev.textColor }]} numberOfLines={2}>
        {label}
      </Text>
    </Animated.View>
  );
});
DragGhost.displayName = 'DragGhost';

// The current time, kept to the minute by its own small timer so the
// grid itself never redraws for it. Drawn on top of event blocks - under
// them, an event happening now hid it (TestFlight 1.1.14, 2026-10-23).
function useMinuteNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const tick = () => setNow(new Date());
    // Line up with the start of the next minute, then every minute.
    const timeout = setTimeout(() => {
      tick();
      interval = setInterval(tick, 60000);
    }, 60000 - (Date.now() % 60000));
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);
  return now;
}
const minutesTop = (d: Date) => ((d.getHours() * 60 + d.getMinutes()) / 60) * HOUR_BLOCK_HEIGHT;

function NowLine() {
  const now = useMinuteNow();
  return (
    <View pointerEvents="none" style={[styles.nowLine, { top: minutesTop(now) }]}>
      <View style={styles.nowDot} />
    </View>
  );
}

// The time itself in red in the hour column, like Apple Calendar - its
// background covers whichever hour label it lands on.
function NowTimeLabel() {
  const now = useMinuteNow();
  const h = now.getHours() % 12 === 0 ? 12 : now.getHours() % 12;
  return (
    <Text pointerEvents="none" style={[styles.nowTimeLabel, { top: minutesTop(now) - 8 }]}>
      {`${h}:${pad(now.getMinutes())}`}
    </Text>
  );
}

// "Today" button in the corner left of the day headers (the bottom of the
// grid is under the Upcoming sheet) - only while today has scrolled out of
// view. Its own small component watching
// the scroll position, so showing/hiding it never redraws the grid.
function TodayPill({
  scrollX,
  dayWidth,
  todayIndex,
  daysVisible,
  onPress,
}: {
  scrollX: SharedValue<number>;
  dayWidth: number;
  todayIndex: number;
  daysVisible: number;
  onPress: () => void;
}) {
  const [visible, setVisible] = useState(false);
  useAnimatedReaction(
    () => {
      const first = Math.round(scrollX.value / dayWidth);
      return todayIndex < first || todayIndex > first + daysVisible - 1;
    },
    (offScreen, prev) => {
      if (offScreen !== prev) runOnJS(setVisible)(offScreen);
    },
    [dayWidth, todayIndex, daysVisible],
  );
  if (!visible) return null;
  return (
    <TouchableOpacity
      style={styles.todayPill}
      onPress={onPress}
      accessibilityRole="button"
      hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
    >
      <Text style={styles.todayPillText}>Today</Text>
    </TouchableOpacity>
  );
}

type Props = {
  daysVisible?: DaysVisible;
  // The grid's width before it's measured, when the host already knows it
  // (Home's two-pane layout gives it half the window) - otherwise it's
  // worked out from the window, which would be the whole width.
  initialWidth?: number;
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
  // Each day's note (see lib/dayNotes.ts), shown as a slim bar above that
  // day's all-day chip - tapping it calls onNotePress to open the full note.
  notesByDay: Record<string, string>;
  onNotePress: (dayKey: string) => void;
  // The day whose notes are expanded in place, and the panel to show for it
  // (see DayNoteChecklist) - drawn just under the notes row, over the grid.
  expandedNoteDayKey?: string | null;
  notePanel?: React.ReactNode;
  height: number;
  onEventPress: (id: string) => void;
  // Long-pressing an event (as opposed to empty grid space - see
  // onEmptySlotLongPress) - the hide/hide-series menu for an external
  // item, see handleWeekItemLongPress in app/(tabs)/index.tsx. Optional so
  // call sites that don't need it (none currently) aren't forced to wire
  // a no-op.
  onEventLongPress?: (id: string) => void;
  // Drag-to-move (hold an event, then drag it): whether this item can be
  // moved by this user, and what to do when it's dropped on a new day/
  // start time. Both optional - without them every event just keeps the
  // hold-for-menu behavior.
  canMoveEvent?: (id: string) => boolean;
  onEventMove?: (id: string, dayKey: string, startMinutes: number) => void;
  onVisibleWeekChange: (weekStart: Date) => void;
  // The first day on screen, whenever it changes - for a title that names
  // the days actually showing.
  onVisibleDayChange?: (firstDay: Date) => void;
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
      daysVisible = 7,
      initialWidth,
      rangeStart,
      dayCount,
      initialDayIndex,
      eventsByDay,
      allDayByDay,
      notesByDay,
      onNotePress,
      expandedNoteDayKey,
      notePanel,
      height,
      onEventPress,
      onEventLongPress,
      canMoveEvent,
      onEventMove,
      onVisibleWeekChange,
      onVisibleDayChange,
      onEmptySlotLongPress,
      onDateHeaderLongPress,
      dragY,
      visibleHeight,
      maxExtraHeight,
      defaultExpansion,
    },
    ref,
  ) => {
    // Measured from the grid's own frame (see the root View's onLayout), not
    // the window - on iPad the content is capped narrower than the window
    // (ResponsiveContainer), and turning a phone sideways changes it.
    // Starts at the width ResponsiveContainer will actually give it - on iPad,
    // starting from the full window width and then shrinking to the capped
    // width threw the initial scroll off by weeks.
    const [gridWidth, setGridWidth] = useState(() => {
      if (initialWidth) return initialWidth;
      const { width, height } = Dimensions.get('window');
      return contentWidthFor(width, height);
    });
    const columnWidth = gridWidth - TIMELINE_LEFT_INSET;
    // Tapping a day's header widens just that one column - the others stay
    // their normal size and simply don't all fit on screen together
    // anymore (scroll to see them, same as always), rather than a "zoom"
    // that resizes every column together. Only one day can be focused at a
    // time; tapping the already-focused day un-focuses it, tapping a
    // different one moves the focus there instead.
    // In 2-day and day view every column is already wide - tapping a day
    // to widen it only applies to the 7-day week.
    const NORMAL_DAY_WIDTH = columnWidth / daysVisible;
    const FOCUSED_DAY_WIDTH = daysVisible === 7 ? columnWidth * 0.45 : NORMAL_DAY_WIDTH;
    const canWiden = daysVisible === 7;
    const todayIndexAt = (start: Date) => {
      const t = new Date();
      t.setHours(0, 0, 0, 0);
      const s0 = new Date(start);
      s0.setHours(0, 0, 0, 0);
      return Math.round((t.getTime() - s0.getTime()) / 86400000);
    };
    // Every view opens on today when today is in the week being shown, not
    // on that week's Sunday - and the 7-day week opens with today widened
    // at the left edge, the days after it narrow to its right (TestFlight
    // 1.1.11, 2026-10-22).
    const startIndexFor = (weekStartIdx: number) => {
      const t = todayIndexAt(rangeStart);
      return t >= weekStartIdx && t < weekStartIdx + 7 ? t : weekStartIdx;
    };
    const todayFocusFor = (leadIdx: number) =>
      daysVisible === 7 && leadIdx === todayIndexAt(rangeStart) ? toDayKey(new Date()) : null;
    const [focusedDayKey, setFocusedDayKey] = useState<string | null>(() =>
      todayFocusFor(startIndexFor(initialDayIndex)),
    );
    // While an event is lifted: which day it came from (that column is
    // raised above its neighbors so the block isn't drawn under them),
    // and the "Tue 3:15 PM" it would land on, shown in the block.
    const [dragging, setDragging] = useState<DragState | null>(null);
    // The day the visible week starts on - see RENDER_RADIUS_DAYS.
    const [renderCenter, setRenderCenter] = useState(initialDayIndex);
    const ghostRef = useRef<DragGhostHandle>(null);

    const [emptySlotPrompt, setEmptySlotPrompt] = useState<{ dayKey: string; top: number; minutes: number } | null>(
      null,
    );

    // Tapping the "+N" all-day chip when a day has more than one full-day
    // item shows this chooser instead of jumping straight into whichever
    // item happened to be first - see the allDayRow's chip onPress below.
    const [dayPicker, setDayPicker] = useState<{ dayKey: string; items: AllDayItem[] } | null>(null);

    useEffect(() => {
      if (!emptySlotPrompt) return;
      const timeout = setTimeout(() => setEmptySlotPrompt(null), EMPTY_SLOT_PROMPT_TIMEOUT_MS);
      return () => clearTimeout(timeout);
    }, [emptySlotPrompt]);

    // The day-notes row only shows when it has something to show: a day
    // that has a note, or the day tapped to widen (which gets the "+" for
    // adding one). It used to be a "+" on every day, all the time - a
    // row of clutter for the many people who never write a note (3 of 46
    // accounts as of 2026-10-03).
    const hasAnyNote = useMemo(
      () => Object.values(notesByDay).some((body) => notePreview(body ?? '') !== ''),
      [notesByDay],
    );
    const showNotesRow = hasAnyNote || focusedDayKey !== null || !!expandedNoteDayKey;
    const notesRowHeight = showNotesRow ? NOTES_BAR_HEIGHT : 0;
    // Same idea for the all-day strip: no empty band when there's nothing
    // all-day anywhere in the grid's range.
    const hasAnyAllDay = useMemo(
      () => Object.values(allDayByDay).some((items) => (items?.length ?? 0) > 0),
      [allDayByDay],
    );
    const allDayRowHeight = hasAnyAllDay ? ALL_DAY_ROW_HEIGHT : 0;

    // The header row and all-day strip above the scroll area are fixed
    // height - only the remainder is this ScrollView's own frame.
    const scrollAreaBaseHeight = Math.max(0, visibleHeight - DAY_LABEL_ROW_HEIGHT - allDayRowHeight - notesRowHeight);
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

    // A dragged block reports where the finger is relative to its own day
    // column; this turns that into the day it's over now.
    const dragLabel = (dayIndex: number, startMinutes: number) => {
      const day = dayKeys[dayIndex];
      return `${day.toLocaleDateString(undefined, { weekday: 'short' })} ${formatClock(startMinutes)}`;
    };

    // Drag-to-move: ONE gesture for the whole grid, not one per block. With
    // a busy phone calendar the grid holds thousands of blocks (~210 days),
    // and giving each its own gesture handlers made every tap take seconds
    // (TestFlight 1.1.10, 2026-10-22). The gesture works out which block is
    // under the finger from the same layout math the blocks render with.
    const dragTx = useSharedValue(0);
    const dragTy = useSharedValue(0);
    const dragStartRef = useRef<DragState | null>(null);
    const lastDragSlot = useRef('');

    const hitTest = (x: number, y: number): DragState | null => {
      const dayIndex = indexForOffset(x);
      const dayKey = toDayKey(dayKeys[dayIndex]);
      const dayEvents = eventsByDay[dayKey] || [];
      const xInDay = x - (dayOffsets[dayIndex] ?? 0);
      const focused = dayKey === focusedDayKey;
      // Later blocks draw on top, so search backwards.
      for (let i = dayEvents.length - 1; i >= 0; i--) {
        const ev = dayEvents[i];
        const g = blockGeometry(ev, dayWidths[dayIndex], focused);
        if (xInDay >= g.left && xInDay <= g.left + g.width && y >= g.top && y <= g.top + g.height) {
          return { ev, fromIndex: dayIndex, fromDayKey: dayKey, x: (dayOffsets[dayIndex] ?? 0) + g.left, y: g.top, width: g.width, height: g.height };
        }
      }
      return null;
    };

    const snapStart = (ev: DayColumnEvent, translationY: number) => {
      // Less than half a step from where it started is no move at all - an
      // item at 5:06 that was held, not dragged, would otherwise snap to
      // 5:00 and ask to be moved (TestFlight 1.1.12).
      if (Math.abs(translationY) < ((DRAG_SNAP_MINUTES / 60) * HOUR_BLOCK_HEIGHT) / 2) return ev.startMinutes;
      const raw = ev.startMinutes + (translationY / HOUR_BLOCK_HEIGHT) * 60;
      const snapped = Math.round(raw / DRAG_SNAP_MINUTES) * DRAG_SNAP_MINUTES;
      return Math.max(0, Math.min(24 * 60 - DRAG_SNAP_MINUTES, snapped));
    };

    const startDrag = () => {
      const hit = dragStartRef.current;
      if (!hit) return;
      lastDragSlot.current = `${hit.fromIndex}:${hit.ev.startMinutes}`;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      setEmptySlotPrompt(null);
      setDragging(hit);
    };
    const updateDrag = (x: number, translationY: number) => {
      const hit = dragStartRef.current;
      if (!hit) return;
      const newStart = snapStart(hit.ev, translationY);
      dragTy.value = ((newStart - hit.ev.startMinutes) / 60) * HOUR_BLOCK_HEIGHT;
      const target = Math.max(0, Math.min(dayKeys.length - 1, indexForOffset(x)));
      const slot = `${target}:${newStart}`;
      if (slot !== lastDragSlot.current) {
        lastDragSlot.current = slot;
        Haptics.selectionAsync().catch(() => {});
        ghostRef.current?.setLabel(dragLabel(target, newStart));
      }
    };
    const endDrag = (x: number, translationY: number) => {
      const hit = dragStartRef.current;
      if (!hit) return;
      const target = Math.max(0, Math.min(dayKeys.length - 1, indexForOffset(x)));
      const targetKey = toDayKey(dayKeys[target]);
      const newStart = snapStart(hit.ev, translationY);
      if (targetKey === hit.fromDayKey && newStart === hit.ev.startMinutes) {
        // Held and let go without moving - whatever the host wired to a
        // hold, if anything (Home wires nothing since 1.1.13).
        onEventLongPress?.(hit.ev.id);
        return;
      }
      onEventMove?.(hit.ev.id, targetKey, newStart);
    };
    const finishDrag = () => {
      dragStartRef.current = null;
      setDragging(null);
    };

    const beginDrag = (x: number, y: number) => {
      const hit = hitTest(x, y);
      dragStartRef.current = hit && canMoveEvent?.(hit.ev.id) ? hit : null;
    };

    // Worklet-side copy of "which blocks can move", by on-screen rectangle,
    // so the gesture can decide on the UI thread - before any touch reaches
    // the JS thread - whether a press is a drag candidate at all. A press
    // anywhere else never involves this gesture, so the normal tap, hold
    // menu, and "+ Add Personal Item" touchables work exactly as before.
    const dragTargets = useSharedValue<{ x: number; y: number; w: number; h: number }[]>([]);
    useEffect(() => {
      if (!onEventMove || !canMoveEvent) {
        dragTargets.value = [];
        return;
      }
      const rects: { x: number; y: number; w: number; h: number }[] = [];
      for (let i = Math.max(0, renderCenter - RENDER_RADIUS_DAYS); i <= Math.min(dayKeys.length - 1, renderCenter + RENDER_RADIUS_DAYS); i++) {
        const key = toDayKey(dayKeys[i]);
        for (const ev of eventsByDay[key] || NO_EVENTS) {
          if (!canMoveEvent(ev.id)) continue;
          const g = blockGeometry(ev, dayWidths[i], key === focusedDayKey);
          rects.push({ x: (dayOffsets[i] ?? 0) + g.left, y: g.top, w: g.width, h: g.height });
        }
      }
      dragTargets.value = rects;
    }, [eventsByDay, canMoveEvent, onEventMove, renderCenter, dayKeys, dayWidths, dayOffsets, focusedDayKey, dragTargets]);

    const dragGesture = Gesture.Pan()
      .activateAfterLongPress(DRAG_HOLD_MS)
      .onTouchesDown((e, manager) => {
        'worklet';
        const t = e.allTouches[0];
        const rects = dragTargets.value;
        let onMovable = false;
        if (t) {
          for (let i = 0; i < rects.length; i++) {
            const r = rects[i];
            if (t.x >= r.x && t.x <= r.x + r.w && t.y >= r.y && t.y <= r.y + r.h) {
              onMovable = true;
              break;
            }
          }
        }
        if (!onMovable) manager.fail();
      })
      .onBegin((e) => {
        'worklet';
        runOnJS(beginDrag)(e.x, e.y);
      })
      .onStart(() => {
        'worklet';
        dragTx.value = 0;
        dragTy.value = 0;
        runOnJS(startDrag)();
      })
      .onUpdate((e) => {
        'worklet';
        dragTx.value = e.translationX;
        runOnJS(updateDrag)(e.x, e.translationY);
      })
      .onEnd((e) => {
        'worklet';
        runOnJS(endDrag)(e.x, e.translationY);
      })
      .onFinalize(() => {
        'worklet';
        dragTx.value = 0;
        dragTy.value = 0;
        runOnJS(finishDrag)();
      });

    const mainScrollRef = useAnimatedRef<Animated.ScrollView>();
    const dayHeaderRef = useAnimatedRef<Animated.ScrollView>();
    const allDayRef = useAnimatedRef<Animated.ScrollView>();
    const verticalScrollRef = useRef<Animated.ScrollView>(null);
    const scrollX = useSharedValue(0);

    // The day the user last settled on - recorded where a scroll comes to
    // rest (or where the grid itself scrolls to), never read back from the
    // live offset mid-rotation: while the columns resize, the ScrollView
    // reports clamped, in-between offsets that would land days off.
    const leadingIndexRef = useRef(initialDayIndex);
    // True while a width change is being re-aligned - the grid is hidden
    // and scroll reports are ignored until it's back on the right day.
    const realigningRef = useRef(false);
    const [realigning, setRealigning] = useState(false);
    const dayOffsetsRef = useRef<number[]>([]);
    dayOffsetsRef.current = dayOffsets;
    const noteSettledOffset = (x: number) => {
      if (realigningRef.current) return;
      const offsets = dayOffsetsRef.current;
      let best = 0;
      for (let i = 1; i < offsets.length; i++) {
        if (Math.abs(offsets[i] - x) < Math.abs(offsets[best] - x)) best = i;
      }
      leadingIndexRef.current = best;
    };

    // While re-aligning after a width change, the offset the grid must hold
    // (-1 when not guarding). On a real iPhone the system's rotation
    // animation can move a scroll view's offset itself after the grid has
    // already scrolled to the right day - it put the old, pre-rotation offset
    // back, stranding landscape weeks early (reported on 1.1.1, never seen in
    // the simulator). Any scroll that isn't the user's own gets corrected
    // until the rotation has settled; touching the grid ends the guard.
    //
    // The correction is queued to the JS thread (runOnJS), never done with a
    // scrollTo right inside onScroll: that runs synchronously within UIKit's
    // own scroll callback, and fighting the rotation animation from there
    // re-entered itself until the app crashed (build 102, on device).
    const guardX = useSharedValue(-1);
    const correctionQueued = useSharedValue(false);
    const realignTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
    const realignApplyRef = useRef<(() => void) | null>(null);
    const reapplyRealign = () => {
      correctionQueued.value = false;
      if (guardX.value >= 0) realignApplyRef.current?.();
    };
    const endRealign = () => {
      realignTimersRef.current.forEach(clearTimeout);
      realignTimersRef.current = [];
      guardX.value = -1;
      if (!realigningRef.current) return;
      realigningRef.current = false;
      setRealigning(false);
      reportVisibleWeek(leadingIndexRef.current);
    };

    // True while one scroll view is pushing its offset onto the other two.
    // A scrollTo fires the target's own onScroll synchronously, inside the
    // same call - without this, the target would push straight back, and if
    // UIKit lands any of them on a slightly different offset (as it can
    // mid-rotation) the views bounce offsets back and forth recursively
    // until the JS stack overflows and the app aborts - the same crash
    // signature as build 102. The nested handler just records the offset.
    const syncing = useSharedValue(false);
    // Which scroll view the user's finger is on (1 = grid, 2 = date row);
    // 0 = nothing being dragged, which the grid leads (arrow buttons,
    // rotation realign). Only the leading view pushes its offset onto the
    // others. On Android a scrollTo's onScroll arrives a frame later, not
    // inside the same call, so the syncing flag alone can't stop the views
    // echoing each other - the date row and grid drifted apart (reported on
    // the Android emulator, 2026-10-04).
    const driver = useSharedValue(0);

    const horizontalScrollHandler = useAnimatedScrollHandler({
      onScroll: (event) => {
        if (guardX.value >= 0) {
          if (Math.abs(event.contentOffset.x - guardX.value) > 0.5 && !correctionQueued.value) {
            correctionQueued.value = true;
            runOnJS(reapplyRealign)();
          }
          return;
        }
        if (driver.value === 2) return;
        scrollX.value = event.contentOffset.x;
        if (syncing.value) return;
        syncing.value = true;
        scrollTo(dayHeaderRef, event.contentOffset.x, 0, false);
        scrollTo(allDayRef, event.contentOffset.x, 0, false);
        syncing.value = false;
      },
      onBeginDrag: () => {
        driver.value = 1;
        if (guardX.value >= 0) {
          guardX.value = -1;
          runOnJS(endRealign)();
        }
      },
      onEndDrag: (event) => {
        runOnJS(noteSettledOffset)(event.contentOffset.x);
      },
      onMomentumEnd: (event) => {
        runOnJS(noteSettledOffset)(event.contentOffset.x);
      },
    });

    // The day-label row used to only ever be driven programmatically
    // (scrollEnabled={false}, moved by the handler above) - dragging it
    // directly did nothing. This mirrors the same sync the other direction,
    // so swiping the dates themselves now scrolls the grid and all-day
    // strip too. The syncing flag above keeps the two handlers from
    // ping-ponging offsets back and forth.
    const dayHeaderScrollHandler = useAnimatedScrollHandler({
      onScroll: (event) => {
        if (guardX.value >= 0) {
          if (Math.abs(event.contentOffset.x - guardX.value) > 0.5 && !correctionQueued.value) {
            correctionQueued.value = true;
            runOnJS(reapplyRealign)();
          }
          return;
        }
        if (driver.value !== 2) return;
        scrollX.value = event.contentOffset.x;
        if (syncing.value) return;
        syncing.value = true;
        scrollTo(mainScrollRef, event.contentOffset.x, 0, false);
        scrollTo(allDayRef, event.contentOffset.x, 0, false);
        syncing.value = false;
      },
      onBeginDrag: () => {
        driver.value = 2;
        if (guardX.value >= 0) {
          guardX.value = -1;
          runOnJS(endRealign)();
        }
      },
      onEndDrag: (event) => {
        runOnJS(noteSettledOffset)(event.contentOffset.x);
      },
      onMomentumEnd: (event) => {
        runOnJS(noteSettledOffset)(event.contentOffset.x);
        driver.value = 0;
      },
    });

    // Without this the grid would always open at the very start of the
    // pre-rendered range (rangeStart), not the week the user actually
    // asked for - jumps once, on mount, no animation (a visible slide from
    // the range's edge to the right week on every open would be jarring).
    // Also scrolls vertically to roughly the current time, matching what
    // Timeline's own scrollToNow did before this replaced it. The only day
    // that can be widened at mount is the leading one (today), so every day
    // before it is still NORMAL_DAY_WIDTH here.
    useEffect(() => {
      const startIdx = startIndexFor(initialDayIndex);
      leadingIndexRef.current = startIdx;
      const x = startIdx * NORMAL_DAY_WIDTH;
      scrollX.value = x;
      mainScrollRef.current?.scrollTo({ x, y: 0, animated: false });
      dayHeaderRef.current?.scrollTo({ x, y: 0, animated: false });
      allDayRef.current?.scrollTo({ x, y: 0, animated: false });
      const now = new Date();
      const nowY = Math.max(0, (now.getHours() - 1) * HOUR_BLOCK_HEIGHT);
      verticalScrollRef.current?.scrollTo({ x: 0, y: nowY, animated: false });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Keeps the same leading day in view when the column width changes
    // (rotation, or the first real measurement replacing the window-based
    // guess) - a scroll offset in points would otherwise land on a
    // different day once every column is a new width. The grid stays hidden
    // from the first render at the new width until it's scrolled back onto
    // that day; otherwise the old offset shows a stretch of much earlier
    // days for a frame (reported as flashing back to early September).
    const prevDayWidthRef = useRef(NORMAL_DAY_WIDTH);
    const prevDaysVisibleRef = useRef(daysVisible);
    const widthChanging = prevDayWidthRef.current !== NORMAL_DAY_WIDTH;
    useEffect(() => {
      const prev = prevDayWidthRef.current;
      prevDayWidthRef.current = NORMAL_DAY_WIDTH;
      if (prev === NORMAL_DAY_WIDTH) return;
      // Switching between week / 2-day / day keeps the same days in view
      // (and lands on today when switching in from today's week).
      const daysChanged = prevDaysVisibleRef.current !== daysVisible;
      prevDaysVisibleRef.current = daysVisible;
      const lead = leadingIndexRef.current;
      const idx = !daysChanged ? lead : startIndexFor(lead - (dayKeys[lead]?.getDay() ?? 0));
      leadingIndexRef.current = idx;
      const x = idx * NORMAL_DAY_WIDTH;
      realignTimersRef.current.forEach(clearTimeout);
      realigningRef.current = true;
      setRealigning(true);
      // Only ever the leading day, so x above still holds.
      setFocusedDayKey(todayFocusFor(idx));
      scrollX.value = x;
      guardX.value = x;
      driver.value = 0;
      const apply = () => {
        mainScrollRef.current?.scrollTo({ x, y: 0, animated: false });
        dayHeaderRef.current?.scrollTo({ x, y: 0, animated: false });
        allDayRef.current?.scrollTo({ x, y: 0, animated: false });
      };
      realignApplyRef.current = apply;
      requestAnimationFrame(() => {
        apply();
        // Shown again as soon as it's on the right day; the guard (and the
        // re-applies below, after the rotation animation) keep it there.
        requestAnimationFrame(() => setRealigning(false));
      });
      realignTimersRef.current = [
        setTimeout(apply, 350),
        setTimeout(apply, 600),
        setTimeout(apply, 900),
        setTimeout(endRealign, 1200),
      ];
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [NORMAL_DAY_WIDTH]);
    useEffect(() => () => realignTimersRef.current.forEach(clearTimeout), []);

    // Re-centers on the tapped day once dayOffsets has actually recomputed
    // to reflect its new (focused/unfocused) width - doing this inside the
    // tap handler itself would still be scrolling by the OLD offsets,
    // landing just short of or past the day the instant its column resizes.
    const pendingFocusIndexRef = useRef<number | null>(null);
    useEffect(() => {
      if (pendingFocusIndexRef.current === null) return;
      const idx = pendingFocusIndexRef.current;
      pendingFocusIndexRef.current = null;
      leadingIndexRef.current = idx;
      const x = dayOffsets[idx] ?? 0;
      scrollX.value = x;
      mainScrollRef.current?.scrollTo({ x, y: 0, animated: true });
      dayHeaderRef.current?.scrollTo({ x, y: 0, animated: true });
      allDayRef.current?.scrollTo({ x, y: 0, animated: true });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusedDayKey]);

    // Shared by the day-header label AND tapping anywhere on a collapsed
    // day's own column (see the day column Pressable's onPress below) -
    // either one focuses/unfocuses that day the same way. Tapping an event
    // inside an already-focused day opens it instead of toggling focus (see
    // that TouchableOpacity's onPress below).
    const handleDayTap = (dayKey: string, dayIndex: number) => {
      if (!canWiden) return;
      pendingFocusIndexRef.current = dayIndex;
      setFocusedDayKey((prev) => (prev === dayKey ? null : dayKey));
    };

    // Reports which day (and week) is leading the viewport back up to the
    // header title (app/(tabs)/index.tsx) - only when it actually changes,
    // not on every pixel of scroll. Uses the real dayOffsets: once the title
    // named the first day on screen, a widened day earlier in the range put
    // it days off (Oct 31 over a Thu 29 view, 2026-10-22).
    const lastReportedWeekKey = useRef<string | null>(null);
    const lastReportedDayKey = useRef<string | null>(null);
    const reportVisibleWeek = (dayIndex: number) => {
      if (realigningRef.current) return;
      const clamped = Math.max(0, Math.min(dayCount - 1, dayIndex));
      const day = new Date(rangeStart);
      day.setDate(day.getDate() + clamped);
      const dayKey = toDayKey(day);
      if (dayKey !== lastReportedDayKey.current) {
        lastReportedDayKey.current = dayKey;
        onVisibleDayChange?.(day);
      }
      const weekStart = startOfWeek(day);
      const key = toDayKey(weekStart);
      if (key !== lastReportedWeekKey.current) {
        lastReportedWeekKey.current = key;
        onVisibleWeekChange(weekStart);
        setRenderCenter(clamped);
      }
    };
    const dayOffsetsSV = useSharedValue<number[]>([]);
    useEffect(() => {
      dayOffsetsSV.value = dayOffsets;
    }, [dayOffsets, dayOffsetsSV]);
    useAnimatedReaction(
      () => {
        const offsets = dayOffsetsSV.value;
        const x = scrollX.value;
        if (offsets.length === 0) return Math.round(x / NORMAL_DAY_WIDTH);
        let best = 0;
        for (let i = 1; i < offsets.length; i++) {
          if (Math.abs(offsets[i] - x) < Math.abs(offsets[best] - x)) best = i;
          else if (offsets[i] > x) break;
        }
        return best;
      },
      (dayIndex) => {
        runOnJS(reportVisibleWeek)(dayIndex);
      },
    );

    // Today's column, and jumping back to it (the Today button, or the
    // header's own control). Lands the way the grid first opens: today at
    // the left edge, widened in the 7-day week.
    const goToToday = () => {
      const todayIndex = todayIndexAt(rangeStart);
      if (todayIndex < 0 || todayIndex >= dayCount) return;
      leadingIndexRef.current = todayIndex;
      driver.value = 0;
      const todayKey = toDayKey(new Date());
      if (canWiden && focusedDayKey !== todayKey) {
        // Scrolled once the widths have changed - see pendingFocusIndexRef.
        pendingFocusIndexRef.current = todayIndex;
        setFocusedDayKey(todayKey);
      } else {
        mainScrollRef.current?.scrollTo({ x: dayOffsets[todayIndex] ?? 0, y: 0, animated: true });
      }
      const now = new Date();
      verticalScrollRef.current?.scrollTo({ x: 0, y: Math.max(0, (now.getHours() - 1) * HOUR_BLOCK_HEIGHT), animated: true });
    };

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
        leadingIndexRef.current = targetIndex;
        driver.value = 0;
        mainScrollRef.current?.scrollTo({ x: target, y: 0, animated: true });
      },
      scrollToToday: () => goToToday(),
    }));

    const now = new Date();
    const today = toDayKey(now);

    return (
      <View
        style={{ height, opacity: widthChanging || realigning ? 0 : 1 }}
        onLayout={(e) => setGridWidth(e.nativeEvent.layout.width)}
      >
        <View style={styles.headerRow}>
          <View style={styles.todaySlot}>
            <TodayPill
              scrollX={scrollX}
              dayWidth={NORMAL_DAY_WIDTH}
              todayIndex={todayIndexAt(rangeStart)}
              daysVisible={daysVisible}
              onPress={goToToday}
            />
          </View>
          <Animated.ScrollView
            ref={dayHeaderRef}
            horizontal
            onScroll={dayHeaderScrollHandler}
            scrollEventThrottle={16}
            snapToOffsets={dayOffsets}
            decelerationRate="fast"
            showsHorizontalScrollIndicator={false}
            removeClippedSubviews={Platform.OS === 'ios'}
          >
            {dayKeys.map((d, i) => {
              const key = toDayKey(d);
              return (
                <Pressable
                  key={key}
                  style={[styles.dayLabelCell, { width: dayWidths[i] }]}
                  delayLongPress={450}
                  onPress={() => handleDayTap(key, i)}
                  onLongPress={() => onDateHeaderLongPress(key)}
                >
                  {/* Today's date in a red circle, like Apple Calendar. A
                      2-day or day view has room to put it on one line. */}
                  <View style={daysVisible < 7 ? styles.dayLabelInline : null}>
                    <Text style={[styles.dayLabelDow, key === today && styles.dayLabelDowToday]}>
                      {d.toLocaleDateString(undefined, { weekday: 'short' })}
                    </Text>
                    <View style={[styles.dayLabelNumWrap, key === today && styles.dayLabelNumWrapToday]}>
                      <Text style={[styles.dayLabelNum, key === today && styles.dayLabelNumToday]}>{d.getDate()}</Text>
                    </View>
                  </View>
                </Pressable>
              );
            })}
          </Animated.ScrollView>
        </View>

        <View style={[styles.allDayRow, { height: allDayRowHeight + notesRowHeight }]}>
          <View style={{ width: TIMELINE_LEFT_INSET, justifyContent: 'flex-end' }}>
            {hasAnyAllDay && (
              <View style={styles.allDayLabelSlot}>
                <Text style={styles.allDayLabel}>all-day</Text>
              </View>
            )}
          </View>
          <Animated.ScrollView
            ref={allDayRef}
            horizontal
            scrollEnabled={false}
            showsHorizontalScrollIndicator={false}
            removeClippedSubviews={Platform.OS === 'ios'}
          >
            {dayKeys.map((d, i) => {
              const key = toDayKey(d);
              const dayItems = allDayByDay[key] || [];
              const first = dayItems[0];
              const note = notePreview(notesByDay[key] ?? '');
              const expanded = key === expandedNoteDayKey;
              const showNoteBar = !!note || expanded || key === focusedDayKey;
              return (
                <View key={key} style={[styles.allDayCell, { width: dayWidths[i] }]}>
                  {showNoteBar ? (
                    <TouchableOpacity
                      style={[styles.noteBar, note ? styles.noteBarFilled : styles.noteBarEmpty, expanded && styles.noteBarExpanded]}
                      onPress={() => onNotePress(key)}
                      accessibilityLabel={note ? `Note: ${note}` : 'Add a note for this day'}
                    >
                      <Text style={note ? styles.noteBarText : styles.noteBarPlus} numberOfLines={1}>
                        {note || '+ Note'}
                      </Text>
                    </TouchableOpacity>
                  ) : showNotesRow ? (
                    <View style={styles.noteBarSpacer} />
                  ) : null}
                  {hasAnyAllDay && (
                  <View style={styles.allDayChipSlot}>
                    {first && (
                      <TouchableOpacity
                        style={[styles.allDayChip, { backgroundColor: first.fill, borderLeftColor: first.stripe }]}
                        // More than one full-day item on this day - a tap
                        // shouldn't silently jump into whichever one happened
                        // to be first, so it opens a chooser listing all of
                        // them instead.
                        onPress={() =>
                          dayItems.length > 1 ? setDayPicker({ dayKey: key, items: dayItems }) : onEventPress(first.id)
                        }
                        // Same "which one" ambiguity as onPress above - only
                        // wired when there's exactly one item to act on.
                        onLongPress={
                          dayItems.length > 1 || !onEventLongPress ? undefined : () => onEventLongPress(first.id)
                        }
                      >
                        <Text style={[styles.allDayChipText, { color: first.textColor }]} numberOfLines={1}>
                          {first.title}
                          {dayItems.length > 1 ? ` +${dayItems.length - 1}` : ''}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  )}
                </View>
              );
            })}
          </Animated.ScrollView>
        </View>

        <Animated.ScrollView
          ref={verticalScrollRef}
          showsVerticalScrollIndicator={false}
          style={animatedScrollAreaStyle}
          scrollEnabled={!dragging}
        >
          <View style={{ flexDirection: 'row' }}>
            <View style={{ width: TIMELINE_LEFT_INSET, height: GRID_HEIGHT }}>
              {Array.from({ length: 24 }, (_, hour) => (
                <Text key={hour} style={[styles.hourLabel, { top: hour * HOUR_BLOCK_HEIGHT - 6 }]}>
                  {formatHour(hour)}
                </Text>
              ))}
              {todayIndexAt(rangeStart) >= 0 && todayIndexAt(rangeStart) < dayCount && <NowTimeLabel />}
            </View>
            <Animated.ScrollView
              ref={mainScrollRef}
              horizontal
              scrollEnabled={!dragging}
              snapToOffsets={dayOffsets}
              decelerationRate="fast"
              onScroll={horizontalScrollHandler}
              scrollEventThrottle={16}
              showsHorizontalScrollIndicator={false}
              removeClippedSubviews={Platform.OS === 'ios'}
              style={{ height: GRID_HEIGHT }}
            >
              <GestureDetector gesture={dragGesture}>
              <View style={styles.dayRow}>
              {/* Hour lines drawn once across the whole row, not 23 per day. */}
              {Array.from({ length: 23 }, (_, hourIdx) => (
                <View key={hourIdx} style={[styles.hourLine, { top: (hourIdx + 1) * HOUR_BLOCK_HEIGHT }]} />
              ))}
              {dayKeys.map((d, dayIndex) => {
                const key = toDayKey(d);
                const dayEvents =
                  Math.abs(dayIndex - renderCenter) <= RENDER_RADIUS_DAYS ? eventsByDay[key] || NO_EVENTS : NO_EVENTS;
                return (
                  <Pressable
                    key={key}
                    style={[
                      styles.dayColumn,
                      { width: dayWidths[dayIndex] },
                    ]}
                    delayLongPress={450}
                    // Tapping a day's empty space widens it to read (and
                    // tapping again narrows it back). Tapping an event opens
                    // it straight away - see the event TouchableOpacity
                    // below.
                    onPress={() => handleDayTap(key, dayIndex)}
                    onLongPress={(e) => handleColumnLongPress(key, dayEvents, e.nativeEvent.locationY)}
                  >
                    {dayEvents.map((ev, evIndex) => {
                      // Overlaps sit side by side in lanes (see blockGeometry).
                      const g = blockGeometry(ev, dayWidths[dayIndex], key === focusedDayKey);
                      // The block being dragged stays put, dimmed, while
                      // its ghost follows the finger.
                      const isDragged = dragging?.ev.id === ev.id && dragging.fromDayKey === key;
                      return (
                        <Pressable
                          key={`${ev.id}-${evIndex}`}
                          // Plain pressed-state styling, not TouchableOpacity:
                          // its native fade could get stuck half-faded when
                          // the tap widened the day under the finger.
                          style={({ pressed }) => [
                            styles.eventBlock,
                            {
                              top: g.top,
                              height: g.height,
                              left: g.left,
                              width: g.width,
                              backgroundColor: ev.fill,
                              borderLeftColor: ev.stripe,
                            },
                            pressed && styles.eventBlockPressed,
                            isDragged && styles.eventBlockDragging,
                          ]}
                          // On a narrow day, the first tap widens the day so
                          // everything on it is readable (overlaps go side by
                          // side); tapping an event in the widened day opens
                          // it (TestFlight feedback, build 113). 1.1.2 had
                          // made every tap open straight away, which left
                          // crowded days unreadable. Holding an event lifts it
                          // to drag (see dragGesture); hiding is in the tap
                          // menu or the event screen's ••• menu, not on a
                          // hold, which got in the way of dragging
                          // (TestFlight 1.1.12).
                          onPress={() =>
                            !canWiden || key === focusedDayKey ? onEventPress(ev.id) : handleDayTap(key, dayIndex)
                          }
                          delayLongPress={450}
                          onLongPress={onEventLongPress ? () => onEventLongPress(ev.id) : undefined}
                        >
                          {/* Title, then the time (and place) when there's room
                              for a second line - like Apple Calendar. */}
                          <Text
                            style={[
                              styles.eventBlockText,
                              { color: ev.textColor },
                              // Leaves room for the repeat mark in the corner.
                              ev.repeating && g.width >= 40 && styles.eventBlockTextRepeat,
                            ]}
                            // Narrow columns get one line ending in "…" rather
                            // than a word broken across lines ("Workda / y").
                            numberOfLines={g.height >= 44 && g.width >= 80 ? 2 : 1}
                          >
                            {ev.title}
                          </Text>
                          {ev.repeating && g.width >= 40 && (
                            <Text style={[styles.repeatMark, { color: ev.textColor }]}>↻</Text>
                          )}
                          {g.height >= 30 && g.width >= 44 && !!ev.subtitle && (
                            <Text style={[styles.eventBlockSub, { color: ev.textColor }]} numberOfLines={g.height >= 60 ? 2 : 1}>
                              {ev.subtitle}
                            </Text>
                          )}
                        </Pressable>
                      );
                    })}
                    {key === today && <NowLine />}
                    {emptySlotPrompt?.dayKey === key && (
                      <TouchableOpacity
                        style={[styles.emptySlotPill, { top: emptySlotPrompt.top }]}
                        onPress={() => {
                          onEmptySlotLongPress(key, emptySlotPrompt.minutes);
                          setEmptySlotPrompt(null);
                        }}
                      >
                        <Text style={styles.emptySlotPillText}>+ New Event</Text>
                      </TouchableOpacity>
                    )}
                  </Pressable>
                );
              })}
              {dragging && (
                <DragGhost
                  ref={ghostRef}
                  drag={dragging}
                  tx={dragTx}
                  ty={dragTy}
                  initialLabel={dragLabel(dragging.fromIndex, dragging.ev.startMinutes)}
                />
              )}
              </View>
              </GestureDetector>
            </Animated.ScrollView>
          </View>
        </Animated.ScrollView>

        {expandedNoteDayKey && notePanel ? <View style={styles.notePanelWrap}>{notePanel}</View> : null}

        <Modal visible={!!dayPicker} transparent animationType="fade" onRequestClose={() => setDayPicker(null)}>
          <Pressable style={styles.dayPickerBackdrop} onPress={() => setDayPicker(null)}>
            <View style={styles.dayPickerCard}>
              <Text style={styles.dayPickerTitle}>
                {dayPicker ? new Date(dayPicker.dayKey + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : ''}
              </Text>
              {dayPicker?.items.map((item) => (
                <TouchableOpacity
                  key={item.id}
                  style={styles.dayPickerRow}
                  onPress={() => {
                    setDayPicker(null);
                    onEventPress(item.id);
                  }}
                  onLongPress={
                    onEventLongPress
                      ? () => {
                          setDayPicker(null);
                          onEventLongPress(item.id);
                        }
                      : undefined
                  }
                >
                  <Text style={styles.dayPickerRowText} numberOfLines={2}>
                    {item.title}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </Pressable>
        </Modal>
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
  dayLabelDowToday: { color: TODAY_RED },
  dayLabelNumWrap: { minWidth: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  dayLabelNumWrapToday: { backgroundColor: TODAY_RED },
  dayLabelNumToday: { color: colors.white },
  dayLabelInline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  allDayLabelSlot: { height: ALL_DAY_ROW_HEIGHT, justifyContent: 'center', alignItems: 'flex-end', paddingRight: 6 },
  allDayLabel: { fontSize: 10, color: colors.textSecondary },
  repeatMark: { position: 'absolute', top: 1, right: 3, fontSize: 10, opacity: 0.8 },
  todaySlot: { width: TIMELINE_LEFT_INSET, alignItems: 'center', justifyContent: 'center' },
  todayPill: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: TODAY_RED,
  },
  todayPillText: { color: TODAY_RED, fontSize: 11, fontWeight: '700' },
  allDayRow: { flexDirection: 'row' },
  allDayCell: { paddingHorizontal: 2 },
  allDayChipSlot: { height: ALL_DAY_ROW_HEIGHT, justifyContent: 'center' },
  noteBar: { height: NOTES_BAR_HEIGHT - 4, marginTop: 4, borderRadius: 5, justifyContent: 'center', paddingHorizontal: 5 },
  noteBarFilled: { backgroundColor: colors.warningPale },
  noteBarSpacer: { height: NOTES_BAR_HEIGHT },
  noteBarEmpty: { backgroundColor: colors.surface, alignItems: 'center' },
  noteBarExpanded: { borderWidth: 1.5, borderColor: colors.warning },
  notePanelWrap: {
    position: 'absolute',
    top: DAY_LABEL_ROW_HEIGHT + NOTES_BAR_HEIGHT + 2,
    left: 6,
    right: 6,
    zIndex: 30,
    elevation: 30,
  },
  noteBarText: { color: colors.textPrimary, fontSize: 10, fontWeight: '600' },
  noteBarPlus: { color: colors.textMuted, fontSize: 12, fontWeight: '600', lineHeight: 14 },
  // Same tint-and-stripe look as the timed blocks below it.
  allDayChip: {
    borderRadius: 4,
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    borderLeftWidth: 3,
    paddingHorizontal: 5,
    paddingVertical: 3,
  },
  allDayChipText: { fontSize: 10, fontWeight: '600' },
  hourLabel: { position: 'absolute', left: 0, right: 8, textAlign: 'right', fontSize: 11, color: colors.textSecondary },
  dayColumn: { height: GRID_HEIGHT },
  dayRow: { flexDirection: 'row', height: GRID_HEIGHT },
  eventBlockDragging: { opacity: 0.35 },
  eventBlockPressed: { opacity: 0.7 },
  dragGhost: {
    zIndex: 1000,
    elevation: 12,
    shadowColor: colors.textPrimary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  hourLine: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: colors.divider },
  nowLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: colors.danger,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 20,
    elevation: 20,
  },
  // Fully inside the column (a negative margin left half of it clipped).
  nowDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.danger },
  nowTimeLabel: {
    position: 'absolute',
    left: 0,
    right: 4,
    textAlign: 'right',
    fontSize: 11,
    fontWeight: '700',
    color: colors.danger,
    backgroundColor: colors.background,
    paddingVertical: 2,
    lineHeight: 12,
  },
  // Apple-Calendar-style block: pale tint fill, a solid stripe down the
  // left edge (borderLeftColor set per event), flat - no shadow. A 1px
  // white edge on top/bottom keeps back-to-back events from merging.
  eventBlock: {
    position: 'absolute',
    borderRadius: 4,
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    paddingVertical: 2,
    paddingLeft: 4,
    paddingRight: 3,
    overflow: 'hidden',
    borderLeftWidth: 3,
    borderTopWidth: 1,
    borderBottomWidth: 0,
    borderTopColor: colors.background,
  },
  eventBlockText: { fontSize: 11, fontWeight: '600', lineHeight: 13 },
  eventBlockTextRepeat: { paddingRight: 10 },
  eventBlockSub: { fontSize: 10, lineHeight: 12, opacity: 0.85, marginTop: 1 },
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
  dayPickerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(43,43,43,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  dayPickerCard: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: colors.background,
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  dayPickerTitle: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 6,
  },
  dayPickerRow: { paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.divider },
  dayPickerRowText: { color: colors.textPrimary, fontSize: 16, fontWeight: '600' },
});
