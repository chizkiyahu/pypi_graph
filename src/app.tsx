import { useEffect, useRef, useState } from 'preact/hooks'
import './app.css'
import { GraphCanvas } from './components/GraphCanvas.tsx'
import { createBrowserCacheStore } from './lib/cache.ts'
import { formatPlatformOption } from './lib/platforms.ts'
import { createPypiClient } from './lib/pypi.ts'
import { resolveDependencyGraph } from './lib/resolver.ts'
import { getDefaultInputs, readInputsFromUrl, writeInputsToUrl } from './lib/url-state.ts'
import { normalizePackageName } from './lib/versions.ts'
import type {
  GraphDirection,
  PlatformOption,
  ResolutionInputs,
  ResolutionResult,
  RootOptions,
} from './types.ts'

const SAMPLE_PACKAGES = ['fastapi', 'httpx', 'apache-airflow', 'pydantic']

export function App() {
  const cacheRef = useRef(createBrowserCacheStore())
  const clientRef = useRef(createPypiClient({ cache: cacheRef.current }))
  const initialInputsRef = useRef(
    typeof window === 'undefined' ? getDefaultInputs() : readInputsFromUrl(),
  )
  const initialInputs = initialInputsRef.current

  const [inputs, setInputs] = useState<ResolutionInputs>(initialInputs)
  const [result, setResult] = useState<ResolutionResult | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    initialInputs.packageName ? 'loading' : 'idle',
  )
  const [error, setError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [graphDirection, setGraphDirection] = useState<GraphDirection>('top-bottom')
  const [showAllEdgeLabels, setShowAllEdgeLabels] = useState(false)
  const [cacheResetting, setCacheResetting] = useState(false)
  const latestRequestId = useRef(0)
  const syncingInputsRef = useRef(false)

  useEffect(() => {
    writeInputsToUrl(inputs)
  }, [inputs])

  useEffect(() => {
    if (!initialInputs.packageName.trim()) {
      return
    }

    void runResolution(initialInputs)
  }, [])

  async function runResolution(nextInputs: ResolutionInputs) {
    const requestId = latestRequestId.current + 1
    latestRequestId.current = requestId
    setStatus('loading')
    setError(null)
    setSelectedNodeId(null)

    try {
      const nextResult = await resolveDependencyGraph(nextInputs, clientRef.current)
      if (latestRequestId.current !== requestId) {
        return
      }
      if (!sameResolutionInputs(nextInputs, nextResult.effectiveInputs)) {
        syncingInputsRef.current = true
        setInputs(nextResult.effectiveInputs)
      }
      setResult(nextResult)
      setStatus('ready')
    } catch (resolveError) {
      if (latestRequestId.current !== requestId) {
        return
      }
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

  useEffect(() => {
    if (!result) {
      setMenuOpen(false)
    }
  }, [result])

  if (!result) {
    return (
      <div class="shell landing-shell">
        <div class="ambient ambient-left" />
        <div class="ambient ambient-right" />

        <main class="landing-stage">
          <section class="panel landing-card">
            <p class="eyebrow">PyPI DepGraph</p>
            <h1>Enter a package name.</h1>
            <p class="landing-copy">Visualize the full dependency tree. Advanced settings appear after the package metadata loads.</p>

            <form class="landing-form" onSubmit={handleSubmit}>
              <input
                value={inputs.packageName}
                onInput={(event) =>
                  updateInputs((current) => ({
                    ...current,
                    packageName: (event.currentTarget as HTMLInputElement).value,
                  }))}
                placeholder="fastapi"
                spellcheck={false}
              />
              <button class="primary landing-submit" type="submit" disabled={!inputs.packageName.trim() || status === 'loading'}>
                {status === 'loading' ? 'Resolving...' : 'Build graph'}
              </button>
            </form>

            <div class="landing-samples">
              <span class="subtle-label">Try one</span>
              {SAMPLE_PACKAGES.map((sample) => (
                <button class="sample-link" type="button" onClick={() => handleQuickStart(sample)}>
                  {sample}
                </button>
              ))}
            </div>

            {error ? (
              <div class="inline-error">
                <strong>Resolution failed.</strong>
                <span>{error}</span>
              </div>
            ) : null}

            <div class="landing-footer">
              <a href="https://github.com/chizkiyahu/pypi_graph" target="_blank" rel="noopener noreferrer" class="social-link" aria-label="View source code on GitHub">
                <svg width="20" height="20" aria-hidden="true"><use href="/icons.svg#github-icon" /></svg>
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
            <p class="drawer-title">Package inputs</p>
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
            <a href="https://github.com/chizkiyahu/pypi_graph" target="_blank" rel="noopener noreferrer" class="social-link" aria-label="View source code on GitHub">
              <svg width="20" height="20" aria-hidden="true"><use href="/icons.svg#github-icon" /></svg>
              Source on GitHub
              <svg width="14" height="14" aria-hidden="true" class="external-arrow"><use href="/icons.svg#external-link-icon" /></svg>
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
              <div class="title-with-link">
                <p class="section-kicker">Dependency graph</p>
                <a href="https://github.com/chizkiyahu/pypi_graph" target="_blank" rel="noopener noreferrer" class="social-link desktop-title-link" title="View source on GitHub" aria-label="View source on GitHub">
                  <svg width="18" height="18" aria-hidden="true"><use href="/icons.svg#github-icon" /></svg>
                  <svg width="14" height="14" aria-hidden="true" class="external-arrow"><use href="/icons.svg#external-link-icon" /></svg>
                </a>
              </div>
              <h2>{result.effectiveInputs.packageName} graph</h2>
              <p class="graph-stage-subtitle">
                Click a node to inspect its constraints. Change graph direction and labels from the side menu.
              </p>
            </div>

            <div class="graph-stage-meta desktop-meta">
              {renderMeta()}
            </div>
          </div>

          <div class="graph-frame">
            <GraphCanvas
              nodes={result.nodes}
              edges={result.edges}
              rootId={result.rootId}
              selectedNodeId={selectedNodeId}
              direction={graphDirection}
              showAllEdgeLabels={showAllEdgeLabels}
              onSelectNode={setSelectedNodeId}
            />
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

function NodeInspector(props: NodeInspectorProps) {
  const canOverride = props.node.kind === 'package' && props.node.id !== props.rootId
  const overrideValue = props.node.manualOverride ?? ''

  return (
    <div class="inspector">
      <div class="inspector-head">
        <div>
          <p class="section-kicker">Inspector</p>
          <p class="node-title">
            {props.node.packageName} <span>{props.node.displayVersion}</span>
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
