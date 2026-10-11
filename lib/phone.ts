// Shared phone-matching utilities.
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }
  return digits;
}

type SupabaseClient = any;

export type Contact = {
  id: string;
  owner_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  linked_user_id: string | null;
  removed_at?: string | null;
};

type MinimalContact = { id: string; phone: string | null; linked_user_id: string | null };

// A contact created before the other person had an account (or before
// they'd set this phone number) is stuck with linked_user_id: null forever
// otherwise, since linking only ran once at creation time. Re-check right
// before it matters (adding it, or sending an invite to it) so it self-heals
// the moment a matching profile shows up. Generic over T so each screen's
// own (slightly different) local Contact shape can be passed straight in.
export async function healContactLink<T extends MinimalContact>(supabase: SupabaseClient, contact: T): Promise<T> {
  if (contact.linked_user_id || !contact.phone) return contact;

  const { data: profileMatch } = await supabase
    .from('profiles')
    .select('id')
    .eq('phone', contact.phone)
    .maybeSingle();

  if (!profileMatch?.id) return contact;

  const { error } = await supabase.from('contacts').update({ linked_user_id: profileMatch.id }).eq('id', contact.id);

  return error ? contact : { ...contact, linked_user_id: profileMatch.id };
}

export async function findOrCreateContact(
  supabase: SupabaseClient,
  ownerId: string,
  name: string,
  rawPhone?: string | null
): Promise<{ contact: Contact; wasExisting: boolean }> {
  const phone = normalizePhone(rawPhone);

  if (phone) {
    const { data: existing } = await supabase
      .from('contacts')
      .select('*')
      .eq('owner_id', ownerId)
      .eq('phone', phone)
      // Active contact first if a removed one shares the number.
      .order('removed_at', { ascending: true, nullsFirst: true })
      .limit(1)
      .maybeSingle();

    if (existing) {
      // Removed from Settings -> Contacts earlier and now added/imported
      // again: bring it back rather than leaving it hidden (or creating a
      // second row with the same number).
      if ((existing as Contact).removed_at) {
        await supabase.from('contacts').update({ removed_at: null, name }).eq('id', existing.id);
        (existing as Contact).removed_at = null;
        (existing as Contact).name = name;
      }
      const healed = await healContactLink(supabase, existing as Contact);
      return { contact: healed, wasExisting: true };
    }
  }

  let linkedUserId: string | null = null;
  if (phone) {
    const { data: profileMatch } = await supabase
      .from('profiles')
      .select('id')
      .eq('phone', phone)
      .maybeSingle();
    linkedUserId = profileMatch?.id || null;
  }

  const { data: created, error } = await supabase
    .from('contacts')
    .insert([{ owner_id: ownerId, name, phone, linked_user_id: linkedUserId }])
    .select()
    .single();

  if (error) throw error;
  return { contact: created as Contact, wasExisting: false };
}

export async function getAlreadyInvitedPhones(
  supabase: SupabaseClient,
  eventId: string
): Promise<Set<string>> {
  const { data } = await supabase
    .from('invitees')
    .select('contacts(phone), profiles(phone)')
    .eq('event_id', eventId);

  const phones = new Set<string>();
  (data || []).forEach((row: any) => {
    const p = normalizePhone(row.contacts?.phone) || normalizePhone(row.profiles?.phone);
    if (p) phones.add(p);
  });
  return phones;
}
