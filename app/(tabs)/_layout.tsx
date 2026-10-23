import { Tabs } from 'expo-router';
import React from 'react';
import { useWindowDimensions } from 'react-native';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import ResponsiveContainer, { tabBarBandStyle } from '@/components/ResponsiveContainer';

export default function TabLayout() {
  const { width, height } = useWindowDimensions();
  const tabBarStyle = tabBarBandStyle(width, height);
  return (
    <ResponsiveContainer>
      <Tabs
        screenOptions={{
          // Always the light-theme colors: Ping's screens (and this tab bar)
          // are always light, and following the phone's dark mode made the
          // selected tab white on a white bar - Home simply vanished at
          // night (TestFlight feedback, build 114).
          tabBarActiveTintColor: Colors.light.tint,
          tabBarInactiveTintColor: Colors.light.tabIconDefault,
          headerShown: false,
          tabBarButton: HapticTab,
          ...(tabBarStyle ? { tabBarStyle } : {}),
        }}>
        <Tabs.Screen
          name="index"
          options={{
            title: 'Home',
            tabBarIcon: ({ color }) => <IconSymbol size={28} name="house.fill" color={color} />,
          }}
        />
        <Tabs.Screen
          name="groups"
          options={{
            title: 'Groups',
            tabBarIcon: ({ color }) => <IconSymbol size={28} name="person.3.fill" color={color} />,
          }}
        />
        <Tabs.Screen
          name="explore"
          options={{
            title: 'Discover',
            tabBarIcon: ({ color }) => <IconSymbol size={28} name="paperplane.fill" color={color} />,
          }}
        />
      </Tabs>
    </ResponsiveContainer>
  );
}
