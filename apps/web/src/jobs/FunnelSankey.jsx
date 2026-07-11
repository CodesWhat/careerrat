import { useMemo } from "react";
import { Card } from "../components/Card.jsx";
import "./FunnelSankey.css";

const WIDTH = 1800;
const HEIGHT = 520;
const TOP = 48;
const COLUMN_HEIGHT = 400;
const NODE_WIDTH = 5;
const LEFT_PAD = 220;
const RIGHT_PAD = 320;

// The response/decay "waypoint" cluster (Awaiting, Going stale, Ghosted, Heard
// back) commonly packs into a single shared column (col 1), stacked tightly by
// `order`. Each of these nodes carries a two-line label (name + count) that is
// placed ABOVE its own bar — so every node in the cluster needs its own
// reserved headroom, not just the 16px inter-node gap, or a short node's label
// bleeds upward into the previous node's bar/label. LABEL_HEADROOM is the
// vertical room (in px) reserved above a waypoint node's bar for that label.
const LABEL_HEADROOM = 36;
const WAYPOINT_LABEL_IDS = new Set(["awaiting", "heardback", "stale", "ghosted"]);

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function linkId(link) {
  return `${link.from || "unknown"}-${link.to || "unknown"}`;
}

function linkTitle(link, from, to) {
  const count = toNumber(link.count);
  const noun = count === 1 ? "application" : "applications";
  const examples = Array.isArray(link.examples) ? link.examples.filter(Boolean).slice(0, 3) : [];
  const exampleText = examples.length ? ` Examples: ${examples.join("; ")}` : "";
  return `${from.label} to ${to.label}: ${count} ${noun}.${exampleText}`;
}

function nodeTitle(node) {
  const count = toNumber(node.count);
  const noun = count === 1 ? "application" : "applications";
  return `${node.label}: ${count} ${noun}`;
}

function interactiveClassName(baseClass, filter, activeFilter, interactive) {
  if (!interactive) return baseClass;
  const active = activeFilter === filter;
  const dimmed = activeFilter && activeFilter !== "all" && !active;
  return [baseClass, active ? "is-active" : "", dimmed ? "is-dimmed" : ""]
    .filter(Boolean)
    .join(" ");
}

function handleInteractiveKeyDown(event, onSelect, filter) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  onSelect(filter);
}

function gapAfterNode(node, next) {
  return node?.id === "screen" && (next?.id === "rejected" || next?.id === "ghosted") ? 36 : 16;
}

// Waypoint nodes reserve LABEL_HEADROOM of empty space above their own bar (see
// LABEL_HEADROOM) so their above-placed label never crosses into a neighboring
// node's bar or label, however tightly the column packs.
function rowHeightFor(node, barH) {
  return WAYPOINT_LABEL_IDS.has(node.id) ? barH + LABEL_HEADROOM : barH;
}

