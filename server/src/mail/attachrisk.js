// Attachments that can harm a computer when opened: programs and scripts, Office files with macros,
// names that hide what a file is (invoice.pdf.exe, a right-to-left trick), web pages that imitate a
// sign-in page, and archives holding any of these. Mail shows a warning on them, and downloading or
// opening one needs a "yes, I understand" first (the server refuses until then).
import JSZip from 'jszip';

/** Run straight away on Windows, macOS or Linux when opened. */
const PROGRAMS = new Set(['exe', 'scr', 'com', 'pif', 'bat', 'cmd', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ws', 'msi', 'msp', 'mst', 'hta', 'cpl',
  'jar', 'ps1', 'psm1', 'psd1', 'reg', 'lnk', 'scf', 'url', 'inf', 'dll', 'sys', 'chm', 'gadget', 'application', 'appref-ms', 'msc', 'xll', 'iqy', 'slk',
  'apk', 'appx', 'appxbundle', 'msix', 'msixbundle', 'app', 'command', 'tool', 'pkg', 'dmg', 'sh', 'run', 'bin', 'elf', 'deb', 'rpm',
  'iso', 'img', 'vhd', 'vhdx', 'library-ms', 'search-ms', 'settingcontent-ms', 'onepkg', 'one', 'diagcab', 'xbap', 'website']);
/** Office files that carry macros. */
const MACROS = new Set(['docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'xlsb', 'pptm', 'potm', 'ppsm', 'ppam', 'sldm']);
/** Pages that open in a browser and can imitate a sign-in page or run scripts. */
const PAGES = new Set(['html', 'htm', 'xhtml', 'shtml', 'svg', 'mht', 'mhtml']);
/** Archives that can't be looked inside here. */
const SEALED = new Set(['7z', 'rar', 'ace', 'arj', 'cab', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'lzh', 'z']);
const HARMLESS_LOOKING = /\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|gif|txt|csv|rtf|odt|ods|zip|mp3|mp4|wav)$/i;
const ch = (n) => String.fromCharCode(n);
// Direction controls (U+202A–202E, U+2066–2069), the left/right marks (U+200E, U+200F) and the Arabic letter mark (U+061C).
const BIDI = new RegExp(`[${ch(0x202a)}-${ch(0x202e)}${ch(0x2066)}-${ch(0x2069)}${ch(0x200e)}${ch(0x200f)}${ch(0x061c)}]`);
const BIDI_ALL = new RegExp(BIDI.source, 'g');

const extOf = (name) => (/\.([a-z0-9-]{1,20})$/i.exec(String(name || '').trim().replace(/[\s.]+$/, ''))?.[1] || '').toLowerCase();

/** The worst first: 'danger' (don't open it unless you're sure) beats 'warning' (be careful). */
const worst = (a, b) => (a === 'danger' || b === 'danger' ? 'danger' : a || b || null);

/** What's risky about one file name (and, when given, its first bytes): { level, reasons } or null. */
export function nameRisk(filename, head = null) {
  const name = String(filename || '');
  const reasons = [];
  let level = null;
  const ext = extOf(name);
  if (BIDI.test(name)) { level = 'danger'; reasons.push('Its name uses hidden characters that change how it reads, a trick to disguise what kind of file it is'); }
  const shown = name.replace(BIDI_ALL, '');
  if (PROGRAMS.has(ext)) {
    level = 'danger';
    const pretend = /\.([a-z0-9]{2,5})\s*\.[a-z0-9-]+$/i.exec(shown);
    reasons.push(pretend && HARMLESS_LOOKING.test(`.${pretend[1]}`)
      ? `It's a program (.${ext}) pretending to be a .${pretend[1].toLowerCase()} file`
      : `It's a program or script (.${ext}): opening it runs it on your computer`);
  } else if (MACROS.has(ext)) {
    level = worst(level, 'warning'); reasons.push(`It's an Office file with macros (.${ext}), which can run programs when enabled`);
  } else if (PAGES.has(ext)) {
    level = worst(level, 'warning'); reasons.push(`It's a web page (.${ext}): pages sent by email are often fake sign-in pages`);
  } else if (SEALED.has(ext)) {
    level = worst(level, 'warning'); reasons.push(`It's an archive (.${ext}) that can't be checked here`);
  }
  if (head && head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a && !PROGRAMS.has(ext)) { // "MZ": a Windows program
    level = 'danger'; reasons.push(`It's a Windows program, although its name says .${ext || 'nothing'}`);
  }
  if (head && head.length >= 4 && head.readUInt32BE(0) === 0x7f454c46 && !PROGRAMS.has(ext)) { // ELF: a Linux program
    level = 'danger'; reasons.push('It’s a program, although its name doesn’t say so');
  }
  return level ? { level, reasons } : null;
}

/** An old-style Office file (.doc, .xls, .ppt) with a macro project inside. */
const oleMacros = (buf) => buf.length > 512 && buf.readUInt32BE(0) === 0xd0cf11e0 && (buf.includes(Buffer.from('_VBA_PROJECT', 'utf16le')) || buf.includes(Buffer.from('VBA', 'utf16le')) && buf.includes(Buffer.from('Macros', 'utf16le')));

/**
 * The risk of one attachment: { level: 'danger' | 'warning', reasons: [...] } or null.
 * Archives (.zip) are looked into (names only, nothing unpacked), up to 50 MB and 2,000 entries.
 */
export async function attachmentRisk({ filename, content }) {
  const buf = Buffer.isBuffer(content) ? content : null;
  const own = nameRisk(filename, buf?.subarray(0, 8));
  let level = own?.level || null;
  const reasons = [...(own?.reasons || [])];
  const ext = extOf(filename);
  if (buf && ['doc', 'xls', 'ppt', 'dot', 'xlt', 'pot'].includes(ext) && oleMacros(buf)) {
    level = worst(level, 'warning'); reasons.push('It contains macros, which can run programs when enabled');
  }
  const isZip = buf && buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (isZip && !['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub'].includes(ext) && !MACROS.has(ext) && buf.length <= 50 * 1024 * 1024) {
    let zip = null;
    try { zip = await JSZip.loadAsync(buf, { checkCRC32: false }); } catch { /* not readable */ }
    if (zip) {
      const entries = Object.values(zip.files).filter((e) => !e.dir).slice(0, 2000);
      // Password-protected: bit 0 of each entry's flags (JSZip keeps them as `options`/internals; check the raw headers).
      const encrypted = (() => { for (let i = 0; i + 8 < buf.length && i < 1e6; i++) if (buf.readUInt32LE(i) === 0x04034b50) return (buf.readUInt16LE(i + 6) & 1) === 1; return false; })();
      if (encrypted) { level = worst(level, 'warning'); reasons.push('It’s a password-protected archive, so what’s inside can’t be checked'); }
      const inside = entries.map((e) => ({ e, r: nameRisk(e.name.split('/').pop()) })).filter((x) => x.r);
      const bad = inside.filter((x) => x.r.level === 'danger');
      if (bad.length) { level = 'danger'; reasons.push(`It contains ${bad.length === 1 ? 'a program' : `${bad.length} programs`}: ${bad.slice(0, 3).map((x) => x.e.name.split('/').pop().replace(BIDI_ALL, '')).join(', ')}${bad.length > 3 ? '…' : ''}`); }
      else if (inside.length) { level = worst(level, 'warning'); reasons.push(`It contains files to be careful with: ${inside.slice(0, 3).map((x) => x.e.name.split('/').pop()).join(', ')}`); }
    }
  }
  return level ? { level, reasons: [...new Set(reasons)] } : null;
}
