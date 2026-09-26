import React, { useEffect, useRef, useState } from 'react';
import { LayoutAnimation, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { colors } from '../lib/theme';
import { NoteItem, parseNoteItems, serializeNoteItems } from '../lib/dayNotes';

type Item = NoteItem & { id: number };

type Props = {
  dayKey: string;
  body: string;
  maxHeight: number;
  onChange: (body: string) => void;
  onClose: () => void;
};

let nextId = 0;
const withIds = (items: NoteItem[]): Item[] => items.map((i) => ({ ...i, id: nextId++ }));

// Week view's expanded day note, shown in place under the date row when that
// day's notes bar is tapped - a to-do checklist. Checking an item sends it to
// the bottom; unchecking brings it back up with the other open items.
export default function DayNoteChecklist({ dayKey, body, maxHeight, onChange, onClose }: Props) {
  const [items, setItems] = useState<Item[]>(() => withIds(parseNoteItems(body)));
  const [draft, setDraft] = useState('');
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const draftRef = useRef(draft);
  const draftInputRef = useRef<TextInput>(null);
  draftRef.current = draft;

  // Only re-read the stored note when switching days - re-parsing on every
  // save round-trip would reset text the user is in the middle of typing.
  useEffect(() => {
    setItems(withIds(parseNoteItems(body)));
    setDraft('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey]);

  // Refs are updated right away, not on the next render, so a blur and a
  // Close tap landing back to back never read stale items or add a draft twice.
  const commit = (next: Item[]) => {
    itemsRef.current = next;
    setItems(next);
    onChange(serializeNoteItems(next));
  };

  const toggle = (id: number) => {
    const current = itemsRef.current;
    const target = current.find((i) => i.id === id);
    if (!target) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    const rest = current.filter((i) => i.id !== id);
    const open = rest.filter((i) => !i.done);
    const done = rest.filter((i) => i.done);
    const flipped = { ...target, done: !target.done };
    commit(flipped.done ? [...open, ...done, flipped] : [...open, flipped, ...done]);
  };

  const withDraft = (current: Item[]): Item[] => {
    const text = draftRef.current.trim();
    if (!text) return current;
    const open = current.filter((i) => !i.done);
    const done = current.filter((i) => i.done);
    return [...open, { id: nextId++, text, done: false }, ...done];
  };

  const addDraft = () => {
    if (!draftRef.current.trim()) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    commit(withDraft(itemsRef.current));
    draftRef.current = '';
    setDraft('');
    // The input can be ahead of React's last render (fast typing), in which
    // case setDraft('') is a no-op for the native view - clear it directly.
    draftInputRef.current?.clear();
  };

  // Edited-to-empty items are dropped once the user leaves that field.
  const finishEdit = () => commit(itemsRef.current.filter((i) => i.text.trim()));

  const close = () => {
    const next = withDraft(itemsRef.current).filter((i) => i.text.trim());
    onChange(serializeNoteItems(next));
    onClose();
  };

  const title = new Date(`${dayKey}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);

  const renderItem = (item: Item) => (
    <View key={item.id} style={styles.row}>
      <Pressable
        onPress={() => toggle(item.id)}
        hitSlop={10}
        style={[styles.bubble, item.done && styles.bubbleDone]}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: item.done }}
        accessibilityLabel={item.text}
      >
        {item.done && <Text style={styles.check}>✓</Text>}
      </Pressable>
      <TextInput
        style={[styles.itemText, item.done && styles.itemTextDone]}
        value={item.text}
        onChangeText={(text) => {
          const next = itemsRef.current.map((i) => (i.id === item.id ? { ...i, text } : i));
          itemsRef.current = next;
          setItems(next);
        }}
        onEndEditing={finishEdit}
        returnKeyType="done"
      />
    </View>
  );

  return (
    <View style={[styles.panel, { maxHeight }]}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        <TouchableOpacity onPress={close} hitSlop={8}>
          <Text style={styles.close}>Close</Text>
        </TouchableOpacity>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled">
        {open.map(renderItem)}
        <View style={styles.row}>
          <View style={[styles.bubble, styles.bubbleAdd]}>
            <Text style={styles.plus}>+</Text>
          </View>
          <TextInput
            ref={draftInputRef}
            style={styles.itemText}
            value={draft}
            onChangeText={(text) => {
              draftRef.current = text;
              setDraft(text);
            }}
            onSubmitEditing={(e) => {
              draftRef.current = e.nativeEvent.text;
              addDraft();
            }}
            onEndEditing={addDraft}
            submitBehavior="submit"
            placeholder="Add a to-do"
            placeholderTextColor={colors.textMuted}
            returnKeyType="next"
            autoFocus={items.length === 0}
          />
        </View>
        {done.map(renderItem)}
      </ScrollView>
    </View>
  );
}

const BUBBLE = 22;

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.background,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 6,
    borderWidth: 1,
    borderColor: colors.warning,
    shadowColor: colors.textPrimary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 6,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  title: { color: colors.textPrimary, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  close: { color: colors.primary, fontSize: 15, fontWeight: '700', marginLeft: 12 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7 },
  bubble: {
    width: BUBBLE,
    height: BUBBLE,
    borderRadius: BUBBLE / 2,
    borderWidth: 2,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  bubbleDone: { backgroundColor: colors.primary, borderColor: colors.primary },
  bubbleAdd: { borderStyle: 'dashed' },
  check: { color: colors.textOnPrimary, fontSize: 13, fontWeight: '800' },
  plus: { color: colors.textMuted, fontSize: 14, fontWeight: '700', lineHeight: 16 },
  itemText: { flex: 1, fontSize: 16, color: colors.textPrimary, paddingVertical: 2 },
  itemTextDone: { color: colors.textMuted, textDecorationLine: 'line-through' },
});
