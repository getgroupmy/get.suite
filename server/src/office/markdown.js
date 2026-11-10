// Markdown both ways for Docs: a document (TipTap JSON) as Markdown (GitHub style: tables, task
// lists, strikethrough, footnotes), and a .md file opened as a document. Underline, colours and
// highlight have no Markdown, so they're left out; pictures become their names.
import { flattenTabs } from './doctabs.js';
import { chartTable } from './sheetchart.js';
import { chipText, dateText } from './chiptext.js';
import { inText, reference, sourcesOf } from './cite.js';

// ---- document → Markdown ----
const escapeText = (s) => s.replace(/([\\`*_~[\]<>]|^#|^[-+](?= ))/gm, '\\$1').replace(/^(\d+)\. /gm, '$1\\. ')
  .replace(/\$(?=[^\s\d$])/g, '\\$'); // "$x" could start an equation; prices such as "$5" can't

function inline(nodes = [], notes) {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'hardBreak') { out += '  \n'; continue; }
    if (n.type === 'mention') { out += `@${escapeText(n.attrs?.name || '')}`; continue; }
    if (n.type === 'citation') { out += escapeText(inText(n.attrs)); continue; }
    if (n.type === 'math') { const l = String(n.attrs?.latex || '').replace(/\s+/g, ' ').trim(); if (l) out += `$${l}$`; continue; }
    if (n.type === 'datechip') { out += escapeText(dateText(n.attrs?.date)); continue; }
    if (n.type === 'filechip') { out += escapeText(n.attrs?.name || ''); continue; }
    if (n.type === 'dropchip') { out += `**${escapeText(chipText(n.attrs))}**`; continue; }
    if (n.type === 'footnote') { notes.push(n.attrs?.note || ''); out += `[^${notes.length}]`; continue; }
    if (n.type === 'image') { out += n.attrs?.alt || n.attrs?.title || ''; continue; }
    if (n.type !== 'text') { out += inline(n.content, notes); continue; }
    const marks = new Map((n.marks || []).map((m) => [m.type, m]));
    if (marks.has('code')) { const tick = n.text.includes('`') ? '``' : '`'; out += `${tick}${n.text}${tick}`; continue; }
    let t = escapeText(n.text);
    // Keep spaces outside the markers (**word** , not ** word **).
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(t);
    t = core;
    if (t) {
      if (marks.has('superscript')) t = `<sup>${t}</sup>`; // Markdown has none of its own; most readers take the HTML
      if (marks.has('subscript')) t = `<sub>${t}</sub>`;
      if (marks.has('strike')) t = `~~${t}~~`;
      if (marks.has('italic')) t = `*${t}*`;
      if (marks.has('bold')) t = `**${t}**`;
      const link = marks.get('link');
      if (link?.attrs?.href) t = `[${t}](${String(link.attrs.href).replace(/[()\s]/g, encodeURIComponent)})`;
    }
    out += lead + t + trail;
  }
  return out;
}

const cell = (c, notes) => (c.content || []).map((p) => inline(p.content, notes)).join(' ').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function blocks(nodes = [], notes, indent = '') {
  const out = [];
  for (const n of nodes) {
    const t = n.type;
    if (t === 'paragraph') out.push(indent + inline(n.content, notes));
    else if (t === 'heading') out.push(`${'#'.repeat(Math.min(6, n.attrs?.level || 1))} ${inline(n.content, notes)}`);
    else if (t === 'bulletList' || t === 'orderedList' || t === 'taskList') {
      const lines = [];
      (n.content || []).forEach((li, i) => {
        const marker = t === 'orderedList' ? `${(n.attrs?.start || 1) + i}.` : t === 'taskList' ? `- [${li.attrs?.checked ? 'x' : ' '}]` : '-';
        const [first, ...rest] = li.content || [];
        const head = first?.type === 'paragraph' ? inline(first.content, notes) : '';
        lines.push(`${indent}${marker} ${head}`);
        const pad = indent + ' '.repeat(t === 'orderedList' ? marker.length + 1 : 2);
        const more = blocks(first?.type === 'paragraph' ? rest : li.content, notes, pad);
        if (more.length) lines.push(...more.join('\n').split('\n').filter((l) => l.trim()));
      });
      out.push(lines.join('\n'));
    } else if (t === 'blockquote') out.push(blocks(n.content, notes).join('\n\n').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
    else if (t === 'codeBlock') {
      const code = (n.content || []).map((c) => c.text).join('');
      const fence = code.includes('```') ? '~~~' : '```';
      out.push(`${fence}${n.attrs?.language || ''}\n${code}\n${fence}`);
    } else if (t === 'horizontalRule' || t === 'pageBreak') out.push('---');
    else if (t === 'image') out.push(n.attrs?.alt || n.attrs?.title || '');
    else if (t === 'sheetChart') {
      const { title, rows } = chartTable(n.attrs);
      const esc = (x) => x.replace(/\|/g, '\\|');
      out.push([`**${title}**`, ...(rows.length ? ['', `| ${rows[0].map(esc).join(' | ')} |`, `|${' --- |'.repeat(rows[0].length)}`, ...rows.slice(1).map((r) => `| ${r.map(esc).join(' | ')} |`)] : [])].join('\n'));
    }
    else if (t === 'emailDraft') { // an email written in the document: its fields, then its text
      const a = n.attrs || {};
      const head = [['To', a.to], ['Cc', a.cc], ['Subject', a.subject]].filter(([k, v]) => v || k !== 'Cc').map(([k, v]) => `**${k}:** ${escapeText(String(v || ''))}`);
      out.push(head.join('  \n'), ...blocks(n.content, notes, indent));
    }
    else if (t === 'table') {
      const rows = (n.content || []).map((r) => (r.content || []).map((c) => cell(c, notes)));
      if (!rows.length) continue;
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
      out.push([line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n'));
    } else if (t === 'references') {
      const list = sourcesOf(blocks.doc);
      out.push(['**References**', ...list.map((s) => reference(s).map((p) => (p.italic ? `*${escapeText(p.text)}*` : escapeText(p.text))).join(''))].join('\n\n'));
    } else if (t !== 'tableOfContents' && n.content) out.push(...blocks(n.content, notes, indent));
  }
  return out.filter((b) => b !== '');
}

export function markdownFromDoc(doc) {
  doc = flattenTabs(doc);
  const notes = [];
  blocks.doc = doc; // the references list needs the whole document's citations
  const body = blocks(doc?.content, notes).join('\n\n');
  const defs = notes.map((t, i) => `[^${i + 1}]: ${escapeText(t).replace(/\n/g, ' ')}`);
  return `${body}${defs.length ? `\n\n${defs.join('\n')}` : ''}\n`;
}

// ---- Markdown → document ----
const text = (t, marks) => ({ type: 'text', text: t, ...(marks.length && { marks: marks.map((m) => (typeof m === 'string' ? { type: m } : m)) }) });

/** Inline Markdown: **bold**, *italic* / _italic_, ~~strike~~, `code`, [link](url), footnote refs, escapes. */
export function inlineFromMarkdown(s, notes = {}, marks = []) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(text(buf, marks)); buf = ''; } };
  for (let i = 0; i < s.length;) {
    const rest = s.slice(i);
    let m;
    if (s[i] === '\\' && i + 1 < s.length && /[\\`*_~[\]<>#+\-.!|()$]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    // $equation$: no space just inside the dollars, and not "$5 … 6$" money (no digit right after the closing one).
    if ((m = /^\$(?=\S)((?:\\.|[^$\n\\])*?(?:\\.|[^\s$\\]))\$(?!\d)/.exec(rest))) { flush(); out.push({ type: 'math', attrs: { latex: m[1] } }); i += m[0].length; continue; }
    if ((m = /^ {2,}\n|^\\\n/.exec(rest))) { flush(); out.push({ type: 'hardBreak' }); i += m[0].length; continue; }
    if ((m = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest))) { flush(); out.push(text(m[2].replace(/^ (.*) $/, '$1'), [...marks, 'code'])); i += m[0].length; continue; }
    if ((m = /^\[\^([^\]]+)\]/.exec(rest)) && notes[m[1]] !== undefined) { flush(); out.push({ type: 'footnote', attrs: { note: notes[m[1]] } }); i += m[0].length; continue; }
    if ((m = /^!?\[((?:\\.|[^\]])*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest))) {
      flush();
      const href = m[2];
      if (rest[0] === '!' || !/^(https?:|mailto:|\/|#)/i.test(href)) out.push(...inlineFromMarkdown(m[1], notes, marks));
      else out.push(...inlineFromMarkdown(m[1], notes, [...marks, { type: 'link', attrs: { href } }]));
      i += m[0].length; continue;
    }
    if ((m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest))) { flush(); out.push(...inlineFromMarkdown(m[2], notes, [...marks, 'bold'])); i += m[0].length; continue; }
    if ((m = /^<(sup|sub)>([\s\S]*?)<\/\1>/i.exec(rest))) { flush(); out.push(...inlineFromMarkdown(m[2], notes, [...marks, m[1].toLowerCase() === 'sup' ? 'superscript' : 'subscript'])); i += m[0].length; continue; }
    if ((m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) { flush(); out.push(...inlineFromMarkdown(m[1], notes, [...marks, 'strike'])); i += m[0].length; continue; }
    if ((m = /^([*_])(?=\S)([\s\S]*?\S)\1(?![*_\w])/.exec(rest)) && (s[i] === '*' || !/\w/.test(s[i - 1] || ''))) { flush(); out.push(...inlineFromMarkdown(m[2], notes, [...marks, 'italic'])); i += m[0].length; continue; }
    buf += s[i]; i++;
  }
  flush();
  return out;
}

const para = (s, notes) => { const c = inlineFromMarkdown(s.trim(), notes); return { type: 'paragraph', ...(c.length && { content: c }) }; };
const LIST_RE = /^( *)([-*+]|\d+[.)])\s+(.*)$/;
const splitRow = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

