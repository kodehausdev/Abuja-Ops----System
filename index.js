require('dotenv').config();
const express = require('express');
const { parseOrder } = require('./parser');
const { saveOrder, getNextOrderNumberStart, assignCaptain } = require('./db');
const { send } = require('./whatsapp');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.static('public'));

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
  res.json({ success: true, captain_number: result.captainNumber });
});

// ── WEBHOOK VERIFY ────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// ── INCOMING MESSAGES ─────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message || !message.text) return;

  const msgId = message.id;
  if (processed.has(msgId)) return;
  processed.add(msgId);
  if (processed.size > 1000) processed.clear();

  const from = message.from;
  const text = message.text.body.trim();
  console.log(`\n📩 [${from}]: ${text.slice(0, 80)}`);

  // Commands bypass batching — process immediately
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
  let t = text.replace(/\[\d{2}\/\d{2},\s*\d{2}:\d{2}\]\s*[^:]+:\s*/g, '\n').trim();

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
  const stripped = text.replace(/\[\d{2}\/\d{2},\s*\d{2}:\d{2}\]\s*[^:]+:\s*/g, '\n').trim();

  // ── Pre-check: looks like an order? ──
  const looksLikeOrder = /^#\d+/m.test(stripped) || /0[789]\d{9}/.test(stripped) || /\+234/.test(stripped);
  if (!looksLikeOrder) {
    return send(from, `That doesn't look like an order. Paste a customer order with a # number, name, phone and address.`);
  }

  // ── Split into individual orders ──
  const blocks = splitOrders(stripped);
  const isBulk = blocks.length > 1;

  if (isBulk) {
    await send(from, `⏳ Processing ${blocks.length} orders...`);
  } else {
    await send(from, `⏳ Parsing order...`);
  }

  const today = watDate();
  const results = { saved: [], duplicates: [], failed: [] };
  const seenInBatch = new Set(); // track phone+product within this batch

  // Get next order number ONCE before loop
  let nextNum = await getNextOrderNumberStart(today);

  for (const block of blocks) {
    // Clean block before parsing — strip @mentions, preamble text before order details
    const cleanBlock = block
      .replace(/@\S+/g, '')                          // remove @all @mentions
      .replace(/after pickup you deliver with below info/gi, '')
      .replace(/treat as urgent[^\\n]*/gi, '')
      .replace(/^\s*[\n]+/, '')                       // remove leading blank lines
      .trim();

    console.log(`\n📦 Processing block: "${cleanBlock.slice(0,60).replace(/\n/g,' ')}..."`);
    const result = await parseOrder(cleanBlock);

    if (!result.success) {
      if (result.error === 'AI_DOWN') {
        await send(from,
          `⚠️ *AI parser is temporarily unavailable.*\n\n` +
          `Please try again in a few minutes, or enter the order manually on the dashboard.\n\n` +
          `Raw text saved for reference:\n${block.slice(0, 200)}...`
        );
      }
      results.failed.push(block.split('\n')[0].trim());
      continue;
    }

    const order = result.data;

    // Reject if Gemini returned empty/garbage
    if (!order.customer_phone1 && !order.customer_name && !order.amount) {
      console.warn('⚠️ Empty parse result for block:', cleanBlock.slice(0, 80));
      console.warn('   Parsed data:', JSON.stringify(order));
      results.failed.push(block.split('\n')[0].trim().slice(0, 40));
      continue;
    }

    order.raw_text = block; // save original unstripped text

    // In-batch dedup — same phone + same product in same paste = only save first
    const batchKey = `${order.customer_phone1}|${(order.product||'').split(' ')[0]}`;
    if (seenInBatch.has(batchKey)) {
      results.duplicates.push(order);
      continue;
    }
    seenInBatch.add(batchKey);

    order.staff_phone = from;
    order.status      = 'pending';
    if (!order.customer_name?.trim()) order.customer_name = 'Unknown';
    if (!order.zone || order.zone === '**') {
      order.zone = 'UNASSIGNED';
      order.is_outside_abuja = true;
    }

    // Always: save the group's original # as partner_ref, assign a fresh global number
    order.partner_ref = order.order_number || null;
    order.order_number = null;
    order.suggested_number = String(nextNum);
    nextNum++;

    const saved = await saveOrder(order);

    if (saved && saved.success) {
      order.order_number = saved.orderNumber;
      // If this used our suggested number, advance counter
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

  // ── Build reply ──
  await sendResults(from, results, isBulk);
}

async function sendResults(from, results, isBulk) {
  // Send each saved order confirmation individually
  for (const o of results.saved) {
    const outside = o.is_outside_abuja ? ' ⚠️' : '';
    let msg = `✅ *Order #${o.order_number} confirmed!*\n\n`;
    msg += `📍 Zone: *${o.zone}*${outside}\n`;
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

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 TCD Bot running → http://localhost:${PORT}`);
  console.log(`📊 Dashboard → http://localhost:${PORT}/dashboard.html\n`);
});