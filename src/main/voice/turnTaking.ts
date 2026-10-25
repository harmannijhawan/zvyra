/** Short handoff by default; a longer pause remains an explicit preference. */
export function speechPauseMs(configured?:number):number {
  return Number.isFinite(configured)?Math.min(3000,Math.max(500,configured!)):750
}
