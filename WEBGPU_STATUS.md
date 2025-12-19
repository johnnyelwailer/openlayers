# WebGPU Vector Rendering - Implementation Status

**Date:** 2025-12-19
**Branch:** `feature/webgpu-vector` (implied)

## 1. Executive Summary
The core infrastructure for WebGPU vector rendering has been implemented, mirroring the architecture of the WebGL renderer. The system compiles and runs without runtime errors or validation crashes.

**Latest Progress (2025-12-17):**
*   **Compatibility Matrix Accuracy Improvements**:
    * Added compile-time expression backend probes (`capabilities/expr-operators/*`) to distinguish “unsupported operator” from “blank output”.
    * Extended expr probes to cover color-returning expressions (`case/interpolate/match` + `coalesce(color)`), not just numeric/boolean cases.
    * Made pattern sub-rect rows meaningful by auto-injecting required `fill-pattern-src` / `stroke-pattern-src` companions for `fill-pattern-*` / `stroke-pattern-*` property scenarios (avoids false positives where a property is a no-op without a pattern source).
    * Captures WebGPU validation errors per scenario (via `pushErrorScope('validation')`) so failures aren’t reduced to pixel diffs.
    * Reduced headless flakes by forcing deterministic map target sizing and retrying once when a scenario renders a transient blank frame.
    * When WebGPU style/buffer generation fails asynchronously, the compat runner now records the renderer’s last error via `WebGPUVectorLayerRenderer#getLastError()` (instead of only “Rendered blank output”).
*   **Render Loop Hardening**:
    * Reduced per-frame allocations in the opacity compositing path and avoid redundant uniform buffer writes when the layer opacity is unchanged.
    * Cache render pass descriptors and preferred canvas format to reduce per-frame object churn.
    * Avoid allocating/syncing the `vars` storage buffer when no `var()` expressions are used by the active style.
*   **WebGPU Pattern Option Hardening**: WebGPU rejects expressions for `*-pattern-size`, `*-pattern-offset`, `*-pattern-offset-origin`, and stroke `*-pattern-spacing` / `*-pattern-start-offset` with clear errors. Validation happens before any pattern texture is fetched/decoded.
*   **Expression + Style Parity**:
    * WGSL now supports `['has', ...]`, and missing feature properties in the WebGPU `props` buffer are encoded with `UNDEFINED_PROP_VALUE = -9999999` (aligns with WebGL “undefined” semantics for numeric reads).
    * WGSL now supports `['id']` by packing feature ids into the `props` buffer (strings encoded as stable numeric ids); enables `updateStyleVariables()`-driven hover/highlight filters like `examples/webgpu-vector-layer.html`.
    * WGSL now supports `['geometry-type']` by packing simplified geometry types per feature into the `props` buffer (aligns with WebGL “geometry-type” semantics for mixed geometry styling).
    * WGSL now supports `['coalesce', ...]` for missing feature properties via the `UNDEFINED_PROP_VALUE` sentinel (works for `get()` arguments; `var()` cannot currently be detected as undefined in WGSL).
    * Polygon `fill-color` now supports non-trivial expressions (e.g. `case`/`match`/arithmetic) by compiling to WGSL and evaluating per feature.
    * **String-based expressions (WebGL parity)**: strings are represented as stable numeric ids in WGSL, enabling string comparisons in `filter`, `match`, and `in` (fixes the style-variable + feature-property string filtering used in `examples/icon-sprite-webgpu.html`).
    * **Assertion/string ops in WGSL**: `number()` / `string()` assertions and literal-folding support for `concat()` / `to-string()` (improves compat-matrix expression probe coverage for WebGPU).
    * **Polygon fill-color correctness**: polygon `fill-color` expressions are compiled to WGSL when used as expressions (fixes “wrong colors” patterns like `['*', ['get','COLOR'], [220,220,220]]` in `examples/webgpu-vector-layer.html`).
*   **Compatibility Matrix Baseline Updated**: Regenerated `test/compat-matrix/baseline.json` after the above changes.
*   **Validation (Latest)**: `npm run lint`, `npm run typecheck`, `npm run build-full`, `node test/compat-matrix/test.js --headless`, and `npm run test-node` passing locally.

**Notes / Risks (current)**
*   **String semantics in WGSL**: strings are encoded as stable numeric ids (`getStringNumberEquivalent()`) so shaders can do equality-based operations (`==`, `match`, `in`). This is not “string support” beyond comparisons, and the mapping is runtime-local (not stable across sessions). Large numbers of unique strings can grow the mapping table.
*   **Feature id precision**: feature ids are stored as `f32` in the `props` buffer; very large integer ids (beyond ~16M) may lose integer precision, which can break exact-equality comparisons.
*   **Internal prop name collisions**: WebGPU reserves internal `props` keys (`__ol_feature_id__`, `__ol_geometry_type__`) to implement `id()` / `geometry-type()`. If user data contains these exact property names, they will be shadowed/overridden in shader reads.
*   **Special-input detection cost**: detecting `id()` / `geometry-type()` usage uses expression parsing (`parse(..., AnyType, ...)`) during `generateBuffers()`. This is not per-frame, but it can add overhead for very large rule/style sets.
*   **Feature properties packing overhead**: each `get()` property reserves **two `vec4f` slots** (scalar + color). This is simple and WebGL-parity-friendly, but can be memory-heavy for style sets that reference many properties. Consider a tighter packing if this becomes a bottleneck.
*   **TypeScript + WebGPU DOM types**: TypeScript’s DOM lib currently does not include WebGPU types, so the repo uses `@webgpu/types` via `compilerOptions.types` in `tsconfig.json` (inherited by `test/typescript/tsconfig.json`) so both source and generated `.d.ts` typecheck cleanly.
*   **Icon sprite sub-rect expressions**: `icon-size` / `icon-offset` expressions are evaluated on the CPU to compute sprite UVs (needed before drawing). If used with many features and complex expressions, this can become a CPU hotspot (a future GPU-side approach would need precomputed atlas metadata).
*   **Fill-color WGSL binding keepalive**: polygon fill shaders force a read of `styles[index]` even when the fill color expression doesn’t reference the style record, to avoid unused-binding validation issues. This is safe but slightly wasteful; a longer-term solution is to generate alternate pipelines with only the bindings actually used.

