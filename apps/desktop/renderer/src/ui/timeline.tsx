import React, { useMemo, useState } from 'react';
import type { EventKind, TimelineEvent, Approval } from '../data/types';
import { agentById } from '../data/source';
import { cx, Icon, RoleMark, Button } from './primitives';
import { ICheck, IDecision, IFileCode, IXCircle, IShield, IArrowRight, ITube, IChevronRight, ICircle } from '../lib/icons';
import { actions, useApp } from '../lib/store';

export const kindMeta: Record<EventKind, { label: string; icon: React.ComponentType<any>; tone: string }> = {
  activity: { label: 'Activity', icon: ICircle, tone: 'muted' },
  decision: { label: 'Decision', icon: IDecision, tone: 'accent' },
  file: { label: 'File change', icon: IFileCode, tone: 'muted' },
  error: { label: 'Issue', icon: IXCircle, tone: 'danger' },
  approval: { label: 'Approval', icon: IShield, tone: 'warning' },
  milestone: { label: 'Verified', icon: ICheck, tone: 'success' },
  delegation: { label: 'Delegation', icon: IArrowRight, tone: 'muted' },
  test: { label: 'Test', icon: ITube, tone: 'muted' },
};

export type TLFilter = 'all' | 'decisions' | 'files' | 'issues' | 'approvals' | 'verified';
const filterKinds: Record<TLFilter, EventKind[] | null> = {
  all: null, decisions: ['decision', 'delegation'], files: ['file'], issues: ['error'], approvals: ['approval'], verified: ['milestone', 'test'],
};

export function countByFilter(events: TimelineEvent[]) {
  const c: Record<TLFilter, number> = { all: events.length, decisions: 0, files: 0, issues: 0, approvals: 0, verified: 0 };
  for (const e of events) for (const f of Object.keys(filterKinds) as TLFilter[]) if (f !== 'all' && filterKinds[f]!.includes(e.kind)) c[f]++;
  return c;
}

function EventRow({ e, isNew, pending }: { e: TimelineEvent; isNew?: boolean; pending?: Approval }) {
  const [open, setOpen] = useState(false);
  const a = agentById(e.agent);
  const m = kindMeta[e.kind];
  const resolved = useApp((s) => (pending ? s.resolved[pending.id] : undefined));
  const expandable = !!(e.children?.length);
  return (
    <div className={cx('at-ev', `at-ev--${e.kind}`, isNew && 'at-insert', isNew && e.kind === 'milestone' && 'at-flash-ok')} data-open={open}>
      <span className="at-ev-time at-mono at-tnum">{e.time}</span>
      <span className="at-ev-glyph"><Icon as={m.icon as any} size="sm" /></span>
      <div className="at-ev-main">
        <div className="at-ev-title">
          <button type="button" className="at-ev-agent" onClick={() => actions().selectAgent(e.agent)} title={`Inspect ${a.name}`}><RoleMark mark={a.mark} size="sm" /></button>
          <span className="at-ev-text">{e.title}</span>
          {e.meta && <span className="at-ev-meta at-mono">{e.meta}</span>}
          {expandable && (
            <button type="button" className="at-ev-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
              <Icon as={IChevronRight} size="sm" />{e.children!.length}
            </button>
          )}
        </div>
        {e.detail && <div className="at-ev-detail">{e.detail}</div>}
        {pending && !resolved && (
          <div className="at-row" style={{ marginTop: 8, gap: 6 }}>
            <Button size="sm" variant="primary" kbd="⌘ ↵" onClick={() => actions().set({ approvalDialog: pending.id })}>Review request</Button>
            <Button size="sm" variant="ghost" onClick={() => actions().resolve(pending.id, 'denied')}>Deny</Button>
          </div>
        )}
        {pending && resolved && <div className={cx('at-ev-resolved', resolved === 'approved' ? 'at-acc' : 'at-warn')}>{resolved === 'approved' ? 'Approved by you · once' : 'Denied by you'}</div>}
        {open && e.children && (
          <div className="at-ev-children">
            {e.children.map((c, i) => (
              <div key={i} className="at-ev-child"><span className="at-mono at-subtle at-tnum">{c.time}</span><span className="at-mono at-trunc">{c.text}</span>{c.meta && <span className="at-mono at-subtle">{c.meta}</span>}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Groups: consecutive low-signal events (activity/file/test) by the same agent fold into one row.
export function Timeline({ events, filter = 'all', newFrom = Infinity, agentFilter }: { events: TimelineEvent[]; filter?: TLFilter; newFrom?: number; agentFilter?: string }) {
  const pendingApprovals = useApp((s) => s.approvals);
  const list = useMemo(() => {
    const kinds = filterKinds[filter];
    return events.map((e, i) => ({ e, i })).filter(({ e }) => (!kinds || kinds.includes(e.kind)) && (!agentFilter || e.agent === agentFilter));
  }, [events, filter, agentFilter]);
  // Section headers by minute
  let lastMinute = '';
  return (
    <div className="at-tline-list" role="log" aria-live="polite">
      {list.map(({ e, i }) => {
        const minute = e.time.slice(0, 5);
        const head = minute !== lastMinute; lastMinute = minute;
        const pending = e.kind === 'approval' && e.meta === 'Waiting' ? pendingApprovals.find((p) => p.agent === e.agent) : undefined;
        return (
          <React.Fragment key={e.id}>
            {head && <div className="at-tl-minute"><span className="at-mono at-tnum">{minute}</span></div>}
            <EventRow e={e} isNew={i >= newFrom} pending={pending} />
          </React.Fragment>
        );
      })}
    </div>
  );
}
