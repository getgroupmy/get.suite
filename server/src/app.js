import { practiceClicked, practicePage } from './phishpractice.js';
import { mcpRoutes, innerIp } from './mcp.js';
import { googleImportRoutes } from './mail/googleimport.js';
import { msImportRoutes } from './mail/msimport.js';
import { mcpAuthRoutes } from './mcpauth.js';
import slideQaRoutes from './routes/slideqa.js';
import webImportRoutes from './routes/webimport.js';
import { oidcPublicRoutes, oidcApiRoutes } from './oidc.js';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { requireAuth, tokenFromReq } from './auth.js';
import { HttpError } from './util.js';
import authRoutes from './routes/auth.js';
import { compressJson, gzipStatic } from './compress.js';
import userRoutes from './routes/users.js';
import fileRoutes from './routes/files.js';
import roomRoutes from './routes/rooms.js';
import calendarRoutes, { publicInviteRoutes } from './routes/calendar.js';
import timeOffRoutes from './routes/timeoff.js';
import bookingRoutes, { publicBookingRoutes, freeBusyRoutes } from './routes/booking.js';
import { publicConfidentialRoutes } from './mail/confidential.js';
import { publicUnsubscribeRoutes, oneClickRoute } from './mail/mergeunsub.js';
import brandRoutes from './routes/brand.js';
import announcementRoutes from './routes/announcements.js';
import formRoutes, { publicFormRoutes } from './routes/forms.js';
import { meetRoutes, publicMeetRoutes } from './meet.js';
import { groupRoutes } from './groups.js';
import noteRoutes from './routes/notes.js';
import docPrefRoutes from './routes/docprefs.js';
import approvalRoutes from './routes/approvals.js';
import signatureRoutes, { publicSignRoutes } from './routes/signatures.js';
import takeoutRoutes from './routes/takeout.js';
import locationRoutes from './routes/location.js';
import contactRoutes from './routes/contacts.js';
import taskRoutes from './routes/tasks.js';
import notificationRoutes from './routes/notifications.js';
import pushRoutes from './routes/push.js';
import chatRoutes, { chatHookRoutes } from './routes/chat.js';
import { publishRoutes, publicPublishRoutes } from './routes/publish.js';
import { officePreviewRoutes } from './office/preview.js';
import { apiTokenRoutes, bearerOf } from './apitokens.js';
import orgRoutes from './routes/orgs.js';
import mailAdminRoutes, { mtaStsPolicy } from './routes/mailAdmin.js';
import webmailRoutes from './routes/webmail.js';
import dlpRoutes from './routes/dlp.js';
import securityRoutes from './routes/security.js';
import { linkRoutes, publicLinkRoutes } from './routes/links.js';
import { externalShareRoutes } from './routes/externalshares.js';
import davRoutes from './dav.js';
import webdavRoutes from './webdav.js';
import commentRoutes from './routes/comments.js';
import auditRoutes from './routes/audit.js';
import { writeMailConfig, mailEnabled, startKnownSendersRefresh } from './mail/config.js';
import { q } from './db.js';
import { ensureGeneralChannel } from './tenancy.js';

/** Pages that may be shown inside other websites: a form for anyone (/f/…) and a published page (/pub/…). */
export const EMBEDDABLE = /^\/(f|pub)\/[A-Za-z0-9_-]+\/?$/;

