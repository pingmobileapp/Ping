import React, { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors } from '../lib/theme';

type Props = {
  dayKey: string | null;
  initialBody: string;
  onClose: (body: string) => void;
};

// The expanded view of one day's note from Week view's notes bar - opened
// by tapping that day's bar, closed with Done or by tapping outside. Hands
// the text back on close so the caller saves it; nothing is lost by
// dismissing without Done.
export default function DayNoteModal({ dayKey, initialBody, onClose }: Props) {
  const [body, setBody] = useState(initialBody);

  useEffect(() => {
    if (dayKey) setBody(initialBody);
  }, [dayKey, initialBody]);

  const title = dayKey
    ? new Date(`${dayKey}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    : '';

  return (
    <Modal visible={!!dayKey} transparent animationType="fade" onRequestClose={() => onClose(body)}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={() => onClose(body)}>
          <Pressable style={styles.card} onPress={() => {}}>
            <View style={styles.header}>
              <Text style={styles.title}>{title}</Text>
              <TouchableOpacity onPress={() => onClose(body)} hitSlop={8}>
                <Text style={styles.done}>Done</Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.input}
              value={body}
              onChangeText={setBody}
              placeholder="Notes, to-dos, reminders for this day"
              placeholderTextColor={colors.textMuted}
              multiline
              autoFocus={!initialBody}
              textAlignVertical="top"
            />
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(43,43,43,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    width: '100%',
    maxWidth: 500,
    backgroundColor: colors.background,
    borderRadius: 16,
    padding: 16,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  title: { color: colors.textPrimary, fontSize: 17, fontWeight: '700', flexShrink: 1 },
  done: { color: colors.primary, fontSize: 16, fontWeight: '700', marginLeft: 12 },
  input: {
    minHeight: 220,
    maxHeight: 400,
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    color: colors.textPrimary,
  },
});
