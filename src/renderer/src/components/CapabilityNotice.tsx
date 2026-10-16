import { PlugZap } from 'lucide-react'
import type { Capability } from '@shared/contract'
import { useStore } from '../lib/store'

/** Honest banner when the connected backend doesn't implement a surface yet. */
export function CapabilityNotice({ cap, what }: { cap: Capability; what: string }) {
  const value = useStore((s) => s.system?.capabilities[cap])
  const mock = useStore((s) => s.backendMode?.mode === 'mock')
  if (value) return null
  return (
    <div className="notice warning" role="status" style={{ marginBottom: 16 }}>
      <PlugZap />
      <span>
        {what} {mock ? 'needs the real backend — the preview adapter doesn’t touch your PC.' : 'isn’t available from the connected backend yet.'} Controls below
        will show the backend’s exact response when used.
      </span>
    </div>
  )
}
