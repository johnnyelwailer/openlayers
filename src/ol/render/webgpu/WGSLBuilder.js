/**
 * @module ol/render/webgpu/WGSLBuilder
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
   * @return {string} WGSL code.
   */
  getShader() {
    return `
      struct VertexOutput {
        @builtin(position) position : vec4f,
        @location(0) color : vec4f,
      };

      struct Style {
        fillColor : vec4f,
      };

      struct Uniforms {
        transform : mat4x4<f32>,
      };

      @group(0) @binding(0) var<storage, read> styles : array<Style>;
      @group(0) @binding(1) var<uniform> uniforms : Uniforms;

      @vertex
      fn vs_main(
        @location(0) position : vec2f,
        @location(1) featureIndex : f32 // WebGPU usually wants f32 for attributes unless specified as uint/sint format
      ) -> VertexOutput {
        var output : VertexOutput;
        output.position = uniforms.transform * vec4f(position, 0.5, 1.0);
        
        let index = u32(featureIndex);
        let style = styles[index];
        output.color = style.fillColor;
        
        return output;
      }

      @fragment
      fn fs_main(input : VertexOutput) -> @location(0) vec4f {
        return input.color;
      }
    `;
  }

  /**
   * Returns the fill vertex shader.
   * @return {string} WGSL code.
   */
  getFillVertexShader() {
    return this.getShader();
  }

  /**
   * Returns the fill fragment shader.
   * @return {string} WGSL code.
   */
  getFillFragmentShader() {
    return this.getShader();
  }

  getStrokeShader() {
    return `
      struct VertexOutput {
        @builtin(position) position : vec4f,
        @location(0) color : vec4f,
        @location(1) segmentStartPx : vec2f,
        @location(2) segmentEndPx : vec2f,
        @location(3) angleStart : f32,
        @location(4) angleEnd : f32,
        @location(5) width : f32,
        @location(6) distancePx : f32,
        @location(7) measureStart : f32,
        @location(8) measureEnd : f32,
        @location(9) capType : f32,
        @location(10) joinType : f32,
        @location(11) miterLimit : f32,
      };

      struct StrokeUniforms {
        transform : mat4x4<f32>,
        resolution : f32,
        pixelRatio : f32,
        viewportSizePx : vec2f,
      };

      struct Style {
        color : vec4f, 
        width : f32,
        capType : f32,
        joinType : f32,
        miterLimit : f32,
        offsetPx : f32,
        _pad : vec2f,
      };

      @group(0) @binding(0) var<storage, read> styles : array<Style>;
      @group(0) @binding(1) var<uniform> uniforms : StrokeUniforms;

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
        output.width = style.width;
        output.measureStart = measureStart;
        output.measureEnd = measureEnd;
        output.capType = style.capType;
        output.joinType = style.joinType;
        output.miterLimit = style.miterLimit;
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
          output.color = style.color;
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
          joinDirection * (style.width * 0.5 + 1.0);

        output.position = pxToScreen(positionPx);
        output.color = style.color;
        
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

      fn distanceFromSegment(point : vec2f, start : vec2f, end : vec2f) -> f32 {
        let tangent = end - start;
        let startToPoint = point - start;
        let h = clamp(dot(startToPoint, tangent) / dot(tangent, tangent), 0.0, 1.0);
        return length(startToPoint - tangent * h);
      }

      @fragment
      fn fs_main(input : VertexOutput) -> @location(0) vec4f {
        // Fragment builtin position is in physical pixels with top-left origin.
        // Convert to CSS pixels with bottom-left origin to match worldToPx().
        let currentPointPx = vec2f(
          input.position.x,
          uniforms.viewportSizePx.y * uniforms.pixelRatio - input.position.y,
        ) / uniforms.pixelRatio;

        let segmentStartDistance = computeSegmentPointDistance(
          currentPointPx,
          input.segmentStartPx,
          input.segmentEndPx,
          input.width,
          input.angleStart,
          input.capType,
          input.joinType,
          input.miterLimit,
        );
        let segmentEndDistance = computeSegmentPointDistance(
          currentPointPx,
          input.segmentEndPx,
          input.segmentStartPx,
          input.width,
          input.angleEnd,
          input.capType,
          input.joinType,
          input.miterLimit,
        );
        var distanceField = max(
          segmentDistanceField(currentPointPx, input.segmentStartPx, input.segmentEndPx, input.width),
          max(segmentStartDistance, segmentEndDistance),
        );

        var color = input.color;
        color.a = color.a * smoothstep(0.5, -0.5, distanceField);
        return color;
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
}
