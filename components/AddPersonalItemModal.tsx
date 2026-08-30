import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, Alert, KeyboardAvoidingView, Keyboard, Animated, PanResponder, ScrollView } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Calendar } from 'react-native-calendars';
import { colors, calendarTheme } from '../lib/theme';
import {
  ExternalEvent,
  getCalendarPermissionStatus,
  requestCalendarAccess,
  createPersonalCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from '../lib/calendarConflicts';
import RecurrencePicker from './RecurrencePicker';
import { RecurrenceConfig, toExpoRecurrenceRule, fromExpoRecurrenceRule } from '../lib/recurrence';
import {
  REMINDER_OPTIONS,
  schedulePersonalItemReminder,
  cancelPersonalItemReminder,
  getPersonalItemReminderMinutes,
} from '../lib/eventReminders';

type Props = {
  visible: boolean;
  initialDate?: string | null;
  // Minutes since midnight - only meaningful alongside initialDate, for a
  // creation (not edit) opened from a specific spot in Week view's grid
  // (see WeekGrid's long-press pill) rather than a generic "+" tap, which
  // has no particular time in mind.
  initialMinutes?: number | null;
  editingEvent?: ExternalEvent | null;
  onClose: () => void;
  onSaved: () => void;
  onConvertToPing?: (event: ExternalEvent) => void;
};

const toDateString = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

type PickerTarget = 'start' | 'end';

// Recurring items go through EventKit's own instance-scoping (futureEvents/
// instanceStartDate) rather than anything Ping tracks, and that's real
// native behavior this environment has no simulator to exercise before it
// ships - if it fails, showing the actual reason (not just "something went
// wrong") is what makes the next report diagnosable instead of another
// guess.
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Creating: a lightweight, device-only counterpart to a Ping - title +
// start/end time, no invitees, nothing sent. Saved straight to the phone's
// own calendar (see createPersonalCalendarEvent) so it shows up in the
// Upcoming list through the same phone-calendar import path as everything
// else there.
// Editing: also doubles as the edit form for any writable calendar event
// tapped from Upcoming (see ExternalEvent.editable), not just ones Ping
// created - editingEvent.isPersonal only changes the messaging/marker
// handling, not whether editing is allowed.
export default function AddPersonalItemModal({ visible, initialDate, initialMinutes, editingEvent, onClose, onSaved, onConvertToPing }: Props) {
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [recurrence, setRecurrence] = useState<RecurrenceConfig | null>(null);
  const [reminderMinutes, setReminderMinutes] = useState<number | null>(null);
  const [startDate, setStartDate] = useState(new Date());
  const [endDate, setEndDate] = useState(new Date(Date.now() + 60 * 60000));
  const [isAllDay, setIsAllDay] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerMode, setPickerMode] = useState<'date' | 'time'>('date');
  const [pickerTarget, setPickerTarget] = useState<PickerTarget>('start');
  const [submitting, setSubmitting] = useState(false);

  const isEditing = !!editingEvent;
  // Only an item that's already part of a series gets the read-only
  // picker + "apply to" question - editing a plain one-off item can still
  // freely turn it into a new series, no scoping question needed since
  // there's no existing series to disambiguate against.
  const isExistingRecurring = isEditing && !!editingEvent?.recurrenceRule;

  const dragY = useRef(new Animated.Value(0)).current;

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
    if (!visible) return;
    dragY.setValue(0);
    setShowPicker(false);

    if (editingEvent) {
      setTitle(editingEvent.title);
      setDetails(editingEvent.details);
      setRecurrence(editingEvent.recurrenceRule ? fromExpoRecurrenceRule(editingEvent.recurrenceRule) : null);
      // Not editingEvent.reminderMinutesBefore - that reads the calendar
      // event's own native alarm, which this deliberately never sets (see
      // schedulePersonalItemReminder). The real selection lives here instead.
      getPersonalItemReminderMinutes(editingEvent.id).then(setReminderMinutes);
      setStartDate(new Date(editingEvent.startDate));
      setEndDate(new Date(editingEvent.endDate));
      setIsAllDay(editingEvent.allDay);
      return;
    }

    setTitle('');
    setDetails('');
    setRecurrence(null);
    setReminderMinutes(null);
    setIsAllDay(false);
    const start = initialDate ? (() => {
      const [y, m, d] = initialDate.split('-').map(Number);
      const next = new Date();
      next.setFullYear(y, m - 1, d);
      // Rounded to the nearest 15 minutes, matching the time picker's own
      // minuteInterval - a long-press lands wherever the finger happened
      // to be, not necessarily on a clean quarter-hour.
      if (initialMinutes != null) {
        const rounded = Math.round(initialMinutes / 15) * 15;
        next.setHours(Math.floor(rounded / 60), rounded % 60, 0, 0);
      }
      return next;
    })() : new Date();
    setStartDate(start);
    setEndDate(new Date(start.getTime() + 60 * 60000));
  }, [visible, editingEvent, initialDate, initialMinutes]);

  const formatDate = (d: Date) =>
    d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const formatTime = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  const openPicker = (target: PickerTarget, mode: 'date' | 'time') => {
    setPickerTarget(target);
    setPickerMode(mode);
    setShowPicker(true);
  };

  const onChangeTime = (_: any, selectedDate?: Date) => {
    if (Platform.OS === 'android') setShowPicker(false);
    if (!selectedDate) return;
    if (pickerTarget === 'start') {
      setStartDate(selectedDate);
      // Keep the end from silently trailing behind a start that just got
      // moved past it - same safeguard EditEventModal uses.
      if (endDate.getTime() <= selectedDate.getTime()) {
        setEndDate(new Date(selectedDate.getTime() + 60 * 60000));
      }
    } else {
      setEndDate(selectedDate);
    }
  };

  const onDayPress = (day: { year: number; month: number; day: number }) => {
    if (pickerTarget === 'start') {
      const next = new Date(startDate);
      next.setFullYear(day.year, day.month - 1, day.day);
      setStartDate(next);
      if (endDate.getTime() < next.getTime()) {
        const nextEnd = new Date(endDate);
        nextEnd.setFullYear(day.year, day.month - 1, day.day);
        setEndDate(nextEnd);
      }
    } else {
      const next = new Date(endDate);
      next.setFullYear(day.year, day.month - 1, day.day);
      setEndDate(next);
    }
    setShowPicker(false);
  };

  const ensurePermission = async (): Promise<boolean> => {
    const status = await getCalendarPermissionStatus();
    if (status === 'granted') return true;
    if (status === 'undetermined') return await requestCalendarAccess();
    Alert.alert('Calendar access needed', "Ping needs calendar access to add personal items. Enable it in Settings.");
    return false;
  };

  const performSave = async (futureEvents?: boolean) => {
    setSubmitting(true);
    const allowed = await ensurePermission();
    if (!allowed) {
      setSubmitting(false);
      return;
    }

    try {
      const start = new Date(startDate);
      let end = new Date(endDate);
      if (isAllDay) {
        start.setHours(0, 0, 0, 0);
        end = new Date(start.getTime() + 24 * 60 * 60000);
      } else if (end.getTime() <= start.getTime()) {
        end = new Date(start.getTime() + 60 * 60000);
      }

      // null (not reminderMinutes) for the native calendar alarm - a
      // native EventKit alert shows as a generic "Calendar" notification,
      // not one Ping gets any credit for. schedulePersonalItemReminder
      // below is what actually fires it as a Ping-branded reminder.
      let calendarEventId: string;
      if (editingEvent) {
        await updateCalendarEvent(
          editingEvent.id,
          title.trim(),
          start,
          end,
          isAllDay,
          editingEvent.isPersonal,
          details,
          futureEvents,
          // Only passed when this item wasn't already recurring - an
          // existing series' rule is preserved untouched (futureEvents
          // above is what scopes the rest of this edit instead).
          !isExistingRecurring && recurrence ? toExpoRecurrenceRule(recurrence) : undefined,
          null
        );
        calendarEventId = editingEvent.id;
      } else {
        calendarEventId = await createPersonalCalendarEvent(
          title.trim(),
          start,
          end,
          isAllDay,
          details,
          recurrence ? toExpoRecurrenceRule(recurrence) : undefined,
          null
        );
      }

      if (reminderMinutes !== null) {
        await schedulePersonalItemReminder(calendarEventId, title.trim(), start, reminderMinutes);
      } else {
        await cancelPersonalItemReminder(calendarEventId);
      }

      onSaved();
    } catch (err) {
      console.error('Error saving personal calendar item:', err);
      Alert.alert('Error', `Could not save that to your calendar. (${errorMessage(err)})`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSave = () => {
    if (!title.trim()) {
      Alert.alert('Missing info', 'Please add a title.');
      return;
    }

    if (isExistingRecurring) {
      Alert.alert('Apply changes to', undefined, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'This event only', onPress: () => performSave(false) },
        { text: 'This and following events', onPress: () => performSave(true) },
      ]);
      return;
    }

    performSave();
  };

  const performDelete = async (futureEvents?: boolean) => {
    if (!editingEvent) return;
    setSubmitting(true);
    try {
      await deleteCalendarEvent(editingEvent.id, futureEvents, editingEvent.startDate);
      await cancelPersonalItemReminder(editingEvent.id);
      onSaved();
    } catch (err) {
      console.error('Error deleting calendar item:', err);
      Alert.alert('Error', `Could not delete that item. (${errorMessage(err)})`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = () => {
    if (!editingEvent) return;

    if (isExistingRecurring) {
      Alert.alert('Delete which events?', undefined, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'This event only', style: 'destructive', onPress: () => performDelete(false) },
        { text: 'This and following events', style: 'destructive', onPress: () => performDelete(true) },
      ]);
      return;
    }

    Alert.alert(
      'Delete this item?',
      editingEvent.isPersonal
        ? undefined
        : "This will also remove it from wherever this calendar is synced (Google, iCloud, a shared family calendar, etc.) - not just from Ping.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => performDelete(),
        },
      ]
    );
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
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
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: 12 }}
          >
          <Text style={styles.header}>
            {isEditing ? (editingEvent!.isPersonal ? 'Edit Personal Item' : 'Edit Calendar Event') : 'Add Personal Item'}
          </Text>
          <Text style={styles.subheader}>
            {!isEditing || editingEvent!.isPersonal
              ? "Only you can see this — it's saved to your phone's calendar, not sent to anyone."
              : "This is from one of your other calendars — changes here update it everywhere it's synced, not just in Ping."}
          </Text>

          <Text style={styles.label}>Title</Text>
          <TextInput
            style={styles.input}
            placeholder="Dentist appointment"
            placeholderTextColor={colors.textMuted}
            value={title}
            onChangeText={setTitle}
            autoFocus={!isEditing}
            returnKeyType="done"
            onSubmitEditing={Keyboard.dismiss}
          />

          <Text style={styles.label}>Details</Text>
          <TextInput
            style={[styles.input, styles.detailsInput]}
            placeholder="Bring cleats, wear the blue jersey, anything else worth remembering"
            placeholderTextColor={colors.textMuted}
            value={details}
            onChangeText={setDetails}
            multiline
          />

          <Text style={styles.label}>Date</Text>
          <View style={styles.row}>
            <TouchableOpacity style={styles.pillButton} onPress={() => openPicker('start', 'date')}>
              <Text style={styles.pillButtonText}>{formatDate(startDate)}</Text>
            </TouchableOpacity>
            <Text style={styles.rangeDash}>–</Text>
            <TouchableOpacity style={styles.pillButton} onPress={() => openPicker('end', 'date')}>
              <Text style={styles.pillButtonText}>{formatDate(endDate)}</Text>
            </TouchableOpacity>
          </View>

          {!isAllDay && (
            <>
              <Text style={styles.label}>Time</Text>
              <View style={styles.row}>
                <TouchableOpacity style={styles.pillButton} onPress={() => openPicker('start', 'time')}>
                  <Text style={styles.pillButtonText}>{formatTime(startDate)}</Text>
                </TouchableOpacity>
                <Text style={styles.rangeDash}>–</Text>
                <TouchableOpacity style={styles.pillButton} onPress={() => openPicker('end', 'time')}>
                  <Text style={styles.pillButtonText}>{formatTime(endDate)}</Text>
                </TouchableOpacity>
              </View>
            </>
          )}

          {showPicker && pickerMode === 'date' && (
            <View style={styles.calendarWrap}>
              <Calendar
                current={toDateString(pickerTarget === 'end' ? endDate : startDate)}
                onDayPress={onDayPress}
                markedDates={{
                  [toDateString(pickerTarget === 'end' ? endDate : startDate)]: { selected: true },
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
              value={pickerTarget === 'end' ? endDate : startDate}
              mode="time"
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={onChangeTime}
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

          <TouchableOpacity style={styles.allDayRow} onPress={() => setIsAllDay((v) => !v)}>
            <View style={[styles.checkbox, isAllDay && styles.checkboxChecked]}>
              {isAllDay && <Text style={styles.checkmark}>✓</Text>}
            </View>
            <Text style={styles.allDayText}>All day</Text>
          </TouchableOpacity>

          <Text style={styles.label}>Remind me before</Text>
          <View style={styles.row}>
            {REMINDER_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.label}
                style={[styles.pillButton, reminderMinutes === opt.value && styles.pillButtonSelected]}
                onPress={() => setReminderMinutes(opt.value)}
              >
                <Text style={[styles.pillButtonText, reminderMinutes === opt.value && styles.pillButtonTextSelected]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <RecurrencePicker value={recurrence} onChange={setRecurrence} readOnlyExisting={isExistingRecurring} />

          {!showPicker && (
            <>
              <TouchableOpacity style={styles.primaryButton} onPress={handleSave} disabled={submitting}>
                <Text style={styles.primaryButtonText}>
                  {submitting ? 'Saving…' : isEditing ? 'Save Changes' : 'Add to My Calendar'}
                </Text>
              </TouchableOpacity>
              {isEditing && onConvertToPing && (
                <TouchableOpacity
                  style={styles.convertButton}
                  onPress={() => onConvertToPing(editingEvent!)}
                  disabled={submitting}
                >
                  <Text style={styles.convertButtonText}>Convert to Ping & Invite People</Text>
                </TouchableOpacity>
              )}
              {isEditing && (
                <TouchableOpacity style={styles.deleteButton} onPress={handleDelete} disabled={submitting}>
                  <Text style={styles.deleteText}>Delete</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.cancelButton} onPress={onClose} disabled={submitting}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
            </>
          )}
          </ScrollView>
        </Animated.View>
      </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(43,43,43,0.4)' },
  // height, not maxHeight - a flex:1 child (the ScrollView below) can't
  // expand to fill space in an ancestor whose own height is just "however
  // tall its content happens to be." Content here grew past the screen
  // top with nothing to scroll it (Details, Remind me before, and Repeats
  // were all added after this card was first built at its natural size).
  card: { height: '85%', backgroundColor: colors.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20 },
  dragHandleArea: { paddingVertical: 8 },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 4 },
  header: { fontSize: 20, fontWeight: '700', color: colors.textPrimary },
  subheader: { color: colors.textSecondary, fontSize: 13, marginTop: 4, marginBottom: 16, lineHeight: 18 },
  label: { fontWeight: '600', marginTop: 12, marginBottom: 6, color: colors.textPrimary },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
  },
  detailsInput: { minHeight: 60, textAlignVertical: 'top' },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  rangeDash: { color: colors.textMuted, fontSize: 15, fontWeight: '600' },
  pillButton: { flex: 1, backgroundColor: colors.surface, borderRadius: 10, borderWidth: 1, borderColor: colors.border, paddingVertical: 12, alignItems: 'center' },
  pillButtonText: { color: colors.textPrimary, fontSize: 15 },
  pillButtonSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  pillButtonTextSelected: { color: colors.textOnPrimary, fontWeight: '600' },
  allDayRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkmark: { color: colors.textOnPrimary, fontSize: 13, fontWeight: '700' },
  allDayText: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  calendarWrap: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: 'hidden', marginTop: 16 },
  doneText: { color: colors.primary, textAlign: 'right', marginTop: 8, fontSize: 15, fontWeight: '600' },
  primaryButton: { backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
  primaryButtonText: { color: colors.textOnPrimary, fontSize: 16, fontWeight: '700' },
  convertButton: { borderRadius: 14, borderWidth: 1.5, borderColor: colors.primary, paddingVertical: 13, alignItems: 'center', marginTop: 10 },
  convertButtonText: { color: colors.primary, fontSize: 15, fontWeight: '700' },
  deleteButton: { paddingVertical: 14, alignItems: 'center' },
  deleteText: { color: colors.danger, fontSize: 14, fontWeight: '600' },
  cancelButton: { paddingVertical: 6, alignItems: 'center' },
  cancelText: { color: colors.textSecondary, fontSize: 14, fontWeight: '600' },
});
