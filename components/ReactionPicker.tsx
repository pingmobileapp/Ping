import React, { useEffect, useRef, useState } from 'react';
import { Dimensions, Modal, StyleSheet, Text, TextInput, TouchableOpacity, View, ViewStyle } from 'react-native';
import { colors } from '../lib/theme';
import { BubbleAnchor } from './MessageBubble';

// iMessage's six default tapbacks, plus a "+" that switches to a text
// field for picking any emoji via the device's own keyboard (its emoji
// picker already covers this well - no need for a custom in-app grid or a
// new dependency just to duplicate it).
const REACTIONS = ['❤️', '👍', '👎', '😂', '‼️', '❓'];
const PICKER_HEIGHT = 60;
const PICKER_GAP = 10;
const SCREEN_MARGIN = 12;
const CUSTOM_PICKER_WIDTH = 220;

type Props = {
  visible: boolean;
  anchor: BubbleAnchor | null;
  onSelect: (emoji: string) => void;
  onClose: () => void;
};

export default function ReactionPicker({ visible, anchor, onSelect, onClose }: Props) {
  const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
  const [customMode, setCustomMode] = useState(false);
  const [customEmoji, setCustomEmoji] = useState('');
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!visible) {
      setCustomMode(false);
      setCustomEmoji('');
    }
  }, [visible]);

  const submitCustom = () => {
    const trimmed = customEmoji.trim();
    if (!trimmed) return;
    onSelect(trimmed);
    onClose();
  };

  let pickerStyle: ViewStyle | null = null;
  if (anchor) {
    const pickerWidth = customMode
      ? CUSTOM_PICKER_WIDTH
      : Math.min(screenWidth - SCREEN_MARGIN * 2, (REACTIONS.length + 1) * 44 + 16);
    const left = Math.max(
      SCREEN_MARGIN,
      Math.min(anchor.x + anchor.width / 2 - pickerWidth / 2, screenWidth - pickerWidth - SCREEN_MARGIN)
    );

    // Prefers appearing above the bubble (matches where a thumb naturally
    // isn't covering it); falls back to below when there's no room, e.g.
    // near the top of the thread.
    const fitsAbove = anchor.y - PICKER_HEIGHT - PICKER_GAP > SCREEN_MARGIN;
    const top = fitsAbove
      ? anchor.y - PICKER_HEIGHT - PICKER_GAP
      : Math.min(anchor.y + anchor.height + PICKER_GAP, screenHeight - PICKER_HEIGHT - SCREEN_MARGIN);

    pickerStyle = { position: 'absolute', left, top, width: pickerWidth };
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        {pickerStyle && !customMode && (
          <View style={[styles.picker, pickerStyle]}>
            {REACTIONS.map((emoji) => (
              <TouchableOpacity
                key={emoji}
                style={styles.emojiButton}
                onPress={() => {
                  onSelect(emoji);
                  onClose();
                }}
              >
                <Text style={styles.emojiText}>{emoji}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={styles.emojiButton}
              onPress={() => {
                setCustomMode(true);
                setTimeout(() => inputRef.current?.focus(), 50);
              }}
            >
              <Text style={styles.plusText}>+</Text>
            </TouchableOpacity>
          </View>
        )}
        {pickerStyle && customMode && (
          <TouchableOpacity activeOpacity={1} style={[styles.picker, styles.customPicker, pickerStyle]}>
            <TextInput
              ref={inputRef}
              style={styles.customInput}
              value={customEmoji}
              onChangeText={setCustomEmoji}
              placeholder="Pick an emoji"
              placeholderTextColor={colors.textMuted}
              returnKeyType="done"
              onSubmitEditing={submitCustom}
              autoFocus
            />
            <TouchableOpacity
              style={[styles.customConfirm, !customEmoji.trim() && styles.customConfirmDisabled]}
              onPress={submitCustom}
              disabled={!customEmoji.trim()}
            >
              <Text style={styles.customConfirmText}>✓</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        )}
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(43,43,43,0.35)' },
  picker: {
    flexDirection: 'row',
    backgroundColor: colors.background,
    borderRadius: 30,
    paddingHorizontal: 6,
    paddingVertical: 6,
    gap: 2,
    shadowColor: colors.textPrimary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 10,
    elevation: 10,
  },
  emojiButton: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiText: { fontSize: 24 },
  plusText: { fontSize: 24, color: colors.primary, fontWeight: '700' },
  customPicker: { alignItems: 'center', paddingHorizontal: 10 },
  customInput: {
    flex: 1,
    height: 40,
    fontSize: 18,
    color: colors.textPrimary,
  },
  customConfirm: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  customConfirmDisabled: { backgroundColor: colors.border },
  customConfirmText: { color: colors.textOnPrimary, fontSize: 16, fontWeight: '700' },
});
