"use client";

import type { ElementType, ReactNode } from "react";

type LightweightMarkdownProps = {
  readonly children?: ReactNode;
  readonly className?: string;
  readonly mode?: "streaming" | "static";
  readonly pluginSet?: "auto" | "full" | "cjk" | "code" | "math";
  readonly isAnimating?: boolean;
};

type Block =
  | { readonly type: "paragraph"; readonly text: string }
  | { readonly type: "heading"; readonly level: number; readonly text: string }
  | { readonly type: "quote"; readonly text: string }
  | { readonly type: "list"; readonly ordered: boolean; readonly items: string[] }
  | { readonly type: "code"; readonly language: string; readonly code: string }
  | { readonly type: "table"; readonly rows: string[][] };

export type LazyStreamdownProps = LightweightMarkdownProps;

export function LazyStreamdown({ className, children }: LazyStreamdownProps) {
  if (typeof children !== "string") {
    return <div className={className}>{children}</div>;
  }

  const blocks = parseMarkdown(children);
  return (
    <div className={className}>
      {blocks.map((block, index) => renderBlock(block, index))}
    </div>
  );
}

function parseMarkdown(input: string): Block[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language: fence[1] ?? "", code: code.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const tableLines: string[] = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index] ?? "")) {
        tableLines.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ type: "table", rows: tableLines.filter((row, rowIndex) => rowIndex !== 1).map(splitTableRow) });
      continue;
    }

    const listMatch = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$/);
    if (listMatch) {
      const ordered = Boolean(listMatch[2]);
      const items: string[] = [];
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$/);
        if (!item || Boolean(item[2]) !== ordered) break;
        items.push(item[3]!.trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? "")) {
        quote.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", text: quote.join("\n").trim() });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && shouldContinueParagraph(lines, index)) {
      paragraph.push((lines[index] ?? "").trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join("\n").trim() });
  }

  return blocks;
}

function shouldContinueParagraph(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  if (!line.trim()) return false;
  if (/^```/.test(line)) return false;
  if (/^(#{1,6})\s+/.test(line)) return false;
  if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) return false;
  if (/^\s*>\s?/.test(line)) return false;
  if (isTableStart(lines, index)) return false;
  return true;
}

function isTableStart(lines: string[], index: number): boolean {
  const current = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  return /^\s*\|.*\|\s*$/.test(current) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next);
}

function splitTableRow(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function renderBlock(block: Block, index: number) {
  switch (block.type) {
    case "heading": {
      const Tag = `h${block.level}` as ElementType;
      return <Tag key={index}>{renderInline(block.text)}</Tag>;
    }
    case "quote":
      return <blockquote key={index}>{renderInline(block.text)}</blockquote>;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag key={index}>
          {block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}
        </Tag>
      );
    }
    case "code":
      return (
        <pre key={index} className="overflow-auto rounded-md border border-border/40 bg-muted/45 p-3 text-xs leading-5">
          <code>{block.code}</code>
        </pre>
      );
    case "table":
      return (
        <div key={index} className="overflow-x-auto" data-streamdown="table-wrapper">
          <table>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => {
                    const Cell = rowIndex === 0 ? "th" : "td";
                    return <Cell key={cellIndex}>{renderInline(cell)}</Cell>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return <p key={index}>{renderInline(block.text)}</p>;
  }
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={nodes.length}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={nodes.length}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={nodes.length}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
