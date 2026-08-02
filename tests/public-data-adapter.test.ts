import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PublicPublicationContractError,
  parsePublicPublicationList,
} from "../app/public-data/parse-publications.ts";
import {
  PublicPublicationRequestError,
  fetchPublications,
} from "../app/public-data/http-publication-adapter.ts";
import { mergePublicationsIntoGuides } from "../app/public-data/merge-publications.ts";
import type { PublicPublicationListV1 } from "../app/public-data/types.ts";

const publication = {
  publicationId: "77000000-0000-4000-8000-000000000001",
  candidateId: "62000000-0000-4000-8000-000000000001",
  candidateRevisionId: "62000000-0000-4000-8000-000000000002",
  publicationVersionId: "77000000-0000-4000-8000-000000000002",
  versionNumber: 1,
  publishedAt: "2026-07-29T02:00:00.000Z",
  payload: {
    schemaVersion: 1,
    mode: "aram_mayhem",
    patchKey: "26.15",
    catalogRevisionId: "40000000-0000-4000-8000-000000000005",
    championExternalId: "samira",
    augmentExternalIds: ["1194"],
    itemExternalIds: ["3006", "6672"],
  },
} as const;

const validEnvelope: PublicPublicationListV1 = {
  schemaVersion: 1,
  publications: [publication],
};

function createGuides() {
  return [
    {
      id: "samira",
      ddragon: "Samira",
      championId: 360,
      name: "Samira",
      title: "Hoa Hồng Sa Mạc",
      aliases: [],
      role: "Xạ thủ" as const,
      tier: "SS" as const,
      buildGrade: "S" as const,
      buildName: "Tiêu đề tiếng Việt giữ nguyên",
      buildOriginal: "原始标题",
      summary: "Mô tả tiếng Việt giữ nguyên.",
      coreAugments: [{ vi: "Lõi cũ", cn: "旧强化", id: 1 }],
      items: ["Trang bị cũ A", "Trang bị cũ B"],
      itemData: [
        { name: "Giày Cuồng Nộ", original: "狂战士胫甲", id: 3006 },
        { name: "Nỏ Tử Thủ", original: "不朽盾弓", id: 6672 },
      ],
      prismatic: [{ vi: "Lõi API", cn: "API强化", id: 1194 }],
      gold: [],
      silver: [],
      tips: ["Mẹo"],
      traps: ["Bẫy"],
      alternatives: [],
      source: "https://example.test/samira",
    },
    {
      id: "ashe",
      ddragon: "Ashe",
      championId: 22,
      name: "Ashe",
      title: "Cung Băng",
      aliases: [],
      role: "Xạ thủ" as const,
      tier: "S" as const,
      buildGrade: "A" as const,
      buildName: "Build Ashe",
      buildOriginal: "艾希",
      summary: "Static Ashe",
      coreAugments: [{ vi: "Lõi khác", cn: "其他", id: 2 }],
      items: ["Giày Cuồng Nộ", "Nỏ Tử Thủ"],
      itemData: [
        { name: "Giày Cuồng Nộ", original: "狂战士胫甲", id: 3006 },
        { name: "Nỏ Tử Thủ", original: "不朽盾弓", id: 6672 },
      ],
      prismatic: [],
      gold: [],
      silver: [],
      tips: [],
      traps: [],
      alternatives: [],
      source: "https://example.test/ashe",
    },
  ];
}

test("parses the exact closed Publication list contract", () => {
  const parsed = parsePublicPublicationList(validEnvelope);
  assert.deepEqual(parsed, validEnvelope);
  assert.equal(parsed.publications[0].payload.championExternalId, "samira");
});

test("rejects unknown keys and invalid Publication invariants", () => {
  assert.throws(
    () => parsePublicPublicationList({ ...validEnvelope, unexpected: true }),
    PublicPublicationContractError,
  );
  assert.throws(
    () => parsePublicPublicationList({
      ...validEnvelope,
      publications: [{
        ...publication,
        payload: { ...publication.payload, itemExternalIds: ["3006"] },
      }],
    }),
    PublicPublicationContractError,
  );
  assert.throws(
    () => parsePublicPublicationList({
      ...validEnvelope,
      publications: [{
        ...publication,
        payload: { ...publication.payload, augmentExternalIds: ["1194", "1194"] },
      }],
    }),
    PublicPublicationContractError,
  );
});

