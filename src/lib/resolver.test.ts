import { describe, expect, it } from 'vitest'
import { MemoryCacheStore } from './cache.ts'
import { evaluateMarker, parseMarkerExpression } from './marker.ts'
import { createPypiClient } from './pypi.ts'
import { resolveDependencyGraph } from './resolver.ts'
import { parseRequirement } from './requirements.ts'
import { selectVersion } from './versions.ts'

describe('requirement parsing', () => {
  it('parses extras, specifiers, and markers', () => {
    const requirement = parseRequirement(
      'httpx[socks]>=0.27.0; python_version >= "3.9" and sys_platform != "win32"',
    )

    expect(requirement.name).toBe('httpx')
    expect(requirement.extras).toEqual(['socks'])
    expect(requirement.specifier).toBe('>=0.27.0')
    expect(requirement.markerText).toBe('python_version >= "3.9" and sys_platform != "win32"')
  })

  it('normalizes parenthesized legacy specifiers', () => {
    const requirement = parseRequirement('text-unidecode (>=1.3)')
    expect(requirement.name).toBe('text-unidecode')
    expect(requirement.specifier).toBe('>=1.3')
  })
})

describe('marker evaluation', () => {
  it('evaluates platform and version markers', () => {
    const marker = parseMarkerExpression('python_version >= "3.11" and sys_platform == "linux"')
    const evaluation = evaluateMarker(marker, {
      pythonVersion: '3.12',
      pythonFullVersion: '3.12.0',
      sysPlatform: 'linux',
      platformSystem: 'Linux',
      osName: 'posix',
      platformMachine: 'x86_64',
      implementationName: 'cpython',
      implementationVersion: '3.12.0',
      platformPythonImplementation: 'CPython',
      extras: [],
    }, 'python_version >= "3.11" and sys_platform == "linux"')

    expect(evaluation.active).toBe(true)
  })

  it('treats free-threaded python labels as their base version for markers', () => {
    const marker = parseMarkerExpression('python_version >= "3.14"')
    const evaluation = evaluateMarker(marker, {
      pythonVersion: '3.14t',
      pythonFullVersion: '3.14.0',
      sysPlatform: 'linux',
      platformSystem: 'Linux',
      osName: 'posix',
      platformMachine: 'x86_64',
      implementationName: 'cpython',
      implementationVersion: '3.14.0',
      platformPythonImplementation: 'CPython',
      extras: [],
    }, 'python_version >= "3.14"')

    expect(evaluation.active).toBe(true)
  })
})

describe('version selection', () => {
  it('prefers the latest legal version and rejects illegal overrides', () => {
    const choice = selectVersion(['1.0.0', '1.2.0', '2.0.0'], ['>=1,<2'])
    expect(choice.selectedVersion).toBe('1.2.0')

    const rejected = selectVersion(['1.0.0', '1.2.0', '2.0.0'], ['>=1,<2'], '2.0.0')
    expect(rejected.selectedVersion).toBeNull()
    expect(rejected.legalVersions).toEqual(['1.2.0', '1.0.0'])
  })

  it('prefers stable releases over newer dev or prerelease builds by default', () => {
    const stableChoice = selectVersion(['1.0.dev3', '1.0.0', '1.1.0rc1'], [])
    expect(stableChoice.selectedVersion).toBe('1.0.0')
    expect(stableChoice.legalVersions).toEqual(['1.0.0'])

    const prereleaseOnlyChoice = selectVersion(['1.0.dev3', '1.1.0rc1'], [])
    expect(prereleaseOnlyChoice.selectedVersion).toBe('1.1.0rc1')
    expect(prereleaseOnlyChoice.legalVersions).toEqual(['1.1.0rc1', '1.0.dev3'])
  })
})

