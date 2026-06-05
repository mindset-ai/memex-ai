-- Add resolution text to doc_comments for recording what was done to address the comment
ALTER TABLE "doc_comments" ADD COLUMN "resolution" text;
