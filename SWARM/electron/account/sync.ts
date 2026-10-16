import {validatePreferences} from '../../shared/preferences';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFileSync, unlinkSync } from 'node:fs';
import { app, shell, safeStorage } from 'electron';
import { db } from '../core/db';
import { getSecret, getStoredSecret, setSecret } from '../core/secrets';
import { getSettings, updateSettings } from '../core/settings';
import { bus } from '../core/bus';
import type { Conversation } from '../../shared/chat';

type Account={id:string;email:string|null;role:string;name?:string|null;avatar?:string|null};
let validated=false;
type CloudChat={id:string;title:string;createdAt:string;updatedAt:string;messages:{id:number;role:'user'|'assistant';content:string;createdAt:string}[];desktop?:Conversation};
type RecordItem={kind:'chat'|'provider'|'document';id:string;value:any;version:string|null};
type Baseline=Record<string,{version:string|null;local:string|null}>;
const digest=(v:unknown)=>v===null?null:createHash('sha256').update(JSON.stringify(v)).digest('hex');
let busy=false;let timer:NodeJS.Timeout|undefined;let callbackServer:Server|undefined;let error:string|null=null;let connecting=false;
const origin=()=>app.isPackaged?'https://www.swarmgpt.online':db().kvGet('account.origin')||process.env.SWARM_ACCOUNT_URL||'https://www.swarmgpt.online';
const profile=():Account|null=>JSON.parse(db().kvGet('account.profile')||'null');
export function accountStatus(){return {account:validated?profile():null,connected:validated&&!!getStoredSecret('account.device'),origin:origin(),syncing:busy,connecting,lastSync:Number(db().kvGet('account.lastSync')||0)||null,error};}
function notify(){bus.send('account:changed',accountStatus());}
function validateOrigin(value:string){const u=new URL(value);if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname))))throw new Error('Use an HTTPS website address, or localhost for development.');return u.origin;}
async function request(path:string,body?:unknown,token=getStoredSecret('account.device')) {
  const response=await fetch(origin()+'/api/account/'+path,{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000),redirect:'error'});
  if(response.status===401 && token){validated=false;setSecret('account.device',null);notify();}
  if(!response.ok){
    // Try to parse error details from response
    let errorMessage = 'Account service could not complete the request ('+response.status+').';
    try {
      const errorData = await response.json();
      if (errorData?.error) {
        errorMessage = errorData.error;
      } else if (errorData?.code === 'configuration') {
        errorMessage = 'SWARM backend is not properly configured. Contact your administrator.';
      }
    } catch {
      // Use default error message
    }
    if(response.status===401){
      throw new Error('Your account session expired. Sign in again.');
    } else if(response.status===403){
      throw new Error('This device cannot sync this account.');
    } else if(response.status===503){
      throw new Error(errorMessage);
    }
    throw new Error(errorMessage);
  }
  return response.json();
}
function cloudChat(c:Conversation,old?:CloudChat):CloudChat {
  const date=new Date(c.turns[0]?.ts||c.updatedAt).toISOString();
  return {id:c.id,title:c.title.slice(0,120),createdAt:old?.createdAt||date,updatedAt:new Date(c.updatedAt).toISOString(),messages:c.turns.filter(t=>t.status!=='streaming').map(t=>({id:Number(t.id)||parseInt(createHash('sha256').update(t.id).digest('hex').slice(0,12),16),role:t.role,content:t.text,createdAt:new Date(t.ts||c.updatedAt).toISOString()})),desktop:c};
}
function desktopChat(c:CloudChat):Conversation {
  return {...c.desktop,id:c.id,title:c.title,updatedAt:Date.parse(c.updatedAt),turns:c.messages.map(m=>{
    const previous=c.desktop?.turns.find(t=>(Number(t.id)||parseInt(createHash('sha256').update(t.id).digest('hex').slice(0,12),16))===m.id);
    return {...previous,id:previous?.id||String(m.id),role:m.role,text:m.content,ts:Date.parse(m.createdAt),status:'complete' as const};
  })};
}
export async function syncAccount() {
  if(busy||!getStoredSecret('account.device'))return accountStatus();busy=true;error=null;notify();
  try {
    const account=await request('profile') as Account;
    const bound=db().kvGet('account.boundOwner');if(bound!==account.id)throw new Error('This workspace belongs to another account.');
    db().kvSet('account.profile',JSON.stringify(account));validated=true;notify();
    const baseline:Baseline=JSON.parse(db().kvGet('account.baseline.'+account.id)||'{}');
    const chats=db().list<Conversation>('conversations');const pending=new Set(chats.filter(c=>c.turns.some(t=>t.status==='streaming')).map(c=>c.id));
    const local=new Map<string,any>();const changes:any[]=[];
    for(const c of chats) {if(pending.has(c.id))continue;local.set('chat:'+c.id,cloudChat(c,JSON.parse(db().kvGet('account.chat.'+c.id)||'null')));}

    const device=db().kvGet('account.deviceId')||randomBytes(12).toString('hex');db().kvSet('account.deviceId',device);
    const settings=getSettings();local.set('document:preferences',sharedPreferences(settings));
    local.set('document:desktop-'+device,{projects:db().list('projects'),runs:db().list('runs'),graphVersions:db().list('graph_versions'),preferences:{appearance:getSettings().appearance}});
    for(const [key,value] of local) {const old=baseline[key];if(digest(value)!==(old?.local??null)){const cut=key.indexOf(':');changes.push({kind:key.slice(0,cut),id:key.slice(cut+1),base:old?.version??null,value});}}
    for(const key of Object.keys(baseline))if(key.startsWith('chat:')&&!local.has(key)&&!pending.has(key.slice(5))&&baseline[key].local!==null)changes.push({kind:'chat',id:key.slice(5),base:baseline[key].version,value:null});
    const result=await request('sync',{changes});
    if(result.account.id!==account.id)throw new Error('Account identity changed. Sign in again.');
    for(const record of result.records as RecordItem[]) {
      if(record.kind==='provider')continue; // Legacy servers must never transfer provider credentials to this device.
      const key=record.kind+':'+record.id;if(record.kind==='chat'&&(pending.has(record.id)||result.busy?.includes(record.id)))continue;
      if(record.kind==='chat') {const current=db().get<Conversation>('conversations',record.id);if(current?.turns.some(t=>t.status==='streaming')||(current&&digest(cloudChat(current,JSON.parse(db().kvGet('account.chat.'+record.id)||'null')))!==digest(local.get(key)||null))){baseline[key]={version:record.version,local:digest(local.get(key)||null)};continue;}}
      if(result.conflicts.includes(key)&&record.kind==='chat'&&local.get(key)) {
        const copy=desktopChat(local.get(key));copy.id+='-conflict-'+Date.now();copy.title=(copy.title+' (local copy)').slice(0,100);db().put('conversations',copy.id,copy,{updated_at:copy.updatedAt});
      }
      if(record.kind==='chat') {
        if(record.value){const c=desktopChat(record.value);db().put('conversations',c.id,c,{updated_at:c.updatedAt});db().kvSet('account.chat.'+c.id,JSON.stringify(record.value));bus.send('chat:updated',c);baseline[key]={version:record.version,local:digest(cloudChat(c,record.value))};}
        else {db().delete('conversations','id = ?',[record.id]);baseline[key]={version:null,local:null};bus.send('chat:updated',{id:record.id,deleted:true});}
      }else {if(record.id==='preferences'&&record.value){updateSettings(sharedPreferences(record.value));baseline[key]={version:record.version,local:digest(record.value)};}db().kvSet('account.document.'+record.id,JSON.stringify(record.value));if(record.id==='desktop-'+device)baseline[key]={version:record.version,local:digest(record.value)};}
    }
    db().kvSet('account.baseline.'+account.id,JSON.stringify(baseline));db().kvSet('account.lastSync',String(Date.now()));
    if(result.conflicts.length)error='Concurrent edits were detected. Local chat copies were preserved; the account version is now active.';
  } catch(e){error=e instanceof Error?e.message:'Account sync failed.';} finally {busy=false;notify();}
  return accountStatus();
}
async function connect(token:string,account:Account) {
  if(!safeStorage.isEncryptionAvailable())throw new Error('Windows credential encryption is unavailable.');
  const bound=db().kvGet('account.boundOwner');if(bound&&bound!==account.id)throw new Error('This workspace belongs to another account. Use a separate workspace to switch accounts.');
  db().kvSet('account.boundOwner',account.id);db().kvSet('account.profile',JSON.stringify(account));setSecret('account.device',token);validated=true;connecting=false;error=null;notify();await syncAccount();await (await import('../providers/registry')).discoverAll();
}
export async function signInAccount(address:string) {
  if(busy||connecting)throw new Error('An account connection is already in progress.');
  // Check if there's a stored session that might be stale
  const existingToken = getStoredSecret('account.device');
  if(existingToken) {
    // Try to validate the existing session first
    try {
      const testOrigin = app.isPackaged ? 'https://www.swarmgpt.online' : validateOrigin(address);
      const response = await fetch(testOrigin + '/api/account/profile', {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + existingToken },
        signal: AbortSignal.timeout(10000)
      });
      if (response.ok) {
        // Session is still valid, just sync
        await syncAccount();
        return accountStatus();
      }
    } catch {
      // Session is invalid, will clear it and continue with new sign-in
    }
    throw new Error('Sign out before reconnecting.');
  }
  db().kvSet('account.origin',validateOrigin(app.isPackaged?'https://www.swarmgpt.online':address));connecting=true;error=null;notify();
  const state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
  callbackServer?.close();
  let consumed=false;const expires=Date.now()+300000;
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    const u=new URL(req.url||'/', 'http://127.0.0.1');
    if(consumed||Date.now()>expires||req.method!=='GET'||u.pathname!=='/callback'||u.searchParams.get('state')!==state||!u.searchParams.get('code')){res.writeHead(400).end('Invalid connection callback.');return;}
    consumed=true;
    try{const result=await request('desktop-token',{code:u.searchParams.get('code'),verifier},null);await connect(result.token,result.account);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end('<title>SWARM connected</title><h1>Your desktop is connected.</h1><p>Return to SWARM. Your chats and preferences are syncing.</p>');}
    catch(e){error=e instanceof Error?e.message:'Sign-in failed.';res.writeHead(400).end('Could not connect. Return to SWARM to retry.');}
    finally{connecting=false;server.close();notify();}
  });callbackServer=server;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=(server.address() as {port:number}).port;const u=new URL(origin()+'/desktop/connect');u.searchParams.set('callback',`http://127.0.0.1:${port}/callback`);u.searchParams.set('state',state);u.searchParams.set('challenge',challenge);
  const timeout=setTimeout(()=>{server.close();connecting=false;error='Sign-in timed out. Please try again.';notify();},300000);timeout.unref();server.once('close',()=>clearTimeout(timeout));
  try{await shell.openExternal(u.href);}catch(e){server.close();connecting=false;notify();throw e;}return accountStatus();
}
export async function signOutAccount() {
  if(busy)throw new Error('Wait for sync to finish before signing out.');
  const token=getStoredSecret('account.device');
  if(token){
    // Try to revoke server-side, but don't fail if server is unavailable
    try{
      await request('revoke',{id:createHash('sha256').update(token).digest('hex')});
    }catch(e){
      // Server unavailable or token already invalid - that's okay, we'll clear locally anyway
      console.warn('Could not revoke session server-side (server may be unavailable):', e instanceof Error ? e.message : String(e));
    }
    setSecret('account.device',null);
  }
  callbackServer?.close();validated=false;db().kvSet('account.profile','null');connecting=false;error=null;notify();return accountStatus();
}
export async function startAccountSync() {
  const file=app.isPackaged?undefined:process.env.SWARM_ACCOUNT_BOOTSTRAP;
  if(file){try{const value=JSON.parse(readFileSync(file,'utf8'));db().kvSet('account.origin',validateOrigin(value.origin));await connect(value.token,value.account);}finally{unlinkSync(file);delete process.env.SWARM_ACCOUNT_BOOTSTRAP;}}
  timer=setInterval(()=>void syncAccount(),30000);timer.unref();await syncAccount();
}
export function stopAccountSync(){if(timer)clearInterval(timer);callbackServer?.close();}

