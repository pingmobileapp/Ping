import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: { type: 'string' },
      description: '3 to 8 short item names to bring, no quantities or descriptions.',
    },
  },
  required: ['items'],
  additionalProperties: false,
};

serve(async (req) => {
  try {
    const { event_title, past_events } = await req.json();

    if (!event_title || typeof event_title !== 'string') {
      return new Response(JSON.stringify({ error: 'event_title required' }), { status: 400 });
    }

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY not set');
      return new Response(JSON.stringify({ error: 'not configured' }), { status: 500 });
    }

    // Keep the prompt small and cheap - a long items history isn't needed,
    // just enough for Claude to spot "this new event resembles that past
    // one" even when titles don't match literally (a "Lake Trip" should
    // still pull from a past "Beach Day").
    const historyText = Array.isArray(past_events) && past_events.length > 0
      ? past_events
          .slice(0, 20)
          .map((e: any) => `- "${e.title}": ${(e.items || []).join(', ') || '(no items)'}`)
          .join('\n')
      : '(no past events on file)';

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system:
          `You suggest items someone should bring to an event they're hosting, given the event's title and their ` +
          `own history of items from past events they've organized. Prioritize items from past events that ` +
          `resemble this new one in type or theme, even if the titles don't match literally (e.g. a past "Beach ` +
          `Day" is relevant to a new "Lake Trip"). If little or nothing in their history is relevant, still give ` +
          `sensible, generic suggestions appropriate for the kind of event the title describes. Keep every item ` +
          `name short (e.g. "Chips", "Folding chairs", "Sunscreen") - no quantities, no descriptions.`,
        tools: [
          {
            name: 'suggest_items',
            description: 'Record the suggested items to bring.',
            input_schema: SCHEMA,
            strict: true,
          },
        ],
        tool_choice: { type: 'tool', name: 'suggest_items' },
        messages: [
          {
            role: 'user',
            content:
              `New event: "${event_title}"\n\nPast events and their items:\n${historyText}\n\n` +
              `Suggest items to bring to the new event.`,
          },
        ],
      }),
    });

    if (!anthropicResponse.ok) {
      const detail = await anthropicResponse.text();
      console.error('Anthropic API error:', anthropicResponse.status, detail);
      return new Response(JSON.stringify({ error: 'could not generate suggestions' }), { status: 500 });
    }

    const result = await anthropicResponse.json();
    const toolUse = (result.content || []).find(
      (block: any) => block.type === 'tool_use' && block.name === 'suggest_items'
    );

    if (!toolUse || !Array.isArray(toolUse.input?.items)) {
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }

    return new Response(JSON.stringify({ items: toolUse.input.items }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
