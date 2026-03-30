import cytoscape from 'cytoscape'
import { useEffect, useRef } from 'preact/hooks'
import type { GraphDirection, GraphEdge, GraphNode } from '../types.ts'

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
        'font-family': 'IBM Plex Sans, sans-serif',
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
        'curve-style': 'unbundled-bezier',
        'control-point-distances': [40],
        'control-point-weights': [0.5],
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
  const containerRef = useRef<HTMLDivElement | null>(null)
  const cytoscapeRef = useRef<cytoscape.Core | null>(null)

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

    instance.layout({
      name: 'breadthfirst',
      animate: true,
      animationDuration: 220,
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
    }).run()
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
      cytoscapeRef.current?.destroy()
      cytoscapeRef.current = null
    }
  }, [])

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

  function centerRoot() {
    const instance = cytoscapeRef.current
    if (!instance || !props.rootId) {
      return
    }

    const root = instance.getElementById(props.rootId)
    if (root.nonempty()) {
      instance.animate({
        fit: {
          eles: root.closedNeighborhood(),
          padding: 96,
        },
        duration: 240,
      })
    }
  }

  return (
    <div class="graph-canvas-shell">
      <div class="graph-toolbar">
        <button class="graph-tool" type="button" onClick={() => zoomBy(1.2)}>
          +
        </button>
        <button class="graph-tool" type="button" onClick={() => zoomBy(1 / 1.2)}>
          -
        </button>
        <button class="graph-tool" type="button" onClick={fitGraph}>
          Fit
        </button>
        <button class="graph-tool" type="button" onClick={centerRoot} disabled={!props.rootId}>
          Root
        </button>
      </div>
      <div class="graph-canvas" ref={containerRef} />
    </div>
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
