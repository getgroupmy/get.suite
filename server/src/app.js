import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { requireAuth } from './auth.js';
import { HttpError } from './util.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import fileRoutes from './routes/files.js';
import calendarRoutes from './routes/calendar.js';
import contactRoutes from './routes/contacts.js';
import chatRoutes, { ensureGeneralChannel } from './routes/chat.js';

export function createApp({
  publicDir = process.env.PUBLIC_DIR,
  secureCookies = { true: true, false: false }[process.env.SECURE_COOKIES] ?? 'auto',
  trustProxy = process.env.TRUST_PROXY ?? 'loopback, linklocal, uniquelocal',
  maxUploadBytes = Number(process.env.MAX_UPLOAD_MB || 4096) * 1024 * 1024,
} = {}) {
  ensureGeneralChannel();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // CSRF defence: state-changing API calls must carry a custom header,
  // which browsers never attach to cross-site form posts.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('x-requested-with') !== 'nas-workspace') {
      return next(new HttpError(403, 'Missing request header'));
    }
    next();
  });

  app.use('/api', (req, res, next) => (req.path === '/files/upload' ? next() : express.json({ limit: '25mb' })(req, res, next)));

  app.use('/api/auth', authRoutes({ secureCookies }));
  app.use('/api/users', requireAuth, userRoutes());
  app.use('/api/files', requireAuth, fileRoutes({ maxUploadBytes }));
  app.use('/api/events', requireAuth, calendarRoutes());
  app.use('/api/contacts', requireAuth, contactRoutes());
  app.use('/api/chat', requireAuth, chatRoutes());
  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found')));

  // Web app (built React bundle) with SPA fallback.
  if (publicDir && fs.existsSync(publicDir)) {
    publicDir = path.resolve(publicDir);
    app.use(express.static(publicDir, { index: false, maxAge: '1h', setHeaders: (res, p) => {
      if (p.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } }));
    const index = path.join(publicDir, 'index.html');
    app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(index, { headers: { 'Cache-Control': 'no-cache' } }) : next()));
  }

  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) return res.end();
    res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
  });

  return app;
}
