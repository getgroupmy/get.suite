// Forms to start from (New form → a template): the questions and settings for everyday forms, which
// people then change as they like. Questions are cleaned like any others when the form is made.

const opts = (...o) => o;
let n = 0;
const qid = () => `t${++n}`;

export const FORM_TEMPLATES = [
  {
    id: 'event', title: 'Event sign-up', blurb: 'Who is coming, which session, and any dietary needs',
    description: 'Let us know you are coming. Places in each session are limited.',
    confirmation: 'Thanks, you are signed up. See you there!',
    settings: { one_per_person: true },
    questions: [
      { id: qid(), type: 'short', title: 'Your name', required: true },
      { id: qid(), type: 'choice', title: 'Which session?', options: opts('Morning (9:00–12:00)', 'Afternoon (13:00–16:00)'), required: true, limits: { 'Morning (9:00–12:00)': 30, 'Afternoon (13:00–16:00)': 30 } },
      { id: qid(), type: 'checkbox', title: 'Dietary needs', options: opts('Vegetarian', 'Vegan', 'Gluten-free'), other: true },
      { id: qid(), type: 'paragraph', title: 'Anything else we should know?' },
    ],
  },
  {
    id: 'feedback', title: 'Feedback survey', blurb: 'A rating, what went well and what to improve',
    description: 'Tell us how it went. It takes two minutes.',
    confirmation: 'Thank you for your feedback.',
    questions: [
      { id: qid(), type: 'rating', title: 'Overall, how was it?', max: 5, icon: 'star', required: true },
      { id: qid(), type: 'scale', title: 'How likely are you to recommend us to a colleague?', max: 10, low: 'Not likely', high: 'Very likely' },
      { id: qid(), type: 'paragraph', title: 'What went well?' },
      { id: qid(), type: 'paragraph', title: 'What could we do better?' },
    ],
  },
  {
    id: 'rsvp', title: 'RSVP', blurb: 'Yes, no or maybe, and how many are coming',
    description: 'Please reply by the date on the invitation.',
    confirmation: 'Thanks for letting us know.',
    settings: { one_per_person: true },
    questions: [
      { id: qid(), type: 'short', title: 'Your name', required: true },
      { id: qid(), type: 'choice', title: 'Will you come?', options: opts('Yes', 'No', 'Maybe'), required: true },
      { id: qid(), type: 'dropdown', title: 'How many of you?', options: opts('1', '2', '3', '4', '5 or more') },
      { id: qid(), type: 'paragraph', title: 'A note for the host' },
    ],
  },
  {
    id: 'contact', title: 'Contact details', blurb: 'Name, email, phone and how they prefer to be reached',
    description: 'Please keep your details up to date.',
    questions: [
      { id: qid(), type: 'short', title: 'Full name', required: true },
      { id: qid(), type: 'short', title: 'Email address', required: true, check: { kind: 'text', op: 'email' } },
      { id: qid(), type: 'short', title: 'Phone number' },
      { id: qid(), type: 'choice', title: 'Best way to reach you', options: opts('Email', 'Phone', 'Either') },
    ],
  },
  {
    id: 'job', title: 'Job application', blurb: 'The role, experience, a CV upload and when they could start',
    description: 'Thank you for your interest in working with us.',
    confirmation: 'Your application has been received. We will be in touch.',
    questions: [
      { id: qid(), type: 'short', title: 'Full name', required: true },
      { id: qid(), type: 'short', title: 'Email address', required: true, check: { kind: 'text', op: 'email' } },
      { id: qid(), type: 'dropdown', title: 'Which role?', options: opts('Role 1', 'Role 2'), required: true },
      { id: qid(), type: 'paragraph', title: 'Tell us about your experience' },
      { id: qid(), type: 'file', title: 'Your CV', max_files: 1, required: true },
      { id: qid(), type: 'date', title: 'When could you start?' },
    ],
  },
  {
    id: 'quiz', title: 'Quiz', blurb: 'Scored questions with the right answers set',
    description: 'Answer every question. Your score is shown at the end.',
    settings: { quiz: true, show_score: true },
    questions: [
      { id: qid(), type: 'short', title: 'Your name', required: true },
      { id: qid(), type: 'choice', title: 'Question 1: what is 7 × 8?', options: opts('54', '56', '58'), answer: '56', points: 1, required: true },
      { id: qid(), type: 'checkbox', title: 'Question 2: which are prime numbers?', options: opts('2', '9', '11', '15'), answer: ['2', '11'], points: 2 },
      { id: qid(), type: 'short', title: 'Question 3: the capital of France', answer: 'Paris', points: 1 },
    ],
  },
  {
    id: 'timeoff', title: 'Time off request', blurb: 'Dates, the kind of leave and who covers',
    description: 'Ask for time off. Your manager will reply.',
    confirmation: 'Your request has been sent.',
    questions: [
      { id: qid(), type: 'short', title: 'Your name', required: true },
      { id: qid(), type: 'choice', title: 'Kind of leave', options: opts('Holiday', 'Sick leave', 'Personal'), other: true, required: true },
      { id: qid(), type: 'date', title: 'First day off', required: true },
      { id: qid(), type: 'date', title: 'Last day off', required: true },
      { id: qid(), type: 'short', title: 'Who covers for you?' },
    ],
  },
  {
    id: 'order', title: 'Order form', blurb: 'What and how many, delivery and a note',
    description: 'Place an order. We will confirm by email.',
    confirmation: 'Thanks, your order has been placed.',
    questions: [
      { id: qid(), type: 'short', title: 'Your name', required: true },
      { id: qid(), type: 'short', title: 'Email address', required: true, check: { kind: 'text', op: 'email' } },
      { id: qid(), type: 'grid', title: 'How many of each?', rows: ['Item 1', 'Item 2', 'Item 3'], columns: ['0', '1', '2', '3', '4+'] },
      { id: qid(), type: 'choice', title: 'Delivery', options: opts('Collect', 'Deliver to me'), required: true },
      { id: qid(), type: 'paragraph', title: 'Delivery address or a note' },
    ],
  },
];

export const templateById = (id) => FORM_TEMPLATES.find((t) => t.id === id) || null;
/** What the gallery shows. */
export const templateList = () => FORM_TEMPLATES.map((t) => ({ id: t.id, title: t.title, blurb: t.blurb, questions: t.questions.length, ...(t.settings?.quiz && { quiz: true }) }));
