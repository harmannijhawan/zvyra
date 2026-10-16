/** Directory browser + file preview/editor over the authorised-roots file API. */
import { ArrowUp, ExternalLink, File, FileCode, Folder, FolderOpen, RefreshCw, Save } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { FileContent, FileEntry } from '@shared/contract'
import { call, errorMessage } from '../lib/client'
import { bytes } from '../lib/format'
import { attempt, useAction } from '../lib/useAction'
import { Badge, Button, EmptyState, IconButton, Spinner } from './ui'

const CODE_EXT = /\.(ts|tsx|js|jsx|json|md|css|html|py|rs|go|java|cs|c|cpp|h|yml|yaml|toml|sh|ps1|txt)$/i

function parentOf(p: string, root: string) {
  if (p === root) return null
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  const parent = i > 0 ? p.slice(0, i) : root
  return parent.length < root.length ? root : parent
}

export function FileBrowser({ root, editable, onOpenFile }: { root: string; editable?: boolean; onOpenFile?: (f: FileContent | null) => void }) {
  const [dir, setDir] = useState(root)
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<FileContent | null>(null)
  const [draft, setDraft] = useState('')
  const [run, saving] = useAction()

  const load = useCallback(async (path: string) => {
    setEntries(null)
    setError(null)
    try {
      const list = await call('files.list', { path })
      list.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))
      setEntries(list)
    } catch (err) {
      setError(errorMessage(err))
      setEntries([])
    }
  }, [])

  useEffect(() => {
    setDir(root)
    setFile(null)
  }, [root])
  useEffect(() => {
    void load(dir)
  }, [dir, load])

  const open = async (e: FileEntry) => {
    if (e.type === 'directory') return setDir(e.path)
    const f = await attempt(() => call('files.read', { path: e.path }), { errorTitle: 'Couldn’t open file' })
    if (f) {
      setFile(f)
      setDraft(f.content)
      onOpenFile?.(f)
    }
  }

  const save = async () => {
    if (!file) return
    const f = await run(() => call('files.write', { path: file.path, content: draft }), { success: 'Saved' })
    if (f) setFile(f)
  }

  const up = parentOf(dir, root)
  const rel = dir.slice(root.length).replace(/^[\\/]/, '')
  const dirty = !!file && draft !== file.content

  return (
    <div className="grid-2" style={{ gridTemplateColumns: 'minmax(260px, 340px) minmax(0, 1fr)', alignItems: 'start' }}>
      <div className="card padded">
        <div className="row" style={{ marginBottom: 8 }}>
          <IconButton icon={ArrowUp} label="Up one folder" size="sm" disabled={!up} onClick={() => up && setDir(up)} />
          <div className="crumbs truncate" title={dir}>
            <FolderOpen style={{ width: 14, height: 14 }} /> {rel || 'Root'}
          </div>
          <span className="spacer" />
          <IconButton icon={RefreshCw} label="Refresh" size="sm" onClick={() => void load(dir)} />
          <IconButton icon={ExternalLink} label="Show in File Explorer" size="sm" onClick={() => void attempt(() => call('files.reveal', { path: dir }))} />
        </div>
        {error && <div className="notice danger" style={{ marginBottom: 8 }}>{error}</div>}
        {!entries ? (
          <div className="row" style={{ padding: 12 }}>
            <Spinner /> <span className="muted">Loading…</span>
          </div>
        ) : entries.length === 0 && !error ? (
          <div className="muted" style={{ padding: 10, fontSize: 13 }}>This folder is empty.</div>
        ) : (
          <div className="list" style={{ maxHeight: 'calc(100vh - 330px)', overflow: 'auto' }}>
            {entries.map((e) => (
              <button key={e.path} type="button" className={`list-item ${file?.path === e.path ? 'selected' : ''}`} style={{ padding: '6px 8px' }} onClick={() => void open(e)}>
                <span className="li-icon" style={{ width: 26, height: 26 }}>
                  {e.type === 'directory' ? <Folder /> : CODE_EXT.test(e.name) ? <FileCode /> : <File />}
                </span>
                <span className="li-body">
                  <div className="li-title">{e.name}</div>
                </span>
                <span className="li-meta">{e.type === 'file' && e.size !== undefined ? bytes(e.size) : ''}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="card padded" style={{ minHeight: 360 }}>
        {file ? (
          <>
            <div className="row" style={{ marginBottom: 10 }}>
              <div className="li-body">
                <div className="li-title">{file.path.split(/[\\/]/).pop()}</div>
                <div className="li-sub">
                  {bytes(file.size)}
                  {file.truncated ? ' · truncated preview' : ''}
                </div>
              </div>
              {file.truncated && <Badge tone="warning">Read-only (truncated)</Badge>}
              {file.encoding === 'binary' && <Badge>Binary</Badge>}
              <IconButton icon={ExternalLink} label="Open with default app" size="sm" onClick={() => void attempt(() => call('files.openExternal', { path: file.path }))} />
              {editable && file.encoding === 'utf8' && !file.truncated && (
                <Button size="sm" variant="primary" icon={Save} disabled={!dirty} loading={saving} onClick={() => void save()}>
                  Save
                </Button>
              )}
            </div>
            <div className="code-view">
              {editable && file.encoding === 'utf8' && !file.truncated ? (
                <textarea
                  value={draft}
                  spellCheck={false}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 's' && e.ctrlKey) {
                      e.preventDefault()
                      if (dirty) void save()
                    }
                  }}
                  aria-label="File contents"
                />
              ) : (
                <pre style={{ margin: 0, padding: '12px 14px' }}>{file.encoding === 'binary' ? 'Binary file — open it with its default app.' : file.content}</pre>
              )}
            </div>
          </>
        ) : (
          <EmptyState icon={File} title="No file selected">
            Choose a file to preview{editable ? ' or edit' : ''}. Writes go through ZVYRA’s file permissions.
          </EmptyState>
        )}
      </div>
    </div>
  )
}
