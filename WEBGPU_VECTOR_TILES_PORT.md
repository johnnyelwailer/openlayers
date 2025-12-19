# Porting `WebGLVectorTile` to WebGPU (requirements + design notes)

This document captures what is needed to bring `ol/layer/WebGLVectorTile` feature parity to WebGPU (`WebGLVectorTile` → `WebGPUVectorTile`), based on the current OpenLayers codebase state.

## Scope (what “parity” means here)

Minimum parity with today’s `WebGLVectorTile` implementation:
- Vector tile lifecycle: queueing, caching, transitions, fallback tiles (parent/child) and render ordering.
- Flat style support comparable to WebGL vector tiles (rules + filters + patterns), within the current WebGPU vector style constraints.
- Tile overlap handling (“masking”: higher-zoom tiles hide lower-zoom tiles in overlapping screen regions).
- Pattern rendering (fill + stroke patterns) and stable sampling across view transforms.
- Tile-extent clipping (avoid seams/overdraw at tile edges, especially for strokes/patterns).
- Tests and examples analogous to existing WebGL coverage.

Out of scope unless explicitly pursued:
- Full `WebGLVectorTile` hit detection parity (WebGL uses a synchronous GPU pick pass; WebGPU readback is async).
- Decluttering/text layout (not implemented in `WebGLVectorTileLayerRenderer` today).

## Relevant existing code (baseline)

**WebGL vector tiles**
- Layer: `src/ol/layer/WebGLVectorTile.js`
- Renderer: `src/ol/renderer/webgl/VectorTileLayer.js`
- Tile lifecycle/caching base: `src/ol/renderer/webgl/TileLayerBase.js`
- Tile representation (geometry + mask quad + async buffer generation): `src/ol/webgl/TileGeometry.js`
- Offscreen targets (mask + hit detection): `src/ol/webgl/RenderTarget.js`
- Shader-side tile-extent clipping + pattern origin usage: `src/ol/render/webgl/ShaderBuilder.js`
- Style parsing (patterns, rules, filters, expressions): `src/ol/render/webgl/style.js`
- Rendering tests: `test/rendering/cases/webgl-vectortile*/*`
- Browser spec tests: `test/browser/spec/ol/renderer/webgl/VectorTileLayer.test.js`

**WebGPU vectors (current)**
- Layer: `src/ol/layer/WebGPUVector.js`
- Renderer: `src/ol/renderer/webgpu/VectorLayer.js`
- Style renderer + WGSL generation: `src/ol/render/webgpu/VectorStyleRenderer.js`, `src/ol/render/webgpu/WGSLBuilder.js`
- WebGPU helper (canvas/device/context): `src/ol/webgpu/Helper.js`
- Status + known gaps: `WEBGPU_STATUS.md`

## What WebGL vector tiles do that WebGPU doesn’t yet

### 1) Tile lifecycle + caching + transitions (core renderer plumbing)
WebGL vector tiles inherit the full tile lifecycle from `WebGLBaseTileLayerRenderer`:
- Computes the visible tile range per frame, enqueues tiles into `frameState.tileQueue`, updates `frameState.wantedTiles`, and maintains an LRU cache of “tile representations”.
- Handles tile transitions (alpha) and uses fallback tiles (parent/child) while target tiles load.

WebGPU currently has no tile renderer base class. To port vector tiles, you need a WebGPU equivalent of `src/ol/renderer/webgl/TileLayerBase.js` that:
- Extends `src/ol/renderer/webgpu/Layer.js` instead of WebGL’s layer renderer.
- Preserves the tile queue/caching semantics, especially `alphaLookup`, fallback tile lookup, and ordering.
- Provides hooks similar to the WebGL base:
  - `beforeTilesMaskRender(frameState) → boolean`
  - `renderTileMask(tileRep, tileZ, tileExtent, depth)`
  - `beforeTilesRender(frameState, tilesWithAlpha)`
  - `renderTile(tileRep, ..., tileExtent, depth, alpha, ...)`

### 2) Tile overlap masking (“depth mask” pass)
`WebGLVectorTileLayerRenderer` uses a dedicated screen-space “mask texture” to hide lower-zoom tiles where higher-zoom tiles cover the same screen pixels:
- It renders each tile’s extent as a quad into an offscreen render target (`WebGLRenderTarget`) with depth testing enabled.
- The mask’s color stores the tile zoom (`tileZ / 50`) and the depth buffer keeps the “topmost” (highest zoom) tile’s value at each pixel.
- All style shaders get an injected fragment discard clause:
  - `texture2D(u_depthMask, gl_FragCoord.xy / u_pixelRatio / u_viewportSizePx).r * 50. > u_tileZoomLevel + 0.5`

