// Public branding: the sign-in page shows the company whose domain the address it's opened at
// belongs to (workspace.acme.com → Acme), with its logo and colour. Nothing private is shown.
import { Router } from 'express';
import path from 'node:path';
import { q, FILES_DIR } from '../db.js';
import { notFound } from '../util.js';

export function brandForHost(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  if (!h) return null;
  const parts = h.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const d = q('SELECT o.id, o.name, o.accent, o.logo FROM domains d JOIN orgs o ON o.id = d.org_id WHERE d.name = ?').get(parts.slice(i).join('.'));
    if (d) return { name: d.name, accent: d.accent || null, logo: d.logo ? `/api/public/brand/logo/${d.id}?v=${d.logo.slice(0, 8)}` : null };
  }
  return null;
}

export default function brandRoutes() {
  const r = Router();
  r.get('/', (req, res) => res.json({ brand: brandForHost(req.hostname) }));
  r.get('/logo/:orgId', (req, res) => {
    const o = q('SELECT logo, logo_mime FROM orgs WHERE id = ?').get(req.params.orgId);
    if (!o?.logo) throw notFound();
    res.setHeader('Content-Type', o.logo_mime || 'application/octet-stream');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(FILES_DIR, o.logo));
  });
  return r;
}
