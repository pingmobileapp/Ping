import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const SCHEMA = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          date: {
            type: ['string', 'null'],
            description: 'ISO yyyy-mm-dd. null only if no date at all could be determined for this row.',
          },
          start_time: {
            type: ['string', 'null'],
            description: '24-hour HH:mm. null if this row has no specific time (e.g. an all-day item).',
          },
          end_time: { type: ['string', 'null'], description: '24-hour HH:mm, or null if not stated.' },
          location: { type: ['string', 'null'] },
          details: {
            type: ['string', 'null'],
            description:
              'Any additional notes tied specifically to this row that are not the title, date, time, or location - ' +
              'equipment or attire to bring, a coach or contact name, a phone number, an asterisk/footnote next to ' +
              'this row, parenthetical text, etc. null if there is nothing beyond the basic fields.',
          },
          year_inferred: {
            type: 'boolean',
            description: 'true if the schedule itself had no year printed and you inferred one.',
          },
          confidence: { type: 'string', enum: ['high', 'low'] },
        },
        required: ['title', 'date', 'start_time', 'end_time', 'location', 'details', 'year_inferred', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['events'],
  additionalProperties: false,
};

serve(async (req) => {
  try {
    const { image_base64, media_type } = await req.json();

    if (!image_base64 || typeof image_base64 !== 'string') {
      return new Response(JSON.stringify({ error: 'image_base64 required' }), { status: 400 });
    }
    // Decoded byte size is ~0.75x the base64 string length - reject absurdly
    // large payloads before spending an API call on them. The client already
    // guards this too; this is a server-side backstop, not the primary check.
    if (image_base64.length > 12_000_000) {
      return new Response(JSON.stringify({ error: 'image too large' }), { status: 413 });
    }

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY not set');
      return new Response(JSON.stringify({ error: 'not configured' }), { status: 500 });
    }

    const isoToday = new Date().toISOString().slice(0, 10);

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        system:
          `You read a photo of a printed or handwritten schedule (sports practice/game schedule, class schedule, ` +
          `etc.) and extract every distinct event on it. Today's date is ${isoToday}. ` +
          `If the schedule has no year printed anywhere, infer the most plausible year: pick the next upcoming ` +
          `occurrence of each printed month/day on or after today, and set year_inferred to true for those rows. ` +
          `If a row spans multiple dates (e.g. a multi-day tournament "Sept 5-7"), emit one separate event per ` +
          `date rather than one row with a date range - every row must be a single date. If you truly cannot ` +
          `determine any date for a row, still include it with date set to null rather than omitting it. If the ` +
          `photo contains no readable schedule at all, return an empty events array. Capture anything else tied to ` +
          `a specific row - what to bring, what to wear, a coach/contact name or phone number, a footnote - in ` +
          `that row's details field rather than dropping it. Mark confidence "low" on any row you are genuinely ` +
          `unsure about (blurry text, ambiguous handwriting, a guessed field).`,
        tools: [
          {
            name: 'extract_schedule_events',
            description: 'Record the events extracted from the schedule photo.',
            input_schema: SCHEMA,
            strict: true,
          },
        ],
        tool_choice: { type: 'tool', name: 'extract_schedule_events' },
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: media_type || 'image/jpeg', data: image_base64 },
              },
              { type: 'text', text: 'Extract every event on this schedule.' },
            ],
          },
        ],
      }),
    });

    if (!anthropicResponse.ok) {
      const detail = await anthropicResponse.text();
      console.error('Anthropic API error:', anthropicResponse.status, detail);
      return new Response(JSON.stringify({ error: 'could not read that photo' }), { status: 500 });
    }

    const result = await anthropicResponse.json();
    const toolUse = (result.content || []).find(
      (block: any) => block.type === 'tool_use' && block.name === 'extract_schedule_events'
    );

    if (!toolUse || !Array.isArray(toolUse.input?.events)) {
      return new Response(JSON.stringify({ events: [], warning: 'no_events_found' }), { status: 200 });
    }

    const events = toolUse.input.events;
    return new Response(
      JSON.stringify({ events, warning: events.length === 0 ? 'no_events_found' : null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
