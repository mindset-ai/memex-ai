ALTER TABLE "strategies" ADD COLUMN "handle" text NOT NULL;--> statement-breakpoint
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_handle_unique" UNIQUE("handle");