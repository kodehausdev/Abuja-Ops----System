require('dotenv').config();
const express = require('express');
const { parseOrder } = require('./parser');
const { saveOrder } = require('./db');
const { send } = require('./whatsapp');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'tcd_ops_verify';
const processed = new Set();
const messageQueue = {}; // batches rapid messages from same sender
const BATCH_WINDOW = 2000; // 2 seconds — collect messages then process together

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
  // Strip WhatsApp forward headers like "[08/04, 14:16] kodehaus 🏠: "
  const stripped = text.replace(/\[\d{2}\/\d{2},\s*\d{2}:\d{2}\]\s*[^:]+:\s*/g, '\n').trim();

  // Split on lines starting with #number
  const blocks = stripped.split(/(?=^#\d+)/m)
    .map(b => b.trim())
    .filter(b => b.length > 10 && /^#\d+/m.test(b));

  return blocks.length > 0 ? blocks : [stripped];
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

  for (const block of blocks) {
    const result = await parseOrder(block);

    if (!result.success) {
      results.failed.push(block.split('\n')[0].trim());
      continue;
    }

    const order = result.data;
    order.raw_text    = block;
    order.staff_phone = from;
    order.status      = 'pending';
    if (!order.customer_name?.trim()) order.customer_name = 'Unknown';
    if (!order.zone || order.zone === '**') {
      order.zone = 'UNASSIGNED';
      order.is_outside_abuja = true;
    }

    const saved = await saveOrder(order);

    if (saved && saved.success) {
      order.order_number = saved.orderNumber; // use actual number (may be suffixed)
      results.saved.push(order);
    } else if (saved === 'duplicate') {
      results.duplicates.push(order);
    } else {
      results.failed.push(`#${order.order_number}`);
    }
  }

  // ── Build reply ──
  await sendResults(from, results, isBulk);
}

async function sendResults(from, results, isBulk) {
  // Send each saved order confirmation individually
  for (const o of results.saved) {
    const outside = o.is_outside_abuja ? ' ⚠️' : '';
    let msg = `✅ *Order #${o.order_number} 🎉🎉*\n\n`;
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
    let msg = `⚠️ *${results.duplicates.length} already saved today:*\n`;
    for (const o of results.duplicates) msg += `#${o.order_number} ${o.customer_name}\n`;
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
