import React, { useCallback, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Pressable, Image } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { supabase } from '../supabase';
import { useAuth } from '../lib/AuthContext';
import { colors } from '../lib/theme';
import CatchMeUpModal from './CatchMeUpModal';

const MENU_WIDTH = 200;

// Drafts/Declined moved to components/FilterMenu.tsx, consolidated there
// with Pings Only/Hidden/Important Dates - this menu no longer needs to
// know about any of that filter state.
export default function ProfileMenu() {
  const router = useRouter();
  const { session, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [catchMeUpVisible, setCatchMeUpVisible] = useState(false);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });
  const [fullName, setFullName] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const buttonRef = useRef<View>(null);

  useFocusEffect(
    useCallback(() => {
      if (!session?.user?.id) return;
      supabase
        .from('profiles')
        .select('full_name, avatar_url')
        .eq('id', session.user.id)
        .maybeSingle()
        .then(({ data, error }) => {
          if (error) return;
          setFullName(data?.full_name || null);
          setAvatarUrl(data?.avatar_url || null);
        });
    }, [session?.user?.id])
  );

  const initial = (
    fullName ||
    session?.user?.user_metadata?.full_name ||
    session?.user?.user_metadata?.name ||
    session?.user?.email ||
    '?'
  )
    .trim()
    .charAt(0)
    .toUpperCase();

  const openMenu = () => {
    buttonRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ top: y + height + 8, left: x + width - MENU_WIDTH });
    });
    setOpen(true);
  };

  const handleSignOut = () => {
    setOpen(false);
    signOut();
  };

  const openSettings = () => {
    setOpen(false);
    router.push('/settings');
  };

  const openCatchMeUp = () => {
    setOpen(false);
    setCatchMeUpVisible(true);
  };

  return (
    <>
      <TouchableOpacity
        ref={buttonRef}
        style={styles.avatarButton}
        onPress={openMenu}
        activeOpacity={0.8}
      >
        {avatarUrl ? (
          <Image source={{ uri: avatarUrl }} style={styles.avatarImage} />
        ) : (
          <Text style={styles.avatarText}>{initial}</Text>
        )}
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={[styles.menu, { top: anchor.top, left: anchor.left, width: MENU_WIDTH }]}>
            <TouchableOpacity style={styles.menuItem} onPress={openCatchMeUp}>
              <Text style={styles.menuItemText}>✨ Catch me up</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity style={styles.menuItem} onPress={openSettings}>
              <Text style={styles.menuItemText}>Settings</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity style={styles.menuItem} onPress={handleSignOut}>
              <Text style={styles.menuItemText}>Sign Out</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      <CatchMeUpModal visible={catchMeUpVisible} onClose={() => setCatchMeUpVisible(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  avatarButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImage: { width: 32, height: 32 },
  avatarText: { color: colors.textOnPrimary, fontSize: 14, fontWeight: '700' },
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
