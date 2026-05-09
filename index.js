require('dotenv').config();
const path = require('path');
const express = require('express');
const { parseOrder } = require('./parser');
const { saveOrder, getNextOrderNumberStart, assignCaptain } = require('./db');
const { send: sendMeta }   = require('./whatsapp');
const { send: sendTwilio } = require('./whatsapp-twilio');
const { send: sendWhapi } = require('./whatsapp-whapi');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // required for Twilio form-data webhooks
app.use(express.static('public', { index: false }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Defaults to Twilio — set PROVIDER=meta in .env to fall back to Meta
const PROVIDER = (process.env.PROVIDER || 'twilio').toLowerCase();
const send = PROVIDER === 'whapi' ? sendWhapi 
           : PROVIDER === 'meta'  ? sendMeta 
           : sendTwilio;

console.log(`📡 Provider: ${PROVIDER.toUpperCase()}`);

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'tcd_ops_verify';
const processed = new Set();
const messageQueue = {}; // batches rapid messages from same sender
const BATCH_WINDOW = 12000; // 12 seconds — safe for WhatsApp, handles large bulk forwards

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

function watDate() {
  return new Date(Date.now() + 60*60*1000).toISOString().split('T')[0];
}

// ── CONFIG ENDPOINT — serves public config to dashboard ──────
app.get('/config', (req, res) => {
  res.json({
    supabaseUrl:  process.env.SUPABASE_URL,
    supabaseKey:  process.env.SUPABASE_KEY, // anon/publishable key — safe to expose
    opsEmails:    (process.env.OPS_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean),
  });
});

// ── ASSIGN CAPTAIN (dashboard manual assign) ─────────────────
app.post('/api/assign-captain', async (req, res) => {
  const { order_id, dispatcher_name } = req.body;
  if (!order_id || !dispatcher_name) return res.status(400).json({ error: 'order_id and dispatcher_name required' });
  const result = await assignCaptain(order_id, dispatcher_name);
  if (!result) return res.status(500).json({ error: 'Failed to assign captain' });
  res.json({ success: true });
});

// ── TWILIO WEBHOOK ────────────────────────────────────────────
// Twilio sends form-encoded POST to /webhook/twilio — no GET verify step
app.post('/webhook/twilio', async (req, res) => {
  res.sendStatus(200);
  const from = req.body?.From; // whatsapp:+2348XXXXXXXXX
  const text = req.body?.Body?.trim();
  if (!from || !text) return;

  const msgSid = req.body?.MessageSid || `${from}:${Date.now()}`;
  if (processed.has(msgSid)) return;
  processed.add(msgSid);
  if (processed.size > 1000) processed.clear();

  console.log(`\n📩 [Twilio][${from}]: ${text.slice(0, 80)}`);
  const lower = text.toLowerCase();
  const isCommand = lower === 'list' || lower === 'orders' || lower === 'help' ||
    lower === 'edit' || lower.startsWith('edit ') || lower.startsWith('edit #');
  if (isCommand) return await handleMessage(from, text);

  if (!messageQueue[from]) messageQueue[from] = { texts: [], timer: null };
  messageQueue[from].texts.push(text);
  if (messageQueue[from].timer) clearTimeout(messageQueue[from].timer);
  messageQueue[from].timer = setTimeout(async () => {
    const batch = messageQueue[from].texts.join('\n');
    delete messageQueue[from];
    await handleMessage(from, batch);
  }, BATCH_WINDOW);
});

// ── WHAPI WEBHOOK ─────────────────────────────────────────────
app.post('/webhook/whapi', async (req, res) => {
  res.sendStatus(200); // 1. Tell Whapi we got it immediately
  
  const message = req.body?.messages?.[0];
  if (!message || message.type !== 'text') return;

  const msgId = message.id;
  if (processed.has(msgId)) return;
  processed.add(msgId);
  if (processed.size > 1000) processed.clear();

  const from = message.from.split('@')[0];
  const text = message.text?.body?.trim();
  if (!from || !text) return;

  const lower = text.toLowerCase();
  const isCommand = ['list', 'orders', 'help', 'edit'].some(cmd => lower.startsWith(cmd));

  // 2. ONLY bypass batching for commands
  if (isCommand) {
    console.log(`⚡ Command detected from ${from}: ${text}`);
    return await handleMessage(from, text);
  }

  // 3. FORCE everything else into the queue
  if (!messageQueue[from]) {
    messageQueue[from] = { texts: [], timer: null };
  }
  
  messageQueue[from].texts.push(text);
  console.log(`📥 Added to batch [${from}]: ${text.slice(0, 30)}... (Queue size: ${messageQueue[from].texts.length})`);

  if (messageQueue[from].timer) clearTimeout(messageQueue[from].timer);

  messageQueue[from].timer = setTimeout(async () => {
    const fullBatch = messageQueue[from].texts.join('\n\n---\n\n');
    const count = messageQueue[from].texts.length;
    delete messageQueue[from];
    
    console.log(`🚀 Processing BATCH of ${count} orders for ${from}`);
    // This calls the AI once for the entire list
    await handleMessage(from, fullBatch); 
  }, 10000); // 10 seconds is usually the "sweet spot" for bulk forwards
});



// ── META WEBHOOK VERIFY ───────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// ── META INCOMING MESSAGES ────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  console.log('📥 POST /webhook body:', JSON.stringify(req.body).slice(0, 300));
  const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message || !message.text) return;

  const msgId = message.id;
  if (processed.has(msgId)) return;
  processed.add(msgId);
  if (processed.size > 1000) processed.clear();

  const from = message.from;
  const text = message.text.body.trim();
  console.log(`\n📩 [Meta][${from}]: ${text.slice(0, 80)}`);

  const lower = text.toLowerCase();
  const isCommand = lower === 'list' || lower === 'orders' || lower === 'help' ||
    lower === 'edit' || lower.startsWith('edit ') || lower.startsWith('edit #');

  if (isCommand) {
    return await handleMessage(from, text);
  }

  // ── Batch rapid order messages from same sender ──
  if (!messageQueue[from]) {
    messageQueue[from] = { texts: [], timer: null };
  }

  messageQueue[from].texts.push(text);

  // Reset timer — wait for more messages before processing
  if (messageQueue[from].timer) clearTimeout(messageQueue[from].timer);
  messageQueue[from].timer = setTimeout(async () => {
    const batch = messageQueue[from].texts.join('\n');
    delete messageQueue[from];
    await handleMessage(from, batch);
  }, BATCH_WINDOW);
});





