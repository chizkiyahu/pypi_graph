import { useEffect, useRef, useState } from 'preact/hooks'
import './app.css'
import { createBrowserCacheStore } from './lib/cache.ts'
import { detectBrowserPlatform, formatPlatformOption } from './lib/platforms.ts'
import { getDefaultInputs, readInputsFromUrl, writeInputsToUrl } from './lib/url-state.ts'
import { normalizePackageName } from './lib/versions.ts'
import type {
  GraphDirection,
  PlatformOption,
  ResolutionInputs,
  ResolutionProgress,
  ResolutionResult,
  RootOptions,
} from './types.ts'

type GraphCanvasComponent = typeof import('./components/GraphCanvas.tsx')['GraphCanvas']
type PypiClient = ReturnType<typeof import('./lib/pypi.ts')['createPypiClient']>
type ResolveDependencyGraph = typeof import('./lib/resolver.ts')['resolveDependencyGraph']

const SAMPLE_PACKAGES = ['fastapi', 'httpx', 'apache-airflow', 'pydantic']
const GRAPH_STATUS_NOTICE_DELAY_MS = 1000

function SvgSprite() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">
      <symbol id="github-icon" viewBox="0 0 16 16">
        <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
      </symbol>
      <symbol id="external-link-icon" viewBox="0 0 16 16">
        <path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M6 3h7v7"/>
        <path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M13 3 6.5 9.5"/>
      </symbol>
    </svg>
  )
}

