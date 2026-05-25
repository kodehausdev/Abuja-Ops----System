# 🚀 Launch Checklist

## STEP 1 — Supabase Table
1. Go to supabase.co → your project → SQL Editor
2. Paste and run everything in `supabase_setup.sql`

## STEP 2 — Get WhatsApp credentials from Meta
1. Go to developers.facebook.com → Abuja-Ops-Test → WhatsApp → API Setup
2. Copy the **Temporary Access Token**
3. Copy the **Phone Number ID** (under "From" section)
4. Paste both into your `.env` file

## STEP 3 — Start the server
```bash
node index.js
```
You should see: 🚀 Bot running on port 3000

## STEP 4 — Expose with ngrok
Open a NEW terminal:
```bash
ngrok http 3000
```
Copy the https URL e.g. https://abc123.ngrok.io

## STEP 5 — Register Webhook on Meta
1. Go to WhatsApp → Configuration → Webhook
2. Callback URL: `https://abc123.ngrok.io/webhook`
3. Verify Token: `abuja_ops_verify`
4. Click Verify → Subscribe to `messages`

## STEP 6 — Test it!
Send a WhatsApp message to your Meta test number saying:
> hi

The bot will walk through the order flow and save to Supabase ✅

## What the flow looks like:
Customer: hi
Bot: Welcome! What's your name?
Customer: Seyi Fatoki
Bot: What would you like to order?
Customer: 2 bags of rice
Bot: Quantity?
Customer: 2
Bot: Delivery address?
Customer: Wuse 2, Abuja
Bot: [Summary] Reply YES to confirm
Customer: yes
Bot: ✅ Order confirmed! → Saved to Supabase
