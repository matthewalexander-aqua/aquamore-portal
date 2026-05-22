/**
 * Aquamore Sales Portal — HubSpot Sync Script v2
 * Uses the scopes available on HubSpot Free/Starter:
 *   - crm.objects.contacts.read
 *   - crm.objects.deals.read
 *   - crm.objects.owners.read
 *   - sales-email-read
 *   - conversations.read
 *   - timeline
 */

'use strict';
const fs = require('fs');

// ── DEAL STAGE MAPPING ────────────────────────────────────────────────────────
const STAGE_MAP = {
  appointmentscheduled:    'scenario',
  qualifiedtobuy:          'quote-sent',
  presentationscheduled:   'quote-sent',
  decisionmakerboughtin:   'submitted',
  contractsent:            'loo',
  closedwon:               'funded',
  closedlost:              'declined',
  'quote sent':            'quote-sent',
  submitted:               'submitted',
  'loo issued':            'loo',
  'credit approved':       'loo',
  loo:                     'loo',
  'solicitors instructed': 'solicitors',
  solicitors:              'solicitors',
  settled:                 'funded',
  funded:                  'funded',
  withdrawn:               'withdrawn',
  declined:                'declined',
};

function mapStage(s) {
  if (!s) return 'scenario';
  const key = s.toLowerCase().replace(/_/g,' ').trim();
  return STAGE_MAP[key] || 'scenario';
}

// ── HUBSPOT API HELPERS ───────────────────────────────────────────────────────
const HS_BASE = 'https://api.hubapi.com';

async function hsGet(token, path) {
  const res = await fetch(`${HS_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HubSpot ${res.status} on ${path}: ${txt.slice(0,200)}`);
  }
  return res.json();
}

// Fetch all pages from a CRM v3 list endpoint
async function hsGetAll(token, path, properties, limit = 100) {
  const results = [];
  let after = null;
  const props = properties.join(',');
  do {
    const cursor = after ? `&after=${after}` : '';
    const data = await hsGet(token, `${path}?properties=${props}&limit=${limit}${cursor}`);
    results.push(...(data.results || []));
    after = data.paging?.next?.after || null;
  } while (after);
  return results;
}

// ── FETCH ENGAGEMENTS VIA TIMELINE API ───────────────────────────────────────
// The timeline scope gives access to CRM activity events
async function fetchEngagements(token) {
  const engagements = [];
  try {
    // Use the legacy engagements endpoint — accessible with timeline scope
    let offset = 0;
    let hasMore = true;
    while (hasMore && engagements.length < 500) {
      const data = await hsGet(token,
        `/engagements/v1/engagements/paged?limit=100&offset=${offset}`
      );
      const results = data.results || data.engagements || [];
      results.forEach(function(e) {
        const eng  = e.engagement  || e;
        const meta = e.metadata    || {};
        const type = (eng.type || '').toLowerCase();
        const ts   = eng.createdAt || eng.lastUpdated || meta.startTime || null;
        const date = ts ? new Date(ts).toISOString().slice(0,10) : '';
        let desc = '';
        if (type === 'call')    desc = meta.title || meta.body || meta.disposition || 'Call logged';
        if (type === 'email')   desc = meta.subject || 'Email sent';
        if (type === 'meeting') desc = meta.title || meta.body || 'Meeting';
        if (type === 'note')    desc = meta.body?.slice(0,120) || 'Note added';
        if (type === 'task')    desc = meta.subject || meta.body || 'Task';
        if (date && desc) {
          engagements.push({ type: type || 'note', date, desc });
        }
      });
      hasMore = data.hasMore || false;
      offset  = data.offset  || (offset + results.length);
      if (results.length === 0) hasMore = false;
    }
    console.log(`    Engagements (legacy): ${engagements.length}`);
  } catch(e) {
    console.warn(`    Legacy engagements failed (${e.message}), trying CRM activity...`);
    // Fallback: try the CRM associations activity endpoint
    try {
      const acts = await hsGet(token, '/crm/v3/objects/activities?limit=100');
      (acts.results || []).forEach(function(a) {
        const p = a.properties || {};
        engagements.push({
          type: (p.hs_activity_type || 'note').toLowerCase(),
          date: (p.hs_timestamp || p.createdate || '').slice(0,10),
          desc: p.hs_body_preview || p.hs_note_body || 'Activity logged',
        });
      });
      console.log(`    Activities (CRM): ${engagements.length}`);
    } catch(e2) {
      console.warn(`    Activity fetch also failed: ${e2.message}`);
    }
  }
  return engagements;
}

