import { createHash } from "node:crypto";

import { countIndependentSources } from "./community-evidence-v2.mjs";

const VOLATILE_KEYS = new Set([
  "checkedAt",
  "generatedAt",
  "metrics",
  "signal",
  "views",
  "likes",
  "coins",
  "favorites",
  "comments",
]);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function patchMinor(value) {
  const match = String(value ?? "").match(/\b(?:16|26)\.(\d{1,2})\b/);
  return match ? Number(match[1]) : undefined;
}

function isCurrentPatch(candidate, currentPatch) {
  const candidateMinor = patchMinor(candidate.patchHint);
  const currentMinor = patchMinor(currentPatch);
  if (candidateMinor !== undefined && currentMinor !== undefined) return candidateMinor === currentMinor;
  return candidate.currentEnough !== false;
}

function sourceAgeHours(candidate, now) {
  const publishedAt = candidate.publishedAt;
  if (!publishedAt) return 0;
  const published = Date.parse(publishedAt.length === 10 ? `${publishedAt}T00:00:00.000Z` : publishedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(published) || !Number.isFinite(current)) return 0;
  return Math.max(0, (current - published) / 3_600_000);
}

function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (!union.size) return 1;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / union.size;
}

function buildSimilarity(left, right) {
  if (left.championMatches?.[0]?.id !== right.championMatches?.[0]?.id) return 0;
  const augmentSimilarity = jaccard(
    (left.augmentMatches ?? []).map((entry) => entry.id),
    (right.augmentMatches ?? []).map((entry) => entry.id),
  );
  const itemSimilarity = jaccard(
    (left.itemMatches ?? []).map((entry) => entry.id),
    (right.itemMatches ?? []).map((entry) => entry.id),
  );
  return (augmentSimilarity * 0.6) + (itemSimilarity * 0.4);
}

function positiveActions(metrics = {}) {
  return (finite(metrics.likes) ?? 0) + (finite(metrics.coins) ?? 0) + (finite(metrics.favorites) ?? 0);
}

function commentSample(comments = {}) {
  const positive = finite(comments.positive) ?? 0;
  const negative = finite(comments.negative) ?? 0;
  const neutral = finite(comments.neutral) ?? 0;
  const meaningful = finite(comments.meaningful) ?? positive + negative + neutral;
  return {
    positive,
    negative,
    neutral,
    meaningful,
    positiveRatio: meaningful > 0 ? positive / meaningful : 0,
    negativeRatio: meaningful > 0 ? negative / meaningful : 0,
  };
}

function exactEntries(entries = []) {
  return entries.every((entry) => entry?.id !== undefined && Boolean(entry?.icon));
}

function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE_KEYS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableClone(entry)]),
  );
}

function decisionSource(candidate) {
  return {
    platform: candidate.platform,
    url: candidate.url,
    title: candidate.title,
    author: candidate.author,
    publishedAt: candidate.publishedAt,
    metrics: candidate.metrics,
  };
}

export function parseSignalMetrics(signal = "") {
  const patterns = {
    views: /(\d[\d.,]*)\s*lượt xem/i,
    likes: /(\d[\d.,]*)\s*lượt thích/i,
    coins: /(\d[\d.,]*)\s*coin/i,
    favorites: /(\d[\d.,]*)\s*lượt lưu/i,
    comments: /(\d[\d.,]*)\s*bình luận/i,
  };
  const metrics = {};
  for (const [key, pattern] of Object.entries(patterns)) {
    const match = String(signal).match(pattern);
    if (!match) continue;
    const value = Number(match[1].replace(/[.,](?=\d{3}(?:\D|$))/g, "").replace(",", "."));
    if (Number.isFinite(value)) metrics[key] = value;
  }
  return metrics;
}

export function weightedEngagementRate(metrics = {}) {
  const views = finite(metrics.views);
  if (!views) return 0;
  return (
    (finite(metrics.likes) ?? 0)
    + 2 * (finite(metrics.coins) ?? 0)
    + 3 * (finite(metrics.favorites) ?? 0)
  ) / views;
}

