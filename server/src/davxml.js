// A small, strict XML reader for WebDAV request bodies: a tree of elements with their namespaces
// resolved ({ ns, local, attrs, children, text }), or null when the XML isn't well-formed (bad
// nesting, unclosed tags, undeclared or empty namespace prefixes). Plus writing elements back with
// explicit namespace declarations, so stored property values never depend on where they came from.
import { Parser } from 'htmlparser2';

export function parseXml(text) {
  const src = String(text || '').trim();
  if (!src) return null;
  let ok = true, root = null;
  const stack = [];
  const scopes = [{ '': '', xml: 'http://www.w3.org/XML/1998/namespace' }];
  const resolve = (qname, scope, isAttr) => {
    const i = qname.indexOf(':');
    const prefix = i < 0 ? '' : qname.slice(0, i), local = i < 0 ? qname : qname.slice(i + 1);
    if (isAttr && !prefix) return { ns: '', local };
    if (!(prefix in scope)) { ok = false; return { ns: '', local }; }
    return { ns: scope[prefix], local };
  };
  const p = new Parser({
    onopentag(name, attrs) {
      const scope = { ...scopes[scopes.length - 1] };
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'xmlns') scope[''] = v;
        else if (k.startsWith('xmlns:')) { if (!v) ok = false; scope[k.slice(6)] = v; }
      }
      scopes.push(scope);
      const { ns, local } = resolve(name, scope, false);
      const el = { ns, local, qname: name, attrs: {}, children: [], text: '', selfClosing: src[p.endIndex - 1] === '/' };
      for (const [k, v] of Object.entries(attrs)) if (k !== 'xmlns' && !k.startsWith('xmlns:')) { const a = resolve(k, scope, true); el.attrs[`{${a.ns}}${a.local}`] = v; }
      if (stack.length) stack[stack.length - 1].children.push(el);
      else if (root) ok = false; else root = el;
      stack.push(el);
    },
    onclosetag(name, implied) {
      const el = stack.pop();
      scopes.pop();
      // A self-closing tag (<a/>) is reported as "implied" too; only a missing end tag is wrong.
      if (!el || el.qname !== name || (implied && !el.selfClosing)) ok = false;
    },
    ontext(t) {
      if (stack.length) { const el = stack[stack.length - 1]; el.text += t; el.children.push({ text: t }); }
      else if (t.trim()) ok = false;
    },
    onerror() { ok = false; },
  }, { xmlMode: true, decodeEntities: true, recognizeSelfClosing: true });
  // A raw '<' or '&' that isn't markup makes it ill-formed; htmlparser2 would let it through.
  if (/<(?![!?/a-zA-Z_])/.test(src)) return null;
  p.write(src);
  p.end();
  return ok && root && !stack.length ? root : null;
}

export const elements = (el) => (el?.children || []).filter((c) => c.local !== undefined);
export const is = (el, ns, local) => el && el.ns === ns && el.local === local;
export const key = (el) => `{${el.ns}}${el.local}`;
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');

/** Children of an element as XML text, each element declaring its own namespace. */
export function innerXml(el) {
  return (el.children || []).map((c) => (c.local === undefined ? escText(c.text) : outerXml(c))).join('');
}
function outerXml(el) {
  const attrs = Object.entries(el.attrs || {}).map(([k, v]) => {
    const [, ns, local] = /^\{(.*)\}(.*)$/.exec(k);
    return ns ? ` xmlns:a="${escAttr(ns)}" a:${local}="${escAttr(v)}"` : ` ${local}="${escAttr(v)}"`;
  }).join('');
  return `<x:${el.local} xmlns:x="${escAttr(el.ns)}"${attrs}>${innerXml(el)}</x:${el.local}>`;
}

/** An element named {ns}local with the given inner XML. */
export function element(ns, local, inner = '') {
  if (ns === 'DAV:') return inner === '' ? `<d:${local}/>` : `<d:${local}>${inner}</d:${local}>`;
  if (!ns) return `<${local} xmlns="">${inner}</${local}>`;
  return `<p:${local} xmlns:p="${escAttr(ns)}">${inner}</p:${local}>`;
}
