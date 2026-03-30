import { satisfies } from '@renovatebot/pep440'
import type {
  GraphEdge,
  GraphNode,
  MarkerContext,
  ParsedRequirement,
  PypiFile,
  PypiProjectResponse,
  PypiVersionResponse,
  PlatformOption,
  ResolveDependencyGraphOptions,
  ResolutionInputs,
  ResolutionLimits,
  ResolutionProgress,
  ResolutionResult,
  RootOptions,
} from '../types.ts'
import {
  collectMarkerInsights,
  createMutableInsights,
  evaluateMarker,
  finalizeInsights,
} from './marker.ts'
import type { PypiClient } from './pypi.ts'
import { parseRequirement } from './requirements.ts'
import {
  COMMON_PLATFORM_OPTIONS,
  getPlatformDescriptor,
  normalizePlatformTarget,
  sortPlatformOptions,
} from './platforms.ts'
import {
  COMMON_PYTHON_VERSIONS,
  normalizePackageName,
  normalizePythonVersion,
  selectVersion,
  sortPythonVersions,
  sortVersionsDescending,
  uniqueSorted,
} from './versions.ts'

interface ResolveRequest {
  name: string
  normalizedName: string
  specifiers: string[]
  requirementTexts: string[]
  selectedExtras: string[]
  depth: number
}

interface ProjectSnapshot {
  releases: string[]
  yankedVersions: Set<string>
}

interface ResolverState {
  nodes: Map<string, GraphNode>
  edges: Map<string, GraphEdge>
  projectSnapshots: Map<string, ProjectSnapshot>
  limits: ResolutionLimits
  insights: ReturnType<typeof createMutableInsights>
  progress: ProgressReporter
}

interface ProgressUpdate {
  phase: ResolutionProgress['phase']
  message: string
  currentPackage?: string | null
  depth?: number | null
}

interface ProgressReporter {
  emit(update: ProgressUpdate, force?: boolean): void
}

interface CompatibilityMatrix {
  pythonToPlatforms: Map<string, Set<PlatformOption>>
  platformToPython: Map<PlatformOption, Set<string>>
  allPythonVersions: string[]
  allPlatforms: PlatformOption[]
}

interface EnvironmentAnalysisResult {
  supportedCombos: Set<string>
  signatures: Map<string, string>
}

interface EnvironmentAnalysisContext {
  client: PypiClient
  inputs: ResolutionInputs
  pythonPool: string[]
  memo: Map<string, Promise<EnvironmentAnalysisResult>>
  state: ResolverState
}

export async function resolveDependencyGraph(
  inputs: ResolutionInputs,
  client: PypiClient,
  options?: ResolveDependencyGraphOptions,
): Promise<ResolutionResult> {
  const normalizedRoot = normalizePackageName(inputs.packageName)
  if (!normalizedRoot) {
    return {
      rootId: null,
      nodes: [],
      edges: [],
      insights: finalizeInsights([], createMutableInsights([])),
      limits: emptyLimits(),
      rootOptions: {
        extras: [],
        availableVersions: [],
        supportedPythonVersions: buildPythonCandidatePool(inputs.pythonVersion, []),
        supportedPlatforms: COMMON_PLATFORM_OPTIONS,
        showVersionSelector: false,
        showPythonSelector: false,
        showPlatformSelector: false,
      },
      effectiveInputs: inputs,
    }
  }

  const rootProject = await client.getProject(normalizedRoot)
  const rootSnapshot = projectSnapshotFromReleases(rootProject.data.releases)
  const rootExtras = uniqueSorted([
    ...(rootProject.data.info.provides_extra ?? []),
    ...extractRootExtras(rootProject.data.info.requires_dist ?? []),
  ])
  const state: ResolverState = {
    nodes: new Map<string, GraphNode>(),
    edges: new Map<string, GraphEdge>(),
    projectSnapshots: new Map<string, ProjectSnapshot>(),
    limits: emptyLimits(),
    insights: createMutableInsights(rootExtras),
    progress: createProgressReporter(() => state, options?.onProgress),
  }

  recordFetchSource(state.limits, rootProject.source)
  state.projectSnapshots.set(normalizedRoot, rootSnapshot)
  state.progress.emit(
    {
      phase: 'loading-metadata',
      message: `Loaded metadata for ${rootProject.data.info.name} from ${rootProject.source}.`,
      currentPackage: rootProject.data.info.name,
      depth: 0,
    },
    true,
  )
  state.progress.emit(
    {
      phase: 'analyzing-environment',
      message: `Checking supported Python and platform combinations for ${rootProject.data.info.name}…`,
      currentPackage: rootProject.data.info.name,
      depth: 0,
    },
    true,
  )
  const rootOptions = await deriveRootOptions(rootProject.data, rootSnapshot, inputs, rootExtras, client, state)
  const effectiveInputs = sanitizeInputs(inputs, rootOptions)

  state.progress.emit(
    {
      phase: 'resolving-graph',
      message: `Resolving dependency graph for ${rootProject.data.info.name}…`,
      currentPackage: rootProject.data.info.name,
      depth: 0,
    },
    true,
  )

  const rootId = await resolveNode(
    {
      name: rootProject.data.info.name,
      normalizedName: normalizedRoot,
      specifiers: [],
      requirementTexts: [],
      selectedExtras: effectiveInputs.extras,
      depth: 0,
    },
    effectiveInputs,
    client,
    state,
    new Set<string>(),
    rootProject.data.info.name,
    rootProject.data,
  )

  state.progress.emit(
    {
      phase: 'complete',
      message: `Built graph with ${state.nodes.size} nodes and ${state.edges.size} edges.`,
      currentPackage: rootProject.data.info.name,
      depth: 0,
    },
    true,
  )

  return {
    rootId,
    nodes: [...state.nodes.values()].sort((left, right) => left.depth - right.depth || left.packageName.localeCompare(right.packageName)),
    edges: [...state.edges.values()],
    insights: finalizeInsights(rootExtras, state.insights),
    limits: state.limits,
    rootOptions,
    effectiveInputs,
  }
}

