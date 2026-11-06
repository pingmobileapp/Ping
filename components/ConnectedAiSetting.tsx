import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, AppState, Linking, Alert } from 'react-native';
import { supabase } from '../supabase';
import { colors } from '../lib/theme';

// Settings -> Connected AI. AI apps (Meta's Muse, Claude, ChatGPT) linked
// to this Ping account through the AI connector (supabase/functions/mcp).
// The links themselves are Supabase Auth OAuth grants; ai_connections
// (supabase/ai_connections.sql) holds the Full access / Read only choice
// made on the consent page (docs/connect.html). Disconnect revokes the grant,
// which ends the AI app's sign-in right away, then forgets the choice.

const HELP_URL = 'https://pingmobileapp.github.io/Ping/ai.html';

type Connection = { clientId: string; name: string; readOnly: boolean | null };

type Props = { userId: string };

export default function ConnectedAiSetting({ userId }: Props) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [{ data: grants, error }, { data: choices }] = await Promise.all([
      supabase.auth.oauth.listGrants(),
      supabase.from('ai_connections').select('client_id, client_name, read_only').eq('user_id', userId),
    ]);
    if (error) {
      // Before the AI connector is switched on, there's nothing to list.
      console.log('AI connections unavailable:', error.message);
      setConnections([]);
      return;
    }
    setConnections(
      (grants || []).map((g) => {
        const choice = (choices || []).find((c) => c.client_id === g.client.id);
        return { clientId: g.client.id, name: g.client.name || choice?.client_name || 'AI app', readOnly: choice ? choice.read_only : null };
      })
    );
  }, [userId]);

  useEffect(() => {
    refresh();
    // Connecting happens in the browser - pick it up on the way back.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const disconnect = (c: Connection) => {
    Alert.alert(`Disconnect ${c.name}?`, `${c.name} won't be able to use your Ping account anymore. You can connect it again later.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: async () => {
          setBusyId(c.clientId);
          const { error } = await supabase.auth.oauth.revokeGrant({ clientId: c.clientId });
          if (error) {
            setBusyId(null);
            console.error('Error disconnecting AI app:', error);
            Alert.alert("Couldn't disconnect", 'Check your connection and try again.');
            return;
          }
          const { error: forgetError } = await supabase
            .from('ai_connections')
            .delete()
            .eq('user_id', userId)
            .eq('client_id', c.clientId);
          if (forgetError) console.error('Error clearing AI app access choice:', forgetError);
          setBusyId(null);
          refresh();
        },
      },
    ]);
  };

  return (
    <View style={styles.section}>
      <View style={styles.row}>
        <Text style={[styles.title, { flex: 1 }]}>Connected AI</Text>
        <TouchableOpacity onPress={() => Linking.openURL(HELP_URL)}>
          <Text style={styles.action}>How to connect ›</Text>
        </TouchableOpacity>
      </View>

      {connections === null ? (
        <Text style={styles.status}>Loading…</Text>
      ) : connections.length === 0 ? (
        <Text style={styles.status}>No AI apps connected</Text>
      ) : (
        connections.map((c) => (
          <View key={c.clientId} style={[styles.row, styles.appRow]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.appName}>{c.name}</Text>
              <Text style={styles.status}>{c.readOnly === false ? 'Full access' : 'Read only'}</Text>
            </View>
            <TouchableOpacity onPress={() => disconnect(c)} disabled={busyId === c.clientId}>
              <Text style={styles.disconnect}>{busyId === c.clientId ? '…' : 'Disconnect'}</Text>
            </TouchableOpacity>
          </View>
        ))
      )}

      <Text style={styles.helper}>
        Link Ping to an AI app like Muse, Claude or ChatGPT, then ask it to check your calendar, make a New Event or
        invite people. It can't see your phone's own calendar, delete your account or pay for anything.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 32, paddingTop: 20, borderTopWidth: 1, borderTopColor: colors.divider },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  appRow: { marginTop: 12 },
  title: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  appName: { color: colors.textPrimary, fontSize: 15 },
  status: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  action: { color: colors.primary, fontSize: 16, fontWeight: '700' },
  disconnect: { color: colors.danger, fontSize: 15, fontWeight: '700' },
  helper: { color: colors.textMuted, fontSize: 12, marginTop: 8, fontStyle: 'italic' },
});
