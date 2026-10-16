const fs = require('node:fs');
const edit = (file, fn) => fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8')));
edit('src/views/Build.tsx', s => {
  s = s.replace('MessagesSquare, Play,', 'MessagesSquare, Pause, Play, X,');
  s = s.replace("import { BrowserPane } from '../components/BrowserPane';", "import { RuntimePane } from '../components/RuntimePane';");
  s = s.replace('const MIN_CHAT_W = 240', 'const MIN_CHAT_W = 360');
  s = s.replace("const [narrowTab, setNarrowTab] = useState<string>('preview');", "const [narrowTab, setNarrowTab] = useState<string>('graph');\n  const [surface, setSurface] = useState<string>('activity');\n  const [panelOpen, setPanelOpen] = useState(true);\n  const graphArea = useRef<HTMLDivElement>(null);\n  const [graphHeight, setGraphHeight] = useState(480);\n  useEffect(() => { const el = graphArea.current; if (!el) return; const ro = new ResizeObserver(() => setGraphHeight(Math.max(300, el.clientHeight))); ro.observe(el); return () => ro.disconnect(); }, [project?.id, width]);\n  useEffect(() => { const open = () => { setPanelOpen(true); setNarrowTab('chat'); }; window.addEventListener('swarm:agent-selected', open); return () => window.removeEventListener('swarm:agent-selected', open); }, []);");
  s = s.replace("<BrowserPane url={previewUrl} projectId={project.id} />", '<RuntimePane projectId={project.id} runId={runId} />');
  const start = s.indexOf('  // ── narrow: tabs');
  const end = s.indexOf('// ─── Mission header', start);
  s = s.slice(0,start) + `  const bottomTabs = [{ value: 'activity', label: 'Live Activity', icon: ListTree }, { value: 'tasks', label: 'Tasks', icon: Boxes, count: tasks.length }, ...stageTabs];
  const bottom = surface === 'activity' ? <ActivityFeed events={events ?? []} mode={logMode} showTime={settings.interface.showTimestamps} /> :
    surface === 'tasks' ? <div className="build-task-list">{tasks.map(t => <button key={t.id} onClick={() => useStore.setState({ inspector: { type: 'task', id: t.id } })}><Dot tone={t.status === 'completed' ? 'ok' : t.status === 'failed' ? 'err' : t.status === 'running' ? 'accent' : 'neutral'} /><span>{t.title}</span><small>{t.role}</small><small>{t.status}</small></button>)}</div> : stage(surface as StageTab);
  return (
    <div ref={ref} className="build-workspace h-full flex flex-col min-h-0">
      {run ? <Mission /> : <NoRun />}
      {narrow && <div className="build-mobile-tabs"><Tabs value={narrowTab} onChange={setNarrowTab} tabs={[{ value: 'graph', label: 'Graph', icon: Boxes }, { value: 'activity', label: 'Activity', icon: ListTree }, { value: 'chat', label: 'Manager', icon: MessageSquareText }]} /></div>}
      <div className="build-control-room">
        {(!narrow || narrowTab !== 'chat') && <div className="build-main-surface">
          {(!narrow || narrowTab === 'graph') && <section className="build-graph-surface" ref={graphArea}>
            <div className="build-graph-toolbar"><Segmented size="sm" value={graphMode} onChange={setGraphMode} label="Graph mode" options={[{ value: 'agents', label: 'Agents', icon: Boxes }, { value: 'tasks', label: 'Dependencies', icon: ListTree }]} /><span>{Object.keys(agents).length} agents · {tasks.length} total tasks</span>{!panelOpen && <Button variant="ghost" icon={MessageSquareText} onClick={() => setPanelOpen(true)}>Manager</Button>}</div>
            {graphPanel(graphHeight - 42)}
          </section>}
          <section className={cx('build-activity-surface', surface !== 'activity' && surface !== 'tasks' && 'build-activity-expanded', narrow && narrowTab === 'activity' && 'build-activity-mobile')}>
            <div className="build-activity-tabs"><Tabs value={surface} onChange={setSurface} tabs={bottomTabs} /><button className="build-log-toggle" onClick={() => setLogMode(logMode === 'simple' ? 'detailed' : 'simple')}>{logMode === 'simple' ? 'Details' : 'Simple'}</button></div>
            <div className="flex-1 min-h-0">{bottom}</div>
          </section>
        </div>}
        {(!narrow && panelOpen || narrow && narrowTab === 'chat') && <>
          {!narrow && <PanelResizer onDelta={handlePanelDelta} />}
          <section className="build-agent-panel" style={{ width: narrow ? '100%' : Math.min(chatPanelWidth, Math.max(300, width * .32)) }}>
            <button className="build-panel-close" aria-label="Close agent panel" onClick={() => { setPanelOpen(false); setNarrowTab('graph'); }}><X size={16} /></button>
            {chatPanel ?? <Empty icon={MessageSquareText} title="Manager" body="Start a build to direct the workforce." />}
          </section>
        </>}
      </div>
      {artifacts.length > 0 && <div className="build-artifacts">{artifacts.map(a => <Button key={a.path} variant="ghost" icon={FileText} onClick={() => api.projects.reveal(project.id, a.path).catch(() => {})}>{a.path.split('/').pop()}</Button>)}</div>}
      {!run && <div className="px-4 pb-3"><Composer variant="dock" /></div>}
    </div>
  );
}

` + s.slice(end);
  s = s.replace("const done = relevant.filter(t => t.status === 'completed' || t.status === 'failed').length;", "const done = relevant.filter(t => t.status === 'completed').length;");
  s = s.replace('className="px-6 pt-5 pb-4 shrink-0 anim-fade"', 'className="build-mission shrink-0 anim-fade"');
  s = s.replace('<Button variant="secondary" icon={Square} onClick={() => api.runs.cancel(run.id)}>Stop</Button>', '<><Button variant="secondary" icon={Pause} onClick={() => api.runs.pause(run.id)}>Pause</Button><Button variant="secondary" icon={Square} onClick={() => api.runs.cancel(run.id)}>Stop</Button></>');
  s = s.replace("(run.status === 'cancelled' || run.status === 'failed' || run.status === 'attention')", "(run.status === 'paused' || run.status === 'cancelled' || run.status === 'failed' || run.status === 'attention')");
  s = s.replace('<Meter value={progress} tone={run.status', '<Meter value={progress} tone={run.status');
  s = s.replace(' · \${relevant.length} total', ' · \${relevant.length} total');
  return s;
});
edit('electron/chat/liveRunChat.ts', s => s.replace("kind: 'task_created'", "kind: 'task_added'").replace(", agent: 'manager'", ''));