export function createApp({
  publicDir = process.env.PUBLIC_DIR,
  secureCookies = { true: true, false: false }[process.env.SECURE_COOKIES] ?? 'auto',
  trustProxy = process.env.TRUST_PROXY ?? 'loopback, linklocal, uniquelocal',
  maxUploadBytes = Number(process.env.MAX_UPLOAD_MB || 4096) * 1024 * 1024,
} = {}) {
  for (const { id } of q('SELECT id FROM orgs').all()) ensureGeneralChannel(id);
  if (mailEnabled()) { writeMailConfig(); startKnownSendersRefresh(); }
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use(innerIp); // our own MCP calls to the API keep the caller's address

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    // Public forms and published pages may be embedded in other websites (an iframe on the company's own
    // site); everything else only in Workspace itself.
    if (req.method === 'GET' && EMBEDDABLE.test(req.path)) res.setHeader('Content-Security-Policy', 'frame-ancestors *');
    else res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // Phone sync (CalDAV/CardDAV). Apps look for these well-known addresses first.
  for (const w of ['/.well-known/caldav', '/.well-known/carddav']) app.all(w, (req, res) => res.redirect(301, '/dav/'));
  // MTA-STS: other mail servers fetch https://mta-sts.<domain>/.well-known/mta-sts.txt to learn that mail
  // for the domain must come over an encrypted connection (Admin → Email turns it on per domain).
  app.get('/.well-known/mta-sts.txt', (req, res) => {
    const host = String(req.hostname || '').toLowerCase();
    const policy = host.startsWith('mta-sts.') && mtaStsPolicy(host.slice('mta-sts.'.length));
    if (!policy) return res.status(404).type('text/plain').send('No MTA-STS policy here\n');
    res.type('text/plain').set('Cache-Control', 'max-age=3600').send(policy);
  });
  app.use('/dav/files', webdavRoutes({ maxUploadBytes })); // Drive as a network drive
  app.use('/dav', davRoutes());
  // Chat webhooks: scripts post with only the secret address (no session, so outside /api and its CSRF check).
  app.use('/hooks/chat', chatHookRoutes());
  // "Sign in with Workspace" (OpenID Connect): the endpoints other apps call (oidc.js).
  app.use(oidcPublicRoutes());
  // Apps given only the server name ask the root first.
  app.use((req, res, next) => (req.path === '/' && (req.method === 'PROPFIND' || req.method === 'REPORT') ? res.redirect(301, '/dav/') : next()));

  // CSRF defence: state-changing API calls must carry a custom header,
  // which browsers never attach to cross-site form posts.
  app.use('/api', (req, res, next) => {
    // Scripts with an API token and no cookie can't be a forged browser request, so they needn't send it.
    const scripted = bearerOf(req) && !tokenFromReq(req);
    if (req.method !== 'GET' && req.method !== 'HEAD' && !scripted && req.get('x-requested-with') !== 'nas-workspace') {
      return next(new HttpError(403, 'Missing request header'));
    }
    next();
  });

  app.use('/api', compressJson()); // big GET answers gzipped (see compress.js)
  app.use('/api', (req, res, next) => (req.path === '/files/upload' || /^\/files\/[^/]+\/versions$/.test(req.path) ? next() : express.json({ limit: '25mb' })(req, res, next)));

  app.use('/api/auth', authRoutes({ secureCookies }));
  app.use('/api/public/invites', publicInviteRoutes());
  app.use('/api/public/book', publicBookingRoutes());
  app.use('/api/public/confidential', publicConfidentialRoutes());
  app.use('/api/public/unsubscribe', publicUnsubscribeRoutes());
  app.use('/api/public/brand', brandRoutes());
  app.use('/api/public/forms', publicFormRoutes());
  app.use('/api/public/sign', publicSignRoutes());
  app.use('/api/public/pub', publicPublishRoutes());
  app.use('/api/public/meet', publicMeetRoutes());
  app.use('/api/public', publicLinkRoutes({ maxUploadBytes }));
  // A practice phishing email's link (Admin → Phishing → Practice emails): noted, then a page saying it was practice.
  app.get('/practice/:token', (req, res) => {
    res.set({ 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).type('html').send(practicePage(practiceClicked(req.params.token)));
  });
  // AI assistants (Claude, ChatGPT…) over MCP, with an API token.
  app.use('/mcp', mcpRoutes(requireAuth));
  app.use(mcpAuthRoutes()); // how assistants sign in to it (OAuth discovery and registration)
  app.use('/api/users', requireAuth, userRoutes());
  app.use('/api/orgs', requireAuth, orgRoutes());
  app.use('/api/mail-admin', requireAuth, mailAdminRoutes());
  app.use('/api/mail/import/google', requireAuth, googleImportRoutes()); // Google sign-in for imports (works without mail too)
  app.use('/api/mail/import/microsoft', requireAuth, msImportRoutes()); // Microsoft sign-in for imports (calendars, contacts and OneDrive without mail too)
  app.use('/api/mail', requireAuth, webmailRoutes());
  app.use('/api/security', requireAuth, securityRoutes());
  app.use('/api/dlp', requireAuth, dlpRoutes());
  app.use('/api/audit', requireAuth, auditRoutes());
  app.use('/api/files', requireAuth, fileRoutes({ maxUploadBytes }));
  app.use('/api/publish', requireAuth, publishRoutes());
  app.use('/api/tokens', requireAuth, apiTokenRoutes());
  app.use('/api/office-preview', requireAuth, officePreviewRoutes());
  app.use('/api/links', requireAuth, linkRoutes({ maxUploadBytes }));
  app.use('/api/external-shares', requireAuth, externalShareRoutes());
  app.use('/api/comments', requireAuth, commentRoutes());
  app.use('/api/events', requireAuth, calendarRoutes());
  app.use('/api/time-off', requireAuth, timeOffRoutes());
  app.use('/api/rooms', requireAuth, roomRoutes());
  app.use('/api/bookings', requireAuth, bookingRoutes());
  app.use('/api/freebusy', requireAuth, freeBusyRoutes());
  app.use('/api/contacts', requireAuth, contactRoutes());
  app.use('/api/chat', requireAuth, chatRoutes());
  app.use('/api/tasks', requireAuth, taskRoutes());
  app.use('/api/notifications', requireAuth, notificationRoutes());
  app.use('/api/push', requireAuth, pushRoutes());
  app.use('/api/announcements', requireAuth, announcementRoutes());
  app.use('/api/forms', requireAuth, formRoutes());
  app.use('/api/meet', requireAuth, meetRoutes());
  app.use('/api/groups', requireAuth, groupRoutes());
  app.use('/api/notes', requireAuth, noteRoutes());
  app.use('/api/slide-qa', requireAuth, slideQaRoutes());
  app.use('/api/doc-prefs', requireAuth, docPrefRoutes());
  app.use('/api/oauth', requireAuth, oidcApiRoutes());
  app.use('/api/approvals', requireAuth, approvalRoutes());
  app.use('/api/sheets-web', requireAuth, webImportRoutes()); // IMPORTDATA / IMPORTHTML
  app.use('/api/signatures', requireAuth, signatureRoutes());
  app.use('/api/takeout', requireAuth, takeoutRoutes());
  app.use('/api/location', requireAuth, locationRoutes());
  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found')));
  // Share-link pages: keep them out of search engines.
  app.use(['/s/', '/i/', '/f/', '/c/', '/u/'], (req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); next(); });
  app.post('/u/:token', ...oneClickRoute()); // mail apps' one-click unsubscribe (mail merge)

  // Shared to Workspace from another app, before its service worker is running (it normally takes
  // these: public/sw.js): nothing is read or kept here, Drive just opens.
  app.post('/share-target', (req, res) => res.redirect(303, '/drive'));

  // What browsers report the app page's Content-Security-Policy blocked: into the server log, to spot something the
  // policy stops that it shouldn't (or an attempt it rightly stopped). Small and rate-limited per address.
  const cspSeen = new Map();
  app.post('/csp-report', express.json({ type: () => true, limit: '8kb' }), (req, res) => {
    const r = req.body?.['csp-report'] || req.body || {};
    const n = (cspSeen.get(req.ip) || 0) + 1;
    cspSeen.set(req.ip, n);
    if (cspSeen.size > 1000) cspSeen.clear();
    if (n <= 20) console.warn('[csp] blocked', String(r['violated-directive'] || r['effective-directive'] || '').slice(0, 60), String(r['blocked-uri'] || '').slice(0, 200), 'on', String(r['document-uri'] || '').replace(/[?#].*$/, '').slice(0, 200));
    res.status(204).end();
  });
  setInterval(() => cspSeen.clear(), 3600e3).unref();

  // Web app (built React bundle) with SPA fallback.
  if (publicDir && fs.existsSync(publicDir)) {
    publicDir = path.resolve(publicDir);
    app.use(gzipStatic(publicDir, (p) => ({
      ...(p.includes(`${path.sep}assets${path.sep}`) && { 'Cache-Control': 'public, max-age=31536000, immutable' }),
      ...(/[\\/](sw\.js|manifest\.webmanifest)$/.test(p) && { 'Cache-Control': 'no-cache' }),
    })));
    app.use(express.static(publicDir, { index: false, maxAge: '1h', setHeaders: (res, p) => {
      if (p.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      if (/[\\/](sw\.js|manifest\.webmanifest)$/.test(p)) res.setHeader('Cache-Control', 'no-cache'); // the installed app picks up new versions at once
    } }));
    const index = path.join(publicDir, 'index.html');
    // The app's own page: only its own scripts run (no inline script, event handlers or javascript: links, wherever
    // they might slip in), plus what the app needs: inline styles, pictures from anywhere (emails' pictures, once
    // allowed), media and previews from blob: and data:, and its live connection.
    const csp = (req) => {
      const host = String(req.get('host') || '').replace(/[^\w.:[\]-]/g, '');
      return [
        "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", 'img-src * data: blob:', "media-src 'self' data: blob:",
        "font-src 'self' data:", `connect-src 'self'${host ? ` ws://${host} wss://${host}` : ''}`, "frame-src 'self' blob: data:", "worker-src 'self' blob:",
        "object-src 'none'", "base-uri 'self'", "form-action 'self'", `frame-ancestors ${EMBEDDABLE.test(req.path) ? '*' : "'self'"}`, 'report-uri /csp-report',
      ].join('; ');
    };
    app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(index, { headers: { 'Cache-Control': 'no-cache', 'Content-Security-Policy': csp(req) } }) : next()));
  }

  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) return res.end();
    // Errors the code raised on purpose (HttpError) say what's wrong ("Email is not set up on this server", "The mail
    // server took too long to answer"); anything unexpected stays "Server error", its details only in the log.
    res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? 'Server error' : err.message });
  });

  return app;
}
