import * as FileSystem from 'expo-file-system/legacy';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { supabase } from '../supabase';

export type ExtractedEvent = {
  title: string;
  date: string | null; // yyyy-mm-dd
  startTime: string | null; // HH:mm
  endTime: string | null; // HH:mm
  location: string | null;
  details: string | null;
  yearInferred: boolean;
  confidence: 'high' | 'low';
};

// The edge function's response uses snake_case straight from the Claude
// tool-call schema - translated to camelCase here at the one seam that
// needs it, so nothing downstream has to deal with both conventions.
type RawEvent = {
  title: string;
  date: string | null;
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  details: string | null;
  year_inferred: boolean;
  confidence: 'high' | 'low';
};

// Longest edge sent to the scanner, in pixels.
const MAX_EDGE = 2048;

// An error with a message that's safe to show the person as-is.
export class ScanError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'ScanError';
  }
}

export async function extractScheduleEvents(
  uri: string
): Promise<{ events: ExtractedEvent[]; warning: string | null }> {
  // Always re-encode as JPEG, regardless of source format - sidesteps HEIC
  // (which Anthropic's vision input doesn't accept) without needing to sniff
  // the source extension/mimeType to decide whether conversion is needed.
  // Also shrink to a 2048px longest edge: `compress` only re-encodes, so a
  // full-resolution 24-48MP camera photo stayed several MB and could exceed
  // Anthropic's 5MB image limit (or the 12MB guard below) - reported as
  // "can't scan" by a user whose attempts never reached the server
  // (2026-10-28). 2048px is plenty for reading text; Claude downsizes
  // larger images anyway.
  const { width, height } = await ImageManipulator.manipulate(uri).renderAsync();
  const context = ImageManipulator.manipulate(uri);
  if (Math.max(width, height) > MAX_EDGE) {
    context.resize(width >= height ? { width: MAX_EDGE, height: null } : { width: null, height: MAX_EDGE });
  }
  const imageRef = await context.renderAsync();
  const jpeg = await imageRef.saveAsync({ compress: 0.85, format: SaveFormat.JPEG });

  const base64 = await FileSystem.readAsStringAsync(jpeg.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  if (base64.length > 6_500_000) {
    throw new ScanError('That photo is too large. Try a screenshot or a closer photo.');
  }

  const { data, error } = await supabase.functions.invoke('import-schedule', {
    body: { image_base64: base64, media_type: 'image/jpeg' },
  });

  if (error) {
    throw new ScanError('Ping couldn\u2019t reach the scanner. Check your connection and try again.', error);
  }

  const rawEvents: RawEvent[] = data?.events || [];
  const events: ExtractedEvent[] = rawEvents.map((e) => ({
    title: e.title,
    date: e.date,
    startTime: e.start_time,
    endTime: e.end_time,
    location: e.location,
    details: e.details,
    yearInferred: e.year_inferred,
    confidence: e.confidence,
  }));

  return { events, warning: data?.warning ?? null };
}
