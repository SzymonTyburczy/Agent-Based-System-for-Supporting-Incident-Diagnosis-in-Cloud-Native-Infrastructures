/**
 * IncidentIQ — Frontend Application
 * Manages scenario selection, SSE streaming from agent pipeline, and dynamic UI rendering.
 */

const API = '';  // same origin — FastAPI serves both API and static files

let selectedScenario = null;
let activeEventSource = null;
let reportBuffer = '';
let isRunning = false;

const STEP_ORDER = [
  'ALERT_RECEIVED',
  'ANALYZING_METRICS',
  'QUERYING_LOGS',
  'RAG_SEARCH',
  'GENERATING_REPORT',
];

const SEVERITY_BADGE = {
  critical: 'badge-critical',
  warning: 'badge-warning',
  info: 'badge-info',
};

const SEVERITY_ICON = {
  critical: '🔴',
  warning: '🟡',
  info: '🔵',
};

// ── Initialization ──────────────────────────────────────────────────────────

async function init() {
  try {
    const res = await fetch(`${API}/api/scenarios`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const scenarios = await res.json();
    renderScenarioList(scenarios);
    document.getElementById('scenario-count').textContent = `${scenarios.length} scenarios`;
  } catch (err) {
    showError(`Failed to load scenarios: ${err.message}. Make sure the backend is running.`);
  }
}

// ── Scenario List ───────────────────────────────────────────────────────────

function renderScenarioList(scenarios) {
  const list = document.getElementById('scenario-list');
  list.innerHTML = '';
  scenarios.forEach(s => {
    const item = document.createElement('div');
    item.className = 'scenario-item';
    item.id = `scenario-${s.id}`;
    item.setAttribute('data-id', s.id);
    item.onclick = () => selectScenario(s);
    item.innerHTML = `
      <div class="scenario-item-header">
        <span class="scenario-name">${s.name}</span>
        <span class="badge ${SEVERITY_BADGE[s.severity] || 'badge-info'}">${s.severity}</span>
      </div>
      <div class="scenario-service">${s.namespace} / ${s.service}</div>
      <div class="scenario-description">${s.description}</div>
    `;
    list.appendChild(item);
  });
}

// ── Custom Scenario UI ────────────────────────────────────────────────────────
function showCustomScenarioForm() {
  if (isRunning) return;

  // Deselect predefined
  document.querySelectorAll('.scenario-item').forEach(el => el.classList.remove('active'));
  selectedScenario = null;

  // Show custom form, hide welcome and pipeline details
  document.getElementById('welcome-state').style.display = 'none';
  document.getElementById('pipeline-panel').classList.remove('visible');
  document.getElementById('custom-scenario-panel').style.display = 'block';

  // Hide previous results
  document.getElementById('telemetry-grid').style.display = 'none';
  document.getElementById('report-panel').classList.remove('visible');
  hideError();
}

function selectScenario(scenario) {
  if (isRunning) return;

  // Deselect previous
  document.querySelectorAll('.scenario-item').forEach(el => el.classList.remove('active'));
  document.getElementById(`scenario-${scenario.id}`)?.classList.add('active');

  selectedScenario = scenario;

  // Show pipeline panel, hide welcome and custom form
  document.getElementById('welcome-state').style.display = 'none';
  document.getElementById('custom-scenario-panel').style.display = 'none';
  document.getElementById('pipeline-panel').classList.add('visible');

  // Update pipeline header
  document.getElementById('pipeline-alert-name').textContent = scenario.name;
  document.getElementById('pipeline-alert-type').textContent = scenario.alert_type;
  document.getElementById('pipeline-alert-icon').textContent = SEVERITY_ICON[scenario.severity] || '🔵';

  // Reset pipeline UI
  resetPipelineUI();

  // Hide previous results
  document.getElementById('telemetry-grid').style.display = 'none';
  document.getElementById('report-panel').classList.remove('visible');
  hideError();
}


// ── Pipeline UI Helpers ─────────────────────────────────────────────────────

function resetPipelineUI() {
  STEP_ORDER.forEach(step => {
    const el = document.getElementById(`step-${step}`);
    if (el) {
      el.classList.remove('active', 'done');
      const iconWrap = el.querySelector('.step-icon-wrap');
      if (iconWrap) iconWrap.innerHTML = stepIcon(step);
    }
    const msg = document.getElementById(`msg-${step}`);
    if (msg) msg.textContent = 'Waiting…';
  });
  document.getElementById('rag-doc-list').innerHTML = '';
  reportBuffer = '';
}

function stepIcon(step) {
  const icons = {
    'ALERT_RECEIVED': '📨',
    'ANALYZING_METRICS': '📊',
    'QUERYING_LOGS': '🗂️',
    'RAG_SEARCH': '🔍',
    'GENERATING_REPORT': '✨',
  };
  return icons[step] || '⚙️';
}

function activateStep(step) {
  const el = document.getElementById(`step-${step}`);
  if (!el) return;
  el.classList.add('active');
  const iconWrap = el.querySelector('.step-icon-wrap');
  if (iconWrap) iconWrap.innerHTML = '<div class="spinner"></div>';
}

function completeStep(step, message) {
  const el = document.getElementById(`step-${step}`);
  if (!el) return;
  el.classList.remove('active');
  el.classList.add('done');
  const iconWrap = el.querySelector('.step-icon-wrap');
  if (iconWrap) iconWrap.innerHTML = '✓';
  const msg = document.getElementById(`msg-${step}`);
  if (msg) msg.textContent = message;
}

// ── Diagnosis Runner ────────────────────────────────────────────────────────

async function runCustomDiagnosis() {
  if (isRunning) return;

  const alertType = document.getElementById('custom-alert-type').value || 'CustomAlert';
  const service = document.getElementById('custom-service').value || 'my-service';
  const description = document.getElementById('custom-description').value || 'No description provided';

  const customPayload = {
    name: 'Custom User Incident',
    alert_type: alertType,
    severity: 'warning',
    service: service,
    namespace: 'default',
    description: description,
    metrics: {},
    logs: [description] // Pass description as logs to be safe
  };

  // Hide custom form and show pipeline
  document.getElementById('custom-scenario-panel').style.display = 'none';
  document.getElementById('pipeline-panel').classList.add('visible');
  
  // Setup pipeline header
  document.getElementById('pipeline-alert-name').textContent = customPayload.name;
  document.getElementById('pipeline-alert-type').textContent = customPayload.alert_type;
  document.getElementById('pipeline-alert-icon').textContent = SEVERITY_ICON[customPayload.severity];

  await executeDiagnosis('/api/diagnose/custom', customPayload);
}

async function runDiagnosis() {
  if (!selectedScenario || isRunning) return;
  await executeDiagnosis('/api/diagnose', { scenario_id: selectedScenario.id });
}

async function executeDiagnosis(endpoint, payload) {
  isRunning = true;
  document.getElementById('run-btn').disabled = true;
  document.getElementById('run-btn').innerHTML = '<div class="spinner" style="width:12px;height:12px;"></div> Running…';

  hideError();
  resetPipelineUI();
  document.getElementById('telemetry-grid').style.display = 'none';
  document.getElementById('report-panel').classList.remove('visible');
  document.getElementById('report-body').innerHTML = '';
  reportBuffer = '';

  // Close any existing SSE
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }

  try {
    // Use fetch with ReadableStream for SSE-over-POST
    const response = await fetch(`${API}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(err.detail || `HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const evPayload = JSON.parse(line.slice(6));
            handleAgentEvent(evPayload);
          } catch (_) { /* ignore malformed chunks */ }
        }
      }
    }
  } catch (err) {
    showError(`Diagnosis failed: ${err.message}`);
  } finally {
    isRunning = false;
    document.getElementById('run-btn').disabled = false;
    document.getElementById('run-btn').innerHTML = '<span>▶</span> Run Diagnosis';
    // Remove streaming cursor
    const reportEl = document.getElementById('report-body');
    reportEl.classList.remove('report-cursor');
  }
}

