import { z } from 'zod';
import { PcAction } from '../../SWARM/electron/computer/service';
import { SettingsSchema } from '../../SWARM/shared/settings';

const id = z.string().min(1).max(128);
const text = z.string().trim().min(1).max(100_000);
const empty = z.object({}).strict();
const byId = z.object({ id }).strict();
const provider = z.enum(['google', 'groq', 'mistral', 'huggingface', 'nvidia', 'openrouter']);
// Zod defaults inside .partial() would reset omitted settings. Validate the patch,
// but preserve only the fields actually supplied by the caller.
export function patch<S extends z.ZodObject>(schema: S) {
  return z.unknown().transform((value, ctx): Partial<z.infer<S>> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { ctx.addIssue({ code: 'custom', message: 'Expected settings object' }); return z.NEVER; }
    const parsed = schema.partial().strict().safeParse(value);
    if (!parsed.success) { ctx.addIssue({ code: 'custom', message: 'Invalid settings patch' }); return z.NEVER; }
    return value as Partial<z.infer<S>>;
  });
}
export const Preferences = z.object({
  doNotDisturb: z.boolean().default(false), quietStart: z.number().int().min(0).max(23).default(22),
  quietEnd: z.number().int().min(0).max(23).default(8), quietHours: z.boolean().default(false),
  memoryEnabled: z.boolean().default(true), startAtLogin: z.boolean().default(false),
}).strict();
export const VoiceSettings = z.object({ enabled: z.boolean().default(false), wakeWord: z.boolean().default(false),
  speakReplies: z.boolean().default(false), language: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/).default('en-US'),
  microphone: z.literal('system-default').default('system-default'),
}).strict();
export const schemas = {
  'status.get': empty,
  'conversation.list': empty, 'conversation.get': byId,
  'conversation.create': z.object({ projectId: id.optional() }).strict(),
  'conversation.rename': z.object({ id, title: z.string().trim().min(1).max(100) }).strict(),
  'conversation.delete': byId, 'conversation.cancel': byId,
  'conversation.send': z.object({ id, text, model: id.optional() }).strict(),
  'task.list': z.object({ projectId: id.optional() }).strict(), 'task.get': byId,
  'task.create': z.object({ projectId: id, instruction: text, model: id.optional() }).strict(),
  'task.pause': byId, 'task.resume': byId, 'task.cancel': byId, 'task.retry': byId,
  'task.logs': z.object({ id, limit: z.number().int().min(1).max(2000).default(200) }).strict(),
  'agents.list': empty,
  'routing.get': empty, 'routing.models': empty,
  'routing.discover': z.object({ provider: provider.optional() }).strict(),
  'routing.test': z.object({ provider }).strict(),
  'routing.probe': byId,
  'routing.configure': z.object({ ai: patch(SettingsSchema.shape.ai.unwrap()).optional(), routing: patch(SettingsSchema.shape.routing.unwrap()).optional(), modelPreference: SettingsSchema.shape.agents.unwrap().shape.modelPreference.optional() }).strict(),
  'routing.credential': z.object({ provider, key: z.string().min(1).max(4096).nullable() }).strict(),
  'computer.status': empty, 'computer.permission': z.object({ enabled: z.boolean() }).strict(),
  'computer.execute': z.object({ id, action: PcAction }).strict(), 'computer.cancel': byId,
  'approval.list': empty, 'approval.resolve': z.object({ id, approved: z.boolean() }).strict(),
  'project.list': empty, 'project.get': byId,
  'project.create': z.object({ name: z.string().trim().min(1).max(100), objective: text.optional() }).strict(),
  'memory.search': z.object({ query: z.string().max(500).default(''), projectId: id.optional() }).strict(),
  'memory.save': z.object({ id: id.optional(), text: z.string().trim().min(1).max(10000), projectId: id.optional() }).strict(),
  'memory.delete': byId, 'memory.clear': empty,
  'preferences.get': empty, 'preferences.update': patch(Preferences),
  'privacy.get': empty, 'privacy.update': patch(SettingsSchema.shape.privacy.unwrap()),
  'notifications.list': empty, 'notifications.read': empty,
  'voice.get': empty, 'voice.configure': patch(VoiceSettings), 'voice.start': empty,
  'voice.stop': empty, 'voice.finish': empty, 'voice.speak': z.object({ text: z.string().min(1).max(10000) }).strict(),
  'voice.stopPlayback': empty,
  'automation.list': empty,
  'automation.create': z.object({ projectId: id, instruction: text, at: z.number().int().positive() }).strict(),
  'automation.cancel': byId,
} as const;
export type Operation = keyof typeof schemas;
export type Input<K extends Operation> = z.input<(typeof schemas)[K]>;
export interface BackendEvent { version: 1; sequence: number; at: number; topic: string; payload: unknown }
export type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; retryable: boolean } };
export type VoiceState = 'disabled' | 'standby' | 'wake_word_detected' | 'listening' | 'transcribing' | 'planning' | 'speaking' | 'error';

