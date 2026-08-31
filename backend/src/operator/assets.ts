export const OPERATOR_HTML = `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hải Đấu — Operator Console</title>
  <link rel="stylesheet" href="/operator.css">
</head>
<body>
  <main class="shell">
    <header class="header">
      <div>
        <p class="eyebrow">HẢI ĐẤU / INTERNAL</p>
        <h1>Review & Operations</h1>
        <p id="generated" class="muted">Chưa tải snapshot.</p>
      </div>
      <button id="refresh" type="button">Làm mới</button>
    </header>

    <nav class="view-tabs" aria-label="Operator views">
      <button id="view-candidates" class="view-tab" type="button" aria-selected="true">Candidate review</button>
      <button id="view-signals" class="view-tab" type="button" aria-selected="false">Monitoring &amp; feedback</button>
    </nav>

    <p id="status" class="status" role="status"></p>

    <section id="candidate-view" aria-label="Candidate review queue">
      <section id="candidate-summary" class="summary" aria-label="Tóm tắt candidate"></section>

      <section class="controls candidate-controls" aria-label="Bộ lọc candidate">
        <label>
          Trạng thái review
          <select id="review-state">
            <option value="all">Tất cả</option>
            <option value="unreviewed">Chưa review</option>
            <option value="in_progress">Đang review</option>
          </select>
        </label>
        <label>
          Confidence band
          <select id="confidence-band">
            <option value="all">Tất cả</option>
            <option value="very_high">Very high</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
            <option value="unscored">Unscored</option>
          </select>
        </label>
        <label>
          Tìm cục bộ
          <input id="candidate-search" type="search" autocomplete="off" placeholder="Candidate / Revision / Subject / Entity ID">
        </label>
      </section>

      <section id="candidate-items" class="signals" aria-label="Candidate review items"></section>
    </section>

    <section id="signal-view" aria-label="Monitoring and feedback" hidden>
      <section id="summary" class="summary" aria-label="Tóm tắt tín hiệu"></section>

      <section class="controls" aria-label="Bộ lọc tín hiệu">
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

      <section id="signals" class="signals" aria-label="Danh sách tín hiệu"></section>
    </section>
  </main>
  <script src="/operator.js" defer></script>
</body>
</html>`;

export const OPERATOR_CSS = `
:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; background: #0b0d12; color: #eef1f8; }
button, input, select { font: inherit; }
[hidden] { display: none !important; }
.shell { max-width: 1180px; margin: 0 auto; padding: 32px 20px 64px; }
.header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.eyebrow { margin: 0 0 8px; color: #9aa4b7; font-size: 12px; letter-spacing: .16em; }
h1 { margin: 0; font-size: clamp(28px, 4vw, 44px); }
.muted, .status { color: #9aa4b7; }
button { border: 1px solid #343b4a; border-radius: 10px; background: #191e29; color: inherit; padding: 10px 14px; cursor: pointer; }
button:disabled { opacity: .55; cursor: default; }
.view-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin: 24px 0 0; }
.view-tab[aria-selected="true"] { border-color: #6f8fc7; background: #1d2b43; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px,1fr)); gap: 12px; margin: 24px 0; }
.metric, .card { border: 1px solid #252c39; background: #11151d; border-radius: 14px; }
.metric { padding: 14px; }
.metric strong { display: block; margin-top: 6px; font-size: 24px; }
.controls { display: grid; grid-template-columns: 1fr auto 1.5fr; gap: 14px; align-items: end; margin-bottom: 18px; }
.candidate-controls { grid-template-columns: 1fr 1fr 1.5fr; }
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
.badge-very_high { border-color: #3c8b74; }
.badge-high { border-color: #477eb5; }
.badge-medium { border-color: #8a6e32; }
.badge-low, .badge-unscored { border-color: #6b7280; }
.ids { display: grid; gap: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #aeb8ca; overflow-wrap: anywhere; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 12px; margin-top: 12px; }
.panel { border-top: 1px solid #252c39; padding-top: 12px; }
.panel h2 { margin: 0 0 8px; font-size: 14px; }
.component-list { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 6px 12px; margin: 0; padding: 0; list-style: none; }
.reason-list, .detail-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.detail { border-left: 2px solid #343b4a; padding-left: 9px; white-space: pre-wrap; overflow-wrap: anywhere; }
.empty { border: 1px dashed #343b4a; border-radius: 14px; padding: 28px; color: #9aa4b7; text-align: center; }
@media (max-width: 760px) { .summary { grid-template-columns: repeat(2,1fr); } .controls, .candidate-controls, .grid { grid-template-columns: 1fr; } .header { align-items: stretch; flex-direction: column; } }
`;

