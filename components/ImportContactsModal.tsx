import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
  FlatList,
  KeyboardAvoidingView,
  ActivityIndicator,
  Linking,
} from 'react-native';
import * as Contacts from 'expo-contacts';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../supabase';
import { useAuth } from '../lib/AuthContext';
import { findOrCreateContact } from '../lib/phone';
import { colors } from '../lib/theme';

const CONSENT_KEY = 'ping.contactsUploadConsent.v1';

type DeviceContact = { key: string; name: string; phone: string | null };
type AppContact = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  linked_user_id: string | null;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  onImported: (contacts: AppContact[]) => void;
};

export default function ImportContactsModal({ visible, onClose, onImported }: Props) {
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [limitedAccess, setLimitedAccess] = useState(false);
  const [deviceContacts, setDeviceContacts] = useState<DeviceContact[]>([]);
  const [search, setSearch] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [needsConsent, setNeedsConsent] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setSelectedKeys([]);
    setSearch('');
    setNeedsConsent(false);
    setLoading(true);
    (async () => {
      let consented = false;
      try {
        consented = (await AsyncStorage.getItem(CONSENT_KEY)) === 'yes';
      } catch {}
      if (consented) {
        loadDeviceContacts();
      } else {
        setNeedsConsent(true);
        setLoading(false);
      }
    })();
  }, [visible]);

  const handleConsent = async () => {
    try {
      await AsyncStorage.setItem(CONSENT_KEY, 'yes');
    } catch {}
    setNeedsConsent(false);
    loadDeviceContacts();
  };

  const loadDeviceContacts = async () => {
    setLoading(true);
    setPermissionDenied(false);
    setLimitedAccess(false);

    const permission = await Contacts.requestPermissionsAsync();
    if (permission.status !== 'granted') {
      setPermissionDenied(true);
      setLoading(false);
      return;
    }
    // iOS 18+ "Select Contacts..." grants access to only a hand-picked
    // subset - once chosen, the OS never shows the permission prompt again,
    // so the only way to add more later is through the Settings app.
    if (permission.accessPrivileges === 'limited') {
      setLimitedAccess(true);
    }

    const { data } = await Contacts.getContactsAsync({
      fields: [Contacts.Fields.PhoneNumbers],
      sort: Contacts.SortTypes.FirstName,
    });

    // expo-contacts can hand back duplicate or missing `id`s for a handful
    // of contacts under iOS's limited-access mode - fold the array index
    // into the key so two contacts can never collide and silently fight
    // over the same selection/checkbox state.
    const mapped: DeviceContact[] = data
      .filter((c) => c.name)
      .map((c, idx) => ({
        key: c.id ? `${c.id}-${idx}` : `contact-${idx}-${c.name}`,
        name: c.name!,
        phone: c.phoneNumbers?.[0]?.number || null,
      }));

    setDeviceContacts(mapped);
    setLoading(false);
  };

  const toggle = (key: string) => {
    setSelectedKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const filtered = deviceContacts.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()));

  const handleImport = async () => {
    if (!session?.user?.id || selectedKeys.length === 0) return;
    setImporting(true);

    const toImport = deviceContacts.filter((c) => selectedKeys.includes(c.key));
    const results: AppContact[] = [];

    for (const dc of toImport) {
      try {
        const { contact } = await findOrCreateContact(supabase, session.user.id, dc.name, dc.phone);
        results.push(contact);
      } catch (err) {
        console.error('Error importing contact:', dc.name, err);
      }
    }

    setImporting(false);
    onImported(results);
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
          <Text style={styles.header}>Import from Contacts</Text>

          {needsConsent ? (
            <View style={{ flex: 1 }}>
              <Text style={styles.consentTitle}>Before you import contacts</Text>
              <Text style={styles.consentText}>
                Ping will ask to read your contacts so you can pick people to invite. Your contact list is
                not uploaded.
              </Text>
              <Text style={styles.consentText}>
                Only the contacts you select and import are uploaded to Ping's servers, and only their name
                and phone number.
              </Text>
              <Text style={styles.consentText}>
                We use them to add those people to your events and groups, and to check whether they already
                have a Ping account so you can invite them. Ping does not sell your contacts or use them for
                advertising.
              </Text>
              <Text style={styles.consentText}>
                You can stop at any time. Nothing is uploaded until you tap Import.
              </Text>
            </View>
          ) : loading ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
          ) : permissionDenied ? (
            <View style={{ paddingVertical: 40 }}>
              <Text style={styles.helperText}>
                Contacts access was denied. You can enable it in your phone's Settings for this app,
                or add people manually instead.
              </Text>
            </View>
          ) : (
            <>
              {limitedAccess && (
                <View style={styles.limitedBanner}>
                  <Text style={styles.limitedBannerText}>
                    Only a few contacts are shared with Ping. To pick from your full list, open Settings
                    and choose Contacts → Full Access (or add more people to the shared list).
                  </Text>
                  <TouchableOpacity onPress={() => Linking.openSettings()}>
                    <Text style={styles.limitedBannerLink}>Open Settings</Text>
                  </TouchableOpacity>
                </View>
              )}
              <TextInput
                style={styles.searchInput}
                placeholder="Search contacts"
                placeholderTextColor={colors.textMuted}
                value={search}
                onChangeText={setSearch}
              />
              <FlatList
                data={filtered}
                keyExtractor={(c) => c.key}
                contentContainerStyle={{ paddingBottom: 12 }}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => {
                  const selected = selectedKeys.includes(item.key);
                  return (
                    <TouchableOpacity style={styles.contactRow} onPress={() => toggle(item.key)}>
                      <View>
                        <Text style={styles.contactName}>{item.name}</Text>
                        {!!item.phone && <Text style={styles.contactPhone}>{item.phone}</Text>}
                      </View>
                      <View style={[styles.checkbox, selected && styles.checkboxChecked]}>
                        {selected && <Text style={styles.checkmark}>✓</Text>}
                      </View>
                    </TouchableOpacity>
                  );
                }}
                ListEmptyComponent={<Text style={styles.helperText}>No contacts found.</Text>}
              />
            </>
          )}

          {!needsConsent && !loading && !permissionDenied && (
            <Text style={styles.uploadNote}>
              Importing saves each selected contact's name and phone number to your Ping account.
            </Text>
          )}

          <View style={styles.footer}>
            <TouchableOpacity style={[styles.footerButton, styles.cancelButton]} onPress={onClose}>
              <Text style={styles.cancelButtonText}>{needsConsent ? 'Not now' : 'Cancel'}</Text>
            </TouchableOpacity>
            {needsConsent ? (
              <TouchableOpacity style={[styles.footerButton, styles.importButton]} onPress={handleConsent}>
                <Text style={styles.importButtonText}>Agree & Continue</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.footerButton, styles.importButton]}
                onPress={handleImport}
                disabled={importing || selectedKeys.length === 0}
              >
                <Text style={styles.importButtonText}>
                  {importing ? 'Importing...' : `Import${selectedKeys.length ? ` (${selectedKeys.length})` : ''}`}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(43,43,43,0.4)' },
  card: { height: '80%', backgroundColor: colors.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20 },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 12 },
  header: { fontSize: 20, fontWeight: '700', color: colors.textPrimary, marginBottom: 12 },
  consentTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary, marginBottom: 10 },
  consentText: { color: colors.textSecondary, fontSize: 15, lineHeight: 22, marginBottom: 12 },
  uploadNote: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: 8 },
  helperText: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  limitedBanner: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  limitedBannerText: { color: colors.textSecondary, fontSize: 13, lineHeight: 18, marginBottom: 6 },
  limitedBannerLink: { color: colors.primary, fontSize: 13, fontWeight: '700' },
  searchInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    marginBottom: 10,
  },
  contactRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  contactName: { color: colors.textPrimary, fontSize: 16 },
  contactPhone: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
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
  footer: { flexDirection: 'row', gap: 12, marginTop: 12 },
  footerButton: { flex: 1, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  cancelButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  cancelButtonText: { color: colors.textPrimary, fontWeight: '600', fontSize: 15 },
  importButton: { backgroundColor: colors.primary },
  importButtonText: { color: colors.textOnPrimary, fontWeight: '700', fontSize: 15 },
});
