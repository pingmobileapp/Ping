import { decode } from "base64-arraybuffer";
import * as FileSystem from "expo-file-system/legacy";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { supabase } from "../supabase";

// Longest edge, in pixels, each kind of upload is shrunk to. Phone cameras
// shoot 12-48MP, and the picker's `quality` only re-encodes - it never
// resizes - so uploads averaged 1-1.4MB with some at 14MB (storage audit,
// 2026-10-12), filling the free plan's 1GB storage and 5GB egress far
// faster than the photos warrant. These sizes still look sharp full-screen
// on the largest iPhone/iPad.
const MAX_EDGE = { banner: 1600, full: 2048, avatar: 512 } as const;

// Resize so the longest edge is at most maxEdge and re-encode as JPEG
// (also turns HEIC/PNG picks into JPEG). Falls back to the original file if
// anything goes wrong, so a resize problem never blocks the upload itself.
async function shrink(localUri: string, maxEdge: number): Promise<string> {
  try {
    const { width, height } = await ImageManipulator.manipulate(localUri).renderAsync();
    const context = ImageManipulator.manipulate(localUri);
    if (Math.max(width, height) > maxEdge) {
      context.resize(width >= height ? { width: maxEdge, height: null } : { width: null, height: maxEdge });
    }
    const rendered = await context.renderAsync();
    const result = await rendered.saveAsync({ compress: 0.8, format: SaveFormat.JPEG });
    return result.uri;
  } catch (err) {
    console.error("Image resize failed, uploading the original:", err);
    return localUri;
  }
}

async function uploadImage(localUri: string, pathPrefix: string, maxEdge: number): Promise<string> {
  const uploadUri = await shrink(localUri, maxEdge);
  const base64 = await FileSystem.readAsStringAsync(uploadUri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const rawExt = uploadUri.split(".").pop()?.toLowerCase() || "jpg";
  const ext = rawExt === "jpg" ? "jpeg" : rawExt;
  const path = `${pathPrefix}.${ext === "jpeg" ? "jpg" : ext}`;

  const { error } = await supabase.storage
    .from("event-images")
    .upload(path, decode(base64), {
      contentType: `image/${ext}`,
      upsert: true,
    });

  if (error) throw error;

  const { data } = supabase.storage.from("event-images").getPublicUrl(path);
  return data.publicUrl;
}

export async function uploadEventImage(
  localUri: string,
  ownerId: string,
): Promise<string> {
  return uploadImage(localUri, `${ownerId}/${Date.now()}`, MAX_EDGE.banner);
}

// The cropped photo (uploadEventImage) is what cards/banners show, but it's
// destructively cropped - nothing outside that frame survives in it. This
// uploads the original, never-cropped pick alongside it so a full-screen
// view has something more than the cropped sliver to show (e.g. a flyer
// with text that got cropped out of the banner shape).
export async function uploadEventImageFull(
  localUri: string,
  ownerId: string,
): Promise<string> {
  return uploadImage(localUri, `${ownerId}/${Date.now()}-full`, MAX_EDGE.full);
}

// Reuses the same bucket as event photos, under its own prefix, so no
// separate storage bucket needs to be provisioned for avatars.
export async function uploadAvatarImage(
  localUri: string,
  userId: string,
): Promise<string> {
  return uploadImage(localUri, `avatars/${userId}/${Date.now()}`, MAX_EDGE.avatar);
}
