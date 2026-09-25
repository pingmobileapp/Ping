import React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { colors } from '../lib/theme';

// iPad (and Ping running in a resized iPadOS window) hands React Native the
// window's real width, which can be far wider than anything the app's
// screens were built for. Left alone, phone-built layouts like Home's
// calendar grid just stretch to fill it - calendar cells balloon into
// mostly-empty boxes, and the tab bar's two icons end up pinned to opposite
// edges of a 13" screen. Apple's review flagged exactly this as a
// Guideline 4 design issue when testing on an iPad Air.
//
// Capping content at a comfortable width and centering it is the standard
// fix for a phone-designed app rather than building a second tablet layout
// per screen - the same pattern many iPad apps use for a single-pane view.
const MAX_CONTENT_WIDTH = 700;

export default function ResponsiveContainer({ children }: { children: React.ReactNode }) {
  const { width, height } = useWindowDimensions();

  // Phone width (or a narrowed-down iPad window) - unchanged from before.
  // A phone turned sideways (Week view's landscape mode) is also wider than
  // the cap but should use its full width, so only tablet-sized screens -
  // short side 600pt+ - get capped.
  if (width <= MAX_CONTENT_WIDTH || Math.min(width, height) < 600) {
    return <>{children}</>;
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center' }}>
      <View style={{ flex: 1, width: '100%', maxWidth: MAX_CONTENT_WIDTH }}>{children}</View>
    </View>
  );
}
