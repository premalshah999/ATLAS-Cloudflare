// Runs the installed ATLAS app against the real Afterlight repository.
// The first pass uses the labeled survey runtime; all release checks execute for real.
import { _electron as electron, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const product=process.env.ATLAS_DEMO_REPO??path.join(os.homedir(),'Desktop/Afterlight');
const expectRollback=process.env.ATLAS_EXPECT_ROLLBACK==='1';
const out = process.env.ATLAS_DEMO_OUT??path.join(root,'test-results',`afterlight-${Date.now()}`);
mkdirSync(out,{recursive:true});
const env={...process.env,ATLAS_E2E:'1',ATLAS_USER_DATA:process.env.ATLAS_DEMO_PROFILE??path.join(os.homedir(),'Library/Application Support/ATLAS-Afterlight'),ATLAS_E2E_OPEN_DIR:product,ATLAS_E2E_SAVE_PATH:path.join(out,'afterlight-mission.atlas.jsonl')};
delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(/_API_KEY$/.test(key))delete env[key];
const app=await electron.launch({executablePath:process.env.ATLAS_TEST_EXECUTABLE??path.join(root,'apps/desktop/release/mac/ATLAS.app/Contents/MacOS/ATLAS'),env,recordVideo:{dir:path.join(out,'raw'),size:{width:1440,height:900}}});
const page=await app.firstWindow();
const call=(method,params={})=>page.evaluate(({method,params})=>window.atlas.invoke(method,params),{method,params});
try{
 await expect(page.getByTestId('daemon-status')).toHaveAttribute('data-state','ready',{timeout:30000});
 const workspace=await call('workspace.open');
 const settings=await call('settings.get');
 await call('settings.set',{key:'deploy.allowedTargets',value:[...new Set([...settings.values['deploy.allowedTargets'],'afterlight-staging'])]});
 const mission=await call('mission.create',{workspaceId:workspace.id,title:(expectRollback?'Afterlight — bad revision rollback proof ':'Afterlight — launch verification ')+Date.now(),goal:'Verify the real Afterlight product. Independently execute its tests, syntax checks, HTTP boundary checks, complete browser launch lifecycle, persisted locked decision and exact staging revision. Do not change code or claim a live model was used. This pass uses the labeled scripted survey runtime.',constraints:'No sample fixture behavior. No fabricated evidence. No external or production deployment in this pass.',runtime:'fake',approvalMode:'plan_only',targetEnvironment:'afterlight-staging',budget:{maxWallClockMinutes:15,maxTokens:100000,maxTasks:4,maxConcurrentAgents:2}});
 console.log('MISSION_ID='+mission.id+' OUTPUT='+out);
 writeFileSync(path.join(out,'mission-id.txt'),mission.id);
 await call('mission.plan',{missionId:mission.id});
 // Navigate using the app command palette to retain the product's actual mission UI.
 await page.getByTestId('open-palette').click();await page.keyboard.type(mission.title);await page.keyboard.press('Enter');
 await expect(page.getByTestId('plan')).toBeVisible();
 await page.screenshot({path:path.join(out,'01-plan.png')});
 await page.getByTestId('approve-plan').click();
 const deadline=Date.now()+180000;
 let final;
 while(Date.now()<deadline){
  const m=await call('mission.get',{missionId:mission.id});
  const state=m.mission??m;
  const approvals=page.getByTestId('approval');
  if(await approvals.count()){
   const card=approvals.first();const text=await card.innerText();
   if(!text.includes('afterlight-staging'))throw new Error('Unexpected approval: '+text.slice(0,200));
   await page.screenshot({path:path.join(out,'02-staging-approval.png')});
   await card.getByTestId('approve').click();
  }
  if(['completed','failed','cancelled'].includes(state.state)){final=m;break;}
  await new Promise(r=>setTimeout(r,750));
 }
 writeFileSync(path.join(out,'result.json'),JSON.stringify(final,null,2));
 if(!final)throw new Error('Mission timed out');
 await page.getByRole('tab',{name:/Evidence/}).click();
 await page.screenshot({path:path.join(out,'03-evidence.png'),fullPage:true});
 console.log(JSON.stringify(final.mission??final));

 const state=(final.mission??final).state;
 if(expectRollback){
  if(state!=='failed'||!final.checks?.some(c=>c.name==='staging:revision'&&c.result==='fail')||!final.checks?.some(c=>c.name==='staging:rollback'&&c.result==='pass'))throw new Error('Expected a blocked bad revision and independently confirmed rollback. Inspect '+path.join(out,'result.json'));
 }else if(state!=='completed')throw new Error('ATLAS mission '+state+'; inspect '+path.join(out,'result.json'));
 await page.getByRole('tab',{name:/Browser/}).click();await page.screenshot({path:path.join(out,'04-browser.png'),fullPage:true});
 await page.getByRole('tab',{name:/Deploy/}).click();await page.screenshot({path:path.join(out,'05-staging.png'),fullPage:true});
 if(process.env.ATLAS_CLOUD_PUBLISH==='1'&&!expectRollback){
  const text=readFileSync(process.env.ATLAS_CLOUD_VARS_FILE??path.join(root,'cloudflare/.dev.vars'),'utf8');
  const token=text.split('\n').find(l=>l.startsWith('ATLAS_CLOUD_TOKEN=')).slice('ATLAS_CLOUD_TOKEN='.length).replace(/^['"]|['"]$/g,'').trim();
  await call('settings.set',{key:'cloud.url',value:process.env.ATLAS_CLOUD_URL??'https://atlas-mission-control.premalshah1305.workers.dev'});
  await call('deploy.secrets.set',{target:'cloudflare',name:'ATLAS_CLOUD_TOKEN',value:token});
  const publication=await call('cloud.publish',{missionId:mission.id});
  writeFileSync(path.join(out,'cloud-publication.json'),JSON.stringify(publication,null,2));
  await page.getByRole('tab',{name:'Cloudflare'}).click();await expect(page.getByTestId('cloud-panel')).toContainText('All published commit IDs match');await page.screenshot({path:path.join(out,'06-artifacts.png'),fullPage:true});
  console.log('ARTIFACTS_VERIFIED='+publication.verified);
 }
 await page.getByTestId('mission-menu').click();await page.getByRole('menuitem',{name:/Export audit log/}).click();
 await call('mission.decide',{missionId:mission.id,decision:expectRollback?'reject':'accept'});
 console.log((expectRollback?'EXPECTED_ROLLBACK_VERIFIED':'ATLAS verified Afterlight')+'; audit exported to '+out);
}catch(e){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});console.error(e);process.exitCode=1;}
finally{await app.close();}
