import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentRisk } from '../src/mail/paymentrisk.js';

test('asks to pay somewhere new: changed bank details, urgent transfers, gift cards (English and Malay)', () => {
  const yes = [
    ['bank', { subject: 'Updated bank details', text: 'Please use the account below.' }],
    ['bank', { text: 'Our banking details have been changed. Kindly pay the attached invoice to our new account.' }],
    ['bank', { text: 'Please note the change of our bank account information from today.' }],
    ['bank', { text: 'Make payments into this new account from now on.' }],
    ['bank', { text: 'Please change the bank details we pay into.' }],
    ['bank', { text: 'Sila ambil maklum, akaun bank baru kami seperti di bawah.' }],
    ['bank', { text: 'Terdapat pertukaran akaun bank syarikat kami.' }],
    ['transfer', { text: 'I need you to process a wire transfer today, it is urgent.' }],
    ['transfer', { text: 'Urgently arrange a bank transfer of RM 48,000 to the supplier.' }],
    ['transfer', { text: 'Sila buat pindahan wang segera hari ini.'.replace('segera hari ini', 'hari ini untuk pemindahan dana') }],
    ['giftcards', { text: 'Can you buy 5 Google Play gift cards for a client? Scratch the codes and send me a photo.' }],
  ];
  for (const [kind, mail] of yes) assert.equal(paymentRisk(mail), kind, JSON.stringify(mail));
});

test('ordinary mail about money isn’t flagged', () => {
  for (const mail of [
    { subject: 'Invoice 1043', text: 'Please find attached our invoice for October. Payment terms 30 days.' },
    { text: 'Thanks, we received your bank transfer yesterday.' },
    { text: 'Our bank details are on the invoice as usual.' },
    { text: 'Happy birthday! Here is a gift card from the team.' },
    { text: 'The new account manager for your region is Kim.' },
    {},
  ]) assert.equal(paymentRisk(mail), null, JSON.stringify(mail));
});
