const filterEl = document.getElementById('compat-filter');
const groupEl = document.getElementById('compat-group');
const diagnosticsEl = document.getElementById('compat-diagnostics');
const metaEl = document.getElementById('compat-meta');
const summaryEl = document.getElementById('compat-summary');
const tableEl = document.getElementById('compat-table');

/**
 * @param {any} value Arbitrary JSON-serializable value.
 * @return {any} Cloned value with long strings truncated for display.
 */
function truncateForDisplay(value) {
  const max = 120;
  if (typeof value === 'string') {
    if (value.length <= max) {
      return value;
    }
    return `${value.slice(0, 60)}…${value.slice(-20)} (len=${value.length})`;
  }
  if (Array.isArray(value)) {
    return value.map(truncateForDisplay);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = truncateForDisplay(v);
    }
    return out;
  }
  return value;
}

/**
 * @param {any} value JSON-ish value.
 * @param {number} indent Indent level.
 * @return {string} Compact JSON-like formatting with small arrays on one line.
 */
function formatJsonCompact(value, indent = 0) {
  const pad = '  '.repeat(indent);
  const nextPad = '  '.repeat(indent + 1);

  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const hasObjectElement = value.some(
      (v) => v && typeof v === 'object' && !Array.isArray(v),
    );
    if (!hasObjectElement) {
      return `[${value.map((v) => formatJsonCompact(v, 0)).join(', ')}]`;
    }
    if (value.length === 0) {
      return '[]';
    }
    return `[\n${value
      .map((v) => `${nextPad}${formatJsonCompact(v, indent + 1)}`)
      .join(',\n')}\n${pad}]`;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return '{}';
  }

  return `{\n${entries
    .map(
      ([k, v]) =>
        `${nextPad}${JSON.stringify(k)}: ${formatJsonCompact(v, indent + 1)}`,
    )
    .join(',\n')}\n${pad}}`;
}

/**
 * @param {string} id Scenario id.
 * @return {{property: string, variant: string, symbolizer: string, geometry: string}} Parsed id parts.
 */
function parseScenarioId(id) {
  const parts = id.split('/');
  const variant = parts.pop() || '';
  const property = parts.join('/');
  const leaf = property.includes('/') ? property.split('/').pop() : property;

  let symbolizer = 'generic';
  if (leaf.startsWith('fill-')) {
    symbolizer = 'fill';
  } else if (leaf.startsWith('stroke-')) {
    symbolizer = 'stroke';
  } else if (leaf.startsWith('circle-')) {
    symbolizer = 'circle';
  } else if (leaf.startsWith('icon-')) {
    symbolizer = 'icon';
  } else if (leaf.startsWith('shape-')) {
    symbolizer = 'shape';
  } else if (leaf.startsWith('text-')) {
    symbolizer = 'text';
  }

  const geometry =
    symbolizer === 'fill'
      ? 'polygon'
      : symbolizer === 'stroke'
        ? 'line'
        : 'point';

  return {property, variant, symbolizer, geometry};
}

/**
 * @param {string} id Scenario id.
 * @return {{title: string, description: string, code: string}|null} Scenario info.
 */
