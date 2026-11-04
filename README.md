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
| **Mail** | A mailbox for every user on their company's domains: webmail (read, reply, forward, attachments from your computer or Drive, archive, spam, search, stars), rich-text writing (bold, lists, links, quotes), drafts that save automatically, vacation auto-replies, filter rules, signatures, folders, send as aliases you belong to, and IMAP/SMTP for phones and Outlook |
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
                                              │                └──▶ files    (data/files/<uuid>)
                                              │ writes accounts/aliases/DKIM keys to mail-config/
                                              │ webmail over IMAP 993 / SMTP 465
                                              ▼
Internet ◀── SMTP 25 ──▶  mail container: Postfix (SMTP) · Dovecot (IMAP, mailboxes) · Rspamd (spam filtering, DKIM signing)
Phones/Outlook ── IMAP 993 / SMTP 465·587 ──▶ (same container)
```

- **Two containers, about 250 to 300 MB of RAM in total.** The app needs 60 to 120 MB, with no separate database server, which matters on the DS224+'s 2 GB. The mail container measured about 160 MB, most of it Rspamd.
- **Mail server:** `mail/`. Standard, battle-tested programs (Postfix, Dovecot, Rspamd) in an Ubuntu 24.04 image with configuration written for this app. The app owns all accounts and settings: it writes plain tables to `mail-config/`, and the mail container picks up changes within 5 seconds. Users' passwords are never stored in readable form. Webmail opens mailboxes with a server-held secret (a Dovecot "master user"), and phones use the user's own password, which is kept in step automatically.
- **Server:** `server/src`. Node 22 with the built-in `node:sqlite` module, so there are no native modules to compile. Express 5 and `ws` are the only dependencies.
- **Web:** `web/src`. React 18, Vite, TipTap (the Docs editor) and a custom formula engine (`web/src/apps/sheets/formula.js`).
- **Security:**
  - Passwords are hashed with scrypt.
  - Sessions use HttpOnly SameSite cookies, which are Secure automatically when served over HTTPS.
  - Write requests must carry a CSRF header.
  - Sign-in protection covers both the web and mail apps; see [Sign-in protection](#sign-in-protection).
  - Uploaded HTML and SVG files are never rendered inline on the app's origin.
  - Every file access checks permissions up the folder chain.
  - HTML emails are shown in a sandboxed frame with no scripts and no access to the app.
  - Remote images in emails are blocked until the reader clicks "Show images", which stops tracking pixels.
  - Email attachments always download rather than open in the browser.
  - Users can only send from their own address or an alias they belong to; this is enforced by the mail server itself.

## Install on a Synology DS224+

Requires DSM 7.2+ and **Container Manager** (from Package Center).

1. **Create folders.** In File Station, inside the `docker` shared folder, create `workspace/app`, `workspace/data`, `workspace/mail-config` and `workspace/mailboxes`.
2. **Copy the code.** Upload this whole project into `docker/workspace/app`, so that `docker-compose.yml` sits directly in it.
3. **Set the user ID.** Enable SSH (Control Panel → Terminal & SNMP), connect with `ssh you@NAS-IP` and run `id`. Put your `uid` and `gid` into the `user:` line of `docker-compose.yml` (the default `1026:100` is the usual first admin account on DSM). At the top of the file, set your **mail hostname** (e.g. `mail.yourcompany.com`) and **time zone**.
4. **Build and start.** In Container Manager, go to **Project → Create**:
   - Name: `workspace`
   - Path: `/volume1/docker/workspace/app`
   - Choose "Use existing docker-compose.yml", then click Next and Done. The first build takes a few minutes.
5. **Create the workspace.** Open `http://NAS-IP:8080`. The first visit asks for your company name, its domain and your account, and that account becomes the **platform owner**. Then use **Admin → All companies** to add other companies (each gets its own first admin), and **Admin → Users** to add people.

On 2 GB of RAM, both containers fit with room to spare. Adding a RAM stick only matters if you run other heavy containers. Don't install Synology's own MailPlus or Mail Server packages alongside this, because they use the same ports (25, 465, 587, 993).

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

## Email

Your business fixed IP is what makes this work. Do these once:

1. **Ask your ISP** for two things:
   - Make sure port **25** is open in both directions.
   - Set **reverse DNS (PTR)** for your fixed IP to your mail hostname, e.g. `mail.yourcompany.com`. Gmail and Outlook reject mail from IPs without a matching PTR record.