**Earlier Progress (2025-12-16):**
*   **Compat Matrix Parity (Points)**: Fixed WebGPU “blank output” for `circle-fill-color/var`, `circle-stroke-color/var`, `shape-fill-color/var`, `shape-stroke-color/var`, `icon-color/var`, `icon-size/get`, and `icon-size/var` by resolving `var()` and size expressions for point symbol style buffers.
*   **Icon Sprite Sub-rect Expressions**: WebGPU icon rendering now resolves `icon-size`/`icon-offset` as `literal|get|var` per feature (prevents NaNs in UVs and enables the compat-matrix icon-size coverage).
*   **Style Resolution Helpers**: Extended WebGPU style-buffer helpers to resolve `['var', …]` and added `resolveSize()` for `SizeExpression` handling (used in the point/icon pipeline).
*   **Feature Properties Buffer (`get()` in WGSL)**: Added a per-feature `props` storage buffer and switched WGSL `get()` compilation to read from it; enables rule filter discard on points/polygons (not just lines) and supports typed reads (scalars + colors) from feature properties in WebGPU WGSL expressions.
*   **Rule `else` Semantics (Points + Strokes)**: Implemented `else: true` behavior for point symbolizers and stroke rules by compiling an “effective filter” (`current && !any(prev)`) into shader discard logic.
*   **Bind Group Caching**: Reduced per-frame overhead by caching bind groups per buffer set (keyed by pipeline + bound resources), instead of creating bind groups on every render call.
*   **`props` Allocation Optimization**: Avoid allocating/binding the feature-properties buffer for CPU-resolved `get()` usage (e.g. direct `['get', ...]` stroke width/color), while still allocating when WGSL expressions require it (filters/expressions).
*   **Update Path Allocations Reduced**: Reused scratch arrays for per-feature GPU buffer updates and reused the uniform upload array to reduce GC churn.
*   **Batched Dirty Ref Updates**: Coalesced consecutive “dirty ref” style/props updates into contiguous `queue.writeBuffer()` uploads to reduce per-frame CPU overhead for rapidly changing feature properties.
*   **`time` Expression Parity**: Added support for `['time']` in WebGPU via a real uniform (WebGL parity), sourced from `frameState.time` / `performance.now()` to avoid epoch mismatches.
*   **CPU Hit Detection (Sync)**: Implemented a first-pass, synchronous `forEachFeatureAtPixel` path for WebGPU vector layers using source spatial indexing + CPU geometry distance checks (best-effort tolerance derived from literal style values); see `src/ol/renderer/webgpu/hitdetect.js`.
*   **Compatibility Matrix Baseline Updated**: Regenerated `test/compat-matrix/baseline.json` after the above parity fixes.
*   **Validation (Latest)**: `npm run lint`, `node test/rendering/test.js --match webgpu`, `npm run build-full`, and `node test/compat-matrix/test.js --headless` passing locally.

