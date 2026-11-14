import tls from 'node:tls';
import nodemailer from '../../../server/node_modules/nodemailer/dist/cjs/nodemailer.js';
export function imapLogin(user, pass, localAddress = '127.0.0.5') {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port: 993, localAddress, rejectUnauthorized: false });
    let buf = '', sent = false;
    s.on('data', (d) => {
      buf += d;
      if (!sent && buf.includes('* OK')) { sent = true; s.write(`a1 LOGIN "${user}" "${pass}"\r\n`); }
      const m = buf.match(/a1 (OK|NO|BAD)([^\r\n]*)/);
      if (m) { s.end(); resolve(m[1] + m[2]); }
    });
    s.on('error', reject);
    setTimeout(() => { s.destroy(); resolve('TIMEOUT'); }, 30000);
  });
}
export async function smtpLogin(user, pass, localAddress = '127.0.0.5') {
  const t = nodemailer.createTransport({ host: '127.0.0.1', port: 465, secure: true, localAddress, tls: { rejectUnauthorized: false }, auth: { user, pass } });
  try { await t.verify(); return 'OK'; } catch (e) { return `FAIL ${e.responseCode || ''} ${(e.response || e.message).slice(0, 90)}`; }
}
if (process.argv[2] === 'run') {
  console.log('imap bad', await imapLogin('olivia@acme.com', 'wrong1'));
  console.log('imap good', await imapLogin('olivia@acme.com', 'password123'));
  console.log('smtp bad', await smtpLogin('olivia@acme.com', 'wrong2'));
  console.log('imap unknown user', await imapLogin('nobody@acme.com', 'x'));
}
