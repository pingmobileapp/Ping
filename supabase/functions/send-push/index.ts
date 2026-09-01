import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

serve(async (req) => {
  try {
    const { user_ids, title, body, data } = await req.json();

    if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
      return new Response(JSON.stringify({ error: 'user_ids required' }), { status: 400 });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id, push_token')
      .in('id', user_ids)
      .not('push_token', 'is', null);

    if (error) throw error;

    if (!profiles || profiles.length === 0) {
      return new Response(JSON.stringify({ sent: 0, reason: 'no push tokens for these users' }), {
        status: 200,
      });
    }

    // The app icon's badge number - each recipient gets their own actual
    // unread count, not a flat "1" per push. lib/notify.ts awaits the
    // notifications-table write before invoking this function, so the row
    // this push is for is already committed and counted here.
    const { data: unreadRows, error: unreadError } = await supabase
      .from('notifications')
      .select('recipient_id')
      .in('recipient_id', user_ids)
      .is('read_at', null);
    if (unreadError) console.error('Error counting unread notifications:', unreadError);

    const unreadCounts = new Map<string, number>();
    (unreadRows || []).forEach((r) => {
      unreadCounts.set(r.recipient_id, (unreadCounts.get(r.recipient_id) || 0) + 1);
    });

    const messages = profiles.map((p) => ({
      to: p.push_token,
      title,
      body,
      data: data || {},
      sound: 'default',
      badge: unreadCounts.get(p.id) || 0,
      // Lets invite pushes show Accept/Interested/Decline as native
      // quick-actions - see the matching categories registered in
      // lib/pushNotifications.ts. A priced event uses the no-actions
      // category instead - Accept can't be a quick-action for it, since
      // that would need to open Stripe Checkout, which a backgrounded
      // notification response can't do.
      ...(data?.type === 'invite' ? { categoryId: data?.hasPrice ? 'invite_priced' : 'invite' } : {}),
    }));

    const pushResponse = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });

    const result = await pushResponse.json();

    return new Response(JSON.stringify({ sent: profiles.length, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
