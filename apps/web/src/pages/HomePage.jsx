import { PageScaffold } from "../components/PageScaffold.jsx";

export function HomePage() {
  return (
    <PageScaffold
      title="Rolester"
      subtitle="M7 app shell — Settings is the first real page here; more of the product moves in through M10."
    >
      <p>
        Use the left nav to reach <strong>Settings</strong>, the first surface backed by real
        reads/writes. Everything else in the nav is a working route stub for a later milestone.
      </p>
    </PageScaffold>
  );
}
