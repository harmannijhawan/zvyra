/**
 * OWNER: GPT-6 Astra (backend).
 *
 * Single integration point for the real ZVYRA backend. Replace this
 * placeholder with the real implementation of `ZvyraBackend`
 * (see docs/CONTRACT.md). While it returns null, the shell boots the
 * clearly-labelled preview adapter from src/main/mock.
 */
import type { ZvyraBackend } from '../../shared/contract'
import type { BackendContext } from '../backendContext'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { app } from 'electron'

export async function createBackend(ctx: BackendContext): Promise<ZvyraBackend | null> {
  // SWARM retains its own compiler/dependencies. Build with `npm --prefix backend run build`.
  // Loading its bundle at runtime avoids applying renderer compiler settings to vendor source.
  const requireBackend = createRequire(import.meta.url)
  const { createUiBackend } = requireBackend(join(app.getAppPath(), 'backend/dist/ui.cjs')) as {
    createUiBackend(context: BackendContext): Promise<ZvyraBackend>
  }
  return createUiBackend(ctx)
}
