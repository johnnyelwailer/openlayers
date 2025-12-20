#! /usr/bin/env node
import fs from 'fs';
import {performance} from 'node:perf_hooks';
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
const renderingDataDir = path.join(repoRoot, 'test', 'rendering', 'data');

function serve(options) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(serveStatic(buildFullDir));
    app.use('/perf', serveStatic(baseDir));
    app.use('/data', serveStatic(renderingDataDir));
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
    const lt = r.longTasks;
    lines.push(
      `${r.renderer}/${r.scenario}: frame p95=${ft.p95.toFixed(
        2,
      )}ms median=${ft.median.toFixed(2)}ms max=${ft.max.toFixed(
        2,
      )}ms over16=${ft.over16ms}/${ft.count}${
        lt
          ? ` | longtask max=${lt.max.toFixed(1)}ms over100=${lt.over100ms}/${lt.count} over250=${lt.over250ms}/${lt.count}`
          : ''
      }`,
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

  const evalTimeoutMs = options.stepTimeout;

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(options.timeout);
    await page.setCacheEnabled(false);
    page.on('console', (msg) => {
      const type = msg.type();
      const verbose =
        options.logLevel === 'trace' || options.logLevel === 'debug';
      if (!verbose && type !== 'error') {
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`[browser:${type}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      // eslint-disable-next-line no-console
      console.log(`[browser:pageerror] ${err?.stack || err}`);
    });
    page.on('requestfailed', (req) => {
      // eslint-disable-next-line no-console
      console.log(
        `[browser:requestfailed] ${req.url()} ${req.failure()?.errorText || ''}`,
      );
    });
    page.on('response', (res) => {
      const verbose =
        options.logLevel === 'trace' || options.logLevel === 'debug';
      if (!verbose) {
        return;
      }
      try {
        const url = res.url();
        if (
          url.includes('/perf/runner.js') ||
          url.includes('/perf/runner.html')
        ) {
          // eslint-disable-next-line no-console
          console.log(`[browser:response] ${res.status()} ${url}`);
        }
      } catch {
        // ignore
      }
    });
    await page.setViewport({
      width: 1100,
      height: 600,
      deviceScaleFactor: 1,
    });

    await page.exposeFunction('reportDone', async () => {});

    const params = new URLSearchParams();
    params.set('frames', String(options.frames));
    params.set('warmup', String(options.warmup));
    params.set('features', String(options.features));
    if (options.renderer) {
      params.set('renderer', String(options.renderer));
    }
    params.set('controlled', '1');
    if (options.vectortiles === false) {
      params.set('vectortiles', '0');
    }
    if (options.scenarios && options.scenarios.length > 0) {
      params.set('scenarios', options.scenarios.map(String).join(','));
    }

    await page.goto(
      `http://${options.host}:${options.port}/perf/runner.html?${params.toString()}`,
      {
        // The perf runner can generate continuous network activity (e.g. tile loading),
        // so waiting for "networkidle0" can hang indefinitely.
        waitUntil: 'load',
      },
    );
    try {
      const probe = await page.evaluate(() => ({
        hasReportDone: typeof globalThis.reportDone === 'function',
        hasOl: !!globalThis.ol,
        hasGpu: !!globalThis.navigator?.gpu,
        visibilityState: document.visibilityState,
        hidden: document.hidden,
        perfStatus: globalThis.__olPerfStatus || null,
      }));
      options.log.info(
        `probe: reportDone=${probe.hasReportDone} ol=${probe.hasOl} gpu=${probe.hasGpu} visibility=${probe.visibilityState} status=${JSON.stringify(
          probe.perfStatus,
        )}`,
      );
    } catch (err) {
      options.log.warn(`probe failed: ${err?.message || err}`);
    }

    /**
     * @template T
     * @param {Promise<T>} promise Promise.
     * @param {number} ms Timeout.
     * @return {Promise<T>} Result.
     */
    async function withTimeout(promise, ms) {
      return await Promise.race([
        promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms),
        ),
      ]);
    }

    let lastStatus = null;
    let steps = 0;
    const start = performance.now();
    while (true) {
      const elapsed = performance.now() - start;
      if (elapsed > options.timeout) {
        try {
          lastStatus = await withTimeout(
            page.evaluate(() => globalThis.__olPerfStatus || null),
            evalTimeoutMs,
          );
        } catch {
          // ignore
        }
        throw new Error(
          `timeout waiting for results (${options.timeout}ms) status=${JSON.stringify(
            lastStatus,
          )}`,
        );
      }

      const done = await withTimeout(
        page.evaluate(() => globalThis.__olPerfDone === true),
        evalTimeoutMs,
      );
      if (done) {
        break;
      }
      try {
        lastStatus = await withTimeout(
          page.evaluate(() => globalThis.__olPerfStatus || null),
          evalTimeoutMs,
        );
      } catch {
        // ignore
      }
      try {
        await withTimeout(
          page.evaluate(() => globalThis.__olPerfAdvance?.()),
          evalTimeoutMs,
        );
      } catch (err) {
        throw new Error(
          `step timeout after ${evalTimeoutMs}ms at step=${steps} status=${JSON.stringify(
            lastStatus,
          )} (${err?.message || err})`,
        );
      }
      steps++;
      if (
        (options.logLevel === 'trace' || options.logLevel === 'debug') &&
        steps % 50 === 0
      ) {
        options.log.debug(`step ${steps} status=${JSON.stringify(lastStatus)}`);
      }
      if (options.stepDelay > 0) {
        await new Promise((r) => setTimeout(r, options.stepDelay));
      }
    }

    const finalResult = await page.evaluate(() => globalThis.__olPerfResult);

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
    try {
      await browser.close();
    } catch {
      // If the browser crashed or a CDP call is stuck, force kill to avoid hanging the harness.
      try {
        browser.process()?.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
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
    .option('renderer', {
      type: 'string',
      choices: ['webgl', 'webgpu'],
      describe: 'Limit runs to a single renderer',
    })
    .option('step-delay', {
      type: 'number',
      default: 5,
      describe: 'Delay (ms) between steps for controlled runs',
    })
    .option('step-timeout', {
      type: 'number',
      default: 30000,
      describe: 'Timeout (ms) for a single step/evaluation',
    })
    .option('vectortiles', {
      type: 'boolean',
      default: false,
      describe: 'Include vector tile scenario(s) (may crash headless Chrome)',
    })
    .option('scenarios', {
      type: 'array',
      default: [],
      describe:
        'Vector scenario ids to run (e.g. --scenarios style-vars pan opacity geometry-churn)',
    })
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
    .option('timeout', {type: 'number', default: 600000})
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
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
          ]
        : [
            '--enable-unsafe-webgpu',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
          ],
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
