import { useFocusEffect, useRouter } from "expo-router";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  LayoutChangeEvent,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Calendar } from "react-native-calendars";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import AddPersonalItemModal from "../../components/AddPersonalItemModal";
import CalendarHeaderRow from "../../components/CalendarHeaderRow";
import CompactEventRow from "../../components/CompactEventRow";
import CompactGroupRow, { PingGroup } from "../../components/CompactGroupRow";
import CreateEventModal from "../../components/CreateEventModal";
import EventCard, { PingEvent } from "../../components/EventCard";
import EventDetailModal from "../../components/EventDetailModal";
import ExternalEventRow from "../../components/ExternalEventRow";
import GroupChatModal from "../../components/GroupChatModal";
import PingLogoMenu from "../../components/PingLogoMenu";
import ProfileMenu from "../../components/ProfileMenu";
import ScheduleReviewModal from "../../components/ScheduleReviewModal";
import WeekGrid, { WeekGridHandle } from "../../components/WeekGrid";
import { useAuth } from "../../lib/AuthContext";
import { useNotificationsContext } from "../../lib/NotificationsContext";
import { calendarTheme, colors } from "../../lib/theme";
import { eachDayKeyInRange, formatWeekRangeLabel } from "../../lib/eventDate";
import { buildDayColumns, buildAllDayColumns } from "../../lib/weekTimeline";
import { externalItemDuplicatesPing } from "../../lib/eventDedup";
import {
  CalendarPermissionStatus,
  ExternalEvent,
  deleteCalendarEvent,
  getCalendarPermissionStatus,
  getUpcomingExternalEvents,
  requestCalendarAccess,
} from "../../lib/calendarConflicts";
import { getHiddenEventIds, hideEvent, unhideEvent } from "../../lib/hiddenEvents";
import { pickEventImage } from "../../lib/imagePicker";
import { extractScheduleEvents, ExtractedEvent } from "../../lib/scheduleImport";
import { dismissProfilePrompt, useProfilePhone } from "../../lib/useProfilePhone";
import { useLatestGroupMessages } from "../../lib/useLatestGroupMessages";
import { useLatestMessages } from "../../lib/useLatestMessages";
import { supabase } from "../../supabase";

const toDateKey = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

// How far the sheet may rise: it can cover the whole calendar down to just
// this many px from the top, leaving the month title + nav arrows peeking
// above it.
const MIN_TOP_INSET = 52;
const HANDLE_HEIGHT = 28;
// How much room to leave above the FAB when the handle is parked at its
// lowest resting position.
const FAB_CLEARANCE = 110;
const SPRING_CONFIG = { damping: 22, stiffness: 210, mass: 0.4 };
// Both content blocks are always mounted (never conditionally torn down
// mid-drag — see note below); this is the width of the dragY band around 0
// over which they crossfade.
const CROSSFADE_BAND = 16;
// Week mode never lets the downward drag go far enough to shrink Upcoming
// (and push the handle) past this much height - unlike Month mode, Upcoming
// never fades out in Week mode (see animatedCardsSheetStyle), so without
// this reserve the handle could ride down out of easy reach and the list
// could shrink to nothing, with no way back but a lucky blind grab.
const MIN_UPCOMING_VISIBLE = 160;

