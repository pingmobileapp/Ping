import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { supabase } from '../supabase';
import { useAuth } from '../lib/AuthContext';
import { generateCatchMeUp } from '../lib/catchMeUp';
import { colors } from '../lib/theme';

type Props = {
  visible: boolean;
  onClose: () => void;
};

// On-demand digest, generated fresh each time it's opened rather than on a
// schedule - no cron/background infra needed, and it's always current with
// whatever just happened.
export default function CatchMeUpModal({ visible, onClose }: Props) {
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState('');
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!visible || !session?.user?.id) return;
    setLoading(true);
    setError(false);
    generateCatchMeUp(supabase, session.user.id)
      .then(setSummary)
      .catch((err) => {
        console.error('Error generating catch-me-up summary:', err);
        setError(true);
      })
      .finally(() => setLoading(false));
  }, [visible, session?.user?.id]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.header}>✨ Catch me up</Text>

          {loading ? (
            <ActivityIndicator color={colors.primary} style={{ marginVertical: 24 }} />
          ) : error ? (
            <Text style={styles.errorText}>Couldn't put that together right now. Try again in a moment.</Text>
          ) : (
            <Text style={styles.summaryText}>{summary}</Text>
          )}

          <TouchableOpacity style={styles.doneButton} onPress={onClose}>
            <Text style={styles.doneButtonText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(43,43,43,0.4)', padding: 24 },
  card: { backgroundColor: colors.background, borderRadius: 20, padding: 24, width: '100%', maxWidth: 400 },
  header: { fontSize: 18, fontWeight: '700', color: colors.textPrimary, marginBottom: 12 },
  summaryText: { fontSize: 15, lineHeight: 22, color: colors.textPrimary },
  errorText: { fontSize: 14, color: colors.textSecondary, fontStyle: 'italic' },
  doneButton: { backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 12, alignItems: 'center', marginTop: 20 },
  doneButtonText: { color: colors.textOnPrimary, fontWeight: '700', fontSize: 15 },
});
