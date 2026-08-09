/**
 * Static hero mockup of the CareerRat dashboard — illustrative markup, not a
 * screenshot or embed. Mirrors the "Clear these five and you're done" panel
 * from the approved design comp (CareerRat Website.dc.html, frame 1a) so the
 * hero never depends on a live demo URL or a recorded screen capture.
 */
export default function DashboardPreview() {
  return (
    <div className="dash-card" role="img" aria-label="Preview of the CareerRat dashboard">
      <div className="dash-card-head">
        <span className="dash-card-wordmark">
          CareerRat<span className="dash-card-dot">.</span>
        </span>
        <span className="dash-card-receipt">SAT AUG 9 · 18 ACTIVE</span>
      </div>
      <div className="dash-card-body">
        <div className="dash-card-title">Clear these five and you&apos;re done.</div>
        <div className="dash-card-row">
          <span className="dash-card-row-label dash-card-row-label-danger">
            1 · INTERVIEW 2:00 PM
          </span>
          <span className="dash-card-row-text">
            Prep the Cyberdyne technical screen
          </span>
        </div>
        <div className="dash-card-row">
          <span className="dash-card-row-label">2 · OVERNIGHT FINDS</span>
          <span className="dash-card-row-text">Review 4 new high-fit roles</span>
        </div>
        <div className="dash-card-ask">
          <span>Ask your rat — &ldquo;why did Stripe get cut?&rdquo;</span>
          <span className="dash-card-ask-send" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="11"
              height="11"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 19V5" />
              <path d="m6 11 6-6 6 6" />
            </svg>
          </span>
        </div>
        <span className="dash-card-footer">
          OVERNIGHT · 41 SCANNED · 7 NEW · AI · CLAUDE CODE
        </span>
      </div>
    </div>
  );
}
