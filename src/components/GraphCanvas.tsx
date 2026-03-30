import cytoscape from 'cytoscape'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { GraphDirection, GraphEdge, GraphNode } from '../types.ts'

const GRAPH_FONT_STACK =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

interface GraphCanvasProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
  rootId: string | null
  selectedNodeId: string | null
  direction: GraphDirection
  showAllEdgeLabels: boolean
  onSelectNode: (nodeId: string | null) => void
}

function prefersDarkTheme(): boolean {
  return typeof window !== 'undefined'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false
}

function buildGraphStyles(isDark: boolean) {
  const nodeBackground = isDark ? '#213027' : '#fff4d8'
  const nodeBorder = isDark ? '#7ab395' : '#c7952e'
  const nodeInk = isDark ? '#edf6f0' : '#1f1d16'
  const rootBackground = isDark ? '#df7b1c' : '#f08a24'
  const unresolvedBackground = isDark ? '#553233' : '#f4d7d7'
  const unresolvedBorder = isDark ? '#e59d9d' : '#ad4d4d'
  const edgeColor = isDark ? '#7eb39a' : '#6c8a7b'
  const edgeFocus = isDark ? '#ffd494' : '#c46c0b'
  const edgeInk = isDark ? '#dff1e6' : '#355247'
  const edgeLabelBackground = isDark ? '#16201b' : '#fffaf0'

  return [
    {
      selector: 'node',
      style: {
        shape: 'round-rectangle',
        width: '236px',
        height: '92px',
        padding: '12px',
        'background-color': nodeBackground,
        'border-width': '2px',
        'border-color': nodeBorder,
        label: 'data(label)',
        color: nodeInk,
        'font-size': '19px',
        'font-weight': 600,
        'font-family': GRAPH_FONT_STACK,
        'text-wrap': 'wrap',
        'text-max-width': '206px',
        'text-valign': 'center',
        'text-halign': 'center',
      },
    },
    {
      selector: 'node[root = "true"]',
      style: {
        width: '252px',
        height: '98px',
        'background-color': rootBackground,
        'border-color': isDark ? '#ffd8a5' : '#7b3d10',
        color: '#fffef5',
      },
    },
    {
      selector: 'node[unresolved = "true"]',
      style: {
        'background-color': unresolvedBackground,
        'border-color': unresolvedBorder,
        'border-style': 'dashed',
      },
    },
    {
      selector: 'node.is-selected',
      style: {
        'border-width': '4px',
        'border-color': isDark ? '#fff3c4' : '#10372b',
        'underlay-color': isDark ? '#f2b66c' : '#dc8b35',
        'underlay-opacity': 0.28,
        'underlay-padding': '12px',
      },
    },
    {
      selector: 'node.is-neighbor',
      style: {
        'border-width': '3px',
        'border-color': isDark ? '#b2e1c9' : '#35614f',
      },
    },
    {
      selector: 'edge',
      style: {
        width: '2px',
        'line-color': edgeColor,
        'target-arrow-color': edgeColor,
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        label: 'data(label)',
        'font-size': '13px',
        'font-weight': 600,
        'text-wrap': 'wrap',
        'text-max-width': '220px',
        color: edgeInk,
        'text-background-color': edgeLabelBackground,
        'text-background-opacity': 0.92,
        'text-background-padding': '4px',
        'text-rotation': 'autorotate',
      },
    },
    {
      selector: 'edge.is-focus',
      style: {
        width: '3px',
        'line-color': edgeFocus,
        'target-arrow-color': edgeFocus,
      },
    },
    {
      selector: '.is-faded',
      style: {
        opacity: 0.14,
        'text-opacity': 0,
      },
    },
  ] as cytoscape.StylesheetJson
}

function rotateBreadthfirstPosition(position: cytoscape.Position): cytoscape.Position {
  const { x: verticalAxis, y: horizontalAxis } = position

  return {
    x: horizontalAxis,
    y: verticalAxis,
  }
}

