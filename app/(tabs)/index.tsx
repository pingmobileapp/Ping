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
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import AddPersonalItemModal from "../../components/AddPersonalItemModal";
import CalendarHeaderRow from "../../components/CalendarHeaderRow";
import CreateEventModal from "../../components/CreateEventModal";
import EventCard, { PingEvent } from "../../components/EventCard";
import EventDetailModal from "../../components/EventDetailModal";
import ExternalEventRow from "../../components/ExternalEventRow";
import GroupChatModal from "../../components/GroupChatModal";
import { CELL_HEIGHT } from "../../components/MonthDayCell";
import MonthGrid, { MonthGridHandle, MONTH_LABEL_HEIGHT, WEEKDAY_HEADER_HEIGHT } from "../../components/MonthGrid";
import PingLogoMenu from "../../components/PingLogoMenu";
import ProfileMenu from "../../components/ProfileMenu";
import FilterMenu, { HomeFilter } from "../../components/FilterMenu";
import ScheduleReviewModal from "../../components/ScheduleReviewModal";
import WeekGrid, { WeekGridHandle } from "../../components/WeekGrid";
import { useAuth } from "../../lib/AuthContext";
import { useNotificationsContext } from "../../lib/NotificationsContext";
import { colors } from "../../lib/theme";
import { formatWeekRangeLabel } from "../../lib/eventDate";
import { buildDayColumns, buildAllDayColumns, buildMonthDayBars, MonthDayBar } from "../../lib/weekTimeline";
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
import { getAllImportantItemIds } from "../../lib/eventReminders";
import { DailyWeather, fetchWeatherForEvents } from "../../lib/eventWeather";
import InterestedActivityCard from "../../components/InterestedActivityCard";
import {
  InterestedActivity,
  fetchInterestedActivities,
  removeInterestByKey,
} from "../../lib/discoverActivities";
import { pickEventImage } from "../../lib/imagePicker";
import { extractScheduleEvents, ExtractedEvent } from "../../lib/scheduleImport";
import { dismissProfilePrompt, useProfilePhone } from "../../lib/useProfilePhone";
import { supabase } from "../../supabase";

const toDateKey = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

// How far the drag sheet may rise, in either mode: it can cover the whole
// grid (MonthGrid or WeekGrid) down to just this many px from the top,
// leaving the title + nav arrows peeking above it.
const MIN_TOP_INSET = 52;
const HANDLE_HEIGHT = 28;
// How much room to leave above the FAB when the handle is parked at its
// lowest resting position.
const FAB_CLEARANCE = 110;
const SPRING_CONFIG = { damping: 22, stiffness: 210, mass: 0.4 };