async function resolveNode(
  request: ResolveRequest,
  inputs: ResolutionInputs,
  client: PypiClient,
  state: ResolverState,
  path: Set<string>,
  displayName?: string,
  preloadedProject?: PypiProjectResponse,
): Promise<string> {
  const requestedDisplayName = displayName ?? request.name
  state.progress.emit({
    phase: 'resolving-graph',
    message:
      request.depth === 0
        ? `Resolving ${requestedDisplayName}…`
        : `Resolving dependency ${requestedDisplayName}…`,
    currentPackage: requestedDisplayName,
    depth: request.depth,
  })

  const summary: PypiProjectResponse =
    preloadedProject ??
    (await fetchProjectSummary(
      request.normalizedName,
      requestedDisplayName,
      client,
      state,
      'resolving-graph',
      request.depth,
    ).then((result) => result.data))

  if (!state.projectSnapshots.has(request.normalizedName)) {
    state.projectSnapshots.set(request.normalizedName, projectSnapshotFromReleases(summary.releases))
  }

  const snapshot = state.projectSnapshots.get(request.normalizedName)!
  const availableVersions = snapshot.releases.filter((version) => !snapshot.yankedVersions.has(version))
  const manualOverride =
    request.depth === 0
      ? inputs.rootVersion
      : inputs.manualVersions[request.normalizedName] ?? null
  const versionChoice =
    request.depth === 0
      ? selectRootVersion(availableVersions, manualOverride)
      : selectVersion(availableVersions, request.specifiers, manualOverride)

  if (!versionChoice.selectedVersion) {
    state.limits.unresolvedNodes += 1
    const unresolvedId = ensureUnresolvedNode(
      state,
      request,
      versionChoice.legalVersions,
      manualOverride,
      versionChoice.rejectionReason ?? 'The package could not be resolved.',
      requestedDisplayName,
    )
    state.progress.emit({
      phase: 'resolving-graph',
      message: `Could not resolve ${requestedDisplayName}.`,
      currentPackage: requestedDisplayName,
      depth: request.depth,
    })
    return unresolvedId
  }

  const nodeId = makeNodeId(request.normalizedName, versionChoice.selectedVersion, request.selectedExtras)
  if (path.has(nodeId)) {
    state.limits.cycleEdges += 1
    return nodeId
  }

  const existing = state.nodes.get(nodeId)
  if (existing) {
    mergeNode(existing, request.requirementTexts, request.specifiers, versionChoice.legalVersions, manualOverride)
    state.progress.emit({
      phase: 'resolving-graph',
      message: `Reused ${existing.packageName} ${existing.displayVersion}.`,
      currentPackage: existing.packageName,
      depth: request.depth,
    })
    return nodeId
  }

  const versionResponse: { data: PypiProjectResponse | PypiVersionResponse; source: 'cache' | 'network' } =
    versionChoice.selectedVersion === summary.info.version
      ? { data: summary, source: 'cache' as const }
      : await fetchVersionPayload(
          request.normalizedName,
          versionChoice.selectedVersion,
          requestedDisplayName,
          client,
          state,
          'resolving-graph',
          request.depth,
        )

  const node: GraphNode = {
    id: nodeId,
    kind: 'package',
    packageName: versionResponse.data.info.name,
    normalizedName: request.normalizedName,
    version: versionChoice.selectedVersion,
    displayVersion: versionChoice.selectedVersion,
    summary: versionResponse.data.info.summary ?? 'No summary published.',
    depth: request.depth,
    selectedExtras: [...request.selectedExtras].sort((left, right) => left.localeCompare(right)),
    incomingRequirements: [...new Set(request.requirementTexts)],
    inactiveRequirements: [],
    availableVersions: versionChoice.legalVersions,
    combinedSpecifiers: [...request.specifiers],
    manualOverride,
    requiresPython: versionResponse.data.info.requires_python ?? null,
    projectUrl: versionResponse.data.info.package_url,
    cacheSource: versionResponse.source,
    notes: [],
  }
  state.nodes.set(nodeId, node)
  state.progress.emit({
    phase: 'resolving-graph',
    message: `Resolved ${node.packageName} ${node.displayVersion}.`,
    currentPackage: node.packageName,
    depth: request.depth,
  })

  const markerContext = buildMarkerContext(inputs, request.selectedExtras)
  const nextPath = new Set(path)
  nextPath.add(nodeId)
  const requirements = versionResponse.data.info.requires_dist ?? []

  await Promise.all(
    requirements.map(async (rawRequirement) => {
      let parsed: ParsedRequirement
      try {
        parsed = parseRequirement(rawRequirement)
      } catch (error) {
        state.limits.parseFailures += 1
        node.inactiveRequirements.push({
          raw: rawRequirement,
          markerText: null,
          reason: error instanceof Error ? error.message : 'Could not parse requirement.',
        })
        return
      }

      if (parsed.markerAst && parsed.markerText) {
        collectMarkerInsights(parsed.markerAst, state.insights, parsed.markerText)
        const evaluation = evaluateMarker(parsed.markerAst, markerContext, parsed.markerText)
        if (!evaluation.active) {
          state.limits.inactiveRequirements += 1
          node.inactiveRequirements.push({
            raw: parsed.raw,
            markerText: parsed.markerText,
            reason: evaluation.reason,
          })
          return
        }
      }

      if (parsed.directReference) {
        state.limits.skippedDirectReferences += 1
        const directRefId = ensureUnresolvedNode(
          state,
          {
            ...request,
            name: parsed.name,
            normalizedName: parsed.normalizedName,
            specifiers: parsed.specifier ? [parsed.specifier] : [],
            selectedExtras: parsed.extras,
            requirementTexts: [parsed.raw],
          },
          [],
          null,
          `Direct reference dependencies are shown but not recursively resolved: ${parsed.directReference}`,
          parsed.name,
        )
        state.edges.set(
          makeEdgeId(nodeId, directRefId, parsed.raw),
          buildEdge(nodeId, directRefId, parsed.raw, parsed.markerText),
        )
        return
      }

      const childId = await resolveNode(
        {
          name: parsed.name,
          normalizedName: parsed.normalizedName,
          specifiers: parsed.specifier ? [parsed.specifier] : [],
          requirementTexts: [parsed.raw],
          selectedExtras: parsed.extras,
          depth: request.depth + 1,
        },
        inputs,
        client,
        state,
        nextPath,
      )

      state.edges.set(
        makeEdgeId(nodeId, childId, parsed.raw),
        buildEdge(nodeId, childId, parsed.raw, parsed.markerText),
      )
    }),
  )

  return nodeId
}

