import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ScrollView,
  KeyboardAvoidingView,
  Alert,
} from 'react-native';
import { supabase } from '../supabase';
import { useAuth } from '../lib/AuthContext';
import { findOrCreateContact, healContactLink, getAlreadyInvitedPhones, normalizePhone } from '../lib/phone';
import { colors } from '../lib/theme';
import { notify } from '../lib/notify';
import ImportContactsModal from './ImportContactsModal';
import NonAppInviteQueue, { QueueContact } from './NonAppInviteQueue';

type Contact = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  linked_user_id: string | null;
};

type Props = {
  visible: boolean;
  eventId: string;
  eventTitle?: string;
  eventDate?: string;
  location?: string;
  onClose: () => void;
  onInvited: () => void;
};

export default function ShareInviteModal({
  visible,
  eventId,
  eventTitle,
  eventDate,
  location,
  onClose,
  onInvited,
}: Props) {
  const { session } = useAuth();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [addingContact, setAddingContact] = useState(false);
  const [newContactName, setNewContactName] = useState('');
  const [newContactPhone, setNewContactPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [importVisible, setImportVisible] = useState(false);
  const [queueContacts, setQueueContacts] = useState<QueueContact[]>([]);
  const [queueVisible, setQueueVisible] = useState(false);

  useEffect(() => {
    if (visible && session?.user?.id) {
      loadContacts();
      setSelectedIds([]);
    }
  }, [visible, session?.user?.id]);

  const loadContacts = async () => {
    const { data, error } = await supabase
      .from('contacts')
      .select('id, name, phone, email, linked_user_id')
      .eq('owner_id', session!.user.id)
      .order('name');

    if (error) console.error('Error loading contacts:', error);
    setContacts(data || []);
  };

  const toggle = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  };

  const handleAddContact = async () => {
    if (!newContactName.trim() || !session?.user?.id) return;

    try {
      const { contact, wasExisting } = await findOrCreateContact(
        supabase,
        session.user.id,
        newContactName.trim(),
        newContactPhone
      );

      setContacts((prev) => {
        if (wasExisting && prev.some((c) => c.id === contact.id)) return prev;
        return [...prev, contact].sort((a, b) => a.name.localeCompare(b.name));
      });
      setSelectedIds((prev) => (prev.includes(contact.id) ? prev : [...prev, contact.id]));

      if (wasExisting) {
        Alert.alert('Already in your contacts', `Matched to existing contact "${contact.name}" by phone number.`);
      }
    } catch (err) {
      console.error(err);
      Alert.alert('Error', 'Could not add contact.');
      return;
    }

    setNewContactName('');
    setNewContactPhone('');
    setAddingContact(false);
  };

  const handleImported = (imported: Contact[]) => {
    setImportVisible(false);
    setContacts((prev) => {
      const merged = [...prev];
      imported.forEach((c) => {
        if (!merged.some((m) => m.id === c.id)) merged.push(c);
      });
      return merged.sort((a, b) => a.name.localeCompare(b.name));
    });
    setSelectedIds((prev) => Array.from(new Set([...prev, ...imported.map((c) => c.id)])));
  };

  const handleSendInvites = async () => {
    if (selectedIds.length === 0) {
      onClose();
      return;
    }
    setSubmitting(true);

    const alreadyInvitedPhones = await getAlreadyInvitedPhones(supabase, eventId);

    const toInvite: string[] = [];
    const skippedNames: string[] = [];
    for (const cid of selectedIds) {
      const contact = contacts.find((c) => c.id === cid);
      const phone = normalizePhone(contact?.phone);
      if (phone && alreadyInvitedPhones.has(phone)) {
        skippedNames.push(contact?.name || 'Someone');
      } else {
        toInvite.push(cid);
        if (phone) alreadyInvitedPhones.add(phone);
      }
    }

    if (toInvite.length === 0) {
      setSubmitting(false);
      Alert.alert('Already invited', `${skippedNames.join(', ')} ${skippedNames.length === 1 ? 'is' : 'are'} already on this event.`);
      return;
    }

    // Re-check each contact's account link right before inviting — see the
    // matching comment in CreateEventModal.
    const healedContacts = await Promise.all(
      toInvite.map(async (cid) => {
        const contact = contacts.find((c) => c.id === cid);
        return contact ? healContactLink(supabase, contact) : contact;
      })
    );
    const rows = toInvite.map((cid, i) => {
      const contact = healedContacts[i];
      return {
        event_id: eventId,
        contact_id: cid,
        user_id: contact?.linked_user_id || null,
        rsvp_status: 'pending',
        invited_via: contact?.linked_user_id ? 'app' : contact?.phone ? 'sms' : 'email',
      };
    });

    const { data: insertedInvitees, error } = await supabase.from('invitees').insert(rows).select();
    setSubmitting(false);

    if (error) {
      console.error('Error sharing invite:', error);
      Alert.alert('Error', 'Something went wrong sending invites.');
      return;
    }

    const notifiableUserIds = rows.map((r) => r.user_id).filter(Boolean);
    await notify(notifiableUserIds, "You're invited! 🎉", `${eventTitle || 'An event'} — tap to view and RSVP`, {
      eventId,
      type: 'invite',
    });

    let smsQueueItems: QueueContact[] = [];
    if (eventDate) {
      smsQueueItems = (insertedInvitees || [])
        .filter((r) => r.invited_via === 'sms' && r.contact_id)
        .map((r) => {
          const contact = healedContacts.find((c) => c?.id === r.contact_id);
          return contact?.phone ? { inviteeId: r.id, name: contact.name, phone: contact.phone } : null;
        })
        .filter((c): c is QueueContact => !!c);
    }

    if (skippedNames.length > 0) {
      Alert.alert(
        'Some were already invited',
        `${skippedNames.join(', ')} ${skippedNames.length === 1 ? 'was' : 'were'} skipped since they already had an invite.`
      );
    }

    // Same-app-only invites skip straight to onInvited (unchanged flow) -
    // the queue only interrupts when there's actually someone to text.
    if (smsQueueItems.length > 0) {
      setQueueContacts(smsQueueItems);
      setQueueVisible(true);
    } else {
      onInvited();
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.handle} />
          <Text style={styles.header}>Invite others</Text>
          <Text style={styles.subheader}>This event is shareable — anyone invited can pass it along.</Text>

          <TouchableOpacity style={styles.importRow} onPress={() => setImportVisible(true)}>
            <Text style={styles.importText}>📇 Import from Contacts</Text>
          </TouchableOpacity>

          <ScrollView contentContainerStyle={{ paddingBottom: 12 }} keyboardShouldPersistTaps="handled">
            <View style={styles.chipRow}>
              {contacts.map((c) => (
                <TouchableOpacity
                  key={c.id}
                  style={[styles.chip, selectedIds.includes(c.id) && styles.chipSelected]}
                  onPress={() => toggle(c.id)}
                >
                  <Text style={[styles.chipText, selectedIds.includes(c.id) && styles.chipTextSelected]}>
                    {c.name}
                  </Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity style={styles.addChip} onPress={() => setAddingContact(true)}>
                <Text style={styles.addChipText}>+ New</Text>
              </TouchableOpacity>
            </View>

            {addingContact && (
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
            )}

            {contacts.length === 0 && !addingContact && (
              <Text style={styles.helperText}>No contacts yet — tap "+ New" or import from your phone.</Text>
            )}
          </ScrollView>

          <View style={styles.footer}>
            <TouchableOpacity style={[styles.footerButton, styles.cancelButton]} onPress={onClose}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.footerButton, styles.sendButton]}
              onPress={handleSendInvites}
              disabled={submitting}
            >
              <Text style={styles.sendButtonText}>
                {submitting ? 'Sending...' : `Invite${selectedIds.length ? ` (${selectedIds.length})` : ''}`}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
      </KeyboardAvoidingView>

      <ImportContactsModal
        visible={importVisible}
        onClose={() => setImportVisible(false)}
        onImported={handleImported}
      />

      <NonAppInviteQueue
        visible={queueVisible}
        contacts={queueContacts}
        eventTitle={eventTitle || 'An event'}
        eventDate={new Date(eventDate || Date.now())}
        location={location || ''}
        onDone={() => setQueueVisible(false)}
        onClosed={onInvited}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(43,43,43,0.4)' },
  card: { maxHeight: '75%', backgroundColor: colors.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20 },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 12 },
  header: { fontSize: 20, fontWeight: '700', color: colors.textPrimary, marginBottom: 4 },
  subheader: { color: colors.textSecondary, fontSize: 13, marginBottom: 12 },
  importRow: { backgroundColor: colors.surfaceAlt, borderRadius: 10, paddingVertical: 10, alignItems: 'center', marginBottom: 10 },
  importText: { color: colors.primary, fontWeight: '600', fontSize: 14 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.surface,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.textSecondary, fontSize: 14 },
  chipTextSelected: { color: colors.textOnPrimary, fontWeight: '600' },
  addChip: {
    borderWidth: 1,
    borderColor: colors.primary,
    borderStyle: 'dashed',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  addChipText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  helperText: { color: colors.textMuted, fontSize: 13, marginTop: 12, fontStyle: 'italic' },
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
  addContactButton: { backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 16, justifyContent: 'center' },
  addContactButtonText: { color: colors.textOnPrimary, fontWeight: '600' },
  footer: { flexDirection: 'row', gap: 12, marginTop: 16 },
  footerButton: { flex: 1, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  cancelButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  cancelButtonText: { color: colors.textPrimary, fontWeight: '600', fontSize: 15 },
  sendButton: { backgroundColor: colors.primary },
  sendButtonText: { color: colors.textOnPrimary, fontWeight: '700', fontSize: 15 },
});