export default function HomeScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const { shouldPrompt: shouldPromptPhone, refresh: refreshProfilePhone } = useProfilePhone(session?.user?.id);
  const [phoneBannerDismissed, setPhoneBannerDismissed] = useState(false);
  const [events, setEvents] = useState<PingEvent[]>([]);
  const [weatherByEventId, setWeatherByEventId] = useState<Record<string, DailyWeather>>({});
  const [interestedActivities, setInterestedActivities] = useState<InterestedActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [eventsLoadError, setEventsLoadError] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [fabMenuVisible, setFabMenuVisible] = useState(false);
  // Set only by long-pressing an empty Week-view slot (see
  // handleEmptySlotLongPress) - takes priority over selectedDate for the
  // create modals' initialDate below, without touching selectedDate itself
  // (which also drives the Upcoming list's day filter - a Week-view
  // long-press shouldn't jump that too).
  const [createPrefillDate, setCreatePrefillDate] = useState<string | null>(null);
  const [createPrefillMinutes, setCreatePrefillMinutes] = useState<number | null>(null);
  const [personalItemModalVisible, setPersonalItemModalVisible] = useState(false);
  const [editingPersonalEvent, setEditingPersonalEvent] = useState<ExternalEvent | null>(null);
  const [convertPrefill, setConvertPrefill] = useState<{
    title: string;
    startDate: Date;
    endDate: Date;
    isAllDay: boolean;
    location?: string;
    description?: string;
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
  // MonthGrid reports whichever month the user has actually scrolled to
  // (see onVisibleMonthChange below) - visibleMonth just holds that latest
  // report, it's not something changeMonth sets directly the way it used
  // to when Month paged one at a time via a swipeable <Calendar>.
  const monthGridRef = useRef<MonthGridHandle>(null);
  const changeMonth = (delta: number) => {
    monthGridRef.current?.scrollByMonths(delta);
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
  // Shared by the header's Week toggle and tapping a day in Month view -
  // switching viewMode remounts WeekGrid fresh (see the Month/Week ternary
  // below), which is what makes this anchor actually take effect via
  // WeekGrid's own mount-effect initial-scroll positioning.
  const goToWeekFor = (anchor: Date) => {
    const anchorWeekStart = startOfWeek(anchor);
    setVisibleWeekStart(anchorWeekStart);
    setWeekGridAnchor(anchorWeekStart);
    setViewMode("week");
  };
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
    goToWeekFor(anchor);
  };
  // Consolidates what used to be four independent (and only partially
  // mutually-exclusive) booleans into one single-select filter - see
  // components/FilterMenu.tsx for why that's the right model here.
  const [activeFilter, setActiveFilter] = useState<HomeFilter>(null);
  const showDraftsOnly = activeFilter === 'drafts';
  const showDeclinedOnly = activeFilter === 'declined';
  const showHiddenOnly = activeFilter === 'hidden';
  const showPingsOnly = activeFilter === 'pingsOnly';
  const showImportantOnly = activeFilter === 'important';
  const [hiddenEventIds, setHiddenEventIds] = useState<Set<string>>(new Set());
  const [importantItemIds, setImportantItemIds] = useState<Set<string>>(new Set());
  const [myRsvpByEvent, setMyRsvpByEvent] = useState<Record<string, string>>({});
  const [externalEvents, setExternalEvents] = useState<ExternalEvent[]>([]);
  const [calendarPermission, setCalendarPermission] = useState<CalendarPermissionStatus | null>(null);
  // Separate from calendarPermission on purpose - iOS grants calendar
  // access to the app+device pairing, not to whichever Ping account is
  // signed in, so a second account signing in on an already-permitted
  // phone would otherwise see calendarPermission as "granted" and start
  // syncing the real device calendar immediately, with no chance to
  // consent as that account. null means not loaded yet (never sync while
  // still unknown - see the gated effects below).
  const [calendarSyncEnabled, setCalendarSyncEnabled] = useState<boolean | null>(null);

  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedGroupName, setSelectedGroupName] = useState<string | null>(
    null,
  );
  const [groupChatVisible, setGroupChatVisible] = useState(false);

  // Only Week mode's own drag-to-expand-hours gesture needs this now -
  // Month view is a plain scrolling page (see the viewMode==='month' JSX
  // branch below), so it no longer needs any measured height at all. Week's
  // sizing is deliberately independent of Month's own calendar height (see
  // weekGridBaseHeight below) - it used to reuse the Month grid's measured
  // height as a stand-in "reasonable panel size," which broke once Month's
  // grid became legitimately tall (event bars) for reasons that have
  // nothing to do with how many hours of a day is a sane default to show.
  const [totalHeight, setTotalHeight] = useState<number | null>(null);
  const totalMeasuredRef = useRef(false);

  const dragY = useSharedValue(0);
  const dragStart = useSharedValue(0);

  const {
    notifications,
    unreadCount,
    refresh: refreshNotifications,
    pendingEventModal,
    clearEventModal,
    pendingGroupChat,
    clearGroupChat,
  } = useNotificationsContext();

  // Which events have an unread chat notification right now - drives the
  // red dot on EventCard's chat icon. MessageThread marks the underlying
  // notification read as soon as its event's messages are actually viewed
  // (by any path - this icon, a swipe, a push tap), and that update flows
  // back into `notifications` via useNotifications' own realtime
  // subscription, so this recomputes on its own with no extra wiring here.
  const unreadMessageEventIds = useMemo(
    () => new Set(notifications.filter((n) => n.type === 'message' && n.event_id && !n.read_at).map((n) => n.event_id!)),
    [notifications]
  );

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

  // Wide enough to cover anything the Upcoming list's own month/day
  // scoping might show - the memo below does the actual narrowing, same
  // as how externalEvents is fetched broadly and filtered per-view.
  const fetchInterested = useCallback(async () => {
    const rangeStart = new Date();
    const rangeEnd = new Date();
    rangeEnd.setDate(rangeEnd.getDate() + 90);
    setInterestedActivities(await fetchInterestedActivities(rangeStart, rangeEnd));
  }, []);

  useEffect(() => {
    fetchInterested();
  }, [fetchInterested]);

  // Refetch on return to Home - starring/unstarring happens on the
  // Discover screen, so without this, coming back wouldn't reflect a
  // change made there until some unrelated refresh happened to fire.
  useFocusEffect(
    useCallback(() => {
      fetchInterested();
    }, [fetchInterested]),
  );

  const handleUnstarInterested = async (activity: InterestedActivity) => {
    setInterestedActivities((prev) => prev.filter((a) => a.activityKey !== activity.activityKey));
    await removeInterestByKey(activity.activityKey);
  };

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
      if (status === "granted" && calendarSyncEnabled) fetchExternalEvents();
    });
  }, [fetchExternalEvents, calendarSyncEnabled]);

  // Per-account opt-in (see calendarSyncEnabled above) - loaded once per
  // signed-in user, separately from the device-level OS permission check.
  useEffect(() => {
    if (!session?.user?.id) return;
    supabase
      .from("profiles")
      .select("calendar_sync_enabled")
      .eq("id", session.user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) console.error("Error loading calendar sync preference:", error);
        setCalendarSyncEnabled(!!data?.calendar_sync_enabled);
      });
  }, [session?.user?.id]);

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
      if (calendarPermission === "granted" && calendarSyncEnabled) fetchExternalEvents();
    }, [calendarPermission, calendarSyncEnabled, fetchExternalEvents]),
  );

  const handleEnableExternalCalendar = async () => {
    // Already granted at the OS level from a different account on this
    // same device - no native dialog to show, just record that this
    // account itself has now opted in too.
    const granted = calendarPermission === "granted" ? true : await requestCalendarAccess();
    setCalendarPermission(granted ? "granted" : "denied");
    if (granted && session?.user?.id) {
      const { error } = await supabase
        .from("profiles")
        .update({ calendar_sync_enabled: true })
        .eq("id", session.user.id);
      if (error) console.error("Error saving calendar sync preference:", error);
      setCalendarSyncEnabled(true);
      await fetchExternalEvents();
    }
  };

  const handleDismissPhoneBanner = async () => {
    setPhoneBannerDismissed(true);
    if (session?.user?.id) await dismissProfilePrompt(session.user.id);
  };

  useEffect(() => {
    getHiddenEventIds().then(setHiddenEventIds);
    refreshImportantItemIds();
  }, []);

  const refreshImportantItemIds = () => {
    getAllImportantItemIds().then(setImportantItemIds);
  };

  const handleHideEvent = async (eventId: string) => {
    setHiddenEventIds(await hideEvent(eventId));
  };

  const handleUnhideEvent = async (eventId: string) => {
    const next = await unhideEvent(eventId);
    setHiddenEventIds(next);
    // Nothing left to review - drop back to the normal Upcoming view
    // instead of leaving the user stranded on an empty "Hidden" screen.
    if (next.size === 0) setActiveFilter((f) => (f === 'hidden' ? null : f));
  };

  const handleGroupChatClose = useCallback(() => {
    setGroupChatVisible(false);
  }, []);

  const handleConvertToPing = (event: ExternalEvent) => {
    setPersonalItemModalVisible(false);
    setEditingPersonalEvent(null);
    setConvertPrefill({
      title: event.title,
      startDate: new Date(event.startDate),
      endDate: new Date(event.endDate),
      isAllDay: event.allDay,
      description: event.details || undefined,
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

  // Long-pressing empty grid space in Week view (see WeekGrid's pill,
  // onEmptySlotLongPress) opens Add Personal Item directly - a quick
  // reminder for that exact day/time, not a menu of choices, since it can
  // always be converted to a real Ping afterward if it turns out to need
  // one (see AddPersonalItemModal's own onConvertToPing). createPrefillDate
  // takes priority over selectedDate (see the modal's initialDate prop
  // below) so this doesn't also change what the Upcoming list is filtered
  // to, the way tapping a day on the Month calendar does.
  const handleEmptySlotLongPress = (dayKey: string, minutes: number) => {
    setCreatePrefillDate(dayKey);
    setCreatePrefillMinutes(minutes);
    setPersonalItemModalVisible(true);
  };

  // Long-pressing a day's header cell in Week view (see WeekGrid's
  // onDateHeaderLongPress) hands off to the Explore tab scoped to that
  // whole day, not a specific free-time gap.
  const handleDateHeaderLongPress = (dayKey: string) => {
    router.push({ pathname: "/explore", params: { date: dayKey } });
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
  // virtualization, re-centering to avoid unbounded growth). Scrolling
  // past either edge just stops, an honest disclosed limit rather than a
  // silent bug. Centered-ish on weekGridAnchor, biased forward since
  // people look ahead more than back - specifically needs to cover at
  // least 6 months forward (a real user request: someone needed to plan
  // further out than Week view let them see) - 189 days ≈ 6.2 months,
  // with a bit of margin. removeClippedSubviews (below, on the actual
  // ScrollViews) is what keeps rendering ~210 non-virtualized day columns
  // from being a real performance concern - it lets the native side drop
  // the ones currently scrolled far off-screen instead of keeping all of
  // them fully mounted natively at once.
  const WEEK_GRID_DAY_COUNT = 210;
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

  // Used to also mark which days had a Ping (a circle/bar) or an external
  // item (a dot) - now that monthDayBars (below) renders every event as its
  // own titled colored bar via MonthDayCell, those would just double up
  // with the new bars, so this only carries the marks that are genuinely
  // independent of "does this day have an event": the tapped-day circle,
  // today's ring, and the "important" underline.
  const markedDates = useMemo(() => {
    const marks: Record<string, any> = {};
    // A personal item checked "Important" (AddPersonalItemModal) marks its
    // date on the month grid - additive on top of whatever that day already
    // has (the selected-day circle, today's ring below), never replacing
    // it. A plain boolean flag rather than a text-decoration style - a real
    // <View> bar (drawn by MonthDayCell, see `marking.important`) renders
    // far more reliably/visibly than CSS underline-on-a-number-glyph did.
    externalEvents.forEach((e) => {
      if (hiddenEventIds.has(e.id) || !importantItemIds.has(e.id)) return;
      const key = toDateKey(e.startDate);
      marks[key] = { ...(marks[key] || {}), important: true };
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
  }, [externalEvents, selectedDate, hiddenEventIds, importantItemIds]);

  // MonthGrid's pre-rendered month range - same fixed-window idea as
  // WeekGrid's own 56-day range (see that comment above), just months
  // instead of days: real added complexity (virtualization, re-centering)
  // not worth it for a calendar people mostly look at a handful of months
  // around now. Fixed once at mount (not state) - unlike Week, nothing
  // external ever needs to re-center this on a specific month.
  const MONTH_GRID_MONTHS_BACK = 3;
  const MONTH_GRID_MONTHS_FORWARD = 15;
  const MONTH_GRID_MONTH_COUNT = MONTH_GRID_MONTHS_BACK + MONTH_GRID_MONTHS_FORWARD + 1;
  const monthGridRangeStart = useMemo(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth() - MONTH_GRID_MONTHS_BACK, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const monthGridRangeEnd = useMemo(
    () => new Date(monthGridRangeStart.getFullYear(), monthGridRangeStart.getMonth() + MONTH_GRID_MONTH_COUNT, 1),
    [monthGridRangeStart],
  );
  // Per-day stacked event bars for Month view's cells (Apple-Calendar
  // style) - same declinedFilteredEvents/visibleExternalEvents pair Week's
  // own grid uses (see the comment above weekDayColumns), scoped to
  // MonthGrid's whole pre-rendered window rather than just one visible
  // month, since it's all real, simultaneously-mounted content now (no
  // more page-one-month-at-a-time swiping to re-trigger this).
  const monthDayBars = useMemo(
    () => buildMonthDayBars(monthGridRangeStart, monthGridRangeEnd, declinedFilteredEvents, visibleExternalEvents),
    [monthGridRangeStart, monthGridRangeEnd, declinedFilteredEvents, visibleExternalEvents],
  );
  const onVisibleMonthChange = (monthStart: Date) => setVisibleMonth(monthStart);

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
    | { kind: "external"; key: string; date: Date; event: ExternalEvent }
    | { kind: "interested"; key: string; date: Date; event: InterestedActivity };

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

    // Same standalone-view idea as Hidden - "important date" only ever
    // applies to a personal/synced calendar item (see AddPersonalItemModal's
    // checkbox), never a Ping, so there's nothing to mix in from pingItems.
    if (showImportantOnly) {
      return externalEvents
        .filter((e) => importantItemIds.has(e.id))
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
    // Same "hide it once it's over, but only in the default view" rule
    // visibleEvents applies to Pings above - external items never had this
    // check at all, which went unnoticed as long as the calendar-item fetch
    // itself only ever looked forward from right now (see
    // getUpcomingExternalEvents' old windowStart). Now that it also looks
    // back (so a same-day item doesn't vanish from the calendar the moment
    // its own time passes), a genuinely past item can appear in
    // externalEvents, and without this it would leak into the default
    // Upcoming view the same way.
    const dayFiltered = (
      selectedDate
        ? externalEvents.filter((e) => toDateKey(e.startDate) === selectedDate)
        : externalEvents
            .filter((e) => inVisibleMonth(e.startDate, null))
            .filter((e) => (e.endDate ?? e.startDate).getTime() >= now)
    )
      .filter((e) => !hiddenEventIds.has(e.id))
      .filter((e) => !externalItemDuplicatesPing(pingEntriesForDedup, { title: e.title, start: e.startDate }));

    const externalItems: UpcomingListItem[] = dayFiltered.map((e) => ({
      kind: "external",
      key: `ext-${e.id}`,
      date: e.startDate,
      event: e,
    }));

    const interestedFiltered = selectedDate
      ? interestedActivities.filter((a) => toDateKey(new Date(a.startsAt)) === selectedDate)
      : interestedActivities.filter((a) => inVisibleMonth(new Date(a.startsAt), null));

    const interestedItems: UpcomingListItem[] = interestedFiltered.map((a) => ({
      kind: "interested",
      key: `interest-${a.activityKey}`,
      date: new Date(a.startsAt),
      event: a,
    }));

    return [...pingItems, ...externalItems, ...interestedItems].sort(
      (a, b) => a.date.getTime() - b.date.getTime(),
    );
  }, [
    visibleEvents,
    showHiddenOnly,
    hiddenEventIds,
    showImportantOnly,
    importantItemIds,
    externalEvents,
    interestedActivities,
    selectedDate,
    showDraftsOnly,
    showDeclinedOnly,
    showPingsOnly,
    monthStart,
    monthEnd,
    now,
  ]);

  // Only Ping cards show weather (see EventCard) - external calendar rows
  // render as compact ExternalEventRow entries with no room for it. Keyed
  // on id+location+date rather than the whole item list, so switching
  // filters that don't change which Pings are visible (e.g. toggling
  // showHiddenOnly) doesn't trigger a redundant re-fetch.
  const pingWeatherKey = useMemo(
    () =>
      upcomingListItems
        .filter((item) => item.kind === "ping")
        .map((item) => `${item.event.id}|${item.event.location || ""}|${item.event.event_date}`)
        .join(","),
    [upcomingListItems],
  );

  useEffect(() => {
    const pingEvents = upcomingListItems
      .filter((item) => item.kind === "ping")
      .map((item) => item.event as PingEvent);
    if (pingEvents.length === 0) return;
    fetchWeatherForEvents(pingEvents).then((result) =>
      setWeatherByEventId((prev) => ({ ...prev, ...result })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pingWeatherKey]);

  const onDayPress = (dateKey: string) => {
    setSelectedDate((prev) => (prev === dateKey ? null : dateKey));
    // A day is easiest to actually look at in Week view - Month is for
    // orientation/picking a day, not reading it in detail.
    const [y, m, d] = dateKey.split("-").map(Number);
    goToWeekFor(new Date(y, m - 1, d));
  };

  const handleRefresh = useCallback(async () => {
    await fetchEvents();
    if (calendarPermission === "granted" && calendarSyncEnabled) await fetchExternalEvents();
  }, [fetchEvents, calendarPermission, calendarSyncEnabled, fetchExternalEvents]);

  const handleDetailClose = useCallback(async () => {
    setDetailVisible(false);
    await fetchEvents();
  }, [fetchEvents]);

  const ready = totalHeight !== null;
  // Week and Month modes each have their own drag-to-expand sizing, fully
  // independent of each other - they used to share one set of numbers
  // derived from <Calendar>'s measured height, which broke once Month's
  // calendar genuinely got taller (event bars) for reasons that have
  // nothing to do with how many hours of a day, or how many weeks of a
  // month, is a sane default to show. Both are based on totalHeight (this
  // screen's whole content area) instead: a fixed default size, then
  // however much room is left before crowding the FAB.
  const WEEK_DEFAULT_HOURS = 6;
  const weekGridBaseHeight = WEEK_DEFAULT_HOURS * 60;
  const weekBottomLimit = ready
    ? Math.max(0, totalHeight! - MIN_TOP_INSET - weekGridBaseHeight - FAB_CLEARANCE)
    : 0;
  const weekGridMaxHeight = weekGridBaseHeight + weekBottomLimit;
  // Resting (dragY=0) height is boosted by this much over the bare
  // default - showing only the default with no boost was too little to be
  // useful without dragging every time. Capped to the mode's own
  // bottomLimit so it never asks for more than that ceiling allows.
  const weekDefaultExpansion = Math.min(280, weekBottomLimit);

  // Month's default (collapsed) height: the weekday-letter row + one
  // month's own label row + MONTH_DEFAULT_ROWS of day cells - computed
  // analytically (MonthGrid never needs to measure anything, see that
  // component's own header comment), roughly half a typical month.
  const MONTH_DEFAULT_ROWS = 3;
  const monthGridBaseHeight = WEEKDAY_HEADER_HEIGHT + MONTH_LABEL_HEIGHT + MONTH_DEFAULT_ROWS * CELL_HEIGHT;
  const monthBottomLimit = ready
    ? Math.max(0, totalHeight! - MIN_TOP_INSET - monthGridBaseHeight - FAB_CLEARANCE)
    : 0;
  const monthGridMaxHeight = monthGridBaseHeight + monthBottomLimit;
  const monthDefaultExpansion = Math.min(280, monthBottomLimit);

  const gridBaseHeight = viewMode === "week" ? weekGridBaseHeight : monthGridBaseHeight;
  const gridBottomLimit = viewMode === "week" ? weekBottomLimit : monthBottomLimit;
  const topLimit = ready ? -gridBaseHeight : 0;

  const handleContentLayout = (e: LayoutChangeEvent) => {
    if (totalMeasuredRef.current) return;
    totalMeasuredRef.current = true;
    setTotalHeight(e.nativeEvent.layout.height);
  };

  const pan = Gesture.Pan()
    .enabled(ready)
    .onBegin(() => {
      dragStart.value = dragY.value;
    })
    .onUpdate((e) => {
      const next = dragStart.value + e.translationY;
      dragY.value = Math.min(gridBottomLimit, Math.max(topLimit, next));
    })
    .onEnd(() => {
      // Snap purely by physical nearest-point — no velocity involved.
      // Velocity-based projection (even capped/direction-gated) kept
      // overshooting straight past the intended target to whichever
      // endpoint matched the direction of motion, regardless of how close
      // the actual release position was to a nearer point.
      const points = [topLimit, 0, gridBottomLimit];
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

  // A guaranteed, tap-based way to snap the drag sheet back to rest (the
  // grid back to its default height, in whichever mode is active) -
  // doesn't depend on successfully grabbing and dragging the handle, which
  // has historically been the most fragile part of this screen.
  const collapseCalendar = () => {
    if (!ready) return;
    dragY.value = withSpring(0, SPRING_CONFIG);
  };

  // Cards sheet: top edge rises to cover the calendar, bottom edge always
  // pinned to the true screen bottom. Animating `top` (not a translateY
  // transform) so the box's real height always matches what's actually
  // visible — a transform only repaints the box shifted, it doesn't
  // resize it, so the FlatList inside kept thinking it had more room than
  // was actually on-screen and would scroll its last item into a clipped,
  // invisible strip past the true bottom edge. Same curve shape for both
  // modes - only which grid's own base/bottomLimit/defaultExpansion feeds
  // it differs.
  const animatedCardsSheetStyle = useAnimatedStyle(() => {
    const calBottom = MIN_TOP_INSET + gridBaseHeight;
    const bottomLimit = viewMode === "week" ? weekBottomLimit : monthBottomLimit;
    const defaultExpansion = viewMode === "week" ? weekDefaultExpansion : monthDefaultExpansion;
    // Downward drag grows the grid behind it (see weekGridMaxHeight /
    // monthGridMaxHeight) - Upcoming stays fully visible and just gets
    // pushed down to stay flush against the growing calendar. The rest
    // position (dragY=0) is itself boosted by defaultExpansion so the
    // default view opens already showing more than the bare minimum,
    // without giving up the topLimit/bottomLimit endpoints - only the
    // 0→bottomLimit segment's slope compresses slightly to make room for
    // that boosted starting point.
    if (bottomLimit <= 0) {
      return { opacity: 1, top: interpolate(dragY.value, [topLimit, 0], [MIN_TOP_INSET, calBottom], Extrapolation.CLAMP) };
    }
    return {
      opacity: 1,
      top: interpolate(
        dragY.value,
        [topLimit, 0, bottomLimit],
        [MIN_TOP_INSET, calBottom + defaultExpansion, calBottom + bottomLimit],
        Extrapolation.CLAMP,
      ),
    };
  });

  // The handle itself: tracks the exact same curve as
  // animatedCardsSheetStyle's `top`, so it always sits flush with the
  // sheet's actual top edge.
  const animatedHandleStyle = useAnimatedStyle(() => {
    const calBottom = MIN_TOP_INSET + gridBaseHeight;
    const bottomLimit = viewMode === "week" ? weekBottomLimit : monthBottomLimit;
    const defaultExpansion = viewMode === "week" ? weekDefaultExpansion : monthDefaultExpansion;
    if (bottomLimit <= 0) {
      return { transform: [{ translateY: interpolate(dragY.value, [topLimit, 0], [MIN_TOP_INSET, calBottom], Extrapolation.CLAMP) }] };
    }
    return {
      transform: [
        {
          translateY: interpolate(
            dragY.value,
            [topLimit, 0, bottomLimit],
            [MIN_TOP_INSET, calBottom + defaultExpansion, calBottom + bottomLimit],
            Extrapolation.CLAMP,
          ),
        },
      ],
    };
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
              : showImportantOnly
                ? "Important Dates"
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
        <FilterMenu
          active={activeFilter}
          onSelect={(filter) => {
            setActiveFilter(filter);
            // Any of these filters is about the Upcoming list - picking one
            // backs the calendar out of its expanded state first, so the
            // filtered list is actually visible.
            collapseCalendar();
          }}
          hasHidden={hiddenEventIds.size > 0}
          hasImportant={importantItemIds.size > 0}
        />
      </View>
    </View>
  );

  const emptyText = showHiddenOnly
    ? "Nothing hidden."
    : showDraftsOnly
      ? "No drafts right now."
      : showDeclinedOnly
        ? "No declined events."
        : showImportantOnly
          ? "No important dates marked yet."
          : selectedDate
            ? "No events on this day."
            : "No events yet — tap + to create one.";

  // Shared by both Month's (plain-scroll) and Week's (drag-sheet) FlatList
  // - the two views wrap this list very differently, but what's actually
  // inside it is identical either way.
  type UpcomingItem = (typeof upcomingListItems)[number];
  const renderUpcomingItem = ({ item }: { item: UpcomingItem }) =>
    item.kind === "ping" ? (
      <EventCard
        event={item.event}
        highlight={item.event.id === justCreatedId}
        onPress={openEvent}
        rsvpStatus={myRsvpByEvent[item.event.id] as any}
        weather={weatherByEventId[item.event.id]}
        onPressChat={(e) => openEvent(e, { startOnMessages: true })}
        hasUnreadMessages={unreadMessageEventIds.has(item.event.id)}
      />
    ) : item.kind === "interested" ? (
      <InterestedActivityCard
        activity={item.event}
        onPress={() =>
          router.push({
            pathname: "/explore",
            params: { date: toDateKey(item.date), activityKey: item.event.activityKey },
          })
        }
        onUnstar={handleUnstarInterested}
      />
    ) : showHiddenOnly ? (
      <ExternalEventRow event={item.event} onUnhide={() => handleUnhideEvent(item.event.id)} />
    ) : (
      <ExternalEventRow
        event={item.event}
        onEdit={item.event.editable ? () => setEditingPersonalEvent(item.event) : undefined}
        onHide={() => handleHideEvent(item.event.id)}
      />
    );
  const upcomingEmptyComponent = !loading ? <Text style={styles.emptyText}>{emptyText}</Text> : null;

  const upcomingBanners = (
    <>
      {eventsLoadError && (
        <TouchableOpacity style={styles.errorPromptRow} onPress={() => fetchEvents()}>
          <Text style={styles.errorPromptText}>⚠️ Couldn't load your Pings — tap to retry</Text>
        </TouchableOpacity>
      )}
      {(calendarPermission === "undetermined" ||
        (calendarPermission === "granted" && calendarSyncEnabled === false)) &&
        !showDraftsOnly &&
        !showDeclinedOnly && (
          <TouchableOpacity style={styles.calendarPromptRow} onPress={handleEnableExternalCalendar}>
            <Text style={styles.calendarPromptText}>📅 Show your phone calendar here too</Text>
          </TouchableOpacity>
        )}
      {shouldPromptPhone && !phoneBannerDismissed && !showDraftsOnly && !showDeclinedOnly && !showHiddenOnly && (
        <View style={styles.calendarPromptRow}>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => router.push("/settings")}>
            <Text style={styles.calendarPromptText}>📱 Add your phone number so people can find and invite you</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleDismissPhoneBanner} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.phonePromptDismiss}>✕</Text>
          </TouchableOpacity>
        </View>
      )}
    </>
  );

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <PingLogoMenu
          hasNotifications={unreadCount > 0}
          onCreatePing={() => setModalVisible(true)}
        />
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={() => setModalVisible(true)}>
            <Text style={styles.createText}>Create</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push("/groups")}>
            <Text style={styles.groupsText}>Groups</Text>
          </TouchableOpacity>
          <ProfileMenu />
        </View>
      </View>

      <View style={styles.contentArea} onLayout={handleContentLayout}>
        <View style={styles.calendarWrapper}>
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
            <MonthGrid
              ref={monthGridRef}
              rangeStart={monthGridRangeStart}
              monthCount={MONTH_GRID_MONTH_COUNT}
              initialMonthIndex={MONTH_GRID_MONTHS_BACK}
              markedDatesByDay={markedDates}
              monthDayBars={monthDayBars}
              onDayPress={onDayPress}
              onVisibleMonthChange={onVisibleMonthChange}
              height={monthGridMaxHeight}
              dragY={dragY}
              visibleHeight={monthGridBaseHeight}
              maxExtraHeight={monthBottomLimit}
              defaultExpansion={monthDefaultExpansion}
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
              onEmptySlotLongPress={handleEmptySlotLongPress}
              onDateHeaderLongPress={handleDateHeaderLongPress}
              dragY={dragY}
              visibleHeight={weekGridBaseHeight}
              maxExtraHeight={weekBottomLimit}
              defaultExpansion={weekDefaultExpansion}
            />
          )}
        </View>

        <Animated.View style={[styles.cardsSheet, ready && animatedCardsSheetStyle]}>
          <View style={styles.handleSpacer} />
          {renderListHeader("Upcoming")}
          {upcomingBanners}
          <FlatList
            style={{ flex: 1 }}
            data={upcomingListItems}
            keyExtractor={(item) => item.key}
            extraData={myRsvpByEvent}
            refreshControl={<RefreshControl refreshing={loading} onRefresh={handleRefresh} tintColor={colors.primary} />}
            renderItem={renderUpcomingItem}
            ListEmptyComponent={upcomingEmptyComponent}
            contentContainerStyle={{ paddingVertical: 12, paddingBottom: 120 }}
          />
        </Animated.View>

        <Animated.View style={[styles.handleWrap, ready && animatedHandleStyle]}>
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
          setCreatePrefillDate(null);
        }}
        onCreated={(status) => {
          setCreatePrefillDate(null);
          handleCreated(status);
        }}
        initialDate={createPrefillDate ?? selectedDate}
        prefill={convertPrefill}
      />

      <AddPersonalItemModal
        visible={personalItemModalVisible || !!editingPersonalEvent}
        editingEvent={editingPersonalEvent}
        initialDate={createPrefillDate ?? selectedDate}
        initialMinutes={editingPersonalEvent ? null : createPrefillMinutes}
        onClose={() => {
          setPersonalItemModalVisible(false);
          setEditingPersonalEvent(null);
          setCreatePrefillDate(null);
          setCreatePrefillMinutes(null);
        }}
        onSaved={async () => {
          setPersonalItemModalVisible(false);
          setEditingPersonalEvent(null);
          setCreatePrefillDate(null);
          setCreatePrefillMinutes(null);
          setCalendarPermission("granted");
          await fetchExternalEvents();
          refreshImportantItemIds();
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
        onCreatePing={(prefill) => {
          // Nothing was written to the personal calendar for this row -
          // just close the review sheet and open the same Ping-creation
          // flow AddPersonalItemModal's "Convert to Ping" uses, prefilled
          // straight from the scanned row instead of an already-saved
          // calendar event.
          setScheduleReviewEvents(null);
          setConvertPrefill(prefill);
          setConvertSource(null);
          setModalVisible(true);
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
  groupsText: { color: colors.primary, fontSize: 14, fontWeight: "600" },
  contentArea: { flex: 1, position: "relative", overflow: "hidden" },
  calendarWrapper: {},
  // Fixed to MIN_TOP_INSET so it's exactly the height that stays visible
  // when the Upcoming sheet is dragged all the way up, in both modes - see
  // the note on MIN_TOP_INSET above.
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
  // The floating handle: one persistent element positioned independently of
  // the calendar/Upcoming sheet beneath it, so the gesture stays bound to
  // the same view throughout the whole drag.
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
  listHeaderActions: { flexDirection: "row", gap: 16, alignItems: "center" },
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