function buildSankeyLayout(sankey) {
  const nodes = Array.isArray(sankey?.nodes) ? sankey.nodes : [];
  const links = Array.isArray(sankey?.links) ? sankey.links : [];
  if (!nodes.length) return { nodes: [], links: [] };

  const columns = [
    ...new Set(nodes.map((node) => toNumber(node.col)).filter(Number.isFinite)),
  ].sort((a, b) => a - b);
  const maxCol = Math.max(1, ...columns);
  const usableWidth = WIDTH - LEFT_PAD - RIGHT_PAD;
  const xForCol = (col) => LEFT_PAD + (usableWidth * col) / maxCol;
  const columnNodes = (col) =>
    nodes
      .filter((node) => toNumber(node.col) === col)
      .sort((a, b) => toNumber(a.order) - toNumber(b.order));
  const columnGapTotal = (items) =>
    items
      .slice(0, -1)
      .reduce((total, node, index) => total + gapAfterNode(node, items[index + 1]), 0);
  const columnUnitCaps = columns
    .map((col) => {
      const items = columnNodes(col);
      const count = items.reduce((total, node) => total + toNumber(node.count), 0);
      return count > 0 ? (COLUMN_HEIGHT - columnGapTotal(items)) / count : 11;
    })
    .filter((value) => Number.isFinite(value) && value > 0);
  const unit = Math.max(1, Math.min(11, ...columnUnitCaps));
  const layout = new Map();

  for (const col of columns) {
    const items = columnNodes(col);
    const rows = items.map((node) => {
      const barH = Math.max(6, toNumber(node.count) * unit);
      return { node, barH, rowH: rowHeightFor(node, barH) };
    });
    const usedHeight = rows.reduce((total, row) => total + row.rowH, 0) + columnGapTotal(items);
    let y = TOP + Math.max(0, (COLUMN_HEIGHT - usedHeight) / 2);
    const awaitingLaid = layout.get("awaiting");
    const staleLaid = layout.get("stale");
    // The anchor overrides below (sync with Awaiting, centre on Screen, pin to
    // the bottom/top) assume the node is the SOLE occupant of its column — true
    // for the legacy fractional-column layout (each sink gets its own column),
    // but not when the response/decay cluster shares a single integer column
    // (col 1) as one packed group. Forcing the whole shared column to the top
    // just because it contains "ghosted", say, is what produced the collision
    // this guard fixes — so these overrides only fire for a lone node.
    const solo = items.length === 1;

    if (solo && items.some((node) => node.id === "stale") && awaitingLaid) {
      const maxTop = TOP + COLUMN_HEIGHT - usedHeight;
      y = Math.min(awaitingLaid.y, maxTop);
    } else if (solo && items.some((node) => node.id === "screen") && staleLaid) {
      const heardLaid = layout.get("heardback");
      const screenNode = items.find((node) => node.id === "screen");
      const screenH = screenNode ? Math.max(6, toNumber(screenNode.count) * unit) : 0;
      const maxStart = TOP + COLUMN_HEIGHT - usedHeight;
      const centreScreen = TOP + COLUMN_HEIGHT / 2 - screenH / 2;
      const clearFloor = heardLaid
        ? 2 * (staleLaid.y + staleLaid.h + 8) - heardLaid.y - screenH
        : y;
      y = Math.min(maxStart, Math.max(centreScreen, clearFloor));
    } else if (solo && items.some((node) => node.id === "round-1") && staleLaid) {
      // round-1 replaced the old "screen" node in the numbered-round rewrite but
      // never inherited its clearance anchor, so a solo round-1 floated to the
      // column's natural vertical centre and its inbound band crested up into
      // Going stale. Push round-1 down until it clears stale's bottom by a
      // comfortable gap, but never float it ABOVE its natural centred position
      // (`y` at this point) and never past the column's own floor.
      const maxTop = TOP + COLUMN_HEIGHT - usedHeight;
      const clearFloor = staleLaid.y + staleLaid.h + 16;
      y = Math.min(maxTop, Math.max(y, clearFloor));
    } else if (solo && items.some((node) => node.id === "rejected")) {
      y = TOP + COLUMN_HEIGHT - usedHeight;
    } else if (solo && items.some((node) => node.id === "ghosted")) {
      y = TOP;
    }

    for (let index = 0; index < rows.length; index += 1) {
      const { node, barH, rowH } = rows[index];
      // The bar sits at the BOTTOM of its reserved row, leaving rowH - barH of
      // clear headroom above it for a waypoint node's label — guaranteeing that
      // headroom lives inside this node's own row rather than borrowing space
      // from whatever sits above it.
      const barY = y + rowH - barH;
      layout.set(node.id, { ...node, x: xForCol(col), y: barY, h: barH });
      y += rowH + gapAfterNode(node, items[index + 1]);
    }
  }

  const inOffsets = new Map();
  const rejectedInOffsets = new Map();
  // Nest order at Rejected: a source that's farther left (shallower/earlier
  // round, smaller col) takes an upper slot, the nearer/deeper round sits just
  // below it, so bands converge roughly parallel instead of crossing. Heard
  // back — the long, low pre-screen band — is always forced to the very
  // bottom regardless of its column.
  const rejectedIncoming = links
    .filter((link) => link.to === "rejected" && layout.get(link.from))
    .sort((a, b) => {
      if (a.from === "heardback") return 1;
      if (b.from === "heardback") return -1;
      const colDelta = toNumber(layout.get(a.from).col) - toNumber(layout.get(b.from).col);
      if (colDelta !== 0) return colDelta;
      return layout.get(a.from).y - layout.get(b.from).y;
    });
  let rejectedAcc = 0;
  for (const link of rejectedIncoming) {
    rejectedInOffsets.set(link, rejectedAcc);
    rejectedAcc += Math.max(4, toNumber(link.count) * unit);
  }

  // A source node's out-stack keeps its live continuations stacked from the
  // TOP as before, but loss links (round → Rejected/Withdrawn) are FLUSHED to
  // the BOTTOM of the source bar (from.h) rather than merely stacked last —
  // stacking last still lands at offset 0 (the top) when the loss link is a
  // node's ONLY out-link (e.g. the deepest round, whose entire outflow is the
  // loss), which is exactly the case that kept exiting the top.
  const isLossLink = (link) => link.to === "rejected" || link.to === "withdrawn";
  const outOffsets = new Map();
  const bySource = new Map();
  for (const link of links) {
    if (!layout.get(link.from) || !layout.get(link.to)) continue;
    if (!bySource.has(link.from)) bySource.set(link.from, []);
    bySource.get(link.from).push(link);
  }
  const linkH = (link) => Math.max(4, toNumber(link.count) * unit);
  for (const [fromId, group] of bySource) {
    const barH = layout.get(fromId).h;
    const nonLoss = group.filter((l) => !isLossLink(l));
    const loss = group.filter((l) => isLossLink(l));
    let top = 0;
    for (const link of nonLoss) {
      outOffsets.set(link, top);
      top += linkH(link);
    }
    const lossTotal = loss.reduce((t, l) => t + linkH(l), 0);
    // Flush loss links to the node's bottom edge; never let them overlap the
    // live continuations stacked at the top (guards against Math.max(4,…) inflation).
    let bottom = Math.max(top, barH - lossTotal);
    for (const link of loss) {
      outOffsets.set(link, bottom);
      bottom += linkH(link);
    }
  }

  const laidLinks = links
    .map((link) => {
      const from = layout.get(link.from);
      const to = layout.get(link.to);
      if (!from || !to) return null;
      const h = Math.max(4, toNumber(link.count) * unit);
      const out = outOffsets.get(link) || 0;
      const incoming =
        link.to === "rejected" ? rejectedInOffsets.get(link) || 0 : inOffsets.get(link.to) || 0;
      if (link.to !== "rejected") inOffsets.set(link.to, incoming + h);
      const x1 = from.x + NODE_WIDTH;
      const x2 = to.x;
      const y1 = from.y + out + h / 2;
      const y2 = to.y + incoming + h / 2;
      const span = Math.abs(x2 - x1);
      const curve = Math.min(Math.max(120, span * 0.52), span * 0.5);
      const d = `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`;
      return { ...link, id: linkId(link), d, h, fromNode: from, toNode: to };
    })
    .filter(Boolean);

  return { nodes: [...layout.values()], links: laidLinks };
}

