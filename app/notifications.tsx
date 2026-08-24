import React, { useCallback } from 'react';
import { Animated, View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { colors } from '../lib/theme';
import { useNotificationsContext } from '../lib/NotificationsContext';
import { NotificationRow as NotificationRowData } from '../lib/useNotifications';
import CompactEventRow from '../components/CompactEventRow';
import NotificationRow from '../components/NotificationRow';

// Slides in from behind the row as it's dragged (dragX starts near 0 and
// grows negative while swiping left) rather than just popping into place at
// full size once the reveal threshold is crossed.
const renderDeleteAction = (dragX: Animated.AnimatedInterpolation<number>, onPress: () => void) => {
  const scale = dragX.interpolate({
    inputRange: [-80, 0],
    outputRange: [1, 0.5],
    extrapolate: 'clamp',
  });
  return (
    <TouchableOpacity style={styles.deleteAction} onPress={onPress}>
      <Animated.Text style={[styles.deleteActionText, { transform: [{ scale }] }]}>Delete</Animated.Text>
    </TouchableOpacity>
  );
};

export default function NotificationsScreen() {
  const router = useRouter();
  const {
    notifications,
    pendingInvites,
    loading,
    refresh,
    markRead,
    markAllRead,
    deleteNotification,
    openEventModal,
    openGroupChat,
  } = useNotificationsContext();

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );

  // Events open in the same flip-card modal used everywhere else in the
  // app (the Home screen watches pendingEventModal) rather than the
  // separate full-page route - dismissTo('/') returns to the Home screen
  // that's already on the stack (this screen was itself pushed from
  // there) rather than push('/'), which was mounting a second, duplicate
  // Home instance and opening a native modal on it at the same time -
  // that combination was the actual cause of a real crash during family
  // testing (two competing native screen/modal instances corrupting the
  // native view stack).
  const openNotification = (n: NotificationRowData) => {
    markRead(n.id);
    if (n.group_id) {
      openGroupChat(n.group_id);
      if (router.canDismiss()) router.dismissTo('/');
    } else if (n.event_id) {
      openEventModal(n.event_id, n.type === 'message');
      if (router.canDismiss()) router.dismissTo('/');
    }
  };

  const hasUnread = notifications.some((n) => !n.read_at);
  const isEmpty = !loading && pendingInvites.length === 0 && notifications.length === 0;

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.pageTitle}>Notifications</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : isEmpty ? (
        <Text style={styles.emptyText}>You're all caught up.</Text>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
          {pendingInvites.length > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.sectionTitle}>Needs your response</Text>
              </View>
              {pendingInvites.map((p) => (
                <CompactEventRow
                  key={p.id}
                  event={p.events}
                  snippet={{ senderName: 'Invited', body: 'Tap to respond', createdAt: '' }}
                  onPress={() => {
                    openEventModal(p.event_id);
                    if (router.canDismiss()) router.dismissTo('/');
                  }}
                />
              ))}
            </View>
          )}

          {notifications.length > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.sectionTitle}>Recent</Text>
                {hasUnread && (
                  <TouchableOpacity onPress={markAllRead}>
                    <Text style={styles.markAllText}>Mark all read</Text>
                  </TouchableOpacity>
                )}
              </View>
              {notifications.map((n) => (
                <Swipeable
                  key={n.id}
                  renderRightActions={(_, dragX) => renderDeleteAction(dragX, () => deleteNotification(n.id))}
                  overshootRight={false}
                  rightThreshold={40}
                >
                  <NotificationRow notification={n} onPress={openNotification} />
                </Swipeable>
              ))}
            </View>
          )}
        </ScrollView>
      )}
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
  emptyText: { color: colors.textMuted, textAlign: 'center', marginTop: 40, fontSize: 15 },
  section: { marginTop: 12 },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginHorizontal: 20,
    marginBottom: 4,
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  markAllText: { color: colors.primary, fontSize: 13, fontWeight: '600' },
  deleteAction: {
    width: 80,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteActionText: { color: colors.textOnPrimary, fontWeight: '700', fontSize: 14 },
});
