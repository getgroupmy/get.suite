# NAS Workspace

A self-hosted, Google Workspace-style office suite built to run on a Synology DS224+ (or any Docker host). One server hosts **several separate companies**, each with its own domains, users and admins.

| App | What it does |
|---|---|
| **Drive** | Folders, uploads up to 4 GB each (drag and drop), previews (images, PDF, video, audio, text), rename, move, trash and restore, search, sharing with people as viewer or editor (folder shares apply to everything inside), share links for people without an account, version history, and access as a network drive (WebDAV) from Mac, Windows and other apps |
| **Docs** | Rich-text documents (headings, lists, links, quotes, code, alignment), edited together live with everyone's cursors shown, print/PDF and HTML export |
| **Sheets** | Spreadsheets with formulas (`SUM AVERAGE MIN MAX MEDIAN COUNT COUNTA COUNTIF SUMIF IF IFERROR AND OR NOT ROUND ABS SQRT POWER MOD INT CONCAT LEN UPPER LOWER TRIM LEFT RIGHT TODAY NOW`), cell formatting (bold, italic, underline, text and fill colour, alignment, number, currency and percent formats), live co-editing with everyone's selected cell shown, multiple sheets, copy/paste with reference shifting, and CSV import/export |
| **Slides** | Presentations: slide layouts, text boxes, pictures and shapes you drag and resize, text size, bold, italic and colour, four themes, live co-editing, full-screen presenting, and printing or saving as PDF |
| **Calendar** | Month, week and day views (timed events placed by the hour, side by side when they overlap, with a current-time line), all-day and timed events, repeating events, inviting colleagues and people outside by email (Yes / Maybe / No), colours, upcoming list |
| **Contacts** | Personal address book, plus a directory of everyone on the NAS |
| **Chat** | Channels and direct messages, delivered live over WebSockets, with an emoji picker |
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
- **Changing someone's address:** Admin → Users → ⋮ → **Change email address**, to another name or another of the company's domains (for example after a marriage or a rebrand). Their mailbox, files, calendar and chats stay as they are. Aliases they're in follow the new address, and the old address can stay as an alias, so mail sent to it still arrives and they can still send as it. They sign in with the new address from then on, also in mail apps (update the account there).
- **Reused addresses start empty:** when someone is deleted or renamed, their mailbox stays on the server under its old folder, and a new person who later gets that address gets a fresh, empty mailbox. (This applies to deletions from this version on.)
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

## Editing documents together

Everyone who can edit a document, spreadsheet or presentation can work in it at the same time, like in Google Docs, Sheets and Slides.

- **Live:** what others type shows up as they type, and simultaneous changes merge character by character (Yjs), so nobody's work is overwritten. Each person's cursor shows in their colour, with their name, and the people who have the document open are shown at the top.
- **Saving:** there's no Save button and no "someone else changed this" conflict. The server saves a couple of seconds after each change, and when the last person closes the document.
- **Undo** (Ctrl+Z, or the ↶ button; redo with Ctrl+Y or Ctrl+Shift+Z) takes back only your own changes, not your colleagues', in documents, spreadsheets and presentations alike.
- **Offline:** keep typing. Your changes are kept in the browser and merged in when the connection is back, even after the server restarts.
- **Viewers** see changes live but can't type.
- **Version history** keeps a version each time a different person starts editing, or after a 10-minute pause. Restoring a version reloads it for everyone who has the document open.
- **Sheets** works the same way, cell by cell: two people changing different cells at once both keep their change, and the same cell keeps the later change. Each person's selected cell is outlined in their colour. Formats, column widths and new sheets are shared too.
- **Slides** too: slides and the boxes on them merge one by one, so two people working on different boxes (or slides) both keep their changes; the same box keeps the later change. Each person's selected box is outlined in their colour.

## Comments and @mentions (Docs, Sheets)

