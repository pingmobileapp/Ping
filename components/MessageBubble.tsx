import React, { useEffect, useRef } from 'react';
import { Animated, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors } from '../lib/theme';
import { ReactionCount } from '../lib/useMessageReactions';
import Avatar from './Avatar';

export type BubbleAnchor = { x: number; y: number; width: number; height: number };

type Props = {
  isMine: boolean;
  senderLabel?: string;
  // Whether to render the name text above the bubble - senderLabel itself
  // is still needed even when this is false, since Avatar falls back to it
  // for the initial shown when there's no photo. Consecutive messages from
  // the same sender pass senderLabel (for the avatar) but showSenderName:
  // false (no repeated name line) - see MessageThread.tsx/
  // GroupMessageThread.tsx.
  showSenderName?: boolean;
  avatarUrl?: string | null;
  body: string;
  timestamp: string;
  reactions: ReactionCount[];
  isActive: boolean;
  onToggleReaction: (emoji: string) => void;
  onLongPressBubble: (anchor: BubbleAnchor) => void;
};

export default function MessageBubble({
  isMine,
  senderLabel,
  showSenderName = true,
  avatarUrl,
  body,
  timestamp,
  reactions,
  isActive,
  onToggleReaction,
  onLongPressBubble,
}: Props) {
  const scale = useRef(new Animated.Value(1)).current;
  const bubbleRef = useRef<View>(null);

  // Driven by `isActive` (whether this bubble's reaction picker is open)
  // rather than press-in/press-out directly, so it only pops once a long
  // press actually registers - a quick tap shouldn't visibly react at all.
  useEffect(() => {
    Animated.spring(scale, {
      toValue: isActive ? 1.06 : 1,
      useNativeDriver: true,
      friction: 6,
    }).start();
  }, [isActive, scale]);

  const handleLongPress = () => {
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    // Position of the bubble itself (not the raw touch point) is what the
    // picker anchors to - it reads more like iMessage's tapback (appears
    // right by the message) than a menu trailing your finger.
    bubbleRef.current?.measureInWindow((x, y, width, height) => {
      onLongPressBubble({ x, y, width, height });
    });
  };

  return (
    <View style={[styles.bubbleRow, isMine && styles.bubbleRowMine]}>
      {!isMine && (
        <View style={styles.avatarSlot}>
          <Avatar url={avatarUrl} name={senderLabel || '?'} size={26} />
        </View>
      )}
      <View style={isMine ? styles.bubbleColumnMine : styles.bubbleColumn}>
        <View style={styles.bubbleWrapper}>
          <Animated.View
            ref={bubbleRef}
            collapsable={false}
            style={[{ transform: [{ scale }] }, isActive && styles.raised]}
          >
            <TouchableOpacity
              style={[styles.bubble, isMine && styles.bubbleMine, isActive && styles.bubbleActive]}
              activeOpacity={0.85}
              onLongPress={handleLongPress}
              delayLongPress={280}
            >
              {!isMine && showSenderName && senderLabel && (
                <Text style={styles.senderName} numberOfLines={1}>{senderLabel}</Text>
              )}
              <Text style={[styles.bubbleText, isMine && styles.bubbleTextMine]}>{body}</Text>
              <Text style={[styles.timestamp, isMine && styles.timestampMine]} numberOfLines={1}>
                {timestamp}
              </Text>
            </TouchableOpacity>
          </Animated.View>
          {reactions.length > 0 && (
            // Overlaps the bubble's top corner (iMessage tapback style)
            // instead of stacking below it as its own row, which read like
            // a separate message. Hangs toward whichever side is away from
            // the screen edge the bubble is pinned to (left for outgoing/
            // right-aligned bubbles, right for incoming/left-aligned ones)
            // so it never gets clipped.
            <View style={[styles.reactionBadgeRow, isMine ? styles.reactionBadgeRowMine : styles.reactionBadgeRowTheirs]}>
              {reactions.map((r) => (
                <TouchableOpacity
                  key={r.emoji}
                  style={[styles.reactionBadge, r.mine && styles.reactionBadgeMine]}
                  onPress={() => onToggleReaction(r.emoji)}
                >
                  <Text style={styles.reactionBadgeText}>
                    {r.emoji}
                    {r.count > 1 ? ` ${r.count}` : ''}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bubbleRow: { flexDirection: 'row', width: '100%', marginBottom: 10, alignItems: 'flex-end' },
  bubbleRowMine: { justifyContent: 'flex-end' },
  avatarSlot: { marginRight: 6, marginBottom: 2 },
  // Explicit on this inner wrapper too, redundant with bubbleRow's
  // justifyContent - the bubble and its reaction row both need to anchor
  // to the same edge independently of each other's width, not just be
  // pushed as a shrink-wrapped unit that could end up misaligned.
  bubbleColumn: { alignItems: 'flex-start' },
  bubbleColumnMine: { alignItems: 'flex-end' },
  bubble: {
    maxWidth: '85%',
    // Without this, the bubble sizes itself to fit only its shortest line
    // (the message body, for something like "Yes") and then squeezes the
    // name/timestamp lines to fit that same narrow width instead of the
    // other way around - hence the truncated "Hy…" / "2:2…" - rather than
    // the bubble growing to fit its widest line like it visually should.
    minWidth: 110,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bubbleMine: { backgroundColor: colors.primary, borderColor: colors.primary },
  bubbleActive: { borderColor: colors.primaryDark },
  raised: {
    shadowColor: colors.textPrimary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 8,
  },
  senderName: { color: colors.textSecondary, fontSize: 11, fontWeight: '700', marginBottom: 4 },
  bubbleText: { color: colors.textPrimary, fontSize: 15 },
  bubbleTextMine: { color: colors.textOnPrimary },
  timestamp: { color: colors.textMuted, fontSize: 10, marginTop: 6, textAlign: 'right' },
  timestampMine: { color: 'rgba(255,255,255,0.75)' },
  // Bubble's own positioning context for the absolutely-positioned
  // reaction badge below - just establishes the anchor, doesn't affect
  // alignment (bubbleColumn/bubbleColumnMine's alignItems already handles
  // that via normal shrink-wrap).
  bubbleWrapper: { position: 'relative' },
  reactionBadgeRow: { position: 'absolute', top: -14, flexDirection: 'row', gap: 2 },
  reactionBadgeRowMine: { left: -4 },
  reactionBadgeRowTheirs: { right: -4 },
  reactionBadge: {
    flexDirection: 'row',
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 6,
    paddingVertical: 2,
    shadowColor: colors.textPrimary,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 2,
    elevation: 3,
  },
  reactionBadgeMine: { borderColor: colors.primary },
  reactionBadgeText: { fontSize: 13, color: colors.textPrimary },
});
