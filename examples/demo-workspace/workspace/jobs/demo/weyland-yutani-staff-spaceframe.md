# Staff Engineer, Spaceframe — Weyland-Yutani Corporation

**Location:** Remote (Global) — occasional travel to launch sites (<10%)
**Level:** Staff / Principal
**Team:** Spaceframe Engineering
**Requisition:** WY-2026-SE-047

---

## About the Role

Weyland-Yutani's Spaceframe division builds and operates the distributed computing backbone that
runs aboard long-duration missions — autonomous systems, crew telemetry, life-support integration
layers, and the agentic monitoring stack that handles decisions when round-trip latency is measured
in minutes. We are looking for a Staff Engineer who can own the full stack from sensor ingestion
through actionable insight delivery, with a relentless focus on reliability, human-in-the-loop
safety, and zero-downtime operations.

You will be a technical anchor for a cross-functional team of 8 engineers across three timezones.
You will own architecture decisions, drive incident response playbooks, and collaborate directly
with mission operations, hardware, and product leadership. We are building better worlds — that
requires engineers who take reliability personally.

---

## What You'll Do

- Design and own the Spaceframe telemetry pipeline: sensor ingestion at variable cadence (1 Hz –
  1 kHz), aggregation under degraded-link conditions, time-series storage, and sub-60s alerting.
- Lead the evolution of our human-in-the-loop approval layer: automated anomaly detection surfaces
  a ranked alert + recommended action; a crew operator confirms before any write to actuator
  systems. Own the latency and false-positive budget for this path.
- Drive the migration of three legacy Perl-era subsystems to our Go + gRPC + Kafka stack. Own
  the cutover plan; zero crew-impact tolerance.
- Establish observability standards (traces, metrics, logs, SLOs/SLAs) across all Spaceframe
  services; on-call rotation participation (~1 week per quarter primary).
- Prototype-to-production for new AI-augmented monitoring features (anomaly classification,
  predictive maintenance, natural-language incident summaries). Evaluate, integrate, ship.
- Mentor 2–3 senior engineers; co-own the team RFC process.

---

## What We're Looking For

- 8+ years software engineering; 3+ as a staff/principal-level contributor or tech lead.
- Proven design and operation of **distributed, high-reliability systems** in production: event
  streaming (Kafka or equivalent), time-series data (InfluxDB, TimescaleDB, or equivalent),
  service meshes, multi-region failover.
- Experience with **human-in-the-loop automation**: systems where software proposes and humans
  approve before writes happen. Safety-critical or mission-critical context preferred.
- Shipped **AI/LLM-augmented workflows** in production — integration patterns, reliability
  strategies, evaluation frameworks. Model training is not required.
- Excellent written communication; comfortable driving architecture decisions across org
  boundaries; fluent in the cost/benefit language of reliability tradeoffs.
- Low-bandwidth / high-latency networking experience a plus.

---

## Compensation

- **Base:** $215,000 – $255,000
- **Equity:** 0.05% – 0.10% RSU (4-year, 1-year cliff)
- **Bonus:** 12% target annual bonus
- **Total comp target:** ~$320,000 – $380,000 at mid-range

Benefits: remote-first, 401(k) + 4% match, comprehensive health/dental/vision, $3,000 learning
budget, 4 weeks PTO + holidays, home-office setup stipend ($2,500), parental leave 16 weeks.

---

## About Weyland-Yutani

Founded in 2019 through the merger of Weyland Corp and Yutani Corporation, we operate across
aerospace engineering, terraforming, advanced robotics, and applied AI. We employ 73,000 people
across 14 planetary bodies (and counting). Our Spaceframe division powers over 200 active
long-duration missions. We are committed to building better worlds through better engineering.

*Weyland-Yutani is an equal-opportunity employer. Crew-expendability assessments conducted only
in accordance with applicable Interstellar Commerce Commission regulations.*
