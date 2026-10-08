import { createClient } from "@supabase/supabase-js";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState } from "react-native";
import "react-native-url-polyfill/auto";

const supabaseUrl = "https://rmooxzkinakbyhvxcivv.supabase.co";
const supabaseAnonKey = "sb_publishable_O97fJjA2cNuR4vvRumRsvQ_P3RuxrhO";

// No storage adapter was ever configured here - supabase-js defaults to
// browser localStorage, which doesn't exist in React Native, so it fell
// back to keeping the session in memory only. That's why signing in never
// stuck: killing the app (not just backgrounding it) wiped it every time.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// supabase-js's auto-refresh is a JS timer, and iOS suspends JS timers while
// the app is backgrounded. After a long background stretch (TestFlight
// feedback, build 104: ~19h), the access token had expired by the time the
// app came back. The first requests on resume tried to refresh it, but the
// refresh failed because the network wasn't back up yet, so they went out
// with only the publishable key. RLS then returned [] for invitees, and Home
// showed "No events yet" until something refetched. This is the documented
// Supabase pattern for React Native: refresh only while the app is in the
// foreground, and kick a refresh off immediately on resume.
AppState.addEventListener("change", (state) => {
  if (state === "active") {
    supabase.auth.startAutoRefresh();
  } else {
    supabase.auth.stopAutoRefresh();
  }
});
