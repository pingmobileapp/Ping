import * as Calendar from 'expo-calendar';

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

export type RecurrenceEndCondition =
  | { type: 'never' }
  | { type: 'onDate'; date: Date }
  | { type: 'afterCount'; count: number };

export type RecurrenceConfig = {
  frequency: RecurrenceFrequency;
  interval: number; // every N days/weeks/months/years
  end: RecurrenceEndCondition;
};

// Safety ceiling on generated Ping occurrences - unlike a personal item's
// single native EventKit recurrence rule (which iOS expands lazily and
// unboundedly on its own), each Ping occurrence is a full events row with
// its own invitees/items, so a mis-set far-future end date or a large
// count can't be allowed to generate an unbounded number of real rows.
export const MAX_GENERATED_OCCURRENCES = 52;

const FREQUENCY_TO_EXPO: Record<RecurrenceFrequency, Calendar.Frequency> = {
  daily: Calendar.Frequency.DAILY,
  weekly: Calendar.Frequency.WEEKLY,
  monthly: Calendar.Frequency.MONTHLY,
  yearly: Calendar.Frequency.YEARLY,
};

// Personal items hand their recurrence straight to EventKit, which expands
// and displays occurrences itself - no cap or date generation needed here.
export function toExpoRecurrenceRule(config: RecurrenceConfig): Calendar.RecurrenceRule {
  return {
    frequency: FREQUENCY_TO_EXPO[config.frequency],
    interval: config.interval,
    ...(config.end.type === 'onDate' ? { endDate: config.end.date } : {}),
    ...(config.end.type === 'afterCount' ? { occurrence: config.end.count } : {}),
  };
}

// Reverse of the above, for showing a read-only summary of an existing
// item's native recurrenceRule (see RecurrencePicker's readOnlyExisting
// mode) - Calendar.Frequency's string values already match
// RecurrenceFrequency exactly, so this is a direct field mapping, not a
// lossy reconstruction.
export function fromExpoRecurrenceRule(rule: Calendar.RecurrenceRule): RecurrenceConfig {
  return {
    frequency: rule.frequency as RecurrenceFrequency,
    interval: rule.interval ?? 1,
    end: rule.endDate
      ? { type: 'onDate', date: new Date(rule.endDate) }
      : rule.occurrence
      ? { type: 'afterCount', count: rule.occurrence }
      : { type: 'never' },
  };
}

// Advances a date by one step of the given frequency, operating on local
// calendar fields (not millisecond offsets) - millisecond math silently
// drifts the local wall-clock time across a DST boundary (a 6pm weekly
// event sliding to 5pm), which every other date helper in this codebase
// already avoids for the same reason.
function advance(date: Date, frequency: RecurrenceFrequency, interval: number, originalDay: number): Date {
  const next = new Date(date);
  if (frequency === 'daily') {
    next.setDate(next.getDate() + interval);
  } else if (frequency === 'weekly') {
    next.setDate(next.getDate() + interval * 7);
  } else if (frequency === 'monthly') {
    next.setDate(1); // avoid rolling into the wrong month while the day is still the old month's
    next.setMonth(next.getMonth() + interval);
    // Clamp to the target month's last day rather than letting setDate
    // roll over into the month after (e.g. Jan 31 + 1 month should land
    // on Feb 28/29, not roll into March 3).
    const lastDayOfMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(originalDay, lastDayOfMonth));
  } else {
    next.setFullYear(next.getFullYear() + interval);
  }
  return next;
}

// Produces every start/end pair for a Ping series, capped at
// MAX_GENERATED_OCCURRENCES. Always includes the original occurrence as
// the first element. Preserves the original start->end duration on every
// generated occurrence rather than recomputing it.
export function generateOccurrences(
  startDate: Date,
  endDate: Date | null,
  config: RecurrenceConfig
): { startDate: Date; endDate: Date | null }[] {
  const durationMs = endDate ? endDate.getTime() - startDate.getTime() : null;
  const originalDay = startDate.getDate();
  const occurrences: { startDate: Date; endDate: Date | null }[] = [
    { startDate, endDate },
  ];

  let cursor = startDate;
  while (occurrences.length < MAX_GENERATED_OCCURRENCES) {
    if (config.end.type === 'afterCount' && occurrences.length >= config.end.count) break;

    cursor = advance(cursor, config.frequency, config.interval, originalDay);

    if (config.end.type === 'onDate' && cursor > config.end.date) break;

    occurrences.push({
      startDate: cursor,
      endDate: durationMs !== null ? new Date(cursor.getTime() + durationMs) : null,
    });
  }

  return occurrences;
}
