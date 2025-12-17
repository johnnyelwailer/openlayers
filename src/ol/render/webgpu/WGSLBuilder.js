/**
 * @module ol/render/webgpu/WGSLBuilder
 */

/**
 * @typedef {Object} FillPatternShaderOptions
 * @property {string} textureSize WGSL `vec2f` expression for the full texture size in pixels.
 * @property {string} textureOffset WGSL `vec2f` expression for the sample offset in pixels.
 * @property {string} sampleSize WGSL `vec2f` expression for the sample size in pixels.
 * @property {string} tint WGSL `vec4f` expression for optional tint.
 */

/**
 * @typedef {Object} FillShaderOptions
 * @property {FillPatternShaderOptions} [pattern] Fill pattern sampling options.
 * @property {string} [fillColor] WGSL `vec4f` expression for the fill color.
 * @property {string} [discard] WGSL `bool` expression for fragment discard.
 */

/**
 * @typedef {Object} StrokePatternShaderOptions
 * @property {string} textureSize WGSL `vec2f` expression for the full texture size in pixels.
 * @property {string} textureOffset WGSL `vec2f` expression for the sample offset in pixels.
 * @property {string} sampleSize WGSL `vec2f` expression for the sample size in pixels.
 * @property {string} spacingPx WGSL `f32` expression for spacing in pixels.
 * @property {string} startOffsetPx WGSL `f32` expression for start offset in pixels.
 * @property {string} tint WGSL `vec4f` expression for optional tint.
 */

/**
 * @typedef {Object} StrokeShaderOptions
 * @property {string} [strokeColor] WGSL `vec4f` expression for the stroke color.
 * @property {string} [strokeWidth] WGSL `f32` expression for the stroke width.
 * @property {string} [discard] WGSL `bool` expression for fragment discard.
 * @property {StrokePatternShaderOptions} [pattern] Stroke pattern sampling options.
 */

/**
 * @typedef {Object} CircleSymbolShaderOptions
 * @property {string} [fillColor] WGSL `vec4f` expression for the circle fill color.
 * @property {string} [strokeColor] WGSL `vec4f` expression for the circle stroke color.
 * @property {string} [discard] WGSL `bool` expression for fragment discard.
 */

/**
 * @typedef {Object} ShapeSymbolShaderOptions
 * @property {string} [fillColor] WGSL `vec4f` expression for the shape fill color.
 * @property {string} [strokeColor] WGSL `vec4f` expression for the shape stroke color.
 * @property {string} [discard] WGSL `bool` expression for fragment discard.
 */

/**
 * @typedef {Object} IconSymbolShaderOptions
 * @property {string} [tint] WGSL `vec4f` expression for the icon tint.
 * @property {string} [discard] WGSL `bool` expression for fragment discard.
 */

/**
 * @classdesc
 * A builder class for generating WGSL shaders for WebGPU.
 * This mirrors the functionality of ShaderBuilder (GLSL) but for WGSL.
 */
export class WGSLBuilder {
  constructor() {
    /**
     * @type {string}
     * @private
     */
    this.fillColorExpression_ = 'vec4f(1.0, 1.0, 1.0, 1.0)';

    /**
     * @type {string}
     * @private
     */
    this.strokeColorExpression_ = 'vec4f(0.0, 0.0, 0.0, 1.0)';

    /**
     * @type {string}
     * @private
     */
    this.strokeWidthExpression_ = '1.0';
  }

  /**
   * @param {string} expression Fill color expression.
   * @return {WGSLBuilder} this.
   */
  setFillColorExpression(expression) {
    this.fillColorExpression_ = expression;
    return this;
  }

  /**
   * @return {string} The current fill color expression
   */
  getFillColorExpression() {
    return this.fillColorExpression_;
  }

  /**
   * @param {string} expression Stroke color expression.
   * @return {WGSLBuilder} this.
   */
  setStrokeColorExpression(expression) {
    this.strokeColorExpression_ = expression;
    return this;
  }

  /**
   * @param {string} expression Stroke width expression.
   * @return {WGSLBuilder} this.
   */
  setStrokeWidthExpression(expression) {
    this.strokeWidthExpression_ = expression;
    return this;
  }

