// Capability inference from model identifiers. These are hints only: routing
// decisions are corrected over time by measured success/latency statistics.
import type { Capability } from '../../shared/types';

// `fim` = fill-in-the-middle completion models and `robotics` = embodied-reasoning models: both were routed
// as "coding" agents by name and produced no usable action output, so they are not chat/agent models.
const NON_CHAT = /(embed|rerank|guard|reward|safety|nemoretriever|retriever|parse|nvclip|\bclip\b|whisper|tts|speech|audio|transcri|detector|translate|calibration|diffusion|deplot|topic-control|content-safety|flux|stable-diffusion|sdxl|image-gen|dall-e|moderation|ocr|kosmos|fuyu|synthetic-video|playai|orpheus|lyria|imagen|veo|aqa|banana|(?:^|[-_/.])fim(?:[-_/.]|$)|robotics)/i;

export function isChatModel(id: string): boolean {
  return !NON_CHAT.test(id);
}

export function estimateParamsB(id: string): number | null {
  const lower = id.toLowerCase();
  const moe = lower.match(/(\d+)x(\d+(?:\.\d+)?)b/);
  if (moe) return Number(moe[1]) * Number(moe[2]);
  const all = [...lower.matchAll(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z])/g)].map((m) => Number(m[1]));
  if (all.length) return Math.max(...all);
  return null;
}

export function inferCapabilities(id: string, extra: Partial<Record<Capability, boolean>> = {}): Capability[] {
  const s = id.toLowerCase();
  const caps = new Set<Capability>(['chat']);
  const params = estimateParamsB(s);
  if (/cod(e|er|estral|ing)|starcoder|devstral|deepseek|kimi|glm|gpt-oss|qwen(2\.5|3)|llama-3\.[13]|llama-4|nemotron|mistral-(large|medium|small)|gemini|gemma-[34]|laguna|minimax|grok|claude|gpt-4|gpt-5|command-a|hermes/.test(s)) caps.add('coding');
  if (/r1\b|reason|think|qwq|ultra|super|kimi|glm-[45]|deepseek-v|gpt-oss|magistral|nemotron-3|gemini-(2\.5|3)|-pro\b|large|405b|253b|70b|120b|235b|480b|550b/.test(s)) caps.add('reasoning');
  if (/vision|-vl\b|vl-|\bvl\b|llava|pixtral|gemma-3-(4|12|27)b|gemma-[4]|gemma3|phi-3(\.5)?-vision|omni|neva|vila|gemini|llama-4|qwen2\.5-vl|qwen3-vl|minicpm-v|moondream|llama3\.2-vision|cosmos-reason/.test(s)) caps.add('vision');
  if (/flash|lite|mini|nano|instant|fast|lightning|small|tiny|8b|7b|4b|3b|2b|1b/.test(s) || (params !== null && params <= 14)) caps.add('fast');
  if (/128k|1m|200k|kimi|gemini|llama-3\.[123]|llama-4|nemotron|glm|deepseek-v|qwen3|gpt-oss|mistral-large|command-r/.test(s)) caps.add('long_context');
  if (/tool|function|llama-3\.[13]|llama-4|qwen|mistral|gpt-oss|kimi|glm|nemotron|gemini|deepseek-v/.test(s)) caps.add('tools');
  for (const [k, v] of Object.entries(extra)) {
    if (v) caps.add(k as Capability); else if (v === false) caps.delete(k as Capability);
  }
  return [...caps];
}

export function inferContext(id: string): number {
  const s = id.toLowerCase();
  if (/1m|gemini/.test(s)) return 1_000_000;
  if (/kimi|glm-5|deepseek-v|qwen3|gpt-oss|nemotron-3|llama-3\.[123]|llama-4|mistral-large|128k|phi-3.*128k|laguna/.test(s)) return 128_000;
  if (/llama2|codellama|gemma-2b|recurrentgemma|starcoder|8k/.test(s)) return 8_192;
  return 32_768;
}

export function prettyName(id: string): string {
  const base = id.split('/').pop() ?? id;
  return base
    .replace(/:free$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b(\w)/g, (m) => m.toUpperCase())
    .replace(/\bIt\b/g, 'IT')
    .replace(/(\d)B\b/gi, '$1B');
}