WebGPU vector rendering has no equivalent render-target abstraction or mask pipeline today. To port this you need:
- A WebGPU “render target” concept for at least:
  - A color texture view for the tile mask (sampleable + renderable).
  - A depth texture for mask rendering (renderable).
- A tiny WGSL pipeline to render world-space quads for each tile extent into the mask texture, honoring depth.
- Shader support in the vector tile draw shaders to sample the mask texture using fragment position and discard based on the current tile’s `tileZ`.
- Matching WebGL behavior during transitions: tiles that are still transitioning (alpha < 1) should *not* be written into the mask (WebGL skips them) so the crossfade shows underlying tiles.

Binding/layout implications (current WebGPU style pipelines):
- WebGPU vector shaders currently reserve bindings:
  - `0`: style storage buffer
  - `1`: uniform buffer
  - `2/3`: optional pattern sampler/texture
  - `4`: optional `vars` storage buffer
  - `5`: optional `props` storage buffer
- Tile mask sampling should use additional bindings (e.g. `6/7`) and must be present in every pipeline variant that uses it.

### 3) Tile-extent clipping (render extent discard)
WebGL shaders discard fragments outside a per-draw `u_renderExtent` in world coordinates (see `src/ol/render/webgl/ShaderBuilder.js`), which is critical for tiles:
- Prevents overdraw/double-darkening at tile seams (especially for thick strokes, dashes, patterns, joins/caps).
- `WebGLVectorTileLayerRenderer` sets `u_renderExtent` to the intersection of tile extent and view extent per tile draw.

WebGPU vector shaders currently do not implement render extent clipping. To add it you need:
- A per-draw `renderExtent` value (vec4) available to the fragment shader.
- A way to compute `worldPos` for each fragment to compare against `renderExtent`.
  - WebGL uses a `u_screenToWorldMatrix`.
  - WebGPU uniform data currently does not include center or an inverse transform matrix; so you likely need to add either:
    - `screenToWorld` matrix to uniforms, or
    - `center` + a `pxToWorld()` function in WGSL mirroring WebGL math.

### 4) Per-tile depth / ordering
WebGL tile renderers rely on depth in clip space (`u_depth`) plus depth testing to guarantee correct ordering across tiles and zoom levels, independent of draw order.

WebGPU vector rendering currently:
- Draws polygons/lines/points in explicit order with blending.
- Does not attach a depth buffer, and uses constant z (e.g. `0.5` in WGSL).

For vector tiles you’ll need a strategy for:
- Representing tile z-order (and transition tiles) so higher zoom tiles do not get overwritten by lower zoom tiles.
- Matching WebGL transition behavior (alpha tiles rendered last; WebGL uses a special depth value and separate draw ordering).

Pragmatic options:
- Add depth attachment support to the WebGPU vector rendering pass(es) and write a per-tile depth value (akin to `depthForZ(z)` in `src/ol/renderer/webgl/TileLayerBase.js`).
- Or, enforce strict tile draw order (e.g. low→high zoom) and carefully handle alpha tiles; this can work but is more fragile and can regress easily.

### 5) Coordinate precision strategy (world coords vs tile-local coords)
WebGL vector tiles generate tile-local coordinates (`TileGeometry` applies a translation by `-tileOrigin`) and then re-applies the origin via per-tile uniforms (`invertVerticesTransform`) at draw time. This keeps coordinate magnitudes small and reduces floating-point artifacts at high zoom.

WebGPU vector rendering today uses world coordinates directly (MixedGeometryBatch → GPU buffers), and the `transform` argument to `VectorStyleRenderer.generateBuffers()` is currently unused.

For WebGPU vector tiles you need to choose:
- **Phase 1 (simpler):** store world coords in GPU buffers (no per-tile origin). Faster to implement, but may show precision issues at high zoom and can increase seam risk.
- **Phase 2 (WebGL-like):** store tile-local coords and add per-tile origin back in shader (requires per-tile uniforms or per-draw bind groups).

### 6) API surface / layer class
You will need a new layer class mirroring `WebGLVectorTile`:
- Proposed: `src/ol/layer/WebGPUVectorTile.js`
- Should accept the same flat style/rules shape and `variables`, and align option names (`cacheSize`, `disableHitDetection`, etc.).

It should create a WebGPU renderer (proposed `src/ol/renderer/webgpu/VectorTileLayer.js`) that:
- Integrates tile lifecycle/caching (from a WebGPU tile base renderer).
- Builds tile representations (geometry + GPU buffers) using the WebGPU `VectorStyleRenderer`.
- Performs the mask pass and then draws visible tiles with mask+extent logic.

