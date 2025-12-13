import Feature from '../../../../src/ol/Feature.js';
import Map from '../../../../src/ol/Map.js';
import View from '../../../../src/ol/View.js';
import Polygon from '../../../../src/ol/geom/Polygon.js';
import WebGPUVectorLayer from '../../../../src/ol/layer/WebGPUVector.js';
import VectorSource from '../../../../src/ol/source/Vector.js';

const bottom = new WebGPUVectorLayer({
  source: new VectorSource({
    features: [
      new Feature({
        geometry: new Polygon([
          [
            [-6e6, -6e6],
            [6e6, -6e6],
            [6e6, 6e6],
            [-6e6, 6e6],
            [-6e6, -6e6],
          ],
        ]),
      }),
    ],
  }),
  style: {
    'fill-color': 'rgba(0, 0, 255, 1)',
  },
});

const top = new WebGPUVectorLayer({
  opacity: 0.5,
  source: new VectorSource({
    features: [
      new Feature({
        geometry: new Polygon([
          [
            [-1e6, -4e6],
            [9e6, -4e6],
            [9e6, 4e6],
            [-1e6, 4e6],
            [-1e6, -4e6],
          ],
        ]),
      }),
    ],
  }),
  style: {
    'fill-color': 'rgba(255, 0, 0, 1)',
  },
});

new Map({
  layers: [bottom, top],
  target: 'map',
  view: new View({
    center: [0, 0],
    zoom: 0,
    rotation: Math.PI / 8,
  }),
});

render({
  message: 'WebGPU vector layer opacity affects compositing between layers',
});
