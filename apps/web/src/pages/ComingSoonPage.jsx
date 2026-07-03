import { PageScaffold } from "../components/PageScaffold.jsx";

export function ComingSoonPage({ title, milestone, description }) {
  return (
    <PageScaffold title={title} subtitle={milestone ? `Coming in ${milestone}` : undefined}>
      <p>{description}</p>
    </PageScaffold>
  );
}
