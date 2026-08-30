import React from 'react';
import { Alert, Linking, View, Text, Image, StyleSheet, TouchableOpacity } from 'react-native';
import { colors, EVENT_IMAGE_ASPECT_RATIO } from '../lib/theme';
import { formatEventDate, formatEventTime } from '../lib/eventDate';
import { DailyWeather } from '../lib/eventWeather';

export type PingEvent = {
  id: string;
  title: string;
  location: string;
  event_date: string;
  end_date?: string | null;
  is_all_day?: boolean;
  status?: 'sent' | 'draft';
  image_url?: string | null;
  // Set only when this occurrence is part of a series (see
  // CreateEventModal's batch-create) - every occurrence is otherwise a
  // fully independent row, this is purely a display hint.
  recurrence_id?: string | null;
  // Set when this Ping was created via a single selected group in
  // CreateEventModal - lets a group's own screen show its tagged events.
  group_id?: string | null;
};

type RsvpStatus = 'pending' | 'accepted' | 'interested' | 'declined';

const RSVP_DOT_COLOR: Record<'accepted' | 'interested' | 'declined', string> = {
  accepted: colors.success,
  interested: colors.warning,
  declined: colors.danger,
};

type Props = {
  event: PingEvent;
  onPress?: (event: PingEvent) => void;
  highlight?: boolean;
  // Your own response, shown as a small badge so you don't have to open
  // the card just to remember what you already told the host.
  rsvpStatus?: RsvpStatus;
  // See lib/eventWeather.ts - null means resolved but unavailable
  // (forecast out of range, or no location to anchor it to at all),
  // undefined/omitted means not resolved yet.
  weather?: DailyWeather;
};

export default function EventCard({ event, onPress, highlight, rsvpStatus, weather }: Props) {
  const rsvpDotColor = rsvpStatus && rsvpStatus !== 'pending' ? RSVP_DOT_COLOR[rsvpStatus] : null;
  const dateLabel = formatEventDate(event.event_date, event.end_date, 'short');
  const timeLabel = formatEventTime(event.event_date, event.is_all_day, event.end_date);

  // Apple doesn't publish an official way for another app to deep-link
  // into its own Weather app (unlike Maps/Music) - this scheme is
  // commonly reported to work but isn't documented, so it's not
  // guaranteed across every iOS version. Falls back to a plain alert
  // rather than silently doing nothing if it can't be opened.
  const handleWeatherPress = () => {
    Linking.openURL('weather://').catch(() => {
      Alert.alert('Could not open Weather', "Your phone's Weather app couldn't be opened.");
    });
  };

  return (
    <TouchableOpacity
      style={[styles.wrapper, highlight && styles.wrapperHighlight]}
      activeOpacity={0.85}
      onPress={() => onPress?.(event)}
    >
      <View style={styles.inner}>
        {event.status === 'draft' && (
          <View style={styles.draftBadge}>
            <Text style={styles.draftBadgeText}>DRAFT</Text>
          </View>
        )}

        {!!rsvpDotColor && <View style={[styles.rsvpDot, { backgroundColor: rsvpDotColor }]} />}

        {!!event.image_url && (
          <Image source={{ uri: event.image_url }} style={styles.image} resizeMode="cover" />
        )}

        <Text style={styles.title} numberOfLines={1}>
          {event.title}
        </Text>

        <View style={styles.statBar}>
          <View style={styles.statTopRow}>
            <Text style={styles.statText} numberOfLines={1}>
              {!!event.recurrence_id && '↻ '}
              {dateLabel} · {timeLabel}
            </Text>
            {!!weather && (
              <TouchableOpacity onPress={handleWeatherPress} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={styles.weatherText}>
                  {weather.icon} {weather.highF}°/{weather.lowF}°
                </Text>
              </TouchableOpacity>
            )}
          </View>
          {!!event.location && (
            <Text style={styles.statText} numberOfLines={1}>
              {event.location}
            </Text>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrapper: { marginHorizontal: 20, marginVertical: 8, borderRadius: 20 },
  wrapperHighlight: {
    shadowColor: colors.primary,
    shadowOpacity: 0.6,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  inner: {
    backgroundColor: colors.surfaceLight,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.primaryPale,
    padding: 12,
  },
  draftBadge: {
    position: 'absolute',
    top: 14,
    left: 14,
    zIndex: 2,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  draftBadgeText: { color: '#eee', fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  rsvpDot: {
    position: 'absolute',
    top: 14,
    right: 14,
    zIndex: 2,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.surfaceLight,
  },
  image: { width: '100%', aspectRatio: EVENT_IMAGE_ASPECT_RATIO, borderRadius: 12, marginBottom: 10 },
  title: { color: colors.textPrimary, fontSize: 18, fontWeight: '800', marginBottom: 6 },
  statBar: { borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 6, gap: 2 },
  statTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  statText: { color: colors.textSecondary, fontSize: 13, flexShrink: 1 },
  weatherText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
});