// ── Event Handler ───────────────────────────────────────────────────────────

function handleAgentEvent(payload) {
  const { step, message, data } = payload;

  switch (step) {
    case 'ALERT_RECEIVED':
      activateStep('ALERT_RECEIVED');
      setTimeout(() => completeStep('ALERT_RECEIVED', message), 600);
      break;

    case 'ANALYZING_METRICS':
      activateStep('ANALYZING_METRICS');
      if (data) renderMetrics(data);
      setTimeout(() => {
        completeStep('ANALYZING_METRICS', message);
        document.getElementById('telemetry-grid').style.display = 'grid';
      }, 600);
      break;

    case 'QUERYING_LOGS':
      activateStep('QUERYING_LOGS');
      if (data?.logs) renderLogs(data.logs);
      setTimeout(() => completeStep('QUERYING_LOGS', message), 600);
      break;

    case 'RAG_SEARCH':
      activateStep('RAG_SEARCH');
      if (data?.documents) renderRagDocs(data.documents);
      if (data?.query) {
        const qEl = document.getElementById('msg-RAG_SEARCH');
        if (qEl) qEl.textContent = `Query: "${data.query.substring(0, 80)}…"`;
      }
      setTimeout(() => completeStep('RAG_SEARCH', message), 600);
      break;

    case 'GENERATING_REPORT':
      activateStep('GENERATING_REPORT');
      // Show report panel with streaming cursor
      document.getElementById('report-panel').classList.add('visible', 'fade-in');
      document.getElementById('report-body').classList.add('report-cursor');
      break;

    case 'REPORT_CHUNK':
      // Accumulate and render streaming text
      reportBuffer += message;
      renderMarkdown(reportBuffer);
      scrollReportToBottom();
      break;

    case 'REPORT_COMPLETE':
      completeStep('GENERATING_REPORT', 'Report generated successfully.');
      document.getElementById('report-body').classList.remove('report-cursor');
      break;

    case 'ERROR':
      showError(message);
      break;
  }
}

