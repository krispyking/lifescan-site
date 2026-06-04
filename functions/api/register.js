// Cloudflare Pages Function — POST /api/register
// Saves early access registrations to Notion under the LifeScan Agent Workspace.
// Secrets (CF Pages): NOTION_TOKEN
// Optional: LIFESCAN_WORKSPACE_ID (defaults to the known workspace page ID)

const NOTION_VERSION = '2022-06-28';
const NOTION_API = 'https://api.notion.com/v1';
// LifeScan Agent Workspace page — registrations are appended as child pages
const WORKSPACE_ID = '32028547-eaa7-8126-a69a-ed9edd706788';

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

  const body = {
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

  const resp = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error('Notion error:', err);
    return json({ error: 'Registration saved but confirmation failed. Please email contact@lifescan.ai if you do not hear from us.' }, 502);
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
