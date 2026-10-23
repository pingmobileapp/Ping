import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { colors } from '../lib/theme';
import { COMMON_TIME_ZONES, deviceTimeZone, zoneAbbreviation, zoneLabel } from '../lib/timeZones';

type Props = {
  value: string;
  onChange: (zone: string) => void;
  // When the zone was picked for the host from the Ping's location, says
  // so - a time zone that changed by itself should never be a surprise.
  fromLocation?: boolean;
};

// The "Time zone" line under a Ping's times in Create and Edit: which
// zone's clock the times above are in (see lib/timeZones.ts). Quiet when
// it's the phone's own zone, since that's what nearly every Ping uses.
export default function TimeZoneRow({ value, onChange, fromLocation }: Props) {
  const [open, setOpen] = useState(false);
  const device = deviceTimeZone();
  const isDevice = value === device;
  const choices = [
    { label: `${zoneLabel(device)} (your phone)`, zone: device },
    ...(isDevice || COMMON_TIME_ZONES.some((z) => z.zone === value) ? [] : [{ label: zoneLabel(value), zone: value }]),
    ...COMMON_TIME_ZONES.filter((z) => z.zone !== device),
  ];

  return (
    <>
      <TouchableOpacity style={styles.row} onPress={() => setOpen(true)} accessibilityRole="button">
        <Text style={[styles.text, !isDevice && styles.textOther]} numberOfLines={1}>
          Time zone: {zoneLabel(value)} ({zoneAbbreviation(value)})
          {fromLocation && !isDevice ? ' · from location' : ''}
        </Text>
        <Text style={styles.change}>Change</Text>
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={styles.card}>
            <Text style={styles.title}>Time Zone</Text>
            <ScrollView style={{ maxHeight: 420 }}>
              {choices.map((c) => (
                <TouchableOpacity
                  key={c.zone}
                  style={styles.choice}
                  onPress={() => {
                    onChange(c.zone);
                    setOpen(false);
                  }}
                >
                  <Text style={[styles.choiceText, c.zone === value && styles.choiceSelected]}>
                    {c.label} ({zoneAbbreviation(c.zone)})
                  </Text>
                  {c.zone === value && <Text style={styles.check}>✓</Text>}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 8 },
  text: { flex: 1, color: colors.textSecondary, fontSize: 13 },
  textOther: { color: colors.textPrimary, fontWeight: '600' },
  change: { color: colors.primary, fontSize: 13, fontWeight: '600' },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(43,43,43,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  card: { width: '100%', maxWidth: 360, backgroundColor: colors.background, borderRadius: 16, paddingVertical: 8 },
  title: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 6,
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  choiceText: { flex: 1, color: colors.textPrimary, fontSize: 16 },
  choiceSelected: { fontWeight: '700' },
  check: { color: colors.primary, fontSize: 16, fontWeight: '700' },
});