function SankeyLink({ activeFilter, interactive, link, onSelectStage }) {
  const filter = link.filter || "all";
  const title = linkTitle(link, link.fromNode, link.toNode);
  const className = interactiveClassName("funnel-sankey__link", filter, activeFilter, interactive);

  if (interactive) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: SVG path can't be a <button>; role+tabIndex+onKeyDown make it keyboard-operable
      <path
        aria-label={title}
        className={className}
        d={link.d}
        data-sankey-link={link.id}
        fill="none"
        onClick={() => onSelectStage(filter)}
        onKeyDown={(event) => handleInteractiveKeyDown(event, onSelectStage, filter)}
        role="button"
        stroke={link.color || "currentColor"}
        strokeLinecap="butt"
        strokeWidth={link.h}
        tabIndex={0}
      >
        <title>{title}</title>
      </path>
    );
  }

  return (
    <path
      className={className}
      d={link.d}
      data-sankey-link={link.id}
      fill="none"
      stroke={link.color || "currentColor"}
      strokeLinecap="butt"
      strokeWidth={link.h}
    >
      <title>{title}</title>
    </path>
  );
}

function SankeyNode({ activeFilter, interactive, maxCol, node, onSelectStage }) {
  const filter = node.filter || node.id;
  const title = nodeTitle(node);
  const className = interactiveClassName("funnel-sankey__node", filter, activeFilter, interactive);
  const rect = (
    <rect
      fill={node.color || "currentColor"}
      height={node.h}
      rx="2"
      width={NODE_WIDTH}
      x={node.x}
      y={node.y}
    />
  );

  if (interactive) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: SVG <g> can't be a <button>; role+tabIndex+onKeyDown make it keyboard-operable
      <g
        aria-label={title}
        className={className}
        data-sankey-node={node.id}
        onClick={() => onSelectStage(filter)}
        onKeyDown={(event) => handleInteractiveKeyDown(event, onSelectStage, filter)}
        role="button"
        tabIndex={0}
      >
        {rect}
        {renderNodeLabel(node, maxCol)}
        <title>{title}</title>
      </g>
    );
  }

  return (
    <g className={className} data-sankey-node={node.id}>
      {rect}
      {renderNodeLabel(node, maxCol)}
      <title>{title}</title>
    </g>
  );
}