// ── SPLIT BULK ORDERS ─────────────────────────────────────────
function splitOrders(text) {
  // Strip WhatsApp forward headers
  let t = text.replace(/\[\d{1,2}\/\d{1,2}(?:\/\d{2,4})?[,\s]+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap][Mm])?\]\s*[^:\n]+:\s*/g, '\n').trim();

  // 1. Split on #number — when orders have explicit numbers, this is definitive
  // Each #N at start of line = exactly one order. Don't apply any other logic.
  let blocks = t.split(/(?=^#\d+)/m).map(b => b.trim()).filter(b => b.length > 10);
  if (blocks.length > 1) return blocks;
  // Single #number order — return as-is, no further splitting
  if (blocks.length === 1 && /^#\d+/m.test(blocks[0])) return blocks;

  // 2. No #numbers — inject separators before Name: lines
  t = t.replace(/([^\n])\n(Name[\s:])/gim, '$1\n\n\n$2');
  t = t.replace(/(N[\d,]+)\n([A-Z][a-z])/g, '$1\n\n\n$2');

  // Helper
  const isOrder = b => {
    const clean = b.replace(/,+/g, '');
    return /0[789]\d{9}/.test(clean) || /\+234\d{10}/.test(clean) ||
           /phone/i.test(b) || /₦\d/.test(b) || /N\d{4,}/.test(b);
  };

  // 3. Split on triple newlines
  blocks = t.split(/\n\s*\n\s*\n/).map(b => b.trim()).filter(b => b.length > 15 && isOrder(b));
  if (blocks.length > 1) return blocks;

  // 4. Split on double newlines
  blocks = t.split(/\n\s*\n/).map(b => b.trim()).filter(b => b.length > 15 && isOrder(b));
  if (blocks.length > 1) return blocks;

  return [t.trim()];
}

// ── CAPTAIN HELPERS ───────────────────────────────────────────
let cachedCaptains = null;
let captainsCachedAt = 0;

async function getCaptains() {
  if (cachedCaptains && Date.now() - captainsCachedAt < 3600000) return cachedCaptains;
  const supabase = getSupabase();
  const { data } = await supabase.from('dispatchers').select('name');
  cachedCaptains = (data || []).map(r => r.name.toUpperCase());
  captainsCachedAt = Date.now();
  return cachedCaptains;
}

function fuzzyMatchCaptain(input, captains) {
  const q = input.trim().toUpperCase();
  if (captains.includes(q)) return q;
  const sw = captains.find(c => c.startsWith(q) || q.startsWith(c));
  if (sw) return sw;
  const co = captains.find(c => c.includes(q) || q.includes(c));
  if (co) return co;
  const words = q.split(/\s+/).filter(w => w.length > 2);
  for (const word of words) {
    const m = captains.find(c => c.includes(word));
    if (m) return m;
  }
  return null;
}

// Splits full paste into sections by "Captain: Name" lines
function splitByCaptain(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;

  for (const line of lines) {
    const m = line.match(/^Captain:\s*(.+)/i);
    if (m) {
      if (current) sections.push(current);
      current = { captain: m[1].trim(), text: '' };
    } else {
      if (current) {
        current.text += line + '\n';
      } else {
        // text before any Captain: line — no captain prefix
        if (!sections.length) current = { captain: null, text: line + '\n' };
      }
    }
  }
  if (current) sections.push(current);
  return sections.map(s => ({ ...s, text: s.text.trim() })).filter(s => s.text.length > 0);
}

// ── MAIN HANDLER ──────────────────────────────────────────────
async function handleMessage(from, text) {
  const lower = text.toLowerCase();

  // ── Commands ──
  if (lower === 'list' || lower === 'orders') return handleListCommand(from);
  if (lower === 'help') return send(from,
    `*TCD Order Bot*\n\nPaste one or multiple orders and I'll process them all at once.\n\n` +
    `• *LIST* — today's orders by zone\n` +
    `• *EDIT #[num] [field] [value]* — fix a field\n` +
    `• *HELP* — this message`
  );

  // Edit check — handle "edit", "EDIT #15 zone CBD" etc
  if (lower === 'edit' || lower.startsWith('edit ') || lower.startsWith('edit #')) {
    return handleEditCommand(from, text);
  }

  // ── Pre-check: too short ──
  if (text.length < 20) {
    return send(from, `That looks too short. Paste the full order text.`);
  }

  // ── Strip forward headers before checking ──
  const stripped = text.replace(/\[\d{1,2}\/\d{1,2}(?:\/\d{2,4})?[,\s]+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap][Mm])?\]\s*[^:\n]+:\s*/g, '\n').trim();

  // ── Pre-check: looks like an order? ──
  const looksLikeOrder = /^#\d+/m.test(stripped) || /0[789]\d{9}/.test(stripped) || /\+234/.test(stripped);
  if (!looksLikeOrder) {
    return send(from, `That doesn't look like an order. Paste a customer order with a # number, name, phone and address.`);
  }

  // ── Split by Captain: sections, then into individual order blocks ──
  const captainSections = splitByCaptain(stripped);
  const hasCaptainPrefix = captainSections.some(s => s.captain);
  const captains = hasCaptainPrefix ? await getCaptains() : [];

  // Flatten all sections into [{ block, captain }]
  const allBlocks = [];
  for (const section of captainSections) {
    let matchedCaptain = null;
    if (section.captain) {
      matchedCaptain = fuzzyMatchCaptain(section.captain, captains);
      if (!matchedCaptain) {
        await send(from, `⚠️ Captain "${section.captain}" not recognised. Orders will be saved unassigned.\n\nKnown captains: ${captains.slice(0, 10).join(', ')}`);
      }
    }
    if (!section.text) continue;
    for (const block of splitOrders(section.text)) {
      allBlocks.push({ block, captain: matchedCaptain });
    }
  }

  const isBulk = allBlocks.length > 1;
  await send(from, isBulk ? `⏳ Processing ${allBlocks.length} orders...` : `⏳ Parsing order...`);

  const today = watDate();
  const results = { saved: [], duplicates: [], failed: [] };
  const seenInBatch = new Set();
  let nextNum = await getNextOrderNumberStart(today);

  for (const { block, captain } of allBlocks) {
    const cleanBlock = block
      .replace(/@\S+/g, '')
      .replace(/after pickup you deliver with below info/gi, '')
      .replace(/treat as urgent[^\n]*/gi, '')
      .replace(/^\s*\n+/, '')
      .trim();

    console.log(`\n📦 [${captain || 'unassigned'}] "${cleanBlock.slice(0,60).replace(/\n/g,' ')}..."`);
    const result = await parseOrder(cleanBlock);

    if (!result.success) {
      if (result.error === 'AI_DOWN') {
        await send(from,
          `⚠️ AI parser is temporarily unavailable.\n\nTry again in a few minutes, or add the order manually on the dashboard.\n\nRaw text:\n${block.slice(0, 200)}`
        );
      }
      results.failed.push(block.split('\n')[0].trim());
      continue;
    }

    const order = result.data;

    if (!order.customer_phone1 && !order.customer_name && !order.amount) {
      console.warn('⚠️ Empty parse result:', cleanBlock.slice(0, 80));
      results.failed.push(block.split('\n')[0].trim().slice(0, 40));
      continue;
    }

    order.raw_text     = block;
    order.force_captain = captain;

    const batchKey = `${order.customer_phone1}|${(order.product||'').split(' ')[0]}`;
    if (seenInBatch.has(batchKey)) { results.duplicates.push(order); continue; }
    seenInBatch.add(batchKey);

    order.staff_phone = from;
    order.status      = 'pending';
    if (!order.customer_name?.trim()) order.customer_name = 'Unknown';
    if (!order.zone || order.zone === '**') {
      order.zone = 'UNASSIGNED';
      order.is_outside_abuja = true;
    }

    if (!order.order_number) {
      order.suggested_number = String(nextNum);
      nextNum++;
    }

    const saved = await saveOrder(order);

    if (saved && saved.success) {
      order.order_number = saved.orderNumber;
      if (order.suggested_number) {
        const usedNum = parseInt(saved.orderNumber);
        if (!isNaN(usedNum) && usedNum >= nextNum) nextNum = usedNum + 1;
      }
      results.saved.push(order);
    } else if (saved === 'duplicate') {
      results.duplicates.push(order);
    } else {
      results.failed.push(`#${order.order_number || '?'}`);
    }
  }

  await sendResults(from, results, isBulk);
}

