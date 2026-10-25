import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { colors } from '../lib/theme';

// The host's "add something to bring" controls - shared by New Event, Edit,
// and the event screen. Two plain choices (2026-10-24):
// - Guests add what they're bringing: one tap, nothing to name. Each guest
//   adds as many things as they like ("Pickles", "Watermelon"). A host had
//   made four "Side" categories just so they could list four dishes.
// - A specific item: "Chips x 2", guests tap to take one.

type Mode = 'open' | 'specific';

// The name of the open list - what guests see as its heading.
export const OPEN_LIST_NAME = "Anything you'd like to bring";

// How an item on the host's list reads, so it's clear how guests sign up.
export function bringItemSummary(allowCustom: boolean, qty: number): string {
  if (allowCustom) return "Guests add what they're bringing";
  return qty > 1 ? `${qty} needed` : '1 needed';
}

type Props = {
  onAdd: (name: string, qty: number, allowCustom: boolean) => void | Promise<void>;
  // Whether the event already has a write-in list (any allow_custom item),
  // so the open-list button shows it's on instead of adding a second.
  hasOpenList?: boolean;
  onInputFocus?: () => void;
};

export default function BringItemAdder({ onAdd, hasOpenList = false, onInputFocus }: Props) {
  const [mode, setMode] = useState<Mode>(hasOpenList ? 'specific' : 'open');
  const [name, setName] = useState('');
  const [qty, setQty] = useState(1);

  const add = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await onAdd(trimmed, qty, false);
    setName('');
    setQty(1);
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.question}>How should guests sign up?</Text>
      <View style={styles.modeRow}>
        <TouchableOpacity
          style={[styles.modeCard, mode === 'open' && styles.modeCardOn]}
          onPress={() => setMode('open')}
          accessibilityRole="radio"
          accessibilityState={{ selected: mode === 'open' }}
        >
          <Text style={[styles.modeTitle, mode === 'open' && styles.modeTitleOn]}>Guests say what they'll bring</Text>
          <Text style={styles.modeExample}>{'Each guest adds their own, like "Pickles"'}</Text>
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

      {mode === 'open' ? (
        hasOpenList ? (
          <Text style={styles.openOn}>✓ Guests can add what they're bringing</Text>
        ) : (
          <TouchableOpacity style={styles.openButton} onPress={() => onAdd(OPEN_LIST_NAME, 1, true)}>
            <Text style={styles.openButtonText}>Let guests add what they're bringing</Text>
          </TouchableOpacity>
        )
      ) : (
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            placeholder='Item, like "Chips"'
            placeholderTextColor={colors.textMuted}
            value={name}
            onChangeText={setName}
            onFocus={onInputFocus}
            returnKeyType="done"
            onSubmitEditing={add}
          />
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
          <TouchableOpacity
            style={[styles.addButton, !name.trim() && styles.addButtonOff]}
            onPress={add}
            disabled={!name.trim()}
          >
            <Text style={styles.addButtonText}>Add</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 10 },
  question: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
  },
  modeRow: { flexDirection: 'row', gap: 10 },
  modeCard: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 10,
    backgroundColor: colors.surface,
  },
  modeCardOn: {
    borderColor: colors.primary,
    backgroundColor: colors.background,
  },
  modeTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: '700' },
  modeTitleOn: { color: colors.primary },
  modeExample: { color: colors.textSecondary, fontSize: 12, marginTop: 3 },
  openButton: {
    marginTop: 12,
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  openButtonText: {
    color: colors.textOnPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  openOn: {
    marginTop: 12,
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
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
  stepText: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '600',
    marginTop: -2,
  },
  stepValue: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
    minWidth: 18,
    textAlign: 'center',
  },
  addButton: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  addButtonOff: { opacity: 0.5 },
  addButtonText: {
    color: colors.textOnPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
});