export function buildSignature(candidate) {
  const championId = candidate.championMatches?.[0]?.id;
  if (!championId) return undefined;
  const augmentIds = [...(candidate.augmentMatches ?? [])]
    .map((entry) => entry.id)
    .filter((id) => id !== undefined)
    .sort((left, right) => Number(left) - Number(right));
  const itemIds = [...(candidate.itemMatches ?? [])]
    .map((entry) => entry.id)
    .filter((id) => id !== undefined)
    .sort((left, right) => Number(left) - Number(right));
  return `${championId}:${augmentIds.join("-")}:${itemIds.join("-")}`;
}

export function stableDecisionHash(value) {
  return createHash("sha256").update(JSON.stringify(stableClone(value))).digest("hex");
}

export function evaluateCandidate(candidate, context) {
  const moderation = context.policy?.moderation ?? {};
  const previousDecision = context.previousDecision;
  const checkedAt = context.now;
  const signature = candidate.signature ?? buildSignature(candidate);
  const sources = candidate.sources ?? [decisionSource(candidate)];
  const metrics = candidate.metrics ?? parseSignalMetrics(candidate.signal);
  const comments = commentSample(candidate.comments);
  const consecutiveFailures = candidate.accessState === "temporary-error"
    ? (previousDecision?.consecutiveFailures ?? 0) + 1
    : 0;

  if (candidate.accessState === "temporary-error" && previousDecision?.status === "auto-approved") {
    const demote = consecutiveFailures >= moderation.consecutiveFailureLimit;
    return {
      ...previousDecision,
      status: demote ? "needs-verification" : "auto-approved",
      checkedAt,
      consecutiveFailures,
      reasons: demote
        ? ["Nguồn lỗi trong hai lần quét liên tiếp"]
        : ["Nguồn tạm lỗi; giữ quyết định đã xác nhận trong một lần quét"],
    };
  }

  const hardGateFailures = [];
  if (candidate.modeValid === false) hardGateFailures.push("wrong-mode");
  if (!candidate.url || !candidate.author || !candidate.publishedAt) hardGateFailures.push("missing-source-metadata");
  if ((candidate.championMatches ?? []).length !== 1 || !exactEntries(candidate.championMatches)) hardGateFailures.push("invalid-champion-id");
  if (!(candidate.augmentMatches ?? []).length || !exactEntries(candidate.augmentMatches)) hardGateFailures.push("missing-augment-evidence");
  if (((candidate.itemMatches ?? []).length < 2 && !candidate.matchesKnownBuild) || !exactEntries(candidate.itemMatches)) {
    hardGateFailures.push("missing-item-evidence");
  }
  if (["locked", "captcha", "private"].includes(candidate.accessState)) hardGateFailures.push("inaccessible-source");
  if ((candidate.disqualifiers ?? []).length) hardGateFailures.push("disqualified-content");

  const currentPatch = isCurrentPatch(candidate, context.currentPatch);
  if (!currentPatch) hardGateFailures.push("stale-patch");

  const engagementRate = weightedEngagementRate(metrics);
  const engagementPass = (finite(metrics.views) ?? 0) >= moderation.minimumViews
    && positiveActions(metrics) >= moderation.minimumPositiveActions
    && engagementRate >= moderation.minimumWeightedEngagementRate;
  const hasCommentSample = comments.meaningful >= moderation.minimumCommentSample;
  const commentsPositive = hasCommentSample && comments.positiveRatio >= moderation.minimumPositiveCommentRatio;
  const commentsNegative = hasCommentSample && comments.negativeRatio >= moderation.demoteNegativeCommentRatio;
  const independentSourceCount = context.independentSourceCount ?? 1;

  let score = 0;
  if (!hardGateFailures.includes("invalid-champion-id")) score += 15;
  if (!hardGateFailures.includes("missing-augment-evidence")) score += 20;
  if (!hardGateFailures.includes("missing-item-evidence")) score += 15;
  if (currentPatch) score += 15;
  if (candidate.authorTier === "established") score += 10;
  if (independentSourceCount >= 2) score += 15;
  if (engagementPass) score += 15;
  if (commentsPositive) score += 5;
  score = Math.min(100, score);

  const reasons = [];
  if (independentSourceCount >= 2) reasons.push("Hai nguồn độc lập xác nhận cùng tổ hợp");
  if (candidate.authorTier === "established") reasons.push("Tác giả nằm trong danh sách nguồn uy tín");
  reasons.push(engagementPass ? "Tương tác công khai đạt ngưỡng" : "Tương tác tích cực chưa đạt ngưỡng");
  if (commentsPositive) reasons.push("Bình luận công khai nghiêng tích cực");

  if (commentsNegative) {
    return {
      signature,
      championId: candidate.championMatches?.[0]?.id,
      augmentIds: (candidate.augmentMatches ?? []).map((entry) => entry.id),
      itemIds: (candidate.itemMatches ?? []).map((entry) => entry.id),
      status: previousDecision?.status === "auto-approved" ? "needs-verification" : "rejected",
      approvalPath: previousDecision?.approvalPath,
      score,
      hardGateFailures,
      reasons: ["Phản hồi tiêu cực đã vượt ngưỡng an toàn"],
      sources,
      metrics,
      comments,
      patch: context.currentPatch,
      checkedAt,
      consecutiveFailures,
    };
  }

  if (!currentPatch && previousDecision?.status === "auto-approved") {
    return {
      ...previousDecision,
      status: "needs-verification",
      checkedAt,
      patch: context.currentPatch,
      hardGateFailures,
      reasons: ["Chưa được xác nhận lại cho bản hiện hành"],
      consecutiveFailures,
    };
  }

  const sourceAge = sourceAgeHours(candidate, context.now);
  const commentsAllowTrusted = !hasCommentSample || commentsPositive;
  const crossSourceApproval = hardGateFailures.length === 0
    && independentSourceCount >= 2
    && score >= moderation.crossSourceMinimumScore;
  const trustedCreatorApproval = hardGateFailures.length === 0
    && candidate.authorTier === "established"
    && sourceAge >= moderation.minimumSourceAgeHours
    && engagementPass
    && commentsAllowTrusted
    && score >= moderation.trustedCreatorMinimumScore;
  const approvalPath = crossSourceApproval
    ? "cross-source"
    : trustedCreatorApproval ? "trusted-creator" : undefined;

  return {
    signature,
    championId: candidate.championMatches?.[0]?.id,
    augmentIds: (candidate.augmentMatches ?? []).map((entry) => entry.id),
    itemIds: (candidate.itemMatches ?? []).map((entry) => entry.id),
    status: approvalPath ? "auto-approved" : "observing",
    approvalPath,
    score,
    hardGateFailures,
    reasons,
    sources,
    metrics,
    comments,
    patch: context.currentPatch,
    checkedAt,
    consecutiveFailures,
  };
}

