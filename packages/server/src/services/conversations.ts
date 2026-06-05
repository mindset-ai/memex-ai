import { eq, and, asc } from "drizzle-orm";
import { db } from "../db/connection.js";
import { conversations, messages, documents } from "../db/schema.js";
import type { Conversation, Message } from "../db/schema.js";
import { NotFoundError } from "../types/errors.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";
import { nextSeq } from "./shared/sequence.js";
import { bus, type ChangeAction, type ChangeEntity } from "./bus.js";

// Resolve the memexId for a conversation by joining through its parent doc.
// Cached at call-time; conversation FK to doc is immutable so this is safe to
// memoise per-request but we keep it simple here.
async function memexIdForConversation(conversationId: string): Promise<string | null> {
  const [row] = await db
    .select({ memexId: documents.memexId })
    .from(conversations)
    .innerJoin(documents, eq(conversations.docId, documents.id))
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return row?.memexId ?? null;
}

// Conversations inherit account scope from their doc. Service verifies doc → account
// before creating or fetching to prevent cross-account chat. Per-conversation reads/writes
// after creation use the conversation.id which is sufficient (created-only-for-our-doc).
export async function getOrCreateConversation(
  memexId: string,
  docId: string,
  userId: string
): Promise<Mutated<Conversation>> {
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.memexId, memexId)),
  });
  if (!doc) throw new NotFoundError(`Document ${docId} not found`);
  const existing = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.docId, docId),
      eq(conversations.userId, userId)
    ),
  });

  // Container-level write — bumps `updatedAt` or inserts a fresh conversation row.
  // silent: true on both paths — no UI subscriber cares about conversation lifecycle
  // itself; the chat panel reactivity rides on `conversation_message` events fired
  // by appendMessage. Per the Standard's opt-out criteria.
  if (existing) {
    return mutate(
      {},
      { memexId, docId, entity: "conversation_message", action: "updated" },
      async () => {
        const [updated] = await db
          .update(conversations)
          .set({ updatedAt: new Date() })
          .where(eq(conversations.id, existing.id))
          .returning();
        return updated;
      },
      { silent: true },
    );
  }

  return mutate(
    {},
    { memexId, docId, entity: "conversation_message", action: "created" },
    async () => {
      const [created] = await db
        .insert(conversations)
        .values({ docId, userId })
        .returning();
      return created;
    },
    { silent: true },
  );
}

export async function getMessages(
  conversationId: string
): Promise<Message[]> {
  return db.query.messages.findMany({
    where: eq(messages.conversationId, conversationId),
    orderBy: [asc(messages.seq)],
  });
}

export async function appendMessage(
  conversationId: string,
  role: string,
  content: unknown
): Promise<Mutated<Message>> {
  const seq = await nextSeq(messages, messages.seq, messages.conversationId, conversationId);
  const memexId = await memexIdForConversation(conversationId);

  // Each persisted message fires `conversation_message.created` on the bus so
  // cross-tab chat subscribers (Wave 2) refetch the conversation. The bus key
  // omits `docId` intentionally — the chat consumer filters by memexId only.
  return mutate(
    {},
    {
      memexId: memexId ?? "",
      entity: "conversation_message",
      action: "created",
    },
    async () => {
      const [message] = await db
        .insert(messages)
        .values({ conversationId, role, content, seq })
        .returning();
      return message;
    },
    // Skip emit if we couldn't resolve memexId — this only happens if the
    // conversation row was deleted in a race; the write below would FK-fail
    // anyway, so the silent path here is harmless.
    memexId ? undefined : { silent: true },
  );
}

