// Cloudflare Pages Function — POST /api/register
// Saves early access registrations to Notion + HubSpot.
// Secrets (CF Pages): NOTION_TOKEN, HUBSPOT_TOKEN
// HubSpot private app needs scopes: crm.objects.contacts.write

const NOTION_VERSION = '2022-06-28';
const NOTION_API = 'https://api.notion.com/v1';
const WORKSPACE_ID = '32028547-eaa7-8126-a69a-ed9edd706788';
const HUBSPOT_API = 'https://api.hubapi.com';

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

async function pushToHubSpot(token, { full_name, job_title, organisation, country, email, ai_tools, challenge }) {
  const nameParts = full_name.trim().split(/\s+/);
  const firstname = nameParts[0] || full_name;
  const lastname = nameParts.slice(1).join(' ') || '';

  const properties = {
    email,
    firstname,
    lastname,
    jobtitle: job_title,
    company: organisation,
    country,
    hs_lead_status: 'NEW',
    ...(ai_tools ? { message: `AI tools evaluating: ${ai_tools}` } : {}),
  };

  const resp = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ properties }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    // 409 = contact already exists — not an error we care about
    if (resp.status === 409) return { ok: true, existing: true };
    console.error('[HubSpot] contact create failed:', resp.status, body);
    return { ok: false, status: resp.status, body };
  }

  const data = await resp.json();
  return { ok: true, id: data.id };
}

export async function onRequestPost({ request, env }) {
  if (!env.NOTION_TOKEN) {
    return json({ error: 'Registration is not configured yet. Please email contact@lifescan.ai directly.' }, 503);
  }

  let p;
  try { p = await request.json(); } catch (_) { return json({ error: 'Invalid request.' }, 400); }

  const full_name = (p.full_name || '').toString().trim().slice(0, 120);
  const job_title = (p.job_title || '').toString().trim().slice(0, 120);
  const organisation = (p.organisation || '').toString().trim().slice(0, 200);
  const country = COUNTRIES.includes(p.country) ? p.country : '';
  const email = (p.email || '').toString().trim().slice(0, 200);
  const ai_tools = (p.ai_tools || '').toString().trim().slice(0, 500);
  const challenge = (p.challenge || '').toString().trim().slice(0, 1000);

  if (!full_name) return json({ error: 'Full name is required.' }, 400);
  if (!job_title) return json({ error: 'Job title is required.' }, 400);
  if (!organisation) return json({ error: 'Organisation is required.' }, 400);
  if (!country) return json({ error: 'Please select a country.' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'A valid work email is required.' }, 400);

  const now = new Date().toISOString();
  const pageTitle = `Registration: ${full_name} — ${organisation} (${country})`;

  // ── Notion ──────────────────────────────────────────────────────────────────
  const notionBody = {
    parent: { type: 'page_id', page_id: WORKSPACE_ID },
    properties: {
      title: { title: [{ text: { content: pageTitle } }] },
    },
    children: [
      {
        object: 'block',
        type: 'callout',
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
    const err = await notionResp.text();
    console.error('[Notion] page create failed:', err);
    return json({ error: 'Registration could not be saved. Please email contact@lifescan.ai directly.' }, 502);
  }

  // ── HubSpot (best-effort — never blocks the registration) ───────────────────
  if (env.HUBSPOT_TOKEN) {
    pushToHubSpot(env.HUBSPOT_TOKEN, { full_name, job_title, organisation, country, email, ai_tools, challenge })
      .then(r => console.log('[HubSpot]', JSON.stringify(r)))
      .catch(e => console.error('[HubSpot] unexpected error:', e));
  }

  return json({ ok: true, message: 'Registration received. We will be in touch soon.' });
}

function tableBlock(heading, rows) {
  return {
    object: 'block',
    type: 'table',
    table: {
      table_width: 2,
      has_column_header: true,
      has_row_header: false,
      children: rows.map((row, i) => ({
        object: 'block',
        type: 'table_row',
        table_row: {
          cells: row.map(cell => [{ type: 'text', text: { content: cell }, annotations: i === 0 ? { bold: true } : {} }]),
        },
      })),
    },
  };
}