export function moderateCandidates({ candidates, policy, currentPatch, now, previousDecisions = [] }) {
  const minimumSimilarity = policy?.moderation?.minimumSimilarity ?? 1;
  const groups = [];
  for (const candidate of candidates) {
    const group = groups.find((entries) => buildSimilarity(entries[0], candidate) >= minimumSimilarity);
    if (group) group.push(candidate);
    else groups.push([candidate]);
  }

  const previousBySignature = new Map(previousDecisions.map((decision) => [decision.signature, decision]));
  const decisions = groups.map((group) => {
    const sources = [...new Map(group.map((candidate) => [candidate.url, decisionSource(candidate)])).values()];
    const independentSourceCount = countIndependentSources(group);
    const representative = [...group].sort((left, right) => {
      if (left.authorTier === right.authorTier) return weightedEngagementRate(right.metrics) - weightedEngagementRate(left.metrics);
      return left.authorTier === "established" ? -1 : 1;
    })[0];
    const signature = buildSignature(representative);
    const decision = evaluateCandidate(
      { ...representative, signature, sources },
      {
        policy,
        currentPatch,
        now,
        independentSourceCount,
        previousDecision: previousBySignature.get(signature),
      },
    );
    return decision;
  });

  return {
    decisions: decisions.sort((left, right) => String(left.signature).localeCompare(String(right.signature))),
    contentHash: stableDecisionHash(decisions),
  };
}

