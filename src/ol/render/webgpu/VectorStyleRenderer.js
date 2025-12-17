/**
 * @module ol/render/webgpu/VectorStyleRenderer
 */
import earcut from 'earcut';
import {asArray} from '../../color.js';
import {
  BooleanType,
  ColorType,
  NumberType,
  isType,
} from '../../expr/expression.js';
import {
  create as createTransform,
  multiply as multiplyTransform,
  reset as resetTransform,
  rotate as rotateTransform,
  scale as scaleTransform,
  translate as translateTransform,
} from '../../transform.js';
import {
  create as createMat4,
  fromTransform as mat4FromTransform,
} from '../../vec/mat4.js';
import WebGPUBuffer from '../../webgpu/Buffer.js';
import {writeLineSegmentToBuffers} from '../linestringUtil.js';
import {WGSLBuilder} from './WGSLBuilder.js';
import {
  collectGetProperties,
  collectVarNames,
  compileWgslExpression,
} from './expr.js';

const BIND_GROUP_CACHE = Symbol('ol/webgpu/VectorStyleRenderer.bindGroupCache');

/**
 * @typedef {Object} StrokePatternTexture
 * @property {GPUSampler} sampler Sampler.
 * @property {GPUTextureView} view Texture view.
 * @property {[number, number]} size Texture size in pixels.
 */

/**
 * @typedef {Object} PolygonBufferSet
 * @property {WebGPUBuffer} vertex Vertex buffer.
 * @property {WebGPUBuffer} style Style buffer.
 * @property {string} [fillShader] Optional WGSL shader override.
 * @property {StrokePatternTexture} [pattern] Optional fill pattern resources.
 * @property {(device: GPUDevice, ref: number, feature: import("../../Feature.js").default|import("../../render/Feature.js").default) => void} [updateStyle]
 * Update per-feature style record for a given ref.
 */

/**
 * @typedef {Object} PointBufferSet
 * @property {WebGPUBuffer} vertex Vertex buffer (instanced: position + featureIndex).
 * @property {WebGPUBuffer} style Style buffer.
 * @property {string} [symbolShader] Optional WGSL shader override.
 * @property {StrokePatternTexture} [pattern] Optional symbol texture resources.
 */

/**
 * @typedef {Object} LineStringBufferSet
 * @property {WebGPUBuffer} vertex Vertex buffer.
 * @property {WebGPUBuffer} style Style buffer.
 * @property {string} [strokeShader] Optional WGSL shader override.
 * @property {StrokePatternTexture} [pattern] Optional stroke pattern resources.
 */

/**
 * @param {*} value Expression or literal.
 * @param {import("../../Feature.js").default|import("../../render/Feature.js").default} feature Feature.
 * @param {import("../../style/flat.js").StyleVariables} [variables] Style variables.
 * @return {*} Resolved value.
 */
function resolveExpression(value, feature, variables) {
  if (Array.isArray(value) && value.length === 2 && value[0] === 'get') {
    return feature.get(value[1]);
  }
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value[0] === 'var' &&
    variables
  ) {
    return variables[value[1]];
  }
  return value;
}

/**
 * @param {*} value Expression or literal.
 * @param {import("../../Feature.js").default|import("../../render/Feature.js").default} feature Feature.
 * @param {number} fallback Fallback.
 * @param {import("../../style/flat.js").StyleVariables} [variables] Style variables.
 * @return {number} Resolved number.
 */
