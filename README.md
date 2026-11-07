# NAS Workspace

A self-hosted, Google Workspace-style office suite built to run on a Synology DS224+ (or any Docker host). One server hosts **several separate companies**, each with its own domains, users and admins.

| App | What it does |
|---|---|
| **Drive** | Folders, uploads up to 4 GB each (drag and drop), whole folders too (**New → Upload folder**, or drop a folder from your computer: its folders and files arrive as they were, into folders of the same name if they are already there), previews (images, PDF, video, audio, text), rename, move, trash and restore (the trash empties itself after 30 days, or as long as the company chooses), search, sharing with people as viewer or editor (folder shares apply to everything inside), share links for people without an account, version history, templates (**New → From a template…**: ready-made meeting notes, letter, project brief, monthly budget, task tracker and project update; admins can make any document, spreadsheet or presentation a **company template** from its ⋮ menu, for everyone in the company to start from), and access as a network drive (WebDAV) from Mac, Windows and other apps |
| **Docs** | Rich-text documents (headings, lists, checklists with tick boxes, page breaks (Ctrl+Enter; a new page when printed, saved as PDF or downloaded for Word), footnotes (**¹ Footnote** puts a number in the text and the cursor in its note at the end of the document; numbers follow the order in the text, clicking one goes to its note, and they are real footnotes in Word files both ways, numbered links in HTML and a list of notes when printed), links, quotes, code, alignment, text colour and highlight, tables, pictures, and a table of contents that lists the headings as links and keeps itself up to date — kept as links in HTML and Word downloads), edited together live with everyone's cursors shown, print/PDF, HTML and Markdown export (⋮ → **Download as Markdown (.md)**: headings, bold/italic/strikethrough, links, lists, task lists, quotes, code, tables and footnotes; a .md file in Drive opens as a document the same way) |
| **Sheets** | Spreadsheets with formulas (lookups `XLOOKUP VLOOKUP HLOOKUP INDEX MATCH`; conditions `IF IFS SWITCH IFERROR IFNA COUNTIF(S) SUMIF(S) AVERAGEIF(S) MAXIFS MINIFS`, with `*` and `?` wildcards; `SUM AVERAGE MIN MAX MEDIAN COUNT COUNTA COUNTBLANK PRODUCT SUMPRODUCT LARGE SMALL RANK STDEV(.S/.P) VAR(.S/.P) ROUND ROUNDUP ROUNDDOWN CEILING FLOOR ABS SIGN SQRT POWER MOD INT TRUNC LOG LN EXP ISODD ISEVEN RAND RANDBETWEEN PI`; loans `PMT PV FV`; text `CONCAT TEXTJOIN LEN UPPER LOWER PROPER TRIM LEFT RIGHT MID FIND SEARCH SUBSTITUTE REPT EXACT VALUE TEXT CHAR CODE`; dates `TODAY NOW DATE YEAR MONTH DAY WEEKDAY DAYS DATEDIF EDATE EOMONTH NETWORKDAYS WORKDAY`; `AND OR NOT ISBLANK ISNUMBER ISTEXT ISERROR NA`); while you type a formula, matching function names are suggested (arrow keys, then Tab or Enter) and, inside a function's brackets, what it takes is shown with the current argument in bold, merged cells (⊞ joins the selected cells into one, keeping the top-left value; selections and arrow keys treat a merge as one cell; it moves with inserted or deleted rows and columns, sorting across it is refused, and it's kept in Excel files), find and replace (Ctrl+F / Ctrl+H: by what cells show, match case, whole cell, or inside formulas; formulas are only changed when you search them), charts, sorting, inserting and deleting rows and columns, undo, cell formatting (bold, italic, underline, strikethrough, text and fill colour, alignment, wrapped text, borders — all, outer, bottom or none — and number, currency, percent and date formats — dates as 7 Nov 2026, 07/11/2026, Saturday, 7 November 2026, 2026-11-07 or Nov 2026 — all kept in Excel files, where dates are real dates), live co-editing with everyone's selected cell shown, multiple sheets, copy/paste with reference shifting, and CSV import/export |
| **Slides** | Presentations: slide layouts, text boxes, pictures, shapes, lines and arrows you drag and resize, tables (**Table**, then double-click to type in the cells; add or remove rows and columns, a coloured heading row, text size; kept in PowerPoint files both ways), text size, bold, italic and colour, four themes, live co-editing, full-screen presenting, and printing or saving as PDF |
| **Calendar** | Month, week, day and schedule views (the schedule lists four weeks of events, tasks and birthdays day by day; timed events placed by the hour, side by side when they overlap, with a current-time line), all-day and timed events, repeating events, inviting colleagues and people outside by email (Yes / Maybe / No), colours, upcoming list |
| **Contacts** | Personal address book (import and export vCard and CSV, synced with phones), plus a directory of everyone on the NAS; addresses suggested while writing mail |
| **Chat** | Channels and direct messages, delivered live over WebSockets: unread counts, reactions, editing your messages, pictures and files, and an emoji picker |
| **Forms** | Questionnaires, sign-up sheets and polls: seven question types, a link for your company (signed in, names recorded) or for anyone, a live summary of the answers, CSV download and a copy in Sheets |
| **Notes** | Quick notes and checklists on coloured cards: pin, label, archive, search, and share with colleagues to keep one together |
| **Meet** | Video meetings in the browser for up to 8 people: a link and a code to join by, camera and microphone check before joining, screen sharing, raised hands, reactions and a meeting chat |
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
- **Adding many people at once:** Admin → Users → **Import from CSV** takes a spreadsheet saved as CSV, one person per row, with columns **Name** (or First name and Last name) and **Email** (a full address, or just the part before @ on the domain you choose), plus optional **Password** and **Admin** (yes). **Check** shows each row as OK or what is wrong (a taken address, another company's domain, a short password, a repeat). **Create** then adds the good rows. People without a password get an easy-to-type one, shown once with a **Download sign-in details** button so you can pass them on. Up to 500 at a time. Each one is recorded in the activity log.
- **Last active:** Admin → Users shows when each person last used their account (signing in, using Workspace, or a phone or Outlook syncing their calendar and contacts), kept after they sign out. **Only people inactive for 90 days or more** narrows the list to accounts that may no longer be needed (never used ones too; disabled ones are left out).
- **The list of people:** Admin → Users → **Export as CSV** downloads everyone in the company with their address, whether they're an administrator, active or disabled, two-step verification, Drive storage used, when the account was made and when it was last used. It opens in Excel or Sheets; names that look like formulas stay plain text. Exports show in the activity log.
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
  - In Docs, Sheets and Slides, **⋮ → Version history** lists them beside a preview of the one you pick (the document as written, the spreadsheet's values, or the slides), with **Restore this version**. What was there before a restore is kept as a version too.
  - For documents, **Show changes since then** marks what has changed from that version to now, paragraph by paragraph: added words in green, removed words struck through, edited paragraphs flagged at the side, and a count of words added and taken out.
  - **Name current version** (or name any earlier one, such as "Sent to the client") marks it in the list; named versions are kept for good, however many come after.
- **Sheets** works the same way, cell by cell: two people changing different cells at once both keep their change, and the same cell keeps the later change. Each person's selected cell is outlined in their colour. Formats, column widths and new sheets are shared too.
- **Slides** too: slides and the boxes on them merge one by one, so two people working on different boxes (or slides) both keep their changes; the same box keeps the later change. Each person's selected box is outlined in their colour.

## Suggesting (Docs)

Switch **✎ Editing** to **💡 Suggesting** at the top of a document to propose changes instead of making them, like track changes in Word:

- What you type shows **green and underlined**; what you delete stays in the text, **red and struck through**. Typing over a selection suggests a replacement. Hovering shows who suggested it. Everyone with the document open sees suggestions as they're made.
- **💡 (number)** at the top lists the suggestions in order, with who made each and when ("Replace “March” with “April”", "Add …", "Delete …"). Click one to go to it. Anyone who can edit can **Accept** (the change goes in) or **Reject** (it's undone) each one, or **Accept all** / **Reject all**.
- Deleting your own suggested text simply removes it. Backspace at the start of a paragraph still joins paragraphs, and formatting, new paragraphs, pictures and tables go in directly: only text is tracked.
- Until a suggestion is accepted it isn't part of the document: downloads (Word, Markdown, HTML) and printing show the text without pending suggestions.

## Tables and pictures (Docs)

- **Tables:** **Table** → *Insert table*, then Tab to move from cell to cell. The same menu adds and deletes rows and columns, turns the heading row on or off, and deletes the table.
- **Pictures:** **Picture** to choose one, or paste or drop it into the document. It's saved in Drive next to the document (or in your Drive), and everyone who can open the document sees it, even without access to the picture file itself. Click a picture to make it smaller (a quarter, half or three quarters of the page width) or put it in the centre or on the right.
- **Fonts and spacing:** the toolbar's font, size and spacing menus set the font (Arial, Georgia, Times New Roman, Verdana, Trebuchet MS, Courier New) and size of the selected text, and the line spacing (single, 1.15, 1.5, double) of the paragraphs the cursor is in. **Default** takes them off again. They're kept in the Word download.
- **Colour:** the **A** and highlight buttons colour the selected text or mark it with a highlight.

- **@mentions:** type **@** and a few letters of a colleague's name, then Enter (or click) to put them in as a chip. They get a notification linking to the document (once in a while, not for every mention). If they can't open it, a note says so; if it's yours, **Share with them** lets them edit it and tells them. Mentions read as @Name in Word, Markdown and search.
- **Links to Drive files:** **📄** in the toolbar puts in a link to a document, spreadsheet, presentation, file or folder from Drive, named after it (or links the selected text). If anyone who can open this document can't open what you linked, a note says who; if it's yours, **Share with them** lets them view it.
## Find and replace, word count, outline (Docs)

- **Ctrl+F** finds text in the document: every match is highlighted, and Enter (Shift+Enter) goes to the next (previous) one. *Match case* and *Whole words* narrow it down. **Ctrl+H** (or *Replace…*) replaces the current match or all of them; replaced text keeps its formatting, and each replace is one step for Undo. Only the person searching sees the highlights; replacements reach everyone as they're made. Viewers can find but not replace.
- **Word count** (⋮ menu) gives the words and characters in the document.
- **Page setup** (⋮ menu): paper size (A4, Letter, Legal, A5), portrait or landscape, margins, a header and a footer, and page numbers. The paper on screen takes the size; printing (or saving as PDF) and the Word download use all of it. Everyone editing the document sees the same setup. Printing is always on white paper, whichever theme you use.
- **Outline:** the list button next to Comments opens the document's headings down the left, indented by level. Click one to go there; the heading you're in is marked, and headings anyone adds show up as they type. It stays open on that computer until you close it.

## Comments and @mentions (Docs, Sheets, Slides)

- **Comment:** in Docs, select some text and press **Comment** in the toolbar (or Ctrl+Alt+M); in Sheets, select a cell and do the same. The text is highlighted (cells get a small orange corner) and the comment opens in a panel on the right. The highlight moves with the text as people edit.
- **@mention:** type `@` and a few letters of a colleague's name to pick them from a list. They get a chat message with the comment and a link that opens the document at that comment. If the file isn't shared with them, you're told, so you can share it first.
- **Replies, resolve:** anyone who can edit the file can reply, and resolve a thread when it's done (a new reply reopens it). Tick **Show resolved** to see them again. Comments update live for everyone with the file open.
- **Who can do what:** viewers read comments; editors add, reply and resolve; a comment can be deleted by its author or by the file's owner (deleting the first comment removes the thread).

- **In Slides:** **Comment on this slide** comments on the slide you're on (a 💬 shows on its thumbnail). The comment stays with its slide when slides are moved, and clicking where a comment is takes you to its slide. **💬 Comments** opens the list, with replies, resolving and @mentions as in Docs and Sheets.
## Printing (Sheets)

- **Print or save as PDF** (⋮ menu) prints the sheet, or just the selected cells (chosen for you when several are selected), on A4 or Letter, portrait or landscape, with or without gridlines. Values print as they're shown (formatted numbers, dates and formula results), with bold, colours, fills, alignment, borders, merged cells and column widths. Hidden and filtered-out rows and columns are left out. Choose "Save as PDF" in the print dialog for a PDF.

## Rows, columns and sorting (Sheets)

- **Select** a whole row or column by clicking its number or letter; Shift-click to select several.
- **Insert or delete:** right-click a row number, a column letter or a cell (or press Shift+F10 or the menu key) and choose *Insert 1 row above*, *Delete column B*, and so on. With several rows or columns selected, that many are inserted or deleted.
- **Everything follows:** formulas point to the same cells after they move, and ranges grow or shrink (`=SUM(B2:B10)` becomes `=SUM(B2:B11)` with a row inserted inside it). A formula that used a deleted cell shows `#REF!`. Formats, column widths, charts and comments move with their cells; a comment whose cell is deleted is marked *(deleted)*.
- **Sort:** right-click a cell and choose *Sort A → Z* or *Z → A* to sort the table around it by that column, or press **Sort** for a range, column and order of your choice. A heading row is spotted and kept at the top. Numbers come before text, and empty cells go last. Formulas move with their row.

## Column widths and frozen rows (Sheets)

- **Width:** drag the right edge of a column letter to make the column wider or narrower; double-click the edge (or right-click the letter → *Fit column to its contents*) to fit what's in it.
- **Freeze:** right-click a row number → *Freeze the first row* (or *Freeze rows 1–3* with three rows selected) to keep headings in view while scrolling; the same for columns from a column letter. *Unfreeze* puts them back. A darker line shows where the frozen part ends.
- **Hide rows and columns:** right-click a row number or column letter → *Hide row 3* (or *Hide columns B–D* with several selected). Formulas still use what is hidden; arrow keys step over it. A small button on the heading next to hidden ones shows them again, or select across them and choose *Unhide*. Hidden rows and columns move with inserts and deletes and are kept in Excel files.
- **Remove duplicates, split text:** right-click → **Remove duplicates…** removes rows that repeat an earlier row in the selection (or the table around the cell): rows that are the same in every column, ignoring capitals and spaces at the ends, comparing what cells show. The rest close up. **Split text to columns…** splits a column's text ("Kim Park", "Leeds, UK") into the columns to its right at a comma, semicolon, tab, space, bar or anything you type, or the one it finds. Both can be undone.
- Widths and frozen rows and columns are shared with everyone editing, kept per sheet, and carried to and from Excel.

## Filters (Sheets)

- **Filter** in the toolbar turns on a filter over the selected cells, or the table around the cursor; its first row holds the headings, which get a ▾ button.
- The ▾ menu lists the column's values (with how often each comes, and **(Blanks)** for empty cells): untick the ones to hide, or search a long list. Rows with a hidden value disappear for everyone; nothing is deleted, and the arrow keys skip them. The button turns blue on filtered columns. The same menu sorts the table by that column.
- Rows added below the table are filtered too, and a row whose value changes to a hidden one goes as it changes. **Filter** again removes it, showing every row.
- Downloading as Excel keeps it as an AutoFilter with those rows hidden; an Excel file's AutoFilter comes in as a filter.

## Dropdowns and tick boxes (Sheets)

- **Dropdown** in the toolbar turns the selected cells into a list of choices. It starts from the values already in those cells; add or change them one per line. The cells show an arrow: click it, or press **Alt+↓**, then pick with the mouse or the arrow keys and Enter.
- **Only allow these choices** refuses anything else typed into the cells (with a note saying what's allowed); typing a choice in the wrong case is corrected. Turn it off to suggest values without enforcing them.
- **Tick box** shows a box in each cell: click it or press Space. Ticked is TRUE, so formulas such as `=COUNTIF(C2:C20, TRUE)` count them.
- They move with inserted and deleted rows and columns, are shared live, and are kept when downloading as Excel (tick boxes become a TRUE/FALSE list there). Dropdowns in an uploaded Excel file, including lists taken from cells on the sheet, come in as dropdowns.

## Conditional formatting (Sheets)

- **Rules** in the toolbar colours cells by their value: greater or less than, between, equal or not equal to, text that contains, doesn't contain or starts with something, empty or not, or an error. Pick a colour (and bold) and the cells it applies to; the selection is filled in for you.
- A sheet can have several rules. They're tried from the top, and the first that fits a cell colours it; the arrows change the order.
- The colours follow the values as they change, for everyone editing. Rules move with their cells when rows or columns are inserted or deleted, and carry to and from Excel.

## Pivot tables (Sheets)

**⊞ Pivot** in the toolbar (or right-click → **Pivot table…**) summarises the table around the cursor on a new sheet, **Pivot table 1**:

- **Rows:** one for each value of a column (e.g. *Region*); **Columns** (optional): one for each value of another (e.g. *Product*); **Values:** the **sum**, **count**, **average**, **minimum** or **maximum** of a column, or a count of rows. Each row and column has a total, and there's a grand total. Blank values are grouped as *(blank)*; numbers sort before text.
- It **updates by itself** when the data changes, including rows added below the table, for everyone with the spreadsheet open. **Edit pivot table** at the top of its sheet changes what it shows.
- Its cells can't be typed in (they come from the data). Renaming the data sheet keeps it working. Excel downloads have its values.

## Charts (Sheets)

- **Insert:** select cells (or just click one inside your table) and press **Chart**. The first row and column are used as names when they hold text. Choose **Column**, **Bar**, **Line** or **Pie**, give it a title, and check the preview.
- **On the sheet:** drag a chart by its title to move it, and drag its bottom-right corner to resize it. Double-click it (or use its ⋮ menu) to change it; the menu also deletes it.
- **Reading it:** hover to see the exact numbers, and use **Show data** for the table behind the chart. Charts follow the cells, so they change as the numbers do.
- **Together:** charts are shared live like the cells; viewers see them but can't change them. A pie shows the first series and puts its smallest slices together as "Other" past six. Up to eight series are drawn.
- Charts aren't included when you download the spreadsheet as Excel (.xlsx); the numbers are.

## Slides

In Drive, **New → Presentation**. Presentations are shared, versioned and saved automatically like documents.

- **Slides:** **+ Slide** adds one after the current slide with a layout (title and text, title slide, section header, two columns, blank). Each slide's ⋮ menu duplicates, moves or deletes it.
- **On a slide:** add a **Text box**, a **Picture** (from your computer; it's saved in Drive next to the presentation) or a **Shape** (rectangle, rounded rectangle, ellipse, line or arrow; a line or arrow's **Direction** runs across, down, diagonally or backwards, and they're kept in PowerPoint files).
  - Drag to move, and drag the handles to resize. Pictures keep their shape; hold Shift to stretch them.
  - Double-click text to type. Arrow keys nudge the selected item (Shift for bigger steps), and Delete removes it.
  - The toolbar sets text size, bold, italic, colour and alignment, shape colour, the slide's background, and front/back order. The ⋮ menu picks one of four themes.
- **Transitions and skipping:** a slide's ⋮ menu sets how it appears when presenting (**Fade**, **Push**, **Zoom** or none; ✦ marks it in the list) and **Skip when presenting** for backup slides (faded in the list, ⊘). Presenting passes over skipped slides, in the presenter window too. Skipped slides stay hidden in PowerPoint downloads; transitions from PowerPoint files are read, but downloads don't carry them.
- **Speaker notes:** type them in the box under each slide. They're shared and saved with the presentation, carried to and from PowerPoint, and never shown to the audience.
- **Present** opens full screen. The arrow keys, space or a click move between slides, and Esc ends. **N** shows or hides your notes at the bottom (handy with a single screen).
- **Presenter view** also opens a second window for you, the speaker, to keep on your own screen: the current slide, the next one, your notes, a timer and the time. Moving through the slides in either window moves both.
- **Print or save as PDF** (⋮ menu) prints one slide per landscape page. Choose "Save as PDF" in the print dialog.
- People you share a presentation with see its pictures, even ones that aren't shared with them separately. Viewers can present but not edit.

## Contacts

- **Import:** **Import** takes a vCard file (.vcf, with one or many contacts) exported from a phone, iCloud, Outlook or Gmail, or a CSV export from Gmail or Outlook (or any sheet with a Name or Email column). People who are already in your contacts (the same email address) are skipped, so importing the same file twice is harmless. Birthdays, addresses and other details on a vCard are kept for your phone.
- **Export:** **Export** downloads all your contacts as vCards (for phones, Outlook and Apple) or as CSV (for Gmail and spreadsheets).
- **In Mail:** start typing a name or address in To, Cc or Bcc and pick from your contacts and colleagues (Up/Down, then Enter or Tab).

- **More details:** a contact can also have a job title, a website (https:// is added if you leave it off) and a postal address. They show in the list (job title · company · website) and travel with vCard and CSV files and phone sync; an address that came from a phone keeps its parts (street, city, postcode…) on the phone unless you change it here.
- **Birthdays:** a contact can have a birthday (with or without the year: tick **Year not known**). Birthdays show on the Calendar as all-day items with the age they turn when the year is known (29 February falls on the 28th in other years); click one to find the contact, or untick **Show contacts’ birthdays** to hide them. Birthdays come in and go out with vCard and CSV files and sync with phones.
- **Groups:** the **Groups** tab in Contacts holds your own lists of people (contacts, colleagues or any address) to email together. Type a group's name in To, Cc or Bcc and pick it to put in everyone in it, or use the envelope button next to the group. Groups are private to you.
- **Other contacts:** people you send email to who aren't colleagues or in your contacts are remembered (how often and when you last wrote), suggested when you write (marked "Emailed before"), and listed on the **Other contacts** tab. **Add to contacts** makes one a real contact; **×** forgets one.
- **Company contacts:** tick **Share with everyone at {company}** on a contact (a supplier, a client, the shared phone list) and it shows on everyone's **Company** tab, with who added it, and is suggested to everyone when they write mail. Only the person who added it, or a company administrator, can change or delete it; untick the box to make it yours alone again.
- **Merge duplicates:** **Merge duplicates** finds contacts that are the same person: the same email address, the same phone number (spaces and the country code don't matter) or the same name. Pick the one to keep in each group and **Merge**. The kept contact fills in what it's missing from the others, anything different (another email, phone or address) goes into its notes, and the others are deleted (from your phone too, on its next sync).
## Calendar and contacts on your phone

Your Workspace calendar and contacts sync with the phone's own Calendar and Contacts apps, both ways, using the standard CalDAV and CardDAV. Settings → *Calendar and contacts on your phone* shows the details for each person.

- **iPhone and iPad:** Settings → Calendar → Accounts → Add Account → Other → **Add CalDAV Account**. Enter the server (`workspace.example.com`), your email address and password. For contacts, do the same under Contacts → **Add CardDAV Account**.
- **Android:** install the free **DAVx⁵** app → *Login with URL and user name*, with `https://workspace.example.com/`. Calendars and contacts then appear in the phone's apps.
- **Thunderbird, macOS Calendar and Contacts** work the same way. The address `https://workspace.example.com/dav/` is the one to use if an app asks for the full address.
- **Password:** your account password. With two-step verification on, use a **mail-app password** instead (Settings), so a phone never gets around the second step. Wrong passwords count towards sign-in protection.
- **What syncs:**
  - Your events with your reminders, including repeating ones (daily, weekly on chosen days, monthly on a date, yearly; an end date or a number of times; skipped dates). Changes on either side show up on the other.
  - Your contacts. Addresses, birthdays and extra numbers added on a phone are kept, even though the web only shows one email and one phone number.
  - **Invitations** from colleagues appear on your phone with the organiser and guests. Accept, Maybe or Decline there is your answer in Workspace, and deleting one declines it. You can't change someone else's event from the phone.
  - **One occurrence of a repeating event** changed on its own (on the phone, or with "This event" on the web) shows on both as part of the series. Cancelling one on the phone skips that date.
  - **Time zones** come across however the app names them: standard names (`Europe/Berlin`), Outlook's Windows names (`W. Europe Standard Time`), or a zone the app describes itself (Outlook's "Customized Time Zone"), so a 9:00 meeting stays at 9:00.
- **Not yet:**
  - Repeats that Workspace can't show (such as "second Monday of the month") arrive as a one-off on the first date.
- **Synology reverse proxy:** nothing to add. The same HTTPS entry serves `/dav/` and the `/.well-known/caldav` and `/.well-known/carddav` addresses that apps look for.

## Word, Excel and PowerPoint files

- **Opening:** for a `.docx`, `.md`, `.xlsx` or `.pptx` file in Drive, pick **Open as document / spreadsheet / presentation** (⋮ menu, or the button in its preview). Workspace makes an editable Docs, Sheets or Slides copy next to it, and the original stays as it is.
- **Downloading:** **Download as Word / Excel / PowerPoint** is in each editor's ⋮ menu (documents also as Markdown). It includes what's just been typed, even by someone else in the last moment.
- **What carries over:**
  - **Word:** headings, paragraphs, bold, italic, underline, strike, links, bulleted and numbered lists, quotes, code, tables and pictures (saved in a "… pictures" folder beside the document). Downloading also writes text colours and highlights, and each picture's size and alignment. Paragraph alignment and text colours aren't read from Word files yet.
  - **Excel:** every sheet, values and formulas, bold, italic and underline, text and fill colour, alignment, number, currency and percent formats with their decimals, column widths, frozen rows and columns, and conditional formatting. Excel functions Sheets doesn't know show an error in Sheets, but are kept and written back as they were.
  - **PowerPoint:** every slide, text boxes at their places (size, bold, italic, colour, alignment), rectangles, rounded rectangles and ellipses, pictures (saved in a "… pictures" folder beside the presentation), slide backgrounds and speaker notes. Animations, charts and SmartArt don't carry over.
- Files up to 50 MB can be converted.

## Working with files (Drive)

- **Stars:** ⋮ → *Add star* on anything you want to find again; **Starred** in the sidebar lists them. Stars are your own.
- **Several at once:** tick files and folders (or Ctrl/Shift-click a row, or Space on it) and use the bar above the list to download, star, move or trash them together. The box in the header ticks everything.
- **Drag to move:** drag files onto a folder in the list, or onto a folder in the path at the top, to move them there. Dragging one of several ticked files moves them all.
- **Make a copy** (⋮ menu) of a file, document, spreadsheet or presentation; it goes next to the original.
- **Download as .zip:** a folder's ⋮ menu, or **Download** with several ticked, gives one .zip with the folders inside it. Documents, spreadsheets and presentations go in as Word, Excel and PowerPoint files. Up to 2 GB at a time.
- **Trash:** what you trash waits in **Trash**, where each item says when it goes for good: after 30 days unless an admin changes it (Admin → Company settings → **Empty the trash automatically**: 7 days to a year, or never). Its versions go with it and the space is freed. **Restore** brings it back and stops the countdown; **Empty trash** clears it at once.

- **Notify me of changes:** in a document's, spreadsheet's or presentation's **⋮** menu (or **Change notifications on/off** on a file or folder in Drive), turn on a notification for when someone else changes it or uploads a new version; for a folder, when someone adds or changes something in it or its subfolders (file-request uploads too). At most one an hour for each thing you follow, and only while you can still open it. Your own changes never notify you.
- **Storage:** the space line at the bottom of the Drive sidebar opens **Storage**: how much your files, their older versions and the trash take, your company's total (and its limit, if set), and your 25 largest items with what their older versions add. From there, **Delete older versions** frees a file's history (the file stays), the bin moves an item to the trash, and **Empty trash** clears it for good.
- **Transfer ownership:** **⋮ → Transfer ownership…** on something you own makes a colleague the owner (of a folder: with everything in it you own). They decide who has it, it counts as theirs, and you keep edit access. They get a notification, and its activity says who made whom the owner.
- **When someone leaves:** deleting a user (Admin → Users → ⋮ → **Delete user and their files**) can **give their Drive files to** a colleague instead of deleting them. The files go into a **Files from {name}** folder in that colleague's My Drive, with their folders and sharing as they were.

## File details (Drive)

**Details** in a file's or folder's ⋮ menu shows what it is, its size, owner, when it was made and last changed (and by whom), and who has access. Anyone who can edit it can add a **description** there, which search also finds, and give a folder a **colour**, shown on its icon in the list.

**Activity** in the same window lists what happened to it, newest first, for anyone who can open it: who created, uploaded or copied it, edited it (one line per person per hour of editing, including from Docs, Sheets, Slides and the network drive), renamed it, moved it, shared or stopped sharing it, put it in the trash or restored it, or brought back an earlier version. The latest 200 entries are kept for each file.

**Groups:** admins make groups of colleagues in **Admin → Groups** (*Marketing*, *Managers*…) and tick who's in each. In a file's or folder's **Share** window, **Share with a group…** gives the whole group view or edit access in one step. Whoever is in the group has it: people added later get it (with a notification), and people taken off lose it, unless it was also shared with them directly (they keep the better of the two). The Share window lists groups apart from the people shared with one by one. Deleting a group takes away what it gave. Groups also save typing elsewhere: **Invite a group…** in an event's window adds everyone in it as guests, and **+ (group)** when choosing who's in a private Chat channel ticks its members.

**Everyone in the company:** in a file's or folder's **Share** window, its owner can give *Everyone at (your company)* view or edit access in one step, including people who join later (for a handbook, templates, shared forms). It shows in their **Shared with me**, covers everything inside a folder, and stops at once when set back to *No access*. People in other companies never get it this way.

**Asking for access:** opening a link to a document, spreadsheet or presentation that isn't shared with you shows **You need access**: choose view or edit, add a note, and **Request access**. The owner gets a notification and **Access requests** in Drive, where they can **Share** (as asked, or view only) or **Decline**. Either way you're told. The page says nothing about the file, not even whether it exists, until the owner shares it.

## Search everything

The search box at the top looks everywhere at once as you type (two letters or more): **files** (names and what's inside), **mail** (Inbox and Sent, when email is on), **chat** messages, **tasks**, **notes**, calendar **events**, your **contacts** and **people** in the company, a few of each with how many there are. Click one, or pick it with the arrow keys and Enter, to open it where it lives: a document opens, a chat message is shown in its conversation, a task, note or event opens in its app. Enter with nothing picked (or **Search Drive for …**) runs the full Drive search with its filters, as before. Escape closes the list.

## Searching Drive

- The search box at the top finds files by **name** and by the **words inside** them: documents, spreadsheets (cell text and sheet names), presentations, and uploaded text, Word, Excel and PowerPoint files. Each match shows the sentence it was found in, with the words marked. It looks through your files, those shared with you or your company, and everything inside folders shared that way.
- Words can be typed in any order, the start of a word is enough (`penan` finds *Penang*), and accents don't matter (`cafe` finds *café*). Name matches come first.
- **Filters** under the results narrow them by **type** (documents, spreadsheets, presentations, PDFs, pictures, videos, audio, archives, folders; Word, Excel and PowerPoint uploads count with their kind), **owner** (you or someone else), and **when they last changed**. They work without any words too: press Enter in an empty search box, then pick, say, PDFs. The filters are in the page address, so Back and bookmarks keep them.
- Only files you can open are found, and files in the bin aren't. Changes are searchable within a few seconds, however they were made (in the editor, by upload, or over the network drive). PDFs and pictures are found by name only.

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
- **File requests:** for a folder, tick **File request (upload only)** before **Create file request** to collect files from people without an account (receipts, signed forms, photos). The page they open asks for their name and takes files dropped on it; they see only what they sent from that page, never what's in the folder. Each file lands in the folder as yours, counts towards your company's storage, says who sent it (in its details), and you get a notification. Expiry, password and removing the link work as for other links.
- **Keeping track:** the Share dialog lists each link with its expiry, whether it has a password, and how often it was opened. **Remove** stops a link at once.
- **Links stop working by themselves** when they expire, when the file or folder goes to the trash (or is deleted), or when the owner's account is disabled. A file moved out of a shared folder is no longer reachable through that folder's link.
- **Company switch:** Admin → Company settings → *Links for people without an account*. Turning it off immediately stops every link in the company; turning it back on restores the ones that haven't expired.
- Only the owner of a file can create or remove its links. Link pages aren't indexed by search engines.

## Calendar

- **Views:** Month, Week and Day (the choice is remembered in each browser).
  - In week and day views, events sit at their times, overlapping ones side by side, with a red line for the current time.
  - Click an empty half hour to create an event there, or a date to open that day. The arrow keys move between periods.
- **Dragging with the mouse:** drag an event to another time or day (in 15-minute steps in week and day views; to another day in the month view and the all-day row), or drag its bottom edge to change when it ends. Esc cancels a drag. For a repeating event you choose "This event", "This and following events" or "All events"; a weekly series on set weekdays moves its weekdays along with it. Invitations from other people can't be dragged. On phones and tablets, open the event and change the times instead.
- **Reminders:** each event can remind you (at the start, or minutes, hours, days or a week before; up to five). New events remind you 10 minutes before. While Workspace is open in a browser, a reminder pops up at the bottom of the page, and as a desktop notification when the tab is in the background and notifications are on (Settings). It shows once, even with several tabs open. Reminders are your own: a guest sets theirs in the invitation, and the organiser's don't apply to them. Phones and calendar apps that sync over CalDAV get them too, and reminders set on the phone show on the web.
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

- **Booking pages:** **Booking pages** in the Calendar sidebar makes a link people can use to book time with you, with or without an account (customers, candidates, suppliers). Choose the length, the days and hours, how much notice you need and how far ahead people can book. Visitors see only the free times, in their own time zone: your events (repeating ones too) and invitations you haven't declined count as busy, all-day events don't. A booking goes on your calendar with the visitor as a guest and their note in the details; they get an invitation by email, and you get a notice. Turn a page off or delete it to stop bookings; Workspace's address must be reachable from the internet for outside visitors (set `PUBLIC_URL`).
- **Other people's calendars:** **See a colleague's calendar…** in the Calendar sidebar adds a colleague (from your own company, up to ten at a time); their busy times show as hatched blocks in the week and day views, in their own colour, so you can find a time that suits everyone. Only when they're busy shows, never what or where. The list is kept on that device; **×** hides someone again.
- **Duplicate:** **Duplicate** in an event you organise opens a copy with the same title, time, place, notes, guests, colour and reminders (as they are in the window, so you can change the time first); change what you need and **Save**. The copy doesn't repeat, and guests are invited to it as a new event.
- **Out of office:** **🌴 Out of office…** in the Calendar sidebar (or ticking *Out of office* on any event) marks time off, shown striped. While it lasts, new invitations for that time are declined for you, and whoever invited you gets a notification with your message (the event's description). You can still say Yes yourself. Colleagues looking at your calendar see *out of office* for the whole time, even all-day, and booking pages don't offer it. Time off has no guests.
- **Import and export:** **Import (.ics)** in the Calendar sidebar adds the events from a calendar file exported from Google Calendar, Outlook or Apple Calendar: times in their time zones, all-day events, repeats (with changed or cancelled occurrences) and reminders. Importing the same file again skips what's already there. **Export (.ics)** downloads all your own events as one file for another calendar app.
- **Working hours:** **Working hours** in the Calendar sidebar sets the days and times you work, in your time zone (say Tuesday and Thursday, 13:00 to 17:00). **Find a time** then only offers times inside the hours of everyone it checks, each in their own time zone, and names whose own hours it kept to. Anyone who hasn't set theirs counts as Monday to Friday, 9 to 5, in the organizer's time zone. **Use the usual** goes back to that.
- **Attachments:** **Attach from Drive** in an event's window adds documents, spreadsheets, presentations or files (the agenda, last month's figures). Guests on the server are given view access to the ones you own when you save, so they open them straight from the invitation. Others' files they can already open show as links; any they can't open are listed as "no access". **×** takes one off (nobody loses access they were given).
- **Propose a new time:** a guest can answer an invitation with **Propose a new time** (a day, times and a note); they're counted as Maybe, and the organizer gets a notification. In the event's window the organizer sees each suggestion with **Use this time**, which fills in the times to save (guests then get the usual update). Changing the time clears the suggestions. Not for repeating events.
- **Find a time:** in an event's window, **Find a time** suggests the first free times in the next two weeks, for the event's length, within everyone's working hours (every half hour), when you and every colleague you've invited are free (their own events and invitations they haven't declined; out-of-office counts too). Click one to use it. Guests outside your company can't be checked, and it says so.
- **Rooms:** admins list the company's meeting rooms (or anything else people book, like a projector) in Admin → Company settings → **Rooms**, with how many each seats. In an event, **+ Add a room…** shows each room as free or taken at that time. A free room is booked when you save; a taken one declines (for a repeating event, if it's taken at any of its times in the next six months). Moving an event checks its rooms again. Guests see the room in the invitation. **+ See a room's bookings…** under *Other calendars* shows what a room is booked for, and by whom, in the week and day views.
- **Search:** the **Search events** box in the Calendar sidebar finds your events and invitations with all the words you type, in the title, place or notes. Coming events are listed first (a repeating one by its next time), then past ones, newest first; click one to go to its day and open it. **Clear** brings back Upcoming.
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
- **Undo send:** after **Send**, the message waits five seconds with an **Undo** button, in case you spot a mistake; Undo brings the message back as it was. (Leaving the page in those seconds sends it straight away.)
- **Schedule send:** the clock button next to Send sends it later: tomorrow morning or afternoon, Monday morning, or a date and time you pick. The server sends it then, even if nobody has Workspace open, with the time it was sent as its date. Waiting messages are listed under **Scheduled** in the folder list, with **Send now** and **Don't send** (which puts it back in Drafts to change). The message is put together when you schedule it, so attachments are as they were then. If sending fails three times it stays in the list with the reason.
- **Add to contacts:** next to the sender of a message from outside your company, **Add to contacts** saves them (name and address) to your contacts; once they're there it says *In your contacts*.
- **Block sender:** on a message, **Block sender** (after you confirm) makes a filter that sends their future mail straight to Junk, marked read (on your phone too, since filters run on the mail server), and moves the message there now. It shows in **Filters** as *Blocked: their address*, where deleting it unblocks them.
- **Mark all as read:** when a folder has unread mail, the ✓ button above the list marks all of it as read at once (on the server, so your phone sees it too).
- **Unsubscribe:** newsletters and mailing lists that say how to leave (the List-Unsubscribe header) show **Unsubscribe** beside the sender. After you confirm, Workspace asks the list to stop: with a one-click request when the list supports it (RFC 8058), or else by sending the list's unsubscribe email from your address. Lists that only offer a web page open it in a new tab. For safety, the server only contacts https addresses on the public internet, never your own network, and doesn't follow redirects.
- **Conversations:** above a message, **Conversation: 2 earlier, 1 later messages** lists the rest of its conversation, oldest first: messages with the same subject (ignoring Re:, Fwd: and the like, in several languages) that share someone with it, from the Inbox, Sent, Archive and the folder you're in, so your own replies are there too. Click one to open it.
- **Import mail:** **Import mail** in the Mail sidebar copies everything from another account (Gmail, Outlook.com, Yahoo, iCloud or any IMAP server) into your mailbox: every folder, with what's read and starred and the original dates. Sent, Drafts and Archive go to yours, and Junk and Trash are left out. It runs on the server with progress shown (you can close the window), and messages already here are skipped, so it can be run again. Your password there is used only for the import and never stored. Gmail, Yahoo and iCloud need an app password. Only servers on the internet are allowed, on ports 993 or 143; set `MAIL_IMPORT_ALLOW_PRIVATE=1` to allow an old mail server on your own network.
- **Linked files:** if an email links to Drive files that colleagues it's going to can't open, Mail asks before sending: **Share (can view) and send** shares the ones that are yours, **Send anyway** sends it as it is. Files that aren't yours are named so you can ask their owner. People outside the company aren't checked.
- **Read receipts:** tick **Read receipt** when writing to ask to be told when it's opened (the recipient's mail app may ask them, and they can say no). When a message you open asks for one, a bar offers **Send receipt** or **Not now**; Workspace never sends one by itself, and either answer is remembered so you aren't asked again (in phone mail apps too). The receipt only says the message was opened.
- **Save to Drive:** the folder button beside an attachment saves it to Drive, and **Save all to Drive** (when there are several) saves them all, into an **Email attachments** folder in My Drive (made the first time). **Show** in the note opens the folder. Saved files count towards the company's storage.
- **Create event:** the calendar button on a message opens a new event in Calendar with the subject (without Re: or Fwd:), everyone on the email except you as guests, and its text as the description. Pick the time (it starts at the next half hour) and **Save**; nothing is sent until you do.
- **Search:** the search box finds messages in the folder you're in with all the words you type (in the subject, sender, recipients or text). Like Gmail, it also understands `"exact phrases"`, `-word` to leave out, `from:` `to:` `subject:`, `has:attachment`, `is:unread` `is:read` `is:starred`, `before:2026-01-31` `after:2026-01-01`, `newer_than:7d` `older_than:1y` (days, months, years), and `larger:5M` `smaller:200K`. A mistake (a date written another way) is explained instead of finding nothing. Hover over the box for the list.
- **Print:** the printer button on a message opens your browser's print dialog with a clean page: the subject, From, To, Cc and date, the attachments' names, and the message (pictures from the internet only if you chose to show them). Choose *Save as PDF* there to keep a copy.
- **Labels:** **+** next to Labels in the folder list makes a coloured label. Put it on a message with the tag button (or **Label** with several selected); take it off with the × on its chip. Click a label to see only the messages that have it in the folder you're in. Labels are kept on the mail server as IMAP keywords, so mail apps that show keywords (such as Thunderbird's tags) see them; deleting a label takes it off every message in every folder.
- **Templates:** for messages you send often, write one and choose **Templates → Save as template…** in the message window. Later, **Templates → (its name)** puts its text where the cursor is (in place of an empty message) and its subject if there isn't one yet; your signature stays as it is. **Manage templates…** renames them, changes their subject or deletes them.
- **Snooze:** the clock button on a message (or **Snooze** with several selected) puts it away until later today, tomorrow, the weekend, next week, or a date and time you pick (up to a year ahead). It waits in a **Snoozed** folder, with when it comes back, and returns to the top of your Inbox, unread, at that time, even if nobody has Workspace open. **Unsnooze** brings it back now; snoozing it again changes the time. Phones and Outlook see the Snoozed folder too; a message moved out of it by hand stays where it's put.
- **Keyboard:** **C** writes a new message, **/** searches, **J** / **K** open the next older or newer message, **U** goes back to the list, **R** / **A** / **F** reply, reply all or forward, **E** archives, **#** deletes, **S** stars and **Shift+U** marks unread. They work whenever you aren't typing in a box; **?** (or Ctrl+/) lists them.
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

## Storage (admins)

**Admin → Storage** shows how much of the company's storage is used (and its limit, if the platform owner set one), how much each person uses, split into their files, the earlier versions kept of them, and their trash, biggest users first, and the 25 largest files with their owners (including what's in the trash). Earlier versions and the trash count towards the limit: people can empty their trash in Drive, and delete versions from a file's version history.

## Announcements (admins)

**Admin → Announcements** puts a short notice at the top of every page for everyone in the company: an office closure, a maintenance window, a new policy. Give it the text (up to 300 characters), an optional link (a page in the suite like `/drive`, or an `https://` address), a style (**Info** or **Warning**, which is amber) and, if you like, an end date after which it disappears by itself. It shows up straight away for everyone signed in. Each person can dismiss it with the × and it stays gone for them. **Showing now** lists what's up, with how many people have dismissed each one, and **Take down** removes one for everyone. Posting and taking down are recorded in the activity log.

## Activity log

**Admin → Activity** shows each company's admins what happened in their company, newest first:

- **Sign-ins:** successful and failed sign-ins, sign-outs, devices signed out, password changes, two-step verification turned on or off, and mail-app passwords.
- **People and settings:** people added, changed or deleted, company settings, mail domains and aliases.
- **Files:** sharing changes, public links made or removed, files deleted forever, and the trash being emptied.

Each entry shows who did it, what it was done to, the details and the IP address. Filter by kind, search for a person, file or address, or pick dates. **Download CSV** saves what's shown, for a spreadsheet or your records. Admins see only their own company; the platform owner can pick any company. Entries are kept for a year (set `AUDIT_DAYS` to change this).

## Tasks

- **Lists:** everyone starts with **My tasks**; **+** next to Lists makes more. Type in **Add a task** and press Enter: new tasks go on top. Drag tasks to put them in order.
- **Comments:** a task's details have a **Comments** box for talking it over; everyone on the list sees them as they're posted, and the list shows 💬 with how many. The person it's for, whoever made it and anyone who has commented get a notification. You can delete your own comments.
- **Board:** **List | Board** at the top of a list shows it as a board with **To do**, **In progress** and **Done** columns. Drag a card to another column (or use its ‹ › arrows); moving one to Done ticks it off, and back takes it off again. In progress shows on the task in the list too, and everyone sharing the list sees the same columns. Each list remembers which view you chose (in this browser).
- **Sorting:** **⇅** at the top of a list sorts it your way: **My order** (drag to arrange), **Due date** (timed ones first on a day, undated at the end), **Title**, **Recently added** or **Starred first**. It's your own choice for each list, remembered on every device; others on a shared list keep theirs.
- **Ticking off:** the box marks a task done (with **Undo**); done tasks move to **Completed** at the bottom, and **⋮ → Delete completed tasks** clears them.
- **Details:** click a task for notes, a due date (shown as Today, Tomorrow or the date; overdue in red) and, if you like, a time on it ("Today 15:30"; red once it's passed; it shows on the calendar too, and a note pops up at that time while Workspace is open, with a desktop notification when those are on), who it's for, and which list it's on. Changes save as you make them.
- **Search:** the **Search tasks** box finds tasks with all the words you type in their title, notes or steps, on your own lists and those shared with you (open ones first, soonest due first, then done ones). Click one to open it in its list.
- **Steps:** a task can hold a checklist. Type in **Add a step** in its details; tick steps off, click one to rename it, or **×** to remove it. The list shows progress on the task (☑ 2/5, green when all are done), and everyone on a shared list sees the same steps. A repeating task's next one comes with the same steps, none ticked.
- **Repeating:** **Repeat** in a task's details (every day, weekday, week, month or year). Ticking it off adds the next one, due on the same schedule from today on (missed ones are skipped, and the 31st becomes the month's last day); **Undo** takes it away again unless someone has already changed it. Clearing the due date stops it repeating.
- **Sharing:** **Share** on a list lets colleagues see it, add and tick off tasks, and be given tasks. Everyone sees changes as they happen. **Assigned to me** gathers the tasks given to you on any list, soonest due first. Leaving a list (or being taken off it) leaves the tasks you were given with nobody.
- **Important:** the ☆ on a task marks it important (anyone on the list can, and everyone sees it). **Important** at the top of Tasks gathers the open important tasks from all your lists, soonest due first, with the list each is on. Ticking one off or taking its star off removes it; a repeating task's next one stays important.
- **From an email or a chat message:** the ✓ button on an open email, or on a chat message (hover over it), adds it to **My tasks**: an email's subject or the message's first line becomes the task, and **Open** in the note goes to it. The task shows ✉ or 💬, and its details link back to the email or message. The email is found even after it's been archived or moved to another folder. **Remove** next to the link takes it off.
- **Reminders:** each morning (from 9:00, or when you first open Workspace after that) a note lists what's due today and overdue, with a button to the tasks. When someone gives you a task you get a note straight away. Both show once, in one tab, and as desktop notifications too when those are on.
- **On the calendar:** open tasks with a due date (given to you, or to nobody on your own lists) show in Calendar as all-day items. Tick the box to complete one there, or click it to open it in Tasks. **Show tasks with due dates** in the Calendar sidebar hides them.

## Forms

**Forms** in the left bar makes questionnaires, sign-up sheets and quick polls.

- **Questions:** **New form**, give it a title and a description, and add questions: short answer, paragraph, multiple choice, tick boxes, dropdown, a 1–5 or 1–10 scale (with optional labels for each end) or a date. Each can have help text and be *Required*. Move questions up and down, duplicate or delete them. Everything saves as you type.
- **Sharing:** **Copy link** gives the form's address (`/f/…`). Under **Settings → Who can fill it in**, choose **People at your company** (they sign in, on the form's page if they aren't already, and their name and address are recorded) or **Anyone with the link** (no sign-in, anonymous; not offered if your company has turned off links for people outside it). Company forms can be limited to **One response per person**. **Preview** opens the form as others see it. **Get a new link** stops the old link working.
- **After submitting:** people see your **Message after submitting** (or "Your response has been recorded"), and can send another response unless it's one each.
- **Responses:** the **Responses** tab updates live as answers arrive: a **Summary** per question (how many chose each option, with bars and percentages, the average on a scale, and the written answers) or each response on its own (**Individual**, with who sent it, and a button to delete it). **Download CSV** saves them all (Excel-safe), and **Open in Sheets** puts a copy of the responses so far in a new spreadsheet in your Drive. **Delete all** clears them.
- **Closing:** untick **Accepting responses** and the link shows that the form is closed. Or let it close by itself: **Settings → Close automatically on** a date and time, and/or **Stop after this many responses** (good for sign-ups with limited places). People opening the link are told why it's closed; change or clear the setting to open it again. **⋮ → Make a copy** starts a new form with the same questions; **Delete form** removes it, its responses and its link.
- **Quizzes:** **Settings → Make this a quiz**, then set the right answer under each short-answer or choice question (several for tick boxes; short answers ignore capitals and extra spaces) and how many points it's worth. Each response is scored: the **Responses** tab shows the average and how many got each score, and each response its score with ✓ and ✗ per question; the CSV and Sheets copy have a **Score** column. With **Show people their score after submitting**, people see their score and which questions they got right. The answers are never sent to people filling the form in.
- **Working together:** **Settings → People who can edit** lets the owner add colleagues by email. Editors see the form in their Forms list (*Shared by …*), can change its questions and settings and read and download the responses, and changes reach everyone who has it open. Only the owner adds or removes editors or deletes the form; an editor can **⋮ → Leave this form**.
- **Notifications:** the owner and editors get a bell notification for each response (turn it off per form in Settings, or for all forms in the bell's settings).

## Notes

**Notes** in the left bar is for quick notes and lists, kept as coloured cards:

- **Take a note…** at the top, or ✓ for a checklist (Enter adds the next item; Backspace on an empty one removes it). Clicking outside or **Close** keeps it; an empty note isn't kept.
- On a card: 📌 **pin** it to the top, 🎨 give it a colour, **archive** it (with **Undo**), tick checklist items off right there (ticked ones are counted underneath), and **⋮ → Labels…** (then pick a label on the left to see just those), **Make a copy** or **Delete**. Click a card to edit it; it saves as you go, and can switch between text and a checklist.
- **Reminders:** 🔔 on a card sets one (later today, tomorrow morning, next Monday, or **Pick a day and time…**). It shows on the card (× takes it off), **Reminders** on the left lists the notes that have one, soonest first, and when it's time a notification (and a desktop one, if those are on) reaches you and everyone the note is shared with, listing what's still unticked on a checklist. You can turn note reminders off in the bell's settings.
- **Search notes** finds words in titles, text, checklist items and labels. **Archive** on the left has the archived ones.
- **Share** (the person icon) gives colleagues in your company the note: they see it among their notes and can change it, and everyone sees changes as they're made. Only the owner can delete it or change who has it; the others can take it off their own list.

## Meet

**Meet** in the left bar starts a video meeting: **New meeting** (give it a name if you like) opens it and gives it a code like `abc-defg-hij`. Share the link (🔗, or **Copy link** before joining) or read out the code; colleagues join with **Join with a code** (typing it with or without dashes, or pasting the link). **Recent meetings** lists the ones you started or joined, with how many people are in each now, so a regular meeting can keep its link.

- **Before joining** you see your camera, can turn the microphone and camera off, and see who's already there. If there's no camera or microphone (or the browser isn't allowed to use them) you can still join to watch, listen and chat.
- **In the meeting:** everyone's video in a grid (a picture of them when their camera is off), 🔇 on whoever is muted, and controls for the microphone, camera, **presenting your screen** (a window, a tab or the whole screen), **raising your hand** (outlined in yellow for everyone, and shown in **People**), quick reactions that float up over your video, the meeting **chat** (seen only by those in the meeting, and gone when it ends) and **Leave** (with **Rejoin**).
- **From Calendar:** in an event's window, **Add video meeting** gives it a meeting (**Remove** takes it off). Guests see **Join video meeting** when they open the event, the invitation email has the link, the reminder before it starts has a **Join** button, and phones get the link with the event (when `PUBLIC_URL` is set).
- **From Chat:** the video button beside the message box starts a meeting, posts its link in the conversation (shown with a **Join video meeting** button for everyone) and opens it for you.
- **Who can join:** people in your company, and in companies yours works with (when both allow working with other companies). Up to 8 at once.
- **How it works:** sound and video go directly between the people in the meeting; the server only introduces them. Browsers only allow cameras on secure pages, so use Meet through HTTPS (see *Publish it securely*). People on the same network, or on most home and office connections, connect directly. For people behind strict firewalls, run a TURN server (for example coturn) and list it in `MEET_ICE_SERVERS`.

## Chat

- **Unread:** Chat in the app bar and each conversation show how many messages you haven't read; opening the conversation clears them, on your other devices too. To come back to something later, hover over someone else's message and choose ✉ **Mark unread from here**: the conversation counts as unread from that message on (you're taken back to the list so it stays that way).
- **Reactions:** hover over a message and pick 👍, ❤️, 😂 or any emoji; click a reaction to add yours or take it back. Hover over it to see who reacted.
- **Editing:** hover over your own message and choose the pencil to change it (Enter saves, Esc cancels). Changed messages say "(edited)".
- **Search:** the search box above the channels finds messages with all the words you type, in every channel and direct conversation you can see (thread replies too), newest first, with the words marked. Click one to jump to it, however far back it is (a reply opens its thread).
- **Channels:** **+** next to Channels makes one, open to the whole company or **private** to the people you choose (🔒). The ⚙ button in a channel sets its **topic** (anyone in it), adds people to a private channel or lets you leave it, and, for whoever made the channel or an admin, renames it, makes it private or open, takes people off, or **archives** it. An archived channel stays readable under **Show archived** but can't be written in until it's unarchived. The company-wide #general always stays open.
- **@mentions:** type **@** and a few letters of a name to pick a colleague (arrow keys and Enter, or click). The person gets a notice with an **Open** button wherever they are in Workspace, the conversation gets an **@** badge until they read it, and mentions of you are highlighted. Works in threads too.
- **Threads:** hover over a message and choose **Reply in thread** to answer it beside the conversation, so side discussions don't bury everything else. The message shows how many replies it has, who replied and when the last came; click that to open the thread. Replies in a thread only count as unread for people in it (who started it or replied). Deleting a message deletes its thread.
- **Formatting:** type `*bold*`, `_italic_`, `~strike~`, `` `code` ``, a block between ```` ``` ```` lines, or start a line with `> ` to quote. Messages stay plain text (so search and notifications see the words), and ordinary text such as `2 * 3`, file_names and web addresses is left as it is.
- **Your status:** the account menu (your picture, top right) → **Set a status**: an emoji and a few words (or a suggestion such as 📅 In a meeting or 🌴 On holiday), cleared after 30 minutes, an hour, 4 hours, today, this week, or never. Colleagues see it at once next to your name in Chat (your direct messages list, and under your name at the top of a conversation with you) and in Contacts → Directory; your picture shows the emoji. **Clear status** removes it.
- **Your photo:** Settings → **Add a photo** (any picture; it's cropped to a square in your browser). Colleagues then see it instead of your initials: in Chat, Contacts → Directory, Drive sharing and details, Tasks, Admin, the top bar, mail from you, and next to your name when you edit a file together. It changes everywhere at once. **Remove photo** brings your initials back. People in other companies you work with can see it too.
- **Muting:** 🔔 at the top of a channel or direct conversation mutes it for you: its messages still arrive and show their count in the list (greyed, with 🔕), but no longer add to Chat's unread count in the app bar. Mentions of you still do. Click 🔕 to unmute.
- **Forwarding:** hover over a message and choose ↪ **Forward**, pick another conversation (a channel or a direct message) and add a note if you like. It arrives as a card showing who wrote it, in which channel (direct messages and private channels aren't named) and when, with its files, which everyone there can open. Forwarding a forward without a note passes on the original. Polls can't be forwarded.
- **Saved for later:** hover over a message and choose 🔖 to save it for yourself (only you see what you save). **🔖 Saved** at the top of the conversation list shows them, last saved first, with where each is; click one to jump to it (in its thread if it's a reply), or **×** to take it off. Messages in a conversation you've left drop out of the list.
- **Pinned messages:** hover over a message and choose 📌 to pin it to the conversation for everyone in it (anyone in the conversation can pin and unpin; thread replies can't be pinned). Pinned messages are marked, and **📌** at the top of the conversation lists them, most recently pinned first: click one to jump to it, or **Unpin** it there. Up to 50 per conversation.
- **Polls:** **📊** beside the message box asks a question with 2–10 options (tick *People can choose more than one* to allow several). Everyone in the conversation votes with a click, sees the counts and who chose what update live, and can change or take back their vote. Whoever asked can **Close poll** (no more voting) and reopen it. Polls can't be edited.
- **Scheduled messages:** write a message and choose **🕒** beside **Send** to send it later: tomorrow morning or afternoon, Monday morning, or a date and time you pick (within a year). It goes at that time as if you sent it then, even if Workspace isn't open. **🕒 N scheduled messages** under the box lists them, with **Send now** and **Delete**. If one can't be sent when it's due (the channel was archived, you left it, a file is gone), it stays in the list with the reason and you get a notification.
- **Remind me:** hover over a message and choose the clock to be reminded about it: in 20 minutes, in an hour, tomorrow morning or afternoon, Monday morning, or a time you pick. Then you get a notification that leads back to the message. The message shows ⏰ until then, with **Cancel**. Only you see your reminders.
- **File cards:** a link to a Workspace document, spreadsheet, presentation or folder in a message (pasted from the address bar, or just /docs/…) shows as a card with its name, kind, owner and what you can do with it. Click it to open the file. If it isn't shared with you, the card says so without showing the name and takes you to **Request access**.
- **Sharing what you link:** when you send a link to a Drive file that some people in the conversation can't open, a note says who. If the file is yours, **Share with them** lets them view it (in a company-wide channel, **Share with everyone at** your company); if not, ask its owner.
- **Pictures and files:** the paper clip attaches files (or drop or paste them into the message box). They're saved in a "Chat files" folder in your Drive, and everyone in the conversation can open them from the message, even without access to the folder. Pictures show in the conversation.

## Notifications

The bell at the top right collects what needs you: being **@mentioned** in Chat or in a comment, a **task** given to you, a calendar **invitation** (or its cancellation), a file or folder **shared** with you, and someone **booking** time with you. New ones appear at once, with a count on the bell. Click one to go there (it's then marked read), or **Mark all read**. The latest 200 are kept.


**Notification settings** (⚙ in the bell's panel) turns each kind on or off for you: mentions in Chat and documents, mentions in file comments, tasks, calendar invitations and answers, shared files and access requests, changes to files you follow, chat reminders, and bookings. Kinds you turn off aren't kept, so they don't turn up later either.

**Pause notifications** (account menu, top right: for 30 minutes, 1 or 2 hours, or until 9:00 tomorrow) stops the pop-up notes and desktop notifications for new mail, mentions, event reminders and tasks until then. Everything still arrives in the bell and the apps. 🔕 by the bell shows it's on (click to resume), and colleagues see 🔕 by your name in Chat.
## Branding

In **Admin → Company settings → Branding**, a company's admins can upload a **logo** (PNG, JPEG or WebP, up to 1 MB; SVG isn't accepted, as it can carry scripts) and pick a **colour**. Everyone in the company then sees the logo in the top bar and the colour on buttons, highlights and links. The sign-in page shows the logo and colour when Workspace is opened at an address on one of the company's domains, such as `workspace.acme.com` (set up the address in DNS and your reverse proxy); other addresses show the plain Workspace sign-in.

## Light and dark

Workspace follows your computer's or phone's light or dark setting. To choose for yourself, go to **Settings → Appearance** and pick **Light** or **Dark** (or **System** to follow the device again). The choice is kept on that device and applies from the moment a page opens.

## Keyboard shortcuts

Press **Ctrl+/** (**⌘/** on a Mac), or **?** outside a text field, for the list of keyboard shortcuts, with the ones for the app you're in first.

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
| `AUDIT_DAYS` | 365 | Days the admin activity log is kept (at least 7) |
| `MAIL_IMPORT_ALLOW_PRIVATE` | off | Set to `1` to let people import mail from a server on your own network (by default only internet mail servers are allowed) |
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
| `MEET_ICE_SERVERS` | none | Extra STUN/TURN servers for Meet, as JSON, e.g. `[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]` |
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
