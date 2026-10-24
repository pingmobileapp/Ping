import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { colors } from '../lib/theme';

// The host's "add something to bring" controls - shared by New Event, Edit,
// and the event screen. Asked for 2026-10-24 after a host couldn't work out
// how to let guests say which side dish they're bringing: that used to be a
// small checkbox above the item box that only applied if ticked *before*
// typing. Now the two kinds are a plain choice with examples, and the common
// potluck categories are one tap.

type Mode = 'choose' | 'specific';

// One tap adds each as a "guests choose" item.
const POTLUCK_PRESETS = ['Side dish', 'Dessert', 'Appetizer', 'Drinks'];

// How an item on the host's list reads, so it's clear how guests sign up.
export function bringItemSummary(allowCustom: boolean, qty: number): string {
  if (allowCustom) return 'Guests write in what they bring';
  return qty > 1 ? `${qty} needed` : '1 needed';
}

type Props = {
  onAdd: (name: string, qty: number, allowCustom: boolean) => void | Promise<void>;
  // Names already on the list, so presets that are already added are hidden.
  existingNames?: string[];
  onInputFocus?: () => void;
};

export default function BringItemAdder({ onAdd, existingNames = [], onInputFocus }: Props) {
  const [mode, setMode] = useState<Mode>('choose');
  const [name, setName] = useState('');
  const [qty, setQty] = useState(1);
  const taken = new Set(existingNames.map((n) => n.trim().toLowerCase()));
  const presets = POTLUCK_PRESETS.filter((p) => !taken.has(p.toLowerCase()));

  const add = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await onAdd(trimmed, mode === 'specific' ? qty : 1, mode === 'choose');
    setName('');
    setQty(1);
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.question}>How should guests sign up?</Text>
      <View style={styles.modeRow}>
        <TouchableOpacity
          style={[styles.modeCard, mode === 'choose' && styles.modeCardOn]}
          onPress={() => setMode('choose')}
          accessibilityRole="radio"
          accessibilityState={{ selected: mode === 'choose' }}
        >
          <Text style={[styles.modeTitle, mode === 'choose' && styles.modeTitleOn]}>Guests choose</Text>
          <Text style={styles.modeExample}>{'Side dish → each guest writes "Mac & cheese"'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.modeCard, mode === 'specific' && styles.modeCardOn]}
          onPress={() => setMode('specific')}
          accessibilityRole="radio"
          accessibilityState={{ selected: mode === 'specific' }}
        >
          <Text style={[styles.modeTitle, mode === 'specific' && styles.modeTitleOn]}>A specific item</Text>
          <Text style={styles.modeExample}>Chips × 2 → guests tap to take one</Text>
        </TouchableOpacity>
      </View>

      {mode === 'choose' && presets.length > 0 && (
        <View style={styles.presetRow}>
          {presets.map((p) => (
            <TouchableOpacity key={p} style={styles.preset} onPress={() => onAdd(p, 1, true)}>
              <Text style={styles.presetText}>+ {p}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          placeholder={mode === 'choose' ? 'Or type your own, like "Salad"' : 'Item, like "Chips"'}
          placeholderTextColor={colors.textMuted}
          value={name}
          onChangeText={setName}
          onFocus={onInputFocus}
          returnKeyType="done"
          onSubmitEditing={add}
        />
        {mode === 'specific' && (
          <View style={styles.stepper}>
            <TouchableOpacity
              style={styles.stepButton}
              onPress={() => setQty((q) => Math.max(1, q - 1))}
              accessibilityLabel="Fewer"
            >
              <Text style={styles.stepText}>–</Text>
            </TouchableOpacity>
            <Text style={styles.stepValue}>{qty}</Text>
            <TouchableOpacity
              style={styles.stepButton}
              onPress={() => setQty((q) => Math.min(99, q + 1))}
              accessibilityLabel="More"
            >
              <Text style={styles.stepText}>+</Text>
            </TouchableOpacity>
          </View>
        )}
        <TouchableOpacity
          style={[styles.addButton, !name.trim() && styles.addButtonOff]}
          onPress={add}
          disabled={!name.trim()}
        >
          <Text style={styles.addButtonText}>Add</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 10 },
  question: { color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 8 },
  modeRow: { flexDirection: 'row', gap: 10 },
  modeCard: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 10,
    backgroundColor: colors.surface,
  },
  modeCardOn: { borderColor: colors.primary, backgroundColor: colors.background },
  modeTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: '700' },
  modeTitleOn: { color: colors.primary },
  modeExample: { color: colors.textSecondary, fontSize: 12, marginTop: 3 },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  preset: {
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  presetText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  input: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.textPrimary,
  },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: { color: colors.textPrimary, fontSize: 18, fontWeight: '600', marginTop: -2 },
  stepValue: { color: colors.textPrimary, fontSize: 15, fontWeight: '700', minWidth: 18, textAlign: 'center' },
  addButton: { backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  addButtonOff: { opacity: 0.5 },
  addButtonText: { color: colors.textOnPrimary, fontSize: 15, fontWeight: '700' },
});