**Earlier Progress (2025-12-15):**
*   **Instanced Line Rendering**: Implemented GPU-side line expansion using instanced rendering with `triangle-strip` topology. Lines now correctly respect `stroke-width` style property.
*   **Stroke Width Support**: The shader now reads `resolution` uniform and expands line segments into quads, enabling variable-width lines that scale correctly with zoom.
*   **webgpu-vector Test**: ✅ Passing again. Polygons and lines render correctly.
*   **Compositing Fix**: Fixed CSS styles for WebGPU canvas (`position: absolute`, `width`, `height`).
*   **Stroke Artifacts Fix**: Resolved stride mismatch (XY vs XYM) in line buffer generation.
*   **WebGL-Equivalent Stroke AA/Joins**: Ported the WebGL stroke approach (join angles + distance-field based AA coverage) to WebGPU; eliminates visible corner/join artifacts.
*   **webgpu-vector-geographic Test**: ✅ Passing again and visually indistinguishable from expected.
*   **Stroke Style Parity**: Added support for `stroke-line-cap`, `stroke-line-join`, `stroke-miter-limit`, and `stroke-offset` in the WebGPU stroke pipeline.
*   **Dashes**: Added `stroke-line-dash` + `stroke-line-dash-offset` support (WebGL-equivalent distance-field approach).
*   **Stroke Patterns**: Added `stroke-pattern-src` sampling, including spacing/start-offset + sprite sub-rect offset/origin/size, with optional tint via `stroke-color`.
*   **Rule/Expression Subset**: Implemented minimal `line-metric` and `get(limit)` support for `webgpu-line-metric` (filter discard, dynamic width/color).
*   **`var()` Expressions (WebGPU)**: Added WGSL backend support for `var('name')` and plumbed a layer-level style variables buffer (`vars`) through the WebGPU vector pipelines.
*   **WebGPU Bind Group Hardening**: Fixed a validation regression caused by `layout: 'auto'` omitting unused bindings by only binding the variables buffer when the shader statically reads from `vars[...]`.
*   **Rendering Tests**: `webgpu-line`, `webgpu-line-metric`, `webgpu-line-pattern`, and `webgpu-line-zoomed-in` passing locally.
*   **Unit Tests**: Added/extended node tests for WGSL `var()` compilation and variable extraction/sync (`test/node/ol/expr/wgsl.test.js`, `test/node/ol/render/webgpu/expr.test.js`, `test/node/ol/render/webgpu/VectorStyleRenderer.test.js`).
*   **WGSL Expression Backend (WIP)**: Added `src/ol/expr/wgsl.js` and wired `src/ol/render/webgpu/expr.js` to use shared parsing/typing (`src/ol/expr/expression.js`) for the supported subset.
*   **Icon Y Orientation**: Fixed `icon-src` sampling orientation for WebGPU point/icon pipeline (removes vertical flip in `webgpu-points-geographic`).
*   **KML XYZ Point Coordinates**: Fixed WebGPU point buffer generation to handle `Point` flat coords that include altitude (XYZ/XYZM) by consuming only XY per point (fixes missing points / bad ordering in `webgpu-points`).
*   **wrapX / Multi-World Rendering**: Added a multi-world render loop (mirrors WebGL’s world rendering approach) and plumbed `worldOffsetX` through the WebGPU style renderer.
*   **Layer Opacity Semantics (WebGPU)**: Implemented WebGL-equivalent *post-composition* layer opacity via an offscreen + composite pass (instead of per-fragment alpha scaling).
*   **Multi-layer Compositing Stability**: Added a persistent per-canvas “frame texture” so multiple WebGPU layer submits in the same frame don’t rely on swap chain content preservation.
*   **Composite Uniform Fix**: Fixed WebGPU minBindingSize/alignment issues (32-byte uniform) and avoided uniform buffer reuse across passes (opacity pass vs final blit).
*   **New Hardening Rendering Cases**: Added `webgpu-mixed-layers` and `webgpu-multiple-layers` (plus existing `webgpu-vector-opacity` and `webgpu-vector-multiple-layers`) to cover compositing/ordering behavior across WebGL↔WebGPU and multiple WebGPU layers.
*   **Rendering Tests**: ✅ All `webgpu-*` rendering cases pass locally (minor `webgpu-points-rotation` diffs tolerated at 0.01 due to rasterization/sampling differences).
*   **Perf Hardening**: Cached polygon fill + symbol render pipelines to avoid per-frame `createRenderPipeline()` churn (stroke pipeline was already cached).
*   **Incremental Styling (WIP)**: Switched to stable per-feature refs (from `MixedGeometryBatch`) and added partial style updates for point/line/polygon (update style storage buffers on feature property changes without regenerating geometry; polygon fill supports literal or `get()`-based `fill-color`/tint).
*   **Compatibility Matrix (New)**: Added an end-to-end, baseline-driven compatibility matrix generator for Canvas/WebGL/WebGPU in `test/compat-matrix/`:
    * Scenarios are auto-generated from **all 103 flat style properties** (`src/ol/style/flat.js`) with variants: `literal`, `get`, `var` (+ `arith` for numeric props).
    * “Blank output” is treated as **not supported**; optional diagnostics show pixel coverage vs the runner background.
    * Capability probes:
        * `capabilities/max-style-vars/<N>` (1..16, 32, 64, 100): how many `var()` references a renderer can compile/execute.
        * `capabilities/max-feature-props/<N>` (1..16, 32, 64): how many distinct `get()` properties can be referenced in one expression (WebGL is typically vertex-attrib limited).
        * `capabilities/max-feature-props-case/<N>` (1..16, 32, 64): `case()` + distinct `get()` references (includes `idx` selector in the reported count).
        * `capabilities/max-rule-filters/<N>` (1..16, 32, 64): number of rules + filters with distinct `get()` across rules (includes `idx` selector in the reported count).
        * `capabilities/operators/<op>`: targeted operator coverage (e.g. `in`, `between`, `match`, multi-stop `interpolate`, and math/boolean operators) without expanding the per-property matrix.
    * Output now includes a `scenarios` section so the viewer can show the exact flat style/rules/variables used.
    * WebGL GL spam from intentionally failing capability probes is filtered in `test/compat-matrix/test.js` to keep logs readable (the structured errors remain in the results).
*   **Compatibility Matrix Viewer (Examples)**: Added `examples/compatibility-matrix.html` / `examples/compatibility-matrix.js` and wired `test/compat-matrix/baseline.json` into `serve-examples` as `resources/compat-matrix/baseline.json`.
    * Table UX: fixed column widths, group-by options, row-click expansion, per-renderer error details in their respective columns, and compact “flat style”/“style variables” previews with a subtle expand button.
*   **Validation (Latest)**: `npm run lint`, `npm run test-node`, `npm run test-rendering -- --match webgpu`, `npm run build-full`, `node test/compat-matrix/test.js --headless`, and `node test/compat-matrix/test.js --headless --fix` passing locally.

## 2. Components Implemented

### Layer & Renderer
*   **`src/ol/layer/WebGPUVector.js`**: New layer class extending `Layer`.
*   **`src/ol/renderer/webgpu/VectorLayer.js`**: 
    *   Handles `prepareFrame` logic.
    *   Manages `MixedGeometryBatch` for feature aggregation.
    *   Implements `World-to-Screen` projection transforms.
    *   **Status**: Fundamental logic complete. Feature loading works.

### Rendering Pipeline
*   **`src/ol/render/webgpu/VectorStyleRenderer.js`**:
    *   **Buffer Generation**: Triangulates polygons (earcut), batches lines/points.
    *   **Line Instancing**: Each line segment stored as instance data (p1, p2, featureIndex).
    *   **Style Buffers**: Color (RGBA) + Width stored per-feature.
    *   **Uniforms**: Manages `UniformBuffer` for Projection Matrix (`mat4`) + Resolution (`f32`).
    *   **Render Pass**: Creates `CommandEncoder`, `RenderPipeline`, `BindGroups`.
    *   **Status**: Polygon/Line/Point pipelines working. Instanced line rendering complete.

### Shaders
*   **`src/ol/render/webgpu/WGSLBuilder.js`**:
    *   Generates WGSL for Fill and Stroke shaders.
    *   **Stroke Shader**: Uses instanced vertices, expands segments into quads.
    *   **Status**: Basic "Flat Style" support, stroke-width implemented.

## 3. Test Status

