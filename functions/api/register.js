// Cloudflare Pages Function — POST /api/register
// Saves early access registrations to Notion + HubSpot + sends Email 1 via Resend.
// Secrets (CF Pages): NOTION_TOKEN, HUBSPOT_TOKEN, RESEND_API_KEY

const NOTION_VERSION = '2022-06-28';
const NOTION_API = 'https://api.notion.com/v1';
const WORKSPACE_ID = '32028547-eaa7-8126-a69a-ed9edd706788';
const HUBSPOT_API = 'https://api.hubapi.com';
const RESEND_API = 'https://api.resend.com/emails';
const FROM_ADDRESS = 'LifeScan AI <noreply@eumeluuent.resend.app>';

const COUNTRIES = [
  'Hong Kong','Singapore','Australia','Thailand','Malaysia',
  'Philippines','Indonesia','Japan','South Korea','Taiwan','Other'
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function pushToHubSpot(token, { full_name, job_title, organisation, country, email, ai_tools }) {
  const nameParts = full_name.trim().split(/\s+/);
  const firstname = nameParts[0] || full_name;
  const lastname = nameParts.slice(1).join(' ') || '';
  const properties = {
    email, firstname, lastname,
    jobtitle: job_title,
    company: organisation,
    country,
    hs_lead_status: 'NEW',
    ...(ai_tools ? { message: `AI tools evaluating: ${ai_tools}` } : {}),
  };
  const resp = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties }),
  });
  if (!resp.ok) {
    if (resp.status === 409) return { ok: true, existing: true };
    console.error('[HubSpot] failed:', resp.status, await resp.text());
    return { ok: false };
  }
  return { ok: true, id: (await resp.json()).id };
}

async function sendEmail1(resendKey, { firstname, email }) {
  const html = `
<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#1C2B36;line-height:1.7">
  <p>Hi ${firstname},</p>
  <p>Thanks for registering with LifeScan — you're among the first radiologists and imaging leads in APAC to hear about what we're building.</p>
  <p>Here's the short version: LifeScan is a vendor-neutral AI validation layer for radiology departments. We don't replace your diagnostic AI tools — we verify that they're actually performing in your environment, on your patient population, at your standards.</p>
  <p>Most hospitals deploying AI imaging tools have no independent way to know if they're working. We fix that.</p>
  <p>Over the next week, I'll share a bit more about the problem we're solving and how we're thinking about the pilot programme.</p>
  <p>In the meantime — if you have questions or want to talk sooner, just reply to this email.</p>
  <p style="margin-top:32px">Chris Ransford<br>
  <span style="color:#5A6B7A;font-size:14px">Founder, LifeScan AI</span></p>
</div>`;

  const resp = await fetch(RESEND_API, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [email],
      subject: "You're registered — here's what happens next",
      html,
    }),
  });
  if (!resp.ok) {
    console.error('[Resend] Email 1 failed:', resp.status, await resp.text());
    return { ok: false };
  }
  return { ok: true, id: (await resp.json()).id };
}

export async function onRequestPost({ request, env }) {
  if (!env.NOTION_TOKEN) {
    return json({ error: 'Registration is not configured yet. Please email contact@lifescan.ai directly.' }, 503);
  }

  let p;
  try { p = await request.json(); } catch (_) { return json({ error: 'Invalid request.' }, 400); }

  const full_name    = (p.full_name    || '').toString().trim().slice(0, 120);
  const job_title    = (p.job_title    || '').toString().trim().slice(0, 120);
  const organisation = (p.organisation || '').toString().trim().slice(0, 200);
  const country      = COUNTRIES.includes(p.country) ? p.country : '';
  const email        = (p.email        || '').toString().trim().slice(0, 200);
  const ai_tools     = (p.ai_tools     || '').toString().trim().slice(0, 500);
  const challenge    = (p.challenge    || '').toString().trim().slice(0, 1000);

  if (!full_name)    return json({ error: 'Full name is required.' }, 400);
  if (!job_title)    return json({ error: 'Job title is required.' }, 400);
  if (!organisation) return json({ error: 'Organisation is required.' }, 400);
  if (!country)      return json({ error: 'Please select a country.' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'A valid work email is required.' }, 400);

  const firstname = full_name.trim().split(/\s+/)[0] || full_name;
  const now = new Date().toISOString();
  const pageTitle = `Registration: ${full_name} — ${organisation} (${country})`;

  // ── Notion ──────────────────────────────────────────────────────────────────
  const notionBody = {
    parent: { type: 'page_id', page_id: WORKSPACE_ID },
    properties: { title: { title: [{ text: { content: pageTitle } }] } },
    children: [
      {
        object: 'block', type: 'callout',
        callout: {
          icon: { type: 'emoji', emoji: '📋' },
          color: 'blue_background',
          rich_text: [{ type: 'text', text: { content: 'Early Access Registration — LifeScan AI' } }],
        },
      },
      tableBlock('Registration Details', [
        ['Field', 'Value'],
        ['Full Name', full_name],
        ['Job Title', job_title],
        ['Organisation', organisation],
        ['Country', country],
        ['Email', email],
        ['AI Tools Evaluating', ai_tools || '—'],
        ['Submitted', now],
      ]),
      ...(challenge ? [
        { object: 'block', type: 'heading_3', heading_3: { rich_text: [{ text: { content: 'Biggest Radiology AI Challenge' } }] } },
        { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: challenge } }] } },
      ] : []),
    ],
  };

  const notionResp = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(notionBody),
  });

  if (!notionResp.ok) {
    console.error('[Notion] failed:', await notionResp.text());
    return json({ error: 'Registration could not be saved. Please email contact@lifescan.ai directly.' }, 502);
  }

  // ── HubSpot + Resend Email 1 (best-effort, never block the registration) ────
  const tasks = [];
  if (env.HUBSPOT_TOKEN) {
    tasks.push(
      pushToHubSpot(env.HUBSPOT_TOKEN, { full_name, job_title, organisation, country, email, ai_tools })
        .then(r => console.log('[HubSpot]', JSON.stringify(r)))
        .catch(e => console.error('[HubSpot] unexpected:', e))
    );
  }
  if (env.RESEND_API_KEY) {
    tasks.push(
      sendEmail1(env.RESEND_API_KEY, { firstname, email })
        .then(r => console.log('[Resend Email 1]', JSON.stringify(r)))
        .catch(e => console.error('[Resend Email 1] unexpected:', e))
    );
  }
  // Fire both in parallel, don't await — registration response is instant
  Promise.all(tasks);

  return json({ ok: true, message: 'Registration received. We will be in touch soon.' });
}

function tableBlock(heading, rows) {
  return {
    object: 'block', type: 'table',
    table: {
      table_width: 2, has_column_header: true, has_row_header: false,
      children: rows.map((row, i) => ({
        object: 'block', type: 'table_row',
        table_row: {
          cells: row.map(cell => [{ type: 'text', text: { content: cell }, annotations: i === 0 ? { bold: true } : {} }]),
        },
      })),
    },
  };
}
