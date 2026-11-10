// Admin → Data protection: the company's rules (dlp.js), and trying text against them.
import { Router } from 'express';
import { requireAdmin } from '../auth.js';
import { audit } from '../audit.js';
import { rulesOf, addRule, changeRule, removeRule, findIn, cleanRule } from '../dlp.js';

export default function dlpRoutes() {
  const r = Router();
  r.use(requireAdmin);
  r.get('/rules', (req, res) => res.json(rulesOf(req.user.org_id)));
  r.post('/rules', (req, res) => { const x = addRule(req.user.org_id, req.body || {}); audit(req, 'dlp.rule_add', { target: x.name, details: { detector: x.detector, action: x.action } }); res.status(201).json(x); });
  r.patch('/rules/:id', (req, res) => { const x = changeRule(req.user.org_id, req.params.id, req.body || {}); audit(req, 'dlp.rule_change', { target: x.name, details: { action: x.action, enabled: x.enabled } }); res.json(x); });
  r.delete('/rules/:id', (req, res) => { removeRule(req.user.org_id, req.params.id); audit(req, 'dlp.rule_delete', { target: req.params.id }); res.json({ ok: true }); });
  // Try a rule (saved or not) on some text: { rule, text } -> { found: [...] }.
  r.post('/test', (req, res) => {
    const rule = cleanRule(req.body?.rule || {});
    res.json({ found: findIn({ ...rule, words: rule.words ? JSON.parse(rule.words) : [] }, String(req.body?.text || '').slice(0, 20000)) });
  });
  return r;
}
