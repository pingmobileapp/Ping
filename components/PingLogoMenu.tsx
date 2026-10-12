import React, { useEffect, useRef, useState } from 'react';
import { View, Image, TouchableOpacity, StyleSheet, Modal, Pressable, Text, Animated, AccessibilityInfo } from 'react-native';
import { useRouter } from 'expo-router';
import { colors } from '../lib/theme';

const MENU_WIDTH = 200;

// The app-icon mark (blue = nothing new, red = something new), trimmed and
// made transparent from assets/images/splash-icon.png and "icon red.png" so
// it sits cleanly on the header instead of inside a pale square. The blue
// one is tinted to colors.primary so it matches Create/Groups beside it
// (TestFlight feedback: "change it out for the icon that matches the color
// of this page").
const logoBlue = require('../assets/images/ping-mark-app-blue.png');
// The red mark split into its three shapes (same canvas, so they stack
// exactly), for the "sending a signal" animation below.
const redDot = require('../assets/images/ping-mark-red-dot.png');
const redMid = require('../assets/images/ping-mark-red-mid.png');
const redOuter = require('../assets/images/ping-mark-red-outer.png');

// When something's new, the red mark slowly "pings": just the dot, then the
// dot and middle arc, then the full mark, then back to the dot - like it's
// sending out a signal. Static for anyone with Reduce Motion turned on.
const PHASE_MS = 650;
const FADE_MS = 220;

function SignalingRedMark() {
  const mid = useRef(new Animated.Value(0)).current;
  const outer = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      mid.setValue(1);
      outer.setValue(1);
      return;
    }
    mid.setValue(0);
    outer.setValue(0);
    const fade = (v: Animated.Value, to: number) =>
      Animated.timing(v, { toValue: to, duration: FADE_MS, useNativeDriver: true });
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(PHASE_MS), // 1: dot
        fade(mid, 1),
        Animated.delay(PHASE_MS), // 2: dot + middle
        fade(outer, 1),
        Animated.delay(PHASE_MS * 1.4), // 3: full mark, held a little longer
        Animated.parallel([fade(mid, 0), fade(outer, 0)]),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [reduceMotion, mid, outer]);

  return (
    <View style={styles.logo}>
      <Image source={redDot} style={styles.layer} resizeMode="contain" />
      <Animated.Image source={redMid} style={[styles.layer, { opacity: mid }]} resizeMode="contain" />
      <Animated.Image source={redOuter} style={[styles.layer, { opacity: outer }]} resizeMode="contain" />
    </View>
  );
}

type Props = {
  // Anything unread at all - turns the logo red and starts its signal.
  hasNotifications?: boolean;
  // Unread chat messages - red dot on the Messages item.
  hasUnreadMessages?: boolean;
  // Unread everything-else (invites, RSVPs, updates) - red dot on
  // Notifications.
  hasUnreadNotifications?: boolean;
};

export default function PingLogoMenu({
  hasNotifications = false,
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
      <TouchableOpacity ref={buttonRef} onPress={openMenu} activeOpacity={0.8}>
        <View style={styles.logoWrap}>
          {hasNotifications ? (
            <SignalingRedMark />
          ) : (
            <Image source={logoBlue} style={styles.logo} resizeMode="contain" />
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
  // Both marks share one square size, so the blue/red swap never nudges the
  // header layout.
  logo: { width: 28, height: 28 },
  layer: { position: 'absolute', top: 0, left: 0, width: 28, height: 28 },
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
  unreadDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.danger },
});