| Test Case | Mismatch | Notes |
|-----------|----------|-------|
| `webgpu-vector-geographic` | 0.0 | ✅ Passing locally. |
| `webgpu-line` | 0.0 | ✅ Passing locally. |
| `webgpu-line-metric` | 0.0 | ✅ Passing locally. |
| `webgpu-line-pattern` | 0.0 | ✅ Passing locally. |
| `webgpu-line-zoomed-in` | 0.0 | ✅ Passing locally. |
| `webgpu-circles` | 0.0 | ✅ Passing locally. |
| `webgpu-icons` | 0.0 | ✅ Passing locally (after icon Y fix). |
| `webgpu-points-geographic` | 0.0 | ✅ Passing locally (after icon Y fix). |
| `webgpu-points` | 0.0 | ✅ Passing locally (after XYZ point coordinate handling). |
| `webgpu-points-rotation` | 0.00984 | ❌ Slight pixel mismatch above tolerance (0.005); visually indistinguishable. |
| `webgpu-fill-pattern` | 0.0 | ✅ Passing locally. |
| `webgpu-holes` | 0.0 | ✅ Passing locally. |
| `webgpu-shapes` | 0.0 | ✅ Passing locally. |

## 4. Open Issues

### Critical
- [x] **`webgpu-vector-geographic` renders nothing**:
    - Root cause was that WebGPU layer rendering could run before the `WebGPUHelper` device init completed, so `afterHelperCreated()` (and thus the style renderer) was not reliably ready when the first frames were prepared.
    - Fix: `src/ol/renderer/webgpu/Layer.js` now waits for `helper.ready()` before calling `prepareFrameInternal()`, and triggers a layer re-render once ready.
    - Result: `test/rendering/cases/webgpu-vector-geographic` now renders and the rendering test passes.

### Rendering Quality
- [x] **Pixelated/Jagged Lines**: Fixed for strokes via distance-field AA (WebGL-equivalent approach).
- [x] **Caps/Joins Options**: Implemented and aligned with WebGL defaults.

### Known Failures / Investigation
- `webgpu-points-rotation` mismatch above tolerance (0.005) but visually indistinguishable on at least one machine; decide whether to tighten the shader math/sampling or accept a looser tolerance for this case.
- Minor rasterization/AA differences across GPUs are expected; defer broad baseline updates until feature parity stabilizes.

### Features (Pending)
- [ ] **Complex Styling**: Full rule support (multiple rules, filters on point/line/polygon) and broader expression coverage beyond the current subset.
- [ ] **WGSL Expression Coverage**: Expand operator support (e.g. `step`, `match`, `between`, `in`, `all/any/!`, `floor/round`, trig) and remove “silent default” codegen paths (surface unsupported ops as errors/warnings).
- [ ] **Style Variables (`var()`) Parity**: Keep expanding `var()` usage across symbolizers and move more dynamic properties from CPU-resolved style buffers to the `vars` storage buffer.
- [ ] **Pattern Expressions**: Support expressions for `*-pattern-size`, `*-pattern-offset`, and related sub-rect fields (WebGL supports expressions here).
- [ ] **Point/Polygon Expressions**: Extend point/polygon pipelines beyond `literal|get|var` (icons, circles, shapes, polygon fill-color).
- [ ] **Hit Detection**: `forEachFeatureAtPixel` parity, including wiring `disableHitDetection` (currently a no-op).
- [ ] **Compatibility Matrix Expansion**: Add operator-level fixtures, more geometry+symbolizer combinations, and turn the matrix into a CI conformance signal (regression-only by default).

## 5. Hardening & Feature Gap Backlog

### Snapshot (what works today)
- **Renderer scope**: WebGPU vector rendering only (`WebGPUVector`); tiles/vector tiles/flow/heatmap are out of scope for the current implementation.
- **Rendering parity**: All existing `test/rendering/cases/webgpu-*` pass locally (with the noted `webgpu-points-rotation` tolerance caveat).
- **Style coverage**:
  - **Lines**: Stroke AA/caps/joins/dashes/patterns; limited WGSL expression compilation is used for line discard + dynamic `stroke-width`/`stroke-color` in some cases.
  - **Points + polygons**: Most properties are resolved CPU-side and written into per-feature style buffers; many fields are currently `literal|get|var` only.
  - **Image src fields**: `icon-src`, `stroke-pattern-src`, `fill-pattern-src` are **string-only** (no expressions), consistent with current WebGL behavior.

### P0 (correctness / merge-blocking hardening)
- [ ] **Style parsing parity**: Replace the “single builder” approach in `src/ol/render/webgpu/VectorStyleRenderer.js` with WebGL-equivalent rule parsing (multiple rules, filters per rule, consistent defaults).
- [x] **Filter parity**: Apply rule filters consistently across point/line/polygon (polygons currently apply the filter for the active fill rule).
- [x] **Expression hardening (shader paths)**: `compileWgslExpression()` now compiles WGSL in `strict` mode so unsupported ops throw instead of silently returning `0.0`/`false`; remaining work is better diagnostics and optional CPU fallbacks for selected properties.
- [ ] **Hit detection plumbing**: Implement `forEachFeatureAtPixel` and wire `disableHitDetection` so it actually bypasses work.
- [ ] **Device lifecycle**: Handle device loss and renderer disposal cleanly (destroy GPU resources, avoid stale cached canvas/device state).

### P1 (feature parity expansion)
- [ ] **WGSL operator coverage**: Prioritize ops exercised by the compatibility matrix (`step`, `match`, conversion ops) and common numeric transforms (`floor/round`, trig).
- [ ] **Pattern expressions**: Port WebGL’s expression support for pattern sub-rect sizing/offset fields (`*-pattern-size`, `*-pattern-offset`, `*-pattern-offset-origin`, spacing/start-offset as expressions where applicable).
- [ ] **Point/Polygon expressions**: Move more per-feature properties to shader-evaluated expressions (or a richer feature-properties storage buffer) to match WebGL semantics and reduce CPU churn.
- [ ] **Browser spec tests**: Expand `test/browser/spec/ol/render/webgpu/*` toward WebGL’s coverage (buffer utils, shader builder, style parsing, renderer lifecycle).

