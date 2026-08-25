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
import { supabase } from '../supabase';
import { useAuth } from '../lib/AuthContext';
import { findOrCreateContact, healContactLink, getAlreadyInvitedPhones, normalizePhone } from '../lib/phone';
import { loadMemberGroups } from '../lib/sharedGroups';
import { uploadEventImage, uploadEventImageFull } from '../lib/imageUpload';
import { pickEventImage } from '../lib/imagePicker';
import { colors, cardFrameGradient, calendarTheme, EVENT_IMAGE_ASPECT_RATIO } from '../lib/theme';
import { isMultiDayEvent } from '../lib/eventDate';
import { notify } from '../lib/notify';
import ImportContactsModal from './ImportContactsModal';
import ImageCropModal from './ImageCropModal';
import NonAppInviteQueue, { QueueContact } from './NonAppInviteQueue';

type Contact = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  linked_user_id: string | null;
};

type GroupMember = { contactId: string; name: string };
type Group = { id: string; name: string; members: GroupMember[] };

export type EditableEvent = {
  id: string;
  title: string;
  location: string;
  event_date: string;
  end_date: string | null;
  is_all_day: boolean;
  image_url: string | null;
  image_url_full: string | null;
  is_public: boolean;
  status: 'sent' | 'draft';
  description: string | null;
  recurrence_id: string | null;
};

type Props = {
  visible: boolean;
  event: EditableEvent | null;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
};

