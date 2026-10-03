import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
} from 'react-native';
import { supabase } from '../supabase';
import { colors } from '../lib/theme';
import { normalizePhone } from '../lib/phone';
import { healInviteLinks } from '../lib/healInvites';

type Props = {
  userId: string;
  onDone: () => void;
};

// Shown once, right after the terms screen, to anyone without a phone
// number on file. Most people meet Ping by being invited by text before
// they have an account - their invite is waiting under their phone number
// and only shows up once that number is on their profile (see
// lib/healInvites.ts). Before this, the only prompt was a Home-screen
// banner that was easy to miss, and invited family members couldn't find
// the invite they'd been texted (real report, 2026-10-01).
//
// Deliberately skippable: Apple rejected an earlier build (guideline
// 5.1.1(v)) for a phone-number gate that couldn't be skipped. Skipping
// leaves the Home-screen card as a later reminder.
export default function FindInvitesScreen({ userId, onDone }: Props) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    supabase
      .from('profiles')
      .select('full_name')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.full_name) setName((current) => current || data.full_name);
      });
  }, [userId]);

  const handleContinue = async () => {
    const normalized = normalizePhone(phone);
    if (phone.trim() && (!normalized || normalized.length < 10)) {
      Alert.alert('Check your number', 'That phone number looks incomplete. Include the area code.');
      return;
    }

    setSaving(true);
    const updates: Record<string, string> = {};
    if (name.trim()) updates.full_name = name.trim();
    if (normalized) updates.phone = normalized;

    if (Object.keys(updates).length > 0) {
      const { error } = await supabase.from('profiles').update(updates).eq('id', userId);
      if (error) {
        setSaving(false);
        if (error.code === '23505') {
          Alert.alert(
            'Number already in use',
            'That phone number is already on another Ping account. If it\'s yours, sign in to that account instead.',
          );
        } else {
          console.error('Error saving profile from find-invites step:', error);
          Alert.alert('Something went wrong', 'Could not save that. Try again, or skip for now.');
        }
        return;
      }
    }

    const found = normalized ? await healInviteLinks() : 0;
    setSaving(false);
    if (found > 0) {
      Alert.alert(
        found === 1 ? 'Found your invite! 🎉' : `Found ${found} invites! 🎉`,
        found === 1 ? "It's waiting on your Home screen." : "They're waiting on your Home screen.",
        [{ text: 'See invites', onPress: onDone }],
      );
      return;
    }
    onDone();
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        // The number pad has no return key - a swipe down puts it away so
        // Skip for now is never stuck behind it.
        keyboardDismissMode="on-drag"
      >
        <Text style={styles.emoji}>📬</Text>
        <Text style={styles.title}>Find your invites</Text>
        <Text style={styles.body}>
          Ping matches invites to you by phone number. Add the number friends and family text you at, and
          anything they've already sent you will show up.
        </Text>

        <Text style={styles.label}>Your name</Text>
        <TextInput
          style={styles.input}
          placeholder="So hosts know who's coming"
          placeholderTextColor={colors.textMuted}
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
          textContentType="name"
          autoComplete="name"
        />

        <Text style={styles.label}>Your phone number</Text>
        <TextInput
          style={styles.input}
          placeholder="(555) 555-1234"
          placeholderTextColor={colors.textMuted}
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
          autoComplete="tel"
        />
        <Text style={styles.note}>Only used to match invites to you. You can change it anytime in Settings.</Text>

        <TouchableOpacity style={styles.primaryButton} onPress={handleContinue} disabled={saving}>
          {saving ? (
            <ActivityIndicator color={colors.textOnPrimary} />
          ) : (
            <Text style={styles.primaryButtonText}>Continue</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity style={styles.skipButton} onPress={onDone} disabled={saving}>
          <Text style={styles.skipButtonText}>Skip for now</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: colors.background, paddingTop: 90, paddingHorizontal: 24, paddingBottom: 40 },
  emoji: { fontSize: 44, marginBottom: 12 },
  title: { fontSize: 28, fontWeight: '800', color: colors.textPrimary, marginBottom: 10 },
  body: { fontSize: 16, lineHeight: 23, color: colors.textSecondary, marginBottom: 28 },
  label: { fontSize: 14, fontWeight: '600', color: colors.textPrimary, marginBottom: 6 },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 17,
    color: colors.textPrimary,
    marginBottom: 18,
  },
  note: { fontSize: 13, color: colors.textMuted, marginTop: -8, marginBottom: 28, lineHeight: 18 },
  primaryButton: { backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 15, alignItems: 'center' },
  primaryButtonText: { color: colors.textOnPrimary, fontSize: 17, fontWeight: '700' },
  skipButton: {
    marginTop: 12,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  skipButtonText: { color: colors.textSecondary, fontSize: 16, fontWeight: '600' },
});
