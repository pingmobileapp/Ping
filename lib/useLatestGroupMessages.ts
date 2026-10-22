import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase';
import { displayName } from './displayName';

export type LatestGroupMessageInfo = {
  senderName: string;
  body: string;
  createdAt: string;
};

// Mirrors useLatestMessages.ts — same reasoning: PostgREST can't express
// "top-1 per group" without a view/RPC, and this repo has no tracked
// migrations to ship one, so we fetch one group at a time.
export function useLatestGroupMessages(sessionUserId?: string | null) {
  const [latestByGroup, setLatestByGroup] = useState<Record<string, LatestGroupMessageInfo>>({});
  const fetchedIds = useRef<Set<string>>(new Set());

  const fetchLatestFor = useCallback(
    async (groupIds: string[], force = false) => {
      const idsToFetch = force ? groupIds : groupIds.filter((id) => !fetchedIds.current.has(id));
      if (idsToFetch.length === 0) return;
      idsToFetch.forEach((id) => fetchedIds.current.add(id));

      const results = await Promise.all(
        idsToFetch.map(async (groupId) => {
          const { data, error } = await supabase
            .from('group_messages')
            .select('sender_id, body, created_at, deleted_at, profiles(full_name, email)')
            .eq('group_id', groupId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (error || !data) return [groupId, null] as const;

          const senderName =
            data.sender_id === sessionUserId ? 'You' : displayName(data.profiles as any, 'Someone');

          return [
            groupId,
            { senderName, body: data.deleted_at ? 'Message deleted' : data.body, createdAt: data.created_at } as LatestGroupMessageInfo,
          ] as const;
        })
      );

      setLatestByGroup((prev) => {
        const next = { ...prev };
        results.forEach(([groupId, info]) => {
          if (info) next[groupId] = info;
        });
        return next;
      });
    },
    [sessionUserId]
  );

  const refresh = useCallback(
    (groupIds: string[]) => fetchLatestFor(groupIds, true),
    [fetchLatestFor]
  );

  // Same reasoning as useLatestMessages.ts: without this, a group message
  // from someone else while you're just looking at the Message Board never
  // updates its cached snippet/timestamp, so the "most recent activity"
  // sort would silently go stale. RLS on group_messages already scopes
  // which INSERTs this subscription actually receives.
  useEffect(() => {
    const channel = supabase
      .channel('latest-group-messages-global')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'group_messages' },
        (payload) => {
          const row = payload.new as any;
          const apply = (senderName: string) => {
            setLatestByGroup((prev) => ({
              ...prev,
              [row.group_id]: { senderName, body: row.body, createdAt: row.created_at },
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

  return { latestByGroup, fetchLatestFor, refresh };
}