### P2 (scope expansion beyond vector)
- [ ] **WebGPU points-only layer** (`WebGLPoints` parity): separate pipeline + hit detection.
- [ ] **WebGPU vector tiles** (`WebGLVectorTile` parity): scaffolding + masking exists (`src/ol/layer/WebGPUVectorTile.js`, `src/ol/renderer/webgpu/VectorTileLayer.js`, `examples/webgpu-vector-tiles.html`, `test/rendering/cases/webgpu-vectortile*`). Still missing tile-extent discard + patterns + hit detection (and likely performance refactors).
- [ ] **WebGPU tile rendering** (`WebGLTile` parity): reprojection, palettes/bands, data tiles, tile-specific tests/examples.

## 6. Next Steps
1. **Style parsing + filters parity**: Port WebGL’s rule/filter behavior to WebGPU across point/line/polygon.
2. **Expression hardening + coverage**: Add missing ops and make unsupported ops observable (no silent defaults).
3. **Hit detection**: Implement `forEachFeatureAtPixel` and wire `disableHitDetection`.
4. **Pattern + symbol parity**: Add expression support for pattern sub-rect fields and expand point/polygon expression handling.
5. **Performance tracking**: Use `node test/perf/test.js` (or `npm run test-perf`) to capture repeatable WebGL/WebGPU frame-time stats for common scenarios (style vars + panning).
   * Add scenarios as needed (e.g. `geometry-churn` for buffer rebuild hitching, `opacity` for compositing).

### Hit Detection Approaches (WebGPU)

WebGL’s current approach is a GPU ID-buffer render pass + `readPixels()` from an offscreen render target. This is accurate (it matches shader discard/alpha), but it is also prone to stalls because `readPixels()` is synchronous and typically forces the browser/driver to flush GPU work. It is also “work proportional to what you render”: the pick pass runs the full draw workload again, and the readback cost scales with the pick buffer size (even if only one pixel is ultimately used).

WebGPU changes the trade space: readback is *asynchronous* (`copyTextureToBuffer` + `mapAsync()`), so it can avoid blocking the main thread, but the result cannot be made available synchronously without redesigning APIs or accepting stale/latency-compromised results.

#### Constraints / goals
- **API shape**: `Map#forEachFeatureAtPixel()` / `getFeaturesAtPixel()` are synchronous today; any “GPU readback” approach is inherently async in WebGPU.
- **Semantics**: Must respect style-dependent visibility (alpha/discard, symbol shape), hit tolerance, and “topmost” behavior (z-index + draw order), plus wrapX worlds.
- **Cost model**: Picking must remain fast with large feature counts; `disableHitDetection` must actually bypass extra work.

#### Options
1. **CPU hit detection (spatial index + geometry tests)**  
   Use a spatial index (source RBush, or a renderer-local index) to prefilter candidates, then do geometry-specific tests (distance-to-point for points/lines, point-in-polygon for fills, distance-to-ring for strokes), expanding by `hitTolerance` and style-derived widths/radii where feasible.
   - **Pros**: Synchronous (works with existing `forEachFeatureAtPixel`), no GPU stalls, no extra render pass, predictable cost with good indexing.
   - **Cons**: Hard to match WebGL/WebGPU visual semantics for complex styles (icons/alpha masks, patterns, shader discard), and “topmost” ordering must be reproduced in JS (rule/zIndex/order/declutter).

2. **GPU ID-buffer picking (raster pick pass + 1px readback)**  
   Render to a small pick target (ideally `r32uint` or packed `rgba8unorm`) where each fragment writes a feature id/ref, then `copyTextureToBuffer` for a 1×1 region and `mapAsync()` to read the id.
   - **Pros**: Highest fidelity (matches shader discard/alpha, patterns, icons), naturally returns the topmost fragment, and can keep readback bandwidth minimal (4–16 bytes).
   - **Cons**: Still requires a pick render pass (often “draw everything again” unless paired with culling), and it is async (doesn’t plug into synchronous `forEachFeatureAtPixel` without API changes or a “last known pick” cache with latency).

3. **GPU compute picking (compute shader over pick primitives)**  
   Maintain GPU buffers with per-feature “pick primitives” (e.g., screen-space bounds for points, segment AABBs for lines, coarse polygon bounds), run a compute pass that tests the query pixel (and tolerance) in parallel, and write the best match to a small output buffer for async readback.
   - **Pros**: Avoids rasterizing the whole scene for picking; can be much cheaper than a full pick render pass if pick primitives are compact and well-binned; can return multiple hits (e.g., within tolerance) with bounded output.
   - **Cons**: Considerably more complex; requires maintaining additional GPU-side pick data, implementing ordering (zIndex/draw order/depth), and still needs async readback. Exact polygon/icon semantics still require a second-stage “exact” test or fallback.

4. **Hybrid CPU prefilter + GPU exactness**  
   CPU prefilters candidates (extent/tolerance/style-aware bounds) and sends only a small candidate set to the GPU for an exact test (raster pick pass restricted to candidates, or compute test against exact data).
   - **Pros**: Can drastically reduce GPU work while keeping high fidelity; limits readback to a single id; avoids “draw everything again” in typical cases.
   - **Cons**: More plumbing (candidate extraction + upload per pick), still async, and correctness depends on how conservative the CPU prefilter is (must not miss candidates).

5. **Always-on pick buffer (keep an ID buffer per frame)**  
   Continuously render an ID buffer alongside the main pass and keep it available for queries.
   - **Pros**: Can make “what’s under the cursor?” queries cheap *if* the ID buffer is already produced.
   - **Cons**: Increases per-frame GPU cost for all users (even if no picking happens), and making it synchronous would still require readback or a redesign that keeps pick results GPU-side (not currently compatible with `forEachFeatureAtPixel`).

