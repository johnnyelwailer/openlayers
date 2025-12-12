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

      struct Style {
        // TODO: distinct structs for fill vs stroke
        // For now, assuming standard color at location 0
        color : vec4f, 
      };

      struct Uniforms {
        transform : mat4x4<f32>,
      };

      @group(0) @binding(0) var<storage, read> styles : array<Style>;
      @group(0) @binding(1) var<uniform> uniforms : Uniforms;

      @vertex
      fn vs_main(
        @location(0) position : vec2f,
        @location(1) featureIndex : f32
      ) -> VertexOutput {
        var output : VertexOutput;
        output.position = uniforms.transform * vec4f(position, 0.5, 1.0);
        
        let index = u32(featureIndex);
        let style = styles[index];
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