export default function HomeScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const { shouldPrompt: shouldPromptPhone, refresh: refreshProfilePhone } = useProfilePhone(session?.user?.id);
  const [phoneBannerDismissed, setPhoneBannerDismissed] = useState(false);
  const [events, setEvents] = useState<PingEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [eventsLoadError, setEventsLoadError] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [fabMenuVisible, setFabMenuVisible] = useState(false);
  const [personalItemModalVisible, setPersonalItemModalVisible] = useState(false);
  const [editingPersonalEvent, setEditingPersonalEvent] = useState<ExternalEvent | null>(null);
  const [convertPrefill, setConvertPrefill] = useState<{
    title: string;
    startDate: Date;
    endDate: Date;
    isAllDay: boolean;
  } | null>(null);
  // The personal/synced calendar item being replaced by the Ping just
  // created from it - cleaned up in handleCreated once that succeeds, so
  // it doesn't keep showing up alongside its own replacement.
  const [convertSource, setConvertSource] = useState<{ id: string; isPersonal: boolean } | null>(null);
  const [scanningSchedule, setScanningSchedule] = useState(false);
  const [scheduleReviewEvents, setScheduleReviewEvents] = useState<ExtractedEvent[] | null>(null);
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [openViaMessages, setOpenViaMessages] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  // Which month the calendar is currently showing - the default Upcoming
  // list (no day picked) scopes itself to just this month rather than every
  // future event forever, and swiping the calendar to another month moves
  // the list along with it.
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  });
  // react-native-calendars' <Calendar> only reads its `current` prop once,
  // at mount, to seed its own internal month state - it does not react to
  // that prop changing later (confirmed in node_modules/react-native-
  // calendars/src/calendar/index.js: currentMonth is a useState initializer,
  // no effect watches `current`). Swiping the calendar itself still works
  // because that updates its internal state directly, but changeMonth
  // (triggered from the Upcoming list's own swipe - see monthSwipe below)
  // has no way to reach in and update it - remounting via `key` is the only
  // way to force it to resync. Only bump this here, not in onMonthChange,
  // so the calendar's own swipe/tap never remounts itself mid-gesture.
  const [calendarSyncKey, setCalendarSyncKey] = useState(0);
  const changeMonth = (delta: number) => {
    setVisibleMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
    setCalendarSyncKey((k) => k + 1);
  };

  const [viewMode, setViewMode] = useState<"month" | "week">("month");
  const startOfWeek = (d: Date) => {
    const r = new Date(d);
    r.setHours(0, 0, 0, 0);
    r.setDate(r.getDate() - r.getDay());
    return r;
  };
  const [visibleWeekStart, setVisibleWeekStart] = useState(() => startOfWeek(new Date()));
  // Where WeekGrid's pre-rendered day range is centered - set once when
  // entering Week mode, NOT updated by scrolling (visibleWeekStart is the
  // one that tracks scroll position, for the header title). Keeping these
  // separate avoids a feedback loop: if the range start moved every time
  // the visible week changed, WeekGrid would re-derive a new range (and
  // reset its scroll position) on every scroll event.
  const [weekGridAnchor, setWeekGridAnchor] = useState(() => startOfWeek(new Date()));
  const weekGridRef = useRef<WeekGridHandle>(null);
  const onSelectMonth = () => setViewMode("month");
  // Strongest signal of "what the user's looking at" first: an explicitly
  // picked day, then today (if the month view is already showing the
  // current month), then just the visible month's start - avoids jumping
  // back to today's week if they'd already paged Month view elsewhere.
  const onSelectWeek = () => {
    const today = new Date();
    const anchor = selectedDate
      ? (() => {
          const [y, m, d] = selectedDate.split("-").map(Number);
          return new Date(y, m - 1, d);
        })()
      : visibleMonth.getFullYear() === today.getFullYear() &&
          visibleMonth.getMonth() === today.getMonth()
        ? today
        : visibleMonth;
    const anchorWeekStart = startOfWeek(anchor);
    setVisibleWeekStart(anchorWeekStart);
    setWeekGridAnchor(anchorWeekStart);
    setViewMode("week");
  };
  const [showDraftsOnly, setShowDraftsOnly] = useState(false);
  const [showDeclinedOnly, setShowDeclinedOnly] = useState(false);
  const [showHiddenOnly, setShowHiddenOnly] = useState(false);
  const [showPingsOnly, setShowPingsOnly] = useState(false);
  const [hiddenEventIds, setHiddenEventIds] = useState<Set<string>>(new Set());
  const [myRsvpByEvent, setMyRsvpByEvent] = useState<Record<string, string>>({});
  const [externalEvents, setExternalEvents] = useState<ExternalEvent[]>([]);
  const [calendarPermission, setCalendarPermission] = useState<CalendarPermissionStatus | null>(null);

  const [boardView, setBoardView] = useState<"events" | "groups">("events");
  const [groups, setGroups] = useState<PingGroup[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedGroupName, setSelectedGroupName] = useState<string | null>(
    null,
  );
  const [groupChatVisible, setGroupChatVisible] = useState(false);

  const [isCompactMode, setIsCompactMode] = useState(false);
  const [calFullHeight, setCalFullHeight] = useState<number | null>(null);
  const [totalHeight, setTotalHeight] = useState<number | null>(null);
  const calMeasuredRef = useRef(false);
  const totalMeasuredRef = useRef(false);

  const dragY = useSharedValue(0);
  const dragStart = useSharedValue(0);
  const isCompactModeShared = useSharedValue(false);

  const {
    latestByEvent,
    fetchLatestFor,
    refresh: refreshLatestMessages,
  } = useLatestMessages(session?.user?.id);
  const {
    latestByGroup,
    fetchLatestFor: fetchLatestGroupFor,
    refresh: refreshLatestGroupMessages,
  } = useLatestGroupMessages(session?.user?.id);
  const {
    unreadCount,
    refresh: refreshNotifications,
    pendingEventModal,
    clearEventModal,
    pendingGroupChat,
    clearGroupChat,
  } = useNotificationsContext();

  // visibleEvents' "is this event in the past" cutoff reads this instead of
  // calling Date.now() directly inside that useMemo - a plain Date.now()
  // call only gets re-evaluated when declinedFilteredEvents/selectedDate/
  // showDraftsOnly change, so an event that was still upcoming when the
  // list last computed kept showing as upcoming indefinitely if the app
  // just sat open/backgrounded without any of those changing (a real
  // report: a 7pm event was still showing the next morning).
  const [now, setNow] = useState(() => Date.now());

  useFocusEffect(
    useCallback(() => {
      refreshNotifications();
      // Picks up a phone number saved from Settings without needing a full
      // app relaunch - useProfilePhone only fetches once on mount otherwise,
      // so returning to Home kept showing the banner even after adding one.
      refreshProfilePhone();
      // Catches the common case (app backgrounded, then reopened) right
      // away - the interval below is just a backstop for a long
      // continuous foreground session.
      setNow(Date.now());
    }, [refreshNotifications, refreshProfilePhone]),
  );

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 5 * 60000);
    return () => clearInterval(interval);
  }, []);

  // Notifications, the invite popup's "View full details", and any other
  // in-app trigger all funnel through this instead of each pushing their
  // own full-page route - keeps every entry point landing on the same
  // flip-card modal.
  useEffect(() => {
    if (!pendingEventModal) return;
    setSelectedEventId(pendingEventModal.eventId);
    setOpenViaMessages(pendingEventModal.startOnMessages);
    setDetailVisible(true);
    clearEventModal();
  }, [pendingEventModal, clearEventModal]);

  // Same idea for group chats - the Groups screens have no chat UI of
  // their own, they just hand off to this same modal.
  useEffect(() => {
    if (!pendingGroupChat) return;
    setSelectedGroupId(pendingGroupChat.groupId);
    setSelectedGroupName(pendingGroupChat.groupName ?? null);
    setGroupChatVisible(true);
    clearGroupChat();
  }, [pendingGroupChat, clearGroupChat]);

  const fetchEvents = useCallback(async () => {
    if (!session?.user?.id) return;

    // Visibility rule: you only see an event if you have an invitee row
    // for it. Hosting an event auto-creates that row (see
    // CreateEventModal), so this one check covers both "you're hosting"
    // and "you were invited." Also grabs your own rsvp_status so declined
    // events can be filtered out of the default views below.
    const { data: myInvites, error: inviteError } = await supabase
      .from("invitees")
      .select("event_id, rsvp_status")
      .eq("user_id", session.user.id);

    if (inviteError) {
      console.error("Error fetching invited events:", inviteError);
      setEventsLoadError(true);
      return;
    }

    const rsvpByEvent: Record<string, string> = {};
    (myInvites || []).forEach((i) => {
      if (i.event_id) rsvpByEvent[i.event_id] = i.rsvp_status;
    });
    setMyRsvpByEvent(rsvpByEvent);

    const invitedEventIds = Array.from(
      new Set((myInvites || []).map((i) => i.event_id)),
    );

    if (invitedEventIds.length === 0) {
      setEvents([]);
      setEventsLoadError(false);
      return;
    }

    // Every invited event is fetched regardless of date - visibleEvents
    // below is what actually hides past events from the default Upcoming
    // view, so tapping a past day on the calendar can still reach that
    // day's event (and its conversation) instead of it never having been
    // loaded at all.
    const { data, error } = await supabase
      .from("events")
      .select("*")
      .in("id", invitedEventIds)
      .order("event_date", { ascending: true });

    if (error) {
      console.error("Error fetching events:", error);
      setEventsLoadError(true);
      return;
    }
    setEvents(data as PingEvent[]);
    setEventsLoadError(false);
  }, [session?.user?.id]);

  useEffect(() => {
    fetchEvents().finally(() => setLoading(false));
  }, [fetchEvents]);

  // Only call once permission is confirmed granted - see the matching note
  // on getUpcomingExternalEvents.
  const fetchExternalEvents = useCallback(async () => {
    try {
      setExternalEvents(await getUpcomingExternalEvents());
    } catch (err) {
      console.error("Error fetching phone calendar events:", err);
    }
  }, []);

  // Checks silently on load (no prompt) so returning users who already
  // granted access get their phone-calendar events without an extra tap -
  // first-time users see an inline "undetermined" prompt instead (below).
  useEffect(() => {
    getCalendarPermissionStatus().then((status) => {
      setCalendarPermission(status);
      if (status === "granted") fetchExternalEvents();
    });
  }, [fetchExternalEvents]);

  // Without this, anything written straight to the phone calendar from
  // somewhere other than this exact screen - Discover's "Add to My
  // Calendar", editing an event in the native Calendar app, Add Personal
  // Item's own onSaved covers itself but nothing covered arriving here from
  // elsewhere - stayed invisible in Upcoming until some unrelated action
  // happened to also call fetchExternalEvents (a pull-to-refresh). This is
  // what was behind "it says added, but I don't see it": the write itself
  // was succeeding, Home's cached externalEvents just hadn't been told to
  // refetch. Refetching on every focus resolves that the moment you come
  // back to this screen.
  useFocusEffect(
    useCallback(() => {
      if (calendarPermission === "granted") fetchExternalEvents();
    }, [calendarPermission, fetchExternalEvents]),
  );

  const handleEnableExternalCalendar = async () => {
    const granted = await requestCalendarAccess();
    setCalendarPermission(granted ? "granted" : "denied");
    if (granted) await fetchExternalEvents();
  };

  const handleDismissPhoneBanner = async () => {
    setPhoneBannerDismissed(true);
    if (session?.user?.id) await dismissProfilePrompt(session.user.id);
  };

  useEffect(() => {
    getHiddenEventIds().then(setHiddenEventIds);
  }, []);

  const handleHideEvent = async (eventId: string) => {
    setHiddenEventIds(await hideEvent(eventId));
  };

  const handleUnhideEvent = async (eventId: string) => {
    const next = await unhideEvent(eventId);
    setHiddenEventIds(next);
    // Nothing left to review - drop back to the normal Upcoming view
    // instead of leaving the user stranded on an empty "Hidden" screen.
    if (next.size === 0) setShowHiddenOnly(false);
  };

  // Groups I'm in = groups I own, union groups I'm a resolved member of.
  const fetchGroups = useCallback(async () => {
    if (!session?.user?.id) return;
    const uid = session.user.id;

    const [
      { data: owned, error: ownedError },
      { data: memberOf, error: memberError },
    ] = await Promise.all([
      supabase.from("groups").select("id, name").eq("owner_id", uid),
      supabase
        .from("group_members")
        .select("group_id, groups(id, name)")
        .eq("user_id", uid),
    ]);

    if (ownedError) console.error("Error fetching owned groups:", ownedError);
    if (memberError)
      console.error("Error fetching member groups:", memberError);

    const byId = new Map<string, PingGroup>();
    (owned || []).forEach((g: any) =>
      byId.set(g.id, { id: g.id, name: g.name }),
    );
    (memberOf || []).forEach((m: any) => {
      if (m.groups)
        byId.set(m.groups.id, { id: m.groups.id, name: m.groups.name });
    });

    setGroups(
      Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name)),
    );
  }, [session?.user?.id]);

  useEffect(() => {
    fetchGroups().finally(() => setLoadingGroups(false));
  }, [fetchGroups]);

  const openGroup = (group: PingGroup) => {
    setSelectedGroupId(group.id);
    setSelectedGroupName(group.name);
    setGroupChatVisible(true);
  };

  const handleGroupChatClose = useCallback(async () => {
    setGroupChatVisible(false);
    if (selectedGroupId) {
      await refreshLatestGroupMessages([selectedGroupId]);
    }
  }, [refreshLatestGroupMessages, selectedGroupId]);

  const handleConvertToPing = (event: ExternalEvent) => {
    setPersonalItemModalVisible(false);
    setEditingPersonalEvent(null);
    setConvertPrefill({
      title: event.title,
      startDate: new Date(event.startDate),
      endDate: new Date(event.endDate),
      isAllDay: event.allDay,
    });
    setConvertSource({ id: event.id, isPersonal: event.isPersonal });
    setModalVisible(true);
  };

  const handleScanSchedule = async () => {
    const uri = await pickEventImage();
    if (!uri) return;

    setScanningSchedule(true);
    try {
      const { events, warning } = await extractScheduleEvents(uri);
      setScanningSchedule(false);
      if (warning === "no_events_found" || events.length === 0) {
        Alert.alert(
          "No events found",
          "Couldn't find any events in that photo. Try a clearer or closer photo.",
        );
        return;
      }
      setScheduleReviewEvents(events);
    } catch (err) {
      setScanningSchedule(false);
      console.error("Error scanning schedule:", err);
      Alert.alert("Error", "Something went wrong reading that photo. Try again.");
    }
  };

  const handleCreated = async (status: "sent" | "draft") => {
    setModalVisible(false);
    setConvertPrefill(null);
    if (convertSource) {
      const source = convertSource;
      setConvertSource(null);
      try {
        if (source.isPersonal) {
          await deleteCalendarEvent(source.id);
        } else {
          setHiddenEventIds(await hideEvent(source.id));
        }
        await fetchExternalEvents();
      } catch (err) {
        console.error("Error cleaning up converted calendar item:", err);
      }
    }
    await fetchEvents();
    setEvents((current) => {
      const newest = [...current].sort(
        (a, b) =>
          new Date(b.event_date).getTime() - new Date(a.event_date).getTime(),
      )[0];
      if (newest) {
        setJustCreatedId(newest.id);
        setTimeout(() => setJustCreatedId(null), 1500);
      }
      return current;
    });
  };

  const openEvent = (
    event: PingEvent,
    options?: { startOnMessages?: boolean },
  ) => {
    setSelectedEventId(event.id);
    setOpenViaMessages(!!options?.startOnMessages);
    setDetailVisible(true);
  };

  // Shared by Week view's timed blocks (Timeline's onEventPress) and its
  // all-day chip strip - same ping-/ext- id prefixes upcomingListItems
  // already uses, routed to the exact handlers the Upcoming list uses for
  // the same two item kinds.
  const formatExternalEventTime = (ext: ExternalEvent) => {
    const dateLabel = ext.startDate.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    if (ext.allDay) return `${dateLabel} · All day`;
    const startLabel = ext.startDate.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    const endLabel = ext.endDate.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${dateLabel} · ${startLabel} – ${endLabel}`;
  };

  const handleWeekItemPress = (id: string) => {
    if (id.startsWith("ping-")) {
      const p = declinedFilteredEvents.find((e) => e.id === id.slice(5));
      if (p) openEvent(p);
    } else if (id.startsWith("ext-")) {
      // A tap here reads as "what is this", not "let me edit this" - unlike
      // the Upcoming list's explicit pencil icon, so this shows a read-only
      // peek instead of opening the edit form.
      const ext = externalEvents.find((e) => e.id === id.slice(4));
      if (ext) Alert.alert(ext.title, formatExternalEventTime(ext));
    }
  };

  // Long-pressing an empty gap in Week view (see WeekGrid's
  // onDiscoverRequest) hands off to the Explore tab, pre-scoped to that day
  // and free-time window rather than a generic "browse everything" view.
  const handleDiscoverRequest = (dayKey: string, gapStartMinutes: number, gapEndMinutes: number) => {
    router.push({
      pathname: "/explore",
      params: { date: dayKey, gapStart: String(gapStartMinutes), gapEnd: String(gapEndMinutes) },
    });
  };

  // Declined events are hidden from the calendar/lists by default (nothing
  // to act on there anymore) but never actually removed - toggling
  // showDeclinedOnly swaps to showing just those, so changing your mind is
  // still a normal RSVP change away, not a dead end.
  const declinedFilteredEvents = useMemo(() => {
    return events.filter((e) => {
      const isDeclined = myRsvpByEvent[e.id] === "declined";
      return showDeclinedOnly ? isDeclined : !isDeclined;
    });
  }, [events, myRsvpByEvent, showDeclinedOnly]);

  // Same event set the month grid marks (declined-filtered Pings, non-
  // hidden external items) - Week view is another way of looking at the
  // calendar, not the filtered Upcoming list, so it doesn't respect the
  // Drafts/Declined/Pings Only/Hidden list toggles.
  const visibleExternalEvents = useMemo(
    () => externalEvents.filter((e) => !hiddenEventIds.has(e.id)),
    [externalEvents, hiddenEventIds],
  );
  // WeekGrid's pre-rendered day range: a fixed 8-week (56-day) window
  // rather than infinite-scroll pagination (real added complexity - list
  // virtualization, re-centering to avoid unbounded growth - not worth it
  // for a calendar people mostly look at a few weeks around "now").
  // Scrolling past either edge just stops, an honest disclosed limit
  // rather than a silent bug. Centered-ish on weekGridAnchor, biased
  // slightly forward since people look ahead more than back.
  const WEEK_GRID_DAY_COUNT = 56;
  const WEEK_GRID_LOOKBACK_DAYS = 21;
  const weekGridRangeStart = useMemo(() => {
    const d = new Date(weekGridAnchor);
    d.setDate(d.getDate() - WEEK_GRID_LOOKBACK_DAYS);
    return d;
  }, [weekGridAnchor]);
  const weekGridRangeEnd = useMemo(() => {
    const d = new Date(weekGridRangeStart);
    d.setDate(d.getDate() + WEEK_GRID_DAY_COUNT);
    return d;
  }, [weekGridRangeStart]);
  const weekDayColumns = useMemo(
    () => buildDayColumns(weekGridRangeStart, weekGridRangeEnd, declinedFilteredEvents, visibleExternalEvents),
    [weekGridRangeStart, weekGridRangeEnd, declinedFilteredEvents, visibleExternalEvents],
  );
  const weekAllDayColumns = useMemo(
    () => buildAllDayColumns(weekGridRangeStart, weekGridRangeEnd, declinedFilteredEvents, visibleExternalEvents),
    [weekGridRangeStart, weekGridRangeEnd, declinedFilteredEvents, visibleExternalEvents],
  );
  // Calendar's own built-in header (title + arrows) is hidden below in
  // favor of CalendarHeaderRow (needs room for the Month/Week toggle too) -
  // this recreates just the title text it would otherwise have shown.
  const monthLabel = visibleMonth.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  const markedDates = useMemo(() => {
    const marks: Record<string, any> = {};
    declinedFilteredEvents.forEach((e) => {
      const startKey = toDateKey(new Date(e.event_date));
      const endKey = e.end_date ? toDateKey(new Date(e.end_date)) : null;

      if (endKey && endKey !== startKey) {
        // Multi-day: shade every day of the span so it reads as one
        // continuous bar instead of separate circles. The day cell is
        // centered in a wider column by default, leaving gaps between
        // days - stretching it to fill the column width and only
        // rounding the outer corners of the first/last day is what
        // makes adjacent days actually touch and read as a single bar.
        const dayKeys = eachDayKeyInRange(startKey, endKey);
        dayKeys.forEach((key, idx) => {
          const isStart = idx === 0;
          const isEnd = idx === dayKeys.length - 1;
          marks[key] = {
            ...(marks[key] || {}),
            customStyles: {
              container: {
                ...(marks[key]?.customStyles?.container || {}),
                backgroundColor: colors.primaryPale,
                width: '100%',
                alignSelf: 'stretch',
                borderRadius: 0,
                borderTopLeftRadius: isStart ? 16 : 0,
                borderBottomLeftRadius: isStart ? 16 : 0,
                borderTopRightRadius: isEnd ? 16 : 0,
                borderBottomRightRadius: isEnd ? 16 : 0,
              },
              text: {
                ...(marks[key]?.customStyles?.text || {}),
                color: colors.textPrimary,
              },
            },
          };
        });
      } else {
        marks[startKey] = {
          ...(marks[startKey] || {}),
          selected: true,
          selectedColor: colors.primaryPale,
          selectedTextColor: colors.textPrimary,
        };
      }
    });
    // Phone-calendar and personal items get a small dot instead of the big
    // circle above - only on days with no Ping event of their own, so it
    // reads as "something smaller is here too" rather than competing with
    // the circle for attention. `marked`/`dotColor` render via
    // react-native-calendars' built-in dot regardless of markingType, so
    // this coexists with the customStyles-driven circle/bar logic above
    // without needing a custom day renderer.
    externalEvents.forEach((e) => {
      if (hiddenEventIds.has(e.id)) return;
      const key = toDateKey(e.startDate);
      if (!marks[key]) {
        marks[key] = { marked: true, dotColor: colors.primary };
      }
    });
    if (selectedDate) {
      marks[selectedDate] = {
        ...(marks[selectedDate] || {}),
        selected: true,
        selectedColor: colors.primary,
        selectedTextColor: colors.textOnPrimary,
      };
    }
    // A hollow ring around today, layered on top of whatever else that day
    // already has (an event, or being the selected day) rather than
    // replacing it - customStyles is additive alongside selected/
    // selectedColor, it doesn't require switching those over.
    const todayKey = toDateKey(new Date());
    marks[todayKey] = {
      ...(marks[todayKey] || {}),
      customStyles: {
        container: { ...(marks[todayKey]?.customStyles?.container || {}), borderWidth: 2, borderColor: colors.warning },
        text: { ...(marks[todayKey]?.customStyles?.text || {}) },
      },
    };
    return marks;
  }, [declinedFilteredEvents, externalEvents, selectedDate, hiddenEventIds]);

  const visibleEvents = useMemo(() => {
    let result = declinedFilteredEvents;
    if (showDraftsOnly) {
      result = result.filter((e) => e.status === "draft");
    }
    if (selectedDate) {
      // Explicitly tapping a day - including a past one - always shows
      // what was (or is) there. Only the default Upcoming view (no day
      // picked) hides events once they're over.
      result = result.filter(
        (e) => toDateKey(new Date(e.event_date)) === selectedDate,
      );
    } else {
      result = result.filter(
        (e) =>
          e.status === "draft" ||
          new Date(e.end_date || e.event_date).getTime() >= now,
      );
    }
    return result;
  }, [declinedFilteredEvents, selectedDate, showDraftsOnly, now]);

  // Only the Upcoming list (not the Message Board, calendar dots, or drafts
  // view) mixes in phone-calendar events - they're not real Ping events, so
  // keeping them out of visibleEvents itself means nothing else downstream
  // has to know they exist.
  type UpcomingListItem =
    | { kind: "ping"; key: string; date: Date; event: PingEvent }
    | { kind: "external"; key: string; date: Date; event: ExternalEvent };

  // Bounds of the calendar's currently displayed month, used below to cap
  // the default Upcoming list to one month at a time instead of every
  // future event forever. Only applies when browsing the plain default
  // view - a picked day or the Drafts/Declined toggles already scope
  // themselves and shouldn't also be squeezed into the visible month.
  const monthStart = visibleMonth;
  const monthEnd = useMemo(
    () => new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1),
    [visibleMonth],
  );
  const inVisibleMonth = (start: Date, end: Date | null) =>
    start < monthEnd && (end ?? start) >= monthStart;

  const upcomingListItems = useMemo<UpcomingListItem[]>(() => {
    // Hidden is its own standalone view (phone-calendar events only, same
    // as hiding itself) rather than another filter layered on top of the
    // normal list - showing what's hidden alongside what isn't would just
    // recreate the clutter hiding is meant to remove.
    if (showHiddenOnly) {
      return externalEvents
        .filter((e) => hiddenEventIds.has(e.id))
        .map((e) => ({
          kind: "external" as const,
          key: `ext-${e.id}`,
          date: e.startDate,
          event: e,
        }))
        .sort((a, b) => a.date.getTime() - b.date.getTime());
    }

    const monthScoped =
      !selectedDate && !showDraftsOnly && !showDeclinedOnly && !showPingsOnly
        ? visibleEvents.filter((e) =>
            inVisibleMonth(
              new Date(e.event_date),
              e.end_date ? new Date(e.end_date) : null,
            ),
          )
        : visibleEvents;

    const pingItems: UpcomingListItem[] = monthScoped.map((e) => ({
      kind: "ping",
      key: `ping-${e.id}`,
      date: new Date(e.event_date),
      event: e,
    }));

    if (showDraftsOnly || showDeclinedOnly || showPingsOnly) return pingItems;

    // Same rule Week view uses (lib/eventDedup.ts) - no stored link ties a
    // Ping to a same-named entry someone's synced calendar independently
    // picked up for the same real-world gathering, so both used to show up
    // here as separate rows. Compared against monthScoped (not all of
    // visibleEvents) since that's exactly the set of Pings actually being
    // shown alongside these external items.
    const pingEntriesForDedup = monthScoped.map((e) => ({ title: e.title, start: new Date(e.event_date) }));
    const dayFiltered = (
      selectedDate
        ? externalEvents.filter((e) => toDateKey(e.startDate) === selectedDate)
        : externalEvents.filter((e) => inVisibleMonth(e.startDate, null))
    )
      .filter((e) => !hiddenEventIds.has(e.id))
      .filter((e) => !externalItemDuplicatesPing(pingEntriesForDedup, { title: e.title, start: e.startDate }));

    const externalItems: UpcomingListItem[] = dayFiltered.map((e) => ({
      kind: "external",
      key: `ext-${e.id}`,
      date: e.startDate,
      event: e,
    }));

    return [...pingItems, ...externalItems].sort(
      (a, b) => a.date.getTime() - b.date.getTime(),
    );
  }, [
    visibleEvents,
    showHiddenOnly,
    hiddenEventIds,
    externalEvents,
    selectedDate,
    showDraftsOnly,
    showDeclinedOnly,
    showPingsOnly,
    monthStart,
    monthEnd,
  ]);

  // The Message Board (unlike the date-sorted Upcoming list above it) reads
  // like a texting app's conversation list - most recently active thread
  // first, not soonest-upcoming first. Events with no messages yet fall
  // back to event date so they don't all clump at the bottom in an
  // arbitrary order.
  const messageBoardEvents = useMemo(() => {
    return [...visibleEvents].sort((a, b) => {
      const aTime = latestByEvent[a.id]?.createdAt;
      const bTime = latestByEvent[b.id]?.createdAt;
      if (aTime && bTime) return new Date(bTime).getTime() - new Date(aTime).getTime();
      if (aTime) return -1;
      if (bTime) return 1;
      return new Date(a.event_date).getTime() - new Date(b.event_date).getTime();
    });
  }, [visibleEvents, latestByEvent]);

  const messageBoardGroups = useMemo(() => {
    return [...groups].sort((a, b) => {
      const aTime = latestByGroup[a.id]?.createdAt;
      const bTime = latestByGroup[b.id]?.createdAt;
      if (aTime && bTime) return new Date(bTime).getTime() - new Date(aTime).getTime();
      if (aTime) return -1;
      if (bTime) return 1;
      return 0;
    });
  }, [groups, latestByGroup]);

  const onDayPress = (day: { dateString: string }) => {
    setSelectedDate((prev) =>
      prev === day.dateString ? null : day.dateString,
    );
  };

  // Fetch latest-message snippets lazily once compact mode is entered;
  // useLatestMessages/useLatestGroupMessages cache by id, so repeat calls
  // are cheap.
  useEffect(() => {
    if (isCompactMode && boardView === "events" && visibleEvents.length > 0) {
      fetchLatestFor(visibleEvents.map((e) => e.id));
    }
  }, [isCompactMode, boardView, visibleEvents, fetchLatestFor]);

  useEffect(() => {
    if (isCompactMode && boardView === "groups" && groups.length > 0) {
      fetchLatestGroupFor(groups.map((g) => g.id));
    }
  }, [isCompactMode, boardView, groups, fetchLatestGroupFor]);

  const handleRefresh = useCallback(async () => {
    if (boardView === "groups") {
      await fetchGroups();
      if (isCompactMode) {
        await refreshLatestGroupMessages(groups.map((g) => g.id));
      }
      return;
    }
    await fetchEvents();
    if (calendarPermission === "granted") await fetchExternalEvents();
    if (isCompactMode) {
      await refreshLatestMessages(visibleEvents.map((e) => e.id));
    }
  }, [
    boardView,
    fetchGroups,
    isCompactMode,
    refreshLatestGroupMessages,
    groups,
    fetchEvents,
    calendarPermission,
    fetchExternalEvents,
    refreshLatestMessages,
    visibleEvents,
  ]);

  const handleDetailClose = useCallback(async () => {
    setDetailVisible(false);
    await fetchEvents();
    if (isCompactMode && boardView === "events" && selectedEventId) {
      await refreshLatestMessages([selectedEventId]);
    }
  }, [
    fetchEvents,
    isCompactMode,
    boardView,
    refreshLatestMessages,
    selectedEventId,
  ]);

  const ready = calFullHeight !== null && totalHeight !== null;
  // Three real resting points for dragY: topLimit (handle near the month
  // title, cards extended), 0 (default, handle under the calendar),
  // bottomLimit (handle parked near the + button, message rows extended).
  const topLimit = ready ? -(calFullHeight! - MIN_TOP_INSET) : 0;
  // Room below the calendar before it needs to start covering anything. On
  // a screen with plenty of natural room, this is already past the
  // calendar's halfway point and nothing needs to cover anything — bottomLimit
  // just equals originalRoom, identical to the original (already-proven)
  // behavior. Only a cramped screen, where that natural room falls short of
  // reaching halfway up the calendar, extends bottomLimit further and lets
  // the rows block's top rise to cover the difference — and never past the
  // calendar's own midpoint. (An earlier version of this let it cover the
  // calendar all the way to the top on every screen size, which pushed the
  // fully-open snap point so far down that dragging back to center became a
  // fight — it always felt stuck pinned open.)
  const originalRoom = ready
    ? Math.max(0, totalHeight! - calFullHeight! - FAB_CLEARANCE)
    : 0;
  const roomNeededForHalfway = ready
    ? Math.max(0, totalHeight! - calFullHeight! / 2 - FAB_CLEARANCE)
    : 0;
  const bottomLimit = ready ? Math.max(80, originalRoom, roomNeededForHalfway) : 0;
  const extraCoverable = Math.max(0, bottomLimit - originalRoom);

  // Week mode repurposes the same downward drag + bottomLimit budget that
  // Month mode grants to the Message Board (rows block) below - instead of
  // revealing messages, dragging down in Week view grows how many hours of
  // the day are visible. WeekGrid itself is always given this full max
  // height as its own internal layout budget (see the height prop below) so
  // it never re-renders mid-drag - only the clipping wrapper's height
  // animates, purely on the UI thread.
  const weekGridBaseHeight = Math.max(0, (calFullHeight ?? 0) - MIN_TOP_INSET);
  // Week mode's own, smaller ceiling for dragY - leaves MIN_UPCOMING_VISIBLE
  // of Upcoming (and the handle) always reachable, unlike Month mode's
  // bottomLimit which is fine to ride all the way down since Upcoming there
  // is meant to fully hand off to the Message Board.
  const weekBottomLimit = ready ? Math.max(0, bottomLimit - MIN_UPCOMING_VISIBLE) : 0;
  const weekGridMaxHeight = weekGridBaseHeight + weekBottomLimit;
  // Week mode's resting (dragY=0) height is boosted by this much over
  // Month's - showing only ~3 hours by default (weekGridBaseHeight alone)
  // was too little to be useful without dragging every time. Capped to
  // weekBottomLimit so it never asks for more than that ceiling allows.
  const weekDefaultExpansion = Math.min(280, weekBottomLimit);

  const handleContentLayout = (e: LayoutChangeEvent) => {
    if (totalMeasuredRef.current) return;
    totalMeasuredRef.current = true;
    setTotalHeight(e.nativeEvent.layout.height);
  };

  const handleCalendarLayout = (e: LayoutChangeEvent) => {
    if (calMeasuredRef.current) return;
    calMeasuredRef.current = true;
    setCalFullHeight(e.nativeEvent.layout.height);
  };

  const pan = Gesture.Pan()
    .enabled(ready)
    .onBegin(() => {
      dragStart.value = dragY.value;
    })
    .onUpdate((e) => {
      const next = dragStart.value + e.translationY;
      const maxY = viewMode === "week" ? weekBottomLimit : bottomLimit;
      dragY.value = Math.min(maxY, Math.max(topLimit, next));
    })
    .onEnd(() => {
      // Snap purely by physical nearest-point — no velocity involved.
      // Velocity-based projection (even capped/direction-gated) kept
      // overshooting straight past the intended target to whichever
      // endpoint matched the direction of motion, regardless of how close
      // the actual release position was to a nearer point.
      const maxY = viewMode === "week" ? weekBottomLimit : bottomLimit;
      const points = [topLimit, 0, maxY];
      let target = points[0];
      let bestDist = Math.abs(points[0] - dragY.value);
      for (let i = 1; i < points.length; i++) {
        const dist = Math.abs(points[i] - dragY.value);
        if (dist < bestDist) {
          bestDist = dist;
          target = points[i];
        }
      }
      dragY.value = withSpring(target, SPRING_CONFIG);
    });

  // Lets the Upcoming list change months the same way swiping the calendar
  // grid itself does - needed because pulling the sheet up covers that grid
  // (see topLimit/MIN_TOP_INSET above), so it's otherwise unreachable while
  // the list is showing. activeOffsetX/failOffsetY keep this from
  // hijacking the FlatList's own vertical scroll - it only takes over once
  // the drag is clearly more horizontal than vertical.
  const monthSwipe = Gesture.Pan()
    .activeOffsetX([-20, 20])
    .failOffsetY([-10, 10])
    .onEnd((e) => {
      if (e.translationX <= -40) {
        runOnJS(changeMonth)(1);
      } else if (e.translationX >= 40) {
        runOnJS(changeMonth)(-1);
      }
    });

  // Lets the "Messages" menu link snap the handle straight to the bottom
  // resting point, revealing the Message Board the same way a manual drag
  // would — teaches people where the feature lives.
  const openMessages = () => {
    if (!ready) return;
    // In Week mode the same downward drag/bottomLimit is repurposed to grow
    // the hour grid instead of revealing the Message Board (see
    // weekGridMaxHeight above) - switch back to Month first so this always
    // actually lands on messages regardless of which view was showing.
    if (viewMode === "week") setViewMode("month");
    dragY.value = withSpring(bottomLimit, SPRING_CONFIG);
  };

  // A guaranteed, tap-based way back to the calendar/Upcoming view that
  // doesn't depend on successfully grabbing and dragging the handle - the
  // drag alone has been the single most fragile part of this screen, so
  // this exists as a plain button that can't get stuck the way a gesture
  // recognizer can.
  const closeMessages = () => {
    if (!ready) return;
    dragY.value = withSpring(0, SPRING_CONFIG);
  };

  // Content type is a pure function of which side of center the handle is
  // on — no separate toggle/threshold bookkeeping needed.
  useAnimatedReaction(
    // Week mode never enters compact/Message-Board mode - its downward drag
    // is repurposed to grow the hour grid instead (see weekGridMaxHeight).
    () => dragY.value > 0 && viewMode !== "week",
    (shouldBeCompact) => {
      if (shouldBeCompact !== isCompactModeShared.value) {
        isCompactModeShared.value = shouldBeCompact;
        runOnJS(setIsCompactMode)(shouldBeCompact);
      }
    },
  );

  // Cards sheet and rows block are both *always* mounted — swapping one
  // out via conditional rendering mid-drag (tearing down/mounting an
  // Animated.View tree while dragY is being updated every frame) was
  // destabilizing the gesture right at the crossing point, sending it flying
  // to the far endpoint instead of settling near the middle. Crossfading
  // opacity instead means nothing ever mounts/unmounts during a drag.

  // Cards sheet: top edge rises to cover the calendar, bottom edge always
  // pinned to the true screen bottom. Animating `top` (not a translateY
  // transform) so the box's real height always matches what's actually
  // visible — a transform only repaints the box shifted, it doesn't
  // resize it, so the FlatList inside kept thinking it had more room than
  // was actually on-screen and would scroll its last item into a clipped,
  // invisible strip past the true bottom edge.
  const animatedCardsSheetStyle = useAnimatedStyle(() => {
    const base = calFullHeight ?? MIN_TOP_INSET;
    const upTop = interpolate(
      dragY.value,
      [topLimit, 0],
      [MIN_TOP_INSET, base],
      Extrapolation.CLAMP,
    );
    if (viewMode === "week") {
      // Week mode's downward drag grows the hour grid (see
      // weekGridMaxHeight) instead of revealing the Message Board - Upcoming
      // stays fully visible and just gets pushed down to stay flush against
      // the growing calendar, rather than fading out. The rest position
      // (dragY=0) is itself boosted by weekDefaultExpansion so Week view
      // opens already showing more than a bare handful of hours, without
      // giving up the topLimit/weekBottomLimit endpoints - only the 0→
      // weekBottomLimit segment's slope compresses slightly to make room for
      // that boosted starting point.
      if (weekBottomLimit <= 0) {
        return { opacity: 1, top: upTop };
      }
      return {
        opacity: 1,
        top: interpolate(
          dragY.value,
          [topLimit, 0, weekBottomLimit],
          [MIN_TOP_INSET, base + weekDefaultExpansion, base + weekBottomLimit],
          Extrapolation.CLAMP,
        ),
      };
    }
    return {
      // Only fades out once you're pulling into rows territory (dragY > 0);
      // fully opaque for the entire rest/up range, so the default view never
      // sits mid-fade.
      opacity: interpolate(
        dragY.value,
        [0, CROSSFADE_BAND],
        [1, 0],
        Extrapolation.CLAMP,
      ),
      top: upTop,
    };
  });

  // Rows block: top edge stays flush against the calendar while there's
  // still room below it (dragY <= originalRoom); only on a cramped screen
  // does the drag go past that, at which point the top itself starts rising
  // to cover the calendar too (never past its own midpoint — see
  // roomNeededForHalfway above). Height always simply tracks dragY 1:1.
  const animatedRowsBlockStyle = useAnimatedStyle(() => {
    // Never shown in Week mode - that view's downward drag grows the hour
    // grid's own ScrollView instead (see WeekGrid's animatedScrollAreaStyle).
    if (viewMode === "week") {
      return { opacity: 0, top: calFullHeight ?? 0, height: 0 };
    }
    const calBottom = calFullHeight ?? 0;
    const covered =
      extraCoverable > 0
        ? interpolate(dragY.value, [originalRoom, bottomLimit], [0, extraCoverable], Extrapolation.CLAMP)
        : 0;
    return {
      opacity: interpolate(
        dragY.value,
        [0, CROSSFADE_BAND],
        [0, 1],
        Extrapolation.CLAMP,
      ),
      top: calBottom - covered,
      height: interpolate(
        dragY.value,
        [0, bottomLimit],
        [0, bottomLimit],
        Extrapolation.CLAMP,
      ),
    };
  });

  // The handle itself: a single, always-mounted element so the active
  // gesture never gets orphaned by a conditional remount mid-drag. It must
  // track the actual drag distance 1:1 so it always moves with your finger
  // — the cards sheet's top for dragY<=0 (which happens to also be a 1:1
  // mapping), and calBottom + dragY for dragY>=0. (An earlier version tried
  // tracking the rows block's top edge instead, which stays pinned in place
  // for the whole normal-screen drag range — the handle would freeze right
  // on top of the Events/Groups row instead of moving, blocking those
  // buttons and making the drag feel broken.)
  const animatedHandleStyle = useAnimatedStyle(() => {
    const calBottom = calFullHeight ?? MIN_TOP_INSET;
    // Week mode's cards sheet rests at a boosted top (see
    // animatedCardsSheetStyle) - the handle has to track that same boosted
    // curve or it visually drifts away from the sheet's actual top edge.
    if (viewMode === "week" && weekBottomLimit > 0) {
      return {
        transform: [
          {
            translateY: interpolate(
              dragY.value,
              [topLimit, 0, weekBottomLimit],
              [MIN_TOP_INSET, calBottom + weekDefaultExpansion, calBottom + weekBottomLimit],
              Extrapolation.CLAMP,
            ),
          },
        ],
      };
    }
    if (dragY.value <= 0) {
      return {
        transform: [
          {
            translateY: interpolate(
              dragY.value,
              [topLimit, 0],
              [MIN_TOP_INSET, calBottom],
              Extrapolation.CLAMP,
            ),
          },
        ],
      };
    }
    return { transform: [{ translateY: calBottom + dragY.value }] };
  });

  const renderListHeader = (defaultTitle: string) => (
    <View style={styles.listHeaderRow}>
      <Text style={styles.pageTitle}>
        {showHiddenOnly
          ? "Hidden"
          : showDraftsOnly
            ? "Drafts"
            : showDeclinedOnly
              ? "Declined"
              : selectedDate
                ? "On this day"
                : defaultTitle}
      </Text>
      <View style={styles.listHeaderActions}>
        {selectedDate && (
          <TouchableOpacity onPress={() => setSelectedDate(null)}>
            <Text style={styles.clearFilterText}>Show all</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={() => setShowPingsOnly((prev) => !prev)}>
          <Text
            style={[
              styles.draftsText,
              showPingsOnly && styles.draftsTextActive,
            ]}
          >
            {showPingsOnly ? "Pings Only ✓" : "Pings Only"}
          </Text>
        </TouchableOpacity>
        {hiddenEventIds.size > 0 && (
          <TouchableOpacity
            onPress={() =>
              setShowHiddenOnly((prev) => {
                if (!prev) {
                  setShowDraftsOnly(false);
                  setShowDeclinedOnly(false);
                }
                return !prev;
              })
            }
          >
            <Text
              style={[
                styles.draftsText,
                showHiddenOnly && styles.draftsTextActive,
              ]}
            >
              {showHiddenOnly ? "Hidden ✓" : "Hidden"}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );

  // The compact rows block's header carries the Events/Groups toggle.
  // Date-filter/"Show all" is events-only — groups aren't date-scoped.
  const renderRowsHeader = () => (
    <View style={[styles.listHeaderRow, styles.rowsHeaderRow]}>
      <TouchableOpacity onPress={closeMessages} style={styles.backToCalendarButton}>
        <Text style={styles.pageTitle} numberOfLines={1}>
          ‹{" "}
          {boardView === "groups"
            ? "Groups"
            : showDraftsOnly
              ? "Drafts"
              : selectedDate
                ? "On this day"
                : "Message Board"}
        </Text>
      </TouchableOpacity>
      <View style={styles.listHeaderActions}>
        {boardView === "events" && selectedDate && (
          <TouchableOpacity onPress={() => setSelectedDate(null)}>
            <Text style={styles.clearFilterText}>Show all</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={() => setBoardView("events")}>
          <Text
            style={[
              styles.draftsText,
              boardView === "events" && styles.draftsTextActive,
            ]}
          >
            Events
          </Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setBoardView("groups")}>
          <Text
            style={[
              styles.draftsText,
              boardView === "groups" && styles.draftsTextActive,
            ]}
          >
            Groups
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const emptyText = showHiddenOnly
    ? "Nothing hidden."
    : showDraftsOnly
      ? "No drafts right now."
      : showDeclinedOnly
        ? "No declined events."
        : selectedDate
          ? "No events on this day."
          : "No events yet — tap + to create one.";

  const groupsEmptyText = "No groups yet — create one from the Groups screen.";

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <PingLogoMenu
          hasNotifications={unreadCount > 0}
          onCreatePing={() => setModalVisible(true)}
          onOpenMessages={openMessages}
        />
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={() => setModalVisible(true)}>
            <Text style={styles.createText}>Create</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push("/groups")}>
            <Text style={styles.groupsText}>Groups</Text>
          </TouchableOpacity>
          <ProfileMenu
            draftsActive={showDraftsOnly}
            declinedActive={showDeclinedOnly}
            onToggleDrafts={() => {
              setShowDraftsOnly((prev) => {
                if (!prev) {
                  setShowDeclinedOnly(false);
                  setShowHiddenOnly(false);
                }
                return !prev;
              });
              closeMessages();
            }}
            onToggleDeclined={() => {
              setShowDeclinedOnly((prev) => {
                if (!prev) {
                  setShowDraftsOnly(false);
                  setShowHiddenOnly(false);
                }
                return !prev;
              });
              closeMessages();
            }}
          />
        </View>
      </View>

      <View style={styles.contentArea} onLayout={handleContentLayout}>
        <View style={styles.calendarWrapper} onLayout={handleCalendarLayout}>
          <View style={styles.calendarHeaderRow}>
            <CalendarHeaderRow
              title={viewMode === "month" ? monthLabel : formatWeekRangeLabel(visibleWeekStart)}
              onPrev={() => (viewMode === "month" ? changeMonth(-1) : weekGridRef.current?.scrollByDays(-7))}
              onNext={() => (viewMode === "month" ? changeMonth(1) : weekGridRef.current?.scrollByDays(7))}
              viewMode={viewMode}
              onSelectMonth={onSelectMonth}
              onSelectWeek={onSelectWeek}
            />
          </View>
          {viewMode === "month" ? (
            <Calendar
              key={calendarSyncKey}
              current={toDateKey(visibleMonth)}
              onDayPress={onDayPress}
              onMonthChange={(month) =>
                setVisibleMonth(new Date(month.year, month.month - 1, 1))
              }
              markedDates={markedDates}
              markingType="custom"
              theme={calendarTheme}
              style={styles.calendar}
              enableSwipeMonths
              hideArrows
              customHeaderTitle={<View />}
            />
          ) : (
            <WeekGrid
              ref={weekGridRef}
              rangeStart={weekGridRangeStart}
              dayCount={WEEK_GRID_DAY_COUNT}
              initialDayIndex={WEEK_GRID_LOOKBACK_DAYS}
              eventsByDay={weekDayColumns}
              allDayByDay={weekAllDayColumns}
              height={weekGridMaxHeight}
              onEventPress={handleWeekItemPress}
              onVisibleWeekChange={setVisibleWeekStart}
              onDiscoverRequest={handleDiscoverRequest}
              dragY={dragY}
              visibleHeight={weekGridBaseHeight}
              maxExtraHeight={weekBottomLimit}
              defaultExpansion={weekDefaultExpansion}
            />
          )}
        </View>

        <Animated.View
          style={[styles.cardsSheet, ready && animatedCardsSheetStyle]}
          pointerEvents={isCompactMode ? "none" : "auto"}
        >
          <View style={styles.handleSpacer} />
          {renderListHeader("Upcoming")}
          {eventsLoadError && (
            <TouchableOpacity
              style={styles.errorPromptRow}
              onPress={() => fetchEvents()}
            >
              <Text style={styles.errorPromptText}>
                ⚠️ Couldn't load your Pings — tap to retry
              </Text>
            </TouchableOpacity>
          )}
          {calendarPermission === "undetermined" &&
            !showDraftsOnly &&
            !showDeclinedOnly && (
              <TouchableOpacity
                style={styles.calendarPromptRow}
                onPress={handleEnableExternalCalendar}
              >
                <Text style={styles.calendarPromptText}>
                  📅 Show your phone calendar here too
                </Text>
              </TouchableOpacity>
            )}
          {shouldPromptPhone &&
            !phoneBannerDismissed &&
            !showDraftsOnly &&
            !showDeclinedOnly &&
            !showHiddenOnly && (
              <View style={styles.calendarPromptRow}>
                <TouchableOpacity
                  style={{ flex: 1 }}
                  onPress={() => router.push("/settings")}
                >
                  <Text style={styles.calendarPromptText}>
                    📱 Add your phone number so people can find and invite you
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleDismissPhoneBanner}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.phonePromptDismiss}>✕</Text>
                </TouchableOpacity>
              </View>
            )}
          <GestureDetector gesture={monthSwipe}>
          <FlatList
            style={{ flex: 1 }}
            data={upcomingListItems}
            keyExtractor={(item) => item.key}
            extraData={myRsvpByEvent}
            refreshControl={
              <RefreshControl
                refreshing={loading}
                onRefresh={handleRefresh}
                tintColor={colors.primary}
              />
            }
            renderItem={({ item }) =>
              item.kind === "ping" ? (
                <EventCard
                  event={item.event}
                  highlight={item.event.id === justCreatedId}
                  onPress={openEvent}
                  rsvpStatus={myRsvpByEvent[item.event.id] as any}
                />
              ) : showHiddenOnly ? (
                <ExternalEventRow
                  event={item.event}
                  onUnhide={() => handleUnhideEvent(item.event.id)}
                />
              ) : (
                <ExternalEventRow
                  event={item.event}
                  onEdit={item.event.editable ? () => setEditingPersonalEvent(item.event) : undefined}
                  onHide={() => handleHideEvent(item.event.id)}
                />
              )
            }
            ListEmptyComponent={
              !loading ? (
                <Text style={styles.emptyText}>{emptyText}</Text>
              ) : null
            }
            contentContainerStyle={{ paddingVertical: 12, paddingBottom: 120 }}
          />
          </GestureDetector>
        </Animated.View>

        <Animated.View
          style={[
            styles.rowsBlock,
            !ready && { top: calFullHeight ?? 0 },
            ready && animatedRowsBlockStyle,
          ]}
          pointerEvents={isCompactMode ? "auto" : "none"}
        >
          {renderRowsHeader()}
          {boardView === "events" ? (
            <FlatList
              style={{ flex: 1 }}
              data={messageBoardEvents}
              keyExtractor={(item) => item.id}
              extraData={latestByEvent}
              refreshControl={
                <RefreshControl
                  refreshing={loading}
                  onRefresh={handleRefresh}
                  tintColor={colors.primary}
                />
              }
              renderItem={({ item }) => (
                <CompactEventRow
                  event={item}
                  snippet={latestByEvent[item.id]}
                  onPress={(e) => openEvent(e, { startOnMessages: true })}
                />
              )}
              ListEmptyComponent={
                !loading ? (
                  <Text style={styles.emptyText}>{emptyText}</Text>
                ) : null
              }
            />
          ) : (
            <FlatList
              style={{ flex: 1 }}
              data={messageBoardGroups}
              keyExtractor={(item) => item.id}
              extraData={latestByGroup}
              refreshControl={
                <RefreshControl
                  refreshing={loadingGroups}
                  onRefresh={handleRefresh}
                  tintColor={colors.primary}
                />
              }
              renderItem={({ item }) => (
                <CompactGroupRow
                  group={item}
                  snippet={latestByGroup[item.id]}
                  onPress={openGroup}
                />
              )}
              ListEmptyComponent={
                !loadingGroups ? (
                  <Text style={styles.emptyText}>{groupsEmptyText}</Text>
                ) : null
              }
            />
          )}
        </Animated.View>

        <Animated.View
          style={[styles.handleWrap, ready && animatedHandleStyle]}
        >
          <GestureDetector gesture={pan}>
            <View style={styles.dragHandleArea}>
              <View style={styles.dragHandle} />
            </View>
          </GestureDetector>
        </Animated.View>
      </View>

      {fabMenuVisible && (
        <Pressable
          style={styles.fabMenuBackdrop}
          onPress={() => setFabMenuVisible(false)}
        />
      )}

      <TouchableOpacity
        style={styles.fab}
        onPress={() => setFabMenuVisible(true)}
        activeOpacity={0.85}
      >
        <Text style={styles.fabPlus}>+</Text>
      </TouchableOpacity>

      {fabMenuVisible && (
        <View style={styles.fabMenuItems} pointerEvents="box-none">
          <TouchableOpacity
            onPress={() => {
              setFabMenuVisible(false);
              setPersonalItemModalVisible(true);
            }}
          >
            <Text style={styles.fabMenuItemText}>Add Personal Item</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              setFabMenuVisible(false);
              handleScanSchedule();
            }}
          >
            <Text style={styles.fabMenuItemText}>Scan a Schedule</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              setFabMenuVisible(false);
              setModalVisible(true);
            }}
          >
            <Text style={styles.fabMenuItemText}>Create a Ping</Text>
          </TouchableOpacity>
        </View>
      )}

      <CreateEventModal
        visible={modalVisible}
        onClose={() => {
          setModalVisible(false);
          setConvertPrefill(null);
          setConvertSource(null);
        }}
        onCreated={handleCreated}
        initialDate={selectedDate}
        prefill={convertPrefill}
      />

      <AddPersonalItemModal
        visible={personalItemModalVisible || !!editingPersonalEvent}
        editingEvent={editingPersonalEvent}
        initialDate={selectedDate}
        onClose={() => {
          setPersonalItemModalVisible(false);
          setEditingPersonalEvent(null);
        }}
        onSaved={async () => {
          setPersonalItemModalVisible(false);
          setEditingPersonalEvent(null);
          setCalendarPermission("granted");
          await fetchExternalEvents();
        }}
        onConvertToPing={handleConvertToPing}
      />

      {scanningSchedule && (
        <View style={styles.scanningOverlay} pointerEvents="auto">
          <ActivityIndicator color={colors.textOnPrimary} size="large" />
          <Text style={styles.scanningText}>Reading your schedule…</Text>
        </View>
      )}

      <ScheduleReviewModal
        visible={!!scheduleReviewEvents}
        extractedEvents={scheduleReviewEvents || []}
        onClose={() => setScheduleReviewEvents(null)}
        onSaved={async () => {
          setScheduleReviewEvents(null);
          setCalendarPermission("granted");
          await fetchExternalEvents();
        }}
      />

      <EventDetailModal
        visible={detailVisible}
        eventId={selectedEventId}
        startOnMessages={openViaMessages}
        onClose={handleDetailClose}
      />

      <GroupChatModal
        visible={groupChatVisible}
        groupId={selectedGroupId}
        groupName={selectedGroupName}
        onClose={handleGroupChatClose}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingTop: 60 },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginHorizontal: 20,
    marginBottom: 4,
  },
  headerActions: { flexDirection: "row", gap: 16, alignItems: "center" },
  createText: { color: colors.primary, fontSize: 14, fontWeight: "700" },
  draftsText: { color: colors.textSecondary, fontSize: 14, fontWeight: "600" },
  draftsTextActive: { color: colors.primary },
  groupsText: { color: colors.primary, fontSize: 14, fontWeight: "600" },
  contentArea: { flex: 1, position: "relative", overflow: "hidden" },
  calendarWrapper: {},
  calendar: { borderBottomWidth: 1, borderBottomColor: colors.divider },
  // Fixed to MIN_TOP_INSET so it's exactly the height that stays visible
  // when the Upcoming sheet is dragged all the way up, in both Month and
  // Week mode - see the note on MIN_TOP_INSET above.
  calendarHeaderRow: { height: MIN_TOP_INSET },
  // Cards sheet: rises to cover the calendar as you drag up; pinned right
  // under it at rest. Reserves handleSpacer at the top so its content
  // doesn't render under the independently-floating handle.
  cardsSheet: {
    position: "absolute",
    left: 0,
    right: 0,
    top: MIN_TOP_INSET,
    bottom: 0,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  handleSpacer: { height: HANDLE_HEIGHT },
  // Rows block: top fixed flush against the calendar, height grows downward
  // as the handle is dragged toward the + button.
  rowsBlock: {
    position: "absolute",
    left: 0,
    right: 0,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    overflow: "hidden",
  },
  // The floating handle: one persistent element positioned independently of
  // both content blocks (both always mounted), so the gesture stays bound
  // to the same view throughout the whole drag.
  handleWrap: { position: "absolute", left: 0, right: 0, top: 0 },
  dragHandleArea: {
    height: HANDLE_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
  },
  dragHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
  },
  listHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginHorizontal: 20,
    marginTop: 4,
  },
  // Message Board / Groups board sit right under the drag handle with no
  // separate spacer above them (unlike the Upcoming list's handleSpacer),
  // so this row needs its own extra breathing room instead of sharing
  // listHeaderRow's tighter default.
  rowsHeaderRow: {
    marginTop: 16,
    marginBottom: 12,
  },
  listHeaderActions: { flexDirection: "row", gap: 16, alignItems: "center" },
  // The title itself is the way back to the calendar now (tap it) - it used
  // to share this row with a separate "▲ Calendar" button, which was too
  // much for the Events/Groups toggle to fit alongside on a small screen.
  backToCalendarButton: { flexShrink: 1, marginRight: 8 },
  pageTitle: { color: colors.textPrimary, fontSize: 22, fontWeight: "700" },
  clearFilterText: { color: colors.primary, fontSize: 14, fontWeight: "600" },
  calendarPromptRow: {
    marginHorizontal: 20,
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
  },
  calendarPromptText: { color: colors.primaryDark, fontSize: 13 },
  phonePromptDismiss: { color: colors.textMuted, fontSize: 13, paddingLeft: 12 },
  errorPromptRow: {
    marginHorizontal: 20,
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
  },
  errorPromptText: { color: colors.danger, fontSize: 13, fontWeight: "600" },
  emptyText: {
    color: colors.textMuted,
    textAlign: "center",
    marginTop: 40,
    fontSize: 15,
  },
  fab: {
    position: "absolute",
    right: 24,
    bottom: 40,
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: colors.textPrimary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 6,
  },
  fabPlus: {
    color: colors.textOnPrimary,
    fontSize: 34,
    fontWeight: "400",
    marginTop: -2,
  },
  fabMenuBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(43,43,43,0.45)",
  },
  fabMenuItems: {
    position: "absolute",
    right: 24,
    bottom: 116,
    alignItems: "flex-end",
    gap: 20,
  },
  scanningOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(43,43,43,0.55)",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  scanningText: {
    color: colors.textOnPrimary,
    fontSize: 16,
    fontWeight: "600",
  },
  fabMenuItemText: {
    color: colors.textOnPrimary,
    fontSize: 17,
    fontWeight: "700",
    paddingVertical: 6,
    textShadowColor: "rgba(0,0,0,0.35)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});
