import { db } from "../db/connection.js";
import { waitlistEntries } from "../db/schema.js";
import type { WaitlistEntry } from "../db/schema.js";
import { ConflictError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LEN = 200;
const DEPLOYMENT_VALUES = ["cloud", "self_hosted", "any"] as const;
type Deployment = (typeof DEPLOYMENT_VALUES)[number];

export interface WaitlistInput {
  name: string;
  company: string;
  email: string;
  deployment?: string;
}

export async function addWaitlistEntry(
  input: WaitlistInput,
  ctx: RequestCtx = {},
): Promise<Mutated<WaitlistEntry>> {
  const name = (input.name ?? "").trim();
  const company = (input.company ?? "").trim();
  const email = (input.email ?? "").trim().toLowerCase();
  const deployment: Deployment = DEPLOYMENT_VALUES.includes(input.deployment as Deployment)
    ? (input.deployment as Deployment)
    : "any";

  if (!name || !company || !email) {
    throw new ValidationError("name, company, and email are required");
  }
  if (name.length > MAX_LEN || company.length > MAX_LEN || email.length > MAX_LEN) {
    throw new ValidationError(`fields must be ${MAX_LEN} characters or fewer`);
  }
  if (!EMAIL_RE.test(email)) {
    throw new ValidationError("email is not a valid address");
  }

  // Waitlist is global (not tenancy-scoped): the table has no memex column, so the
  // event carries memexId="". Per spec-156 dec-2 the insert emits waitlist_entry.created
  // on the unified bus (std-8 §6's requires-emit classification) — an admin/backstage
  // subscriber can react in real time without a poll (spec-156 ac-26).
  return mutate(
    ctx,
    { memexId: "", entity: "waitlist_entry", action: "created" },
    async () => {
      try {
        const [entry] = await db
          .insert(waitlistEntries)
          .values({ name, company, email, deployment })
          .returning();
        return entry;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError("That email is already on the waitlist");
        }
        throw err;
      }
    },
  );
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}
