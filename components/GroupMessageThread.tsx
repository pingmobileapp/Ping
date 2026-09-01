import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  Keyboard,
  Platform,
  Alert,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { supabase } from '../supabase';
import { useAuth } from '../lib/AuthContext';
import { colors } from '../lib/theme';
import { notify } from '../lib/notify';
import { displayName } from '../lib/displayName';
import { useMessageReactions } from '../lib/useMessageReactions';
import { reportContent, blockUser } from '../lib/moderation';
import { containsObjectionableContent } from '../lib/contentFilter';
import ReactionPicker from './ReactionPicker';
import MessageBubble, { BubbleAnchor } from './MessageBubble';

const PAGE_SIZE = 30;

type GroupMessage = {
  id: string;
  group_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  profiles: { full_name: string | null; email: string | null; avatar_url: string | null } | null;
};

type Props = {
  groupId: string;
  onSwipeBack?: () => void;
};

export default function GroupMessageThread({ groupId, onSwipeBack }: Props) {
  const { session } = useAuth();
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [draft, setDraft] = useState('');
  const draftRef = useRef('');
  const inputRef = useRef<TextInput>(null);
  const [sending, setSending] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [isMember, setIsMember] = useState(false);
  const [muted, setMuted] = useState(false);
  const listRef = useRef<FlatList>(null);
  const [reactingToId, setReactingToId] = useState<string | null>(null);
  const [pickerAnchor, setPickerAnchor] = useState<BubbleAnchor | null>(null);
  const { reactionsByMessage, fetchForIds, toggleReaction } = useMessageReactions(
    'group_message_id',
    session?.user?.id
  );

  const updateDraft = (text: string) => {
    draftRef.current = text;
    setDraft(text);
  };

  // Same rightward-swipe-to-go-back gesture as MessageThread.tsx - this
  // modal has no "front card" to flip to (see the note in GroupChatModal),
  // so swiping just closes it back to whichever list (Groups tab or the
  // group Message Board) was open underneath.
  // See the matching note in MessageThread.tsx: PanResponder doesn't
  // reliably win against the FlatList's native scroll gesture on-device,
  // so this uses react-native-gesture-handler's Pan gesture instead.
  // onEnd runs as a worklet on the UI thread - calling onSwipeBack directly
  // from there instead of through runOnJS is exactly the kind of thing that
  // crashes a release build instead of just erroring in dev.
  const swipeBackGesture = Gesture.Pan()
    .activeOffsetX(15)
    .failOffsetY([-10, 10])
    .onEnd((e) => {
      if (e.translationX > 60 && onSwipeBack) {
        runOnJS(onSwipeBack)();
      }
    });

  // Owners don't have their own group_members row (see recipient logic in
  // handleSend below), so muting is only offered to actual members for now.
  // group_members has no surrogate id column - group_id + user_id together
  // address a row, same as the healing update in handleSend below.
  useEffect(() => {
    if (!session?.user?.id) return;
    supabase
      .from('group_members')
      .select('muted')
      .eq('group_id', groupId)
      .eq('user_id', session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        setIsMember(!!data);
        setMuted(!!data?.muted);
      });
  }, [groupId, session?.user?.id]);

  const toggleMuted = async () => {
    if (!isMember || !session?.user?.id) return;
    const next = !muted;
    setMuted(next);
    const { error } = await supabase
      .from('group_members')
      .update({ muted: next })
      .eq('group_id', groupId)
      .eq('user_id', session.user.id);
    if (error) {
      console.error('Error updating mute state:', error);
      setMuted(!next);
    }
  };

  // First name only - see the matching note in MessageThread.tsx.
  const senderName = (m: GroupMessage) =>
    m.sender_id === session?.user?.id ? 'You' : displayName(m.profiles, 'Someone').split(' ')[0];

  // Same keyboard-tracking gotcha as MessageThread.tsx: KeyboardAvoidingView
  // is unreliable inside this app's nested/animated ancestor chains, so we
  // track the real keyboard height directly instead.
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const fetchLatest = useCallback(async () => {
    const { data, error } = await supabase
      .from('group_messages')
      .select('id, group_id, sender_id, body, created_at, profiles(full_name, email, avatar_url)')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE);

    if (error) {
      console.error('Error fetching group messages:', error);
      return;
    }
    const page = (data as any[]) || [];
    setMessages(page);
    setHasMore(page.length === PAGE_SIZE);
    fetchForIds(page.map((m) => m.id));
  }, [groupId, fetchForIds]);

  const loadOlder = async () => {
    if (loadingMore || !hasMore || messages.length === 0) return;
    setLoadingMore(true);

    const oldest = messages[messages.length - 1];
    const { data, error } = await supabase
      .from('group_messages')
      .select('id, group_id, sender_id, body, created_at, profiles(full_name, email, avatar_url)')
      .eq('group_id', groupId)
      .lt('created_at', oldest.created_at)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE);

    setLoadingMore(false);

    if (error) {
      console.error('Error loading older group messages:', error);
      return;
    }
    const page = (data as any[]) || [];
    setMessages((prev) => [...prev, ...page]);
    setHasMore(page.length === PAGE_SIZE);
    fetchForIds(page.map((m) => m.id));
  };

  useEffect(() => {
    fetchLatest().finally(() => setLoading(false));

    const channel = supabase
      .channel(`group-messages-${groupId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'group_messages', filter: `group_id=eq.${groupId}` },
        (payload) => {
          const row = payload.new as any;
          setMessages((prev) => {
            if (prev.some((m) => m.id === row.id)) return prev;
            return [{ ...row, profiles: null }, ...prev];
          });

          // postgres_changes payloads are the raw row only - no profiles
          // join support - so the sender's name is fetched separately here
          // and patched onto the message once it arrives.
          if (row.sender_id !== session?.user?.id) {
            supabase
              .from('profiles')
              .select('full_name, email, avatar_url')
              .eq('id', row.sender_id)
              .single()
              .then(({ data }) => {
                if (!data) return;
                setMessages((prev) =>
                  prev.map((m) => (m.id === row.id ? { ...m, profiles: data } : m))
                );
              });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [groupId, fetchLatest, session?.user?.id]);

  const handleSend = async () => {
    // Same autocorrect-commit issue as MessageThread.tsx - blur first so
    // a highlighted suggestion is accepted before the text is read.
    inputRef.current?.blur();
    await new Promise((resolve) => setTimeout(resolve, 60));

    const body = draftRef.current.trim();
    if (!body || !session?.user?.id) return;

    setSending(true);
    updateDraft('');

    const { data: inserted, error } = await supabase
      .from('group_messages')
      .insert([{ group_id: groupId, sender_id: session.user.id, body }])
      .select('id')
      .single();

    setSending(false);

    if (error) {
      console.error('Error sending group message:', error);
      updateDraft(body);
      return;
    }

    // Doesn't block sending - see the matching note in MessageThread.tsx.
    if (containsObjectionableContent(body) && inserted) {
      reportContent({
        reporterId: session.user.id,
        reportedUserId: session.user.id,
        contentType: 'group_message',
        contentId: inserted.id,
        groupId,
        reason: 'Auto-flagged group message content',
        source: 'auto_filter',
      });
    }

    await fetchLatest();

    // Recipients are the group owner plus resolved members — either role
    // could be the sender, so both need to be included and the sender
    // excluded, unlike events which only ever have one host.
    const [{ data: groupRow }, { data: memberRows }] = await Promise.all([
      supabase.from('groups').select('name, owner_id').eq('id', groupId).single(),
      // Filtering to `.not('user_id', 'is', null)` here used to silently
      // drop anyone whose group_members.user_id was never resolved (added
      // by phone before they had, or had linked, an account) - excluded
      // from the query entirely, so they never got notified even after
      // signing up. Fetch everyone and re-resolve each one's link fresh
      // below instead, same self-healing idea as healContactLink for event
      // invites.
      // group_members has no surrogate id column - group_id + contact_id
      // together are how a row is addressed (see toggleMember in
      // app/groups/[id].tsx), so that's what the healing update below
      // matches on too.
      supabase.from('group_members').select('contact_id, user_id, muted, contacts(linked_user_id)').eq('group_id', groupId),
    ]);

    const healedMembers = await Promise.all(
      (memberRows || []).map(async (m: any) => {
        const resolvedUserId = m.user_id || m.contacts?.linked_user_id || null;
        if (resolvedUserId && resolvedUserId !== m.user_id) {
          await supabase
            .from('group_members')
            .update({ user_id: resolvedUserId })
            .eq('group_id', groupId)
            .eq('contact_id', m.contact_id);
        }
        return { ...m, user_id: resolvedUserId };
      })
    );

    // Owners don't have a group_members row yet (see the mute effect
    // above), so they always land in the normal bucket for now.
    const recipientIds = Array.from(
      new Set(
        [
          groupRow?.owner_id,
          ...healedMembers.filter((m) => !m.muted).map((m) => m.user_id),
        ].filter(Boolean)
      )
    ).filter((id) => id !== session.user.id);
    const mutedRecipientIds = healedMembers
      .filter((m) => m.muted && m.user_id)
      .map((m) => m.user_id as string)
      .filter((id) => id !== session.user.id);

    const senderDisplayName =
      session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || 'Someone';
    const notifTitle = groupRow?.name ? `New message — ${groupRow.name}` : 'New group message';
    const notifBody = `${senderDisplayName}: ${body}`;

    await notify(recipientIds, notifTitle, notifBody, { groupId, type: 'group_message' });
    await notify(mutedRecipientIds, notifTitle, notifBody, { groupId, type: 'group_message', silent: true });
  };

  // Same Report/Block action sheet as MessageThread.tsx, for someone
  // else's message - see lib/moderation.ts.
  const handleLongPressOther = (message: GroupMessage, anchor: BubbleAnchor) => {
    if (!session?.user?.id) return;
    const reporterId = session.user.id;
    const name = displayName(message.profiles, 'Someone');
    Alert.alert(name, undefined, [
      { text: 'React', onPress: () => { setReactingToId(message.id); setPickerAnchor(anchor); } },
      {
        text: 'Report Message',
        onPress: () =>
          reportContent({
            reporterId,
            reportedUserId: message.sender_id,
            contentType: 'group_message',
            contentId: message.id,
            groupId,
            reason: `Reported group message from ${name}`,
          }),
      },
      {
        text: `Block ${name}`,
        style: 'destructive',
        onPress: () => {
          Alert.alert('Block this person?', `You won't see messages from ${name} anymore.`, [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Block',
              style: 'destructive',
              onPress: async () => {
                await blockUser({ blockerId: reporterId, blockedId: message.sender_id, blockedName: name });
                await fetchLatest();
              },
            },
          ]);
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  return (
    <GestureDetector gesture={swipeBackGesture}>
    <View style={{ flex: 1 }}>
      {isMember && (
        <TouchableOpacity onPress={toggleMuted} style={styles.muteRow}>
          <Text style={styles.muteText}>{muted ? '🔕 Muted' : '🔔 Mute'}</Text>
        </TouchableOpacity>
      )}

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          ref={listRef}
          style={{ flex: 1 }}
          data={messages}
          keyExtractor={(m) => m.id}
          inverted
          contentContainerStyle={
            // See the matching note in MessageThread.tsx - flexGrow only
            // when empty, or short message lists get stretched into gaps.
            messages.length === 0 ? { paddingBottom: 12, flexGrow: 1 } : { paddingBottom: 12 }
          }
          onEndReached={loadOlder}
          onEndReachedThreshold={0.3}
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator color={colors.primary} style={{ marginVertical: 12 }} />
            ) : !hasMore && messages.length > 0 ? (
              <Text style={styles.endOfThreadText}>Start of conversation</Text>
            ) : null
          }
          renderItem={({ item, index }) => {
            const isMine = item.sender_id === session?.user?.id;
            // See the matching note in MessageThread.tsx - only label the
            // first bubble in a consecutive run from the same sender.
            const showSenderLabel =
              !isMine &&
              (index === messages.length - 1 || messages[index + 1]?.sender_id !== item.sender_id);
            return (
              <MessageBubble
                isMine={isMine}
                senderLabel={!isMine ? senderName(item) : undefined}
                showSenderName={showSenderLabel}
                avatarUrl={!isMine ? item.profiles?.avatar_url : undefined}
                body={item.body}
                timestamp={new Date(item.created_at).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                reactions={reactionsByMessage[item.id] || []}
                isActive={reactingToId === item.id}
                onToggleReaction={(emoji) => toggleReaction(item.id, emoji)}
                onLongPressBubble={(anchor) => {
                  if (isMine) {
                    setReactingToId(item.id);
                    setPickerAnchor(anchor);
                  } else {
                    handleLongPressOther(item, anchor);
                  }
                }}
              />
            );
          }}
          ListEmptyComponent={
            // FlatList's `inverted` prop flips its whole content via a
            // transform, including ListEmptyComponent — counter-flip so
            // this text renders right-side up.
            <Text style={[styles.emptyText, { transform: [{ scaleY: -1 }] }]}>
              No messages yet — say something!
            </Text>
          }
        />
      )}

      <View
        style={[
          styles.inputRow,
          { marginBottom: keyboardHeight > 0 ? keyboardHeight - 20 + 28 : 12 },
        ]}
      >
        <TextInput
          ref={inputRef}
          style={styles.input}
          placeholder="Message..."
          placeholderTextColor={colors.textMuted}
          value={draft}
          onChangeText={updateDraft}
          multiline
        />
        <TouchableOpacity style={styles.sendButton} onPress={handleSend} disabled={sending || !draft.trim()}>
          <Text style={styles.sendButtonText}>Send</Text>
        </TouchableOpacity>
      </View>

      <ReactionPicker
        visible={!!reactingToId}
        anchor={pickerAnchor}
        onClose={() => {
          setReactingToId(null);
          setPickerAnchor(null);
        }}
        onSelect={(emoji) => {
          if (reactingToId) toggleReaction(reactingToId, emoji);
        }}
      />
    </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  muteRow: { alignItems: 'flex-end', marginBottom: 8 },
  muteText: { color: colors.textSecondary, fontSize: 14, fontWeight: '600' },
  emptyText: { color: colors.textMuted, textAlign: 'center', marginTop: 40, fontSize: 15 },
  endOfThreadText: { color: colors.textMuted, textAlign: 'center', fontSize: 12, marginVertical: 12 },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-end',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    maxHeight: 100,
  },
  sendButton: { backgroundColor: colors.primary, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 10 },
  sendButtonText: { color: colors.textOnPrimary, fontWeight: '600', fontSize: 14 },
});
