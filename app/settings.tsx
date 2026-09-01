import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Image,
  Platform,
  KeyboardAvoidingView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { supabase } from '../supabase';
import { useAuth } from '../lib/AuthContext';
import { pickProfileImage } from '../lib/imagePicker';
import { uploadAvatarImage } from '../lib/imageUpload';
import { normalizePhone } from '../lib/phone';
import { colors } from '../lib/theme';
import { fetchConnectStatus, startConnectOnboarding, ConnectAccountState } from '../lib/stripeConnect';

const CONNECT_STATUS_LABEL: Record<ConnectAccountState['status'], string> = {
  not_started: 'Not set up',
  incomplete: 'Setup incomplete',
  pending: 'Verification pending',
  ready: 'Ready to receive payments',
};

export default function SettingsScreen() {
  const router = useRouter();
  const { session, signOut } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState(session?.user?.email || '');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [connectState, setConnectState] = useState<ConnectAccountState | null>(null);
  const [connectLoading, setConnectLoading] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    fetchConnectStatus().then(setConnectState);
  }, []);

  const handleSetUpPayouts = async () => {
    setConnectLoading(true);
    const { opened, error } = await startConnectOnboarding();
    if (!opened) {
      setConnectLoading(false);
      Alert.alert('Error', error || 'Could not start payout setup.');
      return;
    }
    setConnectState(await fetchConnectStatus());
    setConnectLoading(false);
  };

  useEffect(() => {
    if (!session?.user?.id) return;
    (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('full_name, phone, avatar_url, is_admin')
        .eq('id', session.user.id)
        .maybeSingle();

      if (error) console.error('Error loading profile:', error);
      setFullName(data?.full_name || '');
      setPhone(data?.phone || '');
      setAvatarUrl(data?.avatar_url || null);
      setIsAdmin(!!data?.is_admin);
      setLoading(false);
    })();
  }, [session?.user?.id]);

  const pickAvatar = async () => {
    const uri = await pickProfileImage();
    if (uri) setAvatarUri(uri);
  };

  const handleSave = async () => {
    if (!session?.user?.id) return;
    setSaving(true);

    let newAvatarUrl = avatarUrl;
    if (avatarUri) {
      try {
        newAvatarUrl = await uploadAvatarImage(avatarUri, session.user.id);
      } catch (err) {
        console.error('Error uploading avatar:', err);
        setSaving(false);
        Alert.alert('Upload failed', 'Could not upload the photo. Try again.');
        return;
      }
    }

    // Must match the format contacts.phone is stored in (digits only, see
    // lib/phone.ts) or the account-linking lookup that matches an invitee's
    // phone against a profile can never find this row.
    const { error: profileError } = await supabase
      .from('profiles')
      .update({
        full_name: fullName.trim() || null,
        phone: normalizePhone(phone) || null,
        avatar_url: newAvatarUrl,
      })
      .eq('id', session.user.id);

    if (profileError) {
      setSaving(false);
      console.error('Error saving profile:', profileError);
      if (profileError.code === '23505') {
        Alert.alert('Phone number in use', 'That phone number is already linked to another account.');
      } else {
        Alert.alert('Error', 'Could not save your profile.');
      }
      return;
    }

    const trimmedEmail = email.trim();
    if (trimmedEmail && trimmedEmail !== session.user.email) {
      const { error: emailError } = await supabase.auth.updateUser({ email: trimmedEmail });
      setSaving(false);
      if (emailError) {
        Alert.alert('Email change failed', emailError.message);
        return;
      }
      Alert.alert(
        'Check your email',
        'Confirm the change from the link we sent to your new address before it takes effect.'
      );
      return;
    }

    setSaving(false);
    router.back();
  };

  const performDelete = async () => {
    setDeleting(true);
    const { error } = await supabase.functions.invoke('delete-account');
    if (error) {
      setDeleting(false);
      console.error('Error deleting account:', error);
      Alert.alert('Error', 'Could not delete your account. Try again in a moment.');
      return;
    }
    await signOut();
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      "This permanently deletes your account and everything tied to it - your profile, events you host, messages, contacts, and groups you own. This can't be undone.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            Alert.alert('Are you sure?', 'This is your last chance to back out.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete Account', style: 'destructive', onPress: performDelete },
            ]),
        },
      ]
    );
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />

        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()}>
            <Text style={styles.backText}>‹ Back</Text>
          </TouchableOpacity>
          <Text style={styles.pageTitle}>Settings</Text>
          <TouchableOpacity onPress={handleSave} disabled={saving}>
            <Text style={styles.saveText}>{saving ? 'Saving...' : 'Save'}</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
        >
          <TouchableOpacity style={styles.avatarWrap} onPress={pickAvatar} activeOpacity={0.85}>
            {avatarUri || avatarUrl ? (
              <Image source={{ uri: avatarUri || avatarUrl! }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarPlaceholder]}>
                <Text style={styles.avatarPlaceholderText}>
                  {(fullName || session?.user?.email || '?').trim().charAt(0).toUpperCase()}
                </Text>
              </View>
            )}
            <Text style={styles.avatarEditText}>Change Photo</Text>
          </TouchableOpacity>

          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            placeholder="Your name"
            placeholderTextColor={colors.textMuted}
            value={fullName}
            onChangeText={setFullName}
          />

          <Text style={styles.label}>Phone</Text>
          <TextInput
            style={styles.input}
            placeholder="Phone number"
            placeholderTextColor={colors.textMuted}
            keyboardType="phone-pad"
            value={phone}
            onChangeText={setPhone}
          />

          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
          <Text style={styles.helperText}>
            Changing your email requires confirming it from a link sent to your new address.
          </Text>

          <View style={styles.payoutsSection}>
            <Text style={styles.label}>Payouts</Text>
            <View style={styles.payoutsRow}>
              <Text style={styles.payoutsStatusText}>
                {connectState ? CONNECT_STATUS_LABEL[connectState.status] : 'Loading…'}
              </Text>
              <TouchableOpacity onPress={handleSetUpPayouts} disabled={connectLoading}>
                <Text style={styles.saveText}>
                  {connectLoading
                    ? 'Opening…'
                    : connectState?.status === 'ready'
                      ? 'Manage'
                      : connectState?.status === 'not_started'
                        ? 'Set up'
                        : 'Continue'}
                </Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.helperText}>
              Connect a Stripe account to charge for events you host on Discover. Stripe handles your payout
              details directly - Ping never sees your bank info.
            </Text>
          </View>

          {isAdmin && (
            <View style={styles.payoutsSection}>
              {/* Expo Router's generated route types (.expo/types/router.d.ts)
                  only pick up a new route file once a dev server/build
                  regenerates them - harmless cast until that next happens. */}
              <TouchableOpacity onPress={() => router.push('/admin' as any)}>
                <Text style={styles.label}>Admin - Reports</Text>
              </TouchableOpacity>
              <Text style={styles.helperText}>Review and act on user reports.</Text>
            </View>
          )}

          <View style={styles.dangerZone}>
            <TouchableOpacity onPress={handleDeleteAccount} disabled={deleting}>
              <Text style={styles.deleteText}>{deleting ? 'Deleting Account…' : 'Delete Account'}</Text>
            </TouchableOpacity>
            <Text style={styles.helperText}>
              Permanently deletes your account and everything tied to it - your profile, events you host,
              messages, contacts, and groups you own. This can't be undone.
            </Text>
          </View>
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingTop: 60, paddingHorizontal: 20 },
  centered: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  backText: { color: colors.primary, fontSize: 16, fontWeight: '600' },
  pageTitle: { color: colors.textPrimary, fontSize: 18, fontWeight: '700' },
  saveText: { color: colors.primary, fontSize: 16, fontWeight: '700' },
  avatarWrap: { alignItems: 'center', marginBottom: 24 },
  avatar: { width: 96, height: 96, borderRadius: 48 },
  avatarPlaceholder: { backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  avatarPlaceholderText: { color: colors.textOnPrimary, fontSize: 34, fontWeight: '700' },
  avatarEditText: { color: colors.primary, fontSize: 14, fontWeight: '600', marginTop: 10 },
  label: { fontWeight: '600', marginTop: 14, marginBottom: 6, color: colors.textPrimary },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
  },
  helperText: { color: colors.textMuted, fontSize: 12, marginTop: 6, fontStyle: 'italic' },
  payoutsSection: { marginTop: 32, paddingTop: 20, borderTopWidth: 1, borderTopColor: colors.divider },
  payoutsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  payoutsStatusText: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  dangerZone: { marginTop: 24, paddingTop: 20, borderTopWidth: 1, borderTopColor: colors.divider },
  deleteText: { color: colors.danger, fontSize: 16, fontWeight: '700' },
});
