import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Keyboard,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Calendar } from 'react-native-calendars';
import { colors, calendarTheme } from '../lib/theme';
import { ExtractedEvent } from '../lib/scheduleImport';
import { getCalendarPermissionStatus, requestCalendarAccess, createPersonalCalendarEvent } from '../lib/calendarConflicts';

type Props = {
  visible: boolean;
  extractedEvents: ExtractedEvent[];
  onClose: () => void;
  onSaved: () => void;
};

type Row = {
  key: string;
  selected: boolean;
  title: string;
  date: string | null; // yyyy-mm-dd
  startTime: string | null; // HH:mm
  endTime: string | null; // HH:mm
  location: string | null;
  yearInferred: boolean;
  confidence: 'high' | 'low';
};

type PickerTarget = 'start' | 'end';

const toDateString = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const parseDateAndTime = (date: string, time: string | null): Date => {
  const [y, m, d] = date.split('-').map(Number);
  const result = new Date();
  result.setFullYear(y, m - 1, d);
  if (time) {
    const [hh, mm] = time.split(':').map(Number);
    result.setHours(hh, mm, 0, 0);
  } else {
    result.setHours(0, 0, 0, 0);
  }
  return result;
};

const formatDateLabel = (date: string | null) =>
  date
    ? parseDateAndTime(date, null).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : 'No date';

