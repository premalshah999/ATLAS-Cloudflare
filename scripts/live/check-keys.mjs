import { openAtlas } from './session.mjs';
const { app, invoke } = await openAtlas();
try {
  const creds = await invoke('credentials.list');
  console.log('configured:', creds.providers.filter((p) => p.stored || p.fromEnvironment).map((p) => p.provider).join(', ') || 'none');
  console.log('deepseek test:', JSON.stringify(await invoke('credentials.test', { provider: 'deepseek' })));
  const models = await invoke('models.list');
  console.log('models:', models.map((m) => m.ref).join(', '));
  console.log('health:', JSON.stringify((await invoke('runtime.health')).map((h) => ({ runtime: h.runtime, ok: h.ok, detail: h.detail }))));
  const s = await invoke('settings.get');
  console.log('tiers:', s.values['models.default'], s.values['models.fast'], s.values['models.strong']);
} finally { await app.close(); }
