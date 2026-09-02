// A stand-in for a document locker, so a need can be proved instead of claimed.
//
// khaali's lower-berth rule seats a traveller who needs a lower berth ahead of
// one who merely wants it. Until now the need was a chip you ticked, which
// means the rule rested on everyone being honest. This module is the demo
// answer: the traveller's own locker holds the documents, khaali asks it two
// questions, and the traveller has to say yes on their own device.
//
// This is NOT DigiLocker, is not connected to it, and must never be dressed up
// to look like it. It is khaali's own consent screen standing in for one, in
// the same way `pay.html` stands in for a bank. Nothing here accepts a real
// Aadhaar number, a real PAN or a real OTP, and the fixtures below are
// invented.
//
// The one design rule, and the point of the whole thing: khaali asks for the
// ANSWER, not the document. Two things come back - a date of birth, and
// whether a priority certificate exists. The Aadhaar number, the PAN, the
// address and the documents themselves never leave the locker, and
// `shareOf()` below is what guarantees it.

export const CONSENT_MS = 300000;             // five minutes to answer, like a hold

/**
 * The demo lockers. `id` numbers are invented and deliberately shown masked,
 * the way a real locker shows them; nothing here is or resembles a real
 * Aadhaar or PAN.
 */
export const VAULT = {
  'Pranav': {
    dob: '2003-06-14', aadhaar: 'xxxx xxxx 7412', pan: 'BQRPP4417K',
    docs: [
      { kind: 'licence', label: 'Driving licence', issuer: 'Transport Dept, Karnataka', no: 'KA-05 2022 xxxx41' },
      { kind: 'education', label: 'Degree certificate', issuer: 'Bengaluru University', no: 'BU/2024/xxxx09' },
    ],
  },
  'Varun': {
    dob: '2001-11-02', aadhaar: 'xxxx xxxx 2260', pan: 'AKMPV9031C',
    docs: [
      { kind: 'licence', label: 'Driving licence', issuer: 'Transport Dept, Karnataka', no: 'KA-03 2021 xxxx77' },
      { kind: 'education', label: 'Class XII certificate', issuer: 'CBSE', no: 'CBSE/2019/xxxx14' },
    ],
  },
  'Achina': {
    dob: '2006-02-19', aadhaar: 'xxxx xxxx 5083', pan: 'CJHPA2288L',
    docs: [
      { kind: 'education', label: 'Class XII certificate', issuer: 'CBSE', no: 'CBSE/2024/xxxx62' },
      { kind: 'education', label: 'College enrolment card', issuer: 'Mount Carmel College', no: 'MCC/2024/xxxx18' },
    ],
  },
  'Martin': {
    dob: '1988-09-30', aadhaar: 'xxxx xxxx 1974', pan: 'DLTPM6642H',
    docs: [
      { kind: 'licence', label: 'Driving licence', issuer: 'Transport Dept, Karnataka', no: 'KA-01 2011 xxxx03' },
      { kind: 'vehicle', label: 'Vehicle registration', issuer: 'Transport Dept, Karnataka', no: 'KA-01-MJ-xxxx' },
    ],
  },
  'Sam Altman': {
    dob: '1958-03-11', aadhaar: 'xxxx xxxx 6690', pan: 'EYVPS1157B',
    docs: [
      { kind: 'pension', label: 'Pension payment order', issuer: 'Central Pension Accounting Office', no: 'CPAO/xxxx58' },
      { kind: 'licence', label: 'Driving licence', issuer: 'Transport Dept, Karnataka', no: 'KA-02 1984 xxxx26' },
    ],
  },
  'Meowy Mayya': {
    dob: '1997-07-25', aadhaar: 'xxxx xxxx 3348', pan: 'FRDPM8804J',
    docs: [
      { kind: 'expecting', label: 'Antenatal care card', issuer: 'Health & Family Welfare', no: 'ANC/2026/xxxx31' },
      { kind: 'education', label: 'Degree certificate', issuer: 'Christ University', no: 'CU/2019/xxxx55' },
    ],
  },
};

/** Every locker as the locker's own page shows it: documents and all. */
export function profiles(iso) {
  return Object.keys(VAULT).map(name => {
    const h = VAULT[name];
    const s = shareOf(h, iso);
    return {
      name, dob: h.dob, age: s.age, need: s.need,
      documents: [
        { kind: 'aadhaar', label: 'Aadhaar', issuer: 'UIDAI', no: h.aadhaar },
        { kind: 'pan', label: 'PAN card', issuer: 'Income Tax Department', no: h.pan },
        ...(h.docs || []).map(d => ({ kind: d.kind, label: d.label, issuer: d.issuer, no: d.no || '' })),
      ],
      // the only two answers khaali is ever offered from this locker
      offers: { dob: h.dob, need: s.need,
        certificate: s.certificate ? s.certificate.label : null },
    };
  });
}

export const holderOf = name => VAULT[String(name || '').trim()] || null;