test("fetches the list once with GET and validates the response", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify(validEnvelope), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await fetchPublications({
    apiBaseUrl: "https://api.example.test/",
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.deepEqual(result, validEnvelope);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "https://api.example.test/api/v1/publications");
  assert.equal(calls[0].init?.method, "GET");
  assert.deepEqual(calls[0].init?.headers, { accept: "application/json" });
});

test("does not retry a failed HTTP response", async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    return new Response("internal detail", { status: 500 });
  };

  await assert.rejects(
    fetchPublications({
      apiBaseUrl: "https://api.example.test",
      fetchImpl: fetchImpl as typeof fetch,
    }),
    PublicPublicationRequestError,
  );
  assert.equal(callCount, 1);
});

test("overlays localized API assets while preserving editorial copy", () => {
  const guides = createGuides();
  const merged = mergePublicationsIntoGuides(guides, validEnvelope.publications);

  assert.notEqual(merged[0], guides[0]);
  assert.equal(merged[0].buildName, guides[0].buildName);
  assert.equal(merged[0].summary, guides[0].summary);
  assert.deepEqual(merged[0].coreAugments.map((value) => value.id), [1194]);
  assert.deepEqual(merged[0].itemData?.map((value) => value.id), [3006, 6672]);
  assert.deepEqual(merged[0].items, ["Giày Cuồng Nộ", "Nỏ Tử Thủ"]);
  assert.equal(merged[0].publicPublication?.patchKey, "26.15");
  assert.equal(merged[0].publicPublication?.versionNumber, 1);
  assert.equal(merged[1], guides[1]);
});

test("keeps the exact static guide when any API asset is unresolved", () => {
  const guides = createGuides();
  const unresolved = {
    ...publication,
    payload: {
      ...publication.payload,
      itemExternalIds: ["3006", "999999"],
    },
  };

  const merged = mergePublicationsIntoGuides(guides, [unresolved]);
  assert.equal(merged[0], guides[0]);
});

test("selects a deterministic winner for duplicate champion Publications", () => {
  const guides = createGuides();
  const older = publication;
  const newerLowerVersion = {
    ...publication,
    publicationId: "77000000-0000-4000-8000-000000000003",
    publicationVersionId: "77000000-0000-4000-8000-000000000004",
    publishedAt: "2026-07-30T02:00:00.000Z",
    payload: { ...publication.payload, patchKey: "26.16" },
  };
  const newerHigherVersion = {
    ...newerLowerVersion,
    publicationId: "77000000-0000-4000-8000-000000000005",
    publicationVersionId: "77000000-0000-4000-8000-000000000006",
    versionNumber: 2,
    payload: { ...publication.payload, patchKey: "26.17" },
  };

  const merged = mergePublicationsIntoGuides(guides, [newerLowerVersion, older, newerHigherVersion]);
  assert.equal(merged[0].publicPublication?.patchKey, "26.17");
  assert.equal(merged[0].publicPublication?.versionNumber, 2);
});

test("keeps the frontend boundary read-only and one-shot", async () => {
  const files = await Promise.all([
    "../app/public-data/http-publication-adapter.ts",
    "../app/public-data/use-public-guides.ts",
    "../app/page.tsx",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  const source = files.join("\n");

  assert.match(source, /NEXT_PUBLIC_PUBLIC_API_BASE_URL/);
  assert.match(source, /usePublicGuides/);
  assert.match(source, /Dữ liệu tĩnh/);
  assert.match(source, /Đang kiểm tra bản xuất bản/);
  assert.match(source, /Đang dùng bản xuất bản API/);
  assert.match(source, /API tạm thời không khả dụng/);
  assert.match(source, /API · Bản/);
  assert.doesNotMatch(source, /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i);
  assert.doesNotMatch(source, /setInterval|setTimeout|authorization|bearer|github[_-]?token|auto.?publish/i);
});
