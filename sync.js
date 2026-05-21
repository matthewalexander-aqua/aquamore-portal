/**
 * Aquamore Sales Portal — HubSpot Sync Script
 * Runs via GitHub Actions every 30 minutes.
 * Reads RM tokens from environment variables (GitHub Secrets).
 * Writes data.json to the repo root — read by the portal and TV dashboard.
 *
 * To add a new RM: add RM_X_TOKEN and RM_X_NAME to GitHub Secrets.
 * Currently supports up to 10 RMs (RM_1 through RM_10).
 */

'use strict';
const fs = require('fs');

// ── DEAL STAGE MAPPING ────────────────────────────────────────────────────────
// Maps HubSpot deal stage IDs/names → portal pipeline status
const STAGE_MAP = {
  // HubSpot defaults
  appointmentscheduled:    'scenario',
  qualifiedtobuy:          'quote-sent',
  presentationscheduled:   'quote-sent',
  decisionmakerboughtin:   'submitted',
  contractsent:            'loo',
  closedwon:               'funded',
  closedlost:              'declined',
  // Common custom stage names (case-insensitive match)
  scenario:                'scenario',
  valuation:               'valuation',
  'quote sent':            'quote-sent',
  'quote-sent':            'quote-sent',
  'followed up':           'quote-sent',
  'app submitted':         'submitted',
  submitted:               'submitted',
  'loo issued':            'loo',
  'credit approved':       'loo',
  loo:                     'loo',
  'solicitors instructed': 'solicitors',
  solicitors:              'solicitors',
  'settled':               'funded',
  funded:                  'funded',
  settled:                 'funded',
  withdrawn:               'withdrawn',
  declined:                'declined',
};

function mapStage(hubspotStage) {
  if (!hubspotStage) return 'scenario';
  const key = hubspotStage.toLowerCase().replace(/_/g, ' ').trim();
  return STAGE_MAP[key] || STAGE_MAP[hubspotStage.toLowerCase()] || 'scenario';
}

// ── HUBSPOT API HELPERS ───────────────────────────────────────────────────────
const HS_BASE = 'https://api.hubapi.com';

