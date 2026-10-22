import { Alert } from 'react-native';
import { supabase } from '../supabase';

// Editing and deleting your own chat messages - event chats ('messages')
// and group chats ('group_messages') alike. The database only lets a sender
// change their own message's text (see supabase/message_edit_delete.sql);
// it stamps edited_at itself, and a delete wipes the text and keeps the row
// as "Message deleted".

export type ChatTable = 'messages' | 'group_messages';

export async function saveMessageEdit(table: ChatTable, id: string, body: string): Promise<boolean> {
  const { error } = await supabase.from(table).update({ body }).eq('id', id);
  if (error) {
    console.error('Error editing message:', error);
    Alert.alert("Couldn't save your edit", 'Check your connection and try again.');
    return false;
  }
  return true;
}

export function confirmDeleteMessage(table: ChatTable, id: string, onDeleted: () => void) {
  Alert.alert('Delete this message?', 'It will say "Message deleted" for everyone in the chat.', [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Delete',
      style: 'destructive',
      onPress: async () => {
        const { error } = await supabase
          .from(table)
          .update({ deleted_at: new Date().toISOString(), body: '' })
          .eq('id', id);
        if (error) {
          console.error('Error deleting message:', error);
          Alert.alert("Couldn't delete it", 'Check your connection and try again.');
          return;
        }
        onDeleted();
      },
    },
  ]);
}

// Columns every chat query needs, so edits and deletes show up.
export const CHAT_MESSAGE_COLUMNS = 'body, created_at, edited_at, deleted_at';
