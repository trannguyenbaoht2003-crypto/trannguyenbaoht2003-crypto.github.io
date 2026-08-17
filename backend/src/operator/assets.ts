export const OPERATOR_HTML = `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hải Đấu — Operator Signals</title>
  <link rel="stylesheet" href="/operator.css">
</head>
<body>
  <main class="shell">
    <header class="header">
      <div>
        <p class="eyebrow">HẢI ĐẤU / INTERNAL</p>
        <h1>Monitoring & Feedback</h1>
        <p id="generated" class="muted">Chưa tải snapshot.</p>
      </div>
      <button id="refresh" type="button">Làm mới</button>
    </header>

    <section id="summary" class="summary" aria-label="Tóm tắt tín hiệu"></section>

    <section class="controls" aria-label="Bộ lọc">
      <label>
        Mức ưu tiên
        <select id="priority">
          <option value="all">Tất cả</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="feedback">Feedback only</option>
        </select>
      </label>
      <label class="check">
        <input id="active-only" type="checkbox">
        Chỉ phiên bản đang active
      </label>
      <label>
        Tìm cục bộ
        <input id="search" type="search" autocomplete="off" placeholder="Publication / Version / reason">
      </label>
    </section>

    <p id="status" class="status" role="status"></p>
    <section id="signals" class="signals" aria-label="Danh sách tín hiệu"></section>
  </main>
  <script src="/operator.js" defer></script>
</body>
</html>`;

export const OPERATOR_CSS = `
:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; background: #0b0d12; color: #eef1f8; }
button, input, select { font: inherit; }
.shell { max-width: 1180px; margin: 0 auto; padding: 32px 20px 64px; }
.header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.eyebrow { margin: 0 0 8px; color: #9aa4b7; font-size: 12px; letter-spacing: .16em; }
h1 { margin: 0; font-size: clamp(28px, 4vw, 44px); }
.muted, .status { color: #9aa4b7; }
button { border: 1px solid #343b4a; border-radius: 10px; background: #191e29; color: inherit; padding: 10px 14px; cursor: pointer; }
button:disabled { opacity: .55; cursor: default; }
.summary { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 12px; margin: 24px 0; }
.metric, .card { border: 1px solid #252c39; background: #11151d; border-radius: 14px; }
.metric { padding: 14px; }
.metric strong { display: block; margin-top: 6px; font-size: 24px; }
.controls { display: grid; grid-template-columns: 1fr auto 1.5fr; gap: 14px; align-items: end; margin-bottom: 18px; }
.controls label { display: grid; gap: 6px; color: #b8c0cf; font-size: 13px; }
.controls .check { display: flex; align-items: center; padding-bottom: 10px; }
input, select { width: 100%; border: 1px solid #343b4a; border-radius: 9px; background: #0f131b; color: inherit; padding: 9px 10px; }
.signals { display: grid; gap: 12px; }
.card { padding: 16px; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.badges { display: flex; flex-wrap: wrap; gap: 7px; }
.badge { border: 1px solid #3a4252; border-radius: 999px; padding: 3px 8px; font-size: 12px; text-transform: uppercase; }
.badge-critical { border-color: #8d3544; }
.badge-warning { border-color: #8a6e32; }
.badge-feedback { border-color: #365f8e; }
.ids { display: grid; gap: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #aeb8ca; overflow-wrap: anywhere; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 12px; margin-top: 12px; }
.panel { border-top: 1px solid #252c39; padding-top: 12px; }
.panel h2 { margin: 0 0 8px; font-size: 14px; }
.reason-list, .detail-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.detail { border-left: 2px solid #343b4a; padding-left: 9px; white-space: pre-wrap; overflow-wrap: anywhere; }
.empty { border: 1px dashed #343b4a; border-radius: 14px; padding: 28px; color: #9aa4b7; text-align: center; }
@media (max-width: 760px) { .summary { grid-template-columns: repeat(2,1fr); } .controls, .grid { grid-template-columns: 1fr; } .header { align-items: stretch; flex-direction: column; } }
`;

