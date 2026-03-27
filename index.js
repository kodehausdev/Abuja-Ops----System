require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const supabase = createClient(
  'https://cnibkphbjautasggyiia.supabase.co',
  'sb_publishable_mUKU80NAIYmS1Gk-S22nAQ_JMZNp1BJ'
);

const WA_TOKEN        = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN    = 'abuja_ops_verify';

const sessions = {};

// ── WEBHOOK VERIFY ────────────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// ── INCOMING MESSAGES ─────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message || !message.text) return;
  const from = message.from;
  const text = message.text.body.trim();
  console.log(`📩 [${from}]: ${text}`);
  await handleMessage(from, text);
});

// ── STATE MACHINE ─────────────────────────────────────────────────────────────
async function handleMessage(from, text) {
  const lower = text.toLowerCase();
  if (!sessions[from]) sessions[from] = { step: 'idle' };
  const session = sessions[from];

  if (['hi','hello','start','menu'].includes(lower) || session.step === 'idle') {
    sessions[from] = { step: 'ask_name' };
    return send(from,
      `👋 Welcome to *Abuja Ops Order System!*\n\n` +
      `I will collect the order details in a few quick steps.\n\n` +
      `First — what is your *dispatcher name*?`
    );
  }

  switch (session.step) {
    case 'ask_name':
      session.dispatcher_name = capitalize(text);
      session.step = 'ask_product';
      return send(from,
        `Got it *${session.dispatcher_name}* 👍\n\n` +
        `What *product* are you selling today?\n\n` +
        `E.g: Charger Type-C, Power Bank 20000mah, Earbuds Pro`
      );

    case 'ask_product':
      session.product = text;
      session.step = 'ask_customer_name';
      return send(from, `What is the *customer full name*?`);

    case 'ask_customer_name':
      session.customer_name = capitalize(text);
      session.step = 'ask_customer_phone';
      return send(from, `Customer *phone number*?`);

    case 'ask_customer_phone':
      session.customer_phone = text;
      session.step = 'ask_customer_email';
      return send(from, `Customer *email address*?\n(type *skip* if none)`);

    case 'ask_customer_email':
      session.customer_email = lower === 'skip' ? '' : text;
      session.step = 'ask_qty';
      return send(from, `*Quantity* ordered?`);

    case 'ask_qty':
      session.qty = text;
      session.step = 'ask_address';
      return send(from, `*Delivery address* in Abuja?`);

    case 'ask_address':
      session.address = text;
      session.step = 'confirm';
      return send(from,
        `📋 *Order Summary*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👤 Dispatcher: ${session.dispatcher_name}\n` +
        `📦 Product: ${session.product}\n` +
        `🧑 Customer: ${session.customer_name}\n` +
        `📱 Phone: ${session.customer_phone}\n` +
        `📧 Email: ${session.customer_email || 'N/A'}\n` +
        `🔢 Qty: ${session.qty}\n` +
        `📍 Address: ${session.address}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Reply *YES* to submit ✅ or *NO* to cancel ❌`
      );

    case 'confirm':
      if (lower === 'yes') {
        const ok = await saveOrder(from, session);
        sessions[from] = { step: 'idle' };
        return send(from, ok
          ? `✅ *Order logged!* The ops team can see it on the dashboard now.\n\nType *hi* to log another order.`
          : `❌ Error saving order. Type *hi* to try again.`
        );
      } else {
        sessions[from] = { step: 'idle' };
        return send(from, `Order cancelled. Type *hi* to start a new one.`);
      }

    default:
      sessions[from] = { step: 'idle' };
      return send(from, `Type *hi* to log an order 👋`);
  }
}

// ── SUPABASE ──────────────────────────────────────────────────────────────────
async function saveOrder(phone, s) {
  const { error } = await supabase.from('orders').insert([{
    dispatcher_phone: phone,
    dispatcher_name:  s.dispatcher_name,
    product:          s.product,
    customer_name:    s.customer_name,
    customer_phone:   s.customer_phone,
    customer_email:   s.customer_email || null,
    quantity:         parseInt(s.qty) || 1,
    address:          s.address,
    status:           'new'
  }]);
  if (error) { console.error('❌ Supabase:', error.message); return false; }
  console.log('✅ Order saved to Supabase');
  return true;
}

// ── SEND WHATSAPP ─────────────────────────────────────────────────────────────
async function send(to, body) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body } },
      { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('❌ WA Send failed:', e.response?.data || e.message);
  }
}

function capitalize(str) {
  return str.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Abuja Ops Bot running → http://localhost:${PORT}`);
  console.log(`📊 Dashboard → http://localhost:${PORT}/dashboard.html\n`);
});
