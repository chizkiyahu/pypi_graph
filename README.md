# PyPI DepGraph

Interactive dependency graph explorer for Python PyPI packages. Deployed as a static GitHub Pages site.

## Features

- Enter a PyPI package name and resolve its full dependency graph using the PyPI JSON API.
- Evaluate extras, Python version markers, and platform markers in-browser.
- Rebuild the graph when the top-level Python version, platform, or extras change.
- Manually pin displayed dependency versions when the selected version is still legal under the active constraints.
- Minimize repeat PyPI calls with an IndexedDB cache plus in-flight request deduplication.
- Deploy as a static site with GitHub Actions and GitHub Pages.

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
