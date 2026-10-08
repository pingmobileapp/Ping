import React, { useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Pressable } from 'react-native';
import { colors } from '../lib/theme';

const MENU_WIDTH = 200;

// The Upcoming list's everyday filter is just All vs Pings Only. Drafts/
// Declined/Hidden/Important Dates are separate views you visit and leave
// (the list header shows a Done link while one is open), so they live in
// ProfileMenu instead - having all five here made the menu feel busy even
// after it only listed non-empty ones (TestFlight feedback, 1.1.2).
export type ListFilter = 'pingsOnly' | null;
export type HomeView = 'drafts' | 'declined' | 'hidden' | 'important';
export type HomeFilter = ListFilter | HomeView;

export const VIEW_LABELS: Record<HomeView, string> = {
  drafts: 'Drafts',
  declined: 'Declined',
  hidden: 'Hidden',
  important: 'Important Dates',
};

type Props = {
  active: ListFilter;
  onSelect: (filter: ListFilter) => void;
};

export default function FilterMenu({ active, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<View>(null);

  const openMenu = () => {
    buttonRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ top: y + height + 8, left: x + width - MENU_WIDTH });
    });
    setOpen(true);
  };

  const handleSelect = (filter: ListFilter) => {
    setOpen(false);
    onSelect(filter);
  };

  return (
    <>
      <TouchableOpacity ref={buttonRef} onPress={openMenu}>
        <Text style={[styles.buttonText, !!active && styles.buttonTextActive]}>
          {active ? 'Pings Only ✓' : 'Filter'}
        </Text>
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={[styles.menu, { top: anchor.top, left: anchor.left, width: MENU_WIDTH }]}>
            <TouchableOpacity style={styles.menuItem} onPress={() => handleSelect(null)}>
              <Text style={[styles.menuItemText, !active && styles.menuItemTextActive]}>
                {!active ? 'All ✓' : 'All'}
              </Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity style={styles.menuItem} onPress={() => handleSelect('pingsOnly')}>
              <Text style={[styles.menuItemText, !!active && styles.menuItemTextActive]}>
                {active ? 'Pings Only ✓' : 'Pings Only'}
              </Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  buttonText: { color: colors.textSecondary, fontSize: 14, fontWeight: '600' },
  buttonTextActive: { color: colors.primary },
  backdrop: { flex: 1 },
  menu: {
    position: 'absolute',
    backgroundColor: colors.background,
    borderRadius: 14,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: colors.textPrimary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  menuItem: { paddingHorizontal: 16, paddingVertical: 12 },
  menuItemText: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  menuItemTextActive: { color: colors.primary },
  menuDivider: { height: 1, backgroundColor: colors.divider, marginHorizontal: 8 },
});
