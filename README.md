# NAS Workspace

A self-hosted, Google Workspace-style office suite built to run on a Synology DS224+ (or any Docker host). One server hosts **several separate companies**, each with its own domains, users and admins.

| App | What it does |
|---|---|
| **Drive** | Folders, uploads up to 4 GB each (drag and drop), previews (images, PDF, video, audio, text), rename, move, trash and restore, search, and sharing with people as viewer or editor (folder shares apply to everything inside) |
| **Docs** | Rich-text documents (headings, lists, links, quotes, code, alignment) with autosave, print/PDF and HTML export |
| **Sheets** | Spreadsheets with formulas (`SUM AVERAGE MIN MAX MEDIAN COUNT COUNTA COUNTIF SUMIF IF IFERROR AND OR NOT ROUND ABS SQRT POWER MOD INT CONCAT LEN UPPER LOWER TRIM LEFT RIGHT TODAY NOW`), multiple sheets, copy/paste with reference shifting, and CSV import/export |
| **Calendar** | Month view, all-day and timed events, colours, upcoming list |
| **Contacts** | Personal address book, plus a directory of everyone on the NAS |
| **Chat** | Channels and direct messages, delivered live over WebSockets |
| **Admin** | Create, disable, reset or delete users; per-user storage use; company settings; all companies (platform owner) |

## Companies (multi-tenant)

| Role | Can do |
|---|---|
| **Platform owner** (the account created on first run) | Add and delete companies, assign domains, set storage quotas, manage any company's users |
| **Company admin** | Manage their own company's users (addresses on their company's domains only), rename the company, switch external collaboration on or off |
| **User** | Use the apps; sees only their own company's directory and chat channels |

- **Sign-in:** everyone signs in with their email address, e.g. `anna@company.com`. The domain must belong to their company, and the same address will become their mailbox in the mail phase.
- **Isolation:** companies can't see each other's directory, channels, users or files.
- **Working across companies:** a user can share a file or folder, or start a direct message, with someone at another company by typing their **exact email address**. This works only while **both** companies allow external collaboration. If either admin switches it off, outside access ends immediately; switching it back on restores it. Shares show an "External · Company" badge.
- **Quotas:** set per company by the platform owner (0 = unlimited).

When two people edit the same doc or sheet, changes are pushed live. If both edit at once, the second person sees a conflict banner ("load theirs" or "keep mine") instead of silently losing work.

## Architecture

```
Browser (React SPA) ──HTTP/WebSocket──▶ Node.js server (Express) ──▶ SQLite  (data/workspace.db)
                                                              └──▶ files    (data/files/<uuid>)
```

- **One container, about 60 to 120 MB of RAM.** There is no separate database server, which matters on the DS224+'s 2 GB.
- **Server:** `server/src`. Node 22 with the built-in `node:sqlite` module, so there are no native modules to compile. Express 5 and `ws` are the only dependencies.
- **Web:** `web/src`. React 18, Vite, TipTap (the Docs editor) and a custom formula engine (`web/src/apps/sheets/formula.js`).
- **Security:**
  - Passwords are hashed with scrypt.
  - Sessions use HttpOnly SameSite cookies, which are Secure automatically when served over HTTPS.
  - Write requests must carry a CSRF header.
  - Login attempts are rate-limited.
  - Uploaded HTML and SVG files are never rendered inline on the app's origin.
  - Every file access checks permissions up the folder chain.

## Install on a Synology DS224+

Requires DSM 7.2+ and **Container Manager** (from Package Center).

1. **Create folders.** In File Station, inside the `docker` shared folder, create `workspace/app` and `workspace/data`.
2. **Copy the code.** Upload this whole project into `docker/workspace/app`, so that `docker-compose.yml` sits directly in it.
3. **Set the user ID.** Enable SSH (Control Panel → Terminal & SNMP), connect with `ssh you@NAS-IP` and run `id`. Put your `uid` and `gid` into the `user:` line of `docker-compose.yml` (the default `1026:100` is the usual first admin account on DSM). Also set `TZ` to your time zone.
4. **Build and start.** In Container Manager, go to **Project → Create**:
   - Name: `workspace`
   - Path: `/volume1/docker/workspace/app`
   - Choose "Use existing docker-compose.yml", then click Next and Done. The first build takes a few minutes.