// Only portable preferences may cross the account boundary. Never sync execution permissions or paths.
function sharedPreferences(value:any){return validatePreferences(JSON.parse(JSON.stringify({ai:{routing:value.ai?.routing,freeMode:true,pinnedModel:value.ai?.pinnedModel,temperature:value.ai?.temperature,maxOutputTokens:value.ai?.maxOutputTokens},agents:{modelPreference:value.agents?.modelPreference},providers:{enabled:value.providers?.enabled},routing:{excluded:value.routing?.excluded,maxFallbacks:value.routing?.maxFallbacks},appearance:value.appearance})));}

// Authenticated backend access. This token is a SWARM device session, never an AI provider key.
export async function managedRequest(path:string,body?:unknown,signal?:AbortSignal) {
  if(!validated||!getStoredSecret('account.device'))throw new Error('Sign in to SWARM to continue.');
  const response=await fetch(origin()+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+getStoredSecret('account.device'),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(240000)]):AbortSignal.timeout(45000),redirect:'error'});
  if(response.status===401){validated=false;setSecret('account.device',null);notify();}
  if(!response.ok)throw new Error(response.status===401?'Your SWARM session expired. Sign in again.':response.status===429?'Your SWARM allowance or request capacity is exhausted. Check Account & billing.':response.status===403?'This request is not included in your SWARM plan.':response.status===409?'This request is already running or has expired. Refresh before retrying.':'SWARM AI is temporarily unavailable. No provider API-key setup is required.');
  return response.json();
}
