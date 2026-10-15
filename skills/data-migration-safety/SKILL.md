---
name: data-migration-safety
description: Change a database schema or rewrite stored data without downtime or data loss - expand then contract, backfill in batches, keep every step reversible, and test the migration against realistic data. Use for migrations, schema changes and backfills.
roles: [coder, reviewer]
triggers: [migration*, migrate, schema, database, db, column, table, backfill, index, sql, alter, rename column, data model]
tools: [read_file, code_graph, write_file, run_tests, shell_exec, view_diff, report_finding]
version: 1
---

# Data migration safety

## When to use
Any change to stored data or its schema. Old and new code run side by side during a deploy, so each step must work
with both.

## Procedure
1. **Find every reader and writer** of the tables or fields involved: `code_graph` `symbol` for the model, and
   `shell_exec` `grep` for the table and column names (raw SQL, reports, other services).
2. **Plan expand and contract** (references/patterns.md):
   - expand: add new structures, nullable or with defaults;
   - dual write;
   - backfill;
   - switch reads;
   - contract: remove the old structures in a later release.

   Never rename or drop in the same step that the new code starts depending on.
3. **Each step reversible.** Write the down migration, or explain why one is impossible and what the restore path is
   (a backup, or keeping the old column).
4. **Backfills in batches,** idempotent and resumable, so they can be re-run safely, with bounded locks.
5. **Test against data.** A test creates the old schema with realistic rows (including nulls, duplicates and
   extremes), runs the migration, checks the data, runs the down migration, and checks again (`run_tests`).
6. **Estimate cost.** Note which statements lock or rewrite whole tables on the project's database, and how long they
   would take at the table's real size.

## Required summary
- Readers and writers found
- The steps, and which release each belongs to
- Down migrations, or the restore path
- Migration test results (log ids)
- Locking and duration risks

## Rules
- No destructive step (drop, rename, type narrowing) in the same release that stops using the old form.
- No migration that cannot be re-run safely after a partial failure.
- As a reviewer, report a migration without a tested reverse path with `report_finding`.