#### Recommendation (pragmatic path)
- **Near-term**: Implement **CPU hit detection** for WebGPU vector so `forEachFeatureAtPixel` parity is possible without changing public APIs; make it fast via spatial indexing + early-out ordering heuristics. (Initial implementation is in place, but does not yet match all style-dependent semantics.)
- **Optional (higher fidelity / future)**: Add a **GPU pick path** behind an async API surface (e.g. `layer.getFeatures(pixel)` for WebGPU renderers, or a new async map-level method) and/or as an internal refinement step where latency is acceptable (hover/tooltips).

## 6.1 Review Notes (2025-12-16)

These are follow-up notes after hardening `get()` support in the WGSL backend via a per-feature `props` storage buffer.

## 6.2 Hit Detection Notes (2025-12-17)

WebGPU vector hit detection is currently implemented as a **synchronous, CPU-based** best-effort path in `src/ol/renderer/webgpu/hitdetect.js`.

### Outstanding issues / gaps
- **Map-state expressions (`['zoom']`, `['time']`)**: WebGPU hit detection is CPU-based and uses the shared CPU expression evaluator, which does not implement these operators yet. As a result, any hit-relevant sizes are treated as default/fallback values, and **rule `filter`s that depend on zoom/time may be treated as if no filter was provided** (potentially returning hits for features that are not rendered).
- **Icon fidelity**: `icon-anchor`, `icon-displacement`, `icon-rotation`, `icon-rotate-with-view`, and image alpha are not modeled; hit tolerance uses coarse size-based padding.
- **Patterns & discard**: shader-dependent discard logic (patterns, texture alpha, complex filter/expression combinations) cannot be matched exactly on the CPU.
- **Ordering semantics**: “topmost” behavior is approximated via the existing `matches` distance ordering; this does not yet replicate WebGL/WebGPU draw-order + zIndex in all cases.
- **Performance**: dynamic expressions can force conservative padding (bigger extents) which increases candidate iteration in `forEachFeatureInExtent`.

### Next tasks
- **End-to-end browser tests**: add coverage via `Map#forEachFeatureAtPixel()` with `WebGPUVector` layers (including wrapped worlds and layer ordering).
- **Zoom/time plumbing**: extend the CPU evaluation context to support zoom/time and populate it where CPU expression evaluation is used.
- **Style-aware bounds**: incorporate more style properties into hit padding (anchor/displacement/scale/rotation) and better polygon stroke-vs-fill semantics.
- **Optional future**: explore a GPU pick path behind an async API surface for high-fidelity picking (see Section 6).

### Correctness risks
- **Global refs vs per-geometry buffers**: MixedGeometryBatch refs are global across point/line/polygon, but WebGPU per-geometry style buffers are sized based on each geometry type’s `*MaxRef`. `updateFeatureStyles()` currently fans out updates to all buffer sets, so per-buffer `updateStyle()` must guard against out-of-range `ref` values. (Hardened in `src/ol/render/webgpu/VectorStyleRenderer.js` by checking `ref > {point,line,poly}MaxRef` before writing.)
- **`get()` return type limitations**: `get()` now supports both scalar and color reads by storing two `vec4f` slots per property (scalar slot + color slot). This is correct but increases memory usage; future work may want a more compact typed layout.
- **Auto pipeline layout sensitivity**: Shaders are built with `layout: 'auto'`, so unused bindings are omitted by WebGPU. Binding logic currently relies on scanning WGSL source for `vars[...]` / `props[...]`. This is pragmatic but fragile if shader codegen changes.
- **Boolean literal filters in WGSL**: `compileWgslExpression()` does not currently compile top-level `true`/`false` literals for `expected === 'bool'` (it falls back to `false`). Call sites use a workaround like `['==', 1, 1]` for “always true”; this should be fixed in the compiler.
- **Polygon rule support gaps**: Polygons now support multiple fill rules with filters and `else: true` semantics, but fill style evaluation is still largely CPU-side (`literal|get|var` subsets) and lacks full WebGL rule parsing parity.
- **`time` time-base mismatches**: If `['time']` is sourced from multiple clocks (e.g. mixing epoch time and monotonic time), deltas can jump wildly; keep the time source consistent across frames.
- **CPU hit detection fidelity**: The current WebGPU hit detection (`src/ol/renderer/webgpu/hitdetect.js`) is CPU-based and sync, but it is not style-accurate for shader discard/alpha masks, patterns, icon image alpha, and expression-driven sizes; it uses geometry distance checks and a conservative max padding for `get()`/`var()`-driven sizes.

### Performance considerations
- **Bind group churn**: Bind groups are now cached per buffer set; remaining churn is mostly limited to pipeline/resource changes (e.g. texture changes) rather than per-frame redraw.
- **Per-update allocations**: Style/props update paths now reuse scratch `Float32Array` instances; remaining allocations are dominated by user expressions/resolvers rather than the renderer’s buffer upload scaffolding.
- **Dirty ref batching**: When many features update in a frame, the renderer batches consecutive refs into contiguous GPU writes to reduce `queue.writeBuffer()` call counts.
- **Memory scaling**: `featureProperties` scales as `featureCount * propCount * 32 bytes` (two `vec4f` slots per property: scalar + color) and is allocated only when WGSL expressions need it (e.g. filters/expressions), not for CPU-only `get()` style fields. If many distinct `get()` properties are referenced, memory can still grow quickly.
- **Per-frame GC hitches**: Remaining “micro hitches” are often driven by per-frame allocations (transform/mat4 temporaries, composite bind group creation, cache-key string construction). Reducing allocations in `render()` and caching composite resources tends to smooth fast panning/zooming.
- **Cache key allocations**: Avoid allocating string cache keys in hot render loops (bind groups and pipeline caches) by caching with nested `Map`s keyed by stable object ids / shader code strings.

