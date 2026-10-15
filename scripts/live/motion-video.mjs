// Motion-designed video from real app screenshots: kinetic titles, camera moves (zoom/pan to a focus point),
// animated callouts and transitions, timed to narration in a premium macOS voice. Recorded with Playwright.
// Usage: VOICE="Zoe (Premium)" ATLAS_FFMPEG=... node scripts/live/motion-video.mjs <scenes.json> <out-dir>
// scenes.json: [{ "image": "/abs/path.png" | null, "kicker": "…", "title": "…", "say": "narration",
//                 "focus": { "x": 0.5, "y": 0.4, "zoom": 1.35 }, "callouts": [{ "x": 0.2, "y": 0.3, "w": 0.3, "h": 0.2, "label": "…" }] }]
import { chromium } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';

const [scenesFile, outDir] = process.argv.slice(2);
const scenes = JSON.parse(readFileSync(scenesFile, 'utf8'));
mkdirSync(outDir, { recursive: true });
const ffmpeg = process.env.ATLAS_FFMPEG ?? 'ffmpeg';
const voice = process.env.VOICE ?? 'Samantha';
const W = 1920, H = 1080;

// 1. Narration per scene, measured.
const parts = scenes.map((s, i) => {
  const aiff = path.join(outDir, `v${i}.aiff`);
  writeFileSync(path.join(outDir, `v${i}.txt`), s.say);
  execFileSync('say', ['-v', voice, '-r', process.env.RATE ?? '172', '-f', path.join(outDir, `v${i}.txt`), '-o', aiff]);
  const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(spawnSync(ffmpeg, ['-i', aiff], { encoding: 'utf8' }).stderr);
  const secs = m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 6;
  return { aiff, dur: Math.max(4.5, secs + 0.9) };
});

