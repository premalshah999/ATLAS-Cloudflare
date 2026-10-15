# Patterns

**Rename a column.**
1. Add the new column.
2. Write both columns.
3. Backfill the new column from the old.
4. Read the new column.
5. Stop writing the old column.
6. Drop the old column, in a later release.

**Make a column required.**
1. Backfill nulls with a sensible value.
2. Add the NOT NULL constraint without validating existing rows, if the database supports it.
3. Validate.

**Split a table.**
1. Create the new table.
2. Dual write.
3. Backfill.
4. Switch reads.
5. Stop the old writes.
6. Drop the old table, in a later release.

**Add an index on a large table.** Build it concurrently or online where the database supports it, outside a
transaction.

**Change a type.** Add a new column of the new type, then follow the rename pattern. Never narrow a type in place.

**Backfill.**
- Process in primary-key ranges.
- Commit per batch.
- Record progress so a re-run continues where it stopped.
- Throttle against database load.
