// Throwaway local dev seed — a simple email/password login for previewing.
//   DATABASE_URL=... TEST_EMAIL=... TEST_PASSWORD=... tsx src/db/seed-test-user.ts
// Idempotent: reruns reset the password and keep the email verified.
import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import { namespaces, memexes, users } from "./schema.js";
import { hashPassword } from "../services/passwords.js";

const EMAIL = process.env.TEST_EMAIL ?? "test@test.com";
const PASSWORD = process.env.TEST_PASSWORD ?? "bombardear";
// Personal namespace slug — kept simple + stable so reruns are idempotent.
const SLUG = process.env.TEST_SLUG ?? "test-user";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const client = postgres(connectionString);
  const db = drizzle(client, { schema });

  const passwordHash = await hashPassword(PASSWORD);

  let user = await db.query.users.findFirst({ where: eq(users.email, EMAIL) });
  if (!user) {
    [user] = await db
      .insert(users)
      .values({
        email: EMAIL,
        emailVerifiedAt: new Date(),
        passwordHash,
      } as typeof users.$inferInsert)
      .returning();
    console.log(`Created user ${user.id} <${EMAIL}>`);
  } else {
    [user] = await db
      .update(users)
      .set({ passwordHash, emailVerifiedAt: user.emailVerifiedAt ?? new Date() })
      .where(eq(users.id, user.id))
      .returning();
    console.log(`User exists ${user.id} <${EMAIL}> — password reset`);
  }

  let ns = await db.query.namespaces.findFirst({ where: eq(namespaces.slug, SLUG) });
  if (!ns) {
    [ns] = await db
      .insert(namespaces)
      .values({ slug: SLUG, kind: "user", ownerUserId: user.id })
      .returning();
    await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Personal" });
    console.log(`Created personal namespace ${SLUG} + memex`);
  } else {
    console.log(`Namespace ${SLUG} already exists`);
  }

  console.log(`\nLogin: ${EMAIL} / ${PASSWORD}`);
  await client.end();
}

main().catch((err) => {
  console.error("seed-test-user failed:", err);
  process.exit(1);
});