describe('resolver integration', () => {
  it('builds a recursive graph using cached project responses', async () => {
    const fixtures = new Map<string, object>([
      [
        'https://pypi.org/pypi/demo/json',
        {
          info: {
            name: 'demo',
            version: '1.0.1',
            summary: 'demo root',
            requires_dist: ['dep>=2; python_version >= "3.11"'],
            requires_python: '>=3.11',
            provides_extra: ['speed'],
            package_url: 'https://pypi.org/project/demo/',
          },
          releases: {
            '1.0.0': [
              {
                filename: 'demo-1.0.0-cp312-cp312-manylinux_2_17_x86_64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp312',
                requires_python: '>=3.11',
                yanked: false,
              },
              {
                filename: 'demo-1.0.0-cp312-cp312-macosx_11_0_arm64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp312',
                requires_python: '>=3.11',
                yanked: false,
              },
            ],
            '1.0.1': [
              {
                filename: 'demo-1.0.1-cp312-cp312-manylinux_2_17_x86_64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp312',
                requires_python: '>=3.11',
                yanked: false,
              },
              {
                filename: 'demo-1.0.1-cp312-cp312-macosx_11_0_arm64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp312',
                requires_python: '>=3.11',
                yanked: false,
              },
            ],
            '1.1.0rc1': [
              {
                filename: 'demo-1.1.0rc1-cp312-cp312-manylinux_2_17_x86_64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp312',
                requires_python: '>=3.11',
                yanked: false,
              },
            ],
          },
        },
      ],
      [
        'https://pypi.org/pypi/demo/1.1.0rc1/json',
        {
          info: {
            name: 'demo',
            version: '1.1.0rc1',
            summary: 'demo prerelease',
            requires_dist: ['dep>=2; python_version >= "3.11"'],
            requires_python: '>=3.11',
            provides_extra: ['speed'],
            package_url: 'https://pypi.org/project/demo/',
          },
          urls: [
            {
              filename: 'demo-1.1.0rc1-cp312-cp312-manylinux_2_17_x86_64.whl',
              packagetype: 'bdist_wheel',
              python_version: 'cp312',
              requires_python: '>=3.11',
              yanked: false,
            },
          ],
        },
      ],
      [
        'https://pypi.org/pypi/dep/json',
        {
          info: {
            name: 'dep',
            version: '2.2.0',
            summary: 'dep latest',
            requires_dist: ['leaf>=1'],
            requires_python: null,
            provides_extra: null,
            package_url: 'https://pypi.org/project/dep/',
          },
          releases: {
            '2.0.0': [
              {
                filename: 'dep-2.0.0.tar.gz',
                packagetype: 'sdist',
                python_version: 'source',
                requires_python: null,
                yanked: false,
              },
            ],
            '2.2.0': [
              {
                filename: 'dep-2.2.0.tar.gz',
                packagetype: 'sdist',
                python_version: 'source',
                requires_python: null,
                yanked: false,
              },
            ],
          },
        },
      ],
      [
        'https://pypi.org/pypi/leaf/json',
        {
          info: {
            name: 'leaf',
            version: '1.5.0',
            summary: 'leaf latest',
            requires_dist: null,
            requires_python: null,
            provides_extra: null,
            package_url: 'https://pypi.org/project/leaf/',
          },
          releases: {
            '1.5.0': [
              {
                filename: 'leaf-1.5.0.tar.gz',
                packagetype: 'sdist',
                python_version: 'source',
                requires_python: null,
                yanked: false,
              },
            ],
          },
        },
      ],
    ])

    const fetcher = async (input: RequestInfo | URL) => {
      const key = String(input)
      const data = fixtures.get(key)
      if (!data) {
        return new Response('Not found', { status: 404 })
      }
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }

    const client = createPypiClient({
      cache: new MemoryCacheStore(),
      fetcher,
      ttlMs: 1000 * 60 * 60,
    })
    const progressUpdates: string[] = []

    const graph = await resolveDependencyGraph({
      packageName: 'demo',
      rootVersion: null,
      pythonVersion: '3.12',
      platform: 'linux',
      extras: [],
      manualVersions: {},
    }, client, {
      onProgress(progress) {
        progressUpdates.push(progress.phase)
      },
    })

    expect(graph.nodes.map((node) => node.packageName)).toEqual(['demo', 'dep', 'leaf'])
    expect(graph.nodes[0]?.displayVersion).toBe('1.0.1')
    expect(graph.edges).toHaveLength(2)
    expect(graph.limits.networkRequests).toBe(3)
    expect(graph.limits.cacheHits).toBe(2)
    expect(progressUpdates).toContain('loading-metadata')
    expect(progressUpdates).toContain('analyzing-environment')
    expect(progressUpdates).toContain('resolving-graph')
    expect(progressUpdates.at(-1)).toBe('complete')
    expect(graph.rootOptions.availableVersions).toEqual(['1.1.0rc1', '1.0.1', '1.0.0'])
    expect(graph.rootOptions.showVersionSelector).toBe(true)
    expect(graph.rootOptions.supportedPythonVersions).toEqual(['3.12'])
    expect(graph.rootOptions.supportedPlatforms).toEqual(['linux-x86_64', 'macos-arm64'])
    expect(graph.rootOptions.showPythonSelector).toBe(true)
    expect(graph.rootOptions.showPlatformSelector).toBe(true)
  })

  it('allows selecting a root prerelease version explicitly', async () => {
    const fixtures = new Map<string, object>([
      [
        'https://pypi.org/pypi/demo/json',
        {
          info: {
            name: 'demo',
            version: '1.0.1',
            summary: 'demo root',
            requires_dist: null,
            requires_python: '>=3.11',
            provides_extra: null,
            package_url: 'https://pypi.org/project/demo/',
          },
          releases: {
            '1.0.1': [
              {
                filename: 'demo-1.0.1.tar.gz',
                packagetype: 'sdist',
                python_version: 'source',
                requires_python: '>=3.11',
                yanked: false,
              },
            ],
            '1.1.0rc1': [
              {
                filename: 'demo-1.1.0rc1.tar.gz',
                packagetype: 'sdist',
                python_version: 'source',
                requires_python: '>=3.11',
                yanked: false,
              },
            ],
          },
        },
      ],
      [
        'https://pypi.org/pypi/demo/1.1.0rc1/json',
        {
          info: {
            name: 'demo',
            version: '1.1.0rc1',
            summary: 'demo prerelease',
            requires_dist: null,
            requires_python: '>=3.11',
            provides_extra: null,
            package_url: 'https://pypi.org/project/demo/',
          },
          urls: [
            {
              filename: 'demo-1.1.0rc1.tar.gz',
              packagetype: 'sdist',
              python_version: 'source',
              requires_python: '>=3.11',
              yanked: false,
            },
          ],
        },
      ],
    ])

    const fetcher = async (input: RequestInfo | URL) => {
      const key = String(input)
      const data = fixtures.get(key)
      if (!data) {
        return new Response('Not found', { status: 404 })
      }
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }

    const client = createPypiClient({
      cache: new MemoryCacheStore(),
      fetcher,
      ttlMs: 1000 * 60 * 60,
    })

    const graph = await resolveDependencyGraph({
      packageName: 'demo',
      rootVersion: '1.1.0rc1',
      pythonVersion: '3.12',
      platform: 'linux',
      extras: [],
      manualVersions: {},
    }, client)

    expect(graph.nodes[0]?.displayVersion).toBe('1.1.0rc1')
    expect(graph.effectiveInputs.rootVersion).toBe('1.1.0rc1')
  })

  it('auto-selects the latest stable root release even when PyPI info.version is a prerelease', async () => {
    const fixtures = new Map<string, object>([
      [
        'https://pypi.org/pypi/demo/json',
        {
          info: {
            name: 'demo',
            version: '1.1.0rc1',
            summary: 'demo prerelease head',
            requires_dist: null,
            requires_python: '>=3.11',
            provides_extra: null,
            package_url: 'https://pypi.org/project/demo/',
          },
          releases: {
            '1.0.1': [
              {
                filename: 'demo-1.0.1-cp312-cp312-manylinux_2_17_x86_64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp312',
                requires_python: '>=3.11',
                yanked: false,
              },
              {
                filename: 'demo-1.0.1-cp312-cp312-win_amd64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp312',
                requires_python: '>=3.11',
                yanked: false,
              },
            ],
            '1.1.0rc1': [
              {
                filename: 'demo-1.1.0rc1-cp312-cp312-manylinux_2_17_x86_64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp312',
                requires_python: '>=3.11',
                yanked: false,
              },
            ],
          },
        },
      ],
      [
        'https://pypi.org/pypi/demo/1.0.1/json',
        {
          info: {
            name: 'demo',
            version: '1.0.1',
            summary: 'demo stable release',
            requires_dist: null,
            requires_python: '>=3.11',
            provides_extra: null,
            package_url: 'https://pypi.org/project/demo/',
          },
          urls: [
            {
              filename: 'demo-1.0.1-cp312-cp312-manylinux_2_17_x86_64.whl',
              packagetype: 'bdist_wheel',
              python_version: 'cp312',
              requires_python: '>=3.11',
              yanked: false,
            },
            {
              filename: 'demo-1.0.1-cp312-cp312-win_amd64.whl',
              packagetype: 'bdist_wheel',
              python_version: 'cp312',
              requires_python: '>=3.11',
              yanked: false,
            },
          ],
        },
      ],
    ])

    const fetcher = async (input: RequestInfo | URL) => {
      const key = String(input)
      const data = fixtures.get(key)
      if (!data) {
        return new Response('Not found', { status: 404 })
      }
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }

    const client = createPypiClient({
      cache: new MemoryCacheStore(),
      fetcher,
      ttlMs: 1000 * 60 * 60,
    })

    const graph = await resolveDependencyGraph({
      packageName: 'demo',
      rootVersion: null,
      pythonVersion: '3.12',
      platform: 'linux',
      extras: [],
      manualVersions: {},
    }, client)

    expect(graph.nodes[0]?.displayVersion).toBe('1.0.1')
    expect(graph.rootOptions.supportedPlatforms).toEqual(['linux-x86_64', 'windows-x86_64'])
  })

  it('derives python selectors from wheel tags including free-threaded builds', async () => {
    const fixtures = new Map<string, object>([
      [
        'https://pypi.org/pypi/demo/json',
        {
          info: {
            name: 'demo',
            version: '2.0.0',
            summary: 'demo threaded wheels',
            requires_dist: null,
            requires_python: '>=3.14',
            provides_extra: null,
            package_url: 'https://pypi.org/project/demo/',
          },
          releases: {
            '2.0.0': [
              {
                filename: 'demo-2.0.0-cp314-cp314-manylinux_2_17_x86_64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp314',
                requires_python: '>=3.14',
                yanked: false,
              },
              {
                filename: 'demo-2.0.0-cp314-cp314t-manylinux_2_17_x86_64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp314',
                requires_python: '>=3.14',
                yanked: false,
              },
            ],
          },
        },
      ],
    ])

    const fetcher = async (input: RequestInfo | URL) => {
      const key = String(input)
      const data = fixtures.get(key)
      if (!data) {
        return new Response('Not found', { status: 404 })
      }
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }

    const client = createPypiClient({
      cache: new MemoryCacheStore(),
      fetcher,
      ttlMs: 1000 * 60 * 60,
    })

    const graph = await resolveDependencyGraph({
      packageName: 'demo',
      rootVersion: null,
      pythonVersion: '3.12',
      platform: 'linux',
      extras: [],
      manualVersions: {},
    }, client)

    expect(graph.rootOptions.supportedPythonVersions).toEqual(['3.14', '3.14t'])
    expect(graph.effectiveInputs.pythonVersion).toBe('3.14')
  })

  it('keeps future python minors in the selector pool for specifier-based packages', async () => {
    const fixtures = new Map<string, object>([
      [
        'https://pypi.org/pypi/demo/json',
        {
          info: {
            name: 'demo',
            version: '3.0.0',
            summary: 'demo future python markers',
            requires_dist: ['future-only>=1; python_version >= "3.15"'],
            requires_python: '>=3.8',
            provides_extra: null,
            package_url: 'https://pypi.org/project/demo/',
          },
          releases: {
            '3.0.0': [
              {
                filename: 'demo-3.0.0.tar.gz',
                packagetype: 'sdist',
                python_version: 'source',
                requires_python: '>=3.8',
                yanked: false,
              },
            ],
          },
        },
      ],
    ])

    const fetcher = async (input: RequestInfo | URL) => {
      const key = String(input)
      const data = fixtures.get(key)
      if (!data) {
        return new Response('Not found', { status: 404 })
      }
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }

    const client = createPypiClient({
      cache: new MemoryCacheStore(),
      fetcher,
      ttlMs: 1000 * 60 * 60,
    })

    const graph = await resolveDependencyGraph({
      packageName: 'demo',
      rootVersion: null,
      pythonVersion: '3.12',
      platform: 'linux',
      extras: [],
      manualVersions: {},
    }, client)

    expect(graph.rootOptions.supportedPythonVersions).toContain('3.15')
    expect(graph.rootOptions.showPythonSelector).toBe(true)
  })

  it('propagates platform and python support from nested dependencies', async () => {
    const fixtures = new Map<string, object>([
      [
        'https://pypi.org/pypi/demo/json',
        {
          info: {
            name: 'demo',
            version: '1.0.0',
            summary: 'demo root',
            requires_dist: ['middle>=1'],
            requires_python: null,
            provides_extra: null,
            package_url: 'https://pypi.org/project/demo/',
          },
          releases: {
            '1.0.0': [
              {
                filename: 'demo-1.0.0.tar.gz',
                packagetype: 'sdist',
                python_version: 'source',
                requires_python: null,
                yanked: false,
              },
            ],
          },
        },
      ],
      [
        'https://pypi.org/pypi/middle/json',
        {
          info: {
            name: 'middle',
            version: '1.0.0',
            summary: 'middle layer',
            requires_dist: ['leaf>=2'],
            requires_python: null,
            provides_extra: null,
            package_url: 'https://pypi.org/project/middle/',
          },
          releases: {
            '1.0.0': [
              {
                filename: 'middle-1.0.0.tar.gz',
                packagetype: 'sdist',
                python_version: 'source',
                requires_python: null,
                yanked: false,
              },
            ],
          },
        },
      ],
      [
        'https://pypi.org/pypi/leaf/json',
        {
          info: {
            name: 'leaf',
            version: '2.0.0',
            summary: 'restricted leaf',
            requires_dist: null,
            requires_python: '>=3.12,<3.13',
            provides_extra: null,
            package_url: 'https://pypi.org/project/leaf/',
          },
          releases: {
            '2.0.0': [
              {
                filename: 'leaf-2.0.0-cp312-cp312-manylinux_2_17_x86_64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp312',
                requires_python: '>=3.12,<3.13',
                yanked: false,
              },
              {
                filename: 'leaf-2.0.0-cp312-cp312-macosx_11_0_arm64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp312',
                requires_python: '>=3.12,<3.13',
                yanked: false,
              },
            ],
          },
        },
      ],
    ])

    const fetcher = async (input: RequestInfo | URL) => {
      const key = String(input)
      const data = fixtures.get(key)
      if (!data) {
        return new Response('Not found', { status: 404 })
      }
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }

    const client = createPypiClient({
      cache: new MemoryCacheStore(),
      fetcher,
      ttlMs: 1000 * 60 * 60,
    })

    const graph = await resolveDependencyGraph({
      packageName: 'demo',
      rootVersion: null,
      pythonVersion: '3.11',
      platform: 'windows-x86_64',
      extras: [],
      manualVersions: {},
    }, client)

    expect(graph.rootOptions.supportedPythonVersions).toEqual(['3.12'])
    expect(graph.rootOptions.supportedPlatforms).toEqual(['linux-x86_64', 'macos-arm64'])
    expect(graph.effectiveInputs.pythonVersion).toBe('3.12')
    expect(graph.effectiveInputs.platform).toBe('linux-x86_64')
    expect(graph.rootOptions.showPythonSelector).toBe(true)
    expect(graph.rootOptions.showPlatformSelector).toBe(true)
  })

  it('shows TensorFlow-style wheel targets as distinct supported platforms', async () => {
    const fixtures = new Map<string, object>([
      [
        'https://pypi.org/pypi/demo/json',
        {
          info: {
            name: 'demo',
            version: '2.21.0',
            summary: 'demo tensorflow-like wheels',
            requires_dist: null,
            requires_python: '>=3.10',
            provides_extra: null,
            package_url: 'https://pypi.org/project/demo/',
          },
          releases: {
            '2.21.0': [
              {
                filename: 'demo-2.21.0-cp310-cp310-macosx_12_0_arm64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp310',
                requires_python: '>=3.10',
                yanked: false,
              },
              {
                filename: 'demo-2.21.0-cp310-cp310-manylinux_2_27_aarch64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp310',
                requires_python: '>=3.10',
                yanked: false,
              },
              {
                filename: 'demo-2.21.0-cp310-cp310-manylinux_2_27_x86_64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp310',
                requires_python: '>=3.10',
                yanked: false,
              },
              {
                filename: 'demo-2.21.0-cp310-cp310-win_amd64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp310',
                requires_python: '>=3.10',
                yanked: false,
              },
              {
                filename: 'demo-2.21.0-cp311-cp311-macosx_12_0_arm64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp311',
                requires_python: '>=3.10',
                yanked: false,
              },
              {
                filename: 'demo-2.21.0-cp311-cp311-manylinux_2_27_aarch64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp311',
                requires_python: '>=3.10',
                yanked: false,
              },
              {
                filename: 'demo-2.21.0-cp311-cp311-manylinux_2_27_x86_64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp311',
                requires_python: '>=3.10',
                yanked: false,
              },
              {
                filename: 'demo-2.21.0-cp311-cp311-win_amd64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp311',
                requires_python: '>=3.10',
                yanked: false,
              },
              {
                filename: 'demo-2.21.0-cp312-cp312-macosx_12_0_arm64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp312',
                requires_python: '>=3.10',
                yanked: false,
              },
              {
                filename: 'demo-2.21.0-cp312-cp312-manylinux_2_27_aarch64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp312',
                requires_python: '>=3.10',
                yanked: false,
              },
              {
                filename: 'demo-2.21.0-cp312-cp312-manylinux_2_27_x86_64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp312',
                requires_python: '>=3.10',
                yanked: false,
              },
              {
                filename: 'demo-2.21.0-cp312-cp312-win_amd64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp312',
                requires_python: '>=3.10',
                yanked: false,
              },
              {
                filename: 'demo-2.21.0-cp313-cp313-macosx_12_0_arm64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp313',
                requires_python: '>=3.10',
                yanked: false,
              },
              {
                filename: 'demo-2.21.0-cp313-cp313-manylinux_2_27_aarch64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp313',
                requires_python: '>=3.10',
                yanked: false,
              },
              {
                filename: 'demo-2.21.0-cp313-cp313-manylinux_2_27_x86_64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp313',
                requires_python: '>=3.10',
                yanked: false,
              },
              {
                filename: 'demo-2.21.0-cp313-cp313-win_amd64.whl',
                packagetype: 'bdist_wheel',
                python_version: 'cp313',
                requires_python: '>=3.10',
                yanked: false,
              },
            ],
          },
        },
      ],
    ])

    const fetcher = async (input: RequestInfo | URL) => {
      const key = String(input)
      const data = fixtures.get(key)
      if (!data) {
        return new Response('Not found', { status: 404 })
      }
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }

    const client = createPypiClient({
      cache: new MemoryCacheStore(),
      fetcher,
      ttlMs: 1000 * 60 * 60,
    })

    const graph = await resolveDependencyGraph({
      packageName: 'demo',
      rootVersion: null,
      pythonVersion: '3.12',
      platform: 'linux',
      extras: [],
      manualVersions: {},
    }, client)

    expect(graph.rootOptions.supportedPythonVersions).toEqual(['3.10', '3.11', '3.12', '3.13'])
    expect(graph.rootOptions.supportedPlatforms).toEqual([
      'linux-x86_64',
      'linux-aarch64',
      'windows-x86_64',
      'macos-arm64',
    ])
    expect(graph.rootOptions.showPlatformSelector).toBe(true)
  })

  it('resolves dependencies declared with parenthesized legacy specifiers', async () => {
    const fixtures = new Map<string, object>([
      [
        'https://pypi.org/pypi/demo/json',
        {
          info: {
            name: 'demo',
            version: '1.0.0',
            summary: 'demo legacy requirement',
            requires_dist: ['python-slugify>=8'],
            requires_python: '>=3.10',
            provides_extra: null,
            package_url: 'https://pypi.org/project/demo/',
          },
          releases: {
            '1.0.0': [
              {
                filename: 'demo-1.0.0.tar.gz',
                packagetype: 'sdist',
                python_version: 'source',
                requires_python: '>=3.10',
                yanked: false,
              },
            ],
          },
        },
      ],
      [
        'https://pypi.org/pypi/python-slugify/json',
        {
          info: {
            name: 'python-slugify',
            version: '8.0.4',
            summary: 'slugify package',
            requires_dist: ['text-unidecode (>=1.3)'],
            requires_python: '>=3.7',
            provides_extra: null,
            package_url: 'https://pypi.org/project/python-slugify/',
          },
          releases: {
            '8.0.4': [
              {
                filename: 'python_slugify-8.0.4.tar.gz',
                packagetype: 'sdist',
                python_version: 'source',
                requires_python: '>=3.7',
                yanked: false,
              },
            ],
          },
        },
      ],
      [
        'https://pypi.org/pypi/text-unidecode/json',
        {
          info: {
            name: 'text-unidecode',
            version: '1.3',
            summary: 'text transliteration',
            requires_dist: null,
            requires_python: null,
            provides_extra: null,
            package_url: 'https://pypi.org/project/text-unidecode/',
          },
          releases: {
            '1.3': [
              {
                filename: 'text_unidecode-1.3.tar.gz',
                packagetype: 'sdist',
                python_version: 'source',
                requires_python: null,
                yanked: false,
              },
            ],
          },
        },
      ],
    ])

    const fetcher = async (input: RequestInfo | URL) => {
      const key = String(input)
      const data = fixtures.get(key)
      if (!data) {
        return new Response('Not found', { status: 404 })
      }
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }

    const client = createPypiClient({
      cache: new MemoryCacheStore(),
      fetcher,
      ttlMs: 1000 * 60 * 60,
    })

    const graph = await resolveDependencyGraph({
      packageName: 'demo',
      rootVersion: null,
      pythonVersion: '3.12',
      platform: 'linux-x86_64',
      extras: [],
      manualVersions: {},
    }, client)

    expect(graph.nodes.some((node) => node.normalizedName === 'text-unidecode' && node.kind === 'package')).toBe(true)
    expect(graph.nodes.some((node) => node.normalizedName === 'text-unidecode' && node.kind === 'unresolved')).toBe(false)
  })

  it('does not deadlock while analyzing cyclic dependencies', async () => {
    const fixtures = new Map<string, object>([
      [
        'https://pypi.org/pypi/demo/json',
        {
          info: {
            name: 'demo',
            version: '1.0.0',
            summary: 'demo root',
            requires_dist: ['dep>=1'],
            requires_python: '>=3.11',
            provides_extra: null,
            package_url: 'https://pypi.org/project/demo/',
          },
          releases: {
            '1.0.0': [
              {
                filename: 'demo-1.0.0.tar.gz',
                packagetype: 'sdist',
                python_version: 'source',
                requires_python: '>=3.11',
                yanked: false,
              },
            ],
          },
        },
      ],
      [
        'https://pypi.org/pypi/dep/json',
        {
          info: {
            name: 'dep',
            version: '1.0.0',
            summary: 'dep child',
            requires_dist: ['demo>=1'],
            requires_python: '>=3.11',
            provides_extra: null,
            package_url: 'https://pypi.org/project/dep/',
          },
          releases: {
            '1.0.0': [
              {
                filename: 'dep-1.0.0.tar.gz',
                packagetype: 'sdist',
                python_version: 'source',
                requires_python: '>=3.11',
                yanked: false,
              },
            ],
          },
        },
      ],
    ])

    const fetcher = async (input: RequestInfo | URL) => {
      const key = String(input)
      const data = fixtures.get(key)
      if (!data) {
        return new Response('Not found', { status: 404 })
      }
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }

    const client = createPypiClient({
      cache: new MemoryCacheStore(),
      fetcher,
      ttlMs: 1000 * 60 * 60,
    })

    const graph = await Promise.race([
      resolveDependencyGraph(
        {
          packageName: 'demo',
          rootVersion: null,
          pythonVersion: '3.12',
          platform: 'linux-x86_64',
          extras: [],
          manualVersions: {},
        },
        client,
      ),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('cyclic environment analysis timed out')), 250)
      }),
    ])

    expect(graph.nodes.map((node) => node.packageName)).toEqual(['demo', 'dep'])
    expect(graph.edges).toHaveLength(2)
    expect(graph.limits.cycleEdges).toBe(1)
  })
})
