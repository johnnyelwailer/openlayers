import WebGPUVector from '../../../../src/ol/layer/WebGPUVector.js';
import VectorSource from '../../../../src/ol/source/Vector.js';
import expect from '../../expect.js';

describe('ol/layer/WebGPUVector.js', () => {
  describe('style validation', () => {
    it('throws for icon-src expressions', () => {
      const layer = new WebGPUVector({
        source: new VectorSource(),
        style: {'circle-radius': 1},
      });
      expect(() => {
        layer.setStyle({'icon-src': ['get', 'src']});
      }).to.throwException((e) => {
        expect(e.message).to.be(
          'WebGPU layers do not support expressions for the icon-src style property',
        );
      });
    });

    it('throws for fill-pattern-src expressions', () => {
      const layer = new WebGPUVector({
        source: new VectorSource(),
        style: {'circle-radius': 1},
      });
      expect(() => {
        layer.setStyle({'fill-pattern-src': ['var', 'pattern']});
      }).to.throwException((e) => {
        expect(e.message).to.be(
          'WebGPU layers do not support expressions for the fill-pattern-src style property',
        );
      });
    });

    it('throws for stroke-pattern-src expressions in rules', () => {
      const layer = new WebGPUVector({
        source: new VectorSource(),
        style: {'circle-radius': 1},
      });
      expect(() => {
        layer.setStyle([
          {
            style: {
              'stroke-color': [0, 0, 0, 1],
              'stroke-width': 2,
              'stroke-pattern-src': ['get', 'pattern'],
            },
          },
        ]);
      }).to.throwException((e) => {
        expect(e.message).to.be(
          'WebGPU layers do not support expressions for the stroke-pattern-src style property',
        );
      });
    });
  });
});
