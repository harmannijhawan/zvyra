/** Real provider latency using synthetic speech; never records the user's mic. */
import {app} from 'electron'
import {copyFileSync,mkdtempSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {GoogleGenAI} from '@google/genai'
import {VoiceEngine,type VoiceEngineDeps} from '../src/main/voice/engine'
import {SecretStore} from '../src/main/desktop/secrets'
import {readWav16k} from '../src/main/voice/personalWake'
import {DEFAULT_LIVE_MODEL} from '../src/main/voice/catalog'
const dir=process.env.ZVYRA_LATENCY_DIR!
const installed=join(app.getPath('appData'),'ZVYRA')
const profile=mkdtempSync(join(tmpdir(),'zvyra-latency-'))
copyFileSync(join(installed,'Local State'),join(profile,'Local State'))
app.setPath('userData',profile)
void app.whenReady().then(async()=>{
  let engine:VoiceEngine|undefined
  let session:Awaited<ReturnType<GoogleGenAI['live']['connect']>>|undefined
  let firstAudio=0,lastSpeech=0,setup=0
  const result:Record<string,unknown>={}
  const started=Date.now()
  try {
    const key=new SecretStore(installed).get('gemini.apiKey')
    if(!key)throw new Error('No configured voice credential available')
    engine=new VoiceEngine({getKey:()=>key,getConfig:()=>({wakeEnabled:false,sensitivity:0.6,micDeviceId:null,model:DEFAULT_LIVE_MODEL,voice:'Charon',idleTimeoutSec:60,silenceMs:750,speakingRate:1}),tools:{host:{},systemContext:async()=>''},logger:{info:()=>{},warn:()=>{}},emit:()=>{},activity:()=>{}} as unknown as VoiceEngineDeps)
    const config=await (engine as unknown as {buildConfig():Promise<import('@google/genai').LiveConnectConfig>}).buildConfig()
    const ai=new GoogleGenAI({apiKey:key})
    let error=''
    session=await ai.live.connect({model:DEFAULT_LIVE_MODEL,config,callbacks:{onmessage:m=>{
      if(m.setupComplete)setup=Date.now()
      if(!firstAudio&&m.serverContent?.modelTurn?.parts?.some(p=>p.inlineData?.data))firstAudio=Date.now()
    },onerror:e=>{error=e.message??'Provider error'},onclose:e=>{if(!firstAudio)error=error||`Closed ${e.code}: ${e.reason}`}}})
    const floats=readWav16k(join(dir,'request.wav'))
    if(!floats)throw new Error('Synthetic test audio could not be decoded')
    const pcm=Int16Array.from(floats,v=>Math.max(-32768,Math.min(32767,Math.round(v*32767))))
    for(let offset=0;offset<pcm.length;offset+=1600) {
      const part=pcm.subarray(offset,Math.min(pcm.length,offset+1600))
      if(part.some(v=>Math.abs(v)>300))lastSpeech=Date.now()+part.length/16
      session.sendRealtimeInput({audio:{data:Buffer.from(part.buffer,part.byteOffset,part.byteLength).toString('base64'),mimeType:'audio/pcm;rate=16000'}})
      await new Promise(r=>setTimeout(r,part.length/16))
      if(error)throw new Error(error)
    }
    const deadline=Date.now()+20000
    while(!firstAudio&&Date.now()<deadline&&!error) {
      session.sendRealtimeInput({audio:{data:Buffer.alloc(3200).toString('base64'),mimeType:'audio/pcm;rate=16000'}})
      await new Promise(r=>setTimeout(r,100))
    }
    if(error)throw new Error(error)
    if(!firstAudio)throw new Error('No reply audio within 20 seconds')
    Object.assign(result,{ok:true,model:DEFAULT_LIVE_MODEL,setupMs:setup-started,afterSpeechMs:firstAudio-lastSpeech,thinkingBudget:config.thinkingConfig?.thinkingBudget,pauseMs:config.realtimeInputConfig?.automaticActivityDetection?.silenceDurationMs})
  }catch(error){result.ok=false;result.error=error instanceof Error?error.message:String(error)}
  finally {
    session?.close();engine?.dispose()
    writeFileSync(join(dir,'result.json'),JSON.stringify(result,null,2))
    console.log(JSON.stringify(result));app.exit(result.ok?0:1)
  }
})