function resolveNumber(value, feature, fallback, variables) {
  const resolved = resolveExpression(value, feature, variables);
  const num = Number(resolved);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * @param {*} expr Encoded expression.
 * @return {number} Maximum numeric output found, or NaN if unknown.
 */
function maxNumberInExpression(expr) {
  if (typeof expr === 'number') {
    return expr;
  }
  if (typeof expr === 'string') {
    const n = Number(expr);
    return Number.isFinite(n) ? n : NaN;
  }
  if (!Array.isArray(expr) || expr.length === 0) {
    return NaN;
  }

  const op = expr[0];
  if (op === 'case' && expr.length >= 4) {
    const t = maxNumberInExpression(expr[2]);
    const f = maxNumberInExpression(expr[3]);
    if (!Number.isFinite(t)) {
      return f;
    }
    if (!Number.isFinite(f)) {
      return t;
    }
    return Math.max(t, f);
  }
  if (
    op === 'interpolate' &&
    Array.isArray(expr[1]) &&
    expr[1][0] === 'linear'
  ) {
    // stops are [stop, output] pairs after the input expression
    let maxVal = NaN;
    for (let i = 3; i + 1 < expr.length; i += 2) {
      const out = maxNumberInExpression(expr[i + 1]);
      if (!Number.isFinite(out)) {
        continue;
      }
      maxVal = Number.isFinite(maxVal) ? Math.max(maxVal, out) : out;
    }
    return maxVal;
  }

  return NaN;
}

/**
 * @param {*} value Expression or literal.
 * @param {import("../../Feature.js").default|import("../../render/Feature.js").default} feature Feature.
 * @param {number} fallback Fallback.
 * @param {import("../../style/flat.js").StyleVariables} [variables] Style variables.
 * @return {number} Stroke width.
 */
function resolveStrokeWidth(value, feature, fallback, variables) {
  if (!Array.isArray(value)) {
    return resolveNumber(value, feature, fallback, variables);
  }
  if (value[0] === 'get') {
    return resolveNumber(value, feature, fallback, variables);
  }
  const maxWidth = maxNumberInExpression(value);
  if (Number.isFinite(maxWidth) && maxWidth > 0) {
    return maxWidth;
  }
  return fallback;
}

/**
 * @param {*} value Expression or literal.
 * @param {import("../../Feature.js").default|import("../../render/Feature.js").default} feature Feature.
 * @param {Array<number>} fallback Fallback RGBA (0..1).
 * @param {import("../../style/flat.js").StyleVariables} [variables] Style variables.
 * @return {Array<number>} Resolved color.
 */
function resolveColor(value, feature, fallback, variables) {
  const resolved = resolveExpression(value, feature, variables);
  if (!resolved) {
    return fallback;
  }
  try {
    const c = asArray(resolved);
    const r = Number(c[0]);
    const g = Number(c[1]);
    const b = Number(c[2]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
      return fallback;
    }
    const max = Math.max(r, g, b);
    const scale = max > 1.5 ? 1 / 255 : 1;
    const alpha = c.length > 3 ? Number(c[3]) : 1;
    return [
      r * scale,
      g * scale,
      b * scale,
      Number.isFinite(alpha) ? alpha : 1,
    ];
  } catch {
    return fallback;
  }
}

/**
 * @param {*} value Expression or literal.
 * @param {import("../../Feature.js").default|import("../../render/Feature.js").default} feature Feature.
 * @param {[number, number]} fallback Fallback size.
 * @param {import("../../style/flat.js").StyleVariables} [variables] Style variables.
 * @return {[number, number]} Resolved size.
 */
function resolveSize(value, feature, fallback, variables) {
  const resolved = resolveExpression(value, feature, variables);
  if (Array.isArray(resolved) && resolved.length >= 2) {
    const w = Number(resolved[0]);
    const h = Number(resolved[1]);
    if (Number.isFinite(w) && Number.isFinite(h)) {
      return [w, h];
    }
  }
  if (typeof resolved === 'number' && Number.isFinite(resolved)) {
    return [resolved, resolved];
  }
  return fallback;
}

/**
 * @typedef {Object} StyleShaders
 * @property {WGSLBuilder} builder Helper class to build the shaders
 * @property {import("../webgl/VectorStyleRenderer.js").UniformDefinitions} uniforms Uniform definitions
 * @property {import("../webgl/VectorStyleRenderer.js").AttributeDefinitions} attributes Attribute definitions
 */

/**
 * @classdesc
 * The WebGPU equivalent of VectorStyleRenderer.
 * It manages style compilation and buffer generation for vector layers.
 */
class VectorStyleRenderer {
  /**
   * @param {Array<import("../../style/flat.js").Rule>|Array<import("../../style/flat.js").FlatStyle>|StyleShaders} styles Styles.
   * @param {import("../../style/flat.js").StyleVariables} variables Style variables.
   * @param {import("../../webgpu/Helper.js").default} helper Helper.
   */
  constructor(styles, variables, helper) {
    this.helper_ = helper;
    this.styles_ = styles;
    this.variables_ = variables || {};
    /** @type {Map<string, Map<string, GPURenderPipeline>>} */
    this.strokePipelineCache_ = new Map();
    /** @type {Map<string, Map<string, GPURenderPipeline>>} */
    this.fillPipelineCache_ = new Map();
    /** @type {Map<string, Map<string, GPURenderPipeline>>} */
    this.symbolPipelineCache_ = new Map();
    /** @type {Map<string, Promise<StrokePatternTexture>>} */
    this.patternTextureCache_ = new Map();

    /**
     * @private
     * @type {Array<string>}
     */
    this.variableNames_ = [];

    /**
     * @private
     * @type {Map<string, number>}
     */
    this.variableIndexByName_ = new Map();

    /**
     * @private
     * @type {GPUBuffer|null}
     */
    this.variablesBuffer_ = null;

    /**
     * @private
     * @type {number}
     */
    this.variablesBufferSize_ = 0;

    /**
     * @private
     * @type {Float32Array|null}
     */
    this.variablesData_ = null;

    // TODO: Phase 2 - Implement proper style parsing
    // For now, we manually create a single builder/shader pair
    const builder = new WGSLBuilder();
    if (styles[0] && styles[0]['fill-color']) {
      builder.setFillColorExpression(styles[0]['fill-color']);
    }

    this.styleShaders_ = [
      {
        builder: builder,
        attributes: {},
        uniforms: {},
      },
    ];

    /**
     * @private
     * @type {string}
     */
    this.defaultFillShader_ = builder.getFillShader();

    /**
     * @private
     * @type {string}
     */
    this.defaultStrokeShader_ = builder.getStrokeShader();

    /**
     * @private
     * @type {string}
     */
    this.defaultCircleSymbolShader_ = builder.getCircleSymbolShader();

    /**
     * @private
     * @type {boolean}
     */
    this.defaultFillShaderUsesVars_ = this.shaderUsesVars_(
      this.defaultFillShader_,
    );

    /**
     * @private
     * @type {boolean}
     */
    this.defaultFillShaderUsesProps_ = this.shaderUsesProps_(
      this.defaultFillShader_,
    );

    /**
     * @private
     * @type {boolean}
     */
    this.defaultStrokeShaderUsesVars_ = this.shaderUsesVars_(
      this.defaultStrokeShader_,
    );

    /**
     * @private
     * @type {boolean}
     */
    this.defaultStrokeShaderUsesProps_ = this.shaderUsesProps_(
      this.defaultStrokeShader_,
    );

    /**
     * @private
     * @type {boolean}
     */
    this.defaultCircleSymbolShaderUsesVars_ = this.shaderUsesVars_(
      this.defaultCircleSymbolShader_,
    );

    /**
     * @private
     * @type {boolean}
     */
    this.defaultCircleSymbolShaderUsesProps_ = this.shaderUsesProps_(
      this.defaultCircleSymbolShader_,
    );

    /**
     * @private
     * @type {GPUTexture|null}
     */
    this.offscreenTexture_ = null;

    /**
     * @private
     * @type {[number, number]}
     */
    this.offscreenTextureSize_ = [0, 0];

    /**
     * @private
     * @type {GPUSampler|null}
     */
    this.compositeSampler_ = null;

    /**
     * @private
     * @type {GPUBuffer|null}
     */
    this.compositeUniformBufferOpacity_ = null;

    /**
     * @private
     * @type {GPUBuffer|null}
     */
    this.compositeUniformBufferOne_ = null;

    /**
     * @private
     * @type {GPURenderPipeline|null}
     */
    this.compositePipeline_ = null;

    /**
     * @private
     * @type {WeakMap<Object, number>}
     */
    this.objectIdByObject_ = new WeakMap();

    /**
     * @private
     * @type {number}
     */
    this.nextObjectId_ = 1;

    /**
     * @private
     * @type {Float32Array|null}
     */
    this.uniformData_ = null;

    /**
     * @private
     * @type {number|null}
     */
    this.startTime_ = null;

    /**
     * @private
     * @type {import("../../transform.js").Transform}
     */
    this.renderTransform_ = createTransform();

    /**
     * @private
     * @type {import("../../transform.js").Transform}
     */
    this.clipTransform_ = createTransform();

    /**
     * @private
     * @type {import("../../vec/mat4.js").Mat4}
     */
    this.clipMat4_ = createMat4();

    /**
     * @private
     * @type {GPUTextureView|null}
     */
    this.offscreenTextureView_ = null;

    /**
     * @private
     * @type {WeakMap<GPUTextureView, WeakMap<GPUBuffer, GPUBindGroup>>}
     */
    this.compositeBindGroupCache_ = new WeakMap();

    /**
     * @private
     * @type {GPUTextureFormat|null}
     */
    this.compositePipelineFormat_ = null;
  }

  /**
   * @param {Object|null|undefined} obj Object.
   * @return {number} Stable numeric id for the object.
   * @private
   */
  getObjectId_(obj) {
    if (!obj) {
      return 0;
    }
    let id = this.objectIdByObject_.get(obj);
    if (id === undefined) {
      id = this.nextObjectId_++;
      this.objectIdByObject_.set(obj, id);
    }
    return id;
  }

  /**
   * @param {Object} buffers Current buffers.
   * @return {Map<number, *>} Bind group cache.
   * @private
   */
  getBindGroupCache_(buffers) {
    let cache = buffers[BIND_GROUP_CACHE];
    if (!cache) {
      cache = new Map();
      buffers[BIND_GROUP_CACHE] = cache;
    }
    return cache;
  }

  /**
   * @param {Map<string, Map<string, GPURenderPipeline>>} cache Cache.
   * @param {string} format Format.
   * @param {string} code WGSL code.
   * @param {() => GPURenderPipeline} create Create callback.
   * @return {GPURenderPipeline} Pipeline.
   * @private
   */
  getPipeline_(cache, format, code, create) {
    let byFormat = cache.get(format);
    if (!byFormat) {
      byFormat = new Map();
      cache.set(format, byFormat);
    }
    let pipeline = byFormat.get(code);
    if (!pipeline) {
      pipeline = create();
      byFormat.set(code, pipeline);
    }
    return pipeline;
  }

  /**
   * Cache bind groups without allocating string keys in render loops.
   * @param {Map<number, *>} cache Cache root.
   * @param {number} pipelineId Pipeline id.
   * @param {number} styleBufferId Style buffer id.
   * @param {number} uniformsBufferId Uniform buffer id.
   * @param {number} patternSamplerId Pattern sampler id.
   * @param {number} patternViewId Pattern view id.
   * @param {number} varsBufferId Vars buffer id.
   * @param {number} propsBufferId Props buffer id.
   * @param {() => GPUBindGroup} create Create callback.
   * @return {GPUBindGroup} Cached bind group.
   * @private
   */
  getCachedBindGroup_(
    cache,
    pipelineId,
    styleBufferId,
    uniformsBufferId,
    patternSamplerId,
    patternViewId,
    varsBufferId,
    propsBufferId,
    create,
  ) {
    let m1 = cache.get(pipelineId);
    if (!m1) {
      m1 = new Map();
      cache.set(pipelineId, m1);
    }
    let m2 = m1.get(styleBufferId);
    if (!m2) {
      m2 = new Map();
      m1.set(styleBufferId, m2);
    }
    let m3 = m2.get(uniformsBufferId);
    if (!m3) {
      m3 = new Map();
      m2.set(uniformsBufferId, m3);
    }
    let m4 = m3.get(patternSamplerId);
    if (!m4) {
      m4 = new Map();
      m3.set(patternSamplerId, m4);
    }
    let m5 = m4.get(patternViewId);
    if (!m5) {
      m5 = new Map();
      m4.set(patternViewId, m5);
    }
    let m6 = m5.get(varsBufferId);
    if (!m6) {
      m6 = new Map();
      m5.set(varsBufferId, m6);
    }
    let bindGroup = m6.get(propsBufferId);
    if (!bindGroup) {
      bindGroup = create();
      m6.set(propsBufferId, bindGroup);
    }
    return bindGroup;
  }

  /**
   * WebGPU pipelines created with `layout: 'auto'` only expose bindings that are
   * statically used by the shader. We therefore must only add the `vars` bind
   * group entry when the shader actually reads from `vars[...]`.
   * @param {string} code WGSL shader code.
   * @return {boolean} Whether the shader reads from the `vars` buffer.
   * @private
   */
  shaderUsesVars_(code) {
    return /\bvars\s*\[/.test(code);
  }

  /**
   * WebGPU pipelines created with `layout: 'auto'` only expose bindings that are
   * statically used by the shader. We therefore must only add the `props` bind
   * group entry when the shader actually reads from `props[...]`.
   * @param {string} code WGSL shader code.
   * @return {boolean} Whether the shader reads from the `props` buffer.
   * @private
   */
  shaderUsesProps_(code) {
    return /\bprops\s*\[/.test(code);
  }

  /**
   * @param {Array<string>} names Names.
   * @private
   */
  setVariableNames_(names) {
    if (
      names.length === this.variableNames_.length &&
      names.every((n, i) => n === this.variableNames_[i])
    ) {
      return;
    }
    this.variableNames_ = names;
    this.variableIndexByName_.clear();
    for (let i = 0; i < names.length; i++) {
      this.variableIndexByName_.set(names[i], i);
    }
    this.variablesBuffer_ = null;
    this.variablesBufferSize_ = 0;
    this.variablesData_ = null;
  }

  /**
   * @param {GPUDevice} device Device.
   * @return {GPUBuffer} Variable storage buffer (array<vec4f>).
   * @private
   */
  getVariablesBuffer_(device) {
    const count = Math.max(1, this.variableNames_.length);
    const byteSize = count * 16;
    if (!this.variablesBuffer_ || this.variablesBufferSize_ !== byteSize) {
      this.variablesBuffer_ = device.createBuffer({
        size: byteSize,
        usage: 0x0080 | 0x0008, // STORAGE | COPY_DST
      });
      this.variablesBufferSize_ = byteSize;
      this.variablesData_ = new Float32Array(count * 4);
      device.queue.writeBuffer(this.variablesBuffer_, 0, this.variablesData_);
    }
    return this.variablesBuffer_;
  }

  /**
   * @param {GPUDevice} device Device.
   * @private
   */
  syncVariables_(device) {
    const buffer = this.getVariablesBuffer_(device);
    const data = this.variablesData_;
    if (!data) {
      return;
    }

    let dirty = false;
    const vars = this.variables_;
    const names = this.variableNames_;
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const value = vars[name];
      let x = 0;
      let y = 0;
      let z = 0;
      let w = 0;

      if (typeof value === 'number') {
        x = value;
      } else if (typeof value === 'boolean') {
        x = value ? 1 : 0;
      } else if (typeof value === 'string') {
        try {
          const c = asArray(value);
          x = c[0] / 255;
          y = c[1] / 255;
          z = c[2] / 255;
          w = c.length > 3 ? c[3] : 1;
        } catch {
          x = 0;
        }
      } else if (Array.isArray(value) && value.length >= 3) {
        const a = /** @type {Array<*>} */ (value);
        const r = Number(a[0]);
        const g = Number(a[1]);
        const b = Number(a[2]);
        if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
          const max = Math.max(r, g, b);
          const scale = max > 1.5 ? 1 / 255 : 1;
          x = r * scale;
          y = g * scale;
          z = b * scale;
          const alpha = a.length > 3 ? Number(a[3]) : 1;
          w = Number.isFinite(alpha) ? alpha : 1;
        }
      }

      const o = i * 4;
      if (
        data[o] !== x ||
        data[o + 1] !== y ||
        data[o + 2] !== z ||
        data[o + 3] !== w
      ) {
        data[o] = x;
        data[o + 1] = y;
        data[o + 2] = z;
        data[o + 3] = w;
        dirty = true;
      }
    }

    if (dirty) {
      device.queue.writeBuffer(buffer, 0, data);
    }
  }

  /**
   * @param {string} name Variable name.
   * @param {number} type Value type bitmask.
   * @return {string} WGSL expression.
   * @private
   */
  getVarExpression_(name, type) {
    const idx = this.variableIndexByName_.get(name);
    if (idx === undefined) {
      if (isType(type, ColorType)) {
        return 'vec4f(0.0, 0.0, 0.0, 0.0)';
      }
      if (isType(type, BooleanType)) {
        return 'false';
      }
      return '0.0';
    }

    if (isType(type, ColorType)) {
      return `vars[${idx}]`;
    }
    if (isType(type, BooleanType)) {
      return `(vars[${idx}].x > 0.0)`;
    }
    if (isType(type, NumberType)) {
      return `vars[${idx}].x`;
    }
    return `vars[${idx}].x`;
  }

  /**
   * @param {string} name Property name.
   * @param {number} type Value type bitmask.
   * @param {string} featureIndexExpr WGSL expression for feature index.
   * @param {Map<string, number>} indexByName Property index map.
   * @param {number} propStride Vec4 slot stride per feature.
   * @return {string} WGSL expression.
   * @private
   */
  getFeaturePropExpression_(
    name,
    type,
    featureIndexExpr,
    indexByName,
    propStride,
  ) {
    const idx = indexByName.get(name);
    if (idx === undefined || propStride <= 0) {
      if (isType(type, ColorType)) {
        return 'vec4f(0.0, 0.0, 0.0, 0.0)';
      }
      if (isType(type, BooleanType)) {
        return 'false';
      }
      return '0.0';
    }

    // Each property uses two vec4 slots:
    // - even slot: scalar/bool in .x
    // - odd slot: color in rgba
    const slot = isType(type, ColorType) ? '1u' : '0u';
    const entry = `props[u32(${featureIndexExpr}) * ${propStride}u + ${idx}u * 2u + ${slot}]`;
    if (isType(type, ColorType)) {
      return entry;
    }
    if (isType(type, BooleanType)) {
      return `(${entry}.x > 0.0)`;
    }
    return `${entry}.x`;
  }

  /**
   * @param {string} src Image URL or data URL.
   * @return {Promise<{sampler: GPUSampler, view: GPUTextureView, size: [number, number]}>} Texture resources.
   * @private
   */
  async getPatternTexture_(src) {
    const cached = this.patternTextureCache_.get(src);
    if (cached) {
      return cached;
    }

    const device = this.helper_.getDevice();
    const loadPromise = (async () => {
      /** @type {ImageBitmap|HTMLImageElement} */
      let imageSource;
      let width;
      let height;
      try {
        const response = await fetch(src);
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);
        imageSource = bitmap;
        width = bitmap.width;
        height = bitmap.height;
      } catch {
        // Some image types (notably SVG in headless Chromium) are not reliably supported by createImageBitmap().
        // Fallback to HTMLImageElement decoding.
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.src = src;
        await image.decode();
        imageSource = image;
        width = image.naturalWidth;
        height = image.naturalHeight;
      }

      const TEXTURE_BINDING = 0x04;
      const COPY_DST = 0x02;
      const RENDER_ATTACHMENT = 0x10;
      const texture = device.createTexture({
        size: {width, height},
        format: 'rgba8unorm',
        usage: TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT,
      });
      device.queue.copyExternalImageToTexture(
        {source: imageSource},
        {texture},
        {width, height},
      );

      const sampler = device.createSampler({
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        magFilter: 'linear',
        minFilter: 'linear',
      });

      return {
        sampler,
        view: texture.createView(),
        size: [width, height],
      };
    })();

    this.patternTextureCache_.set(src, loadPromise);
    return loadPromise;
  }

  /**
   * @param {import("../webgl/MixedGeometryBatch.js").default} geometryBatch Geometry batch.
   * @param {import("../../transform.js").Transform} transform Transform.
   * @return {Promise<Object>} Buffers.
   */
  async generateBuffers(geometryBatch, transform) {
    const rules = (Array.isArray(this.styles_) ? this.styles_ : []).map(
      (entry) => (entry && entry.style ? entry : {style: entry}),
    );
    const alwaysTrueFilter = true;

    const varsUsed = new Set();
    for (const rule of rules) {
      collectVarNames(rule.filter, varsUsed);
      const style = rule.style;
      if (!style) {
        continue;
      }
      for (const value of Object.values(style)) {
        collectVarNames(value, varsUsed);
      }
    }
    this.setVariableNames_(Array.from(varsUsed).sort());

    const propsUsed = new Set();
    for (const rule of rules) {
      collectGetProperties(rule.filter, propsUsed);
      const style = rule.style;
      if (!style) {
        continue;
      }
      // Only collect properties that may be used by the WGSL expression backend today.
      if (
        Array.isArray(style['stroke-width']) &&
        style['stroke-width'][0] !== 'get'
      ) {
        collectGetProperties(style['stroke-width'], propsUsed);
      }
      if (
        Array.isArray(style['stroke-color']) &&
        style['stroke-color'][0] !== 'get'
      ) {
        collectGetProperties(style['stroke-color'], propsUsed);
      }
    }
    const propNames = Array.from(propsUsed).sort();
    const propIndexByName = new Map();
    for (let i = 0; i < propNames.length; i++) {
      propIndexByName.set(propNames[i], i);
    }
    const propCount = propNames.length;
    const propStride = propCount * 2;

    // --- 1. Generate Point Buffers ---
    const pointBatch = geometryBatch.pointBatch;
    const pointEntries = Object.values(pointBatch.entries);
    const pointMaxRef = pointEntries.reduce(
      (max, entry) => Math.max(max, entry.ref || 0),
      0,
    );
    // Calculate total vertices for points
    let pointVertexCount = 0;
    for (const entry of pointEntries) {
      // Each entry can have multiple points (MultiPoint)
      // Point geometries can be XYZ/XYZM (e.g. KML coordinates with altitude).
      // Only the first two components are used for rendering.
      pointVertexCount += entry.flatCoordss.length;
    }

    // 3 floats per vertex: x, y, featureIndex
    const pointData = new Float32Array(pointVertexCount * 3);

    let cursor = 0;
    for (let i = 0; i < pointEntries.length; i++) {
      const entry = pointEntries[i];
      const ref = entry.ref || 0;
      // Fill Vertex Buffer
      for (const flatCoordPoints of entry.flatCoordss) {
        pointData[cursor++] = flatCoordPoints[0];
        pointData[cursor++] = flatCoordPoints[1];
        pointData[cursor++] = ref; // featureIndex (stable ref)
      }
    }

    /** @type {Array<PointBufferSet>} */
    const pointBuffers = [];
    let pointBuffer = null;

    const hasAnyPointSymbol = rules.some((r) => {
      const s = r.style;
      return (
        s && ('icon-src' in s || 'shape-points' in s || 'circle-radius' in s)
      );
    });

    if (pointVertexCount > 0 && hasAnyPointSymbol) {
      pointBuffer = new WebGPUBuffer({
        size: pointData.byteLength,
        usage: 0x0020 | 0x0008, // VERTEX | COPY_DST
        mappedAtCreation: true,
      });
      pointBuffer.create(this.helper_);
      new Float32Array(pointBuffer.getBuffer().getMappedRange()).set(pointData);
      pointBuffer.getBuffer().unmap();
    }

    if (pointBuffer) {
      const STYLE_STRIDE = 20;
      const baseCircleShader =
        this.styleShaders_[0].builder.getCircleSymbolShader();
      const baseIconShader =
        this.styleShaders_[0].builder.getIconSymbolShader();
      const baseShapeShader =
        this.styleShaders_[0].builder.getShapeSymbolShader();

      /** @type {Array<any>} */
      const prevPointFilters = [];
      for (const rule of rules) {
        const style = rule.style;
        if (!style) {
          continue;
        }

        // --- Icons ---
        const iconSrc = style['icon-src'];
        if (
          iconSrc !== undefined &&
          iconSrc !== null &&
          typeof iconSrc !== 'string'
        ) {
          throw new Error(
            'WebGPU layers do not support expressions for the icon-src style property',
          );
        }
        const isIcon = typeof iconSrc === 'string';
        const isShape = 'shape-points' in style;
        const isCircle = 'circle-radius' in style;
        if (!isIcon && !isShape && !isCircle) {
          continue;
        }

        const currentFilter = rule.filter || alwaysTrueFilter;
        const hasPrev = prevPointFilters.length > 0;
        const prevAny =
          prevPointFilters.length === 1
            ? prevPointFilters[0]
            : /** @type {any} */ (['any', ...prevPointFilters]);
        const effectiveFilter =
          rule.else && hasPrev
            ? /** @type {any} */ (['all', currentFilter, ['!', prevAny]])
            : currentFilter;
        prevPointFilters.push(effectiveFilter);

        const filterCtx = {
          lineMetricVar: '0.0',
          getProp: (name, type) =>
            this.getFeaturePropExpression_(
              name,
              type,
              'input.featureIndex',
              propIndexByName,
              propStride,
            ),
          getVar: (name, type) => this.getVarExpression_(name, type),
        };
        const needsDiscard = !!rule.filter || (rule.else && hasPrev);
        const discard = needsDiscard
          ? `!(${compileWgslExpression(effectiveFilter, filterCtx, 'bool')})`
          : 'false';

        if (typeof iconSrc === 'string') {
          const texture = await this.getPatternTexture_(iconSrc);
          const textureSize = texture.size;

          const writeStyle = (styleData, sIdx, feature) => {
            const sampleSize = resolveSize(
              style['icon-size'],
              feature,
              textureSize,
              this.variables_,
            );
            const baseOffset = resolveSize(
              style['icon-offset'],
              feature,
              [0, 0],
              this.variables_,
            );
            const origin = String(
              resolveExpression(
                style['icon-offset-origin'] || 'top-left',
                feature,
                this.variables_,
              ),
            );
            let offsetX = baseOffset[0];
            let offsetY = baseOffset[1];
            if (origin === 'top-right') {
              offsetX = textureSize[0] - sampleSize[0] - offsetX;
            } else if (origin === 'bottom-left') {
              offsetY = textureSize[1] - sampleSize[1] - offsetY;
            } else if (origin === 'bottom-right') {
              offsetX = textureSize[0] - sampleSize[0] - offsetX;
              offsetY = textureSize[1] - sampleSize[1] - offsetY;
            }

            const uvOrigin = [
              offsetX / textureSize[0],
              offsetY / textureSize[1],
            ];
            const uvSize = [
              sampleSize[0] / textureSize[0],
              sampleSize[1] / textureSize[1],
            ];

            const tint = resolveColor(
              style['icon-color'],
              feature,
              [1, 1, 1, 1],
              this.variables_,
            );
            const opacity = resolveNumber(
              style['icon-opacity'],
              feature,
              1.0,
              this.variables_,
            );
            const rotation = resolveNumber(
              style['icon-rotation'],
              feature,
              0.0,
              this.variables_,
            );
            const rotateWithView = style['icon-rotate-with-view'] ? 1 : 0;

            const scaleValue = resolveExpression(
              style['icon-scale'],
              feature,
              this.variables_,
            );
            const scale =
              typeof scaleValue === 'number'
                ? [scaleValue, scaleValue]
                : Array.isArray(scaleValue)
                  ? scaleValue
                  : [1, 1];
            const scaleVec = [Number(scale[0]) || 1, Number(scale[1]) || 1];

            const displacement = resolveExpression(
              style['icon-displacement'],
              feature,
              this.variables_,
            );
            const displacementVec = Array.isArray(displacement)
              ? displacement
              : [0, 0];

            let centerOffset = [
              Number(displacementVec[0]) || 0,
              Number(displacementVec[1]) || 0,
            ];

            if ('icon-anchor' in style) {
              const anchorValue = resolveExpression(
                style['icon-anchor'],
                feature,
                this.variables_,
              );
              const anchor = Array.isArray(anchorValue)
                ? anchorValue
                : [0.5, 0.5];
              const quadSizePx = [
                sampleSize[0] * scaleVec[0],
                sampleSize[1] * scaleVec[1],
              ];
              const scaleScalar = scaleVec[0];
              const xUnits = style['icon-anchor-x-units'] || 'fraction';
              const yUnits = style['icon-anchor-y-units'] || 'fraction';

              let shiftX;
              let shiftY;
              if (xUnits === 'pixels' && yUnits === 'pixels') {
                shiftX = anchor[0] * scaleScalar;
                shiftY = anchor[1] * scaleScalar;
              } else if (xUnits === 'pixels') {
                shiftX = anchor[0] * scaleScalar;
                shiftY = anchor[1] * quadSizePx[1];
              } else if (yUnits === 'pixels') {
                shiftX = anchor[0] * quadSizePx[0];
                shiftY = anchor[1] * scaleScalar;
              } else {
                shiftX = anchor[0] * quadSizePx[0];
                shiftY = anchor[1] * quadSizePx[1];
              }

              let offsetPxX = quadSizePx[0] * 0.5 - shiftX;
              let offsetPxY = -quadSizePx[1] * 0.5 + shiftY;
              const anchorOrigin = style['icon-anchor-origin'] || 'top-left';
              if (anchorOrigin === 'top-right') {
                offsetPxX = -quadSizePx[0] * 0.5 + shiftX;
                offsetPxY = -quadSizePx[1] * 0.5 + shiftY;
              } else if (anchorOrigin === 'bottom-left') {
                offsetPxX = quadSizePx[0] * 0.5 - shiftX;
                offsetPxY = quadSizePx[1] * 0.5 - shiftY;
              } else if (anchorOrigin === 'bottom-right') {
                offsetPxX = -quadSizePx[0] * 0.5 + shiftX;
                offsetPxY = quadSizePx[1] * 0.5 - shiftY;
              }

              centerOffset = [
                centerOffset[0] + offsetPxX,
                centerOffset[1] + offsetPxY,
              ];
            }

            // tint (vec4)
            styleData[sIdx + 0] = tint[0];
            styleData[sIdx + 1] = tint[1];
            styleData[sIdx + 2] = tint[2];
            styleData[sIdx + 3] = tint[3];
            // uvOrigin (vec2)
            styleData[sIdx + 4] = uvOrigin[0];
            styleData[sIdx + 5] = uvOrigin[1];
            // uvSize (vec2)
            styleData[sIdx + 6] = uvSize[0];
            styleData[sIdx + 7] = uvSize[1];
            // sizePx (vec2)
            styleData[sIdx + 8] = sampleSize[0];
            styleData[sIdx + 9] = sampleSize[1];
            // scale (vec2)
            styleData[sIdx + 10] = scaleVec[0];
            styleData[sIdx + 11] = scaleVec[1];
            // rotation, opacity, rotateWithView, pad
            styleData[sIdx + 12] = rotation;
            styleData[sIdx + 13] = opacity;
            styleData[sIdx + 14] = rotateWithView;
            styleData[sIdx + 15] = 0;
            // offsetPx (vec2) + pad
            styleData[sIdx + 16] = centerOffset[0];
            styleData[sIdx + 17] = centerOffset[1];
            styleData[sIdx + 18] = 0;
            styleData[sIdx + 19] = 0;
          };

          const styleData = new Float32Array((pointMaxRef + 1) * STYLE_STRIDE);
          for (let i = 0; i < pointEntries.length; i++) {
            const entry = pointEntries[i];
            writeStyle(
              styleData,
              (entry.ref || 0) * STYLE_STRIDE,
              entry.feature,
            );
          }

          const styleBuffer = new WebGPUBuffer({
            size: styleData.byteLength,
            usage: 0x0080 | 0x0008,
            mappedAtCreation: true,
          });
          styleBuffer.create(this.helper_);
          new Float32Array(styleBuffer.getBuffer().getMappedRange()).set(
            styleData,
          );
          styleBuffer.getBuffer().unmap();

          const strideBytes = STYLE_STRIDE * 4;
          const scratch = new Float32Array(STYLE_STRIDE);
          const symbolShader =
            discard === 'false'
              ? baseIconShader
              : this.styleShaders_[0].builder.getIconSymbolShader({discard});
          /** @type {Float32Array|null} */
          let batchScratch = null;
          pointBuffers.push({
            vertex: pointBuffer,
            style: styleBuffer,
            symbolShader,
            usesVars: this.shaderUsesVars_(symbolShader),
            usesProps: this.shaderUsesProps_(symbolShader),
            pattern: texture,
            updateStyle: (device, ref, feature) => {
              if (!ref || ref > pointMaxRef) {
                return;
              }
              writeStyle(scratch, 0, feature);
              device.queue.writeBuffer(
                styleBuffer.getBuffer(),
                ref * strideBytes,
                scratch,
              );
            },
            updateStyleBatch: (device, dirtyRefs) => {
              if (!dirtyRefs || dirtyRefs.size === 0) {
                return;
              }
              /** @type {Array<number>} */
              const refs = [];
              for (const ref of dirtyRefs.keys()) {
                if (ref && ref <= pointMaxRef) {
                  refs.push(ref);
                }
              }
              if (refs.length === 0) {
                return;
              }
              if (refs.length === 1) {
                const ref = refs[0];
                const feature = dirtyRefs.get(ref);
                if (feature) {
                  writeStyle(scratch, 0, feature);
                  device.queue.writeBuffer(
                    styleBuffer.getBuffer(),
                    ref * strideBytes,
                    scratch,
                  );
                }
                return;
              }
              refs.sort((a, b) => a - b);
              let runStart = refs[0];
              let prev = refs[0];
              for (let i = 1; i <= refs.length; i++) {
                const ref = i < refs.length ? refs[i] : null;
                if (ref !== null && ref === prev + 1) {
                  prev = ref;
                  continue;
                }
                const runLen = prev - runStart + 1;
                const needed = runLen * STYLE_STRIDE;
                if (!batchScratch || batchScratch.length < needed) {
                  batchScratch = new Float32Array(needed);
                }
                for (let r = runStart; r <= prev; r++) {
                  const feature = dirtyRefs.get(r);
                  if (!feature) {
                    continue;
                  }
                  writeStyle(batchScratch, (r - runStart) * STYLE_STRIDE, feature);
                }
                device.queue.writeBuffer(
                  styleBuffer.getBuffer(),
                  runStart * strideBytes,
                  batchScratch.subarray(0, needed),
                );
                if (ref === null) {
                  break;
                }
                runStart = ref;
                prev = ref;
              }
            },
          });
          continue;
        }

        // --- Shapes ---
        if (isShape) {
          const writeStyle = (styleData, sIdx, feature) => {
            const points = resolveNumber(
              style['shape-points'],
              feature,
              3.0,
              this.variables_,
            );
            const strokeWidth = resolveNumber(
              style['shape-stroke-width'],
              feature,
              0.0,
              this.variables_,
            );
            const opacity = resolveNumber(
              style['shape-opacity'],
              feature,
              1.0,
              this.variables_,
            );
            const shapeAngle = resolveNumber(
              style['shape-angle'],
              feature,
              0.0,
              this.variables_,
            );

            const fillColor = resolveColor(
              style['shape-fill-color'],
              feature,
              [1, 1, 1, 1],
              this.variables_,
            );
            let strokeColor = resolveColor(
              style['shape-stroke-color'],
              feature,
              [0, 0, 0, 0],
              this.variables_,
            );
            const strokeExpr = style['shape-stroke-color'];
            if (Array.isArray(strokeExpr) && strokeExpr[0] === '*') {
              const a = resolveColor(
                strokeExpr[1],
                feature,
                strokeColor,
                this.variables_,
              );
              const b = resolveColor(
                strokeExpr[2],
                feature,
                [1, 1, 1, 1],
                this.variables_,
              );
              strokeColor = [
                a[0] * b[0],
                a[1] * b[1],
                a[2] * b[2],
                a[3] * b[3],
              ];
            }

            const baseRadius = resolveNumber(
              style['shape-radius'],
              feature,
              5.0,
              this.variables_,
            );
            const baseRadius2 =
              'shape-radius2' in style
                ? resolveNumber(
                    style['shape-radius2'],
                    feature,
                    0.0,
                    this.variables_,
                  )
                : 0.0;
            const radius = baseRadius + strokeWidth * 0.5;
            const radius2 =
              baseRadius2 > 0 ? baseRadius2 + strokeWidth * 0.5 : 0.0;

            const displacement = resolveExpression(
              style['shape-displacement'],
              feature,
              this.variables_,
            );
            const displacementVec = Array.isArray(displacement)
              ? displacement
              : [0, 0];
            const rotation = resolveNumber(
              style['shape-rotation'],
              feature,
              0.0,
              this.variables_,
            );
            const rotateWithView = style['shape-rotate-with-view'] ? 1 : 0;

            const scaleValue = resolveExpression(
              style['shape-scale'],
              feature,
              this.variables_,
            );
            const scale =
              typeof scaleValue === 'number'
                ? [scaleValue, scaleValue]
                : Array.isArray(scaleValue)
                  ? scaleValue
                  : [1, 1];

            // fillColor (vec4)
            styleData[sIdx + 0] = fillColor[0];
            styleData[sIdx + 1] = fillColor[1];
            styleData[sIdx + 2] = fillColor[2];
            styleData[sIdx + 3] = fillColor[3];
            // strokeColor (vec4)
            styleData[sIdx + 4] = strokeColor[0];
            styleData[sIdx + 5] = strokeColor[1];
            styleData[sIdx + 6] = strokeColor[2];
            styleData[sIdx + 7] = strokeColor[3];
            // radius, radius2, strokeWidth, opacity
            styleData[sIdx + 8] = radius;
            styleData[sIdx + 9] = radius2;
            styleData[sIdx + 10] = strokeWidth;
            styleData[sIdx + 11] = opacity;
            // points, shapeAngle, rotateWithView, rotation
            styleData[sIdx + 12] = points;
            styleData[sIdx + 13] = shapeAngle;
            styleData[sIdx + 14] = rotateWithView;
            styleData[sIdx + 15] = rotation;
            // scale (vec2)
            styleData[sIdx + 16] = Number(scale[0]) || 1;
            styleData[sIdx + 17] = Number(scale[1]) || 1;
            // displacement (vec2)
            styleData[sIdx + 18] = Number(displacementVec[0]) || 0;
            styleData[sIdx + 19] = Number(displacementVec[1]) || 0;
          };

          const styleData = new Float32Array((pointMaxRef + 1) * STYLE_STRIDE);
          for (let i = 0; i < pointEntries.length; i++) {
            const entry = pointEntries[i];
            writeStyle(
              styleData,
              (entry.ref || 0) * STYLE_STRIDE,
              entry.feature,
            );
          }

          const styleBuffer = new WebGPUBuffer({
            size: styleData.byteLength,
            usage: 0x0080 | 0x0008,
            mappedAtCreation: true,
          });
          styleBuffer.create(this.helper_);
          new Float32Array(styleBuffer.getBuffer().getMappedRange()).set(
            styleData,
          );
          styleBuffer.getBuffer().unmap();

          const strideBytes = STYLE_STRIDE * 4;
          const scratch = new Float32Array(STYLE_STRIDE);
          const symbolShader =
            discard === 'false'
              ? baseShapeShader
              : this.styleShaders_[0].builder.getShapeSymbolShader({discard});
          /** @type {Float32Array|null} */
          let batchScratch = null;
          pointBuffers.push({
            vertex: pointBuffer,
            style: styleBuffer,
            symbolShader,
            usesVars: this.shaderUsesVars_(symbolShader),
            usesProps: this.shaderUsesProps_(symbolShader),
            updateStyle: (device, ref, feature) => {
              if (!ref || ref > pointMaxRef) {
                return;
              }
              writeStyle(scratch, 0, feature);
              device.queue.writeBuffer(
                styleBuffer.getBuffer(),
                ref * strideBytes,
                scratch,
              );
            },
            updateStyleBatch: (device, dirtyRefs) => {
              if (!dirtyRefs || dirtyRefs.size === 0) {
                return;
              }
              /** @type {Array<number>} */
              const refs = [];
              for (const ref of dirtyRefs.keys()) {
                if (ref && ref <= pointMaxRef) {
                  refs.push(ref);
                }
              }
              if (refs.length === 0) {
                return;
              }
              if (refs.length === 1) {
                const ref = refs[0];
                const feature = dirtyRefs.get(ref);
                if (feature) {
                  writeStyle(scratch, 0, feature);
                  device.queue.writeBuffer(
                    styleBuffer.getBuffer(),
                    ref * strideBytes,
                    scratch,
                  );
                }
                return;
              }
              refs.sort((a, b) => a - b);
              let runStart = refs[0];
              let prev = refs[0];
              for (let i = 1; i <= refs.length; i++) {
                const ref = i < refs.length ? refs[i] : null;
                if (ref !== null && ref === prev + 1) {
                  prev = ref;
                  continue;
                }
                const runLen = prev - runStart + 1;
                const needed = runLen * STYLE_STRIDE;
                if (!batchScratch || batchScratch.length < needed) {
                  batchScratch = new Float32Array(needed);
                }
                for (let r = runStart; r <= prev; r++) {
                  const feature = dirtyRefs.get(r);
                  if (!feature) {
                    continue;
                  }
                  writeStyle(batchScratch, (r - runStart) * STYLE_STRIDE, feature);
                }
                device.queue.writeBuffer(
                  styleBuffer.getBuffer(),
                  runStart * strideBytes,
                  batchScratch.subarray(0, needed),
                );
                if (ref === null) {
                  break;
                }
                runStart = ref;
                prev = ref;
              }
            },
          });
          continue;
        }

        // --- Circles ---
        if (isCircle) {
          const writeStyle = (styleData, sIdx, feature) => {
            const radius = resolveNumber(
              style['circle-radius'],
              feature,
              5.0,
              this.variables_,
            );
            const strokeWidth = resolveNumber(
              style['circle-stroke-width'],
              feature,
              0.0,
              this.variables_,
            );
            const opacity = resolveNumber(
              style['circle-opacity'],
              feature,
              1.0,
              this.variables_,
            );

            const fillColor = resolveColor(
              style['circle-fill-color'],
              feature,
              [1, 1, 1, 1],
              this.variables_,
            );
            let strokeColor = resolveColor(
              style['circle-stroke-color'],
              feature,
              [0, 0, 0, 0],
              this.variables_,
            );
            const strokeExpr = style['circle-stroke-color'];
            if (Array.isArray(strokeExpr) && strokeExpr[0] === '*') {
              const a = resolveColor(
                strokeExpr[1],
                feature,
                strokeColor,
                this.variables_,
              );
              const b = resolveColor(
                strokeExpr[2],
                feature,
                [1, 1, 1, 1],
                this.variables_,
              );
              strokeColor = [
                a[0] * b[0],
                a[1] * b[1],
                a[2] * b[2],
                a[3] * b[3],
              ];
            }

            const displacement = resolveExpression(
              style['circle-displacement'],
              feature,
              this.variables_,
            );
            const displacementVec = Array.isArray(displacement)
              ? displacement
              : [0, 0];
            const rotation = resolveNumber(
              style['circle-rotation'],
              feature,
              0.0,
              this.variables_,
            );
            const scaleValue = resolveExpression(
              style['circle-scale'],
              feature,
              this.variables_,
            );
            const scale =
              typeof scaleValue === 'number'
                ? [scaleValue, scaleValue]
                : Array.isArray(scaleValue)
                  ? scaleValue
                  : [1, 1];
            const rotateWithView = style['circle-rotate-with-view'] ? 1 : 0;

            styleData[sIdx + 0] = fillColor[0];
            styleData[sIdx + 1] = fillColor[1];
            styleData[sIdx + 2] = fillColor[2];
            styleData[sIdx + 3] = fillColor[3];
            styleData[sIdx + 4] = strokeColor[0];
            styleData[sIdx + 5] = strokeColor[1];
            styleData[sIdx + 6] = strokeColor[2];
            styleData[sIdx + 7] = strokeColor[3];
            styleData[sIdx + 8] = radius;
            styleData[sIdx + 9] = strokeWidth;
            styleData[sIdx + 10] = opacity;
            styleData[sIdx + 11] = rotateWithView;
            styleData[sIdx + 12] = Number(scale[0]) || 1;
            styleData[sIdx + 13] = Number(scale[1]) || 1;
            styleData[sIdx + 14] = rotation;
            styleData[sIdx + 15] = 0;
            styleData[sIdx + 16] = Number(displacementVec[0]) || 0;
            styleData[sIdx + 17] = Number(displacementVec[1]) || 0;
            styleData[sIdx + 18] = 0;
            styleData[sIdx + 19] = 0;
          };

          const styleData = new Float32Array((pointMaxRef + 1) * STYLE_STRIDE);
          for (let i = 0; i < pointEntries.length; i++) {
            const entry = pointEntries[i];
            writeStyle(
              styleData,
              (entry.ref || 0) * STYLE_STRIDE,
              entry.feature,
            );
          }

          const styleBuffer = new WebGPUBuffer({
            size: styleData.byteLength,
            usage: 0x0080 | 0x0008,
            mappedAtCreation: true,
          });
          styleBuffer.create(this.helper_);
          new Float32Array(styleBuffer.getBuffer().getMappedRange()).set(
            styleData,
          );
          styleBuffer.getBuffer().unmap();

          const strideBytes = STYLE_STRIDE * 4;
          const scratch = new Float32Array(STYLE_STRIDE);
          const symbolShader =
            discard === 'false'
              ? baseCircleShader
              : this.styleShaders_[0].builder.getCircleSymbolShader({
                  discard,
                });
          /** @type {Float32Array|null} */
          let batchScratch = null;
          pointBuffers.push({
            vertex: pointBuffer,
            style: styleBuffer,
            symbolShader,
            usesVars: this.shaderUsesVars_(symbolShader),
            usesProps: this.shaderUsesProps_(symbolShader),
            updateStyle: (device, ref, feature) => {
              if (!ref || ref > pointMaxRef) {
                return;
              }
              writeStyle(scratch, 0, feature);
              device.queue.writeBuffer(
                styleBuffer.getBuffer(),
                ref * strideBytes,
                scratch,
              );
            },
            updateStyleBatch: (device, dirtyRefs) => {
              if (!dirtyRefs || dirtyRefs.size === 0) {
                return;
              }
              /** @type {Array<number>} */
              const refs = [];
              for (const ref of dirtyRefs.keys()) {
                if (ref && ref <= pointMaxRef) {
                  refs.push(ref);
                }
              }
              if (refs.length === 0) {
                return;
              }
              if (refs.length === 1) {
                const ref = refs[0];
                const feature = dirtyRefs.get(ref);
                if (feature) {
                  writeStyle(scratch, 0, feature);
                  device.queue.writeBuffer(
                    styleBuffer.getBuffer(),
                    ref * strideBytes,
                    scratch,
                  );
                }
                return;
              }
              refs.sort((a, b) => a - b);
              let runStart = refs[0];
              let prev = refs[0];
              for (let i = 1; i <= refs.length; i++) {
                const ref = i < refs.length ? refs[i] : null;
                if (ref !== null && ref === prev + 1) {
                  prev = ref;
                  continue;
                }
                const runLen = prev - runStart + 1;
                const needed = runLen * STYLE_STRIDE;
                if (!batchScratch || batchScratch.length < needed) {
                  batchScratch = new Float32Array(needed);
                }
                for (let r = runStart; r <= prev; r++) {
                  const feature = dirtyRefs.get(r);
                  if (!feature) {
                    continue;
                  }
                  writeStyle(batchScratch, (r - runStart) * STYLE_STRIDE, feature);
                }
                device.queue.writeBuffer(
                  styleBuffer.getBuffer(),
                  runStart * strideBytes,
                  batchScratch.subarray(0, needed),
                );
                if (ref === null) {
                  break;
                }
                runStart = ref;
                prev = ref;
              }
            },
          });
        }
      }
    }

    // --- 2. Generate LineString Buffers ---
    const lineBatch = geometryBatch.lineStringBatch;
    const lineEntries = Object.values(lineBatch.entries);
    const lineMaxRef = lineEntries.reduce(
      (max, entry) => Math.max(max, entry.ref || 0),
      0,
    );

    // stride is 3 (XYM) for lines in MixedGeometryBatch
    const LINE_STRIDE = 3;

    // Generate per-segment instance attributes compatible with the WebGL stroke pipeline:
    // p0(x,y,m), p1(x,y,m), angle0, angle1, distanceLow, distanceHigh, angleTangentSum, featureIndex
    // -> 12 floats per segment instance.
    /** @type {Array<number>} */
    const lineInstanceAttributes = [];

    const strokeRules = rules.filter((r) => {
      const s = r.style;
      return (
        s &&
        ('stroke-color' in s ||
          'stroke-width' in s ||
          'stroke-line-dash' in s ||
          'stroke-offset' in s)
      );
    });
    const hasAnyStroke = strokeRules.length > 0;

    const identityTransform = createTransform();
    // Generate segment instances per feature/linestring
    for (let i = 0; i < lineEntries.length; i++) {
      const entry = lineEntries[i];
      const ref = entry.ref || 0;

      for (const flatCoords of entry.flatCoordss) {
        const numPoints = flatCoords.length / LINE_STRIDE;
        if (numPoints < 2) {
          continue;
        }
        const instructions = new Float32Array(flatCoords);
        const firstInstructionsIndex = 0;
        const lastInstructionsIndex = (numPoints - 1) * LINE_STRIDE;
        const isLoop =
          instructions[firstInstructionsIndex] ===
            instructions[lastInstructionsIndex] &&
          instructions[firstInstructionsIndex + 1] ===
            instructions[lastInstructionsIndex + 1];

        let currentLength = 0;
        let currentAngleTangentSum = 0;

        for (let j = 0; j < numPoints - 1; j++) {
          let beforeIndex = null;
          if (j > 0) {
            beforeIndex = (j - 1) * LINE_STRIDE;
          } else if (isLoop) {
            beforeIndex = lastInstructionsIndex - LINE_STRIDE;
          }

          let afterIndex = null;
          if (j < numPoints - 2) {
            afterIndex = (j + 2) * LINE_STRIDE;
          } else if (isLoop) {
            afterIndex = firstInstructionsIndex + LINE_STRIDE;
          }

          const measures = writeLineSegmentToBuffers(
            instructions,
            j * LINE_STRIDE,
            (j + 1) * LINE_STRIDE,
            beforeIndex,
            afterIndex,
            lineInstanceAttributes,
            [ref], // featureIndex as custom attribute (stable ref)
            identityTransform,
            currentLength,
            currentAngleTangentSum,
          );
          currentLength = measures.length;
          currentAngleTangentSum = measures.angle;
        }
      }
    }

    let lineBuffer = null;
    /** @type {Array<LineStringBufferSet>} */
    const lineStringBuffers = [];
    if (lineInstanceAttributes.length > 0 && hasAnyStroke) {
      const lineData = new Float32Array(lineInstanceAttributes);
      lineBuffer = new WebGPUBuffer({
        size: lineData.byteLength,
        usage: 0x0020 | 0x0008, // VERTEX | COPY_DST
        mappedAtCreation: true,
      });
      lineBuffer.create(this.helper_);
      new Float32Array(lineBuffer.getBuffer().getMappedRange()).set(lineData);
      lineBuffer.getBuffer().unmap();
    }

    if (lineBuffer) {
      // Style struct is aligned to 16 bytes; 24 floats = 96 bytes per feature:
      // color(4), width, cap, join, miterLimit, offset, dashCount, dashOffset, dashTotal, pad(4),
      // dash0(4), dash1(4), pad(4) => 28 floats (112 bytes) per feature
      const STYLE_STRIDE = 28;
      const DASH_MAX = 8;
      const defaultColor = [0, 0, 0, 1];
      /** @type {Array<any>} */
      const prevStrokeFilters = [];
      for (const rule of strokeRules) {
        const style = rule.style;
        const currentFilter = rule.filter || alwaysTrueFilter;
        const hasPrev = prevStrokeFilters.length > 0;
        const prevAny =
          prevStrokeFilters.length === 1
            ? prevStrokeFilters[0]
            : /** @type {any} */ (['any', ...prevStrokeFilters]);
        const effectiveFilter =
          rule.else && hasPrev
            ? /** @type {any} */ (['all', currentFilter, ['!', prevAny]])
            : currentFilter;
        prevStrokeFilters.push(effectiveFilter);
        const needsDiscard = !!rule.filter || (rule.else && hasPrev);
        const lineStyleData = new Float32Array((lineMaxRef + 1) * STYLE_STRIDE);

        const patternSrc = style['stroke-pattern-src'];
        if (
          patternSrc !== undefined &&
          patternSrc !== null &&
          typeof patternSrc !== 'string'
        ) {
          throw new Error(
            'WebGPU layers do not support expressions for the stroke-pattern-src style property',
          );
        }
        const hasStrokePattern = typeof patternSrc === 'string';
        let patternTexture;
        let patternOptions;
        if (hasStrokePattern) {
          patternTexture = await this.getPatternTexture_(patternSrc);
          const textureSize = patternTexture.size;
          const sampleSize = Array.isArray(style['stroke-pattern-size'])
            ? style['stroke-pattern-size']
            : textureSize;
          const baseOffset = Array.isArray(style['stroke-pattern-offset'])
            ? style['stroke-pattern-offset']
            : [0, 0];
          const origin = style['stroke-pattern-offset-origin'] || 'top-left';
          let offsetX = baseOffset[0] || 0;
          let offsetY = baseOffset[1] || 0;
          if (origin === 'top-right') {
            offsetX = textureSize[0] - sampleSize[0] - offsetX;
          } else if (origin === 'bottom-left') {
            offsetY = textureSize[1] - sampleSize[1] - offsetY;
          } else if (origin === 'bottom-right') {
            offsetX = textureSize[0] - sampleSize[0] - offsetX;
            offsetY = textureSize[1] - sampleSize[1] - offsetY;
          }

          const spacingPx = Number(style['stroke-pattern-spacing'] || 0);
          const startOffsetPx = Number(
            style['stroke-pattern-start-offset'] || 0,
          );
          const tintEnabled = 'stroke-color' in style;
          patternOptions = {
            textureSize: `vec2f(${textureSize[0]}, ${textureSize[1]})`,
            textureOffset: `vec2f(${offsetX}, ${offsetY})`,
            sampleSize: `vec2f(${sampleSize[0]}, ${sampleSize[1]})`,
            spacingPx: `${spacingPx}`,
            startOffsetPx: `${startOffsetPx}`,
            tint: tintEnabled ? 'style.color' : 'vec4f(1.0, 1.0, 1.0, 1.0)',
          };
        }

        const writeStyle = (lineStyleData, sIdx, feature) => {
          const color = resolveColor(
            style['stroke-color'],
            feature,
            defaultColor,
          );
          const width = resolveStrokeWidth(style['stroke-width'], feature, 1.0);
          const offsetPx = resolveNumber(style['stroke-offset'], feature, 0.0);
          const miterLimit = resolveNumber(
            style['stroke-miter-limit'],
            feature,
            10.0,
          );

          let capType = 2; // match WebGL default
          if ('stroke-line-cap' in style) {
            const cap = String(
              resolveExpression(style['stroke-line-cap'], feature),
            );
            capType = cap === 'square' ? 1 : cap === 'butt' ? 0 : 2;
          }
          let joinType = 2; // match WebGL default
          if ('stroke-line-join' in style) {
            const join = String(
              resolveExpression(style['stroke-line-join'], feature),
            );
            joinType = join === 'bevel' ? 1 : join === 'round' ? 2 : 0;
          }

          const dash = resolveExpression(style['stroke-line-dash'], feature);
          const dashOffset = resolveNumber(
            style['stroke-line-dash-offset'],
            feature,
            0.0,
          );
          let dashValues = Array.isArray(dash) ? dash : null;
          if (dashValues && dashValues.length % 2 === 1) {
            dashValues = dashValues.concat(dashValues);
          }
          const dashCount = dashValues
            ? Math.min(DASH_MAX, dashValues.length)
            : 0;
          let dashTotal = 0.0;
          for (let d = 0; d < dashCount; d++) {
            dashTotal += resolveNumber(dashValues[d], feature, 0.0);
          }

          lineStyleData[sIdx + 0] = color[0];
          lineStyleData[sIdx + 1] = color[1];
          lineStyleData[sIdx + 2] = color[2];
          lineStyleData[sIdx + 3] = color[3];
          lineStyleData[sIdx + 4] = width;
          lineStyleData[sIdx + 5] = capType;
          lineStyleData[sIdx + 6] = joinType;
          lineStyleData[sIdx + 7] =
            Number.isFinite(miterLimit) && miterLimit > 0 ? miterLimit : 10.0;
          lineStyleData[sIdx + 8] = offsetPx;
          lineStyleData[sIdx + 9] = dashCount;
          lineStyleData[sIdx + 10] = dashOffset;
          lineStyleData[sIdx + 11] = dashTotal;

          for (let d = 0; d < dashCount; d++) {
            const len = resolveNumber(dashValues[d], feature, 0.0);
            const vecBase = d < 4 ? sIdx + 16 : sIdx + 20;
            lineStyleData[vecBase + (d % 4)] = len;
          }
        };

        for (let i = 0; i < lineEntries.length; i++) {
          const entry = lineEntries[i];
          writeStyle(
            lineStyleData,
            (entry.ref || 0) * STYLE_STRIDE,
            entry.feature,
          );
        }

        const lineStyleBuffer = new WebGPUBuffer({
          size: lineStyleData.byteLength,
          usage: 0x0080 | 0x0008, // STORAGE
          mappedAtCreation: true,
        });
        lineStyleBuffer.create(this.helper_);
        new Float32Array(lineStyleBuffer.getBuffer().getMappedRange()).set(
          lineStyleData,
        );
        lineStyleBuffer.getBuffer().unmap();

        const strideBytes = STYLE_STRIDE * 4;
        const scratch = new Float32Array(STYLE_STRIDE);
        let strokeShader;
        if (
          needsDiscard ||
          (Array.isArray(style['stroke-width']) &&
            style['stroke-width'][0] !== 'get') ||
          (Array.isArray(style['stroke-color']) &&
            style['stroke-color'][0] !== 'get') ||
          hasStrokePattern
        ) {
          const vertexCtx = {
            lineMetricVar: 'lineMetric',
            getProp: (name, type) =>
              this.getFeaturePropExpression_(
                name,
                type,
                'featureIndex',
                propIndexByName,
                propStride,
              ),
            getVar: (name, type) => this.getVarExpression_(name, type),
          };
          const fragmentCtx = {
            lineMetricVar: 'lineMetric',
            getProp: (name, type) =>
              this.getFeaturePropExpression_(
                name,
                type,
                'input.featureIndex',
                propIndexByName,
                propStride,
              ),
            getVar: (name, type) => this.getVarExpression_(name, type),
          };
          const discard = needsDiscard
            ? `!(${compileWgslExpression(effectiveFilter, fragmentCtx, 'bool')})`
            : 'false';
          const widthExpr = Array.isArray(style['stroke-width'])
            ? compileWgslExpression(style['stroke-width'], vertexCtx, 'f32')
            : 'style.width';
          const colorExpr = Array.isArray(style['stroke-color'])
            ? compileWgslExpression(style['stroke-color'], fragmentCtx, 'vec4f')
            : 'style.color';
          strokeShader = this.styleShaders_[0].builder.getStrokeShader({
            strokeColor: colorExpr,
            strokeWidth: widthExpr,
            discard: discard,
            pattern: patternOptions,
          });
        }

        const strokeCode = strokeShader || this.defaultStrokeShader_;
        /** @type {Float32Array|null} */
        let batchScratch = null;
        lineStringBuffers.push({
          vertex: lineBuffer,
          style: lineStyleBuffer,
          strokeShader,
          usesVars: strokeShader
            ? this.shaderUsesVars_(strokeCode)
            : this.defaultStrokeShaderUsesVars_,
          usesProps: strokeShader
            ? this.shaderUsesProps_(strokeCode)
            : this.defaultStrokeShaderUsesProps_,
          pattern: patternTexture,
          updateStyle: (device, ref, feature) => {
            if (!ref || ref > lineMaxRef) {
              return;
            }
            writeStyle(scratch, 0, feature);
            device.queue.writeBuffer(
              lineStyleBuffer.getBuffer(),
              ref * strideBytes,
              scratch,
            );
          },
          updateStyleBatch: (device, dirtyRefs) => {
            if (!dirtyRefs || dirtyRefs.size === 0) {
              return;
            }
            /** @type {Array<number>} */
            const refs = [];
            for (const ref of dirtyRefs.keys()) {
              if (ref && ref <= lineMaxRef) {
                refs.push(ref);
              }
            }
            if (refs.length === 0) {
              return;
            }
            if (refs.length === 1) {
              const ref = refs[0];
              const feature = dirtyRefs.get(ref);
              if (feature) {
                writeStyle(scratch, 0, feature);
                device.queue.writeBuffer(
                  lineStyleBuffer.getBuffer(),
                  ref * strideBytes,
                  scratch,
                );
              }
              return;
            }
            refs.sort((a, b) => a - b);
            let runStart = refs[0];
            let prev = refs[0];
            for (let i = 1; i <= refs.length; i++) {
              const ref = i < refs.length ? refs[i] : null;
              if (ref !== null && ref === prev + 1) {
                prev = ref;
                continue;
              }
              const runLen = prev - runStart + 1;
              const needed = runLen * STYLE_STRIDE;
              if (!batchScratch || batchScratch.length < needed) {
                batchScratch = new Float32Array(needed);
              }
              for (let r = runStart; r <= prev; r++) {
                const feature = dirtyRefs.get(r);
                if (!feature) {
                  continue;
                }
                writeStyle(batchScratch, (r - runStart) * STYLE_STRIDE, feature);
              }
              device.queue.writeBuffer(
                lineStyleBuffer.getBuffer(),
                runStart * strideBytes,
                batchScratch.subarray(0, needed),
              );
              if (ref === null) {
                break;
              }
              runStart = ref;
              prev = ref;
            }
          },
        });
      }
    }

    // --- 3. Generate Polygon Buffers ---
    const polyBatch = geometryBatch.polygonBatch;
    const polyEntries = Object.values(polyBatch.entries);
    const polyMaxRef = polyEntries.reduce(
      (max, entry) => Math.max(max, entry.ref || 0),
      0,
    );

    const polyRules = rules.filter((r) => {
      const s = r.style;
      if (!s) {
        return false;
      }

      const patternSrc = s['fill-pattern-src'];
      if (
        patternSrc !== undefined &&
        patternSrc !== null &&
        typeof patternSrc !== 'string'
      ) {
        throw new Error(
          'WebGPU layers do not support expressions for the fill-pattern-src style property',
        );
      }

      const fillColor = s['fill-color'];
      const hasFillColor =
        typeof fillColor === 'string' ||
        (Array.isArray(fillColor) &&
          (fillColor[0] === 'get' ||
            fillColor[0] === 'var' ||
            typeof fillColor[0] !== 'string'));

      return hasFillColor || typeof patternSrc === 'string';
    });
    /** @type {Array<PolygonBufferSet>} */
    const polygonBuffers = [];
    if (polyRules.length > 0) {
      // To estimate size, we'd need to triangulate first or use a dynamic array.
      // Since earcut is fast enough for 2D, triangulate into a temp array once.

      const POLY_STRIDE = 2; // MixedGeometryBatch usually 2 unless M/Z
      const polyVertices = []; // [x, y, featureIndex, x, y, featureIndex]
      for (let i = 0; i < polyEntries.length; i++) {
        const entry = polyEntries[i];
        const ref = entry.ref || 0;

        // entry.flatCoordss is Array<Array<number>> (polygons)
        // entry.ringsVerticesCounts is Array<Array<number>> (rings per polygon)
        for (let pOffset = 0; pOffset < entry.flatCoordss.length; pOffset++) {
          const flatCoords = entry.flatCoordss[pOffset];
          const ringsCounts = entry.ringsVerticesCounts[pOffset];

          if (!flatCoords || flatCoords.length === 0) {
            continue;
          }

          // Calculate holes
          // holes: array of vertex-indices where holes start
          const holes = [];
          let currentVertexIndex = 0;
          for (let r = 0; r < ringsCounts.length; r++) {
            // ringsCounts[r] is number of vertices in this ring
            if (r > 0) {
              holes.push(currentVertexIndex);
            }
            currentVertexIndex += ringsCounts[r];
          }

          // Triangulate
          const triangles = earcut(flatCoords, holes, POLY_STRIDE);

          // triangles is flat array of vertex indices
          for (let t = 0; t < triangles.length; t++) {
            const vIdx = triangles[t]; // Index of vertex (0-based)
            const px = flatCoords[vIdx * POLY_STRIDE];
            const py = flatCoords[vIdx * POLY_STRIDE + 1];
            polyVertices.push(px, py, ref); // x, y, featureIndex (stable ref)
          }
        }
      }

      let polyBuffer = null;
      if (polyVertices.length > 0) {
        const polyDataFloat = new Float32Array(polyVertices);
        polyBuffer = new WebGPUBuffer({
          size: polyDataFloat.byteLength,
          usage: 0x0020 | 0x0008,
          mappedAtCreation: true,
        });
        polyBuffer.create(this.helper_);
        new Float32Array(polyBuffer.getBuffer().getMappedRange()).set(
          polyDataFloat,
        );
        polyBuffer.getBuffer().unmap();
      }

      if (polyBuffer) {
        /** @type {Array<any>} */
        const prevFillFilters = [];
        for (const rule of polyRules) {
          const polyStyle = rule.style;
          const fillPatternSrc = polyStyle['fill-pattern-src'];
          const hasFillPattern = typeof fillPatternSrc === 'string';

          const fillColorExpr = polyStyle['fill-color'];
          const fallbackTint = hasFillPattern ? [1, 1, 1, 1] : [0, 0, 1, 1];
          const resolveFillColor = (feature) => {
            if (!fillColorExpr) {
              return fallbackTint;
            }
            if (
              Array.isArray(fillColorExpr) &&
              fillColorExpr.length === 2 &&
              fillColorExpr[0] === 'var'
            ) {
              return resolveColor(
                this.variables_[fillColorExpr[1]],
                feature,
                fallbackTint,
              );
            }
            return resolveColor(fillColorExpr, feature, fallbackTint);
          };

          /** @type {StrokePatternTexture|undefined} */
          let fillPatternTexture;
          /** @type {import("./WGSLBuilder.js").FillPatternShaderOptions|undefined} */
          let fillPatternOptions;
          if (hasFillPattern) {
            fillPatternTexture = await this.getPatternTexture_(fillPatternSrc);
            const textureSize = fillPatternTexture.size;
            const sampleSize = Array.isArray(polyStyle['fill-pattern-size'])
              ? polyStyle['fill-pattern-size']
              : textureSize;
            const baseOffset = Array.isArray(polyStyle['fill-pattern-offset'])
              ? polyStyle['fill-pattern-offset']
              : [0, 0];
            const origin =
              polyStyle['fill-pattern-offset-origin'] || 'top-left';
            let offsetX = baseOffset[0] || 0;
            let offsetY = baseOffset[1] || 0;
            if (origin === 'top-right') {
              offsetX = textureSize[0] - sampleSize[0] - offsetX;
            } else if (origin === 'bottom-left') {
              offsetY = textureSize[1] - sampleSize[1] - offsetY;
            } else if (origin === 'bottom-right') {
              offsetX = textureSize[0] - sampleSize[0] - offsetX;
              offsetY = textureSize[1] - sampleSize[1] - offsetY;
            }

            fillPatternOptions = {
              textureSize: `vec2f(${textureSize[0]}, ${textureSize[1]})`,
              textureOffset: `vec2f(${offsetX}, ${offsetY})`,
              sampleSize: `vec2f(${sampleSize[0]}, ${sampleSize[1]})`,
              tint: 'input.color',
            };
          }

          const polyStyleData = new Float32Array((polyMaxRef + 1) * 4); // vec4 per feature ref
          for (let i = 0; i < polyEntries.length; i++) {
            const entry = polyEntries[i];
            const ref = entry.ref || 0;
            const fillColor = resolveFillColor(entry.feature);
            polyStyleData[ref * 4 + 0] = fillColor[0];
            polyStyleData[ref * 4 + 1] = fillColor[1];
            polyStyleData[ref * 4 + 2] = fillColor[2];
            polyStyleData[ref * 4 + 3] = fillColor[3];
          }

          const polyStyleBuffer = new WebGPUBuffer({
            size: polyStyleData.byteLength,
            usage: 0x0080 | 0x0008,
            mappedAtCreation: true,
          });
          polyStyleBuffer.create(this.helper_);
          new Float32Array(polyStyleBuffer.getBuffer().getMappedRange()).set(
            polyStyleData,
          );
          polyStyleBuffer.getBuffer().unmap();

          const currentFilter = rule.filter || alwaysTrueFilter;
          const hasPrev = prevFillFilters.length > 0;
          const prevAny =
            prevFillFilters.length === 1
              ? prevFillFilters[0]
              : /** @type {any} */ (['any', ...prevFillFilters]);
          const effectiveFilter =
            rule.else && hasPrev
              ? /** @type {any} */ (['all', currentFilter, ['!', prevAny]])
              : currentFilter;
          prevFillFilters.push(effectiveFilter);

          const polyFilterCtx = {
            lineMetricVar: '0.0',
            getProp: (name, type) =>
              this.getFeaturePropExpression_(
                name,
                type,
                'input.featureIndex',
                propIndexByName,
                propStride,
              ),
            getVar: (name, type) => this.getVarExpression_(name, type),
          };
          const needsDiscard = !!rule.filter || (rule.else && hasPrev);
          const polyDiscard = needsDiscard
            ? `!(${compileWgslExpression(effectiveFilter, polyFilterCtx, 'bool')})`
            : 'false';

          const scratch = new Float32Array(4);
          const fillShader =
            hasFillPattern || polyDiscard !== 'false'
              ? this.styleShaders_[0].builder.getFillShader({
                  pattern: fillPatternOptions,
                  discard: polyDiscard,
                })
              : undefined;
          const fillCode = fillShader || this.defaultFillShader_;
          /** @type {Float32Array|null} */
          let batchScratch = null;
          polygonBuffers.push({
            vertex: polyBuffer,
            style: polyStyleBuffer,
            fillShader,
            usesVars: fillShader
              ? this.shaderUsesVars_(fillCode)
              : this.defaultFillShaderUsesVars_,
            usesProps: fillShader
              ? this.shaderUsesProps_(fillCode)
              : this.defaultFillShaderUsesProps_,
            pattern: fillPatternTexture,
            updateStyle: (device, ref, feature) => {
              if (!ref || ref > polyMaxRef) {
                return;
              }
              const fillColor = resolveFillColor(feature);
              scratch[0] = fillColor[0];
              scratch[1] = fillColor[1];
              scratch[2] = fillColor[2];
              scratch[3] = fillColor[3];
              device.queue.writeBuffer(
                polyStyleBuffer.getBuffer(),
                ref * 16,
                scratch,
              );
            },
            updateStyleBatch: (device, dirtyRefs) => {
              if (!dirtyRefs || dirtyRefs.size === 0) {
                return;
              }
              /** @type {Array<number>} */
              const refs = [];
              for (const ref of dirtyRefs.keys()) {
                if (ref && ref <= polyMaxRef) {
                  refs.push(ref);
                }
              }
              if (refs.length === 0) {
                return;
              }
              if (refs.length === 1) {
                const ref = refs[0];
                const feature = dirtyRefs.get(ref);
                if (feature) {
                  const fillColor = resolveFillColor(feature);
                  scratch[0] = fillColor[0];
                  scratch[1] = fillColor[1];
                  scratch[2] = fillColor[2];
                  scratch[3] = fillColor[3];
                  device.queue.writeBuffer(
                    polyStyleBuffer.getBuffer(),
                    ref * 16,
                    scratch,
                  );
                }
                return;
              }
              refs.sort((a, b) => a - b);
              let runStart = refs[0];
              let prev = refs[0];
              for (let i = 1; i <= refs.length; i++) {
                const ref = i < refs.length ? refs[i] : null;
                if (ref !== null && ref === prev + 1) {
                  prev = ref;
                  continue;
                }
                const runLen = prev - runStart + 1;
                const needed = runLen * 4;
                if (!batchScratch || batchScratch.length < needed) {
                  batchScratch = new Float32Array(needed);
                }
                for (let r = runStart; r <= prev; r++) {
                  const feature = dirtyRefs.get(r);
                  if (!feature) {
                    continue;
                  }
                  const fillColor = resolveFillColor(feature);
                  const base = (r - runStart) * 4;
                  batchScratch[base + 0] = fillColor[0];
                  batchScratch[base + 1] = fillColor[1];
                  batchScratch[base + 2] = fillColor[2];
                  batchScratch[base + 3] = fillColor[3];
                }
                device.queue.writeBuffer(
                  polyStyleBuffer.getBuffer(),
                  runStart * 16,
                  batchScratch.subarray(0, needed),
                );
                if (ref === null) {
                  break;
                }
                runStart = ref;
                prev = ref;
              }
            },
          });
        }
      }
    }

    const maxRef = Math.max(pointMaxRef, lineMaxRef, polyMaxRef);
    const featureCount = maxRef + 1;
    /** @type {{buffer: WebGPUBuffer, propNames: Array<string>, propCount: number, indexByName: Map<string, number>, update: (device: GPUDevice, ref: number, feature: import(\"../../Feature.js\").default|import(\"../../render/Feature.js\").default) => void}|null} */
    let featureProperties = null;
    if (propCount > 0 && featureCount > 0) {
      const featureByRef = new Array(featureCount);
      for (const entry of pointEntries) {
        const ref = entry.ref || 0;
        if (!featureByRef[ref]) {
          featureByRef[ref] = entry.feature;
        }
      }
      for (const entry of lineEntries) {
        const ref = entry.ref || 0;
        if (!featureByRef[ref]) {
          featureByRef[ref] = entry.feature;
        }
      }
      for (const entry of polyEntries) {
        const ref = entry.ref || 0;
        if (!featureByRef[ref]) {
          featureByRef[ref] = entry.feature;
        }
      }

      const data = new Float32Array(featureCount * propStride * 4);
      for (let ref = 0; ref < featureCount; ref++) {
        const feature = featureByRef[ref];
        if (!feature) {
          continue;
        }
        for (let i = 0; i < propCount; i++) {
          const name = propNames[i];
          const value = feature.get(name);
          let scalar = 0;
          if (typeof value === 'number') {
            scalar = Number.isFinite(value) ? value : 0;
          } else if (typeof value === 'boolean') {
            scalar = value ? 1 : 0;
          } else if (typeof value === 'string') {
            const n = Number(value);
            scalar = Number.isFinite(n) ? n : 0;
          }
          const scalarOffset = (ref * propStride + i * 2) * 4;
          data[scalarOffset] = scalar;

          if (Array.isArray(value)) {
            const r = Number(value[0]);
            const g = Number(value[1]);
            const b = Number(value[2]);
            if (
              Number.isFinite(r) &&
              Number.isFinite(g) &&
              Number.isFinite(b)
            ) {
              const max = Math.max(r, g, b);
              const scale = max > 1.5 ? 1 / 255 : 1;
              const a = value.length > 3 ? Number(value[3]) : 1;
              const alpha = Number.isFinite(a) ? a : 1;
              const colorOffset = (ref * propStride + i * 2 + 1) * 4;
              data[colorOffset] = r * scale;
              data[colorOffset + 1] = g * scale;
              data[colorOffset + 2] = b * scale;
              data[colorOffset + 3] = alpha;
            }
          } else if (typeof value === 'string') {
            try {
              const rgba = asArray(value);
              const r = Number(rgba[0]);
              const g = Number(rgba[1]);
              const b = Number(rgba[2]);
              if (
                Number.isFinite(r) &&
                Number.isFinite(g) &&
                Number.isFinite(b)
              ) {
                const max = Math.max(r, g, b);
                const scale = max > 1.5 ? 1 / 255 : 1;
                const a = rgba.length > 3 ? Number(rgba[3]) : 1;
                const alpha = Number.isFinite(a) ? a : 1;
                const colorOffset = (ref * propStride + i * 2 + 1) * 4;
                data[colorOffset] = r * scale;
                data[colorOffset + 1] = g * scale;
                data[colorOffset + 2] = b * scale;
                data[colorOffset + 3] = alpha;
              }
            } catch {
              // ignore invalid colors
            }
          }
        }
      }

      const propsBuffer = new WebGPUBuffer({
        size: data.byteLength,
        usage: 0x0080 | 0x0008, // STORAGE | COPY_DST
        mappedAtCreation: true,
      });
      propsBuffer.create(this.helper_);
      new Float32Array(propsBuffer.getBuffer().getMappedRange()).set(data);
      propsBuffer.getBuffer().unmap();

      const strideBytes = propStride * 16;
      const rowStrideFloats = propStride * 4;
      const scratch = new Float32Array(rowStrideFloats);
      /** @type {Float32Array|null} */
      let batchScratch = null;
      const writeRow = (dst, base, feature) => {
        dst.fill(0, base, base + rowStrideFloats);
        for (let i = 0; i < propCount; i++) {
          const name = propNames[i];
          const value = feature.get(name);
          let scalar = 0;
          if (typeof value === 'number') {
            scalar = Number.isFinite(value) ? value : 0;
          } else if (typeof value === 'boolean') {
            scalar = value ? 1 : 0;
          } else if (typeof value === 'string') {
            const n = Number(value);
            scalar = Number.isFinite(n) ? n : 0;
          }
          dst[base + i * 8] = scalar;

          if (Array.isArray(value)) {
            const r = Number(value[0]);
            const g = Number(value[1]);
            const b = Number(value[2]);
            if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
              const max = Math.max(r, g, b);
              const scale = max > 1.5 ? 1 / 255 : 1;
              const a = value.length > 3 ? Number(value[3]) : 1;
              const alpha = Number.isFinite(a) ? a : 1;
              const colorOffset = base + i * 8 + 4;
              dst[colorOffset] = r * scale;
              dst[colorOffset + 1] = g * scale;
              dst[colorOffset + 2] = b * scale;
              dst[colorOffset + 3] = alpha;
            }
          } else if (typeof value === 'string') {
            try {
              const rgba = asArray(value);
              const r = Number(rgba[0]);
              const g = Number(rgba[1]);
              const b = Number(rgba[2]);
              if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
                const max = Math.max(r, g, b);
                const scale = max > 1.5 ? 1 / 255 : 1;
                const a = rgba.length > 3 ? Number(rgba[3]) : 1;
                const alpha = Number.isFinite(a) ? a : 1;
                const colorOffset = base + i * 8 + 4;
                dst[colorOffset] = r * scale;
                dst[colorOffset + 1] = g * scale;
                dst[colorOffset + 2] = b * scale;
                dst[colorOffset + 3] = alpha;
              }
            } catch {
              // ignore invalid colors
            }
          }
        }
      };
      featureProperties = {
        buffer: propsBuffer,
        propNames,
        propCount,
        indexByName: propIndexByName,
        update: (device, ref, feature) => {
          if (!ref || ref >= featureCount) {
            return;
          }
          writeRow(scratch, 0, feature);
          device.queue.writeBuffer(
            propsBuffer.getBuffer(),
            ref * strideBytes,
            scratch,
          );
        },
        updateBatch: (device, dirtyRefs) => {
          if (!dirtyRefs || dirtyRefs.size === 0) {
            return;
          }
          /** @type {Array<number>} */
          const refs = [];
          for (const ref of dirtyRefs.keys()) {
            if (ref && ref < featureCount) {
              refs.push(ref);
            }
          }
          if (refs.length === 0) {
            return;
          }
          if (refs.length === 1) {
            const ref = refs[0];
            const feature = dirtyRefs.get(ref);
            if (feature) {
              writeRow(scratch, 0, feature);
              device.queue.writeBuffer(
                propsBuffer.getBuffer(),
                ref * strideBytes,
                scratch,
              );
            }
            return;
          }
          refs.sort((a, b) => a - b);
          let runStart = refs[0];
          let prev = refs[0];
          for (let i = 1; i <= refs.length; i++) {
            const ref = i < refs.length ? refs[i] : null;
            if (ref !== null && ref === prev + 1) {
              prev = ref;
              continue;
            }
            const runLen = prev - runStart + 1;
            const needed = runLen * rowStrideFloats;
            if (!batchScratch || batchScratch.length < needed) {
              batchScratch = new Float32Array(needed);
            }
            for (let r = runStart; r <= prev; r++) {
              const feature = dirtyRefs.get(r);
              if (!feature) {
                continue;
              }
              writeRow(batchScratch, (r - runStart) * rowStrideFloats, feature);
            }
            device.queue.writeBuffer(
              propsBuffer.getBuffer(),
              runStart * strideBytes,
              batchScratch.subarray(0, needed),
            );
            if (ref === null) {
              break;
            }
            runStart = ref;
            prev = ref;
          }
        },
      };
    }

    return {
      featureProperties,
      pointBuffers,
      lineStringBuffers,
      polygonBuffers,
    };
  }

  /**
   * Update per-feature style data without regenerating geometry buffers.
   * This is used for fast updates when only feature properties change.
   * @param {Object} buffers Current buffers as returned by `generateBuffers()`.
   * @param {number} ref Feature ref (stable index).
   * @param {import("../../Feature.js").default|import("../../render/Feature.js").default} feature Feature.
   */
  updateFeatureStyles(buffers, ref, feature) {
    const device = this.helper_.getDevice();
    if (!device || !buffers || !ref) {
      return;
    }

    const pointBuffers = buffers.pointBuffers || [];
    for (const set of pointBuffers) {
      set.updateStyle?.(device, ref, feature);
    }

    const lineBuffers = buffers.lineStringBuffers || [];
    for (const set of lineBuffers) {
      set.updateStyle?.(device, ref, feature);
    }

    const polyBuffers = buffers.polygonBuffers || [];
    for (const set of polyBuffers) {
      set.updateStyle?.(device, ref, feature);
    }

    buffers.featureProperties?.update?.(device, ref, feature);
  }

  /**
   * Batch update per-feature style data without regenerating geometry buffers.
   * This reduces CPU overhead when many features change at once by coalescing
   * GPU writes for consecutive refs.
   * @param {Object} buffers Current buffers as returned by `generateBuffers()`.
   * @param {Map<number, import("../../Feature.js").default|import("../../render/Feature.js").default>} dirtyRefs Dirty refs.
   */
  updateFeatureStylesBatch(buffers, dirtyRefs) {
    const device = this.helper_.getDevice();
    if (!device || !buffers || !dirtyRefs || dirtyRefs.size === 0) {
      return;
    }

    const pointBuffers = buffers.pointBuffers || [];
    for (const set of pointBuffers) {
      set.updateStyleBatch?.(device, dirtyRefs);
      if (!set.updateStyleBatch && set.updateStyle) {
        for (const [ref, feature] of dirtyRefs) {
          set.updateStyle(device, ref, feature);
        }
      }
    }

    const lineBuffers = buffers.lineStringBuffers || [];
    for (const set of lineBuffers) {
      set.updateStyleBatch?.(device, dirtyRefs);
      if (!set.updateStyleBatch && set.updateStyle) {
        for (const [ref, feature] of dirtyRefs) {
          set.updateStyle(device, ref, feature);
        }
      }
    }

    const polyBuffers = buffers.polygonBuffers || [];
    for (const set of polyBuffers) {
      set.updateStyleBatch?.(device, dirtyRefs);
      if (!set.updateStyleBatch && set.updateStyle) {
        for (const [ref, feature] of dirtyRefs) {
          set.updateStyle(device, ref, feature);
        }
      }
    }

    buffers.featureProperties?.updateBatch?.(device, dirtyRefs);
    if (!buffers.featureProperties?.updateBatch && buffers.featureProperties?.update) {
      for (const [ref, feature] of dirtyRefs) {
        buffers.featureProperties.update(device, ref, feature);
      }
    }
  }

  /**
   * @param {GPUDevice} device Device.
   * @param {GPUTextureFormat} format Color format.
   * @param {number} widthPx Physical pixel width.
   * @param {number} heightPx Physical pixel height.
   * @return {GPUTextureView} Texture view.
   * @private
   */
  getOffscreenView_(device, format, widthPx, heightPx) {
    if (
      !this.offscreenTexture_ ||
      this.offscreenTextureSize_[0] !== widthPx ||
      this.offscreenTextureSize_[1] !== heightPx
    ) {
      if (this.offscreenTexture_) {
        this.offscreenTexture_.destroy();
      }
      this.offscreenTexture_ = device.createTexture({
        size: {width: widthPx, height: heightPx},
        format,
        usage: 0x10 | 0x04, // RENDER_ATTACHMENT | TEXTURE_BINDING
      });
      this.offscreenTextureSize_ = [widthPx, heightPx];
      this.offscreenTextureView_ = null;
    }
    if (!this.offscreenTextureView_) {
      this.offscreenTextureView_ = this.offscreenTexture_.createView();
    }
    return this.offscreenTextureView_;
  }

  /**
   * Composite an offscreen texture onto the swap chain with a single layer opacity.
   * This matches WebGL's layer opacity semantics (opacity applied after all layer draws).
   * @param {GPUDevice} device Device.
   * @param {GPUTextureView} srcView Source view.
   * @param {GPUTextureView} dstView Destination view.
   * @param {GPUTextureFormat} format Format.
   * @param {number} opacity Opacity in [0..1].
   * @param {GPUCommandEncoder} commandEncoder Encoder.
   * @param {boolean} [clearDst] Whether to clear the destination.
   * @private
   */
  compositeToView_(
    device,
    srcView,
    dstView,
    format,
    opacity,
    commandEncoder,
    clearDst = false,
  ) {
    if (!this.compositeSampler_) {
      this.compositeSampler_ = device.createSampler({
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        magFilter: 'nearest',
        minFilter: 'nearest',
      });
    }

    const uniformBuffer = this.getCompositeUniformBuffer_(device, opacity);

    if (
      this.compositePipeline_ &&
      this.compositePipelineFormat_ &&
      this.compositePipelineFormat_ !== format
    ) {
      this.compositePipeline_ = null;
      this.compositePipelineFormat_ = null;
      this.compositeBindGroupCache_ = new WeakMap();
    }

    if (!this.compositePipeline_) {
      const shader = `
        struct VertexOutput {
          @builtin(position) position : vec4f,
          @location(0) texCoord : vec2f,
        };

        struct Uniforms {
          opacity : f32,
          _pad0 : vec3f,
        };

        @group(0) @binding(0) var texSampler : sampler;
        @group(0) @binding(1) var tex : texture_2d<f32>;
        @group(0) @binding(2) var<uniform> uniforms : Uniforms;

        @vertex
        fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> VertexOutput {
          var output : VertexOutput;
          var positions = array<vec2f, 4>(
            vec2f(-1.0, -1.0),
            vec2f(1.0, -1.0),
            vec2f(-1.0, 1.0),
            vec2f(1.0, 1.0),
          );
          var uvs = array<vec2f, 4>(
            vec2f(0.0, 1.0),
            vec2f(1.0, 1.0),
            vec2f(0.0, 0.0),
            vec2f(1.0, 0.0),
          );
          output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
          output.texCoord = uvs[vertexIndex];
          return output;
        }

        @fragment
        fn fs_main(input : VertexOutput) -> @location(0) vec4f {
          let c = textureSampleLevel(tex, texSampler, input.texCoord, 0.0);
          return c * uniforms.opacity;
        }
      `;
      const module = device.createShaderModule({code: shader});
      this.compositePipeline_ = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vs_main',
        },
        fragment: {
          module,
          entryPoint: 'fs_main',
          targets: [
            {
              format,
              blend: {
                color: {
                  srcFactor: 'one',
                  dstFactor: 'one-minus-src-alpha',
                  operation: 'add',
                },
                alpha: {
                  srcFactor: 'one',
                  dstFactor: 'one-minus-src-alpha',
                  operation: 'add',
                },
              },
            },
          ],
        },
        primitive: {
          topology: 'triangle-strip',
        },
      });
      this.compositePipelineFormat_ = format;
    }

    let byUniform = this.compositeBindGroupCache_.get(srcView);
    if (!byUniform) {
      byUniform = new WeakMap();
      this.compositeBindGroupCache_.set(srcView, byUniform);
    }
    let bindGroup = byUniform.get(uniformBuffer);
    if (!bindGroup) {
      bindGroup = device.createBindGroup({
        layout: this.compositePipeline_.getBindGroupLayout(0),
        entries: [
          {binding: 0, resource: this.compositeSampler_},
          {binding: 1, resource: srcView},
          {binding: 2, resource: {buffer: uniformBuffer}},
        ],
      });
      byUniform.set(uniformBuffer, bindGroup);
    }

    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: dstView,
          clearValue: {r: 0.0, g: 0.0, b: 0.0, a: 0.0},
          loadOp: clearDst ? 'clear' : 'load',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.compositePipeline_);
    pass.setBindGroup(0, bindGroup);
    pass.draw(4);
    pass.end();
  }

  /**
   * @param {GPUDevice} device Device.
   * @param {number} opacity Opacity.
   * @return {GPUBuffer} Uniform buffer for composite pass.
   * @private
   */
  getCompositeUniformBuffer_(device, opacity) {
    // Uniform layout rules make the struct size 32 bytes:
    // opacity (4) + padding to 16 + vec3 (12) + struct padding to 32.
    const byteSize = 32;

    if (opacity === 1) {
      if (!this.compositeUniformBufferOne_) {
        this.compositeUniformBufferOne_ = device.createBuffer({
          size: byteSize,
          usage: 0x0040 | 0x0008, // UNIFORM | COPY_DST
        });
        device.queue.writeBuffer(
          this.compositeUniformBufferOne_,
          0,
          new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
        );
      }
      return this.compositeUniformBufferOne_;
    }

    if (!this.compositeUniformBufferOpacity_) {
      this.compositeUniformBufferOpacity_ = device.createBuffer({
        size: byteSize,
        usage: 0x0040 | 0x0008, // UNIFORM | COPY_DST
      });
    }
    device.queue.writeBuffer(
      this.compositeUniformBufferOpacity_,
      0,
      new Float32Array([opacity, 0, 0, 0, 0, 0, 0, 0]),
    );
    return this.compositeUniformBufferOpacity_;
  }

  /**
   * @param {Object} buffers Buffers.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {number} [worldOffsetX] World offset in map units (defaults to 0).
   * @param {number} [opacity] Layer opacity (defaults to 1).
   * @param {boolean} [isFirstWorld] Whether this is the first world pass.
   * @param {boolean} [isLastWorld] Whether this is the last world pass.
   * @param {boolean} [isFirstPass] Whether this is the first pass for the shared canvas.
   */
  render(
    buffers,
    frameState,
    worldOffsetX = 0,
    opacity = 1,
    isFirstWorld = true,
    isLastWorld = true,
    isFirstPass = false,
  ) {
    const device = this.helper_.getDevice();
    const context = this.helper_.getContext();

    if (!device || !context) {
      return;
    }

    this.syncVariables_(device);

    // --- Uniforms Calculation (World -> Clip) ---
    const size = frameState.size;
    const width = size[0];
    const height = size[1];
    const pixelRatio = frameState.pixelRatio;
    const rotation = frameState.viewState.rotation;
    const resolution = frameState.viewState.resolution;
    const zoom = frameState.viewState.zoom;
    const center = frameState.viewState.center;

    // 1. World -> Pixel
    const renderTransform = this.renderTransform_;
    resetTransform(renderTransform);
    translateTransform(renderTransform, width / 2, height / 2);
    scaleTransform(renderTransform, 1 / resolution, -1 / resolution);
    rotateTransform(renderTransform, -rotation);
    translateTransform(renderTransform, -center[0] + worldOffsetX, -center[1]);

    // 2. Pixel -> Clip
    // Scale (2/w, -2/h), Translate (-1, 1)
    const clipTransform = this.clipTransform_;
    resetTransform(clipTransform);
    translateTransform(clipTransform, -1, 1);
    scaleTransform(clipTransform, 2 / width, -2 / height);

    // 3. Combine: Clip * Render
    multiplyTransform(clipTransform, renderTransform);

    // 5. Update Uniform Buffer (re-done inside render to include resolution)
    if (!this.uniformBuffer_) {
      this.uniformBuffer_ = device.createBuffer({
        size: 112, // includes time (f32) + padding
        usage: 0x0040 | 0x0008, // UNIFORM | COPY_DST
      });
    }

    const commandEncoder = device.createCommandEncoder();

    const format = navigator.gpu.getPreferredCanvasFormat();
    const widthPx = Math.round(width * pixelRatio);
    const heightPx = Math.round(height * pixelRatio);
    const frameView = this.helper_.getFrameTextureView(
      frameState.index,
      format,
      widthPx,
      heightPx,
    );

    const useOffscreenComposite =
      Number.isFinite(opacity) && opacity >= 0 && opacity < 1;
    const geometryTargetView = useOffscreenComposite
      ? this.getOffscreenView_(device, format, widthPx, heightPx)
      : frameView;

    // If we are the first WebGPU layer in the frame, clear the persistent frame target.
    // This is needed even when the layer uses offscreen compositing (opacity < 1), because
    // the frame target will only be written to on the last world pass.
    if (useOffscreenComposite && isFirstPass && isFirstWorld) {
      const clearPass = commandEncoder.beginRenderPass({
        colorAttachments: [
          {
            view: frameView,
            clearValue: {r: 0.0, g: 0.0, b: 0.0, a: 0.0},
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      clearPass.end();
    }
    const renderPassDescriptor = {
      colorAttachments: [
        {
          view: geometryTargetView,
          clearValue: {r: 0.0, g: 0.0, b: 0.0, a: 0.0},
          loadOp: useOffscreenComposite
            ? isFirstWorld
              ? 'clear'
              : 'load'
            : isFirstPass && isFirstWorld
              ? 'clear'
              : 'load',
          storeOp: 'store',
        },
      ],
    };

    // Update Uniform Buffer with resolution
    if (this.uniformBuffer_) {
      const uniformData = this.uniformData_ || new Float32Array(28); // 112 bytes
      this.uniformData_ = uniformData;
      const mat4Data = this.clipMat4_;
      mat4FromTransform(mat4Data, clipTransform);
      uniformData.set(mat4Data);
      uniformData[16] = resolution;
      uniformData[17] = pixelRatio;
      uniformData[18] = width;
      uniformData[19] = height;
      uniformData[20] = rotation;
      uniformData[21] = zoom;
      uniformData[22] = 0;
      uniformData[23] = 0;
      const now =
        typeof frameState.time === 'number' ? frameState.time : Date.now();
      if (this.startTime_ === null) {
        this.startTime_ = now;
      }
      uniformData[24] = (now - this.startTime_) * 0.001;
      uniformData[25] = 0;
      uniformData[26] = 0;
      uniformData[27] = 0;
      device.queue.writeBuffer(this.uniformBuffer_, 0, uniformData);
    }

    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
    const bindGroupCache = this.getBindGroupCache_(buffers);

    // 1. Render Polygons (Draw first to be underneath)
    if (buffers.polygonBuffers) {
      for (const bufferSet of buffers.polygonBuffers) {
        const vertexBuffer = bufferSet.vertex.getBuffer();
        const styleBuffer = bufferSet.style.getBuffer();
        const count = vertexBuffer.size / 12;

        const fillCode = bufferSet.fillShader || this.defaultFillShader_;
        const pipeline = this.getPipeline_(
          this.fillPipelineCache_,
          format,
          fillCode,
          () => {
            const shaderModule = device.createShaderModule({code: fillCode});
            return device.createRenderPipeline({
              layout: 'auto',
              vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
                buffers: [
                  {
                    arrayStride: 12, // 3 floats
                    attributes: [
                      {
                        shaderLocation: 0,
                        offset: 0,
                        format: 'float32x2', // position
                      },
                      {
                        shaderLocation: 1,
                        offset: 8,
                        format: 'float32', // featureIndex
                      },
                    ],
                  },
                ],
              },
              fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [
                  {
                    format,
                    blend: {
                      color: {
                        srcFactor: 'one',
                        dstFactor: 'one-minus-src-alpha',
                        operation: 'add',
                      },
                      alpha: {
                        srcFactor: 'one',
                        dstFactor: 'one-minus-src-alpha',
                        operation: 'add',
                      },
                    },
                  },
                ],
              },
              primitive: {
                topology: 'triangle-list',
              },
            });
          },
        );

        const usesVars = bufferSet.usesVars ?? this.shaderUsesVars_(fillCode);
        const varsBuffer = usesVars ? this.getVariablesBuffer_(device) : null;
        const usesProps =
          bufferSet.usesProps ?? this.shaderUsesProps_(fillCode);
        const propsBuffer =
          buffers.featureProperties && usesProps
            ? buffers.featureProperties.buffer.getBuffer()
            : null;
        const patternSampler = bufferSet.pattern?.sampler || null;
        const patternView = bufferSet.pattern?.view || null;
        const bindGroup = this.getCachedBindGroup_(
          bindGroupCache,
          this.getObjectId_(pipeline),
          this.getObjectId_(styleBuffer),
          this.getObjectId_(this.uniformBuffer_),
          this.getObjectId_(patternSampler),
          this.getObjectId_(patternView),
          this.getObjectId_(varsBuffer),
          this.getObjectId_(propsBuffer),
          () =>
            device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [
                {
                  binding: 0,
                  resource: {
                    buffer: styleBuffer,
                  },
                },
                {
                  binding: 1,
                  resource: {
                    buffer: this.uniformBuffer_,
                  },
                },
                ...(bufferSet.pattern
                  ? [
                      {
                        binding: 2,
                        resource: bufferSet.pattern.sampler,
                      },
                      {
                        binding: 3,
                        resource: bufferSet.pattern.view,
                      },
                    ]
                  : []),
                ...(varsBuffer
                  ? [
                      {
                        binding: 4,
                        resource: {
                          buffer: varsBuffer,
                        },
                      },
                    ]
                  : []),
                ...(propsBuffer
                  ? [
                      {
                        binding: 5,
                        resource: {
                          buffer: propsBuffer,
                        },
                      },
                    ]
                  : []),
              ],
            }),
        );

        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.draw(count);
      }
    }

    // 2. Render Lines
    if (buffers.lineStringBuffers) {
      for (const bufferSet of buffers.lineStringBuffers) {
        const vertexBuffer = bufferSet.vertex.getBuffer();
        const styleBuffer = bufferSet.style.getBuffer();
        // 12 floats per instance (see generation above)
        const count = vertexBuffer.size / (12 * 4);

        const strokeCode = bufferSet.strokeShader || this.defaultStrokeShader_;
        const pipeline = this.getPipeline_(
          this.strokePipelineCache_,
          format,
          strokeCode,
          () => {
            const shaderModule = device.createShaderModule({code: strokeCode});
            return device.createRenderPipeline({
              layout: 'auto',
              vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
                buffers: [
                  {
                    arrayStride: 48, // 12 floats per instance
                    stepMode: 'instance',
                    attributes: [
                      {
                        shaderLocation: 0,
                        offset: 0,
                        format: 'float32x2', // segmentStart
                      },
                      {
                        shaderLocation: 1,
                        offset: 8,
                        format: 'float32', // measureStart
                      },
                      {
                        shaderLocation: 2,
                        offset: 12,
                        format: 'float32x2', // segmentEnd
                      },
                      {
                        shaderLocation: 3,
                        offset: 20,
                        format: 'float32', // measureEnd
                      },
                      {
                        shaderLocation: 4,
                        offset: 24,
                        format: 'float32x2', // joinAngles (start,end)
                      },
                      {
                        shaderLocation: 5,
                        offset: 32,
                        format: 'float32', // distanceLow
                      },
                      {
                        shaderLocation: 6,
                        offset: 36,
                        format: 'float32', // distanceHigh
                      },
                      {
                        shaderLocation: 7,
                        offset: 40,
                        format: 'float32', // angleTangentSum
                      },
                      {
                        shaderLocation: 8,
                        offset: 44,
                        format: 'float32', // featureIndex
                      },
                    ],
                  },
                ],
              },
              fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [
                  {
                    format,
                    blend: {
                      color: {
                        srcFactor: 'one',
                        dstFactor: 'one-minus-src-alpha',
                        operation: 'add',
                      },
                      alpha: {
                        srcFactor: 'one',
                        dstFactor: 'one-minus-src-alpha',
                        operation: 'add',
                      },
                    },
                  },
                ],
              },
              primitive: {
                topology: 'triangle-strip',
              },
            });
          },
        );

        const usesVars = bufferSet.usesVars ?? this.shaderUsesVars_(strokeCode);
        const varsBuffer = usesVars ? this.getVariablesBuffer_(device) : null;
        const usesProps =
          bufferSet.usesProps ?? this.shaderUsesProps_(strokeCode);
        const propsBuffer =
          buffers.featureProperties && usesProps
            ? buffers.featureProperties.buffer.getBuffer()
            : null;
        const patternSampler = bufferSet.pattern?.sampler || null;
        const patternView = bufferSet.pattern?.view || null;
        const bindGroup = this.getCachedBindGroup_(
          bindGroupCache,
          this.getObjectId_(pipeline),
          this.getObjectId_(styleBuffer),
          this.getObjectId_(this.uniformBuffer_),
          this.getObjectId_(patternSampler),
          this.getObjectId_(patternView),
          this.getObjectId_(varsBuffer),
          this.getObjectId_(propsBuffer),
          () =>
            device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [
                {
                  binding: 0,
                  resource: {
                    buffer: styleBuffer,
                  },
                },
                {
                  binding: 1,
                  resource: {
                    buffer: this.uniformBuffer_,
                  },
                },
                ...(bufferSet.pattern
                  ? [
                      {
                        binding: 2,
                        resource: bufferSet.pattern.sampler,
                      },
                      {
                        binding: 3,
                        resource: bufferSet.pattern.view,
                      },
                    ]
                  : []),
                ...(varsBuffer
                  ? [
                      {
                        binding: 4,
                        resource: {
                          buffer: varsBuffer,
                        },
                      },
                    ]
                  : []),
                ...(propsBuffer
                  ? [
                      {
                        binding: 5,
                        resource: {
                          buffer: propsBuffer,
                        },
                      },
                    ]
                  : []),
              ],
            }),
        );

        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.draw(4, count); // 4 vertices per instance (quad as triangle-strip)
      }
    }

    // 3. Render Points (Draw last to be on top)
    if (buffers.pointBuffers) {
      for (const bufferSet of buffers.pointBuffers) {
        const vertexBuffer = bufferSet.vertex.getBuffer();
        const styleBuffer = bufferSet.style.getBuffer();
        const instanceCount = vertexBuffer.size / 12;

        const symbolCode =
          bufferSet.symbolShader || this.defaultCircleSymbolShader_;
        const pipeline = this.getPipeline_(
          this.symbolPipelineCache_,
          format,
          symbolCode,
          () => {
            const shaderModule = device.createShaderModule({code: symbolCode});
            return device.createRenderPipeline({
              layout: 'auto',
              vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
                buffers: [
                  {
                    arrayStride: 12,
                    stepMode: 'instance',
                    attributes: [
                      {
                        shaderLocation: 0,
                        offset: 0,
                        format: 'float32x2',
                      },
                      {
                        shaderLocation: 1,
                        offset: 8,
                        format: 'float32',
                      },
                    ],
                  },
                ],
              },
              fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [
                  {
                    format,
                    blend: {
                      color: {
                        srcFactor: 'one',
                        dstFactor: 'one-minus-src-alpha',
                        operation: 'add',
                      },
                      alpha: {
                        srcFactor: 'one',
                        dstFactor: 'one-minus-src-alpha',
                        operation: 'add',
                      },
                    },
                  },
                ],
              },
              primitive: {
                topology: 'triangle-strip',
              },
            });
          },
        );

        const usesVars = bufferSet.usesVars ?? this.shaderUsesVars_(symbolCode);
        const varsBuffer = usesVars ? this.getVariablesBuffer_(device) : null;
        const usesProps =
          bufferSet.usesProps ?? this.shaderUsesProps_(symbolCode);
        const propsBuffer =
          buffers.featureProperties && usesProps
            ? buffers.featureProperties.buffer.getBuffer()
            : null;
        const patternSampler = bufferSet.pattern?.sampler || null;
        const patternView = bufferSet.pattern?.view || null;
        const bindGroup = this.getCachedBindGroup_(
          bindGroupCache,
          this.getObjectId_(pipeline),
          this.getObjectId_(styleBuffer),
          this.getObjectId_(this.uniformBuffer_),
          this.getObjectId_(patternSampler),
          this.getObjectId_(patternView),
          this.getObjectId_(varsBuffer),
          this.getObjectId_(propsBuffer),
          () =>
            device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [
                {
                  binding: 0,
                  resource: {
                    buffer: styleBuffer,
                  },
                },
                {
                  binding: 1,
                  resource: {
                    buffer: this.uniformBuffer_,
                  },
                },
                ...(bufferSet.pattern
                  ? [
                      {
                        binding: 2,
                        resource: bufferSet.pattern.sampler,
                      },
                      {
                        binding: 3,
                        resource: bufferSet.pattern.view,
                      },
                    ]
                  : []),
                ...(varsBuffer
                  ? [
                      {
                        binding: 4,
                        resource: {
                          buffer: varsBuffer,
                        },
                      },
                    ]
                  : []),
                ...(propsBuffer
                  ? [
                      {
                        binding: 5,
                        resource: {
                          buffer: propsBuffer,
                        },
                      },
                    ]
                  : []),
              ],
            }),
        );

        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.draw(4, instanceCount);
      }
    }

    passEncoder.end();

    if (useOffscreenComposite && isLastWorld) {
      // Composite pass applies layer opacity once, like WebGL.
      // Composite the layer's offscreen texture into the persistent frame texture.
      this.compositeToView_(
        device,
        geometryTargetView,
        frameView,
        format,
        opacity,
        commandEncoder,
        false,
      );
    }

    if (isLastWorld) {
      // Always blit the persistent frame texture to the swap chain so we don't
      // depend on swap chain content preservation across multiple layer submits.
      const swapChainView = this.helper_.getCurrentTextureView(
        frameState.index,
      );
      this.compositeToView_(
        device,
        frameView,
        swapChainView,
        format,
        1,
        commandEncoder,
        true,
      );
    }

    device.queue.submit([commandEncoder.finish()]);
  }
}

export default VectorStyleRenderer;