- **Comment:** in Docs, select some text and press **Comment** in the toolbar (or Ctrl+Alt+M); in Sheets, select a cell and do the same. The text is highlighted (cells get a small orange corner) and the comment opens in a panel on the right. The highlight moves with the text as people edit.
- **@mention:** type `@` and a few letters of a colleague's name to pick them from a list. They get a chat message with the comment and a link that opens the document at that comment. If the file isn't shared with them, you're told, so you can share it first.
- **Replies, resolve:** anyone who can edit the file can reply, and resolve a thread when it's done (a new reply reopens it). Tick **Show resolved** to see them again. Comments update live for everyone with the file open.
- **Who can do what:** viewers read comments; editors add, reply and resolve; a comment can be deleted by its author or by the file's owner (deleting the first comment removes the thread).

## Rows, columns and sorting (Sheets)

- **Select** a whole row or column by clicking its number or letter; Shift-click to select several.
- **Insert or delete:** right-click a row number, a column letter or a cell (or press Shift+F10 or the menu key) and choose *Insert 1 row above*, *Delete column B*, and so on. With several rows or columns selected, that many are inserted or deleted.
- **Everything follows:** formulas point to the same cells after they move, and ranges grow or shrink (`=SUM(B2:B10)` becomes `=SUM(B2:B11)` with a row inserted inside it). A formula that used a deleted cell shows `#REF!`. Formats, column widths, charts and comments move with their cells; a comment whose cell is deleted is marked *(deleted)*.
- **Sort:** right-click a cell and choose *Sort A → Z* or *Z → A* to sort the table around it by that column, or press **Sort** for a range, column and order of your choice. A heading row is spotted and kept at the top. Numbers come before text, and empty cells go last. Formulas move with their row.

## Charts (Sheets)

- **Insert:** select cells (or just click one inside your table) and press **Chart**. The first row and column are used as names when they hold text. Choose **Column**, **Bar**, **Line** or **Pie**, give it a title, and check the preview.
- **On the sheet:** drag a chart by its title to move it, and drag its bottom-right corner to resize it. Double-click it (or use its ⋮ menu) to change it; the menu also deletes it.
- **Reading it:** hover to see the exact numbers, and use **Show data** for the table behind the chart. Charts follow the cells, so they change as the numbers do.
- **Together:** charts are shared live like the cells; viewers see them but can't change them. A pie shows the first series and puts its smallest slices together as "Other" past six. Up to eight series are drawn.
- Charts aren't included when you download the spreadsheet as Excel (.xlsx); the numbers are.

## Slides

In Drive, **New → Presentation**. Presentations are shared, versioned and saved automatically like documents.

