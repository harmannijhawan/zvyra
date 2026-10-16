/** Chat — persistent conversations with streaming AI replies. */
import {
  Check,
  Copy,
  FileText,
  Image as ImageIcon,
  ListTodo,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  RotateCcw,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Attachment, ChatMessage } from '@shared/contract'
import { Composer, ModelSelect } from '../components/Composer'
import { Pet } from '../components/Pet'
import { Badge, Button, ConfirmDialog, EmptyState, IconButton } from '../components/ui'
import { call } from '../lib/client'
import { bytes, timeAgo } from '../lib/format'
import { useNow } from '../lib/hooks'
import { loadMessages, navigate, useCapability, useStore } from '../lib/store'
import { attempt, reportError, useAction } from '../lib/useAction'

export function Chat({ conversationId }: { conversationId?: string }) {
  const conversations = useStore((s) => s.conversations)
  const [query, setQuery] = useState('')
  const [run, creating] = useAction()
  const now = useNow(60_000)
  const list = useMemo(
    () =>
      Object.values(conversations)
        .filter((c) => !query || `${c.title} ${c.preview ?? ''}`.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [conversations, query]
  )

  const create = async () => {
    const c = await run(() => call('chat.create', {}))
    if (c) navigate(`chat/${c.id}`)
  }

  useEffect(() => {
    if (!conversationId && list.length && !query) navigate(`chat/${list[0].id}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  return (
    <div className="page flush">
      <div className="split">
        <aside className="split-side">
          <div className="split-side-head">
            <h1>Chat</h1>
            <Button size="sm" variant="primary" icon={MessageSquarePlus} onClick={() => void create()} loading={creating}>
              New
            </Button>
          </div>
          <div className="search">
            <Search />
            <input className="input" placeholder="Search conversations" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search conversations" />
          </div>
          <div className="split-list list" role="list">
            {list.length === 0 && <div className="muted" style={{ padding: '10px 8px', fontSize: 13 }}>{query ? 'No matches.' : 'No conversations yet.'}</div>}
            {list.map((c) => (
              <button
                key={c.id}
                type="button"
                role="listitem"
                className={`list-item ${c.id === conversationId ? 'selected' : ''}`}
                onClick={() => navigate(`chat/${c.id}`)}
              >
                <span className="li-icon">
                  <MessageSquare />
                </span>
                <span className="li-body">
                  <div className="li-title">{c.title}</div>
                  <div className="li-sub">{c.preview ?? `${c.messageCount} messages`}</div>
                </span>
                <span className="li-meta">{timeAgo(c.updatedAt, now)}</span>
              </button>
            ))}
          </div>
        </aside>
        {conversationId && conversations[conversationId] ? (
          <Conversation id={conversationId} />
        ) : (
          <div className="split-main" style={{ justifyContent: 'center' }}>
            <EmptyState
              icon={MessageSquare}
              title={conversationId ? 'Conversation not found' : 'Start a conversation'}
              action={
                <Button variant="primary" icon={MessageSquarePlus} onClick={() => void create()}>
                  New conversation
                </Button>
              }
            >
              Conversations are saved and restored when you restart ZVYRA.
            </EmptyState>
          </div>
        )}
      </div>
    </div>
  )
}

function Conversation({ id }: { id: string }) {
  const conv = useStore((s) => s.conversations[id])
  const messages = useStore((s) => s.messages[id])
  const attachCap = useCapability('chatAttachments')
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(conv.title)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [sending, setSending] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)
  const streaming = !!messages?.some((m) => m.status === 'streaming')

  useEffect(() => {
    setLoadError(null)
    setAttachments([])
    loadMessages(id).catch((e) => setLoadError(String(e?.message ?? e)))
    inputRef.current?.focus()
  }, [id])
  useEffect(() => setTitle(conv.title), [conv.title])

  useEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const onScroll = () => {
    const el = scrollRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const send = async () => {
    if (!text.trim()) return
    setSending(true)
    stick.current = true
    const r = await attempt(() =>
      call('chat.send', { conversationId: id, text: text.trim(), attachmentIds: attachments.length ? attachments.map((a) => a.id) : undefined })
    )
    setSending(false)
    if (r) {
      setText('')
      setAttachments([])
    }
  }

  const rename = async () => {
    setEditing(false)
    if (title.trim() && title.trim() !== conv.title) await attempt(() => call('chat.rename', { id, title: title.trim() }))
    else setTitle(conv.title)
  }

  const pick = async () => {
    const picked = await attempt(() => call('chat.pickAttachments'))
    if (picked?.length) setAttachments((a) => [...a, ...picked])
  }

  return (
    <div className="split-main">
      <header className="chat-head">
        {editing ? (
          <input
            className="input"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void rename()
              if (e.key === 'Escape') {
                setTitle(conv.title)
                setEditing(false)
              }
            }}
            aria-label="Conversation title"
          />
        ) : (
          <h2 title={conv.title}>{conv.title}</h2>
        )}
        <IconButton icon={editing ? Check : Pencil} label={editing ? 'Save title' : 'Rename'} size="sm" onClick={() => (editing ? void rename() : setEditing(true))} />
        <span className="spacer" />
        <ModelSelect
          value={conv.model}
          onChange={(m) => void attempt(() => call('chat.setModel', { id, model: m ?? null }))}
          className="composer-model"
        />
        <IconButton icon={Trash2} label="Delete conversation" size="sm" onClick={() => setConfirmDelete(true)} />
      </header>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-inner">
          {loadError && (
            <div className="notice danger">
              Couldn’t load messages: {loadError}
              <Button size="sm" onClick={() => void loadMessages(id).then(() => setLoadError(null))}>
                Retry
              </Button>
            </div>
          )}
          {messages?.length === 0 && (
            <EmptyState icon={MessageSquare} title="Ask anything">
              Replies stream from the model selected above. Choose “Auto” to let ZVYRA pick.
            </EmptyState>
          )}
          {messages?.map((m, i) => (
            <Message key={m.id} message={m} conversationId={id} isLast={i === messages.length - 1} />
          ))}
        </div>
      </div>

      <div className="chat-compose">
        {attachments.length > 0 && (
          <div className="attach-row" style={{ maxWidth: 820, margin: '0 auto 8px' }}>
            {attachments.map((a) => (
              <span key={a.id} className="attach">
                {a.kind === 'image' ? <ImageIcon /> : <FileText />}
                {a.name} <span className="muted">{bytes(a.size)}</span>
                <IconButton icon={X} size="sm" label={`Remove ${a.name}`} onClick={() => setAttachments((l) => l.filter((x) => x.id !== a.id))} />
              </span>
            ))}
          </div>
        )}
        <Composer
          ref={inputRef}
          value={text}
          onChange={setText}
          onSubmit={() => void send()}
          busy={sending || streaming}
          onStop={streaming ? () => void attempt(() => call('chat.stop', { conversationId: id })) : undefined}
          source="chat"
          placeholder="Message ZVYRA…"
          onAttach={attachCap ? () => void pick() : undefined}
          attachDisabledReason={attachCap ? undefined : 'Attachments are not supported by the connected backend yet'}
        />
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete conversation?"
        body={`“${conv.title}” and its messages will be permanently removed.`}
        confirmLabel="Delete"
        danger
        onClose={() => setConfirmDelete(false)}
        onConfirm={() =>
          void attempt(() => call('chat.delete', { id }), { success: 'Conversation deleted' }).then(() => navigate('chat'))
        }
      />
    </div>
  )
}

const Message = memo(function Message({ message: m, conversationId, isLast }: { message: ChatMessage; conversationId: string; isLast: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch (err) {
      reportError(err, 'Copy failed')
    }
  }
  const isUser = m.role === 'user'
  return (
    <div className={`msg ${m.role} ${m.status === 'error' ? 'error' : ''}`}>
      <div className="msg-avatar">
        {isUser ? <span className="avatar">·</span> : <Pet state={m.status === 'streaming' ? 'thinking' : m.status === 'error' ? 'error' : 'idle'} size={32} />}
      </div>
      <div className="msg-col">
        {m.attachments && m.attachments.length > 0 && (
          <div className="attach-row">
            {m.attachments.map((a) => (
              <span key={a.id} className="attach">
                {a.kind === 'image' ? <ImageIcon /> : <FileText />} {a.name}
              </span>
            ))}
          </div>
        )}
        <div className="bubble">
          {isUser ? (
            m.content
          ) : m.content ? (
            <div className="markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
            </div>
          ) : m.status === 'streaming' ? (
            <span className="muted">Thinking…</span>
          ) : null}
          {m.status === 'streaming' && m.content && <span className="caret" />}
        </div>
        {m.status === 'error' && <div className="notice danger" style={{ padding: '6px 10px' }}>{m.error ?? 'The model request failed.'}</div>}
        <div className="msg-meta">
          {m.model && !isUser && <span>{m.model}</span>}
          {m.status === 'stopped' && <Badge>Stopped</Badge>}
          <span>{timeAgo(m.createdAt)}</span>
          {m.content && <IconButton icon={copied ? Check : Copy} label={copied ? 'Copied' : 'Copy'} size="sm" onClick={() => void copy()} />}
          {!isUser && isLast && (m.status === 'error' || m.status === 'stopped' || m.status === 'complete') && (
            <IconButton icon={RotateCcw} label="Retry" size="sm" onClick={() => void attempt(() => call('chat.retry', { conversationId }))} />
          )}
          {isUser && (
            <IconButton
              icon={ListTodo}
              label="Run as task"
              size="sm"
              onClick={() =>
                void attempt(() => call('chat.runAsTask', { conversationId, messageId: m.id }), { success: 'Task created' }).then((t) => t && navigate(`tasks/${t.id}`))
              }
            />
          )}
        </div>
      </div>
    </div>
  )
})
