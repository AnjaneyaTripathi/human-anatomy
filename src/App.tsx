import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Box, ChevronDown, ChevronRight, CircleHelp, Eye, EyeOff,
  Focus, Layers3, Menu, Move3d, RotateCcw, ScanLine, Search,
  X,
} from 'lucide-react'
import AnatomyViewer from './AnatomyViewer'
import type { ClipAxis, ViewDirection } from './viewer-types'
import type { AnatomyLandmark, AnatomyManifest, AnatomyStructure } from './types'

const PAGE_SIZE = 80
const views: Array<{ id: ViewDirection; label: string }> = [
  { id: 'anterior', label: 'Anterior' }, { id: 'posterior', label: 'Posterior' },
  { id: 'left', label: 'Left' }, { id: 'right', label: 'Right' },
]
type CatalogEntry = (AnatomyStructure | AnatomyLandmark) & { kind: 'structure' | 'landmark' }
const EXCLUDED_SYSTEM_IDS = new Set(['regions'])

/** Keeps the source manifest untouched while omitting the outer skin envelope at runtime. */
function atlasWithoutOuterSkin(atlas: AnatomyManifest): AnatomyManifest {
  const systems = atlas.systems.filter((system) => !EXCLUDED_SYSTEM_IDS.has(system.id))
  const systemIds = new Set(systems.map((system) => system.id))
  const structures = atlas.structures.filter((structure) => systemIds.has(structure.system))
  const structureIds = new Set(structures.map((structure) => structure.id))
  const landmarks = atlas.landmarks?.filter((landmark) => systemIds.has(landmark.system) && (!landmark.parentStructureId || structureIds.has(landmark.parentStructureId)))
  return {
    ...atlas,
    systems,
    structures,
    landmarks,
    coverage: {
      ...atlas.coverage,
      runtimeExcludedSystems: ['regions'],
      runtimeExportedStructures: structures.length,
    },
  }
}

/** Show the compact skeleton immediately; the remaining systems load when requested. */
function initialVisibleSystems(atlas?: AnatomyManifest): Set<string> {
  const skeletal = atlas?.systems.find((system) => system.id === 'skeletal')
  return new Set(skeletal ? [skeletal.id] : atlas?.systems.slice(0, 1).map((system) => system.id) ?? [])
}

function titleCase(value: string) { return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) }
function displayName(value: string) {
  return value.replace(/\.ol\b/gi, ' origin left').replace(/\.or\b/gi, ' origin right')
    .replace(/\.il\b/gi, ' insertion left').replace(/\.ir\b/gi, ' insertion right')
    .replace(/\.l\b/gi, ' left').replace(/\.r\b/gi, ' right').replace(/\.(g|i|e\d+)\b/gi, '').trim()
}