- **Slides:** **+ Slide** adds one after the current slide with a layout (title and text, title slide, section header, two columns, blank). Each slide's ⋮ menu duplicates, moves or deletes it.
- **On a slide:** add a **Text box**, a **Picture** (from your computer; it's saved in Drive next to the presentation) or a **Shape**.
  - Drag to move, and drag the handles to resize. Pictures keep their shape; hold Shift to stretch them.
  - Double-click text to type. Arrow keys nudge the selected item (Shift for bigger steps), and Delete removes it.
  - The toolbar sets text size, bold, italic, colour and alignment, shape colour, the slide's background, and front/back order. The ⋮ menu picks one of four themes.
- **Present** opens full screen. The arrow keys, space or a click move between slides, and Esc ends.
- **Print or save as PDF** (⋮ menu) prints one slide per landscape page. Choose "Save as PDF" in the print dialog.
- People you share a presentation with see its pictures, even ones that aren't shared with them separately. Viewers can present but not edit.

## Calendar and contacts on your phone

Your Workspace calendar and contacts sync with the phone's own Calendar and Contacts apps, both ways, using the standard CalDAV and CardDAV. Settings → *Calendar and contacts on your phone* shows the details for each person.

- **iPhone and iPad:** Settings → Calendar → Accounts → Add Account → Other → **Add CalDAV Account**. Enter the server (`workspace.example.com`), your email address and password. For contacts, do the same under Contacts → **Add CardDAV Account**.
- **Android:** install the free **DAVx⁵** app → *Login with URL and user name*, with `https://workspace.example.com/`. Calendars and contacts then appear in the phone's apps.
- **Thunderbird, macOS Calendar and Contacts** work the same way. The address `https://workspace.example.com/dav/` is the one to use if an app asks for the full address.
- **Password:** your account password. With two-step verification on, use a **mail-app password** instead (Settings), so a phone never gets around the second step. Wrong passwords count towards sign-in protection.
- **What syncs:**
  - Your events, including repeating ones (daily, weekly on chosen days, monthly on a date, yearly; an end date or a number of times; skipped dates). Changes on either side show up on the other.
  - Your contacts. Addresses, birthdays and extra numbers added on a phone are kept, even though the web only shows one email and one phone number.
  - **Invitations** from colleagues appear on your phone with the organiser and guests. Accept, Maybe or Decline there is your answer in Workspace, and deleting one declines it. You can't change someone else's event from the phone.
  - **One occurrence of a repeating event** changed on its own (on the phone, or with "This event" on the web) shows on both as part of the series. Cancelling one on the phone skips that date.
  - **Time zones** come across however the app names them: standard names (`Europe/Berlin`), Outlook's Windows names (`W. Europe Standard Time`), or a zone the app describes itself (Outlook's "Customized Time Zone"), so a 9:00 meeting stays at 9:00.
- **Not yet:**
  - Repeats that Workspace can't show (such as "second Monday of the month") arrive as a one-off on the first date.
  - Reminders set on the phone stay on the phone.
- **Synology reverse proxy:** nothing to add. The same HTTPS entry serves `/dav/` and the `/.well-known/caldav` and `/.well-known/carddav` addresses that apps look for.

## Word, Excel and PowerPoint files

- **Opening:** for a `.docx`, `.xlsx` or `.pptx` file in Drive, pick **Open as document / spreadsheet / presentation** (⋮ menu, or the button in its preview). Workspace makes an editable Docs, Sheets or Slides copy next to it, and the original stays as it is.
- **Downloading:** **Download as Word / Excel / PowerPoint** is in each editor's ⋮ menu.
- **What carries over:**
  - **Word:** headings, paragraphs, bold, italic, underline, strike, links, bulleted and numbered lists, quotes and code. Tables come in as rows of text, and pictures as a "[picture]" note, since Docs doesn't have tables or pictures yet. Paragraph alignment isn't read from Word files yet.
  - **Excel:** every sheet, values and formulas, bold, italic and underline, text and fill colour, alignment, number, currency and percent formats with their decimals, and column widths. Excel functions Sheets doesn't know show an error in Sheets, but are kept and written back as they were.
  - **PowerPoint:** every slide, text boxes at their places (size, bold, italic, colour, alignment), rectangles, rounded rectangles and ellipses, pictures (saved in a "… pictures" folder beside the presentation), and slide backgrounds. Animations, charts and SmartArt don't carry over.
- Files up to 50 MB can be converted.

## Drive as a network drive

Drive can also appear on a computer as an ordinary drive (WebDAV), so files open and save straight from Finder, File Explorer or any app's Open and Save dialogs. The address is `https://workspace.example.com/dav/files/`. Settings shows it for each person.

