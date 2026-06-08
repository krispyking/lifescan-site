// Cloudflare Pages Function — POST /api/register
// Saves registrations to Notion + HubSpot, sends Email 1, alerts Slack.
// Secrets: NOTION_TOKEN, HUBSPOT_TOKEN, RESEND_API_KEY, SLACK_BOT_TOKEN

const NOTION_VERSION = '2022-06-28';
const NOTION_API     = 'https://api.notion.com/v1';
const WORKSPACE_ID   = '32028547-eaa7-8126-a69a-ed9edd706788';
const HUBSPOT_API    = 'https://api.hubapi.com';
const RESEND_API     = 'https://api.resend.com/emails';
const SLACK_CHANNEL  = 'C0AS2HDNSJC'; // #proj-lifescan
const FROM_ADDRESS   = 'LifeScan <chris@lifescan.krispyking.com>';
const REPLY_TO       = ['lifescanai@gmail.com'];

const COUNTRIES = [
  'Hong Kong','Singapore','Australia','Thailand','Malaysia',
  'Philippines','Indonesia','Japan','South Korea','Taiwan','Other'
];

// ── Email template ───────────────────────────────────────────────────────────

function emailWrap(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F8FAFB">

<!-- Header -->
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0B6E6E">
  <tr><td align="center" style="padding:28px 24px">
    <table cellpadding="0" cellspacing="0" border="0">
      <tr><td align="center">
        <span style="color:#fff;font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:22px;letter-spacing:-0.02em">LifeScan AI</span>
      </td></tr>
      <tr><td align="center" style="padding-top:6px">
        <span style="color:rgba(255,255,255,0.65);font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:0.08em;text-transform:uppercase">Know your AI works</span>
      </td></tr>
    </table>
  </td></tr>
</table>

<!-- Body -->
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F8FAFB">
  <tr><td align="center" style="padding:0 16px">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #E4ECF3;border-top:none;border-radius:0 0 12px 12px">
      <tr><td style="padding:36px 40px;color:#1C2B36;font-family:Georgia,serif;font-size:16px;line-height:1.75">
        ${bodyHtml}
      </td></tr>
    </table>
  </td></tr>
</table>

<!-- Footer -->
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td align="center" style="padding:24px 16px">
    <table cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
      <tr><td align="center" style="color:#8A9BB0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.8">
        <span>LifeScan AI &nbsp;·&nbsp; <a href="https://lifescan.krispyking.com" style="color:#0B6E6E;text-decoration:none">lifescan.krispyking.com</a></span><br>
        <span>You're receiving this because you registered at lifescan.krispyking.com.</span><br>
        <a href="mailto:lifescanai@gmail.com?subject=Unsubscribe&body=Please remove me from LifeScan AI emails." style="color:#0B6E6E">Unsubscribe</a>
      </td></tr>
    </table>
  </td></tr>
</table>

</body></html>`;
}

function sig() {
  return `<p style="margin:32px 0 0;padding-top:24px;border-top:1px solid #E4ECF3;font-size:15px">
    Chris Ransford<br>
    <span style="color:#5A6B7A;font-size:14px">Founder, LifeScan AI &nbsp;·&nbsp; <a href="https://lifescan.krispyking.com" style="color:#0B6E6E;text-decoration:none">lifescan.krispyking.com</a></span>
  </p>`;
}

function email1Html(firstname) {
  return emailWrap(`
    <p style="margin:0 0 18px">Hi ${firstname},</p>
    <p style="margin:0 0 18px">Thanks for registering with LifeScan — you're among the first radiologists and imaging leads in APAC to hear about what we're building.</p>
    <p style="margin:0 0 18px">Here's the short version: LifeScan is a vendor-neutral AI validation layer for radiology departments. We don't replace your diagnostic AI tools — we verify that they're actually performing in your environment, on your patient population, at your standards.</p>
    <p style="margin:0 0 18px">Most hospitals deploying AI imaging tools have no independent way to know if they're working. We fix that.</p>
    <p style="margin:0 0 0">Over the next week, I'll share a bit more about the problem we're solving and how we're thinking about the pilot programme. In the meantime — if you have questions or want to talk sooner, just reply to this email.</p>
    ${sig()}
  `);
}

// ── Integrations ─────────────────────────────────────────────────────────────

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function pushToHubSpot(token, { full_name, job_title, organisation, country, email, ai_tools }) {
  const parts = full_name.trim().split(/\s+/);
  const properties = {
    email,
    firstname: parts[0] || full_name,
    lastname:  parts.slice(1).join(' ') || '',
    jobtitle:  job_title,
    company:   organisation,
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
  const resp = await fetch(RESEND_API, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      reply_to: REPLY_TO,
      to: [email],
      subject: "You're registered — here's what happens next",
      html: email1Html(firstname),
    }),
  });
  if (!resp.ok) {
    console.error('[Resend Email 1] failed:', resp.status, await resp.text());
    return { ok: false };
  }
  return { ok: true, id: (await resp.json()).id };
}

async function notifySlack(token, { full_name, job_title, organisation, country, email }) {
  const text = `🔔 *New LifeScan Registration*\n*Name:* ${full_name}\n*Title:* ${job_title}\n*Organisation:* ${organisation}\n*Country:* ${country}\n*Email:* ${email}`;
  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text, unfurl_links: false }),
  });
  const data = await resp.json();
  if (!data.ok) console.error('[Slack] failed:', data.error);
  return data;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function onRequestPost({ request, env }) {
  if (!env.NOTION_TOKEN) {
    return json({ error: 'Registration is not configured yet. Please email lifescanai@gmail.com directly.' }, 503);
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
  const now       = new Date().toISOString();
  const pageTitle = `Registration: ${full_name} — ${organisation} (${country})`;

  // ── Notion (blocking — if this fails we return an error) ───────────────────
  const notionBody = {
    parent: { type: 'page_id', page_id: WORKSPACE_ID },
    properties: { title: { title: [{ text: { content: pageTitle } }] } },
    children: [
      { object: 'block', type: 'callout', callout: {
          icon: { type: 'emoji', emoji: '📋' }, color: 'blue_background',
          rich_text: [{ type: 'text', text: { content: 'Early Access Registration — LifeScan AI' } }],
      }},
      tableBlock([
        ['Field',              'Value'],
        ['Full Name',          full_name],
        ['Job Title',          job_title],
        ['Organisation',       organisation],
        ['Country',            country],
        ['Email',              email],
        ['AI Tools Evaluating', ai_tools || '—'],
        ['Submitted',          now],
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
    return json({ error: 'Registration could not be saved. Please email lifescanai@gmail.com directly.' }, 502);
  }

  // ── HubSpot + Email 1 + Slack (all best-effort, fire-and-forget) ───────────
  const tasks = [];

  if (env.HUBSPOT_TOKEN) tasks.push(
    pushToHubSpot(env.HUBSPOT_TOKEN, { full_name, job_title, organisation, country, email, ai_tools })
      .then(r => console.log('[HubSpot]', JSON.stringify(r)))
      .catch(e => console.error('[HubSpot]', e))
  );

  if (env.RESEND_API_KEY) tasks.push(
    sendEmail1(env.RESEND_API_KEY, { firstname, email })
      .then(r => console.log('[Resend Email 1]', JSON.stringify(r)))
      .catch(e => console.error('[Resend Email 1]', e))
  );

  if (env.SLACK_BOT_TOKEN) tasks.push(
    notifySlack(env.SLACK_BOT_TOKEN, { full_name, job_title, organisation, country, email })
      .then(r => console.log('[Slack]', r.ok ? 'sent' : r.error))
      .catch(e => console.error('[Slack]', e))
  );

  Promise.all(tasks);

  return json({ ok: true, message: 'Registration received. We will be in touch soon.' });
}

function tableBlock(rows) {
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
