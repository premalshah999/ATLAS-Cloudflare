// Real provider mission, using keys already encrypted in this ATLAS profile.
import { _electron as electron, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const profile=path.join(os.homedir(),'Library/Application Support/ATLAS-Afterlight');
const out=path.join(os.homedir(),'Desktop/ATLAS-Submission/afterlight',`live-${Date.now()}`);mkdirSync(out,{recursive:true});
const env={...process.env,ATLAS_E2E:'1',ATLAS_USER_DATA:profile,ATLAS_E2E_OPEN_DIR:path.join(os.homedir(),'Desktop/Afterlight'),ATLAS_E2E_SAVE_PATH:path.join(out,'live-mission.atlas.jsonl')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.join(root,'apps/desktop/release/mac/ATLAS.app/Contents/MacOS/ATLAS'),env,recordVideo:{dir:path.join(out,'raw'),size:{width:1440,height:900}}});
const page=await app.firstWindow();
const call=(method,params={})=>page.evaluate(({method,params})=>window.atlas.invoke(method,params),{method,params});
const goal=`Add a production-useful Markdown launch brief export to Afterlight. Use two parallel coder tasks with disjoint declared files, then a dependent reviewer. Task 1 implements public/brief.js, updates public/app.js to import it and adds an Export brief button beside Export record, and updates server.js's static asset allowlist for /brief.js. Task 2 writes test/brief.test.js independently against the exact module contract below. Reviewer depends on BOTH and runs tests on their integrated result. Do not run incomplete cross-task tests as proof before integration.

Module contract: public/brief.js exports function launchBrief(release), returning deterministic Markdown text. For a release with title, owner, date, status, checks and optional shippedAt: include a level-1 heading containing its title; owner, target date and status; one checklist row per check using [x] only for status=done and [ ] otherwise; check title, owner (or Unassigned), and team; evidence URLs when supplied; optional notes; a final decision section distinguishing active from shipped. Shipped exports include shippedAt and state that the snapshot is locked. A minimal valid input is {title:'Pilot',owner:'Premal',date:'2026-10-20',status:'active',checks:[]}. Reject a missing/invalid release object with a useful Error.

Security: escape user Markdown/HTML metacharacters and neutralize embedded newlines in user fields so titles or notes cannot inject HTML, headings or additional checklist items. Never produce active javascript:, data:, file: or credential-bearing URLs. Only include HTTP/HTTPS evidence links; preserve their destination safely even if it contains parentheses. Do not fetch evidence. Export brief downloads a .md file for active and shipped releases. Keep existing JSON export and all release rules intact. Add focused positive, negative and shipped-snapshot tests. No dependencies, no network commands, no changes to atlas.config.json or deployment credentials. Read README.md, public/app.js, server.js and src/domain.js as needed. Existing checks must pass. Use write_file and governed tools, not direct Git writes.`;
try{
 await expect(page.getByTestId('daemon-status')).toHaveAttribute('data-state','ready',{timeout:30000});
 const health=await call('runtime.health');const pi=health.find(h=>h.runtime==='pi');console.log('RUNTIME_HEALTH='+JSON.stringify(pi));
 if(!pi?.ok)throw new Error('Live model not available');
 const model=pi.models.includes('deepseek/deepseek-chat')?'deepseek/deepseek-chat':pi.models[0];
 await call('settings.set',{key:'runtime.model',value:model});
 const workspace=await call('workspace.open');
 const mission=await call('mission.create',{workspaceId:workspace.id,title:'Afterlight — live agents add launch briefs '+Date.now(),goal,constraints:'Keep tasks bounded and files disjoint. Tests must import launchBrief from ../public/brief.js. Two coder tasks in parallel; reviewer depends on both. No credentials, external networking, or unrelated refactors.',runtime:'pi',approvalMode:'ask_risky',targetEnvironment:'afterlight-staging',budget:{maxConcurrentAgents:2,maxTasks:4,maxDelegationDepth:0,maxTokens:600000,maxWallClockMinutes:25}});
 console.log('MISSION_ID='+mission.id+' OUTPUT='+out);writeFileSync(path.join(out,'mission-id.txt'),mission.id);writeFileSync(path.join(out,'objective.txt'),goal);
 await call('mission.plan',{missionId:mission.id});
 await page.getByTestId('open-palette').click();await page.keyboard.type(mission.title);await page.keyboard.press('Enter');await expect(page.getByTestId('plan')).toBeVisible();
 const planned=await call('mission.get',{missionId:mission.id});writeFileSync(path.join(out,'plan.json'),JSON.stringify(planned,null,2));
 await page.screenshot({path:path.join(out,'01-live-plan.png'),fullPage:true});
 await page.getByTestId('approve-plan').click();
 await page.getByRole('tab',{name:/Tasks/}).click();
 let final,lastSeq=0,lastState='',parallelShot=false;const deadline=Date.now()+25*60000;
 while(Date.now()<deadline){
  const state=await call('mission.get',{missionId:mission.id});const m=state.mission??state;
  if(m.state!==lastState){console.log('STATE='+m.state);lastState=m.state;}
  const events=await call('events.since',{missionId:mission.id,afterSeq:lastSeq});
  for(const event of events){lastSeq=Math.max(lastSeq,event.seq);if(['attempt.started','attempt.ended','task.state','finding.reported','agent.message','agent.error'].includes(event.type))console.log(JSON.stringify(event));}
  if(!parallelShot&&(state.tasks??[]).filter(t=>t.state==='running').length>=2){await page.screenshot({path:path.join(out,'02-live-parallel.png'),fullPage:true});parallelShot=true;}
  const cards=page.getByTestId('approval');
  if(await cards.count()){
   const card=cards.first();const text=await card.innerText();
   if(!text.includes('afterlight-staging'))throw new Error('Approval needs operator review: '+text.slice(0,500));
   await page.screenshot({path:path.join(out,'03-live-staging-approval.png')});await card.getByTestId('approve').click();
  }
  if(['completed','failed','cancelled'].includes(m.state)){final=state;break;}
  await new Promise(r=>setTimeout(r,1200));
 }
 if(!final)throw new Error('Mission deadline reached');
 writeFileSync(path.join(out,'result.json'),JSON.stringify(final,null,2));
 await page.getByRole('tab',{name:/Evidence/}).click();await page.screenshot({path:path.join(out,'04-live-evidence.png'),fullPage:true});
 await page.getByTestId('mission-menu').click();await page.getByRole('menuitem',{name:/Export audit log/}).click();
 if((final.mission??final).state!=='completed')throw new Error('Live mission did not pass: '+(final.mission??final).outcome);
 const token=readFileSync(path.join(root,'cloudflare/.dev.vars'),'utf8').split('\n').find(l=>l.startsWith('ATLAS_CLOUD_TOKEN=')).slice(18).trim();
 await call('deploy.secrets.set',{target:'cloudflare',name:'ATLAS_CLOUD_TOKEN',value:token});
 const pub=await call('cloud.publish',{missionId:mission.id});writeFileSync(path.join(out,'cloud-publication.json'),JSON.stringify(pub,null,2));
 await page.getByRole('tab',{name:'Cloudflare'}).click();await expect(page.getByTestId('cloud-panel')).toContainText('All published commit IDs match');await page.screenshot({path:path.join(out,'05-live-artifacts.png'),fullPage:true});
 await call('mission.decide',{missionId:mission.id,decision:'accept'});
 await page.getByTestId('mission-menu').click();await page.getByRole('menuitem',{name:/Export audit log/}).click();
 writeFileSync(path.join(out,'result.json'),JSON.stringify(await call('mission.get',{missionId:mission.id}),null,2));
 console.log('LIVE_VERIFIED='+JSON.stringify({missionId:mission.id,branch:(final.mission??final).integrationBranch,commit:(final.mission??final).integrationCommit,model,out}));
}catch(error){await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});console.error(error);process.exitCode=1;}
finally{await app.close();}