function buildMarkerContext(inputs: ResolutionInputs, selectedExtras: string[]): MarkerContext {
  const platform = getPlatformDescriptor(inputs.platform)

  return {
    pythonVersion: inputs.pythonVersion,
    pythonFullVersion: normalizePythonVersion(inputs.pythonVersion),
    sysPlatform: platform.sysPlatform,
    platformSystem: platform.platformSystem,
    osName: platform.osName,
    platformMachine: platform.machine,
    implementationName: 'cpython',
    implementationVersion: normalizePythonVersion(inputs.pythonVersion),
    platformPythonImplementation: 'CPython',
    extras: selectedExtras,
  }
}

async function deriveRootOptions(
  rootProject: PypiProjectResponse,
  rootSnapshot: ProjectSnapshot,
  inputs: ResolutionInputs,
  rootExtras: string[],
  client: PypiClient,
  state: ResolverState,
): Promise<RootOptions> {
  const sanitizedExtras = inputs.extras.filter((extra) => rootExtras.includes(extra))
  const parsedRequirements = parseRequirementList(rootProject.info.requires_dist ?? [])
  const availableVersions = sortVersionsDescending(
    rootSnapshot.releases.filter((version) => !rootSnapshot.yankedVersions.has(version)),
  )
  const selectedOrDefaultVersion =
    pickSupportedRootVersion(inputs.rootVersion, availableVersions) ??
    selectRootVersion(availableVersions, null).selectedVersion ??
    rootProject.info.version
  const selectedVersionFiles =
    rootProject.releases[selectedOrDefaultVersion] ?? rootProject.releases[rootProject.info.version] ?? []
  const pythonPool = buildPythonCandidatePool(inputs.pythonVersion, selectedVersionFiles)
  const environmentAnalysis = await analyzeResolvedEnvironmentSupport(
    {
      name: rootProject.info.name,
      normalizedName: normalizePackageName(rootProject.info.name),
      specifiers: [],
      requirementTexts: [],
      selectedExtras: sanitizedExtras,
      depth: 0,
    },
    pythonPool,
    inputs,
    client,
    state,
    rootProject,
  )
  const compatibility = compatibilityMatrixFromCombos(environmentAnalysis.supportedCombos)

  let supportedPlatforms = deriveSupportedPlatforms(compatibility, inputs.pythonVersion)
  let effectivePlatform = pickSupportedPlatform(inputs.platform, supportedPlatforms)
  let supportedPythonVersions = deriveSupportedPythonVersions(compatibility, effectivePlatform, pythonPool)
  let effectivePythonVersion = pickSupportedPythonVersion(inputs.pythonVersion, supportedPythonVersions)

  supportedPlatforms = deriveSupportedPlatforms(compatibility, effectivePythonVersion)
  effectivePlatform = pickSupportedPlatform(effectivePlatform, supportedPlatforms)
  supportedPythonVersions = deriveSupportedPythonVersions(compatibility, effectivePlatform, pythonPool)
  effectivePythonVersion = pickSupportedPythonVersion(effectivePythonVersion, supportedPythonVersions)

  const signatures = Promise.resolve(
    filterEnvironmentSignatures(environmentAnalysis.signatures, compatibility),
  )
  const [pythonSensitive, platformSensitive] = await Promise.all([
    hasEnvironmentVariation(
      signatures,
      supportedPythonVersions,
      (pythonVersion) => makeEnvironmentKey(pythonVersion, effectivePlatform),
    ),
    hasEnvironmentVariation(
      signatures,
      supportedPlatforms,
      (platform) => makeEnvironmentKey(effectivePythonVersion, platform),
    ),
  ])

  return {
    extras: rootExtras,
    availableVersions,
    supportedPythonVersions,
    supportedPlatforms,
    showVersionSelector: availableVersions.length > 1,
    showPythonSelector:
      supportedPythonVersions.length < pythonPool.length ||
      pythonSensitive ||
      hasRequirementVariation(
        parsedRequirements,
        supportedPythonVersions,
        (pythonVersion) =>
          buildMarkerContext(
            {
              ...inputs,
              pythonVersion,
              platform: effectivePlatform,
              extras: sanitizedExtras,
            },
            sanitizedExtras,
          ),
      ),
    showPlatformSelector:
      supportedPlatforms.length < COMMON_PLATFORM_OPTIONS.length ||
      platformSensitive ||
      hasRequirementVariation(
        parsedRequirements,
        supportedPlatforms,
        (platform) =>
          buildMarkerContext(
            {
              ...inputs,
              pythonVersion: effectivePythonVersion,
              platform,
              extras: sanitizedExtras,
            },
            sanitizedExtras,
          ),
      ),
  }
}