function publishingIndexes(guides) {
  const guideById = new Map(guides.map((guide) => [guide.id, guide]));
  const augmentById = new Map();
  const augmentIdByCn = new Map();
  const itemById = new Map();
  const itemIdByCn = new Map();
  for (const guide of guides) {
    for (const augment of [...(guide.coreAugments ?? []), ...(guide.prismatic ?? []), ...(guide.gold ?? []), ...(guide.silver ?? [])]) {
      if (augment?.id === undefined) continue;
      if (!augmentById.has(augment.id)) augmentById.set(augment.id, augment);
      if (augment.cn && !augmentIdByCn.has(augment.cn)) augmentIdByCn.set(augment.cn, augment.id);
    }
    for (const item of guide.itemData ?? []) {
      if (item?.id === undefined) continue;
      if (!itemById.has(item.id)) itemById.set(item.id, item);
      if (item.original && !itemIdByCn.has(item.original)) itemIdByCn.set(item.original, item.id);
    }
  }
  return { guideById, augmentById, augmentIdByCn, itemById, itemIdByCn };
}

function recordSignature(record, indexes) {
  const augmentIds = (record.coreCn ?? []).map((cn) => indexes.augmentIdByCn.get(cn));
  const itemIds = (record.itemCn ?? []).map((cn) => indexes.itemIdByCn.get(cn));
  if (!record.championId || augmentIds.some((id) => id === undefined) || itemIds.some((id) => id === undefined)) return undefined;
  return buildSignature({
    championMatches: [{ id: record.championId }],
    augmentMatches: augmentIds.map((id) => ({ id })),
    itemMatches: itemIds.map((id) => ({ id })),
  });
}

function haiDauSignatures(guides) {
  const signatures = new Set();
  for (const guide of guides) {
    if (!(guide.coreAugments ?? []).length) continue;
    const signature = buildSignature({
      championMatches: [{ id: guide.id }],
      augmentMatches: guide.coreAugments,
      itemMatches: guide.itemData ?? [],
    });
    if (signature) signatures.add(signature);
  }
  return signatures;
}

