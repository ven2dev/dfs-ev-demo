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
      'access_method', (SELECT amname FROM pg_catalog.pg_am WHERE oid = c.relam),
      'row_security', c.relrowsecurity, 'force_row_security', c.relforcerowsecurity,
      'replica_identity', c.relreplident,
      'options', (SELECT jsonb_agg(option ORDER BY option) FROM unnest(c.reloptions) option),
      'parents', (
        SELECT jsonb_agg(pn.nspname || '.' || pc.relname ORDER BY i.inhseqno)
        FROM pg_catalog.pg_inherits i
        JOIN pg_catalog.pg_class pc ON pc.oid = i.inhparent
        JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
        WHERE i.inhrelid = c.oid
      ),
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
      'validated', co.convalidated, 'enforced', co.conenforced, 'deferrable', co.condeferrable,
      'initially_deferred', co.condeferred, 'no_inherit', co.connoinherit,
      -- Internal trigger names contain OIDs. Compare their semantic identity
      -- and enable state instead, so a disabled FK cannot look healthy.
      'trigger_states', (
        SELECT jsonb_agg(jsonb_build_object(
          'table', tn.nspname || '.' || tc.relname, 'function', pn.nspname || '.' || p.proname,
          'type', t.tgtype, 'enabled', t.tgenabled,
          'deferrable', t.tgdeferrable, 'initially_deferred', t.tginitdeferred
        ) ORDER BY tn.nspname, tc.relname, pn.nspname, p.proname, t.tgtype)
        FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_class tc ON tc.oid = t.tgrelid
        JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
        JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
        JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
        WHERE t.tgconstraint = co.oid AND t.tgisinternal
      )
    )
  FROM relations c JOIN pg_catalog.pg_constraint co ON co.conrelid = c.oid
  UNION ALL
  SELECT 'index', ic.relname,
    jsonb_build_object(
      'table', c.relname, 'definition', pg_get_indexdef(i.indexrelid, 0, true),
      'unique', i.indisunique, 'primary', i.indisprimary,
      'valid', i.indisvalid, 'ready', i.indisready, 'live', i.indislive,
      'immediate', i.indimmediate, 'exclusion', i.indisexclusion,
      'options', (SELECT jsonb_agg(option ORDER BY option) FROM unnest(ic.reloptions) option),
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
  SELECT 'rule', c.relname || '.' || r.rulename,
    jsonb_build_object('definition', pg_get_ruledef(r.oid, true), 'enabled', r.ev_enabled)
  FROM relations c JOIN pg_catalog.pg_rewrite r ON r.ev_class = c.oid
  WHERE r.rulename <> '_RETURN'
  UNION ALL
  SELECT 'policy', c.relname || '.' || pol.polname,
    jsonb_build_object(
      'command', pol.polcmd, 'permissive', pol.polpermissive,
      'roles', (SELECT jsonb_agg(CASE WHEN role_oid = 0 THEN 'public' ELSE pg_get_userbyid(role_oid)::text END
        ORDER BY CASE WHEN role_oid = 0 THEN 'public' ELSE pg_get_userbyid(role_oid)::text END)
        FROM unnest(pol.polroles) role_oid),
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
  WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd')
  UNION ALL
  SELECT 'domain_constraint', t.typname || '.' || co.conname,
    jsonb_build_object('definition', pg_get_constraintdef(co.oid, true),
      'validated', co.convalidated, 'enforced', co.conenforced)
  FROM pg_catalog.pg_constraint co
  JOIN pg_catalog.pg_type t ON t.oid = co.contypid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public'
  UNION ALL
  -- Inventory classes without a complete definition contract as unsupported.
  -- They must cause refusal, never disappear from the managed-object check.
  SELECT 'unsupported', 'type.' || t.typname, jsonb_build_object('kind', t.typtype)
  FROM pg_catalog.pg_type t
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  LEFT JOIN pg_catalog.pg_class c ON c.oid = t.typrelid
  WHERE n.nspname = 'public' AND (
    t.typtype IN ('r', 'm') OR (t.typtype = 'c' AND c.relkind = 'c') OR
    (t.typtype = 'b' AND NOT EXISTS (SELECT FROM pg_catalog.pg_type element WHERE element.typarray = t.oid))
  )
  UNION ALL
  SELECT 'unsupported', 'collation.' || c.collname, '{}'::jsonb
  FROM pg_catalog.pg_collation c JOIN pg_catalog.pg_namespace n ON n.oid = c.collnamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'unsupported', 'operator.' || o.oprname || '(' ||
    CASE WHEN o.oprleft = 0 THEN 'NONE' ELSE format_type(o.oprleft, NULL) END || ',' ||
    CASE WHEN o.oprright = 0 THEN 'NONE' ELSE format_type(o.oprright, NULL) END || ')', '{}'::jsonb
  FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_namespace n ON n.oid = o.oprnamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'unsupported', 'operator_class.' || a.amname || '.' || o.opcname, '{}'::jsonb
  FROM pg_catalog.pg_opclass o JOIN pg_catalog.pg_namespace n ON n.oid = o.opcnamespace
  JOIN pg_catalog.pg_am a ON a.oid = o.opcmethod WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'unsupported', 'operator_family.' || a.amname || '.' || o.opfname, '{}'::jsonb
  FROM pg_catalog.pg_opfamily o JOIN pg_catalog.pg_namespace n ON n.oid = o.opfnamespace
  JOIN pg_catalog.pg_am a ON a.oid = o.opfmethod WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'unsupported', 'conversion.' || c.conname, '{}'::jsonb
  FROM pg_catalog.pg_conversion c JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'unsupported', 'text_search_config.' || c.cfgname, '{}'::jsonb
  FROM pg_catalog.pg_ts_config c JOIN pg_catalog.pg_namespace n ON n.oid = c.cfgnamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'unsupported', 'text_search_dictionary.' || d.dictname, '{}'::jsonb
  FROM pg_catalog.pg_ts_dict d JOIN pg_catalog.pg_namespace n ON n.oid = d.dictnamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'unsupported', 'text_search_parser.' || p.prsname, '{}'::jsonb
  FROM pg_catalog.pg_ts_parser p JOIN pg_catalog.pg_namespace n ON n.oid = p.prsnamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'unsupported', 'text_search_template.' || t.tmplname, '{}'::jsonb
  FROM pg_catalog.pg_ts_template t JOIN pg_catalog.pg_namespace n ON n.oid = t.tmplnamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'unsupported', 'statistics.' || s.stxname, '{}'::jsonb
  FROM pg_catalog.pg_statistic_ext s JOIN pg_catalog.pg_namespace n ON n.oid = s.stxnamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'extension', e.extname,
    jsonb_build_object('version', e.extversion, 'relocatable', e.extrelocatable)
  FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
  WHERE n.nspname = 'public'
)
SELECT kind, name, definition FROM objects ORDER BY kind COLLATE "C", name COLLATE "C";
