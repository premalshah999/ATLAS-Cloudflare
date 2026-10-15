---
name: dependency-upgrade
description: Upgrade a dependency without surprises - read what changed between the versions, find every use with the code graph, change the lockfile through the package manager, and prove the upgrade with the full suite. Use for version bumps, deprecations and vulnerability fixes.
roles: [coder]
triggers: [upgrade, update, bump, dependenc*, package*, library, version, deprecat*, vulnerab*, cve, outdated, npm, pnpm, yarn, pip]
tools: [mission_memory, code_graph, read_file, shell_exec, run_tests, view_diff, write_file, process_start]
version: 1
---

# Dependency upgrade

## When to use
A dependency must move to a new version. Installing packages needs network access, so each install asks the operator
for approval; plan for one install, not several.

## Procedure
1. **Know the jump.** Read the current version from the manifest and lockfile (`read_file`). Note whether the target
   crosses a major version.
2. **Find every use.** `code_graph` `symbol` for the imported names, and `shell_exec` `grep` for the package name
   (dynamic imports, config files, scripts). List each call site and the APIs it uses.
3. **Read what changed.** After the install, read the package's CHANGELOG or release notes inside `node_modules` (or
   the equivalent) for every version in between. List breaking changes, deprecations and changed defaults that touch
   the APIs you found.
4. **Upgrade through the package manager** (`shell_exec`, for example `npm install pkg@x.y.z`), never by editing the
   lockfile by hand. One approval, one install.
5. **Adapt the call sites** for each breaking change you listed. Prefer the new API to a compatibility shim.
6. **Prove it.** The full suite passes (`run_tests`). If the package is used at runtime by an app, start it
   (`process_start` with serve when allowed) and exercise one path that uses the package.
7. **Review the diff** (`view_diff`): the manifest, the lockfile and the adapted call sites only. Check that no
   unrelated packages moved in the lockfile; if they did, say why.

## Required summary
- From and to versions, and whether it crosses a major version
- Breaking changes that applied, and how each call site was adapted
- Lockfile changes beyond the target package, and why
- Test results (log ids)
- Rollback: the previous version and the files to restore

## Rules
- Never pin to a version you have not read the changes for.
- Never add a new dependency to work around an upgrade problem without saying so; ATLAS's security scan reports new
  packages and install scripts.
- If the upgrade is blocked (approval denied, incompatible), stop and report; do not hand-edit the lockfile.