// ── Rendering Helpers ───────────────────────────────────────────────────────

function renderMetrics(metrics) {
  const grid = document.getElementById('metrics-grid');
  grid.innerHTML = '';
  const highlight = ['cpu_usage_percent', 'memory_usage_mb', 'active_connections', 'error_rate_percent',
                     'disk_usage_percent', 'oom_kill_count', 'pod_restarts'];

  Object.entries(metrics).slice(0, 8).forEach(([key, value]) => {
    const isHighlight = highlight.includes(key);
    const displayKey = key.replace(/_/g, ' ');
    const numVal = typeof value === 'number' ? value : null;
    let cls = '';
    if (numVal !== null && isHighlight) {
      cls = numVal > 90 ? 'danger' : numVal > 70 ? 'warning' : 'success';
    }
    const displayVal = Array.isArray(value)
      ? `${value.length} items`
      : typeof value === 'object'
      ? JSON.stringify(value)
      : value;

    grid.innerHTML += `
      <div class="metric-item">
        <div class="metric-key">${displayKey}</div>
        <div class="metric-value ${cls}">${displayVal}</div>
      </div>
    `;
  });
}

function renderLogs(logs) {
  const list = document.getElementById('log-list');
  list.innerHTML = '';
  logs.forEach(log => {
    const cls = log.includes('CRITICAL') ? 'critical'
               : log.includes('ERROR') ? 'error'
               : log.includes('WARN') ? 'warn'
               : 'info';
    const entry = document.createElement('div');
    entry.className = `log-entry ${cls} fade-in`;
    entry.textContent = log;
    list.appendChild(entry);
  });
}

function renderRagDocs(docs) {
  const list = document.getElementById('rag-doc-list');
  list.innerHTML = '';
  docs.forEach((doc, i) => {
    setTimeout(() => {
      const tag = document.createElement('span');
      tag.className = 'rag-doc-tag';
      // doc can be a string (legacy) or {source, distance} object
      if (typeof doc === 'object' && doc.source) {
        const score = doc.distance != null ? ` (${((1 - doc.distance) * 100).toFixed(0)}%)` : '';
        tag.textContent = `📄 ${doc.source}${score}`;
        tag.title = `Cosine similarity: ${((1 - doc.distance) * 100).toFixed(1)}%`;
      } else {
        tag.textContent = `📄 ${doc}`;
      }
      list.appendChild(tag);
    }, i * 150);
  });
}

/**
 * Very lightweight Markdown → HTML renderer (no external dependencies).
 * Handles: ## headings, **bold**, `code`, numbered lists, bullet lists, paragraphs.
 */
function renderMarkdown(text) {
  const html = text
    // h2
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    // bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // numbered list items
    .replace(/^\d+\.\s+(.*)$/gm, '<li>$1</li>')
    // bullet list items
    .replace(/^[-*]\s+(.*)$/gm, '<li>$1</li>')
    // wrap consecutive <li> in <ol>
    .replace(/(<li>.*<\/li>\n?)+/g, match => `<ol>${match}</ol>`)
    // paragraphs (blank-line separated)
    .replace(/\n\n(?!<)/g, '</p><p>')
    // line breaks
    .replace(/\n(?!<)/g, '<br/>');

  document.getElementById('report-body').innerHTML = `<p>${html}</p>`;
}

function scrollReportToBottom() {
  const el = document.getElementById('report-body');
  el.scrollTop = el.scrollHeight;
}

// ── Copy Report ─────────────────────────────────────────────────────────────

function copyReport() {
  if (!reportBuffer) return;
  navigator.clipboard.writeText(reportBuffer).then(() => {
    const btn = document.getElementById('copy-btn');
    btn.textContent = '✓ Copied!';
    setTimeout(() => btn.textContent = '📋 Copy', 2000);
  });
}

// ── Error Handling ───────────────────────────────────────────────────────────

function showError(msg) {
  const el = document.getElementById('error-banner');
  el.textContent = `⚠️ ${msg}`;
  el.classList.add('visible');
}

function hideError() {
  document.getElementById('error-banner').classList.remove('visible');
}

// ── Boot ─────────────────────────────────────────────────────────────────────

init();
