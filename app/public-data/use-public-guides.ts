"use client";

import { useEffect, useState } from "react";

import type { ChampionGuide } from "../data.ts";
import { fetchPublications } from "./http-publication-adapter.ts";
import {
  mergePublicationsIntoGuides,
  type PublicChampionGuide,
} from "./merge-publications.ts";
import type { PublicDataStatus } from "./types.ts";

export type PublicGuidesState = {
  guides: readonly PublicChampionGuide[];
  status: PublicDataStatus;
  publicationCount: number;
};

export function usePublicGuides(
  staticGuides: readonly ChampionGuide[],
  apiBaseUrl?: string,
): PublicGuidesState {
  const configuredUrl = apiBaseUrl?.trim() || undefined;
  const [state, setState] = useState<PublicGuidesState>(() => ({
    guides: staticGuides,
    status: configuredUrl ? "loading" : "static",
    publicationCount: 0,
  }));

  useEffect(() => {
    if (!configuredUrl) return;

    const controller = new AbortController();
    fetchPublications({ apiBaseUrl: configuredUrl, signal: controller.signal })
      .then((result) => {
        const guides = mergePublicationsIntoGuides(staticGuides, result.publications);
        setState({
          guides,
          status: "live",
          publicationCount: guides.filter((guide) => guide.publicPublication).length,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        setState({ guides: staticGuides, status: "fallback", publicationCount: 0 });
      });

    return () => controller.abort();
  }, [configuredUrl, staticGuides]);

  return state;
}
