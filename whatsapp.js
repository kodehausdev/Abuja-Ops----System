require('dotenv').config();
const axios = require('axios');

const WA_TOKEN        = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WA_URL          = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;

async function send(to, body) {
  try {
    await axios.post(WA_URL,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body } },
      { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`📤 Sent to ${to}`);
  } catch (e) {
    console.error('❌ WA Send failed:', e.response?.data || e.message);
  }
}

module.exports = { send };
