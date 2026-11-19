// OpenDocument presentations (.odp, LibreOffice Impress's own format), both ways: every slide with its
// background (colour or picture), text boxes (size, bold, italic, colour, alignment, fill, outline, a link),
// shapes (rectangles, rounded ones, ellipses, triangles, diamonds, block arrows, chevrons, stars, callouts,
// lines and arrows) with their text, tables, pictures (with alt text), turned boxes, speaker notes and hidden
// slides. Charts go out as a table of their figures; videos as their name.
import { dataChartObject, dataChartFromObject } from './odpchart.js';
import JSZip from 'jszip';
import { parseDocument } from 'htmlparser2';
import { themeOfDeck, numberShown } from './powerpoint.js';

/** Boxes of the same group (two or more) wrapped in one <draw:g>, where the first of them was. */
export function groupedXml(xml, pieces) {
  const count = new Map();
  for (const p of pieces) if (p.it.group && p.end > p.start) count.set(p.it.group, (count.get(p.it.group) || 0) + 1);
  const done = new Set();
  let out = '';
  for (const p of pieces) {
    const g = p.it.group;
    if (!g || (count.get(g) || 0) < 2) { out += xml.slice(p.start, p.end); continue; }
    if (done.has(g)) continue;
    done.add(g);
    out += `<draw:g>${pieces.filter((q) => q.it.group === g).map((q) => xml.slice(q.start, q.end)).join('')}</draw:g>`;
  }
  return out;
}

export const ODP_MIME = 'application/vnd.oasis.opendocument.presentation';
// (characters XML can't hold — control characters such as CHAR(1) gives, a lone surrogate — are left out: one would
// make the whole file unreadable)
const x = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const COLOR = /^#[0-9a-f]{6}$/i;
const W = 28, H = 15.75; // cm, 16:9 like Slides
// Slide transitions as LibreOffice's (SMIL) and back: the nearest of Slides' three.
const ODP_TRANSITIONS = { fade: 'smil:type="fade" smil:subtype="crossfade"', push: 'smil:type="pushWipe" smil:subtype="fromBottom"', zoom: 'smil:type="zoom"' };
const transitionFromOdp = (type) => (!type ? null : /^(pushWipe|slideWipe|barWipe|irisWipe|clockWipe|snakeWipe|spiralWipe|waterfallWipe)$/i.test(type) ? 'push' : /^(zoom|ellipseWipe|fourBoxWipe)$/i.test(type) ? 'zoom' : 'fade');
/** A slide's page properties for showing it: its transition, moving on by itself after so many seconds, its number. */
function slideShowProps(s, numbered) {
  const secs = Number(s.advance) > 0 ? Math.min(3600, Math.round(Number(s.advance))) : 0;
  return `${secs ? ` presentation:transition-type="automatic" presentation:duration="PT${secs}S"` : ''}${ODP_TRANSITIONS[s.transition] ? ` presentation:transition-speed="medium" ${ODP_TRANSITIONS[s.transition]}` : ''} presentation:display-page-number="${numbered ? 'true' : 'false'}"`;
}
const cm = (n) => `${Number(n).toFixed(3)}cm`;
const ODP_SHAPES = { rect: 'rectangle', round: 'round-rectangle', ellipse: 'ellipse', triangle: 'isosceles-triangle', diamond: 'diamond', arrowblock: 'right-arrow', chevron: 'chevron', star: 'star5', callout: 'round-rectangular-callout' };
const OUR_SHAPES = { ...Object.fromEntries(Object.entries(ODP_SHAPES).map(([a, b]) => [b, a])),
  // shapes from a .pptx, as Impress names them when it saves one as .odp
  'ooxml-rect': 'rect', 'ooxml-roundRect': 'round', 'ooxml-ellipse': 'ellipse', 'ooxml-triangle': 'triangle', 'ooxml-diamond': 'diamond', 'ooxml-rightArrow': 'arrowblock', 'ooxml-chevron': 'chevron', 'ooxml-star5': 'star', 'ooxml-wedgeRoundRectCallout': 'callout' };
const OUTLINES = [1, 2, 4, 6];
/** Font size in points for a box's size (Slides keeps it relative to the slide's width). */
const ptOf = (size) => (size * (W / 2.54) * 72) / 1000;
// (a size a hair off a whole one, from pt ↔ cm rounding in another app, is that whole one)
const sizeOf = (pt, widthCm = W) => { const v = (pt * 1000) / ((widthCm / 2.54) * 72); return Math.abs(v - Math.round(v)) <= 0.35 ? Math.round(v) : Math.round(v * 10) / 10; };

