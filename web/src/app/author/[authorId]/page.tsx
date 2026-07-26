import { AuthorProfileView } from "./AuthorProfileView";
import WorkspacePaneRedirect from "../../../components/layout/WorkspacePaneRedirect";
import { PublicPage } from "../../../components/public/PublicPage";

// Standalone external-author profile. A logged-in visitor is bounced into the
// workspace overlay; a logged-out one gets this page.
//
// WRAPPED ONLY (tranche 3). AuthorProfileView is also mounted by
// ProfileOverlay, so its internals are a workspace question — including the
// `rounded-full` avatars at AuthorProfileView.tsx:263, which are fine anyway
// (circles are not softened rectangles).
export default function AuthorPage({
  params,
}: {
  params: { authorId: string };
}) {
  return (
    <PublicPage>
      <WorkspacePaneRedirect
        overlay="profile"
        params={{ author: params.authorId }}
      />
      <AuthorProfileView authorId={params.authorId} />
    </PublicPage>
  );
}
