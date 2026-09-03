import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, TouchableOpacity, Text, Animated, StyleSheet } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import ReAnimated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import EventDetailContent from './EventDetailContent';
import MessageThread from './MessageThread';
import { colors } from '../lib/theme';

type Props = {
  visible: boolean;
  eventId: string | null;
  onClose: () => void;
  startOnMessages?: boolean;
};

export default function EventDetailModal({ visible, eventId, onClose, startOnMessages = false }: Props) {
  const [isFlipped, setIsFlipped] = useState(startOnMessages);
  const flipAnim = useRef(new Animated.Value(startOnMessages ? 180 : 0)).current;
  const dragY = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      dragY.value = 0;
      // Jump (don't animate) to the requested face — the modal is already
      // sliding in, so an extra flip animation on top would look off.
      flipAnim.setValue(startOnMessages ? 180 : 0);
      setIsFlipped(startOnMessages);
    }
  }, [visible, startOnMessages]);

  const toggleFlip = () => {
    Animated.timing(flipAnim, {
      toValue: isFlipped ? 0 : 180,
      duration: 450,
      useNativeDriver: true,
    }).start();
    setIsFlipped(!isFlipped);
  };

  const handleClose = () => {
    if (isFlipped) {
      flipAnim.setValue(0);
      setIsFlipped(false);
    }
    onClose();
  };

  // Leftward swipe on the front face flips to messages, same destination as
  // tapping the 💬 bubble - matches the rightward swipe-back gesture in
  // MessageThread.tsx.
  // Plain PanResponder (even capture-phase) turned out not to reliably win
  // against EventDetailContent's ScrollView on-device - its native scroll
  // gesture recognizer still grabbed the touch regardless. react-native-
  // gesture-handler's Pan gesture is built to negotiate with a native
  // ScrollView correctly: failOffsetY lets the scroll view win outright once
  // vertical intent is clear, activeOffsetX only claims once horizontal
  // intent is clear - the same library already drives the calendar sheet's
  // drag handle in app/(tabs)/index.tsx.
  const swipeToMessagesGesture = Gesture.Pan()
    .activeOffsetX(-15)
    .failOffsetY([-10, 10])
    .onEnd((e) => {
      if (!isFlipped && e.translationX < -60) {
        runOnJS(toggleFlip)();
      }
    });

  // Drag-to-dismiss on the handle. Previously a plain PanResponder, but that
  // mixed two different gesture systems (PanResponder + the gesture-handler
  // Pan above) inside the same GestureHandlerRootView, which turned out to
  // cause visible glitching - a quick flash/jump before the drag actually
  // took over. Rebuilt on the same react-native-gesture-handler + Reanimated
  // combo as the swipe gesture (and as the calendar sheet's drag handle in
  // app/(tabs)/index.tsx) so only one gesture system is active in this tree.
  const dismissGesture = Gesture.Pan()
    .activeOffsetY(15)
    .failOffsetX([-15, 15])
    .onUpdate((e) => {
      if (e.translationY > 0) dragY.value = e.translationY;
    })
    .onEnd((e) => {
      if (e.translationY > 100 || e.velocityY > 800) {
        dragY.value = withTiming(800, { duration: 200 }, (finished) => {
          if (finished) {
            dragY.value = 0;
            runOnJS(handleClose)();
          }
        });
      } else {
        dragY.value = withSpring(0, { damping: 18 });
      }
    });

  const cardAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: dragY.value }],
  }));

  // Negative degrees spin the card the opposite way around (left edge
  // leading instead of right) while landing on the same resting
  // orientation for both faces - rotateY(-180deg) looks identical to
  // rotateY(180deg) once settled, only the direction of travel differs.
  const frontRotateY = flipAnim.interpolate({ inputRange: [0, 180], outputRange: ['0deg', '-180deg'] });
  const backRotateY = flipAnim.interpolate({ inputRange: [0, 180], outputRange: ['-180deg', '-360deg'] });

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      {/* RN's Modal renders into its own native root, separate from the
          GestureHandlerRootView wrapping the rest of the app in
          app/_layout.tsx - without this, react-native-gesture-handler
          gestures inside a Modal silently don't work at all. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={styles.overlay}>
        <ReAnimated.View style={[styles.card, cardAnimatedStyle]}>
          <GestureDetector gesture={dismissGesture}>
            <View style={styles.dragHandleArea} hitSlop={{ top: 10, bottom: 16, left: 30, right: 30 }}>
              <View style={styles.handle} />
            </View>
          </GestureDetector>

          <View style={styles.faceContainer}>
            <GestureDetector gesture={swipeToMessagesGesture}>
              <Animated.View
                style={[styles.face, { transform: [{ perspective: 1000 }, { rotateY: frontRotateY }] }]}
                pointerEvents={isFlipped ? 'none' : 'auto'}
              >
                {eventId && <EventDetailContent eventId={eventId} onClose={handleClose} variant="modal" />}
              </Animated.View>
            </GestureDetector>

            <Animated.View
              style={[
                styles.face,
                styles.faceBack,
                { transform: [{ perspective: 1000 }, { rotateY: backRotateY }] },
              ]}
              pointerEvents={isFlipped ? 'auto' : 'none'}
            >
              {eventId && (
                <MessageThread
                  eventId={eventId}
                  // Opened straight into messages - by a chat-icon tap, a
                  // notification, or the Messages screen, all of which land
                  // here the same way - there's no front-of-card details
                  // face this trip has shown, so swiping/tapping back should
                  // leave the modal entirely rather than reveal a card face
                  // the user never asked for. Same reasoning as
                  // hasShownDetails in app/event/[id].tsx. The label stays
                  // generic ("Back") rather than naming a specific origin
                  // screen - this modal doesn't know or care which of those
                  // callers opened it, and it used to hardcode "Message
                  // Board" back when that was the only one, which went stale
                  // (and outright wrong - dismissTo('/') already closes back
                  // to Home, not to whatever screen was tapped from) the
                  // moment other entry points existed.
                  onFlipBack={startOnMessages ? handleClose : toggleFlip}
                  backLabel={startOnMessages ? 'Back' : 'Event Details'}
                />
              )}
            </Animated.View>
          </View>

          {!isFlipped && (
            <TouchableOpacity style={styles.messageBubble} onPress={toggleFlip} activeOpacity={0.8}>
              <Text style={styles.messageBubbleIcon}>💬</Text>
            </TouchableOpacity>
          )}
        </ReAnimated.View>
      </View>
      </GestureHandlerRootView>
    </Modal>
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
  faceContainer: { flex: 1 },
  face: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backfaceVisibility: 'hidden' },
  faceBack: { paddingHorizontal: 2 },
  messageBubble: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.textPrimary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 5,
  },
  messageBubbleIcon: { fontSize: 22 },
});