async function sendResults(from, results, isBulk) {
  // Send each saved order confirmation individually
  for (const o of results.saved) {
    const outside = o.is_outside_abuja ? ' ⚠️' : '';
    let msg = `✅ *Order #${o.order_number} confirmed!*\n\n`;
    msg += `📍 Zone: *${o.zone}*${outside}\n`;
    if (o.force_captain) msg += `🚴 Captain: *${o.force_captain}*\n`;
    msg += `👤 ${o.customer_name}\n`;
    msg += `📱 ${o.customer_phone1}${o.customer_phone2 ? ' / ' + o.customer_phone2 : ''}\n`;
    msg += `📦 ${o.product}\n`;
    msg += `💰 ₦${Number(o.amount).toLocaleString()}\n`;
    if (o.partner_name) msg += `🏪 ${o.partner_name}\n`;
    if (o.closer_name)  msg += `👨‍💼 ${o.closer_name}\n`;
    if (o.notes)        msg += `📝 ${o.notes}\n`;
    await send(from, msg);
  }

  // Duplicates summary
  if (results.duplicates.length > 0) {
    let msg = `⚠️ *${results.duplicates.length} duplicate${results.duplicates.length>1?'s':''} skipped* — same phone + product already saved today:\n\n`;
    for (const o of results.duplicates) {
      msg += `• ${o.customer_name} (${o.customer_phone1||'no phone'}) — ${(o.product||'').slice(0,30)}\n`;
    }
    msg += `\n_If this is a genuine new order, add it manually on the dashboard._`;
    await send(from, msg);
  }

  // Failed summary
  if (results.failed.length > 0) {
    let msg = `❌ *${results.failed.length} failed to parse:*\n`;
    for (const f of results.failed) msg += `${f}\n`;
    await send(from, msg);
  }

  await send(from, `Send *LIST* to see all today's orders.`);
}

