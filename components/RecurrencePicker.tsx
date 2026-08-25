import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { colors } from '../lib/theme';
import { RecurrenceConfig, RecurrenceFrequency } from '../lib/recurrence';

type Props = {
  value: RecurrenceConfig | null;
  onChange: (value: RecurrenceConfig | null) => void;
  // Editing an item that's already part of a series - frequency/interval/
  // end can't be changed after creation (a series' shape is fixed once
  // occurrences exist; the caller offers its own "this event only / this
  // and following" choice instead), so this just shows a read-only summary.
  readOnlyExisting?: boolean;
};

const FREQUENCY_LABELS: Record<RecurrenceFrequency, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  yearly: 'Yearly',
};

const FREQUENCY_OPTIONS: RecurrenceFrequency[] = ['daily', 'weekly', 'monthly', 'yearly'];

const summarize = (config: RecurrenceConfig): string => {
  const base =
    config.interval > 1
      ? `Every ${config.interval} ${config.frequency.replace('ly', '')}s`
      : FREQUENCY_LABELS[config.frequency];
  if (config.end.type === 'onDate') {
    return `${base}, until ${config.end.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  if (config.end.type === 'afterCount') {
    return `${base}, ${config.end.count} time${config.end.count === 1 ? '' : 's'}`;
  }
  return base;
};

export default function RecurrencePicker({ value, onChange, readOnlyExisting }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [showEndDatePicker, setShowEndDatePicker] = useState(false);

  const toggleRepeats = () => {
    if (readOnlyExisting) return;
    if (value) {
      onChange(null);
      setExpanded(false);
    } else {
      onChange({ frequency: 'weekly', interval: 1, end: { type: 'never' } });
      setExpanded(true);
    }
  };

  return (
    <View>
      <TouchableOpacity
        style={styles.row}
        onPress={value ? () => setExpanded((v) => !v) : toggleRepeats}
        disabled={readOnlyExisting && !value}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.rowTitle}>Repeats</Text>
          <Text style={styles.rowSubtitle}>{value ? summarize(value) : 'Does not repeat'}</Text>
        </View>
        {!readOnlyExisting && (
          <View style={[styles.checkbox, !!value && styles.checkboxChecked]}>
            {value && <Text style={styles.checkmark}>✓</Text>}
          </View>
        )}
      </TouchableOpacity>

      {value && !readOnlyExisting && expanded && (
        <View style={styles.editor}>
          <View style={styles.chipRow}>
            {FREQUENCY_OPTIONS.map((freq) => (
              <TouchableOpacity
                key={freq}
                style={[styles.chip, value.frequency === freq && styles.chipSelected]}
                onPress={() => onChange({ ...value, frequency: freq })}
              >
                <Text style={[styles.chipText, value.frequency === freq && styles.chipTextSelected]}>
                  {FREQUENCY_LABELS[freq]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.stepperRow}>
            <Text style={styles.stepperLabel}>Every</Text>
            <TouchableOpacity
              style={styles.stepperButton}
              onPress={() => onChange({ ...value, interval: Math.max(1, value.interval - 1) })}
            >
              <Text style={styles.stepperButtonText}>−</Text>
            </TouchableOpacity>
            <Text style={styles.stepperValue}>{value.interval}</Text>
            <TouchableOpacity
              style={styles.stepperButton}
              onPress={() => onChange({ ...value, interval: value.interval + 1 })}
            >
              <Text style={styles.stepperButtonText}>+</Text>
            </TouchableOpacity>
            <Text style={styles.stepperLabel}>{value.frequency.replace('ly', '')}{value.interval > 1 ? 's' : ''}</Text>
          </View>

          <Text style={styles.endLabel}>Ends</Text>
          <View style={styles.chipRow}>
            <TouchableOpacity
              style={[styles.chip, value.end.type === 'never' && styles.chipSelected]}
              onPress={() => onChange({ ...value, end: { type: 'never' } })}
            >
              <Text style={[styles.chipText, value.end.type === 'never' && styles.chipTextSelected]}>Never</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.chip, value.end.type === 'onDate' && styles.chipSelected]}
              onPress={() => {
                onChange({ ...value, end: { type: 'onDate', date: new Date(Date.now() + 30 * 24 * 60 * 60000) } });
                setShowEndDatePicker(true);
              }}
            >
              <Text style={[styles.chipText, value.end.type === 'onDate' && styles.chipTextSelected]}>On date</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.chip, value.end.type === 'afterCount' && styles.chipSelected]}
              onPress={() => onChange({ ...value, end: { type: 'afterCount', count: 10 } })}
            >
              <Text style={[styles.chipText, value.end.type === 'afterCount' && styles.chipTextSelected]}>
                After N times
              </Text>
            </TouchableOpacity>
          </View>

          {value.end.type === 'onDate' && (
            <TouchableOpacity style={styles.pillButton} onPress={() => setShowEndDatePicker(true)}>
              <Text style={styles.pillButtonText}>
                {value.end.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
              </Text>
            </TouchableOpacity>
          )}
          {value.end.type === 'onDate' && showEndDatePicker && (
            <DateTimePicker
              value={value.end.date}
              mode="date"
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              minimumDate={new Date()}
              onChange={(_, selected) => {
                if (Platform.OS === 'android') setShowEndDatePicker(false);
                if (selected && value.end.type === 'onDate') {
                  onChange({ ...value, end: { type: 'onDate', date: selected } });
                }
              }}
              themeVariant="light"
              textColor={colors.textPrimary}
            />
          )}
          {value.end.type === 'onDate' && showEndDatePicker && Platform.OS === 'ios' && (
            <TouchableOpacity onPress={() => setShowEndDatePicker(false)}>
              <Text style={styles.doneText}>Done</Text>
            </TouchableOpacity>
          )}

          {value.end.type === 'afterCount' && (
            <View style={styles.stepperRow}>
              <TouchableOpacity
                style={styles.stepperButton}
                onPress={() =>
                  value.end.type === 'afterCount' &&
                  onChange({ ...value, end: { type: 'afterCount', count: Math.max(1, value.end.count - 1) } })
                }
              >
                <Text style={styles.stepperButtonText}>−</Text>
              </TouchableOpacity>
              <Text style={styles.stepperValue}>{value.end.count}</Text>
              <TouchableOpacity
                style={styles.stepperButton}
                onPress={() =>
                  value.end.type === 'afterCount' &&
                  onChange({ ...value, end: { type: 'afterCount', count: value.end.count + 1 } })
                }
              >
                <Text style={styles.stepperButtonText}>+</Text>
              </TouchableOpacity>
              <Text style={styles.stepperLabel}>times</Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16, paddingVertical: 6 },
  rowTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  rowSubtitle: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkmark: { color: colors.textOnPrimary, fontSize: 13, fontWeight: '700' },
  editor: { marginTop: 8, paddingLeft: 2 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.surface },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.textSecondary, fontSize: 14 },
  chipTextSelected: { color: colors.textOnPrimary, fontWeight: '600' },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  stepperLabel: { color: colors.textPrimary, fontSize: 14 },
  stepperButton: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  stepperButtonText: { color: colors.textPrimary, fontSize: 18, fontWeight: '600', marginTop: -2 },
  stepperValue: { color: colors.textPrimary, fontSize: 15, fontWeight: '600', minWidth: 20, textAlign: 'center' },
  endLabel: { color: colors.textPrimary, fontSize: 13, fontWeight: '600', marginBottom: 6 },
  pillButton: { alignSelf: 'flex-start', backgroundColor: colors.surface, borderRadius: 10, borderWidth: 1, borderColor: colors.border, paddingVertical: 10, paddingHorizontal: 14, marginBottom: 10 },
  pillButtonText: { color: colors.textPrimary, fontSize: 14 },
  doneText: { color: colors.primary, textAlign: 'right', marginBottom: 8, fontSize: 15, fontWeight: '600' },
});
