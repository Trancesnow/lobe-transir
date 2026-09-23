CREATE TABLE IF NOT EXISTS resource_save_authorizations (
  token uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id text NOT NULL DEFAULT '',
  operation text NOT NULL,
  content_digest text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS resource_save_authorizations_expiry ON resource_save_authorizations(expires_at);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_resource_save_authorization() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  authorized boolean := current_setting('lobehub.resource_save_workspace', true) = COALESCE(NEW.workspace_id, '')
    AND (NEW.workspace_id IS NOT NULL OR current_setting('lobehub.resource_save_user', true) = NEW.user_id)
    AND COALESCE(current_setting('lobehub.resource_save_user', true), '') <> '';
  was_hidden boolean := false;
  is_hidden boolean := COALESCE(NEW.metadata->>'ephemeral', 'false') = 'true';
BEGIN
  IF TG_TABLE_NAME = 'documents' THEN
    -- Agent configuration is hidden except when explicitly attached to a resource library.
    is_hidden := is_hidden OR (COALESCE(NEW.source_type IN ('agent', 'agent-signal'), false) AND NEW.knowledge_base_id IS NULL);
    IF TG_OP = 'UPDATE' THEN
      was_hidden := COALESCE(OLD.metadata->>'ephemeral', 'false') = 'true'
        OR (COALESCE(OLD.source_type IN ('agent', 'agent-signal'), false) AND OLD.knowledge_base_id IS NULL);
    END IF;
  ELSE
    -- Acceptance evidence belongs to a separate surface, not the resource library.
    is_hidden := is_hidden OR COALESCE(NEW.source = 'acceptance', false);
    IF TG_OP = 'UPDATE' THEN
      was_hidden := COALESCE(OLD.metadata->>'ephemeral', 'false') = 'true'
        OR COALESCE(OLD.source = 'acceptance', false);
    END IF;
  END IF;
  IF NOT is_hidden AND NOT COALESCE(authorized, false) THEN
    IF TG_OP = 'INSERT' OR was_hidden THEN
      RAISE EXCEPTION 'Explicit resource save authorization required' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER documents_require_explicit_save BEFORE INSERT OR UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION enforce_resource_save_authorization();
--> statement-breakpoint
CREATE TRIGGER files_require_explicit_save BEFORE INSERT OR UPDATE ON files
FOR EACH ROW EXECUTE FUNCTION enforce_resource_save_authorization();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_work_save_authorization() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('lobehub.resource_save_workspace', true) IS DISTINCT FROM COALESCE(NEW.workspace_id, '')
    OR COALESCE(current_setting('lobehub.resource_save_user', true), '') = ''
    OR (NEW.workspace_id IS NULL AND current_setting('lobehub.resource_save_user', true) IS DISTINCT FROM NEW.user_id) THEN
    RAISE EXCEPTION 'Explicit work save authorization required' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- AFTER INSERT runs only for actual insertions, preserving ON CONFLICT updates to existing Works.
CREATE TRIGGER works_require_explicit_save AFTER INSERT ON works
FOR EACH ROW EXECUTE FUNCTION enforce_work_save_authorization();
