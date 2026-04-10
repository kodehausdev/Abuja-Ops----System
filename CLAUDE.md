# TCD Order Automation System
## Project Brain — Read this first

Built by **Kodehaus** (Seyi Fatoki) for **TollyClassic Delivery (TCD)**, Abuja.
Lead developer: Seyi | AI pair: Claude (Anthropic)

---

## What this project is

TCD has 160+ partners who sell products online. Customers order, partners collect the order details and drop them in WhatsApp groups. TCD staff manually pick up these orders, rewrite them onto paper sheets, handwrite dispatch slips for each package, and sort them by delivery zone.

**This system replaces all of that.**

Staff paste raw order text into a single WhatsApp bot number. AI (Gemini) reads it — any format, any messiness — extracts all fields, matches the address to TCD's 84-zone Abuja location database, saves to Supabase, and replies with a sorted order list grouped by zone. A dashboard gives ops full visibility. Printable dispatch slips are generated automatically — no handwriting.

---

## Current status

**Paid contract. 10-day build. Day 1 in progress.**

Payment structure: ₦100k (received) → ₦100k day 5 → ₦100k day 10

**What is DONE:**
- ✅ Supabase database set up (Optipropose project)
- ✅ `locations` table seeded — 84 Abuja delivery zones
- ✅ `orders` table rebuilt for new schema
- ✅ `dispatchers` table seeded — 77 dispatchers
- ✅ `partners` table seeded — 160+ partners
- ✅ `parser.js` — Gemini AI parses any raw order format
- ✅ Keyword override system for zone precision (Guzape → ASOKORO EXTENSION etc)
- ✅ `test_parser.js` — tested against 8 real TCD orders, 8/8 pass
- ✅ MVP WhatsApp bot from previous project (different client, same codebase base)
- ✅ Catalogue PDF generator (daily order sheet + dispatch slips)

**What is IN PROGRESS (Day 1-3):**
- WhatsApp webhook that receives pasted orders
- Save parsed orders to Supabase
- Bot replies with structured confirmation + zone assignment
- Staff verification step before order is finalised

---

## Tech stack

| Layer | Tech | Notes |
|---|---|---|
| Runtime | Node.js + Express | webhook server |
| AI | Gemini 2.5 Flash | `@google/generative-ai` — model: `gemini-2.5-flash` |
| Messaging | WhatsApp Cloud API v22 | Meta, test number for now |
| Database | Supabase PostgreSQL | Optipropose project |
| Dashboard | Vanilla HTML/CSS/JS | pulls from Supabase REST |
| Slips | ReportLab (Python) | PDF generation |
| Hosting | AWS (credits) | deploy Day 5 |
| Version control | Git + GitHub | private repo |

---

## Environment variables

```env
GEMINI_API_KEY=
SUPABASE_URL=https://cnibkphbjautasggyiia.supabase.co
SUPABASE_KEY=sb_publishable_mUKU80NAIYmS1Gk-S22nAQ_JMZNp1BJ
WA_TOKEN=
PHONE_NUMBER_ID=961583850382092
VERIFY_TOKEN=tcd_ops_verify
PORT=3000
```

---

## Database schema (Supabase — Optipropose project)

```sql
-- 84 Abuja delivery zones
locations (id, name)

-- 77 dispatchers / riders
dispatchers (id, name, created_at)

-- 160+ partner stores
partners (id, name, phone, created_at)

-- Every order
orders (
  id, order_number, raw_text,
  partner_name, customer_name,
  customer_phone1, customer_phone2,
  product, amount, raw_address, zone,
  verified, status,  -- status: pending → dispatched → delivered
  payment_method,    -- T or C (filled after delivery)
  report,            -- delivery notes
  created_at
)
```

---

## How the AI parser works

File: `parser.js`

