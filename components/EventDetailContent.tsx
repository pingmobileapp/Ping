import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Platform,
  KeyboardAvoidingView,
  Keyboard,
  ActivityIndicator,
  Alert,
  Image,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { supabase } from '../supabase';
import { useAuth } from '../lib/AuthContext';
import ShareInviteModal from './ShareInviteModal';
import EditEventModal, { EditableEvent } from './EditEventModal';
import NonAppInviteQueue, { QueueContact } from './NonAppInviteQueue';
import PhotoViewerModal from './PhotoViewerModal';
import Avatar from './Avatar';
import { colors, cardFrameGradient, EVENT_IMAGE_ASPECT_RATIO } from '../lib/theme';
import { notify } from '../lib/notify';
import { submitRsvp, RsvpStatus } from '../lib/rsvp';
import { scheduleEventReminder, cancelEventReminder } from '../lib/eventReminders';
import { displayName } from '../lib/displayName';
import { formatEventDate, formatEventTime } from '../lib/eventDate';

type EventDetail = {
  id: string;
  title: string;
  location: string;
  event_date: string;
  end_date: string | null;
  is_all_day: boolean;
  host_id: string | null;
  is_public: boolean;
  image_url: string | null;
  image_url_full: string | null;
  status: 'sent' | 'draft';
  description: string | null;
};

type InviteeRow = {
  id: string;
  user_id: string | null;
  rsvp_status: RsvpStatus;
  reminder_minutes_before: number | null;
  invited_via: string | null;
  profiles: { full_name: string | null; email: string | null; avatar_url: string | null } | null;
  contacts: { name: string | null; phone: string | null } | null;
};

type HostProfile = { full_name: string | null; email: string | null; avatar_url: string | null };

type ClaimRow = { id: string; invitee_id: string; quantity: number; note: string | null };

type ItemRow = {
  id: string;
  name: string;
  quantity_needed: number;
  allow_custom: boolean;
  item_claims: ClaimRow[];
};

const RSVP_OPTIONS: { label: string; value: 'accepted' | 'declined' | 'interested' }[] = [
  { label: 'Accept', value: 'accepted' },
  { label: 'Interested', value: 'interested' },
  { label: 'Decline', value: 'declined' },
];

const REMINDER_OPTIONS: { label: string; value: number | null }[] = [
  { label: 'Off', value: null },
  { label: '30 min', value: 30 },
  { label: '1 hr', value: 60 },
  { label: '1 day', value: 1440 },
];

type Props = {
  eventId: string;
  onClose: () => void;
  variant?: 'modal' | 'page';
  onOpenMessages?: () => void;
};

