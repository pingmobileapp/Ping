import React, { useEffect, useRef, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../lib/AuthContext';
import { NotificationsProvider, useNotificationsContext } from '../lib/NotificationsContext';
import { useAccountGate } from '../lib/useAccountGate';
import { healInviteLinks } from '../lib/healInvites';
import { watchForAppUpdates } from '../lib/updatePrompt';
import { useAnyModalOpen } from '../lib/modalPresence';
import LoginScreen from './(auth)/login';
import InvitePopup from '../components/InvitePopup';
import TermsGateScreen from '../components/TermsGateScreen';
import FindInvitesScreen from '../components/FindInvitesScreen';
import { useFindInvitesStep } from '../lib/useFindInvitesStep';
import { colors } from '../lib/theme';
import { RootSideInsetsContext } from '../components/SheetModal';

function InvitePopupHost() {
  const router = useRouter();
  const { popupEventId, closeInvitePopup, openEventModal } = useNotificationsContext();
  // Wait while any other sheet is open - two RN Modals on screen at once can
  // freeze the app on iOS (see lib/modalPresence.ts). The invite stays
  // queued and appears as soon as that sheet closes.
  const otherModalOpen = useAnyModalOpen();
  // ...and give the closing sheet's slide-away a moment to finish first -
  // iOS can't present one sheet while another is still animating closed.
  const [clearToShow, setClearToShow] = useState(!otherModalOpen);
  useEffect(() => {
    if (otherModalOpen) {
      setClearToShow(false);
      return;
    }
    const t = setTimeout(() => setClearToShow(true), 600);
    return () => clearTimeout(t);
  }, [otherModalOpen]);

  return (
    <InvitePopup
      eventId={clearToShow ? popupEventId : null}
      onClose={closeInvitePopup}
      onOpenFull={(eventId) => {
        // Drop the rest of the queued invites rather than popping the next
        // one up over the event card they asked to see (they stay listed in
        // Notifications as pending).
        closeInvitePopup([], true);
        openEventModal(eventId);
        // dismissTo, not push - returns to the existing Home screen
        // instead of mounting a second instance of it (push('/') here was
        // implicated in a real crash - see app/notifications.tsx for the
        // full explanation). But this popup is a global overlay, not tied
        // to any one screen - it can appear while already sitting on Home
        // with nothing pushed on top, and calling dismissTo('/') with
        // nothing to dismiss was implicated in a real freeze during family
        // testing. canDismiss() guards that: pendingEventModal alone is
        // enough for Home's own effect to show the detail modal in place
        // when we're already there, no navigation needed.
        if (router.canDismiss()) {
          router.dismissTo('/');
        }
      }}
    />
  );
}

function RootNavigation() {
  const { session, loading, signOut } = useAuth();
  const { state: gateState, refresh: refreshGate } = useAccountGate(session?.user?.id);

  // Once per signed-in account per launch, pick up any invites sent to this
  // person's phone number before they joined - see lib/healInvites.ts.
  const userId = session?.user?.id;
  const healedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!userId || gateState !== 'clear' || healedForRef.current === userId) return;
    healedForRef.current = userId;
    healInviteLinks();
  }, [userId, gateState]);

  // Offer a newer App Store version (lib/updatePrompt.ts) - only once
  // someone is past sign-in and the terms gate, so it never stacks on top
  // of those screens.
  const appReady = !!userId && gateState === 'clear';
  useEffect(() => {
    if (!appReady) return;
    return watchForAppUpdates();
  }, [appReady]);

  const findInvites = useFindInvitesStep(userId, gateState === 'clear');

  if (loading || (session && (gateState === 'loading' || (gateState === 'clear' && findInvites.state === 'loading')))) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!session) {
    return <LoginScreen />;
  }

  // Apple's Guideline 1.2 review requires accepting terms (with explicit
  // zero-tolerance language) before using the app at all - unlike the
  // deleted PhoneGateScreen, this one is meant to be a real, unskippable
  // gate. banned_at reuses it to lock out a suspended account too.
  if (gateState === 'needs_terms' || gateState === 'banned') {
    return <TermsGateScreen userId={session.user.id} mode={gateState} onAccepted={refreshGate} onSignOut={signOut} />;
  }

  // Phone number and name are asked for once, on a skippable step (see
  // components/FindInvitesScreen) - never required: Apple rejected an
  // earlier build (guideline 5.1.1(v)) for requiring a phone number just
  // to use the app. Skipping leaves the Home-screen card as a reminder.
  if (findInvites.state === 'show') {
    return <FindInvitesScreen userId={session.user.id} onDone={findInvites.finish} />;
  }

  return (
    <NotificationsProvider>
      <Stack screenOptions={{ headerShown: false }} />
      <InvitePopupHost />
    </NotificationsProvider>
  );
}

// Keeps every screen clear of a side inset - a phone turned sideways (the
// notch), and the iPhone Duo, which keeps a system rail down one edge even
// upright (2026-10-22). Screens below see no side insets, so none of them
// pads twice; top and bottom are still theirs to handle.
function SideInsets({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingLeft: insets.left, paddingRight: insets.right }}>
      <RootSideInsetsContext.Provider value={{ left: insets.left, right: insets.right }}>
        <SafeAreaInsetsContext.Provider value={{ ...insets, left: 0, right: 0 }}>{children}</SafeAreaInsetsContext.Provider>
      </RootSideInsetsContext.Provider>
    </View>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* Ping's screens are always light, so the clock/battery icons must
          always be dark - Android otherwise draws them white on white. */}
      <StatusBar style="dark" />
      <SideInsets>
        <AuthProvider>
          <RootNavigation />
        </AuthProvider>
      </SideInsets>
    </GestureHandlerRootView>
  );
}
