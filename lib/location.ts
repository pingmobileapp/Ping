import * as Location from 'expo-location';

export type LocationPermissionStatus = 'granted' | 'denied' | 'undetermined';

export type Coords = { latitude: number; longitude: number };

// Only call once permission is confirmed granted — this never prompts.
export async function getLocationPermissionStatus(): Promise<LocationPermissionStatus> {
  const { status } = await Location.getForegroundPermissionsAsync();
  return status as LocationPermissionStatus;
}

export async function requestLocationAccess(): Promise<boolean> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  return status === 'granted';
}

// Only call once permission is confirmed granted — this never prompts.
// 'Balanced' accuracy is plenty for a "how far away is this" figure on an
// activity card - no need to burn extra battery on GPS-tier precision.
export async function getCurrentCoords(): Promise<Coords | null> {
  try {
    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { latitude: position.coords.latitude, longitude: position.coords.longitude };
  } catch (err) {
    console.error('Error getting current location:', err);
    return null;
  }
}
