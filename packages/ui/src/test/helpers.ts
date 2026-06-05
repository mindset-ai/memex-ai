/**
 * Shared test helpers for the admin package.
 */

/** Create a mock Response returning JSON. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Create a mock Response with an SSE body stream. */
export function fakeSSEResponse(
  events: Array<{ event?: string; data: unknown }>
): Response {
  const chunks = events.map(
    (e) =>
      (e.event ? `event: ${e.event}\n` : '') +
      `data: ${JSON.stringify(e.data)}\n\n`
  );
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
