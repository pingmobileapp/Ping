import React, { useCallback, useEffect, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, useWindowDimensions } from 'react-native';
import { colors } from '../lib/theme';
import { useRegisterModal } from '../lib/modalPresence';

// A step-by-step "here's where things are" tour for new users (asked for
// 2026-10-11): the screen dims, one part of it stays lit, and a bubble with
// an arrow explains it. Skip ends it at any point; Back/Next walk through.
//
// Each step measures its own target when it's shown (measure() should call
// back with window coordinates, e.g. via View.measureInWindow), so it works
// on any screen size and orientation without hard-coded positions. A step
// with no measure, or whose target can't be measured, is shown as a
// centered bubble with no arrow.

export type Rect = { x: number; y: number; width: number; height: number };

export type TourStep = {
  title: string;
  body: string;
  measure?: (done: (rect: Rect | null) => void) => void;
};

type Props = {
  visible: boolean;
  steps: TourStep[];
  onFinish: (completed: boolean) => void; // true = reached the end, false = skipped
  // Wording for the first bubble's dismiss button - "No thanks" when the
  // tour is being offered rather than started (see lib/appTour.ts).
  firstSkipLabel?: string;
};

const PAD = 6; // breathing room around the highlighted target
const BUBBLE_MAX = 340;
const GAP = 14; // space between target and bubble (the arrow sits in it)
const MARGIN = 16;

export default function AppTour({ visible, steps, onFinish, firstSkipLabel }: Props) {
  useRegisterModal(visible);
  const { width: winW, height: winH } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [measured, setMeasured] = useState(false);
  const [bubbleH, setBubbleH] = useState(0);

  useEffect(() => {
    if (visible) setIndex(0);
  }, [visible]);

  const step = steps[index];

  const measureStep = useCallback(() => {
    setMeasured(false);
    if (!step?.measure) {
      setRect(null);
      setMeasured(true);
      return;
    }
    step.measure((r) => {
      setRect(r && r.width > 0 && r.height > 0 ? r : null);
      setMeasured(true);
    });
  }, [step]);

  useEffect(() => {
    if (visible && step) measureStep();
  }, [visible, step, measureStep, winW, winH]);

  if (!visible || !step) return null;

  const isLast = index === steps.length - 1;
  // Padded around the target, then clipped to the screen so the ring never
  // runs off an edge (e.g. the Discover tab sits flush with the right side).
  const hole = (() => {
    if (!rect) return null;
    const x = Math.max(2, rect.x - PAD);
    const y = Math.max(2, rect.y - PAD);
    const right = Math.min(winW - 2, rect.x + rect.width + PAD);
    const bottom = Math.min(winH - 2, rect.y + rect.height + PAD);
    return { x, y, width: right - x, height: bottom - y };
  })();

  // Bubble goes below the target when there's room, otherwise above.
  const bubbleW = Math.min(BUBBLE_MAX, winW - MARGIN * 2);
  let bubbleTop = (winH - bubbleH) / 2;
  let bubbleLeft = (winW - bubbleW) / 2;
  let arrow: { top: number; left: number; up: boolean } | null = null;
  if (hole) {
    const centerX = hole.x + hole.width / 2;
    bubbleLeft = Math.min(Math.max(MARGIN, centerX - bubbleW / 2), winW - MARGIN - bubbleW);
    const below = hole.y + hole.height + GAP + bubbleH + MARGIN <= winH;
    bubbleTop = below ? hole.y + hole.height + GAP : hole.y - GAP - bubbleH;
    bubbleTop = Math.min(Math.max(MARGIN + 40, bubbleTop), winH - bubbleH - MARGIN);
    const arrowLeft = Math.min(Math.max(bubbleLeft + 18, centerX - 9), bubbleLeft + bubbleW - 36);
    arrow = below
      ? { top: bubbleTop - 9, left: arrowLeft, up: true }
      : { top: bubbleTop + bubbleH - 1, left: arrowLeft, up: false };
  }

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => onFinish(false)}
    >
      <View style={StyleSheet.absoluteFill}>
        {/* Four dim panels around the lit target - plain Views, no SVG. */}
        {hole ? (
          <>
            <View style={[styles.dim, { top: 0, left: 0, right: 0, height: hole.y }]} />
            <View style={[styles.dim, { top: hole.y + hole.height, left: 0, right: 0, bottom: 0 }]} />
            <View style={[styles.dim, { top: hole.y, left: 0, width: hole.x, height: hole.height }]} />
            <View
              style={[styles.dim, { top: hole.y, left: hole.x + hole.width, right: 0, height: hole.height }]}
            />
            <View
              pointerEvents="none"
              style={[styles.ring, { top: hole.y, left: hole.x, width: hole.width, height: hole.height }]}
            />
          </>
        ) : (
          <View style={[styles.dim, StyleSheet.absoluteFill]} />
        )}

        {measured && (
          <>
            {arrow && (
              <View
                pointerEvents="none"
                style={[styles.arrow, arrow.up ? styles.arrowUp : styles.arrowDown, { top: arrow.top, left: arrow.left }]}
              />
            )}
            <View
              style={[styles.bubble, { top: bubbleTop, left: bubbleLeft, width: bubbleW }]}
              onLayout={(e) => setBubbleH(e.nativeEvent.layout.height)}
            >
              <Text style={styles.stepCount}>
                {index + 1} of {steps.length}
              </Text>
              <Text style={styles.title}>{step.title}</Text>
              <Text style={styles.body}>{step.body}</Text>
              <View style={styles.buttons}>
                {!isLast ? (
                  <TouchableOpacity onPress={() => onFinish(false)} hitSlop={8}>
                    <Text style={styles.skip}>{index === 0 && firstSkipLabel ? firstSkipLabel : 'Skip tour'}</Text>
                  </TouchableOpacity>
                ) : (
                  <View />
                )}
                <View style={styles.navButtons}>
                  {index > 0 && (
                    <TouchableOpacity onPress={() => setIndex(index - 1)} hitSlop={8}>
                      <Text style={styles.back}>Back</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    style={styles.next}
                    onPress={() => (isLast ? onFinish(true) : setIndex(index + 1))}
                  >
                    <Text style={styles.nextText}>{isLast ? 'Done' : index === 0 ? 'Show me' : 'Next'}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dim: { position: 'absolute', backgroundColor: 'rgba(20,20,20,0.62)' },
  ring: { position: 'absolute', borderRadius: 12, borderWidth: 2, borderColor: colors.primaryPale },
  bubble: {
    position: 'absolute',
    backgroundColor: colors.background,
    borderRadius: 16,
    padding: 18,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
  arrow: { position: 'absolute', width: 0, height: 0, borderLeftWidth: 10, borderRightWidth: 10, borderLeftColor: 'transparent', borderRightColor: 'transparent' },
  arrowUp: { borderBottomWidth: 10, borderBottomColor: colors.background },
  arrowDown: { borderTopWidth: 10, borderTopColor: colors.background },
  stepCount: { color: colors.textMuted, fontSize: 12, fontWeight: '600', marginBottom: 4 },
  title: { color: colors.textPrimary, fontSize: 18, fontWeight: '800', marginBottom: 6 },
  body: { color: colors.textSecondary, fontSize: 15, lineHeight: 21 },
  buttons: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 },
  navButtons: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  skip: { color: colors.textMuted, fontSize: 15, fontWeight: '600' },
  back: { color: colors.primary, fontSize: 15, fontWeight: '600' },
  next: { backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 9 },
  nextText: { color: colors.textOnPrimary, fontSize: 15, fontWeight: '700' },
});
