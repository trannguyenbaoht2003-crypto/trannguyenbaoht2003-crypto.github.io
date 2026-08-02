import { parsePublicPublicationList } from "./parse-publications.ts";
import type { PublicPublicationListV1 } from "./types.ts";

export class PublicPublicationRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicPublicationRequestError";
  }
}

export function buildPublicationListUrl(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.trim();
  if (!trimmed) {
    throw new PublicPublicationRequestError("Public API base URL is not configured");
  }
  if (trimmed === "same-origin") {
    return "/api/v1/publications";
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new PublicPublicationRequestError("Public API base URL is invalid");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new PublicPublicationRequestError("Public API base URL is invalid");
  }

  return `${trimmed.replace(/\/+$/, "")}/api/v1/publications`;
}

export async function fetchPublications(options: {
  apiBaseUrl: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<PublicPublicationListV1> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(buildPublicationListUrl(options.apiBaseUrl), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new PublicPublicationRequestError("Public Publication request failed");
  }

  if (!response.ok) {
    throw new PublicPublicationRequestError("Public Publication request failed");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new PublicPublicationRequestError("Public Publication response was not valid JSON");
  }

  return parsePublicPublicationList(payload);
}
