-- spec-21 t-4: attribution persistence — capture marketing click IDs and UTM params
-- at the moment a new account is created, for server-side conversion reporting.

CREATE TABLE IF NOT EXISTS "user_attributions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "event_id" text NOT NULL,
  "gclid" text,
  "li_fat_id" text,
  "oppref" text,
  "utm_source" text,
  "utm_medium" text,
  "utm_campaign" text,
  "utm_content" text,
  "utm_term" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "user_attributions_user_id_idx"
  ON "user_attributions" ("user_id");
