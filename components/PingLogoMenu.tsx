import React, { useRef, useState } from 'react';
import { View, Image, TouchableOpacity, StyleSheet, Modal, Pressable, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { colors } from '../lib/theme';

const MENU_WIDTH = 200;

const logoBlue = require('../assets/images/ping-logo-blue.png');
const logoRed = require('../assets/images/ping-logo-red.png');

type Props = {
  hasNotifications?: boolean;
  onCreatePing: () => void;
};

export default function PingLogoMenu({ hasNotifications = false, onCreatePing }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<View>(null);

  const openMenu = () => {
    buttonRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ top: y + height + 8, left: x });
    });
    setOpen(true);
  };

  const handleCreatePing = () => {
    setOpen(false);
    onCreatePing();
  };

  // The Message Board used to also be reachable by dragging Home's
  // calendar sheet down - that drag range is now Month view's own
  // pull-down-to-reveal-the-rest-of-the-month gesture instead, so this menu
  // item (same as Notifications below) is the only way in now.
  const handleOpenMessages = () => {
    setOpen(false);
    // Cast needed until .expo/types/router.d.ts regenerates to include the
    // new app/messages.tsx route - same as /admin elsewhere in this app.
    router.push('/messages' as any);
  };

  const handleOpenNotifications = () => {
    setOpen(false);
    router.push('/notifications');
  };

  return (
    <>
      <TouchableOpacity ref={buttonRef} onPress={openMenu} activeOpacity={0.8}>
        <View style={styles.logoWrap}>
          <Image source={hasNotifications ? logoRed : logoBlue} style={styles.logo} resizeMode="contain" />
          {hasNotifications && <View style={styles.notificationDot} />}
        </View>
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={[styles.menu, { top: anchor.top, left: anchor.left, width: MENU_WIDTH }]}>
            <TouchableOpacity style={styles.menuItem} onPress={handleCreatePing}>
              <Text style={styles.menuItemText}>Create a Ping</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity style={styles.menuItem} onPress={handleOpenMessages}>
              <Text style={styles.menuItemText}>Messages</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity style={[styles.menuItem, styles.menuItemRow]} onPress={handleOpenNotifications}>
              <Text style={styles.menuItemText}>Notifications</Text>
              {hasNotifications && <View style={styles.unreadDot} />}
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  // Fixed to the blue mark's natural aspect ratio (355x214) so swapping to
  // the red notification variant doesn't nudge the header layout.
  logo: { height: 30, aspectRatio: 355 / 214 },
  logoWrap: { position: 'relative' },
  // A second, more obvious notification cue than the red/blue logo swap
  // alone — sized a bit bigger than the small signal-dot already in the
  // wordmark art itself, so it doesn't get mistaken for part of the logo.
  notificationDot: {
    position: 'absolute',
    bottom: -2,
    left: -2,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.danger,
    borderWidth: 1.5,
    borderColor: colors.background,
  },
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
  menuItemRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  menuItemText: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  menuDivider: { height: 1, backgroundColor: colors.divider, marginHorizontal: 8 },
  unreadDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.primary },
});
