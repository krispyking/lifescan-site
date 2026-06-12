// Cloudflare Pages Function — POST /api/rui-submit
// Receives Rui's discovery interview answers → HubSpot contact + note, Slack alert.
// Secrets: HUBSPOT_TOKEN, SLACK_BOT_TOKEN, RESEND_API_KEY (optional)

const HUBSPOT_API   = 'https://api.hubapi.com';
const SLACK_CHANNEL = 'C0AS2HDNSJC'; // #proj-lifescan
const FROM_ADDRESS  = 'LifeScan <chris@lifescan.krispyking.com>';
const REPLY_TO      = ['lifescanai@gmail.com'];
const RESEND_API    = 'https://api.resend.com/emails';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

const QUESTIONS = {
  q1_1: 'How does your department currently receive and queue radiology studies? What does a typical day look like?',
  q1_2: 'Where do you see the biggest bottlenecks — triage, reporting, or follow-up?',
  q1_3: 'Have you evaluated or deployed any AI diagnostic tools? What was your experience?',
  q2_1: 'What would it take for you to trust an AI tool enough to use it in a clinical setting?',
  q2_2: 'Who in your organisation has to sign off before an AI tool is used — and what evidence do they require?',
  q2_3: 'Have you ever seen an AI tool perform differently in your environment than the vendor claimed?',
  q3_1: 'When you adopt a new AI tool, who currently runs the validation study?',
  q3_2: 'What is your current process for monitoring AI performance over time once deployed?',
  q3_3: 'Would having independent, regulatory-grade validation change your confidence in deploying AI tools?',
  q4_1: 'What is the typical budget cycle for new clinical software in your department?',
  q4_2: 'Is procurement driven from the radiology department, IT, or hospital administration?',
  q4_3: 'What would make LifeScan AI easy — or hard — to bring to your procurement team?',
  q5_1: 'How does the HKHA regulatory environment affect your decisions around AI adoption?',
  q5_2: 'Are there APAC-specific patient population differences that concern you when evaluating AI tools trained on Western datasets?',
  q5_3: 'Which other hospitals or departments in HK / APAC are you aware of that are actively deploying radiology AI?',
  q6_1: "What's missing from the LifeScan AI concept as you understand it?",
  q6_2: 'What would make this a must-have vs a nice-to-have for your department?',
  q6_3: 'Who else should we be talking to?',
};

const SECTIONS = [
  { title: 'Section 1: Clinical Workflow',          keys: ['q1_1','q1_2','q1_3'] },
  { title: 'Section 2: AI Validation & Trust',      keys: ['q2_1','q2_2','q2_3'] },
  { title: 'Section 3: The Validation Problem',     keys: ['q3_1','q3_2','q3_3'] },
  { title: 'Section 4: Procurement & Priorities',   keys: ['q4_1','q4_2','q4_3'] },
  { title: 'Section 5: APAC & HK Specifics',        keys: ['q5_1','q5_2','q5_3'] },
  { title: 'Section 6: Open Feedback',              keys: ['q6_1','q6_2','q6_3'] },
];

function buildNoteBody(p) {
  const lines = [
    `LifeScan AI — Discovery Interview`,
    `Respondent: ${p.full_name || '—'} | ${p.job_title || '—'} | ${p.organisation || '—'}`,
    `Email: ${p.email}`,
    `Submitted: ${new Date().toUTCString()}`,
    '',
  ];
  for (const sec of SECTIONS) {
    lines.push(`── ${sec.title} ──`);
    for (const k of sec.keys) {
      const answer = (p[k] || '').trim();
      lines.push(`Q: ${QUESTIONS[k]}`);
      lines.push(`A: ${answer || '(no answer)'}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

async function upsertHubSpotContact(token, { email, full_name, job_title, organisation }) {
  const parts = (full_name || '').trim().split(/\s+/);
  const properties = {
    email,
    firstname:  parts[0] || full_name || '',
    lastname:   parts.slice(1).join(' ') || '',
    jobtitle:   job_title  || '',
    company:    organisation || '',
    hs_lead_status: 'IN_PROGRESS',
    lifecyclestage: 'lead',
  };

  // Try create first
  const createResp = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties }),
  });

  if (createResp.ok) {
    const c = await createResp.json();
    return { ok: true, id: c.id, created: true };
  }

  // 409 = already exists — look it up by email
  if (createResp.status === 409) {
    const searchResp = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts/search`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties: ['email'],
        limit: 1,
      }),
    });
    if (searchResp.ok) {
      const s = await searchResp.json();
      const existingId = s.results?.[0]?.id;
      if (existingId) return { ok: true, id: existingId, created: false };
    }
  }

  const errText = await createResp.text().catch(() => '');
  console.error('[HubSpot contact] failed:', createResp.status, errText);
  return { ok: false };
}

