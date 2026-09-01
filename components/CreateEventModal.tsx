import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ScrollView,
  KeyboardAvoidingView,
  Keyboard,
  Animated,
  PanResponder,
  Alert,
  Image,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Calendar } from 'react-native-calendars';
import { LinearGradient } from 'expo-linear-gradient';
import * as Crypto from 'expo-crypto';
import { supabase } from '../supabase';
import { useAuth } from '../lib/AuthContext';
import { findOrCreateContact, healContactLink } from '../lib/phone';
import { loadMemberGroups } from '../lib/sharedGroups';
import { uploadEventImage, uploadEventImageFull } from '../lib/imageUpload';
import { pickEventImage } from '../lib/imagePicker';
import { colors, cardFrameGradient, calendarTheme, EVENT_IMAGE_ASPECT_RATIO } from '../lib/theme';
import { notify } from '../lib/notify';
import { RecurrenceConfig, generateOccurrences } from '../lib/recurrence';
import { suggestItems } from '../lib/itemSuggestions';
import { ActivityCategory, CATEGORY_LABELS } from '../lib/discoverActivities';
import { fetchConnectStatus, ConnectAccountState } from '../lib/stripeConnect';
import { dollarsToCents } from '../lib/pricing';
import { containsObjectionableContent } from '../lib/contentFilter';
import { reportContent } from '../lib/moderation';
import ImportContactsModal from './ImportContactsModal';
import ImageCropModal from './ImageCropModal';
import NonAppInviteQueue, { QueueContact } from './NonAppInviteQueue';
import RecurrencePicker from './RecurrencePicker';

type Contact = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  linked_user_id: string | null;
};

type GroupMember = { contactId: string; name: string };
type Group = { id: string; name: string; members: GroupMember[] };

type Props = {
  visible: boolean;
  onClose: () => void;
  onCreated: (status: 'sent' | 'draft') => void;
  // Date the user had selected on the home calendar (YYYY-MM-DD), if any —
  // pre-fills the date field so tapping + after picking a day doesn't
  // default back to today.
  initialDate?: string | null;
  // Carries a personal/synced calendar item's title and time over when the
  // user converts it into a real Ping (see AddPersonalItemModal's "Convert
  // to Ping" button, and ScheduleReviewModal's "Create Ping instead") -
  // takes priority over initialDate when both are set. location/description
  // are optional since AddPersonalItemModal's ExternalEvent type doesn't
  // always have them populated (an external synced calendar event may have
  // no details at all).
  prefill?: {
    title: string;
    startDate: Date;
    endDate: Date;
    isAllDay: boolean;
    location?: string;
    description?: string;
  } | null;
};

