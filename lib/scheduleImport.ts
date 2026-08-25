import * as FileSystem from 'expo-file-system/legacy';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { supabase } from '../supabase';

export type ExtractedEvent = {
  title: string;
  date: string | null; // yyyy-mm-dd
  startTime: string | null; // HH:mm
  endTime: string | null; // HH:mm
  location: string | null;
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
  year_inferred: boolean;
  confidence: 'high' | 'low';
};

export async function extractScheduleEvents(
  uri: string
): Promise<{ events: ExtractedEvent[]; warning: string | null }> {
  // Always re-encode as JPEG, regardless of source format - sidesteps HEIC
  // (which Anthropic's vision input doesn't accept) without needing to sniff
  // the source extension/mimeType to decide whether conversion is needed.
  const imageRef = await ImageManipulator.manipulate(uri).renderAsync();
  const jpeg = await imageRef.saveAsync({ compress: 0.85, format: SaveFormat.JPEG });

  const base64 = await FileSystem.readAsStringAsync(jpeg.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  if (base64.length > 12_000_000) {
    throw new Error('That photo is too large - try a tighter photo.');
  }

  const { data, error } = await supabase.functions.invoke('import-schedule', {
    body: { image_base64: base64, media_type: 'image/jpeg' },
  });

  if (error) throw error;

  const rawEvents: RawEvent[] = data?.events || [];
  const events: ExtractedEvent[] = rawEvents.map((e) => ({
    title: e.title,
    date: e.date,
    startTime: e.start_time,
    endTime: e.end_time,
    location: e.location,
    yearInferred: e.year_inferred,
    confidence: e.confidence,
  }));

  return { events, warning: data?.warning ?? null };
}