2. **Mail hostname:** at your registrar, add an **A record** `mail.yourcompany.com → <fixed IP>`. This one hostname serves every company and domain.
3. **Router:** forward TCP **25, 465, 587 and 993** to the NAS.
4. **Certificate:** in DSM, go to Control Panel → Security → Certificate → Add → Let's Encrypt for `mail.yourcompany.com`. To use it in the mail container:
   - SSH in and run `sudo cat /usr/syno/etc/certificate/_archive/DEFAULT` to see the certificate folder ID. If the mail certificate isn't the default, run `sudo ls -l /usr/syno/etc/certificate/_archive/` and find the folder whose `cert.pem` shows `CN=mail.yourcompany.com` (`sudo openssl x509 -noout -subject -in …/cert.pem`).
   - Uncomment the `/etc/nw-tls` line in `docker-compose.yml`, replace `REPLACE_ME` with that ID, and rebuild.
   - DSM renews the certificate in place, and the mail container reloads it automatically.
   - Until this is done, the container uses a self-signed certificate. Webmail works, but phones will warn.
5. **Every domain:** open **Admin → Email**. Each domain shows the exact **MX, SPF, DKIM and DMARC** records to add at its DNS provider, with copy buttons. Use **Check DNS** to confirm them, and as the platform owner use **Mail server → Check** to verify the A and PTR records.
6. **Test:** send a message from webmail to a Gmail address, then in Gmail use "Show original". SPF, DKIM and DMARC should all say `PASS`.

**What's built in:**
- **Mailboxes:** every user automatically has one at their sign-in address, with its standard folders: Inbox, Drafts, Sent, Archive, Junk and Trash.
- **Aliases** (Admin → Email): one address delivers to several people or forwards outside, e.g. `sales@` → three people. Members can also send as the alias.
- **postmaster@ and abuse@** go to the company's admins automatically, as email standards require.
- **Catch-all** (Admin → Email, per domain): mail to any address on the domain that doesn't exist (typos, old addresses, `anything@`) goes to one mailbox you choose.
  - Real mailboxes and aliases keep their own mail.
  - The catch-all must be a mailbox in the same company, so the server can't be used to relay a domain's junk elsewhere.
  - Catch-alls attract extra spam; turn it off to return such mail to the sender again.
- **Mailbox size limits** (Admin → Users → ⋮ → Mailbox size). When a mailbox is full, new mail bounces to the sender.
- **Spam:** Rspamd scores incoming mail, rejects obvious spam and files likely spam in Junk.
- **Suspended users:** disabling a user blocks sign-in everywhere, but their mail keeps arriving.
- **Drafts:** compose saves to the Drafts folder 2 seconds after you stop typing. Closing the window keeps the draft, the bin icon discards it, and clicking a draft in Drafts resumes it.
  - Drafts live on the mail server, so phones and Outlook see them.
  - Attachments in a draft are kept as links to Drive files. They're restored when the draft is reopened in webmail, but phones don't see them until the message is sent.
- **Rich-text writing:** bold, italic, underline, strike, bulleted and numbered lists, quotes and links. Every message is sent with a formatted version and a readable plain-text version (quotes marked with `>`, lists with `-` / `1.`), so any mail app can show it. Replies quote the original as a quoted block. Quotes are built from the original's plain text, so formatting tricks in a received email can't carry into yours.
- **Filters** (Mail → Filters, or **Filter messages like this** on any message): rules run by the mail server as mail arrives, so they apply to phones too. They run in order, and can be reordered and switched on or off.
  - Conditions: From, To or Cc, or Subject *contains*, *doesn't contain* or *is exactly* a value, matching all or any of them.
  - Actions: move to a folder (created if needed, e.g. `Clients/Acme`), mark as read, star, forward a copy, or delete.
  - A matching filter stops later ones unless you untick "Don't apply later filters".
  - Mail a filter files away still gets your vacation reply; mail it deletes doesn't.
  - Forwarded copies keep the original sender. Some receiving servers treat forwarded mail from outside domains with suspicion (SPF), so forwarding works best within your own companies.
- **Folders:** create folders and subfolders from the Mail sidebar (**New folder**). Each of your own folders has a ⋮ menu with **Rename** and **Delete**.
  - The built-in folders (Inbox, Drafts, Sent, Archive, Junk, Trash) can't be renamed or deleted.
  - Renaming moves subfolders with it and updates any filter that files mail there.
  - Deleting moves the folder's messages, and its subfolders' messages, to **Trash** first, so nothing is lost by accident. Filters that filed mail there are switched off rather than silently recreating the folder.
  - New and renamed folders are subscribed automatically, including folders a filter creates, so phones and Outlook show them.