// ── FETCH CONVERSATIONS ───────────────────────────────────────────────────────
async function fetchConversations(token) {
  const items = [];
  try {
    const data = await hsGet(token, '/conversations/v3/conversations/threads?limit=50');
    (data.results || []).forEach(function(thread) {
      const ts = thread.latestMessageReceivedAt || thread.createdAt || '';
      items.push({
        type: 'email',
        date: ts ? new Date(ts).toISOString().slice(0,10) : '',
        desc: thread.subject || 'Conversation',
      });
    });
    console.log(`    Conversations: ${items.length}`);
  } catch(e) {
    console.warn(`    Conversations fetch failed: ${e.message}`);
  }
  return items;
}

// ── PER-RM FETCH ─────────────────────────────────────────────────────────────
async function fetchRMData(rm) {
  console.log(`\n  Fetching: ${rm.name}`);
  const out = { rm: rm.name, contacts: [], deals: [], engagements: [] };

  try {
    out.contacts = await hsGetAll(rm.token,
      '/crm/v3/objects/contacts',
      ['firstname','lastname','email','phone','company']
    );
    console.log(`    Contacts: ${out.contacts.length}`);
  } catch(e) { console.warn(`    Contacts failed: ${e.message}`); }

  try {
    out.deals = await hsGetAll(rm.token,
      '/crm/v3/objects/deals',
      ['dealname','amount','dealstage','closedate','createdate',
       'pipeline','description','hs_lastmodifieddate']
    );
    console.log(`    Deals: ${out.deals.length}`);
  } catch(e) { console.warn(`    Deals failed: ${e.message}`); }

  // Engagements via timeline scope (legacy endpoint)
  const engs  = await fetchEngagements(rm.token);
  const convs = await fetchConversations(rm.token);
  out.engagements = engs.concat(convs);

  return out;
}

// ── TRANSFORM TO PORTAL FORMAT ────────────────────────────────────────────────
function transform(allRMData) {
  const pipeline = [];
  const activityFeed = [];
  const contacts = [];
  let dealCounter = 90000;

  for (const rmData of allRMData) {
    const rmName = rmData.rm;

    // Deals → pipeline
    for (const deal of rmData.deals) {
      const p = deal.properties;
      pipeline.push({
        id:        ++dealCounter,
        borrower:  p.dealname || 'Unknown',
        amount:    (parseFloat(p.amount) || 0).toString(),
        status:    mapStage(p.dealstage),
        bdm:       rmName,
        broker:    '',
        loanType:  p.pipeline || 'Commercial',
        refNo:     `HS-${deal.id}`,
        notes:     p.description || '',
        createdAt: (p.createdate || '').slice(0,10),
        updatedAt: (p.hs_lastmodifieddate || p.createdate || '').slice(0,10),
        source:    'hubspot',
      });
    }

    // Contacts
    for (const c of rmData.contacts) {
      const p = c.properties;
      const name = [p.firstname, p.lastname].filter(Boolean).join(' ') || p.email || 'Unknown';
      contacts.push({ id: c.id, name, email: p.email||'', phone: p.phone||'', company: p.company||'', rm: rmName });
    }

    // Engagements → activity feed
    for (const eng of rmData.engagements) {
      if (!eng.date || !eng.type) continue;
      activityFeed.push({
        type:   eng.type,
        date:   eng.date,
        desc:   eng.desc || '',
        broker: '',
        bdm:    rmName,
        source: 'hubspot',
      });
    }
  }

  activityFeed.sort((a,b) => b.date.localeCompare(a.date));
  return { pipeline, activityFeed, contacts };
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Aquamore HubSpot Sync v2 — ' + new Date().toISOString());

  const rmConfigs = [];
  for (let i = 1; i <= 10; i++) {
    const token = process.env[`RM_${i}_TOKEN`];
    const name  = process.env[`RM_${i}_NAME`] || `RM ${i}`;
    if (token) rmConfigs.push({ id: `rm${i}`, name, token });
  }

  if (rmConfigs.length === 0) {
    console.warn('No RM tokens configured.');
    fs.writeFileSync('data.json', JSON.stringify({
      last_updated: new Date().toISOString(),
      sync_status: 'no_rms_configured',
      rms: [], pipeline: [], activity_feed: [], contacts: [],
      stats: { total_deals:0, total_activities:0, total_contacts:0, rms_synced:0 }
    }, null, 2));
    return;
  }

  console.log(`RMs to sync: ${rmConfigs.map(r=>r.name).join(', ')}`);

  const allRMData = await Promise.all(rmConfigs.map(fetchRMData));
  const { pipeline, activityFeed, contacts } = transform(allRMData);

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
  console.log(`\nDone — ${pipeline.length} deals, ${activityFeed.length} activities, ${contacts.length} contacts`);
}

main().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
