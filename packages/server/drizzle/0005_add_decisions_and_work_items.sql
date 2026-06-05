-- Decisions
CREATE TABLE IF NOT EXISTS "decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "doc_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "seq" integer NOT NULL,
  "title" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "resolution" text,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "decisions_doc_id_seq_unique" UNIQUE("doc_id", "seq")
);

-- Work Items
CREATE TABLE IF NOT EXISTS "work_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "doc_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "seq" integer NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "status" text DEFAULT 'not_started' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  CONSTRAINT "work_items_doc_id_seq_unique" UNIQUE("doc_id", "seq")
);

-- Decision dependencies (work item blocked by decision)
CREATE TABLE IF NOT EXISTS "decision_deps" (
  "work_item_id" uuid NOT NULL REFERENCES "work_items"("id") ON DELETE CASCADE,
  "decision_id" uuid NOT NULL REFERENCES "decisions"("id") ON DELETE CASCADE,
  CONSTRAINT "decision_deps_pkey" PRIMARY KEY("work_item_id", "decision_id")
);

-- Work item dependencies (work item depends on another work item)
CREATE TABLE IF NOT EXISTS "work_item_deps" (
  "work_item_id" uuid NOT NULL REFERENCES "work_items"("id") ON DELETE CASCADE,
  "depends_on_id" uuid NOT NULL REFERENCES "work_items"("id") ON DELETE CASCADE,
  CONSTRAINT "work_item_deps_pkey" PRIMARY KEY("work_item_id", "depends_on_id"),
  CONSTRAINT "no_self_dep" CHECK ("work_item_id" != "depends_on_id")
);
