# Compatibility Matrix (Canvas vs WebGL vs WebGPU)

This test suite generates a renderer capability matrix for *flat style* properties + expression variants.

It is designed to be:
- End-to-end (renders to a real canvas in a real browser via Puppeteer).
- High-combination (many small permutations instead of a few large cases).
- Baseline-driven (like rendering tests), but stores results as JSON instead of `expected.png`.
- Result-driven (a scenario is considered supported only if it renders non-blank output).

## Run

Build the full bundle once (required because the runner uses `build/full/ol.js`):

```sh
npm run build-full
```

Then run the matrix against the checked-in baseline:

```sh
node test/compat-matrix/test.js
```

Generate/update the baseline (writes `test/compat-matrix/baseline.json`):

```sh
node test/compat-matrix/test.js --fix
```

Useful options:

```sh
node test/compat-matrix/test.js --headless --gpu-info --log-level info
node test/compat-matrix/test.js --require-hardware --gpu-info --log-level info
```

## View

Open `test/compat-matrix/viewer.html` in a browser (it fetches `baseline.json`).