- **Mac:** Finder → Go → **Connect to Server…** → enter the address → sign in.
- **Windows:** File Explorer → This PC → **Map network drive** → *Connect to a website that you can use to store your documents and pictures*. Then enter the address.
- **Linux, phones and other apps:** any WebDAV client (for example the Files app with a WebDAV app, rclone or Cyberduck).
- **What you see:** *My Drive* at the top, plus a **Shared with me** folder. Documents, spreadsheets and presentations stay in the browser, so they aren't listed.
- **Sign-in:** the same as for calendar sync: your email address and password, or your mail-app password with two-step verification.
- **Safe by design:**
  - Saving over a file keeps the previous one in its version history.
  - Deleting moves to Drive's trash.
  - Viewers can only open files.
  - Quotas and the upload size limit apply.
  - A file that someone has open (locked) can't be overwritten or deleted by anyone else meanwhile.
  - Mac and Windows clutter (`.DS_Store`, `._…`, `Thumbs.db`) isn't stored.
- **Checked** with *litmus*, the standard WebDAV test suite: all 104 tests pass (basic operations, copy and move, properties, locks).
- **Windows note:** Windows connects to WebDAV only over HTTPS, which is how the Synology setup above serves it.

## Version history (Drive)

Drive keeps earlier versions of files, so a wrong edit or an overwritten upload can be undone.

- **Uploaded files:** in a file's ⋮ menu, **Upload new version** replaces its contents (and takes the new file's name). Links, shares and its place in Drive stay the same, and the previous contents are kept.
- **Documents and spreadsheets** keep a version from each editing session: when someone else starts editing, or after a 10-minute pause.
- **Version history** (in the ⋮ menu) lists the versions with when and who. You can download earlier uploads, and **Restore** any version. What's there now is kept as a version too, so you can switch back. Open editors load the restored content straight away.
- Viewers can see and download versions. Editors can also upload new versions and restore. Owners can delete versions they no longer need.
- The most recent 50 versions of each file are kept (`KEEP_VERSIONS` changes this). They count towards the company's storage quota, and are deleted with the file.

## Share links (Drive)

Send a file or a whole folder to someone who has no account, such as a client. In Drive, open **Share** on a file or folder; under **Link sharing**, pick how long the link lasts (1, 7 or 30 days, or no expiry), optionally add a password, and press **Create link**. The link is copied straight away and looks like `https://workspace.example.com/s/…`.

- **What they see:** a simple page with the name, who shared it and from which company, a preview (pictures, PDF, video, audio, text) and a **Download** button. A folder link lists what's inside; they can open sub-folders and view or download any file. Docs and Sheets inside a folder aren't included yet.
- **Password:** they type it once per browser tab. Wrong passwords count towards sign-in protection, so guessing gets the address blocked. Send the password separately, for example by phone.
- **Keeping track:** the Share dialog lists each link with its expiry, whether it has a password, and how often it was opened. **Remove** stops a link at once.
- **Links stop working by themselves** when they expire, when the file or folder goes to the trash (or is deleted), or when the owner's account is disabled. A file moved out of a shared folder is no longer reachable through that folder's link.
- **Company switch:** Admin → Company settings → *Links for people without an account*. Turning it off immediately stops every link in the company; turning it back on restores the ones that haven't expired.
- Only the owner of a file can create or remove its links. Link pages aren't indexed by search engines.

## Calendar

- **Views:** Month, Week and Day (the choice is remembered in each browser).
  - In week and day views, events sit at their times, overlapping ones side by side, with a red line for the current time.
  - Click an empty half hour to create an event there, or a date to open that day. The arrow keys move between periods.
- **Dragging with the mouse:** drag an event to another time or day (in 15-minute steps in week and day views; to another day in the month view and the all-day row), or drag its bottom edge to change when it ends. Esc cancels a drag. For a repeating event you choose "This event", "This and following events" or "All events"; a weekly series on set weekdays moves its weekdays along with it. Invitations from other people can't be dragged. On phones and tablets, open the event and change the times instead.
- **Repeating events:** in an event, choose **Repeat**: daily, weekly (pick the weekdays), monthly on the same date, or yearly; every 1, 2, 3… of those. It ends never, on a date, or after a number of times. A line such as "Every 2 weeks on Mon, Thu" confirms the choice.
  - Dates are worked out in the event's own time zone, so a 9:00 meeting stays at 9:00 when the clocks change, also for colleagues looking at it from another time zone.
  - A monthly event on the 31st skips months without a 31st, and a yearly event on 29 February appears only in leap years.
  - Changing or deleting one occurrence asks **This event / This and following events / All events**.
  - Repeating events show ↻.