async function hsGet(token, path) {
  const res = await fetch(`${HS_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot API error ${res.status} on ${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Fetch all pages from a HubSpot CRM list endpoint
async function hsGetAll(token, path, properties, limit = 100) {
  const results = [];
  let after = null;
  const propParam = properties.join(',');
  do {
    const cursor = after ? `&after=${after}` : '';
    const url = `${path}?properties=${propParam}&limit=${limit}${cursor}`;
    const data = await hsGet(token, url);
    results.push(...(data.results || []));
    after = data.paging?.next?.after || null;
  } while (after);
  return results;
}

// ── PER-RM FETCH ─────────────────────────────────────────────────────────────
async function fetchRMData(rm) {
  console.log(`  Fetching data for ${rm.name}...`);
  const results = { rm: rm.name, contacts: [], deals: [], calls: [], emails: [], meetings: [], notes: [] };

  try {
    // Contacts (brokers)
    results.contacts = await hsGetAll(rm.token, '/crm/v3/objects/contacts',
      ['firstname', 'lastname', 'email', 'phone', 'company', 'hs_lead_status']);
    console.log(`    Contacts: ${results.contacts.length}`);
  } catch(e) { console.warn(`    Contacts fetch failed: ${e.message}`); }

  try {
    // Deals (pipeline)
    results.deals = await hsGetAll(rm.token, '/crm/v3/objects/deals',
      ['dealname', 'amount', 'dealstage', 'closedate', 'createdate', 'pipeline',
       'description', 'hs_lastmodifieddate']);
    console.log(`    Deals: ${results.deals.length}`);
  } catch(e) { console.warn(`    Deals fetch failed: ${e.message}`); }

  try {
    // Calls
    results.calls = await hsGetAll(rm.token, '/crm/v3/objects/calls',
      ['hs_call_title', 'hs_call_body', 'hs_timestamp', 'hs_call_duration',
       'hs_call_status', 'hs_call_direction']);
    console.log(`    Calls: ${results.calls.length}`);
  } catch(e) { console.warn(`    Calls fetch failed: ${e.message}`); }

  try {
    // Emails
    results.emails = await hsGetAll(rm.token, '/crm/v3/objects/emails',
      ['hs_email_subject', 'hs_email_text', 'hs_timestamp', 'hs_email_direction']);
    console.log(`    Emails: ${results.emails.length}`);
  } catch(e) { console.warn(`    Emails fetch failed: ${e.message}`); }

  try {
    // Meetings
    results.meetings = await hsGetAll(rm.token, '/crm/v3/objects/meetings',
      ['hs_meeting_title', 'hs_meeting_body', 'hs_timestamp', 'hs_meeting_start_time',
       'hs_meeting_outcome']);
    console.log(`    Meetings: ${results.meetings.length}`);
  } catch(e) { console.warn(`    Meetings fetch failed: ${e.message}`); }

  try {
    // Notes
    results.notes = await hsGetAll(rm.token, '/crm/v3/objects/notes',
      ['hs_note_body', 'hs_timestamp']);
    console.log(`    Notes: ${results.notes.length}`);
  } catch(e) { console.warn(`    Notes fetch failed: ${e.message}`); }

  return results;
}

// ── TRANSFORM TO PORTAL FORMAT ────────────────────────────────────────────────
function transformData(allRMData) {
  const pipeline = [];
  const activityFeed = [];
  const contacts = [];
  let dealIdCounter = 90000; // high to avoid clashing with portal's embedded deals

  for (const rmData of allRMData) {
    const rmName = rmData.rm;

    // Transform deals → pipeline
    for (const deal of rmData.deals) {
      const p = deal.properties;
      const amount = parseFloat(p.amount) || 0;
      const created = p.createdate ? p.createdate.slice(0, 10) : '';
      const updated = p.hs_lastmodifieddate ? p.hs_lastmodifieddate.slice(0, 10) : created;
      pipeline.push({
        id:        ++dealIdCounter,
        borrower:  p.dealname || 'Unknown',
        amount:    amount.toString(),
        status:    mapStage(p.dealstage),
        bdm:       rmName,
        broker:    '',               // HubSpot contacts association would enrich this
        loanType:  p.pipeline || 'Commercial',
        refNo:     `HS-${deal.id}`,
        notes:     p.description || '',
        createdAt: created,
        updatedAt: updated,
        source:    'hubspot',
      });
    }

    // Transform contacts
    for (const c of rmData.contacts) {
      const p = c.properties;
      const name = [p.firstname, p.lastname].filter(Boolean).join(' ') || p.email || 'Unknown';
      contacts.push({ id: c.id, name, email: p.email||'', phone: p.phone||'', company: p.company||'', rm: rmName });
    }

    // Transform calls → activity
    for (const c of rmData.calls) {
      const p = c.properties;
      if (!p.hs_timestamp) continue;
      activityFeed.push({
        type:   'call',
        date:   p.hs_timestamp.slice(0, 10),
        desc:   p.hs_call_title || p.hs_call_body?.slice(0, 120) || 'Call logged',
        broker: '',
        bdm:    rmName,
        source: 'hubspot',
      });
    }

    // Transform emails → activity
    for (const e of rmData.emails) {
      const p = e.properties;
      if (!p.hs_timestamp) continue;
      activityFeed.push({
        type:   'email',
        date:   p.hs_timestamp.slice(0, 10),
        desc:   p.hs_email_subject || 'Email sent',
        broker: '',
        bdm:    rmName,
        source: 'hubspot',
      });
    }

    // Transform meetings → activity
    for (const m of rmData.meetings) {
      const p = m.properties;
      const ts = p.hs_meeting_start_time || p.hs_timestamp;
      if (!ts) continue;
      activityFeed.push({
        type:   'meeting',
        date:   ts.slice(0, 10),
        desc:   p.hs_meeting_title || p.hs_meeting_body?.slice(0, 120) || 'Meeting',
        broker: '',
        bdm:    rmName,
        source: 'hubspot',
      });
    }

    // Transform notes → activity
    for (const n of rmData.notes) {
      const p = n.properties;
      if (!p.hs_timestamp) continue;
      activityFeed.push({
        type:   'note',
        date:   p.hs_timestamp.slice(0, 10),
        desc:   p.hs_note_body?.slice(0, 120) || 'Note added',
        broker: '',
        bdm:    rmName,
        source: 'hubspot',
      });
    }
  }

  // Sort activity by date descending
  activityFeed.sort((a, b) => b.date.localeCompare(a.date));

  return { pipeline, activityFeed, contacts };
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Aquamore HubSpot Sync — ' + new Date().toISOString());

  // Load RM configs from environment
  const rmConfigs = [];
  for (let i = 1; i <= 10; i++) {
    const token = process.env[`RM_${i}_TOKEN`];
    const name  = process.env[`RM_${i}_NAME`] || `RM ${i}`;
    if (token) {
      rmConfigs.push({ id: `rm${i}`, name, token });
      console.log(`Found config for ${name} (RM_${i})`);
    }
  }

  if (rmConfigs.length === 0) {
    console.warn('No RM tokens found. Set RM_1_TOKEN and RM_1_NAME in GitHub Secrets.');
    // Write an empty but valid data.json so the portal still loads
    const empty = {
      last_updated:  new Date().toISOString(),
      sync_status:   'no_rms_configured',
      rms:           [],
      pipeline:      [],
      activity_feed: [],
      contacts:      [],
      stats:         { total_deals: 0, total_activities: 0, total_contacts: 0, rms_synced: 0 }
    };
    fs.writeFileSync('data.json', JSON.stringify(empty, null, 2));
    console.log('Wrote empty data.json');
    return;
  }

  // Fetch data from all RMs in parallel
  const allRMData = await Promise.all(rmConfigs.map(fetchRMData));

  // Transform to portal format
  const { pipeline, activityFeed, contacts } = transformData(allRMData);

  // Build final output
  const output = {
    last_updated:  new Date().toISOString(),
    sync_status:   'ok',
    rms:           rmConfigs.map(r => ({ name: r.name })),
    pipeline,
    activity_feed: activityFeed,
    contacts,
    stats: {
      total_deals:      pipeline.length,
      total_activities: activityFeed.length,
      total_contacts:   contacts.length,
      rms_synced:       rmConfigs.length,
    }
  };

  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log(`\nSync complete:`);
  console.log(`  RMs synced:    ${output.stats.rms_synced}`);
  console.log(`  Deals:         ${output.stats.total_deals}`);
  console.log(`  Activities:    ${output.stats.total_activities}`);
  console.log(`  Contacts:      ${output.stats.total_contacts}`);
  console.log(`  Written to:    data.json`);
}

main().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
