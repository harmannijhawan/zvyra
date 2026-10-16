import { useSyncExternalStore } from 'react'

export interface Toast {
  id: number
  tone: 'info' | 'success' | 'warning' | 'danger'
  title: string
  message?: string
  action?: { label: string; run: () => void }
}

let toasts: Toast[] = []
let seq = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function toast(t: Omit<Toast, 'id'>, ttl = t.tone === 'danger' ? 8000 : 4000) {
  const id = ++seq
  toasts = [...toasts.slice(-3), { ...t, id }]
  emit()
  setTimeout(() => dismissToast(id), ttl)
  return id
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export function useToasts() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => toasts
  )
}
