import React, { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { supabase } from '../supabase';
import { colors } from '../lib/theme';
import { TERMS_OF_USE_TEXT } from '../lib/termsOfUse';

type Props = {
  userId: string;
  mode: 'needs_terms' | 'banned';
  onAccepted: () => void;
  onSignOut: () => void;
};

// Rendered from app/_layout.tsx before anything else when the signed-in
// account hasn't accepted the current terms, or has been banned by the
// admin screen (see app/admin.tsx) - a real, unskippable gate, which is
// exactly what Apple's Guideline 1.2 review asked for (unlike the old,
// since-deleted PhoneGateScreen, which was rejected for gating on
// information the app didn't actually need).
export default function TermsGateScreen({ userId, mode, onAccepted, onSignOut }: Props) {
  const [submitting, setSubmitting] = useState(false);

  const handleAgree = async () => {
    setSubmitting(true);
    const { error } = await supabase
      .from('profiles')
      .update({ accepted_terms_at: new Date().toISOString() })
      .eq('id', userId);
    setSubmitting(false);
    if (error) {
      console.error('Error accepting terms:', error);
      Alert.alert('Something went wrong', 'Could not save your acceptance. Please try again.');
      return;
    }
    onAccepted();
  };

  if (mode === 'banned') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Account suspended</Text>
        <Text style={styles.bannedText}>
          This account has been suspended for violating Ping's Terms of Use. If you think this is a mistake,
          contact pierson.willhite@gmail.com.
        </Text>
        <TouchableOpacity style={styles.signOutButton} onPress={onSignOut}>
          <Text style={styles.signOutButtonText}>Sign Out</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Terms of Use</Text>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.body}>{TERMS_OF_USE_TEXT}</Text>
      </ScrollView>
      <View style={styles.buttonRow}>
        <TouchableOpacity style={styles.declineButton} onPress={onSignOut} disabled={submitting}>
          <Text style={styles.declineButtonText}>Decline</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.agreeButton} onPress={handleAgree} disabled={submitting}>
          {submitting ? <ActivityIndicator color={colors.textOnPrimary} /> : <Text style={styles.agreeButtonText}>I Agree</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingTop: 70, paddingHorizontal: 20, paddingBottom: 24 },
  title: { fontSize: 24, fontWeight: '700', color: colors.textPrimary, marginBottom: 16 },
  scroll: { flex: 1, borderRadius: 12, backgroundColor: colors.surfaceAlt },
  scrollContent: { padding: 16 },
  body: { fontSize: 14, lineHeight: 21, color: colors.textSecondary },
  buttonRow: { flexDirection: 'row', gap: 12, marginTop: 16 },
  declineButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  declineButtonText: { color: colors.textSecondary, fontSize: 16, fontWeight: '600' },
  agreeButton: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: colors.primary, alignItems: 'center' },
  agreeButtonText: { color: colors.textOnPrimary, fontSize: 16, fontWeight: '700' },
  bannedText: { fontSize: 15, lineHeight: 22, color: colors.textSecondary, marginBottom: 24 },
  signOutButton: { paddingVertical: 14, borderRadius: 12, backgroundColor: colors.danger, alignItems: 'center' },
  signOutButtonText: { color: colors.textOnPrimary, fontSize: 16, fontWeight: '700' },
});