// ---- deck → .odp ----
// ---- animations: Slides' (appear, fade, fly in; disappear, fade out) as Impress keeps them, one a click.
const ODP_PRESET = { appear: 'ooo-entrance-appear', fade: 'ooo-entrance-fade-in', fly: 'ooo-entrance-fly-in', disappear: 'ooo-exit-disappear', fadeout: 'ooo-exit-fade-out' };
const ODP_EFFECT = {
  appear: (t) => `<anim:set smil:begin="0s" smil:dur="0.001s" smil:fill="hold" smil:targetElement="${t}" smil:attributeName="visibility" smil:to="visible"/>`,
  fade: (t) => `${ODP_EFFECT.appear(t)}<anim:transitionFilter smil:dur="0.5s" smil:targetElement="${t}" smil:type="fade" smil:subtype="crossfade"/>`,
  fly: (t) => `${ODP_EFFECT.appear(t)}<anim:animate smil:dur="0.5s" smil:fill="hold" smil:targetElement="${t}" smil:attributeName="x" smil:values="x;x" smil:keyTimes="0;1"/><anim:animate smil:dur="0.5s" smil:fill="hold" smil:targetElement="${t}" smil:attributeName="y" smil:values="1+height/2;y" smil:keyTimes="0;1"/>`,
  disappear: (t) => `<anim:set smil:begin="0s" smil:dur="0.001s" smil:fill="hold" smil:targetElement="${t}" smil:attributeName="visibility" smil:to="hidden"/>`,
  fadeout: (t) => `<anim:transitionFilter smil:dur="0.5s" smil:targetElement="${t}" smil:type="fade" smil:subtype="crossfade" smil:mode="out"/><anim:set smil:begin="0.499s" smil:dur="0.001s" smil:fill="hold" smil:targetElement="${t}" smil:attributeName="visibility" smil:to="hidden"/>`,
};
/** A slide's timing: a main sequence of clicks for the animated boxes ([{ id, anim, start }], in order; start: 'with' or 'after' the one before). */
export function odpTiming(builds) {
  if (!builds.length) return '';
  // Clicks, each a run of steps (each "after" one half a second later), each step its effects together.
  const groups = [];
  for (const bd of builds) {
    if (!bd.start || !groups.length) groups.push([[bd]]);
    else if (bd.start === 'after') groups[groups.length - 1].push([bd]);
    else groups[groups.length - 1][groups[groups.length - 1].length - 1].push(bd);
  }
  const clicks = groups.map((steps) => `<anim:par smil:begin="next" smil:fill="hold">${steps.map((effects, si) => `<anim:par smil:begin="${si * 0.5}s" smil:fill="hold">${effects.map(({ id, anim }, ei) => {
    const a = ODP_PRESET[anim] ? anim : 'fade';
    const exit = a === 'disappear' || a === 'fadeout';
    const node = ei > 0 ? 'with-previous' : si > 0 ? 'after-previous' : 'on-click';
    return `<anim:par smil:begin="0s" smil:fill="hold" presentation:node-type="${node}" presentation:preset-class="${exit ? 'exit' : 'entrance'}" presentation:preset-id="${ODP_PRESET[a]}"${a === 'fly' ? ' presentation:preset-sub-type="from-bottom"' : ''}>${ODP_EFFECT[a](id)}</anim:par>`;
  }).join('')}</anim:par>`).join('')}</anim:par>`).join('');
  return `<anim:par smil:dur="indefinite" smil:restart="never" presentation:node-type="timing-root"><anim:seq smil:dur="indefinite" presentation:node-type="main-sequence">${clicks}</anim:seq></anim:par>`;
}
/** A slide's animations from its timing (an anim:par element): [{ target, anim }] in click order. Unknown entrances fade in, unknown exits fade out. */
export function odpAnimationsOf(timing, tags) {
  const out = [];
  (function walk(n) {
    for (const k of tags(n)) {
      const cls = k.attribs?.['presentation:preset-class'];
      if (k.name === 'anim:par' && (cls === 'entrance' || cls === 'exit')) {
        const target = (function first(e) { for (const c of tags(e)) { if (c.attribs?.['smil:targetElement']) return c.attribs['smil:targetElement']; const f = first(c); if (f) return f; } return null; })(k);
        const id = k.attribs['presentation:preset-id'] || '';
        const anim = cls === 'exit' ? (id === 'ooo-exit-disappear' ? 'disappear' : 'fadeout') : id === 'ooo-entrance-appear' ? 'appear' : id === 'ooo-entrance-fly-in' ? 'fly' : 'fade';
        const node = k.attribs['presentation:node-type'];
        const start = out.length && node === 'with-previous' ? 'with' : out.length && node === 'after-previous' ? 'after' : null;
        if (target && !out.some((o) => o.target === target)) out.push({ target, anim, ...(start && { start }) });
        continue;
      }
      walk(k);
    }
  })(timing);
  return out.slice(0, 100);
}

/**
 * A slide's comment threads as Impress keeps them: an annotation each, its replies right after it at the same
 * place (Impress shows them as comments of their own) and named after it, so they come back as replies.
 */
function slideAnnotations(threads) {
  const when = (t) => new Date(t || Date.now()).toISOString().slice(0, 19);
  const note = (c, place, name) => `<officeooo:annotation ${place}${name}><dc:creator>${x(c.author || '')}</dc:creator><dc:date>${when(c.at)}</dc:date>${String(c.text || '').split('\n').map((l) => `<text:p>${x(l)}</text:p>`).join('')}</officeooo:annotation>`;
  return threads.map((t, k) => {
    const place = `svg:x="0.5cm" svg:y="${(0.5 + k * 1.2).toFixed(1)}cm"`; // (each thread a place of its own: replies share it)
    return note(t, place, '') + (t.replies || []).map((r) => note(r, place, '')).join('');
  }).join('');
}

const odpComments = new WeakMap(); // deck → [{ slideId, author, text, at, replies: [{ author, text, at }] }]
/** The comment threads a presentation read from an .odp file had, by slide (see deckFromOdp). */
export const commentsOfOdpDeck = (deck) => odpComments.get(deck) || [];

