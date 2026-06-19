import { SourceSurface } from "./SourceSurface";
import WorkspacePaneRedirect from "../../../components/layout/WorkspacePaneRedirect";

export default function SourcePage({ params }: { params: { id: string } }) {
  return (
    <>
      <WorkspacePaneRedirect
        overlay="surface"
        params={{ surface: `/source/${params.id}` }}
      />
      <SourceSurface id={params.id} />
    </>
  );
}
