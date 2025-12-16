const table = document.getElementById('table');
const filter = document.getElementById('filter');
const metaEl = document.getElementById('meta');

/**
 * @param {string} status Status string.
 * @return {string} CSS class for status.
 */
function statusClass(status) {
  if (status === 'ok') {
    return 'ok';
  }
  if (status === 'unavailable') {
    return 'unavailable';
  }
  return 'not-supported';
}

/**
 * @param {Array<any>} messages Messages.
 * @return {string} Renderable string.
 */
function formatMessages(messages) {
  if (!messages || messages.length === 0) {
    return '';
  }
  return messages.map((m) => `${m.type}: ${m.message}`).join('\n');
}

async function load() {
  const res = await fetch('./baseline.json', {cache: 'no-store'});
  if (!res.ok) {
    throw new Error(`Failed to load baseline.json: ${res.status}`);
  }
  return res.json();
}

/**
 * @param {any} data Matrix data.
 * @param {string} query Filter query.
 */
function render(data, query) {
  const results = data.results || [];
  const byScenario = new Map();
  for (const r of results) {
    const key = r.id;
    if (!byScenario.has(key)) {
      byScenario.set(key, []);
    }
    byScenario.get(key).push(r);
  }

  const scenarioIds = Array.from(byScenario.keys()).sort();
  const q = query.trim().toLowerCase();
  const filtered = q
    ? scenarioIds.filter((id) => id.toLowerCase().includes(q))
    : scenarioIds;

  metaEl.textContent = data.meta
    ? `${data.meta.date || ''} · scenarios=${data.meta.scenarios || ''}`
    : '';

  table.innerHTML = '';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>
    <th>Scenario</th>
    <th>Canvas</th>
    <th>WebGL</th>
    <th>WebGPU</th>
  </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const id of filtered) {
    const row = document.createElement('tr');
    const cellId = document.createElement('td');
    cellId.textContent = id;
    row.appendChild(cellId);

    const entries = byScenario.get(id);
    const byRenderer = new Map(entries.map((e) => [e.renderer, e]));
    for (const renderer of ['canvas', 'webgl', 'webgpu']) {
      const e = byRenderer.get(renderer);
      const td = document.createElement('td');
      if (!e) {
        td.innerHTML = `<div class="cell unavailable">n/a</div>`;
      } else {
        const s = e.status;
        const details = formatMessages(e.messages);
        const label = s === 'not_supported' ? 'not supported' : s;
        const detailsHtml = details
          ? `<div class="details">${escapeHtml(details)}</div>`
          : '';
        td.innerHTML = `<div class="cell ${statusClass(s)}">${label}</div>${detailsHtml}`;
      }
      row.appendChild(td);
    }

    tbody.appendChild(row);
  }
  table.appendChild(tbody);
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

const data = await load();
render(data, '');
filter.addEventListener('input', () => {
  render(data, filter.value);
});
