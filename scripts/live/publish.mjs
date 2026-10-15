// Publish a completed mission to Cloudflare Artifacts through the app (cloud.publish), operator profile.
import { openAtlas } from './session.mjs';
const [missionId] = process.argv.slice(2);
const { app, invoke } = await openAtlas();
try {
  const s = await invoke('settings.get');
  console.log('worker:', s.values['cloud.url'] || '(not configured)');
  const r = await invoke('cloud.publish', { missionId });
  console.log(JSON.stringify({ name: r.name, remote: r.remote, verified: r.verified, refs: r.refs.map((x) => `${x.ref} ${x.matches ? 'matches' : 'MISMATCH'}`) }, null, 2));
} catch (e) { console.log('publish failed:', e.message); } finally { await app.close(); }