export const OPERATOR_JS = `(() => {
  'use strict';

  const summaryNode = document.getElementById('summary');
  const signalsNode = document.getElementById('signals');
  const generatedNode = document.getElementById('generated');
  const statusNode = document.getElementById('status');
  const refreshButton = document.getElementById('refresh');
  const prioritySelect = document.getElementById('priority');
  const activeOnlyInput = document.getElementById('active-only');
  const searchInput = document.getElementById('search');
  let snapshot = null;

  refreshButton.textContent = 'Làm mới';

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function replaceChildren(target, children) {
    while (target.firstChild) target.removeChild(target.firstChild);
    for (const child of children) target.appendChild(child);
  }

  function reasonEntries(feedback) {
    if (!feedback || !feedback.countsByReason) return [];
    return Object.entries(feedback.countsByReason).sort(([left], [right]) => left.localeCompare(right));
  }

  function searchableText(signal) {
    const reasons = reasonEntries(signal.feedback).map(([reason]) => reason).join(' ');
    return [signal.publicationId, signal.publicationVersionId, signal.monitoringAlert && signal.monitoringAlert.alertCode, reasons]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  }

  function passesFilters(signal) {
    const priority = prioritySelect.value;
    if (priority !== 'all' && signal.priority !== priority) return false;
    if (activeOnlyInput.checked && !signal.isActiveVersion) return false;
    const query = searchInput.value.trim().toLowerCase();
    return !query || searchableText(signal).includes(query);
  }

  function renderSummary(value) {
    const metrics = [
      ['Critical', value.summary.critical],
      ['Warning', value.summary.warning],
      ['Feedback only', value.summary.feedbackOnly],
      ['Tổng', value.summary.total],
    ].map(([label, count]) => {
      const card = node('div', 'metric');
      card.appendChild(node('span', 'muted', label));
      card.appendChild(node('strong', '', count));
      return card;
    });
    replaceChildren(summaryNode, metrics);
  }

  function monitoringPanel(alert) {
    const panel = node('section', 'panel');
    panel.appendChild(node('h2', '', 'Monitoring'));
    panel.appendChild(node('p', 'muted', alert.alertCode));
    panel.appendChild(node('p', '', 'Eligibility: ' + (alert.eligibilityOutcome || 'n/a')));
    if (alert.eligibilityReason) panel.appendChild(node('p', 'muted', alert.eligibilityReason));
    panel.appendChild(node('p', 'muted', 'Đánh giá: ' + alert.evaluatedAt));
    return panel;
  }

  function feedbackPanel(feedback) {
    const panel = node('section', 'panel');
    panel.appendChild(node('h2', '', 'Feedback (' + feedback.totalCount + ')'));
    const reasons = node('ul', 'reason-list');
    for (const [reason, count] of reasonEntries(feedback)) {
      reasons.appendChild(node('li', '', reason + ': ' + count));
    }
    panel.appendChild(reasons);

    if (feedback.recentDetails.length > 0) {
      const details = node('ul', 'detail-list');
      for (const detail of feedback.recentDetails) {
        const item = node('li', 'detail');
        item.appendChild(node('strong', '', detail.reasonCode));
        item.appendChild(node('div', '', detail.details));
        item.appendChild(node('small', 'muted', detail.receivedAt));
        details.appendChild(item);
      }
      panel.appendChild(details);
    }
    return panel;
  }

  function signalCard(signal) {
    const card = node('article', 'card');
    const head = node('div', 'card-head');
    const badges = node('div', 'badges');
    badges.appendChild(node('span', 'badge badge-' + signal.priority, signal.priority));
    if (!signal.isActiveVersion) badges.appendChild(node('span', 'badge', 'historical version'));
    head.appendChild(badges);
    head.appendChild(node('span', 'muted', signal.feedback ? signal.feedback.newestReceivedAt : signal.monitoringAlert.evaluatedAt));
    card.appendChild(head);

    const ids = node('div', 'ids');
    ids.appendChild(node('span', '', 'Publication: ' + signal.publicationId));
    ids.appendChild(node('span', '', 'Version: ' + signal.publicationVersionId));
    card.appendChild(ids);

    const grid = node('div', 'grid');
    if (signal.monitoringAlert) grid.appendChild(monitoringPanel(signal.monitoringAlert));
    if (signal.feedback) grid.appendChild(feedbackPanel(signal.feedback));
    card.appendChild(grid);
    return card;
  }

  function renderSignals() {
    if (!snapshot) return;
    const visible = snapshot.signals.filter(passesFilters);
    if (visible.length === 0) {
      replaceChildren(signalsNode, [node('div', 'empty', 'Không có tín hiệu phù hợp bộ lọc.')]);
      return;
    }
    replaceChildren(signalsNode, visible.map(signalCard));
  }

  function render(value) {
    snapshot = value;
    generatedNode.textContent = 'Snapshot: ' + value.generatedAt + ' · cửa sổ ' + value.sinceHours + ' giờ';
    renderSummary(value);
    renderSignals();
  }

  async function loadSnapshot() {
    refreshButton.disabled = true;
    statusNode.textContent = 'Đang tải snapshot…';
    try {
      const response = await fetch('/api/operator/v1/snapshot', { method: 'GET', cache: 'no-store' });
      if (!response.ok) throw new Error('snapshot unavailable');
      render(await response.json());
      statusNode.textContent = '';
    } catch {
      statusNode.textContent = 'Không thể tải operator snapshot. Kiểm tra PostgreSQL và thử lại.';
    } finally {
      refreshButton.disabled = false;
    }
  }

  refreshButton.addEventListener('click', loadSnapshot);
  prioritySelect.addEventListener('change', renderSignals);
  activeOnlyInput.addEventListener('change', renderSignals);
  searchInput.addEventListener('input', renderSignals);
  loadSnapshot();
})();
`;