function sanitizeInputs(inputs: ResolutionInputs, rootOptions: RootOptions): ResolutionInputs {
  return {
    ...inputs,
    rootVersion: pickSupportedRootVersion(inputs.rootVersion, rootOptions.availableVersions),
    pythonVersion: pickSupportedPythonVersion(inputs.pythonVersion, rootOptions.supportedPythonVersions),
    platform: pickSupportedPlatform(inputs.platform, rootOptions.supportedPlatforms),
    extras: inputs.extras.filter((extra) => rootOptions.extras.includes(extra)),
  }
}

function buildPythonCandidatePool(selectedVersion: string, files: PypiFile[]): string[] {
  return sortPythonVersions([
    ...COMMON_PYTHON_VERSIONS,
    ...extractExplicitPythonVersionsFromFiles(files),
    selectedVersion,
  ])
}

function deriveSupportedPythonVersions(
  compatibility: CompatibilityMatrix,
  platform: PlatformOption,
  pool: string[],
): string[] {
  const normalizedPlatform = normalizePlatformTarget(platform)
  const supported = compatibility.platformToPython.get(normalizedPlatform)
  if (supported && supported.size > 0) {
    return sortPythonVersions(supported)
  }

  return sortPythonVersions(compatibility.allPythonVersions.length > 0 ? compatibility.allPythonVersions : pool)
}

function deriveSupportedPlatforms(
  compatibility: CompatibilityMatrix,
  pythonVersion: string,
): PlatformOption[] {
  const supported = compatibility.pythonToPlatforms.get(pythonVersion)
  if (supported && supported.size > 0) {
    return sortPlatformOptions(supported)
  }

  return compatibility.allPlatforms
}

async function analyzeResolvedEnvironmentSupport(
  request: ResolveRequest,
  pythonPool: string[],
  inputs: ResolutionInputs,
  client: PypiClient,
  state: ResolverState,
  preloadedProject?: PypiProjectResponse,
): Promise<EnvironmentAnalysisResult> {
  return analyzeEnvironmentSupport(
    request,
    {
      client,
      inputs,
      pythonPool,
      memo: new Map<string, Promise<EnvironmentAnalysisResult>>(),
      state,
    },
    new Set<string>(),
    preloadedProject,
  )
}

function filterEnvironmentSignatures(
  signatures: Map<string, string>,
  compatibility: CompatibilityMatrix,
): Map<string, string> {
  return new Map(
    [...signatures.entries()].filter(([key]) => {
      const [pythonVersion, platform] = parseEnvironmentKey(key)
      return (
        compatibility.pythonToPlatforms.get(pythonVersion)?.has(platform) ??
        false
      )
    }),
  )
}

async function analyzeEnvironmentSupport(
  request: ResolveRequest,
  context: EnvironmentAnalysisContext,
  path: Set<string>,
  preloadedProject?: PypiProjectResponse,
): Promise<EnvironmentAnalysisResult> {
  const memoKey = makeEnvironmentMemoKey(request, context.inputs)
  if (path.has(memoKey)) {
    return {
      supportedCombos: buildAllEnvironmentCombos(context.pythonPool),
      signatures: new Map(),
    }
  }

  const existing = context.memo.get(memoKey)
  if (existing) {
    return existing
  }

  const nextPath = new Set(path)
  nextPath.add(memoKey)

  const promise = (async (): Promise<EnvironmentAnalysisResult> => {
    context.state.progress.emit({
      phase: 'analyzing-environment',
      message:
        request.depth === 0
          ? `Scanning supported environments for ${request.name}…`
          : `Checking ${request.name} across Python and platform combinations…`,
      currentPackage: request.name,
      depth: request.depth,
    })

    let summary: PypiProjectResponse
    try {
      summary = await loadProject(request.normalizedName, context, preloadedProject)
    } catch {
      return {
        supportedCombos: buildAllEnvironmentCombos(context.pythonPool),
        signatures: new Map(),
      }
    }
    const snapshot = projectSnapshotFromReleases(summary.releases)
    const availableVersions = snapshot.releases.filter((version) => !snapshot.yankedVersions.has(version))
    const manualOverride =
      request.depth === 0
        ? context.inputs.rootVersion
        : context.inputs.manualVersions[request.normalizedName] ?? null
    const versionChoice =
      request.depth === 0
        ? selectRootVersion(availableVersions, manualOverride)
        : selectVersion(availableVersions, request.specifiers, manualOverride)

    if (!versionChoice.selectedVersion) {
      return {
        supportedCombos: buildAllEnvironmentCombos(context.pythonPool),
        signatures: new Map(),
      }
    }

    let versionData: PypiProjectResponse | PypiVersionResponse
    try {
      versionData = await loadVersionData(
        request.normalizedName,
        versionChoice.selectedVersion,
        summary,
        context,
      )
    } catch {
      return {
        supportedCombos: buildAllEnvironmentCombos(context.pythonPool),
        signatures: new Map(),
      }
    }
    const files = getVersionFiles(versionData, summary, versionChoice.selectedVersion)
    const selfCompatibility = buildCompatibilityMatrix(
      files,
      context.pythonPool,
      versionData.info.requires_python ?? null,
    )
    const supportedCombos = compatibilityCombos(selfCompatibility)
    const signatures = new Map<string, string>(
      [...supportedCombos].map((comboKey) => [comboKey, makeNodeId(request.normalizedName, versionChoice.selectedVersion!, request.selectedExtras)]),
    )
    const requirements = versionData.info.requires_dist ?? []

    for (const rawRequirement of requirements) {
      let parsed: ParsedRequirement
      try {
        parsed = parseRequirement(rawRequirement)
      } catch {
        continue
      }

      const activeCombos = [...supportedCombos].filter((comboKey) => {
        if (!parsed.markerAst || !parsed.markerText) {
          return true
        }

        const [pythonVersion, platform] = parseEnvironmentKey(comboKey)
        return evaluateMarker(
          parsed.markerAst,
          buildMarkerContext(
            {
              ...context.inputs,
              pythonVersion,
              platform,
              extras: request.selectedExtras,
            },
            request.selectedExtras,
          ),
          parsed.markerText,
        ).active
      })

      if (activeCombos.length === 0) {
        continue
      }

      if (parsed.directReference) {
        for (const comboKey of activeCombos) {
          signatures.set(comboKey, `${signatures.get(comboKey)}|${parsed.raw}:direct`)
        }
        continue
      }

      const child = await analyzeEnvironmentSupport(
        {
          name: parsed.name,
          normalizedName: parsed.normalizedName,
          specifiers: parsed.specifier ? [parsed.specifier] : [],
          requirementTexts: [parsed.raw],
          selectedExtras: parsed.extras,
          depth: request.depth + 1,
        },
        context,
        nextPath,
      )

      for (const comboKey of activeCombos) {
        if (!child.supportedCombos.has(comboKey)) {
          supportedCombos.delete(comboKey)
          signatures.delete(comboKey)
          continue
        }

        const childSignature = child.signatures.get(comboKey)
        if (childSignature) {
          signatures.set(comboKey, `${signatures.get(comboKey)}|${parsed.raw}->${childSignature}`)
        }
      }
    }

    return { supportedCombos, signatures }
  })()

  context.memo.set(memoKey, promise)
  return promise
}

