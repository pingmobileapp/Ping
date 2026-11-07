import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

async function pickImage(
  allowsEditing: boolean,
  aspect?: [number, number],
  onGallery?: () => void
): Promise<string | null> {
  return new Promise((resolve) => {
    Alert.alert(
      'Add Photo',
      undefined,
      [
        // Ping's Gallery of free photos (components/PhotoGalleryModal) -
        // event photos only. The caller opens it; nothing is returned here.
        ...(onGallery
          ? [
              {
                text: 'Choose from Gallery',
                onPress: () => {
                  resolve(null);
                  onGallery();
                },
              },
            ]
          : []),
        {
          text: 'Take Photo',
          onPress: async () => {
            const permission = await ImagePicker.requestCameraPermissionsAsync();
            if (!permission.granted) {
              Alert.alert('Permission needed', 'Allow camera access to take a photo.');
              resolve(null);
              return;
            }
            const result = await ImagePicker.launchCameraAsync({
              allowsEditing,
              aspect,
              quality: 0.8,
            });
            resolve(!result.canceled && result.assets?.[0]?.uri ? result.assets[0].uri : null);
          },
        },
        {
          text: 'Choose from Library',
          onPress: async () => {
            const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (!permission.granted) {
              Alert.alert('Permission needed', 'Allow photo access to choose an image.');
              resolve(null);
              return;
            }
            const result = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ImagePicker.MediaTypeOptions.Images,
              allowsEditing,
              aspect,
              quality: 0.8,
            });
            resolve(!result.canceled && result.assets?.[0]?.uri ? result.assets[0].uri : null);
          },
        },
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
      ],
      { cancelable: true, onDismiss: () => resolve(null) }
    );
  });
}

// No OS-level crop here (unlike the profile picker below) - the raw pick
// goes through ImageCropModal instead, which is also how re-cropping an
// already-selected photo works (that flow has no "picking" step at all, so
// it could never have gone through the OS crop anyway).
export async function pickEventImage(onGallery?: () => void): Promise<string | null> {
  return pickImage(false, undefined, onGallery);
}

export async function pickProfileImage(): Promise<string | null> {
  return pickImage(true, [1, 1]);
}