- **Inviting colleagues:** add people under **Guests** (type an address; suggestions come from your company directory). You can invite anyone you can work with: your own company, and other companies when both allow collaboration.
  - Guests see the event in their calendar, outlined until they answer, and answer **Yes / Maybe / No**. For a repeating event, the answer covers the whole series.
  - When email is set up, they also get an invitation email from you (with the time in your time zone), an "Updated:" email when you change the time, place or details, and a cancellation if you delete the event or remove them.
  - You see each answer in the event, for example "3 guests: 2 yes, 1 not answered". Calendars that are open update straight away.
  - Only the organiser can change or delete the event. A guest who says No still sees it, faded.
- **Inviting people outside Workspace** (clients, suppliers): type their email address under **Guests**; they show as "by email". This needs email to be set up.
  - They get an invitation email with a calendar file, so Outlook, Gmail, Apple Mail and phones show it as an invitation they can add to their own calendar. Repeating events keep their time across clock changes.
  - The email has a personal link to a simple page (no account needed) where they answer **Yes / Maybe / No**, see the time in their own time zone, and can download the event again. Their answer shows in your calendar straight away.
  - If you change the time, place or details, they get an updated invitation that replaces the old one in their calendar. Removing them or deleting the event sends a cancellation, and their link stops working.
  - They can also answer with their own mail app's buttons (Outlook's *Accept*, Gmail's *Yes*). That reply arrives in your inbox as usual, and Workspace reads the answer from it within a couple of minutes. Only a reply from the guest's own address counts.
  - An address on one of this server's own domains must belong to someone here, so a typo can't email a stranger.

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
- **Rich-text writing:** bold, italic, underline, strike, bulleted and numbered lists, quotes, links and tables. Every message is sent with a formatted version and a readable plain-text version (quotes marked with `>`, lists with `-` / `1.`), so any mail app can show it. Replies quote the original as a quoted block. Quotes are built from the original's plain text, so formatting tricks in a received email can't carry into yours.
- **Alignment:** the alignment button's **Left / Centre / Right** align the paragraph the cursor is in (or every selected paragraph). Keyboard: Ctrl+Shift+L / E / R. Mail apps show the alignment as sent.
  - **Pictures:** click a picture, then use the same alignment button to put it on the left, in the centre or on the right. Drafts keep it, and the email is built so Outlook on Windows shows it the same way.
- **Toolbar:** one compact row in a normal window (it wraps on phones). From left to right:
  - **Undo / Redo** (also Ctrl+Z / Ctrl+Y). Each is greyed out when there's nothing to undo or redo.
  - Font and size, **B I U**, text and highlight colour.
  - An **alignment** button that shows the current alignment and opens Left / Centre / Right.
  - Lists, link, picture, **emoji** and table.
  - **⋮ More formatting**, which holds Strikethrough, Quote, Decrease / Increase indent and Clear formatting.
  - The menus work from the keyboard: Enter or ↓ opens, the arrow keys move, Enter picks, and Escape closes the menu (not the message). Choices that can be on or off show as checked.
  - Picture and table tools appear only while a picture or table is selected.
- **Emoji:** 🙂 opens the emoji picker (also in Chat, next to the message box). Type to search by name ("thumbs", "party", "thanks"), or browse the groups. The ones you use most recently come first, remembered in each browser. From the keyboard: type, then Enter picks the first match, or ↓ and the arrow keys move through them. Escape closes the picker, not the message.
- **Links:** 🔗 or **Ctrl+K** opens the link dialog: the text to show, and a web address or an email address.
  - "example.com" becomes `https://example.com`, and an email address becomes a link that starts a message.
  - Other kinds of address (such as `javascript:`) are refused.
  - **Test this link** opens the address in a new tab.
  - With the cursor in a link, the same button edits it, or **Remove link** takes the link off and keeps the text.
