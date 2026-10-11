import { Alert } from 'react-native';

type InviteContact = { name: string; phone: string | null; linked_user_id: string | null };

// A contact who isn't on Ping and has no phone number can't be reached at
// all - there's no in-app notification, no text, and Ping doesn't send
// email - so their invite used to vanish without a word. A host picked two
// old phone-less copies of contacts he'd since re-imported with numbers and
// never got the text-invite prompt (reported 2026-10-10). Returns true to
// go ahead and send, false to go back and fix the guest list.
export function confirmUnreachableInvitees(contacts: (InviteContact | undefined)[]): Promise<boolean> {
  const unreachable = contacts.filter((c): c is InviteContact => !!c && !c.linked_user_id && !c.phone);
  if (unreachable.length === 0) return Promise.resolve(true);

  const names = unreachable.map((c) => c.name);
  const list =
    names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;

  return new Promise((resolve) => {
    Alert.alert(
      names.length === 1 ? "1 person won't get this invite" : `${names.length} people won't get this invite`,
      `${list} ${names.length === 1 ? "isn't" : "aren't"} on Ping and ${names.length === 1 ? 'has' : 'have'} no phone number saved, so there's no way to reach them. You can add a number in Settings → Contacts.`,
      [
        { text: 'Go back', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Send anyway', onPress: () => resolve(true) },
      ],
      { cancelable: false }
    );
  });
}
