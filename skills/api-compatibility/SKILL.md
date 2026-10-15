---
name: api-compatibility
description: Decide whether a change breaks anyone who depends on it - exported functions, HTTP routes, schemas, config and CLI flags - and classify it as a patch, minor or major change. Use when a change touches anything other code or users call.
roles: [reviewer, coder]
triggers: [api, public api, interface, schema, breaking, backward*, compatib*, contract, endpoint, exported, sdk, client, signature, response, payload, cli, flag]
tools: [view_diff, code_graph, read_file, shell_exec, run_tests, report_finding]
version: 1
---

# API compatibility

## When to use
The change touches a surface others rely on: exported code, HTTP routes, response or request shapes, database
schemas read by other services, config keys, CLI flags, events or messages.

## Procedure
1. **List the surfaces** in the diff (`view_diff`). For exported code, `code_graph` `file` shows what each changed file
   exports and who imports it. Importers outside the change are consumers.
2. **Compare before and after** for each surface with references/breaking-changes.md: removed or renamed members,
   changed parameter order or types, narrower accepted input, wider returned values, changed defaults, changed
   error behavior, new required fields, and changed status codes.
3. **Find the consumers.** Inside the repository: `code_graph` importers and `shell_exec` `grep` for route paths,
   event names and config keys. Outside it: documentation, clients and published packages. Say what you could not
   check.
4. **Classify** each change as patch (no observable change), minor (additive, old calls still work) or major (an
   existing call can break). The version bump or changelog must match the worst one.
5. **Prove compatibility** where it is claimed. A test that calls the old form still passes (`run_tests`); for a
   deprecated form, a test shows the warning and the old behavior.
6. **Report** each unmarked break with `report_finding`: the surface, the old and new behavior, the consumers
   affected, and a compatible alternative (an optional parameter, a deprecation period, a new version of the route).

## Required summary
- Surfaces changed, and their classification
- Consumers found, and where you could not look
- Compatibility tests (log ids)
- Breaks without a migration path

## Rules
- "Nobody uses it" needs evidence: the search that found no consumers.
- Additive is not automatically safe: a new required field, or a new enum value an exhaustive switch rejects,
  breaks callers.
