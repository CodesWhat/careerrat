import { renderInlineMarkdown } from "./inlineMarkdown.jsx";

function tableCells(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function isTableDivider(cells) {
  return (
    Array.isArray(cells) && cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
  );
}

function keyedValues(values, serialize = (value) => String(value)) {
  const occurrences = new Map();
  return values.map((value) => {
    const serialized = serialize(value);
    const occurrence = (occurrences.get(serialized) || 0) + 1;
    occurrences.set(serialized, occurrence);
    return { key: `${serialized}\u0000${occurrence}`, value };
  });
}

function linesWithBreaks(lines, keyPrefix) {
  let first = true;
  return keyedValues(lines).flatMap(({ key, value }) => {
    const nodes = first ? [] : [<br key={`${keyPrefix}-br-${key}`} />];
    first = false;
    nodes.push(<span key={`${keyPrefix}-line-${key}`}>{renderInlineMarkdown(value)}</span>);
    return nodes;
  });
}

// Assistant text is untrusted. This renderer supports only the small block
// subset discovery agents use and delegates inline links/formatting to the
// safe React-only renderer. It never parses HTML or uses innerHTML.
export function renderChatMarkdown(text) {
  const lines = String(text || "")
    .replaceAll("\r\n", "\n")
    .split("\n");
  const nodes = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }

    const heading = lines[index].match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const Heading = heading[1].length === 1 ? "h2" : "h3";
      nodes.push(
        <Heading key={`heading-${index}`} className="chat-markdown__heading">
          {renderInlineMarkdown(heading[2])}
        </Heading>
      );
      index += 1;
      continue;
    }

    const headerCells = tableCells(lines[index]);
    const dividerCells = tableCells(lines[index + 1]);
    if (headerCells && isTableDivider(dividerCells) && headerCells.length === dividerCells.length) {
      const rows = [];
      index += 2;
      while (index < lines.length) {
        const cells = tableCells(lines[index]);
        if (!cells || cells.length !== headerCells.length) break;
        rows.push(cells);
        index += 1;
      }
      nodes.push(
        <div key={`table-${index}`} className="chat-markdown__table-wrap">
          <table>
            <thead>
              <tr>
                {keyedValues(headerCells).map(({ key, value }) => (
                  <th key={`head-${key}`} scope="col">
                    {renderInlineMarkdown(value)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keyedValues(rows, (cells) => cells.join("\u0000")).map(({ key, value: cells }) => (
                <tr key={`row-${key}`}>
                  {keyedValues(cells).map(({ key: cellKey, value }) => (
                    <td key={`cell-${cellKey}`}>{renderInlineMarkdown(value)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (/^\s*[-*]\s+/.test(lines[index])) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      nodes.push(
        <ul key={`list-${index}`} className="chat-markdown__list">
          {keyedValues(items).map(({ key, value }) => (
            <li key={`item-${key}`}>{renderInlineMarkdown(value)}</li>
          ))}
        </ul>
      );
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim()) {
      if (paragraph.length && /^(#{1,3})\s+/.test(lines[index])) break;
      if (paragraph.length && /^\s*[-*]\s+/.test(lines[index])) break;
      if (
        paragraph.length &&
        tableCells(lines[index]) &&
        isTableDivider(tableCells(lines[index + 1]))
      ) {
        break;
      }
      paragraph.push(lines[index]);
      index += 1;
    }
    nodes.push(
      <p key={`paragraph-${index}`} className="chat-markdown__paragraph">
        {linesWithBreaks(paragraph, `paragraph-${index}`)}
      </p>
    );
  }

  return nodes;
}
