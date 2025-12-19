import {WGSLBuilder} from '../../../../../src/ol/render/webgpu/WGSLBuilder.js';
import expect from '../../../expect.js';

describe('ol/render/webgpu/WGSLBuilder', () => {
  it('adds tile mask bindings and uses padding for tile params', () => {
    const builder = new WGSLBuilder();

    const shaders = [
      builder.getFillShader({tileMask: true}),
      builder.getStrokeShader({tileMask: true}),
      builder.getCircleSymbolShader({tileMask: true}),
      builder.getIconSymbolShader({tileMask: true}),
      builder.getShapeSymbolShader({tileMask: true}),
    ];

    for (const code of shaders) {
      expect(code).to.contain('@binding(6)');
      expect(code).to.contain('@binding(7)');
      expect(code).to.contain('tileMaskTexture');
      expect(code).to.contain('uniforms.padding.x');
      expect(code).to.contain('uniforms.padding.y');
    }
  });
});
