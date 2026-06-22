import { request } from "./client";

// =============================================================================
// Upstream Edges API (credit / citation / dispute)
//
// Spec: docs/adr/UPSTREAM-EDGES-ADR.md. Phase 1 read endpoints keyed on the
// internal articles.id UUID (the reader's `articleDbId` prop, NOT the nostr
// event id).
// =============================================================================

export interface CreditDisclaimer {
  id: string;
  /** True ⇒ filed by the credited party themselves (a real disclaimer). */
  byCreditedParty: boolean;
  counterCharacterisation: string;
  createdAt: string;
}

export interface CreditEdge {
  id: string;
  target: {
    /** NULL ⇒ native/unaddressable; else the external protocol. */
    protocol: string | null;
    externalId: string | null;
    displayName: string | null;
    /** Set when the credited source is a native member. */
    accountId: string | null;
    username: string | null;
  };
  note: string | null;
  createdAt: string;
  disclaimers: CreditDisclaimer[];
}

export interface CitationDispute {
  id: string;
  counterCharacterisation: string;
  widerExcerpt: string | null;
  createdAt: string;
}

export interface CitationEdge {
  id: string;
  source: {
    protocol: string | null;
    authorPubkey: string | null;
    naddr: string | null;
    uri: string | null;
    username: string | null;
    displayName: string | null;
  };
  excerpt: string;
  charStart: number | null;
  charEnd: number | null;
  characterisation: string;
  createdAt: string;
  disputes: {
    /** The cited author's own dispute (max one, rendered inline). */
    citedAuthor: CitationDispute | null;
    /** Third-party disputes are a count only — never glance-level badges. */
    thirdPartyCount: number;
  };
}

export const upstreamEdges = {
  getCredits: (articleId: string) =>
    request<{ credits: CreditEdge[] }>(`/articles/${articleId}/credits`),
  getCitations: (articleId: string) =>
    request<{ citations: CitationEdge[] }>(`/articles/${articleId}/citations`),
};