async function createHubSpotNote(token, contactId, noteBody) {
  // Create note
  const noteResp = await fetch(`${HUBSPOT_API}/crm/v3/objects/notes`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: {
        hs_note_body:  noteBody,
        hs_timestamp:  Date.now().toString(),
      },
    }),
  });

  if (!noteResp.ok) {
    console.error('[HubSpot note] create failed:', noteResp.status, await noteResp.text().catch(() => ''));
    return { ok: false };
  }

  const note = await noteResp.json();
  const noteId = note.id;

  // Associate note → contact (associationTypeId 202 = note-to-contact)
  const assocResp = await fetch(
    `${HUBSPOT_API}/crm/v4/objects/notes/${noteId}/associations/contacts/${contactId}`,
    {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }]),
    }
  );

  if (!assocResp.ok) {
    console.error('[HubSpot assoc] failed:', assocResp.status, await assocResp.text().catch(() => ''));
  }

  return { ok: true, noteId };
}

async function notifySlack(token, { full_name, job_title, organisation, email, answeredCount }) {
  const text = [
    `📋 *LifeScan Discovery Interview — Rui submitted*`,
    `*Name:* ${full_name || '—'} | *Title:* ${job_title || '—'}`,
    `*Organisation:* ${organisation || '—'} | *Email:* ${email}`,
    `*Questions answered:* ${answeredCount} / 18`,
  ].join('\n');

  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text, unfurl_links: false }),
  });
  const d = await resp.json();
  if (!d.ok) console.error('[Slack] failed:', d.error);
  return d;
}

async function sendConfirmation(resendKey, { email, full_name }) {
  const firstname = (full_name || '').split(' ')[0] || 'there';
  const html = `<!DOCTYPE html><html><body style="font-family:Georgia,serif;color:#1C2B36;background:#F8FAFB;margin:0;padding:0">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="background:#0B6E6E;padding:24px">
<span style="color:#fff;font-weight:700;font-size:20px;font-family:Arial,sans-serif">LifeScan AI</span></td></tr>
<tr><td align="center"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:1px solid #E4ECF3;border-top:none;border-radius:0 0 12px 12px">
<tr><td style="padding:36px 40px;font-size:16px;line-height:1.75">
<p>Hi ${firstname},</p>
<p>Thank you for taking the time to share your thoughts. Chris will read your answers personally and follow up within 24 hours.</p>
<p>If you'd like to add anything or have questions in the meantime, just reply to this email.</p>
<p style="margin-top:32px;padding-top:24px;border-top:1px solid #E4ECF3;font-size:14px;color:#5A6B7A">
Chris Ransford<br>Founder, LifeScan AI · <a href="https://lifescan.krispyking.com" style="color:#0B6E6E">lifescan.krispyking.com</a>
</p></td></tr></table></td></tr></table></body></html>`;

  const resp = await fetch(RESEND_API, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      reply_to: REPLY_TO,
      to: [email],
      subject: 'Got your answers — Chris will be in touch',
      html,
    }),
  });
  if (!resp.ok) console.error('[Resend confirm] failed:', resp.status, await resp.text().catch(() => ''));
  return { ok: resp.ok };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function onRequestPost({ request, env }) {
  if (!env.HUBSPOT_TOKEN) {
    return json({ error: 'Submission endpoint not configured. Please email lifescanai@gmail.com directly.' }, 503);
  }

  let p;
  try { p = await request.json(); } catch (_) { return json({ error: 'Invalid request.' }, 400); }

  const email        = ((p.email        || '').toString().trim()).slice(0, 200);
  const full_name    = ((p.full_name    || '').toString().trim()).slice(0, 120);
  const job_title    = ((p.job_title    || '').toString().trim()).slice(0, 120);
  const organisation = ((p.organisation || '').toString().trim()).slice(0, 200);

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: 'A valid email is required.' }, 400);
  }

  // Sanitise all question answers
  const answers = {};
  for (const k of Object.keys(QUESTIONS)) {
    answers[k] = ((p[k] || '').toString().trim()).slice(0, 2000);
  }

  const answeredCount = Object.values(answers).filter(v => v.length > 0).length;
  const noteBody = buildNoteBody({ email, full_name, job_title, organisation, ...answers });

  // HubSpot — blocking
  const contact = await upsertHubSpotContact(env.HUBSPOT_TOKEN, { email, full_name, job_title, organisation });
  if (!contact.ok) {
    return json({ error: 'Could not save your answers. Please email lifescanai@gmail.com directly.' }, 502);
  }

  // Note + Slack + Email — best-effort
  const tasks = [
    createHubSpotNote(env.HUBSPOT_TOKEN, contact.id, noteBody)
      .then(r => console.log('[HubSpot note]', JSON.stringify(r)))
      .catch(e => console.error('[HubSpot note]', e)),
  ];

  if (env.SLACK_BOT_TOKEN) tasks.push(
    notifySlack(env.SLACK_BOT_TOKEN, { full_name, job_title, organisation, email, answeredCount })
      .catch(e => console.error('[Slack]', e))
  );

  if (env.RESEND_API_KEY) tasks.push(
    sendConfirmation(env.RESEND_API_KEY, { email, full_name })
      .catch(e => console.error('[Resend confirm]', e))
  );

  Promise.all(tasks);

  return json({ ok: true, contactId: contact.id });
}
