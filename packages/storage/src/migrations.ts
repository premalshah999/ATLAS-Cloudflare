// Forward-only schema migrations (manual §39). Never edit a shipped migration; add a new one.
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE, is_git INTEGER NOT NULL,
        branch TEXT, head TEXT, dirty INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE missions (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), title TEXT NOT NULL, goal TEXT NOT NULL,
        constraints TEXT NOT NULL, approval_mode TEXT NOT NULL, runtime TEXT NOT NULL, base_commit TEXT, state TEXT NOT NULL,
        plan_version INTEGER NOT NULL DEFAULT 0, policy_id TEXT NOT NULL, outcome TEXT, decision TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX missions_ws ON missions(workspace_id, updated_at);
      CREATE TABLE plans (
        mission_id TEXT NOT NULL REFERENCES missions(id), version INTEGER NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY (mission_id, version)
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), key TEXT NOT NULL, title TEXT NOT NULL, role TEXT NOT NULL,
        dependencies TEXT NOT NULL, state TEXT NOT NULL, retries INTEGER NOT NULL DEFAULT 0, acceptance TEXT NOT NULL,
        result_ref TEXT, worktree TEXT, branch TEXT, UNIQUE (mission_id, key)
      );
      CREATE INDEX tasks_mission ON tasks(mission_id);
      CREATE TABLE attempts (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), mission_id TEXT NOT NULL REFERENCES missions(id),
        number INTEGER NOT NULL, state TEXT NOT NULL, runtime TEXT NOT NULL, pid INTEGER, started_at TEXT NOT NULL,
        ended_at TEXT, error TEXT, tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX attempts_task ON attempts(task_id);
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), task_id TEXT, agent_role TEXT NOT NULL, tool TEXT NOT NULL,
        capability TEXT NOT NULL, action TEXT NOT NULL, environment TEXT NOT NULL, resources TEXT NOT NULL, reason TEXT NOT NULL,
        risk TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL, requested_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        decided_at TEXT, decided_by TEXT
      );
      CREATE INDEX approvals_mission ON approvals(mission_id, status);
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), task_id TEXT, kind TEXT NOT NULL, name TEXT NOT NULL,
        size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX artifacts_mission ON artifacts(mission_id);
      CREATE TABLE checks (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), name TEXT NOT NULL, command TEXT, required INTEGER NOT NULL,
        result TEXT NOT NULL, exit_code INTEGER, duration_ms INTEGER, reason TEXT NOT NULL, artifact_id TEXT, commit_sha TEXT
      );
      CREATE TABLE events (
        mission_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, ts TEXT NOT NULL, actor TEXT NOT NULL,
        task_id TEXT, attempt_id TEXT, payload TEXT NOT NULL, artifact_ids TEXT NOT NULL, PRIMARY KEY (mission_id, seq)
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE tasks ADD COLUMN checkpoint TEXT;
      ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id);
      ALTER TABLE tasks ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE missions ADD COLUMN budget TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE missions ADD COLUMN integration_branch TEXT;
      ALTER TABLE missions ADD COLUMN integration_commit TEXT;
      ALTER TABLE missions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE findings (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), task_id TEXT NOT NULL REFERENCES tasks(id),
        file TEXT NOT NULL, line INTEGER, end_line INTEGER, severity TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
        observation TEXT NOT NULL, recommendation TEXT, evidence TEXT NOT NULL, reproduction_artifact_id TEXT, confidence REAL NOT NULL,
        status TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (mission_id, fingerprint)
      );
      CREATE INDEX findings_mission ON findings(mission_id);
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE missions ADD COLUMN target_environment TEXT;
      CREATE TABLE deployments (
        id TEXT PRIMARY KEY, mission_id TEXT REFERENCES missions(id), target TEXT NOT NULL, provider TEXT NOT NULL,
        revision TEXT NOT NULL, url TEXT, external_id TEXT, status TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
        release_dir TEXT, previous_id TEXT, detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX deployments_target ON deployments(target, created_at);
    `,
  },
  {
    version: 5,
    sql: `
      -- The gate verdict, so "unverified" is never displayed as plain "completed". Backfilled from the log.
      ALTER TABLE missions ADD COLUMN verdict TEXT;
      UPDATE missions SET verdict = (
        SELECT json_extract(e.payload, '$.verdict') FROM events e WHERE e.mission_id = missions.id AND e.type = 'gate.result' ORDER BY e.seq DESC LIMIT 1
      );
      -- Every process ATLAS starts is journaled until it exits, so a crashed daemon's orphans can be reaped.
      CREATE TABLE process_journal (
        pid INTEGER NOT NULL, identity TEXT NOT NULL, kind TEXT NOT NULL, command TEXT NOT NULL, started_at TEXT NOT NULL,
        PRIMARY KEY (pid, identity)
      );
    `,
  },
  {
    version: 6,
    sql: `
      -- A mission that fixes CI on an earlier mission's pull request (ADR 0015).
      ALTER TABLE missions ADD COLUMN follow_up TEXT;
    `,
  },
  {
    version: 7,
    sql: `
      -- The model chosen for a mission (provider/model, ADR 0017); NULL uses the Settings choice per role tier.
      ALTER TABLE missions ADD COLUMN model TEXT;
    `,
  },
  {
    version: 8,
    sql: `
      -- Who reported a finding (ADR 0023): an agent review, or ATLAS's own security scan.
      ALTER TABLE findings ADD COLUMN source TEXT NOT NULL DEFAULT 'review';
    `,
  },
  {
    version: 9,
    sql: `
      -- Event lookups by type, task and attempt run in SQL instead of reading a whole mission's log.
      CREATE INDEX events_type ON events(mission_id, type, seq);
      CREATE INDEX events_task ON events(mission_id, task_id, seq);
      CREATE INDEX events_attempt ON events(attempt_id, seq) WHERE attempt_id IS NOT NULL;
    `,
  },
];