export default function CreateEventModal({ visible, onClose, onCreated, initialDate, prefill }: Props) {
  const { session } = useAuth();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [eventDate, setEventDate] = useState(new Date());
  const [endDate, setEndDate] = useState<Date | null>(null);
  const [isMultiDay, setIsMultiDay] = useState(false);
  const [isAllDay, setIsAllDay] = useState(false);
  const [recurrence, setRecurrence] = useState<RecurrenceConfig | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerMode, setPickerMode] = useState<'date' | 'time'>('date');
  const [pickerTarget, setPickerTarget] = useState<'start' | 'end'>('start');
  const [submitting, setSubmitting] = useState(false);
  const [isPublic, setIsPublic] = useState(false);
  // Checking this also forces isPublic true on submit (see submit's
  // insert) - a Discover listing needs to be joinable by strangers, which
  // is exactly what is_public already grants via the self-join invitees
  // policy, so there's no separate RSVP machinery to build for this.
  const [discoverable, setDiscoverable] = useState(false);
  const [discoverCategory, setDiscoverCategory] = useState<ActivityCategory>('community');
  // Text, not number, while editing (an empty field reads as "no limit" -
  // 0 would incorrectly read as falsy/no-limit too if this were a number
  // state instead).
  const [capacity, setCapacity] = useState('');
  // Text (dollars), converted to whole cents on submit - see dollarsToCents.
  const [price, setPrice] = useState('');
  const [connectStatus, setConnectStatus] = useState<ConnectAccountState | null>(null);
  const [imageUri, setImageUri] = useState<string | null>(null);
  // The never-cropped pick, kept separate from imageUri (the cropped
  // result) so recropping always has full image data to work with - see
  // handlePhotoTap.
  const [originalImageUri, setOriginalImageUri] = useState<string | null>(null);
  const [cropModalVisible, setCropModalVisible] = useState(false);
  const [cropSourceUri, setCropSourceUri] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  const [contacts, setContacts] = useState<Contact[]>([]);
  // Materializing a shared group's members into your own contacts (see
  // loadMemberGroups) takes a network round trip - blocking Send until it
  // settles avoids a race where hitting Send with a shared group selected,
  // before that finishes, would build an invite row for a contact id that
  // doesn't exist in `contacts` yet and silently invite no one for that
  // person.
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [favoriteContactIds, setFavoriteContactIds] = useState<string[]>([]);
  const [showAllContacts, setShowAllContacts] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  // Co-hosts get full host permissions, added directly with no accept
  // step - restricted to contacts already linked to a real Ping account,
  // since they need to actually be able to log in and use them.
  const [selectedCoHostIds, setSelectedCoHostIds] = useState<string[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [excludedGroupMemberIds, setExcludedGroupMemberIds] = useState<string[]>([]);
  const [addingContact, setAddingContact] = useState(false);
  const [newContactName, setNewContactName] = useState('');
  const [newContactPhone, setNewContactPhone] = useState('');
  const [importVisible, setImportVisible] = useState(false);
  const [queueContacts, setQueueContacts] = useState<QueueContact[]>([]);
  const [queueVisible, setQueueVisible] = useState(false);
  const [pendingFinishStatus, setPendingFinishStatus] = useState<'sent' | 'draft' | null>(null);

  const [items, setItems] = useState<{ name: string; qty: string; allowCustom: boolean }[]>([]);
  const [newItemName, setNewItemName] = useState('');
  const [newItemQty, setNewItemQty] = useState('1');
  const [newItemAllowCustom, setNewItemAllowCustom] = useState(false);
  const [suggestedItems, setSuggestedItems] = useState<string[]>([]);
  const [suggestingItems, setSuggestingItems] = useState(false);

  const dragY = useRef(new Animated.Value(0)).current;
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    if (visible) {
      dragY.setValue(0);
      resetForm();
    }
  }, [visible]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, () => {
      setKeyboardVisible(true);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardVisible(false);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dy) > 4,
      onPanResponderMove: (_, gesture) => {
        if (gesture.dy > 0) dragY.setValue(gesture.dy);
      },
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dy > 100 || gesture.vy > 0.8) {
          Animated.timing(dragY, {
            toValue: 800,
            duration: 200,
            useNativeDriver: true,
          }).start(() => {
            dragY.setValue(0);
            onClose();
          });
        } else {
          Animated.spring(dragY, { toValue: 0, useNativeDriver: true, bounciness: 6 }).start();
        }
      },
    })
  ).current;

  useEffect(() => {
    if (visible && session?.user?.id) {
      loadContactsAndGroups();
      fetchConnectStatus().then(setConnectStatus);
    }
  }, [visible, session?.user?.id]);

  const loadContactsAndGroups = async () => {
    setGroupsLoading(true);
    const { data: contactsData, error: contactsError } = await supabase
      .from('contacts')
      .select('id, name, phone, email, linked_user_id')
      .eq('owner_id', session!.user.id)
      .order('name');

    if (contactsError) console.error('Error loading contacts:', contactsError);
    setContacts(contactsData || []);

    // "Favorites" = people you've actually invited to something before,
    // most-pinged first. No GROUP BY without an RPC this repo doesn't have,
    // so just tally it client-side - a family's contact list is small.
    const contactIds = (contactsData || []).map((c) => c.id);
    if (contactIds.length > 0) {
      const { data: inviteRows, error: inviteRowsError } = await supabase
        .from('invitees')
        .select('contact_id')
        .in('contact_id', contactIds);
      if (inviteRowsError) console.error('Error loading ping counts:', inviteRowsError);
      const counts = new Map<string, number>();
      (inviteRows || []).forEach((r: any) => {
        if (!r.contact_id) return;
        counts.set(r.contact_id, (counts.get(r.contact_id) || 0) + 1);
      });
      const ranked = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id);
      // Fill out to 6 with whoever else exists (contactIds is already
      // alpha-sorted) so the Favorites/See-all split is visible right away
      // even before any ping history has built up, instead of silently
      // falling back to "show everyone" with no visible feature at all.
      setFavoriteContactIds(Array.from(new Set([...ranked, ...contactIds])).slice(0, 6));
    } else {
      setFavoriteContactIds([]);
    }

    const { data: groupsData, error: groupsError } = await supabase
      .from('groups')
      .select('id, name, group_members(contact_id, contacts(name))')
      .eq('owner_id', session!.user.id)
      .order('name');

    if (groupsError) console.error('Error loading groups:', groupsError);
    const ownedGroups = (groupsData || []).map((g: any) => ({
      id: g.id,
      name: g.name,
      members: (g.group_members || []).map((m: any) => ({
        contactId: m.contact_id,
        name: m.contacts?.name || 'Unknown',
      })),
    }));
    setGroups(ownedGroups);

    // Groups someone else shared with you - their members get materialized
    // into your own contacts the first time this loads (see loadMemberGroups).
    // groupsLoading blocks Send until this settles, below.
    const { groups: memberGroups, newContacts } = await loadMemberGroups(
      supabase,
      session!.user.id,
      contactsData || []
    );
    if (memberGroups.length > 0) setGroups([...ownedGroups, ...memberGroups]);
    if (newContacts.length > 0) {
      setContacts((prev) => [...prev, ...newContacts].sort((a, b) => a.name.localeCompare(b.name)));
    }
    setGroupsLoading(false);
  };

  const startCrop = (uri: string) => {
    setCropSourceUri(uri);
    setCropModalVisible(true);
  };

  // A photo already attached gets a choice to just reframe it in place
  // (no picking involved, so the original crop tool never even comes up)
  // instead of always forcing a fresh trip through the library. Recropping
  // always starts from the original, never-cropped pick - once a photo's
  // been cropped to the exact target frame there's no extra image data
  // left outside it to drag into view, so recropping the previous crop
  // result would have nothing to actually reposition.
  const handlePhotoTap = async () => {
    if (imageUri) {
      Alert.alert('Photo', undefined, [
        { text: 'Recrop This Photo', onPress: () => startCrop(originalImageUri || imageUri) },
        {
          text: 'Choose a Different Photo',
          onPress: async () => {
            const uri = await pickEventImage();
            if (uri) {
              setOriginalImageUri(uri);
              startCrop(uri);
            }
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
      return;
    }
    const uri = await pickEventImage();
    if (uri) {
      setOriginalImageUri(uri);
      startCrop(uri);
    }
  };

  const toggleContact = (id: string) => {
    setSelectedContactIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  };

  const toggleGroup = (id: string) => {
    setSelectedGroupIds((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]));
  };

  const toggleCoHost = (id: string) => {
    setSelectedCoHostIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  };

  const toggleGroupMember = (contactId: string) => {
    setExcludedGroupMemberIds((prev) =>
      prev.includes(contactId) ? prev.filter((id) => id !== contactId) : [...prev, contactId]
    );
  };

  const handleAddContact = async () => {
    if (!newContactName.trim() || !session?.user?.id) return;

    try {
      const { contact, wasExisting } = await findOrCreateContact(
        supabase,
        session.user.id,
        newContactName.trim(),
        newContactPhone
      );

      setContacts((prev) => {
        if (wasExisting && prev.some((c) => c.id === contact.id)) return prev;
        return [...prev, contact].sort((a, b) => a.name.localeCompare(b.name));
      });
      setSelectedContactIds((prev) => (prev.includes(contact.id) ? prev : [...prev, contact.id]));

      if (wasExisting) {
        Alert.alert('Already in your contacts', `Matched to existing contact "${contact.name}" by phone number.`);
      }
    } catch (err) {
      console.error(err);
      Alert.alert('Error', 'Could not add contact.');
      return;
    }

    setNewContactName('');
    setNewContactPhone('');
    setAddingContact(false);
    Keyboard.dismiss();
  };

  const handleImported = (imported: Contact[]) => {
    setImportVisible(false);
    setContacts((prev) => {
      const merged = [...prev];
      imported.forEach((c) => {
        if (!merged.some((m) => m.id === c.id)) merged.push(c);
      });
      return merged.sort((a, b) => a.name.localeCompare(b.name));
    });
    setSelectedContactIds((prev) => Array.from(new Set([...prev, ...imported.map((c) => c.id)])));
  };

  const handleAddItem = () => {
    if (!newItemName.trim()) return;
    setItems((prev) => [
      ...prev,
      { name: newItemName.trim(), qty: newItemQty.trim() || '1', allowCustom: newItemAllowCustom },
    ]);
    setNewItemName('');
    setNewItemQty('1');
    setNewItemAllowCustom(false);
    Keyboard.dismiss();
  };

  const handleSuggestItems = async () => {
    if (!title.trim() || !session?.user?.id) {
      Alert.alert('Add a title first', 'Suggestions are based on the event title.');
      return;
    }
    setSuggestingItems(true);
    try {
      const suggestions = await suggestItems(supabase, session.user.id, title.trim());
      // Drop anything already added, so tapping a suggestion never creates
      // a duplicate item.
      const existingNames = new Set(items.map((it) => it.name.toLowerCase()));
      setSuggestedItems(suggestions.filter((s) => !existingNames.has(s.toLowerCase())));
    } catch (err) {
      console.error('Error suggesting items:', err);
      Alert.alert('Error', 'Could not get suggestions right now.');
    } finally {
      setSuggestingItems(false);
    }
  };

  const addSuggestedItem = (name: string) => {
    setItems((prev) => [...prev, { name, qty: '1', allowCustom: false }]);
    setSuggestedItems((prev) => prev.filter((s) => s !== name));
  };

  const removeItem = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  const buildInitialEventDate = () => {
    if (!initialDate) return new Date();
    const [y, m, d] = initialDate.split('-').map(Number);
    const next = new Date();
    next.setFullYear(y, m - 1, d);
    return next;
  };

  const resetForm = () => {
    if (prefill) {
      setTitle(prefill.title);
      setEventDate(prefill.startDate);
      setEndDate(prefill.endDate);
      setIsMultiDay(prefill.startDate.toDateString() !== prefill.endDate.toDateString());
      setIsAllDay(prefill.isAllDay);
      setLocation(prefill.location || '');
      setDescription(prefill.description || '');
    } else {
      setDescription('');
      setLocation('');
      setTitle('');
      const initial = buildInitialEventDate();
      setEventDate(initial);
      setEndDate(new Date(initial.getTime() + 60 * 60000));
      setIsMultiDay(false);
      setIsAllDay(false);
    }
    setRecurrence(null);
    setSuggestedItems([]);
    setSelectedContactIds([]);
    setSelectedCoHostIds([]);
    setSelectedGroupIds([]);
    setExcludedGroupMemberIds([]);
    setIsPublic(false);
    setDiscoverable(false);
    setDiscoverCategory('community');
    setCapacity('');
    setPrice('');
    setImageUri(null);
    setOriginalImageUri(null);
    setItems([]);
    setShowAllContacts(false);
  };

  const formatDate = (date: Date) =>
    date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  const formatTime = (date: Date) =>
    date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  const onChangeDate = (event: any, selectedDate?: Date) => {
    if (Platform.OS === 'android') setShowPicker(false);
    if (!selectedDate) return;
    if (pickerTarget === 'end') {
      setEndDate(selectedDate);
      return;
    }
    setEventDate(selectedDate);
    // Keep the end time from silently trailing behind a start time that
    // just got moved past it - same idea as the end-date safeguard below.
    if (endDate && endDate.getTime() <= selectedDate.getTime()) {
      setEndDate(new Date(selectedDate.getTime() + 60 * 60000));
    }
  };

  const toDateString = (date: Date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  const onDayPress = (day: { year: number; month: number; day: number }) => {
    if (pickerTarget === 'end') {
      const next = new Date(endDate || eventDate);
      next.setFullYear(day.year, day.month - 1, day.day);
      setEndDate(next);
      setShowPicker(false);
      return;
    }
    const next = new Date(eventDate);
    next.setFullYear(day.year, day.month - 1, day.day);
    setEventDate(next);
    // Keep the end date from silently trailing behind a start date that
    // just got moved past it.
    if (endDate && endDate.getTime() < next.getTime()) setEndDate(next);
    setShowPicker(false);
  };

  const toggleMultiDay = () => {
    setIsMultiDay((prev) => {
      const next = !prev;
      // Turning it off collapses the end back onto the start's day rather
      // than discarding it - there's always an end time now, multi-day
      // just controls whether that end can land on a different day.
      if (!next && endDate) {
        const collapsed = new Date(eventDate);
        collapsed.setHours(endDate.getHours(), endDate.getMinutes(), 0, 0);
        setEndDate(collapsed);
      }
      return next;
    });
  };

  const resolveInviteeContactIds = (): string[] => {
    const fromGroups = selectedGroupIds.flatMap((gid) =>
      (groups.find((g) => g.id === gid)?.members || [])
        .map((m) => m.contactId)
        .filter((cid) => !excludedGroupMemberIds.includes(cid))
    );
    // Co-hosts already get their own accepted invitee row (see
    // createOccurrence) - excluded here so picking someone as both a
    // co-host and a regular invitee can't create two invitee rows for
    // the same person on the same event.
    const allIds = Array.from(
      new Set([...selectedContactIds, ...fromGroups].filter((cid) => !selectedCoHostIds.includes(cid)))
    );

    const seenPhones = new Set<string>();
    const deduped: string[] = [];
    for (const cid of allIds) {
      const phone = contacts.find((c) => c.id === cid)?.phone;
      if (phone) {
        if (seenPhones.has(phone)) continue;
        seenPhones.add(phone);
      }
      deduped.push(cid);
    }
    return deduped;
  };

  // One occurrence's worth of the full create sequence - event row, host's
  // own accepted-invitee row, items, and (if sent) guest invitees. Used
  // both for a plain one-off event and, in a loop, for each date in a
  // recurring series (see submit below) - shouldNotify gates the push
  // notification and SMS-queue prompt so a multi-occurrence series fires
  // those once, not once per occurrence (nobody wants 10 "you're invited"
  // pushes back to back for a weekly series). Throws on the one failure
  // that should hard-stop the caller (the events insert itself); every
  // other failure here is logged and swallowed, matching this form's
  // existing non-atomic error handling.
  const createOccurrence = async (
    occStart: Date,
    occEnd: Date | null,
    recurrenceId: string | null,
    imageUrl: string | null,
    imageUrlFull: string | null,
    status: 'sent' | 'draft',
    shouldNotify: boolean
  ): Promise<{ eventId: string; smsQueueItems: QueueContact[] }> => {
    const { data: eventRow, error } = await supabase
      .from('events')
      .insert([
        {
          title,
          description: description.trim() || null,
          location,
          event_date: occStart.toISOString(),
          end_date: occEnd ? occEnd.toISOString() : null,
          is_all_day: isAllDay,
          status,
          host_id: session!.user.id,
          is_public: isPublic || discoverable,
          discoverable,
          discover_category: discoverable ? discoverCategory : null,
          capacity: discoverable && capacity.trim() ? parseInt(capacity, 10) : null,
          price_cents: discoverable ? dollarsToCents(price) : null,
          image_url: imageUrl,
          image_url_full: imageUrlFull,
          recurrence_id: recurrenceId,
          // Only when exactly one group is selected - inviting from
          // multiple groups at once stays ambiguous about which one (if
          // any) "owns" the event, so it's left untagged rather than
          // guessing.
          group_id: selectedGroupIds.length === 1 ? selectedGroupIds[0] : null,
        },
      ])
      .select()
      .single();

    if (error || !eventRow) {
      throw error || new Error('No event row returned');
    }

    // Only checked for a Discover listing - that's the surface a broad
    // audience actually sees, matching this app's scoped response to
    // Apple's Guideline 1.2 review. Doesn't block creation (see
    // lib/contentFilter.ts), just raises the same admin report a user's
    // own flag would.
    if (discoverable && (containsObjectionableContent(title) || containsObjectionableContent(description))) {
      reportContent({
        reporterId: session!.user.id,
        reportedUserId: session!.user.id,
        contentType: 'event',
        contentId: eventRow.id,
        eventId: eventRow.id,
        reason: 'Auto-flagged event content',
        source: 'auto_filter',
      });
    }

    // Host always gets their own accepted invitee row, regardless of
    // draft/sent — homepage visibility depends entirely on having one.
    const { error: hostInviteError } = await supabase.from('invitees').insert([
      {
        event_id: eventRow.id,
        user_id: session!.user.id,
        rsvp_status: 'accepted',
        invited_via: 'app',
        responded_at: new Date().toISOString(),
      },
    ]);
    if (hostInviteError) console.error('Error creating host invitee row:', hostInviteError);

    if (selectedCoHostIds.length > 0) {
      // Re-check each co-host's account link right before granting them
      // full permissions — same re-check-before-invite pattern used for
      // regular invitees below, but a co-host has no SMS-fallback path,
      // so a stale/broken link just means that person doesn't become a
      // co-host on this occurrence rather than silently mis-targeting.
      const healedCoHosts = await Promise.all(
        selectedCoHostIds.map(async (cid) => {
          const contact = contacts.find((c) => c.id === cid);
          return contact ? healContactLink(supabase, contact) : contact;
        })
      );
      const coHostUserIds = healedCoHosts.map((c) => c?.linked_user_id).filter((id): id is string => !!id);
      if (coHostUserIds.length > 0) {
        const { error: eventHostsError } = await supabase
          .from('event_hosts')
          .insert(coHostUserIds.map((uid) => ({ event_id: eventRow.id, user_id: uid })));
        if (eventHostsError) console.error('Error adding co-hosts:', eventHostsError);

        const { error: coHostInviteError } = await supabase.from('invitees').insert(
          coHostUserIds.map((uid) => ({
            event_id: eventRow.id,
            user_id: uid,
            rsvp_status: 'accepted',
            invited_via: 'app',
            responded_at: new Date().toISOString(),
          }))
        );
        if (coHostInviteError) console.error('Error creating co-host invitee rows:', coHostInviteError);
      }
    }

    if (items.length > 0) {
      const { error: itemsError } = await supabase.from('items').insert(
        items.map((it) => ({
          event_id: eventRow.id,
          name: it.name,
          quantity_needed: parseInt(it.qty, 10) || 1,
          allow_custom: it.allowCustom,
        }))
      );
      if (itemsError) console.error('Error creating items:', itemsError);
    }

    let smsQueueItems: QueueContact[] = [];
    if (status === 'sent') {
      const contactIds = resolveInviteeContactIds();
      if (contactIds.length > 0) {
        // Re-check each contact's account link right before inviting —
        // the locally-loaded list can be stale if they signed up after
        // being added, and a stuck null link means the invite (and its
        // notification) never reaches anyone.
        const healedContacts = await Promise.all(
          contactIds.map(async (cid) => {
            const contact = contacts.find((c) => c.id === cid);
            return contact ? healContactLink(supabase, contact) : contact;
          })
        );
        const rows = contactIds.map((cid, i) => {
          const contact = healedContacts[i];
          return {
            event_id: eventRow.id,
            contact_id: cid,
            user_id: contact?.linked_user_id || null,
            rsvp_status: 'pending',
            invited_via: contact?.linked_user_id ? 'app' : contact?.phone ? 'sms' : 'email',
          };
        });
        const { data: insertedInvitees, error: inviteeError } = await supabase
          .from('invitees')
          .insert(rows)
          .select();
        if (inviteeError) {
          console.error('Error creating invitees:', inviteeError);
        } else if (shouldNotify) {
          const notifiableUserIds = rows.map((r) => r.user_id).filter(Boolean);
          await notify(
            notifiableUserIds,
            "You're invited! 🎉",
            `${title} — tap to view and RSVP${recurrenceId ? ' (repeats)' : ''}`,
            { eventId: eventRow.id, type: 'invite' }
          );
          smsQueueItems = (insertedInvitees || [])
            .filter((r) => r.invited_via === 'sms' && r.contact_id)
            .map((r) => {
              const contact = healedContacts.find((c) => c?.id === r.contact_id);
              return contact?.phone ? { inviteeId: r.id, name: contact.name, phone: contact.phone } : null;
            })
            .filter((c): c is QueueContact => !!c);
        }
      }
    }

    return { eventId: eventRow.id, smsQueueItems };
  };

  const submit = async (status: 'sent' | 'draft') => {
    if (!title) {
      Alert.alert('Missing info', 'Please add at least a title.');
      return;
    }
    if (!session?.user?.id) return;

    setSubmitting(true);

    let imageUrl: string | null = null;
    let imageUrlFull: string | null = null;
    if (imageUri) {
      setUploadingImage(true);
      try {
        [imageUrl, imageUrlFull] = await Promise.all([
          uploadEventImage(imageUri, session.user.id),
          uploadEventImageFull(originalImageUri || imageUri, session.user.id),
        ]);
      } catch (err) {
        console.error('Error uploading image:', err);
        setUploadingImage(false);
        setSubmitting(false);
        Alert.alert('Image upload failed', 'Could not upload the photo. Try again, or continue without one.');
        return;
      }
      setUploadingImage(false);
    }

    let smsQueueItems: QueueContact[] = [];

    if (recurrence) {
      const recurrenceId = Crypto.randomUUID();
      const occurrences = generateOccurrences(eventDate, endDate, recurrence);
      const failedDates: string[] = [];
      let firstOccurrenceCreated = false;

      for (let i = 0; i < occurrences.length; i++) {
        const occ = occurrences[i];
        try {
          const result = await createOccurrence(
            occ.startDate,
            occ.endDate,
            recurrenceId,
            imageUrl,
            imageUrlFull,
            status,
            i === 0
          );
          if (i === 0) {
            firstOccurrenceCreated = true;
            smsQueueItems = result.smsQueueItems;
          }
        } catch (err) {
          console.error('Error creating occurrence:', occ.startDate, err);
          failedDates.push(occ.startDate.toLocaleDateString());
        }
      }

      setSubmitting(false);

      if (!firstOccurrenceCreated) {
        Alert.alert('Error', 'Something went wrong creating the event.');
        return;
      }
      if (failedDates.length > 0) {
        Alert.alert(
          'Some occurrences could not be created',
          `Everything else was added. These dates failed: ${failedDates.join(', ')}`
        );
      }
    } else {
      try {
        const result = await createOccurrence(eventDate, endDate, null, imageUrl, imageUrlFull, status, true);
        smsQueueItems = result.smsQueueItems;
      } catch (err) {
        setSubmitting(false);
        console.error('Error creating event:', err);
        Alert.alert('Error', 'Something went wrong creating the event.');
        return;
      }
      setSubmitting(false);
    }

    // Same-app-only invites (or drafts, with no invitees at all) skip
    // straight to finishing - the queue only interrupts when there's
    // actually someone to text.
    if (smsQueueItems.length > 0) {
      setPendingFinishStatus(status);
      setQueueContacts(smsQueueItems);
      setQueueVisible(true);
    } else {
      resetForm();
      onCreated(status);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
      <View style={styles.overlay}>
        <Animated.View style={[styles.card, { transform: [{ translateY: dragY }] }]}>
          <View
            style={styles.dragHandleArea}
            hitSlop={{ top: 10, bottom: 16, left: 30, right: 30 }}
            {...panResponder.panHandlers}
          >
            <View style={styles.handle} />
          </View>
          <ScrollView
            style={{ flex: 1 }}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 24 }}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.header}>Create a Ping</Text>

            {imageUri ? (
              <TouchableOpacity onPress={handlePhotoTap} activeOpacity={0.85}>
                <LinearGradient colors={cardFrameGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.imageFrame}>
                  <Image source={{ uri: imageUri }} style={styles.image} resizeMode="cover" />
                  <View style={styles.editPhotoBadge}>
                    <Text style={styles.editPhotoBadgeIcon}>✏️</Text>
                  </View>
                </LinearGradient>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.addImageRow} onPress={handlePhotoTap}>
                <Text style={styles.addImageText}>+ Add an image</Text>
              </TouchableOpacity>
            )}

            <Text style={styles.label}>Event Title</Text>
            <TextInput
              style={styles.input}
              placeholder="Game Night"
              placeholderTextColor={colors.textMuted}
              value={title}
              onChangeText={setTitle}
            />

            <Text style={styles.label}>Description</Text>
            <TextInput
              style={[styles.input, styles.descriptionInput]}
              placeholder="Any extra details guests should know"
              placeholderTextColor={colors.textMuted}
              value={description}
              onChangeText={setDescription}
              multiline
            />

            <Text style={styles.label}>Date & Time</Text>
            <View style={styles.row}>
              <TouchableOpacity
                style={styles.pillButton}
                onPress={() => { setPickerMode('date'); setPickerTarget('start'); setShowPicker(true); }}
              >
                <Text style={styles.pillButtonText}>{formatDate(eventDate)}</Text>
              </TouchableOpacity>
              {!isAllDay && (
                <TouchableOpacity
                  style={styles.pillButton}
                  onPress={() => { setPickerMode('time'); setPickerTarget('start'); setShowPicker(true); }}
                >
                  <Text style={styles.pillButtonText}>{formatTime(eventDate)}</Text>
                </TouchableOpacity>
              )}
            </View>

            {(isMultiDay || !isAllDay) && (
              <>
                <Text style={styles.sublabel}>Ends</Text>
                <View style={styles.row}>
                  {isMultiDay && (
                    <TouchableOpacity
                      style={styles.pillButton}
                      onPress={() => { setPickerMode('date'); setPickerTarget('end'); setShowPicker(true); }}
                    >
                      <Text style={styles.pillButtonText}>{formatDate(endDate || eventDate)}</Text>
                    </TouchableOpacity>
                  )}
                  {!isAllDay && (
                    <TouchableOpacity
                      style={styles.pillButton}
                      onPress={() => { setPickerMode('time'); setPickerTarget('end'); setShowPicker(true); }}
                    >
                      <Text style={styles.pillButtonText}>{formatTime(endDate || eventDate)}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </>
            )}

            {showPicker && pickerMode === 'date' && (
              <View style={styles.calendarWrap}>
                <Calendar
                  current={toDateString(pickerTarget === 'end' ? endDate || eventDate : eventDate)}
                  onDayPress={onDayPress}
                  markedDates={{
                    [toDateString(pickerTarget === 'end' ? endDate || eventDate : eventDate)]: { selected: true },
                  }}
                  theme={calendarTheme}
                />
              </View>
            )}
            {showPicker && pickerMode === 'date' && (
              <TouchableOpacity onPress={() => setShowPicker(false)}>
                <Text style={styles.doneText}>Done</Text>
              </TouchableOpacity>
            )}

            {showPicker && pickerMode === 'time' && (
              <DateTimePicker
                value={pickerTarget === 'end' ? endDate || eventDate : eventDate}
                mode="time"
                display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                onChange={onChangeDate}
                minuteInterval={15}
                themeVariant="light"
                textColor={colors.textPrimary}
              />
            )}
            {Platform.OS === 'ios' && showPicker && pickerMode === 'time' && (
              <TouchableOpacity onPress={() => setShowPicker(false)}>
                <Text style={styles.doneText}>Done</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity style={styles.publicRow} onPress={toggleMultiDay}>
              <View style={[styles.checkbox, isMultiDay && styles.checkboxChecked]}>
                {isMultiDay && <Text style={styles.checkmark}>✓</Text>}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.publicRowTitle}>Multi-day event</Text>
                <Text style={styles.publicRowSubtitle}>Spans more than one day, like a trip</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity style={styles.publicRow} onPress={() => setIsAllDay((v) => !v)}>
              <View style={[styles.checkbox, isAllDay && styles.checkboxChecked]}>
                {isAllDay && <Text style={styles.checkmark}>✓</Text>}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.publicRowTitle}>All day</Text>
                <Text style={styles.publicRowSubtitle}>No specific start time</Text>
              </View>
            </TouchableOpacity>

            <RecurrencePicker value={recurrence} onChange={setRecurrence} />

            <Text style={styles.label}>Location</Text>
            <TextInput
              style={styles.input}
              placeholder="Mom and Dad's house"
              placeholderTextColor={colors.textMuted}
              value={location}
              onChangeText={setLocation}
            />

            <TouchableOpacity style={styles.publicRow} onPress={() => setIsPublic(!isPublic)}>
              <View style={[styles.checkbox, isPublic && styles.checkboxChecked]}>
                {isPublic && <Text style={styles.checkmark}>✓</Text>}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.publicRowTitle}>Make this event shareable</Text>
                <Text style={styles.publicRowSubtitle}>Those you invite can invite others</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity style={styles.publicRow} onPress={() => setDiscoverable((v) => !v)}>
              <View style={[styles.checkbox, discoverable && styles.checkboxChecked]}>
                {discoverable && <Text style={styles.checkmark}>✓</Text>}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.publicRowTitle}>List on Discover</Text>
                <Text style={styles.publicRowSubtitle}>
                  Any nearby Ping user can find this and say they're going — also makes it shareable
                </Text>
              </View>
            </TouchableOpacity>

            {discoverable && (
              <>
                <Text style={styles.sublabel}>Category</Text>
                <View style={styles.chipRow}>
                  {(Object.keys(CATEGORY_LABELS) as ActivityCategory[]).map((cat) => (
                    <TouchableOpacity
                      key={cat}
                      style={[styles.chip, discoverCategory === cat && styles.chipSelected]}
                      onPress={() => setDiscoverCategory(cat)}
                    >
                      <Text style={[styles.chipText, discoverCategory === cat && styles.chipTextSelected]}>
                        {CATEGORY_LABELS[cat]}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.sublabel}>Limit how many can join (optional)</Text>
                <TextInput
                  style={styles.input}
                  placeholder="No limit"
                  placeholderTextColor={colors.textMuted}
                  value={capacity}
                  onChangeText={(text) => setCapacity(text.replace(/[^0-9]/g, ''))}
                  keyboardType="number-pad"
                />

                <Text style={styles.sublabel}>Price (optional)</Text>
                {connectStatus?.status === 'ready' ? (
                  <TextInput
                    style={styles.input}
                    placeholder="Free"
                    placeholderTextColor={colors.textMuted}
                    value={price}
                    onChangeText={(text) => setPrice(text.replace(/[^0-9.]/g, ''))}
                    keyboardType="decimal-pad"
                  />
                ) : (
                  <Text style={styles.publicRowSubtitle}>
                    Connect a Stripe account in Settings → Payouts to charge for this event.
                  </Text>
                )}
              </>
            )}

            <Text style={styles.label}>Invite</Text>

            <TouchableOpacity style={styles.importRow} onPress={() => setImportVisible(true)}>
              <Text style={styles.importText}>📇 Import from Contacts</Text>
            </TouchableOpacity>

            {groups.length > 0 && (
              <>
                <Text style={styles.sublabel}>Groups</Text>
                <View style={styles.chipRow}>
                  {groups.map((g) => (
                    <TouchableOpacity
                      key={g.id}
                      style={[styles.chip, selectedGroupIds.includes(g.id) && styles.chipSelected]}
                      onPress={() => toggleGroup(g.id)}
                    >
                      <Text style={[styles.chipText, selectedGroupIds.includes(g.id) && styles.chipTextSelected]}>
                        {g.name}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {selectedGroupIds.map((gid) => {
                  const group = groups.find((g) => g.id === gid);
                  if (!group || group.members.length === 0) return null;
                  return (
                    <View key={gid} style={styles.groupMembersBlock}>
                      <Text style={styles.groupMembersLabel}>{group.name} — tap to exclude</Text>
                      <View style={styles.chipRow}>
                        {group.members.map((member) => {
                          const included = !excludedGroupMemberIds.includes(member.contactId);
                          return (
                            <TouchableOpacity
                              key={member.contactId}
                              style={[styles.memberChip, included ? styles.memberChipIncluded : styles.memberChipExcluded]}
                              onPress={() => toggleGroupMember(member.contactId)}
                            >
                              <Text
                                style={[
                                  styles.memberChipText,
                                  included && styles.memberChipTextIncluded,
                                ]}
                              >
                                {member.name}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>
                  );
                })}
              </>
            )}

            <Text style={styles.sublabel}>
              {showAllContacts || favoriteContactIds.length === 0 ? 'People' : 'Favorites'}
            </Text>
            <View style={styles.chipRow}>
              {(showAllContacts || favoriteContactIds.length === 0
                ? contacts
                : (favoriteContactIds
                    .map((id) => contacts.find((c) => c.id === id))
                    .filter(Boolean) as Contact[])
              ).map((c) => (
                <TouchableOpacity
                  key={c.id}
                  style={[styles.chip, selectedContactIds.includes(c.id) && styles.chipSelected]}
                  onPress={() => toggleContact(c.id)}
                >
                  <Text style={[styles.chipText, selectedContactIds.includes(c.id) && styles.chipTextSelected]}>
                    {c.name}
                  </Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity style={styles.addChip} onPress={() => setAddingContact(true)}>
                <Text style={styles.addChipText}>+ New</Text>
              </TouchableOpacity>
            </View>
            {!showAllContacts && favoriteContactIds.length > 0 && contacts.length > favoriteContactIds.length && (
              <TouchableOpacity onPress={() => setShowAllContacts(true)}>
                <Text style={styles.seeAllText}>See all ({contacts.length})</Text>
              </TouchableOpacity>
            )}

            {addingContact && (
              <View style={styles.addContactRow}>
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  placeholder="Name"
                  placeholderTextColor={colors.textMuted}
                  value={newContactName}
                  onChangeText={setNewContactName}
                  autoFocus
                />
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  placeholder="Phone (optional)"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="phone-pad"
                  value={newContactPhone}
                  onChangeText={setNewContactPhone}
                />
                <TouchableOpacity style={styles.addContactButton} onPress={handleAddContact}>
                  <Text style={styles.addContactButtonText}>Add</Text>
                </TouchableOpacity>
              </View>
            )}

            {contacts.length === 0 && groups.length === 0 && !addingContact && (
              <Text style={styles.helperText}>No contacts yet — tap "+ New" or import from your phone.</Text>
            )}

            {contacts.some((c) => c.linked_user_id) && (
              <>
                <Text style={styles.label}>Co-hosts</Text>
                <Text style={styles.helperText}>
                  Full permissions to edit, delete, invite, and manage items - same as you.
                </Text>
                <View style={styles.chipRow}>
                  {contacts
                    .filter((c) => c.linked_user_id)
                    .map((c) => (
                      <TouchableOpacity
                        key={c.id}
                        style={[styles.chip, selectedCoHostIds.includes(c.id) && styles.chipSelected]}
                        onPress={() => toggleCoHost(c.id)}
                      >
                        <Text style={[styles.chipText, selectedCoHostIds.includes(c.id) && styles.chipTextSelected]}>
                          {c.name}
                        </Text>
                      </TouchableOpacity>
                    ))}
                </View>
              </>
            )}

            <View style={styles.whatToBringHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>What to bring</Text>
                <Text style={styles.helperText}>Guests can claim these once they get the invite.</Text>
              </View>
              <TouchableOpacity style={styles.suggestButton} onPress={handleSuggestItems} disabled={suggestingItems}>
                <Text style={styles.suggestButtonText}>{suggestingItems ? 'Thinking…' : '✨ Suggest'}</Text>
              </TouchableOpacity>
            </View>

            {suggestedItems.length > 0 && (
              <View style={styles.chipRow}>
                {suggestedItems.map((name) => (
                  <TouchableOpacity key={name} style={styles.chip} onPress={() => addSuggestedItem(name)}>
                    <Text style={styles.chipText}>+ {name}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {items.map((it, idx) => (
              <View key={idx} style={styles.itemRow}>
                <Text style={styles.itemRowText}>
                  {it.name}
                  {it.allowCustom ? ' — guests describe' : parseInt(it.qty, 10) > 1 ? ` (x${it.qty})` : ''}
                </Text>
                <TouchableOpacity onPress={() => removeItem(idx)}>
                  <Text style={styles.itemRemoveText}>Remove</Text>
                </TouchableOpacity>
              </View>
            ))}

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

            <View style={styles.addContactRow}>
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
              <TouchableOpacity style={styles.addContactButton} onPress={handleAddItem}>
                <Text style={styles.addContactButtonText}>Add</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>

          {!showPicker && !keyboardVisible && (
            <View style={styles.footer}>
              <TouchableOpacity style={[styles.footerButton, styles.saveButton]} onPress={() => submit('draft')} disabled={submitting}>
                <Text style={styles.saveButtonText}>Save for later</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.footerButton, styles.sendButton]}
                onPress={() => submit('sent')}
                disabled={submitting || groupsLoading}
              >
                <Text style={styles.sendButtonText}>
                  {uploadingImage ? 'Uploading photo...' : submitting ? 'Sending...' : groupsLoading ? 'Loading...' : 'Send'}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* The Save/Send footer above is hidden while the keyboard covers
              it (there's no room for both) - this floats right above the
              keyboard as the one way back to it, since nothing else on this
              densely-packed form reliably dismisses the keyboard on tap. */}
          {keyboardVisible && (
            <TouchableOpacity
              style={styles.keyboardDoneBar}
              onPress={() => Keyboard.dismiss()}
            >
              <Text style={styles.keyboardDoneText}>Done</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={styles.closeArea}
            onPress={onClose}
            disabled={showPicker || keyboardVisible}
          >
            {!showPicker && !keyboardVisible && <Text style={styles.closeText}>Cancel</Text>}
          </TouchableOpacity>
        </Animated.View>
      </View>
      </KeyboardAvoidingView>

      <ImportContactsModal visible={importVisible} onClose={() => setImportVisible(false)} onImported={handleImported} />

      <NonAppInviteQueue
        visible={queueVisible}
        contacts={queueContacts}
        eventTitle={title || 'An event'}
        eventDate={eventDate}
        location={location}
        onDone={() => setQueueVisible(false)}
        onClosed={() => {
          resetForm();
          if (pendingFinishStatus) onCreated(pendingFinishStatus);
        }}
      />

      <ImageCropModal
        visible={cropModalVisible}
        uri={cropSourceUri}
        onCancel={() => setCropModalVisible(false)}
        onCropped={(uri) => {
          setImageUri(uri);
          setCropModalVisible(false);
        }}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(43,43,43,0.4)' },
  card: { height: '92%', backgroundColor: colors.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20 },
  dragHandleArea: { paddingVertical: 12, marginBottom: 4 },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center' },
  header: { fontSize: 22, fontWeight: '700', color: colors.textPrimary, marginBottom: 16 },
  imageFrame: { borderRadius: 18, padding: 3, marginBottom: 16 },
  image: { width: '100%', aspectRatio: EVENT_IMAGE_ASPECT_RATIO, borderRadius: 15 },
  addImageRow: { paddingVertical: 10, marginBottom: 4 },
  addImageText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  editPhotoBadge: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(43,43,43,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  editPhotoBadgeIcon: { fontSize: 15 },
  label: { fontWeight: '600', marginTop: 14, marginBottom: 6, color: colors.textPrimary },
  whatToBringHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  suggestButton: {
    marginTop: 14,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  suggestButtonText: { color: colors.primary, fontSize: 13, fontWeight: '700' },
  sublabel: { color: colors.textSecondary, fontSize: 13, marginTop: 8, marginBottom: 6 },
  seeAllText: { color: colors.primary, fontSize: 13, fontWeight: '600', marginTop: 8 },
  helperText: { color: colors.textMuted, fontSize: 13, marginTop: 8, fontStyle: 'italic' },
  importRow: { backgroundColor: colors.surfaceAlt, borderRadius: 10, paddingVertical: 10, alignItems: 'center', marginBottom: 10 },
  importText: { color: colors.primary, fontWeight: '600', fontSize: 14 },
  publicRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 18, paddingVertical: 10 },
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkmark: { color: colors.textOnPrimary, fontSize: 14, fontWeight: '700' },
  publicRowTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  publicRowSubtitle: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, fontSize: 16, color: colors.textPrimary, backgroundColor: colors.surface },
  descriptionInput: { minHeight: 80, textAlignVertical: 'top' },
  row: { flexDirection: 'row', gap: 10 },
  pillButton: { flex: 1, backgroundColor: colors.surface, borderRadius: 10, borderWidth: 1, borderColor: colors.border, paddingVertical: 12, alignItems: 'center' },
  pillButtonText: { color: colors.textPrimary, fontSize: 15 },
  doneText: { color: colors.primary, textAlign: 'right', marginTop: 4, fontSize: 15, fontWeight: '600' },
  calendarWrap: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: 'hidden', marginTop: 4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.surface },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.textSecondary, fontSize: 14 },
  chipTextSelected: { color: colors.textOnPrimary, fontWeight: '600' },
  addChip: { borderWidth: 1, borderColor: colors.primary, borderStyle: 'dashed', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 },
  addChipText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  groupMembersBlock: { marginTop: 6, marginBottom: 4, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: colors.border },
  groupMembersLabel: { color: colors.textMuted, fontSize: 12, marginBottom: 6 },
  memberChip: { borderWidth: 1, borderColor: colors.border, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
  memberChipIncluded: { backgroundColor: colors.surface },
  memberChipExcluded: { backgroundColor: colors.divider, borderColor: colors.divider },
  memberChipText: { color: colors.textMuted, fontSize: 13, textDecorationLine: 'line-through' },
  memberChipTextIncluded: { color: colors.textSecondary, fontWeight: '600', textDecorationLine: 'none' },
  addContactRow: { flexDirection: 'row', gap: 8, marginTop: 10, alignItems: 'center' },
  addContactButton: { backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 12 },
  addContactButtonText: { color: colors.textOnPrimary, fontWeight: '600' },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  itemRowText: { color: colors.textPrimary, fontSize: 15 },
  itemRemoveText: { color: colors.danger, fontSize: 13, fontWeight: '600' },
  customToggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  customToggleText: { color: colors.textSecondary, fontSize: 13, flex: 1 },
  footer: { flexDirection: 'row', gap: 12, marginTop: 12 },
  footerButton: { flex: 1, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  keyboardDoneBar: {
    // KeyboardAvoidingView (wrapping the whole modal, see below) already
    // shifts this card up by the keyboard's height - bottom:0 here lands
    // right above the keyboard for free. An earlier version also offset
    // this by keyboardHeight on top of that, double-compensating and
    // landing the bar in the middle of the screen instead.
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  keyboardDoneText: { color: colors.primary, fontWeight: '700', fontSize: 15 },
  saveButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  saveButtonText: { color: colors.textPrimary, fontWeight: '600', fontSize: 15 },
  sendButton: { backgroundColor: colors.primary },
  sendButtonText: { color: colors.textOnPrimary, fontWeight: '700', fontSize: 15 },
  closeArea: { alignItems: 'center', marginTop: 10 },
  closeText: { color: colors.textMuted, fontSize: 14 },
});
