import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planExport, gmailTarget, sourceOf, contactsCsv } from '../src/migrate/plan.js';

const as = (r) => Object.fromEntries(r.plan.map((x) => [x.name, x.as === 'drive' ? `drive:${x.path}` : x.as === 'mbox' ? `mbox:${x.gmail ? 'gmail' : x.folder}` : x.as === 'eml' ? `eml:${x.folder}` : x.as]));

test('a Google Takeout', () => {
  const r = planExport(['Takeout/', 'Takeout/archive_browser.html', 'Takeout/Mail/All mail Including Spam and Trash.mbox', 'Takeout/Mail/User Settings/Filters.xml',
    'Takeout/Calendar/Work.ics', 'Takeout/Calendar/Holidays.ics', 'Takeout/Contacts/All Contacts/All Contacts.vcf', 'Takeout/Contacts/Family/Family.vcf',
    'Takeout/Drive/Plans/Q3.docx', 'Takeout/Drive/photo.jpg', 'Takeout/Keep/Shopping.json', 'Takeout/Keep/Shopping.html', 'Takeout/Keep/abc.png', 'Takeout/Keep/Labels.txt',
    'Takeout/Tasks/Tasks.json', 'Takeout/YouTube and YouTube Music/history.json', 'Takeout/Chrome/Bookmarks.html']);
  assert.equal(r.source, 'google');
  assert.deepEqual(as(r), {
    'Takeout/archive_browser.html': 'skip', 'Takeout/Mail/All mail Including Spam and Trash.mbox': 'mbox:gmail', 'Takeout/Mail/User Settings/Filters.xml': 'skip',
    'Takeout/Calendar/Work.ics': 'calendar', 'Takeout/Calendar/Holidays.ics': 'calendar', 'Takeout/Contacts/All Contacts/All Contacts.vcf': 'contacts',
    'Takeout/Contacts/Family/Family.vcf': 'skip', 'Takeout/Drive/Plans/Q3.docx': 'drive:Plans/Q3.docx', 'Takeout/Drive/photo.jpg': 'drive:photo.jpg',
    'Takeout/Keep/Shopping.json': 'keep', 'Takeout/Keep/Shopping.html': 'keep', 'Takeout/Keep/abc.png': 'keep', 'Takeout/Keep/Labels.txt': 'skip',
    'Takeout/Tasks/Tasks.json': 'tasks', 'Takeout/YouTube and YouTube Music/history.json': 'skip', 'Takeout/Chrome/Bookmarks.html': 'skip',
  });
  assert.deepEqual(r.left_out, ['Chrome', 'YouTube and YouTube Music']);
  // Without All Contacts, each group's file comes in (doubles are skipped by the contacts import).
  assert.equal(as(planExport(['Takeout/Contacts/Family/Family.vcf']))['Takeout/Contacts/Family/Family.vcf'], 'contacts');
  // Gmail's label folders, when exported as separate .mbox files.
  assert.equal(as(planExport(['Takeout/Mail/Clients.mbox']))['Takeout/Mail/Clients.mbox'], 'mbox:Clients');
});

test('Zoho and Microsoft exports, and anything else, by kind of file', () => {
  const z = planExport(['ZohoMail_export/Inbox/1.eml', 'ZohoMail_export/Inbox/2.eml', 'ZohoMail_export/Sent/3.eml', 'ZohoMail_export/Clients/Acme/4.eml']);
  assert.equal(z.source, 'zoho');
  assert.deepEqual(Object.values(as(z)), ['eml:Inbox', 'eml:Inbox', 'eml:Sent', 'eml:Acme']);
  const m = planExport(['OneDrive_1_15-11-2026/Reports/Q3.xlsx', 'OneDrive_1_15-11-2026/notes.txt']);
  assert.equal(m.source, 'microsoft');
  assert.deepEqual(Object.values(as(m)), ['drive:Reports/Q3.xlsx', 'drive:notes.txt'], 'the wrapping folder is dropped');
  const o = planExport(['export/contacts.csv', 'export/Calendar.ics', 'export/people.vcf', 'export/Old.mbox', 'export/mail.pst', 'export/docs/a.pdf', '__MACOSX/x', '.DS_Store']);
  assert.deepEqual(as(o), { 'export/contacts.csv': 'contacts-csv?', 'export/Calendar.ics': 'calendar', 'export/people.vcf': 'contacts', 'export/Old.mbox': 'mbox:Old', 'export/mail.pst': 'skip', 'export/docs/a.pdf': 'drive:docs/a.pdf' });
  assert.match(o.plan.find((x) => x.name === 'export/mail.pst').why, /IMAP/);
});

test('which service', () => {
  assert.equal(sourceOf(['Takeout/Drive/a.txt']), 'google');
  assert.equal(sourceOf(['OneDrive/a.txt']), 'microsoft');
  assert.equal(sourceOf(['x/y.txt']), 'other');
});

test('a contacts CSV, not some other spreadsheet', () => {
  assert.equal(contactsCsv('First Name,Middle Name,Last Name,E-mail Address,Business Phone'), true, 'Outlook');
  assert.equal(contactsCsv('Name,Given Name,Family Name,E-mail 1 - Type,E-mail 1 - Value'), true, 'Google');
  assert.equal(contactsCsv('"First Name","Last Name","Email Address","Mobile Phone"'), true, 'Zoho');
  assert.equal(contactsCsv('Region,Q1,Q2,Q3'), false);
  assert.equal(contactsCsv('Subject,Start Date,Start Time,Name'), false, 'an Outlook calendar CSV');
});

test('Gmail labels to folders', () => {
  assert.deepEqual(gmailTarget('Inbox,Opened,Important'), { folder: 'INBOX' });
  assert.deepEqual(gmailTarget('Sent,Opened'), { folder: '\\Sent' });
  assert.deepEqual(gmailTarget('Opened,Clients,Category Updates'), { folder: 'Clients' });
  assert.deepEqual(gmailTarget('"Projects/Acme",Unread'), { folder: 'Projects/Acme' });
  assert.deepEqual(gmailTarget('Archived,Opened'), { folder: '\\Archive' });
  assert.deepEqual(gmailTarget('Drafts'), { folder: '\\Drafts' });
  assert.deepEqual(gmailTarget('Spam,Unread'), { skip: true });
  assert.deepEqual(gmailTarget('Trash'), { skip: true });
  assert.deepEqual(gmailTarget('Chat'), { skip: true });
  assert.deepEqual(gmailTarget(''), { folder: '\\Archive' });
});
