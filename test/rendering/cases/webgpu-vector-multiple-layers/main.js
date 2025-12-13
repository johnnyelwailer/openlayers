import Feature from '../../../../src/ol/Feature.js';
import Map from '../../../../src/ol/Map.js';
import View from '../../../../src/ol/View.js';
import LineString from '../../../../src/ol/geom/LineString.js';
import Point from '../../../../src/ol/geom/Point.js';
import Polygon from '../../../../src/ol/geom/Polygon.js';
import WebGPUVectorLayer from '../../../../src/ol/layer/WebGPUVector.js';
import VectorSource from '../../../../src/ol/source/Vector.js';

const polygonLayer = new WebGPUVectorLayer({
  source: new VectorSource({
    features: [
      new Feature({
        geometry: new Polygon([
          [
            [-8e6, -5e6],
            [8e6, -5e6],
            [8e6, 5e6],
            [-8e6, 5e6],
            [-8e6, -5e6],
          ],
        ]),
      }),
    ],
  }),
  style: {
    'fill-color': 'rgba(220, 220, 220, 1)',
  },
});

const lineLayer = new WebGPUVectorLayer({
  source: new VectorSource({
    features: [
      new Feature({
        geometry: new LineString([
          [-7e6, -3e6],
          [0, 0],
          [7e6, 3e6],
        ]),
      }),
    ],
  }),
  style: {
    'stroke-color': 'rgba(0, 130, 255, 1)',
    'stroke-width': 16,
    'stroke-line-cap': 'round',
    'stroke-line-join': 'round',
  },
});

const pointLayer = new WebGPUVectorLayer({
  source: new VectorSource({
    features: [
      new Feature({geometry: new Point([-2e6, 1.5e6])}),
      new Feature({geometry: new Point([2e6, -1.5e6])}),
    ],
  }),
  style: {
    'circle-radius': 14,
    'circle-fill-color': 'rgba(0, 255, 0, 1)',
    'circle-stroke-color': 'rgba(0, 0, 0, 1)',
    'circle-stroke-width': 3,
  },
});

new Map({
  layers: [polygonLayer, lineLayer, pointLayer],
  target: 'map',
  view: new View({
    center: [0, 0],
    zoom: 0,
    rotation: -Math.PI / 10,
  }),
});

render({
  message: 'Multiple WebGPU vector layers render in correct order',
});
