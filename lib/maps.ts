import { Alert, Linking, Platform } from 'react-native';

// `maps://` is iOS-only and Apple Maps specifically; `geo:` is Android's
// generic "hand this query to whatever maps app is installed" scheme.
// Either can still fail (no maps app at all, an odd address string), so
// this falls back to Google's web maps URL, which always works in a
// plain browser.
export function openInMaps(query: string) {
  if (!query.trim()) return;
  const encoded = encodeURIComponent(query);
  const url = Platform.OS === 'ios' ? `maps://?address=${encoded}` : `geo:0,0?q=${encoded}`;
  Linking.openURL(url).catch(() => {
    Linking.openURL(`https://maps.google.com/?q=${encoded}`).catch(() => {
      Alert.alert('Could not open Maps', "Couldn't open a maps app for this address.");
    });
  });
}
