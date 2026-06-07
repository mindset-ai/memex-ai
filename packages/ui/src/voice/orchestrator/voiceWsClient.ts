// spec-190 t-3 (dec-2/dec-9) — the browser side of the audio-leg WebSocket
// (routes/voice.ts is the server side). One socket per session carries mic PCM
// upstream and transcripts + TTS audio + control frames downstream (ac-32).
//
// Pure-ish: the WebSocket is created via an injectable factory so the message
// routing / encoding is unit-testable with a fake socket and no real network.
// The wire protocol is the contract documented in routes/voice.ts.

import type { CharAlignment } from '../bargeIn';

export interface VoiceWsCallbacks {
  onReady?: () => void;
  onTranscript?: (text: string, isFinal: boolean) => void;
  onAudio?: (
    requestId: string,
    audio: ArrayBuffer,
    alignment: CharAlignment | undefined,
    isFinal: boolean,
  ) => void;
  onError?: (message: string, requestId?: string) => void;
  onClose?: () => void;
}

export interface VoiceWsClient {
  /** Forward a mic PCM frame upstream (binary). */
  sendAudio(frame: ArrayBuffer): void;
  startListening(): void;
  endUtterance(): void;
  /** Ask the server to synthesize `text` for this turn (requestId scopes abort). */
  speak(requestId: string, text: string): void;
  abort(requestId: string): void;
  close(): void;
}

/** Minimal structural type for the socket — satisfied by the browser WebSocket
 *  and by a fake in tests. */
export interface SocketLike {
  send(data: string | ArrayBufferView | ArrayBuffer): void;
  close(): void;
  binaryType: string;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Map the server's forwarded ElevenLabs alignment onto the barge-in shape. */
function toAlignment(raw: unknown): CharAlignment | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const a = raw as { chars?: unknown; charStartMs?: unknown };
  if (!Array.isArray(a.chars) || !Array.isArray(a.charStartMs)) return undefined;
  return { chars: a.chars as string[], charStartMs: a.charStartMs as number[] };
}

/**
 * Build the session WS URL from the tenant base (`/api/<ns>/<mx>`) + a session
 * token. http(s) → ws(s); the token rides the connect query (the handshake can't
 * carry an Authorization header — routes/voice.ts authenticates it).
 */
export function buildVoiceWsUrl(tenantBase: string, token: string, origin: string): string {
  const u = new URL(`${tenantBase}/voice/session`, origin);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.searchParams.set('token', token);
  return u.toString();
}

export function openVoiceWs(
  url: string,
  callbacks: VoiceWsCallbacks,
  socketFactory: SocketFactory = (u) => new WebSocket(u) as unknown as SocketLike,
): VoiceWsClient {
  const ws = socketFactory(url);
  ws.binaryType = 'arraybuffer';

  // NB: do NOT fire onReady on raw socket open. The server emits an explicit
  // {type:"ready"} control frame only AFTER it passes the config + auth checks
  // (routes/voice.ts open()); a denied connection is closed 1008 and never sends
  // it. Driving start_listening off the server frame (case 'ready' below) means we
  // (a) never push start_listening into a socket the server is about to close, and
  // (b) open the upstream ElevenLabs STT session exactly once — onopen + the ready
  // frame both firing would have opened-then-immediately-closed a first STT session
  // every connect, burning the scarce STT concurrency pool (s-4).
  ws.onerror = () => callbacks.onError?.('voice socket error');
  ws.onclose = () => callbacks.onClose?.();
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return; // server control frames are JSON text
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'ready':
        callbacks.onReady?.();
        break;
      case 'transcript':
        callbacks.onTranscript?.(String(msg.text ?? ''), Boolean(msg.isFinal));
        break;
      case 'audio':
        callbacks.onAudio?.(
          String(msg.requestId ?? ''),
          base64ToArrayBuffer(String(msg.audio ?? '')),
          toAlignment(msg.alignment),
          Boolean(msg.isFinal),
        );
        break;
      case 'error':
        callbacks.onError?.(String(msg.message ?? 'voice error'), msg.requestId ? String(msg.requestId) : undefined);
        break;
    }
  };

  const sendJson = (obj: Record<string, unknown>) => ws.send(JSON.stringify(obj));

  return {
    sendAudio: (frame) => ws.send(frame),
    startListening: () => sendJson({ type: 'start_listening' }),
    endUtterance: () => sendJson({ type: 'end_utterance' }),
    speak: (requestId, text) => sendJson({ type: 'speak', requestId, text }),
    abort: (requestId) => sendJson({ type: 'abort', requestId }),
    close: () => ws.close(),
  };
}