  /**
   * Generates the WGSL code.
   * @param {FillShaderOptions} [options] Shader options.
   * @return {string} WGSL code.
   */
  getFillShader(options = {}) {
    const pattern = options.pattern;
    const fillColorExpr = options.fillColor || 'style.fillColor';
    const discardExpr = options.discard || 'false';
    const patternBindings = pattern
      ? `
      @group(0) @binding(2) var fillPatternSampler : sampler;
      @group(0) @binding(3) var fillPatternTexture : texture_2d<f32>;
      `
      : '';
    const patternFns = pattern
      ? `
      fn positiveMod2(x : vec2f, m : vec2f) -> vec2f {
        let r = x - floor(x / m) * m;
        return select(r, r + m, r < vec2f(0.0));
      }

      fn worldToPx(worldPos : vec2f) -> vec2f {
        let clip = uniforms.transform * vec4f(worldPos, 0.5, 1.0);
        let ndc = clip.xy / clip.w;
        return (0.5 * ndc + vec2f(0.5, 0.5)) * uniforms.viewportSizePx;
      }

      fn sampleFillPattern(
        texture : texture_2d<f32>,
        samp : sampler,
        textureSize : vec2f,
        textureOffset : vec2f,
        sampleSize : vec2f,
        pxOrigin : vec2f,
        pxPosition : vec2f,
      ) -> vec4f {
        // WebGL-equivalent scaleRatio, based on fractional zoom.
        let scaleRatio = pow(2.0, fract(uniforms.zoom + 0.5) - 0.5);
        var pxRelativePos = pxPosition - pxOrigin;
        let cosR = cos(uniforms.rotation);
        let sinR = sin(uniforms.rotation);
        pxRelativePos = vec2f(
          pxRelativePos.x * cosR - pxRelativePos.y * sinR,
          pxRelativePos.x * sinR + pxRelativePos.y * cosR,
        );

        // Sample position is computed according to the sample offset & size.
        var samplePos = positiveMod2(pxRelativePos / scaleRatio, sampleSize);
        // Avoid sampling too close to borders to avoid interpolation with outside pixels.
        samplePos = clamp(samplePos, vec2f(0.5), sampleSize - vec2f(0.5));
        // Invert y axis so that images appear upright.
        samplePos.y = sampleSize.y - samplePos.y;
        return textureSampleLevel(texture, samp, (samplePos + textureOffset) / textureSize, 0.0);
      }
      `
      : `
      fn worldToPx(worldPos : vec2f) -> vec2f {
        let clip = uniforms.transform * vec4f(worldPos, 0.5, 1.0);
        let ndc = clip.xy / clip.w;
        return (0.5 * ndc + vec2f(0.5, 0.5)) * uniforms.viewportSizePx;
      }
      `;

    return `
      struct VertexOutput {
        @builtin(position) position : vec4f,
        @location(0) color : vec4f,
        @location(1) @interpolate(flat) featureIndex : f32,
      };

      struct Style {
        fillColor : vec4f,
      };

      struct Uniforms {
        transform : mat4x4<f32>,
        resolution : f32,
        pixelRatio : f32,
        viewportSizePx : vec2f,
        rotation : f32,
        zoom : f32,
        padding : vec2f,
        time : f32,
      };

      @group(0) @binding(0) var<storage, read> styles : array<Style>;
      @group(0) @binding(1) var<uniform> uniforms : Uniforms;
      ${patternBindings}
      @group(0) @binding(4) var<storage, read> vars : array<vec4f>;
      @group(0) @binding(5) var<storage, read> props : array<vec4f>;
      ${patternFns}

      @vertex
      fn vs_main(
        @location(0) position : vec2f,
        @location(1) featureIndex : f32 // WebGPU usually wants f32 for attributes unless specified as uint/sint format
      ) -> VertexOutput {
        var output : VertexOutput;
        output.position = uniforms.transform * vec4f(position, 0.5, 1.0);
        
        let index = u32(featureIndex);
        let style = styles[index];
        // Ensure styles binding stays used even when fillColorExpr does not reference it.
        output.color = (${fillColorExpr} + style.fillColor * 0.0);
        output.featureIndex = featureIndex;
        
        return output;
      }

      @fragment
      fn fs_main(input : VertexOutput) -> @location(0) vec4f {
        if (${discardExpr}) {
          discard;
        }
        ${
          pattern
            ? `
        // Fragment builtin position is in physical pixels with top-left origin.
        // Convert to CSS pixels with bottom-left origin.
        let pxPos = vec2f(
          input.position.x,
          uniforms.viewportSizePx.y * uniforms.pixelRatio - input.position.y,
        ) / uniforms.pixelRatio;
        let pxOrigin = worldToPx(vec2f(0.0, 0.0));
        let c = sampleFillPattern(
          fillPatternTexture,
          fillPatternSampler,
          ${pattern.textureSize},
          ${pattern.textureOffset},
          ${pattern.sampleSize},
          pxOrigin,
          pxPos,
        );
        let outColor = ${pattern.tint} * c;
        return vec4f(outColor.rgb * outColor.a, outColor.a);
            `
            : `
        let outColor = input.color;
        return vec4f(outColor.rgb * outColor.a, outColor.a);
            `
        }
      }
    `;
  }

  /**
   * Returns the fill vertex shader.
   * @return {string} WGSL code.
   */
  getFillVertexShader() {
    return this.getFillShader();
  }

  /**
   * Returns the fill fragment shader.
   * @return {string} WGSL code.
   */
  getFillFragmentShader() {
    return this.getFillShader();
  }