// spec-156 ac-14: the full-thread save path. The React UI's chat panel persists
// the *entire* message set on each turn (replace-all semantics), not an append —
// so the route used to do a raw db.delete + per-message db.insert, bypassing
// mutate() and emitting nothing (std-8 violation). This helper folds that
// replace-all into a single mutate() so saving a chat turn emits
// `conversation_message.created`, matching appendMessage's bus key (memexId-only,
// no docId — the chat consumer filters by memexId). One logical change = one
// event per dec-2, so we emit once for the whole set rather than per message.
export async function replaceMessages(
  conversationId: string,
  msgs: ReadonlyArray<{ role: string; content: unknown }>,
  ctx: RequestCtx = {},
): Promise<Mutated<number>> {
  const memexId = await memexIdForConversation(conversationId);

  return mutate(
    ctx,
    {
      memexId: memexId ?? "",
      entity: "conversation_message",
      action: "created",
    },
    async () => {
      await db.delete(messages).where(eq(messages.conversationId, conversationId));
      for (let i = 0; i < msgs.length; i++) {
        await db.insert(messages).values({
          conversationId,
          role: msgs[i].role,
          content: msgs[i].content,
          seq: i + 1,
        });
      }
      return msgs.length;
    },
    // Skip emit if we couldn't resolve memexId — same race rationale as
    // appendMessage: the FK insert below would fail anyway.
    memexId ? undefined : { silent: true },
  );
}

export async function clearConversation(
  conversationId: string
): Promise<Mutated<void>> {
  const memexId = await memexIdForConversation(conversationId);

  return mutate(
    {},
    {
      memexId: memexId ?? "",
      entity: "conversation_message",
      action: "deleted",
    },
    async () => {
      await db
        .delete(messages)
        .where(eq(messages.conversationId, conversationId));

      await db
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
    },
    memexId ? undefined : { silent: true },
  );
}

// ──────────────────────────────────────────────
// Pulse (b-60 t-6) — in-app agent read/call activity
// ──────────────────────────────────────────────
//
// The in-app agent (std-11: direct Anthropic SDK on the server) executes
// non-mutating server tools (search / read / assess / Slack send) without
// going through mutate(), so those calls never reach the Pulse feed. This
// helper emits a `channel:'in_app_agent'` ChangeEvent directly on the bus for
// each such call.
//
// Strictly advisory: it MUST NOT block or throw, and MUST no-op on any
// failure — emission is never on the critical path of an agent turn. We do the
// conversation-id resolution (clientId) + emit fully detached on a microtask so
// the caller's tool result is never delayed and a slow/failed lookup can't
// surface as a tool error.

export interface InAppAgentActivity {
  memexId: string;
  /** The doc the in-app chat is bound to, if any. Used to resolve the
   *  conversation id (clientId) and as the event's docId for doc-scoped reads. */
  docId?: string;
  userId: string;
  action: ChangeAction;
  entity: ChangeEntity;
  narrative: string;
  payload?: Record<string, unknown>;
}

/**
 * Resolve the conversation id for a (doc, user) pair. Conversations are unique
 * per (docId, userId) (see schema). Returns null if none exists yet (e.g. the
 * creation phase, before any conversation row is persisted) or on any error.
 */
async function conversationIdFor(
  docId: string,
  userId: string,
): Promise<string | null> {
  try {
    const row = await db.query.conversations.findFirst({
      where: and(eq(conversations.docId, docId), eq(conversations.userId, userId)),
      columns: { id: true },
    });
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Emit a read/call activity event for an in-app agent tool invocation. Fully
 * advisory — see the section comment above. Never awaited by the caller; never
 * throws.
 */
export function emitInAppAgentActivity(activity: InAppAgentActivity): void {
  // Detach on a microtask so neither the conversation-id lookup nor a throwing
  // bus subscriber can perturb the agent turn that triggered this.
  void (async () => {
    try {
      const clientId = activity.docId
        ? (await conversationIdFor(activity.docId, activity.userId)) ?? undefined
        : undefined;
      bus.emit({
        memexId: activity.memexId,
        docId: activity.docId,
        userId: activity.userId,
        entity: activity.entity,
        action: activity.action,
        narrative: activity.narrative,
        clientId,
        channel: "in_app_agent",
        payload: activity.payload,
      });
    } catch {
      // No-op on failure — activity emission is never on the critical path.
    }
  })();
}
