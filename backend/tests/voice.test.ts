import { beforeAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const fixture=vi.hoisted(()=>({children:[] as any[]}));
vi.mock('node:child_process',()=>({spawn:()=>{const child=new EventEmitter() as any;child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=vi.fn(()=>{queueMicrotask(()=>child.emit('close',1));});fixture.children.push(child);return child;}}));
vi.mock('electron',()=>({screen:{},shell:{},nativeImage:{},app:{},Notification:{isSupported:()=>false}}));
import { VoiceService } from '../src/voice';
import { initDb } from '../../SWARM/electron/core/db';
beforeAll(()=>initDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(),'zvyra-voice-')),'test.db')));
describe('voice lifecycle with controlled speech workers (not hardware tests)',()=>{
  function setup(){const publish=vi.fn(),command=vi.fn();const service=new VoiceService('speech.ps1',publish,command);service.capabilities={recognizers:['en-GB'],microphone:'system-default',tts:true};service.configure({enabled:true,language:'en-GB',wakeWord:false});return {service,publish,command};}
  it('rejects unavailable recognizers before microphone capture',()=>{const {service}=setup();service.configure({language:'en-US'});expect(()=>service.listen()).toThrow('Install a Windows');});
  it('emits readiness only after the worker initializes; completes a transcript',()=>{const {service,command}=setup();service.listen();expect(service.state).not.toBe('listening');const child=fixture.children.at(-1);child.stdout.write('{"type":"ready"}\n');expect(service.state).toBe('listening');child.stdout.write('{"type":"transcript","text":"hello"}\n');child.emit('close',0);expect(command).toHaveBeenCalledWith('hello');service.stop();});
  it('ignores late transcripts after cancellation',()=>{const {service,command}=setup();service.listen();const child=fixture.children.at(-1);service.stop();child.stdout.write('{"type":"transcript","text":"stale"}\n');child.emit('close',0);expect(command).not.toHaveBeenCalled();expect(service.state).toBe('disabled');});
  it('finish asks the worker to finalize, while cancel kills it',()=>{const {service}=setup();service.listen();const child=fixture.children.at(-1);child.stdout.write('{"type":"ready"}\n');service.finish();expect(child.stdin.read().toString()).toBe('finish\n');expect(service.state).toBe('transcribing');service.stop();expect(child.kill).toHaveBeenCalled();});
  it('surfaces microphone errors without claiming a transcript',()=>{const {service,command}=setup();service.listen();const child=fixture.children.at(-1);child.stdout.write('{"type":"error","message":"No input device"}\n');child.emit('close',1);expect(service.error).toBe('No input device');expect(service.state).toBe('error');expect(command).not.toHaveBeenCalled();});
});