export default function EventDetailContent({ eventId, onClose, variant = 'modal', onOpenMessages }: Props) {
  const { session } = useAuth();

  const [event, setEvent] = useState<EventDetail | null>(null);
  const [hostProfile, setHostProfile] = useState<HostProfile | null>(null);
  const [invitees, setInvitees] = useState<InviteeRow[]>([]);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [newItemQty, setNewItemQty] = useState('1');
  const [newItemAllowCustom, setNewItemAllowCustom] = useState(false);
  const [addingItem, setAddingItem] = useState(false);
  const [customDraftByItem, setCustomDraftByItem] = useState<Record<string, string>>({});
  const [shareModalVisible, setShareModalVisible] = useState(false);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [photoViewerVisible, setPhotoViewerVisible] = useState(false);
  const [smsQueueVisible, setSmsQueueVisible] = useState(false);

  const myInvitee = invitees.find((inv) => inv.user_id === session?.user?.id) || null;
  const isHost = event?.host_id === session?.user?.id;
  const unclaimedCount = items.filter(
    (item) => item.item_claims.reduce((sum, c) => sum + c.quantity, 0) < item.quantity_needed
  ).length;
  const scrollRef = useRef<ScrollView>(null);
  const itemsSectionY = useRef(0);

  // Invitees texted via the host's own Messages app (see NonAppInviteQueue)
  // have no reliable "was it actually sent" signal - closing that flow with
  // "Finish later" (or backgrounding mid-flow) just leaves these invitee
  // rows sitting here with no linked account. Surfacing them again on the
  // event itself is what makes "finish later" actually resumable, instead
  // of the reminder vanishing the moment that modal closes.
  const pendingSmsInvitees: QueueContact[] = invitees
    .filter((inv) => inv.invited_via === 'sms' && !inv.user_id && inv.contacts?.phone)
    .map((inv) => ({ inviteeId: inv.id, name: inv.contacts?.name || 'Guest', phone: inv.contacts!.phone! }));

  const inviteeName = (inv: InviteeRow) =>
    inv.profiles?.full_name || inv.contacts?.name || displayName(inv.profiles);

  const claimantName = (claim: ClaimRow) => {
    const invitee = invitees.find((inv) => inv.id === claim.invitee_id);
    return invitee ? inviteeName(invitee) : 'Someone';
  };

  const myName = () => {
    const mine = invitees.find((inv) => inv.user_id === session?.user?.id);
    return mine ? inviteeName(mine) : 'Someone';
  };

  const fetchData = useCallback(async () => {
    const [{ data: eventData, error: eventError }, { data: inviteeData, error: inviteeError }, { data: itemData, error: itemError }] =
      await Promise.all([
        supabase.from('events').select('*').eq('id', eventId).single(),
        supabase
          .from('invitees')
          .select('id, user_id, rsvp_status, reminder_minutes_before, invited_via, profiles(full_name, email, avatar_url), contacts(name, phone)')
          .eq('event_id', eventId),
        supabase
          .from('items')
          .select('id, name, quantity_needed, allow_custom, item_claims(id, invitee_id, quantity, note)')
          .eq('event_id', eventId),
      ]);

    if (eventError) console.error('Error fetching event:', eventError);
    if (inviteeError) console.error('Error fetching invitees:', inviteeError);
    if (itemError) console.error('Error fetching items:', itemError);

    setEvent(eventData as EventDetail);
    setInvitees((inviteeData as any[]) || []);
    setItems((itemData as any[]) || []);

    if (eventData?.host_id) {
      const { data: hostData, error: hostError } = await supabase
        .from('profiles')
        .select('full_name, email, avatar_url')
        .eq('id', eventData.host_id)
        .maybeSingle();
      if (hostError) console.error('Error fetching host profile:', hostError);
      setHostProfile((hostData as HostProfile) || null);
    } else {
      setHostProfile(null);
    }
  }, [eventId]);

  useEffect(() => {
    setLoading(true);
    fetchData().finally(() => setLoading(false));
  }, [fetchData]);

  // Without this, a host looking at the guest list has no way to see an
  // RSVP someone else just submitted short of closing and reopening the
  // event — this keeps it live the same way notifications already are.
  useEffect(() => {
    const channel = supabase
      .channel(`invitees-${eventId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'invitees', filter: `event_id=eq.${eventId}` },
        () => fetchData()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [eventId, fetchData]);

  const handleRsvp = async (status: 'accepted' | 'declined' | 'interested') => {
    if (!session?.user?.id || !event) return;

    if (!isHost && !myInvitee) {
      Alert.alert("Can't RSVP", "You haven't been invited to this event.");
      return;
    }

    setUpdating(true);

    await submitRsvp({
      eventId,
      hostId: event.host_id,
      eventTitle: event.title,
      userId: session.user.id,
      myInviteeId: myInvitee?.id || null,
      responderName: myName(),
      status,
    });

    await fetchData();
    setUpdating(false);
  };

  const handleSetReminder = async (minutesBefore: number | null) => {
    if (!myInvitee || !event || !session?.user?.id) return;

    // Optimistic update - the button should flip the instant you tap it,
    // not wait on a network round-trip and then a full fetchData() re-fetch
    // of the entire event (all invitees, all items) just to reflect one
    // field changing on one invitee.
    const previousValue = myInvitee.reminder_minutes_before;
    const inviteeId = myInvitee.id;
    setInvitees((prev) =>
      prev.map((inv) => (inv.id === inviteeId ? { ...inv, reminder_minutes_before: minutesBefore } : inv))
    );

    const { error } = await supabase
      .from('invitees')
      .update({ reminder_minutes_before: minutesBefore })
      .eq('id', inviteeId);
    if (error) {
      console.error('Error updating reminder:', error);
      setInvitees((prev) =>
        prev.map((inv) => (inv.id === inviteeId ? { ...inv, reminder_minutes_before: previousValue } : inv))
      );
      return;
    }

    if (minutesBefore === null) {
      await cancelEventReminder(session.user.id, event.id);
    } else {
      await scheduleEventReminder(session.user.id, event.id, event.title, new Date(event.event_date), minutesBefore);
    }
  };

  const setInviteeRsvp = async (inviteeId: string, status: RsvpStatus) => {
    const previous = invitees;
    setInvitees((prev) =>
      prev.map((inv) => (inv.id === inviteeId ? { ...inv, rsvp_status: status } : inv))
    );

    const { error } = await supabase
      .from('invitees')
      .update({ rsvp_status: status, responded_at: status === 'pending' ? null : new Date().toISOString() })
      .eq('id', inviteeId);
    if (error) {
      console.error('Error updating RSVP:', error);
      setInvitees(previous);
      Alert.alert('Error', "Could not update that person's response.");
    }
  };

  const handleHostRsvpPress = (inv: InviteeRow) => {
    Alert.alert(
      inviteeName(inv),
      "This person doesn't have Ping — update their response based on what they told you.",
      [
        { text: 'Accepted', onPress: () => setInviteeRsvp(inv.id, 'accepted') },
        { text: 'Interested', onPress: () => setInviteeRsvp(inv.id, 'interested') },
        { text: 'Declined', onPress: () => setInviteeRsvp(inv.id, 'declined') },
        ...(inv.rsvp_status !== 'pending'
          ? [{ text: 'Reset to Pending', onPress: () => setInviteeRsvp(inv.id, 'pending' as RsvpStatus) }]
          : []),
        { text: 'Cancel', style: 'cancel' as const },
      ]
    );
  };

  const handleAddItem = async () => {
    if (!newItemName.trim()) return;
    const qty = parseInt(newItemQty, 10) || 1;

    const { error } = await supabase.from('items').insert([
      {
        event_id: eventId,
        name: newItemName.trim(),
        quantity_needed: qty,
        allow_custom: newItemAllowCustom,
      },
    ]);

    if (error) {
      Alert.alert('Error', 'Could not add item.');
      console.error(error);
      return;
    }

    setNewItemName('');
    setNewItemQty('1');
    setNewItemAllowCustom(false);
    Keyboard.dismiss();
    await fetchData();
  };

  const handleAddCustomClaim = async (item: ItemRow) => {
    if (!myInvitee) {
      Alert.alert('RSVP first', "Respond to the event before saying what you'll bring.");
      return;
    }
    const text = (customDraftByItem[item.id] || '').trim();
    if (!text) return;

    const { error } = await supabase
      .from('item_claims')
      .insert([{ item_id: item.id, invitee_id: myInvitee.id, quantity: 1, note: text }]);
    if (error) {
      console.error('Error adding claim:', error);
      return;
    }

    setCustomDraftByItem((prev) => ({ ...prev, [item.id]: '' }));
    Keyboard.dismiss();
    await fetchData();
  };

  const handleRemoveCustomClaim = async (item: ItemRow) => {
    const myClaim = item.item_claims.find((c) => c.invitee_id === myInvitee?.id);
    if (!myClaim) return;

    const { error } = await supabase.from('item_claims').delete().eq('id', myClaim.id);
    if (error) console.error('Error removing claim:', error);
    await fetchData();
  };

  const handleClaim = async (item: ItemRow, delta: number) => {
    if (!myInvitee) {
      Alert.alert('RSVP first', 'Respond to the event before claiming an item.');
      return;
    }

    const myClaim = item.item_claims.find((c) => c.invitee_id === myInvitee.id);
    const claimedByOthers = item.item_claims
      .filter((c) => c.invitee_id !== myInvitee.id)
      .reduce((sum, c) => sum + c.quantity, 0);
    const remaining = item.quantity_needed - claimedByOthers;
    const prevQty = myClaim?.quantity || 0;
    const nextQty = prevQty + delta;

    if (nextQty > remaining) return;
    if (nextQty <= 0) {
      if (myClaim) {
        const { error } = await supabase.from('item_claims').delete().eq('id', myClaim.id);
        if (error) console.error('Error releasing claim:', error);
      }
    } else if (myClaim) {
      const { error } = await supabase
        .from('item_claims')
        .update({ quantity: nextQty })
        .eq('id', myClaim.id);
      if (error) console.error('Error updating claim:', error);
    } else {
      const { error } = await supabase
        .from('item_claims')
        .insert([{ item_id: item.id, invitee_id: myInvitee.id, quantity: nextQty }]);
      if (error) console.error('Error creating claim:', error);
    }

    if (nextQty > prevQty && !isHost && event?.host_id) {
      await notify([event.host_id], 'Item claimed', `${myName()} claimed "${item.name}" for ${event.title}`, {
        eventId,
        type: 'item_claimed',
      });
    }

    await fetchData();
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!event) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>Event not found.</Text>
      </View>
    );
  }

  const dateLabel = formatEventDate(event.event_date, event.end_date, 'long');
  const timeLabel = formatEventTime(event.event_date, event.is_all_day, event.end_date);

  const counts = invitees.reduce(
    (acc, inv) => {
      acc[inv.rsvp_status] = (acc[inv.rsvp_status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return (
    <>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={variant === 'page' && Platform.OS === 'ios' ? 'padding' : undefined}
      >
      <ScrollView
        ref={scrollRef}
        style={variant === 'modal' ? styles.containerModal : styles.containerPage}
        contentContainerStyle={{ paddingBottom: 60 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.topRow}>
          <TouchableOpacity onPress={onClose} style={styles.backButton}>
            <Text style={styles.backText}>{variant === 'modal' ? '✕ Close' : '‹ Back'}</Text>
          </TouchableOpacity>
          {isHost && (
            <TouchableOpacity onPress={() => setEditModalVisible(true)}>
              <Text style={styles.editText}>Edit</Text>
            </TouchableOpacity>
          )}
        </View>

        {event.status === 'draft' && (
          <View style={styles.draftBanner}>
            <Text style={styles.draftBannerText}>
              This is a draft — only you can see it. Tap Edit to finish and send it.
            </Text>
          </View>
        )}

        {!!event.image_url && (
          <TouchableOpacity activeOpacity={0.85} onPress={() => setPhotoViewerVisible(true)}>
            <LinearGradient
              colors={cardFrameGradient}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.imageFrame}
            >
              <Image source={{ uri: event.image_url }} style={styles.image} resizeMode="cover" />
            </LinearGradient>
          </TouchableOpacity>
        )}

        <Text style={styles.title}>{event.title}</Text>
        <Text style={styles.meta}>{dateLabel}</Text>
        <Text style={styles.meta}>{timeLabel}</Text>
        {!!event.location && <Text style={styles.meta}>{event.location}</Text>}
        {!!event.description && <Text style={styles.description}>{event.description}</Text>}

        {!!hostProfile && (
          <View style={styles.hostRow}>
            <Avatar url={hostProfile.avatar_url} name={displayName(hostProfile)} size={22} />
            <Text style={styles.hostText}>
              Added by {isHost ? 'you' : displayName(hostProfile)}
            </Text>
          </View>
        )}

        <View style={styles.visibilityRow}>
          <View style={[styles.visibilityBadge, event.is_public ? styles.publicBadge : styles.privateBadge]}>
            <Text style={styles.visibilityBadgeText}>{event.is_public ? 'Public' : 'Private'}</Text>
          </View>
          {event.is_public && (myInvitee || isHost) && (
            <TouchableOpacity onPress={() => setShareModalVisible(true)}>
              <Text style={styles.inviteOthersText}>+ Invite others</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.rsvpSection}>
          <Text style={styles.sectionLabel}>Your response</Text>
          {isHost || myInvitee ? (
            <View style={styles.rsvpRow}>
              {RSVP_OPTIONS.map((opt) => {
                const selected = myInvitee?.rsvp_status === opt.value;
                return (
                  <TouchableOpacity
                    key={opt.value}
                    style={[styles.rsvpButton, selected && styles.rsvpButtonSelected]}
                    onPress={() => handleRsvp(opt.value)}
                    disabled={updating}
                  >
                    <Text style={[styles.rsvpButtonText, selected && styles.rsvpButtonTextSelected]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : (
            <Text style={styles.notInvitedText}>You haven't been invited to this event.</Text>
          )}
        </View>

        {myInvitee?.rsvp_status === 'accepted' && (
          <View style={styles.rsvpSection}>
            <Text style={styles.sectionLabel}>Remind me before</Text>
            <View style={styles.rsvpRow}>
              {REMINDER_OPTIONS.map((opt) => {
                const selected = (myInvitee.reminder_minutes_before ?? null) === opt.value;
                return (
                  <TouchableOpacity
                    key={opt.label}
                    style={[styles.rsvpButton, selected && styles.rsvpButtonSelected]}
                    onPress={() => handleSetReminder(opt.value)}
                    disabled={updating}
                  >
                    <Text style={[styles.rsvpButtonText, selected && styles.rsvpButtonTextSelected]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        <View style={styles.summarySection}>
          <Text style={styles.sectionLabel}>
            {counts.accepted || 0} going · {counts.interested || 0} interested ·{' '}
            {counts.declined || 0} declined
          </Text>
        </View>

        {isHost && pendingSmsInvitees.length > 0 && (
          <TouchableOpacity style={styles.actionBanner} onPress={() => setSmsQueueVisible(true)}>
            <Text style={styles.actionBannerText}>
              {pendingSmsInvitees.length === 1
                ? `${pendingSmsInvitees[0].name} still needs a text invite`
                : `${pendingSmsInvitees.length} people still need a text invite`}
            </Text>
            <Text style={styles.actionBannerAction}>Send now</Text>
          </TouchableOpacity>
        )}

        {myInvitee && myInvitee.rsvp_status !== 'declined' && unclaimedCount > 0 && (
          <TouchableOpacity
            style={styles.actionBanner}
            onPress={() => scrollRef.current?.scrollTo({ y: itemsSectionY.current - 12, animated: true })}
          >
            <Text style={styles.actionBannerText}>
              🛒 {unclaimedCount === 1 ? '1 item still needs someone' : `${unclaimedCount} items still need someone`}
            </Text>
            <Text style={styles.actionBannerAction}>View</Text>
          </TouchableOpacity>
        )}

        <View style={styles.guestList}>
          {invitees.map((inv) => {
            // Invitees with no linked account can't RSVP in-app - they told
            // the host by whatever channel actually reached them (a text
            // back, in person, etc). Letting the host set it manually here
            // is the only way that answer ever gets reflected anywhere.
            const hostCanSetRsvp = isHost && !inv.user_id;
            return (
              <TouchableOpacity
                key={inv.id}
                style={styles.guestRow}
                activeOpacity={hostCanSetRsvp ? 0.6 : 1}
                disabled={!hostCanSetRsvp}
                onPress={() => handleHostRsvpPress(inv)}
              >
                <View style={styles.guestIdentity}>
                  <Avatar url={inv.profiles?.avatar_url} name={inviteeName(inv)} size={28} />
                  <Text style={styles.guestName}>{inviteeName(inv)}</Text>
                </View>
                <View style={styles.guestStatusRow}>
                  <Text style={[styles.guestStatus, styles[`status_${inv.rsvp_status}` as const]]}>
                    {inv.rsvp_status}
                  </Text>
                  {hostCanSetRsvp && <Text style={styles.guestStatusEditIcon}>✎</Text>}
                </View>
              </TouchableOpacity>
            );
          })}
          {invitees.length === 0 && <Text style={styles.emptyText}>No responses yet.</Text>}
        </View>

        {(items.length > 0 || isHost) && (
        <View
          style={styles.itemsSection}
          onLayout={(e) => { itemsSectionY.current = e.nativeEvent.layout.y; }}
        >
          {(items.length > 0 || addingItem) && (
            <Text style={styles.sectionLabel}>What to bring</Text>
          )}

          {items.map((item) => {
            if (item.allow_custom) {
              const myClaim = item.item_claims.find((c) => c.invitee_id === myInvitee?.id);
              return (
                <View key={item.id} style={styles.customItemBlock}>
                  <Text style={styles.itemName}>{item.name}</Text>

                  {item.item_claims.length > 0 && (
                    <View style={{ marginTop: 6, gap: 4 }}>
                      {item.item_claims.map((c) => (
                        <Text key={c.id} style={styles.customClaimText}>
                          • {c.note} <Text style={styles.customClaimAuthor}>— {claimantName(c)}</Text>
                        </Text>
                      ))}
                    </View>
                  )}

                  {myClaim ? (
                    <View style={styles.customClaimRow}>
                      <Text style={styles.itemMeta}>You’re bringing: {myClaim.note}</Text>
                      <TouchableOpacity onPress={() => handleRemoveCustomClaim(item)}>
                        <Text style={styles.itemRemoveText}>Remove</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <View style={styles.addItemRow}>
                      <TextInput
                        style={[styles.input, { flex: 1 }]}
                        placeholder="What are you bringing?"
                        placeholderTextColor={colors.textMuted}
                        value={customDraftByItem[item.id] || ''}
                        onChangeText={(text) =>
                          setCustomDraftByItem((prev) => ({ ...prev, [item.id]: text }))
                        }
                      />
                      <TouchableOpacity style={styles.addItemButton} onPress={() => handleAddCustomClaim(item)}>
                        <Text style={styles.addItemButtonText}>Add</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              );
            }

            const claimedTotal = item.item_claims.reduce((sum, c) => sum + c.quantity, 0);
            const myClaim = item.item_claims.find((c) => c.invitee_id === myInvitee?.id);
            const isFull = claimedTotal >= item.quantity_needed && !myClaim;
            const claimedByOthers = item.item_claims
              .filter((c) => c.invitee_id !== myInvitee?.id)
              .reduce((sum, c) => sum + c.quantity, 0);
            const remaining = item.quantity_needed - claimedByOthers;
            const atMax = !!myClaim && myClaim.quantity >= remaining;

            return (
              <View key={item.id} style={styles.itemRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName}>{item.name}</Text>
                  <Text style={styles.itemMeta}>
                    {claimedTotal}/{item.quantity_needed} claimed
                  </Text>
                </View>

                {myClaim ? (
                  <View style={styles.stepper}>
                    <TouchableOpacity style={styles.stepperButton} onPress={() => handleClaim(item, -1)}>
                      <Text style={styles.stepperButtonText}>–</Text>
                    </TouchableOpacity>
                    <Text style={styles.stepperValue}>{myClaim.quantity}</Text>
                    <TouchableOpacity
                      style={[styles.stepperButton, atMax && styles.stepperButtonDisabled]}
                      onPress={() => handleClaim(item, 1)}
                      disabled={atMax}
                    >
                      <Text style={[styles.stepperButtonText, atMax && styles.stepperButtonTextDisabled]}>+</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={[styles.claimButton, isFull && styles.claimButtonDisabled]}
                    onPress={() => handleClaim(item, 1)}
                    disabled={isFull}
                  >
                    <Text style={styles.claimButtonText}>{isFull ? 'Full' : 'Claim'}</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })}

          {isHost && (
            addingItem || items.length > 0 ? (
              <>
                {items.length === 0 && (
                  <Text style={styles.emptyText}>No items added yet.</Text>
                )}
                <TouchableOpacity
                  style={styles.customToggleRow}
                  onPress={() => setNewItemAllowCustom((v) => !v)}
                >
                  <View style={[styles.checkbox, newItemAllowCustom && styles.checkboxChecked]}>
                    {newItemAllowCustom && <Text style={styles.checkmark}>✓</Text>}
                  </View>
                  <Text style={styles.customToggleText}>
                    {'Let each person write in what they’re bringing (e.g. "Side dish")'}
                  </Text>
                </TouchableOpacity>

                <View style={styles.addItemRow}>
                  <TextInput
                    style={[styles.input, { flex: 2 }]}
                    placeholder="Item (e.g. Chips)"
                    placeholderTextColor={colors.textMuted}
                    value={newItemName}
                    onChangeText={setNewItemName}
                  />
                  <TextInput
                    style={[styles.input, { flex: 1, textAlign: 'center' }]}
                    placeholder="Qty"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="number-pad"
                    value={newItemQty}
                    onChangeText={setNewItemQty}
                  />
                  <TouchableOpacity style={styles.addItemButton} onPress={handleAddItem}>
                    <Text style={styles.addItemButtonText}>Add</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              <TouchableOpacity onPress={() => setAddingItem(true)}>
                <Text style={styles.addNewLinkText}>+ Add something to bring</Text>
              </TouchableOpacity>
            )
          )}
        </View>
        )}
      </ScrollView>
      </KeyboardAvoidingView>

      {onOpenMessages && (
        <TouchableOpacity style={styles.messageBubble} onPress={onOpenMessages} activeOpacity={0.8}>
          <Text style={styles.messageBubbleIcon}>💬</Text>
        </TouchableOpacity>
      )}

      <NonAppInviteQueue
        visible={smsQueueVisible}
        contacts={pendingSmsInvitees}
        eventTitle={event.title}
        eventDate={new Date(event.event_date)}
        location={event.location}
        onDone={() => setSmsQueueVisible(false)}
      />

      <ShareInviteModal
        visible={shareModalVisible}
        eventId={event.id}
        eventTitle={event.title}
        eventDate={event.event_date}
        location={event.location}
        onClose={() => setShareModalVisible(false)}
        onInvited={async () => {
          setShareModalVisible(false);
          await fetchData();
        }}
      />

      <EditEventModal
        visible={editModalVisible}
        event={
          {
            id: event.id,
            title: event.title,
            location: event.location,
            event_date: event.event_date,
            end_date: event.end_date,
            is_all_day: event.is_all_day,
            image_url: event.image_url,
            image_url_full: event.image_url_full,
            is_public: event.is_public,
            status: event.status,
            description: event.description,
          } as EditableEvent
        }
        onClose={() => setEditModalVisible(false)}
        onSaved={async () => {
          setEditModalVisible(false);
          await fetchData();
        }}
        onDeleted={() => {
          setEditModalVisible(false);
          // This modal is itself stacked on top of the event detail modal
          // (onClose here dismisses that outer one). Dismissing both native
          // <Modal>s in the same tick is what was actually behind the
          // "freezes, no crash log, force-quit" delete reports - the two
          // slide-down transitions colliding wedges the modal presentation
          // state. Letting this one finish first (its slide animation is
          // ~300ms) before dismissing the outer one avoids the collision.
          setTimeout(onClose, 350);
        }}
      />

      <PhotoViewerModal
        visible={photoViewerVisible}
        uri={event.image_url_full || event.image_url}
        onClose={() => setPhotoViewerVisible(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  containerModal: { flex: 1, paddingHorizontal: 4, marginBottom: 84 },
  containerPage: { flex: 1, backgroundColor: colors.background, padding: 20, paddingTop: 60 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },
  messageBubble: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.textPrimary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 5,
  },
  messageBubbleIcon: { fontSize: 22 },
  backButton: {},
  backText: { color: colors.primary, fontSize: 16, fontWeight: '600' },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  editText: { color: colors.primary, fontSize: 16, fontWeight: '600' },
  draftBanner: { backgroundColor: colors.surfaceAlt, borderRadius: 10, padding: 12, marginBottom: 14 },
  draftBannerText: { color: colors.textSecondary, fontSize: 13 },
  imageFrame: { borderRadius: 18, padding: 3, marginBottom: 14 },
  image: { width: '100%', aspectRatio: EVENT_IMAGE_ASPECT_RATIO, borderRadius: 15 },
  title: { color: colors.textPrimary, fontSize: 26, fontWeight: '700', marginBottom: 8 },
  meta: { color: colors.textSecondary, fontSize: 15, marginBottom: 2 },
  description: { color: colors.textPrimary, fontSize: 15, lineHeight: 21, marginTop: 10 },
  hostRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  hostText: { color: colors.textSecondary, fontSize: 14 },
  visibilityRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 12 },
  visibilityBadge: { borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  publicBadge: { backgroundColor: '#DFF3E0' },
  privateBadge: { backgroundColor: colors.surfaceAlt },
  visibilityBadgeText: { color: colors.textPrimary, fontSize: 12, fontWeight: '700' },
  inviteOthersText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  rsvpSection: { marginTop: 28 },
  sectionLabel: { color: colors.textSecondary, fontSize: 13, marginBottom: 10, textTransform: 'uppercase' },
  addNewLinkText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  rsvpRow: { flexDirection: 'row', gap: 10 },
  rsvpButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: colors.surface,
  },
  rsvpButtonSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  rsvpButtonText: { color: colors.textSecondary, fontWeight: '600', fontSize: 14 },
  rsvpButtonTextSelected: { color: colors.textOnPrimary },
  notInvitedText: { color: colors.textMuted, fontSize: 14, fontStyle: 'italic' },
  summarySection: { marginTop: 28 },
  actionBanner: {
    marginTop: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  actionBannerText: { flex: 1, color: colors.textPrimary, fontSize: 14, fontWeight: '600', marginRight: 12 },
  actionBannerAction: { color: colors.primary, fontSize: 14, fontWeight: '700' },
  guestList: { marginTop: 12, gap: 10 },
  guestRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  guestIdentity: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
  guestName: { color: colors.textPrimary, fontSize: 15, flexShrink: 1 },
  guestStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  guestStatus: { fontSize: 13, fontWeight: '600', textTransform: 'capitalize' },
  guestStatusEditIcon: { fontSize: 12, color: colors.textMuted },
  status_accepted: { color: colors.success },
  status_interested: { color: colors.warning },
  status_declined: { color: colors.danger },
  status_pending: { color: colors.textMuted },
  emptyText: { color: colors.textMuted, fontSize: 14, marginTop: 8 },
  itemsSection: { marginTop: 32 },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  itemName: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  itemMeta: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  claimButton: { backgroundColor: colors.primary, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 },
  claimButtonDisabled: { backgroundColor: colors.surfaceAlt },
  claimButtonText: { color: colors.textOnPrimary, fontWeight: '600', fontSize: 13 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepperButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperButtonText: { color: colors.textPrimary, fontSize: 16, fontWeight: '700' },
  stepperButtonDisabled: { backgroundColor: colors.surfaceAlt, borderColor: colors.divider },
  stepperButtonTextDisabled: { color: colors.textMuted },
  stepperValue: { color: colors.textPrimary, fontSize: 15, fontWeight: '600', minWidth: 16, textAlign: 'center' },
  addItemRow: { flexDirection: 'row', gap: 8, marginTop: 16 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 10,
    fontSize: 14,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
  },
  addItemButton: { backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 16, justifyContent: 'center' },
  addItemButtonText: { color: colors.textOnPrimary, fontWeight: '600' },
  customItemBlock: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.divider },
  customClaimText: { color: colors.textPrimary, fontSize: 14 },
  customClaimAuthor: { color: colors.textMuted, fontSize: 12 },
  customClaimRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  itemRemoveText: { color: colors.danger, fontSize: 13, fontWeight: '600' },
  customToggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 },
  customToggleText: { color: colors.textSecondary, fontSize: 13, flex: 1 },
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkmark: { color: colors.textOnPrimary, fontSize: 14, fontWeight: '700' },
});
