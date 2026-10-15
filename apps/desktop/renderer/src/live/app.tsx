// The live ATLAS application. The design-system prototype remains reachable as a labeled preview.
import React, { useEffect, useState } from 'react';
import { cx } from '../ui/primitives';
import { Toasts } from '../ui/overlays';
import { AtlasApp } from '../shell/app';
import { createStore } from '../lib/store';
import { connect, go, useLive } from './store';
import { LiveRail, LiveStatusBar, LiveTitleBar, PreviewBanner, openRepository } from './shell';
import { Projects } from './projects';
import { NewMission } from './newMission';
import { MissionView } from './mission';
import { Settings } from './settings';
import { TeamScreen } from './team';
import { bridge } from './api';
import { LivePalette, togglePalette } from './palette';
import { useAttentionTitle } from './attention';

function Keys() {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'k') { e.preventDefault(); togglePalette(); return; }
      if (k === 'o') { e.preventDefault(); void openRepository(); }
      else if (k === '1') { e.preventDefault(); go({ screen: 'projects' }); }
      else if (k === '2') { e.preventDefault(); go({ screen: 'team' }); }
      else if (k === 'n') { e.preventDefault(); go({ screen: 'new' }); }
      else if (k === ',') { e.preventDefault(); go({ screen: 'settings' }); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  return null;
}

export function LiveApp() {
  useEffect(() => { connect(); }, []);
  useAttentionTitle();
  const route = useLive((s) => s.route);
  const [preview] = useState(() => createStore({ screen: 'mission' }));
  if (!bridge) {
    return (
      <div className="at-root lv-nobridge">
        <h1 className="display">ATLAS runs as a desktop app</h1>
        <p className="at-muted">This page has no access to the ATLAS control plane. Start it with <code>pnpm dev</code>, or open the design preview.</p>
        <button type="button" className="at-btn" onClick={() => go({ screen: 'preview' })}>Open design preview</button>
        {route.screen === 'preview' && <div style={{ position: 'fixed', inset: 0 }}><AtlasApp store={preview} frame={false} /></div>}
      </div>
    );
  }
  if (route.screen === 'preview') {
    return (
      <div className="lv-preview">
        <PreviewBanner onExit={() => go({ screen: 'projects' })} />
        <div className="lv-preview-body"><AtlasApp store={preview} frame={false} /></div>
      </div>
    );
  }
  return (
    <div className={cx('at-root at-frame')} data-motion="full">
      <Keys />
      <div className="at-app lv-app">
        <LiveTitleBar />
        <LiveRail />
        <div className="at-body">
          <main className="at-canvas">
            {route.screen === 'projects' && <Projects />}
            {route.screen === 'new' && <NewMission key={route.item?.id ?? 'new'} workspaceId={route.workspaceId} item={route.item} />}
            {route.screen === 'team' && <TeamScreen workspaceId={route.workspaceId} />}
            {route.screen === 'mission' && <MissionView missionId={route.missionId} />}
            {route.screen === 'settings' && <Settings />}
          </main>
        </div>
        <LiveStatusBar />
      </div>
      <LivePalette />
      <Toasts />
    </div>
  );
}
