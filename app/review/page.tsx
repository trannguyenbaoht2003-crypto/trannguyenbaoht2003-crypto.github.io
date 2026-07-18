import type { Metadata } from "next";

import communityInbox from "../../data/community-inbox.json";
import { generatedChampions } from "../generated-guides";
import { buildReviewCatalog } from "../../scripts/lib/community-review-v31.mjs";
import ReviewWorkbench, { type ReviewCandidate } from "./ReviewWorkbench";

export const metadata: Metadata = {
  title: "Bảng duyệt Evidence v3.1 — Lõi.Meta",
  description: "Đối chiếu nguồn công khai với ID và ảnh game hiện hành trước khi đưa vào kiểm duyệt ARAM: Mayhem.",
};

type InboxCandidate = {
  id: string;
  platform: string;
  url: string;
  title: string;
  author?: string;
  publishedAt?: string;
  status: string;
  accessState?: string;
  modeValid?: boolean;
  currentEnough?: boolean;
  disqualifiers?: string[];
  evidenceReviewState?: string;
  reasons?: string[];
  championMatches?: ReviewCandidate["championMatches"];
  augmentMatches?: ReviewCandidate["augmentMatches"];
  itemMatches?: ReviewCandidate["itemMatches"];
  entityEvidence?: ReviewCandidate["entityEvidence"];
  sourceImageIds?: string[];
  sourceImageReferenceIds?: string[];
};

const reviewStates = new Set(["image-review-required", "translation-review-required"]);

function toSafeReviewCandidate(candidate: InboxCandidate): ReviewCandidate | undefined {
  if (!reviewStates.has(candidate.evidenceReviewState ?? "")) return undefined;
  if (candidate.accessState !== "ok" || candidate.modeValid !== true || candidate.currentEnough !== true) return undefined;
  if ((candidate.disqualifiers?.length ?? 0) > 0) return undefined;
  return {
    id: candidate.id,
    platform: candidate.platform,
    url: candidate.url,
    title: candidate.title,
    author: candidate.author,
    publishedAt: candidate.publishedAt,
    status: candidate.status,
    evidenceReviewState: candidate.evidenceReviewState as ReviewCandidate["evidenceReviewState"],
    reasons: candidate.reasons ?? [],
    championMatches: candidate.championMatches ?? [],
    augmentMatches: candidate.augmentMatches ?? [],
    itemMatches: candidate.itemMatches ?? [],
    entityEvidence: candidate.entityEvidence ?? { champions: [], augments: [], items: [] },
    imageReferenceCount: (candidate.sourceImageIds?.length ?? 0) + (candidate.sourceImageReferenceIds?.length ?? 0),
  };
}

const candidates = (communityInbox.candidates as InboxCandidate[])
  .map(toSafeReviewCandidate)
  .filter((candidate): candidate is ReviewCandidate => Boolean(candidate));
const catalog = buildReviewCatalog(generatedChampions);

export default function ReviewPage() {
  return <ReviewWorkbench candidates={candidates} catalog={catalog} />;
}
