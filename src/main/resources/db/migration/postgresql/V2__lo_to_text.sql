-- Legacy safety net for PostgreSQL.
--
-- Older versions of this application mapped found_viruses_json and error_message
-- as @Lob, which PostgreSQL stores as OID large objects. Those columns then fail at
-- runtime with "Large objects may not be used in auto-commit mode".
--
-- This migration converts them to TEXT if (and only if) they are still OID columns,
-- so it is a no-op on databases created by V1__init.sql. It runs before Hibernate
-- validates the schema, which is why it replaces the former PostgresLobMigration
-- component (that one ran after startup, too late for ddl-auto=validate).

DO $$
DECLARE
    found_viruses_type text;
    error_message_type text;
BEGIN
    SELECT data_type INTO found_viruses_type
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'scan_jobs'
       AND column_name = 'found_viruses_json';

    SELECT data_type INTO error_message_type
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'scan_jobs'
       AND column_name = 'error_message';

    IF found_viruses_type = 'oid' THEN
        ALTER TABLE scan_jobs ADD COLUMN found_viruses_json_text TEXT;
        UPDATE scan_jobs
           SET found_viruses_json_text =
               CASE WHEN found_viruses_json IS NULL THEN NULL
                    ELSE convert_from(lo_get(found_viruses_json), 'UTF8') END;
        ALTER TABLE scan_jobs DROP COLUMN found_viruses_json;
        ALTER TABLE scan_jobs RENAME COLUMN found_viruses_json_text TO found_viruses_json;
    END IF;

    IF error_message_type = 'oid' THEN
        ALTER TABLE scan_jobs ADD COLUMN error_message_text TEXT;
        UPDATE scan_jobs
           SET error_message_text =
               CASE WHEN error_message IS NULL THEN NULL
                    ELSE convert_from(lo_get(error_message), 'UTF8') END;
        ALTER TABLE scan_jobs DROP COLUMN error_message;
        ALTER TABLE scan_jobs RENAME COLUMN error_message_text TO error_message;
    END IF;
END $$;