async function hasEnvironmentVariation(
  signaturesPromise: Promise<Map<string, string>>,
  values: string[],
  toKey: (value: string) => string,
): Promise<boolean> {
  if (values.length === 0) {
    return false
  }

  const signatures = await signaturesPromise
  const resolved = values.map((value) => signatures.get(toKey(value)) ?? '')
  return new Set(resolved).size > 1
}

async function loadProject(
  normalizedName: string,
  context: EnvironmentAnalysisContext,
  preloadedProject?: PypiProjectResponse,
): Promise<PypiProjectResponse> {
  if (preloadedProject) {
    return preloadedProject
  }

  const result = await fetchProjectSummary(
    normalizedName,
    normalizedName,
    context.client,
    context.state,
    'analyzing-environment',
    null,
  )
  return result.data
}

async function loadVersionData(
  normalizedName: string,
  selectedVersion: string,
  summary: PypiProjectResponse,
  context: EnvironmentAnalysisContext,
): Promise<PypiProjectResponse | PypiVersionResponse> {
  if (selectedVersion === summary.info.version) {
    return summary
  }

  const result = await fetchVersionPayload(
    normalizedName,
    selectedVersion,
    summary.info.name,
    context.client,
    context.state,
    'analyzing-environment',
    null,
  )
  return result.data
}

function getVersionFiles(
  versionData: PypiProjectResponse | PypiVersionResponse,
  summary: PypiProjectResponse,
  selectedVersion: string,
): PypiFile[] {
  if ('urls' in versionData) {
    return versionData.urls
  }

  return versionData.releases[selectedVersion] ?? summary.releases[selectedVersion] ?? []
}

function makeEnvironmentMemoKey(request: ResolveRequest, inputs: ResolutionInputs): string {
  const manualOverride =
    request.depth === 0
      ? inputs.rootVersion ?? ''
      : inputs.manualVersions[request.normalizedName] ?? ''

  return [
    request.normalizedName,
    request.specifiers.join(','),
    [...request.selectedExtras].sort((left, right) => left.localeCompare(right)).join(','),
    manualOverride,
    request.depth === 0 ? 'root' : 'dep',
  ].join('|')
}

function makeEnvironmentKey(pythonVersion: string, platform: PlatformOption): string {
  return `${pythonVersion}|${normalizePlatformTarget(platform)}`
}

function parseEnvironmentKey(value: string): [string, PlatformOption] {
  const [pythonVersion, platform] = value.split('|', 2)
  return [pythonVersion, normalizePlatformTarget(platform ?? '')]
}

function buildAllEnvironmentCombos(pythonPool: string[]): Set<string> {
  return new Set(
    pythonPool.flatMap((pythonVersion) =>
      COMMON_PLATFORM_OPTIONS.map((platform) => makeEnvironmentKey(pythonVersion, platform)),
    ),
  )
}

function compatibilityCombos(compatibility: CompatibilityMatrix): Set<string> {
  const combos = new Set<string>()

  for (const [pythonVersion, platforms] of compatibility.pythonToPlatforms.entries()) {
    for (const platform of platforms) {
      combos.add(makeEnvironmentKey(pythonVersion, platform))
    }
  }

  return combos
}

