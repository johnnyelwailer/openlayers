/**
 * Worker for parsing Mapbox vector tiles (MVT) off the main thread.
 * @module ol/worker/mvt
 */

import MVT from '../format/MVT.js';

/** @type {any} */
const worker = self;

const formatCache = new Map();

const GEOMETRY_TYPE_CODE = {
  Point: 0,
  LineString: 1,
  LinearRing: 2,
  Polygon: 2,
  MultiPoint: 3,
  MultiLineString: 4,
};

const GEOMETRY_TYPE_NAME = [
  'Point',
  'LineString',
  'Polygon', // LinearRing shares the polygon rendering path
  'MultiPoint',
  'MultiLineString',
];

/**
 * @param {Object|undefined} options MVT options.
 * @return {MVT} MVT format instance.
 */
function getFormat(options) {
  const key = JSON.stringify(options || {});
  let format = formatCache.get(key);
  if (!format) {
    format = new MVT(options);
    formatCache.set(key, format);
  }
  return format;
}

/** @param {MessageEvent} event Message event. */
worker.onmessage = (event) => {
  const received = event.data;
  if (!received || received.type !== 'MVT_READ_FEATURES') {
    return;
  }

  const {id, arrayBuffer, extent, options} = received;
  try {
    const format = getFormat(options);
    const features = format.readFeatures(arrayBuffer, {extent});

    let coordCount = 0;
    let endsCount = 0;
    for (let i = 0; i < features.length; i++) {
      const feature = features[i];
      coordCount += feature.getOrientedFlatCoordinates().length;
      const ends = feature.getEnds();
      endsCount += ends ? ends.length : 0;
    }

    // Per-feature metadata: [typeCode, coordOffset, coordLength, endsOffset, endsLength]
    const meta = new Uint32Array(features.length * 5);
    const coords = new Float32Array(coordCount);
    const ends = new Uint32Array(endsCount);

    /** @type {Array<*>} */
    const ids = new Array(features.length);
    /** @type {Array<Object<string, *>>|null} */
    let properties = null;

    const requestedProperties =
      options && Array.isArray(options.properties) ? options.properties : null;

    const layerName =
      options && options.layerName ? options.layerName : 'layer';
    const propNames = requestedProperties
      ? Array.from(new Set([...requestedProperties, layerName]))
      : null;

    /** @type {Array<ArrayBufferLike>|null} */
    let propTypesBuffers = null;
    /** @type {Array<ArrayBufferLike>|null} */
    let propNumbersBuffers = null;
    /** @type {Array<ArrayBufferLike>|null} */
    let propStringsBuffers = null;
    /** @type {Array<ArrayBufferLike>|null} */
    let propBoolsBuffers = null;
    /** @type {Array<string>|null} */
    let propStringTable = null;

    /** @type {Array<Uint8Array>|null} */
    let propTypes = null;
    /** @type {Array<Float64Array>|null} */
    let propNumbers = null;
    /** @type {Array<Uint32Array>|null} */
    let propStrings = null;
    /** @type {Array<Uint8Array>|null} */
    let propBools = null;

    /** @type {Map<string, number>|null} */
    let propStringIndexByValue = null;

    let coordOffset = 0;
    let endsOffset = 0;
    for (let i = 0; i < features.length; i++) {
      const feature = features[i];
      const type = feature.getType();
      const typeCode = GEOMETRY_TYPE_CODE[type];
      meta[i * 5 + 0] = typeCode === undefined ? 0 : typeCode;

      const flatCoordinates = feature.getOrientedFlatCoordinates();
      meta[i * 5 + 1] = coordOffset;
      meta[i * 5 + 2] = flatCoordinates.length;
      coords.set(flatCoordinates, coordOffset);
      coordOffset += flatCoordinates.length;

      const featureEnds = feature.getEnds();
      meta[i * 5 + 3] = endsOffset;
      meta[i * 5 + 4] = featureEnds ? featureEnds.length : 0;
      if (featureEnds) {
        ends.set(featureEnds, endsOffset);
        endsOffset += featureEnds.length;
      }

      ids[i] = feature.getId();
    }

    if (!propNames) {
      properties = new Array(features.length);
      for (let i = 0; i < features.length; i++) {
        properties[i] = features[i].getProperties();
      }
    } else {
      propTypes = new Array(propNames.length);
      propNumbers = new Array(propNames.length);
      propStrings = new Array(propNames.length);
      propBools = new Array(propNames.length);
      for (let p = 0; p < propNames.length; p++) {
        propTypes[p] = new Uint8Array(features.length);
        propNumbers[p] = new Float64Array(features.length);
        propStrings[p] = new Uint32Array(features.length);
        propBools[p] = new Uint8Array(features.length);
      }

      propStringTable = [''];
      propStringIndexByValue = new Map([['', 0]]);

      for (let i = 0; i < features.length; i++) {
        const feature = features[i];
        const props = feature.getProperties();
        for (let p = 0; p < propNames.length; p++) {
          const name = propNames[p];
          const value = props[name];
          if (value === null || value === undefined) {
            continue;
          }
          const t = typeof value;
          if (t === 'number') {
            propTypes[p][i] = 1;
            propNumbers[p][i] = value;
            continue;
          }
          if (t === 'boolean') {
            propTypes[p][i] = 3;
            propBools[p][i] = value ? 1 : 0;
            continue;
          }
          const s = String(value);
          let idx = propStringIndexByValue.get(s);
          if (idx === undefined) {
            idx = propStringTable.length;
            propStringTable.push(s);
            propStringIndexByValue.set(s, idx);
          }
          propTypes[p][i] = 2;
          propStrings[p][i] = idx;
        }
      }

      propTypesBuffers = propTypes.map((a) => a.buffer);
      propNumbersBuffers = propNumbers.map((a) => a.buffer);
      propStringsBuffers = propStrings.map((a) => a.buffer);
      propBoolsBuffers = propBools.map((a) => a.buffer);
    }

    /** @type {Array<Transferable>} */
    const transfers = [
      /** @type {ArrayBuffer} */ (meta.buffer),
      /** @type {ArrayBuffer} */ (coords.buffer),
      /** @type {ArrayBuffer} */ (ends.buffer),
    ];
    if (propTypesBuffers) {
      transfers.push(
        ...propTypesBuffers.map((b) => /** @type {ArrayBuffer} */ (b)),
      );
    }
    if (propNumbersBuffers) {
      transfers.push(
        ...propNumbersBuffers.map((b) => /** @type {ArrayBuffer} */ (b)),
      );
    }
    if (propStringsBuffers) {
      transfers.push(
        ...propStringsBuffers.map((b) => /** @type {ArrayBuffer} */ (b)),
      );
    }
    if (propBoolsBuffers) {
      transfers.push(
        ...propBoolsBuffers.map((b) => /** @type {ArrayBuffer} */ (b)),
      );
    }

    worker.postMessage(
      {
        id,
        meta: meta.buffer,
        coords: coords.buffer,
        ends: ends.buffer,
        ids,
        properties,
        propNames,
        propStringTable,
        propTypes: propTypesBuffers,
        propNumbers: propNumbersBuffers,
        propStrings: propStringsBuffers,
        propBools: propBoolsBuffers,
        types: GEOMETRY_TYPE_NAME,
      },
      transfers,
    );
  } catch (error) {
    worker.postMessage({id, error: error ? String(error) : 'Unknown error'});
  }
};

/** @type {function(): Worker} */ export let create;
