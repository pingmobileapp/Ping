import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase';
import { displayName } from './displayName';

export type LatestMessageInfo = {
  senderName: string;
  body: string;
  createdAt: string;
};

// PostgREST can't express "top-1 per group" without a view/RPC, and this
// repo has no tracked migrations to ship one. A shared .limit() across all
// events would let one chatty event crowd a quieter event's real latest
// message out of the result window, so we fetch one event at a time.
export function useLatestMessages(sessionUserId?: string | null) {
  const [latestByEvent, setLatestByEvent] = useState<Record<string, LatestMessageInfo>>({});
  const fetchedIds = useRef<Set<string>>(new Set());

  const fetchLatestFor = useCallback(
    async (eventIds: string[], force = false) => {
      const idsToFetch = force ? eventIds : eventIds.filter((id) => !fetchedIds.current.has(id));
      if (idsToFetch.length === 0) return;
      idsToFetch.forEach((id) => fetchedIds.current.add(id));

      const results = await Promise.all(
        idsToFetch.map(async (eventId) => {
          const { data, error } = await supabase
            .from('messages')
            .select('sender_id, body, created_at, deleted_at, profiles(full_name, email)')
            .eq('event_id', eventId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (error || !data) return [eventId, null] as const;

          const senderName =
            data.sender_id === sessionUserId ? 'You' : displayName(data.profiles as any, 'Someone');

          return [
            eventId,
            { senderName, body: data.deleted_at ? 'Message deleted' : data.body, createdAt: data.created_at } as LatestMessageInfo,
          ] as const;
        })
      );

      setLatestByEvent((prev) => {
        const next = { ...prev };
        results.forEach(([eventId, info]) => {
          if (info) next[eventId] = info;
        });
        return next;
      });
    },
    [sessionUserId]
  );

  const refresh = useCallback(
    (eventIds: string[]) => fetchLatestFor(eventIds, true),
    [fetchLatestFor]
  );

  // Without this, a message someone else sends while you're just looking
  // at the Message Board never updates its cached snippet/timestamp here -
  // the lazy per-id fetch above only ever runs once (or on an explicit
  // refresh()), so the "most recent activity" sort on the Home screen would
  // silently go stale the moment anyone but you posted anywhere. RLS on
  // `messages` already scopes which INSERTs this subscription actually
  // receives, so no extra filter is needed here.
  useEffect(() => {
    const channel = supabase
      .channel('latest-messages-global')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const row = payload.new as any;
          const apply = (senderName: string) => {
            setLatestByEvent((prev) => ({
              ...prev,
              [row.event_id]: { senderName, body: row.body, createdAt: row.created_at },
            }));
          };
          if (row.sender_id === sessionUserId) {
            apply('You');
            return;
          }
          supabase
            .from('profiles')
            .select('full_name, email')
            .eq('id', row.sender_id)
            .maybeSingle()
            .then(({ data }) => apply(displayName(data, 'Someone')));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [sessionUserId]);

  return { latestByEvent, fetchLatestFor, refresh };
}