// ── EDIT COMMAND ──────────────────────────────────────────────
// Usage: EDIT #15 zone MARARABA
//        EDIT #15 customer John Doe
//        EDIT #15 phone 08012345678
//        EDIT #15 amount 25000
//        EDIT #15 address No 5 Wuse 2 Abuja
async function handleEditCommand(from, text) {
  const match = text.match(/^edit\s+#?(\d+)\s+(\w+)\s+(.+)$/i);
  if (!match) {
    return send(from,
      `❓ Edit format: *EDIT #[order] [field] [value]*\n\n` +
      `Examples:\n` +
      `• EDIT #15 zone MARARABA\n` +
      `• EDIT #15 customer John Doe\n` +
      `• EDIT #15 phone 08012345678\n` +
      `• EDIT #15 amount 25000\n` +
      `• EDIT #15 address No 5 Wuse 2 Abuja`
    );
  }

  const [, orderNum, field, value] = match;
  const today = watDate();
  const supabase = getSupabase();

  // Find the order
  const { data: orders } = await supabase
    .from('orders')
    .select('id, order_number, customer_name, zone')
    .eq('order_number', orderNum)
    .eq('order_date', today)
    .limit(1);

  if (!orders || orders.length === 0) {
    return send(from, `❌ Order #${orderNum} not found for today.`);
  }

  const order = orders[0];

  // Map field name to DB column
  const fieldMap = {
    zone:     'zone',
    customer: 'customer_name',
    name:     'customer_name',
    phone:    'customer_phone1',
    phone2:   'customer_phone2',
    amount:   'amount',
    address:  'raw_address',
    product:  'product',
    partner:  'partner_name',
    status:   'status',
    report:   'report',
  };

  const col = fieldMap[field.toLowerCase()];
  if (!col) {
    return send(from,
      `❌ Unknown field: *${field}*\n\nEditable fields: zone, customer, phone, amount, address, product, partner, status, report`
    );
  }

  const updateVal = col === 'amount' ? Number(value) : value.trim();

  const { error } = await supabase
    .from('orders')
    .update({ [col]: updateVal })
    .eq('id', order.id);

  if (error) {
    return send(from, `❌ Update failed: ${error.message}`);
  }

  await send(from,
    `✅ *Order #${orderNum} updated!*\n\n` +
    `${field.toUpperCase()}: ${value}\n\n` +
    `Customer: ${order.customer_name} — Zone: ${order.zone}`
  );
}

// ── LIST COMMAND ──────────────────────────────────────────────
async function handleListCommand(from) {
  const supabase = getSupabase();
  const today = watDate();

  const { data: orders, error } = await supabase
    .from('orders').select('*')
    .eq('order_date', today)
    .order('zone').order('created_at');

  if (error || !orders?.length) {
    return send(from, `No orders found for today yet.`);
  }

  const byZone = {};
  for (const o of orders) {
    const z = o.zone || 'UNASSIGNED';
    if (!byZone[z]) byZone[z] = [];
    byZone[z].push(o);
  }

  let msg = `📦 *TODAY'S ORDERS — ${orders.length} total*\n━━━━━━━━━━━━━━━━━━━━\n`;
  for (const [zone, zoneOrders] of Object.entries(byZone)) {
    msg += `\n📍 *${zone}* (${zoneOrders.length})\n`;
    for (const o of zoneOrders) {
      msg += `✅ #${o.order_number} ${o.customer_name} — ${o.product} — ₦${Number(o.amount).toLocaleString()}\n`;
    }
  }
  msg += `\n━━━━━━━━━━━━━━━━━━━━`;
  await send(from, msg);
}

// ── PASTE ORDERS (dashboard direct paste) ─────────────────────
app.post('/parse-orders', async (req, res) => {
  if (!req.body?.text) return res.status(400).json({ error: 'text required' });

  let { text, captain } = req.body;

  // Captain field works identically to "Captain: Name" prefix in the bot
  if (captain?.trim()) {
    text = `Captain: ${captain.trim()}\n${text}`;
  }

  const stripped = text.replace(/\[\d{1,2}\/\d{1,2}(?:\/\d{2,4})?[,\s]+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap][Mm])?\]\s*[^:\n]+:\s*/g, '\n').trim();

  const captainSections = splitByCaptain(stripped);
  const hasCaptainPrefix = captainSections.some(s => s.captain);
  const captains = hasCaptainPrefix ? await getCaptains() : [];

  const allBlocks = [];
  const warnings = [];
  for (const section of captainSections) {
    let matchedCaptain = null;
    if (section.captain) {
      matchedCaptain = fuzzyMatchCaptain(section.captain, captains);
      if (!matchedCaptain) {
        warnings.push(`Captain "${section.captain}" not recognised — orders saved unassigned. Known: ${captains.slice(0, 5).join(', ')}`);
      }
    }
    if (!section.text) continue;
    for (const block of splitOrders(section.text)) {
      allBlocks.push({ block, captain: matchedCaptain });
    }
  }

  const today = watDate();
  const results = { saved: [], duplicates: [], failed: [], warnings };
  const seenInBatch = new Set();
  let nextNum = await getNextOrderNumberStart(today);

  for (const { block, captain: blockCaptain } of allBlocks) {
    const cleanBlock = block
      .replace(/@\S+/g, '')
      .replace(/after pickup you deliver with below info/gi, '')
      .replace(/treat as urgent[^\n]*/gi, '')
      .replace(/^\s*\n+/, '')
      .trim();

    console.log(`\n📦 [dashboard][${blockCaptain || 'unassigned'}] "${cleanBlock.slice(0, 60).replace(/\n/g, ' ')}..."`);
    const result = await parseOrder(cleanBlock);

    if (!result.success) {
      results.failed.push(block.split('\n')[0].trim().slice(0, 60));
      continue;
    }

    const order = result.data;

    if (!order.customer_phone1 && !order.customer_name && !order.amount) {
      console.warn('⚠️ Empty parse result:', cleanBlock.slice(0, 80));
      results.failed.push(block.split('\n')[0].trim().slice(0, 40));
      continue;
    }

    order.raw_text = block;
    order.force_captain = blockCaptain;

    const batchKey = `${order.customer_phone1}|${(order.product || '').split(' ')[0]}`;
    if (seenInBatch.has(batchKey)) {
      results.duplicates.push({ customer_name: order.customer_name, customer_phone1: order.customer_phone1, product: order.product });
      continue;
    }
    seenInBatch.add(batchKey);

    order.staff_phone = 'dashboard';
    order.status = 'pending';
    if (!order.customer_name?.trim()) order.customer_name = 'Unknown';
    if (!order.zone || order.zone === '**') {
      order.zone = 'UNASSIGNED';
      order.is_outside_abuja = true;
    }

    if (!order.order_number) {
      order.suggested_number = String(nextNum);
      nextNum++;
    }

    const saved = await saveOrder(order);

    if (saved && saved.success) {
      order.order_number = saved.orderNumber;
      if (order.suggested_number) {
        const usedNum = parseInt(saved.orderNumber);
        if (!isNaN(usedNum) && usedNum >= nextNum) nextNum = usedNum + 1;
      }
      results.saved.push({
        order_number: order.order_number,
        customer_name: order.customer_name,
        zone: order.zone,
        captain: order.force_captain || null,
        product: order.product,
        amount: order.amount,
        is_outside_abuja: order.is_outside_abuja,
      });
    } else if (saved === 'duplicate') {
      results.duplicates.push({ customer_name: order.customer_name, customer_phone1: order.customer_phone1, product: order.product });
    } else {
      results.failed.push(`#${order.order_number || '?'} ${order.customer_name || ''}`.trim());
    }
  }

  res.json(results);
});

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 TCD Bot running → http://localhost:${PORT}`);
  console.log(`📊 Dashboard → http://localhost:${PORT}/dashboard.html\n`);
});