  /**
   * @param {StrokeShaderOptions} [options] Shader options.
   * @return {string} WGSL code.
   */
  getStrokeShader(options = {}) {
    const strokeColorExpr = options.strokeColor || 'style.color';
    const strokeWidthExpr = options.strokeWidth || 'style.width';
    const discardExpr = options.discard || 'false';
    const pattern = options.pattern;
    const patternBindings = pattern
      ? `
      @group(0) @binding(2) var strokePatternSampler : sampler;
      @group(0) @binding(3) var strokePatternTexture : texture_2d<f32>;
      `
      : '';
    const patternFns = pattern
      ? `
      fn sampleStrokePattern(
        texture : texture_2d<f32>,
        samp : sampler,
        textureSize : vec2f,
        textureOffset : vec2f,
        sampleSize : vec2f,
        spacingPx : f32,
        startOffsetPx : f32,
        currentLengthPx : f32,
        currentRadiusRatio : f32,
        lineWidth : f32,
      ) -> vec4f {
        let safeWidth = max(lineWidth, 1.17549435e-38);
        let currentLengthScaled = (currentLengthPx - startOffsetPx) * sampleSize.y / safeWidth;
        let spacingScaled = spacingPx * sampleSize.y / safeWidth;
        var uCoordPx = positiveMod(currentLengthScaled, (sampleSize.x + spacingScaled));
        let isInsideOfPattern = select(0.0, 1.0, uCoordPx <= sampleSize.x);
        var vCoordPx = (-currentRadiusRatio * 0.5 + 0.5) * sampleSize.y;
        // Avoid sampling too close to borders.
        uCoordPx = clamp(uCoordPx, 0.5, sampleSize.x - 0.5);
        vCoordPx = clamp(vCoordPx, 0.5, sampleSize.y - 0.5);
        let texCoord = (vec2f(uCoordPx, vCoordPx) + textureOffset) / textureSize;
        var c = textureSampleLevel(texture, samp, texCoord, 0.0);
        c.a = c.a * isInsideOfPattern;
        return c;
      }
      `
      : '';
    const patternDistanceMod = pattern
      ? `
        let strokePatternLengthPx = (${pattern.sampleSize}.x / ${pattern.sampleSize}.y) * lineWidth + ${pattern.spacingPx};
        output.distancePx = positiveMod(output.distancePx, strokePatternLengthPx);
      `
      : '';
    return `
      struct VertexOutput {
        @builtin(position) position : vec4f,
        @location(0) segmentStartPx : vec2f,
        @location(1) segmentEndPx : vec2f,
        @location(2) @interpolate(flat) angleStart : f32,
        @location(3) @interpolate(flat) angleEnd : f32,
        @location(4) @interpolate(flat) distancePx : f32,
        @location(5) @interpolate(flat) measureStart : f32,
        @location(6) @interpolate(flat) measureEnd : f32,
        @location(7) @interpolate(flat) featureIndex : f32,
        @location(8) width : f32,
      };

      struct StrokeUniforms {
        transform : mat4x4<f32>,
        resolution : f32,
        pixelRatio : f32,
        viewportSizePx : vec2f,
        rotation : f32,
        zoom : f32,
        padding : vec2f,
        time : f32,
      };

      struct Style {
        color : vec4f, 
        width : f32,
        capType : f32,
        joinType : f32,
        miterLimit : f32,
        offsetPx : f32,
        dashCount : f32,
        dashOffset : f32,
        dashTotal : f32,
        _pad0 : f32,
        dash0 : vec4f,
        dash1 : vec4f,
        get0 : f32,
      };

      @group(0) @binding(0) var<storage, read> styles : array<Style>;
      @group(0) @binding(1) var<uniform> uniforms : StrokeUniforms;
      ${patternBindings}
      @group(0) @binding(4) var<storage, read> vars : array<vec4f>;
      @group(0) @binding(5) var<storage, read> props : array<vec4f>;

      const LINESTRING_ANGLE_COSINE_CUTOFF : f32 = 0.985;

      fn worldToPx(worldPos : vec2f) -> vec2f {
        let clip = uniforms.transform * vec4f(worldPos, 0.0, 1.0);
        return (0.5 * clip.xy + vec2f(0.5, 0.5)) * uniforms.viewportSizePx;
      }

      fn pxToScreen(pxPos : vec2f) -> vec4f {
        let screenPos = 2.0 * pxPos / uniforms.viewportSizePx - vec2f(1.0, 1.0);
        return vec4f(screenPos, 0.5, 1.0);
      }

      fn isCap(joinAngle : f32) -> bool {
        return joinAngle < -0.1;
      }

      fn getJoinOffsetDirection(normalPx : vec2f, joinAngle : f32) -> vec2f {
        let halfAngle = joinAngle * 0.5;
        let c = cos(halfAngle);
        let s = sin(halfAngle);
        let angleBisectorNormal = vec2f(s * normalPx.x + c * normalPx.y, -c * normalPx.x + s * normalPx.y);
        let invS = 1.0 / s;
        return angleBisectorNormal * invS;
      }

      fn getOffsetPoint(point : vec2f, normalPx : vec2f, joinAngle : f32, offsetPx : f32) -> vec2f {
        if (cos(joinAngle) > 0.998 || isCap(joinAngle)) {
          return point - normalPx * offsetPx;
        }
        return point - getJoinOffsetDirection(normalPx, joinAngle) * offsetPx;
      }

      @vertex
      fn vs_main(
        @builtin(vertex_index) vertexIdx : u32,
        @location(0) segmentStart : vec2f,
        @location(1) measureStart : f32,
        @location(2) segmentEnd : vec2f,
        @location(3) measureEnd : f32,
        @location(4) joinAngles : vec2f,
        @location(5) distanceLow : f32,
        @location(6) distanceHigh : f32,
        @location(7) angleTangentSum : f32,
        @location(8) featureIndex : f32
      ) -> VertexOutput {
        var output : VertexOutput;
        
        let index = u32(featureIndex);
        let style = styles[index];

        // Derive local position like the WebGL quad: x=-1(start)/+1(end), y=-1/+1 across width.
        var localPos : vec2f;
        if (vertexIdx == 0u) {
          localPos = vec2f(-1.0, -1.0);
        } else if (vertexIdx == 1u) {
          localPos = vec2f(-1.0, 1.0);
        } else if (vertexIdx == 2u) {
          localPos = vec2f(1.0, -1.0);
        } else {
          localPos = vec2f(1.0, 1.0);
        }

        output.angleStart = joinAngles.x;
        output.angleEnd = joinAngles.y;
        output.measureStart = measureStart;
        output.measureEnd = measureEnd;
        output.featureIndex = featureIndex;
        // Same behavior as WebGL: adjust dash/symbol distance when line is offset.
        output.distancePx =
          (distanceLow + distanceHigh) / uniforms.resolution -
          (style.offsetPx * angleTangentSum);

        // Compute segment start/end in pixel coordinates.
        var segmentStartPx = worldToPx(segmentStart);
        var segmentEndPx = worldToPx(segmentEnd);
        let diffPx = segmentEndPx - segmentStartPx;
        let segLenPx = length(diffPx);
        if (segLenPx == 0.0) {
          output.position = vec4f(0.0);
          return output;
        }
        let tangentPx = diffPx / segLenPx;
        let normalPx = vec2f(-tangentPx.y, tangentPx.x);

        // Apply stroke offset in pixel space (equivalent to WebGL).
        segmentStartPx = getOffsetPoint(segmentStartPx, normalPx, output.angleStart, style.offsetPx);
        segmentEndPx = getOffsetPoint(segmentEndPx, normalPx, output.angleEnd, style.offsetPx);
        output.segmentStartPx = segmentStartPx;
        output.segmentEndPx = segmentEndPx;

        let startEndRatio = localPos.x * 0.5 + 0.5;
        let lineMetric = mix(measureStart, measureEnd, startEndRatio);
        let lineWidth = max(0.0, (${strokeWidthExpr}));
        output.width = lineWidth;
        ${patternDistanceMod}
        let normalDir = -1.0 * localPos.y;
        let tangentDir = -1.0 * localPos.x;
        let angle = mix(output.angleStart, output.angleEnd, startEndRatio);

        var joinDirection : vec2f;
        if (cos(angle) > LINESTRING_ANGLE_COSINE_CUTOFF || isCap(angle)) {
          joinDirection = normalPx * normalDir - tangentPx * tangentDir;
        } else {
          joinDirection = getJoinOffsetDirection(normalPx * normalDir, angle);
        }

        // Add 1px fringe for antialiasing (WebGL behavior).
        let positionPx = mix(segmentStartPx, segmentEndPx, startEndRatio) +
          joinDirection * (lineWidth * 0.5 + 1.0);

        output.position = pxToScreen(positionPx);
        
        return output;
      }

      fn segmentDistanceField(point : vec2f, start : vec2f, end : vec2f, width : f32) -> f32 {
        let tangent = normalize(end - start);
        let normal = vec2f(-tangent.y, tangent.x);
        let startToPoint = point - start;
        return abs(dot(startToPoint, normal)) - width * 0.5;
      }

      fn buttCapDistanceField(point : vec2f, start : vec2f, end : vec2f) -> f32 {
        let startToPoint = point - start;
        let tangent = normalize(end - start);
        return dot(startToPoint, -tangent);
      }

      fn squareCapDistanceField(point : vec2f, start : vec2f, end : vec2f, width : f32) -> f32 {
        return buttCapDistanceField(point, start, end) - width * 0.5;
      }

      fn roundCapDistanceField(point : vec2f, start : vec2f, end : vec2f, width : f32) -> f32 {
        let onSegment = max(0.0, 1000.0 * dot(point - start, end - start));
        return length(point - start) - width * 0.5 - onSegment;
      }

      fn roundJoinDistanceField(point : vec2f, start : vec2f, end : vec2f, width : f32) -> f32 {
        return roundCapDistanceField(point, start, end, width);
      }

      fn bevelJoinField(point : vec2f, start : vec2f, end : vec2f, width : f32, joinAngle : f32) -> f32 {
        let startToPoint = point - start;
        let tangent = normalize(end - start);
        let c = cos(joinAngle * 0.5);
        let s = sin(joinAngle * 0.5);
        let direction = -sign(sin(joinAngle));
        let bisector = vec2f(c * tangent.x - s * tangent.y, s * tangent.x + c * tangent.y);
        let radius = width * 0.5 * s;
        return dot(startToPoint, bisector * direction) - radius;
      }

      fn capDistanceField(point : vec2f, start : vec2f, end : vec2f, width : f32, capType : f32) -> f32 {
        if (capType == 1.0) {
          return squareCapDistanceField(point, start, end, width);
        } else if (capType == 2.0) {
          return roundCapDistanceField(point, start, end, width);
        }
        return buttCapDistanceField(point, start, end);
      }

      fn joinDistanceField(point : vec2f, start : vec2f, end : vec2f, width : f32, joinAngle : f32, joinType : f32, miterLimit : f32) -> f32 {
        if (joinType == 1.0) {
          return bevelJoinField(point, start, end, width, joinAngle);
        } else if (joinType == 2.0) {
          return roundJoinDistanceField(point, start, end, width);
        }
        // miter join (default)
        if (cos(joinAngle) > LINESTRING_ANGLE_COSINE_CUTOFF) {
          return bevelJoinField(point, start, end, width, joinAngle);
        }
        let miterLength = 1.0 / sin(joinAngle * 0.5);
        if (miterLength > miterLimit) {
          return bevelJoinField(point, start, end, width, joinAngle);
        }
        return -1000.0;
      }

      fn computeSegmentPointDistance(point : vec2f, start : vec2f, end : vec2f, width : f32, joinAngle : f32, capType : f32, joinType : f32, miterLimit : f32) -> f32 {
        if (isCap(joinAngle)) {
          return capDistanceField(point, start, end, width, capType);
        }
        return joinDistanceField(point, start, end, width, joinAngle, joinType, miterLimit);
      }

      fn dashValue(d0 : vec4f, d1 : vec4f, idx : u32) -> f32 {
        if (idx < 4u) {
          return d0[idx];
        }
        return d1[idx - 4u];
      }

      fn positiveMod(x : f32, m : f32) -> f32 {
        let r = x - floor(x / m) * m;
        return r + select(0.0, m, r < 0.0);
      }
      ${patternFns}

      fn getSingleDashDistance(distance : f32, radius : f32, dashOffset : f32, dashLength : f32, dashLengthTotal : f32, capType : f32, lineWidth : f32) -> f32 {
        let localDistance = positiveMod(distance, dashLengthTotal);
        var distanceSegment = abs(localDistance - dashOffset - dashLength * 0.5) - dashLength * 0.5;
        distanceSegment = min(distanceSegment, dashLengthTotal - localDistance);
        if (capType == 1.0) {
          distanceSegment = distanceSegment - lineWidth * 0.5;
        } else if (capType == 2.0) {
          distanceSegment = min(
            distanceSegment,
            sqrt(distanceSegment * distanceSegment + radius * radius) - lineWidth * 0.5,
          );
        }
        return distanceSegment;
      }

      fn dashDistanceField(distance : f32, radius : f32, capType : f32, lineWidth : f32, dashCount : u32, dashTotal : f32, d0 : vec4f, d1 : vec4f) -> f32 {
        // dash pattern is [on0, off0, on1, off1, ...]; only "on" segments contribute.
        let safeTotal = max(dashTotal, 1.17549435e-38);
        var currentOffset = 0.0;
        var result = getSingleDashDistance(distance, radius, currentOffset, dashValue(d0, d1, 0u), safeTotal, capType, lineWidth);
        for (var i : u32 = 2u; i < 8u; i = i + 2u) {
          if (i >= dashCount) {
            break;
          }
          currentOffset = currentOffset + dashValue(d0, d1, i - 2u) + dashValue(d0, d1, i - 1u);
          let d = getSingleDashDistance(distance, radius, currentOffset, dashValue(d0, d1, i), safeTotal, capType, lineWidth);
          result = min(result, d);
        }
        return result;
      }

      fn distanceFromSegment(point : vec2f, start : vec2f, end : vec2f) -> f32 {
        let tangent = end - start;
        let startToPoint = point - start;
        let h = clamp(dot(startToPoint, tangent) / dot(tangent, tangent), 0.0, 1.0);
        return length(startToPoint - tangent * h);
      }

      @fragment
      fn fs_main(input : VertexOutput) -> @location(0) vec4f {
        let style = styles[u32(input.featureIndex)];
        // Fragment builtin position is in physical pixels with top-left origin.
        // Convert to CSS pixels with bottom-left origin to match worldToPx().
        let currentPointPx = vec2f(
          input.position.x,
          uniforms.viewportSizePx.y * uniforms.pixelRatio - input.position.y,
        ) / uniforms.pixelRatio;

        let segmentVec = input.segmentEndPx - input.segmentStartPx;
        let segmentLengthPx = length(segmentVec);
        let safeSegLen = max(segmentLengthPx, 1.17549435e-38);
        let segmentTangent = segmentVec / safeSegLen;
        let segmentNormal = vec2f(-segmentTangent.y, segmentTangent.x);
        let startToPointPx = currentPointPx - input.segmentStartPx;
        let lengthToPointPx = max(0.0, min(dot(segmentTangent, startToPointPx), segmentLengthPx));
        let lineMetric = mix(input.measureStart, input.measureEnd, lengthToPointPx / safeSegLen);
        let lineWidth = max(0.0, input.width);
        let currentLengthPx = lengthToPointPx + input.distancePx;
        let currentRadiusRatio = dot(segmentNormal, startToPointPx) * 2.0 / max(lineWidth, 1.17549435e-38);

        if (${discardExpr}) {
          discard;
        }

        let segmentStartDistance = computeSegmentPointDistance(
          currentPointPx,
          input.segmentStartPx,
          input.segmentEndPx,
          lineWidth,
          input.angleStart,
          style.capType,
          style.joinType,
          style.miterLimit,
        );
        let segmentEndDistance = computeSegmentPointDistance(
          currentPointPx,
          input.segmentEndPx,
          input.segmentStartPx,
          lineWidth,
          input.angleEnd,
          style.capType,
          style.joinType,
          style.miterLimit,
        );
        var distanceField = max(
          segmentDistanceField(
            currentPointPx,
            input.segmentStartPx,
            input.segmentEndPx,
            lineWidth,
          ),
          max(segmentStartDistance, segmentEndDistance),
        );

        // Dash distance field, integrated like WebGL (sharp/round dash caps based on capType).
        if (style.dashCount > 0.0 && style.dashTotal > 0.0) {
          let radius = distanceFromSegment(currentPointPx, input.segmentStartPx, input.segmentEndPx);
          let count = u32(min(style.dashCount, 8.0));
          let dashDf = dashDistanceField(
            currentLengthPx + style.dashOffset,
            radius,
            style.capType,
            lineWidth,
            count,
            style.dashTotal,
            style.dash0,
            style.dash1,
          );
          distanceField = max(distanceField, dashDf);
        }

        var color = ${
          pattern
            ? `${pattern.tint} * sampleStrokePattern(
            strokePatternTexture,
            strokePatternSampler,
            ${pattern.textureSize},
            ${pattern.textureOffset},
            ${pattern.sampleSize},
            ${pattern.spacingPx},
            ${pattern.startOffsetPx},
            currentLengthPx,
            currentRadiusRatio,
            lineWidth,
          )`
            : strokeColorExpr
        };
        color.a = color.a * smoothstep(0.5, -0.5, distanceField);
        return vec4f(color.rgb * color.a, color.a);
      }
      `;
  }

