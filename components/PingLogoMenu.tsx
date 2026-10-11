import React, { useRef, useState } from 'react';
import { View, Image, TouchableOpacity, StyleSheet, Modal, Pressable, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { colors } from '../lib/theme';

const MENU_WIDTH = 200;

// The app-icon mark (blue = nothing new, red = something new), trimmed and
// made transparent from assets/images/splash-icon.png and "icon red.png" so
// it sits cleanly on the header instead of inside a pale square.
const logoBlue = require('../assets/images/ping-mark-blue.png');
const logoRed = require('../assets/images/ping-mark-red.png');

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
  // Both marks share one square size, so the blue/red swap never nudges the
  // header layout.
  logo: { width: 34, height: 34 },
  logoWrap: { position: 'relative' },
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
