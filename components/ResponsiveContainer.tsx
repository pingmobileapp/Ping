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

// Phone width (or a narrowed-down iPad window) is left alone. A phone turned
// sideways (Week view's landscape mode) is also wider than the cap but should
// use its full width, so only tablet-sized screens - short side 600pt+ - get
// capped.
const isCapped = (width: number, height: number) => width > MAX_CONTENT_WIDTH && Math.min(width, height) >= 600;

// Wide enough for Home to put the calendar and Upcoming side by side: the
// iPhone Duo opened up (951 x 669pt, the fold down the middle - 2026-10-22)
// and iPad. Home then uses the whole width itself, so the cap below steps
// aside; Groups and Discover keep their own centered column (CappedColumn).
export const TWO_PANE_MIN_WIDTH = 800;
export const isTwoPaneSize = (width: number, height: number) => width >= TWO_PANE_MIN_WIDTH && height >= 560;

// The tab bar on a two-pane-wide window: its three tabs in a centered band
// the width of the usual capped column, not spread to the far edges.
export const tabBarBandStyle = (width: number, height: number) =>
  isTwoPaneSize(width, height) ? { paddingHorizontal: Math.max(0, (width - MAX_CONTENT_WIDTH) / 2) } : undefined;

// The width screens inside this container actually get - lets a screen size
// itself correctly on its very first render, before any onLayout measurement.
export const contentWidthFor = (width: number, height: number) =>
  isCapped(width, height) && !isTwoPaneSize(width, height) ? MAX_CONTENT_WIDTH : width;

const CappedBox = ({ children }: { children: React.ReactNode }) => (
  <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center' }}>
    <View style={{ flex: 1, width: '100%', maxWidth: MAX_CONTENT_WIDTH }}>{children}</View>
  </View>
);

export default function ResponsiveContainer({ children }: { children: React.ReactNode }) {
  const { width, height } = useWindowDimensions();

  if (!isCapped(width, height) || isTwoPaneSize(width, height)) {
    return <>{children}</>;
  }

  return <CappedBox>{children}</CappedBox>;
}

// For a single-column screen (Groups, Discover) on a two-pane-wide window,
// where ResponsiveContainer has stepped aside for Home - keeps it the same
// centered column it gets everywhere else that's tablet-wide.
export function CappedColumn({ children }: { children: React.ReactNode }) {
  const { width, height } = useWindowDimensions();
  if (!isTwoPaneSize(width, height)) return <>{children}</>;
  return <CappedBox>{children}</CappedBox>;
}
