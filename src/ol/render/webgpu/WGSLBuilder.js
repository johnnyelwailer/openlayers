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
      };

      struct StrokeUniforms {
        transform : mat4x4<f32>,
        resolution : f32,
      };

      struct Style {
        color : vec4f, 
        width : f32,
      };

      @group(0) @binding(0) var<storage, read> styles : array<Style>;
      @group(0) @binding(1) var<uniform> uniforms : StrokeUniforms;

      @vertex
      fn vs_main(
        @builtin(vertex_index) vertexIdx : u32,
        @location(0) p1 : vec2f,
        @location(1) p2 : vec2f,
        @location(2) featureIndex : f32
      ) -> VertexOutput {
        var output : VertexOutput;
        
        let index = u32(featureIndex);
        let style = styles[index];

        // Line Direction & Normal
        let diff = p2 - p1;
        let len = length(diff);
        if (len == 0.0) {
           output.position = vec4f(0.0);
           return output;
        }
        let normal = normalize(vec2f(-diff.y, diff.x));

        // Expansion (in world units)
        // width (px) * resolution (world/px) = width (world)
        // Half width for offset
        let halfWidth = (style.width * uniforms.resolution) * 0.5;
        let offset = normal * halfWidth;

        var pos : vec2f;
        // Vertex 0: P1 + offset
        // Vertex 1: P1 - offset
        // Vertex 2: P2 - offset
        // Vertex 3: P2 + offset
        // Topology: Triangle Strip: 0, 1, 3, 2 ? No, let's look at index
        // Using triangle-strip with 4 vertices:
        // 0: P1 + off
        // 1: P1 - off
        // 2: P2 + off
        // 3: P2 - off
        
        // Map vertexIdx (0..3) to offsets
        // 0: P1, +1
        // 1: P1, -1
        // 2: P2, +1
        // 3: P2, -1
        
        if (vertexIdx == 0u) {
          pos = p1 + offset;
        } else if (vertexIdx == 1u) {
          pos = p1 - offset;
        } else if (vertexIdx == 2u) {
          pos = p2 + offset;
        } else {
          pos = p2 - offset;
        }

        output.position = uniforms.transform * vec4f(pos, 0.5, 1.0);
        output.color = style.color;
        
        return output;
      }

      @fragment
      fn fs_main(input : VertexOutput) -> @location(0) vec4f {
        return input.color;
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
