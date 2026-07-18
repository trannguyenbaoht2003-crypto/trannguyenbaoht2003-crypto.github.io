"use client";
/* eslint-disable @next/next/no-img-element */

import { useMemo, useState } from "react";
import Link from "next/link";

import styles from "./review.module.css";

export type CatalogEntry<Id extends string | number = string | number> = {
  id: Id;
  vi: string;
  cn: string;
  icon: string;
};

export type ReviewCatalog = {
  champions: CatalogEntry<string>[];
  augments: CatalogEntry<number>[];
  items: CatalogEntry<number>[];
};

type EvidenceEntry = { id: string | number; channels: string[] };

export type ReviewCandidate = {
  id: string;
  platform: string;
  url: string;
  title: string;
  author?: string;
  publishedAt?: string;
  status: string;
  evidenceReviewState: "image-review-required" | "translation-review-required";
  reasons: string[];
  championMatches: CatalogEntry<string>[];
  augmentMatches: CatalogEntry<number>[];
  itemMatches: CatalogEntry<number>[];
  entityEvidence: {
    champions: EvidenceEntry[];
    augments: EvidenceEntry[];
    items: EvidenceEntry[];
  };
  imageReferenceCount: number;
};

type ReviewDraft = {
  championId: string;
  augmentIds: number[];
  itemIds: number[];
  attested: boolean;
};

type Filter = "all" | "image" | "translation";

function unique<Id extends string | number>(values: Id[]) {
  return [...new Set(values)];
}

function initialDraft(candidate: ReviewCandidate): ReviewDraft {
  return {
    championId: candidate.championMatches.length === 1 ? candidate.championMatches[0].id : "",
    augmentIds: unique(candidate.augmentMatches.map((entry) => entry.id)),
    itemIds: unique(candidate.itemMatches.map((entry) => entry.id)),
    attested: false,
  };
}

function stateLabel(state: ReviewCandidate["evidenceReviewState"]) {
  return state === "image-review-required" ? "Chờ đối chiếu ảnh" : "Chờ đối chiếu bản dịch";
}

function normalizedSearch(value: string | number) {
  return String(value).normalize("NFKC").toLocaleLowerCase("vi-VN").trim();
}

