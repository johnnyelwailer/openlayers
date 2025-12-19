import Map from '../src/ol/Map.js';
import View from '../src/ol/View.js';
import MVT from '../src/ol/format/MVT.js';
import WebGPUVectorTileLayer from '../src/ol/layer/WebGPUVectorTile.js';
import VectorTileSource from '../src/ol/source/VectorTile.js';

const key =
  'pk.eyJ1IjoiYWhvY2V2YXIiLCJhIjoiY2t0cGdwMHVnMGdlbzMxbDhwazBic2xrNSJ9.WbcTL9uj8JPAsnT9mgb7oQ';

const style = [
  {
    filter: [
      'all',
      ['==', ['get', 'layer'], 'landuse'],
      ['==', ['get', 'class'], 'park'],
    ],
    style: {
      'fill-color': '#d8e8c8',
    },
  },
  {
    filter: ['==', ['get', 'layer'], 'water'],
    style: {
      'fill-color': '#a0c8f0',
    },
  },
  {
    filter: ['==', ['get', 'layer'], 'building'],
    style: {
      'fill-color': '#f2eae2',
      'stroke-color': '#dfdbd7',
      'stroke-width': 1,
    },
  },
  {
    filter: ['==', ['get', 'layer'], 'road'],
    style: {
      'stroke-color': '#cfcdca',
      'stroke-width': 1,
    },
  },
  {
    filter: ['==', ['get', 'layer'], 'place_label'],
    style: {
      'circle-radius': 3,
      'circle-fill-color': '#707070',
    },
  },
];

new Map({
  layers: [
    new WebGPUVectorTileLayer({
      source: new VectorTileSource({
        format: new MVT(),
        url:
          'https://api.mapbox.com/v4/mapbox.mapbox-streets-v6/{z}/{x}/{y}.vector.pbf?access_token=' +
          key,
        transition: 0,
      }),
      style,
    }),
  ],
  target: 'map',
  view: new View({
    center: [-12936956, 4027158],
    zoom: 14,
  }),
});
