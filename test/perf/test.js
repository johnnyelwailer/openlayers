#! /usr/bin/env node
import fs from 'fs';
import path, {dirname} from 'path';
import {fileURLToPath} from 'url';
import esMain from 'es-main';
import express from 'express';
import {LogLevel} from 'loglevelnext';
import {launch} from 'puppeteer';
import serveStatic from 'serve-static';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers'; //eslint-disable-line import/no-unresolved

const baseDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(baseDir, '..', '..');
const buildFullDir = path.join(repoRoot, 'build', 'full');

function serve(options) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(serveStatic(buildFullDir));
    app.use('/perf', serveStatic(baseDir));
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

/**
 * @param {any} result Result JSON.
 * @return {string} Summary string.
 */
function formatSummary(result) {
  const lines = [];
  for (const r of result.results || []) {
    if (r.status !== 'ok') {
      lines.push(
        `${r.renderer}/${r.scenario}: ${r.status}${
          r.message ? ` (${r.message})` : ''
        }`,
      );
      continue;
    }
    const ft = r.frameTimes;
    lines.push(
      `${r.renderer}/${r.scenario}: frame p95=${ft.p95.toFixed(
        2,
      )}ms median=${ft.median.toFixed(2)}ms max=${ft.max.toFixed(
        2,
      )}ms over16=${ft.over16ms}/${ft.count}`,
    );
  }
  return lines.join('\n');
}

/**
 * @param {any} current Current results.
 * @param {any} baseline Baseline results.
 * @param {number} threshold Threshold as fraction (0.15 == 15%).
 * @return {{ok: boolean, messages: Array<string>}} Comparison result.
 */
function compareResults(current, baseline, threshold) {
  const baseByKey = new Map(
    (baseline.results || []).map((r) => [`${r.renderer}|${r.scenario}`, r]),
  );
  const messages = [];
  let ok = true;
  for (const r of current.results || []) {
    if (r.status !== 'ok') {
      continue;
    }
    const b = baseByKey.get(`${r.renderer}|${r.scenario}`);
    if (!b || b.status !== 'ok') {
      continue;
    }
    const cur = r.frameTimes?.p95;
    const base = b.frameTimes?.p95;
    if (!Number.isFinite(cur) || !Number.isFinite(base) || base <= 0) {
      continue;
    }
    const delta = (cur - base) / base;
    if (delta > threshold) {
      ok = false;
      messages.push(
        `${r.renderer}/${r.scenario}: p95 ${(delta * 100).toFixed(1)}% slower (${base.toFixed(
          2,
        )}ms -> ${cur.toFixed(2)}ms)`,
      );
    }
  }
  return {ok, messages};
}

async function run(options) {
  if (!fs.existsSync(path.join(buildFullDir, 'ol.js'))) {
    throw new Error(
      `Missing ${path.join(buildFullDir, 'ol.js')} - run \`npm run build-full\` first.`,
    );
  }

  const closeServer = await serve(options);
  const browser = await launch({
    args: options.puppeteerArgs,
    headless: options.headless ? 'new' : false,
  });

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(options.timeout);
    await page.setViewport({
      width: 1100,
      height: 600,
      deviceScaleFactor: 1,
    });

    /** @type {any} */
    let finalResult = null;

    await page.exposeFunction('reportDone', async (result) => {
      finalResult = result;
    });

    const params = new URLSearchParams();
    params.set('frames', String(options.frames));
    params.set('warmup', String(options.warmup));
    params.set('features', String(options.features));

    await page.goto(
      `http://${options.host}:${options.port}/perf/runner.html?${params.toString()}`,
      {
        waitUntil: 'networkidle0',
      },
    );

    const start = Date.now();
    while (!finalResult) {
      if (Date.now() - start > options.timeout) {
        throw new Error('timeout waiting for results');
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    if (options.out) {
      fs.writeFileSync(options.out, JSON.stringify(finalResult, null, 2));
      options.log.info(`wrote results ${path.relative(repoRoot, options.out)}`);
    }

    options.log.info(formatSummary(finalResult));

    if (options.compare) {
      const baseline = JSON.parse(fs.readFileSync(options.compare, 'utf-8'));
      const compared = compareResults(finalResult, baseline, options.threshold);
      if (!compared.ok) {
        options.log.error(
          `perf regressions:\n- ${compared.messages.join('\n- ')}`,
        );
        throw new Error('PERF REGRESSION');
      }
    }
  } finally {
    await browser.close();
    closeServer();
  }
}

if (esMain(import.meta)) {
  const options = yargs(hideBin(process.argv))
    .option('host', {type: 'string', default: '127.0.0.1'})
    .option('port', {type: 'number', default: 3210})
    .option('headless', {type: 'boolean', default: true})
    .option('frames', {type: 'number', default: 240})
    .option('warmup', {type: 'number', default: 60})
    .option('features', {type: 'number', default: 2000})
    .option('out', {
      type: 'string',
      describe: 'Write full JSON results to this path',
    })
    .option('compare', {
      type: 'string',
      describe:
        'Compare against a baseline JSON file (machine-local recommended)',
    })
    .option('threshold', {
      type: 'number',
      default: 0.15,
      describe: 'Allowed p95 regression fraction (0.15 == 15%)',
    })
    .option('timeout', {type: 'number', default: 120000})
    .option('log-level', {
      describe: 'The level for logging',
      choices: ['trace', 'debug', 'info', 'warn', 'error', 'silent'],
      default: 'info',
    })
    .option('puppeteer-args', {
      type: 'array',
      default: process.env.CI
        ? [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--enable-unsafe-webgpu',
          ]
        : ['--enable-unsafe-webgpu'],
      describe: 'Additional args for Puppeteer',
    })
    .strict()
    .help()
    .parse();

  options.log = new LogLevel({name: 'perf', level: options.logLevel});
  options.puppeteerArgs = options.puppeteerArgs.map(String);

  run(options).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err?.message || err);
    process.exit(1);
  });
}