function EntityPicker({
  title,
  requirement,
  entries,
  selected,
  single = false,
  onToggle,
}: {
  title: string;
  requirement: string;
  entries: CatalogEntry[];
  selected: (string | number)[];
  single?: boolean;
  onToggle: (id: string | number) => void;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const needle = normalizedSearch(query);
    return entries
      .filter((entry) => !needle || normalizedSearch(`${entry.vi} ${entry.cn} ${entry.id}`).includes(needle))
      .sort((left, right) => Number(selected.includes(right.id)) - Number(selected.includes(left.id)));
  }, [entries, query, selected]);

  return (
    <section className={styles.picker} aria-labelledby={`picker-${title}`}>
      <div className={styles.pickerHeading}>
        <div><h3 id={`picker-${title}`}>{title}</h3><p>{requirement}</p></div>
        <span>{selected.length} đã chọn</span>
      </div>
      <label className={styles.pickerSearch}>
        <span className="sr-only">Tìm trong {title}</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Tìm tên Việt, Trung hoặc ID ${title.toLocaleLowerCase("vi-VN")}...`}
          autoComplete="off"
        />
      </label>
      <div className={styles.entityGrid}>
        {visible.map((entry) => {
          const active = selected.includes(entry.id);
          const order = selected.indexOf(entry.id) + 1;
          return (
            <button
              className={active ? styles.entityActive : styles.entity}
              type="button"
              key={`${title}-${entry.id}`}
              aria-pressed={active}
              onClick={() => onToggle(entry.id)}
            >
              <span className={styles.entityImage}><img src={entry.icon} alt="" loading="lazy" />{active && !single && <b>{order}</b>}</span>
              <span><strong>{entry.vi}</strong><small>{entry.cn}</small><code>#{entry.id}</code></span>
            </button>
          );
        })}
        {visible.length === 0 && <p className={styles.noResults}>Không có ID phù hợp.</p>}
      </div>
    </section>
  );
}

function MatchList({ label, entries }: { label: string; entries: CatalogEntry[] }) {
  return (
    <div className={styles.matchGroup}>
      <b>{label}</b>
      <div>{entries.length ? entries.map((entry) => (
        <span key={`${label}-${entry.id}`}><img src={entry.icon} alt="" /><small>{entry.vi}<em>{entry.cn} · #{entry.id}</em></small></span>
      )) : <i>Chưa khớp ID</i>}</div>
    </div>
  );
}

export default function ReviewWorkbench({ candidates, catalog }: { candidates: ReviewCandidate[]; catalog: ReviewCatalog }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [candidateQuery, setCandidateQuery] = useState("");
  const [selectedId, setSelectedId] = useState(candidates[0]?.id ?? "");
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>(() => Object.fromEntries(
    candidates.map((candidate) => [candidate.id, initialDraft(candidate)]),
  ));
  const [packagedIds, setPackagedIds] = useState<string[]>([]);
  const [downloadMessage, setDownloadMessage] = useState("");

  const filteredCandidates = useMemo(() => {
    const needle = normalizedSearch(candidateQuery);
    return candidates.filter((candidate) => {
      const matchesFilter = filter === "all"
        || (filter === "image" && candidate.evidenceReviewState === "image-review-required")
        || (filter === "translation" && candidate.evidenceReviewState === "translation-review-required");
      const matchesQuery = !needle || normalizedSearch(`${candidate.title} ${candidate.platform} ${candidate.author ?? ""} ${candidate.id}`).includes(needle);
      return matchesFilter && matchesQuery;
    });
  }, [candidateQuery, candidates, filter]);
  const selected = candidates.find((candidate) => candidate.id === selectedId) ?? filteredCandidates[0];
  const draft = selected ? drafts[selected.id] : undefined;
  const isComplete = Boolean(draft?.championId)
    && (draft?.augmentIds.length ?? 0) >= 1
    && (draft?.itemIds.length ?? 0) >= 2
    && draft?.attested === true;

  function updateDraft(next: Partial<ReviewDraft>) {
    if (!selected || !draft) return;
    setDrafts((current) => ({ ...current, [selected.id]: { ...draft, ...next } }));
    setPackagedIds((current) => current.filter((id) => id !== selected.id));
    setDownloadMessage("");
  }

  function toggleNumber(field: "augmentIds" | "itemIds", id: number) {
    if (!draft) return;
    const values = draft[field];
    updateDraft({ [field]: values.includes(id) ? values.filter((value) => value !== id) : [...values, id] });
  }

  function addToPackage() {
    if (!selected || !isComplete) return;
    setPackagedIds((current) => unique([...current, selected.id]));
    setDownloadMessage(`${selected.title} đã sẵn sàng trong gói.`);
  }

  function downloadPackage() {
    const reviews = packagedIds.flatMap((candidateId) => {
      const candidate = candidates.find((entry) => entry.id === candidateId);
      const candidateDraft = drafts[candidateId];
      if (!candidate || !candidateDraft?.attested || !candidateDraft.championId || candidateDraft.augmentIds.length < 1 || candidateDraft.itemIds.length < 2) return [];
      return [{
        candidateId,
        url: candidate.url,
        championId: candidateDraft.championId,
        augmentIds: candidateDraft.augmentIds,
        itemIds: candidateDraft.itemIds,
        attested: true as const,
      }];
    });
    if (!reviews.length) return;
    const payload = {
      schemaVersion: 1,
      evidenceVersion: "3.1",
      generatedAt: new Date().toISOString(),
      reviews,
    };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "evidence-v31-review-package.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(href);
    setDownloadMessage(`Đã tải gói ${reviews.length} review. Gói vẫn phải nhập bằng CLI và qua moderation.`);
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/"><span>LÕI</span>.META</Link>
        <Link className={styles.backLink} href="/">← Về cẩm nang</Link>
      </header>

      <section className={styles.hero}>
        <span>EVIDENCE V3.1 · REVIEW WORKBENCH</span>
        <h1>Bảng duyệt Evidence v3.1</h1>
        <p>Đối chiếu nguồn công khai với tên Việt, tên Trung Quốc, ID và ảnh game hiện hành. <b>Không tự động đăng</b>: gói tải về vẫn phải được CLI xác minh và đi qua moderation.</p>
        <div className={styles.heroStats}>
          <span aria-label={`${candidates.length} ứng viên`}><b>{candidates.length}</b><small>ứng viên</small></span>
          <span><b>{candidates.filter((candidate) => candidate.evidenceReviewState === "image-review-required").length}</b><small>chờ ảnh</small></span>
          <span><b>{candidates.filter((candidate) => candidate.evidenceReviewState === "translation-review-required").length}</b><small>chờ bản dịch</small></span>
          <span><b>{catalog.champions.length + catalog.augments.length + catalog.items.length}</b><small>ID có ảnh</small></span>
        </div>
      </section>

      <section className={styles.workbench}>
        <aside className={styles.candidates} aria-label="Danh sách ứng viên Evidence v3.1">
          <div className={styles.asideHeading}><div><h2>Hàng chờ</h2><span>{filteredCandidates.length}/{candidates.length}</span></div><p>Chỉ metadata an toàn; mở nguồn để tự đối chiếu.</p></div>
          <label className={styles.candidateSearch}><span className="sr-only">Tìm ứng viên</span><input type="search" value={candidateQuery} onChange={(event) => setCandidateQuery(event.target.value)} placeholder="Tìm tiêu đề, tác giả, ID..." /></label>
          <div className={styles.filters} aria-label="Lọc hàng chờ">
            <button type="button" className={filter === "all" ? styles.filterActive : ""} onClick={() => setFilter("all")}>Tất cả</button>
            <button type="button" className={filter === "image" ? styles.filterActive : ""} onClick={() => setFilter("image")}>Chờ đối chiếu ảnh</button>
            <button type="button" className={filter === "translation" ? styles.filterActive : ""} onClick={() => setFilter("translation")}>Chờ đối chiếu bản dịch</button>
          </div>
          <div className={styles.candidateList}>
            {filteredCandidates.map((candidate) => (
              <button
                type="button"
                key={candidate.id}
                className={candidate.id === selected?.id ? styles.candidateActive : styles.candidate}
                onClick={() => setSelectedId(candidate.id)}
              >
                <span><b>{candidate.platform}</b><em>{stateLabel(candidate.evidenceReviewState)}</em></span>
                <strong>{candidate.title}</strong>
                <small>{candidate.author ?? "Không ghi tác giả"} · {candidate.publishedAt ?? "Không ghi ngày"}</small>
                <code>{candidate.id}</code>
              </button>
            ))}
            {filteredCandidates.length === 0 && <p className={styles.noCandidates}>Không có ứng viên phù hợp bộ lọc.</p>}
          </div>
        </aside>

        <section className={styles.editor} aria-live="polite">
          {selected && draft ? (
            <>
              <div className={styles.sourceCard}>
                <div><span>{stateLabel(selected.evidenceReviewState)}</span><code>{selected.id}</code></div>
                <h2>{selected.title}</h2>
                <p>{selected.platform} · {selected.author ?? "Không ghi tác giả"} · {selected.publishedAt ?? "Không ghi ngày"}</p>
                <div className={styles.sourceActions}><a href={selected.url} target="_blank" rel="noreferrer">Mở nguồn công khai ↗</a><span>{selected.imageReferenceCount} mã ảnh băm/tham chiếu</span></div>
              </div>

              <section className={styles.currentEvidence} aria-label="ID hệ thống đang khớp">
                <div className={styles.sectionTitle}><div><span>01</span><h2>ID đang khớp</h2></div><p>Đây là kết quả máy; không mặc định là kết luận đúng.</p></div>
                <div className={styles.matchGrid}>
                  <MatchList label="Tướng" entries={selected.championMatches} />
                  <MatchList label="Lõi" entries={selected.augmentMatches} />
                  <MatchList label="Trang bị" entries={selected.itemMatches} />
                </div>
                <details><summary>Xem lý do đưa vào hàng chờ</summary><ul>{selected.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></details>
              </section>

              <div className={styles.sectionTitle}><div><span>02</span><h2>Chọn ID chính xác</h2></div><p>Thứ tự lõi và trang bị được giữ nguyên trong gói.</p></div>
              <EntityPicker title="Tướng" requirement="Chọn đúng 1 tướng" entries={catalog.champions} selected={draft.championId ? [draft.championId] : []} single onToggle={(id) => updateDraft({ championId: String(id) })} />
              <EntityPicker title="Lõi" requirement="Ít nhất 1 lõi" entries={catalog.augments} selected={draft.augmentIds} onToggle={(id) => toggleNumber("augmentIds", Number(id))} />
              <EntityPicker title="Trang bị" requirement="Ít nhất 2 trang bị" entries={catalog.items} selected={draft.itemIds} onToggle={(id) => toggleNumber("itemIds", Number(id))} />

              <section className={styles.attestation}>
                <div><span>03</span><h2>Xác nhận đối chiếu</h2></div>
                <label><input type="checkbox" checked={draft.attested} onChange={(event) => updateDraft({ attested: event.target.checked })} /><span><b>Tôi đã đối chiếu</b> tướng, lõi và trang bị với URL công khai ở trên; không dựa vào phần khóa, CAPTCHA, nội dung riêng tư hoặc suy đoán.</span></label>
                <div className={styles.completion}>
                  <span className={draft.championId ? styles.done : ""}>1 tướng</span>
                  <span className={draft.augmentIds.length >= 1 ? styles.done : ""}>{draft.augmentIds.length} lõi</span>
                  <span className={draft.itemIds.length >= 2 ? styles.done : ""}>{draft.itemIds.length} trang bị</span>
                  <span className={draft.attested ? styles.done : ""}>Đã xác nhận</span>
                </div>
                <button type="button" className={styles.addButton} disabled={!isComplete} onClick={addToPackage}>{packagedIds.includes(selected.id) ? "Cập nhật trong gói" : "Thêm vào gói duyệt"}</button>
              </section>
            </>
          ) : <div className={styles.emptyEditor}><h2>Chưa có ứng viên</h2><p>Hàng chờ an toàn hiện đang trống.</p></div>}
        </section>
      </section>

      <section className={styles.packageTray} aria-label="Gói duyệt Evidence v3.1">
        <div><span>{packagedIds.length}</span><p><b>review trong gói</b><small>JSON chỉ chứa URL và ID có cấu trúc.</small></p></div>
        <ol>{packagedIds.map((id) => <li key={id}><code>{id}</code><button type="button" onClick={() => setPackagedIds((current) => current.filter((value) => value !== id))} aria-label={`Xóa ${id} khỏi gói`}>×</button></li>)}</ol>
        <div className={styles.packageAction}><button type="button" onClick={downloadPackage} disabled={packagedIds.length === 0}>Tải gói JSON</button><small>Sau đó chạy <code>npm run review:apply -- &lt;tệp.json&gt;</code></small></div>
      </section>
      <p className={styles.downloadStatus} role="status">{downloadMessage}</p>

      <footer className={styles.footer}><p>Evidence v3.1 không thay thế moderation, không tạo nguồn độc lập và không phải tỷ lệ thắng.</p><Link href="/">Lõi.Meta · ARAM: Mayhem</Link></footer>
    </main>
  );
}