function describeScenario(id) {
  const caps = parseCapabilityId(id);
  if (caps) {
    if (caps.prefix === 'capabilities/max-style-vars/') {
      return {
        title: 'Max style variables in expression',
        description:
          'One circle style. circle-radius uses a sum of N style variables (var). This probes how many style variables a renderer can reference in GPU expressions (uniforms/storage), not vertex attributes.',
        code: "layer.updateStyleVariables({v0: 0.1, ...});\nstyle = {'circle-radius': ['+', 20, ['+', ['var','v0'], ['var','v1'], ...]]}",
      };
    }
    if (caps.prefix === 'capabilities/max-feature-props/') {
      return {
        title: 'Max feature properties in expression',
        description:
          'One circle style. circle-radius uses a sum of N per-feature properties (get). For WebGL this is typically constrained by the available vertex attributes because each distinct get() becomes an attribute.',
        code: "feature.set('p0', 0.1);\nstyle = {'circle-radius': ['+', 20, ['+', ['get','p0'], ['get','p1'], ...]]}",
      };
    }
    if (caps.prefix === 'capabilities/max-feature-props-case/') {
      return {
        title: 'Max feature properties behind branching',
        description:
          'One circle style. circle-radius uses a case() on idx to pick one of N per-feature properties. This probes case() support plus distinct get() references.',
        code: "style = {'circle-radius': ['+', 20, ['case', ['==',['get','idx'],0], ['get','pc0'], ... , 0]]}",
      };
    }
    if (caps.prefix === 'capabilities/max-rule-filters/') {
      return {
        title: 'Max rules (filter) with distinct props',
        description:
          'Layer style is an array of N rules. Rule i applies to point idx=i (filter uses get(idx)), and each rule references a distinct get(pf<i>) in its style. This probes rule/filter support and stresses distinct per-feature properties across rules.',
        code: "rules = [{filter: ['==',['get','idx'],0], style: {'circle-radius': ['+', 20, ['get','pf0']] }}, ...]",
      };
    }
  }

  const parsed = parseScenarioId(id);
  if (!parsed.property || !parsed.variant) {
    return null;
  }
  return {
    title: `${parsed.property} (${parsed.variant})`,
    description: `symbolizer=${parsed.symbolizer}, geometry=${parsed.geometry}`,
    code: '',
  };
}

/**
 * @param {any} data Matrix data.
 * @return {Array<{id: string, byRenderer: Map<string, any>}>} Grouped scenarios.
 */
function groupScenario(data) {
  const byScenario = new Map();
  for (const r of data.results || []) {
    const key = r.id;
    if (!byScenario.has(key)) {
      byScenario.set(key, []);
    }
    byScenario.get(key).push(r);
  }

  const ids = Array.from(byScenario.keys()).sort();
  return ids.map((id) => {
    const entries = byScenario.get(id);
    return {
      id,
      byRenderer: new Map(entries.map((e) => [e.renderer, e])),
    };
  });
}

/**
 * @param {{byRenderer: Map<string, any>}} scenario Grouped scenario.
 * @return {any|null} Representative entry for per-scenario metadata.
 */
function scenarioMeta(scenario) {
  for (const r of ['webgl', 'webgpu', 'canvas']) {
    const entry = scenario.byRenderer.get(r);
    if (entry) {
      return entry;
    }
  }
  return null;
}

/**
 * @param {string} status Status.
 * @return {{label: string, className: string}} Label + CSS class.
 */
function formatStatus(status) {
  if (status === 'unavailable') {
    return {label: 'unavailable', className: 'status-unavailable'};
  }
  if (status !== 'ok') {
    return {label: 'not supported', className: 'status-error'};
  }
  return {label: 'ok', className: 'status-ok'};
}

/**
 * @param {Array<any>} messages Messages.
 * @return {string} Renderable details.
 */
function formatMessages(messages) {
  if (!messages || messages.length === 0) {
    return '';
  }
  return messages.map((m) => `${m.type}: ${m.message}`).join('\n');
}

/**
 * @param {any} entry Matrix entry.
 * @param {boolean} showDiagnostics Whether to show extra diagnostic info.
 * @return {string} Renderable details.
 */
function formatDetails(entry, showDiagnostics) {
  const details = formatMessages(entry.messages);
  if (!showDiagnostics) {
    return details;
  }
  const parts = [];
  if (details) {
    parts.push(details);
  }
  if (entry.rendered === true && typeof entry.differentFraction === 'number') {
    parts.push(
      `pixel coverage: ${(entry.differentFraction * 100).toFixed(2)}%`,
    );
  }
  return parts.join('\n');
}

/**
 * @param {{property: string, variant: string, symbolizer: string, geometry: string}} parsed Parsed id.
 * @param {string} groupBy Grouping key.
 * @return {string} Group key (empty string means "no group").
 */
function groupKey(parsed, groupBy) {
  if (groupBy === 'symbolizer') {
    return parsed.symbolizer;
  }
  if (groupBy === 'geometry') {
    return parsed.geometry;
  }
  if (groupBy === 'property') {
    return parsed.property;
  }
  if (groupBy === 'expression') {
    return parsed.variant;
  }
  return '';
}

/**
 * @param {string} a Key A.
 * @param {string} b Key B.
 * @return {number} Sort order.
 */
