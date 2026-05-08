// whatsapp-whapi.js
const fetch = require('node-fetch');

function normalizeToWhapi(from) {
  // Twilio sends "whatsapp:+2348XXXXXXXXX", Meta sends "2348XXXXXXXXX"
  // Whapi wants "2348XXXXXXXXX@s.whatsapp.net"
  let num = from
    .replace('whatsapp:', '')
    .replace('+', '')
    .trim();
  return `${num}@s.whatsapp.net`;
}

async function send(to, message) {
  const recipient = normalizeToWhapi(to);
  try {
    const res = await fetch('https://gate.whapi.cloud/messages/text', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHAPI_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to: recipient, body: message }),
    });
    const data = await res.json();
    if (!res.ok) console.error('❌ Whapi error:', data);
    return data;
  } catch (err) {
    console.error('❌ Whapi send failed:', err.message);
  }
}

module.exports = { send };