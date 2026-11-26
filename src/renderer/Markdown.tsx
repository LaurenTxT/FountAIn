import { createElement, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyText } from './ui';
import { projectFileLink } from '../shared/round-results';

// Member output is rendered as React nodes only. No HTML from a member is ever parsed or executed.

type Block =
  | { type: 'code'; lang: string; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'rule' }
  | { type: 'paragraph'; text: string };

const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)/);
    if (fence) {
      const body: string[] = []; index++;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index++]);
      index++; blocks.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') }); continue;
    }
    if (!line.trim()) { index++; continue; }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] }); index++; continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ type: 'rule' }); index++; continue; }
    if (line.includes('|') && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1])) {
      const header = cells(line); const rows: string[][] = []; index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(cells(lines[index++]));
      blocks.push({ type: 'table', header, rows }); continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) body.push(lines[index++].replace(/^\s{0,3}>\s?/, ''));
      blocks.push({ type: 'quote', text: body.join('\n') }); continue;
    }
    if (LIST_ITEM.test(line)) {
      const ordered = /^\s{0,3}\d/.test(line); const items: string[] = [];
      while (index < lines.length && (LIST_ITEM.test(lines[index]) || (/^\s{2,}\S/.test(lines[index]) && items.length))) {
        const current = lines[index++];
        if (LIST_ITEM.test(current)) items.push(current.replace(LIST_ITEM, ''));
        else items[items.length - 1] += '\n' + current.trim();
      }
      blocks.push({ type: 'list', ordered, items }); continue;
    }
    const body: string[] = [];
    while (index < lines.length && lines[index].trim() && !/^\s*(`{3,}|~{3,})/.test(lines[index]) && !/^\s{0,3}#{1,6}\s/.test(lines[index]) && !LIST_ITEM.test(lines[index]) && !/^\s{0,3}>/.test(lines[index])) body.push(lines[index++]);
    if (!body.length) body.push(lines[index++]);
    blocks.push({ type: 'paragraph', text: body.join('\n') });
  }
  return blocks;
}

const INLINE = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|~~([^~]+?)~~|\*([^*\s][^*]*?)\*|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\((<[^<>\r\n]+>|[^)\s]+)\)/g;
type DocumentLink = (target: string) => void;
export function inline(text: string, key = 'i', onDocument?: DocumentLink): ReactNode[] {
  // A fresh pattern per call: nested emphasis recurses, and a shared global regex would lose its place.
  const pattern = new RegExp(INLINE.source, 'g');
  const nodes: ReactNode[] = []; let last = 0; let match: RegExpExecArray | null; let count = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const id = `${key}-${count++}`;
    if (match[2] !== undefined) nodes.push(<code key={id}>{match[2]}</code>);
    else if (match[3] !== undefined || match[4] !== undefined) nodes.push(<strong key={id}>{inline(match[3] ?? match[4], id, onDocument)}</strong>);
    else if (match[5] !== undefined) nodes.push(<del key={id}>{inline(match[5], id, onDocument)}</del>);
    else if (match[6] !== undefined) nodes.push(<em key={id}>{inline(match[6], id, onDocument)}</em>);
    else if (match[8] !== undefined) {
      const target = match[8];
      const local = projectFileLink(target);
      const label = match[7]?.trim() || target.split(/[\\/]/).pop() || '图片';
      nodes.push(onDocument && local
        ? <button type="button" className="md-image-chip md-document-link" key={id} title={local} onClick={() => onDocument(target)}>🖼️ {label}</button>
        : <span className="md-image-chip" key={id} title={target}>🖼️ {label}</span>);
    }
    else if (match[9] !== undefined) {
      const target = match[10];
      const local = projectFileLink(target);
      const label = inline(match[9], id);
      nodes.push(onDocument && local
        ? <button type="button" className="md-link md-document-link" key={id} title={local} onClick={() => onDocument(target)}>{label}</button>
        : <span className="md-link" key={id} title={target}>{label}</span>);
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.flatMap<ReactNode>((node, index) => typeof node === 'string' ? node.split('\n').flatMap((part, line) => line ? [<br key={`${key}-br-${index}-${line}`} />, part] : [part]) : [node]);
}

/** Plain one-line text for previews: markdown punctuation removed. */
export function plainText(text: string) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`~>#|]+/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="md-code">
    <div className="md-code-bar"><span>{lang || '代码'}</span><button type="button" aria-label="复制代码" onClick={() => { void copyText(text).then(ok => { if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1400); } }); }}>{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? '已复制' : '复制'}</button></div>
    <pre><code>{text}</code></pre>
  </div>;
}

export function Markdown({ text, className = '', onDocument }: { text: string; className?: string; onDocument?: DocumentLink }) {
  const renderInline = (value: string, key: string) => inline(value, key, onDocument);
  const blocks = parseBlocks(text);
  return <div className={`markdown ${className}`}>{blocks.map((block, index) => {
    const key = `b${index}`;
    switch (block.type) {
      case 'code': return <CodeBlock key={key} lang={block.lang} text={block.text} />;
      case 'heading': return createElement(`h${Math.min(6, block.level + 2)}`, { key }, ...renderInline(block.text, key));
      case 'list': return createElement(block.ordered ? 'ol' : 'ul', { key }, block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item.replace(/^\[( |x|X)\]\s+/, (_all, mark) => mark.trim() ? '✅ ' : '⬜ '), `${key}-${itemIndex}`)}</li>));
      case 'quote': return <blockquote key={key}>{renderInline(block.text, key)}</blockquote>;
      case 'table': return <div className="md-table" key={key}><table><thead><tr>{block.header.map((cell, cellIndex) => <th key={cellIndex}>{renderInline(cell, `${key}-h${cellIndex}`)}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{block.header.map((_cell, cellIndex) => <td key={cellIndex}>{renderInline(row[cellIndex] ?? '', `${key}-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody></table></div>;
      case 'rule': return <hr key={key} />;
      default: return <p key={key}>{renderInline(block.text, key)}</p>;
    }
  })}</div>;
}
