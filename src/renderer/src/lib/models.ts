/** Model catalogue from the AI engine. Never invents availability. */
import { useEffect, useSyncExternalStore } from 'react'
import type { ModelInfo } from '@shared/contract'
import { call, errorMessage } from './client'
import { useStore } from './store'

interface ModelsState {
  models: ModelInfo[]
  loading: boolean
  loaded: boolean
  error?: string
}

let state: ModelsState = { models: [], loading: false, loaded: false }
const listeners = new Set<() => void>()
const set = (patch: Partial<ModelsState>) => {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export async function loadModels(refresh = false) {
  if (state.loading) return
  set({ loading: true, error: undefined })
  try {
    set({ models: await call('models.list', { refresh }), loaded: true, loading: false })
  } catch (err) {
    set({ loading: false, loaded: true, error: errorMessage(err) })
  }
}

export function useModels(autoLoad = true) {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state
  )
  // Reload whenever the AI connection (re)connects or is re-checked.
  const conn = useStore((st) => `${st.swarm?.status}|${st.swarm?.lastCheckedAt ?? ''}|${st.swarm?.baseUrl ?? ''}`)
  useEffect(() => {
    if (autoLoad && !state.loading) void loadModels()
  }, [autoLoad, conn])
  return s
}
