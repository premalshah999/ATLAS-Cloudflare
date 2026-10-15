import React, { useState } from 'react';
import { actions, adapter, slots, useApp } from '../lib/store';
import { pipeline, deployments, models, providers, agentById, activity, checkpoints, live, mission, agents, tasks, reviewFiles, findings, browserActions, timeline, terminals, roleDetails } from '../data/source';
import { cx, Icon, Button, IconButton, Badge, PanelHead, RoleMark, Seg, Toggle, Field, Input, Select, Check, Kbd, Status, SampleTag, EmptyState, Dot, Tip } from '../ui/primitives';
import { Pipeline, VerificationRow, StageGlyph } from '../ui/verify';
import { CodeBlock } from '../ui/code';
import {
  IDeploy, IRetry, IExternal, ICommit, ILock, IShield, ICheck, IWarn, IImage, IFileCode, IDownload, ICpu, IKey, IServer, IKeyboard, IPalette,
  IPlug, IFolder, IUser, IPlus, IReviews, IArrowRight, IHistory, IRecord, IPlay, IFilter, IXCircle, ICheckCircle, IEye,
} from '../lib/icons';

/* ---------- 10. Deployment verification studio ---------- */
export function Deploy() {
  const [stage, setStage] = useState('qa');
  const [authOpen, setAuthOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [ack, setAck] = useState({ warn: false, rollback: false });
  const [depSel, setDepSel] = useState(0);
  const A = actions();
  const st = pipeline.find((s) => s.id === stage) ?? pipeline[0];
  const dep = deployments[depSel];
  const by = (id: string) => pipeline.find((p) => p.id === id);
  const warn = pipeline.filter((p) => p.status === 'warning').length;
  const failedStages = pipeline.filter((p) => p.status === 'failed');
  const deployOk = by('deploy')?.status === 'passed';
  const answer = !live.on ? null : failedStages.length ? <><b>Not verified.</b> {failedStages.map((x) => x.name).join(', ')} failed. See each stage’s evidence.</>
    : deployOk ? <><b>Yes, on {dep?.env ?? mission.workspace}, for what was checked.</b> {by('api')?.summary} API checks and {by('qa')?.summary} browser checks passed against the served revision{warn ? `, with ${warn} warning${warn === 1 ? '' : 's'}` : ''}.</>
      : <><b>Verified locally, not deployed.</b> Checks ran on the integrated revision in the sandbox. {mission.status === 'running' ? 'The mission is still running.' : 'This mission has no staging deployment.'}</>;
  const Shot = slots.Shot;
  if (!st) return <div className="at-screen"><EmptyState center icon={IDeploy} title="No deployment pipeline" body="Open a mission with checks to see its verification pipeline." /></div>;
  const ready = typed === 'storefront-production' && ack.warn && ack.rollback;
  return (
    <div className="at-screen at-deploy">
      <aside className="at-deploy-list">
        <div className="at-phead"><span className="at-label">Deployments</span></div>
        <div className="at-pbody">
          {deployments.map((d, i) => (
            <button key={d.id} type="button" className="at-list-row" aria-selected={i === depSel} style={{ alignItems: 'flex-start' }} onClick={() => { setDepSel(i); if (live.on && d.missionId) A.set({ missionId: d.missionId }); }}>
              <Dot s={d.status.startsWith('verified') ? 'done' : d.status === 'live' ? 'running' : 'failed'} />
              <span className="at-col" style={{ gap: 2, minWidth: 0 }}>
                <span className="at-row" style={{ gap: 6 }}><span className="at-mono">{d.id}</span><Badge tone={d.env === 'production' ? 'accent' : 'outline'}>{d.env}</Badge></span>
                <span className="at-subtle" style={{ fontSize: 11.5 }}>{d.status} · {d.when}</span>
              </span>
            </button>
          ))}
          {live.on && !deployments.length && <div className="at-subtle" style={{ padding: 12, fontSize: 12 }}>No staging deployments yet. Missions with a staging target deploy after verification.</div>}
        </div>
      </aside>
      <div className="at-col at-grow">
        {live.on ? (
        <div className="at-deploy-head">
          <div className="at-col" style={{ gap: 6, minWidth: 0, flex: 1 }}>
            <div className="at-row" style={{ gap: 10 }}>
              <span className="at-mid">{dep?.id ?? mission.id}</span><span className="display" style={{ fontSize: 20 }}>{dep ? `${dep.env} · ` : ''}{mission.title}</span>
              {failedStages.length ? <Badge tone="danger">Failed</Badge> : deployOk ? <Badge tone="success" icon={ICheck}>Verified</Badge> : <Badge tone="outline">{mission.status}</Badge>}{warn > 0 && <Badge tone="warning" icon={IWarn}>{warn} warning{warn === 1 ? '' : 's'}</Badge>}
            </div>
            <div className="at-row at-home-meta">
              {dep?.commit && <span><Icon as={ICommit} size="sm" /><span className="at-mono">{dep.commit}</span></span>}
              {dep?.url && <span className="at-mono">{dep.url}</span>}
              <span>{dep?.mission ?? mission.id} · {dep?.when ?? mission.updated}</span>
            </div>
          </div>
        </div>
        ) : (
        <div className="at-deploy-head">
          <div className="at-col" style={{ gap: 6, minWidth: 0, flex: 1 }}>
            <div className="at-row" style={{ gap: 10 }}>
              <span className="at-mid">DEP-312</span><span className="display" style={{ fontSize: 20 }}>Staging · Stripe checkout</span>
              <Badge tone="success" icon={ICheck}>Verified</Badge><Badge tone="warning" icon={IWarn}>1 warning</Badge>
            </div>
            <div className="at-row at-home-meta">
              <span><Icon as={ICommit} size="sm" /><span className="at-mono">3d0b9f4e1c0a</span></span>
              <span><a className="at-link at-mono" href="#" onClick={(e) => e.preventDefault()}>https://storefront-staging.fly.dev</a></span>
              <span>MSN-0139 · DevOps Engineer · yesterday 17:42</span>
            </div>
          </div>
          <SampleTag />
        </div>
        )}
        <div className="at-deploy-pipe"><Pipeline stages={pipeline} selected={stage} onSelect={setStage} /></div>
        <div className="at-row at-grow" style={{ alignItems: 'stretch', gap: 0 }}>
          <div className="at-col at-grow at-stage">
            <div className="at-stage-head">
              <StageGlyph s={st.status} /><span className="heading">{st.name}</span>
              <span className="at-subtle">{st.summary}</span>
              <span style={{ flex: 1 }} />
              {st.duration && <span className="at-mono at-subtle">{st.duration}</span>}
              {st.status !== 'locked' && <Button size="sm" icon={IRetry} disabled={live.on && !adapter} onClick={() => { if (adapter) void adapter.reverify().catch((e: Error) => A.toast({ tone: 'danger', title: 'Could not re-run', body: e.message })); }}>{live.on ? 'Re-run verification' : 'Re-run stage'}</Button>}
            </div>
            <div className="at-pbody" style={{ padding: '0 20px 20px' }}>
              {live.on && st.id === 'approval' ? (
                <div className="at-gate">
                  <div className="at-row" style={{ gap: 10 }}><span className="at-apd-icon"><Icon as={ILock} /></span><div className="at-col"><span className="heading">{mission.status === 'done' ? 'Decision recorded' : 'Your decision'}</span><span className="at-subtle" style={{ fontSize: 12 }}>ATLAS never deploys to production. Accept to keep the integration branch for your release process, or reject to discard it.</span></div></div>
                  {mission.status === 'review' && adapter && <div className="at-row" style={{ gap: 8, marginTop: 14 }}><Button variant="ghost" onClick={() => void adapter!.decide('reject')}>Reject</Button><Button variant="primary" icon={ICheck} onClick={() => void adapter!.decide('accept')}>Accept change</Button></div>}
                </div>
              ) : st.status === 'locked' ? (
                <div className="at-gate">
                  <div className="at-row" style={{ gap: 10 }}><span className="at-apd-icon"><Icon as={ILock} /></span><div className="at-col"><span className="heading">Production promotion is gated</span><span className="at-subtle" style={{ fontSize: 12 }}>No agent can deploy to production. Only you can, here, with the evidence in front of you.</span></div></div>
                  {!authOpen ? <Button variant="primary" icon={IShield} style={{ marginTop: 14 }} onClick={() => setAuthOpen(true)}>Authorize production promotion…</Button> : (
                    <div className="at-col" style={{ gap: 10, marginTop: 16, maxWidth: 520 }}>
                      <label className="at-row" style={{ gap: 10, fontSize: 12.5 }}><Check on={ack.warn} onChange={(v) => setAck({ ...ack, warn: v })} label="ack warning" />I’ve seen the open warning: p95 on /api/checkout/session is 412 ms (budget 300 ms).</label>
                      <label className="at-row" style={{ gap: 10, fontSize: 12.5 }}><Check on={ack.rollback} onChange={(v) => setAck({ ...ack, rollback: v })} label="ack rollback" />Rollback target is v211 (88a0c4d); migration 0039 is backward compatible.</label>
                      <Field label={<>Type <span className="at-mono at-ink">storefront-production</span> to confirm</>}><Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="storefront-production" /></Field>
                      <div className="at-row" style={{ gap: 8 }}><Button variant="ghost" onClick={() => setAuthOpen(false)}>Cancel</Button><Button variant="primary" icon={IDeploy} disabled={!ready} onClick={() => A.toast({ tone: 'info', title: 'Promotion authorized', body: 'DevOps Engineer will promote v214 and run the same checks against production.' })}>Promote v214 to production</Button></div>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="at-label" style={{ margin: '4px 0 6px' }}>Evidence</div>
                  <div className="at-evid">{st.evidence.map((e, i) => <VerificationRow key={i} label={e.label} value={e.value} status={e.status} />)}</div>
                  {st.id === 'qa' && live.on && Shot && (
                    <div className="at-shots at-shots--lg">{browserActions.filter((b) => b.shot).slice(-4).map((b) => <div key={b.shot} className="at-shot"><Shot artifactId={b.shot!} alt={b.text} /><span className="at-mono at-trunc">{b.text.split(' — ')[0]}</span></div>)}</div>
                  )}
                  {st.id === 'qa' && !live.on && (
                    <div className="at-shots at-shots--lg">
                      {['checkout-4242', '3ds-challenge', 'declined-0002', 'order-confirmed'].map((s) => <div key={s} className="at-shot"><div className="at-shot-img"><Icon as={IImage} size="sm" /></div><span className="at-mono">{s}.png</span></div>)}
                    </div>
                  )}
                  <div className="at-label" style={{ margin: '16px 0 6px' }}>Log</div>
                  <CodeBlock compact lang="bash" code={st.logs.join('\n') || '—'} />
                  {st.artifacts.length > 0 && <><div className="at-label" style={{ margin: '16px 0 6px' }}>Artifacts</div><div className="at-row" style={{ gap: 6, flexWrap: 'wrap' }}>{st.artifacts.map((x) => <Badge key={x} tone="outline" icon={IFileCode}><span className="at-mono">{x}</span></Badge>)}</div></>}
                </>
              )}
            </div>
          </div>
          <aside className="at-report-side">
            <PanelHead label="Release report"><Button size="sm" variant="ghost" icon={IDownload} onClick={() => { if (adapter) void adapter.exportAudit().catch((e: Error) => A.toast({ tone: 'danger', title: 'Export failed', body: e.message })); }}>Export</Button></PanelHead>
            {live.on ? (
            <div className="at-pbody">
              <div className="at-answer"><div className="at-label" style={{ marginBottom: 6 }}>Is the deployed app actually working?</div><p>{answer}</p></div>
              <div style={{ padding: '0 14px' }}><dl className="at-kv" style={{ gridTemplateColumns: '84px 1fr' }}><dt>Environment</dt><dd>{dep?.env ?? 'sandbox (not deployed)'}</dd><dt>Commit</dt><dd className="at-mono">{dep?.commit || '—'}</dd><dt>URL</dt><dd className="at-mono">{dep?.url || '—'}</dd></dl></div>
              <div className="at-label" style={{ padding: '16px 14px 4px' }}>User flows</div>
              {(by('qa')?.evidence ?? []).map((e) => <VerificationRow key={e.label} label={e.label} value={e.value} status={e.status} />)}
              <div className="at-label" style={{ padding: '16px 14px 4px' }}>Runtime health</div>
              {(by('health')?.evidence ?? []).length ? by('health')!.evidence.map((e) => <VerificationRow key={e.label} label={e.label} value={e.value} status={e.status} />) : <div className="at-subtle" style={{ padding: '0 14px', fontSize: 12 }}>Measured on staging only.</div>}
              <div className="at-label" style={{ padding: '16px 14px 4px' }}>Not verified</div>
              <ul className="at-notverified">{pipeline.filter((p) => p.status === 'pending' || p.status === 'locked').map((p) => <li key={p.id}>{p.name} — {p.summary}</li>)}</ul>
            </div>
            ) : (
            <div className="at-pbody">
              <div className="at-answer">
                <div className="at-label" style={{ marginBottom: 6 }}>Is the deployed app actually working?</div>
                <p><b>Yes, on staging, for the flows tested.</b> 6 of 6 user flows and 18 of 18 API checks passed against the deployed URL, with 0 errors in 5 minutes of synthetic traffic. One latency warning stands.</p>
              </div>
              <div style={{ padding: '0 14px' }}>
                <dl className="at-kv" style={{ gridTemplateColumns: '84px 1fr' }}>
                  <dt>Environment</dt><dd>staging · fly.io iad · v214</dd>
                  <dt>Commit</dt><dd className="at-mono">3d0b9f4e1c0a</dd>
                  <dt>URL</dt><dd className="at-mono">storefront-staging.fly.dev</dd>
                </dl>
              </div>
              <div className="at-label" style={{ padding: '16px 14px 4px' }}>User flows</div>
              <VerificationRow label="Guest checkout · 4242" value="confirmed" status="passed" />
              <VerificationRow label="3-D Secure challenge" value="completed" status="passed" />
              <VerificationRow label="Declined card" value="no order" status="passed" />
              <VerificationRow label="Promo SAVE10" value="applied" status="passed" />
              <div className="at-label" style={{ padding: '16px 14px 4px' }}>Runtime health</div>
              <VerificationRow label="Error rate" value="0.00%" status="passed" />
              <VerificationRow label="p95 checkout session" value="412 ms" status="warning" />
              <div className="at-label" style={{ padding: '16px 14px 4px' }}>Not verified</div>
              <ul className="at-notverified">
                <li>Stripe live mode — staging uses test keys</li>
                <li>Webhook delivery under retry storms</li>
                <li>Production traffic patterns</li>
              </ul>
            </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

/* ---------- 12. Settings & model configuration ---------- */
const sections = [
  { id: 'models', label: 'Models & providers', icon: ICpu }, { id: 'perms', label: 'Permissions', icon: IShield }, { id: 'mcp', label: 'MCP & integrations', icon: IPlug },
  { id: 'keys', label: 'Keyboard', icon: IKeyboard }, { id: 'look', label: 'Appearance & motion', icon: IPalette }, { id: 'ws', label: 'Workspace', icon: IFolder }, { id: 'acct', label: 'Account', icon: IUser },
];
export function Settings() {
  const [sec, setSec] = useState('models');
  const [showEmpty, setShowEmpty] = useState(false);
  const motion = useApp((s) => s.motion);
  const A = actions();
  return (
    <div className="at-screen at-settings">
      <aside className="at-settings-nav">
        <div className="heading" style={{ padding: '18px 16px 12px' }}>Settings</div>
        {sections.map((s) => <button key={s.id} type="button" className="at-list-row" aria-selected={sec === s.id} onClick={() => setSec(s.id)}><Icon as={s.icon} className="at-subtle" /><span>{s.label}</span></button>)}
      </aside>
      <div className="at-pbody at-settings-body">
        {sec === 'models' && (
          <div className="at-settings-col">
            <div className="at-sh"><span className="heading">Providers</span><span style={{ flex: 1 }} />{live.on ? <button type="button" className="at-link" onClick={() => adapter?.openLive('settings')}>Add or test keys in full Settings</button> : <button type="button" className="at-link" onClick={() => setShowEmpty(!showEmpty)}>{showEmpty ? 'Show connected' : 'Preview: no models connected'}</button>}</div>
            {showEmpty ? (
              <div className="at-boxed"><EmptyState icon={ICpu} title="No models connected" body="Agents can’t start without a model. Connect a provider, or point Atlas at a local Ollama server — keys stay in your system keychain."><Button variant="primary" icon={IKey}>Add API key</Button><Button icon={IServer}>Use Ollama</Button></EmptyState></div>
            ) : (
              <div className="at-boxed">
                {providers.map((p) => (
                  <div key={p.id} className="at-prov">
                    <Dot s={p.status === 'connected' ? 'connected' : 'off'} />
                    <span className="at-col" style={{ gap: 1, flex: 1 }}><span style={{ fontWeight: 500 }}>{p.name}</span><span className="at-subtle" style={{ fontSize: 12 }}>{p.detail}</span></span>
                    {p.status === 'connected' ? <><Badge tone="success" icon={ICheck}>Connected</Badge><Button size="sm" variant="ghost" onClick={() => adapter?.openLive('settings')}>Manage</Button></> : <Button size="sm" icon={IPlus} onClick={() => adapter?.openLive('settings')}>Connect</Button>}
                  </div>
                ))}
              </div>
            )}
            <div className="at-sh" style={{ marginTop: 28 }}><span className="heading">Default model by role</span></div>
            <p className="at-settings-p">Agents use these unless their own config says otherwise. Changing a default doesn’t affect running missions.</p>
            <div className="at-boxed">
              {live.on ? (['strong', 'default', 'fast'] as const).map((tier) => {
                const roles = Object.values(roleDetails).filter((r) => r.tier === tier).map((r) => r.title);
                const cur = Object.values(roleDetails).find((r) => r.tier === tier)?.model ?? models[0]?.id ?? '';
                return <div key={tier} className="at-prov"><span style={{ width: 160 }}>{tier} tier<br /><span className="at-subtle" style={{ fontSize: 11 }}>{roles.join(', ') || '—'}</span></span><div style={{ width: 260 }}><Select value={cur} onChange={(v) => { if (adapter) void adapter.setTier(tier, v).then(() => A.toast({ tone: 'info', title: `${tier} tier → ${v}` })).catch((e: Error) => A.toast({ tone: 'danger', title: 'Not saved', body: e.message })); }} options={models.map((x) => ({ id: x.id, label: x.name, hint: x.ctx }))} /></div><span style={{ flex: 1 }} /><span className="at-subtle" style={{ fontSize: 12 }}>{models.find((x) => x.id === cur)?.provider ?? ''}</span></div>;
              }) : [['Orchestrator', 'opus'], ['Engineers', 'sonnet'], ['Security review', 'opus'], ['QA & browser', 'sonnet'], ['Deploy & summaries', 'haiku']].map(([r, m]) => (
                <div key={r} className="at-prov"><span style={{ width: 160 }}>{r}</span><div style={{ width: 260 }}><Select value={m} onChange={() => {}} options={models.map((x) => ({ id: x.id, label: x.name, hint: x.ctx }))} /></div><span style={{ flex: 1 }} /><span className="at-subtle" style={{ fontSize: 12 }}>{models.find((x) => x.id === m)?.provider}</span></div>
              ))}
            </div>
            <div className="at-sh" style={{ marginTop: 28 }}><span className="heading">{live.on ? 'Mission budget' : 'Spending'}</span></div>
            {live.on ? <p className="at-settings-p">Each mission has a token budget (2M by default), a task cap and per-role tool-call and time limits; ATLAS stops and asks when one is reached. Provider balances are checked live in Settings → Test.</p> :
            <div className="at-sform-grid at-sform-grid--3" style={{ maxWidth: 640 }}>
              <Field label="Per-mission default" help="Atlas pauses and asks at the limit."><Input defaultValue="$12.00" /></Field>
              <Field label="Daily cap"><Input defaultValue="$60.00" /></Field>
              <Field label="Warn at"><Input defaultValue="80%" /></Field>
            </div>}
          </div>
        )}
        {sec === 'look' && (
          <div className="at-settings-col">
            <div className="at-sh"><span className="heading">Appearance & motion</span></div>
            <div className="at-boxed">
              <div className="at-prov"><span className="at-col" style={{ flex: 1 }}><span style={{ fontWeight: 500 }}>Reduce motion</span><span className="at-subtle" style={{ fontSize: 12 }}>Stops graph-edge flow, activity bars and overlay springs. Follows the system setting by default.</span></span><Toggle on={motion === 'reduced'} onChange={(v) => A.set({ motion: v ? 'reduced' : 'full' })} label="Reduce motion" /></div>
              <div className="at-prov"><span className="at-col" style={{ flex: 1 }}><span style={{ fontWeight: 500 }}>Interface density</span><span className="at-subtle" style={{ fontSize: 12 }}>Compact fits 2 more timeline rows at 900 px tall.</span></span><Seg value="default" onChange={() => {}} items={[{ id: 'compact', label: 'Compact' }, { id: 'default', label: 'Default' }]} /></div>
              <div className="at-prov"><span className="at-col" style={{ flex: 1 }}><span style={{ fontWeight: 500 }}>Terminal font size</span></span><Select value="12" onChange={() => {}} width={120} options={[{ id: '11', label: '11 px' }, { id: '12', label: '12 px' }, { id: '13', label: '13 px' }]} /></div>
            </div>
          </div>
        )}
        {sec === 'keys' && (
          <div className="at-settings-col">
            <div className="at-sh"><span className="heading">Keyboard</span></div>
            <div className="at-boxed">
              {[['Command palette', '⌘ K'], ['New mission', '⌘ N'], ['Home / Missions / Agents / Reviews / Deployments', '⌘ 1 – 5'], ['Toggle sidebar', '⌘ \\'], ['Toggle inspector', '⌘ ⌥ I'], ['Agent activity drawer', '⌘ J'], ['Approve focused request', '⌘ ↵'], ['Pause all agents', '⌘ ⇧ .'], ['Terminal', '⌃ `'], ['Find in terminal', '⌘ F'], ['Next / previous file in review', 'J / K']].map(([l, k]) => <div key={l} className="at-prov"><span style={{ flex: 1 }}>{l}</span><Kbd k={k} /></div>)}
            </div>
          </div>
        )}
        {sec === 'perms' && (
          <div className="at-settings-col">
            <div className="at-sh"><span className="heading">Workspace permissions</span><Badge tone="accent">Balanced</Badge></div>
            <p className="at-settings-p">{live.on ? 'Enforced by policy before every tool call (ATLAS default: ask for risky actions). Per-mission approval mode narrows these.' : 'Defaults for every agent in acme/storefront. An agent’s own config can only narrow these.'}</p>
            <div className="at-boxed">
              {[['Edit files in worktrees', 'allow'], ['Edit files outside worktrees', 'deny'], ['Run tests, linters, type-check', 'allow'], ['Other shell commands', 'ask'], ['Database schema changes', 'ask'], ['Network outside localhost', 'ask'], ['Sensitive paths (.env*, ~/.ssh, ~/.aws)', 'deny'], ['Deploy to staging', 'ask'], ['Deploy to production', 'deny'], ['Control your desktop', 'ask']].map(([s, l]) => (
                <div key={s} className="at-prov"><span style={{ flex: 1 }}>{s}</span><Seg value={l} onChange={() => {}} items={[{ id: 'allow', label: 'Allow' }, { id: 'ask', label: 'Ask' }, { id: 'deny', label: 'Deny' }]} /></div>
              ))}
            </div>
          </div>
        )}
        {(sec === 'mcp' || sec === 'ws' || sec === 'acct') && (
          <div className="at-settings-col">
            <div className="at-sh"><span className="heading">{sections.find((s) => s.id === sec)!.label}</span></div>
            {sec === 'mcp' ? (
              <div className="at-boxed">
                {live.on ? <>{providers.filter((p) => p.id === 'github').map((p) => <div key={p.id} className="at-prov"><Dot s="connected" /><span className="at-mono" style={{ width: 80 }}>github</span><span className="at-subtle" style={{ flex: 1 }}>Pull requests and CI · {p.detail}</span></div>)}<div className="at-prov"><Icon as={IPlug} size="sm" className="at-subtle" /><span className="at-subtle" style={{ flex: 1 }}>MCP servers, skills and sync are managed in full Settings.</span><Button size="sm" onClick={() => adapter?.openLive('settings')}>Open</Button></div></>
                : [['linear', 'Read issues, comment', 'connected'], ['github', 'PRs, checks, reviews', 'connected'], ['sentry', 'Read errors for staging', 'connected'], ['figma', 'Not configured', 'off']].map(([n, d, s]) => <div key={n} className="at-prov"><Dot s={s === 'connected' ? 'connected' : 'off'} /><span className="at-mono" style={{ width: 80 }}>{n}</span><span className="at-subtle" style={{ flex: 1 }}>{d}</span>{s === 'connected' ? <Button size="sm" variant="ghost">Scopes</Button> : <Button size="sm" icon={IPlus}>Add</Button>}</div>)}
              </div>
            ) : <div className="at-boxed"><div className="at-prov"><span className="at-subtle" style={{ flex: 1 }}>{live.on ? 'Workspaces, team spaces, Cloudflare and GitHub are configured in full Settings.' : 'Workspace and account settings follow the same row pattern.'}</span>{live.on && <Button size="sm" onClick={() => adapter?.openLive(sec === 'acct' ? 'team' : 'settings')}>Open</Button>}</div></div>}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Mission completion report ---------- */
export function Report() { return live.on ? <LiveReport /> : <SampleReport />; }

function LiveReport() {
  const A = actions();
  const add = reviewFiles.reduce((x, f) => x + f.add, 0), del = reviewFiles.reduce((x, f) => x + f.del, 0);
  const failed = pipeline.filter((p) => p.status === 'failed');
  const decisions = timeline.filter((e) => e.kind === 'decision' || e.kind === 'milestone').slice(-6);
  const summaries = agents.filter((a) => a.id !== 'orch' && a.status === 'done').map((a) => ({ a, text: a.activity })).filter((x) => x.text);
  return (
    <div className="at-screen">
      <div className="at-pbody">
        <article className="at-report">
          <div className="at-row" style={{ gap: 8 }}><span className="at-mid">{mission.id}</span>{failed.length ? <Badge tone="danger">Failed verification</Badge> : mission.status === 'review' || mission.status === 'done' ? <Badge tone="success" icon={ICheck}>Verified</Badge> : <Badge tone="outline">{mission.status}</Badge>}<span style={{ flex: 1 }} /><Button size="sm" variant="ghost" icon={IDownload} onClick={() => void adapter?.exportAudit()}>Export audit log</Button><Button size="sm" icon={IReviews} onClick={() => A.go('review')}>Open review</Button><Button size="sm" variant="primary" icon={IDeploy} onClick={() => A.go('deploy')}>Deployment…</Button></div>
          <h1 className="display" style={{ margin: '18px 0 8px', fontSize: 26, lineHeight: '32px' }}>{mission.title}</h1>
          <p className="at-report-lede">{mission.objective}</p>
          <div className="at-report-facts">
            <div><span className="at-label">Duration</span><b>{mission.elapsed}</b></div><div><span className="at-label">Tasks</span><b>{mission.tasksDone} / {mission.tasksTotal}</b></div><div><span className="at-label">Changed</span><b>{reviewFiles.length} files</b><span className="at-fact-delta"><span className="at-ok">+{add}</span><span className="at-err">−{del}</span></span></div><div><span className="at-label">Tokens</span><b>{mission.tokens}</b><span className="at-subtle">{mission.compute}</span></div>
          </div>
          <h3 className="at-report-h">Evidence</h3>
          <div className="at-boxed">{pipeline.filter((p) => p.id !== 'approval').map((p) => <VerificationRow key={p.id} label={p.name} value={p.summary} status={p.status === 'locked' ? 'pending' : p.status} />)}<VerificationRow label="Review" value={`${findings.filter((f) => f.status === 'open').length} open · ${findings.filter((f) => f.status === 'fixed').length} fixed`} status={findings.some((f) => f.status === 'open' && f.severity === 'high') ? 'warning' : 'passed'} /></div>
          <h3 className="at-report-h">Decisions and summaries</h3>
          <ol className="at-report-list">
            {decisions.map((d) => <li key={d.id}><b>{d.title}</b>{d.detail ? <> {d.detail}</> : null} <span className="at-subtle">— {agentById(d.agent).name}, {d.time}</span></li>)}
            {summaries.map(({ a, text }) => <li key={a.id}><b>{a.assignment}.</b> {text} <span className="at-subtle">— {a.name}</span></li>)}
          </ol>
          <h3 className="at-report-h">Not verified</h3>
          <ul className="at-report-list at-notverified">{pipeline.filter((p) => p.status === 'pending' || p.status === 'locked').map((p) => <li key={p.id}>{p.name}: {p.summary}</li>)}</ul>
          <h3 className="at-report-h">Team</h3>
          <table className="at-table">
            <thead><tr><th>Agent</th><th>Tasks</th><th>Time</th><th style={{ textAlign: 'right' }}>Tokens</th></tr></thead>
            <tbody>{agents.filter((a) => a.id !== 'orch').map((a) => <tr key={a.id}><td><span className="at-row"><RoleMark mark={a.mark} size="sm" />{a.name} <span className="at-mono at-subtle">{a.id}</span></span></td><td className="at-mono">{tasks.filter((t) => t.agent === a.id).length}</td><td className="at-mono at-muted">{a.elapsed}</td><td className="at-mono at-muted" style={{ textAlign: 'right' }}>{a.tokens.toLocaleString()}</td></tr>)}</tbody>
          </table>
        </article>
      </div>
    </div>
  );
}

function SampleReport() {
  const A = actions();
  return (
    <div className="at-screen">
      <div className="at-pbody">
        <article className="at-report">
          <div className="at-row" style={{ gap: 8 }}><span className="at-mid">MSN-0139</span><Badge tone="success" icon={ICheck}>Verified on staging</Badge><Badge tone="warning" icon={IWarn}>1 warning</Badge><span style={{ flex: 1 }} /><Button size="sm" variant="ghost" icon={IDownload}>Export</Button><Button size="sm" icon={IReviews} onClick={() => A.go('review')}>Open PR #482</Button><Button size="sm" variant="primary" icon={IDeploy} onClick={() => A.go('deploy')}>Promotion…</Button></div>
          <h1 className="display" style={{ margin: '18px 0 8px', fontSize: 26, lineHeight: '32px' }}>Implement Stripe checkout</h1>
          <p className="at-report-lede">Card checkout with 3-D Secure and idempotent webhooks is implemented, tested and running on staging. Five agents worked 1 h 12 m across 16 tasks. Production promotion is waiting for you.</p>
          <div className="at-report-facts">
            <div><span className="at-label">Duration</span><b>1h 12m</b></div><div><span className="at-label">Tasks</span><b>16 / 16</b></div><div><span className="at-label">Changed</span><b>23 files</b><span className="at-fact-delta"><span className="at-ok">+1,284</span><span className="at-err">−212</span></span></div><div><span className="at-label">Spend</span><b>$8.91</b><span className="at-subtle">3.84M tokens</span></div>
          </div>
          <h3 className="at-report-h">Evidence</h3>
          <div className="at-boxed">
            <VerificationRow label="Unit & integration tests" value="412 passed · 0 failed" status="passed" />
            <VerificationRow label="API contract checks on staging" value="18 / 18" status="passed" />
            <VerificationRow label="Browser QA on staging" value="6 / 6 flows · 23 screenshots" status="passed" />
            <VerificationRow label="Security review" value="0 open · 2 fixed" status="passed" />
            <VerificationRow label="Runtime health · 5 min" value="p95 412 ms > 300 ms budget" status="warning" />
          </div>
          <h3 className="at-report-h">Decisions</h3>
          <ol className="at-report-list">
            <li><b>Stripe Checkout Sessions over Payment Element.</b> Fewer PCI surfaces; hosted 3-D Secure. Rejected: custom card form. <span className="at-subtle">— Atlas Orchestrator, T1</span></li>
            <li><b>Webhook idempotency by event id in Postgres.</b> Survives redeploys; Redis was not durable across machines. <span className="at-subtle">— Backend Engineer, T6</span></li>
            <li><b>Order created on <span className="at-mono">checkout.session.completed</span>, not on redirect.</b> Redirects can be lost. <span className="at-subtle">— Security Engineer review</span></li>
          </ol>
          <h3 className="at-report-h">Not verified</h3>
          <ul className="at-report-list at-notverified"><li>Stripe live mode (staging uses test keys)</li><li>Webhook behaviour under Stripe retry storms</li><li>Tax calculation for non-US addresses (out of scope)</li></ul>
          <h3 className="at-report-h">Team</h3>
          <table className="at-table">
            <thead><tr><th>Agent</th><th>Tasks</th><th>Time</th><th style={{ textAlign: 'right' }}>Tokens</th></tr></thead>
            <tbody>{[['orch', 2, '1h 12m', '612k'], ['be', 6, '41m', '1.48M'], ['fe', 4, '29m', '930k'], ['qa', 3, '18m', '544k'], ['ops', 1, '11m', '268k']].map(([id, t, d, k]) => { const a = agentById(id as string); return <tr key={id as string}><td><span className="at-row"><RoleMark mark={a.mark} size="sm" />{a.name}</span></td><td className="at-mono">{t}</td><td className="at-mono at-muted">{d}</td><td className="at-mono at-muted" style={{ textAlign: 'right' }}>{k}</td></tr>; })}</tbody>
          </table>
        </article>
      </div>
    </div>
  );
}

/* ---------- Activity ---------- */
export function ActivityScreen() {
  const [f, setF] = useState('all');
  const [q, setQ] = useState('');
  const A = actions();
  return (
    <div className="at-screen">
      <div className="at-pagehead"><span className="heading">Activity</span><Seg value={f} onChange={setF} items={[{ id: 'all', label: 'All' }, { id: 'you', label: 'Your actions' }, { id: 'issues', label: 'Issues' }, { id: 'rec', label: 'Recordings' }]} /><span style={{ flex: 1 }} /><Input icon={IFilter} placeholder="Filter by agent, file, mission" style={{ width: 280 }} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="at-pbody" style={{ padding: '0 20px' }}>
        {f === 'rec' ? (
          live.on ? <div className="at-boxed">{terminals.filter((t) => t.status !== 'running').map((t) => <div key={t.id} className="at-prov"><Icon as={IRecord} size="sm" className={t.status === 'failed' ? 'at-err' : 'at-subtle'} /><span style={{ flex: 1 }}>{t.title} · {agentById(t.agent ?? 'orch').name} · {t.duration} · exit {t.exit ?? '—'}</span><Button size="sm" variant="ghost" icon={IPlay} onClick={() => A.go('terminal')}>Replay</Button></div>)}{!terminals.length && <div className="at-prov"><span className="at-subtle">No recordings yet.</span></div>}</div> :
          <div className="at-boxed">{['playwright · auth · QA Engineer · 38s', 'semgrep · Security Engineer · 6s', 'vitest · auth · Backend Engineer · 4s', 'browser · logout flow · QA Engineer · 14s'].map((r) => <div key={r} className="at-prov"><Icon as={IRecord} size="sm" className="at-err" /><span style={{ flex: 1 }}>{r}</span><Button size="sm" variant="ghost" icon={IPlay}>Replay</Button></div>)}</div>
        ) : (
          <div className="at-feed">{activity.filter((a) => f === 'all' || (f === 'you' ? a.kind === 'human' : a.kind === 'error' || a.kind === 'warn')).filter((a) => !q || `${a.who} ${a.text} ${a.mission}`.toLowerCase().includes(q.toLowerCase())).map((a, i) => (
            <div key={i} className="at-feed-row" style={{ height: 40 }}><span className="at-mono at-subtle" style={{ width: 44 }}>{a.time}</span><Dot s={a.kind === 'error' ? 'failed' : a.kind === 'warn' ? 'warning' : a.kind === 'ok' ? 'done' : 'human'} /><span className={cx(a.kind === 'human' && 'at-human-c')} style={{ fontWeight: 500, width: 150 }}>{a.who}</span><span className="at-muted at-trunc">{a.text}</span><span className="at-mono at-subtle" style={{ marginLeft: 'auto' }}>{a.mission}</span></div>
          ))}</div>
        )}
      </div>
    </div>
  );
}

export { checkpoints, IHistory, IArrowRight, IExternal, IXCircle, ICheckCircle, IEye, Tip, Status, IconButton };
