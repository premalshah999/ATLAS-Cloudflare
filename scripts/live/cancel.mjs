import { openAtlas } from './session.mjs';
const { app, invoke } = await openAtlas();
try {
  for (const id of process.argv.slice(2)) { await invoke('mission.cancel', { missionId: id }).catch((e) => console.log(id, e.message)); console.log('cancelled', id); }
} finally { await app.close(); }