function compareGroupKeys(a, b) {
  const an = Number.parseInt(a, 10);
  const bn = Number.parseInt(b, 10);
  if (String(an) === a && String(bn) === b) {
    return an - bn;
  }
  return a.localeCompare(b);
}

/**
 * @param {string} id Scenario id.
 * @return {{prefix: string, n: number}|null} Capability id parts, if applicable.
 */
function parseCapabilityId(id) {
  const m = id.match(/^(capabilities\/[^/]+\/)(\d+)$/);
  if (!m) {
    return null;
  }
  return {prefix: m[1], n: Number.parseInt(m[2], 10)};
}

/**
 * @param {string} text Raw text.
 * @return {string} Escaped HTML.
 */
function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * @param {string} title Section title.
 * @param {string} text Preformatted text.
 * @param {string} id Unique id suffix.
 * @return {string} HTML fragment.
 */
function renderExpandablePre(title, text, id) {
  if (!text) {
    return '';
  }
  const escaped = escapeHtml(text);
  const lineCount = text.split('\n').length;
  const collapsible = lineCount > 3;

  if (!collapsible) {
    return `<div class="mt-2">
      <div class="small fw-semibold">${escapeHtml(title)}</div>
      <pre class="details">${escaped}</pre>
    </div>`;
  }

  return `<div class="mt-2">
      <div class="small fw-semibold">${escapeHtml(title)}</div>
      <div class="code-block" data-expanded="false" data-code-id="${escapeHtml(
        id,
      )}">
        <pre class="details details-collapsed">${escaped}</pre>
        <button class="code-toggle" type="button" title="click to expand" aria-expanded="false" aria-label="click to expand">show ▾</button>
      </div>
    </div>`;
}

/**
 * @param {Array<any>} scenarios Scenarios.
 */
function renderSummary(scenarios) {
  const renderers = ['canvas', 'webgl', 'webgpu'];
  const counts = {};
  const maxVars = {};
  const maxFeatureProps = {};
  const maxFeaturePropsCase = {};
  const maxRuleFilters = {};
  for (const r of renderers) {
    counts[r] = {ok: 0, notSupported: 0, unavailable: 0};
    maxVars[r] = null;
    maxFeatureProps[r] = null;
    maxFeaturePropsCase[r] = null;
    maxRuleFilters[r] = null;
  }

  for (const s of scenarios) {
    for (const r of renderers) {
      const entry = s.byRenderer.get(r);
      if (!entry) {
        counts[r].unavailable++;
        continue;
      }
      const status = entry.status;
      if (status === 'unavailable') {
        counts[r].unavailable++;
        continue;
      }
      if (status !== 'ok') {
        counts[r].notSupported++;
        continue;
      }
      counts[r].ok++;
    }
  }

  for (const s of scenarios) {
    for (const r of renderers) {
      const entry = s.byRenderer.get(r);
      if (!entry || entry.status !== 'ok') {
        continue;
      }

      const kind = entry.capabilityKind;
      if (!kind) {
        continue;
      }

      if (kind === 'max-style-vars') {
        const vars = entry.capabilityVarsUsed;
        if (
          typeof vars === 'number' &&
          (maxVars[r] === null || vars > maxVars[r])
        ) {
          maxVars[r] = vars;
        }
      } else if (kind === 'max-feature-props') {
        const gets = entry.capabilityGetsUsed;
        if (
          typeof gets === 'number' &&
          (maxFeatureProps[r] === null || gets > maxFeatureProps[r])
        ) {
          maxFeatureProps[r] = gets;
        }
      } else if (kind === 'max-feature-props-case') {
        const gets = entry.capabilityGetsUsed;
        if (
          typeof gets === 'number' &&
          (maxFeaturePropsCase[r] === null || gets > maxFeaturePropsCase[r])
        ) {
          maxFeaturePropsCase[r] = gets;
        }
      } else if (kind === 'max-rule-filters') {
        const rules = entry.capabilityCount;
        if (
          typeof rules === 'number' &&
          (maxRuleFilters[r] === null || rules > maxRuleFilters[r])
        ) {
          maxRuleFilters[r] = rules;
        }
      }
    }
  }

  summaryEl.innerHTML = '';
  for (const r of renderers) {
    const el = document.createElement('div');
    el.className = 'col-12 col-md-4';
    const maxVarsLabel = maxVars[r] === null ? 'n/a' : String(maxVars[r]);
    const maxPropsLabel =
      maxFeatureProps[r] === null ? 'n/a' : String(maxFeatureProps[r]);
    const maxPropsCaseLabel =
      maxFeaturePropsCase[r] === null ? 'n/a' : String(maxFeaturePropsCase[r]);
    const maxRuleFiltersLabel =
      maxRuleFilters[r] === null ? 'n/a' : String(maxRuleFilters[r]);
    el.innerHTML = `
      <div class="card">
        <div class="card-body py-2">
          <div class="fw-semibold">${r}</div>
          <div class="small text-muted">
            ok=${counts[r].ok} · not supported=${counts[r].notSupported} · unavailable=${counts[r].unavailable}
          </div>
          <div class="small text-muted">max style vars (var): ${maxVarsLabel}</div>
          <div class="small text-muted">max feature props (get): ${maxPropsLabel}</div>
          <div class="small text-muted">max feature props (case+get): ${maxPropsCaseLabel}</div>
          <div class="small text-muted">max rules (filter): ${maxRuleFiltersLabel}</div>
        </div>
      </div>
    `;
    summaryEl.appendChild(el);
  }
}

