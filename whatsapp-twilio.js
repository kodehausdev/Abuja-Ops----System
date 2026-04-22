require('dotenv').config();
const axios = require('axios');

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER; // e.g. whatsapp:+14155238886

async function send(to, body) {
  // Ensure to has whatsapp: prefix
  const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  try {
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
      new URLSearchParams({ From: FROM_NUMBER, To: toFormatted, Body: body }).toString(),
      {
        auth: { username: ACCOUNT_SID, password: AUTH_TOKEN },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );
    console.log(`📤 [Twilio] Sent to ${to}`);
  } catch (e) {
    console.error('❌ Twilio send failed:', e.response?.data || e.message);
  }
}

module.exports = { send };
