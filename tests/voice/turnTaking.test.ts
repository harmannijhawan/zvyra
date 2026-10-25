import {afterEach,describe,expect,it,vi} from 'vitest'
import {EndSensitivity,type LiveConnectConfig} from '@google/genai'
vi.mock('electron',()=>({BrowserWindow:class{},ipcMain:{on:vi.fn(),removeListener:vi.fn()}}))
vi.mock('../../src/main/voice/extraTools',()=>({ALL_TOOL_DECLARATIONS:[],runTool:vi.fn()}))
vi.mock('../../src/main/computer/controller',()=>({computerController:{stop:vi.fn()}}))
vi.mock('../../src/main/computer/inputQueue',()=>({desktopInput:{stop:vi.fn()}}))
import {VoiceEngine,type VoiceEngineDeps} from '../../src/main/voice/engine'
import {speechPauseMs} from '../../src/main/voice/turnTaking'

function setup() {
  const session={close:vi.fn(),sendRealtimeInput:vi.fn()}
  const engine=new VoiceEngine({getKey:()=>null,getConfig:()=>({wakeEnabled:false,sensitivity:0.6,model:'test',voice:'Charon',idleTimeoutSec:60,silenceMs:800,speakingRate:1,stayAwake:true}),logger:{info:vi.fn(),warn:vi.fn()},emit:vi.fn(),tools:{host:{},systemContext:async()=>''},activity:vi.fn()} as unknown as VoiceEngineDeps)
  const runtime=engine as unknown as {session:typeof session;phase:string;outLevel:number;userSpeaking:boolean;awaitingReply:boolean;onAudio(pcm:Uint8Array):void;trackSpeech(rms:number,now:number):void;buildConfig():Promise<LiveConnectConfig>}
  runtime.session=session;runtime.phase='listening'
  return {engine,runtime,session}
}
const pcm=(value:number)=>new Uint8Array(new Int16Array(1600).fill(value).buffer)
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks()})

describe('whole utterance listening',()=>{
  it('keeps quiet continuation audio flowing while the assistant speaks',()=>{
    vi.useFakeTimers();const {engine,runtime,session}=setup()
    try {
      runtime.phase='speaking';runtime.outLevel=0.8
      const frames=[pcm(150),pcm(250),pcm(300),pcm(200)]
      for(const frame of frames)runtime.onAudio(frame)
      expect(session.sendRealtimeInput).toHaveBeenCalledTimes(4)
      expect(session.sendRealtimeInput.mock.calls.map(c=>c[0].audio.data)).toEqual(frames.map(f=>Buffer.from(f).toString('base64')))
    } finally{engine.dispose()}
  })
  it('preserves the opening frames of a spoken interruption without double sending',()=>{
    vi.useFakeTimers();const {engine,runtime,session}=setup()
    try {
      runtime.phase='speaking';runtime.outLevel=0
      for(let i=0;i<3;i++)runtime.onAudio(pcm(6000+i))
      expect(runtime.phase).toBe('listening')
      expect(session.sendRealtimeInput).toHaveBeenCalledTimes(3)
    } finally{engine.dispose()}
  })
  it('does not end a request during a short pause and resets the pause when speech continues',()=>{
    vi.useFakeTimers();const {engine,runtime}=setup()
    try {
      runtime.trackSpeech(0.1,100);runtime.trackSpeech(0.1,300)
      runtime.trackSpeech(0,400);runtime.trackSpeech(0,1000)
      expect(runtime.userSpeaking).toBe(true);expect(runtime.awaitingReply).toBe(false)
      runtime.trackSpeech(0.1,1050);runtime.trackSpeech(0,1100);runtime.trackSpeech(0,1800)
      expect(runtime.userSpeaking).toBe(true)
      runtime.trackSpeech(0,1900)
      expect(runtime.userSpeaking).toBe(false);expect(runtime.awaitingReply).toBe(true)
    } finally{engine.dispose()}
  })
  it('uses a short server handoff with thinking disabled for immediate conversation',async()=>{
    vi.useFakeTimers();const {engine,runtime}=setup()
    try {
      const cfg=await runtime.buildConfig()
      expect(cfg.realtimeInputConfig?.automaticActivityDetection).toMatchObject({silenceDurationMs:800,prefixPaddingMs:300,endOfSpeechSensitivity:EndSensitivity.END_SENSITIVITY_LOW})
      expect(cfg.thinkingConfig).toEqual({thinkingBudget:0})
      expect(speechPauseMs(500)).toBe(500);expect(speechPauseMs(2800)).toBe(2800);expect(speechPauseMs(undefined)).toBe(750)
    } finally{engine.dispose()}
  })
  it('detects quieter speech promptly and shows speaking while a task is working',()=>{
    vi.useFakeTimers();const {engine,runtime}=setup()
    try {
      const state=runtime as typeof runtime & {toolsRunning:number}
      state.toolsRunning=1
      runtime.trackSpeech(0.012,100);runtime.trackSpeech(0.012,200)
      expect(runtime.userSpeaking).toBe(true);expect(engine.status()).toMatchObject({state:'listening',userSpeaking:true})
      runtime.trackSpeech(0.006,300)
      expect(runtime.userSpeaking).toBe(true)
      runtime.trackSpeech(0,400);runtime.trackSpeech(0,1200)
      expect(runtime.userSpeaking).toBe(false);expect(engine.status().state).toBe('transcribing')
    } finally{engine.dispose()}
  })
})
