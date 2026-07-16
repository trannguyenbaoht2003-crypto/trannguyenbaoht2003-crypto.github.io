"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState } from "react";
import {
  ChampionGuide,
  Role,
  championIcon,
  championSplash,
  champions,
  communitySourceStats,
  communityWatchStats,
  roles,
  sourceSync,
} from "./data";

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const tierOrder = { SSS: 5, SS: 4, S: 3, A: 2, B: 1 } as const;

function formatSourceDate(value?: string) {
  if (!value) return "Không ghi ngày";
  const date = new Date(`${value}T00:00:00+07:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("vi-VN");
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

function HeartIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={filled ? "filled" : ""}>
      <path d="M20.8 4.7a5.5 5.5 0 0 0-7.8 0L12 5.8l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.4 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" />
    </svg>
  );
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
  return (
    <article className="champion-card" onClick={onOpen}>
      <div className="card-art">
        <img src={championSplash(champion)} alt="" loading="lazy" />
        <div className="card-art-shade" />
        <span className={`tier-badge tier-${champion.tier.toLowerCase()}`}>{champion.tier}</span>
        <button
          className="favorite-button"
          aria-label={favorite ? `Bỏ lưu ${champion.name}` : `Lưu ${champion.name}`}
          onClick={(event) => {
            event.stopPropagation();
            onFavorite();
          }}
        >
          <HeartIcon filled={favorite} />
        </button>
        <div className="card-name">
          <h3>{champion.name}</h3>
          <p>{champion.title}</p>
        </div>
      </div>
      <div className="card-body">
        <div className="card-label">Lõi trung tâm</div>
        <div className="card-core">
          {champion.coreAugments[0]?.icon && <img src={champion.coreAugments[0].icon} alt="" loading="lazy" />}
          <strong>{champion.coreAugments.map((augment) => augment.vi).join(" + ") || "Theo danh sách ưu tiên"}</strong>
        </div>
        <p>{champion.buildName}</p>
        <div className="card-footer">
          <span>{champion.role}</span>
          <button type="button">Xem hướng dẫn <span>→</span></button>
        </div>
      </div>
    </article>
  );
}

function AugmentRow({
  title,
  className,
  augments,
  onPick,
  selected,
}: {
  title: string;
  className: string;
  augments: ChampionGuide["gold"];
  onPick?: (name: string) => void;
  selected?: string[];
}) {
  return (
    <div className="augment-row">
      <div className={`augment-rarity ${className}`}>
        <span />
        {title}
      </div>
      <div className="augment-list">
        {augments.map((augment, index) => (
          <button
            type="button"
            key={augment.cn}
            className={`augment-chip ${selected?.includes(augment.vi) ? "selected" : ""}`}
            onClick={() => onPick?.(augment.vi)}
            title={augment.cn}
          >
            {augment.icon ? <img src={augment.icon} alt="" loading="lazy" /> : <b>{index + 1}</b>}
            <span>{augment.vi}<small>{augment.cn}</small></span>
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

  const priorities = useMemo(() => {
    const all = [...champion.prismatic, ...champion.gold, ...champion.silver];
    return picks
      .map((name) => ({ name, score: all.findIndex((augment) => augment.vi === name) }))
      .sort((left, right) => left.score - right.score);
  }, [champion, picks]);

  function togglePick(name: string) {
    setPicks((current) => {
      if (current.includes(name)) return current.filter((item) => item !== name);
      if (current.length === 3) return [...current.slice(1), name];
      return [...current, name];
    });
  }

  const communityBuilds = champion.communityBuilds ?? [];
  const detailedAlternativeOriginals = new Set(
    communityBuilds
      .map((build) => build.matchesAlternativeOriginal)
      .filter((value): value is string => Boolean(value)),
  );
  const visibleAlternatives = champion.alternatives.filter((_, index) => {
    const original = champion.alternativeOriginals?.[index];
    return !original || !detailedAlternativeOriginals.has(original);
  });
  const visibleAlternativeOriginals = champion.alternativeOriginals?.filter(
    (original) => !detailedAlternativeOriginals.has(original),
  ) ?? [];

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="guide-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Hướng dẫn ${champion.name}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="drawer-close" onClick={onClose} aria-label="Đóng hướng dẫn">
          <CloseIcon />
        </button>

        <header className="drawer-hero">
          <img src={championSplash(champion)} alt="" />
          <div className="drawer-hero-shade" />
          <div className="drawer-hero-content">
            <img className="drawer-icon" src={championIcon(champion)} alt={`Chân dung ${champion.name}`} />
            <div>
              <div className="drawer-kicker"><span className={`tier-inline tier-${champion.tier.toLowerCase()}`}>{champion.tier}</span> {champion.role}</div>
              <h2>{champion.name}</h2>
              <p>{champion.title}</p>
            </div>
            <button className={`drawer-favorite ${favorite ? "active" : ""}`} onClick={onFavorite}>
              <HeartIcon filled={favorite} /> {favorite ? "Đã lưu" : "Lưu tướng"}
            </button>
          </div>
        </header>

        <div className="drawer-content">
          <nav className="detail-jump" aria-label="Mục hướng dẫn">
            <a href="#build">Build</a>
            {communityBuilds.length > 0 && <a href="#community">Cộng đồng TQ</a>}
            <a href="#augments">Lõi ưu tiên</a>
            <a href="#compare">So sánh 3 lõi</a>
            <a href="#notes">Mẹo & tránh bẫy</a>
          </nav>

          <section id="build" className="detail-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Build trung tâm · hạng {champion.buildGrade}</span>
                <h3>{champion.buildName}</h3>
                <small>{champion.buildOriginal}</small>
              </div>
            </div>
            <p className="detail-summary">{champion.summary}</p>
            <div className="core-grid">
              <div className="core-panel">
                <span className="panel-label">Lõi bắt buộc / ưu tiên</span>
                {champion.coreAugments.map((augment) => (
                  <div className="core-augment" key={augment.cn}>
                    {augment.icon
                      ? <img className="augment-art" src={augment.icon} alt="" loading="lazy" />
                      : <span className="augment-gem">✦</span>}
                    <div><strong>{augment.vi}</strong><small>{augment.cn}</small></div>
                  </div>
                ))}
              </div>
              <div className="core-panel item-panel">
                <span className="panel-label">Thứ tự trang bị gợi ý</span>
                <div className="item-path">
                  {champion.items.map((item, index) => {
                    const asset = champion.itemData?.[index];
                    return (
                    <div className="item-step" key={item}>
                      {asset?.icon
                        ? <img src={asset.icon} alt="" loading="lazy" />
                        : <span>{index + 1}</span>}
                      <div><strong>{item}</strong>{asset?.original && <small>{asset.original}</small>}</div>
                    </div>
                    );
                  })}
                </div>
              </div>
            </div>
            {visibleAlternatives.length > 0 && (
              <div className="alternate-builds">
                <span>Các hướng khác</span>
                {visibleAlternatives.map((item) => <b key={item}>{item}</b>)}
              </div>
            )}
          </section>

          {communityBuilds.length > 0 && (
            <section id="community" className="detail-section community-section">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">Bilibili · Zhihu · Tieba · web Trung Quốc</span>
                  <h3>Lối chơi được cộng đồng nhắc đến</h3>
                </div>
                <p>Đã gộp theo tướng + lõi + trang bị</p>
              </div>
              <div className="community-caution">
                <b>Không phải bảng tỷ lệ thắng.</b> “Đã đối chiếu” nghĩa là lối chơi vẫn xuất hiện trong Hải Đấu hiện hành; “Cần kiểm chứng” là ý tưởng cộng đồng chưa có xác nhận sau bản {communitySourceStats.patchBaseline}.
              </div>
              <div className="community-build-list">
                {communityBuilds.map((build) => (
                  <article className={`community-build-card ${build.status === "Đã đối chiếu" ? "verified" : "review"}`} key={build.canonicalKey}>
                    <div className="community-build-topline">
                      <span className="community-relation">
                        {build.relation === "primary" ? "Đối chiếu build chính" : build.relation === "alternative" ? "Biến thể đã gộp" : "Gợi ý cộng đồng"}
                      </span>
                      <span className="community-status" title={build.statusNote}>{build.status}</span>
                    </div>
                    <h4>{build.title}</h4>
                    <small>{build.titleOriginal}</small>
                    <p>{build.summary}</p>
                    {build.coreAugments.length > 0 && (
                      <div className="community-assets">
                        <span>Lõi</span>
                        {build.coreAugments.map((augment) => (
                          <div className="community-asset" key={augment.cn} title={augment.cn}>
                            {augment.icon ? <img src={augment.icon} alt="" loading="lazy" /> : <i>✦</i>}
                            <b>{augment.vi}<small>{augment.cn}</small></b>
                          </div>
                        ))}
                      </div>
                    )}
                    {build.itemData.length > 0 ? (
                      <div className="community-assets items">
                        <span>Đồ được nguồn nêu rõ</span>
                        {build.itemData.map((item) => (
                          <div className="community-asset" key={item.original} title={item.original}>
                            {item.icon ? <img src={item.icon} alt="" loading="lazy" /> : <i>◇</i>}
                            <b>{item.name}<small>{item.original}</small></b>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="community-no-items">Nguồn này không ghi rõ đủ trang bị bằng chữ; giữ thứ tự đồ Hải Đấu ở phía trên.</p>
                    )}
                    <div className="community-source-links">
                      {build.sources.map((source) => (
                        <a href={source.url} target="_blank" rel="noreferrer" key={source.url}>
                          <b>{source.platform}</b>
                          <span>{source.kind} · {formatSourceDate(source.publishedAt)}</span>
                          {source.signal && <small>{source.signal}</small>}
                        </a>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          <section id="augments" className="detail-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Danh sách lựa chọn</span>
                <h3>Lõi ưu tiên theo phẩm</h3>
              </div>
              <p>Thứ tự từ trái sang phải</p>
            </div>
            <AugmentRow title="Lăng kính" className="prismatic" augments={champion.prismatic} onPick={togglePick} selected={picks} />
            <AugmentRow title="Vàng" className="gold" augments={champion.gold} onPick={togglePick} selected={picks} />
            <AugmentRow title="Bạc" className="silver" augments={champion.silver} onPick={togglePick} selected={picks} />
          </section>

          <section id="compare" className="compare-panel">
            <div>
              <span className="eyebrow">Chọn thủ công</span>
              <h3>So sánh 3 lõi đang xuất hiện</h3>
              <p>Chạm vào tối đa ba lõi ở danh sách phía trên. Công cụ xếp theo độ ưu tiên đã biên tập, không dùng tỷ lệ thắng giả.</p>
            </div>
            <div className="pick-slots">
              {[0, 1, 2].map((index) => (
                <div className={picks[index] ? "pick-slot filled" : "pick-slot"} key={index}>
                  <span>{index + 1}</span>{picks[index] ?? "Chọn một lõi"}
                </div>
              ))}
            </div>
            {picks.length >= 2 && (
              <div className="recommendation">
                <span>Ưu tiên chọn</span>
                <strong>{priorities[0]?.name}</strong>
                <p>Đây là lựa chọn nằm cao nhất trong danh sách ưu tiên hiện tại của {champion.name}.</p>
              </div>
            )}
          </section>

          <section id="notes" className="notes-grid">
            <div className="note-panel good">
              <span className="note-icon">✓</span>
              <div><h3>Tương tác nên tận dụng</h3>{champion.tips.map((tip) => <p key={tip}>{tip}</p>)}</div>
            </div>
            <div className="note-panel warning">
              <span className="note-icon">!</span>
              <div><h3>Bẫy cần tránh</h3>{champion.traps.map((trap) => <p key={trap}>{trap}</p>)}</div>
            </div>
          </section>

          {(champion.sourceNotes?.length || champion.summaryOriginal || visibleAlternativeOriginals.length) ? (
            <details className="original-notes">
              <summary>Nguyên văn Trung Quốc để đối chiếu bản dịch</summary>
              <div>
                {champion.summaryOriginal && <p>{champion.summaryOriginal}</p>}
                {champion.sourceNotes?.map((note, index) => <p key={`${index}-${note}`}>{note}</p>)}
                {visibleAlternativeOriginals.map((note, index) => <p key={`alt-${index}-${note}`}>Biến thể: {note}</p>)}
              </div>
            </details>
          ) : null}

          <div className="source-card">
            <div>
              <strong>Nguồn đối chiếu</strong>
              <p>Nội dung công khai đã được Việt hóa và đối chiếu bằng ID dữ liệu game. Trang nguồn cập nhật gần nhất: {champion.sourceModified ?? "chưa công bố"}.</p>
            </div>
            <a href={champion.source} target="_blank" rel="noreferrer">Mở trang nguồn ↗</a>
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
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const featured = champions.find((champion) => champion.id === "ryze") ?? champions[0];

  useEffect(() => {
    const saved = window.localStorage.getItem("loi-meta-favorites");
    const frame = saved
      ? window.requestAnimationFrame(() => setFavorites(JSON.parse(saved)))
      : null;
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);

    const onInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPrompt);
    };
    window.addEventListener("beforeinstallprompt", onInstall);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("beforeinstallprompt", onInstall);
    };
  }, []);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", close);
    document.body.style.overflow = selected ? "hidden" : "";
    return () => {
      window.removeEventListener("keydown", close);
      document.body.style.overflow = "";
    };
  }, [selected]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("vi");
    return champions
      .filter((champion) => role === "Tất cả" || champion.role === role)
      .filter((champion) => !favoritesOnly || favorites.includes(champion.id))
      .filter((champion) => {
        if (!normalized) return true;
        return [
          champion.name,
          champion.title,
          champion.buildName,
          ...champion.aliases,
          ...champion.coreAugments.map((augment) => augment.vi),
          ...(champion.communityBuilds ?? []).flatMap((build) => [
            build.title,
            build.titleOriginal,
            ...build.coreAugments.flatMap((augment) => [augment.vi, augment.cn]),
          ]),
        ]
          .join(" ")
          .toLocaleLowerCase("vi")
          .includes(normalized);
      })
      .sort((left, right) => tierOrder[right.tier] - tierOrder[left.tier]);
  }, [favorites, favoritesOnly, query, role]);

  function toggleFavorite(id: string) {
    setFavorites((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
      window.localStorage.setItem("loi-meta-favorites", JSON.stringify(next));
      return next;
    });
  }

  async function installApp() {
    if (!installPrompt) {
      document.getElementById("install-guide")?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Lõi Meta - Trang chủ">
          <span className="brand-mark">✦</span>
          <span>LÕI<span>.META</span></span>
          <small>ARAM MAYHEM</small>
        </a>
        <nav>
          <a href="#champions">Tướng</a>
          <a href="#how-to">Cách dùng</a>
          <a href="#community-sources">Nguồn cộng đồng</a>
        </nav>
        <button className="install-button" onClick={installApp}><span>↓</span> Cài ứng dụng</button>
      </header>

      <section className="hero" id="top">
        <div className="hero-glow hero-glow-one" />
        <div className="hero-glow hero-glow-two" />
        <div className="hero-content">
          <div className="hero-copy">
            <div className="version-pill"><span /> Đồng bộ nguồn · {sourceSync.newestSourceDate ?? "đang cập nhật"}</div>
            <h1>Chọn lõi đúng.<br /><span>Lên đồ đúng nhịp.</span></h1>
            <p>Hướng dẫn tiếng Việt cho ARAM: Mayhem — tập trung vào build, lõi trung tâm, tương tác đặc biệt và những lựa chọn dễ khiến bạn “tự hủy”.</p>
            <div className="hero-search">
              <SearchIcon />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Tìm tướng, biệt danh, lối build hoặc lõi..."
                aria-label="Tìm hướng dẫn tướng"
              />
              {query && <button onClick={() => setQuery("")} aria-label="Xóa tìm kiếm"><CloseIcon /></button>}
            </div>
            <div className="hero-proof">
              <span><b>{champions.length}</b> tướng đã biên tập</span>
              <span><b>{communitySourceStats.buildCount}</b> lối cộng đồng đã gộp</span>
              <span><b>{communitySourceStats.championCount}</b> tướng có nguồn chéo</span>
              <span><b>0</b> tỷ lệ thắng bịa</span>
            </div>
          </div>
          <div className="hero-featured" onClick={() => setSelected(featured)}>
            <div className="featured-art">
              <img src={championSplash(featured)} alt={featured.name} />
              <div className="featured-shade" />
            </div>
            <span className="featured-label">Build nổi bật tuần này</span>
            <div className="featured-title"><span className={`tier-badge tier-${featured.tier.toLowerCase()}`}>{featured.tier}</span><div><h2>{featured.name} · {featured.buildName}</h2><p>{featured.coreAugments.length} lõi trọng tâm · {featured.items.length} trang bị gợi ý</p></div></div>
            <div className="featured-augments">
              {featured.coreAugments.slice(0, 2).map((augment, index) => <span key={augment.cn}>{index > 0 && <b>+</b>}{augment.vi}</span>)}
            </div>
            <button>Xem cách vận hành <span>↗</span></button>
          </div>
        </div>
      </section>

      <section className="champion-section" id="champions">
        <div className="section-intro">
          <div><span className="eyebrow">Kho hướng dẫn</span><h2>Chọn tướng của bạn</h2><p>Nhấn vào một thẻ để xem build đầy đủ và thử so sánh ba lõi đang xuất hiện trong trận.</p></div>
          <div className="result-count"><b>{filtered.length}</b><span>kết quả</span></div>
        </div>
        <div className="filter-bar">
          <div className="role-tabs">
            {roles.map((item) => <button key={item} className={role === item ? "active" : ""} onClick={() => setRole(item)}>{item}</button>)}
          </div>
          <button className={`favorite-filter ${favoritesOnly ? "active" : ""}`} onClick={() => setFavoritesOnly((value) => !value)}><HeartIcon filled={favoritesOnly} /> Đã lưu ({favorites.length})</button>
        </div>
        {filtered.length ? (
          <div className="champion-grid">
            {filtered.map((champion) => (
              <ChampionCard
                key={champion.id}
                champion={champion}
                favorite={favorites.includes(champion.id)}
                onOpen={() => setSelected(champion)}
                onFavorite={() => toggleFavorite(champion.id)}
              />
            ))}
          </div>
        ) : (
          <div className="empty-state"><span>⌕</span><h3>Chưa tìm thấy tướng phù hợp</h3><p>Thử tên khác hoặc bỏ bộ lọc hiện tại.</p><button onClick={() => { setQuery(""); setRole("Tất cả"); setFavoritesOnly(false); }}>Xóa bộ lọc</button></div>
        )}
      </section>

      <section className="community-source-section" id="community-sources">
        <div className="section-intro">
          <div>
            <span className="eyebrow">Nguồn cộng đồng Trung Quốc</span>
            <h2>Theo dõi rộng, chỉ nhập phần kiểm chứng được</h2>
            <p>Bilibili, Zhihu, Tieba và các trang hướng dẫn được dùng để phát hiện lối chơi. Tên lõi và trang bị chỉ được đưa vào khi khớp đúng ID dữ liệu game; một tổ hợp trùng nhau trên nhiều nguồn vẫn chỉ tạo một build.</p>
          </div>
          <div className="result-count"><b>{communitySourceStats.platformCount}</b><span>nhóm nguồn</span></div>
        </div>
        <div className="automation-watch">
          <div className="automation-watch-copy">
            <span className="eyebrow">Bộ theo dõi tự động · Bản {communityWatchStats.currentPatch}</span>
            <h3>Tìm ứng viên trước, con người xác minh trước khi đăng</h3>
            <p>Hệ thống quét metadata công khai từ {communityWatchStats.queryCount} truy vấn và theo dõi {communityWatchStats.creatorCount} tác giả. Không vượt đăng nhập/CAPTCHA, không lưu nguyên bài hoặc transcript và không coi lượt xem là tỷ lệ thắng.</p>
            <small>Lần quét gần nhất: {formatSourceDate(communityWatchStats.generatedAt.slice(0, 10))}{communityWatchStats.scanErrorCount > 0 ? ` · ${communityWatchStats.scanErrorCount} nguồn tạm lỗi` : " · tất cả truy vấn phản hồi"}</small>
          </div>
          <div className="automation-watch-metrics" aria-label="Trạng thái hàng chờ cộng đồng">
            <span><b>{communityWatchStats.candidateCount}</b><small>URL đã gộp trùng</small></span>
            <span><b>{communityWatchStats.reviewCandidateCount}</b><small>ứng viên có ID chờ duyệt</small></span>
            <span><b>{communityWatchStats.autoPublish ? "Bật" : "0"}</b><small>tự động công khai</small></span>
          </div>
        </div>
        <div className="source-watch-grid">
          {communitySourceStats.globalSources.map((source) => (
            <a href={source.url} target="_blank" rel="noreferrer" key={source.url}>
              <div><span>{source.platform}</span><small>{source.kind}</small></div>
              <h3>{source.title}</h3>
              <p>{source.note}</p>
              <div className="source-watch-meta"><span>{formatSourceDate(source.publishedAt)}</span>{source.signal && <b>{source.signal}</b>}<i>↗</i></div>
            </a>
          ))}
        </div>
        <p className="community-updated">Danh mục cộng đồng biên tập gần nhất: {formatSourceDate(communitySourceStats.updatedAt)} · Mốc kiểm chứng: bản {communitySourceStats.patchBaseline} trở lên.</p>
      </section>

      <section className="how-section" id="how-to">
        <div className="section-intro compact"><div><span className="eyebrow">Dùng trong 10 giây</span><h2>Không cần tự động nhận diện trận</h2></div></div>
        <div className="how-grid">
          <article><span>01</span><div><h3>Tìm tướng</h3><p>Gõ tên, biệt danh hoặc lọc theo vai trò.</p></div></article>
          <article><span>02</span><div><h3>Khóa lối build</h3><p>Đọc lõi trung tâm và thứ tự trang bị trước khi trận bắt đầu.</p></div></article>
          <article><span>03</span><div><h3>So ba lựa chọn</h3><p>Chạm ba lõi đang hiện để nhận thứ tự ưu tiên thủ công.</p></div></article>
        </div>
      </section>

      <section className="install-guide" id="install-guide">
        <div className="install-visual"><span className="brand-mark">✦</span><i>+</i></div>
        <div><span className="eyebrow">PWA · dùng như ứng dụng</span><h2>Ghim Lõi.Meta lên màn hình chính</h2><p>Trên iPhone: Chia sẻ → Thêm vào MH chính. Trên Android/Chrome: chọn “Cài đặt ứng dụng”. Những trang đã mở vẫn xem được khi mạng chập chờn.</p></div>
        <button onClick={installApp}>Cài ứng dụng <span>↓</span></button>
      </section>

      <footer id="sources">
        <div className="footer-brand"><span className="brand-mark">✦</span><div><strong>LÕI.META</strong><p>Hướng dẫn ARAM: Mayhem bằng tiếng Việt.</p></div></div>
        <p className="disclaimer">Dự án cộng đồng, không được Riot Games bảo trợ. Đã đồng bộ {sourceSync.championCount} tướng từ phần công khai của 海斗小助手; Bilibili, Zhihu, Tieba và các trang hướng dẫn chỉ bổ sung nguồn chéo. Tên và ảnh lõi/trang bị được đối chiếu qua dữ liệu client Việt Nam của Riot/CommunityDragon.</p>
        <div className="footer-links"><a href="https://lolhaidou.cn/" target="_blank" rel="noreferrer">Hải Đấu ↗</a><a href="#community-sources">Nguồn cộng đồng ↑</a><a href="https://www.communitydragon.org/" target="_blank" rel="noreferrer">CommunityDragon ↗</a></div>
      </footer>

      {selected && (
        <GuideDrawer
          key={selected.id}
          champion={selected}
          favorite={favorites.includes(selected.id)}
          onFavorite={() => toggleFavorite(selected.id)}
          onClose={() => setSelected(null)}
        />
      )}

      <nav className="mobile-nav" aria-label="Điều hướng di động">
        <a href="#top"><span>⌂</span>Trang chủ</a>
        <a href="#champions"><span>♙</span>Tướng</a>
        <button onClick={() => setFavoritesOnly((value) => !value)}><span>♡</span>Đã lưu</button>
      </nav>
    </main>
  );
}