function compatibilityMatrixFromCombos(combos: Iterable<string>): CompatibilityMatrix {
  const pythonToPlatforms = new Map<string, Set<PlatformOption>>()
  const platformToPython = new Map<PlatformOption, Set<string>>()

  for (const comboKey of combos) {
    const [pythonVersion, platform] = parseEnvironmentKey(comboKey)
    const normalizedPlatform = normalizePlatformTarget(platform)
    const platforms = pythonToPlatforms.get(pythonVersion) ?? new Set<PlatformOption>()
    pythonToPlatforms.set(pythonVersion, platforms)
    platforms.add(normalizedPlatform)

    const versions = platformToPython.get(normalizedPlatform) ?? new Set<string>()
    platformToPython.set(normalizedPlatform, versions)
    versions.add(pythonVersion)
  }

  return {
    pythonToPlatforms,
    platformToPython,
    allPythonVersions: sortPythonVersions(pythonToPlatforms.keys()),
    allPlatforms: sortPlatformOptions(platformToPython.keys()),
  }
}

function supportsPythonSpecifier(specifier: string | null, version: string): boolean {
  if (!specifier) {
    return true
  }

  try {
    return satisfies(normalizePythonVersion(version), specifier, { prereleases: true })
  } catch {
    return true
  }
}

function buildCompatibilityMatrix(
  files: PypiFile[],
  pythonPool: string[],
  requiresPython: string | null,
): CompatibilityMatrix {
  const pythonToPlatforms = new Map<string, Set<PlatformOption>>()
  const platformToPython = new Map<PlatformOption, Set<string>>()
  const allPlatforms = extractExplicitPlatformTargetsFromFiles(files)
  const platformPool = allPlatforms.length > 0 ? allPlatforms : COMMON_PLATFORM_OPTIONS

  for (const file of files) {
    const explicitPlatforms = inferPlatformTargetsFromFile(file)
    const filePlatforms =
      explicitPlatforms && explicitPlatforms.length > 0 ? explicitPlatforms : platformPool
    const fileRequiresPython = file.requires_python ?? requiresPython
    const explicitPythonVersions = inferPythonVersionsForFile(file, pythonPool, fileRequiresPython)
    const filePythonVersions =
      explicitPythonVersions.length > 0
        ? explicitPythonVersions
        : pythonPool.filter((version) => supportsPythonSpecifier(fileRequiresPython, version))

    for (const pythonVersion of filePythonVersions) {
      const compatibilityPythonVersion = pythonVersion
      const pythonPlatforms = pythonToPlatforms.get(compatibilityPythonVersion) ?? new Set<PlatformOption>()
      pythonToPlatforms.set(compatibilityPythonVersion, pythonPlatforms)

      for (const platform of filePlatforms) {
        const normalizedPlatform = normalizePlatformTarget(platform)
        pythonPlatforms.add(normalizedPlatform)

        const platformVersions = platformToPython.get(normalizedPlatform) ?? new Set<string>()
        platformToPython.set(normalizedPlatform, platformVersions)
        platformVersions.add(compatibilityPythonVersion)
      }
    }
  }

  if (pythonToPlatforms.size === 0) {
    for (const pythonVersion of pythonPool.filter((version) => supportsPythonSpecifier(requiresPython, version))) {
      const pythonPlatforms = pythonToPlatforms.get(pythonVersion) ?? new Set<PlatformOption>()
      pythonToPlatforms.set(pythonVersion, pythonPlatforms)

      for (const platform of platformPool) {
        pythonPlatforms.add(platform)
        const platformVersions = platformToPython.get(platform) ?? new Set<string>()
        platformToPython.set(platform, platformVersions)
        platformVersions.add(pythonVersion)
      }
    }
  }

  return {
    pythonToPlatforms,
    platformToPython,
    allPythonVersions: sortPythonVersions(pythonToPlatforms.keys()),
    allPlatforms: sortPlatformOptions(platformToPython.keys()),
  }
}

function inferPythonVersionsForFile(
  file: PypiFile,
  pool: string[],
  requiresPython: string | null,
): string[] {
  const normalizedFilename = file.filename.toLowerCase()
  const pythonTag = file.python_version.toLowerCase()

  if (
    file.packagetype === 'sdist' ||
    pythonTag === 'source' ||
    normalizedFilename.endsWith('-any.whl') ||
    pythonTag === 'py3' ||
    pythonTag === 'py2.py3'
  ) {
    return []
  }

  if (normalizedFilename.includes('-abi3-')) {
    const minimumVersion = sortPythonVersions(
      extractExplicitPythonVersions(normalizedFilename, pythonTag).filter(
        (version) => !version.endsWith('t'),
      ),
    )[0]

    if (!minimumVersion) {
      return []
    }

    return sortPythonVersions(
      pool.filter((version) =>
        !version.endsWith('t') &&
        supportsPythonSpecifier(`>=${minimumVersion}`, version) &&
        supportsPythonSpecifier(requiresPython, version),
      ),
    )
  }

  return sortPythonVersions(
    extractExplicitPythonVersions(normalizedFilename, pythonTag).filter((version) =>
      supportsPythonSpecifier(requiresPython, version),
    ),
  )
}

function extractExplicitPythonVersionsFromFiles(files: PypiFile[]): string[] {
  const versions = new Set<string>()

  for (const file of files) {
    for (const version of extractExplicitPythonVersions(file.filename.toLowerCase(), file.python_version.toLowerCase())) {
      versions.add(version)
    }
  }

  return sortPythonVersions(versions)
}

function extractExplicitPythonVersions(filename: string, pythonTag: string): string[] {
  const versions = new Set<string>()
  const source = `${filename}-${pythonTag}`

  for (const match of source.matchAll(/(?:^|[-_.])(?:cp|py)(\d)(\d{1,2})(t?)(?=$|[-_.])/g)) {
    if (match[1] !== '3') {
      continue
    }

    const minor = String(Number(match[2]))
    const threadedSuffix = match[3] === 't' ? 't' : ''
    versions.add(`3.${minor}${threadedSuffix}`)
  }

  return sortPythonVersions(versions)
}

