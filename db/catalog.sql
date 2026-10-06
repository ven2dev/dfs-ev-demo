-- Read-only #60 inventory. Definitions only: no application rows, connection
-- details, OIDs, ownership role names, statistics or mutable sequence values.
-- The export is evidence; this query does not decide which schema to adopt.
WITH relations AS (
  SELECT c.*
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
), objects AS (
  SELECT 'relation' AS kind, c.relname::text AS name,
    jsonb_build_object(
      'kind', c.relkind, 'persistence', c.relpersistence,
      'row_security', c.relrowsecurity, 'force_row_security', c.relforcerowsecurity,
      'partition_key', CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END,
      'partition_bound', pg_get_expr(c.relpartbound, c.oid),
      'view_definition', CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END
    ) AS definition
  FROM relations c WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
  UNION ALL
  SELECT 'column', c.relname || '.' || a.attname,
    jsonb_build_object(
      'position', a.attnum, 'type', format_type(a.atttypid, a.atttypmod),
      'not_null', a.attnotnull, 'identity', a.attidentity, 'generated', a.attgenerated,
      'default', pg_get_expr(d.adbin, d.adrelid),
      'collation', CASE WHEN a.attcollation <> 0 THEN cn.nspname || '.' || co.collname END
    )
  FROM relations c
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
  LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
  LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'constraint', c.relname || '.' || co.conname,
    jsonb_build_object(
      'type', co.contype, 'definition', pg_get_constraintdef(co.oid, true),
      'validated', co.convalidated, 'deferrable', co.condeferrable,
      'initially_deferred', co.condeferred, 'no_inherit', co.connoinherit
    )
  FROM relations c JOIN pg_catalog.pg_constraint co ON co.conrelid = c.oid
  UNION ALL
  SELECT 'index', ic.relname,
    jsonb_build_object(
      'table', c.relname, 'definition', pg_get_indexdef(i.indexrelid, 0, true),
      'unique', i.indisunique, 'primary', i.indisprimary,
      'valid', i.indisvalid, 'ready', i.indisready,
      'nulls_not_distinct', i.indnullsnotdistinct, 'replica_identity', i.indisreplident
    )
  FROM relations c
  JOIN pg_catalog.pg_index i ON i.indrelid = c.oid
  JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
  UNION ALL
  SELECT 'sequence', c.relname,
    jsonb_build_object(
      'type', format_type(s.seqtypid, NULL), 'start', s.seqstart::text,
      'increment', s.seqincrement::text, 'minimum', s.seqmin::text,
      'maximum', s.seqmax::text, 'cache', s.seqcache::text, 'cycle', s.seqcycle,
      'owned_by', (
        SELECT jsonb_agg(rn.nspname || '.' || rc.relname || '.' || a.attname ORDER BY rn.nspname, rc.relname, a.attname)
        FROM pg_catalog.pg_depend dep
        JOIN pg_catalog.pg_class rc ON rc.oid = dep.refobjid
        JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid = rc.oid AND a.attnum = dep.refobjsubid
        WHERE dep.classid = 'pg_class'::regclass AND dep.objid = c.oid
          AND dep.refclassid = 'pg_class'::regclass AND dep.deptype IN ('a', 'i')
      )
    )
  FROM relations c JOIN pg_catalog.pg_sequence s ON s.seqrelid = c.oid
  UNION ALL
  SELECT 'trigger', c.relname || '.' || t.tgname,
    jsonb_build_object('definition', pg_get_triggerdef(t.oid, true), 'enabled', t.tgenabled)
  FROM relations c JOIN pg_catalog.pg_trigger t ON t.tgrelid = c.oid
  WHERE NOT t.tgisinternal
  UNION ALL
  SELECT 'policy', c.relname || '.' || pol.polname,
    jsonb_build_object(
      'command', pol.polcmd, 'permissive', pol.polpermissive,
      'using', pg_get_expr(pol.polqual, pol.polrelid),
      'check', pg_get_expr(pol.polwithcheck, pol.polrelid)
    )
  FROM relations c JOIN pg_catalog.pg_policy pol ON pol.polrelid = c.oid
  UNION ALL
  SELECT 'routine', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
    jsonb_build_object(
      'kind', p.prokind, 'security_definer', p.prosecdef,
      'definition', CASE WHEN p.prokind <> 'a' THEN pg_get_functiondef(p.oid) END
    )
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'type', t.typname,
    jsonb_build_object(
      'kind', t.typtype, 'base_type', CASE WHEN t.typtype = 'd' THEN format_type(t.typbasetype, t.typtypmod) END,
      'not_null', t.typnotnull, 'default', t.typdefault,
      'enum_labels', (SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid)
    )
  FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  LEFT JOIN pg_catalog.pg_class c ON c.oid = t.typrelid
  WHERE n.nspname = 'public' AND (t.typtype IN ('e', 'd') OR (t.typtype = 'c' AND c.relkind = 'c'))
  UNION ALL
  SELECT 'extension', e.extname,
    jsonb_build_object('version', e.extversion, 'relocatable', e.extrelocatable)
  FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
  WHERE n.nspname = 'public'
)
SELECT kind, name, definition FROM objects ORDER BY kind COLLATE "C", name COLLATE "C";