1. Raw order text (any format) is passed to Gemini 1.5 Flash
2. Prompt instructs Gemini to extract: order_number, partner_name, customer_name, phone1, phone2, address, zone, product, amount, closer_name, closer_phone, notes, is_outside_abuja
3. Response is parsed as JSON
4. **Keyword override system** runs after AI — catches zone precision issues the AI gets wrong:
   - "Guzape" → ASOKORO EXTENSION
   - "Karshi", "Karshi bye pass" → KARU (it's on the Apo-Karu road)
   - "Mogadishu Cantonment", "Navy Gate" → ASOKORO
   - "Mararaba" → MARARABA (not outside Abuja)
   - "NAF Valley" → ASOKORO
   - "CBD / Central Area / Federal Secretariat" → CBD
   - "Kugbo", "Apo mechanic" → APO MECH
   - "Wumba", "Apo resettlement" → APO RESETTL
   - etc. (see KEYWORD_OVERRIDES array in parser.js)
5. Result saved to Supabase `orders` table

**To add a new zone mapping:** add a line to `KEYWORD_OVERRIDES` in `parser.js`:
```js
{ keywords: ['your keyword'], zone: 'ZONE NAME' },
```

---

## Real order samples (for testing)

These are actual TCD orders used to build and test the parser. Use them in `test_parser.js`.

Key formats seen in the wild:
- Clean labeled format: `Name: X`, `Phone 1: X`, `Address: X`
- Raw unlabeled: just name, phones, address as separate lines
- CRM dump: full Daggo Group CRM format with order numbers
- Tab-separated single line (worst case)
- With emojis and noise
- With "Closer details" block at bottom
- Partner code at top (VRW-HQ, KUMBO, ELA, Amaka2)

---

## 10-day build plan

### Days 1–3 — Core AI pipeline
- [x] `parser.js` — Gemini extracts order fields
- [x] Zone keyword overrides
- [ ] `index.js` — Express webhook server
- [ ] Receive WhatsApp message → parse → save to Supabase
- [ ] Bot confirms back: "Order #X received. Zone: ASOKORO. Customer: John Doe"
- [ ] Staff verification: bot asks "Correct? Reply YES to confirm or NO to edit"

### Days 4–5 — Sorted reply + day summary
- [ ] After each order confirmed, bot sends updated sorted list to group
- [ ] Format: grouped by zone, with order numbers
- [ ] End of day: bot sends full day summary
- [ ] Swap test WhatsApp number → TCD's verified Business number
- [ ] Deploy to AWS EC2

### Days 6–8 — Ops Dashboard
- [ ] Rebuild dashboard for new data model
- [ ] Columns match their paper sheet: No | SN | Seller | Customer | Phone | Product | Location | T/C | Date | Report | Amount
- [ ] Filter by zone, partner, date, status
- [ ] Assign dispatcher to zone (dropdown)
- [ ] Mark order as dispatched / delivered
- [ ] T/C field editable after delivery

### Days 9–10 — Slips + Polish + Handover
- [ ] Printable dispatch slip generation (per order + batch)
- [ ] Slip format: S/N, Order #, Amount, Product(s), Partner name
- [ ] CSV/Excel export — daily catalogue
- [ ] Error handling, fallback messages, edge cases
- [ ] Test with real staff on real orders
- [ ] Source code handover + documentation

---

## Future roadmap (post Day 10)

These are features to discuss with TCD after the initial build:

- **Dispatcher assignment** — each zone assigned to a specific dispatcher, auto-notified
- **Rider tracking** — dispatcher marks orders delivered one by one from their phone
- **Partner portal** — each partner sees only their own orders (read-only)
- **Analytics** — orders by partner, by zone, by day, revenue trends
- **Auto daily report** — WhatsApp message sent to ops at end of every day
- **Failed delivery flow** — mark as failed, reschedule, notify partner
- **Multi-city expansion** — they mentioned Kaduna. Location DB can be extended.
- **Payments integration** — track cash vs transfer, flag unpaid CODs

---

## Key people

| Person | Role | Contact |
|---|---|---|
| Gbenga (meettheprof) | TCD Client / Decision maker | WhatsApp |
| Cynthia | TCD Operations Officer | mentioned in orders |
| Esther | TCD Assistant Operations | mentioned in orders |
| Seyi (kodehaus) | Developer | hi.kodehaus@gmail.com |

---

## Known issues / watch out for

1. **WhatsApp access token expires** — temp tokens last ~24hrs. Use permanent token for production.
2. **Phone Number ID** — easy to transpose digits. Always copy-paste from Meta dashboard.
3. **Supabase RLS** — policies alone aren't enough. Always run explicit `GRANT` statements too.
4. **API version** — Meta moves fast. Currently on v22.0. Check if it changes.
5. **Mararaba** — is in FCT, not Nasarawa. Don't flag as outside Abuja.
6. **Guzape** — is ASOKORO EXTENSION, not ASOKORO. Keyword override handles this.
7. **Karshi bypass** — is KARU zone (Apo-Karshi road). Keyword override handles this.
8. **Gemini model** — use `gemini-2.5-flash`. Older models (1.5-flash) throw 404 on SDK v0.24+.
9. **Zone comes back as `**`** — means AI couldn't match. Add the address keyword to KEYWORD_OVERRIDES in parser.js and to the ZONE RULES in the prompt.

---

## How to run locally

```bash
# Install deps
npm install

# Set up env
cp .env.example .env
# Fill in GEMINI_API_KEY and WA_TOKEN

# Test the parser against real orders
node test_parser.js

# Start the webhook server
node index.js

# In another terminal — expose locally
ngrok http 3000

# Register webhook on Meta:
# URL: https://YOUR-NGROK.ngrok-free.app/webhook
# Verify token: tcd_ops_verify
# Subscribe to: messages
```

---

## File structure

```
tcd-bot/
├── index.js          ← webhook server (to be built Day 1-2)
├── parser.js         ← Gemini AI order parser ✅
├── test_parser.js    ← parser test harness ✅
├── db.js             ← Supabase client + save functions (to build)
├── whatsapp.js       ← send message helpers (to build)
├── public/
│   └── dashboard.html ← ops dashboard (to rebuild Day 6-8)
├── .env              ← secrets (never commit)
├── .env.example      ← template ✅
├── .gitignore        ← node_modules, .env
├── CLAUDE.md         ← this file
└── package.json
```

---

*Last updated: April 2026 | Kodehaus × TCD*