export async function odpFromDeck(deck, { pictureData, title = 'Presentation', comments = [] } = {}) {
  const theme = themeOfDeck(deck);
  const color = (v, fallback) => { const c = v === 'accent' ? theme.accent : v === 'text' ? theme.text : v === 'bg' ? theme.bg : v; return COLOR.test(c || '') ? c.toLowerCase() : fallback; };
  const font = theme.font || 'Liberation Sans';
  const auto = [], pictures = [], fillImages = [], chartObjects = []; // (chartObjects: the charts' objects, Object 1, Object 2…)
  let n = 0;
  // Speaker notes' frame needs a presentation style of its own, or LibreOffice reads it as an ordinary text box (and
  // PowerPoint files it makes from ours then have no notes).
  let notesStyleName = null;
  const notesStyle = () => (notesStyleName ??= (auto.push('<style:style style:name="prNotes" style:family="presentation"/>'), 'prNotes'));
  const style = (family, inner, attrs = '') => { const name = `${family[0]}${++n}`; auto.push(`<style:style style:name="${name}" style:family="${family}"${attrs}>${inner}</style:style>`); return name; };
  const picPath = new Map();
  const picture = async (id) => {
    if (!id) return null;
    if (picPath.has(id)) return picPath.get(id);
    const got = await pictureData?.(id);
    if (!got || !/^image\/(png|jpeg|gif|svg\+xml|webp)$/.test(got.mime)) { picPath.set(id, null); return null; }
    const path = `Pictures/${pictures.length + 1}.${got.mime.split('/')[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`;
    pictures.push({ path, data: got.data, mime: got.mime });
    picPath.set(id, path);
    return path;
  };
  // Where a box goes: its corner, or (turned) a transform turning it about its centre, as Impress writes it.
  const place = (it) => {
    const w = (it.w / 100) * W, h = (it.h / 100) * H, xx = (it.x / 100) * W, yy = (it.y / 100) * H;
    const deg = ((Number(it.rot) || 0) % 360 + 360) % 360;
    if (!deg) return `svg:x="${cm(xx)}" svg:y="${cm(yy)}" svg:width="${cm(w)}" svg:height="${cm(h)}"`;
    const t = (deg * Math.PI) / 180, cx = xx + w / 2, cy = yy + h / 2;
    const tx = cx - (w / 2 * Math.cos(t) - h / 2 * Math.sin(t)), ty = cy - (w / 2 * Math.sin(t) + h / 2 * Math.cos(t));
    return `svg:width="${cm(w)}" svg:height="${cm(h)}" draw:transform="rotate(${(-t).toFixed(6)}) translate(${cm(tx)} ${cm(ty)})"`;
  };
  const textStyle = (it, fallbackColor, defSize) => style('text', `<style:text-properties fo:font-size="${(Math.round(ptOf(it.size || defSize) * 10) / 10)}pt" style:font-name="${x(font)}" fo:font-family="'${x(font)}'"${it.bold ? ' fo:font-weight="bold"' : ''}${it.italic ? ' fo:font-style="italic"' : ''} fo:color="${color(it.color, fallbackColor)}"/>`);
  const paraStyle = (align) => style('paragraph', `<style:paragraph-properties fo:text-align="${{ center: 'center', right: 'end', justify: 'justify' }[align] || 'start'}"/>`);
  const paras = (text, ts, ps, href) => String(text ?? '').split('\n').map((l) => {
    const words = href ? `<text:a xlink:type="simple" xlink:href="${x(href)}">${x(l)}</text:a>` : x(l); // the link inside the span, as Impress writes it
    return `<text:p text:style-name="${ps}"><text:span text:style-name="${ts}">${words}</text:span></text:p>`;
  }).join('');
  const graphic = (it, { fill, stroke, valign } = {}) => {
    const f = fill ? `draw:fill="solid" draw:fill-color="${fill}"` : 'draw:fill="none"';
    const s = stroke ? `draw:stroke="solid" svg:stroke-color="${stroke.color}" svg:stroke-width="${(stroke.width * 0.0353).toFixed(3)}cm"` : 'draw:stroke="none"';
    return style('graphic', `<style:graphic-properties ${f} ${s}${valign ? ` draw:textarea-vertical-align="${valign}"` : ''} fo:padding="0cm" fo:min-height="0cm" draw:auto-grow-height="false" draw:auto-grow-width="false"${stroke?.arrow ? ' draw:marker-end="Arrow" draw:marker-end-width="0.4cm"' : ''}/>`);
  };
  const outline = (it) => (it.outline ? { color: color(it.outline, theme.text), width: OUTLINES.includes(it.outlineW) ? it.outlineW : 1 } : null);
  const linkOf = (it, slides) => {
    if (!it.link) return null;
    if (typeof it.link === 'string') return /^(https?:|mailto:)/i.test(it.link) ? it.link : null;
    if (it.link.url && /^(https?:|mailto:)/i.test(it.link.url)) return it.link.url;
    const i = slides.findIndex((s) => s.id === it.link.slide);
    return i >= 0 ? `#page${i + 1}` : null;
  };
  const slides = deck?.slides?.length ? deck.slides : [{ id: 's1', items: [] }];
  let pages = '';
  const gradients = []; // gradient backgrounds, by name (in styles.xml)
  for (const [si, s] of slides.entries()) {
    const bgPath = await picture(s.bgImage);
    let dp;
    // How it moves on (LibreOffice's transitions and timings), whether it shows its number, and a gradient background.
    const show = slideShowProps(s, numberShown(deck, si));
    const grad = !bgPath && /^#([0-9a-f]{6}) (\d{1,3})$/i.exec(s.bgGrad || '');
    if (bgPath) { const name = `bg${fillImages.length + 1}`; fillImages.push(`<draw:fill-image draw:name="${name}" xlink:href="${bgPath}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>`); dp = style('drawing-page', `<style:drawing-page-properties draw:fill="bitmap" draw:fill-image-name="${name}" style:repeat="stretch" presentation:visibility="${s.skip ? 'hidden' : 'visible'}"${show}/>`); }
    else if (grad) { // from the slide's colour into the other, at the angle (CSS's; LibreOffice's runs the other way round from the top)
      const name = `grad${gradients.length + 1}`;
      gradients.push(`<draw:gradient draw:name="${name}" draw:style="linear" draw:start-color="${color(s.bg, theme.bg)}" draw:end-color="#${grad[1].toLowerCase()}" draw:start-intensity="100%" draw:end-intensity="100%" draw:angle="${(180 - (Number(grad[2]) % 360) + 360) % 360}deg" draw:border="0%"/>`);
      dp = style('drawing-page', `<style:drawing-page-properties draw:fill="gradient" draw:fill-gradient-name="${name}" presentation:visibility="${s.skip ? 'hidden' : 'visible'}"${show}/>`);
    } else dp = style('drawing-page', `<style:drawing-page-properties draw:fill="solid" draw:fill-color="${color(s.bg, theme.bg)}" presentation:visibility="${s.skip ? 'hidden' : 'visible'}"${show}/>`);
    let items = '', titled = false;
    const pieces = []; // each box's own XML, so grouped ones can be wrapped in a <draw:g>
    for (const it of s.items || []) {
      if (pieces.length) pieces[pieces.length - 1].end = items.length;
      pieces.push({ it, start: items.length });
      const href = linkOf(it, slides);
      if (it.type === 'text') {
        const gs = graphic(it, { fill: it.fill ? color(it.fill, theme.accent) : null, stroke: outline(it), valign: 'top' });
        const title = it.role === 'title' && !titled && String(it.text || '').trim(); // the slide's title, as Impress marks it (once a slide; Impress drops the mark unless the style is named as a presentation one)
        if (title) titled = true;
        items += `<draw:frame ${title ? `presentation:style-name="${gs}" presentation:class="title" presentation:user-transformed="true"` : `draw:style-name="${gs}"`} ${place(it)}><draw:text-box>${paras(it.text, textStyle(it, theme.text, 24), paraStyle(it.align), href)}</draw:text-box></draw:frame>`;
      } else if (it.type === 'shape' && (it.shape === 'line' || it.shape === 'arrow')) {
        const xx = (it.x / 100) * W, yy = (it.y / 100) * H, w = (it.w / 100) * W, h = (it.h / 100) * H;
        const d = it.dir || 'h';
        const [x1, y1, x2, y2] = d === 'h' ? [xx, yy + h / 2, xx + w, yy + h / 2] : d === 'hr' ? [xx + w, yy + h / 2, xx, yy + h / 2] : d === 'v' ? [xx + w / 2, yy, xx + w / 2, yy + h] : d === 'vr' ? [xx + w / 2, yy + h, xx + w / 2, yy]
          : d === 'u' ? [xx, yy + h, xx + w, yy] : [xx, yy, xx + w, yy + h];
        const gs = graphic(it, { stroke: { color: color(it.fill || 'text', theme.text), width: 3, arrow: it.shape === 'arrow' } });
        items += `<draw:line draw:style-name="${gs}" svg:x1="${cm(x1)}" svg:y1="${cm(y1)}" svg:x2="${cm(x2)}" svg:y2="${cm(y2)}"><text:p/></draw:line>`;
      } else if (it.type === 'shape') {
        const gs = graphic(it, { fill: color(it.fill || 'accent', theme.accent), stroke: outline(it), valign: 'middle' });
        const text = it.text ? paras(it.text, textStyle(it, theme.bg, 20), paraStyle(it.align || 'center'), null) : '';
        const shape = `<draw:custom-shape draw:style-name="${gs}" ${place(it)}>${text}<draw:enhanced-geometry draw:type="${ODP_SHAPES[it.shape] || 'rectangle'}"/></draw:custom-shape>`;
        items += href ? `<draw:a xlink:type="simple" xlink:href="${x(href)}">${shape}</draw:a>` : shape;
      } else if (it.type === 'chart' && it.data?.series?.length && dataChartObject(it, (it.w / 100) * W, (it.h / 100) * H)) {
        // A chart: a chart object carrying its figures, which Impress draws (and keeps) as a chart.
        chartObjects.push(dataChartObject(it, (it.w / 100) * W, (it.h / 100) * H));
        items += `<draw:frame draw:style-name="${graphic(it, {})}" ${place(it)}><draw:object xlink:href="./Object ${chartObjects.length}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>`;
      } else if ((it.type === 'table' && it.cells?.length) || (it.type === 'chart' && it.data?.series?.length)) {
        const rows = it.type === 'table' ? it.cells : [['', ...it.data.series.map((se) => String(se.name ?? ''))], ...(it.data.categories || []).map((c, i) => [String(c ?? ''), ...it.data.series.map((se) => String(se.values?.[i] ?? ''))])];
        const head = it.type === 'chart' || it.header;
        const ts = textStyle({ size: it.size || 18 }, theme.text, 18), hs = textStyle({ size: it.size || 18, bold: true, color: 'bg' }, theme.bg, 18), ps = paraStyle('left');
        const cell = style('table-cell', `<style:graphic-properties draw:fill="none"/><style:table-cell-properties fo:border="0.03cm solid ${theme.text}" fo:padding="0.1cm"/>`);
        const headCell = style('table-cell', `<style:graphic-properties draw:fill="solid" draw:fill-color="${theme.accent}"/><style:table-cell-properties fo:background-color="${theme.accent}" fo:border="0.03cm solid ${theme.text}" fo:padding="0.1cm"/>`);
        const cols = Math.max(...rows.map((r) => r.length));
        const plain = graphic(it, {});
        const caption = it.type === 'chart' && it.title ? `<draw:frame draw:style-name="${plain}" ${place({ ...it, h: Math.min(it.h, 8) })}><draw:text-box>${paras(`📊 ${it.title}`, textStyle({ size: 20, bold: true }, theme.text, 20), ps)}</draw:text-box></draw:frame>` : '';
        items += `${caption}<draw:frame draw:style-name="${plain}" ${place(it.type === 'chart' && it.title ? { ...it, y: it.y + 8, h: Math.max(4, it.h - 8) } : it)}><table:table${head ? ' table:template-name="default" table:use-first-row-styles="true"' : ''}><table:table-column table:number-columns-repeated="${cols}"/>${rows.map((r, ri) => `<table:table-row>${Array.from({ length: cols }, (_, ci) => `<table:table-cell table:style-name="${head && ri === 0 ? headCell : cell}" office:value-type="string">${paras(r[ci] ?? '', head && ri === 0 ? hs : ts, ps)}</table:table-cell>`).join('')}</table:table-row>`).join('')}</table:table></draw:frame>`;
      } else if (it.type === 'image') {
        const p = await picture(it.fileId);
        if (!p) continue;
        const img = `<draw:frame draw:style-name="${graphic(it, {})}" ${place(it)}><draw:image xlink:href="${p}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>${it.alt ? `<svg:title>${x(it.alt)}</svg:title><svg:desc>${x(it.alt)}</svg:desc>` : ''}</draw:frame>`;
        items += href ? `<draw:a xlink:type="simple" xlink:href="${x(href)}">${img}</draw:a>` : img;
      } else if (it.type === 'video' || it.type === 'audio') {
        items += `<draw:frame draw:style-name="${graphic(it, { fill: '#f1f3f4', valign: 'middle' })}" ${place(it)}><draw:text-box>${paras(`${it.type === 'audio' ? '🔊' : '▶'} ${it.name || (it.type === 'audio' ? 'Sound' : 'Video')}`, textStyle({ size: 18, color: '#5f6368' }, '#5f6368', 18), paraStyle('center'))}</draw:text-box></draw:frame>`;
      }
    }
    if (pieces.length) pieces[pieces.length - 1].end = items.length;
    // Animated boxes: an id on each (its first drawing element), for the slide's timing to point at.
    const animated = pieces.filter((pc) => pc.it.anim).sort((a, b) => (a.it.animAt || 0) - (b.it.animAt || 0));
    for (const pc of [...animated].sort((a, b) => b.start - a.start)) {
      const m = /<draw:(?:frame|custom-shape|rect|ellipse|line)\b/.exec(items.slice(pc.start, pc.end));
      if (!m) { pc.animId = null; continue; }
      pc.animId = `anim${pieces.indexOf(pc) + 1}`;
      const at = pc.start + m.index + m[0].length, add = ` xml:id="${pc.animId}" draw:id="${pc.animId}"`;
      items = items.slice(0, at) + add + items.slice(at);
      for (const q of pieces) { if (q.start >= at) q.start += add.length; if (q.end >= at) q.end += add.length; }
      // By paragraph: an id on each paragraph with words instead (Impress points at those), last first.
      const lines = String(pc.it.text || '').split('\n');
      if (pc.it.animBy === 'para' && pc.it.type === 'text' && !/^(disappear|fadeout)$/.test(pc.it.anim) && lines.filter((l) => l.trim()).length > 1) {
        const ps = [...items.slice(pc.start, pc.end).matchAll(/<text:p\b/g)].map((pm) => pc.start + pm.index + pm[0].length);
        pc.paraIds = [];
        for (let k = Math.min(ps.length, lines.length) - 1; k >= 0; k--) {
          if (!lines[k].trim()) continue;
          const pid = `${pc.animId}p${k}`, padd = ` xml:id="${pid}" text:id="${pid}"`;
          pc.paraIds.unshift(pid);
          items = items.slice(0, ps[k]) + padd + items.slice(ps[k]);
          for (const q of pieces) { if (q.start >= ps[k]) q.start += padd.length; if (q.end >= ps[k]) q.end += padd.length; }
        }
      }
    }
    items = groupedXml(items, pieces) + odpTiming(animated.filter((pc) => pc.animId).flatMap((pc) => (pc.paraIds?.length ? pc.paraIds : [pc.animId]).map((id, n) => ({ id, anim: pc.it.anim, start: n ? null : pc.it.animStart || null }))));
    const notes = s.notes ? `<presentation:notes><draw:page-thumbnail presentation:class="page" svg:x="2cm" svg:y="2cm" svg:width="17cm" svg:height="9.56cm" draw:page-number="${si + 1}"/><draw:frame presentation:style-name="${notesStyle()}" presentation:class="notes" svg:x="2cm" svg:y="12.5cm" svg:width="17cm" svg:height="13cm"><draw:text-box>${String(s.notes).split('\n').map((l) => `<text:p>${x(l)}</text:p>`).join('')}</draw:text-box></draw:frame></presentation:notes>` : '';
    const threads = (comments || []).filter((t) => t.slideId === s.id && t.text);
    // Its number: a page-number box at the bottom right, as LibreOffice keeps a slide's (it counts the slides itself).
    const number = numberShown(deck, si) ? `<draw:frame presentation:class="page-number" svg:x="${(W - 3.4).toFixed(2)}cm" svg:y="${(H - 1.3).toFixed(2)}cm" svg:width="3cm" svg:height="0.9cm"><draw:text-box><text:p text:style-name="${paraStyle('right')}"><text:span text:style-name="${style('text', `<style:text-properties fo:font-size="12pt" style:font-name="${x(font)}" fo:font-family="'${x(font)}'" fo:color="#888888"/>`)}"><text:page-number>${si + 1}</text:page-number></text:span></text:p></draw:text-box></draw:frame>` : '';
    pages += `<draw:page draw:name="page${si + 1}" draw:style-name="${dp}" draw:master-page-name="Default">${items}${number}${notes}${slideAnnotations(threads)}</draw:page>`;
  }
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:anim="urn:oasis:names:tc:opendocument:xmlns:animation:1.0" xmlns:smil="urn:oasis:names:tc:opendocument:xmlns:smil-compatible:1.0" xmlns:officeooo="http://openoffice.org/2009/office" office:version="1.3"';
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NS}><office:automatic-styles>${auto.join('')}</office:automatic-styles><office:body><office:presentation>${pages}${deck?.loop ? '<presentation:settings presentation:endless="true" presentation:pause="P0D"/>' : ''}</office:presentation></office:body></office:document-content>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${NS}><office:styles>${fillImages.join('')}${gradients.join('')}<draw:marker draw:name="Arrow" svg:viewBox="0 0 20 30" svg:d="M10 0l-10 30h20z"/>
<style:default-style style:family="graphic"><style:graphic-properties draw:fill="none" draw:stroke="none"/><style:text-properties fo:font-size="18pt" style:font-name="${x(font)}" fo:font-family="'${x(font)}'"/></style:default-style></office:styles>
<office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:margin="0cm" fo:page-width="${W}cm" fo:page-height="${H}cm" style:print-orientation="landscape"/></style:page-layout>
<style:page-layout style:name="PMN"><style:page-layout-properties fo:margin="0cm" fo:page-width="21cm" fo:page-height="29.7cm" style:print-orientation="portrait"/></style:page-layout>
<style:style style:name="Mdp" style:family="drawing-page"><style:drawing-page-properties draw:fill="solid" draw:fill-color="${theme.bg}"/></style:style></office:automatic-styles>
<office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1" draw:style-name="Mdp"><presentation:notes style:page-layout-name="PMN"><draw:page-thumbnail presentation:class="page" svg:x="2cm" svg:y="2cm" svg:width="17cm" svg:height="9.56cm"/><draw:frame presentation:class="notes" presentation:placeholder="true" svg:x="2cm" svg:y="12.5cm" svg:width="17cm" svg:height="13cm"/></presentation:notes></style:master-page></office:master-styles></office:document-styles>`;
  const meta = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta ${NS}><office:meta><dc:title>${x(title)}</dc:title><meta:generator>Workspace</meta:generator></office:meta></office:document-meta>`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">
<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${ODP_MIME}"/>
${['content.xml', 'styles.xml', 'meta.xml'].map((f) => `<manifest:file-entry manifest:full-path="${f}" manifest:media-type="text/xml"/>`).join('\n')}
${pictures.map((p) => `<manifest:file-entry manifest:full-path="${p.path}" manifest:media-type="${p.mime}"/>`).join('\n')}
${chartObjects.map((o, k) => `<manifest:file-entry manifest:full-path="Object ${k + 1}/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.chart"/><manifest:file-entry manifest:full-path="Object ${k + 1}/content.xml" manifest:media-type="text/xml"/>`).join('\n')}
</manifest:manifest>`;
  const zip = new JSZip();
  zip.file('mimetype', ODP_MIME, { compression: 'STORE' });
  zip.file('content.xml', content);
  zip.file('styles.xml', styles);
  zip.file('meta.xml', meta);
  zip.file('META-INF/manifest.xml', manifest);
  for (const p of pictures) zip.file(p.path, p.data);
  chartObjects.forEach((o, k) => zip.file(`Object ${k + 1}/content.xml`, o));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: ODP_MIME });
}

