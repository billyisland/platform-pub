import { SourceSurface } from "./SourceSurface";

export default function SourcePage({ params }: { params: { id: string } }) {
  return <SourceSurface id={params.id} />;
}