export default function App() {
  const mount = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const viewer = useRef<AnatomyViewer | null>(null)
  const loadEpoch = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const [atlas, setAtlas] = useState<AnatomyManifest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState('Preparing anatomy library')
  const [ready, setReady] = useState(false)
  const [assetBusy, setAssetBusy] = useState(false)
  const [assetFailure, setAssetFailure] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [visible, setVisible] = useState<Set<string>>(new Set())
  const [opacities, setOpacities] = useState<Record<string, number>>({})
  const [query, setQuery] = useState('')
  const [activeFilter, setActiveFilter] = useState<string>('all')
  const [shown, setShown] = useState(PAGE_SIZE)
  const [view, setView] = useState<ViewDirection>('anterior')
  const [clipAxis, setClipAxis] = useState<ClipAxis>('none')
  const [clipFraction, setClipFraction] = useState(50)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)

  const load = useCallback(async () => {
    const epoch = ++loadEpoch.current
    abortRef.current?.abort()
    viewer.current?.dispose(); viewer.current = null
    const aborter = new AbortController(); abortRef.current = aborter
    setSelectedId(null); setError(null); setAssetFailure(null); setReady(false); setAssetBusy(true); setProgress('Reading atlas index')
    try {
      const manifestUrl = `${import.meta.env.BASE_URL}data/anatomy.json`
      const response = await fetch(manifestUrl, { signal: aborter.signal })
      if (epoch !== loadEpoch.current) return
      if (!response.ok) throw new Error(`The anatomy index could not be loaded (${response.status}).`)
      const rawData = await response.json() as AnatomyManifest
      if (epoch !== loadEpoch.current) return
      if (!Array.isArray(rawData.systems) || !Array.isArray(rawData.structures)) throw new Error('The anatomy index has an invalid format.')
      const data = atlasWithoutOuterSkin(rawData)
      setAtlas(data)
      const initial = initialVisibleSystems(data)
      setVisible(initial); setOpacities(Object.fromEntries(data.systems.map((system) => [system.id, 1])))
      if (!mount.current) return
      const instance = new AnatomyViewer(mount.current, {
        onSelect: (id) => { if (epoch === loadEpoch.current) setSelectedId(id) },
        onHover: (id) => { if (epoch === loadEpoch.current) setHoveredId(id) },
        onProgress: (p) => { if (epoch === loadEpoch.current) { setProgress(p.stage === 'error' ? p.label : `Loading ${p.label}`); if (p.stage === 'error') { setAssetFailure(p.label); setAssetBusy(false) } else if (p.stage === 'loading' || p.stage === 'deferred') setAssetBusy(true); else if (p.stage === 'ready') { setAssetFailure(null); setAssetBusy(false) } } },
        onReady: () => { if (epoch === loadEpoch.current) setReady(true) },
        onError: (message) => { if (epoch === loadEpoch.current) setError(message) },
        onRevealSystem: (system) => { if (epoch === loadEpoch.current) setVisible((current) => new Set(current).add(system)) },
      })
      viewer.current = instance
      await instance.load(data, { manifestUrl, initialVisibleSystems: initial })
      if (epoch !== loadEpoch.current) { instance.dispose(); return }
    } catch (reason) {
      if (epoch !== loadEpoch.current || aborter.signal.aborted) return
      setError(reason instanceof Error ? reason.message : 'The atlas could not be loaded.')
    }
  }, [])

  useEffect(() => {
    void load()
    return () => { loadEpoch.current += 1; abortRef.current?.abort(); viewer.current?.dispose(); viewer.current = null }
  }, [load])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setDrawerOpen(true); requestAnimationFrame(() => searchInput.current?.focus())
      }
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => { setShown(PAGE_SIZE) }, [query, activeFilter])
  useEffect(() => {
    if (!infoOpen) return
    const close = (event: KeyboardEvent) => { const modal = document.querySelector<HTMLElement>('.info-modal'); if (event.key === 'Escape') setInfoOpen(false); if (event.key === 'Tab') { const focusable = modal?.querySelectorAll<HTMLElement>('a,button'); if (!focusable?.length) return; const first = focusable[0]; const last = focusable[focusable.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() } } }
    window.addEventListener('keydown', close); requestAnimationFrame(() => document.querySelector<HTMLElement>('.info-modal button')?.focus())
    return () => window.removeEventListener('keydown', close)
  }, [infoOpen])

  const systemsById = useMemo(() => new Map(atlas?.systems.map((s) => [s.id, s]) ?? []), [atlas])
  const selected = useMemo<CatalogEntry | null>(() => {
    const structure = atlas?.structures.find((item) => item.id === selectedId)
    if (structure) return { ...structure, kind: 'structure' }
    const landmark = atlas?.landmarks?.find((item) => item.id === selectedId)
    return landmark ? { ...landmark, kind: 'landmark' } : null
  }, [atlas, selectedId])
  const landmarkParent = selected?.kind === 'landmark' ? atlas?.structures.find((item) => item.id === selected.parentStructureId) : null
  const groups = useMemo(() => atlas?.systems.map((system) => ({ id: system.id, label: system.label, count: system.count, color: system.color })) ?? [], [atlas])
  const rows = useMemo<CatalogEntry[]>(() => {
    const entries: CatalogEntry[] = [
      ...(atlas?.structures ?? []).map((item) => ({ ...item, kind: 'structure' as const })),
      ...(atlas?.landmarks ?? []).map((item) => ({ ...item, kind: 'landmark' as const })),
    ]
    return entries.filter((item) => {
      const hierarchy = 'parentPath' in item ? item.parentPath?.join(' ') ?? '' : ''
      const text = `${item.name} ${item.system} ${hierarchy}`.toLowerCase()
      return (!query || text.includes(query.toLowerCase())) && (activeFilter === 'all' || item.system === activeFilter)
    })
  }, [atlas, query, activeFilter])

  const updateVisible = (next: Set<string>) => { setVisible(next); viewer.current?.setVisibleSystems(next) }
  const toggleSystem = (id: string) => { const next = new Set(visible); next.has(id) ? next.delete(id) : next.add(id); updateVisible(next) }
  const setPreset = (preset: 'viscera' | 'muscles' | 'skeleton' | 'all') => {
    if (!atlas) return
    viewer.current?.showAll()
    const next = new Set(atlas.systems.filter((s) => {
      const key = `${s.id} ${s.label}`.toLowerCase()
      if (preset === 'all') return true
      if (preset === 'viscera') return /visceral|digest|respir|urinary|reproductive|endocrine|cardio|nervous|lymph/.test(key)
      if (preset === 'muscles') return /muscle|muscul/.test(key)
      return /skelet/.test(key)
    }).map((s) => s.id))
    updateVisible(next)
  }
  const choose = (id: string) => {
    const entry = rows.find((item) => item.id === id)
    if (entry && !visible.has(entry.system)) updateVisible(new Set(visible).add(entry.system))
    viewer.current?.reveal(id)
    setSelectedId(id); viewer.current?.select(id); setDrawerOpen(false)
  }
  const applyView = (id: ViewDirection) => { setView(id); viewer.current?.setView(id) }
  const applyClip = (axis: ClipAxis) => { setClipAxis(axis); viewer.current?.setClipping(axis, clipFraction / 100) }
  const resetAtlasView = () => {
    const initial = initialVisibleSystems(atlas ?? undefined)
    viewer.current?.showAll(); updateVisible(initial); viewer.current?.select(null); viewer.current?.setView('anterior'); viewer.current?.setClipping('none')
    setSelectedId(null); setView('anterior'); setClipAxis('none'); setOpacities(Object.fromEntries((atlas?.systems ?? []).map((system) => [system.id, 1])))
    atlas?.systems.forEach((system) => viewer.current?.setSystemOpacity(system.id, 1))
  }

  return <main className="app-shell">
    <style>{'@media (min-width:761px){.stage-note{bottom:52px}}@media (max-width:1080px){.inspector:has(.anatomy-mark){transform:none}}@media (max-width:760px){.library{z-index:17}.scrim{z-index:16}.inspector{max-height:40dvh}.app-shell:has(.inspector.has-selection) .stage{height:calc(60dvh - 58px);min-height:0}}'}</style>
    <header className="topbar">
      <button className="brand" aria-label="Corpus home" onClick={resetAtlasView}><span>CORPUS</span><i /> <small>Human anatomy atlas</small></button>
      <div className="topbar-actions"><button className="quiet-button" onClick={() => setInfoOpen(true)}><CircleHelp size={16} /> Source & coverage</button><button className="menu-button" aria-label="Open structure library" onClick={() => setDrawerOpen(true)}><Menu size={20} /></button></div>
    </header>

    <aside className={`library ${drawerOpen ? 'is-open' : ''}`} aria-label="Anatomy library">
      <div className="library-head"><div><span className="eyebrow">INDEX / {atlas?.structures.length ?? 0} STRUCTURES · {atlas?.landmarks?.length ?? 0} LANDMARKS</span><h2>Anatomy library</h2></div><button className="drawer-close" aria-label="Close library" onClick={() => setDrawerOpen(false)}><X size={18} /></button></div>
      <label className="search"><Search size={16}/><input ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search structures" aria-label="Search structures"/><kbd>⌘ K</kbd></label>
      <div className="tabs" role="tablist"><button className="active" onClick={() => setActiveFilter('all')} role="tab">Systems</button></div>
      <div className="filter-list"><button className={activeFilter === 'all' ? 'selected' : ''} onClick={() => setActiveFilter('all')}><span>All entries</span><b>{(atlas?.structures.length ?? 0) + (atlas?.landmarks?.length ?? 0)}</b></button>{groups.map((group) => <button key={group.id} className={activeFilter === group.id ? 'selected' : ''} onClick={() => setActiveFilter(group.id)}><i style={{ background: group.color }} /><span>{group.label}</span><b>{group.count}</b></button>)}</div>
      <div className="system-visibility"><span className="eyebrow">VISIBLE SYSTEMS</span>{atlas?.systems.map((system) => <div className="visibility-row" key={system.id}><button aria-label={`${visible.has(system.id) ? 'Hide' : 'Show'} ${system.label}`} className="eye" onClick={() => toggleSystem(system.id)}>{visible.has(system.id) ? <Eye size={15}/> : <EyeOff size={15}/>}</button><span>{system.label}</span><input aria-label={`${system.label} opacity`} type="range" min="15" max="100" value={(opacities[system.id] ?? 1) * 100} onChange={(event) => { const opacity = Number(event.target.value) / 100; setOpacities({ ...opacities, [system.id]: opacity }); viewer.current?.setSystemOpacity(system.id, opacity) }}/></div>)}</div>
      <div className="structure-results"><div className="result-heading"><span>{rows.length} matching entries</span><span>{Math.min(shown, rows.length)} shown</span></div>{rows.slice(0, shown).map((structure) => <button key={structure.id} className={`structure-row ${selectedId === structure.id ? 'selected' : ''} ${hoveredId === structure.id ? 'hovered' : ''}`} onClick={() => choose(structure.id)}><i style={{ background: systemsById.get(structure.system)?.color ?? '#81979a' }} /><span><b>{displayName(structure.name)}</b><small>{structure.kind === 'landmark' ? 'Surface landmark · ' : ''}{systemsById.get(structure.system)?.label ?? titleCase(structure.system)}</small></span></button>)}{shown < rows.length && <button className="load-more" onClick={() => setShown((count) => count + PAGE_SIZE)}>Load 80 more <ChevronDown size={14}/></button>}</div>
    </aside>
    {drawerOpen && <button className="scrim" aria-label="Close library" onClick={() => setDrawerOpen(false)} />}

    <section className="stage" aria-label="3D anatomy viewer">
      <div className="stage-top"><div><span className="eyebrow">INTERACTIVE MODEL</span><h1>Explore the human body.</h1></div><div className="view-buttons" aria-label="Camera direction">{views.map((item) => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => applyView(item.id)}>{item.label}</button>)}</div></div>
      <div ref={mount} className="viewer-mount" />
      {(!ready || assetBusy) && !error && !assetFailure && <div className="viewer-status"><span className="spinner" />{progress}</div>}
      {ready && assetFailure && !error && <div className="viewer-status error"><span>{assetFailure}</span></div>}
      {error && <div className="viewer-status error"><span>{error}</span><button onClick={() => void load()}>Retry</button></div>}
      <div className="stage-note"><Move3d size={14}/> Drag to rotate · scroll to zoom · select a structure to inspect</div>
      <div className="preset-bar" aria-label="Viewing presets"><span>View</span><button onClick={() => setPreset('viscera')}>Viscera</button><button onClick={() => setPreset('muscles')}>Muscles</button><button onClick={() => setPreset('skeleton')}>Skeleton</button><button onClick={() => setPreset('all')}>All structures</button></div>
      <div className="clip-control"><ScanLine size={15}/><select value={clipAxis} onChange={(event) => applyClip(event.target.value as ClipAxis)} aria-label="Section plane"><option value="none">No section</option><option value="x">Sagittal section</option><option value="y">Transverse section</option><option value="z">Coronal section</option></select>{clipAxis !== 'none' && <input type="range" min="0" max="100" value={clipFraction} aria-label="Section position" onChange={(event) => { const fraction = Number(event.target.value); setClipFraction(fraction); viewer.current?.setClipping(clipAxis, fraction / 100) }} />}</div>
    </section>

    <aside className={`inspector ${selected ? 'has-selection' : ''}`} aria-label="Structure inspector">{selected ? <><div className="inspector-head"><span className="eyebrow">{selected.kind === 'landmark' ? 'SURFACE LANDMARK' : 'SELECTED STRUCTURE'}</span><button onClick={() => { setSelectedId(null); viewer.current?.select(null) }} aria-label="Clear selection"><X size={17}/></button></div><div className="anatomy-mark" style={{ borderColor: systemsById.get(selected.system)?.color }} /><h2>{displayName(selected.name)}</h2><p className="taxonomy">{selected.kind === 'landmark' ? 'Surface landmark' : systemsById.get(selected.system)?.label ?? titleCase(selected.system)}</p>{landmarkParent && <p className="parent-context">Parent bone: {displayName(landmarkParent.name)}</p>}{selected.descriptionOrigin === 'parent_name' && selected.descriptionAppliesTo && <p className="parent-context">Parent context: {displayName(selected.descriptionAppliesTo)}</p>}<p className="description">{selected.description || 'Description unavailable.'}</p><p className="review-status"><CircleHelp size={14}/> {selected.descriptionStatus === 'source_definition_excerpt' ? 'Source excerpt · unreviewed' : selected.descriptionStatus === 'editorial_unreviewed' ? 'Editorial description · unreviewed' : 'Description unavailable'}</p>{selected.descriptionSourceUrls?.filter((url) => /^https?:\/\//.test(url)).map((url) => <a key={url} className="description-source" href={url} target="_blank" rel="noreferrer">Description source <ChevronRight size={13}/></a>)}<div className="inspector-actions"><button onClick={() => viewer.current?.focus(selected.id)}><Focus size={15}/> Focus</button><button onClick={() => viewer.current?.isolate(selected.id)}><Box size={15}/> Isolate</button><button onClick={() => viewer.current?.hide(selected.id)}><EyeOff size={15}/> Hide</button></div></> : <div className="empty-inspector"><Layers3 size={25}/><span className="eyebrow">INSPECTOR</span><h2>Select a structure</h2><p>Choose any anatomical structure in the model or library to read its source description.</p></div>}<div className="inspector-bottom"><button onClick={() => { viewer.current?.showAll(); atlas && updateVisible(new Set(atlas.systems.map((s) => s.id))) }}><Eye size={15}/> Show all</button><button onClick={() => { const initial = initialVisibleSystems(atlas ?? undefined); viewer.current?.showAll(); updateVisible(initial); viewer.current?.select(null); viewer.current?.setView('anterior'); viewer.current?.setClipping('none'); setSelectedId(null); setView('anterior'); setClipAxis('none'); setOpacities(Object.fromEntries((atlas?.systems ?? []).map((s) => [s.id, 1]))); atlas?.systems.forEach((s) => viewer.current?.setSystemOpacity(s.id, 1)) }}><RotateCcw size={15}/> Reset view</button></div></aside>
    <footer className="footer"><span>Original geometry: Z-Anatomy</span><button onClick={() => setInfoOpen(true)}>Source & coverage <ChevronRight size={13}/></button></footer>
    {infoOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setInfoOpen(false)}><section className="info-modal" role="dialog" aria-modal="true" aria-labelledby="source-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setInfoOpen(false)} aria-label="Close source and coverage"><X size={18}/></button><span className="eyebrow">EDITORIAL NOTE / 01</span><h2 id="source-title">Source & coverage</h2><p>This atlas uses original open anatomy geometry, currently an original male model. A corresponding female model is absent; coverage is incomplete.</p><dl><dt>Geometry source</dt><dd>{atlas?.source?.url ? <a href={atlas.source.url} target="_blank" rel="noreferrer">{atlas.source.name}</a> : atlas?.source?.name || 'Z-Anatomy'}</dd><dt>License</dt><dd>{atlas?.source?.license || 'See source documentation. Individual subassets may carry distinct restrictions.'}</dd><dt>Descriptions</dt><dd>Source and Wikipedia-derived entries; they have not been independently verified against Netter.</dd></dl><p>Netter plate-by-plate audit is pending. No Netter plates are copied here. Use the <a href="https://www.us.elsevierhealth.com/media/wysiwyg/PDF/NetterAtlas9e_3DcorrelatesCompleteAnatomy.pdf" target="_blank" rel="noreferrer">official Netter 9e 3D-correlates checklist</a> as a public reference for future review.</p><button className="modal-done" onClick={() => setInfoOpen(false)}>Return to atlas</button></section></div>}
  </main>
}