- **Indent:** **Increase / Decrease indent** in the ⋮ menu (or Ctrl+] / Ctrl+[) move the paragraph in 40 px steps, up to 8. In a list they nest or un-nest the item instead. Tab is left free for moving out of the message with the keyboard. The plain-text version indents with spaces.
- **Font:** the menu next to the size menu sets the font for the selected text, or for what you type next: Georgia, Times New Roman, Garamond, Courier New, Verdana, Tahoma, Trebuchet MS, Calibri or Comic Sans MS. **Sans Serif** is the normal font.
  - Each font is sent with fallbacks, for example Calibri, then Arial, so recipients without that font still see something close.
  - The menu shows the font where the cursor is, including fonts quoted from a reply or forward. **Sans Serif** and **Clear formatting** remove it.
- **Font size:** the menu at the start of the toolbar sets **Small, Normal, Large or Huge** (12 / default / 18 / 24 px) for the selected text, or for what you type next. It shows the size where the cursor is. **Normal** and **Clear formatting** remove it. Sizes are sent as part of the text, so common mail apps show them.
- **Text colour:** the **A** button (its bar shows the colour at the cursor) colours the selected text, or what you type next.
  - Choose from 10 colours that read well on white and in mail apps' dark modes. **Automatic** goes back to the normal text colour.
  - Keyboard: Enter opens the palette, the arrow keys move, Enter picks, and Escape closes it without closing the message.
- **Custom colours:** both palettes end with a custom choice. Use the colour well to open your system's colour chooser, or type a code such as `#0b8043`, then **Apply** (or press Enter).
  - A sample shows the result. You're warned, but not stopped, if a text colour would be hard to read on white or a highlight is too dark for the text on it.
  - Your last six custom colours appear in the palette, remembered in that browser.
- **Highlight colour:** the 🖍 button next to it highlights the selected text, like a highlighter pen.
  - Choose from 7 light colours (yellow, green, blue, pink, orange, purple, grey), so the text on them stays readable. **None** removes the highlight.
  - Highlights are sent as a background colour on the text, which Gmail, Outlook and phone mail apps all show. In dark mode the editor keeps dark text on the highlight.
  - Same keyboard use as the text colour button.
- **Tables:** the ▦ button inserts a table. Pick the size from the grid (up to 8 × 8) by hovering and clicking, or with the arrow keys and Enter. **Header row** (on by default) makes the first row bold.
  - Type in a cell, and use Tab / Shift+Tab to move between cells.
  - Inside a table, the toolbar offers **+ Row / − Row / + Column / − Column / Delete table**. Tables can't be put inside other tables.
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
  - **Crop and rotate:** double-click a picture, or click it and choose **✂ Crop / rotate** in the toolbar.
    - **Rotate left / Rotate right** turn it in 90° steps.
    - Drag the crop frame to move it, or its corners and edges to resize it. Choose **Free, Square, 4:3 or 16:9** for the shape; **Reset crop** starts over.
    - Keyboard: Tab to the frame, then use the arrow keys to move it and Shift with the arrow keys to resize it.
    - The new size in pixels shows as you go. **Apply** saves the result to your Drive as "name (edited)" and swaps it into the message at the same size. The original file is left untouched, and Ctrl+Z puts it back.
    - JPEG and WebP photos come out as JPEG, everything else as PNG. An animated GIF becomes a still picture.
    - Only pictures you inserted yourself can be edited, not ones quoted from another email.
  - Pictures are saved to your Drive.
  - When the message is sent they're embedded in the email itself, so recipients see them without access to your server and without "show images" prompts.
  - The plain-text version shows `[image: name]` in their place.
  - Pictures count towards the 25 MB message limit.
  - Replies and forwards carry the original's pictures too (see below).
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
    - **The Archive can be followed too** (its ⋮ menu has just this option), which suits filters that file receipts or newsletters straight into it. Sent, Drafts, Junk and Trash can't be followed.
  - Only newly delivered mail triggers an alert. Mail you move yourself (archiving unread mail, "Not spam", a phone tidying folders) keeps its original arrival time, so it counts towards the unread badge but doesn't alert. A message is announced once, even if it lands in the Inbox and is then archived straight away.