  getStrokeVertexShader() {
    return this.getStrokeShader();
  }

  getStrokeFragmentShader() {
    return this.getStrokeShader();
  }

  getSymbolVertexShader() {
    return null; // Placeholder
  }

  getSymbolFragmentShader() {
    return null; // Placeholder
  }

  /**
   * Returns a circle symbol shader (vertex + fragment in same module).
   * This mirrors WebGL's circle distance-field approach.
   * @param {CircleSymbolShaderOptions} [options] Shader options.
   * @return {string} WGSL code.
   */
  getCircleSymbolShader(options = {}) {
    const fillColorExpr = options.fillColor || 'style.fillColor';
    const strokeColorExpr = options.strokeColor || 'style.strokeColor';
    const discardExpr = options.discard || 'false';
    return `
      struct VertexOutput {
        @builtin(position) position : vec4f,
        @location(0) @interpolate(flat) featureIndex : f32,
        @location(1) @interpolate(flat) angle : f32,
        @location(2) @interpolate(flat) rotateWithView : f32,
        @location(3) @interpolate(flat) radius : f32,
        @location(4) @interpolate(flat) strokeWidth : f32,
        @location(5) @interpolate(flat) opacity : f32,
        @location(6) @interpolate(flat) scale : vec2f,
        @location(7) @interpolate(flat) fillColor : vec4f,
        @location(8) @interpolate(flat) strokeColor : vec4f,
        @location(9) @interpolate(flat) centerPx : vec2f,
      };

      struct Style {
        fillColor : vec4f,
        strokeColor : vec4f,
        radius : f32,
        strokeWidth : f32,
        opacity : f32,
        rotateWithView : f32,
        scale : vec2f,
        rotation : f32,
        _pad0 : f32,
        displacement : vec2f,
        _pad1 : vec2f,
      };

      struct Uniforms {
        transform : mat4x4<f32>,
        resolution : f32,
        pixelRatio : f32,
        viewportSizePx : vec2f,
        rotation : f32,
        zoom : f32,
        padding : vec2f,
        time : f32,
      };

      @group(0) @binding(0) var<storage, read> styles : array<Style>;
      @group(0) @binding(1) var<uniform> uniforms : Uniforms;
      @group(0) @binding(4) var<storage, read> vars : array<vec4f>;
      @group(0) @binding(5) var<storage, read> props : array<vec4f>;

      fn localPosition(vertexIndex : u32) -> vec2f {
        // triangle-strip order: (-1,-1), (1,-1), (-1,1), (1,1)
        if (vertexIndex == 0u) { return vec2f(-1.0, -1.0); }
        if (vertexIndex == 1u) { return vec2f(1.0, -1.0); }
        if (vertexIndex == 2u) { return vec2f(-1.0, 1.0); }
        return vec2f(1.0, 1.0);
      }

      fn pxToScreen(offsetPx : vec2f) -> vec2f {
        return offsetPx / uniforms.viewportSizePx * 2.0;
      }

      fn screenToPx(coordScreen : vec2f) -> vec2f {
        return (coordScreen * 0.5 + 0.5) * uniforms.viewportSizePx;
      }

      fn circleDistanceField(point : vec2f, radius : f32) -> f32 {
        return length(point) - radius;
      }

      fn colorFromDistanceField(distanceField : f32, fillColor : vec4f, strokeColor : vec4f, strokeWidth : f32) -> vec4f {
        var color = fillColor;
        if (strokeWidth > 0.0) {
          let strokeFillRatio = smoothstep(-strokeWidth + 0.63, -strokeWidth - 0.58, distanceField);
          color = mix(strokeColor, color, strokeFillRatio);
        }
        let shapeOpacity = 1.0 - smoothstep(-0.63, 0.58, distanceField);
        return color * vec4f(1.0, 1.0, 1.0, shapeOpacity);
      }

      @vertex
      fn vs_main(
        @builtin(vertex_index) vertexIndex : u32,
        @location(0) position : vec2f,
        @location(1) featureIndex : f32,
      ) -> VertexOutput {
        var output : VertexOutput;
        let style = styles[u32(featureIndex)];

        let quadSizePx = (vec2f(style.radius * 2.0 + 0.5) + vec2f(style.strokeWidth)) * style.scale;
        let halfSizePx = quadSizePx * 0.5;

        var offsetPx = style.displacement + localPosition(vertexIndex) * halfSizePx * vec2f(1.0, -1.0);
        let angle = style.rotation + select(0.0, uniforms.rotation, style.rotateWithView > 0.5);
        let c = cos(-angle);
        let s = sin(-angle);
        offsetPx = vec2f(c * offsetPx.x - s * offsetPx.y, s * offsetPx.x + c * offsetPx.y);

        let center = uniforms.transform * vec4f(position, 0.5, 1.0);
        output.position = center + vec4f(pxToScreen(offsetPx), 0.0, 0.0);
        output.featureIndex = featureIndex;
        output.angle = angle;
        output.rotateWithView = style.rotateWithView;
        output.radius = style.radius;
        output.strokeWidth = style.strokeWidth;
        output.opacity = style.opacity;
        output.scale = style.scale;
        output.fillColor = ${fillColorExpr};
        output.strokeColor = ${strokeColorExpr};

        // Center in CSS pixels (bottom-left origin), used in fragment to compute coordsPx.
        var centerOffsetPx = style.displacement;
        let c2 = cos(-angle);
        let s2 = sin(-angle);
        centerOffsetPx = vec2f(c2 * centerOffsetPx.x - s2 * centerOffsetPx.y, s2 * centerOffsetPx.x + c2 * centerOffsetPx.y);
        output.centerPx = screenToPx(center.xy) + centerOffsetPx;
        return output;
      }

      @fragment
      fn fs_main(input : VertexOutput) -> @location(0) vec4f {
        if (${discardExpr}) {
          discard;
        }
        // Convert from physical pixels with top-left origin to CSS pixels with bottom-left origin.
        var coordsPx = vec2f(
          input.position.x,
          uniforms.viewportSizePx.y * uniforms.pixelRatio - input.position.y,
        ) / uniforms.pixelRatio - input.centerPx;

        let c = cos(input.angle);
        let s = sin(input.angle);
        coordsPx = vec2f(c * coordsPx.x - s * coordsPx.y, s * coordsPx.x + c * coordsPx.y);

        let safeScale = max(input.scale, vec2f(1.17549435e-38));
        // Match WebGL: radius is expanded by half the stroke width.
        let df = circleDistanceField(
          coordsPx / safeScale,
          input.radius + input.strokeWidth * 0.5,
        );

        var color = colorFromDistanceField(df, input.fillColor, input.strokeColor, input.strokeWidth);
        color.a = color.a * input.opacity;
        return vec4f(color.rgb * color.a, color.a);
      }
    `;
  }