/** Age on a date, from a date of birth. The locker does this, not khaali. */
export function ageOn(dob, iso) {
  const d = new Date(dob + 'T00:00:00'), on = new Date(iso + 'T00:00:00');
  if (isNaN(d) || isNaN(on)) return null;
  let a = on.getFullYear() - d.getFullYear();
  if (on.getMonth() < d.getMonth() || (on.getMonth() === d.getMonth() && on.getDate() < d.getDate())) a--;
  return a;
}

/**
 * Exactly what leaves the locker, and nothing else. A date of birth, the
 * priority certificate's kind if one exists, and its issuer so the traveller
 * can see what was read. No identifier, no document, no address.
 */
export function shareOf(h, iso) {
  const doc = (h.docs || []).find(d => d.kind === 'disabled' || d.kind === 'expecting') || null;
  const age = ageOn(h.dob, iso);
  return {
    dob: h.dob,
    age,
    need: age != null && age >= 60 ? 'senior' : (doc ? doc.kind : null),
    certificate: doc ? { label: doc.label, issuer: doc.issuer } : null,
  };
}

/** What the consent screen shows before anyone agrees to anything. */
export function askOf(h, iso) {
  return {
    holds: [
      { label: 'Aadhaar', value: h.aadhaar },
      { label: 'PAN', value: h.pan },
      ...(h.docs || []).map(d => ({ label: d.label, value: d.issuer })),
    ],
    wants: [
      'Date of birth, to work out age on ' + iso,
      'Whether a certificate giving lower-berth priority exists',
    ],
    never: ['The Aadhaar number', 'The PAN', 'The documents themselves', 'Any address'],
  };
}

// --------------------------------------------------------- signing in --
// The locker's own sign-in. In the real world the code arrives by SMS; here
// it is generated and handed straight back so the page can print it, because
// a demo that asked for a code sent to a real phone would be indistinguishable
// from a phishing page. Nothing here takes a real Aadhaar number or a real OTP.

export const OTP_MS = 300000;                 // the code is good for five minutes
export const OTP_TRIES = 5;

/** A six digit code, and the session waiting for it. */
export function newSignIn({ id, code }, now = Date.now()) {
  const c = /^\d{6}$/.test(String(code || '')) ? String(code) : null;
  if (!c) return { ok: false, reason: 'bad-code' };
  return { ok: true, session: {
    id, code: c, status: 'sent', tries: 0, createdAt: now, expiresAt: now + OTP_MS,
  } };
}

/**
 * Check a code. Wrong codes are counted and the session dies after five, an
 * expired session is dead whatever the code, and a code works exactly once.
 */
export function verify(s, code, now = Date.now()) {
  if (!s) return { ok: false, reason: 'missing' };
  if (s.status === 'open') return { ok: true, already: true };
  if (s.status !== 'sent') return { ok: false, reason: s.status };
  if (now > s.expiresAt) { s.status = 'expired'; return { ok: false, reason: 'expired' }; }
  if (String(code || '') !== s.code) {
    s.tries++;
    if (s.tries >= OTP_TRIES) { s.status = 'locked'; return { ok: false, reason: 'locked' }; }
    return { ok: false, reason: 'wrong', left: OTP_TRIES - s.tries };
  }
  s.status = 'open'; s.openedAt = now;
  return { ok: true };
}

export const signedIn = (s, now = Date.now()) =>
  !!s && s.status === 'open' && now < s.openedAt + 3600000;   // an hour inside the locker

/** A request for consent. Nothing is read until the holder allows it. */
export function newConsent({ id, who, name, date }, now = Date.now()) {
  const h = holderOf(name);
  if (!h) return { ok: false, reason: 'unknown-holder' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { ok: false, reason: 'bad-date' };
  return { ok: true, consent: {
    id, who, name: String(name).trim(), date, status: 'pending',
    createdAt: now, expiresAt: now + CONSENT_MS, share: null,
  } };
}

export const expired = (c, now = Date.now()) => !!c && c.status === 'pending' && now > c.expiresAt;

/** The holder said yes on their own device. Only now is anything read. */
export function allow(c, now = Date.now()) {
  if (!c) return { ok: false, reason: 'missing' };
  if (c.status !== 'pending') return { ok: false, reason: c.status };
  if (now > c.expiresAt) { c.status = 'expired'; return { ok: false, reason: 'expired' }; }
  const h = holderOf(c.name);
  if (!h) return { ok: false, reason: 'unknown-holder' };
  c.status = 'allowed';
  c.answeredAt = now;
  c.share = shareOf(h, c.date);
  return { ok: true, share: c.share };
}

/** The holder said no. Nothing was read, and nothing is kept. */
export function decline(c, now = Date.now()) {
  if (!c) return { ok: false, reason: 'missing' };
  if (c.status !== 'pending') return { ok: false, reason: c.status };
  c.status = 'declined'; c.answeredAt = now; c.share = null;
  return { ok: true };
}

/** The consent as the phone and the app are allowed to see it. */
export function publicOf(c, now = Date.now()) {
  if (!c) return null;
  const h = holderOf(c.name);
  const status = expired(c, now) ? 'expired' : c.status;
  return {
    id: c.id, name: c.name, date: c.date, status,
    msLeft: Math.max(0, c.expiresAt - now),
    ask: h ? askOf(h, c.date) : null,
    share: status === 'allowed' ? c.share : null,
  };
}