// ---- .odp → deck ----
const kids = (el) => el?.children || [];
const tags = (el, name) => kids(el).filter((k) => k.type === 'tag' && (!name || k.name === name));
const textOf = (el) => (el.type === 'text' ? el.data : el.name === 'text:s' ? ' '.repeat(Number(el.attribs['text:c']) || 1) : el.name === 'text:tab' ? '\t' : el.name === 'text:line-break' ? '\n' : kids(el).map(textOf).join(''));
const toCm = (v) => { const m = /^(-?[\d.]+)(cm|mm|in|pt|px)?$/.exec(String(v || '').trim()); if (!m) return null; const k = Number(m[1]); return { cm: k, mm: k / 10, in: k * 2.54, pt: k * 2.54 / 72, px: k * 2.54 / 96, undefined: k }[m[2]] ?? k; };
const round1 = (v) => Math.round(v * 10) / 10;

/** Read an .odp file as a presentation's content: { theme, slides }. Pictures saved with savePicture(name, data, mime) → file id. */
export async function deckFromOdp(buffer, { savePicture } = {}) {
  const zip = await JSZip.loadAsync(buffer);
  const contentXml = await zip.file('content.xml')?.async('string');
  if (!contentXml) throw new Error('Not an OpenDocument presentation');
  const parse = (s) => parseDocument(s || '', { xmlMode: true, decodeEntities: true });
  const root = parse(contentXml), stylesRoot = parse(await zip.file('styles.xml')?.async('string'));
  const styles = new Map(), fillImages = new Map(), layouts = new Map(), masters = new Map(), gradients = new Map();
  const read = (node) => {
    for (const el of tags(node)) {
      if (el.name === 'style:style') {
        const get = (k) => tags(el, k)[0]?.attribs || {};
        styles.set(el.attribs['style:name'], { parent: el.attribs['style:parent-style-name'], g: get('style:graphic-properties'), t: get('style:text-properties'), p: get('style:paragraph-properties'), d: get('style:drawing-page-properties') });
      } else if (el.name === 'draw:fill-image') fillImages.set(el.attribs['draw:name'], el.attribs['xlink:href']);
      else if (el.name === 'draw:gradient') gradients.set(el.attribs['draw:name'], el.attribs);
      else if (el.name === 'style:page-layout') layouts.set(el.attribs['style:name'], tags(el, 'style:page-layout-properties')[0]?.attribs || {});
      else if (el.name === 'style:master-page') masters.set(el.attribs['style:name'], el.attribs);
      read(el);
    }
  };
  read(stylesRoot); read(root);
  const look = (name, part) => { const out = {}; const chain = []; for (let s = styles.get(name), i = 0; s && i < 10; s = styles.get(s.parent), i++) chain.unshift(s); for (const s of chain) Object.assign(out, s[part]); return out; };
  const master = masters.values().next().value;
  const pl = layouts.get(master?.['style:page-layout-name']) || {};
  const pw = toCm(pl['fo:page-width']) || W, ph = toCm(pl['fo:page-height']) || H;
  const pct = (v, of) => round1(((toCm(v) || 0) / of) * 100);
  const saved = new Map();
  let picNo = 0;
  const pictureFor = async (href) => {
    if (!savePicture || !href || /^https?:/i.test(href)) return null;
    if (saved.has(href)) return saved.get(href);
    const f = zip.file(href.replace(/^\.?\//, ''));
    const ext = (/\.([a-z]+)$/i.exec(href) || [])[1]?.toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[ext];
    const id = f && mime ? await savePicture(`Picture ${++picNo}.${ext === 'jpeg' ? 'jpg' : ext}`, await f.async('nodebuffer'), mime) : null;
    saved.set(href, id);
    return id;
  };
  const hex = (v) => (COLOR.test(v || '') ? v.toLowerCase() : null);
  // A box: from svg:x/y/width/height, or a transform (rotate, then translate) for a turned one.
  const boxOf = (el) => {
    const w = toCm(el.attribs['svg:width']) || 0, h = toCm(el.attribs['svg:height']) || 0;
    let xx = toCm(el.attribs['svg:x']) || 0, yy = toCm(el.attribs['svg:y']) || 0, rot = 0;
    const tf = el.attribs['draw:transform'];
    if (tf) {
      const r = /rotate\s*\(\s*(-?[\d.e-]+)\s*\)/.exec(tf), t = /translate\s*\(\s*(-?[\d.]+\w*)[\s,]+(-?[\d.]+\w*)\s*\)/.exec(tf);
      const th = r ? -Number(r[1]) : 0;
      const tx = t ? toCm(t[1]) : xx, ty = t ? toCm(t[2]) : yy;
      const cx = tx + (w / 2 * Math.cos(th) - h / 2 * Math.sin(th)), cy = ty + (w / 2 * Math.sin(th) + h / 2 * Math.cos(th));
      xx = cx - w / 2; yy = cy - h / 2;
      rot = Math.round((((th * 180) / Math.PI) % 360 + 360) % 360);
    }
    return { x: round1((xx / pw) * 100), y: round1((yy / ph) * 100), w: round1((w / pw) * 100), h: round1((h / ph) * 100), ...(rot && rot !== 360 && { rot }) };
  };
  // A text's look, from its first span (or paragraph): size, bold, italic, colour; its alignment.
  const textLook = (container, defPt) => {
    const p = tags(container, 'text:p')[0] || tags(container, 'text:h')[0];
    const span = p && (function first(n) { for (const k of tags(n)) { if (k.name === 'text:span') return k; const f = first(k); if (f) return f; } return null; })(p);
    const t = { ...look(container.attribs?.['draw:text-style-name'], 't'), ...look(p?.attribs['text:style-name'], 't'), ...look(span?.attribs['text:style-name'], 't') };
    const pt = Number(String(t['fo:font-size'] || '').replace('pt', '')) || defPt;
    const al = { center: 'center', end: 'right', right: 'right', justify: 'justify' }[look(p?.attribs['text:style-name'], 'p')['fo:text-align']];
    return { size: sizeOf(pt, pw), ...(/bold|[6-9]00/.test(t['fo:font-weight'] || '') && { bold: true }), ...(t['fo:font-style'] === 'italic' && { italic: true }), ...(hex(t['fo:color']) && { color: hex(t['fo:color']) }), ...(al && { align: al }) };
  };
  // A table whose first row is all bold (and the rest isn't): a heading row, as LibreOffice turns a PowerPoint table's into.
  const boldFirstRow = (tbl) => {
    const rows = tags(tbl, 'table:table-row');
    const bold = (row) => { const cells = tags(row, 'table:table-cell').filter((c) => textOf(c).trim()); return cells.length > 0 && cells.every((c) => textLook(c, 18).bold); };
    return rows.length > 1 && bold(rows[0]) && !bold(rows[1]);
  };
  const linkIn = (el) => { const a = (function find(n) { for (const k of tags(n)) { if (k.name === 'text:a' || k.name === 'draw:a') return k; const f = find(k); if (f) return f; } return null; })(el); const h = a?.attribs['xlink:href']; return h && /^(https?:|mailto:)/i.test(h) ? { url: h } : null; };
  const paraText = (el) => tags(el).filter((k) => k.name === 'text:p' || k.name === 'text:h' || k.name === 'text:list').map((k) => (k.name === 'text:list' ? tags(k, 'text:list-item').map((li) => paraText(li)).join('\n') : textOf(k))).join('\n');
  const fillOf = (g) => (g['draw:fill'] === 'solid' || (g['draw:fill'] === undefined && g['draw:fill-color']) ? hex(g['draw:fill-color']) : null);
  const outlineOf = (g) => { if (g['draw:stroke'] !== 'solid' || !hex(g['svg:stroke-color'])) return {}; const pt = (toCm(g['svg:stroke-width']) || 0.0353) / 0.0353; return { outline: hex(g['svg:stroke-color']), outlineW: OUTLINES.reduce((a, b) => (Math.abs(b - pt) < Math.abs(a - pt) ? b : a)) }; };
  const slides = [], threads = [];
  const fresh = () => Math.random().toString(36).slice(2, 10);
  const pres = (function find(n) { for (const k of tags(n)) { if (k.name === 'office:presentation') return k; const f = find(k); if (f) return f; } return null; })(root);
  const pageLinks = new Map();
  const numbered = new Set(); // the slides showing their number
  for (const page of tags(pres, 'draw:page')) {
    const d = look(page.attribs['draw:style-name'], 'd');
    const slide = { id: fresh(), items: [] };
    pageLinks.set(page.attribs['draw:name'], slide.id);
    if (d['draw:fill'] === 'bitmap' && d['draw:fill-image-name']) { const id = await pictureFor(fillImages.get(d['draw:fill-image-name'])); if (id) slide.bgImage = id; }
    else if (d['draw:fill'] === 'gradient' && gradients.get(d['draw:fill-gradient-name'])) { // a linear gradient: from its first colour into its last
      const gr = gradients.get(d['draw:fill-gradient-name']);
      const from = hex(gr['draw:start-color']), to = hex(gr['draw:end-color']);
      const deg = /^(-?[\d.]+)(deg|rad|grad)?$/.exec(String(gr['draw:angle'] || '0'));
      const odf = deg ? (deg[2] === 'rad' ? (Number(deg[1]) * 180) / Math.PI : deg[2] === 'grad' ? Number(deg[1]) * 0.9 : deg[2] ? Number(deg[1]) : Number(deg[1]) / 10) : 0; // (no unit: tenths of a degree)
      if (from) slide.bg = from;
      if (to && to !== from) slide.bgGrad = `${to} ${Math.round((((180 - odf) % 360) + 360) % 360)}`;
    } else if (fillOf(d)) slide.bg = fillOf(d);
    if (d['presentation:visibility'] === 'hidden') slide.skip = true;
    const tr = transitionFromOdp(d['smil:type']);
    if (tr) slide.transition = tr;
    const dur = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(d['presentation:duration'] || '');
    const secs = dur ? (Number(dur[1] || 0) * 3600) + (Number(dur[2] || 0) * 60) + Number(dur[3] || 0) : 0;
    if (d['presentation:transition-type'] === 'automatic' && secs > 0) slide.advance = Math.min(3600, Math.max(1, Math.round(secs)));
    if (d['presentation:display-page-number'] === 'true') numbered.add(slides.length);
    const byAnimId = new Map(); // a drawing element's id → the box it became (for animations)
    const byParaId = new Map(); // a paragraph's id → the box it is in (animations a paragraph at a time)
    const walk = async (nodes, link) => {
      for (const el of nodes) {
        const before = slide.items.length;
        await one(el, link);
        const eid = el.attribs?.['xml:id'] || el.attribs?.['draw:id'];
        if (slide.items.length > before) {
          if (eid) byAnimId.set(eid, slide.items[before]);
          (function paraIds(n) { for (const k of tags(n)) { const pid = k.name === 'text:p' && (k.attribs['xml:id'] || k.attribs['text:id']); if (pid) byParaId.set(pid, slide.items[before]); paraIds(k); } })(el);
        }
      }
    };
    const one = async (el, link) => {
        if (el.name === 'draw:frame' && /^(page-number|footer|header|date-time)$/.test(el.attribs['presentation:class'] || '')) { // the slide's number (or footer): not a box of its own
          if (el.attribs['presentation:class'] === 'page-number') numbered.add(slides.length);
          return;
        }
        if (el.name === 'draw:g') { // a group: its boxes keep a group id (the outermost group's; a group of one is just a box)
          const from = slide.items.length;
          await walk(tags(el), link);
          const added = slide.items.slice(from);
          const gid = fresh();
          if (added.length > 1) for (const it of added) if (!it.group) it.group = gid;
          return;
        }
        if (el.name === 'draw:a') { await walk(tags(el), el.attribs['xlink:href']); return; }
        if (el.attribs?.['presentation:placeholder'] === 'true' && !textOf(el).trim()) return; // an empty placeholder (Impress marks some with text in them too)
        const g = look(el.attribs?.['draw:style-name'] || el.attribs?.['presentation:style-name'], 'g');
        // Its link: a <draw:a> round it (ours), else a click action (LibreOffice's: go to a slide, or a web page), else one
        // link that is all of its text.
        let own = link;
        if (!own) {
          const ev = tags(tags(el, 'office:event-listeners')[0] || { children: [] }, 'presentation:event-listener')[0];
          if (ev && ['show', 'previous-page', 'next-page'].includes(ev.attribs['presentation:action'] || 'show')) own = ev.attribs['xlink:href'];
        }
        if (!own) {
          const all = (function find(n, out = []) { for (const k of tags(n)) { if (k.name === 'text:a') out.push(k); else find(k, out); } return out; })(el);
          if (all.length === 1 && textOf(all[0]).trim() && textOf(all[0]).trim() === textOf(el).trim()) own = all[0].attribs['xlink:href'];
        }
        const lk = own && /^(https?:|mailto:)/i.test(own) ? { link: { url: own } } : own?.startsWith('#') ? { link: { pageName: own.slice(1) } } : {};
        if (el.name === 'draw:frame') {
          // A chart object carrying its figures (what the download writes, and Impress's own charts): a chart.
          const objHref = String(tags(el, 'draw:object')[0]?.attribs['xlink:href'] || '').replace(/^\.\//, '').replace(/\/$/, '');
          const objXml = objHref && await zip.file(`${objHref}/content.xml`)?.async('string');
          if (objXml) {
            const find = (n, name) => { for (const k of tags(n)) { if (k.name === name) return k; const f = find(k, name); if (f) return f; } return null; };
            const ch = dataChartFromObject(parse(objXml), { tags, textOf, find });
            if (ch) { slide.items.push({ id: fresh(), type: 'chart', ...boxOf(el), ...ch }); return; }
          }
          const img = tags(el, 'draw:image')[0], box = tags(el, 'draw:text-box')[0], tbl = tags(el, 'table:table')[0];
          const alt = textOf(tags(el, 'svg:title')[0] || tags(el, 'svg:desc')[0] || { children: [] }).trim();
          if (tbl) { // (Impress adds a picture of the table as well: the table is what counts)
            const rows = [];
            (function rws(n) { for (const k of tags(n)) { if (k.name === 'table:table-row') rows.push(tags(k).filter((c) => c.name === 'table:table-cell').map((c) => paraText(c))); else if (/^table:table-(header-)?rows$/.test(k.name)) rws(k); } })(tbl);
            if (rows.length) slide.items.push({ id: fresh(), type: 'table', ...boxOf(el), cells: rows.slice(0, 30).map((r) => r.slice(0, 12)), ...((tbl.attribs['table:use-first-row-styles'] === 'true' || boldFirstRow(tbl)) && { header: true }), size: textLook(tags(tags(tbl, 'table:table-row')[0], 'table:table-cell')[0] || {}, 18).size });
          } else if (img) { const id = await pictureFor(img.attribs['xlink:href']); if (id) slide.items.push({ id: fresh(), type: 'image', ...boxOf(el), fileId: id, ...(alt && { alt }), ...lk }); }
          else if (box) {
            const text = paraText(box);
            if (!text.trim()) return;
            const fill = fillOf(g);
            slide.items.push({ id: fresh(), type: 'text', ...(el.attribs['presentation:class'] === 'title' && { role: 'title' }), ...boxOf(el), text, ...textLook(box, 18), ...(fill && { fill }), ...outlineOf(g), ...(linkIn(box) || lk.link ? { link: linkIn(box) || lk.link } : {}) });
          }
        } else if (el.name === 'draw:custom-shape' || el.name === 'draw:rect' || el.name === 'draw:ellipse') {
          const geo = tags(el, 'draw:enhanced-geometry')[0]?.attribs['draw:type'];
          const shape = el.name === 'draw:ellipse' ? 'ellipse' : el.name === 'draw:rect' ? (el.attribs['draw:corner-radius'] ? 'round' : 'rect') : OUR_SHAPES[geo] || (/ellipse|circle/.test(geo || '') ? 'ellipse' : 'rect');
          const text = paraText(el);
          // A plain box with words and no fill (how Impress keeps a .pptx text box) is a text box, not a shape.
          if (shape === 'rect' && g['draw:fill'] === 'none' && text.trim()) { slide.items.push({ id: fresh(), type: 'text', ...boxOf(el), text, ...textLook(el, 18), ...outlineOf(g), ...(linkIn(el) || lk.link ? { link: linkIn(el) || lk.link } : {}) }); return; }
          slide.items.push({ id: fresh(), type: 'shape', shape, ...boxOf(el), fill: fillOf(g) || 'accent', ...outlineOf(g), ...(text.trim() && { text, ...textLook(el, 18) }), ...lk });
        } else if (el.name === 'draw:line') {
          const [x1, y1, x2, y2] = ['svg:x1', 'svg:y1', 'svg:x2', 'svg:y2'].map((k) => toCm(el.attribs[k]) || 0);
          const dx = x2 - x1, dy = y2 - y1;
          const dir = Math.abs(dy) < 0.01 ? (dx >= 0 ? 'h' : 'hr') : Math.abs(dx) < 0.01 ? (dy >= 0 ? 'v' : 'vr') : (dx > 0) === (dy > 0) ? 'd' : 'u';
          const left = Math.min(x1, x2), top = Math.min(y1, y2);
          const w = Math.max(Math.abs(dx), 0.5), h = Math.max(Math.abs(dy), 0.5);
          slide.items.push({ id: fresh(), type: 'shape', shape: g['draw:marker-end'] || g['draw:marker-start'] ? 'arrow' : 'line', dir,
            x: pct(`${left - (dir === 'v' || dir === 'vr' ? w / 2 : 0)}cm`, pw), y: pct(`${top - (dir === 'h' || dir === 'hr' ? h / 2 : 0)}cm`, ph), w: pct(`${w}cm`, pw), h: pct(`${h}cm`, ph),
            ...(hex(g['svg:stroke-color']) && { fill: hex(g['svg:stroke-color']) }) });
        }
    };
    await walk(tags(page));
    // Its animations, on the boxes they point at, in click order.
    const timing = tags(page).find((k) => k.name === 'anim:par' && k.attribs['presentation:node-type'] === 'timing-root');
    let k = 0;
    if (timing) {
      for (const a of odpAnimationsOf(timing, tags)) {
        const it = byAnimId.get(a.target) || byParaId.get(a.target);
        if (!it) continue;
        if (it.anim) { if (byParaId.get(a.target) === it && it.type === 'text') it.animBy = 'para'; continue; } // (its next paragraph)
        Object.assign(it, { anim: a.anim, animAt: ++k, ...(a.start && { animStart: a.start }) });
      }
    }
    const notes = tags(page, 'presentation:notes')[0];
    const nf = notes && (tags(notes, 'draw:frame').find((f) => f.attribs['presentation:class'] === 'notes') || tags(notes, 'draw:frame').find((f) => tags(f, 'draw:text-box').length));
    const nt = nf ? paraText(tags(nf, 'draw:text-box')[0] || nf).trim() : '';
    if (nt) slide.notes = nt.slice(0, 20000);
    // Its comments: each a thread, except one at the very place of the one before it (and not older), a reply to it.
    let last = null;
    for (const a of tags(page, 'officeooo:annotation').slice(0, 200)) {
      const kid = (name) => textOf(tags(a, name)[0] || { children: [] }).trim();
      const c = { author: kid('dc:creator').slice(0, 100), at: Date.parse(kid('dc:date') + (/(Z|[+-]\d\d:?\d\d)$/.test(kid('dc:date')) ? '' : 'Z')) || null, text: paraText(a).trim().slice(0, 5000) };
      if (!c.text) continue;
      const place = `${a.attribs['svg:x'] || ''}|${a.attribs['svg:y'] || ''}`;
      if (last && last.place === place && (!c.at || !last.thread.at || c.at >= last.thread.at)) { last.thread.replies.push(c); continue; }
      const thread = { slideId: slide.id, ...c, replies: [] };
      threads.push(thread);
      last = { place, thread };
    }
    slides.push(slide);
  }
  // Links to another slide, now that every slide has its id.
  for (const s of slides) for (const it of s.items) if (it.link?.pageName) { const id = pageLinks.get(it.link.pageName); if (id) it.link = { slide: id }; else delete it.link; }
  // Slide numbers: on every slide, or every one but the first; looping when the show is endless.
  const numbers = !numbered.size ? null : numbered.size === slides.length - 1 && !numbered.has(0) ? 'skip-first' : true;
  const loop = tags(pres, 'presentation:settings')[0]?.attribs['presentation:endless'] === 'true';
  const deck = { theme: 'light', ...(numbers && { numbers }), ...(loop && { loop: true }), slides: slides.length ? slides : [{ id: fresh(), items: [] }] };
  odpComments.set(deck, threads);
  return deck;
}
