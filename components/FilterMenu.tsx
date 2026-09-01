import React, { useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Pressable } from 'react-native';
import { colors } from '../lib/theme';

const MENU_WIDTH = 200;

// Single-select on purpose - four of these five options already replace
// the whole Upcoming list with a different subset (Drafts/Declined/Hidden/
// Important Dates), so combining them doesn't mean anything ("Drafts +
// Pings Only" is just Drafts, since drafts are always Ping-only already).
// Consolidates what used to be ProfileMenu's Drafts/Declined items plus
// the separate inline "Pings Only"/"Hidden" toggles into one menu, in the
// same spot "Hidden" used to sit.
export type HomeFilter = 'pingsOnly' | 'drafts' | 'declined' | 'hidden' | 'important' | null;

const FILTER_LABELS: Record<Exclude<HomeFilter, null>, string> = {
  pingsOnly: 'Pings Only',
  drafts: 'Drafts',
  declined: 'Declined',
  hidden: 'Hidden',
  important: 'Important Dates',
};

type Props = {
  active: HomeFilter;
  onSelect: (filter: HomeFilter) => void;
  // Hidden/Important Dates only show up as options once there's something
  // they'd actually filter to - same gating the old inline "Hidden" toggle
  // used (hiddenEventIds.size > 0).
  hasHidden: boolean;
  hasImportant: boolean;
};

export default function FilterMenu({ active, onSelect, hasHidden, hasImportant }: Props) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<View>(null);

  const openMenu = () => {
    buttonRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ top: y + height + 8, left: x + width - MENU_WIDTH });
    });
    setOpen(true);
  };

  const handleSelect = (filter: HomeFilter) => {
    setOpen(false);
    onSelect(filter);
  };

  const options: HomeFilter[] = [
    'pingsOnly',
    'drafts',
    'declined',
    ...(hasHidden ? (['hidden'] as HomeFilter[]) : []),
    ...(hasImportant ? (['important'] as HomeFilter[]) : []),
  ];

  return (
    <>
      <TouchableOpacity ref={buttonRef} onPress={openMenu}>
        <Text style={[styles.buttonText, !!active && styles.buttonTextActive]}>
          {active ? `${FILTER_LABELS[active]} ✓` : 'Filter'}
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
            {options.map((opt) => (
              <TouchableOpacity key={opt} style={styles.menuItem} onPress={() => handleSelect(opt)}>
                <Text style={[styles.menuItemText, active === opt && styles.menuItemTextActive]}>
                  {active === opt ? `${FILTER_LABELS[opt as Exclude<HomeFilter, null>]} ✓` : FILTER_LABELS[opt as Exclude<HomeFilter, null>]}
                </Text>
              </TouchableOpacity>
            ))}
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
