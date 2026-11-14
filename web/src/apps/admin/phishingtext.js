// Words for Admin → Phishing.

/** A warning for everyone about a reported sender, short enough for an announcement (300 characters): the subject goes first if it's too long. */
export function warningText(g) {
  const say = (subject) => `⚠ Phishing: emails from ${g.sender}${subject} are a scam. Don't click their links, open their attachments or reply: use Report phishing in Mail.`;
  const s = g.subjects[0] ? ` (“${g.subjects[0].length > 80 ? `${g.subjects[0].slice(0, 79)}…` : g.subjects[0]}”)` : '';
  const text = say(s);
  return text.length <= 300 ? text : say('').slice(0, 300);
}