function extractExplicitPlatformTargetsFromFiles(files: PypiFile[]): PlatformOption[] {
  const targets = new Set<PlatformOption>()

  for (const file of files) {
    for (const target of inferPlatformTargetsFromFile(file) ?? []) {
      targets.add(target)
    }
  }

  return sortPlatformOptions(targets)
}

function inferPlatformTargetsFromFile(file: PypiFile): PlatformOption[] | null {
  const normalized = file.filename.toLowerCase()
  const pythonTag = file.python_version.toLowerCase()

  if (
    file.packagetype === 'sdist' ||
    pythonTag === 'source' ||
    normalized.endsWith('-any.whl') ||
    pythonTag === 'py3' ||
    pythonTag === 'py2.py3'
  ) {
    return null
  }

  const targets = new Set<PlatformOption>()

  if (normalized.includes('manylinux') || normalized.includes('musllinux') || normalized.includes('linux')) {
    if (normalized.includes('aarch64') || normalized.includes('arm64')) {
      targets.add('linux-aarch64')
    }
    if (normalized.includes('x86_64') || normalized.includes('amd64')) {
      targets.add('linux-x86_64')
    }
    if (normalized.includes('armv7l')) {
      targets.add('linux-armv7l')
    }
    if (normalized.includes('ppc64le')) {
      targets.add('linux-ppc64le')
    }
    if (normalized.includes('s390x')) {
      targets.add('linux-s390x')
    }
    if (normalized.includes('i686') || normalized.includes('i386')) {
      targets.add('linux-x86')
    }
  }

  if (normalized.includes('win_amd64')) {
    targets.add('windows-x86_64')
  }
  if (normalized.includes('win_arm64')) {
    targets.add('windows-arm64')
  }
  if (normalized.includes('win32')) {
    targets.add('windows-x86')
  }

  if (normalized.includes('macosx') || normalized.includes('darwin')) {
    if (normalized.includes('universal2')) {
      targets.add('macos-arm64')
      targets.add('macos-x86_64')
    }
    if (normalized.includes('arm64')) {
      targets.add('macos-arm64')
    }
    if (normalized.includes('x86_64')) {
      targets.add('macos-x86_64')
    }
  }

  return targets.size > 0 ? sortPlatformOptions(targets) : null
}

function parseRequirementList(requiresDist: string[]): ParsedRequirement[] {
  const parsed: ParsedRequirement[] = []

  for (const rawRequirement of requiresDist) {
    try {
      parsed.push(parseRequirement(rawRequirement))
    } catch {
    }
  }

  return parsed
}

function hasRequirementVariation<T>(
  requirements: ParsedRequirement[],
  values: T[],
  toContext: (value: T) => MarkerContext,
): boolean {
  if (requirements.length === 0 || values.length === 0) {
    return false
  }

  const signatures = new Set(
    values.map((value) => getActiveRequirementSignature(requirements, toContext(value))),
  )

  return signatures.size > 1
}

function getActiveRequirementSignature(
  requirements: ParsedRequirement[],
  context: MarkerContext,
): string {
  return requirements
    .filter((requirement) => isRequirementActive(requirement, context))
    .map((requirement) => requirement.raw)
    .sort((left, right) => left.localeCompare(right))
    .join('|')
}

function isRequirementActive(requirement: ParsedRequirement, context: MarkerContext): boolean {
  if (!requirement.markerAst || !requirement.markerText) {
    return true
  }

  return evaluateMarker(requirement.markerAst, context, requirement.markerText).active
}

function pickSupportedPythonVersion(selected: string, supported: string[]): string {
  if (supported.includes(selected)) {
    return selected
  }

  const standardFallback = [...supported].reverse().find((version) => !version.endsWith('t'))
  return standardFallback ?? supported[supported.length - 1] ?? selected
}

function pickSupportedRootVersion(selected: string | null, supported: string[]): string | null {
  if (!selected) {
    return null
  }

  return supported.includes(selected) ? selected : null
}

function pickSupportedPlatform(selected: PlatformOption, supported: PlatformOption[]): PlatformOption {
  const normalized = normalizePlatformTarget(selected)
  if (supported.includes(normalized)) {
    return normalized
  }

  const selectedFamily = getPlatformDescriptor(normalized).family
  const familyFallback = supported.find((platform) => getPlatformDescriptor(platform).family === selectedFamily)
  return familyFallback ?? supported[0] ?? normalized
}

function selectRootVersion(
  versions: string[],
  requestedVersion: string | null,
): {
  selectedVersion: string | null
  legalVersions: string[]
  rejectionReason: string | null
} {
  if (requestedVersion) {
    return {
      selectedVersion: versions.includes(requestedVersion) ? requestedVersion : null,
      legalVersions: versions,
      rejectionReason: versions.includes(requestedVersion)
        ? null
        : `Requested root version ${requestedVersion} was not available on PyPI.`,
    }
  }

  const autoSelected = selectVersion(versions, [])
  return {
    selectedVersion: autoSelected.selectedVersion,
    legalVersions: versions,
    rejectionReason: autoSelected.rejectionReason,
  }
}

function projectSnapshotFromReleases(releases: Record<string, { yanked: boolean }[]>): ProjectSnapshot {
  const yankedVersions = new Set<string>()
  const releaseVersions = Object.entries(releases)
    .filter(([, files]) => files.length > 0)
    .map(([version, files]) => {
      const allYanked = files.every((file) => file.yanked)
      if (allYanked) {
        yankedVersions.add(version)
      }
      return version
    })

  return {
    releases: releaseVersions,
    yankedVersions,
  }
}

