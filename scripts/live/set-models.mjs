import { openAtlas } from './session.mjs';
const { app, invoke } = await openAtlas();
try {
  for (const m of await invoke('models.list')) console.log(m.ref, JSON.stringify({ cost: m.cost, ctx: m.contextWindow, reasoning: m.reasoning }));
  const [def, fast, strong] = process.argv.slice(2);
  if (def) {
    await invoke('settings.set', { key: 'models.default', value: def });
    await invoke('settings.set', { key: 'models.fast', value: fast });
    await invoke('settings.set', { key: 'models.strong', value: strong });
    const s = await invoke('settings.get');
    console.log('tiers set:', s.values['models.default'], s.values['models.fast'], s.values['models.strong']);
  }
} finally { await app.close(); }
