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

function gapAfterNode(node, next) {
  return node?.id === "screen" && (next?.id === "rejected" || next?.id === "ghosted") ? 36 : 16;
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
    const usedHeight =
      items.reduce((total, node) => total + Math.max(6, toNumber(node.count) * unit), 0) +
      columnGapTotal(items);
    let y = TOP + Math.max(0, (COLUMN_HEIGHT - usedHeight) / 2);
    const awaitingLaid = layout.get("awaiting");
    const staleLaid = layout.get("stale");

    if (items.some((node) => node.id === "stale") && awaitingLaid) {
      const maxTop = TOP + COLUMN_HEIGHT - usedHeight;
      y = Math.min(awaitingLaid.y, maxTop);
    } else if (items.some((node) => node.id === "screen") && staleLaid) {
      const heardLaid = layout.get("heardback");
      const screenNode = items.find((node) => node.id === "screen");
      const screenH = screenNode ? Math.max(6, toNumber(screenNode.count) * unit) : 0;
      const maxStart = TOP + COLUMN_HEIGHT - usedHeight;
      const centreScreen = TOP + COLUMN_HEIGHT / 2 - screenH / 2;
      const clearFloor = heardLaid
        ? 2 * (staleLaid.y + staleLaid.h + 8) - heardLaid.y - screenH
        : y;
      y = Math.min(maxStart, Math.max(centreScreen, clearFloor));
    } else if (items.some((node) => node.id === "rejected")) {
      y = TOP + COLUMN_HEIGHT - usedHeight;
    } else if (items.some((node) => node.id === "ghosted")) {
      y = TOP;
    }

    for (let index = 0; index < items.length; index += 1) {
      const node = items[index];
      const h = Math.max(6, toNumber(node.count) * unit);
      layout.set(node.id, { ...node, x: xForCol(col), y, h });
      y += h + gapAfterNode(node, items[index + 1]);
    }
  }

  const outOffsets = new Map();
  const inOffsets = new Map();
  const rejectedInOffsets = new Map();
  const rejectedIncoming = links
    .filter((link) => link.to === "rejected" && layout.get(link.from))
    .sort((a, b) => {
      if (a.from === "heardback") return 1;
      if (b.from === "heardback") return -1;
      return layout.get(a.from).y - layout.get(b.from).y;
    });
  let rejectedAcc = 0;
  for (const link of rejectedIncoming) {
    rejectedInOffsets.set(link, rejectedAcc);
    rejectedAcc += Math.max(4, toNumber(link.count) * unit);
  }

  const laidLinks = links
    .map((link) => {
      const from = layout.get(link.from);
      const to = layout.get(link.to);
      if (!from || !to) return null;
      const h = Math.max(4, toNumber(link.count) * unit);
      const out = outOffsets.get(link.from) || 0;
      const incoming =
        link.to === "rejected" ? rejectedInOffsets.get(link) || 0 : inOffsets.get(link.to) || 0;
      outOffsets.set(link.from, out + h);
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

function renderNodeLabel(node, maxCol) {
  if (node.hideLabel) return null;

  const isFirst = node.col === 0;
  const isLast = node.col === maxCol;
  const isRound = typeof node.id === "string" && node.id.startsWith("round-");
  const isRejected = node.id === "rejected";
  const isAccepted = node.id === "accepted";
  const sideRight = (isLast || isRejected || isAccepted) && !isRound;
  const labelAbove =
    node.id === "awaiting" || node.id === "stale" || node.id === "ghosted" || isRound;
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

export function FunnelSankey({ sankey }) {
  const layout = useMemo(() => buildSankeyLayout(sankey), [sankey]);
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
                <path
                  className="funnel-sankey__link"
                  d={link.d}
                  data-sankey-link={link.id}
                  fill="none"
                  key={link.id}
                  stroke={link.color || "currentColor"}
                  strokeLinecap="butt"
                  strokeWidth={link.h}
                >
                  <title>{linkTitle(link, link.fromNode, link.toNode)}</title>
                </path>
              ))}
            </g>
            <g className="funnel-sankey__nodes">
              {layout.nodes.map((node) => (
                <g className="funnel-sankey__node" data-sankey-node={node.id} key={node.id}>
                  <rect
                    fill={node.color || "currentColor"}
                    height={node.h}
                    rx="2"
                    width={NODE_WIDTH}
                    x={node.x}
                    y={node.y}
                  />
                  {renderNodeLabel(node, maxCol)}
                  <title>{nodeTitle(node)}</title>
                </g>
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