export function GraphCanvas(props: GraphCanvasProps) {
  const shellRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const cytoscapeRef = useRef<cytoscape.Core | null>(null)
  const viewportFitPassesRef = useRef(0)
  const viewportFrameRef = useRef<number | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const fullscreenSupported =
    typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.requestFullscreen === 'function'

  function syncViewport(mode: 'center' | 'fit') {
    const instance = cytoscapeRef.current
    if (!instance) {
      return
    }

    instance.resize()

    if (instance.elements().empty()) {
      return
    }

    if (mode === 'fit') {
      instance.fit(instance.elements(), 36)
      return
    }

    instance.center()
  }

  function queueViewportFitPasses(passCount: number) {
    if (typeof window === 'undefined') {
      return
    }

    viewportFitPassesRef.current = Math.max(viewportFitPassesRef.current, passCount)

    if (viewportFrameRef.current !== null) {
      return
    }

    const runPass = () => {
      viewportFrameRef.current = null

      if (viewportFitPassesRef.current <= 0) {
        return
      }

      syncViewport('fit')
      viewportFitPassesRef.current -= 1

      if (viewportFitPassesRef.current > 0) {
        viewportFrameRef.current = window.requestAnimationFrame(runPass)
      }
    }

    viewportFrameRef.current = window.requestAnimationFrame(runPass)
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const instance =
      cytoscapeRef.current ??
      cytoscape({
        container,
        minZoom: 0.15,
        maxZoom: 3.2,
        style: buildGraphStyles(prefersDarkTheme()),
        // Use preset (no-op) as the default layout so Cytoscape never runs
        // GridLayout automatically when elements are added via .json().
        // The explicit breadthfirst layout is always called right after .json().
        layout: { name: 'preset' },
      })

    cytoscapeRef.current = instance

    instance.on('tap', 'node', (event) => {
      props.onSelectNode(event.target.id())
    })
    instance.on('tap', (event) => {
      if (event.target === instance) {
        props.onSelectNode(null)
      }
    })

    return () => {
      instance.removeAllListeners()
    }
  }, [props.onSelectNode])

  useEffect(() => {
    const instance = cytoscapeRef.current
    if (!instance) {
      return
    }

    instance.style(buildGraphStyles(prefersDarkTheme()))
    instance.json({
      elements: {
        nodes: props.nodes.map((node) => ({
          data: {
            id: node.id,
            label: `${node.packageName}\n${node.displayVersion}`,
            root: String(node.id === props.rootId),
            unresolved: String(node.kind === 'unresolved'),
          },
        })),
        edges: props.edges.map((edge) => ({
          data: {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            fullLabel: edge.requirement,
            label: '',
          },
        })),
      },
    })

    applyGraphFocus(instance, props.selectedNodeId, props.showAllEdgeLabels)

    const layoutOptions: cytoscape.BreadthFirstLayoutOptions = {
      name: 'breadthfirst',
      // Newly loaded graphs briefly share the same origin point before the
      // breadthfirst positions are applied. Keeping the layout synchronous
      // avoids Cytoscape's "invalid endpoints" warnings while rendering.
      animate: false,
      directed: true,
      fit: true,
      roots: props.rootId ? [props.rootId] : undefined,
      padding: props.nodes.length > 80 ? 28 : 36,
      spacingFactor:
        props.nodes.length > 140
          ? 0.72
          : props.nodes.length > 80
            ? 0.82
            : props.nodes.length > 40
              ? 0.90
              : 1.0,
      avoidOverlap: true,
      nodeDimensionsIncludeLabels: true,
      grid: false,
      transform: (_node, position) =>
        props.direction === 'left-right'
          ? rotateBreadthfirstPosition(position)
          : position,
    }

    instance.layout(layoutOptions).run()
  }, [props.nodes, props.edges, props.rootId, props.direction])

  useEffect(() => {
    const instance = cytoscapeRef.current
    if (!instance) {
      return
    }

    applyGraphFocus(instance, props.selectedNodeId, props.showAllEdgeLabels)
  }, [props.selectedNodeId, props.showAllEdgeLabels])

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && viewportFrameRef.current !== null) {
        window.cancelAnimationFrame(viewportFrameRef.current)
      }
      cytoscapeRef.current?.destroy()
      cytoscapeRef.current = null
    }
  }, [])

  useEffect(() => {
    const shell = shellRef.current
    if (!shell || typeof document === 'undefined') {
      return
    }

    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === shell)
    }

    handleFullscreenChange()
    document.addEventListener('fullscreenchange', handleFullscreenChange)

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    const instance = cytoscapeRef.current
    if (!container || !instance || typeof ResizeObserver === 'undefined') {
      return
    }

    const resizeObserver = new ResizeObserver(() => {
      syncViewport(viewportFitPassesRef.current > 0 ? 'fit' : 'center')

      if (viewportFitPassesRef.current > 0) {
        viewportFitPassesRef.current -= 1
      }
    })

    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
    }
  }, [props.rootId])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    queueViewportFitPasses(4)

    return () => {
      if (viewportFrameRef.current !== null) {
        window.cancelAnimationFrame(viewportFrameRef.current)
        viewportFrameRef.current = null
      }
    }
  }, [isFullscreen])

  function fitGraph() {
    const instance = cytoscapeRef.current
    if (!instance) {
      return
    }

    instance.animate({
      fit: {
        eles: instance.elements(),
        padding: 36,
      },
      duration: 240,
    })
  }

  function zoomBy(multiplier: number) {
    const instance = cytoscapeRef.current
    if (!instance) {
      return
    }

    const nextZoom = Math.max(instance.minZoom(), Math.min(instance.maxZoom(), instance.zoom() * multiplier))
    instance.animate({
      zoom: {
        level: nextZoom,
        renderedPosition: {
          x: instance.width() / 2,
          y: instance.height() / 2,
        },
      },
      duration: 180,
    })
  }

  async function toggleFullscreen() {
    const shell = shellRef.current
    if (!shell || typeof document === 'undefined') {
      return
    }

    try {
      if (document.fullscreenElement === shell) {
        await document.exitFullscreen()
      } else {
        await shell.requestFullscreen()
      }
    } catch {
      // Ignore fullscreen failures triggered by browser settings or user agent policy.
    }
  }

  function saveGraphToFile() {
    const instance = cytoscapeRef.current
    if (!instance || typeof document === 'undefined') {
      return
    }

    const rootNode = props.nodes.find((node) => node.id === props.rootId) ?? props.nodes[0]
    const scale = typeof window === 'undefined' ? 2 : Math.min(3, Math.max(2, Math.ceil(window.devicePixelRatio || 1)))
    const link = document.createElement('a')

    link.href = instance.png({
      full: true,
      scale,
      bg: prefersDarkTheme() ? '#0b1512' : '#f6efe0',
    })
    link.download = `${sanitizeFileName(rootNode?.packageName ?? 'dependency-graph')}-dependency-graph.png`
    document.body.append(link)
    link.click()
    link.remove()
  }

  return (
    <div class="graph-canvas-shell" ref={shellRef}>
      <div class="graph-toolbar">
        <button class="graph-tool" type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in" title="Zoom in">
          +
        </button>
        <button class="graph-tool" type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out" title="Zoom out">
          -
        </button>
        <button class="graph-tool graph-tool-icon" type="button" onClick={fitGraph} aria-label="Fit graph to view" title="Fit graph to view">
          <FitIcon />
        </button>
        <button
          class="graph-tool graph-tool-icon"
          type="button"
          onClick={() => void toggleFullscreen()}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          disabled={!fullscreenSupported}
        >
          {isFullscreen ? <ExitFullscreenIcon /> : <EnterFullscreenIcon />}
        </button>
        <button class="graph-tool graph-tool-icon" type="button" onClick={saveGraphToFile} aria-label="Save graph as PNG" title="Save graph as PNG">
          <DownloadIcon />
        </button>
      </div>
      <div class="graph-canvas" ref={containerRef} />
    </div>
  )
}

function FitIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7.5 7.5 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M12.5 7.5 16 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M7.5 12.5 4 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M12.5 12.5 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <rect x="7.2" y="7.2" width="5.6" height="5.6" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function EnterFullscreenIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7 3H3v4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 3h4v4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17 13v4h-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 13v4h4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ExitFullscreenIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7 7H3V3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 7h4V3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17 17v-4h-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 17v-4h4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 3v8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="m6.5 8.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 15.5h12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

function applyGraphFocus(
  instance: cytoscape.Core,
  selectedNodeId: string | null,
  showAllEdgeLabels: boolean,
): void {
  instance.elements().removeClass('is-selected is-neighbor is-focus is-faded')

  const edges = instance.edges()
  edges.forEach((edge) => {
    edge.data('label', showAllEdgeLabels ? compactEdgeLabel(String(edge.data('fullLabel') ?? '')) : '')
  })

  if (!selectedNodeId) {
    return
  }

  const selected = instance.getElementById(selectedNodeId)
  if (selected.empty()) {
    return
  }

  const neighborhood = selected.closedNeighborhood()
  instance.elements().difference(neighborhood).addClass('is-faded')
  selected.addClass('is-selected')
  selected.neighborhood('node').addClass('is-neighbor')
  selected.connectedEdges().addClass('is-focus')

  if (!showAllEdgeLabels) {
    selected.connectedEdges().forEach((edge) => {
      edge.data('label', compactEdgeLabel(String(edge.data('fullLabel') ?? '')))
    })
  }
}

function compactEdgeLabel(label: string): string {
  return label.length > 54 ? `${label.slice(0, 51)}...` : label
}

function sanitizeFileName(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return sanitized || 'dependency-graph'
}

