import Map from '../src/ol/Map.js';
import View from '../src/ol/View.js';
import GeoJSON from '../src/ol/format/GeoJSON.js';
import TileLayer from '../src/ol/layer/Tile.js';
import WebGPUVectorLayer from '../src/ol/layer/WebGPUVector.js';
import VectorSource from '../src/ol/source/Vector.js';
import XYZ from '../src/ol/source/XYZ.js';
import {useGeographic} from '../src/ol/proj.js';

useGeographic();

const vector = new WebGPUVectorLayer({
  source: new VectorSource({
    url: 'data/geojson/switzerland.geojson',
    format: new GeoJSON(),
  }),
  style: {
    'fill-color': '#ddd',
    'stroke-color': '#eee',
    'stroke-width': 2,
  },
});

// const raster = new TileLayer({
//   source: new XYZ({
//     url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
//     maxZoom: 19,
//   }),
// });

const map = new Map({
  layers: [vector],
  target: 'map',
  view: new View({
    center: [8, 47],
    zoom: 7,
  }),
});

// Force render loop to catch WebGPU readiness
function render() {
  map.render();
  requestAnimationFrame(render);
}
render();
