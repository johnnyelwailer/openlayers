# Performance Harness

This directory contains a small performance harness for comparing WebGL and WebGPU vector rendering on repeatable scenarios.

It uses Puppeteer to run browser-side scenarios and reports:
- frame time stats (median / p95 / max, plus dropped-frame counts)
- CPU work time stats per frame (time spent in `step()` + `map.renderSync()`)

## Running

Build the full bundle first:

```bash
npm run build-full
```

Run the harness:

```bash
node test/perf/test.js
```

Tune run parameters:

```bash
node test/perf/test.js --frames 300 --warmup 90 --features 5000
```

Write JSON results:

```bash
node test/perf/test.js --out test/perf/results.json
```

## Baselines / regressions

Because performance is machine-dependent, baselines are expected to be machine-local or stored externally (e.g. CI artifacts on a dedicated runner).

Compare against a baseline and fail if p95 frame time regresses by more than 15%:

```bash
node test/perf/test.js --compare path/to/baseline.json --threshold 0.15
```

## Adding scenarios

Scenarios live in `test/perf/runner.js` and should be:
- deterministic (no network, no randomness unless seeded)
- representative of a user-facing workload (e.g. style vars churn, pan/zoom, feature add/remove)
- cheap enough to run in a couple minutes with defaults

When working on performance, add a new scenario if an optimization targets a specific workload that is not covered by `style-vars` or `pan`.

Current scenarios:
- `style-vars`: rapid `updateStyleVariables()` churn
- `pan`: view panning
- `opacity`: layer opacity animation (exercises offscreen compositing in WebGPU)
- `geometry-churn`: periodic geometry updates (forces batch/buffer rebuilds; surfaces hitching) (currently opt-in via `--scenarios geometry-churn`)
- Vector tile scenarios are opt-in via `--vectortiles` because headless Chrome can be unstable for tile workloads.
