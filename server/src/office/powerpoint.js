// PowerPoint files <-> Slides: slide by slide, text boxes (with size, bold, italic, colour,
// alignment), rectangles, rounded rectangles and ellipses, pictures, and slide backgrounds (colours and pictures), at their
// places on the slide. Boxes are kept in percent of the slide, as Slides does.
import { histogramOf, waterfallOf } from './chartshapes.js';
import JSZip from 'jszip';
import path from 'node:path';
import PptxGenJS from 'pptxgenjs';
import { parseXml, elements } from '../davxml.js';
import { chartDataFromXml } from './xlsxcharts.js';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const THEMES = { light: { bg: '#ffffff', text: '#202124', accent: '#1a73e8' }, dark: { bg: '#202124', text: '#f1f3f4', accent: '#8ab4f8' }, ocean: { bg: '#0b57d0', text: '#ffffff', accent: '#ffd666' }, sand: { bg: '#f7f1e3', text: '#3c2f1e', accent: '#b5651d' } };
// PowerPoint's shape names → Slides' (and back, for downloads).
const SHAPES = { rect: 'rect', roundRect: 'round', ellipse: 'ellipse', triangle: 'triangle', diamond: 'diamond', rightArrow: 'arrowblock', chevron: 'chevron', star5: 'star', wedgeRoundRectCallout: 'callout' };
export const OUTLINE_WIDTHS = [1, 2, 4, 6]; // points
const PPT_SHAPES = Object.fromEntries(Object.entries(SHAPES).map(([ppt, ours]) => [ours, ppt]));

const kids = (el, ns, local) => elements(el).filter((e) => e.ns === ns && e.local === local);
const kid = (el, ns, local) => kids(el, ns, local)[0];
const deep = (el, ns, local) => { const out = []; const walk = (e) => { for (const c of elements(e)) { if (c.ns === ns && c.local === local) out.push(c); walk(c); } }; if (el) walk(el); return out; };
const attr = (el, name) => el?.attrs?.[`{}${name}`];
const rattr = (el, name) => el?.attrs?.[`{${R}}${name}`];
const id = () => Math.random().toString(36).slice(2, 10);
const relsOf = async (zip, file) => {
  const x = await zip.file(path.posix.join(path.posix.dirname(file), '_rels', `${path.posix.basename(file)}.rels`))?.async('string');
  const doc = x && parseXml(x);
  // Targets are relative to the part, or from the package's root when they start with "/".
  const where = (t) => (String(t || '').startsWith('/') ? String(t).slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(file), t)));
  return new Map((doc ? kids(doc, RELS, 'Relationship') : []).map((r) => [attr(r, 'Id'), where(attr(r, 'Target'))]));
};
const colorIn = (el) => { const c = deep(el, A, 'srgbClr')[0]; return c ? `#${attr(c, 'val').toLowerCase()}` : null; };

// ---- comments on slides: PowerPoint's older kind (comments/commentN.xml, names in commentAuthors.xml) and
// its newer one (modernComment_*.xml, names in authors.xml, with replies and a resolved status).
const pptComments = new WeakMap(); // deck → [{ slideId, author, text, at, resolved, replies: [{ author, text, at }] }]
/** The comments a presentation read from PowerPoint had, by slide (see deckFromPowerPoint). */
export const commentsOfDeck = (deck) => pptComments.get(deck) || [];
const unxml = (t) => String(t ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const when = (t) => { const ms = Date.parse(t || ''); return Number.isFinite(ms) ? ms : null; };
const paraText = (xml) => [...String(xml).matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)].map((p) => unxml([...p[0].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join(''))).join('\n').trim();
async function authorsOf(zip) {
  const names = new Map();
  for (const f of ['ppt/commentAuthors.xml', 'ppt/authors.xml']) {
    const x = await zip.file(f)?.async('string');
    for (const m of String(x || '').matchAll(/<p(?:188)?:(?:cmAuthor|author)\b([^>]*)\/?>/g)) {
      const id = /\bid="([^"]+)"/.exec(m[1])?.[1], name = /\bname="([^"]*)"/.exec(m[1])?.[1];
      if (id !== undefined) names.set(id, unxml(name || '').slice(0, 100));
    }
  }
  return names;
}
async function slideCommentsOf(zip, slideFile, authors) {
  const relsXml = await zip.file(path.posix.join(path.posix.dirname(slideFile), '_rels', `${path.posix.basename(slideFile)}.rels`))?.async('string');
  const out = [];
  for (const m of String(relsXml || '').matchAll(/<Relationship\b[^>]*>/g)) {
    if (!/Type="[^"]*\/comments"/.test(m[0])) continue;
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (!target) continue;
    const file = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(slideFile), target));
    const x = String(await zip.file(file)?.async('string') || '');
    // The newer kind: a thread with its replies.
    for (const cm of x.matchAll(/<p188:cm\b([^>]*)>([\s\S]*?)<\/p188:cm>/g)) {
      const body = cm[2].replace(/<p188:replyLst>[\s\S]*<\/p188:replyLst>/, '');
      const text = paraText(/<p188:txBody>([\s\S]*?)<\/p188:txBody>/.exec(body)?.[1] || '');
      if (!text) continue;
      const replies = [...cm[2].matchAll(/<p188:reply\b([^>]*)>([\s\S]*?)<\/p188:reply>/g)].map((r) => ({
        author: authors.get(/authorId="([^"]+)"/.exec(r[1])?.[1]) || '', text: paraText(r[2]), at: when(/created="([^"]+)"/.exec(r[1])?.[1]),
      })).filter((r) => r.text);
      out.push({ author: authors.get(/authorId="([^"]+)"/.exec(cm[1])?.[1]) || '', text, at: when(/created="([^"]+)"/.exec(cm[1])?.[1]), resolved: /status="resolved"/.test(cm[1]), replies });
    }
    // The older kind: one comment each (a reply names its parent in an extension).
    const old = [...x.matchAll(/<p:cm\b([^>]*)>([\s\S]*?)<\/p:cm>/g)].map((cm) => ({
      key: `${/authorId="(\d+)"/.exec(cm[1])?.[1]}:${/idx="(\d+)"/.exec(cm[1])?.[1]}`,
      parent: (() => { const pm = /<p15:parentCm\b[^>]*authorId="(\d+)"[^>]*idx="(\d+)"/.exec(cm[2]); return pm ? `${pm[1]}:${pm[2]}` : null; })(),
      author: authors.get(/authorId="(\d+)"/.exec(cm[1])?.[1]) || '', text: unxml(/<p:text>([\s\S]*?)<\/p:text>/.exec(cm[2])?.[1] || '').trim(), at: when(/dt="([^"]+)"/.exec(cm[1])?.[1]),
    })).filter((c) => c.text);
    const tops = old.filter((c) => !c.parent || !old.some((o) => o.key === c.parent));
    for (const t of tops) out.push({ author: t.author, text: t.text, at: t.at, resolved: false, replies: old.filter((c) => c.parent === t.key).map((c) => ({ author: c.author, text: c.text, at: c.at })) });
  }
  return out.slice(0, 200).map((c) => ({ ...c, text: c.text.slice(0, 4000), replies: c.replies.slice(0, 100).map((r) => ({ ...r, text: r.text.slice(0, 4000) })) }));
}