/**
 * @param {Array<any>} scenarios Scenarios.
 * @param {string} query Filter query.
 * @param {string} groupBy Grouping key.
 * @param {boolean} showDiagnostics Whether to show diagnostic info.
 * @param {Map<string, any>} definitions Scenario definitions by id.
 */
function renderTable(scenarios, query, groupBy, showDiagnostics, definitions) {
  const q = query.trim().toLowerCase();
  const list = q
    ? scenarios.filter((s) => s.id.toLowerCase().includes(q))
    : scenarios;

  const sorted = list.slice().sort((a, b) => {
    const pa = parseScenarioId(a.id);
    const pb = parseScenarioId(b.id);
    const groupA = groupKey(pa, groupBy);
    const groupB = groupKey(pb, groupBy);
    if (groupA !== groupB) {
      return compareGroupKeys(groupA, groupB);
    }
    const ca = parseCapabilityId(a.id);
    const cb = parseCapabilityId(b.id);
    if (ca && cb && ca.prefix === cb.prefix) {
      return ca.n - cb.n;
    }
    return a.id.localeCompare(b.id);
  });

  tableEl.innerHTML = '';
  tableEl.innerHTML = `
    <thead>
      <tr>
        <th>Scenario</th>
        <th>Canvas</th>
        <th>WebGL</th>
        <th>WebGPU</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = tableEl.querySelector('tbody');
  let currentGroup = null;
  for (const s of sorted) {
    const parsed = parseScenarioId(s.id);
    const nextGroup = groupKey(parsed, groupBy) || null;

    if (nextGroup && nextGroup !== currentGroup) {
      currentGroup = nextGroup;
      const groupRow = document.createElement('tr');
      groupRow.className = 'group-row';
      groupRow.innerHTML = `<td colspan="4">${escapeHtml(nextGroup)}</td>`;
      tbody.appendChild(groupRow);
    }

    const meta = scenarioMeta(s);
    const tr = document.createElement('tr');
    tr.className = 'scenario-row';
    tr.dataset.sid = s.id;
    const idCell = document.createElement('td');
    idCell.textContent = s.id;
    tr.appendChild(idCell);

    for (const r of ['canvas', 'webgl', 'webgpu']) {
      const entry = s.byRenderer.get(r);
      const td = document.createElement('td');
      if (!entry) {
        td.innerHTML = `<div class="status-unavailable">n/a</div>`;
      } else {
        const {label, className} = formatStatus(entry.status);
        td.innerHTML = `<div class="${className}">${label}</div>`;
      }
      tr.appendChild(td);
    }

    tbody.appendChild(tr);

    const info = describeScenario(s.id);
    const detailsRow = document.createElement('tr');
    detailsRow.className = 'details-row d-none';
    detailsRow.dataset.sid = s.id;

    const def = definitions.get(s.id) || null;
    const title = info ? info.title : s.id;
    let description = info ? info.description : '';
    if (meta?.capabilityKind) {
      if (
        typeof meta.capabilityGetsUsed === 'number' &&
        meta.capabilityGetsUsed > 0
      ) {
        description += `${description ? ' ' : ''}(distinct get() props: ${meta.capabilityGetsUsed})`;
      }
      if (
        typeof meta.capabilityVarsUsed === 'number' &&
        meta.capabilityVarsUsed > 0
      ) {
        description += `${description ? ' ' : ''}(vars: ${meta.capabilityVarsUsed})`;
      }
    }

    const styleSnippet =
      def?.style !== undefined && def.style !== null
        ? formatJsonCompact(truncateForDisplay(def.style))
        : '';
    const variablesSnippet =
      def?.variables && Object.keys(def.variables).length
        ? formatJsonCompact(truncateForDisplay(def.variables))
        : '';
    const exprSnippet =
      def?.expr !== undefined
        ? formatJsonCompact(truncateForDisplay(def.expr))
        : '';
    const expectedTypeSnippet =
      def?.expectedType !== undefined ? String(def.expectedType) : '';

    const infoCell = document.createElement('td');
    infoCell.innerHTML = `<div class="small fw-semibold">${escapeHtml(
      title,
    )}</div>${
      description
        ? `<div class="text-muted small">${escapeHtml(description)}</div>`
        : ''
    }${
      info?.code
        ? `<div class="small fw-semibold mt-2">Example</div><pre class="details">${escapeHtml(
            info.code,
          )}</pre>`
        : ''
    }${renderExpandablePre('Flat style', styleSnippet, `${s.id}::style`)}${renderExpandablePre(
      'Style variables',
      variablesSnippet,
      `${s.id}::vars`,
    )}${renderExpandablePre('Expression', exprSnippet, `${s.id}::expr`)}${renderExpandablePre(
      'Expected type',
      expectedTypeSnippet,
      `${s.id}::expectedType`,
    )}`;
    detailsRow.appendChild(infoCell);

    for (const r of ['canvas', 'webgl', 'webgpu']) {
      const entry = s.byRenderer.get(r);
      const cell = document.createElement('td');
      if (!entry) {
        cell.innerHTML = `<div class="status-unavailable">n/a</div>`;
      } else {
        const details = formatDetails(entry, showDiagnostics);
        const detailsHtml = details
          ? `<pre class="details">${escapeHtml(details)}</pre>`
          : '';
        cell.innerHTML = detailsHtml || '';
      }
      detailsRow.appendChild(cell);
    }

    tbody.appendChild(detailsRow);
  }

  tbody.addEventListener('click', (event) => {
    const toggle = event.target.closest('button.code-toggle');
    if (toggle) {
      event.stopPropagation();
      const wrapper = toggle.closest('.code-block');
      if (!wrapper) {
        return;
      }
      const expanded = wrapper.dataset.expanded === 'true';
      wrapper.dataset.expanded = expanded ? 'false' : 'true';
      wrapper.classList.toggle('is-expanded', !expanded);
      toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      toggle.title = expanded ? 'click to expand' : 'click to collapse';
      toggle.textContent = expanded ? 'show ▾' : 'hide ▴';
      return;
    }

    const row = event.target.closest('tr.scenario-row');
    if (!row) {
      return;
    }
    const sid = row.dataset.sid;
    if (!sid) {
      return;
    }
    const selector = `tr.details-row[data-sid="${CSS.escape(sid)}"]`;
    const details = tbody.querySelector(selector);
    if (!details) {
      return;
    }
    details.classList.toggle('d-none');
  });
}

async function loadBaseline() {
  const res = await fetch('./resources/compat-matrix/baseline.json', {
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Failed to load baseline: ${res.status}`);
  }
  return res.json();
}

loadBaseline()
  .then((data) => {
    metaEl.textContent = data.meta
      ? `${data.meta.date || ''} · scenarios=${data.meta.scenarios || ''}`
      : '';
    const scenarios = groupScenario(data);
    renderSummary(scenarios);
    const definitions = new Map((data.scenarios || []).map((d) => [d.id, d]));
    const rerender = () => {
      renderTable(scenarios, filterEl.value, groupEl.value, false, definitions);
    };
    rerender();
    filterEl.addEventListener('input', rerender);
    groupEl.addEventListener('change', rerender);
  })
  .catch((err) => {
    metaEl.textContent = err instanceof Error ? err.message : String(err);
  });
