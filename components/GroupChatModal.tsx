import React, { useEffect } from 'react';
import { View, TouchableOpacity, Text, StyleSheet, useWindowDimensions } from 'react-native';
import SheetModal from './SheetModal';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import ReAnimated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import GroupMessageThread from './GroupMessageThread';
import { colors } from '../lib/theme';
import { useRegisterModal } from '../lib/modalPresence';

type Props = {
  visible: boolean;
  groupId: string | null;
  groupName: string | null;
  onClose: () => void;
};

// Single-face version of EventDetailModal's card — groups have no "detail
// card" equivalent to flip from (their only other screen is the full
// app/groups/[id].tsx member-management route), so this goes straight to
// the chat and reuses only the swipe-to-dismiss gesture, not the flip.
export default function GroupChatModal({ visible, groupId, groupName, onClose }: Props) {
  useRegisterModal(visible);
  const router = useRouter();
  const dragY = useSharedValue(0);
  const { height: screenHeight } = useWindowDimensions();

  useEffect(() => {
    if (visible) dragY.value = 0;
  }, [visible]);

  // Same react-native-gesture-handler + Reanimated combo as
  // EventDetailModal.tsx's drag handle - see the note there. A plain
  // PanResponder here alongside GroupMessageThread's gesture-handler-based
  // swipe-back (both inside the same GestureHandlerRootView below) caused
  // visible glitching from the two systems fighting over the touch.
  const dismissGesture = Gesture.Pan()
    .activeOffsetY(15)
    .failOffsetX([-15, 15])
    .onUpdate((e) => {
      if (e.translationY > 0) dragY.value = e.translationY;
    })
    .onEnd((e) => {
      if (e.translationY > 100 || e.velocityY > 800) {
        // Slide fully off the bottom and stay there - the modal closes from
        // there. Snapping back to 0 first (it used to) flashed the card back
        // to full height for a frame (TestFlight feedback, build 113); the
        // open effect resets it for next time.
        dragY.value = withTiming(screenHeight, { duration: 200 }, (finished) => {
          if (finished) runOnJS(onClose)();
        });
      } else {
        dragY.value = withSpring(0, { damping: 18 });
      }
    });

  const cardAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: dragY.value }],
  }));

  const handleManage = () => {
    onClose();
    if (groupId) router.push(`/groups/${groupId}`);
  };

  return (
    <SheetModal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      {/* See the matching note in EventDetailModal.tsx - RN's Modal renders
          into its own native root, so react-native-gesture-handler gestures
          inside GroupMessageThread need this wrapper to work at all. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={styles.overlay}>
        <ReAnimated.View style={[styles.card, cardAnimatedStyle]}>
          <GestureDetector gesture={dismissGesture}>
            <View style={styles.dragHandleArea} hitSlop={{ top: 10, bottom: 16, left: 30, right: 30 }}>
              <View style={styles.handle} />
            </View>
          </GestureDetector>

          <View style={styles.headerRow}>
            <Text style={styles.title} numberOfLines={1}>
              {groupName || 'Group'}
            </Text>
            <TouchableOpacity onPress={handleManage}>
              <Text style={styles.manageText}>Manage</Text>
            </TouchableOpacity>
          </View>

          <View style={{ flex: 1 }}>
            {groupId && <GroupMessageThread groupId={groupId} onSwipeBack={onClose} />}
          </View>
        </ReAnimated.View>
      </View>
      </GestureHandlerRootView>
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(43,43,43,0.4)' },
  card: {
    height: '92%',
    backgroundColor: colors.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
  },
  dragHandleArea: { paddingVertical: 12, marginBottom: 4 },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: 'center',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    gap: 12,
  },
  title: { color: colors.textPrimary, fontSize: 20, fontWeight: '700', flexShrink: 1 },
  manageText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
});
