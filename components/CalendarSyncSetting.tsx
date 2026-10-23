import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, AppState, Linking, Alert } from 'react-native';
import { supabase } from '../supabase';
import { colors } from '../lib/theme';
import { CalendarPermissionStatus, getCalendarPermissionStatus, requestCalendarAccess } from '../lib/calendarConflicts';

// Settings -> Phone calendar. Showing your phone's calendar in Ping needs two
// things: iOS permission (per device) and this account's own opt-in
// (profiles.calendar_sync_enabled - see supabase/calendar_sync_opt_in.sql).
// Asked for after someone who'd tapped "Don't Allow" once couldn't find a way
// back in: iOS never shows that prompt a second time, and Home's banner only
// appears while it still can, so they had to dig through iPhone Settings.
// This covers every state, including sending them straight to Ping's page in
// iPhone Settings when that's the only way.

type Props = { userId: string };

export default function CalendarSyncSetting({ userId }: Props) {
  const [permission, setPermission] = useState<CalendarPermissionStatus | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  // Set when we've sent them to iPhone Settings, so coming back with access
  // granted finishes the job (turns sync on) without another tap.
  const awaitingSettings = useRef(false);

  const saveEnabled = useCallback(
    async (value: boolean) => {
      const { error } = await supabase.from('profiles').update({ calendar_sync_enabled: value }).eq('id', userId);
      if (error) {
        console.error('Error saving calendar sync preference:', error);
        Alert.alert("Couldn't save", 'Check your connection and try again.');
        return false;
      }
      setEnabled(value);
      return true;
    },
    [userId]
  );

  const refresh = useCallback(async () => {
    const [status, { data }] = await Promise.all([
      getCalendarPermissionStatus(),
      supabase.from('profiles').select('calendar_sync_enabled').eq('id', userId).maybeSingle(),
    ]);
    setPermission(status);
    setEnabled(!!data?.calendar_sync_enabled);
    if (awaitingSettings.current && status === 'granted') {
      awaitingSettings.current = false;
      if (!data?.calendar_sync_enabled) await saveEnabled(true);
    }
  }, [userId, saveEnabled]);

  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const turnOn = async () => {
    if (permission === 'denied') {
      Alert.alert(
        'Allow calendar access',
        'Your iPhone is blocking Ping from your calendar. Tap Open Settings, then Calendars, and choose Full Access. Come back to Ping when you\'re done.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Open Settings',
            onPress: () => {
              awaitingSettings.current = true;
              Linking.openSettings().catch(() => {});
            },
          },
        ]
      );
      return;
    }
    setBusy(true);
    const granted = permission === 'granted' ? true : await requestCalendarAccess();
    if (granted) await saveEnabled(true);
    await refresh();
    setBusy(false);
  };

  const turnOff = async () => {
    setBusy(true);
    await saveEnabled(false);
    setBusy(false);
  };

  if (permission === null || enabled === null) return null;

  const isOn = permission === 'granted' && enabled;
  const status = isOn ? 'On' : permission === 'denied' ? 'Blocked in iPhone Settings' : 'Off';

  return (
    <View style={styles.section}>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Phone calendar</Text>
          <Text style={[styles.status, isOn && styles.statusOn]}>{status}</Text>
        </View>
        <TouchableOpacity onPress={isOn ? turnOff : turnOn} disabled={busy}>
          <Text style={[styles.action, isOn && styles.actionOff]}>
            {busy ? '…' : isOn ? 'Turn off' : permission === 'denied' ? 'Open Settings' : 'Turn on'}
          </Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.helper}>
        Shows your phone's calendar events alongside your events in Ping, and warns you about conflicts when you're invited
        to something. Your calendar stays on your phone - it's never uploaded.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 32, paddingTop: 20, borderTopWidth: 1, borderTopColor: colors.divider },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  status: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  statusOn: { color: colors.success, fontWeight: '600' },
  action: { color: colors.primary, fontSize: 16, fontWeight: '700' },
  actionOff: { color: colors.textSecondary },
  helper: { color: colors.textMuted, fontSize: 12, marginTop: 6, fontStyle: 'italic' },
});