/** A box's link as PowerPoint takes it: { url } for a web page (http, https or mailto), { slide: n } (1-based) for another slide. */
/**
 * A scatter chart's series for PowerPoint: the X values first, then each Y series (as Sheets draws
 * it: X from the first column of numbers when the rows have no names, else numeric row names, else 1, 2, 3…).
 */
export function scatterSeries(data) {
  const cats = (data?.categories || []).map(String), all = data?.series || [];
  const rowNumbers = cats.every((c, i) => c === String(i + 1));
  const numericNames = cats.length > 0 && cats.every((c) => c !== '' && !Number.isNaN(Number(c)));
  const num = (v) => (typeof v === 'number' ? v : 0);
  if (rowNumbers && all.length > 1) return [{ name: all[0].name || 'X', values: all[0].values.map(num) }, ...all.slice(1).map((x) => ({ name: String(x.name || ''), values: x.values.map(num) }))];
  return [{ name: 'X', values: cats.map((c, i) => (numericNames ? Number(c) : i + 1)) }, ...all.map((x) => ({ name: String(x.name || ''), values: x.values.map(num) }))];
}

export function linkFor(link, slides) {
  if (!link) return null;
  if (link.slide !== undefined) { const n = slides.findIndex((x) => x.id === link.slide); return n >= 0 ? { slide: n + 1 } : null; }
  const url = String(link.url || '');
  return /^(https?:\/\/|mailto:)[^\s"<>]+$/i.test(url) ? { url: url.slice(0, 2000) } : null;
}

/** Relationships as written (external addresses kept as they are): id → { target, external }. */
const rawRelsOf = async (zip, file) => {
  const x = await zip.file(path.posix.join(path.posix.dirname(file), '_rels', `${path.posix.basename(file)}.rels`))?.async('string');
  const doc = x && parseXml(x);
  return new Map((doc ? kids(doc, RELS, 'Relationship') : []).map((r) => [attr(r, 'Id'), { target: attr(r, 'Target'), external: attr(r, 'TargetMode') === 'External' }]));
};

/** Seconds a slide stays before moving on by itself (1 to 3600), or null. */
export function advanceOf(v) {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n) || n <= 0) return null;
  return Math.min(3600, Math.max(1, Math.round(n / 1000)));
}

const TRANSITION_XML = { fade: '<p:fade/>', push: '<p:push dir="u"/>', zoom: '<p:zoom/>' };

/**
 * What PowerPoint's file writer leaves out: each slide's transition and automatic advance
 * (<p:transition advTm="…">, after the slide's colour mapping), and looping (<p:showPr loop="1">).
 */
