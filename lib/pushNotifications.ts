import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { supabase } from '../supabase';

Notifications.setNotificationHandler({
  // This handler only ever runs while the app's JS is alive and
  // foregrounded - it has no effect on whether the OS shows a banner while
  // backgrounded or killed (that's driven entirely by the push payload's
  // title/body, which send-push always includes). So suppressing the
  // banner here for invites is safe: the in-app InvitePopup only replaces
  // it in the one case (foreground) this handler actually controls.
  handleNotification: async (notification) => {
    const isInvite = notification.request.content.data?.type === 'invite';
    return {
      shouldShowAlert: !isInvite,
      shouldShowBanner: !isInvite,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    };
  },
});

// Lets an invite notification carry Accept/Interested/Decline as native
// quick-action buttons (long-press or expand the notification), so RSVPing
// doesn't require fully opening and navigating the app first. iOS requires
// opensAppToForeground so these still work when the app was fully killed,
// not just backgrounded (see expo-notifications' own docs on that option) -
// so picking one does bring the app forward, it just lands the RSVP
// immediately rather than needing the popup + button tap on top of that.
Notifications.setNotificationCategoryAsync('invite', [
  { identifier: 'accept', buttonTitle: 'Accept', options: { opensAppToForeground: true } },
  { identifier: 'interested', buttonTitle: 'Interested', options: { opensAppToForeground: true } },
  { identifier: 'decline', buttonTitle: 'Decline', options: { isDestructive: true, opensAppToForeground: true } },
]).catch((err) => console.error('Error registering invite notification category:', err));

// A priced event's Accept has to open Stripe Checkout, which a
// backgrounded quick-action tap can't do - no buttons at all here, so
// tapping the notification just opens the app to InvitePopup (see
// notify.ts/send-push's hasPrice handling) instead of wrongly accepting
// for free.
Notifications.setNotificationCategoryAsync('invite_priced', []).catch((err) =>
  console.error('Error registering invite_priced notification category:', err)
);

export async function registerForPushNotifications(userId: string) {
  if (!Device.isDevice) {
    console.log('Push notifications require a physical device, not a simulator.');
    return;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.log('Push notification permission denied.');
    return;
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) {
    console.log('Push token unavailable: no EAS projectId in app.json.');
    return;
  }

  let token: string;
  try {
    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    token = tokenData.data;
  } catch (err) {
    console.log('Push token unavailable:', err);
    return;
  }

  const { error } = await supabase.from('profiles').update({ push_token: token }).eq('id', userId);
  if (error) console.error('Error saving push token:', error);
}
