import type { UiRect } from '../tools/uia'
/** Refocusing is safe for an observed semantic target; coordinates need unchanged geometry and pixels. */
export function sameRect(a: UiRect | null, b: UiRect | null, tolerance = 2): boolean {
  return !!a && !!b && Math.abs(a.x-b.x)<=tolerance && Math.abs(a.y-b.y)<=tolerance && Math.abs(a.w-b.w)<=tolerance && Math.abs(a.h-b.h)<=tolerance
}
export function pixelChange(before: Uint8Array, after: Uint8Array): number {
  if (!before.length || before.length !== after.length) return 1
  let changed = 0
  for (let i=0; i<before.length; i+=4) if (Math.max(Math.abs(before[i]-after[i]),Math.abs(before[i+1]-after[i+1]),Math.abs(before[i+2]-after[i+2])) > 48) changed++
  return changed / (before.length/4)
}
export const isDesktopMission = (text: string) => /\b(computer\s*(control|task)|use (?:my |the )?(?:mouse|keyboard|desktop|screen)|(?:open|launch|use|type|write|draw|click|navigate|save).{0,65}\b(?:notepad|paint|calculator|file explorer)|(?:in|using|through)\s+(?:the\s+)?(?:ui|gui)|on (?:my|the) screen)\b/i.test(text)
