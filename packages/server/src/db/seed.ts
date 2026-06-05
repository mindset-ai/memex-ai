import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import { namespaces, orgs, memexes, documents, docSections } from "./schema.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

const client = postgres(connectionString);
const db = drizzle(client, { schema });

async function seed() {
  console.log("Seeding database...");

  // Ensure a default namespace + org + memex exist for the seed doc (post-t-11 schema
  // requires memex_id on documents).
  const seedSlug = "seed";
  let ns = await db.query.namespaces.findFirst({
    where: eq(namespaces.slug, seedSlug),
  });
  if (!ns) {
    [ns] = await db
      .insert(namespaces)
      .values({ slug: seedSlug, kind: "org" })
      .returning();
    const [org] = await db
      .insert(orgs)
      .values({ namespaceId: ns.id, name: "Seed" })
      .returning();
    await db
      .update(namespaces)
      .set({ ownerOrgId: org.id })
      .where(eq(namespaces.id, ns.id));
  }
  let memex = await db.query.memexes.findFirst({
    where: eq(memexes.namespaceId, ns.id),
  });
  if (!memex) {
    [memex] = await db
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: "main", name: "Main" })
      .returning();
  }

  const [doc] = await db
    .insert(documents)
    .values({
      memexId: memex.id,
      handle: "doc-1",
      title: "Q3 Growth Spec",
      docType: "document",
    })
    .returning();

  await db.insert(docSections).values([
    {
      docId: doc.id,
      sectionType: "purpose",
      title: "Purpose",
      content: "Expand into enterprise segment while maintaining SMB retention above 90%.",
      seq: 1,
      position: 1,
    },
    {
      docId: doc.id,
      sectionType: "approach",
      title: "Approach",
      content: "Hire dedicated enterprise sales team. Build SSO and audit log features. Launch partner programme.",
      seq: 2,
      position: 2,
    },
    {
      docId: doc.id,
      sectionType: "risks",
      title: "Risks",
      content: "Enterprise sales cycle is 3-6 months. Risk of neglecting SMB product roadmap during transition.",
      seq: 3,
      position: 3,
    },
  ]);

  console.log(`Created document "${doc.title}" with 3 sections.`);
  await client.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