function parseBlocks(lines, notes) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = /^(```+|~~~+)\s*([\w+-]*)/.exec(line.trim()))) {
      const fence = m[1], code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence); i++) code.push(lines[i]);
      i++;
      out.push({ type: 'codeBlock', attrs: { language: m[2] || null }, ...(code.length && { content: [{ type: 'text', text: code.join('\n') }] }) });
      continue;
    }
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { out.push({ type: 'heading', attrs: { level: m[1].length }, content: inlineFromMarkdown(m[2], notes) }); i++; continue; }
    if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line)) { out.push({ type: 'horizontalRule' }); i++; continue; }
    if (/^\s*>/.test(line)) {
      const inner = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) inner.push(lines[i].replace(/^\s*> ?/, ''));
      out.push({ type: 'blockquote', content: parseBlocks(inner, notes) });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const rows = [splitRow(line)];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(splitRow(lines[i]));
      const width = rows[0].length;
      out.push({ type: 'table', content: rows.map((r, ri) => ({ type: 'tableRow', content: Array.from({ length: width }, (_, ci) => ({ type: ri === 0 ? 'tableHeader' : 'tableCell', content: [para(r[ci] || '', notes)] })) })) });
      continue;
    }
    if ((m = LIST_RE.exec(line))) {
      const base = m[1].length, ordered = /\d/.test(m[2]);
      const task = !ordered && /^\[[ xX]\]\s/.test(m[3]);
      const items = [];
      while (i < lines.length) {
        const lm = LIST_RE.exec(lines[i]);
        if (!lm || lm[1].length !== base || /\d/.test(lm[2]) !== ordered) break;
        const body = [lm[3]];
        for (i++; i < lines.length; i++) {
          const l = lines[i];
          if (!l.trim()) { if (i + 1 < lines.length && /^ {2,}\S/.test(lines[i + 1]) && lines[i + 1].search(/\S/) > base) { body.push(''); continue; } break; }
          if (l.search(/\S/) <= base && (LIST_RE.test(l) || !/^\s/.test(l))) break;
          body.push(l.slice(Math.min(l.search(/\S/), base + 2)));
        }
        let first = body[0];
        let checked = false;
        if (task) { checked = /^\[[xX]\]/.test(first); first = first.replace(/^\[[ xX]\]\s*/, ''); }
        const firstLines = [first];
        let k = 1;
        while (k < body.length && body[k].trim() && !LIST_RE.test(body[k])) firstLines.push(body[k++].trim());
        const content = [para(firstLines.join(' '), notes), ...parseBlocks(body.slice(k), notes)];
        items.push(task ? { type: 'taskItem', attrs: { checked }, content } : { type: 'listItem', content });
      }
      out.push({ type: task ? 'taskList' : ordered ? 'orderedList' : 'bulletList', ...(ordered && Number(m[2]) !== 1 && { attrs: { start: parseInt(m[2], 10) } }), content: items });
      continue;
    }
    const p = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|~~~|\s*>)/.test(lines[i]) && !(p.length && LIST_RE.test(lines[i])); i++) p.push(lines[i]);
    out.push(para(p.join('\n').replace(/(?<! {2})\n/g, ' '), notes));
  }
  return out;
}

export function docFromMarkdown(md) {
  const notes = {};
  const lines = String(md).replace(/\r\n?/g, '\n').replace(/^﻿/, '').split('\n').filter((l) => {
    const m = /^\[\^([^\]]+)\]:\s*(.*)$/.exec(l);
    if (m) { notes[m[1]] = m[2]; return false; }
    return true;
  });
  const content = parseBlocks(lines, notes);
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}
