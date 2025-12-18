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

