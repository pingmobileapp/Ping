import React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack, useRouter } from 'expo-router';
import { AuthProvider, useAuth } from '../lib/AuthContext';
import { NotificationsProvider, useNotificationsContext } from '../lib/NotificationsContext';
import { useAccountGate } from '../lib/useAccountGate';
import LoginScreen from './(auth)/login';
import InvitePopup from '../components/InvitePopup';
import TermsGateScreen from '../components/TermsGateScreen';
import { colors } from '../lib/theme';

function InvitePopupHost() {
  const router = useRouter();
  const { popupEventId, closeInvitePopup, openEventModal } = useNotificationsContext();

  return (
    <InvitePopup
      eventId={popupEventId}
      onClose={closeInvitePopup}
      onOpenFull={(eventId) => {
        closeInvitePopup();
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

  if (loading || (session && gateState === 'loading')) {
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

  // Phone number and name are collected on-demand from a dismissible
  // Home-screen banner instead of gating entry here - Apple rejected an
  // earlier build (guideline 5.1.1(v)) for requiring phone number just to
  // use the app at all. See lib/useProfilePhone.ts / app/(tabs)/index.tsx.
  return (
    <NotificationsProvider>
      <Stack screenOptions={{ headerShown: false }} />
      <InvitePopupHost />
    </NotificationsProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <RootNavigation />
      </AuthProvider>
    </GestureHandlerRootView>
  );
}
