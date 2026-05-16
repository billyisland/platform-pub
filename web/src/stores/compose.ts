import { create } from "zustand";
import type { QuoteTarget } from "../lib/publishNote";
import type { NoteEvent } from "../lib/ndk";

type ComposeMode = "note" | "reply" | "article";

interface ComposeState {
  isOpen: boolean;
  mode: ComposeMode;
  replyTarget: QuoteTarget | null;
  /** When resuming an existing draft from the dashboard, the article surface seeds from this id. */
  articleDraftId: string | null;
  /** When opening from `/p/[slug]/...`, pre-select that publication in the article surface. */
  articlePublicationSlug: string | null;
  /** Note content carried forward when switching note → article mode. */
  initialArticleContent: string | null;
  /** ArticleComposePanel registers this so the overlay can flush the draft before closing. */
  articleFlush: (() => Promise<void>) | null;

  open: (mode?: ComposeMode, replyTarget?: QuoteTarget) => void;
  openArticle: (opts?: { draftId?: string; publicationSlug?: string }) => void;
  setMode: (mode: ComposeMode, content?: string) => void;
  close: () => void;
  setArticleFlush: (fn: (() => Promise<void>) | null) => void;

  /** FeedView registers this so the overlay can prepend new notes to the feed. */
  onPublished: ((note: NoteEvent) => void) | null;
  setOnPublished: (cb: ((note: NoteEvent) => void) | null) => void;
}

export const useCompose = create<ComposeState>((set) => ({
  isOpen: false,
  mode: "note",
  replyTarget: null,
  articleDraftId: null,
  articlePublicationSlug: null,
  initialArticleContent: null,
  articleFlush: null,
  onPublished: null,

  open: (mode = "note", replyTarget) =>
    set({
      isOpen: true,
      mode,
      replyTarget: replyTarget ?? null,
      articleDraftId: null,
      articlePublicationSlug: null,
      initialArticleContent: null,
    }),

  openArticle: (opts) =>
    set({
      isOpen: true,
      mode: "article",
      replyTarget: null,
      articleDraftId: opts?.draftId ?? null,
      articlePublicationSlug: opts?.publicationSlug ?? null,
      initialArticleContent: null,
    }),

  setMode: (mode, content) =>
    set({
      mode,
      initialArticleContent: mode === "article" ? (content ?? null) : null,
    }),

  close: () =>
    set({
      isOpen: false,
      replyTarget: null,
      articleDraftId: null,
      articlePublicationSlug: null,
      initialArticleContent: null,
      articleFlush: null,
    }),

  setArticleFlush: (fn) => set({ articleFlush: fn }),

  setOnPublished: (cb) => set({ onPublished: cb }),
}));