// Edits an existing event. If it's still a draft, this also doubles as
// the "finish creating it" flow. The invite picker is always available so
// the host can add more people later too - handleSave only sends invites
// to newly selected people, deduped against who's already invited.
export default function EditEventModal({ visible, event, onClose, onSaved, onDeleted }: Props) {
  const { session } = useAuth();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [eventDate, setEventDate] = useState(new Date());
  const [endDate, setEndDate] = useState<Date | null>(null);
  const [isMultiDay, setIsMultiDay] = useState(false);
  const [isAllDay, setIsAllDay] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerMode, setPickerMode] = useState<'date' | 'time'>('date');
  const [pickerTarget, setPickerTarget] = useState<'start' | 'end'>('start');
  const [submitting, setSubmitting] = useState(false);
  const [isPublic, setIsPublic] = useState(false);
  const [imageUri, setImageUri] = useState<string | null>(null);
  // The never-cropped pick, kept separate from imageUri (the cropped
  // result) so recropping always has full image data to work with - see
  // handlePhotoTap. Only ever populated for a photo picked this session;
  // an event's already-saved photo has no original on hand to fall back
  // to, since only the cropped version ever gets uploaded.
  const [originalImageUri, setOriginalImageUri] = useState<string | null>(null);
  const [existingImageUrl, setExistingImageUrl] = useState<string | null>(null);
  const [existingImageUrlFull, setExistingImageUrlFull] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [cropModalVisible, setCropModalVisible] = useState(false);
  const [cropSourceUri, setCropSourceUri] = useState<string | null>(null);

  const isDraft = event?.status === 'draft';

  const [contacts, setContacts] = useState<Contact[]>([]);
  // See the matching comment in CreateEventModal - blocks saving/sending
  // until any shared group's members have finished being materialized into
  // your own contacts, so a selected shared group can't get silently
  // dropped from the invite.
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [favoriteContactIds, setFavoriteContactIds] = useState<string[]>([]);
  const [showAllContacts, setShowAllContacts] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [excludedGroupMemberIds, setExcludedGroupMemberIds] = useState<string[]>([]);
  const [existingInviteeContactIds, setExistingInviteeContactIds] = useState<Set<string>>(new Set());
  const [existingInviteePhones, setExistingInviteePhones] = useState<Set<string>>(new Set());
  const [addingContact, setAddingContact] = useState(false);
  const [newContactName, setNewContactName] = useState('');
  const [newContactPhone, setNewContactPhone] = useState('');
  const [importVisible, setImportVisible] = useState(false);
  const [queueContacts, setQueueContacts] = useState<QueueContact[]>([]);
  const [queueVisible, setQueueVisible] = useState(false);

  const [items, setItems] = useState<{ id: string; name: string; qty: string; allowCustom: boolean }[]>([]);
  const [newItemName, setNewItemName] = useState('');
  const [newItemQty, setNewItemQty] = useState('1');
  const [newItemAllowCustom, setNewItemAllowCustom] = useState(false);

  const dragY = useRef(new Animated.Value(0)).current;
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    if (visible) dragY.setValue(0);
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
    if (visible && event) {
      setTitle(event.title);
      setDescription(event.description || '');
      setLocation(event.location || '');
      setEventDate(new Date(event.event_date));
      setEndDate(
        event.end_date
          ? new Date(event.end_date)
          : new Date(new Date(event.event_date).getTime() + 60 * 60000)
      );
      // Events saved before this had an explicit end time all have
      // end_date === null - only a real, different-day end_date means it
      // was actually set up as spanning multiple days.
      setIsMultiDay(isMultiDayEvent(event.event_date, event.end_date));
      setIsAllDay(!!event.is_all_day);
      setIsPublic(event.is_public);
      setImageUri(null);
      setOriginalImageUri(null);
      setExistingImageUrl(event.image_url);
      setExistingImageUrlFull(event.image_url_full);
      setSelectedContactIds([]);
      setSelectedGroupIds([]);
      setExcludedGroupMemberIds([]);
      setShowAllContacts(false);
      setItems([]);

      if (session?.user?.id) {
        loadContactsAndGroups();
      }
    }
  }, [visible, event?.id]);

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

    // Groups someone else shared with you - see the matching comment in
    // CreateEventModal.
    const { groups: memberGroups, newContacts } = await loadMemberGroups(
      supabase,
      session!.user.id,
      contactsData || []
    );
    if (memberGroups.length > 0) setGroups([...ownedGroups, ...memberGroups]);
    if (newContacts.length > 0) {
      setContacts((prev) => [...prev, ...newContacts].sort((a, b) => a.name.localeCompare(b.name)));
    }

    if (event) {
      const { data: existingInvitees } = await supabase
        .from('invitees')
        .select('contact_id')
        .eq('event_id', event.id);
      setExistingInviteeContactIds(
        new Set((existingInvitees || []).map((i) => i.contact_id).filter(Boolean))
      );
      setExistingInviteePhones(await getAlreadyInvitedPhones(supabase, event.id));

      const { data: itemsData, error: itemsError } = await supabase
        .from('items')
        .select('id, name, quantity_needed, allow_custom')
        .eq('event_id', event.id)
        .order('name');
      if (itemsError) console.error('Error loading items:', itemsError);
      setItems(
        (itemsData || []).map((it) => ({
          id: it.id,
          name: it.name,
          qty: String(it.quantity_needed),
          allowCustom: it.allow_custom,
        }))
      );
    }

    setGroupsLoading(false);
  };

  // Unlike CreateEventModal, the event already exists here, so items are
  // written straight to the database as they're added/removed rather than
  // queued locally until save.
  const handleAddItem = async () => {
    if (!newItemName.trim() || !event) return;

    const { data, error } = await supabase
      .from('items')
      .insert([
        {
          event_id: event.id,
          name: newItemName.trim(),
          quantity_needed: parseInt(newItemQty, 10) || 1,
          allow_custom: newItemAllowCustom,
        },
      ])
      .select()
      .single();

    if (error) {
      console.error('Error adding item:', error);
      Alert.alert('Error', 'Could not add that item.');
      return;
    }

    setItems((prev) => [
      ...prev,
      { id: data.id, name: data.name, qty: String(data.quantity_needed), allowCustom: data.allow_custom },
    ]);
    setNewItemName('');
    setNewItemQty('1');
    setNewItemAllowCustom(false);
    Keyboard.dismiss();
  };

  const removeItem = async (itemId: string) => {
    // Claims reference the item, so they need to go first or the delete
    // below would fail against them.
    const { error: claimsError } = await supabase.from('item_claims').delete().eq('item_id', itemId);
    if (claimsError) console.error('Error removing item claims:', claimsError);

    const { error } = await supabase.from('items').delete().eq('id', itemId);
    if (error) {
      console.error('Error removing item:', error);
      Alert.alert('Error', 'Could not remove that item.');
      return;
    }
    setItems((prev) => prev.filter((it) => it.id !== itemId));
  };

  // Approximation used only for the Save button's label - handleSave
  // re-checks against fresh data at save time before actually inviting.
  const getNewInviteeIds = (): string[] => {
    const contactIds = resolveInviteeContactIds();
    const seenPhones = new Set(existingInviteePhones);
    const result: string[] = [];
    for (const cid of contactIds) {
      if (existingInviteeContactIds.has(cid)) continue;
      const phone = normalizePhone(contacts.find((c) => c.id === cid)?.phone);
      if (phone && seenPhones.has(phone)) continue;
      result.push(cid);
      if (phone) seenPhones.add(phone);
    }
    return result;
  };

  const startCrop = (uri: string) => {
    setCropSourceUri(uri);
    setCropModalVisible(true);
  };

  // A photo already attached (whether a fresh local pick or the event's
  // already-uploaded one) gets a choice to just reframe it in place instead
  // of always forcing a fresh trip through the library. Recropping starts
  // from the original, never-cropped pick when there is one - once a photo
  // has been cropped to the exact target frame there's no extra image data
  // left outside it to reposition, so recropping the previous crop result
  // would have nothing to actually do. An event's already-saved photo has
  // no such original on hand (only the cropped version was ever uploaded),
  // so that case still recrops the saved photo itself.
  const handlePhotoTap = async () => {
    const currentUri = imageUri || existingImageUrl;
    if (currentUri) {
      Alert.alert('Photo', undefined, [
        { text: 'Recrop This Photo', onPress: () => startCrop(originalImageUri || currentUri) },
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

  const formatDate = (date: Date) =>
    date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  const formatTime = (date: Date) =>
    date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  const onChangeDate = (e: any, selectedDate?: Date) => {
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
    const allIds = Array.from(new Set([...selectedContactIds, ...fromGroups]));
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

  // Guests who already have this event (invited, and especially ones who've
  // already told the host they're coming) never heard about it if the host
  // changed the date/location/title afterward — this asks the host whether
  // to let them know before saving, rather than always doing one or the
  // other silently.
  const confirmAndSave = (sendNow: boolean) => {
    if (!event) return;

    if (event.recurrence_id) {
      Alert.alert('Apply changes to', undefined, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'This event only', onPress: () => confirmNotifyAndSave(sendNow, false) },
        { text: 'This and following events', onPress: () => confirmNotifyAndSave(sendNow, true) },
      ]);
      return;
    }

    confirmNotifyAndSave(sendNow, false);
  };

  const confirmNotifyAndSave = (sendNow: boolean, applyToFuture: boolean) => {
    if (!event) return;
    const nextEndDate = isMultiDay && endDate ? endDate.toISOString() : null;
    const changedDetails =
      !isDraft &&
      (title !== event.title ||
        description.trim() !== (event.description || '') ||
        location !== (event.location || '') ||
        eventDate.toISOString() !== event.event_date ||
        nextEndDate !== (event.end_date || null) ||
        isAllDay !== !!event.is_all_day);

    if (!changedDetails) {
      handleSave(sendNow, false, applyToFuture);
      return;
    }

    Alert.alert(
      'Notify guests?',
      "You've changed this event's details. Let the people you've invited know?",
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Save silently', onPress: () => handleSave(sendNow, false, applyToFuture) },
        { text: 'Save & notify', onPress: () => handleSave(sendNow, true, applyToFuture) },
      ]
    );
  };

  const handleSave = async (sendNow: boolean, notifyExisting: boolean, applyToFuture: boolean) => {
    if (!event || !session?.user?.id) return;
    if (!title) {
      Alert.alert('Missing info', 'Please add at least a title.');
      return;
    }

    setSubmitting(true);

    let imageUrl = existingImageUrl;
    let imageUrlFull = existingImageUrlFull;
    if (imageUri) {
      setUploadingImage(true);
      try {
        if (originalImageUri) {
          [imageUrl, imageUrlFull] = await Promise.all([
            uploadEventImage(imageUri, session.user.id),
            uploadEventImageFull(originalImageUri, session.user.id),
          ]);
        } else {
          // Recropped the already-saved photo with no original on hand -
          // there's nothing better than the cropped result to offer as the
          // full version, so leave whatever full image already existed
          // (if any) alone rather than overwrite it with the cropped one.
          imageUrl = await uploadEventImage(imageUri, session.user.id);
        }
      } catch (err) {
        console.error('Error uploading image:', err);
        setUploadingImage(false);
        setSubmitting(false);
        Alert.alert('Image upload failed', 'Could not upload the photo. Try again, or continue without changing it.');
        return;
      }
      setUploadingImage(false);
    }

    let error;
    if (applyToFuture && event.recurrence_id) {
      // Bulk-applying to sibling occurrences deliberately excludes
      // event_date/end_date - shifting a whole series' dates needs
      // relative-offset math, not an absolute overwrite, and is out of
      // scope here. A date/time change always saves as "this event only"
      // (the branch below), never bulk.
      const futureUpdates: Record<string, any> = {
        title,
        description: description.trim() || null,
        location,
        is_all_day: isAllDay,
        is_public: isPublic,
        image_url: imageUrl,
        image_url_full: imageUrlFull,
      };
      if (sendNow) futureUpdates.status = 'sent';

      ({ error } = await supabase
        .from('events')
        .update(futureUpdates)
        .eq('recurrence_id', event.recurrence_id)
        .gte('event_date', event.event_date));
    } else {
      const updates: Record<string, any> = {
        title,
        description: description.trim() || null,
        location,
        event_date: eventDate.toISOString(),
        end_date: endDate ? endDate.toISOString() : null,
        is_all_day: isAllDay,
        is_public: isPublic,
        image_url: imageUrl,
        image_url_full: imageUrlFull,
      };
      if (sendNow) updates.status = 'sent';

      ({ error } = await supabase.from('events').update(updates).eq('id', event.id));
    }

    if (error) {
      setSubmitting(false);
      console.error('Error updating event:', error);
      Alert.alert('Error', 'Something went wrong saving your changes.');
      return;
    }

    if (notifyExisting) {
      const { data: allInvitees } = await supabase
        .from('invitees')
        .select('user_id')
        .eq('event_id', event.id);
      const recipientIds = (allInvitees || [])
        .map((i) => i.user_id)
        .filter((id): id is string => !!id && id !== session.user.id);
      if (recipientIds.length > 0) {
        await notify(recipientIds, `${title} was updated`, "The host changed this event's details — take a look.", {
          eventId: event.id,
          type: 'event_updated',
        });
      }
    }

    // Newly selected people get invited whether this is the draft's first
    // send or just adding more people to an event that already went out.
    let smsQueueItems: QueueContact[] = [];
    const contactIds = resolveInviteeContactIds();
    if (contactIds.length > 0) {
      const { data: existingInvitees } = await supabase
        .from('invitees')
        .select('contact_id')
        .eq('event_id', event.id);
      const alreadyInvitedContactIds = new Set(
        (existingInvitees || []).map((i) => i.contact_id).filter(Boolean)
      );
      const alreadyInvitedPhones = await getAlreadyInvitedPhones(supabase, event.id);

      const toInvite: string[] = [];
      for (const cid of contactIds) {
        if (alreadyInvitedContactIds.has(cid)) continue;
        const contact = contacts.find((c) => c.id === cid);
        const phone = normalizePhone(contact?.phone);
        if (phone && alreadyInvitedPhones.has(phone)) continue;
        toInvite.push(cid);
        if (phone) alreadyInvitedPhones.add(phone);
      }

      if (toInvite.length > 0) {
        // Re-check each contact's account link right before inviting — see
        // the matching comment in CreateEventModal.
        const healedContacts = await Promise.all(
          toInvite.map(async (cid) => {
            const contact = contacts.find((c) => c.id === cid);
            return contact ? healContactLink(supabase, contact) : contact;
          })
        );
        const rows = toInvite.map((cid, i) => {
          const contact = healedContacts[i];
          return {
            event_id: event.id,
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
        } else {
          const notifiableUserIds = rows.map((r) => r.user_id).filter(Boolean);
          await notify(notifiableUserIds, "You're invited! 🎉", `${title} — tap to view and RSVP`, {
            eventId: event.id,
            type: 'invite',
          });
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

    setSubmitting(false);

    // Same as CreateEventModal - only interrupt with the texting flow when
    // there's actually someone to text.
    if (smsQueueItems.length > 0) {
      setQueueContacts(smsQueueItems);
      setQueueVisible(true);
    } else {
      onSaved();
    }
  };

  const handleDeleteEvent = async (shouldNotify: boolean, applyToFuture: boolean) => {
    if (!event) return;
    setSubmitting(true);

    // Everything below used to run as one unguarded chain of awaits — if
    // any single step threw (a network blip, an RLS rejection), the catch
    // block below didn't exist yet, so setSubmitting(false) never ran and
    // the modal was stuck showing its "deleting" state forever, which reads
    // as the whole app freezing on delete. That catch alone isn't enough
    // for a step that never resolves OR rejects (a genuinely stuck request
    // rather than a fast failure) - a real family-testing report of exactly
    // this (frozen, no crash log, had to force-quit) had no error to catch
    // in the first place. Racing the whole sequence against a timeout means
    // it fails loudly instead of hanging forever either way.
    const TIMEOUT_MS = 15000;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timed out deleting event')), TIMEOUT_MS)
    );

    // Invitees with no linked account never receive the push notification
    // below - the host is the only way they'd ever hear this was canceled,
    // so this is collected up front (before the invitees rows are gone)
    // and surfaced after the delete succeeds, rather than letting them
    // silently never find out.
    let unreachableNames: string[] = [];

    try {
      await Promise.race([
        (async () => {
          // "This and following events" needs every sibling occurrence's
          // id up front - everything below (notify/cascade-delete) then
          // operates across all of them instead of just event.id.
          let eventIds = [event.id];
          if (applyToFuture && event.recurrence_id) {
            const { data: siblingRows } = await supabase
              .from('events')
              .select('id')
              .eq('recurrence_id', event.recurrence_id)
              .gte('event_date', event.event_date);
            if (siblingRows && siblingRows.length > 0) eventIds = siblingRows.map((r) => r.id);
          }

          if (shouldNotify) {
            // Only the current occurrence's invitees are notified/checked
            // for reachability, same "once, not per occurrence" reasoning
            // as CreateEventModal's batch-create - a family doesn't need a
            // separate cancellation notice for each of 10 canceled weeks.
            const { data: allInvitees } = await supabase
              .from('invitees')
              .select('user_id, invited_via, contacts(name, phone)')
              .eq('event_id', event.id);
            const recipientIds = (allInvitees || [])
              .map((i) => i.user_id)
              .filter((id): id is string => !!id && id !== session?.user?.id);
            if (recipientIds.length > 0) {
              await notify(
                recipientIds,
                'Event canceled',
                applyToFuture ? `"${title}" and its remaining repeats have been canceled.` : `"${title}" has been canceled.`,
                { eventId: event.id, type: 'event_canceled' }
              );
            }
            unreachableNames = (allInvitees || [])
              .filter((i: any) => !i.user_id && i.invited_via === 'sms' && i.contacts?.phone)
              .map((i: any) => i.contacts?.name || 'Guest');
          }

          // Cascade delete configuration on the DB side is unknown, so
          // clean up dependents manually rather than risk a foreign-key
          // failure.
          const { data: eventItems } = await supabase.from('items').select('id').in('event_id', eventIds);
          const itemIds = (eventItems || []).map((i) => i.id);
          if (itemIds.length > 0) {
            await supabase.from('item_claims').delete().in('item_id', itemIds);
          }
          await supabase.from('items').delete().in('event_id', eventIds);
          await supabase.from('messages').delete().in('event_id', eventIds);
          await supabase.from('invitees').delete().in('event_id', eventIds);

          const { error } = await supabase.from('events').delete().in('id', eventIds);
          if (error) throw error;
        })(),
        timeout,
      ]);

      if (unreachableNames.length > 0) {
        Alert.alert(
          "Some guests won't be notified",
          `${unreachableNames.join(', ')} won't get an automatic notice since they don't have Ping — you'll need to text them yourself to let them know it was canceled.`,
          [{ text: 'OK', onPress: onDeleted }]
        );
      } else {
        onDeleted();
      }
    } catch (err) {
      console.error('Error deleting event:', err);
      Alert.alert('Error', 'Could not delete this event. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDelete = () => {
    if (event?.recurrence_id) {
      Alert.alert('Delete which events?', undefined, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'This event only', style: 'destructive', onPress: () => confirmDeleteNotify(false) },
        { text: 'This and following events', style: 'destructive', onPress: () => confirmDeleteNotify(true) },
      ]);
      return;
    }
    confirmDeleteNotify(false);
  };

  const confirmDeleteNotify = (applyToFuture: boolean) => {
    Alert.alert('Delete this event?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete silently', style: 'destructive', onPress: () => handleDeleteEvent(false, applyToFuture) },
      { text: 'Notify & delete', style: 'destructive', onPress: () => handleDeleteEvent(true, applyToFuture) },
    ]);
  };

  if (!event) return null;

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
            <Text style={styles.header}>{isDraft ? 'Finish Draft' : 'Edit Event'}</Text>

            {imageUri || existingImageUrl ? (
              <TouchableOpacity onPress={handlePhotoTap} activeOpacity={0.85}>
                <LinearGradient colors={cardFrameGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.imageFrame}>
                  <Image source={{ uri: imageUri || existingImageUrl! }} style={styles.image} resizeMode="cover" />
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

            {!!event.recurrence_id && (
              // Ping series don't store their recurrence pattern anywhere
              // (only that these rows share recurrence_id) - a full
              // RecurrencePicker summary would need data that doesn't
              // exist, so this is just an honest "you're editing one part
              // of a series" note. Saving/deleting still asks which
              // occurrences to apply to, below.
              <Text style={styles.recurrenceNote}>↻ Part of a repeating series</Text>
            )}

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
                <Text style={styles.publicRowTitle}>Make this event public</Text>
                <Text style={styles.publicRowSubtitle}>
                  {isPublic ? 'Invitees can share this Ping with others' : 'Only you can select who gets invited'}
                </Text>
              </View>
            </TouchableOpacity>

            <>
                <Text style={styles.label}>{isDraft ? 'Invite' : 'Invite more people'}</Text>

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

                <Text style={styles.label}>What to bring</Text>
                <Text style={styles.helperText}>Guests can claim these once they get the invite.</Text>

                {items.map((it) => (
                  <View key={it.id} style={styles.itemRow}>
                    <Text style={styles.itemRowText}>
                      {it.name}
                      {it.allowCustom ? ' — guests describe' : parseInt(it.qty, 10) > 1 ? ` (x${it.qty})` : ''}
                    </Text>
                    <TouchableOpacity onPress={() => removeItem(it.id)}>
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
              </>
          </ScrollView>

          {!showPicker && !keyboardVisible && (
            <View style={styles.footer}>
              {isDraft ? (
                <>
                  <TouchableOpacity
                    style={[styles.footerButton, styles.saveButton]}
                    onPress={() => confirmAndSave(false)}
                    disabled={submitting || groupsLoading}
                  >
                    <Text style={styles.saveButtonText}>Save Draft</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.footerButton, styles.sendButton]}
                    onPress={() => confirmAndSave(true)}
                    disabled={submitting || groupsLoading}
                  >
                    <Text style={styles.sendButtonText}>
                      {uploadingImage ? 'Uploading...' : submitting ? 'Sending...' : groupsLoading ? 'Loading...' : 'Send'}
                    </Text>
                  </TouchableOpacity>
                </>
              ) : (
                <TouchableOpacity
                  style={[styles.footerButton, styles.sendButton, { flex: 1 }]}
                  onPress={() => confirmAndSave(false)}
                  disabled={submitting || groupsLoading}
                >
                  <Text style={styles.sendButtonText}>
                    {uploadingImage
                      ? 'Uploading...'
                      : submitting
                      ? 'Saving...'
                      : groupsLoading
                      ? 'Loading...'
                      : getNewInviteeIds().length > 0
                      ? 'Save & Send Invites'
                      : 'Save Changes'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* Same reasoning as CreateEventModal.tsx: the footer above is
              hidden while the keyboard covers it, so this is the one
              reliable way back to it on this densely-packed form. */}
          {keyboardVisible && (
            <TouchableOpacity
              style={styles.keyboardDoneBar}
              onPress={() => Keyboard.dismiss()}
            >
              <Text style={styles.keyboardDoneText}>Done</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity style={styles.closeArea} onPress={onClose} disabled={showPicker || keyboardVisible}>
            {!showPicker && !keyboardVisible && <Text style={styles.closeText}>Cancel</Text>}
          </TouchableOpacity>

          {!showPicker && !keyboardVisible && (
            <TouchableOpacity
              style={styles.deleteArea}
              onPress={confirmDelete}
              disabled={submitting}
            >
              <Text style={styles.deleteText}>Delete Event</Text>
            </TouchableOpacity>
          )}
        </Animated.View>
      </View>
      </KeyboardAvoidingView>

      <ImportContactsModal visible={importVisible} onClose={() => setImportVisible(false)} onImported={handleImported} />

      <NonAppInviteQueue
        visible={queueVisible}
        contacts={queueContacts}
        eventTitle={title || event.title}
        eventDate={eventDate}
        location={location}
        onDone={() => setQueueVisible(false)}
        onClosed={onSaved}
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
  sublabel: { color: colors.textSecondary, fontSize: 13, marginTop: 8, marginBottom: 6 },
  seeAllText: { color: colors.primary, fontSize: 13, fontWeight: '600', marginTop: 8 },
  helperText: { color: colors.textMuted, fontSize: 13, marginTop: 8, fontStyle: 'italic' },
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
  importRow: { backgroundColor: colors.surfaceAlt, borderRadius: 10, paddingVertical: 10, alignItems: 'center', marginBottom: 10 },
  importText: { color: colors.primary, fontWeight: '600', fontSize: 14 },
  publicRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 18, paddingVertical: 10 },
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkmark: { color: colors.textOnPrimary, fontSize: 14, fontWeight: '700' },
  publicRowTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  publicRowSubtitle: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  recurrenceNote: { color: colors.textSecondary, fontSize: 13, marginTop: 8, fontStyle: 'italic' },
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
  deleteArea: { alignItems: 'center', marginTop: 8 },
  deleteText: { color: colors.danger, fontSize: 14, fontWeight: '600' },
});