  /**
   * Returns an icon symbol shader (vertex + fragment in same module).
   * @param {IconSymbolShaderOptions} [options] Shader options.
   * @return {string} WGSL code.
   */
  getIconSymbolShader(options = {}) {
    const tintExpr = options.tint || 'style.tint';
    const discardExpr = options.discard || 'false';
    return `
      struct VertexOutput {
        @builtin(position) position : vec4f,
        @location(0) texCoord : vec2f,
        @location(1) @interpolate(flat) tint : vec4f,
        @location(2) @interpolate(flat) opacity : f32,
        @location(3) @interpolate(flat) featureIndex : f32,
      };

      struct Style {
        tint : vec4f,
        uvOrigin : vec2f,
        uvSize : vec2f,
        sizePx : vec2f,
        scale : vec2f,
        rotation : f32,
        opacity : f32,
        rotateWithView : f32,
        _pad0 : f32,
        offsetPx : vec2f,
        _pad1 : vec2f,
      };

      struct Uniforms {
        transform : mat4x4<f32>,
        resolution : f32,
        pixelRatio : f32,
        viewportSizePx : vec2f,
        rotation : f32,
        zoom : f32,
        padding : vec2f,
        time : f32,
      };

      @group(0) @binding(0) var<storage, read> styles : array<Style>;
      @group(0) @binding(1) var<uniform> uniforms : Uniforms;
      @group(0) @binding(2) var iconSampler : sampler;
      @group(0) @binding(3) var iconTexture : texture_2d<f32>;
      @group(0) @binding(4) var<storage, read> vars : array<vec4f>;
      @group(0) @binding(5) var<storage, read> props : array<vec4f>;

      fn localPosition(vertexIndex : u32) -> vec2f {
        if (vertexIndex == 0u) { return vec2f(-1.0, -1.0); }
        if (vertexIndex == 1u) { return vec2f(1.0, -1.0); }
        if (vertexIndex == 2u) { return vec2f(-1.0, 1.0); }
        return vec2f(1.0, 1.0);
      }

      fn pxToScreen(offsetPx : vec2f) -> vec2f {
        return offsetPx / uniforms.viewportSizePx * 2.0;
      }

      @vertex
      fn vs_main(
        @builtin(vertex_index) vertexIndex : u32,
        @location(0) position : vec2f,
        @location(1) featureIndex : f32,
      ) -> VertexOutput {
        var output : VertexOutput;
        let style = styles[u32(featureIndex)];

        let quadSizePx = style.sizePx * style.scale;
        let halfSizePx = quadSizePx * 0.5;
        var offsetPx = style.offsetPx + localPosition(vertexIndex) * halfSizePx * vec2f(1.0, -1.0);
        let angle = style.rotation + select(0.0, uniforms.rotation, style.rotateWithView > 0.5);
        let c = cos(-angle);
        let s = sin(-angle);
        offsetPx = vec2f(c * offsetPx.x - s * offsetPx.y, s * offsetPx.x + c * offsetPx.y);

        let center = uniforms.transform * vec4f(position, 0.5, 1.0);
        output.position = center + vec4f(pxToScreen(offsetPx), 0.0, 0.0);

        let l = localPosition(vertexIndex) * 0.5 + vec2f(0.5, 0.5);
        let u = style.uvOrigin.x + l.x * style.uvSize.x;
        // WebGPU texture coordinates use a top-left origin, matching DOM image sources.
        let v = style.uvOrigin.y + l.y * style.uvSize.y;
        output.texCoord = vec2f(u, v);
        output.tint = ${tintExpr};
        output.opacity = style.opacity;
        output.featureIndex = featureIndex;
        return output;
      }

      @fragment
      fn fs_main(input : VertexOutput) -> @location(0) vec4f {
        if (${discardExpr}) {
          discard;
        }
        var color = input.tint * textureSampleLevel(iconTexture, iconSampler, input.texCoord, 0.0);
        color.a = color.a * input.opacity;
        return vec4f(color.rgb * color.a, color.a);
      }
    `;
  }