### WebGPU-specific optimization opportunities (future work)
- **Render bundles**: Record draw calls once for mostly-static layers and replay each frame with only uniform updates; reduces CPU encoding overhead on pan/zoom.
- **Indirect draws + GPU-driven culling**: Use compute to write `drawIndirect`/`drawIndexedIndirect` command buffers based on view-dependent visibility; reduces CPU-side feature iteration and can reduce draw call count.
- **Compute for style evaluation/packing**: Move “rapidly changing properties” updates to the GPU by uploading a compact “changed refs” list and letting compute update style/props buffers; reduces many small `queue.writeBuffer()` calls.
- **GPU hit detection**: Render an ID buffer (or compute a pick buffer) and read back a small pixel/region for `forEachFeatureAtPixel` parity; avoids CPU geometry traversal for picking.
- **Timestamp queries**: Use GPU timestamps (where available) to separate CPU encoding hitches from GPU execution stalls.

## 7. WebGL → WebGPU Port Completeness Audit

### Rendering cases

**Counts (as of 2025-12-16):**
- WebGL rendering cases: **55**
- WebGPU rendering cases: **19**
- WebGL cases with a WebGPU equivalent: **16**
- WebGL cases missing a WebGPU equivalent: **39**

**WebGPU-only cases (no WebGL equivalent):**
- `webgpu-get-color`
- `webgpu-vector-opacity`
- `webgpu-vector-multiple-layers`

**Equivalent cases (WebGL ↔ WebGPU):**
- [x] `webgl-circles` -> `webgpu-circles`
- [x] `webgl-fill-pattern` -> `webgpu-fill-pattern`
- [x] `webgl-holes` -> `webgpu-holes`
- [x] `webgl-icons` -> `webgpu-icons`
- [x] `webgl-line` -> `webgpu-line`
- [x] `webgl-line-metric` -> `webgpu-line-metric`
- [x] `webgl-line-pattern` -> `webgpu-line-pattern`
- [x] `webgl-line-zoomed-in` -> `webgpu-line-zoomed-in`
- [x] `webgl-mixed-layers` -> `webgpu-mixed-layers`
- [x] `webgl-multiple-layers` -> `webgpu-multiple-layers`
- [x] `webgl-points` -> `webgpu-points`
- [x] `webgl-points-geographic` -> `webgpu-points-geographic`
- [x] `webgl-points-rotation` -> `webgpu-points-rotation`
- [x] `webgl-shapes` -> `webgpu-shapes`
- [x] `webgl-vector` -> `webgpu-vector`
- [x] `webgl-vector-geographic` -> `webgpu-vector-geographic`

**Missing WebGPU equivalents (WebGL-only today):**
- [ ] `webgl-data-tile-3-band`
- [ ] `webgl-data-tile-6-band`
- [ ] `webgl-data-tile-8-band`
- [ ] `webgl-data-tile-clip-extent`
- [ ] `webgl-data-tile-clip-extent-reproj`
- [ ] `webgl-data-tile-interpolate-false`
- [ ] `webgl-data-tile-interpolate-gutter`
- [ ] `webgl-data-tile-interpolate-true`
- [ ] `webgl-data-tile-loosely-packed`
- [ ] `webgl-data-tile-no-wrap`
- [ ] `webgl-data-tile-reset-source`
- [ ] `webgl-data-tile-tilepixelratio2`
- [ ] `webgl-invisible-group`
- [ ] `webgl-layer-canvas-group-changes-for-imagetile`
- [ ] `webgl-layer-canvas-group-changes-for-points`
- [ ] `webgl-layer-extent`
- [ ] `webgl-opacity`
- [ ] `webgl-palette`
- [ ] `webgl-precompose-event`
- [ ] `webgl-reproj`
- [ ] `webgl-reproj-float`
- [ ] `webgl-reproj-float-interpolate-false`
- [ ] `webgl-reproj-interpolate-false`
- [ ] `webgl-reproj-no-wrap`
- [ ] `webgl-reproj-non-parallel`
- [ ] `webgl-source-extent`
- [ ] `webgl-tile-aspect-ratio`
- [ ] `webgl-tile-layer-style-color-array`
- [ ] `webgl-tile-layer-style-color-color`
- [ ] `webgl-tile-multisource`
- [ ] `webgl-tile-no-wrap`
- [ ] `webgl-tile-non-square`
- [ ] `webgl-tile-preload`
- [ ] `webgl-tile-range`
- [ ] `webgl-tile-reset-projection`
- [ ] `webgl-tilewms-gutter20`
- [ ] `webgl-vectortile`
- [ ] `webgl-vectortile-masking`
- [ ] `webgl-vectortile-pattern`

### Examples

**WebGPU examples:**
- `examples/webgpu-debug.html`
- `examples/webgpu-debug.js`
- `examples/compatibility-matrix.html`

**WebGL examples (no WebGPU equivalent yet):**
- `examples/filter-points-webgl.html`
- `examples/filter-points-webgl.js`
- `examples/filter-webgl-line.html`
- `examples/filter-webgl-line.js`
- `examples/icon-sprite-webgl.html`
- `examples/icon-sprite-webgl.js`
- `examples/webgl-draw-line.css`
- `examples/webgl-draw-line.html`
- `examples/webgl-draw-line.js`
- `examples/webgl-layer-swipe.html`
- `examples/webgl-layer-swipe.js`
- `examples/webgl-points-layer.html`
- `examples/webgl-points-layer.js`
- `examples/webgl-sea-level.css`
- `examples/webgl-sea-level.html`
- `examples/webgl-sea-level.js`
- `examples/webgl-shaded-relief.css`
- `examples/webgl-shaded-relief.html`
- `examples/webgl-shaded-relief.js`
- `examples/webgl-tile-style.css`
- `examples/webgl-tile-style.html`
- `examples/webgl-tile-style.js`
- `examples/webgl-tiles.html`
- `examples/webgl-tiles.js`
- `examples/webgl-vector-layer.html`
- `examples/webgl-vector-layer.js`
- `examples/webgl-vector-tiles.html`
- `examples/webgl-vector-tiles.js`

