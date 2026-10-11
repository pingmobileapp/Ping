import { Alert, Platform } from 'react-native';
import { supabase } from '../supabase';

// Rename/delete for groups you own, shared by the Groups list (press and
// hold a group) and the group's own screen. Asked for after a host ended up
// with two "Willhite Family" groups - his own, plus one shared with him -
// and couldn't find how to remove his.

// Deleting removes the group, its member list, and its group chat (all
// ON DELETE CASCADE); Pings that were tagged to it stay, just untagged
// (events.group_id is ON DELETE SET NULL), and the people stay in your
// contacts. Resolves true once deleted.
export function confirmDeleteGroup(groupId: string, groupName: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      `Delete "${groupName}"?`,
      "The group and its group chat are removed for everyone in it. Your Pings and contacts aren't affected. This can't be undone.",
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        {
          text: 'Delete group',
          style: 'destructive',
          onPress: async () => {
            const { error } = await supabase.from('groups').delete().eq('id', groupId);
            if (error) {
              console.error('Error deleting group:', error);
              Alert.alert("Couldn't delete", 'Check your connection and try again.');
              resolve(false);
              return;
            }
            resolve(true);
          },
        },
      ]
    );
  });
}

export async function renameGroup(groupId: string, name: string): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const { error } = await supabase.from('groups').update({ name: trimmed }).eq('id', groupId);
  if (error) {
    console.error('Error renaming group:', error);
    Alert.alert("Couldn't rename", 'Check your connection and try again.');
    return false;
  }
  return true;
}

// iOS has a built-in text prompt; Android doesn't, so callers fall back to
// the group's own screen (tap its name to rename there).
export const canPromptRename = Platform.OS === 'ios';

export function promptRenameGroup(groupId: string, currentName: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.prompt(
      'Rename group',
      undefined,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Save', onPress: async (value?: string) => resolve(await renameGroup(groupId, value || '')) },
      ],
      'plain-text',
      currentName
    );
  });
}
