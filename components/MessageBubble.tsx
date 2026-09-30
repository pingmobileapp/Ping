import React, { useEffect, useRef } from 'react';
import { Animated, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors } from '../lib/theme';
import { ReactionCount } from '../lib/useMessageReactions';
import Avatar from './Avatar';
import { splitMentions } from '../lib/mentions';

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
  // Last message in a run from the same sender - gets the bubble tail and
  // (for incoming) the avatar, like iMessage. Earlier ones in the run
  // stack tightly with neither.
  isLastInRun?: boolean;
  // Centered time shown above this message when it starts a new stretch of
  // conversation (see timeHeaderFor).
  timeHeader?: string | null;
  body: string;
  // Guest names to highlight as @mentions in the body (MessageThread only).
  mentionLabels?: string[];
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
  isLastInRun = true,
  timeHeader,
  body,
  mentionLabels,
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
    <View>
      {!!timeHeader && <Text style={styles.timeHeader}>{timeHeader}</Text>}
      {!isMine && showSenderName && senderLabel && (
        <Text style={styles.senderName} numberOfLines={1}>
          {senderLabel}
        </Text>
      )}
    <View
      style={[
        styles.bubbleRow,
        isMine && styles.bubbleRowMine,
        isLastInRun ? styles.bubbleRowRunEnd : null,
        reactions.length > 0 && styles.bubbleRowWithReaction,
      ]}
    >
      {!isMine && (
        <View style={styles.avatarSlot}>
          {isLastInRun && <Avatar url={avatarUrl} name={senderLabel || '?'} size={28} />}
        </View>
      )}
      <View style={isMine ? styles.bubbleColumnMine : styles.bubbleColumn}>
        <View style={styles.bubbleWrapper}>
          <Animated.View
            ref={bubbleRef}
            collapsable={false}
            style={[{ transform: [{ scale }] }, isActive && styles.raised]}
          >
            {/* iMessage's tail: a bubble-colored curve at the bottom corner,
                trimmed by a background-colored curve. Both chat sheets are
                colors.background, which is what makes the trim invisible. */}
            {isLastInRun && (
              <>
                <View style={[styles.tail, isMine ? styles.tailMine : styles.tailTheirs]} />
                <View style={[styles.tailCut, isMine ? styles.tailCutMine : styles.tailCutTheirs]} />
              </>
            )}
            <TouchableOpacity
              style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleTheirs]}
              activeOpacity={0.85}
              onLongPress={handleLongPress}
              delayLongPress={280}
            >
              <Text style={[styles.bubbleText, isMine && styles.bubbleTextMine]}>
                {mentionLabels?.length
                  ? splitMentions(body, mentionLabels).map((part, i) =>
                      part.mention ? (
                        <Text key={i} style={styles.mention}>
                          {part.text}
                        </Text>
                      ) : (
                        part.text
                      )
                    )
                  : body}
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
    </View>
  );
}

// iMessage-style centered time: "Today 1:14 PM", "Yesterday 3:02 PM",
// "Mon 1:14 PM" within the week, else "Sep 20, 1:14 PM". Shown above a
// message that starts the thread or comes 15+ minutes after the one before.
export function timeHeaderFor(iso: string, previousIso: string | null): string | null {
  const at = new Date(iso);
  if (previousIso && at.getTime() - new Date(previousIso).getTime() < 15 * 60000) return null;
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60000;
  const diffDays = Math.floor((startOfToday.getTime() - new Date(at).setHours(0, 0, 0, 0)) / dayMs);
  if (diffDays <= 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  if (diffDays < 7) return `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

// iMessage's own colors - system blue for sent, light gray for received.
const IMESSAGE_BLUE = '#0B84FE';
const IMESSAGE_GRAY = '#E9E9EB';
const BUBBLE_RADIUS = 18;

const styles = StyleSheet.create({
  // Tight within a run from one sender, a bigger gap between runs.
  bubbleRow: { flexDirection: 'row', width: '100%', marginBottom: 2, alignItems: 'flex-end' },
  bubbleRowRunEnd: { marginBottom: 10 },
  // Room above for the reaction badge, which pokes out of the top corner.
  bubbleRowWithReaction: { marginTop: 14 },
  // Room at the right edge so the outgoing tail isn't clipped by the list.
  bubbleRowMine: { justifyContent: 'flex-end', paddingRight: 8 },
  // Above the tail's white trim piece, which reaches back under the avatar.
  avatarSlot: { width: 28, marginRight: 10, zIndex: 3 },
  // maxWidth lives on this column, a direct child of the full-width row -
  // a percentage resolved through shrink-wrapped ancestors (Yoga) is what
  // used to misalign long, wrapping messages.
  bubbleColumn: { alignItems: 'flex-start', maxWidth: '75%' },
  bubbleColumnMine: { alignItems: 'flex-end', maxWidth: '75%' },
  bubble: {
    borderRadius: BUBBLE_RADIUS,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  bubbleMine: { backgroundColor: IMESSAGE_BLUE },
  bubbleTheirs: { backgroundColor: IMESSAGE_GRAY },
  tail: { position: 'absolute', bottom: 0, width: 20, height: 22 },
  tailMine: { right: -7, backgroundColor: IMESSAGE_BLUE, borderBottomLeftRadius: 16 },
  tailTheirs: { left: -7, backgroundColor: IMESSAGE_GRAY, borderBottomRightRadius: 16 },
  tailCut: { position: 'absolute', bottom: 0, width: 26, height: 24, backgroundColor: colors.background },
  tailCutMine: { right: -26, borderBottomLeftRadius: 10 },
  tailCutTheirs: { left: -26, borderBottomRightRadius: 10 },
  raised: {
    shadowColor: colors.textPrimary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 8,
  },
  timeHeader: {
    textAlign: 'center',
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '500',
    marginTop: 10,
    marginBottom: 8,
  },
  // Above the bubble, outside it, lined up with the bubble's text.
  senderName: { color: '#8E8E93', fontSize: 12, marginLeft: 36 + 12, marginBottom: 2 },
  bubbleText: { color: '#000000', fontSize: 17, lineHeight: 22 },
  bubbleTextMine: { color: '#FFFFFF' },
  mention: { fontWeight: '700' },
  bubbleWrapper: { position: 'relative' },
  reactionBadgeRow: { position: 'absolute', top: -16, flexDirection: 'row', gap: 2, zIndex: 2 },
  reactionBadgeRowMine: { left: -10 },
  reactionBadgeRowTheirs: { right: -10 },
  // Tapback bubble: gray on your own message, blue when it's your reaction.
  reactionBadge: {
    flexDirection: 'row',
    backgroundColor: IMESSAGE_GRAY,
    borderWidth: 2,
    borderColor: colors.background,
    borderRadius: 16,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  reactionBadgeMine: { backgroundColor: IMESSAGE_BLUE },
  reactionBadgeText: { fontSize: 14, color: '#000000' },
});
