"use client";

// =============================================================================
// EditorOverlay — the single article-writing surface: the full ArticleEditor in
// a workspace Glasshouse. Mounted globally in LayoutShell (like ProfileOverlay)
// so "write an article" is reachable from the workspace, the dashboard overlay,
// and the note→article handoff. Opened via useEditorOverlay (ForallMenu, the
// dashboard "New article"/"Edit" rows, the compose "Write an article →" button)
// or the /workspace?overlay=editor deep-link. The standalone /write page remains
// the addressable full-page editor for direct visits/bookmarks.
// =============================================================================

import { useRouter } from "next/navigation";
import { useEditorOverlay } from "../../stores/editorOverlay";
import { useArticleEditorInit } from "../../hooks/useArticleEditorInit";
import { Glasshouse } from "./Glasshouse";
import { ArticleEditor } from "../editor/ArticleEditor";

export function EditorOverlay() {
  const router = useRouter();
  const {
    isOpen,
    draftId,
    editEventId,
    publicationSlug,
    initialContent,
    initialTitle,
    close,
  } = useEditorOverlay();

  // Hooks must run unconditionally; the render bails below when closed. The load
  // effects no-op while there's no user / nothing seeded.
  const init = useArticleEditorInit({
    editEventId,
    draftId,
    pubSlug: publicationSlug,
    seedContent: initialContent,
    seedTitle: initialTitle,
    // Post-publish: close the editor and land on the dashboard's articles tab.
    // Routed through the URL rather than the dashboard store directly because
    // DashboardOverlay is mounted in WorkspaceView while this overlay is global
    // — a router.push works from any surface, mirroring the old /write flow.
    onComplete: (dest) => {
      close();
      const params = new URLSearchParams({ overlay: dest.overlay });
      if (dest.tab) params.set("tab", dest.tab);
      if (dest.context) params.set("context", dest.context);
      router.push(`/workspace?${params.toString()}`);
    },
  });

  if (!isOpen) return null;

  return (
    <Glasshouse onClose={close} maxWidth={780} ariaLabel="Write an article" persistKey="editor" resizable>
      <div className="flex flex-col h-full max-h-[var(--gh-h)] overflow-y-auto">
        {init.loadError ? (
          <div className="px-6 sm:px-10 py-12 text-center">
            <p className="text-red-600">{init.loadError}</p>
          </div>
        ) : (editEventId || draftId) && !init.editorReady ? (
          <div className="px-6 sm:px-10 py-12 text-center">
            <div className="h-8 w-48 mx-auto animate-pulse rounded bg-grey-100" />
            <p className="mt-4 text-sm text-grey-600">Loading…</p>
          </div>
        ) : (
          <ArticleEditor
            chrome="overlay"
            initialTitle={init.initialData?.title}
            initialDek={init.initialData?.dek}
            initialContent={init.initialData?.content}
            initialGatePosition={init.initialData?.gatePosition}
            initialPrice={init.initialData?.price}
            initialCommentsEnabled={init.initialData?.commentsEnabled}
            initialTags={init.initialData?.tags}
            initialCoverImageUrl={init.initialData?.coverImageUrl ?? null}
            editingEventId={init.initialData?.editingEventId}
            editingDTag={init.initialData?.editingDTag}
            publicationMemberships={init.pubMemberships}
            initialPublicationId={init.initialPubId}
            onPublish={init.handlePublish}
            onSchedule={!editEventId ? init.handleSchedule : undefined}
          />
        )}
      </div>
    </Glasshouse>
  );
}
