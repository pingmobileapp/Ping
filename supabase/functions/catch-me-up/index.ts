import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

serve(async (req) => {
  try {
    const { upcoming_events, unclaimed_items, unread_notifications } = await req.json();

    const hasNothing =
      (!upcoming_events || upcoming_events.length === 0) &&
      (!unclaimed_items || unclaimed_items.length === 0) &&
      (!unread_notifications || unread_notifications.length === 0);

    // Nothing to summarize - skip the API call entirely rather than paying
    // for a round trip just to have Claude say "nothing's going on."
    if (hasNothing) {
      return new Response(JSON.stringify({ summary: "You're all caught up - nothing new or upcoming." }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY not set');
      return new Response(JSON.stringify({ error: 'not configured' }), { status: 500 });
    }

    const eventsText = (upcoming_events || [])
      .map((e: any) => `- "${e.title}" on ${e.date} (your RSVP: ${e.my_rsvp})`)
      .join('\n') || '(none)';
    const itemsText = (unclaimed_items || [])
      .map((i: any) => `- "${i.item_name}" for "${i.event_title}" still needs someone`)
      .join('\n') || '(none)';
    const notifsText = (unread_notifications || [])
      .map((n: any) => `- ${n.title}: ${n.body}`)
      .join('\n') || '(none)';

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 400,
        system:
          `You write a short, warm, plain-text catch-up summary for someone opening a family event-planning app. ` +
          `Given their upcoming events, items still needing a volunteer, and unread notifications, write 2-4 ` +
          `sentences highlighting what's most worth their attention - lead with anything actionable (a pending ` +
          `RSVP, an item nobody's claimed yet) before just narrating what's coming up. Keep it conversational, ` +
          `like a friend catching you up, not a bulleted report. No headers, no markdown, plain sentences. Address ` +
          `them directly ("you").`,
        messages: [
          {
            role: 'user',
            content:
              `Upcoming events:\n${eventsText}\n\nItems still needing a volunteer:\n${itemsText}\n\n` +
              `Unread notifications:\n${notifsText}`,
          },
        ],
      }),
    });

    if (!anthropicResponse.ok) {
      const detail = await anthropicResponse.text();
      console.error('Anthropic API error:', anthropicResponse.status, detail);
      return new Response(JSON.stringify({ error: 'could not generate summary' }), { status: 500 });
    }

    const result = await anthropicResponse.json();
    const summary = (result.content || [])
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('')
      .trim();

    return new Response(JSON.stringify({ summary: summary || "You're all caught up." }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
