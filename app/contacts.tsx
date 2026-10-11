import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  Modal,
  Platform,
  KeyboardAvoidingView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useRouter, Stack, useFocusEffect } from 'expo-router';
import { supabase } from '../supabase';
import { useAuth } from '../lib/AuthContext';
import { normalizePhone, healContactLink } from '../lib/phone';
import { colors } from '../lib/theme';

// Settings -> Contacts. Asked for after a host invited two old contacts that
// had no phone number saved (added Sept 1, before he re-imported them with
// numbers) - they silently never got the invite, and the duplicates were
// still sitting in his picker. This lists everything in your Ping contacts,
// flags the ones that can't be reached and the names that appear twice,
// and lets you fix a name/number or remove a contact.
//
// Removing sets removed_at rather than deleting the row (see
// supabase/contacts_removed_at.sql): past invites still point at it and
// keep showing the name.

type ContactRow = {
  id: string;
  name: string;
  phone: string | null;
  linked_user_id: string | null;
};

const formatPhone = (phone: string | null) => {
  if (!phone) return null;
  const d = normalizePhone(phone);
  if (d && d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return phone;
};

// "David Hardy" and "Hardy David" are the same person to a human - phone
// imports sometimes flip first/last - so duplicates compare the name's words
// regardless of order.
const nameKey = (name: string) =>
  name
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');

export default function ContactsScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ContactRow | null>(null);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!session?.user?.id) return;
    const { data, error } = await supabase
      .from('contacts')
      .select('id, name, phone, linked_user_id')
      .eq('owner_id', session.user.id)
      .is('removed_at', null)
      .order('name');
    if (error) console.error('Error loading contacts:', error);
    setContacts(data || []);
    setLoading(false);
  }, [session?.user?.id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const duplicateKeys = useMemo(() => {
    const counts = new Map<string, number>();
    contacts.forEach((c) => counts.set(nameKey(c.name), (counts.get(nameKey(c.name)) || 0) + 1));
    return new Set([...counts].filter(([, n]) => n > 1).map(([k]) => k));
  }, [contacts]);

  const unreachableCount = contacts.filter((c) => !c.linked_user_id && !c.phone).length;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    return contacts.filter(
      (c) => !q || c.name.toLowerCase().includes(q) || (!!digits && (c.phone || '').includes(digits))
    );
  }, [contacts, search]);

  const openEditor = (c: ContactRow) => {
    setEditing(c);
    setEditName(c.name);
    setEditPhone(formatPhone(c.phone) || '');
  };

  const handleSave = async () => {
    if (!editing) return;
    const name = editName.trim();
    if (!name) {
      Alert.alert('Name required', 'Give this contact a name.');
      return;
    }
    const phone = normalizePhone(editPhone);
    if (editPhone.trim() && (!phone || phone.length < 10)) {
      Alert.alert('Check the number', 'That phone number looks incomplete.');
      return;
    }
    const clash = phone && contacts.find((c) => c.id !== editing.id && normalizePhone(c.phone) === phone);
    if (clash) {
      Alert.alert(
        'Number already saved',
        `"${clash.name}" already has this number. Remove one of them instead so you don't have two of the same person.`
      );
      return;
    }

    setSaving(true);
    const changedPhone = phone !== normalizePhone(editing.phone);
    const { error } = await supabase
      .from('contacts')
      .update({
        name,
        phone,
        // A new number may belong to someone else's Ping account (or none) -
        // drop the old link and let healContactLink find the right one.
        ...(changedPhone ? { linked_user_id: null } : {}),
      })
      .eq('id', editing.id);
    if (error) {
      setSaving(false);
      console.error('Error updating contact:', error);
      Alert.alert("Couldn't save", 'Check your connection and try again.');
      return;
    }
    if (changedPhone && phone) {
      await healContactLink(supabase, { id: editing.id, phone, linked_user_id: null });
    }
    setSaving(false);
    setEditing(null);
    load();
  };

  const handleRemove = () => {
    if (!editing) return;
    const target = editing;
    Alert.alert(
      `Remove ${target.name}?`,
      "They'll be taken out of your contacts and any groups you made. Past events still show their name, and you can add them back any time.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            const { error } = await supabase
              .from('contacts')
              .update({ removed_at: new Date().toISOString() })
              .eq('id', target.id);
            if (error) {
              console.error('Error removing contact:', error);
              Alert.alert("Couldn't remove", 'Check your connection and try again.');
              return;
            }
            // Out of their own groups too, so a removed contact doesn't keep
            // getting invited through a group.
            const { error: groupError } = await supabase.from('group_members').delete().eq('contact_id', target.id);
            if (groupError) console.error('Error removing contact from groups:', groupError);
            setEditing(null);
            load();
          },
        },
      ]
    );
  };

  const renderItem = ({ item }: { item: ContactRow }) => {
    const unreachable = !item.linked_user_id && !item.phone;
    const duplicate = duplicateKeys.has(nameKey(item.name));
    return (
      <TouchableOpacity style={styles.row} onPress={() => openEditor(item)} activeOpacity={0.7}>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{item.name}</Text>
          <Text style={[styles.detail, unreachable && styles.detailWarn]}>
            {item.phone ? formatPhone(item.phone) : 'No phone number'}
          </Text>
        </View>
        <View style={styles.badges}>
          {duplicate && <Text style={[styles.badge, styles.badgeWarn]}>Listed twice?</Text>}
          {item.linked_user_id ? (
            <Text style={[styles.badge, styles.badgeOnPing]}>On Ping</Text>
          ) : unreachable ? (
            <Text style={[styles.badge, styles.badgeDanger]}>Can't invite</Text>
          ) : null}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.pageTitle}>Contacts</Text>
        <View style={{ width: 50 }} />
      </View>

      <TextInput
        style={styles.search}
        placeholder="Search name or number"
        placeholderTextColor={colors.textMuted}
        value={search}
        onChangeText={setSearch}
        autoCorrect={false}
        clearButtonMode="while-editing"
      />

      {unreachableCount > 0 && (
        <Text style={styles.notice}>
          {unreachableCount === 1
            ? "1 contact isn't on Ping and has no phone number, so they can't get invites. Add a number or remove them."
            : `${unreachableCount} contacts aren't on Ping and have no phone number, so they can't get invites. Add a number or remove them.`}
        </Text>
      )}

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(c) => c.id}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 40 }}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {search ? 'No contacts match.' : 'No contacts yet. Import them when you create a Ping.'}
            </Text>
          }
        />
      )}

      <Modal visible={!!editing} transparent animationType="fade" onRequestClose={() => setEditing(null)}>
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Edit contact</Text>
            <Text style={styles.label}>Name</Text>
            <TextInput style={styles.input} value={editName} onChangeText={setEditName} placeholder="Name" placeholderTextColor={colors.textMuted} />
            <Text style={styles.label}>Phone</Text>
            <TextInput
              style={styles.input}
              value={editPhone}
              onChangeText={setEditPhone}
              placeholder="Phone number"
              placeholderTextColor={colors.textMuted}
              keyboardType="phone-pad"
            />
            {editing?.linked_user_id && (
              <Text style={styles.helperText}>On Ping - invites reach them in the app.</Text>
            )}
            <View style={styles.modalButtons}>
              <TouchableOpacity onPress={() => setEditing(null)} disabled={saving}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleSave} disabled={saving}>
                <Text style={styles.saveText}>{saving ? 'Saving…' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={styles.removeButton} onPress={handleRemove} disabled={saving}>
              <Text style={styles.removeText}>Remove contact</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingTop: 60, paddingHorizontal: 20 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  backText: { color: colors.primary, fontSize: 16, fontWeight: '600', width: 50 },
  pageTitle: { color: colors.textPrimary, fontSize: 18, fontWeight: '700' },
  search: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    marginBottom: 10,
  },
  notice: {
    color: colors.textPrimary,
    backgroundColor: colors.warningPale,
    borderRadius: 10,
    padding: 12,
    fontSize: 13,
    marginBottom: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    gap: 10,
  },
  name: { color: colors.textPrimary, fontSize: 16, fontWeight: '600' },
  detail: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  detailWarn: { color: colors.danger },
  badges: { alignItems: 'flex-end', gap: 4 },
  badge: { fontSize: 11, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, overflow: 'hidden' },
  badgeOnPing: { color: colors.primary, backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.primaryPale },
  badgeDanger: { color: colors.danger, backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.danger },
  badgeWarn: { color: colors.textPrimary, backgroundColor: colors.warningPale },
  empty: { color: colors.textMuted, textAlign: 'center', marginTop: 40 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(43,43,43,0.4)', justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: colors.background, borderRadius: 18, padding: 20, width: '100%', maxWidth: 480, alignSelf: 'center' },
  modalTitle: { color: colors.textPrimary, fontSize: 18, fontWeight: '700', marginBottom: 4 },
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
  modalButtons: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 20 },
  cancelText: { color: colors.textSecondary, fontSize: 16, fontWeight: '600' },
  saveText: { color: colors.primary, fontSize: 16, fontWeight: '700' },
  removeButton: { marginTop: 20, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.divider, alignItems: 'center' },
  removeText: { color: colors.danger, fontSize: 16, fontWeight: '700' },
});