  /**
   * Returns a regular shape / star symbol shader (vertex + fragment in same module).
   * @param {ShapeSymbolShaderOptions} [options] Shader options.
   * @return {string} WGSL code.
   */
  getShapeSymbolShader(options = {}) {
    const fillColorExpr = options.fillColor || 'style.fillColor';
    const strokeColorExpr = options.strokeColor || 'style.strokeColor';
    const discardExpr = options.discard || 'false';
    return `
      struct VertexOutput {
        @builtin(position) position : vec4f,
        @location(0) @interpolate(flat) featureIndex : f32,
        @location(1) @interpolate(flat) angle : f32,
        @location(2) @interpolate(flat) radius : f32,
        @location(3) @interpolate(flat) radius2 : f32,
        @location(4) @interpolate(flat) strokeWidth : f32,
        @location(5) @interpolate(flat) opacity : f32,
        @location(6) @interpolate(flat) points : f32,
        @location(7) @interpolate(flat) shapeAngle : f32,
        @location(8) @interpolate(flat) scale : vec2f,
        @location(9) @interpolate(flat) fillColor : vec4f,
        @location(10) @interpolate(flat) strokeColor : vec4f,
        @location(11) @interpolate(flat) centerPx : vec2f,
      };

      struct Style {
        fillColor : vec4f,
        strokeColor : vec4f,
        radius : f32,
        radius2 : f32,
        strokeWidth : f32,
        opacity : f32,
        points : f32,
        shapeAngle : f32,
        rotateWithView : f32,
        rotation : f32,
        scale : vec2f,
        displacement : vec2f,
      };

      struct Uniforms {
        transform : mat4x4<f32>,
        resolution : f32,
        pixelRatio : f32,
        viewportSizePx : vec2f,
        rotation : f32,
        zoom : f32,
        padding : vec2f,
        time : f32,
      };

      @group(0) @binding(0) var<storage, read> styles : array<Style>;
      @group(0) @binding(1) var<uniform> uniforms : Uniforms;
      @group(0) @binding(4) var<storage, read> vars : array<vec4f>;
      @group(0) @binding(5) var<storage, read> props : array<vec4f>;

      fn localPosition(vertexIndex : u32) -> vec2f {
        if (vertexIndex == 0u) { return vec2f(-1.0, -1.0); }
        if (vertexIndex == 1u) { return vec2f(1.0, -1.0); }
        if (vertexIndex == 2u) { return vec2f(-1.0, 1.0); }
        return vec2f(1.0, 1.0);
      }

      fn pxToScreen(offsetPx : vec2f) -> vec2f {
        return offsetPx / uniforms.viewportSizePx * 2.0;
      }

      fn screenToPx(coordScreen : vec2f) -> vec2f {
        return (coordScreen * 0.5 + 0.5) * uniforms.viewportSizePx;
      }

      fn roundf(v : f32) -> f32 {
        return sign(v) * floor(abs(v) + 0.5);
      }

      fn starDistanceField(point : vec2f, numPoints : f32, radius : f32, radius2 : f32, angle : f32) -> f32 {
        let startAngle = -3.141592653589793 * 0.5 + angle;
        var c = cos(startAngle);
        var s = sin(startAngle);
        let pointRotated = vec2f(c * point.x - s * point.y, s * point.x + c * point.y);
        let alpha = 6.283185307179586 / numPoints;
        let beta = atan2(pointRotated.y, pointRotated.x);
        let gamma = roundf(beta / alpha) * alpha;
        c = cos(-gamma);
        s = sin(-gamma);
        let inSector = vec2f(c * pointRotated.x - s * pointRotated.y, abs(s * pointRotated.x + c * pointRotated.y));
        let tipToPoint = inSector + vec2f(-radius, 0.0);
        let edgeNormal = vec2f(radius2 * sin(alpha * 0.5), -radius2 * cos(alpha * 0.5) + radius);
        return dot(normalize(edgeNormal), tipToPoint);
      }

      fn regularDistanceField(point : vec2f, numPoints : f32, radius : f32, angle : f32) -> f32 {
        let startAngle = -3.141592653589793 * 0.5 + angle;
        var c = cos(startAngle);
        var s = sin(startAngle);
        let pointRotated = vec2f(c * point.x - s * point.y, s * point.x + c * point.y);
        let alpha = 6.283185307179586 / numPoints;
        let radiusIn = radius * cos(3.141592653589793 / numPoints);
        let beta = atan2(pointRotated.y, pointRotated.x);
        let gamma = roundf((beta - alpha * 0.5) / alpha) * alpha + alpha * 0.5;
        c = cos(-gamma);
        s = sin(-gamma);
        let inSector = vec2f(c * pointRotated.x - s * pointRotated.y, abs(s * pointRotated.x + c * pointRotated.y));
        return inSector.x - radiusIn;
      }

      fn colorFromDistanceField(distanceField : f32, fillColor : vec4f, strokeColor : vec4f, strokeWidth : f32) -> vec4f {
        var color = fillColor;
        if (strokeWidth > 0.0) {
          let strokeFillRatio = smoothstep(-strokeWidth + 0.63, -strokeWidth - 0.58, distanceField);
          color = mix(strokeColor, color, strokeFillRatio);
        }
        let shapeOpacity = 1.0 - smoothstep(-0.63, 0.58, distanceField);
        return color * vec4f(1.0, 1.0, 1.0, shapeOpacity);
      }

      @vertex
      fn vs_main(
        @builtin(vertex_index) vertexIndex : u32,
        @location(0) position : vec2f,
        @location(1) featureIndex : f32,
      ) -> VertexOutput {
        var output : VertexOutput;
        let style = styles[u32(featureIndex)];

        let maxR = max(style.radius, select(style.radius, style.radius2, style.radius2 > 0.0));
        let quadSizePx = vec2f(maxR * 2.0 + 0.5) * style.scale;
        let halfSizePx = quadSizePx * 0.5;

        var offsetPx = style.displacement + localPosition(vertexIndex) * halfSizePx * vec2f(1.0, -1.0);
        let angle = style.rotation + select(0.0, uniforms.rotation, style.rotateWithView > 0.5);
        let c = cos(-angle);
        let s = sin(-angle);
        offsetPx = vec2f(c * offsetPx.x - s * offsetPx.y, s * offsetPx.x + c * offsetPx.y);

        let center = uniforms.transform * vec4f(position, 0.5, 1.0);
        output.position = center + vec4f(pxToScreen(offsetPx), 0.0, 0.0);
        output.featureIndex = featureIndex;
        output.angle = angle;
        output.radius = style.radius;
        output.radius2 = style.radius2;
        output.strokeWidth = style.strokeWidth;
        output.opacity = style.opacity;
        output.points = style.points;
        output.shapeAngle = style.shapeAngle;
        output.scale = style.scale;
        output.fillColor = ${fillColorExpr};
        output.strokeColor = ${strokeColorExpr};

        var centerOffsetPx = style.displacement;
        let c2 = cos(-angle);
        let s2 = sin(-angle);
        centerOffsetPx = vec2f(c2 * centerOffsetPx.x - s2 * centerOffsetPx.y, s2 * centerOffsetPx.x + c2 * centerOffsetPx.y);
        output.centerPx = screenToPx(center.xy) + centerOffsetPx;
        return output;
      }

      @fragment
      fn fs_main(input : VertexOutput) -> @location(0) vec4f {
        if (${discardExpr}) {
          discard;
        }
        var coordsPx = vec2f(
          input.position.x,
          uniforms.viewportSizePx.y * uniforms.pixelRatio - input.position.y,
        ) / uniforms.pixelRatio - input.centerPx;

        let c = cos(input.angle);
        let s = sin(input.angle);
        coordsPx = vec2f(c * coordsPx.x - s * coordsPx.y, s * coordsPx.x + c * coordsPx.y);

        let safeScale = max(input.scale, vec2f(1.17549435e-38));
        let p = coordsPx / safeScale;

        let df = select(
          regularDistanceField(p, input.points, input.radius, input.shapeAngle),
          starDistanceField(p, input.points, input.radius, input.radius2, input.shapeAngle),
          input.radius2 > 0.0,
        );

        var color = colorFromDistanceField(df, input.fillColor, input.strokeColor, input.strokeWidth);
        color.a = color.a * input.opacity;
        return vec4f(color.rgb * color.a, color.a);
      }
    `;
  }
}