export function generatePublishedRecords({ decisions, guides, curatedRecords = [] }) {
  const indexes = publishingIndexes(guides);
  const curatedSignatures = new Set(curatedRecords.map((record) => recordSignature(record, indexes)).filter(Boolean));
  const sourceSignatures = haiDauSignatures(guides);
  const occupiedKeys = new Set(curatedRecords.map((record) => `${record.championId}:${record.canonicalKey}`));
  const records = [];
  const skippedCollisions = [];
  const seenSignatures = new Set();

  for (const decision of decisions) {
    if (!new Set(["auto-approved", "needs-verification"]).has(decision.status)) continue;
    const signature = decision.signature;
    if (!signature || seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);
    if (curatedSignatures.has(signature) || sourceSignatures.has(signature)) {
      skippedCollisions.push({ signature, reason: curatedSignatures.has(signature) ? "curated-signature" : "haidou-signature" });
      continue;
    }

    const guide = indexes.guideById.get(decision.championId);
    const augments = (decision.augmentIds ?? []).map((id) => indexes.augmentById.get(id));
    const items = (decision.itemIds ?? []).map((id) => indexes.itemById.get(id));
    if (!guide || !augments.length || augments.some((entry) => !entry?.cn || !entry?.vi || !entry?.icon)) {
      throw new Error(`Quyết định ${signature} không còn khớp champion/lõi trong client hiện hành`);
    }
    if (items.length < 2 || items.some((entry) => !entry?.original || !entry?.name || !entry?.icon)) {
      throw new Error(`Quyết định ${signature} không còn khớp đủ trang bị trong client hiện hành`);
    }
    const canonicalKey = `auto-${stableDecisionHash(signature).slice(0, 12)}`;
    if (occupiedKeys.has(`${decision.championId}:${canonicalKey}`)) {
      skippedCollisions.push({ signature, reason: "canonical-key" });
      continue;
    }
    const coreCn = augments.map((entry) => entry.cn);
    const coreVi = augments.map((entry) => entry.vi);
    const championCn = (guide.aliases ?? []).find((alias) => /\p{Script=Han}/u.test(alias)) ?? guide.name;
    const sources = [...new Map((decision.sources ?? []).map((source) => [source.url, {
      platform: source.platform,
      kind: "Nguồn cộng đồng công khai",
      title: source.title,
      url: source.url,
      ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
    }])).values()];
    if (!sources.length || sources.some((source) => !source.platform || !source.title || !source.url)) {
      throw new Error(`Quyết định ${signature} thiếu nguồn công khai hợp lệ`);
    }
    const record = {
      championId: decision.championId,
      canonicalKey,
      relation: "candidate",
      title: `${coreVi.join(" + ")} — tổ hợp cộng đồng`,
      titleOriginal: `${championCn} · ${coreCn.join(" + ")}`,
      summary: `Các nguồn công khai cùng nêu tổ hợp ${coreVi.join(", ")} cho ${guide.name}. Hệ thống chỉ đối chiếu lõi và trang bị theo ID game; không suy diễn tỷ lệ thắng.`,
      coreCn,
      itemCn: items.map((entry) => entry.original),
      sources,
      automation: {
        status: decision.status,
        ...(decision.approvalPath ? { approvalPath: decision.approvalPath } : {}),
        checkedAt: decision.checkedAt,
        patch: decision.patch,
        reasons: [...(decision.reasons ?? [])],
        score: decision.score,
      },
    };
    records.push(record);
    occupiedKeys.add(`${decision.championId}:${canonicalKey}`);
  }

  records.sort((left, right) => `${left.championId}:${left.canonicalKey}`.localeCompare(`${right.championId}:${right.canonicalKey}`));
  return { records, skippedCollisions };
}

export function mergeCommunityRecords({ curated = [], generated = [] }) {
  const curatedKeys = new Set(curated.map((record) => `${record.championId}:${record.canonicalKey}`));
  return [
    ...curated,
    ...generated.filter((record) => !curatedKeys.has(`${record.championId}:${record.canonicalKey}`)),
  ];
}

export function validateGeneratedRecord(record) {
  if (!record?.automation || typeof record.automation !== "object") throw new Error("generated record thiếu automation");
  if (!new Set(["auto-approved", "needs-verification"]).has(record.automation.status)) throw new Error("automation.status không hợp lệ");
  if (record.automation.status === "auto-approved" && !new Set(["cross-source", "trusted-creator"]).has(record.automation.approvalPath)) {
    throw new Error("automation.approvalPath không hợp lệ");
  }
  if (!record.automation.checkedAt || Number.isNaN(Date.parse(record.automation.checkedAt))) throw new Error("automation.checkedAt không hợp lệ");
  if (!/^\d+\.\d+$/.test(record.automation.patch ?? "")) throw new Error("automation.patch không hợp lệ");
  if (!Array.isArray(record.automation.reasons) || !record.automation.reasons.length) throw new Error("automation.reasons không hợp lệ");
  if (!Number.isFinite(record.automation.score) || record.automation.score < 0 || record.automation.score > 100) throw new Error("automation.score không hợp lệ");
  return true;
}