// ---- animations: PowerPoint's entrance effects ↔ Slides' (appear, fade, fly), one a click.
const PRESETS = { 1: 'appear', 10: 'fade', 2: 'fly' };
/** A slide's entrance effects (main sequence), in order: [{ spid, anim }]. Effects Slides doesn't have come in as a fade. */
export function animationsOf(slideXml) {
  const timing = /<p:timing>[\s\S]*<\/p:timing>/.exec(String(slideXml))?.[0];
  if (!timing) return [];
  const out = [];
  const re = /<p:cTn\b([^>]*\bpresetClass="entr"[^>]*)>([\s\S]*?)<p:spTgt spid="(\d+)"/g;
  for (let m; (m = re.exec(timing));) {
    const preset = Number(/presetID="(\d+)"/.exec(m[1])?.[1]);
    if (!out.some((o) => o.spid === m[3])) out.push({ spid: m[3], anim: PRESETS[preset] || 'fade' });
  }
  return out.slice(0, 100);
}
let ctnId = 2;
const ctn = () => ++ctnId;
const tgt = (spid) => `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>`;
const showIt = (spid) => `<p:set><p:cBhvr><p:cTn id="${ctn()}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>${tgt(spid)}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>`;
const EFFECT = {
  appear: (spid) => showIt(spid),
  fade: (spid) => `${showIt(spid)}<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="${ctn()}" dur="500"/>${tgt(spid)}</p:cBhvr></p:animEffect>`,
  fly: (spid) => `${showIt(spid)}${['ppt_x', 'ppt_y'].map((a) => `<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="${ctn()}" dur="500" fill="hold"/>${tgt(spid)}<p:attrNameLst><p:attrName>${a}</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="${a === 'ppt_x' ? '#ppt_x' : '1+#ppt_h/2'}"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="#${a}"/></p:val></p:tav></p:tavLst></p:anim>`).join('')}`,
};
const PRESET_OF = { appear: [1, 0], fade: [10, 0], fly: [2, 4] }; // [presetID, presetSubtype (4: from the bottom)]
/** A slide's animations as PowerPoint writes them: a click sequence of entrance effects. `builds`: [{ spid, anim, text }]. */
export function timingXml(builds) {
  ctnId = 2;
  const clicks = builds.map((b) => {
    const [preset, sub] = PRESET_OF[b.anim] || PRESET_OF.fade;
    const outer = ctn(), mid = ctn(), eff = ctn();
    return `<p:par><p:cTn id="${outer}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="${mid}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="${eff}" presetID="${preset}" presetClass="entr" presetSubtype="${sub}" fill="hold" grpId="0" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${(EFFECT[b.anim] || EFFECT.fade)(b.spid)}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`;
  }).join('');
  const bld = builds.filter((b) => b.text).map((b) => `<p:bldP spid="${b.spid}" grpId="0" animBg="1"/>`).join('');
  return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${clicks}</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst>${bld ? `<p:bldLst>${bld}</p:bldLst>` : ''}</p:timing>`;
}

const xmlEsc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/**
 * The file with comments on its slides, in PowerPoint's comment format that every version and
 * LibreOffice read: comment authors in ppt/commentAuthors.xml, each slide's comments in
 * ppt/comments/commentN.xml (a reply names the comment it answers).
 */
export async function withSlideComments(buffer, deck, threads) {
  const bySlide = new Map();
  for (const t of threads || []) {
    const i = (deck.slides || []).findIndex((s) => s.id === t.slideId);
    if (i < 0 || !t.text) continue;
    if (!bySlide.has(i)) bySlide.set(i, []);
    bySlide.get(i).push(t);
  }
  if (!bySlide.size) return buffer;
  const zip = await JSZip.loadAsync(buffer);
  const authors = new Map(); // name → { id, lastIdx }
  const authorOf = (name) => { const n = String(name || 'Workspace').slice(0, 100); if (!authors.has(n)) authors.set(n, { id: authors.size, lastIdx: 0 }); return authors.get(n); };
  const stamp = (ms) => new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().replace(/Z$/, '');
  let types = await zip.file('[Content_Types].xml').async('string');
  for (const [i, list] of bySlide) {
    const slideFile = `ppt/slides/slide${i + 1}.xml`;
    if (!zip.file(slideFile)) continue;
    const cms = [];
    list.slice(0, 200).forEach((t, k) => {
      const a = authorOf(t.author);
      const idx = ++a.lastIdx;
      const y = 80 + k * 160; // down the slide's corner, one under another
      cms.push(`<p:cm authorId="${a.id}" dt="${stamp(t.at)}" idx="${idx}"><p:pos x="10" y="${y}"/><p:text>${xmlEsc(t.text)}</p:text></p:cm>`);
      for (const r of (t.replies || []).slice(0, 100)) {
        const ra = authorOf(r.author);
        cms.push(`<p:cm authorId="${ra.id}" dt="${stamp(r.at)}" idx="${++ra.lastIdx}"><p:pos x="10" y="${y}"/><p:text>${xmlEsc(r.text)}</p:text><p:extLst><p:ext uri="{C676402C-5697-4E1C-873F-D02D1690AC5C}"><p15:threadingInfo xmlns:p15="http://schemas.microsoft.com/office/powerpoint/2012/main" timeZoneBias="0"><p15:parentCm authorId="${a.id}" idx="${idx}"/></p15:threadingInfo></p:ext></p:extLst></p:cm>`);
      }
    });
    const file = `ppt/comments/comment${i + 1}.xml`;
    zip.file(file, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:cmLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">${cms.join('')}</p:cmLst>`);
    types = types.replace('</Types>', `<Override PartName="/${file}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.comments+xml"/></Types>`);
    const relsFile = `ppt/slides/_rels/slide${i + 1}.xml.rels`;
    const rels = (await zip.file(relsFile)?.async('string')) || '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    zip.file(relsFile, rels.replace('</Relationships>', `<Relationship Id="rIdComments1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments/comment${i + 1}.xml"/></Relationships>`));
  }
  zip.file('ppt/commentAuthors.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:cmAuthorLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">${[...authors].map(([name, a]) => `<p:cmAuthor id="${a.id}" name="${xmlEsc(name)}" initials="${xmlEsc(name.split(/\s+/).map((w) => w[0] || '').join('').slice(0, 3).toUpperCase())}" lastIdx="${a.lastIdx}" clrIdx="${a.id % 8}"/>`).join('')}</p:cmAuthorLst>`);
  types = types.replace('</Types>', '<Override PartName="/ppt/commentAuthors.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml"/></Types>');
  zip.file('[Content_Types].xml', types);
  const presRels = 'ppt/_rels/presentation.xml.rels';
  zip.file(presRels, (await zip.file(presRels).async('string')).replace('</Relationships>', '<Relationship Id="rIdCmAuthors" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/commentAuthors" Target="commentAuthors.xml"/></Relationships>'));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function withShowSettings(buffer, deck, emitted = new Map()) {
  const slides = deck.slides || [];
  if (!deck.loop && !slides.some((s) => s.transition || s.advance || (s.items || []).some((it) => it.anim))) return buffer;
  const zip = await JSZip.loadAsync(buffer);
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    // Animations: each box's shape id is the one in the same place among the slide's shapes.
    const anims = (s.items || []).filter((it) => it.anim).sort((a, b) => (a.animAt || 0) - (b.animAt || 0));
    if (anims.length) {
      const file = `ppt/slides/slide${i + 1}.xml`;
      const xml = await zip.file(file)?.async('string');
      const shown = emitted.get(s) || [];
      const ids = [...String(xml || '').matchAll(/<p:cNvPr id="(\d+)" name="([^"]*)"/g)].filter((m) => m[1] !== '1' && !/Placeholder/.test(m[2])).map((m) => m[1]);
      const builds = anims.map((it) => { const k = shown.indexOf(it); return k >= 0 && ids[k] ? { spid: ids[k], anim: it.anim, text: it.type === 'text' || !!it.text } : null; }).filter(Boolean);
      if (xml && builds.length) {
        const timing = timingXml(builds);
        zip.file(file, /<p:extLst>(?![\s\S]*<p:cSld)/.test(xml.split('</p:cSld>')[1] || '') ? xml.replace(/(<\/p:cSld>[\s\S]*?)(<p:extLst>)/, `$1${timing}$2`) : xml.replace('</p:sld>', `${timing}</p:sld>`));
      }
    }
    const secs = Number(s.advance) > 0 ? Math.min(3600, Math.round(Number(s.advance))) : 0;
    if (!s.transition && !secs) continue;
    const file = `ppt/slides/slide${i + 1}.xml`;
    const xml = await zip.file(file)?.async('string');
    if (!xml) continue;
    const el = `<p:transition spd="med"${secs ? ` advTm="${secs * 1000}"` : ''}>${TRANSITION_XML[s.transition] || ''}</p:transition>`;
    zip.file(file, xml.includes('</p:clrMapOvr>') ? xml.replace('</p:clrMapOvr>', `</p:clrMapOvr>${el}`) : xml.replace('</p:sld>', `${el}</p:sld>`));
  }
  if (deck.loop) {
    const props = await zip.file('ppt/presProps.xml')?.async('string');
    if (props) {
      const show = '<p:showPr loop="1" showNarration="1"><p:present/><p:sldAll/><p:penClr><a:prstClr val="red"/></p:penClr></p:showPr>';
      zip.file('ppt/presProps.xml', props.replace(/<p:presentationPr([^>]*)\/>/, `<p:presentationPr$1>${show}</p:presentationPr>`).replace(/<p:presentationPr([^>]*[^/])>(?!<p:showPr)/, `<p:presentationPr$1>${show}`));
    }
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * A PowerPoint file as a Slides presentation. `savePicture(name, buffer, mime)` stores a picture
 * (in Drive) and returns its file id.
 */
export async function deckFromPowerPoint(buffer, { savePicture }) {
  const zip = await JSZip.loadAsync(buffer);
  const pres = parseXml(await zip.file('ppt/presentation.xml').async('string'));
  const size = kid(pres, P, 'sldSz');
  const W = Number(attr(size, 'cx')) || 12192000, H = Number(attr(size, 'cy')) || 6858000;
  const widthIn = W / 914400;
  const presRels = await relsOf(zip, 'ppt/presentation.xml');
  const order = kids(kid(pres, P, 'sldIdLst'), P, 'sldId').map((s) => presRels.get(rattr(s, 'id'))).filter(Boolean);
  const slides = [], slideFiles = [];
  const authors = await authorsOf(zip), comments = [];
  const numbered = new Set(); // slides with a slide number field
  for (const file of order) {
    const xml = parseXml(await zip.file(file)?.async('string') || '');
    if (!xml) continue;
    const rels = await relsOf(zip, file);
    // Placeholders without their own position take it from the slide's layout.
    const layoutFile = [...rels.values()].find((t) => t.includes('slideLayouts/'));
    const layout = layoutFile ? parseXml(await zip.file(layoutFile)?.async('string') || '') : null;
    const layoutBoxes = new Map(deep(layout, P, 'sp').map((sp) => { const ph = deep(sp, P, 'ph')[0]; return [ph ? `${attr(ph, 'type') || 'body'}:${attr(ph, 'idx') || ''}` : null, deep(sp, A, 'xfrm')[0]]; }).filter(([k, x]) => k && x));
    const boxOf = (el) => {
      let xf = deep(kid(el, P, 'spPr'), A, 'xfrm')[0];
      if (!xf) { const ph = deep(el, P, 'ph')[0]; if (ph) xf = layoutBoxes.get(`${attr(ph, 'type') || 'body'}:${attr(ph, 'idx') || ''}`) || [...layoutBoxes.entries()].find(([k]) => k.startsWith(`${attr(ph, 'type') || 'body'}:`))?.[1]; }
      const off = kid(xf, A, 'off'), ext = kid(xf, A, 'ext');
      if (!off || !ext) return null;
      let rot = Math.round(Number(attr(xf, 'rot')) / 60000) || 0; // turned (in 60000ths of a degree)
      rot = ((rot % 360) + 540) % 360 - 180; if (rot === -180) rot = 180;
      return { x: (Number(attr(off, 'x')) / W) * 100, y: (Number(attr(off, 'y')) / H) * 100, w: (Number(attr(ext, 'cx')) / W) * 100, h: (Number(attr(ext, 'cy')) / H) * 100, ...(rot && { rot }) };
    };
    const items = [];
    const raw = await rawRelsOf(zip, file);
    // A shape's (or its text's) click link: a web page, or another slide (resolved once all slides are read).
    const linkOfEl = (el) => {
      const h = deep(el, A, 'hlinkClick')[0];
      const rid = h && rattr(h, 'id');
      const rel = rid && raw.get(rid);
      if (!rel) return null;
      if (rel.external) return /^(https?:\/\/|mailto:)[^\s"<>]+$/i.test(rel.target) ? { url: rel.target.slice(0, 2000) } : null;
      if (/hlinksldjump/.test(attr(h, 'action') || '') || /slides\/slide\d+\.xml$/.test(rel.target)) return { file: path.posix.normalize(path.posix.join(path.posix.dirname(file), rel.target)) };
      return null;
    };
    const linked = (el, item) => { const l = linkOfEl(el); if (l) item.link = l; return item; };
    const tree = deep(xml, P, 'spTree')[0];
    const spidOf = new Map(); // item → its shape id on the slide (for animations)
    const pushFrom = (el, item) => { spidOf.set(item, attr(deep(el, P, 'cNvPr')[0], 'id')); items.push(item); };
    for (const el of deep(tree, P, 'sp').concat(deep(tree, P, 'cxnSp'), deep(tree, P, 'pic'))) { // shapes, connectors (lines, arrows), pictures
      const box = boxOf(el);
      if (!box) continue;
      if (el.local === 'pic') {
        const embed = rattr(deep(el, A, 'blip')[0], 'embed');
        const target = embed && rels.get(embed);
        const data = target && await zip.file(target)?.async('nodebuffer');
        const ext = target ? path.posix.extname(target).slice(1).toLowerCase() : '';
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' }[ext];
        // Its description for screen readers (PowerPoint's Alt Text), when it has one.
        // (Some programs write the picture's own data or file path there instead: not a description.)
        const raw = String(attr(deep(el, P, 'cNvPr')[0], 'descr') || '').replace(/\s+/g, ' ').trim();
        const descr = /^(data:|[a-z]:\\|\/|file:|preencoded\.\w+$)/i.test(raw) ? '' : raw.slice(0, 500);
        if (data && mime) pushFrom(el, linked(el, { id: id(), type: 'image', fileId: await savePicture(path.posix.basename(target), data, mime), name: path.posix.basename(target), ...(descr && { alt: descr }), ...box }));
        continue;
      }
      // A slide number field: the presentation numbers its slides (not a text box of its own).
      if (deep(el, A, 'fld').some((f) => attr(f, 'type') === 'slidenum')) { numbered.add(slides.length); continue; }
      const paras = deep(el, A, 'p');
      const texts = paras.map((p) => deep(p, A, 't').map((t) => t.text).join(''));
      const content = texts.join('\n').replace(/\n+$/, '');
      const geom = attr(deep(kid(el, P, 'spPr'), A, 'prstGeom')[0], 'prst');
      if (geom === 'line' || geom === 'straightConnector1') {
        const ln = deep(kid(el, P, 'spPr'), A, 'ln')[0];
        const xf = deep(kid(el, P, 'spPr'), A, 'xfrm')[0];
        const flipH = attr(xf, 'flipH') === '1', flipV = attr(xf, 'flipV') === '1';
        const arrow = !!deep(ln, A, 'tailEnd').find((t) => attr(t, 'type') && attr(t, 'type') !== 'none');
        const flat = box.h < 0.5, tall = box.w < 0.5;
        const dir = flat ? (flipH ? 'hr' : 'h') : tall ? (flipV ? 'vr' : 'v') : flipV !== flipH ? 'u' : 'd';
        const lineColor = colorIn(kid(ln, A, 'solidFill'));
        pushFrom(el, { id: id(), type: 'shape', shape: arrow ? 'arrow' : 'line', dir, fill: lineColor || 'text', ...box,
          ...(flat && { y: box.y - 4, h: 8 }), ...(tall && { x: box.x - 2, w: 4 }) });
        continue;
      }
      const fill = colorIn(kid(kid(el, P, 'spPr'), A, 'solidFill'));
      // Its outline: a coloured line round it (the nearest of 1, 2, 4 or 6 points).
      const ln = kid(kid(el, P, 'spPr'), A, 'ln');
      const lineColor = ln && !kid(ln, A, 'noFill') && colorIn(kid(ln, A, 'solidFill'));
      const pts = Number(attr(ln, 'w')) / 12700 || 1;
      const edge = lineColor ? { outline: lineColor, outlineW: OUTLINE_WIDTHS.reduce((a, b) => (Math.abs(b - pts) < Math.abs(a - pts) ? b : a)) } : {};
      if (!content.trim()) {
        if (SHAPES[geom] && fill) pushFrom(el, linked(el, { id: id(), type: 'shape', shape: SHAPES[geom], fill, ...edge, ...box }));
        continue;
      }
      const rPr = deep(el, A, 'rPr')[0] || deep(el, A, 'defRPr')[0];
      const pt = Number(attr(rPr, 'sz')) / 100 || 18;
      const algn = attr(deep(el, A, 'pPr')[0], 'algn');
      // A filled shape with words in it: a shape holding its text. (A filled rectangle whose words start at
      // the top, or one PowerPoint marks as a text box, is a text box with a colour behind it.)
      const anchor = attr(deep(el, A, 'bodyPr')[0], 'anchor');
      const textBox = attr(deep(el, P, 'cNvSpPr')[0], 'txBox') === '1' || (geom === 'rect' && anchor !== 'ctr' && anchor !== 'b');
      if (SHAPES[geom] && fill && !textBox) {
        pushFrom(el, linked(el, { id: id(), type: 'shape', shape: SHAPES[geom], fill, ...edge, text: content, ...box,
          size: Math.max(8, Math.round((pt / 72) * 1000 / widthIn)),
          ...(attr(rPr, 'b') === '1' && { bold: true }), ...(attr(rPr, 'i') === '1' && { italic: true }),
          ...(colorIn(kid(rPr, A, 'solidFill')) && { color: colorIn(kid(rPr, A, 'solidFill')) }),
          ...({ l: { align: 'left' }, r: { align: 'right' } }[algn] || {}) }));
        continue;
      }
      const ph = attr(deep(el, P, 'ph')[0], 'type');
      pushFrom(el, linked(el, {
        id: id(), type: 'text', role: ph === 'title' || ph === 'ctrTitle' ? 'title' : ph === 'subTitle' ? 'subtitle' : 'body', text: content, ...box,
        size: Math.max(8, Math.round((pt / 72) * 1000 / widthIn)),
        ...(attr(rPr, 'b') === '1' && { bold: true }), ...(attr(rPr, 'i') === '1' && { italic: true }),
        ...(colorIn(kid(rPr, A, 'solidFill')) && { color: colorIn(kid(rPr, A, 'solidFill')) }),
        ...({ ctr: { align: 'center' }, r: { align: 'right' } }[algn] || {}),
        ...(fill && { fill }), ...edge,
      }));
    }
    // Tables: each cell's text (the first row as headings when PowerPoint marks it so). Charts: their
    // own copy of the figures (a chart not tied to a spreadsheet here), of a kind Slides draws.
    for (const gf of deep(tree, P, 'graphicFrame')) {
      const tbl = deep(gf, A, 'tbl')[0];
      const xf = kid(gf, P, 'xfrm'), off = kid(xf, A, 'off'), ext = kid(xf, A, 'ext');
      const chartRef = deep(gf, 'http://schemas.openxmlformats.org/drawingml/2006/chart', 'chart')[0];
      const chartFile = chartRef && rels.get(rattr(chartRef, 'id'));
      if (chartFile && off && ext) {
        const c = chartDataFromXml(await zip.file(chartFile)?.async('string') || '');
        if (c) pushFrom(gf, { id: id(), type: 'chart', chartType: c.type, title: c.title || '', data: c.data,
          x: (Number(attr(off, 'x')) / W) * 100, y: (Number(attr(off, 'y')) / H) * 100, w: (Number(attr(ext, 'cx')) / W) * 100, h: (Number(attr(ext, 'cy')) / H) * 100 });
        continue;
      }
      if (!tbl || !off || !ext) continue;
      const cells = kids(tbl, A, 'tr').map((tr) => kids(tr, A, 'tc').map((tc) => deep(tc, A, 'p').map((p) => deep(p, A, 't').map((t) => t.text).join('')).join('\n')));
      if (!cells.length || !cells[0].length) continue;
      const cols = Math.max(...cells.map((r) => r.length));
      const rPr = deep(tbl, A, 'rPr')[0];
      const pt = Number(attr(rPr, 'sz')) / 100 || 14;
      pushFrom(gf, { id: id(), type: 'table', cells: cells.map((r) => [...r, ...Array(cols - r.length).fill('')]).slice(0, 20).map((r) => r.slice(0, 10)),
        header: attr(kid(tbl, A, 'tblPr'), 'firstRow') === '1' || kids(kids(tbl, A, 'tr')[0], A, 'tc').every((tc) => deep(tc, A, 'rPr').some((r) => attr(r, 'b') === '1')), size: Math.max(8, Math.round((pt / 72) * 1000 / widthIn)),
        x: (Number(attr(off, 'x')) / W) * 100, y: (Number(attr(off, 'y')) / H) * 100, w: (Number(attr(ext, 'cx')) / W) * 100, h: (Number(attr(ext, 'cy')) / H) * 100 });
    }
    // Animations: the entrance effects of the slide's click sequence, in order, as Slides' own.
    const effects = animationsOf(await zip.file(file)?.async('string') || '');
    effects.forEach((e, k) => {
      const item = items.find((it) => spidOf.get(it) === e.spid && !it.anim);
      if (item) Object.assign(item, { anim: e.anim, animAt: k + 1 });
    });
    const bgEl = deep(xml, P, 'bg')[0];
    const bg = colorIn(bgEl);
    // A picture behind the slide (a background fill with a picture).
    let bgImage = null;
    const bgEmbed = bgEl && rattr(deep(bgEl, A, 'blip')[0], 'embed');
    const bgTarget = bgEmbed && rels.get(bgEmbed);
    if (bgTarget) {
      const data = await zip.file(bgTarget)?.async('nodebuffer');
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' }[path.posix.extname(bgTarget).slice(1).toLowerCase()];
      if (data && mime) bgImage = await savePicture(path.posix.basename(bgTarget), data, mime);
    }
    // Speaker notes: the body text of the slide's notes page.
    const notesFile = [...rels.values()].find((t) => t.includes('notesSlides/'));
    const notesXml = notesFile && parseXml(await zip.file(notesFile)?.async('string') || '');
    const body = notesXml && deep(notesXml, P, 'sp').find((sp) => attr(deep(sp, P, 'ph')[0], 'type') === 'body');
    const notes = body ? deep(body, A, 'p').map((para) => deep(para, A, 't').map((t) => t.text).join('')).join('\n').replace(/\r\n?/g, '\n').trim().slice(0, 20000) : '';
    // Hidden slides (show="0") are skipped when presenting; transitions map to the nearest one Slides has.
    const skip = attr(xml, 'show') === '0';
    const trEl = deep(xml, P, 'transition')[0] || null;
    const tr = elements(trEl)[0]?.local;
    const advance = advanceOf(attr(trEl, 'advTm')); // moves on by itself after so many seconds
    const transition = tr && ({ fade: 'fade', dissolve: 'fade', push: 'push', wipe: 'push', cover: 'push', pull: 'push', split: 'push', zoom: 'zoom', newsflash: 'zoom' }[tr] || 'fade');
    slideFiles.push(file);
    const slideId = id();
    for (const c of await slideCommentsOf(zip, file, authors)) comments.push({ slideId, ...c });
    slides.push({ id: slideId, items, ...(bg && { bg }), ...(bgImage && { bgImage }), ...(notes && { notes }), ...(transition && { transition }), ...(advance && { advance }), ...(skip && { skip: true }) });
  }
  // Links to another slide: from its file to its id (a slide that didn't come in drops the link).
  for (const sl of slides) for (const it of sl.items) {
    if (!it.link?.file) continue;
    const k = slideFiles.indexOf(it.link.file);
    if (k >= 0) it.link = { slide: slides[k].id }; else delete it.link;
  }
  // "Loop until Esc" in the file's slide show settings.
  const props = parseXml(await zip.file('ppt/presProps.xml')?.async('string') || '');
  const loop = !!props && ['1', 'true'].includes(attr(deep(props, P, 'showPr')[0] || null, 'loop'));
  // Numbered slides: all of them, or all but the first.
  const numbers = !numbered.size ? null : numbered.size >= slides.length ? true : numbered.size === slides.length - 1 && !numbered.has(0) ? 'skip-first' : true;
  const deck = { theme: 'light', ...(numbers && { numbers }), ...(loop && { loop: true }), slides: slides.length ? slides : [{ id: id(), items: [] }] };
  if (comments.length) pptComments.set(deck, comments);
  return deck;
}

/**
 * A Slides presentation as a PowerPoint file (Buffer). `pictureData(fileId)` gives a picture's
 * bytes and type ({ data, mime }) or null.
 */
/** Does slide i show its number? deck.numbers: true (every slide) or 'skip-first' (all but the title slide). */
export const numberShown = (deck, i) => !!deck?.numbers && !(deck.numbers === 'skip-first' && i === 0);

/**
 * `comments`: the presentation's open comment threads, [{ slideId, author, at, text, replies: [{ author, at, text }] }];
 * each goes on its slide as a PowerPoint comment, replies as replies to it.
 */
export async function powerPointFromDeck(deck, { pictureData, title = 'Presentation', comments = [] } = {}) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 × 7.5 in, 16:9 like Slides
  pptx.title = title;
  const Win = 13.333, Hin = 7.5;
  const theme = THEMES[deck.theme] || THEMES.light;
  const color = (v, fallback) => (v === 'accent' ? theme.accent : v === 'text' ? theme.text : v || fallback).replace('#', '').toUpperCase();
  // An outline round a shape or text box: its colour and thickness in points.
  const outline = (it) => (it.outline ? { line: { color: color(it.outline, theme.text), width: OUTLINE_WIDTHS.includes(it.outlineW) ? it.outlineW : 1 } } : {});
  const emitted = new Map(); // slide → its boxes that became shapes, in order
  for (const s of deck.slides || []) {
    const slide = pptx.addSlide();
    // A picture behind the slide, or its colour (also kept under the picture, for programs that skip it).
    const back = s.bgImage && await pictureData?.(s.bgImage);
    slide.background = back && /^image\/(png|jpeg|gif)$/.test(back.mime) ? { data: `data:${back.mime};base64,${back.data.toString('base64')}` } : { color: color(s.bg, theme.bg) };
    if (s.notes) slide.addNotes(s.notes);
    if (numberShown(deck, (deck.slides || []).indexOf(s))) slide.slideNumber = { x: Win - 1.1, y: Hin - 0.55, w: 0.8, h: 0.35, fontSize: 12, color: color('text', theme.text), align: 'right', fontFace: 'Arial' };
    if (s.skip) slide.hidden = true; // (transitions and timings are added afterwards: withShowSettings)
    const shown = []; // the boxes that became shapes, in order (their shape ids follow it): for animations
    emitted.set(s, shown);
    for (const it of s.items || []) {
      const before = slide._slideObjects?.length ?? 0;
      const hyperlink = linkFor(it.link, deck.slides || []); // a web page or another slide, followed when presenting
      const pos = { x: (it.x / 100) * Win, y: (it.y / 100) * Hin, w: (it.w / 100) * Win, h: (it.h / 100) * Hin, ...(Number(it.rot) && { rotate: ((Number(it.rot) % 360) + 360) % 360 }) };
      if (it.type === 'text') {
        const look = { fontSize: Math.round((it.size || 24) * Win * 72 / 1000), bold: !!it.bold, italic: !!it.italic, color: color(it.color, theme.text), fontFace: 'Arial' };
        const box = { ...(it.fill && { fill: { color: color(it.fill, theme.accent) } }), ...outline(it) }; // the box's own colour and outline, when it has them
        if (hyperlink) { // the whole text is the link
          const lines = String(it.text || '').split('\n');
          slide.addText(lines.map((t, k) => ({ text: t, options: { ...look, hyperlink, breakLine: k < lines.length - 1 } })), { ...pos, ...box, align: it.align || 'left', valign: 'top', margin: 0 });
        } else slide.addText(it.text || '', { ...pos, ...look, ...box, align: it.align || 'left', valign: 'top', margin: 0 });
      } else if (it.type === 'shape' && (it.shape === 'line' || it.shape === 'arrow')) {
        // A line from one side (or corner) of its box to the other; arrows end in a triangle.
        const d = it.dir || 'h';
        const at = d === 'h' || d === 'hr' ? { ...pos, y: pos.y + pos.h / 2, h: 0 } : d === 'v' || d === 'vr' ? { ...pos, x: pos.x + pos.w / 2, w: 0 } : pos;
        slide.addShape(pptx.ShapeType.line, { ...at, flipH: d === 'hr', flipV: d === 'u' || d === 'vr',
          line: { color: color(it.fill || 'text', theme.text), width: 3, ...(it.shape === 'arrow' && { endArrowType: 'triangle' }) } });
      } else if (it.type === 'shape') {
        const kind = pptx.ShapeType[PPT_SHAPES[it.shape]] || pptx.ShapeType.rect;
        const look = { ...pos, ...(hyperlink && { hyperlink }), fill: { color: color(it.fill || 'accent', theme.accent) }, line: { type: 'none' }, ...outline(it) };
        // Text in the shape: centred in the middle, in the slide's background colour unless chosen.
        if (it.text) slide.addText(String(it.text), { ...look, shape: kind, fontSize: Math.round((it.size || 20) * Win * 72 / 1000), bold: !!it.bold, italic: !!it.italic, color: color(it.color, theme.bg), fontFace: 'Arial', align: it.align || 'center', valign: 'middle' });
        else slide.addShape(kind, look);
      } else if (it.type === 'table' && it.cells?.length) {
        const fontSize = Math.round((it.size || 18) * Win * 72 / 1000);
        const rows = it.cells.map((r, ri) => r.map((text) => ({ text: String(text ?? ''), options: { fontSize, color: color(null, theme.text), fontFace: 'Arial',
          ...(it.header && ri === 0 && { bold: true, fill: { color: color('accent', theme.accent) }, color: color(theme.bg, theme.bg) }) } })));
        slide.addTable(rows, { ...pos, colW: Array(it.cells[0].length).fill(pos.w / it.cells[0].length), border: { type: 'solid', pt: 1, color: color(null, theme.text) }, valign: 'middle', autoPage: false });
      } else if (it.type === 'chart' && it.data?.series?.length) {
        // A chart from a spreadsheet: a real PowerPoint chart, with the figures the slide keeps.
        const t = it.chartType;
        const kind = { column: 'bar', stackedColumn: 'bar', bar: 'bar', stackedBar: 'bar', line: 'line', area: 'area', scatter: 'scatter', pie: 'pie', doughnut: 'doughnut' }[t] || 'bar';
        const round = t === 'pie' || t === 'doughnut';
        const labels = (it.data.categories || []).map(String);
        let series = (round ? it.data.series.slice(0, 1) : it.data.series).map((x) => ({ name: String(x.name || ''), labels, values: (x.values || []).map((v) => (typeof v === 'number' ? v : 0)) }));
        if (t === 'scatter') series = scatterSeries(it.data); // PowerPoint's scatter: the X values first, then each Y series
        // A histogram goes as columns of its counts; a waterfall as stacked columns standing on a base
        // the slide's own colour, so each piece floats where the running total is.
        const shaped = t === 'histogram' ? histogramOf(it.data) : t === 'waterfall' ? waterfallOf(it.data) : null;
        if (shaped && !shaped.error) {
          if (t === 'histogram') series = [{ name: shaped.series[0].name, labels: shaped.categories, values: shaped.series[0].values }];
          else {
            const part = (kind) => shaped.steps.map((st) => (st.kind === kind ? Math.abs(st.to - st.from) : 0));
            series = [{ name: 'Base', labels: shaped.categories, values: shaped.steps.map((st) => (st.kind === 'total' ? Math.min(0, st.to) : Math.min(st.from, st.to))) },
              { name: 'Increase', labels: shaped.categories, values: part('up') }, { name: 'Decrease', labels: shaped.categories, values: part('down') },
              { name: 'Total', labels: shaped.categories, values: shaped.steps.map((st) => (st.kind === 'total' ? Math.abs(st.to) : 0)) }];
          }
        }
        slide.addChart(pptx.ChartType[kind], series, { ...pos, barDir: t === 'bar' || t === 'stackedBar' ? 'bar' : 'col', ...((t === 'stackedColumn' || t === 'stackedBar') && { barGrouping: 'stacked' }),
          ...(t === 'scatter' && { lineSize: 0, lineDataSymbolSize: 7 }), ...(t === 'doughnut' && { holeSize: 58 }), ...(t === 'histogram' && { barGapWidthPct: 4 }),
          ...(t === 'waterfall' && shaped && !shaped.error && { barGrouping: 'stacked', barGapWidthPct: 60, chartColors: [color(theme.bg, theme.bg), '1E8E3E', 'D93025', '1A73E8'] }),
          showLegend: !shaped && (series.length > (t === 'scatter' ? 2 : 1) || round), legendPos: 'b',
          ...(it.title && { showTitle: true, title: String(it.title), titleFontSize: 14 }) });
      } else if (it.type === 'image') {
        const pic = await pictureData?.(it.fileId);
        // Alt Text: its description (a blank one when it has none: left empty, the library would write a made-up file name).
        if (pic) slide.addImage({ ...pos, ...(hyperlink && { hyperlink }), data: `data:${pic.mime};base64,${pic.data.toString('base64')}`, altText: String(it.alt || ' ').slice(0, 500) });
      } else if (it.type === 'video') {
        // A video plays in PowerPoint too (up to 100 MB; a bigger one is named instead, so the file stays manageable).
        const vid = await pictureData?.(it.fileId);
        if (vid && /^video\//.test(vid.mime) && vid.data.length <= 100 * 1024 * 1024) {
          const extn = { 'video/quicktime': 'mov', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv' }[vid.mime] || 'mp4';
          slide.addMedia({ ...pos, type: 'video', data: `${vid.mime};base64,${vid.data.toString('base64')}`, extn });
        } else slide.addText(`▶ ${it.name || 'Video'}`, { ...pos, fontSize: 18, align: 'center', valign: 'middle', color: '5F6368', fill: { color: 'F1F3F4' } });
      }
      if ((slide._slideObjects?.length ?? 0) > before) shown.push(it);
    }
  }
  return withSlideComments(await withShowSettings(Buffer.from(await pptx.write({ outputType: 'nodebuffer' })), deck, emitted), deck, comments);
}
