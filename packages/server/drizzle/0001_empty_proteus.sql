CREATE TABLE "strategy_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"section_id" uuid NOT NULL,
	"author_name" text NOT NULL,
	"content" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "strategy_comments" ADD CONSTRAINT "strategy_comments_section_id_strategy_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."strategy_sections"("id") ON DELETE cascade ON UPDATE no action;