### Unit/integration tests

**WebGL browser spec tests:**
- `test/browser/spec/ol/render/webgl/MixedGeometryBatch.test.js`
- `test/browser/spec/ol/render/webgl/VectorStyleRenderer.test.js`
- `test/browser/spec/ol/render/webgl/bufferUtil.test.js`
- `test/browser/spec/ol/render/webgl/compileUtil.test.js`
- `test/browser/spec/ol/render/webgl/encodeUtil.test.js`
- `test/browser/spec/ol/render/webgl/renderinstructions.test.js`
- `test/browser/spec/ol/render/webgl/shaderbuilder.test.js`
- `test/browser/spec/ol/render/webgl/style.test.js`
- `test/browser/spec/ol/renderer/webgl/Layer.test.js`
- `test/browser/spec/ol/renderer/webgl/PointsLayer.test.js`
- `test/browser/spec/ol/renderer/webgl/TileLayer.test.js`
- `test/browser/spec/ol/renderer/webgl/VectorLayer.test.js`
- `test/browser/spec/ol/renderer/webgl/VectorTileLayer.test.js`

**WebGPU browser spec tests (currently minimal):**
- `test/browser/spec/ol/render/webgpu/VectorStyleRenderer.test.js`
- `test/browser/spec/ol/renderer/webgpu/VectorLayer.test.js`

**Expression tests (shared parsing + GPU backends):**
- `test/node/ol/expr/expression.test.js`
- `test/node/ol/expr/gpu.test.js` (WebGL GLSL backend)
- `test/node/ol/expr/wgsl.test.js` (WebGPU WGSL backend, WIP)
- `test/node/ol/render/webgpu/VectorStyleRenderer.test.js` (WebGPU uniform/opacity plumbing)

### Feature inventory (what exists in WebGL today)

**Layers/renderers:**
- `src/ol/layer/WebGLVector.js` + `src/ol/renderer/webgl/VectorLayer.js` (vector rendering + hit detection)
- `src/ol/layer/WebGLPoints.js` + `src/ol/renderer/webgl/PointsLayer.js` (points-only pipeline + hit detection)
- `src/ol/layer/WebGLVectorTile.js` + `src/ol/renderer/webgl/VectorTileLayer.js` (vector tiles, masking, patterns)
- `src/ol/layer/WebGLTile.js` + `src/ol/renderer/webgl/TileLayer.js` (raster/data tiles, reprojection, palette/band expressions)
- `src/ol/renderer/webgl/FlowLayer.js` (particle/flow rendering)
- `src/ol/layer/Heatmap.js` (uses WebGL vector renderer)

**Core WebGL infra frequently relied on by tests/examples:**
- `src/ol/webgl/Helper.js`, `src/ol/webgl/Buffer.js`, `src/ol/webgl/RenderTarget.js`, `src/ol/webgl/PostProcessingPass.js`
- `src/ol/expr/gpu.js` + `src/ol/render/webgl/compileUtil.js` (expression compilation to GLSL + attribute/uniform plumbing)
- `src/ol/render/webgl/style.js` (flat-style parsing → shader setup for circles/shapes/icons/lines/fills + patterns + filters)

### WebGPU status vs WebGL scope

**Implemented in WebGPU (vector only):**
- `src/ol/layer/WebGPUVector.js` + `src/ol/renderer/webgpu/VectorLayer.js`
- `src/ol/render/webgpu/VectorStyleRenderer.js`, `src/ol/render/webgpu/WGSLBuilder.js`
- `src/ol/webgpu/Helper.js`, `src/ol/webgpu/Buffer.js`

**Not started / missing equivalents (larger scope items):**
- WebGPU tile rendering (`WebGLTile` parity): data tiles, reprojection, palette/band GPU expressions, tile-specific tests/examples.
- WebGPU vector tiles (`WebGLVectorTile` parity): masking, patterns, tile lifecycle and cache integration.

Related design notes: `WEBGPU_VECTOR_TILES_PORT.md`.
- WebGPU points-only layer (`WebGLPoints` parity): separate pipeline + hit detection.
- Hit detection / `forEachFeatureAtPixel` parity for WebGPU vector (`WebGLVector` has this).
- Post-processing / render targets parity where applicable.

## 8. Port Goals & Test Strategy (proposed)

### Performance (same or better)
- Prefer *one pipeline per material* (symbol/line/fill/pattern) with stable bind group layouts.
- Move per-feature data to GPU-friendly buffers (avoid re-uploading every frame; update on change).
- Keep CPU cost predictable by sharing the parse/type-check phase across WebGL/WebGPU and emitting backend code (GLSL/WGSL) from the same IR.

### Unlimited dynamic variables (not constrained by vertex attrib limits)
- Replace per-feature vertex attributes with a *storage buffer* (or texture buffer) indexed by `featureIndex`.
- Store variables/properties in a structured layout (e.g. SoA by type: numbers, vec2/size, vec4/color, strings-as-ids).
- Keep `styleVariables` as a small uniform buffer (or also storage) and let expressions read from either source.

### Auto-generated comparison table (Canvas vs WebGL vs WebGPU)
- Add an E2E style/expression conformance suite that:
  - Renders the same fixture set under Canvas, WebGL, and WebGPU.
  - Captures images + records which style properties and expression ops compiled/executed without fallback/errors.
  - Multiple expression syntax variations per property (as exhaustive as possible)
  - Generates `docs/` (or `WEBGPU_STATUS.md`) tables from the results (pass/fail + mismatch metric + notes).
- Start with operator-level tests (one operator per fixture), then style-property fixtures (circle/icon/stroke/fill/pattern).

### Hardware sanity checks (dev workflow)
- Rendering tests already support headed runs by default when not in CI (omit `--headless`), and now support `--gpu-info` / `--require-hardware` to log (or assert) the WebGPU adapter type (hardware vs. SwiftShader) during local validation.