- **Signatures** (Mail → Signature): a formatted signature for **each address you can send from**, your own and every alias you belong to (e.g. `sales@`), added below a standard `-- ` separator.
  - Each one can be added to new messages, and to replies and forwards, where it sits above the quoted message.
  - Changing **From** while writing swaps in that address's signature.
  - Replies and forwards default to sending from the address the message was sent to, so a reply to mail for `sales@` goes out from `sales@` with the sales signature.
  - It's inserted when you start writing, so you can still edit it in a particular message, and a reopened draft never gets a second copy.
- **Pictures in messages:** insert them with the 🖼 button, paste a screenshot, or drag an image file into the message (PNG, JPEG, GIF or WebP, up to 10 MB each). Signatures can contain pictures too, such as a logo.
  - **Size:** click a picture, then either drag the handle on its bottom-right corner (any width from 10% to 100% of the message, with a live percentage), or choose **Small, Medium, Large or Full width** (25/50/75/100%) in the toolbar.
    - Dragging snaps to those four sizes when you're within 2%.
    - Keyboard: Tab to the handle and use the arrow keys (5% steps, Shift for 1%), Home for the smallest and End for full width.
    - The size is kept in drafts and shows the same in recipients' mail apps.
    - Pictures without a chosen size show at their natural size, and no picture ever gets wider than a phone screen.
  - Pictures are saved to your Drive.
  - When the message is sent they're embedded in the email itself, so recipients see them without access to your server and without "show images" prompts.
  - The plain-text version shows `[image: name]` in their place.
  - Pictures count towards the 25 MB message limit.
  - Replies and forwards quote the original's text, so pictures embedded in the original aren't carried over.
- **New-mail notifications:** while Workspace is open in any tab, new mail in your Inbox shows up within a second or two.
  - A pop-up names the sender and subject.
  - The **Mail** icon shows the unread count, and the browser tab title starts with it, e.g. `(3) Workspace`.
  - The open inbox updates by itself.
  - Turn on **Desktop alerts** in the Mail sidebar to get an operating-system notification while Workspace is in a background tab. Clicking it opens the message.
  - Reading mail on a phone or in another tab updates the count too.
  - Behind the scenes, the app keeps one IMAP IDLE connection on the Inbox for each person who has Workspace open, the same push mechanism phones use, and closes it a minute after their last tab closes. Nothing is polled, and watching never marks mail as read.
  - **Other folders:** choose **Notify me about new mail** in a folder's ⋮ menu, which is useful for folders a filter fills, such as `Clients/Acme`.
    - Followed folders show a bell, alerts say which folder ("New mail in Suppliers from …"), and the badge counts unread mail across the Inbox and every followed folder.
    - You can follow up to 10 folders besides the Inbox, which is always followed. Each one uses its own watching connection.
    - Renaming a followed folder keeps it followed; deleting it unfollows it.
- **Forward as attachment:** sends the original email whole, as an `.eml` file with its formatting, pictures, attachments and technical headers (including DKIM) intact. Use it to report a suspicious message to IT, or to pass one on exactly as received.
- **Forwarding with attachments:** forwarding a message brings its attachments along as chips you can remove one by one. They're attached straight from the original message when you send, so nothing is downloaded and re-uploaded. Forward drafts remember them too. If the original has been deleted by the time you send, you're told the attachments can't be included.
- **Vacation reply** (Mail → Vacation reply): an automatic answer with an optional first and last day. It's built on the mail server's standard Sieve "vacation" feature:
  - Each sender gets at most one reply per day.
  - Mailing lists, newsletters, spam and other automatic messages never get one.
  - It also answers mail sent to aliases the user belongs to.
  - Dates use the mail container's `TZ` time zone.
  - The Mail screen shows a banner, with a Turn off button, while it's on.
- **Phones and Outlook:**

  | | Server | Port | Security |
  |---|---|---|---|
  | **Incoming (IMAP)** | your mail hostname | 993 | SSL/TLS |
  | **Outgoing (SMTP)** | your mail hostname | 465 | SSL/TLS (or 587 with STARTTLS) |

  Users sign in with their email address and Workspace password.
- **Accounts that predate email** get a working mailbox password the next time the user signs in to Workspace. Webmail works right away.

**Not built yet:** cropping or rotating pictures, and carrying pictures embedded in the original into a normal forward (use **Forward as attachment** to keep everything).

## Sign-in protection

