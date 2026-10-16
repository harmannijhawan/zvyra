import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { VoiceSettings, patch, type VoiceState } from './contract';
import { db } from '../../SWARM/electron/core/db';
const patchVoice = (value: unknown) => patch(VoiceSettings).parse(value);
export class VoiceService {
  private capture?: ChildProcessWithoutNullStreams;
  private playback?: ChildProcessWithoutNullStreams;
  private generation = 0;
  state: VoiceState = 'disabled';
  error: string | null = null;
  capabilities: { recognizers: string[]; microphone: string; tts: boolean } | null = null;
  settings = VoiceSettings.parse(JSON.parse(db().kvGet('zvyra.voice') ?? '{}'));
  constructor(private script: string, private publish: (topic: string, payload: unknown) => void, private command: (text: string) => void) {}
  snapshot() { return { state: this.state, error: this.error, settings: this.settings, capabilities: this.capabilities, wakePhrase: 'Hey Zvyra', hardwareVerified: false }; }
  private stateTo(state: VoiceState, error: string | null = null) { this.state = state; this.error = error; this.publish('voice.state', this.snapshot()); }
  private worker(mode: string) {
    if (process.platform === 'win32')
      return spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-File', this.script, '-Mode', mode, '-Language', this.settings.language], { windowsHide: true, stdio: 'pipe' });
    if (process.platform === 'darwin') {
      // macOS worker speaks the identical JSON protocol; it lives beside speech.ps1.
      const macScript = this.script.replace(/speech\.ps1$/i, 'speech.darwin.mjs');
      return spawn(process.execPath, [macScript, '--mode', mode, '--language', this.settings.language], { stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    }
    throw new Error('Speech is not supported on this platform');
  }
  async probe() {
    try {
      const child = this.worker('probe');
      await new Promise<void>(resolve => {
        let data = ''; const timer = setTimeout(() => { child.kill(); resolve(); }, 10000);
        child.stdout.on('data', chunk => { data += chunk; });
        child.on('error', () => { clearTimeout(timer); resolve(); });
        child.on('close', () => { clearTimeout(timer); try { const value = JSON.parse(data.trim()); if (value.type === 'capabilities') this.capabilities = value; else this.error = value.message; } catch { this.error = 'Speech runtime probe failed'; } resolve(); });
      });
    } catch (e) { this.error = String(e); }
    return this.snapshot();
  }
  configure(patch: unknown) {
    const values = patchVoice(patch);
    this.stop(); this.settings = VoiceSettings.parse({ ...this.settings, ...values });
    db().kvSet('zvyra.voice', JSON.stringify(this.settings));
    if (this.settings.enabled && this.settings.wakeWord) this.listen(true);
    return this.snapshot();
  }
  listen(wake = false) {
    if (!this.settings.enabled) throw new Error('Enable voice before listening');
    if (!this.capabilities?.recognizers.includes(this.settings.language)) throw new Error('Install a Windows desktop speech recognizer for the selected language');
    this.stop(); const token = this.generation;
    let child: ChildProcessWithoutNullStreams;
    try { child = this.worker(wake ? 'wake' : 'listen'); } catch (e) { this.stateTo('error', String(e)); throw e; }
    this.capture = child;
    let buffer = ''; let transcript = ''; let failure = ''; let ready = false;
    const startup = setTimeout(() => { failure = 'Microphone initialization timed out'; child.kill(); }, 15000);
    child.stdout.on('data', chunk => {
      buffer += chunk.toString(); const lines = buffer.split(/\r?\n/); buffer = lines.pop()!;
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (token !== this.generation) return;
          if (event.type === 'ready') { ready = true; clearTimeout(startup); this.stateTo(wake ? 'standby' : 'listening'); }
          if (event.type === 'error') failure = String(event.message);
          if (event.type === 'transcript') transcript = String(event.text);
        } catch { failure = 'Invalid speech worker output'; }
      }
    });
    child.on('error', e => { failure = e.message; });
    child.on('close', () => {
      clearTimeout(startup);
      if (token !== this.generation) return;
      this.capture = undefined;
      if (failure || !ready) { this.stateTo('error', failure || 'Speech worker could not initialize'); return; }
      if (wake && transcript) { this.stateTo('wake_word_detected'); this.listen(false); return; }
      if (transcript) { this.stateTo('transcribing'); this.publish('voice.transcript', { text: transcript }); this.stateTo('planning'); this.command(transcript); }
      else this.stateTo('standby');
      if (this.settings.wakeWord) this.listen(true);
    });
    return this.snapshot();
  }
  finish() { if (this.capture && this.state === 'listening') { this.capture.stdin.write('finish\n'); this.stateTo('transcribing'); } return this.snapshot(); }
  stop() { this.generation++; this.capture?.kill(); this.capture = undefined; this.stopPlayback(); this.stateTo('disabled'); return this.snapshot(); }
  speak(text: string) {
    if (!this.settings.enabled || !this.capabilities?.tts) throw new Error('Enable and configure Windows speech first');
    this.stop(); const token = this.generation; const child = this.worker('speak'); this.playback = child; this.stateTo('speaking');
    child.stdin.end(JSON.stringify({ text }));
    child.on('error', e => { if (token === this.generation) this.stateTo('error', e.message); });
    child.on('close', code => { if (token !== this.generation) return; this.playback = undefined; this.stateTo(code === 0 ? 'standby' : 'error', code === 0 ? null : 'Speech playback failed'); if (code === 0 && this.settings.wakeWord) this.listen(true); });
    return this.snapshot();
  }
  stopPlayback() { this.playback?.kill(); this.playback = undefined; if (this.state === 'speaking') { this.generation++; this.stateTo('standby'); } return this.snapshot(); }
}
