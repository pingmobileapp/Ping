import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Platform,
  KeyboardAvoidingView,
  ActivityIndicator,
  Alert,
  Switch,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect, Stack } from 'expo-router';
import { supabase } from '../../supabase';
import { useAuth } from '../../lib/AuthContext';
import { useNotificationsContext } from '../../lib/NotificationsContext';
import { findOrCreateContact } from '../../lib/phone';
import { colors } from '../../lib/theme';
import ImportContactsModal from '../../components/ImportContactsModal';
import EventCard, { PingEvent } from '../../components/EventCard';
import EventDetailModal from '../../components/EventDetailModal';

type Contact = { id: string; name: string; phone: string | null; linked_user_id: string | null };

export default function GroupDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const router = useRouter();
  const { openGroupChat } = useNotificationsContext();

  const [groupName, setGroupName] = useState('');
  const [isOwner, setIsOwner] = useState(true);
  const [isShared, setIsShared] = useState(false);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [memberNames, setMemberNames] = useState<string[]>([]);
  const [allContacts, setAllContacts] = useState<Contact[]>([]);
  const [groupEvents, setGroupEvents] = useState<PingEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [addingContact, setAddingContact] = useState(false);
  const [newContactName, setNewContactName] = useState('');
  const [newContactPhone, setNewContactPhone] = useState('');
  const [importVisible, setImportVisible] = useState(false);

  const fetchData = useCallback(async () => {
    if (!session?.user?.id) return;

    const { data: groupData, error: groupError } = await supabase
      .from('groups')
      .select('id, name, owner_id, is_shared, group_members(contact_id, contacts(name))')
      .eq('id', id)
      .single();
    if (groupError) console.error('Error fetching group:', groupError);

    const owner = groupData?.owner_id === session.user.id;

    setGroupName(groupData?.name || '');
    setIsOwner(owner);
    setIsShared(!!groupData?.is_shared);
    setMemberIds((groupData?.group_members || []).map((m: any) => m.contact_id));
    setMemberNames((groupData?.group_members || []).map((m: any) => m.contacts?.name || 'Someone'));

    // The member-management contact list only matters (and is only
    // readable) for the group's own owner - a shared-with-you view is
    // read-only, so there's nothing to load it for.
    if (owner) {
      const { data: contactsData, error: contactsError } = await supabase
        .from('contacts')
        .select('id, name, phone, linked_user_id')
        .eq('owner_id', session.user.id)
        .order('name');
      if (contactsError) console.error('Error fetching contacts:', contactsError);
      setAllContacts(contactsData || []);
    }

    // Pings tagged to this group (see CreateEventModal) - RLS still only
    // returns ones this viewer is actually host/co-host/invited to, so a
    // group member who wasn't personally invited to a specific tagged
    // Ping won't see it just from being in the group.
    const { data: eventsData, error: eventsError } = await supabase
      .from('events')
      .select('id, title, location, event_date, end_date, is_all_day, status, image_url')
      .eq('group_id', id)
      .gte('event_date', new Date().toISOString())
      .order('event_date', { ascending: true })
      .limit(10);
    if (eventsError) console.error('Error fetching group events:', eventsError);
    setGroupEvents((eventsData as PingEvent[]) || []);
  }, [id, session?.user?.id]);

  const openEvent = (event: PingEvent) => {
    setSelectedEventId(event.id);
    setDetailVisible(true);
  };

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      fetchData().finally(() => setLoading(false));
    }, [fetchData])
  );

  const isMember = (contactId: string) => memberIds.includes(contactId);

  const toggleMember = async (contact: Contact) => {
    if (isMember(contact.id)) {
      const { error } = await supabase
        .from('group_members')
        .delete()
        .eq('group_id', id)
        .eq('contact_id', contact.id);
      if (error) {
        console.error('Error removing member:', error);
        return;
      }
      setMemberIds((prev) => prev.filter((m) => m !== contact.id));
    } else {
      const { error } = await supabase
        .from('group_members')
        .insert([{ group_id: id, contact_id: contact.id, user_id: contact.linked_user_id || null }]);
      if (error) {
        console.error('Error adding member:', error);
        return;
      }
      setMemberIds((prev) => [...prev, contact.id]);
    }
  };

  const handleToggleShared = async (value: boolean) => {
    setIsShared(value);
    const { error } = await supabase.from('groups').update({ is_shared: value }).eq('id', id);
    if (error) {
      console.error('Error updating shared status:', error);
      setIsShared(!value);
    }
  };

  const handleAddContact = async () => {
    if (!newContactName.trim() || !session?.user?.id) return;

    let contact: Contact;
    try {
      const result = await findOrCreateContact(
        supabase,
        session.user.id,
        newContactName.trim(),
        newContactPhone
      );
      contact = result.contact;

      if (result.wasExisting) {
        Alert.alert('Already in your contacts', `Matched to existing contact "${contact.name}" by phone number.`);
        if (!allContacts.some((c) => c.id === contact.id)) {
          setAllContacts((prev) => [...prev, contact].sort((a, b) => a.name.localeCompare(b.name)));
        }
      } else {
        setAllContacts((prev) => [...prev, contact].sort((a, b) => a.name.localeCompare(b.name)));
      }
    } catch (err) {
      Alert.alert('Error', 'Could not add contact.');
      console.error(err);
      return;
    }

    setNewContactName('');
    setNewContactPhone('');
    setAddingContact(false);
    await toggleMember(contact);
  };

  const handleImported = async (imported: Contact[]) => {
    setImportVisible(false);
    setAllContacts((prev) => {
      const merged = [...prev];
      imported.forEach((c) => {
        if (!merged.some((m) => m.id === c.id)) merged.push(c);
      });
      return merged.sort((a, b) => a.name.localeCompare(b.name));
    });
    for (const c of imported) {
      if (!isMember(c.id)) {
        await toggleMember(c);
      }
    }
  };

  const handleDeleteGroup = () => {
    Alert.alert('Delete group?', `This removes "${groupName}" permanently.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('groups').delete().eq('id', id);
          if (error) {
            console.error('Error deleting group:', error);
            return;
          }
          router.back();
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
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={() => router.back()}>
            <Text style={styles.doneText}>Done</Text>
          </TouchableOpacity>
          {isOwner && (
            <TouchableOpacity onPress={handleDeleteGroup}>
              <Text style={styles.deleteText}>Delete</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <View style={styles.titleRow}>
        <Text style={styles.title}>{groupName}</Text>
        <TouchableOpacity
          style={styles.chatButton}
          onPress={() => {
            openGroupChat(id, groupName);
            router.dismissTo('/');
          }}
        >
          <Text style={styles.chatButtonIcon}>💬</Text>
          <Text style={styles.chatButtonText}>Chat</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.eventsSection}>
        <Text style={[styles.sectionLabel, styles.eventsSectionLabel]}>Upcoming</Text>
        {groupEvents.length > 0 ? (
          groupEvents.map((event) => <EventCard key={event.id} event={event} onPress={openEvent} />)
        ) : (
          <Text style={styles.noEventsText}>
            No upcoming Pings tagged to this group yet — when you create one and select just this group to invite
            from, it'll show up here.
          </Text>
        )}
      </View>

      {isOwner ? (
        <View style={styles.sharedRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.sharedTitle}>Shared group</Text>
            <Text style={styles.sharedSubtitle}>
              {isShared ? 'Members can see this group and use it in their own pings' : 'Private — only visible to you'}
            </Text>
          </View>
          <Switch
            value={isShared}
            onValueChange={handleToggleShared}
            trackColor={{ false: colors.border, true: colors.primary }}
            thumbColor={colors.white}
          />
        </View>
      ) : (
        <View style={styles.sharedRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.sharedTitle}>Shared with you</Text>
            <Text style={styles.sharedSubtitle}>
              You can view this group, chat with it, and use it to invite people to your own pings.
            </Text>
          </View>
        </View>
      )}

      <Text style={styles.sectionLabel}>{memberIds.length} in this group</Text>

      {isOwner ? (
        <FlatList
          data={allContacts}
          keyExtractor={(c) => c.id}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingVertical: 12 }}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const member = isMember(item.id);
            return (
              <TouchableOpacity style={styles.contactRow} onPress={() => toggleMember(item)}>
                <Text style={styles.contactName}>{item.name}</Text>
                <View style={[styles.checkbox, member && styles.checkboxChecked]}>
                  {member && <Text style={styles.checkmark}>✓</Text>}
                </View>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            !addingContact ? (
              <Text style={styles.emptyText}>No contacts yet — add one below.</Text>
            ) : null
          }
          ListHeaderComponent={
            <TouchableOpacity style={styles.importRow} onPress={() => setImportVisible(true)}>
              <Text style={styles.importText}>📇 Import from Contacts</Text>
            </TouchableOpacity>
          }
          ListFooterComponent={
            addingContact ? (
              <View style={styles.addContactRow}>
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  placeholder="Name"
                  placeholderTextColor={colors.textMuted}
                  value={newContactName}
                  onChangeText={setNewContactName}
                  autoFocus
                />
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  placeholder="Phone (optional)"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="phone-pad"
                  value={newContactPhone}
                  onChangeText={setNewContactPhone}
                />
                <TouchableOpacity style={styles.addContactButton} onPress={handleAddContact}>
                  <Text style={styles.addContactButtonText}>Add</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity style={styles.addNewRow} onPress={() => setAddingContact(true)}>
                <Text style={styles.addNewText}>+ New contact</Text>
              </TouchableOpacity>
            )
          }
        />
      ) : (
        <FlatList
          data={memberNames}
          keyExtractor={(name, i) => `${name}-${i}`}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingVertical: 12 }}
          renderItem={({ item }) => (
            <View style={styles.contactRow}>
              <Text style={styles.contactName}>{item}</Text>
            </View>
          )}
          ListEmptyComponent={<Text style={styles.emptyText}>No one in this group yet.</Text>}
        />
      )}

      <ImportContactsModal
        visible={importVisible}
        onClose={() => setImportVisible(false)}
        onImported={handleImported}
      />

      <EventDetailModal
        visible={detailVisible}
        eventId={selectedEventId}
        onClose={() => setDetailVisible(false)}
      />
    </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingTop: 60, paddingHorizontal: 20 },
  centered: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  backText: { color: colors.primary, fontSize: 16, fontWeight: '600' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  doneText: { color: colors.primary, fontSize: 16, fontWeight: '700' },
  deleteText: { color: colors.danger, fontSize: 15 },
  title: { color: colors.textPrimary, fontSize: 26, fontWeight: '700' },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 16,
  },
  chatButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chatButtonIcon: { fontSize: 16 },
  chatButtonText: { color: colors.primary, fontWeight: '600', fontSize: 14 },
  sharedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceLight,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 14,
    marginTop: 16,
    gap: 12,
  },
  sharedTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  sharedSubtitle: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  sectionLabel: { color: colors.textSecondary, fontSize: 13, marginTop: 16, marginBottom: 8, textTransform: 'uppercase' },
  // EventCard has its own marginHorizontal:20 (meant for an edge-to-edge
  // list) - this screen's container already has paddingHorizontal:20, so
  // the section itself cancels that out to avoid a doubled 40px inset.
  eventsSection: { marginHorizontal: -20 },
  eventsSectionLabel: { marginHorizontal: 20 },
  noEventsText: { marginHorizontal: 20, color: colors.textMuted, fontSize: 13, lineHeight: 18, fontStyle: 'italic' },
  importRow: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 10,
  },
  importText: { color: colors.primary, fontWeight: '600', fontSize: 14 },
  contactRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  contactName: { color: colors.textPrimary, fontSize: 16 },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkmark: { color: colors.textOnPrimary, fontSize: 14, fontWeight: '700' },
  emptyText: { color: colors.textMuted, textAlign: 'center', marginTop: 40, fontSize: 15 },
  addNewRow: { paddingVertical: 16, alignItems: 'center' },
  addNewText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
  addContactRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
  },
  addContactButton: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  addContactButtonText: { color: colors.textOnPrimary, fontWeight: '600' },
});
