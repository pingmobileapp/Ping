import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { supabase } from '../supabase';
import { useAnyModalOpen, useRegisterModal } from '../lib/modalPresence';
import { colors } from '../lib/theme';

// A gentle reminder for people with no saved name. Email sign-ups never asked
// for one until the sign-up form gained an (optional) field, so most of those
// accounts show up nameless or as an email fragment in guest lists.
//
// Optional by design - App Review rejected making the name required, and
// people who chose "Hide My Email"/no name with Sign in with Apple mustn't be
// pushed to hand it over. So it never shows in an account's first few days,
// "Not now" quiets it for two weeks, and Settings -> Name always works.
//
// Waits until no other sheet is open and registers itself while visible, so it
// never stacks on another RN Modal (see lib/modalPresence for the build 114
// freeze that causes).

const FIRST_REMINDER_AFTER_DAYS = 3;
const SNOOZE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const snoozeKey = (userId: string) => `namePromptSnoozedUntil:${userId}`;

// `signUpName` is the name from the sign-up form / Apple / Google, which
// AuthContext's ensureProfileName is copying onto the profile at this same
// moment on first login - skip the prompt for them rather than race it.
export default function NamePrompt({
  userId,
  signUpName,
  accountCreatedAt,
}: {
  userId: string;
  signUpName?: string;
  accountCreatedAt?: string;
}) {
  const [needsName, setNeedsName] = useState(false);
  const [visible, setVisible] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const anyModalOpen = useAnyModalOpen();

  useRegisterModal(visible);

  useEffect(() => {
    if (signUpName?.trim()) return;
    const created = accountCreatedAt ? Date.parse(accountCreatedAt) : NaN;
    if (!Number.isNaN(created) && Date.now() - created < FIRST_REMINDER_AFTER_DAYS * DAY_MS) return;
    let cancelled = false;
    (async () => {
      const snoozedUntil = Number(await AsyncStorage.getItem(snoozeKey(userId)).catch(() => null));
      if (snoozedUntil && Date.now() < snoozedUntil) return;
      const { data, error } = await supabase.from('profiles').select('full_name').eq('id', userId).maybeSingle();
      if (!cancelled && !error && data && !data.full_name?.trim()) setNeedsName(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, signUpName, accountCreatedAt]);

  // Give launch-time sheets (tour, invite popup) a moment to claim the screen
  // first; if one opens, this effect re-runs and the timer is cancelled.
  useEffect(() => {
    if (!needsName || visible || anyModalOpen) return;
    const timer = setTimeout(() => setVisible(true), 2000);
    return () => clearTimeout(timer);
  }, [needsName, visible, anyModalOpen]);

  const dismiss = () => {
    setVisible(false);
    setNeedsName(false);
  };

  const notNow = () => {
    AsyncStorage.setItem(snoozeKey(userId), String(Date.now() + SNOOZE_DAYS * DAY_MS)).catch(() => {});
    dismiss();
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    const { error } = await supabase.from('profiles').update({ full_name: trimmed }).eq('id', userId);
    setSaving(false);
    if (!error) dismiss();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={notNow}>
      <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.card}>
          <Text style={styles.title}>What’s your name?</Text>
          <Text style={styles.body}>
            Optional, but it helps friends know who’s coming. It shows on events and in messages, and you can
            change it anytime in Settings.
          </Text>
          <TextInput
            style={styles.input}
            placeholder="Your name"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="words"
            textContentType="name"
            autoComplete="name"
            autoFocus
            value={name}
            onChangeText={setName}
            onSubmitEditing={save}
            returnKeyType="done"
          />
          <TouchableOpacity
            style={[styles.primaryButton, !name.trim() && styles.primaryButtonDisabled]}
            onPress={save}
            disabled={!name.trim() || saving}
          >
            {saving ? <ActivityIndicator color={colors.textOnPrimary} /> : <Text style={styles.primaryButtonText}>Save</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={notNow} style={styles.notNow}>
            <Text style={styles.notNowText}>Not now</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: colors.background,
    borderRadius: 16,
    padding: 22,
    gap: 12,
    maxWidth: 440,
    width: '100%',
    alignSelf: 'center',
  },
  title: { color: colors.textPrimary, fontSize: 20, fontWeight: '800' },
  body: { color: colors.textSecondary, fontSize: 15, lineHeight: 21 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceLight,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.textPrimary,
  },
  primaryButton: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryButtonDisabled: { opacity: 0.5 },
  primaryButtonText: { color: colors.textOnPrimary, fontSize: 16, fontWeight: '700' },
  notNow: { alignItems: 'center', paddingVertical: 6 },
  notNowText: { color: colors.textSecondary, fontSize: 15 },
});
