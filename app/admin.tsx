import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator, Alert, RefreshControl } from 'react-native';
import { useRouter, useFocusEffect, Stack } from 'expo-router';
import { supabase } from '../supabase';
import { colors } from '../lib/theme';
import { displayName } from '../lib/displayName';
import { useNotificationsContext } from '../lib/NotificationsContext';

type Report = {
  id: string;
  content_type: 'event' | 'message' | 'group_message' | 'block';
  content_id: string | null;
  event_id: string | null;
  group_id: string | null;
  reported_user_id: string | null;
  reason: string;
  source: 'user' | 'auto_filter' | 'block';
  created_at: string;
  reporter: { full_name: string | null; email: string | null } | null;
  reported: { full_name: string | null; email: string | null } | null;
  group: { name: string | null } | null;
};

// Only reachable from Settings when the signed-in profile has is_admin
// true (see app/settings.tsx) - this is where Apple's Guideline 1.2
// review's "act within 24 hours" requirement actually gets exercised,
// rather than being a promise with no real capability behind it. Every
// report that lands here already triggered a push via lib/moderation.ts.
export default function AdminScreen() {
  const router = useRouter();
  const { openEventModal, openGroupChat } = useNotificationsContext();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [reports, setReports] = useState<Report[]>([]);

  const fetchReports = useCallback(async () => {
    const { data, error } = await supabase
      .from('reports')
      .select(
        'id, content_type, content_id, event_id, group_id, reported_user_id, reason, source, created_at, reporter:reporter_id(full_name, email), reported:reported_user_id(full_name, email), group:group_id(name)'
      )
      .eq('status', 'open')
      .order('created_at', { ascending: false });
    if (error) console.error('Error fetching reports:', error);
    setReports((data as any) || []);
    setLoading(false);
  }, []);

  // A plain useEffect only ever fetched once, on this screen's very first
  // mount - reopening Admin later (e.g. from a report notification, after
  // the first visit happened to be before any reports existed) kept
  // showing that same stale snapshot forever, since nothing told it to
  // fetch again. useFocusEffect (same pattern as app/notifications.tsx)
  // refetches every time the screen is actually navigated to.
  useFocusEffect(
    useCallback(() => {
      fetchReports();
    }, [fetchReports])
  );

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchReports();
    setRefreshing(false);
  };

  const resolve = async (id: string, status: 'dismissed' | 'removed' | 'user_banned') => {
    const { error } = await supabase
      .from('reports')
      .update({ status, resolved_at: new Date().toISOString() })
      .eq('id', id);
    if (error) {
      console.error('Error resolving report:', error);
      Alert.alert('Error', 'Could not update this report.');
      return;
    }
    setReports((prev) => prev.filter((r) => r.id !== id));
  };

  // "Golf ACC: inappropriate content" with no way to actually look at the
  // event/message being reported left the admin unable to make an informed
  // Dismiss/Remove/Ban call - this reuses the same in-app viewers the rest
  // of the app already opens notifications into (EventDetailContent's
  // flip-card modal, group chat) rather than building a second one.
  const canView = (report: Report) =>
    (report.content_type === 'event' || report.content_type === 'message') && !!report.event_id
      ? true
      : report.content_type === 'group_message' && !!report.group_id;

  const handleViewContent = (report: Report) => {
    if (report.content_type === 'event' && report.event_id) {
      openEventModal(report.event_id);
    } else if (report.content_type === 'message' && report.event_id) {
      openEventModal(report.event_id, true);
    } else if (report.content_type === 'group_message' && report.group_id) {
      openGroupChat(report.group_id, report.group?.name ?? undefined);
    } else {
      return;
    }
    if (router.canDismiss()) router.dismissTo('/');
  };

  const handleDismiss = (report: Report) => resolve(report.id, 'dismissed');

  const handleRemoveContent = (report: Report) => {
    Alert.alert('Remove this content?', 'This deletes the reported event or message.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          if (!report.content_id) return;
          const table = report.content_type === 'event' ? 'events' : report.content_type === 'message' ? 'messages' : 'group_messages';
          if (report.content_type !== 'block') {
            const { error } = await supabase.from(table).delete().eq('id', report.content_id);
            if (error) console.error(`Error deleting ${table} row:`, error);
          }
          await resolve(report.id, 'removed');
        },
      },
    ]);
  };

  const handleBanUser = (report: Report) => {
    const name = displayName(report.reported, 'this user');
    Alert.alert(`Ban ${name}?`, 'They will be signed out and unable to use Ping until unbanned.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Ban',
        style: 'destructive',
        onPress: async () => {
          if (!report.reported_user_id) return;
          const { error } = await supabase
            .from('profiles')
            .update({ banned_at: new Date().toISOString() })
            .eq('id', report.reported_user_id);
          if (error) console.error('Error banning user:', error);
          await resolve(report.id, 'user_banned');
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.pageTitle}>Reports</Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.primary} />}
      >
        {reports.length === 0 ? (
          <Text style={styles.emptyText}>No open reports.</Text>
        ) : (
          reports.map((report) => (
            <View key={report.id} style={styles.card}>
              <TouchableOpacity
                activeOpacity={canView(report) ? 0.6 : 1}
                disabled={!canView(report)}
                onPress={() => handleViewContent(report)}
              >
                <Text style={styles.reason}>{report.reason}</Text>
                <Text style={styles.meta}>
                  {report.source === 'auto_filter' ? 'Auto-flagged' : report.source === 'block' ? 'From a block' : 'User report'}
                  {' · '}
                  {report.content_type}
                  {' · '}
                  {new Date(report.created_at).toLocaleString()}
                </Text>
                {!!report.reporter && <Text style={styles.meta}>Reported by: {displayName(report.reporter)}</Text>}
                {!!report.reported && <Text style={styles.meta}>About: {displayName(report.reported)}</Text>}
                {canView(report) && <Text style={styles.viewLink}>View content ›</Text>}
              </TouchableOpacity>

              <View style={styles.actionsRow}>
                <TouchableOpacity style={styles.actionButton} onPress={() => handleDismiss(report)}>
                  <Text style={styles.actionText}>Dismiss</Text>
                </TouchableOpacity>
                {report.content_type !== 'block' && (
                  <TouchableOpacity style={styles.actionButton} onPress={() => handleRemoveContent(report)}>
                    <Text style={styles.actionText}>Remove Content</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={styles.actionButton} onPress={() => handleBanUser(report)}>
                  <Text style={[styles.actionText, styles.banText]}>Ban User</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingTop: 60, paddingHorizontal: 20 },
  centered: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  backText: { color: colors.primary, fontSize: 16, fontWeight: '600' },
  pageTitle: { color: colors.textPrimary, fontSize: 18, fontWeight: '700' },
  emptyText: { color: colors.textMuted, textAlign: 'center', marginTop: 40, fontSize: 15 },
  card: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  reason: { color: colors.textPrimary, fontSize: 15, fontWeight: '600', marginBottom: 4 },
  meta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  viewLink: { color: colors.primary, fontSize: 13, fontWeight: '600', marginTop: 8 },
  actionsRow: { flexDirection: 'row', gap: 16, marginTop: 12 },
  actionButton: {},
  actionText: { color: colors.primary, fontSize: 13, fontWeight: '600' },
  banText: { color: colors.danger },
});
