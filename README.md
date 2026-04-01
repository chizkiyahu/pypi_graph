# PyPI Dependency Graph Visualizer

**Free online tool to visualize Python package dependency trees.** Enter any PyPI package name and instantly explore its full dependency graph — resolve versions, extras, platform constraints, and pip install chains interactively in your browser. No installation required.

🔗 **[Live Demo →](https://chizkiyahu.github.io/pypi-depgraph/)**

## Why use this?

- **Audit what `pip install` actually pulls in** before committing to a new dependency.
- **Compare dependency trees** across different Python versions and platforms.
- **Explore extras** — see which optional dependency groups exist and what they add.
- **Understand version constraints** — view combined PEP 508 specifier fragments per node.
- **Works 100 % in the browser** — no backend, no sign-up, no data leaves your machine.

## Features

- Enter a PyPI package name and resolve its full dependency graph using the PyPI JSON API.
- Evaluate extras, Python version markers, and platform markers in-browser.
- Rebuild the graph when the top-level Python version, platform, or extras change.
- Manually pin displayed dependency versions when the selected version is still legal under the active constraints.
- Export the resolved graph as a machine-readable JSON file or a Markdown report.
- Minimize repeat PyPI calls with an IndexedDB cache plus in-flight request deduplication.
- Deploy as a static site with GitHub Actions and GitHub Pages.

## AI-agent friendly docs

- See [`public/llms.txt`](public/llms.txt) for automation tips and the stable URL/query contract agents can use.

## Resolution model

- Version selection is metadata-driven from released PyPI versions and PEP 508 markers.
- The app is not a full replacement for `pip`'s dependency solver.
- Direct URL dependencies are displayed as unresolved leaves and are not recursively expanded.
- Top-level extras are user-editable. Downstream extras are activated only when the parent requirement explicitly requests them.

## Development

```bash
npm install
npm run dev
```

## Verification

```bash
npm run test
npm run build
```

## Keywords

python dependency graph, pypi dependency tree, visualize pip dependencies, python package dependency checker, pip install dependency graph, python dependency tree viewer, pypi dependency explorer, interactive python dependency visualization
