import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  SectionList,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Platform,
  KeyboardAvoidingView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { supabase } from '../../supabase';
import { useAuth } from '../../lib/AuthContext';
import { useNotificationsContext } from '../../lib/NotificationsContext';
import { colors } from '../../lib/theme';
import { canPromptRename, confirmDeleteGroup, promptRenameGroup } from '../../lib/groups';

type Group = {
  id: string;
  name: string;
  is_shared: boolean;
  memberCount: number;
  isOwner: boolean;
  ownerName?: string | null;
};

export default function GroupsScreen() {
  const { session } = useAuth();
  const router = useRouter();
  const { openGroupChat } = useNotificationsContext();

  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');

  // No owner_id filter here - RLS is what actually decides which rows come
  // back (groups you own, plus ones someone else marked shared and added
  // you to), so this reads as one list instead of two separate queries.
  const fetchGroups = useCallback(async () => {
    if (!session?.user?.id) return;

    const { data, error } = await supabase
      .from('groups')
      .select('id, name, owner_id, is_shared, group_members(contact_id)')
      .order('name');

    if (error) {
      console.error('Error fetching groups:', error);
      return;
    }

    // Whose each shared group is - two groups can have the same name (one
    // of yours, one someone shared with you), and this tells them apart.
    const otherOwnerIds = Array.from(
      new Set((data || []).map((g: any) => g.owner_id).filter((oid: string) => oid !== session.user.id))
    );
    const ownerNames: Record<string, string> = {};
    if (otherOwnerIds.length > 0) {
      const { data: owners } = await supabase.from('profiles').select('id, full_name').in('id', otherOwnerIds);
      (owners || []).forEach((o: any) => {
        if (o.full_name) ownerNames[o.id] = o.full_name;
      });
    }

    setGroups(
      (data || []).map((g: any) => ({
        id: g.id,
        name: g.name,
        is_shared: g.is_shared,
        memberCount: (g.group_members || []).length,
        isOwner: g.owner_id === session.user.id,
        ownerName: ownerNames[g.owner_id] || null,
      }))
    );
  }, [session?.user?.id]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      fetchGroups().finally(() => setLoading(false));
    }, [fetchGroups])
  );

  const handleCreateGroup = async () => {
    if (!newGroupName.trim() || !session?.user?.id) return;

    const { data, error } = await supabase
      .from('groups')
      .insert([{ owner_id: session.user.id, name: newGroupName.trim() }])
      .select()
      .single();

    if (error) {
      console.error('Error creating group:', error);
      return;
    }

    setNewGroupName('');
    setCreating(false);
    await fetchGroups();
    router.push(`/groups/${data.id}`);
  };

  // Press and hold one of your own groups to rename or delete it.
  const showGroupActions = (group: Group) => {
    if (!group.isOwner) {
      Alert.alert(
        group.name,
        `${group.ownerName || 'Someone'} shared this group with you, so only they can rename or delete it.`
      );
      return;
    }
    Alert.alert(group.name, undefined, [
      {
        text: 'Rename',
        onPress: async () => {
          if (!canPromptRename) {
            router.push(`/groups/${group.id}`);
            return;
          }
          if (await promptRenameGroup(group.id, group.name)) fetchGroups();
        },
      },
      {
        text: 'Delete group',
        style: 'destructive',
        onPress: async () => {
          if (await confirmDeleteGroup(group.id, group.name)) fetchGroups();
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const ownedGroups = groups.filter((g) => g.isOwner);
  const sharedGroups = groups.filter((g) => !g.isOwner);
  // Only bother splitting into sections (with headers) once there's
  // actually something shared to distinguish from - otherwise this reads
  // exactly like the old flat list.
  const sections =
    sharedGroups.length > 0
      ? [
          { title: 'Your groups', data: ownedGroups },
          { title: 'Shared with you', data: sharedGroups },
        ]
      : ownedGroups.length > 0
        ? [{ title: '', data: ownedGroups }]
        // No sections at all (not one empty one) - SectionList counts a
        // section's header/footer as items, so it never showed
        // ListEmptyComponent and the screen was blank.
        : [];

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.pageTitle}>Groups</Text>
        <TouchableOpacity onPress={() => setCreating(true)}>
          <Text style={styles.newText}>+ New</Text>
        </TouchableOpacity>
      </View>

      {creating && (
        <View style={styles.createRow}>
          <TextInput
            style={styles.input}
            placeholder="Group name (e.g. Pickleball)"
            placeholderTextColor={colors.textMuted}
            value={newGroupName}
            onChangeText={setNewGroupName}
            autoFocus
            onSubmitEditing={handleCreateGroup}
          />
          <TouchableOpacity style={styles.createButton} onPress={handleCreateGroup}>
            <Text style={styles.createButtonText}>Create</Text>
          </TouchableOpacity>
        </View>
      )}

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(g) => g.id}
          contentContainerStyle={{ paddingVertical: 12 }}
          keyboardShouldPersistTaps="handled"
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) =>
            section.title ? <Text style={styles.sectionTitle}>{section.title}</Text> : null
          }
          renderItem={({ item }) => (
            <View style={styles.groupCard}>
              <TouchableOpacity
                style={{ flex: 1 }}
                onPress={() => router.push(`/groups/${item.id}`)}
                onLongPress={() => showGroupActions(item)}
                delayLongPress={400}
              >
                <Text style={styles.groupName}>{item.name}</Text>
                <Text style={styles.groupMeta}>
                  {item.memberCount} {item.memberCount === 1 ? 'member' : 'members'}
                  {!item.isOwner && item.ownerName ? ` · Shared by ${item.ownerName}` : ''}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.chatButton}
                onPress={() => {
                  openGroupChat(item.id, item.name);
                  router.dismissTo('/');
                }}
              >
                <Text style={styles.chatButtonIcon}>💬</Text>
              </TouchableOpacity>
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No groups yet — tap + New to create one.</Text>
          }
          ListFooterComponent={
            ownedGroups.length > 0 ? (
              <Text style={styles.hintText}>Press and hold one of your groups to rename or delete it.</Text>
            ) : null
          }
        />
      )}
    </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingTop: 60, paddingHorizontal: 20 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  backText: { color: colors.primary, fontSize: 16, fontWeight: '600' },
  pageTitle: { color: colors.textPrimary, fontSize: 20, fontWeight: '700' },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginTop: 12,
    marginBottom: 6,
  },
  newText: { color: colors.primary, fontSize: 16, fontWeight: '600' },
  createRow: { flexDirection: 'row', gap: 8, marginTop: 16 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
  },
  createButton: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  createButtonText: { color: colors.textOnPrimary, fontWeight: '600' },
  groupCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    gap: 12,
  },
  groupName: { color: colors.textPrimary, fontSize: 17, fontWeight: '700', marginBottom: 4 },
  groupMeta: { color: colors.textSecondary, fontSize: 13 },
  hintText: { color: colors.textMuted, fontSize: 12, fontStyle: 'italic', textAlign: 'center', marginTop: 16 },
  chatButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatButtonIcon: { fontSize: 18 },
  emptyText: { color: colors.textMuted, textAlign: 'center', marginTop: 60, fontSize: 15 },
});