const formatTimeLabel = (date: string, time: string | null) =>
  time ? parseDateAndTime(date, time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : 'All day';

const formatDate = (d: Date) => d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const formatTime = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const toTimeString = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// Reads a photo of a schedule (via lib/scheduleImport.ts) and shows the
// extracted candidate events for review before anything is actually
// written to the calendar - deselect anything misread, edit anything
// wrong, then confirm to create the rest via the same
// createPersonalCalendarEvent path AddPersonalItemModal uses one at a time.
export default function ScheduleReviewModal({ visible, extractedEvents, onClose, onSaved }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [editTitle, setEditTitle] = useState('');
  const [editHasDate, setEditHasDate] = useState(true);
  const [editDate, setEditDate] = useState(new Date());
  const [editAllDay, setEditAllDay] = useState(false);
  const [editStart, setEditStart] = useState(new Date());
  const [editEnd, setEditEnd] = useState(new Date());
  const [showPicker, setShowPicker] = useState(false);
  const [pickerMode, setPickerMode] = useState<'date' | 'time'>('date');
  const [pickerTarget, setPickerTarget] = useState<PickerTarget>('start');

  useEffect(() => {
    if (!visible) return;
    setRows(
      extractedEvents.map((e, i) => ({
        key: String(i),
        selected: e.date !== null,
        title: e.title,
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime,
        location: e.location,
        yearInferred: e.yearInferred,
        confidence: e.confidence,
      }))
    );
    setEditingKey(null);
  }, [visible, extractedEvents]);

  const toggleRow = (key: string) => {
    setRows((prev) => prev.map((r) => (r.key === key && r.date ? { ...r, selected: !r.selected } : r)));
  };

  const openEditor = (row: Row) => {
    setEditTitle(row.title);
    const hasDate = row.date !== null;
    setEditHasDate(hasDate);
    const base = hasDate ? parseDateAndTime(row.date!, null) : new Date();
    setEditDate(base);
    setEditAllDay(hasDate && !row.startTime);
    setEditStart(hasDate ? parseDateAndTime(row.date!, row.startTime || '09:00') : new Date());
    setEditEnd(hasDate ? parseDateAndTime(row.date!, row.endTime || row.startTime || '10:00') : new Date());
    setShowPicker(false);
    setEditingKey(row.key);
  };

  const openPicker = (target: PickerTarget, mode: 'date' | 'time') => {
    setPickerTarget(target);
    setPickerMode(mode);
    setShowPicker(true);
  };

  const onChangeTime = (_: any, selectedDate?: Date) => {
    if (Platform.OS === 'android') setShowPicker(false);
    if (!selectedDate) return;
    if (pickerTarget === 'start') {
      setEditStart(selectedDate);
      if (editEnd.getTime() <= selectedDate.getTime()) {
        setEditEnd(new Date(selectedDate.getTime() + 60 * 60000));
      }
    } else {
      setEditEnd(selectedDate);
    }
  };

  const onDayPress = (day: { year: number; month: number; day: number }) => {
    const withNewDay = (d: Date) => {
      const copy = new Date(d);
      copy.setFullYear(day.year, day.month - 1, day.day);
      return copy;
    };
    setEditDate(withNewDay(editDate));
    setEditStart((d) => withNewDay(d));
    setEditEnd((d) => withNewDay(d));
    setEditHasDate(true);
    setShowPicker(false);
  };

  const saveEditor = () => {
    if (!editTitle.trim()) {
      Alert.alert('Missing info', 'Please add a title.');
      return;
    }
    if (!editHasDate) {
      Alert.alert('Missing info', 'Please set a date.');
      return;
    }
    setRows((prev) =>
      prev.map((r) =>
        r.key === editingKey
          ? {
              ...r,
              title: editTitle.trim(),
              date: toDateString(editDate),
              startTime: editAllDay ? null : toTimeString(editStart),
              endTime: editAllDay ? null : toTimeString(editEnd),
              selected: true,
            }
          : r
      )
    );
    setEditingKey(null);
  };

  const ensurePermission = async (): Promise<boolean> => {
    const status = await getCalendarPermissionStatus();
    if (status === 'granted') return true;
    if (status === 'undetermined') return await requestCalendarAccess();
    Alert.alert('Calendar access needed', 'Ping needs calendar access to add these events. Enable it in Settings.');
    return false;
  };

  const selectedRows = rows.filter((r) => r.selected && r.date);

  const handleConfirm = async () => {
    if (selectedRows.length === 0) return;
    setSubmitting(true);
    const allowed = await ensurePermission();
    if (!allowed) {
      setSubmitting(false);
      return;
    }

    const failedKeys: string[] = [];
    for (const row of selectedRows) {
      try {
        const allDay = !row.startTime;
        let start: Date;
        let end: Date;
        if (allDay) {
          start = parseDateAndTime(row.date!, null);
          end = new Date(start.getTime() + 24 * 60 * 60000);
        } else {
          start = parseDateAndTime(row.date!, row.startTime);
          end = row.endTime ? parseDateAndTime(row.date!, row.endTime) : new Date(start.getTime() + 60 * 60000);
          if (end.getTime() <= start.getTime()) end = new Date(start.getTime() + 60 * 60000);
        }
        await createPersonalCalendarEvent(row.title, start, end, allDay);
      } catch (err) {
        console.error('Error creating event from schedule scan:', err);
        failedKeys.push(row.key);
      }
    }

    setSubmitting(false);

    if (failedKeys.length > 0) {
      const failedTitles = rows.filter((r) => failedKeys.includes(r.key)).map((r) => r.title);
      Alert.alert(
        'Some events could not be added',
        `Everything else was added. These failed, so they're still here to try again: ${failedTitles.join(', ')}`
      );
      setRows((prev) => prev.filter((r) => failedKeys.includes(r.key)));
      return;
    }

    Alert.alert('Added', `${selectedRows.length} event${selectedRows.length === 1 ? '' : 's'} added to your calendar.`);
    onSaved();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.overlay}>
          <View style={styles.card}>
            <View style={styles.handle} />

            {editingKey !== null ? (
              <>
                <Text style={styles.header}>Edit Event</Text>

                <Text style={styles.label}>Title</Text>
                <TextInput
                  style={styles.input}
                  value={editTitle}
                  onChangeText={setEditTitle}
                  returnKeyType="done"
                  onSubmitEditing={Keyboard.dismiss}
                />

                <Text style={styles.label}>Date</Text>
                <TouchableOpacity style={styles.pillButton} onPress={() => openPicker('start', 'date')}>
                  <Text style={styles.pillButtonText}>{editHasDate ? formatDate(editDate) : 'Tap to set a date'}</Text>
                </TouchableOpacity>

                {editHasDate && (
                  <TouchableOpacity style={styles.allDayRow} onPress={() => setEditAllDay((v) => !v)}>
                    <View style={[styles.checkbox, editAllDay && styles.checkboxChecked]}>
                      {editAllDay && <Text style={styles.checkmark}>✓</Text>}
                    </View>
                    <Text style={styles.allDayText}>All day</Text>
                  </TouchableOpacity>
                )}

                {editHasDate && !editAllDay && (
                  <View style={styles.row}>
                    <TouchableOpacity style={styles.pillButton} onPress={() => openPicker('start', 'time')}>
                      <Text style={styles.pillButtonText}>{formatTime(editStart)}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.pillButton} onPress={() => openPicker('end', 'time')}>
                      <Text style={styles.pillButtonText}>{formatTime(editEnd)}</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {showPicker && pickerMode === 'date' && (
                  <View style={styles.calendarWrap}>
                    <Calendar
                      current={toDateString(editDate)}
                      onDayPress={onDayPress}
                      markedDates={{ [toDateString(editDate)]: { selected: true } }}
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
                    value={pickerTarget === 'end' ? editEnd : editStart}
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

                {!showPicker && (
                  <>
                    <TouchableOpacity style={styles.primaryButton} onPress={saveEditor}>
                      <Text style={styles.primaryButtonText}>Save</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.cancelButton} onPress={() => setEditingKey(null)}>
                      <Text style={styles.cancelText}>Cancel</Text>
                    </TouchableOpacity>
                  </>
                )}
              </>
            ) : (
              <>
                <Text style={styles.header}>Review Events</Text>
                <Text style={styles.subheader}>
                  {rows.length} found — uncheck anything that looks wrong, or tap a row to edit it.
                </Text>

                <FlatList
                  style={{ flex: 1 }}
                  data={rows}
                  keyExtractor={(r) => r.key}
                  renderItem={({ item }) => (
                    <TouchableOpacity style={styles.eventRow} onPress={() => openEditor(item)}>
                      <TouchableOpacity
                        style={[styles.checkbox, item.selected && styles.checkboxChecked]}
                        onPress={() => toggleRow(item.key)}
                        disabled={!item.date}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        {item.selected && <Text style={styles.checkmark}>✓</Text>}
                      </TouchableOpacity>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.eventTitle}>{item.title}</Text>
                        <Text style={styles.eventMeta}>
                          {formatDateLabel(item.date)}
                          {item.date ? ` · ${formatTimeLabel(item.date, item.startTime)}` : ''}
                          {item.location ? ` · ${item.location}` : ''}
                        </Text>
                        {(!item.date || item.yearInferred || item.confidence === 'low') && (
                          <Text style={styles.eventFlag}>
                            {!item.date ? 'Needs a date — tap to set one' : item.yearInferred ? 'Year assumed' : 'Double-check this one'}
                          </Text>
                        )}
                      </View>
                    </TouchableOpacity>
                  )}
                  contentContainerStyle={{ paddingBottom: 12 }}
                />

                <TouchableOpacity
                  style={[styles.primaryButton, selectedRows.length === 0 && styles.primaryButtonDisabled]}
                  onPress={handleConfirm}
                  disabled={selectedRows.length === 0 || submitting}
                >
                  <Text style={styles.primaryButtonText}>
                    {submitting ? 'Adding…' : `Add ${selectedRows.length} Event${selectedRows.length === 1 ? '' : 's'}`}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.cancelButton} onPress={onClose} disabled={submitting}>
                  <Text style={styles.cancelText}>Cancel</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(43,43,43,0.4)' },
  // height, not maxHeight - a flex:1 child (the FlatList below) can't
  // expand to fill space in an ancestor whose own height is just "however
  // tall its content happens to be" (maxHeight only caps that, it doesn't
  // give Yoga a real number to size flex:1 against), so the list collapsed
  // to zero height and the event rows never rendered.
  card: { height: '85%', backgroundColor: colors.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20 },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 12 },
  header: { fontSize: 20, fontWeight: '700', color: colors.textPrimary },
  subheader: { color: colors.textSecondary, fontSize: 13, marginTop: 4, marginBottom: 12, lineHeight: 18 },
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
  row: { flexDirection: 'row', gap: 10 },
  pillButton: { flex: 1, backgroundColor: colors.surface, borderRadius: 10, borderWidth: 1, borderColor: colors.border, paddingVertical: 12, alignItems: 'center' },
  pillButtonText: { color: colors.textPrimary, fontSize: 15 },
  allDayRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkmark: { color: colors.textOnPrimary, fontSize: 13, fontWeight: '700' },
  allDayText: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  calendarWrap: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: 'hidden', marginTop: 16 },
  doneText: { color: colors.primary, textAlign: 'right', marginTop: 8, fontSize: 15, fontWeight: '600' },
  primaryButton: { backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 16 },
  primaryButtonDisabled: { backgroundColor: colors.border },
  primaryButtonText: { color: colors.textOnPrimary, fontSize: 16, fontWeight: '700' },
  cancelButton: { paddingVertical: 10, alignItems: 'center' },
  cancelText: { color: colors.textSecondary, fontSize: 14, fontWeight: '600' },
  eventRow: { flexDirection: 'row', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.divider, alignItems: 'flex-start' },
  eventTitle: { fontSize: 16, fontWeight: '600', color: colors.textPrimary },
  eventMeta: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  eventFlag: { fontSize: 12, color: colors.textSecondary, marginTop: 2, fontWeight: '600' },
});
