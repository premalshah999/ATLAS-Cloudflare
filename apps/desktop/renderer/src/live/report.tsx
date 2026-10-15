// Mission report (the design preview's Report screen, live): one page that states what was asked, what ran, what
// was independently checked and what the operator decided. Every value comes from the mission snapshot and log.
import React from 'react';
import type { AtlasEvent } from '@atlas/contracts';
import { Badge, Button, KV, Status } from '../ui/primitives';
import { IDisk } from '../lib/icons';
import { call, type MissionSnapshot } from './api';
import { fmtMs, missionStatus, resultWord, roleName, runtimeName } from './format';
import { toast } from './toast';

const RESULT_DOT: Record<string, string> = { pass: 'done', fail: 'failed', skipped: 'idle', inconclusive: 'warning', not_configured: 'idle' };

export function ReportPanel({ snap, events }: { snap: MissionSnapshot; events: AtlasEvent[] }) {
  const m = snap.mission;
  const st = missionStatus(m);
  const done = snap.tasks.filter((t) => t.state === 'done').length;
  const open = snap.findings.filter((f) => f.status === 'open');
  const fixed = snap.findings.filter((f) => f.status === 'fixed').length;
  const required = snap.checks.filter((c) => c.required);
  const passed = required.filter((c) => c.result === 'pass').length;
  const published = [...events].reverse().find((e) => e.type === 'operator.action' && (e.payload as { action?: string }).action === 'cloudflare.published');
  const pub = published?.payload as { name?: string; remote?: string; refs?: unknown[]; checkedAt?: string } | undefined;
  const decision = [...events].reverse().find((e) => e.type === 'mission.decision');
  const roles = [...new Set(snap.tasks.map((t) => t.role))];
  const exportLog = async () => {
    try { const r = await call('mission.export', { missionId: m.id }); if (r) toast({ tone: 'info', title: 'Audit log exported', body: `${r.records} records · SHA-256 ${r.sha256.slice(0, 16)}… → ${r.path}` }); }
    catch (e) { toast({ tone: 'danger', title: 'Export failed', body: (e as Error).message }); }
  };
  return (
    <div className="lv-scroll" style={{ padding: 24 }} data-testid="report-panel">
      <div className="at-row" style={{ gap: 8 }}>
        <span className="at-label">Mission report</span><span style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" icon={IDisk} onClick={() => void exportLog()}>Export signed audit log</Button>
      </div>
      <h1 className="display" style={{ margin: '12px 0 4px', fontSize: 26, lineHeight: '32px' }}>{m.title}</h1>
      <p className="at-muted" style={{ marginTop: 0 }}>{m.goal}</p>
      <div className="lv-home-stats">
        {[['Result', <Status key="s" s={st.dot} label={st.word} />], ['Duration', fmtMs(snap.budget.elapsedMs)], ['Tasks', `${done} / ${snap.tasks.length}`], ['Required checks', `${passed} / ${required.length}`], ['Tool calls', snap.budget.toolCalls.toLocaleString()], ['Tokens', snap.budget.tokens.toLocaleString()]].map(([k, v]) => (
          <div key={k as string} className="lv-card lv-home-stat"><span className="at-label">{k}</span><b>{v}</b></div>
        ))}
      </div>

      <section className="lv-section" data-testid="report-checks">
        <span className="at-label">Independent verification</span>
        {snap.checks.length ? snap.checks.map((c) => (
          <div key={c.id} className="lv-line">
            <Status s={RESULT_DOT[c.result] ?? 'idle'} label={resultWord(c.result)} />
            <span style={{ flex: 1 }}>{c.name}{c.required ? '' : <span className="at-subtle"> · optional</span>}</span>
            <span className="at-mono at-subtle lv-small">{c.command ?? ''}</span>
            <span className="at-mono at-subtle lv-small">{c.durationMs != null ? fmtMs(c.durationMs) : ''}</span>
          </div>
        )) : <p className="at-subtle lv-small">No checks have run. An agent's claim of success is never counted as evidence.</p>}
      </section>

      <section className="lv-section" data-testid="report-review">
        <span className="at-label">Review</span>
        <p className="lv-small">{open.length ? `${open.length} open finding${open.length === 1 ? '' : 's'}` : 'No open findings'}{fixed ? ` · ${fixed} fixed` : ''}</p>
        {open.slice(0, 8).map((f) => <div key={f.id} className="lv-line"><Badge tone={f.severity === 'high' ? 'danger' : f.severity === 'medium' ? 'warning' : 'outline'}>{f.severity}</Badge><span style={{ flex: 1 }}>{f.title}</span><span className="at-mono at-subtle lv-small">{f.file}{f.line ? `:${f.line}` : ''}</span></div>)}
      </section>

      <section className="lv-section">
        <span className="at-label">Provenance</span>
        <KV col={150} rows={[
          ['Base commit', <span key="b" className="at-mono">{m.baseCommit?.slice(0, 12) ?? '—'}</span>],
          ['Integrated result', <span key="i" className="at-mono">{m.integrationBranch ? `${m.integrationBranch} @ ${m.integrationCommit?.slice(0, 12)}` : '—'}</span>],
          ['Agents', roles.length ? roles.map(roleName).join(', ') : '—'],
          ['Runtime', `${runtimeName(m.runtime)}${m.model ? ` · ${m.model}` : ''}`],
          ['Staging', m.targetEnvironment ?? 'Not deployed'],
          ['Cloudflare Artifacts', pub ? <span key="c">{pub.name} · {pub.refs?.length ?? 0} refs verified{pub.checkedAt ? ` ${new Date(pub.checkedAt).toLocaleString()}` : ''}</span> : 'Not published'],
          ['Decision', m.decision ? `${m.decision === 'accepted' ? 'Accepted' : 'Rejected'}${decision ? ` ${new Date(decision.ts).toLocaleString()}` : ''}` : 'Awaiting your decision'],
          ['Outcome', m.outcome ?? '—'],
        ]} />
      </section>
    </div>
  );
}
