// Save the Worker URL and connection token in the operator profile (token read from the environment; never printed).
import { openAtlas } from './session.mjs';
const { app, invoke } = await openAtlas();
try {
  await invoke('settings.set', { key: 'cloud.url', value: process.env.ATLAS_CLOUD_URL });
  await invoke('deploy.secrets.set', { target: 'cloudflare', name: 'ATLAS_CLOUD_TOKEN', value: process.env.ATLAS_CLOUD_TOKEN });
  console.log('cloud.url =', (await invoke('settings.get')).values['cloud.url']);
} finally { await app.close(); }