- **Forward as attachment:** sends the original email whole, as an `.eml` file with its formatting, pictures, attachments and technical headers (including DKIM) intact. Use it to report a suspicious message to IT, or to pass one on exactly as received.
- **Pictures, tables and colours in replies and forwards:** **Reply**, **Reply all** and a normal **Forward** keep the original's basic formatting (paragraphs, bold, italic, lists, quotes, links), its text colours and highlights, its fonts and font sizes, its alignment and indents, its tables, and the pictures embedded in it, in place. In a reply they sit inside the quote.
  - The server cleans the original first. Scripts, styles, forms and pictures loaded from the internet (including tracking pixels) are left out, so nothing in a forwarded email can run or report back to its sender.
  - While you write, the pictures are shown straight from the original message, so they don't take up space in your Drive. When you send, they're embedded in your email like pictures you insert yourself.
  - You can resize, crop or rotate them like your own pictures. A cropped or rotated picture is saved to your Drive.
  - **Text colours** are kept, such as red for "late" or green for "on track", including colour set on a whole paragraph, list or table cell.
    - Text too light to read on a white page (for example white text from a dark newsletter) is shown in the normal colour instead. Near-black counts as normal text.
    - Only plain colour values are accepted; anything else in the original's styles is dropped.
    - **Highlights** in the original (a light background on words, or `<mark>`) are kept too. Backgrounds on whole paragraphs, table cells or the page (newsletter styling) and dark backgrounds are left out.
    - **Clear formatting** (in the ⋮ menu) removes colours and highlights from the selected text.
  - **Indents** are kept, in the same 40 px steps, for example Outlook's half-inch indents. Gmail's indents (a borderless quote) arrive as indents, not as an extra quote.
  - **Alignment** is kept: centred and right-aligned paragraphs, headings and table cells, and centred pictures, stay where they were. Justified text becomes normal left-aligned text. The Left / Centre / Right buttons show and change it.
  - **Fonts and font sizes** are kept too:
    - Sizes are matched to the size menu's **Small / Normal / Large / Huge**, whatever unit the original used, so a newsletter's tiny print or giant banner stays readable. Headings become Large or Huge.
    - Common mail fonts (Georgia, Times New Roman, Courier New, Verdana, Calibri and others) are kept. The usual sans-serif fonts (Arial, Helvetica, system fonts) count as the normal font. Fonts the recipient may not have fall back to the next common font the original listed.
    - **Clear formatting** removes them as well.
    - In dark mode the editor shows coloured text lighter so it stays readable. The email is sent with the original colours.
  - **Tables:** data tables (an order, an invoice, a schedule) are kept with their header row and merged cells.
    - Newsletters often use tables only to lay out the page. Those are recognised (tables inside tables, single-column tables, or ones marked as layout) and turned into ordinary paragraphs, so a quote doesn't become a grid of boxes.
    - Click inside a table to get **+ Row / − Row / + Column / − Column / Delete table** in the toolbar, to trim what you pass on. Tables you paste into a message work the same way.
    - Sent tables have simple borders that show the same in Gmail, Outlook and phone mail apps. The plain-text version shows each row as `cell | cell`.
  - Plain-text emails are quoted as text, as before.
  - Pictures count towards the 25 MB limit. When replying to a picture-heavy newsletter, delete the quoted pictures you don't need.
  - If the original is deleted before you send, you're told its pictures can't be included.
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

