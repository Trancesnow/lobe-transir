CREATE TABLE ephemeral_storage_deletions (
  object_key text PRIMARY KEY,
  file_hash text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'deleted')),
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ephemeral_storage_deletions_retry ON ephemeral_storage_deletions(state, retry_at);
--> statement-breakpoint
-- A durable tombstone remains after deletion: a timed-out S3 request may finish
-- after the worker loses its database connection. Never reuse a claimed object key.
CREATE FUNCTION protect_ephemeral_storage_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  guarded_object_key text;
BEGIN
  IF TG_TABLE_NAME = 'file_uploads' THEN
    guarded_object_key := NEW.pathname;
  ELSIF TG_TABLE_NAME = 'global_files' THEN
    guarded_object_key := NEW.url;
  ELSE
    guarded_object_key := NEW.url;
  END IF;
  -- This lock serializes the guard with the worker's claim transaction, including
  -- reference inserts whose statement snapshot predates the claim commit.
  PERFORM pg_advisory_xact_lock(164, 1);
  IF EXISTS (SELECT 1 FROM ephemeral_storage_deletions deletion
    WHERE deletion.state IN ('claimed', 'deleted')
      AND deletion.object_key = guarded_object_key) THEN
    RAISE EXCEPTION 'Object is reserved for deletion; upload under a new key' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER protect_files_storage_deletion BEFORE INSERT OR UPDATE ON files
  FOR EACH ROW EXECUTE FUNCTION protect_ephemeral_storage_deletion();
CREATE TRIGGER protect_global_files_storage_deletion BEFORE INSERT OR UPDATE ON global_files
  FOR EACH ROW EXECUTE FUNCTION protect_ephemeral_storage_deletion();
CREATE TRIGGER protect_file_uploads_storage_deletion BEFORE INSERT OR UPDATE ON file_uploads
  FOR EACH ROW EXECUTE FUNCTION protect_ephemeral_storage_deletion();
