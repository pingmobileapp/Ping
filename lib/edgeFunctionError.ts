// supabase-js's FunctionsHttpError.message is always the generic "Edge
// Function returned a non-2xx status code" - the edge function's actual
// { error: "..." } body only lives on error.context, the raw Response.
// Shared by every client call site that invokes an edge function and wants
// to show the real failure reason instead of that generic string.
export async function describeFunctionError(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: Response })?.context;
  if (context && typeof context.json === 'function') {
    try {
      const body = await context.json();
      if (body?.error) return body.error as string;
    } catch {
      // context wasn't JSON - fall through to the generic message below
    }
  }
  return error instanceof Error ? error.message : fallback;
}
