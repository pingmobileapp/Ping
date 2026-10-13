import React from 'react';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { colors } from '../lib/theme';
import { EventStop, MAX_STOPS, formatStopDay, newStop } from '../lib/stops';

type Props = {
  stops: EventStop[];
  onChange: (stops: EventStop[]) => void;
  // The event's days (YYYY-MM-DD), first to last - see stopDays.
  days: string[];
};

// "Stops along the way" for a multi-day Ping - shared by Create and Edit.
// Any number of stops per day (a lunch stop and a hotel); each picks its
// day from the event's own date range.
export default function StopsEditor({ stops, onChange, days }: Props) {
  const update = (id: string, patch: Partial<EventStop>) =>
    onChange(stops.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const remove = (id: string) => onChange(stops.filter((s) => s.id !== id));

  // A new stop lands on the day after the last one (the next night of the
  // trip), or the last day once it's reached the end.
  const add = () => {
    if (days.length === 0 || stops.length >= MAX_STOPS) return;
    const lastDay = stops.length > 0 ? stops[stops.length - 1].day : null;
    const nextIndex = lastDay ? Math.min(days.indexOf(lastDay) + 1, days.length - 1) : 0;
    onChange([...stops, newStop(days[Math.max(nextIndex, 0)])]);
  };

  return (
    <View>
      <Text style={styles.label}>Stops along the way</Text>
      <Text style={styles.helper}>Where everyone will be each day, like a hotel each night. Add as many as you need.</Text>

      {stops.map((stop, index) => (
        <View key={stop.id} style={styles.stopCard}>
          <View style={styles.stopHeader}>
            <Text style={styles.stopNumber}>Stop {index + 1}</Text>
            <TouchableOpacity onPress={() => remove(stop.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.removeText}>Remove</Text>
            </TouchableOpacity>
          </View>

          {days.length > 1 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.dayRow}
            >
              {days.map((day) => {
                const selected = stop.day === day;
                return (
                  <TouchableOpacity
                    key={day}
                    style={[styles.dayChip, selected && styles.dayChipSelected]}
                    onPress={() => update(stop.id, { day })}
                  >
                    <Text style={[styles.dayChipText, selected && styles.dayChipTextSelected]}>
                      {formatStopDay(day, 'chip')}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}

          <TextInput
            style={styles.input}
            placeholder="Place, like Hampton Inn Moab"
            placeholderTextColor={colors.textMuted}
            value={stop.name}
            onChangeText={(name) => update(stop.id, { name })}
          />
          <TextInput
            style={[styles.input, { marginTop: 8 }]}
            placeholder="Address (optional)"
            placeholderTextColor={colors.textMuted}
            value={stop.address}
            onChangeText={(address) => update(stop.id, { address })}
          />
        </View>
      ))}

      {stops.length < MAX_STOPS && (
        <TouchableOpacity style={styles.addButton} onPress={add}>
          <Text style={styles.addText}>+ Add a stop</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontWeight: '600', marginTop: 14, marginBottom: 4, color: colors.textPrimary },
  helper: { color: colors.textMuted, fontSize: 13, marginBottom: 8 },
  stopCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  stopHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  stopNumber: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  removeText: { color: colors.danger, fontSize: 13, fontWeight: '600' },
  dayRow: { gap: 8, paddingBottom: 10 },
  dayChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.surface,
  },
  dayChipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  dayChipText: { color: colors.textSecondary, fontSize: 13 },
  dayChipTextSelected: { color: colors.textOnPrimary, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
  },
  addButton: { paddingVertical: 10 },
  addText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
});