### 7) WebGPU VectorStyleRenderer integration and command submission
Today `src/ol/render/webgpu/VectorStyleRenderer.js#render()`:
- Creates a new `GPUCommandEncoder` internally and calls `device.queue.submit()` every time it renders.
- Decides when to clear/load and when to blit to the swap chain based on “world pass” flags (`isFirstWorld`, `isLastWorld`, `isFirstPass`).

Vector tiles typically require drawing many tile buffer sets per frame. For correctness and performance you likely need one of:
- **Minimal implementation:** call `VectorStyleRenderer.render()` once per tile and use the flags to avoid clearing/blitting except once.
  - Works as a prototype, but increases command submission overhead.
- **Better architecture:** refactor WebGPU style rendering to allow an external encoder and “begin/end frame” flow:
  - `beginFrame(frameState, targetView, opts) → encoder/pass`
  - `drawBuffers(buffers, perDrawUniforms, encoder/pass)`
  - `endFrame(encoder)` (blit/composite once)

This refactor also helps with:
- Tile mask pass integration (use the same encoder).
- Reducing redundant uniform writes/pipeline state setup across tiles.

### 8) Styling parity gaps that matter for vector tiles
Even without tiles, WebGPU style support is not at WebGL parity yet (`WEBGPU_STATUS.md`).
Vector tile porting will surface the following more aggressively:
- Rule parsing parity (multiple rules, `else` semantics, consistent defaults across geometry types).
- Wider expression coverage (`match`, boolean ops, `coalesce`, etc.).
- Pattern sub-rect expressions (`*-pattern-size`, `*-pattern-offset`, spacing/start-offset as expressions) which WebGL supports (`src/ol/render/webgl/style.js`) but WebGPU only partially supports today.

## Proposed implementation milestones (incremental)

### Milestone A: bring up “something renders”
- Add `WebGPUVectorTile` layer + renderer skeleton.
- Port tile lifecycle core from `src/ol/renderer/webgl/TileLayerBase.js` to a WebGPU base renderer.
- Render tiles without mask and without tile-extent discard (expect artifacts) to validate the tile queue/cache plumbing.

### Milestone B: tile masking (correct overlap across zooms)
- Implement the mask render target + mask pass (color + depth).
- Extend WGSL shaders and bind groups to sample the mask and discard when covered by higher-zoom tiles.
- Match WebGL behavior for transition tiles (do not write transitioning tiles into mask).
- Add a WebGPU equivalent of `test/rendering/cases/webgl-vectortile-masking`.

### Milestone C: tile-extent clipping (seams + correctness)
- Add per-tile `renderExtent` and fragment discard based on world coordinates.
- Add required uniforms (screen-to-world or center+inverse math).
- Add WebGPU equivalents of `webgl-vectortile` and `webgl-vectortile-pattern` rendering tests.

### Milestone D: depth/ordering + precision
- Decide on depth strategy:
  - Add depth attachment to the geometry pass and write per-tile depth, or
  - Maintain strict draw ordering with careful alpha handling.
- If needed, move to tile-local coordinates for precision (WebGL-like origin handling).

## Test and example checklist

Add WebGPU counterparts of the existing WebGL vector tile rendering fixtures:
- ✅ `test/rendering/cases/webgpu-vectortile`
- ✅ `test/rendering/cases/webgpu-vectortile-masking`
- ⏳ `test/rendering/cases/webgpu-vectortile-pattern`

Add a browser spec test suite mirroring `test/browser/spec/ol/renderer/webgl/VectorTileLayer.test.js` for WebGPU:
- Renderer initialization and style injection (mask discard + uniforms).
- Mask target creation and sizing.
- Per-tile uniform behavior for `tileZ`, `renderExtent`, and transforms.

Add an example similar to `examples/webgl-vector-tiles.html` / `examples/webgl-vector-tiles.js`:
- `examples/webgpu-vector-tiles.html` / `examples/webgpu-vector-tiles.js`
- Use the same MVT source, with a simplified style subset if needed initially.

## Open questions / risks (things to decide early)

- **Hit detection:** WebGL’s approach is synchronous; WebGPU readback is async. Decide whether WebGPU vector tiles:
  - provide CPU hit detection only (sync, approximate), or
  - add a new async API for GPU-based picking, or
  - temporarily do not support hit detection.
- **Uniform layout stability:** WebGPU pipelines currently rely on `layout: 'auto'` and “binding presence” heuristics. Adding tile-mask bindings and new uniforms should be done carefully to avoid validation issues.
- **Precision vs complexity:** world-coordinate buffers are simplest; tile-local coordinates likely needed for high-zoom correctness.
- **Command submission overhead:** calling WebGPU `render()` per tile will work but can become a bottleneck; plan a refactor to share encoders/passes once correctness is proven.