function renderNodeLabel(node, maxCol) {
  if (node.hideLabel) return null;

  const isFirst = node.col === 0;
  const isLast = node.col === maxCol;
  const isRound = typeof node.id === "string" && node.id.startsWith("round-");
  const isRejected = node.id === "rejected";
  const isAccepted = node.id === "accepted";
  const sideRight = (isLast || isRejected || isAccepted) && !isRound;
  // Every node in the response/decay waypoint cluster labels the same way —
  // above its own bar — so a packed shared column never mixes an above-placed
  // label with a below-placed one that would drift into a neighbor's space.
  const labelAbove = WAYPOINT_LABEL_IDS.has(node.id) || isRound;
  const labelX = isFirst
    ? node.x - 8
    : sideRight
      ? node.x + NODE_WIDTH + 14
      : node.x + NODE_WIDTH / 2;
  const anchor = isFirst ? "end" : sideRight ? "start" : "middle";
  const labelY = labelAbove
    ? node.y - 26
    : isFirst || sideRight
      ? node.y + node.h / 2 - 4
      : node.y + node.h + 16;
  const approxCharW = isFirst ? 7 : 7.6;
  const titleW = String(node.label || "").length * approxCharW;
  const countX =
    anchor === "end" ? labelX - titleW / 2 : anchor === "start" ? labelX + titleW / 2 : labelX;

  return (
    <text
      className={`funnel-sankey__node-label${isFirst ? " funnel-sankey__node-label--source" : ""}`}
      textAnchor={anchor}
      x={labelX}
      y={labelY}
    >
      {node.label}
      <tspan dy="1.2em" textAnchor="middle" x={countX}>
        ({toNumber(node.count)})
      </tspan>
    </text>
  );
}

export function FunnelSankey({ sankey, onSelectStage, activeFilter }) {
  const layout = useMemo(() => buildSankeyLayout(sankey), [sankey]);
  const interactive = typeof onSelectStage === "function";
  const total = toNumber(
    sankey?.total,
    layout.nodes.reduce((sum, node) => sum + toNumber(node.count), 0)
  );

  if (!layout.nodes.length) {
    return (
      <Card title="Jobs funnel" className="funnel-sankey-card">
        <p className="funnel-sankey-empty">No application funnel data yet.</p>
      </Card>
    );
  }

  const columns = [...new Set(layout.nodes.map((node) => toNumber(node.col)))];
  const maxCol = Math.max(1, ...columns);
  const legendNodes = layout.nodes.filter(
    (node) => node.col !== 1 || node.id === "stale" || node.id === "ghosted"
  );

  return (
    <Card
      title="Jobs funnel"
      className="funnel-sankey-card"
      actions={
        <span className="funnel-sankey-card__meta">
          {total} applications / {layout.links.length} flows
        </span>
      }
    >
      <div className="funnel-sankey">
        <div className="funnel-sankey__frame">
          <svg
            aria-label="Jobs Sankey funnel"
            className="funnel-sankey__svg"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          >
            <g className="funnel-sankey__links">
              {layout.links.map((link) => (
                <SankeyLink
                  activeFilter={activeFilter}
                  interactive={interactive}
                  key={link.id}
                  link={link}
                  onSelectStage={onSelectStage}
                />
              ))}
            </g>
            <g className="funnel-sankey__nodes">
              {layout.nodes.map((node) => (
                <SankeyNode
                  activeFilter={activeFilter}
                  interactive={interactive}
                  key={node.id}
                  maxCol={maxCol}
                  node={node}
                  onSelectStage={onSelectStage}
                />
              ))}
            </g>
          </svg>
        </div>
        <div className="funnel-sankey__legend">
          {legendNodes.map((node) => (
            <span className="funnel-sankey__legend-item" key={node.id}>
              <span className="funnel-sankey__legend-swatch" style={{ background: node.color }} />
              {node.label}
            </span>
          ))}
        </div>
      </div>
    </Card>
  );
}
