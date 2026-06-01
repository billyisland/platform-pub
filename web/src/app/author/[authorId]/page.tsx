import { AuthorProfileView } from "./AuthorProfileView";

export default function AuthorPage({
  params,
}: {
  params: { authorId: string };
}) {
  return <AuthorProfileView authorId={params.authorId} />;
}
