import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, ActivityIndicator, RefreshControl } from 'react-native';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { colors } from '../lib/theme';
import { useAuth } from '../lib/AuthContext';
import { useLatestMessages } from '../lib/useLatestMessages';
import { useLatestGroupMessages } from '../lib/useLatestGroupMessages';
import CompactEventRow from '../components/CompactEventRow';
import CompactGroupRow, { PingGroup } from '../components/CompactGroupRow';
import { PingEvent } from '../components/EventCard';
import EventDetailModal from '../components/EventDetailModal';
import GroupChatModal from '../components/GroupChatModal';
import { supabase } from '../supabase';

// The Message Board used to live inline on Home, revealed by dragging the
// calendar sheet down - that drag range now belongs to Month view's own
// pull-down-to-reveal-the-rest-of-the-month gesture (see app/(tabs)/
// index.tsx), so this is its own routed screen instead, reached only from
// PingLogoMenu's "Messages" item. Mirrors app/notifications.tsx's shape:
// owns its own data fetching rather than depending on Home's internal
// state, and hands event/group taps off to the same global
// pendingEventModal/pendingGroupChat mechanism Home already watches.
export default function MessagesScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const { latestByEvent, fetchLatestFor, refresh: refreshLatestMessages } = useLatestMessages(session?.user?.id);
  const { latestByGroup, fetchLatestFor: fetchLatestGroupFor, refresh: refreshLatestGroupMessages } =
    useLatestGroupMessages(session?.user?.id);

  const [boardView, setBoardView] = useState<'events' | 'groups'>('events');
  const [events, setEvents] = useState<PingEvent[]>([]);
  const [groups, setGroups] = useState<PingGroup[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [loadingGroups, setLoadingGroups] = useState(true);
  // Opened locally, the same way app/groups/[id].tsx already handles its
  // own event cards, rather than through Home's pendingEventModal/
  // pendingGroupChat mechanism - this screen deliberately stays on the nav
  // stack underneath the modal (see openEvent/openGroup below) instead of
  // dismissing to Home, and relying on a Tab screen that isn't currently
  // focused to notice a context change and render its own <Modal> turned
  // out not to be reliable (a real reported bug: tapping a conversation row
  // did nothing). Owning the modal here directly sidesteps that entirely.
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedGroupName, setSelectedGroupName] = useState<string | null>(null);
  const [groupChatVisible, setGroupChatVisible] = useState(false);

  // Same visibility rule as Home's fetchEvents: you see an event only if
  // you have an invitee row for it (hosting auto-creates one), and a
  // declined event drops out of the default view the same way it does on
  // Home's Upcoming list.
  const fetchEvents = useCallback(async () => {
    if (!session?.user?.id) return;
    const { data: myInvites, error: inviteError } = await supabase
      .from('invitees')
      .select('event_id, rsvp_status')
      .eq('user_id', session.user.id);
    if (inviteError) {
      console.error('Error fetching invited events:', inviteError);
      return;
    }
    const rsvpByEvent: Record<string, string> = {};
    (myInvites || []).forEach((i) => {
      if (i.event_id) rsvpByEvent[i.event_id] = i.rsvp_status;
    });
    const invitedEventIds = Array.from(new Set((myInvites || []).map((i) => i.event_id)));
    if (invitedEventIds.length === 0) {
      setEvents([]);
      return;
    }
    const { data, error } = await supabase.from('events').select('*').in('id', invitedEventIds);
    if (error) {
      console.error('Error fetching events:', error);
      return;
    }
    setEvents((data as PingEvent[]).filter((e) => rsvpByEvent[e.id] !== 'declined'));
  }, [session?.user?.id]);

  // Groups I'm in = groups I own, union groups I'm a resolved member of -
  // same query Home's fetchGroups uses.
  const fetchGroups = useCallback(async () => {
    if (!session?.user?.id) return;
    const uid = session.user.id;
    const [{ data: owned, error: ownedError }, { data: memberOf, error: memberError }] = await Promise.all([
      supabase.from('groups').select('id, name').eq('owner_id', uid),
      supabase.from('group_members').select('group_id, groups(id, name)').eq('user_id', uid),
    ]);
    if (ownedError) console.error('Error fetching owned groups:', ownedError);
    if (memberError) console.error('Error fetching member groups:', memberError);
    const byId = new Map<string, PingGroup>();
    (owned || []).forEach((g: any) => byId.set(g.id, { id: g.id, name: g.name }));
    (memberOf || []).forEach((m: any) => {
      if (m.groups) byId.set(m.groups.id, { id: m.groups.id, name: m.groups.name });
    });
    setGroups(Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name)));
  }, [session?.user?.id]);

  useFocusEffect(
    useCallback(() => {
      fetchEvents().finally(() => setLoadingEvents(false));
      fetchGroups().finally(() => setLoadingGroups(false));
    }, [fetchEvents, fetchGroups])
  );

  // Reads like a texting app's conversation list - most recently active
  // thread first, not soonest-upcoming first (matches the old inline
  // Message Board exactly).
  const sortedEvents = [...events].sort((a, b) => {
    const aTime = latestByEvent[a.id]?.createdAt;
    const bTime = latestByEvent[b.id]?.createdAt;
    if (aTime && bTime) return new Date(bTime).getTime() - new Date(aTime).getTime();
    if (aTime) return -1;
    if (bTime) return 1;
    return new Date(a.event_date).getTime() - new Date(b.event_date).getTime();
  });
  const sortedGroups = [...groups].sort((a, b) => {
    const aTime = latestByGroup[a.id]?.createdAt;
    const bTime = latestByGroup[b.id]?.createdAt;
    if (aTime && bTime) return new Date(bTime).getTime() - new Date(aTime).getTime();
    if (aTime) return -1;
    if (bTime) return 1;
    return 0;
  });

  useEffect(() => {
    if (boardView === 'events' && events.length > 0) fetchLatestFor(events.map((e) => e.id));
  }, [boardView, events, fetchLatestFor]);

  useEffect(() => {
    if (boardView === 'groups' && groups.length > 0) fetchLatestGroupFor(groups.map((g) => g.id));
  }, [boardView, groups, fetchLatestGroupFor]);

  // Opens straight onto the messages face - reading a conversation is the
  // whole point of tapping a row here. Kept entirely local to this screen
  // (not routed through Home) so "back" naturally lands on Messages: this
  // screen never navigates away, so there's nothing to dismiss to.
  const openEvent = (event: PingEvent) => {
    setSelectedEventId(event.id);
    setDetailVisible(true);
  };

  const openGroup = (group: PingGroup) => {
    setSelectedGroupId(group.id);
    setSelectedGroupName(group.name);
    setGroupChatVisible(true);
  };

  const handleRefresh = async () => {
    if (boardView === 'groups') {
      await fetchGroups();
      if (groups.length > 0) await refreshLatestGroupMessages(groups.map((g) => g.id));
    } else {
      await fetchEvents();
      if (events.length > 0) await refreshLatestMessages(events.map((e) => e.id));
    }
  };

  const loading = boardView === 'groups' ? loadingGroups : loadingEvents;

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.pageTitle}>Messages</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.toggleRow}>
        <TouchableOpacity onPress={() => setBoardView('events')}>
          <Text style={[styles.toggleText, boardView === 'events' && styles.toggleTextActive]}>Events</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setBoardView('groups')}>
          <Text style={[styles.toggleText, boardView === 'groups' && styles.toggleTextActive]}>Groups</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : boardView === 'events' ? (
        <FlatList
          data={sortedEvents}
          keyExtractor={(item) => item.id}
          extraData={latestByEvent}
          refreshControl={<RefreshControl refreshing={false} onRefresh={handleRefresh} tintColor={colors.primary} />}
          renderItem={({ item }) => (
            <CompactEventRow event={item} snippet={latestByEvent[item.id]} onPress={openEvent} />
          )}
          ListEmptyComponent={<Text style={styles.emptyText}>No events yet.</Text>}
        />
      ) : (
        <FlatList
          data={sortedGroups}
          keyExtractor={(item) => item.id}
          extraData={latestByGroup}
          refreshControl={<RefreshControl refreshing={false} onRefresh={handleRefresh} tintColor={colors.primary} />}
          renderItem={({ item }) => (
            <CompactGroupRow group={item} snippet={latestByGroup[item.id]} onPress={openGroup} />
          )}
          ListEmptyComponent={<Text style={styles.emptyText}>No groups yet — create one from the Groups screen.</Text>}
        />
      )}

      <EventDetailModal
        visible={detailVisible}
        eventId={selectedEventId}
        startOnMessages
        onClose={() => setDetailVisible(false)}
      />

      <GroupChatModal
        visible={groupChatVisible}
        groupId={selectedGroupId}
        groupName={selectedGroupName}
        onClose={() => setGroupChatVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingTop: 60 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
    paddingHorizontal: 20,
  },
  backText: { color: colors.primary, fontSize: 16, fontWeight: '600' },
  pageTitle: { color: colors.textPrimary, fontSize: 18, fontWeight: '700' },
  toggleRow: { flexDirection: 'row', gap: 16, paddingHorizontal: 20, marginBottom: 8 },
  toggleText: { color: colors.textSecondary, fontSize: 14, fontWeight: '600' },
  toggleTextActive: { color: colors.primary },
  emptyText: { color: colors.textMuted, textAlign: 'center', marginTop: 40, fontSize: 15 },
});