**Not built yet:** keeping the original's exact look (block and page backgrounds, page layout, sizes other than the four in the menu) in a normal forward (use **Forward as attachment** to keep everything).

## Two-step verification

Everyone can add a second step to signing in on the web: after the password, a 6-digit code from an authenticator app on their phone (Google Authenticator, Microsoft Authenticator, 1Password, …). Someone who learns a password then still can't get in.

- **Turning it on:** Settings → Two-step verification → **Turn on**. Confirm your password, scan the QR code (or type the key), and enter the code the app shows.
  - You then get **10 recovery codes**. Each signs you in once without your phone. Save them (Copy / Download), because they're shown only once.
  - Other devices that were signed in are signed out.
- **Signing in:** after the password, enter the code (or **Use a recovery code**). Each code works once, and a phone clock up to 30 seconds off is fine.
  - A sign-in allows 5 wrong codes. Wrong codes also count towards sign-in protection below, so guessing gets the sender blocked.
- **Recovery codes running low?** Settings shows how many are left and warns at 3. **New recovery codes** replaces them all.
- **Lost phone:** sign in with a recovery code. Without one, ask an admin: Admin → Users → ⋮ → **Reset two-step verification**. That signs the person out everywhere so they can sign in with their password and set it up again. The user list shows who has **2-step** on.
- **Turning it off** needs your password and a current code (or a recovery code).
- **Requiring it for a company:** Admin → Company settings → **Require two-step verification for everyone in this company**.
  - You need it on your own account first, so the setting can't lock you out.
  - Anyone without it can still sign in with their password, but sees only a setup page until they've set it up. The server refuses everything else for them, including live updates.
  - While it's required, nobody in the company can turn their own off. An admin reset (lost phone) still works; that person then sets it up again at their next sign-in.
  - The settings page shows how many people still have to set it up.
- **Mail apps:** phones and Outlook reading mail over IMAP/SMTP can't ask for a code. Give them a **mail-app password** (below), so your account password alone can't open your mail from a mail app.
- The keys are stored in the database, so they're included in its backups. Protect the backups like the server itself.

## Signed-in devices

Settings → **Signed-in devices** lists every browser where you're signed in: what it is ("Chrome on Windows", "Safari on iPhone"), when it was last active, its network address, and when it signed in. The one you're using is marked **This device**.

- **Sign out** ends one device's session; it's signed out at its next click.
- **Sign out all other devices** ends every session except this one.
- If you don't recognise a device, sign it out and change your password. Changing your password, or turning on two-step verification, also signs out all other devices.
- Mail apps aren't listed (they don't keep a web session). Use a mail-app password to control those.
- Sessions from before this version show as "Browser" without details until they next sign in.

## Mail apps (phones, Outlook)

Settings → **Mail apps** shows what to enter in a phone or Outlook: the server name, ports (IMAP 993, SMTP 465 or 587) and user name (your email address).

- **Mail-app password (optional):** **Create mail-app password** gives mail apps their own password, for example `wisn-fyun-ngpb-btim`.
  - It's shown once. Type it exactly, dashes included, or use Copy.
  - From then on mail apps accept only it; your account password stops working in them, within a few seconds. Webmail is unaffected.
  - Someone who learns your account password then can't read your mail from a mail app. A lost phone never had your account password: make a new mail-app password (the old one stops working) or **Remove** it to go back to the account password.
  - Recommended together with two-step verification.
- When an admin resets someone's password (for example after a break-in), their mail-app password is removed too, so only the new password works anywhere.

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
| `KEEP_VERSIONS` | 50 | Earlier versions kept per file in Drive |
| `SECURE_COOKIES` | auto | Force `true` or `false`; auto means Secure when the request is HTTPS |
| `PUBLIC_URL` | the address the browser used | The web address people outside use (e.g. `https://workspace.example.com`), for links in invitation emails |
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

Everything planned so far is built.