export const OPERATOR_JS = `(() => {
  'use strict';

  const candidateView = document.getElementById('candidate-view');
  const signalView = document.getElementById('signal-view');
  const candidateTab = document.getElementById('view-candidates');
  const signalTab = document.getElementById('view-signals');
  const candidateSummaryNode = document.getElementById('candidate-summary');
  const candidateItemsNode = document.getElementById('candidate-items');
  const reviewStateSelect = document.getElementById('review-state');
  const confidenceBandSelect = document.getElementById('confidence-band');
  const candidateSearchInput = document.getElementById('candidate-search');
  const summaryNode = document.getElementById('summary');
  const signalsNode = document.getElementById('signals');
  const generatedNode = document.getElementById('generated');
  const statusNode = document.getElementById('status');
  const refreshButton = document.getElementById('refresh');
  const prioritySelect = document.getElementById('priority');
  const activeOnlyInput = document.getElementById('active-only');
  const searchInput = document.getElementById('search');
  let candidateQueue = null;
  let publicationSnapshot = null;
  let activeView = 'candidates';
  let candidateRequestVersion = 0;
  let snapshotRequestVersion = 0;

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

  function metric(label, count) {
    const card = node('div', 'metric');
    card.appendChild(node('span', 'muted', label));
    card.appendChild(node('strong', '', count));
    return card;
  }

  function candidateBand(item) {
    return item.confidence ? item.confidence.band : 'unscored';
  }

  function candidateSearchableText(item) {
    return [
      item.candidateId,
      item.candidateRevisionId,
      item.patchId,
      item.catalogRevisionId,
      item.subjectExternalId,
      ...item.selection.augmentExternalIds,
      ...item.selection.itemExternalIds,
    ].join(' ').toLowerCase();
  }

  function candidatePassesFilters(item) {
    const reviewState = reviewStateSelect.value;
    if (reviewState !== 'all' && item.review.state !== reviewState) return false;
    const band = confidenceBandSelect.value;
    if (band !== 'all' && candidateBand(item) !== band) return false;
    const query = candidateSearchInput.value.trim().toLowerCase();
    return !query || candidateSearchableText(item).includes(query);
  }

  function renderCandidateSummary(queue) {
    replaceChildren(candidateSummaryNode, [
      metric('Returned', queue.summary.returned),
      metric('Unreviewed', queue.summary.unreviewed),
      metric('In progress', queue.summary.inProgress),
      metric('Very high', queue.summary.veryHigh),
      metric('High', queue.summary.high),
      metric('Medium', queue.summary.medium),
      metric('Low', queue.summary.low),
      metric('Unscored', queue.summary.unscored),
    ]);
  }

  function selectionPanel(item) {
    const panel = node('section', 'panel');
    panel.appendChild(node('h2', '', 'Selection'));
    panel.appendChild(node('p', '', 'Subject: ' + item.subjectExternalId));
    panel.appendChild(node('p', 'muted', 'Augments: ' + (item.selection.augmentExternalIds.join(', ') || 'none')));
    panel.appendChild(node('p', 'muted', 'Items: ' + (item.selection.itemExternalIds.join(', ') || 'none')));
    return panel;
  }

  function confidencePanel(confidence) {
    const panel = node('section', 'panel');
    panel.appendChild(node('h2', '', 'Confidence'));
    if (!confidence) {
      panel.appendChild(node('p', 'muted', 'Chưa có persisted confidence score.'));
      return panel;
    }
    panel.appendChild(node('p', '', 'Score: ' + confidence.score + ' / 90'));
    const components = node('ul', 'component-list');
    const values = [
      ['Provenance', confidence.components.provenanceQualityScore],
      ['Evidence diversity', confidence.components.evidenceDiversityScore],
      ['Patch alignment', confidence.components.patchAlignmentScore],
      ['Freshness', confidence.components.freshnessScore],
    ];
    for (const [label, value] of values) {
      components.appendChild(node('li', '', label + ': ' + value));
    }
    panel.appendChild(components);
    panel.appendChild(node('p', 'muted', 'Evaluated: ' + confidence.evaluatedAt));
    panel.appendChild(node('p', 'muted', 'Persisted: ' + confidence.createdAt));
    return panel;
  }

  function candidateCard(item) {
    const card = node('article', 'card');
    const head = node('div', 'card-head');
    const badges = node('div', 'badges');
    const band = candidateBand(item);
    badges.appendChild(node('span', 'badge badge-' + band, band));
    badges.appendChild(node('span', 'badge', item.review.state));
    head.appendChild(badges);
    head.appendChild(node('span', 'muted', item.createdAt));
    card.appendChild(head);

    const ids = node('div', 'ids');
    ids.appendChild(node('span', '', 'Candidate: ' + item.candidateId));
    ids.appendChild(node('span', '', 'Revision: ' + item.candidateRevisionId + ' (#' + item.revision + ')'));
    ids.appendChild(node('span', '', 'Patch: ' + item.patchId));
    ids.appendChild(node('span', '', 'Catalog: ' + item.catalogRevisionId));
    card.appendChild(ids);
    card.appendChild(node('p', '', 'Review progress: ' + item.review.confirmedCount + ' / ' + item.review.requiredCount));

    const grid = node('div', 'grid');
    grid.appendChild(selectionPanel(item));
    grid.appendChild(confidencePanel(item.confidence));
    card.appendChild(grid);
    return card;
  }

  function renderCandidateItems() {
    if (!candidateQueue) return;
    const visible = candidateQueue.items.filter(candidatePassesFilters);
    if (visible.length === 0) {
      replaceChildren(candidateItemsNode, [node('div', 'empty', 'Không có candidate phù hợp bộ lọc.')]);
      return;
    }
    replaceChildren(candidateItemsNode, visible.map(candidateCard));
  }

  function renderCandidateQueue(queue) {
    candidateQueue = queue;
    generatedNode.textContent = 'Candidate snapshot: ' + queue.generatedAt + ' · limit ' + queue.limit;
    renderCandidateSummary(queue);
    renderCandidateItems();
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
    ].map(([label, count]) => metric(label, count));
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
    if (!publicationSnapshot) return;
    const visible = publicationSnapshot.signals.filter(passesFilters);
    if (visible.length === 0) {
      replaceChildren(signalsNode, [node('div', 'empty', 'Không có tín hiệu phù hợp bộ lọc.')]);
      return;
    }
    replaceChildren(signalsNode, visible.map(signalCard));
  }

  function renderPublicationSnapshot(value) {
    publicationSnapshot = value;
    generatedNode.textContent = 'Snapshot: ' + value.generatedAt + ' · cửa sổ ' + value.sinceHours + ' giờ';
    renderSummary(value);
    renderSignals();
  }

  async function loadSnapshot() {
    const requestVersion = ++snapshotRequestVersion;
    if (activeView === 'signals') {
      refreshButton.disabled = true;
      statusNode.textContent = 'Đang tải snapshot…';
    }
    try {
      const response = await fetch('/api/operator/v1/snapshot', { method: 'GET', cache: 'no-store' });
      if (!response.ok) throw new Error('snapshot unavailable');
      const value = await response.json();
      if (requestVersion !== snapshotRequestVersion) return;
      publicationSnapshot = value;
      if (activeView === 'signals') {
        renderPublicationSnapshot(publicationSnapshot);
        statusNode.textContent = '';
      }
    } catch {
      if (activeView === 'signals' && requestVersion === snapshotRequestVersion) {
        statusNode.textContent = 'Không thể tải operator snapshot. Kiểm tra PostgreSQL và thử lại.';
      }
    } finally {
      if (activeView === 'signals' && requestVersion === snapshotRequestVersion) {
        refreshButton.disabled = false;
      }
    }
  }

  async function loadCandidateQueue() {
    const requestVersion = ++candidateRequestVersion;
    if (activeView === 'candidates') {
      refreshButton.disabled = true;
      statusNode.textContent = 'Đang tải candidate review queue…';
    }
    try {
      const response = await fetch('/api/operator/v1/candidate-review-queue', { method: 'GET', cache: 'no-store' });
      if (!response.ok) throw new Error('candidate queue unavailable');
      const value = await response.json();
      if (requestVersion !== candidateRequestVersion) return;
      candidateQueue = value;
      if (activeView === 'candidates') {
        renderCandidateQueue(candidateQueue);
        statusNode.textContent = '';
      }
    } catch {
      if (activeView === 'candidates' && requestVersion === candidateRequestVersion) {
        statusNode.textContent = 'Không thể tải candidate review queue. Kiểm tra PostgreSQL và thử lại.';
      }
    } finally {
      if (activeView === 'candidates' && requestVersion === candidateRequestVersion) {
        refreshButton.disabled = false;
      }
    }
  }

  function setActiveView(view) {
    activeView = view;
    const candidatesActive = view === 'candidates';
    candidateView.hidden = !candidatesActive;
    signalView.hidden = candidatesActive;
    candidateTab.setAttribute('aria-selected', String(candidatesActive));
    signalTab.setAttribute('aria-selected', String(!candidatesActive));
    statusNode.textContent = '';
    refreshButton.disabled = false;
    if (candidatesActive) {
      if (candidateQueue) renderCandidateQueue(candidateQueue);
      else loadCandidateQueue();
    } else if (publicationSnapshot) {
      renderPublicationSnapshot(publicationSnapshot);
    } else {
      loadSnapshot();
    }
  }

  refreshButton.addEventListener('click', () => {
    if (activeView === 'candidates') loadCandidateQueue();
    else loadSnapshot();
  });
  candidateTab.addEventListener('click', () => setActiveView('candidates'));
  signalTab.addEventListener('click', () => setActiveView('signals'));
  reviewStateSelect.addEventListener('change', renderCandidateItems);
  confidenceBandSelect.addEventListener('change', renderCandidateItems);
  candidateSearchInput.addEventListener('input', renderCandidateItems);
  prioritySelect.addEventListener('change', renderSignals);
  activeOnlyInput.addEventListener('change', renderSignals);
  searchInput.addEventListener('input', renderSignals);
  loadCandidateQueue();
})();
`;
