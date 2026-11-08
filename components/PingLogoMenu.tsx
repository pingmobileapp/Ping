import React, { useRef, useState } from 'react';
import { View, Image, TouchableOpacity, StyleSheet, Modal, Pressable, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { colors } from '../lib/theme';

const MENU_WIDTH = 200;

// The app-icon mark, trimmed and made transparent from
// assets/images/splash-icon.png and tinted to colors.primary so it matches
// Create/Groups beside it (TestFlight feedback: "change it out for the icon
// that matches the color of this page").
//
// It stays blue all the time. Anything missed shows as a red badge with the
// count instead of the old red mark that slowly "pinged" (TestFlight
// feedback 83: easier to understand at a glance).
const logoBlue = require('../assets/images/ping-mark-app-blue.png');

export const badgeLabel = (count: number) => (count > 99 ? '99+' : String(count));

type Props = {
  // Every missed message and update (see lib/useNotifications.ts
  // missedCount) - the number in the red badge. 0 hides the badge.
  missedCount?: number;
  // Unread chat messages - red dot on the Messages item.
  hasUnreadMessages?: boolean;
  // Unread everything-else (invites, RSVPs, updates) - red dot on
  // Notifications.
  hasUnreadNotifications?: boolean;
};

export default function PingLogoMenu({
  missedCount = 0,
  hasUnreadMessages = false,
  hasUnreadNotifications = false,
}: Props) {
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
      <TouchableOpacity
        ref={buttonRef}
        onPress={openMenu}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={missedCount > 0 ? `Messages and notifications, ${missedCount} new` : 'Messages and notifications'}
      >
        <View style={styles.logoWrap}>
          <Image source={logoBlue} style={styles.logo} resizeMode="contain" />
          {missedCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText} numberOfLines={1}>
                {badgeLabel(missedCount)}
              </Text>
            </View>
          )}
        </View>
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={[styles.menu, { top: anchor.top, left: anchor.left, width: MENU_WIDTH }]}>
            <TouchableOpacity style={[styles.menuItem, styles.menuItemRow]} onPress={handleOpenMessages}>
              <Text style={styles.menuItemText}>Messages</Text>
              {hasUnreadMessages && <View style={styles.unreadDot} />}
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity style={[styles.menuItem, styles.menuItemRow]} onPress={handleOpenNotifications}>
              <Text style={styles.menuItemText}>Notifications</Text>
              {hasUnreadNotifications && <View style={styles.unreadDot} />}
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  logo: { width: 28, height: 28 },
  logoWrap: { position: 'relative' },
  // Sits on the mark's top-right corner, like an app-icon badge.
  badge: {
    position: 'absolute',
    top: -6,
    right: -10,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: colors.danger,
    borderWidth: 1.5,
    borderColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: colors.white, fontSize: 11, fontWeight: '800', lineHeight: 13 },
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
  unreadDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.danger },
});