// 2. The composition: one HTML page that plays every scene on a timeline.
const img = (p) => (p ? `data:image/png;base64,${readFileSync(p).toString('base64')}` : '');
const data = scenes.map((s, i) => ({ ...s, image: img(s.image), dur: parts[i].dur }));
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}html,body{width:${W}px;height:${H}px;background:#05060a;overflow:hidden;font-family:-apple-system,"SF Pro Display",Inter,system-ui,sans-serif;color:#eef1f7}
.bg{position:absolute;inset:0;background:radial-gradient(1200px 700px at 20% 10%,rgba(110,139,255,.18),transparent 60%),radial-gradient(900px 600px at 90% 90%,rgba(74,222,128,.08),transparent 60%),#05060a}
.grid{position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.06) 1px,transparent 1px);background-size:28px 28px;mask-image:radial-gradient(ellipse at center,black 40%,transparent 80%)}
.scene{position:absolute;inset:0;opacity:0;transition:opacity .7s cubic-bezier(.2,.7,.2,1)}
.scene.on{opacity:1}
.frame{position:absolute;left:50%;top:54%;width:1500px;height:937px;transform:translate(-50%,-50%) scale(.96);border-radius:18px;overflow:hidden;box-shadow:0 40px 120px rgba(0,0,0,.65),0 0 0 1px rgba(255,255,255,.08);transition:transform var(--d) cubic-bezier(.25,.1,.25,1)}
.frame img{width:100%;height:100%;object-fit:cover;transform-origin:var(--fx) var(--fy);transform:scale(1);transition:transform var(--d) cubic-bezier(.3,.05,.2,1)}
.scene.on .frame{transform:translate(-50%,-50%) scale(1)}
.scene.on .frame img{transform:scale(var(--z))}
.cap{position:absolute;left:96px;top:56px;max-width:1500px}
.kicker{font-size:18px;letter-spacing:.22em;text-transform:uppercase;color:#8ea3ff;opacity:0;transform:translateY(12px);transition:all .7s .2s cubic-bezier(.2,.7,.2,1)}
.title{font-size:44px;font-weight:650;letter-spacing:-.02em;margin-top:8px;opacity:0;transform:translateY(18px);transition:all .8s .35s cubic-bezier(.2,.7,.2,1)}
.scene.on .kicker,.scene.on .title{opacity:1;transform:none}
.hero .title{font-size:96px;margin-top:18px}.hero .cap{top:auto;bottom:200px}
.hero .kicker{font-size:22px}
.co{position:absolute;border:2px solid #6e8bff;border-radius:12px;box-shadow:0 0 0 6px rgba(110,139,255,.15),0 0 40px rgba(110,139,255,.35);opacity:0;transform:scale(1.06);transition:all .6s cubic-bezier(.2,.7,.2,1)}
.co span{position:absolute;left:0;top:-40px;white-space:nowrap;background:#6e8bff;color:#05060a;font-weight:650;font-size:17px;padding:6px 12px;border-radius:8px}
.scene.on .co{opacity:1;transform:none}
.bar{position:absolute;left:0;bottom:0;height:4px;background:linear-gradient(90deg,#6e8bff,#4ade80);width:0}
.brand{position:absolute;right:56px;bottom:36px;font-size:16px;letter-spacing:.3em;color:rgba(238,241,247,.45)}
</style></head><body><div class="bg"></div><div class="grid"></div><div id="stage"></div><div class="bar" id="bar"></div><div class="brand">ATLAS</div>
<script>
const S=${JSON.stringify(data)};const stage=document.getElementById('stage');
S.forEach((s,i)=>{const d=document.createElement('div');d.className='scene'+(s.image?'':' hero');d.id='s'+i;
const f=s.focus||{x:.5,y:.5,zoom:1.08};d.style.setProperty('--d',s.dur+'s');d.style.setProperty('--fx',(f.x*100)+'%');d.style.setProperty('--fy',(f.y*100)+'%');d.style.setProperty('--z',f.zoom||1.08);
d.innerHTML=(s.image?'<div class="frame"><img src="'+s.image+'">'+(s.callouts||[]).map((c,j)=>'<div class="co" style="left:'+c.x*100+'%;top:'+c.y*100+'%;width:'+c.w*100+'%;height:'+c.h*100+'%;transition-delay:'+(1.2+j*.9)+'s"><span>'+c.label+'</span></div>').join('')+'</div>':'')+'<div class="cap"><div class="kicker">'+(s.kicker||'')+'</div><div class="title">'+s.title+'</div></div>';stage.appendChild(d)});
const total=S.reduce((a,s)=>a+s.dur,0);window.__total=total;
window.play=()=>{let t=0;S.forEach((s,i)=>{setTimeout(()=>{document.querySelectorAll('.scene').forEach(e=>e.classList.remove('on'));document.getElementById('s'+i).classList.add('on')},t*1000);t+=s.dur});
const bar=document.getElementById('bar');bar.style.transition='width '+total+'s linear';requestAnimationFrame(()=>bar.style.width='100%')};
</script></body></html>`;
writeFileSync(path.join(outDir, 'composition.html'), html);

// 3. Record the composition in real time.
const total = parts.reduce((a, p) => a + p.dur, 0);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: outDir, size: { width: W, height: H } } });
const page = await ctx.newPage();
await page.goto('file://' + path.join(outDir, 'composition.html'));
await page.waitForTimeout(400);
await page.evaluate(() => window.play());
await page.waitForTimeout(total * 1000 + 1200);
await ctx.close(); await browser.close();
const webm = readdirSync(outDir).find((f) => f.endsWith('.webm'));
renameSync(path.join(outDir, webm), path.join(outDir, 'motion.webm'));

// 4. Narration track aligned to scene starts, then mux.
const list = path.join(outDir, 'audio.txt');
const padded = parts.map((p, i) => { const o = path.join(outDir, `a${i}.wav`); execFileSync(ffmpeg, ['-y', '-i', p.aiff, '-af', `apad=whole_dur=${p.dur}`, '-ar', '48000', '-ac', '2', o], { stdio: 'ignore' }); return `file '${o}'`; });
writeFileSync(list, padded.join('\n'));
const narration = path.join(outDir, 'narration.wav');
execFileSync(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', narration], { stdio: 'ignore' });
const final = path.join(outDir, 'ATLAS-demo.mp4');
execFileSync(ffmpeg, ['-y', '-ss', '0.45', '-i', path.join(outDir, 'motion.webm'), '-i', narration, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', final], { stdio: 'ignore' });
console.log(`Motion video: ${final} (${Math.round(total)}s)`);
