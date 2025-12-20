import {
  generateLineInstanceAttributes,
  generatePolygonVertexData,
  packLineWork,
  packPolygonWork,
} from '../../../../../../src/ol/render/webgpu/vectorstylerenderer/geometry.js';
import expect from '../../../../expect.js';

describe('ol/render/webgpu/vectorstylerenderer/geometry', () => {
  describe('lines', () => {
    it('packs and generates one segment instance', () => {
      const lineEntries = [
        {
          ref: 7,
          flatCoordss: [
            // XYM stride = 3
            [0, 0, 0, 10, 0, 10],
          ],
        },
      ];

      const work = packLineWork(lineEntries);
      const out = generateLineInstanceAttributes(work);

      expect(out).to.be.a(Float32Array);
      expect(out.length).to.be(12);
      expect(out[0]).to.be(0); // x0
      expect(out[1]).to.be(0); // y0
      expect(out[2]).to.be(0); // m0
      expect(out[3]).to.be(10); // x1
      expect(out[4]).to.be(0); // y1
      expect(out[5]).to.be(10); // m1
      expect(out[11]).to.be(7); // featureIndex
    });

    it('generates multiple segment instances for a loop', () => {
      const lineEntries = [
        {
          ref: 3,
          flatCoordss: [
            // closes back to the first point
            [0, 0, 0, 10, 0, 10, 0, 0, 20],
          ],
        },
      ];

      const out = generateLineInstanceAttributes(packLineWork(lineEntries));
      expect(out.length).to.be(24); // 2 segments * 12 floats
      expect(out[11]).to.be(3);
      expect(out[23]).to.be(3);
    });
  });

  describe('polygons', () => {
    it('packs and triangulates a triangle polygon', () => {
      const polyEntries = [
        {
          ref: 2,
          flatCoordss: [[0, 0, 10, 0, 0, 10]],
          ringsVerticesCounts: [[3]],
        },
      ];

      const packed = packPolygonWork(polyEntries);
      const out = generatePolygonVertexData(
        packed.meta,
        packed.coords,
        packed.rings,
      );

      expect(out).to.be.a(Float32Array);
      expect(out.length).to.be(9); // 3 vertices * (x,y,ref)
      for (let i = 2; i < out.length; i += 3) {
        expect(out[i]).to.be(2);
      }

      const allowed = new Set(['0,0', '10,0', '0,10']);
      for (let i = 0; i < out.length; i += 3) {
        expect(allowed.has(`${out[i]},${out[i + 1]}`)).to.be(true);
      }
    });

    it('triangulates a polygon with a hole', () => {
      const polyEntries = [
        {
          ref: 9,
          flatCoordss: [
            [
              // outer ring (4 vertices)
              0, 0, 10, 0, 10, 10, 0, 10,
              // hole ring (4 vertices)
              2, 2, 8, 2, 8, 8, 2, 8,
            ],
          ],
          ringsVerticesCounts: [[4, 4]],
        },
      ];

      const packed = packPolygonWork(polyEntries);
      const out = generatePolygonVertexData(
        packed.meta,
        packed.coords,
        packed.rings,
      );

      expect(out.length).to.be.greaterThan(0);
      expect(out.length % 3).to.be(0);
      for (let i = 2; i < out.length; i += 3) {
        expect(out[i]).to.be(9);
      }
    });
  });
});
