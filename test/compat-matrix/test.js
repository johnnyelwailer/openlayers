#! /usr/bin/env node
import fs from 'fs';
import path, {dirname} from 'path';
import {fileURLToPath} from 'url';
import esMain from 'es-main';
import express from 'express';
import {LogLevel} from 'loglevelnext';
import png from 'pngjs';
import {launch} from 'puppeteer';
import serveStatic from 'serve-static';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers'; //eslint-disable-line import/no-unresolved

const baseDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(baseDir, '..', '..');
const buildFullDir = path.join(repoRoot, 'build', 'full');
const baselinePath = path.join(baseDir, 'baseline.json');

/**
 * @return {Array<{name: string, type: string}>} Flat style properties.
 */
function getFlatStyleProperties() {
  const flatStylePath = path.join(repoRoot, 'src', 'ol', 'style', 'flat.js');
  const text = fs.readFileSync(flatStylePath, 'utf-8');
  const re = /^\s*\*\s*@property\s+\{([^}]+)\}\s+\[([^\]]+)\]/gm;

  /** @type {Map<string, string>} */
  const props = new Map();
  let match;
  while ((match = re.exec(text))) {
    const type = match[1].trim();
    const name = match[2].trim().split(/[ =]/)[0];
    if (name === 'style' || name === 'filter' || name === 'else') {
      continue;
    }
    if (!props.has(name)) {
      props.set(name, type);
    }
  }

  return Array.from(props, ([name, type]) => ({name, type})).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

function parsePNGBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const image = new png.PNG();
    image.parse(buffer, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}

/**
 * @param {png.PNG} image Screenshot image.
 * @param {[number, number, number]} bg RGB background color.
 * @return {{rendered: boolean, differentFraction: number}} Render detection result.
 */
function detectRendered(image, bg) {
  const {data, width, height} = image;
  const total = width * height;
  let different = 0;
  const [br, bgc, bb] = bg;
  for (let i = 0; i < total; i++) {
    const idx = i * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    if (r !== br || g !== bgc || b !== bb) {
      different++;
    }
  }
  const differentFraction = different / total;
  return {rendered: differentFraction > 0.001, differentFraction};
}

function serve(options) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(serveStatic(buildFullDir));
    // Serve source modules for browser-side probes (e.g. expression compiler coverage).
    app.use('/src', serveStatic(path.join(repoRoot, 'src')));
    app.get('/compat-matrix/properties.json', (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({properties: getFlatStyleProperties()}, null, 2));
    });
    app.use('/compat-matrix', serveStatic(baseDir));
    app.use('/', serveStatic(baseDir));
    app.get('/favicon.ico', (req, res) => {
      res.writeHead(204);
      res.end();
    });

    const server = app.listen(options.port, options.host, (err) => {
      if (err) {
        return reject(err);
      }
      const address = server.address();
      options.log.info(`server http://${address.address}:${address.port}/`);
      resolve(() => server.close());
    });
  });
}

async function run(options) {
  if (!fs.existsSync(path.join(buildFullDir, 'ol.js'))) {
    throw new Error(
      `Missing ${path.join(
        buildFullDir,
        'ol.js',
      )} - run \`npm run build-full\` first.`,
    );
  }

  const closeServer = await serve(options);
  const browser = await launch({
    args: options.puppeteerArgs,
    headless: options.headless ? 'new' : false,
  });

  try {
    const page = await browser.newPage();
    page.on('console', (message) => {
      const type = message.type();
      const text = message.text();
      // WebGL failures for capability probes can generate a huge amount of low-level GL spam.
      // We record structured errors in the scenario results, so keep console output focused.
      if (
        text.includes('GL_INVALID_VALUE') ||
        text.includes('GL_INVALID_OPERATION') ||
        text.includes('WebGL: too many errors') ||
        text.includes('Too many active WebGL contexts')
      ) {
        return;
      }
      if (options.log[type]) {
        options.log[type](`console: ${text}`);
      }
    });

    page.setDefaultNavigationTimeout(options.timeout);

    /** @type {any} */
    let finalResult = null;

    await page.exposeFunction('reportScenarioResult', async (partial) => {
      if (!partial?.targetId) {
        return null;
      }
      const handle =
        (await page.$(`#${partial.targetId} canvas`)) ||
        (await page.$(`#${partial.targetId}`));
      if (!handle) {
        return null;
      }
      const clip = await handle.boundingBox();
      if (!clip) {
        return null;
      }

      const buffer = await page.screenshot({clip});
      const image = await parsePNGBuffer(buffer);
      // Background in runner.html is rgb(255,0,255).
      return detectRendered(image, [255, 0, 255]);
    });

    await page.exposeFunction('reportDone', async (result) => {
      finalResult = result;
    });

    await page.goto(`http://${options.host}:${options.port}/runner.html`, {
      waitUntil: 'networkidle0',
    });

    // Wait until runner calls reportDone.
    const start = Date.now();
    while (!finalResult) {
      if (Date.now() - start > options.timeout) {
        throw new Error('timeout waiting for results');
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    if (options.fix) {
      fs.writeFileSync(baselinePath, JSON.stringify(finalResult, null, 2));
      options.log.info(
        `wrote baseline ${path.relative(repoRoot, baselinePath)}`,
      );
      return;
    }

    if (!fs.existsSync(baselinePath)) {
      throw new Error(
        `Missing baseline: ${path.relative(
          repoRoot,
          baselinePath,
        )} - run with --fix`,
      );
    }
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));

    const baseByKey = new Map(
      (baseline.results || []).map((r) => [`${r.id}|${r.renderer}`, r]),
    );

    /** @type {Array<string>} */
    const regressions = [];

    for (const r of finalResult.results || []) {
      const key = `${r.id}|${r.renderer}`;
      const b = baseByKey.get(key);
      if (!b) {
        continue;
      }
      if (b.status === 'ok' && r.status !== 'ok') {
        regressions.push(`${key}: ok -> ${r.status}`);
        continue;
      }
      if (b.status === 'ok' && b.rendered === true && r.rendered === false) {
        regressions.push(`${key}: rendered -> blank`);
      }
    }

    if (regressions.length) {
      options.log.error(
        `compat-matrix regressions:\n- ${regressions.join('\n- ')}`,
      );
      throw new Error('COMPATIBILITY MATRIX FAILED');
    }

    options.log.info('compat-matrix: ok');
  } finally {
    await browser.close();
    closeServer();
  }
}

if (esMain(import.meta)) {
  const options = yargs(hideBin(process.argv))
    .option('fix', {
      describe: 'Write baseline JSON instead of comparing to it',
      type: 'boolean',
      default: false,
    })
    .option('host', {
      type: 'string',
      default: '127.0.0.1',
    })
    .option('port', {
      type: 'number',
      default: 3200,
    })
    .option('headless', {
      describe: 'Launch Puppeteer in headless mode',
      type: 'boolean',
      default: !!process.env.CI,
    })
    .option('timeout', {
      describe: 'Timeout in milliseconds',
      type: 'number',
      default: 120000,
    })
    .option('log-level', {
      describe: 'The level for logging',
      choices: ['trace', 'debug', 'info', 'warn', 'error', 'silent'],
      default: 'error',
    })
    .option('puppeteer-args', {
      describe: 'Additional args for Puppeteer',
      type: 'array',
      default: process.env.CI
        ? [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--enable-unsafe-webgpu',
          ]
        : ['--enable-unsafe-webgpu'],
    })
    .parse();

  options.log = new LogLevel({name: 'compat-matrix', level: options.logLevel});

  run(options).catch((err) => {
    options.log.error(err.message);
    process.exit(1);
  });
}