export function App() {
  const cacheRef = useRef(createBrowserCacheStore())
  const clientRef = useRef<PypiClient | null>(null)
  const resolveDependencyGraphRef = useRef<ResolveDependencyGraph | null>(null)
  const initialInputsRef = useRef(
    typeof window === 'undefined' ? getDefaultInputs() : readInputsFromUrl(),
  )
  const initialUrlHasPlatformRef = useRef(
    typeof window !== 'undefined' && Boolean(new URLSearchParams(window.location.search).get('platform')?.trim()),
  )
  const initialInputs = initialInputsRef.current

  const [GraphCanvasComponent, setGraphCanvasComponent] = useState<GraphCanvasComponent | null>(null)
  const [inputs, setInputs] = useState<ResolutionInputs>(initialInputs)
  const [result, setResult] = useState<ResolutionResult | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    initialInputs.packageName ? 'loading' : 'idle',
  )
  const [progress, setProgress] = useState<ResolutionProgress | null>(
    initialInputs.packageName ? createPendingProgress(initialInputs.packageName) : null,
  )
  const [error, setError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [graphDirection, setGraphDirection] = useState<GraphDirection>('top-bottom')
  const [showAllEdgeLabels, setShowAllEdgeLabels] = useState(false)
  const [cacheResetting, setCacheResetting] = useState(false)
  const [graphCanvasLoadError, setGraphCanvasLoadError] = useState<string | null>(null)
  const [showDelayedGraphProgress, setShowDelayedGraphProgress] = useState(false)
  const latestRequestId = useRef(0)
  const syncingInputsRef = useRef(false)
  const inputsRef = useRef(initialInputs)

  useEffect(() => {
    inputsRef.current = inputs
  }, [inputs])

  useEffect(() => {
    writeInputsToUrl(inputs)
  }, [inputs])

  useEffect(() => {
    if (initialUrlHasPlatformRef.current) {
      return
    }

    let cancelled = false

    void detectBrowserPlatform().then((detectedPlatform) => {
      if (cancelled || detectedPlatform === initialInputs.platform) {
        return
      }

      const currentInputs = inputsRef.current
      if (currentInputs.platform !== initialInputs.platform) {
        return
      }

      const nextInputs = { ...currentInputs, platform: detectedPlatform }
      setInputs(nextInputs)

      if (nextInputs.packageName.trim()) {
        void runResolution(nextInputs)
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!initialInputs.packageName.trim()) {
      return
    }

    void runResolution(initialInputs)
  }, [])

  useEffect(() => {
    if ((status !== 'loading' && !result) || GraphCanvasComponent || graphCanvasLoadError) {
      return
    }

    let cancelled = false

    void import('./components/GraphCanvas.tsx')
      .then((module) => {
        if (cancelled) {
          return
        }

        setGraphCanvasComponent(() => module.GraphCanvas)
      })
      .catch(() => {
        if (cancelled) {
          return
        }

        setGraphCanvasLoadError('The interactive graph renderer could not be loaded.')
      })

    return () => {
      cancelled = true
    }
  }, [GraphCanvasComponent, graphCanvasLoadError, result, status])

  useEffect(() => {
    if (status !== 'loading' || !result) {
      setShowDelayedGraphProgress(false)
      return
    }

    const timeoutId = window.setTimeout(() => {
      setShowDelayedGraphProgress(true)
    }, GRAPH_STATUS_NOTICE_DELAY_MS)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [result, status])

  async function ensureResolutionEngine() {
    const [pypiModule, resolverModule] = await Promise.all([
      import('./lib/pypi.ts'),
      import('./lib/resolver.ts'),
    ])

    if (!clientRef.current) {
      clientRef.current = pypiModule.createPypiClient({ cache: cacheRef.current })
    }

    if (!resolveDependencyGraphRef.current) {
      resolveDependencyGraphRef.current = resolverModule.resolveDependencyGraph
    }

    const client = clientRef.current
    const resolveDependencyGraph = resolveDependencyGraphRef.current

    if (!client || !resolveDependencyGraph) {
      throw new Error('The dependency resolver could not be initialized.')
    }

    return {
      client,
      resolveDependencyGraph,
    }
  }

  async function runResolution(nextInputs: ResolutionInputs) {
    const requestId = latestRequestId.current + 1
    latestRequestId.current = requestId
    setStatus('loading')
    setProgress(createPendingProgress(nextInputs.packageName))
    setError(null)
    setSelectedNodeId(null)

    try {
      const { client, resolveDependencyGraph } = await ensureResolutionEngine()
      const nextResult = await resolveDependencyGraph(nextInputs, client, {
        onProgress(nextProgress) {
          if (latestRequestId.current !== requestId) {
            return
          }

          setProgress(nextProgress)
        },
      })
      if (latestRequestId.current !== requestId) {
        return
      }
      if (!sameResolutionInputs(nextInputs, nextResult.effectiveInputs)) {
        syncingInputsRef.current = true
        setInputs(nextResult.effectiveInputs)
      }
      setResult(nextResult)
      setProgress(null)
      setStatus('ready')
    } catch (resolveError) {
      if (latestRequestId.current !== requestId) {
        return
      }
      setProgress(null)
      setStatus('error')
      setError(resolveError instanceof Error ? resolveError.message : 'The graph could not be built.')
    }
  }

  function updateInputs(mutator: (current: ResolutionInputs) => ResolutionInputs) {
    setInputs((current) => mutator(current))
  }

  function handleSubmit(event: Event) {
    event.preventDefault()
    void runResolution(inputs)
  }

  function handlePlatformChange(platform: PlatformOption) {
    updateInputs((current) => ({ ...current, platform }))
  }

  function handleVersionOverride(packageName: string, version: string) {
    updateInputs((current) => {
      const manualVersions = { ...current.manualVersions }
      const normalizedName = normalizePackageName(packageName)
      if (version) {
        manualVersions[normalizedName] = version
      } else {
        delete manualVersions[normalizedName]
      }
      return {
        ...current,
        manualVersions,
      }
    })
  }

  function handleQuickStart(packageName: string) {
    const nextInputs: ResolutionInputs = {
      ...inputs,
      packageName,
      rootVersion: null,
      extras: [],
      manualVersions: {},
    }
    setInputs(nextInputs)
    setMenuOpen(false)
    void runResolution(nextInputs)
  }

  function handleReset() {
    const nextInputs = getDefaultInputs()
    setInputs(nextInputs)
    setResult(null)
    setSelectedNodeId(null)
    setStatus('idle')
    setProgress(null)
    setError(null)
    setMenuOpen(false)
  }

  async function handleResetCache() {
    setCacheResetting(true)
    setError(null)

    try {
      await cacheRef.current.clear()
      if (inputs.packageName.trim()) {
        await runResolution(inputs)
      }
    } catch (cacheError) {
      setError(cacheError instanceof Error ? cacheError.message : 'The local cache could not be cleared.')
    } finally {
      setCacheResetting(false)
    }
  }

  function handleDownloadResult(format: 'json' | 'md') {
    if (!result) {
      return
    }

    const safeName = normalizePackageName(result.effectiveInputs.packageName || 'dependency-graph')
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const extension = format === 'json' ? 'json' : 'md'
    const filename = `${safeName}-dependency-graph-${timestamp}.${extension}`
    const content =
      format === 'json'
        ? JSON.stringify(createSerializableResult(result), null, 2)
        : createMarkdownReport(result)
    const mimeType = format === 'json' ? 'application/json' : 'text/markdown'

    downloadTextFile(filename, content, mimeType)
  }

  useEffect(() => {
    if (syncingInputsRef.current) {
      syncingInputsRef.current = false
      return
    }

    if (!result || !inputs.packageName.trim()) {
      return
    }

    void runResolution(inputs)
  }, [
    inputs.extras.join(','),
    JSON.stringify(inputs.manualVersions),
    inputs.platform,
    inputs.pythonVersion,
    inputs.rootVersion,
  ])

  const hasFreshResult =
    result !== null &&
    normalizePackageName(inputs.packageName) === normalizePackageName(result.effectiveInputs.packageName)
  const editableRootOptions = hasFreshResult ? result?.rootOptions ?? null : null
  const displayedInputs = result?.effectiveInputs ?? inputs
  const displayedRootOptions = result?.rootOptions ?? null
  const extras = editableRootOptions?.extras ?? []
  const availableRootVersions = editableRootOptions?.availableVersions ?? []
  const pythonOptions = editableRootOptions?.supportedPythonVersions ?? []
  const platformOptions = editableRootOptions?.supportedPlatforms ?? []
  const showVersionSelector = Boolean(editableRootOptions?.showVersionSelector)
  const showPythonSelector = Boolean(editableRootOptions?.showPythonSelector)
  const showPlatformSelector = Boolean(editableRootOptions?.showPlatformSelector)
  const selectedNode =
    selectedNodeId && result ? result.nodes.find((node) => node.id === selectedNodeId) ?? null : null
  const rootNode =
    result?.rootId ? result.nodes.find((node) => node.id === result.rootId) ?? null : null
  const activeEnvironment = collectActiveEnvironment(displayedInputs, displayedRootOptions, rootNode?.displayVersion ?? null)
  const loadingProgress = status === 'loading' ? progress ?? createPendingProgress(inputs.packageName) : null
  const landingProgress = !result ? loadingProgress : null
  const graphProgress = result && showDelayedGraphProgress ? loadingProgress : null

  useEffect(() => {
    if (!result) {
      setMenuOpen(false)
    }
  }, [result])

  if (!result) {
    return (
      <div class="shell landing-shell">
        <SvgSprite />
        <div class="ambient ambient-left" />
        <div class="ambient ambient-right" />

        <main class="landing-stage">
          <section class="panel landing-card">
            <p class="eyebrow">Python Dependency Graph Visualizer</p>
            <h1>Visualize any Python package's dependency tree</h1>
            <p class="landing-copy">Enter a PyPI package name to explore its full dependency graph — resolve versions, extras, and platform constraints interactively. No installation required.</p>

            <form class="landing-form" onSubmit={handleSubmit}>
              <input
                value={inputs.packageName}
                onInput={(event) =>
                  updateInputs((current) => ({
                    ...current,
                    packageName: (event.currentTarget as HTMLInputElement).value,
                  }))}
                placeholder="e.g. fastapi, django, requests…"
                spellcheck={false}
              />
              <button class="primary landing-submit" type="submit" disabled={!inputs.packageName.trim() || status === 'loading'}>
                {status === 'loading' ? 'Resolving…' : 'Build dependency graph'}
              </button>
            </form>

            <div class="landing-samples">
              <span class="subtle-label">Try a popular package</span>
              {SAMPLE_PACKAGES.map((sample) => (
                <button class="sample-link" type="button" onClick={() => handleQuickStart(sample)}>
                  {sample}
                </button>
              ))}
            </div>

            {landingProgress ? <ResolutionStatusNotice progress={landingProgress} /> : null}

            {error ? (
              <div class="inline-error">
                <strong>Resolution failed.</strong>
                <span>{error}</span>
              </div>
            ) : null}

            <div class="landing-footer">
              <a href="https://github.com/chizkiyahu/pypi_graph" target="_blank" rel="noopener noreferrer" class="social-link" aria-label="View source code on GitHub">
                <svg width="20" height="20" aria-hidden="true"><use href="#github-icon" /></svg>
                Source on GitHub
              </a>
            </div>
          </section>
        </main>
      </div>
    )
  }

  const graphMetrics = [
    { label: 'Nodes', value: result.nodes.length },
    { label: 'Edges', value: result.edges.length },
    { label: 'API calls', value: result.limits.networkRequests },
    { label: 'Cache hits', value: result.limits.cacheHits },
  ]

  const renderMeta = () => (
    <>
      <div class="stage-badges stage-metrics">
        {graphMetrics.map((metric) => (
          <span class="summary-chip metric-chip">
            <strong>{metric.value}</strong> {metric.label}
          </span>
        ))}
      </div>
      <div class="stage-badges">
        {activeEnvironment.map((item) => (
          <span class="summary-chip">{item}</span>
        ))}
      </div>
      <div class="stage-badges">
        <span class="summary-chip">{result.limits.cycleEdges} cycle edges</span>
        <span class="summary-chip">{result.limits.unresolvedNodes} unresolved</span>
        <span class="summary-chip">{result.limits.skippedDirectReferences} direct refs</span>
      </div>
    </>
  )

  return (
      <div class="shell workspace-shell">
        <SvgSprite />
        <div class="ambient ambient-left" />
      <div class="ambient ambient-right" />

      <button
        class={menuOpen ? 'menu-toggle active hidden' : 'menu-toggle'}
        type="button"
        onClick={() => setMenuOpen((current) => !current)}
        aria-label="Open settings"
      >
        <span />
        <span />
        <span />
      </button>

      {menuOpen ? (
        <button class="drawer-backdrop" type="button" onClick={() => setMenuOpen(false)} aria-label="Close settings" />
      ) : null}

      <aside class={menuOpen ? 'panel settings-drawer open' : 'panel settings-drawer'}>
        <div class="drawer-head">
          <div>
            <p class="eyebrow">Settings</p>
            <p class="drawer-title">Resolution settings</p>
          </div>
          <button class="icon-button" type="button" onClick={() => setMenuOpen(false)}>
            Close
          </button>
        </div>

        <form class="drawer-form" onSubmit={handleSubmit}>
          <label class="field">
            <span>Package</span>
            <input
              value={inputs.packageName}
              onInput={(event) =>
                updateInputs((current) => ({
                  ...current,
                  packageName: (event.currentTarget as HTMLInputElement).value,
                }))}
              placeholder="Enter a PyPI package name"
              spellcheck={false}
            />
          </label>

          {showVersionSelector ? (
            <label class="field">
              <span>Package version</span>
              <select
                value={inputs.rootVersion ?? ''}
                onChange={(event) =>
                  updateInputs((current) => ({
                    ...current,
                    rootVersion: (event.currentTarget as HTMLSelectElement).value || null,
                  }))}
              >
                <option value="">Latest stable release</option>
                {availableRootVersions.map((version) => (
                  <option value={version}>{version}</option>
                ))}
              </select>
            </label>
          ) : null}

          {showPythonSelector ? (
            <div class="field">
              <span>Python</span>
              <div class="pill-row">
                {pythonOptions.map((version) => (
                  <button
                    type="button"
                    class={version === inputs.pythonVersion ? 'pill active' : 'pill'}
                    onClick={() =>
                      updateInputs((current) => ({
                        ...current,
                        pythonVersion: version,
                      }))}
                  >
                    {version}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {showPlatformSelector ? (
            <div class="field">
              <span>Platform</span>
              <div class="pill-row">
                {platformOptions.map((platform) => (
                  <button
                    type="button"
                    class={platform === inputs.platform ? 'pill active' : 'pill'}
                    onClick={() => handlePlatformChange(platform)}
                  >
                    {formatPlatformOption(platform)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {extras.length > 0 ? (
            <div class="field">
              <span>Top-level extras</span>
              <div class="extras-grid">
                {extras.map((extra) => {
                  const active = inputs.extras.includes(extra)
                  return (
                    <label class={active ? 'chip active' : 'chip'}>
                      <input
                        class="chip-input"
                        type="checkbox"
                        checked={active}
                        onChange={(event) => {
                          const enabled = (event.currentTarget as HTMLInputElement).checked
                          updateInputs((current) => ({
                            ...current,
                            extras: enabled
                              ? [...new Set([...current.extras, extra])].sort((left, right) =>
                                  left.localeCompare(right),
                                )
                              : current.extras.filter((value) => value !== extra),
                          }))
                        }}
                      />
                      <span class="checkbox-box" aria-hidden="true" />
                      <span class="chip-label">{extra}</span>
                    </label>
                  )
                })}
              </div>
            </div>
          ) : null}

          <div class="field">
            <span>Graph direction</span>
            <div class="pill-row">
              <button
                type="button"
                class={graphDirection === 'top-bottom' ? 'pill active' : 'pill'}
                onClick={() => setGraphDirection('top-bottom')}
              >
                Top to bottom
              </button>
              <button
                type="button"
                class={graphDirection === 'left-right' ? 'pill active' : 'pill'}
                onClick={() => setGraphDirection('left-right')}
              >
                Left to right
              </button>
            </div>
          </div>

          <div class="field">
            <span>Graph labels</span>
            <label class={showAllEdgeLabels ? 'chip active drawer-toggle' : 'chip drawer-toggle'}>
              <input
                class="chip-input"
                type="checkbox"
                checked={showAllEdgeLabels}
                onChange={(event) => setShowAllEdgeLabels((event.currentTarget as HTMLInputElement).checked)}
              />
              <span class="checkbox-box" aria-hidden="true" />
              <span class="chip-label">Show all dependency edge labels</span>
            </label>
          </div>

          <div class="drawer-actions">
            <button class="primary" type="submit" disabled={!inputs.packageName.trim() || status === 'loading'}>
              {status === 'loading' ? 'Resolving...' : 'Rebuild'}
            </button>
            <button class="secondary" type="button" onClick={handleReset}>
              Reset
            </button>
            <button
              class="secondary"
              type="button"
              onClick={() => void handleResetCache()}
              disabled={cacheResetting || status === 'loading'}
            >
              {cacheResetting ? 'Clearing cache...' : 'Reset cache'}
            </button>
          </div>
        </form>

        <div class="drawer-meta mobile-meta">
          <span class="subtle-label">Graph metadata</span>
          <div class="drawer-meta-content">
            {renderMeta()}
          </div>
        </div>

        <div class="drawer-footer">
          <span class="subtle-label">Quick starts</span>
          <div class="drawer-samples">
            {SAMPLE_PACKAGES.map((sample) => (
              <button class="sample-link" type="button" onClick={() => handleQuickStart(sample)}>
                {sample}
              </button>
            ))}
          </div>
          <div class="drawer-footer-links">
            <div class="export-actions">
              <button class="graph-tool" type="button" onClick={() => handleDownloadResult('json')}>
                Export JSON
              </button>
              <button class="graph-tool" type="button" onClick={() => handleDownloadResult('md')}>
                Export Markdown
              </button>
            </div>
            <a href="https://github.com/chizkiyahu/pypi_graph" target="_blank" rel="noopener noreferrer" class="social-link" aria-label="View source code on GitHub">
              <svg width="20" height="20" aria-hidden="true"><use href="#github-icon" /></svg>
              Source on GitHub
              <svg width="14" height="14" aria-hidden="true" class="external-arrow"><use href="#external-link-icon" /></svg>
            </a>
          </div>
        </div>
      </aside>

      <main class="workspace-main">
        {error ? (
          <div class="inline-error floating-error">
            <strong>Resolution failed.</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <section class="panel graph-stage">
          <div class="graph-stage-header">
            <div class="graph-stage-title">
              <button class="home-link" type="button" onClick={handleReset} title="Back to home">
                <p class="section-kicker">Dependency graph</p>
              </button>
              <h2>{result.effectiveInputs.packageName}</h2>
            </div>

            <div class="graph-stage-actions desktop-meta">
              <div class="stage-badges stage-badges-compact">
                {graphMetrics.map((metric) => (
                  <span class="summary-chip metric-chip">
                    <strong>{metric.value}</strong> {metric.label}
                  </span>
                ))}
                {activeEnvironment.map((item) => (
                  <span class="summary-chip">{item}</span>
                ))}
              </div>
              <a href="https://github.com/chizkiyahu/pypi_graph" target="_blank" rel="noopener noreferrer" class="social-link github-header-link" title="View source on GitHub" aria-label="View source on GitHub">
                <svg width="20" height="20" aria-hidden="true"><use href="#github-icon" /></svg>
                GitHub
                <svg width="14" height="14" aria-hidden="true" class="external-arrow"><use href="#external-link-icon" /></svg>
              </a>
              <button class="graph-tool" type="button" onClick={() => handleDownloadResult('json')}>
                Export JSON
              </button>
              <button class="graph-tool" type="button" onClick={() => handleDownloadResult('md')}>
                Export Markdown
              </button>
            </div>
          </div>

          <div class="graph-stage-body">
            {graphProgress ? <ResolutionStatusNotice progress={graphProgress} compact /> : null}

            <div class="graph-frame">
              {GraphCanvasComponent ? (
                <GraphCanvasComponent
                  nodes={result.nodes}
                  edges={result.edges}
                  rootId={result.rootId}
                  selectedNodeId={selectedNodeId}
                  direction={graphDirection}
                  showAllEdgeLabels={showAllEdgeLabels}
                  onSelectNode={setSelectedNodeId}
                />
              ) : (
                <div class="graph-empty">{graphCanvasLoadError ?? 'Loading interactive graph…'}</div>
              )}
            </div>
          </div>
        </section>

        {selectedNode ? (
          <aside class="inspector-sheet">
            <NodeInspector
              node={selectedNode}
              rootId={result.rootId}
              onClose={() => setSelectedNodeId(null)}
              onOverrideChange={(version) => {
                handleVersionOverride(selectedNode.packageName, version)
              }}
            />
          </aside>
        ) : null}
      </main>
    </div>
  )
}

interface NodeInspectorProps {
  node: ResolutionResult['nodes'][number]
  rootId: string | null
  onClose: () => void
  onOverrideChange: (value: string) => void
}

interface ResolutionStatusNoticeProps {
  progress: ResolutionProgress
  compact?: boolean
}

function ResolutionStatusNotice(props: ResolutionStatusNoticeProps) {
  return (
    <section
      class={props.compact ? 'inline-status inline-status-compact' : 'inline-status'}
      aria-live="polite"
      aria-atomic="true"
    >
      <div class="status-head">
        <span class="status-pill">
          <span class="status-pulse" aria-hidden="true" />
          {formatResolutionPhase(props.progress.phase)}
        </span>
        {props.progress.currentPackage ? <span class="status-current">{props.progress.currentPackage}</span> : null}
      </div>
      <p class="status-message">{props.progress.message}</p>
      <div class="status-metrics">
        <span>{props.progress.nodesDiscovered} nodes</span>
        <span>{props.progress.edgesDiscovered} edges</span>
        <span>{props.progress.networkRequests} API calls</span>
        <span>{props.progress.cacheHits} cache hits</span>
        {props.progress.depth !== null ? <span>depth {props.progress.depth}</span> : null}
      </div>
    </section>
  )
}

function NodeInspector(props: NodeInspectorProps) {
  const canOverride = props.node.kind === 'package' && props.node.id !== props.rootId
  const overrideValue = props.node.manualOverride ?? ''

  return (
    <div class="inspector">
      <div class="inspector-head">
        <div>
          <p class="section-kicker">Inspector</p>
          <p class="node-title">
            <a
              href={`https://pypi.org/project/${props.node.packageName}/${props.node.displayVersion}/`}
              target="_blank"
              rel="noopener noreferrer"
              class="pypi-link"
              title={`View ${props.node.packageName} ${props.node.displayVersion} on PyPI`}
            >
              {props.node.packageName} <span>{props.node.displayVersion}</span>
              <svg width="14" height="14" aria-hidden="true" class="external-arrow"><use href="#external-link-icon" /></svg>
            </a>
          </p>
        </div>
        <button class="icon-button" type="button" onClick={props.onClose}>
          Close
        </button>
      </div>

      <div class="inspector-body">
        <p class="node-summary">{props.node.summary}</p>

        <div class="detail-block">
          <span>Node details</span>
          <ul class="plain-list">
            <li>
              <strong>Extras on this node</strong>{' '}
              {props.node.selectedExtras.length ? props.node.selectedExtras.join(', ') : 'none'}
            </li>
            <li>
              <strong>Requires Python</strong> {props.node.requiresPython ?? 'not declared'}
            </li>
            <li>
              <strong>Constraint fragments</strong> {props.node.combinedSpecifiers.join(', ') || 'none'}
            </li>
            <li>
              <strong>Metadata source</strong> {props.node.cacheSource}
            </li>
          </ul>
        </div>

        {canOverride ? (
          <label class="field">
            <span>Manual version override</span>
            <select
              value={overrideValue}
              onChange={(event) =>
                props.onOverrideChange((event.currentTarget as HTMLSelectElement).value)}
            >
              <option value="">Auto select latest legal version</option>
              {props.node.availableVersions.slice(0, 120).map((version) => (
                <option value={version}>{version}</option>
              ))}
            </select>
          </label>
        ) : null}

        {props.node.incomingRequirements.length > 0 ? (
          <div class="detail-block">
            <span>Incoming requirements</span>
            <ul class="detail-list">
              {props.node.incomingRequirements.map((requirement) => (
                <li>{requirement}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {props.node.inactiveRequirements.length > 0 ? (
          <div class="detail-block">
            <span>Excluded in this view</span>
            <ul class="detail-list muted">
              {props.node.inactiveRequirements.slice(0, 12).map((requirement) => (
                <li>
                  <strong>{requirement.raw}</strong>
                  <small>{requirement.reason}</small>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {props.node.notes.length > 0 ? (
          <div class="detail-block">
            <span>Notes</span>
            <ul class="detail-list">
              {props.node.notes.map((note) => (
                <li>{note}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function sameResolutionInputs(left: ResolutionInputs, right: ResolutionInputs): boolean {
  return (
    left.packageName === right.packageName &&
    left.rootVersion === right.rootVersion &&
    left.pythonVersion === right.pythonVersion &&
    left.platform === right.platform &&
    left.extras.join(',') === right.extras.join(',') &&
    JSON.stringify(left.manualVersions) === JSON.stringify(right.manualVersions)
  )
}

function createPendingProgress(packageName: string): ResolutionProgress {
  const trimmedPackageName = packageName.trim()

  return {
    phase: 'initializing',
    message: trimmedPackageName ? `Preparing to resolve ${trimmedPackageName}…` : 'Preparing dependency resolution…',
    currentPackage: trimmedPackageName || null,
    depth: 0,
    nodesDiscovered: 0,
    edgesDiscovered: 0,
    cacheHits: 0,
    networkRequests: 0,
  }
}

function formatResolutionPhase(phase: ResolutionProgress['phase']): string {
  switch (phase) {
    case 'initializing':
      return 'Preparing'
    case 'loading-metadata':
      return 'Loading metadata'
    case 'analyzing-environment':
      return 'Checking environments'
    case 'resolving-graph':
      return 'Resolving graph'
    case 'complete':
      return 'Complete'
  }
}

function collectActiveEnvironment(
  inputs: ResolutionInputs,
  rootOptions: RootOptions | null,
  resolvedRootVersion: string | null,
): string[] {
  const summary: string[] = []

  if (resolvedRootVersion) {
    summary.push(`version ${resolvedRootVersion}`)
  }
  if (rootOptions?.showPythonSelector) {
    summary.push(`py ${inputs.pythonVersion}`)
  }
  if (rootOptions?.showPlatformSelector) {
    summary.push(formatPlatformOption(inputs.platform))
  }
  if ((rootOptions?.extras.length ?? 0) > 0) {
    summary.push(inputs.extras.length > 0 ? `extras ${inputs.extras.join(', ')}` : 'extras none')
  }

  return summary
}

function createSerializableResult(result: ResolutionResult) {
  return {
    generatedAt: new Date().toISOString(),
    packageName: result.effectiveInputs.packageName,
    effectiveInputs: result.effectiveInputs,
    rootId: result.rootId,
    nodes: result.nodes,
    edges: result.edges,
    insights: result.insights,
    limits: result.limits,
    rootOptions: result.rootOptions,
  }
}

function createMarkdownReport(result: ResolutionResult): string {
  const lines: string[] = []
  lines.push(`# Dependency Graph Report: ${result.effectiveInputs.packageName}`)
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  lines.push('## Resolution inputs')
  lines.push('')
  lines.push(`- Package: \`${result.effectiveInputs.packageName}\``)
  lines.push(`- Root version: \`${result.effectiveInputs.rootVersion ?? 'latest stable'}\``)
  lines.push(`- Python: \`${result.effectiveInputs.pythonVersion}\``)
  lines.push(`- Platform: \`${result.effectiveInputs.platform}\``)
  lines.push(
    `- Extras: ${result.effectiveInputs.extras.length ? result.effectiveInputs.extras.map((extra) => `\`${extra}\``).join(', ') : 'none'}`,
  )
  lines.push('')
  lines.push('## Graph summary')
  lines.push('')
  lines.push(`- Nodes: **${result.nodes.length}**`)
  lines.push(`- Edges: **${result.edges.length}**`)
  lines.push(`- API calls: **${result.limits.networkRequests}**`)
  lines.push(`- Cache hits: **${result.limits.cacheHits}**`)
  lines.push(`- Unresolved nodes: **${result.limits.unresolvedNodes}**`)
  lines.push(`- Cycle edges: **${result.limits.cycleEdges}**`)
  lines.push('')
  lines.push('## Nodes')
  lines.push('')
  lines.push('| Package | Version | Kind | Depth | Requires Python |')
  lines.push('| --- | --- | --- | ---: | --- |')
  for (const node of result.nodes) {
    lines.push(
      `| ${node.packageName} | ${node.displayVersion} | ${node.kind} | ${node.depth} | ${node.requiresPython ?? '—'} |`,
    )
  }
  lines.push('')
  lines.push('## Edges')
  lines.push('')
  lines.push('| From | To | Requirement |')
  lines.push('| --- | --- | --- |')
  for (const edge of result.edges) {
    lines.push(`| ${edge.source} | ${edge.target} | \`${edge.requirement}\` |`)
  }
  lines.push('')

  return lines.join('\n')
}

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
