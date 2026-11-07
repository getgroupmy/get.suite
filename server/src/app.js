import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { requireAuth } from './auth.js';
import { HttpError } from './util.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import fileRoutes from './routes/files.js';
import calendarRoutes, { publicInviteRoutes } from './routes/calendar.js';
import bookingRoutes, { publicBookingRoutes, freeBusyRoutes } from './routes/booking.js';
import brandRoutes from './routes/brand.js';
import contactRoutes from './routes/contacts.js';
import taskRoutes from './routes/tasks.js';
import notificationRoutes from './routes/notifications.js';
import chatRoutes from './routes/chat.js';
import orgRoutes from './routes/orgs.js';
import mailAdminRoutes from './routes/mailAdmin.js';
import webmailRoutes from './routes/webmail.js';
import securityRoutes from './routes/security.js';
import { linkRoutes, publicLinkRoutes } from './routes/links.js';
import davRoutes from './dav.js';
import webdavRoutes from './webdav.js';
import commentRoutes from './routes/comments.js';
import auditRoutes from './routes/audit.js';
import { writeMailConfig, mailEnabled } from './mail/config.js';
import { q } from './db.js';
import { ensureGeneralChannel } from './tenancy.js';

export function createApp({
  publicDir = process.env.PUBLIC_DIR,
  secureCookies = { true: true, false: false }[process.env.SECURE_COOKIES] ?? 'auto',
  trustProxy = process.env.TRUST_PROXY ?? 'loopback, linklocal, uniquelocal',
  maxUploadBytes = Number(process.env.MAX_UPLOAD_MB || 4096) * 1024 * 1024,
} = {}) {
  for (const { id } of q('SELECT id FROM orgs').all()) ensureGeneralChannel(id);
  if (mailEnabled()) writeMailConfig();
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

  // Phone sync (CalDAV/CardDAV). Apps look for these well-known addresses first.
  for (const w of ['/.well-known/caldav', '/.well-known/carddav']) app.all(w, (req, res) => res.redirect(301, '/dav/'));
  app.use('/dav/files', webdavRoutes({ maxUploadBytes })); // Drive as a network drive
  app.use('/dav', davRoutes());
  // Apps given only the server name ask the root first.
  app.use((req, res, next) => (req.path === '/' && (req.method === 'PROPFIND' || req.method === 'REPORT') ? res.redirect(301, '/dav/') : next()));

  // CSRF defence: state-changing API calls must carry a custom header,
  // which browsers never attach to cross-site form posts.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('x-requested-with') !== 'nas-workspace') {
      return next(new HttpError(403, 'Missing request header'));
    }
    next();
  });

  app.use('/api', (req, res, next) => (req.path === '/files/upload' || /^\/files\/[^/]+\/versions$/.test(req.path) ? next() : express.json({ limit: '25mb' })(req, res, next)));

  app.use('/api/auth', authRoutes({ secureCookies }));
  app.use('/api/public/invites', publicInviteRoutes());
  app.use('/api/public/book', publicBookingRoutes());
  app.use('/api/public/brand', brandRoutes());
  app.use('/api/public', publicLinkRoutes({ maxUploadBytes }));
  app.use('/api/users', requireAuth, userRoutes());
  app.use('/api/orgs', requireAuth, orgRoutes());
  app.use('/api/mail-admin', requireAuth, mailAdminRoutes());
  app.use('/api/mail', requireAuth, webmailRoutes());
  app.use('/api/security', requireAuth, securityRoutes());
  app.use('/api/audit', requireAuth, auditRoutes());
  app.use('/api/files', requireAuth, fileRoutes({ maxUploadBytes }));
  app.use('/api/links', requireAuth, linkRoutes());
  app.use('/api/comments', requireAuth, commentRoutes());
  app.use('/api/events', requireAuth, calendarRoutes());
  app.use('/api/bookings', requireAuth, bookingRoutes());
  app.use('/api/freebusy', requireAuth, freeBusyRoutes());
  app.use('/api/contacts', requireAuth, contactRoutes());
  app.use('/api/chat', requireAuth, chatRoutes());
  app.use('/api/tasks', requireAuth, taskRoutes());
  app.use('/api/notifications', requireAuth, notificationRoutes());
  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found')));
  // Share-link pages: keep them out of search engines.
  app.use(['/s/', '/i/'], (req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); next(); });

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
