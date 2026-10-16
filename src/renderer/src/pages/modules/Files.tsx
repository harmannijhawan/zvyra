import { FolderOpen, FolderPlus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FileRoot } from '@shared/contract'
import { CapabilityNotice } from '../../components/CapabilityNotice'
import { FileBrowser } from '../../components/FileBrowser'
import { Badge, Button, Card, EmptyState, IconButton } from '../../components/ui'
import { call, errorMessage } from '../../lib/client'
import { attempt } from '../../lib/useAction'

export function FilesModule() {
  const [roots, setRoots] = useState<FileRoot[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [root, setRoot] = useState<string | null>(null)

  const load = () =>
    call('files.roots')
      .then((r) => {
        setRoots(r)
        setError(null)
        setRoot((cur) => (cur && r.some((x) => x.path === cur) ? cur : (r[0]?.path ?? null)))
      })
      .catch((e) => {
        setRoots([])
        setError(errorMessage(e))
      })

  useEffect(() => {
    void load()
  }, [])

  const add = async () => {
    const r = await attempt(() => call('files.addRoot'), { success: 'Folder authorised' })
    if (r) {
      await load()
      setRoot(r.path)
    }
  }

  return (
    <div className="stack">
      <CapabilityNotice cap="files" what="File browsing" />
      <Card
        title="Authorised folders"
        icon={FolderOpen}
        actions={
          <Button size="sm" icon={FolderPlus} onClick={() => void add()}>
            Authorise folder
          </Button>
        }
      >
        {error && <div className="notice warning" style={{ marginBottom: 8 }}>{error}</div>}
        {roots?.length === 0 && !error && <div className="muted" style={{ fontSize: 13 }}>ZVYRA can only see folders you authorise here or add as projects.</div>}
        <div className="list">
          {roots?.map((r) => (
            <div key={r.path} className={`list-item clickable ${root === r.path ? 'selected' : ''}`}>
              <button type="button" className="li-body" style={{ textAlign: 'left' }} onClick={() => setRoot(r.path)}>
                <div className="li-title">{r.label}</div>
                <div className="li-sub mono">{r.path}</div>
              </button>
              <Badge tone={r.source === 'project' ? 'accent' : 'neutral'}>{r.source === 'project' ? 'Project' : 'Folder'}</Badge>
              {r.source === 'user' && (
                <IconButton
                  icon={Trash2}
                  size="sm"
                  label="Remove access"
                  onClick={() => void attempt(() => call('files.removeRoot', { path: r.path }), { success: 'Access removed' }).then(() => load())}
                />
              )}
            </div>
          ))}
        </div>
      </Card>
      {root ? <FileBrowser root={root} /> : roots && roots.length > 0 ? null : <EmptyState icon={FolderOpen} title="Nothing to browse yet" />}
    </div>
  )
}
