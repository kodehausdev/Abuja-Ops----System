// whatsapp-wasender.js
const fetch = require('node-fetch');

function normalizeToWasender(from) {
  // Strip "whatsapp:" prefix and "+" if present — WaSender wants plain digits e.g. 2348XXXXXXXXX
  return from
    .replace('whatsapp:', '')
    .replace('+', '')
    .trim();
}

async function send(to, message) {
  const recipient = normalizeToWasender(to);
  try {
    const res = await fetch('https://wasenderapi.com/api/send-message', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WASENDER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to: recipient, text: message }),
    });
    const data = await res.json();
    if (!res.ok) console.error('❌ WaSender error:', data);
    return data;
  } catch (err) {
    console.error('❌ WaSender send failed:', err.message);
  }
}

module.exports = { send, normalizeToWasender };
