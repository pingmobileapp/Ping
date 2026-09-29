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
import { MentionGuest, activeMentionQuery, findMentionedUserIds, routeMessageAlerts, withMentionLabels } from '../lib/mentions';

const PAGE_SIZE = 30;

type Message = {
  id: string;
  event_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  profiles: { full_name: string | null; email: string | null; avatar_url: string | null } | null;
};

type Props = {
  eventId: string;
  onFlipBack: () => void;
  backLabel?: string;
};

export default function MessageThread({ eventId, onFlipBack, backLabel = 'Event Details' }: Props) {
  const { session } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [draft, setDraft] = useState('');
  const draftRef = useRef('');
  const inputRef = useRef<TextInput>(null);

  const updateDraft = (text: string) => {
    draftRef.current = text;
    setDraft(text);
  };
  const [sending, setSending] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [myInviteeId, setMyInviteeId] = useState<string | null>(null);
  // Everyone on this Ping with an account, for @mentions.
  const [guests, setGuests] = useState<MentionGuest[]>([]);
  const [cursor, setCursor] = useState(0);
  const [muted, setMuted] = useState(false);
  const listRef = useRef<FlatList>(null);
  const [reactingToId, setReactingToId] = useState<string | null>(null);
  const [pickerAnchor, setPickerAnchor] = useState<BubbleAnchor | null>(null);
  const { reactionsByMessage, fetchForIds, toggleReaction } = useMessageReactions(
    'message_id',
    session?.user?.id
  );

  // A rightward swipe anywhere on the thread also triggers the same
  // back-out as the button. PanResponder (bubble or capture phase) doesn't
  // reliably win against the FlatList's native scroll gesture on-device -
  // react-native-gesture-handler's Pan gesture negotiates that correctly:
  // failOffsetY cedes to the FlatList once vertical intent is clear,
  // activeOffsetX only claims once horizontal intent is clear.
  // onEnd runs as a worklet on the UI thread - calling onFlipBack (a plain
  // JS function that touches React state/RN Animated) directly from there
  // instead of through runOnJS is exactly the kind of thing that crashes a
  // release build instead of just erroring in dev.
  const swipeBackGesture = Gesture.Pan()
    .activeOffsetX(15)
    .failOffsetY([-10, 10])
    .onEnd((e) => {
      if (e.translationX > 60) {
        runOnJS(onFlipBack)();
      }
    });

  useEffect(() => {
    if (!session?.user?.id) return;
    supabase
      .from('invitees')
      .select('id, muted')
      .eq('event_id', eventId)
      .eq('user_id', session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        setMyInviteeId(data?.id || null);
        setMuted(!!data?.muted);
      });
  }, [eventId, session?.user?.id]);

  useEffect(() => {
    supabase
      .from('invitees')
      .select('user_id, profiles(full_name, email), contacts(name)')
      .eq('event_id', eventId)
      .not('user_id', 'is', null)
      .then(({ data }) => {
        const seen = new Set<string>();
        const list = ((data as any[]) || [])
          .filter((r) => r.user_id && !seen.has(r.user_id) && seen.add(r.user_id))
          .map((r) => ({
            userId: r.user_id as string,
            fullName: r.profiles?.full_name || r.contacts?.name || displayName(r.profiles, 'Guest'),
          }));
        setGuests(withMentionLabels(list));
      });
  }, [eventId]);

  const otherGuests = guests.filter((g) => g.userId !== session?.user?.id);
  const mention = activeMentionQuery(draft, cursor);
  const mentionSuggestions = mention
    ? otherGuests
        .filter((g) => {
          const q = mention.query.toLowerCase();
          return !q || g.label.toLowerCase().startsWith(q) || g.fullName.toLowerCase().split(/\s+/).some((w) => w.startsWith(q));
        })
        .slice(0, 5)
    : [];
  const insertMention = (g: MentionGuest) => {
    if (!mention) return;
    const next = `${draft.slice(0, mention.start)}@${g.label} ${draft.slice(cursor)}`;
    updateDraft(next);
    setCursor(mention.start + g.label.length + 2);
  };

  const toggleMuted = async () => {
    if (!myInviteeId) return;
    const next = !muted;
    setMuted(next);
    const { error } = await supabase.from('invitees').update({ muted: next }).eq('id', myInviteeId);
    if (error) {
      console.error('Error updating mute state:', error);
      setMuted(!next);
    }
  };

  // First name only - the full "First Last" name was wide enough to wrap
  // to its own second line above short messages, which is most of what
  // made the thread look cramped/stacked.
  const senderName = (m: Message) =>
    m.sender_id === session?.user?.id ? 'You' : displayName(m.profiles, 'Someone').split(' ')[0];

  // KeyboardAvoidingView is unreliable inside this component's nested,
  // animated (flip-card) ancestor chain - it was observed collapsing the
  // input mid-type. Track the real keyboard height directly instead and
  // apply it as an explicit offset.
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
      .from('messages')
      .select('id, event_id, sender_id, body, created_at, profiles(full_name, email, avatar_url)')
      .eq('event_id', eventId)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE);

    if (error) {
      console.error('Error fetching messages:', error);
      return;
    }
    const page = (data as any[]) || [];
    setMessages(page);
    setHasMore(page.length === PAGE_SIZE);
    fetchForIds(page.map((m) => m.id));
  }, [eventId, fetchForIds]);

  const loadOlder = async () => {
    if (loadingMore || !hasMore || messages.length === 0) return;
    setLoadingMore(true);

    const oldest = messages[messages.length - 1];
    const { data, error } = await supabase
      .from('messages')
      .select('id, event_id, sender_id, body, created_at, profiles(full_name, email, avatar_url)')
      .eq('event_id', eventId)
      .lt('created_at', oldest.created_at)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE);

    setLoadingMore(false);

    if (error) {
      console.error('Error loading older messages:', error);
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
      .channel(`messages-${eventId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `event_id=eq.${eventId}` },
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
  }, [eventId, fetchLatest, session?.user?.id]);

  // Clears the unread chat dot on Home's EventCard (see
  // app/(tabs)/index.tsx) the moment this event's messages are actually
  // viewed - via the new chat icon, a swipe, or a push tap, whichever got
  // here. A direct targeted update rather than going through
  // NotificationsContext's markRead(id) - this component doesn't know
  // (or need to know) which notification row, if any, that consolidated
  // down to. useNotifications' own realtime subscription picks up this
  // write and updates the shared unread state on its own.
  useEffect(() => {
    if (!session?.user?.id) return;
    supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('recipient_id', session.user.id)
      .eq('event_id', eventId)
      .eq('type', 'message')
      .is('read_at', null)
      .then(({ error }) => {
        if (error) console.error('Error marking message notification read:', error);
      });
  }, [eventId, session?.user?.id]);

  const handleSend = async () => {
    // Tapping Send while an autocorrect suggestion is still highlighted
    // doesn't "accept" it the way pressing space would - blurring forces
    // iOS to commit the pending correction, and the short wait gives its
    // onChangeText time to land before the text is read for sending.
    // Otherwise the uncorrected word goes out, with the correction landing
    // a moment later and nothing sent for it - the second send it looked
    // like this needed.
    inputRef.current?.blur();
    await new Promise((resolve) => setTimeout(resolve, 60));

    const body = draftRef.current.trim();
    if (!body || !session?.user?.id) return;

    setSending(true);
    updateDraft('');

    const { data: inserted, error } = await supabase
      .from('messages')
      .insert([{ event_id: eventId, sender_id: session.user.id, body }])
      .select('id')
      .single();

    setSending(false);

    if (error) {
      console.error('Error sending message:', error);
      updateDraft(body);
      return;
    }

    // Doesn't block sending (a naive keyword list has false positives) -
    // just raises the same admin report a user's own flag would, see
    // lib/contentFilter.ts.
    if (containsObjectionableContent(body) && inserted) {
      reportContent({
        reporterId: session.user.id,
        reportedUserId: session.user.id,
        contentType: 'message',
        contentId: inserted.id,
        eventId,
        reason: 'Auto-flagged message content',
        source: 'auto_filter',
      });
    }

    await fetchLatest();

    const [{ data: otherInvitees }, { data: eventRow }] = await Promise.all([
      supabase
        .from('invitees')
        .select('user_id, muted, rsvp_status')
        .eq('event_id', eventId)
        .neq('user_id', session.user.id)
        .not('user_id', 'is', null),
      supabase.from('events').select('title').eq('id', eventId).single(),
    ]);

    const { mentioned, normal: recipientIds, silent: mutedRecipientIds } = routeMessageAlerts(
      (otherInvitees as any[]) || [],
      findMentionedUserIds(body, otherGuests)
    );
    const senderDisplayName =
      session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || 'Someone';
    const notifTitle = eventRow?.title ? `New message — ${eventRow.title}` : 'New message';
    const notifBody = `${senderDisplayName}: ${body}`;
    const mentionTitle = eventRow?.title
      ? `${senderDisplayName} mentioned you — ${eventRow.title}`
      : `${senderDisplayName} mentioned you`;

    await notify(mentioned, mentionTitle, body, { eventId, type: 'message' });
    await notify(recipientIds, notifTitle, notifBody, { eventId, type: 'message' });
    await notify(mutedRecipientIds, notifTitle, notifBody, { eventId, type: 'message', silent: true });
  };

  // Long-pressing someone else's message offers Report/Block alongside
  // reacting, instead of jumping straight to the reaction picker the way
  // it does for your own messages - see lib/moderation.ts.
  const handleLongPressOther = (message: Message, anchor: BubbleAnchor) => {
    if (!session?.user?.id) return;
    const reporterId = session.user.id;
    const senderName = displayName(message.profiles);
    Alert.alert(senderName, undefined, [
      { text: 'React', onPress: () => { setReactingToId(message.id); setPickerAnchor(anchor); } },
      {
        text: 'Report Message',
        onPress: () =>
          reportContent({
            reporterId,
            reportedUserId: message.sender_id,
            contentType: 'message',
            contentId: message.id,
            eventId,
            reason: `Reported message from ${senderName}`,
          }),
      },
      {
        text: `Block ${senderName}`,
        style: 'destructive',
        onPress: () => {
          Alert.alert('Block this person?', `You won't see messages from ${senderName} anymore.`, [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Block',
              style: 'destructive',
              onPress: async () => {
                await blockUser({ blockerId: reporterId, blockedId: message.sender_id, blockedName: senderName });
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
      <View style={styles.topRow}>
        <TouchableOpacity onPress={onFlipBack} style={styles.backButton}>
          <Text style={styles.backText}>‹ {backLabel}</Text>
        </TouchableOpacity>
        {myInviteeId && (
          <TouchableOpacity onPress={toggleMuted}>
            <Text style={styles.muteText}>{muted ? '🔕 Muted' : '🔔 Mute'}</Text>
          </TouchableOpacity>
        )}
      </View>

      <Text style={styles.header}>Messages</Text>

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
            // flexGrow only when empty, to center the "no messages" text -
            // applied unconditionally it also stretches short (but
            // non-empty) message lists, which pushes message groups apart
            // into ugly gaps instead of clustering near the input.
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
            // `messages` is newest-first and the list is inverted, so the
            // chronologically-previous message (rendered just above this
            // one) is at index + 1. Only label the first bubble in a
            // consecutive run from the same sender - repeating the full
            // name on every short message (e.g. a quick back-and-forth) is
            // most of what was making the thread look cramped.
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
                mentionLabels={guests.map((g) => g.label)}
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

      {mentionSuggestions.length > 0 && (
        <View style={styles.mentionList}>
          {mentionSuggestions.map((g) => (
            <TouchableOpacity key={g.userId} style={styles.mentionRow} onPress={() => insertMention(g)}>
              <Text style={styles.mentionName}>@{g.label}</Text>
              {g.label !== g.fullName && <Text style={styles.mentionFull}>{g.fullName}</Text>}
            </TouchableOpacity>
          ))}
        </View>
      )}
      <View
        style={[
          styles.inputRow,
          // The card is inset 20px from the screen edge already (its own
          // padding), so only the keyboard height beyond that needs to be
          // reserved here, plus a small buffer so the input floats clear
          // of the keyboard instead of touching it.
          { marginBottom: keyboardHeight > 0 ? keyboardHeight - 20 + 28 : 12 },
        ]}
      >
        <TextInput
          ref={inputRef}
          style={styles.input}
          placeholder="Message... (type @ to mention someone)"
          placeholderTextColor={colors.textMuted}
          value={draft}
          onChangeText={(text) => {
            updateDraft(text);
            setCursor(text.length);
          }}
          onSelectionChange={(e) => setCursor(e.nativeEvent.selection.end)}
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
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  backButton: {},
  backText: { color: colors.primary, fontSize: 16, fontWeight: '600' },
  muteText: { color: colors.textSecondary, fontSize: 14, fontWeight: '600' },
  header: { color: colors.textPrimary, fontSize: 20, fontWeight: '700', marginBottom: 12 },
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
  mentionList: {
    backgroundColor: colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 4,
    marginTop: 6,
  },
  mentionRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingHorizontal: 14, paddingVertical: 10 },
  mentionName: { color: colors.primary, fontSize: 15, fontWeight: '700' },
  mentionFull: { color: colors.textSecondary, fontSize: 13 },
  sendButton: { backgroundColor: colors.primary, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 10 },
  sendButtonText: { color: colors.textOnPrimary, fontWeight: '600', fontSize: 14 },
});
