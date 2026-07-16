"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChampionGuide,
  CommunityBuild,
  Role,
  championIcon,
  championSplash,
  champions,
  communityModerationStats,
  communitySourceStats,
  communityWatchStats,
  roles,
  sourceSync,
} from "./data";

const tierOrder = { SSS: 5, SS: 4, S: 3, A: 2, B: 1 } as const;
const totalBuilds = champions.reduce((total, champion) => total + 1 + (champion.communityBuilds?.length ?? 0), 0);
const augmentCount = new Set(champions.flatMap((champion) => [
  ...champion.coreAugments,
  ...champion.prismatic,
  ...champion.gold,
  ...champion.silver,
].map((augment) => augment.id ?? augment.cn))).size;
const itemCount = new Set(champions.flatMap((champion) => (champion.itemData ?? []).map((item) => item.id ?? item.original))).size;

function formatSourceDate(value?: string) {
  if (!value) return "Không ghi ngày";
  const parsed = new Date(value.includes("T") ? value : `${value}T00:00:00+07:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString("vi-VN");
}

function SearchIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>;
}

function LogoIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 8 4.6v10.8L12 22l-8-4.6V6.6L12 2Z" /><path d="m9 8 6 8M15 8l-6 8" /></svg>;
}

function HeartIcon({ filled = false }: { filled?: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" className={filled ? "filled" : ""}><path d="M20.8 4.7a5.5 5.5 0 0 0-7.8 0L12 5.8l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.4 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" /></svg>;
}

function CloseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

function BackIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>;
}

function ExternalIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9" /></svg>;
}

function CheckIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>;
}

function AlertIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.8 20h18.4L12 3Z" /><path d="M12 9v5m0 3h.01" /></svg>;
}

function GridIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>;
}

function ChampionCard({
  champion,
  favorite,
  onOpen,
  onFavorite,
}: {
  champion: ChampionGuide;
  favorite: boolean;
  onOpen: () => void;
  onFavorite: () => void;
}) {
  const buildCount = 1 + (champion.communityBuilds?.length ?? 0);
  return (
    <article className="champion-card">
      <button className="champion-open" type="button" onClick={onOpen} aria-label={`Mở hướng dẫn ${champion.name}`}>
        <span className="champion-build-count">{buildCount}</span>
        <span className={`tier-badge tier-${champion.tier.toLowerCase()}`}>{champion.tier}</span>
        <img src={championIcon(champion)} alt="" loading="lazy" />
        <strong>{champion.name}</strong>
        <small>{champion.role}</small>
      </button>
      <button
        className="favorite-button"
        type="button"
        aria-label={favorite ? `Bỏ lưu ${champion.name}` : `Lưu ${champion.name}`}
        aria-pressed={favorite}
        onClick={onFavorite}
      >
        <HeartIcon filled={favorite} />
      </button>
    </article>
  );
}

function AssetTile({
  name,
  original,
  icon,
  index,
  tone = "normal",
}: {
  name: string;
  original: string;
  icon?: string;
  index?: number;
  tone?: "core" | "backup" | "normal";
}) {
  return (
    <div className={`asset-tile ${tone}`} title={original}>
      {index !== undefined && <span className="asset-index">{index}</span>}
      {icon ? <img src={icon} alt="" loading="lazy" /> : <span className="asset-placeholder"><LogoIcon /></span>}
      <span><b>{name}</b><small>{original}</small></span>
    </div>
  );
}

function CommunityBuildCard({ build }: { build: CommunityBuild }) {
  const automatic = Boolean(build.checkedAt);
  const statusClass = build.status === "Tự động đối chiếu" || build.status === "Đã đối chiếu" ? "verified" : "review";
  return (
    <article className={`build-card community-build-card ${statusClass}`}>
      <div className="build-card-heading">
        <span className={`grade-badge ${statusClass}`}>{build.status === "Cần kiểm chứng" ? "?" : "S"}</span>
        <div><h4>{build.title}</h4><small>{build.titleOriginal}</small></div>
        <span className={`status-pill ${statusClass}`}>{build.status}</span>
      </div>
      <p className="build-summary">{build.summary}</p>
      <div className="build-assets">
        <div className="asset-group core-group">
          <span className="asset-group-label">Lõi chính</span>
          <div>{build.coreAugments.map((augment) => <AssetTile key={augment.cn} name={augment.vi} original={augment.cn} icon={augment.icon} tone="core" />)}</div>
        </div>
        {build.itemData.length > 0 && (
          <div className="item-order">
            {build.itemData.map((item, index) => <AssetTile key={`${item.original}-${index}`} name={item.name} original={item.original} icon={item.icon} index={index + 1} />)}
          </div>
        )}
      </div>
      {automatic && (
        <div className="community-proof" aria-label="Bằng chứng kiểm duyệt tự động">
          <b>{build.approvalLabel ?? "Cần kiểm chứng lại"}</b>
          <small>Đối chiếu {formatSourceDate(build.checkedAt)} · Bản {build.patch}</small>
          <ul>{build.decisionReasons?.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          <p>Điểm và tương tác chỉ dùng cho kiểm duyệt; không phải tỷ lệ thắng.</p>
        </div>
      )}
      <div className="source-links compact">
        {build.sources.map((source) => (
          <a href={source.url} target="_blank" rel="noreferrer" key={source.url}>
            <span><b>{source.platform}</b><small>{source.kind} · {formatSourceDate(source.publishedAt)}</small></span>
            <ExternalIcon />
          </a>
        ))}
      </div>
    </article>
  );
}

function AugmentTier({
  title,
  className,
  augments,
  selected,
  onPick,
}: {
  title: string;
  className: string;
  augments: ChampionGuide["gold"];
  selected: string[];
  onPick: (name: string) => void;
}) {
  return (
    <div className="augment-tier">
      <span className={`rarity-label ${className}`}>{title}</span>
      <div className="augment-tier-list">
        {augments.map((augment) => (
          <button
            type="button"
            key={augment.cn}
            className={selected.includes(augment.vi) ? "selected" : ""}
            aria-pressed={selected.includes(augment.vi)}
            onClick={() => onPick(augment.vi)}
            title={augment.cn}
          >
            {augment.icon ? <img src={augment.icon} alt="" loading="lazy" /> : <span><LogoIcon /></span>}
            <b>{augment.vi}</b>
            <small>{augment.cn}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

function GuideDrawer({
  champion,
  favorite,
  onClose,
  onFavorite,
}: {
  champion: ChampionGuide;
  favorite: boolean;
  onClose: () => void;
  onFavorite: () => void;
}) {
  const [picks, setPicks] = useState<string[]>([]);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const communityBuilds = champion.communityBuilds ?? [];
  const coreNames = new Set(champion.coreAugments.map((augment) => augment.cn));
  const backupAugments = [...champion.prismatic, ...champion.gold, ...champion.silver]
    .filter((augment, index, values) => !coreNames.has(augment.cn) && values.findIndex((entry) => entry.cn === augment.cn) === index)
    .slice(0, 4);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    const keepFocusInside = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])') ?? []);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keepFocusInside);
    return () => {
      document.removeEventListener("keydown", keepFocusInside);
      previouslyFocused?.focus();
    };
  }, []);

  function togglePick(name: string) {
    setPicks((current) => current.includes(name)
      ? current.filter((item) => item !== name)
      : current.length >= 3 ? [...current.slice(1), name] : [...current, name]);
  }

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={drawerRef}
        className="guide-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Hướng dẫn ${champion.name}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer-topbar">
          <button ref={closeButtonRef} className="drawer-close" type="button" onClick={onClose} aria-label="Đóng hướng dẫn"><BackIcon /></button>
          <strong>{champion.name}</strong>
          <button className={`drawer-favorite ${favorite ? "active" : ""}`} type="button" aria-label={favorite ? `Bỏ lưu ${champion.name}` : `Lưu ${champion.name}`} aria-pressed={favorite} onClick={onFavorite}><HeartIcon filled={favorite} /></button>
        </header>

        <div className="drawer-scroll">
          <section className="champion-detail-hero">
            <img className="detail-splash" src={championSplash(champion)} alt="" />
            <div className="detail-hero-shade" />
            <div className="detail-hero-content">
              <img src={championIcon(champion)} alt={`Chân dung ${champion.name}`} />
              <div><span className={`tier-inline tier-${champion.tier.toLowerCase()}`}>{champion.tier}</span><h2>{champion.name}</h2><p>{champion.title}</p></div>
              <div className="detail-tags"><span>{champion.role}</span><span>{1 + communityBuilds.length} lối chơi</span></div>
            </div>
          </section>

          <nav className="detail-tabs" aria-label="Điều hướng hướng dẫn tướng">
            <a href="#builds">Lối lên đồ</a>
            <a href="#augments">Lõi ưu tiên</a>
            <a href="#notes">Cách chơi</a>
            <a href="#sources">Nguồn</a>
          </nav>

          <div className="drawer-content">
            <section id="builds" className="detail-section">
              <div className="detail-section-heading"><span>◆</span><div><h3>Lối lên đồ</h3><p>{1 + communityBuilds.length} phương án đã gộp, không lặp build trùng</p></div></div>
              <article className="build-card primary-build-card">
                <div className="build-card-heading">
                  <span className={`grade-badge grade-${champion.buildGrade.toLowerCase()}`}>{champion.buildGrade}</span>
                  <div><h4>{champion.buildName}</h4><small>{champion.buildOriginal}</small></div>
                  <span className="status-pill source">Hải Đấu</span>
                </div>
                <div className="build-tags"><span>{champion.role}</span><span>{champion.coreAugments.length} lõi chính</span><span>{champion.items.length} món gợi ý</span></div>
                <p className="build-summary">{champion.summary}</p>
                <div className="build-assets">
                  <div className="augment-groups">
                    <div className="asset-group core-group">
                      <span className="asset-group-label">Lõi chính</span>
                      <div>{champion.coreAugments.map((augment) => <AssetTile key={augment.cn} name={augment.vi} original={augment.cn} icon={augment.icon} tone="core" />)}</div>
                    </div>
                    {backupAugments.length > 0 && (
                      <div className="asset-group backup-group">
                        <span className="asset-group-label">Ưu tiên thêm</span>
                        <div>{backupAugments.map((augment) => <AssetTile key={augment.cn} name={augment.vi} original={augment.cn} icon={augment.icon} tone="backup" />)}</div>
                      </div>
                    )}
                  </div>
                  <div className="item-order">
                    {champion.items.map((item, index) => {
                      const asset = champion.itemData?.[index];
                      return <AssetTile key={`${item}-${index}`} name={item} original={asset?.original ?? item} icon={asset?.icon} index={index + 1} />;
                    })}
                  </div>
                </div>
                {champion.alternatives.length > 0 && <div className="alternate-list"><span>Hướng khác</span>{champion.alternatives.map((alternative) => <b key={alternative}>{alternative}</b>)}</div>}
              </article>
              {communityBuilds.map((build) => <CommunityBuildCard build={build} key={build.canonicalKey} />)}
            </section>

            <section id="augments" className="detail-section augment-section">
              <div className="detail-section-heading"><span>✦</span><div><h3>Lõi ưu tiên</h3><p>Thứ tự từ trái sang phải; chạm tối đa 3 lõi để ghi nhớ trong trận</p></div></div>
              {picks.length > 0 && <div className="selected-augments"><span>Đã ghim</span>{picks.map((pick, index) => <b key={pick}>{index + 1}. {pick}</b>)}</div>}
              <AugmentTier title="Lăng kính" className="prismatic" augments={champion.prismatic} selected={picks} onPick={togglePick} />
              <AugmentTier title="Vàng" className="gold" augments={champion.gold} selected={picks} onPick={togglePick} />
              <AugmentTier title="Bạc" className="silver" augments={champion.silver} selected={picks} onPick={togglePick} />
            </section>

            <section id="notes" className="detail-section">
              <div className="detail-section-heading"><span>◇</span><div><h3>Cách chơi</h3><p>Tương tác nên tận dụng và bẫy cần tránh</p></div></div>
              <div className="notes-grid">
                <article className="note-card good"><span><CheckIcon /></span><div><h4>Nên tận dụng</h4>{champion.tips.map((tip) => <p key={tip}>{tip}</p>)}</div></article>
                <article className="note-card warning"><span><AlertIcon /></span><div><h4>Cần tránh</h4>{champion.traps.map((trap) => <p key={trap}>{trap}</p>)}</div></article>
              </div>
            </section>

            <section id="sources" className="detail-section">
              <div className="detail-section-heading"><span>↗</span><div><h3>Nguồn</h3><p>Giữ nguyên tên Trung Quốc để đối chiếu bản dịch</p></div></div>
              {(champion.summaryOriginal || champion.sourceNotes?.length || champion.alternativeOriginals?.length) && (
                <details className="original-notes">
                  <summary>Xem nội dung gốc tiếng Trung</summary>
                  {champion.summaryOriginal && <p>{champion.summaryOriginal}</p>}
                  {champion.sourceNotes?.map((note) => <p key={note}>{note}</p>)}
                  {champion.alternativeOriginals?.map((note) => <p key={note}>变体：{note}</p>)}
                </details>
              )}
              <div className="source-links">
                <a href={champion.source} target="_blank" rel="noreferrer"><span><b>海斗小助手</b><small>Cập nhật nguồn: {champion.sourceModified ?? "không ghi ngày"}</small></span><ExternalIcon /></a>
                <a href="https://www.communitydragon.org/" target="_blank" rel="noreferrer"><span><b>Riot / CommunityDragon</b><small>Đối chiếu tên, ID và ảnh trong client</small></span><ExternalIcon /></a>
              </div>
            </section>
          </div>
        </div>
      </section>
    </div>
  );
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<Role>("Tất cả");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [selected, setSelected] = useState<ChampionGuide | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem("loi-meta-favorites");
    if (!saved) return;
    let frame: number | undefined;
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) frame = window.requestAnimationFrame(() => setFavorites(parsed));
    } catch {
      window.localStorage.removeItem("loi-meta-favorites");
    }
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === "Escape") setSelected(null);
      if (event.key === "/" && !target?.matches("input, textarea, select, [contenteditable='true']")) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = selected ? "hidden" : "";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [selected]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("vi");
    return champions
      .filter((champion) => role === "Tất cả" || champion.role === role)
      .filter((champion) => !favoritesOnly || favorites.includes(champion.id))
      .filter((champion) => !normalized || [
        champion.name,
        champion.title,
        champion.buildName,
        champion.buildOriginal,
        ...champion.aliases,
        ...champion.coreAugments.flatMap((augment) => [augment.vi, augment.cn]),
        ...(champion.communityBuilds ?? []).flatMap((build) => [build.title, build.titleOriginal]),
      ].join(" ").toLocaleLowerCase("vi").includes(normalized))
      .sort((left, right) => tierOrder[right.tier] - tierOrder[left.tier] || left.name.localeCompare(right.name, "vi"));
  }, [favorites, favoritesOnly, query, role]);

  function toggleFavorite(id: string) {
    setFavorites((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
      window.localStorage.setItem("loi-meta-favorites", JSON.stringify(next));
      return next;
    });
  }

  return (
    <main id="main-content">
      <a className="skip-link" href="#champions">Đi thẳng tới kho tướng</a>
      <header className="site-header" id="top">
        <a className="brand" href="#top" aria-label="Lõi Meta - Trang chủ"><span className="brand-mark"><LogoIcon /></span><span><b>LÕI.META</b><small>ARAM: MAYHEM</small></span></a>
        <nav aria-label="Điều hướng chính"><a href="#champions">Kho tướng</a><a href="#community-sources">Kiểm duyệt</a><a href="#guide-overview">Cách dùng</a></nav>
      </header>

      <section className="discovery-panel" aria-labelledby="discovery-title">
        <div className="product-title"><span className="eyebrow">CẨM NANG ARAM: MAYHEM TIẾNG VIỆT</span><h1 id="discovery-title">Lõi<span>.Meta</span></h1><p>Tìm đúng tướng, xem ngay lõi chính và thứ tự trang bị.</p></div>
        <div className="metric-strip" aria-label="Quy mô dữ liệu">
          <span><b>{totalBuilds}</b><small>lối chơi</small></span>
          <span><b>{champions.length}</b><small>tướng</small></span>
          <span><b>{augmentCount}</b><small>lõi</small></span>
          <span><b>{itemCount}</b><small>trang bị</small></span>
        </div>
        <div className="search-box"><SearchIcon /><label className="sr-only" htmlFor="champion-search">Tìm tướng, build hoặc lõi</label><input ref={searchRef} id="champion-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm tướng, build hoặc lõi..." autoComplete="off" aria-controls="champion-grid" />{query ? <button type="button" onClick={() => setQuery("")} aria-label="Xóa tìm kiếm"><CloseIcon /></button> : <kbd aria-hidden="true">/</kbd>}</div>
        <nav className="content-tabs" aria-label="Nội dung trang"><a className="active" href="#champions">Kho tướng</a><a href="#guide-overview">Lối lên đồ</a><a href="#guide-overview">Lõi ưu tiên</a><a href="#guide-overview">Cách chơi</a><a href="#community-sources">Nguồn</a></nav>
      </section>

      <section className="champion-section" id="champions">
        <div className="section-heading-row"><div><span className="section-accent" /><h2>Kho tướng</h2></div><p><b>{filtered.length}</b> / {champions.length} tướng</p></div>
        <div className="filter-bar">
          <div className="role-tabs" aria-label="Lọc theo vai trò">{roles.map((item) => <button type="button" key={item} aria-pressed={role === item} className={role === item ? "active" : ""} onClick={() => setRole(item)}>{item}</button>)}</div>
          <button type="button" aria-pressed={favoritesOnly} className={`favorite-filter ${favoritesOnly ? "active" : ""}`} onClick={() => setFavoritesOnly((value) => !value)}><HeartIcon filled={favoritesOnly} />Đã lưu <span>{favorites.length}</span></button>
        </div>
        {filtered.length > 0 ? (
          <div className="champion-grid" id="champion-grid">{filtered.map((champion) => <ChampionCard key={champion.id} champion={champion} favorite={favorites.includes(champion.id)} onOpen={() => setSelected(champion)} onFavorite={() => toggleFavorite(champion.id)} />)}</div>
        ) : (
          <div className="empty-state" role="status"><SearchIcon /><h3>Không tìm thấy tướng</h3><p>Thử tên khác hoặc bỏ bộ lọc hiện tại.</p><button type="button" onClick={() => { setQuery(""); setRole("Tất cả"); setFavoritesOnly(false); }}>Xóa bộ lọc</button></div>
        )}
      </section>

      <section className="guide-overview" id="guide-overview">
        <div className="section-heading-row"><div><span className="section-accent" /><h2>Đọc build trong vài giây</h2></div></div>
        <div className="guide-overview-grid"><article><b>01</b><h3>Lối lên đồ</h3><p>Lõi chính, lựa chọn dự phòng và thứ tự trang bị theo ID game.</p></article><article><b>02</b><h3>Lõi ưu tiên</h3><p>Danh sách Lăng kính, Vàng và Bạc theo thứ tự đã biên tập.</p></article><article><b>03</b><h3>Cách chơi</h3><p>Tương tác đáng dùng và các bẫy dễ chọn nhầm trong trận.</p></article><article><b>04</b><h3>Nguồn</h3><p>Tên Trung Quốc, ngày đối chiếu và liên kết công khai cụ thể.</p></article></div>
      </section>

      <section className="community-source-section" id="community-sources">
        <div className="section-heading-row"><div><span className="section-accent" /><h2>Kiểm duyệt cộng đồng</h2></div><p>Bản {communityModerationStats.currentPatch}</p></div>
        <div className="automation-watch">
          <div className="automation-status"><span className="live-dot" /><div><span className="eyebrow">KIỂM DUYỆT TỰ ĐỘNG ĐANG BẬT</span><h3>Chỉ đăng khi bằng chứng vượt đủ hàng rào an toàn</h3></div></div>
          <p>Hai đường được chấp nhận: <b>Hai nguồn độc lập</b> cùng nêu tổ hợp, hoặc <b>Nguồn uy tín + phản hồi tích cực</b>. Mọi lõi và trang bị phải khớp ID/ảnh trong client hiện hành.</p>
          <div className="moderation-rules"><span><CheckIcon />Không vượt đăng nhập/CAPTCHA</span><span><CheckIcon />Không sao chép bài hoặc transcript</span><span><AlertIcon />Không phải tỷ lệ thắng</span></div>
          <div className="automation-metrics" aria-label="Trạng thái kiểm duyệt"><span><b>{communityModerationStats.decisionCount}</b><small>quyết định hiện có</small></span><span><b>{communityModerationStats.automaticApprovedCount}</b><small>tự động đối chiếu</small></span><span><b>{communityModerationStats.observingCount}</b><small>đang quan sát</small></span><span><b>{communityModerationStats.needsVerificationCount}</b><small>cần kiểm chứng</small></span></div>
          <small className="automation-updated">Đối chiếu gần nhất: {formatSourceDate(communityModerationStats.generatedAt)} · Theo dõi {communityWatchStats.queryCount} nhóm truy vấn công khai.</small>
        </div>
        <div className="source-watch-grid">{communitySourceStats.globalSources.map((source) => <a href={source.url} target="_blank" rel="noreferrer" key={source.url}><div><span>{source.platform}</span><small>{source.kind}</small></div><h3>{source.title}</h3><p>{source.note}</p><footer><span>{formatSourceDate(source.publishedAt)}</span><ExternalIcon /></footer></a>)}</div>
      </section>

      <footer className="site-footer"><div className="footer-brand"><span className="brand-mark"><LogoIcon /></span><div><b>LÕI.META</b><p>Hướng dẫn ARAM: Mayhem bằng tiếng Việt.</p></div></div><p>Dự án cộng đồng, không được Riot Games bảo trợ. Đã đồng bộ {sourceSync.championCount} tướng từ phần công khai của Hải Đấu; tên và ảnh game được đối chiếu qua Riot/CommunityDragon.</p><nav><a href="https://lolhaidou.cn/" target="_blank" rel="noreferrer">Hải Đấu <ExternalIcon /></a><a href="https://www.communitydragon.org/" target="_blank" rel="noreferrer">CommunityDragon <ExternalIcon /></a></nav></footer>

      {selected && <GuideDrawer key={selected.id} champion={selected} favorite={favorites.includes(selected.id)} onFavorite={() => toggleFavorite(selected.id)} onClose={() => setSelected(null)} />}

      <nav className="mobile-nav" aria-label="Điều hướng nhanh"><a href="#top"><LogoIcon />Trang đầu</a><a href="#champions"><GridIcon />Kho tướng</a><button type="button" aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly((value) => !value)}><HeartIcon filled={favoritesOnly} />Đã lưu</button></nav>
    </main>
  );
}
