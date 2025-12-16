import Feature from '../../../../src/ol/Feature.js';
import Map from '../../../../src/ol/Map.js';
import View from '../../../../src/ol/View.js';
import LineString from '../../../../src/ol/geom/LineString.js';
import WebGPUVectorLayer from '../../../../src/ol/layer/WebGPUVector.js';
import VectorSource from '../../../../src/ol/source/Vector.js';

const red = new Feature({
  geometry: new LineString([
    [-90, 40],
    [90, 40],
  ]),
  id: 1,
  c: 'rgb(255,0,0)',
});

const green = new Feature({
  geometry: new LineString([
    [-90, -40],
    [90, -40],
  ]),
  id: 2,
  c: 'rgb(0,255,0)',
});

const style = [
  {
    style: {
      'stroke-width': 14,
      'stroke-line-cap': 'butt',
      'stroke-line-join': 'miter',
      // Exercise WGSL `get()` with a color return type.
      'stroke-color': ['case', ['==', ['get', 'id'], 1], ['get', 'c'], 'black'],
    },
  },
];

const vector = new WebGPUVectorLayer({
  source: new VectorSource({
    features: [red, green],
  }),
  style,
});

new Map({
  layers: [vector],
  target: 'map',
  view: new View({
    center: [0, 0],
    resolution: 1,
    zoom: 1,
  }),
});

render({
  message: 'renders per-feature stroke colors via typed get() in WGSL',
});
