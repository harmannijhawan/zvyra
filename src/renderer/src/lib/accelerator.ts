/** Builds an Electron accelerator string from a keydown event. Requires a non-Shift modifier. */
export function toAccelerator(e: { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; code: string }): string | null {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null
  let key = e.key
  if (e.code.startsWith('Key')) key = e.code.slice(3)
  else if (e.code.startsWith('Digit')) key = e.code.slice(5)
  else if (key === ' ') key = 'Space'
  else if (key.length === 1) key = key.toUpperCase()
  else if (key === 'Escape') key = 'Esc'
  if (!mods.length || (mods.length === 1 && mods[0] === 'Shift')) return null
  return [...mods, key].join('+')
}