5. **Create the workspace.** Open `http://NAS-IP:8080`. The first visit asks for your company name, its domain and your account, and that account becomes the **platform owner**. Then use **Admin → All companies** to add other companies (each gets its own first admin), and **Admin → Users** to add people.

Using 2 GB RAM: the app runs fine, and the 512 MB `mem_limit` is generous. Adding a RAM stick only matters if you run other heavy containers.

## Publish it securely on your fixed IP

1. **DNS:** at your domain registrar, add an A record, e.g. `workspace.example.com → <your fixed IP>`. One hostname serves every company. If you like, each company can also get its own name (e.g. `office.company.com`), added as an extra reverse-proxy entry and certificate pointing at the same port 8080.
2. **Router:** forward TCP **443** and **80** to the NAS. Port 80 is needed only for Let's Encrypt renewals. Do **not** forward 8080 or the DSM ports (5000/5001).
3. **Certificate:** Control Panel → Security → Certificate → Add → *Get a certificate from Let's Encrypt* for `workspace.example.com`.
4. **Reverse proxy:** Control Panel → Login Portal → Advanced → Reverse Proxy → Create:
   - Source: `HTTPS`, host `workspace.example.com`, port `443`, and enable HSTS.
   - Destination: `HTTP`, `localhost`, port `8080`.
   - Custom Header tab → Create → **WebSocket**. This is required for live chat and live updates.
5. **Assign the certificate:** back in Certificate → Settings, assign the new certificate to that reverse proxy entry.
6. **Firewall (recommended):** Control Panel → Security → Firewall. Allow 80 and 443 from everywhere, and allow DSM ports only from your LAN.

Cookies switch to `Secure` automatically once traffic arrives over HTTPS through the proxy.

## Backups

All data is in `docker/workspace/data`:

- `files/`: uploaded files
- `workspace.db`: companies, users, docs, sheets, calendar, contacts and chat
- `backups/`: a consistent database snapshot written daily (the last 7 are kept)

Point **Hyper Backup** at `docker/workspace/data`, ideally to an off-site target. To restore, stop the project, copy the files back (replace `workspace.db` with a snapshot from `backups/` if needed) and start it again.

## Updating

Upgrading from v0.1 (before companies existed) is automatic. Existing users are moved into a company called "My company" with addresses like `alice@workspace.local`, and the first admin becomes the platform owner. Afterwards, add your real domain under Admin → All companies → Domains. Changing existing users' addresses isn't built in yet; it's on the roadmap.

To update, replace the files in `docker/workspace/app` with the new version. Then in Container Manager, go to Project → workspace → **Action → Build**. Your data folder is untouched.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP port inside the container |
| `DATA_DIR` | `/data` | Where the database and files live |
| `MAX_UPLOAD_MB` | `4096` | Largest single upload |
| `SECURE_COOKIES` | auto | Force `true` or `false`; auto means Secure when the request is HTTPS |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Which proxies' `X-Forwarded-*` headers to trust |

## Development

```bash
cd server && npm install && npm run dev        # API on :8080 (data in server/data)
cd web && npm install && npm run dev           # UI on :5173, proxies /api and /ws to :8080
cd server && npm test                          # API tests
cd web && npm test                             # formula engine tests
```

## Roadmap

- **Mail (next):** multi-domain mailboxes for every user (`name@company-domain`), aliases and per-mailbox quotas, managed from the same admin screens, plus a webmail app in this UI, backed by a hardened Postfix and Dovecot container. Your business fixed IP makes this viable. You need port 25 open both ways, a **PTR (reverse-DNS) record** set by your ISP, and SPF, DKIM and DMARC DNS records.
- **Real-time co-editing:** live cursors and character-level merging (Yjs) in Docs and Sheets.
- **Phone sync:** CalDAV and CardDAV, so calendars and contacts sync with the phone's built-in apps; WebDAV for Drive.
- **Renaming a user's address** (moving them to another domain of the same company), **two-factor authentication**, file version history, public share links, Slides, cell formatting in Sheets, and week and day calendar views.
