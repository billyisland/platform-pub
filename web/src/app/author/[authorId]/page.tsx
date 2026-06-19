import { AuthorProfileView } from "./AuthorProfileView";
import WorkspacePaneRedirect from "../../../components/layout/WorkspacePaneRedirect";

export default function AuthorPage({
  params,
}: {
  params: { authorId: string };
}) {
  return (
    <>
      <WorkspacePaneRedirect
        overlay="profile"
        params={{ author: params.authorId }}
      />
      <AuthorProfileView authorId={params.authorId} />
    </>
  );
}