Once ports 465, 587 and 993 are open, bots will start guessing passwords within hours. The same protection guards the Workspace sign-in page and the mail apps:

- **Blocking:** an internet address that fails **10 sign-ins with different accounts or passwords within 15 minutes** is blocked for **1 hour**. If it does it again within 24 hours, it's blocked for **24 hours**. A blocked address is refused even with the right password, on the web, IMAP and SMTP alike.
- **Same wrong password counts once.** A phone that keeps retrying an old password doesn't get your office blocked.
- **Attacks on one account:** an account attacked from many addresses is **slowed down**, never locked, so attackers can't lock your users out.
- **Never blocked:** this server's own addresses, which includes webmail, and anything you put on the allowlist.
- **Private (LAN) addresses** are slowed down after repeated failures but never blocked.
- **Admin → Security** (platform owner) shows blocked addresses with an **Unblock** button, recent failed sign-ins, and the allowlist. Add your office's fixed IP there.

**How it works:** Dovecot asks the app before and after every IMAP and SMTP sign-in (its "auth policy" feature) on an internal port (8081) that isn't published, using a shared secret. Postfix checks SMTP passwords through Dovecot, so both are covered. If the app is down, mail sign-ins carry on unprotected rather than locking everyone out.

**One thing to check after going live:** the protection needs to see real internet addresses. With normal Docker port publishing, which Container Manager uses, it does. If Admin → Security shows a warning that every failure comes from a private address, your network setup is hiding the real addresses.

## Backups

Back up `docker/workspace/data` and `docker/workspace/mailboxes`. (`mail-config` is regenerated by the app at every start.)

`docker/workspace/data` contains:

- `files/`: uploaded files
- `workspace.db`: companies, users, docs, sheets, calendar, contacts and chat
- `backups/`: a consistent database snapshot written daily (the last 7 are kept). It includes each domain's DKIM key and the webmail secret.

Point **Hyper Backup** at both folders, ideally to an off-site target. To restore, stop the project, copy the files back (replace `workspace.db` with a snapshot from `backups/` if needed) and start it again.

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
| `MAIL_CONFIG_DIR` | unset (mail off) | Folder shared with the mail container; setting it turns email on |
| `MAIL_HOSTNAME` | unset | Public name of the mail server (MX target, certificate name) |
| `MAIL_IMAP_HOST` | `mail` | Where the app reaches the mail container (IMAP 993, SMTP 465) |
| `AUTH_MAX_FAILURES` / `AUTH_WINDOW_MIN` / `AUTH_BAN_MIN` | `10` / `15` / `60` | Sign-in protection: failures allowed per address, time window, first block length |
| `AUTH_ACCOUNT_FAILURES` | `20` | Failures on one account (from any address) before its sign-ins are slowed down |
| `AUTH_ALLOWLIST` | empty | Extra never-block addresses or ranges, comma-separated (also editable in Admin → Security) |
| `AUTH_SOFT_NETS` | private ranges | Ranges that are only slowed down, never blocked; set it empty to make LAN addresses blockable too |
| `AUTH_POLICY_PORT` / `AUTH_POLICY_URL` | `8081` / `http://workspace:8081/` | Internal sign-in policy service, and how the mail container reaches it |
| `MAIL_DNS_SERVERS` | system | Comma-separated DNS servers for the "Check DNS" button, e.g. `1.1.1.1,8.8.8.8` |

## Development

```bash
cd server && npm install && npm run dev        # API on :8080 (data in server/data)
cd web && npm install && npm run dev           # UI on :5173, proxies /api and /ws to :8080
cd server && npm test                          # API tests
cd web && npm test                             # formula engine tests
```

The mail integration test runs the app against a real Postfix, Dovecot and Rspamd. On Ubuntu 24.04, install `postfix dovecot-imapd dovecot-lmtpd dovecot-sieve rspamd`, apply the build steps from `mail/Dockerfile`, start `mail/entrypoint.sh` as root, then run:

```bash
cd server && MAIL_IT_CONFIG_DIR=/etc/nw npm run test:mail
```

## Roadmap

- **Mail, next steps:** cropping pictures, and following the built-in Archive folder pushed live instead of checked every 30 seconds.
- **Real-time co-editing:** live cursors and character-level merging (Yjs) in Docs and Sheets.
- **Phone sync:** CalDAV and CardDAV, so calendars and contacts sync with the phone's built-in apps; WebDAV for Drive.
- **Renaming a user's address** (moving them to another domain of the same company), **two-factor authentication**, file version history, public share links, Slides, cell formatting in Sheets, and week and day calendar views.