function mergeNode(
  node: GraphNode,
  incomingRequirements: string[],
  specifiers: string[],
  legalVersions: string[],
  manualOverride: string | null,
): void {
  node.incomingRequirements = uniqueSorted([...node.incomingRequirements, ...incomingRequirements])
  node.combinedSpecifiers = uniqueSorted([...node.combinedSpecifiers, ...specifiers])
  node.availableVersions = legalVersions
  node.manualOverride = manualOverride
}

function ensureUnresolvedNode(
  state: ResolverState,
  request: ResolveRequest,
  legalVersions: string[],
  manualOverride: string | null,
  reason: string,
  displayName: string,
): string {
  const nodeId = `unresolved:${request.normalizedName}:${hashValue(`${request.specifiers.join(',')}|${request.selectedExtras.join(',')}|${reason}`)}`
  if (state.nodes.has(nodeId)) {
    return nodeId
  }

  state.nodes.set(nodeId, {
    id: nodeId,
    kind: 'unresolved',
    packageName: displayName,
    normalizedName: request.normalizedName,
    version: null,
    displayVersion: 'unresolved',
    summary: reason,
    depth: request.depth,
    selectedExtras: request.selectedExtras,
    incomingRequirements: request.requirementTexts,
    inactiveRequirements: [],
    availableVersions: legalVersions,
    combinedSpecifiers: request.specifiers,
    manualOverride,
    requiresPython: null,
    projectUrl: null,
    cacheSource: 'network',
    notes: [reason],
  })
  return nodeId
}

function buildEdge(source: string, target: string, requirement: string, markerText: string | null): GraphEdge {
  return {
    id: makeEdgeId(source, target, requirement),
    source,
    target,
    requirement,
    markerText,
  }
}

function makeEdgeId(source: string, target: string, requirement: string): string {
  return `${source}->${target}:${hashValue(requirement)}`
}

function makeNodeId(normalizedName: string, version: string, selectedExtras: string[]): string {
  const extrasSuffix =
    selectedExtras.length > 0
      ? `[${[...new Set(selectedExtras)].sort((left, right) => left.localeCompare(right)).join(',')}]`
      : ''
  return `${normalizedName}@${version}${extrasSuffix}`
}

function hashValue(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}

function extractRootExtras(requiresDist: string[]): string[] {
  const extras = new Set<string>()

  for (const rawRequirement of requiresDist) {
    try {
      const parsed = parseRequirement(rawRequirement)
      if (parsed.markerAst && parsed.markerText) {
        collectMarkerInsights(parsed.markerAst, {
          extras,
          platforms: new Set<string>(),
          pythonMarkers: new Set<string>(),
          markerFields: new Set<string>(),
        }, parsed.markerText)
      }
    } catch {
    }
  }

  return [...extras]
}

function createProgressReporter(
  getState: () => ResolverState,
  onProgress?: ResolveDependencyGraphOptions['onProgress'],
): ProgressReporter {
  let lastFingerprint = ''

  return {
    emit(update, force = false) {
      if (!onProgress) {
        return
      }

      const state = getState()
      const snapshot: ResolutionProgress = {
        phase: update.phase,
        message: update.message,
        currentPackage: update.currentPackage ?? null,
        depth: update.depth ?? null,
        nodesDiscovered: state.nodes.size,
        edgesDiscovered: state.edges.size,
        cacheHits: state.limits.cacheHits,
        networkRequests: state.limits.networkRequests,
      }
      const fingerprint = JSON.stringify(snapshot)
      if (!force && fingerprint === lastFingerprint) {
        return
      }

      lastFingerprint = fingerprint
      onProgress(snapshot)
    },
  }
}

async function fetchProjectSummary(
  normalizedName: string,
  displayName: string,
  client: PypiClient,
  state: ResolverState,
  phase: ResolutionProgress['phase'],
  depth: number | null,
): Promise<{ data: PypiProjectResponse; source: 'cache' | 'network' }> {
  state.progress.emit({
    phase,
    message: `Loading metadata for ${displayName}…`,
    currentPackage: displayName,
    depth,
  })

  const result = await client.getProject(normalizedName)
  recordFetchSource(state.limits, result.source)
  state.progress.emit({
    phase,
    message: `Loaded metadata for ${result.data.info.name} from ${result.source}.`,
    currentPackage: result.data.info.name,
    depth,
  })

  return result
}

async function fetchVersionPayload(
  normalizedName: string,
  version: string,
  displayName: string,
  client: PypiClient,
  state: ResolverState,
  phase: ResolutionProgress['phase'],
  depth: number | null,
): Promise<{ data: PypiVersionResponse; source: 'cache' | 'network' }> {
  state.progress.emit({
    phase,
    message: `Loading ${displayName} ${version} metadata…`,
    currentPackage: displayName,
    depth,
  })

  const result = await client.getVersion(normalizedName, version)
  recordFetchSource(state.limits, result.source)
  state.progress.emit({
    phase,
    message: `Loaded ${displayName} ${version} metadata from ${result.source}.`,
    currentPackage: displayName,
    depth,
  })

  return result
}

function emptyLimits(): ResolutionLimits {
  return {
    cycleEdges: 0,
    unresolvedNodes: 0,
    skippedDirectReferences: 0,
    parseFailures: 0,
    inactiveRequirements: 0,
    cacheHits: 0,
    networkRequests: 0,
  }
}

function recordFetchSource(limits: ResolutionLimits, source: 'cache' | 'network'): void {
  if (source === 'cache') {
    limits.cacheHits += 1
  } else {
    limits.networkRequests += 1
  }
}
