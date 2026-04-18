require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const ZONES = [
  'ABAJI','ACO ESTATE','AIRPORT','AMAC MARKET','ANGADA','ADO/ NEW NYANYA',
  'APO','APO MECH','APO RESETTL','ASO B','ASOKORO','ASOKORO EXTENSION',
  'BWARI','CBD','CITEC','DAKWA','DAWAKI','DEI-DEI','DURUMI','DUSTE',
  'FISH FARM','GALADIMA','GALADIMAWA','GAMES VII','GARAM','GARKI',
  'GARUAKA','GIWA','GUDU','GWAGWA','GWAGWALADA','GWARIMPA','IDDO','IDU',
  'JABI','JAHI','JIKOWYI','JIWA','KABUSA','KABUSA GARDEN','KABUSA VILLAGE',
  'KADO','KADUNA RD','KARIMO','KARSANA','KARU','KATAMPE','KATAMPE EXTENSION',
  'KAURA','KEFFI','KUBWA','KUCHIKO','KUDURU BWARI','KUJE','KURADU','KWALI',
  'LIFE CAMP','LOKOGOMA','LUGBE','MABUSHI','MADALA','MAITAMA','MARARABA',
  'MASAKA','MPAPE','NATIONAL ASSEMBLY','NEW KARU','NYANYA','ONE MAN VILLAGE',
  'OROZO','SHERETI','SULEJA','SUNNY VALE','T-PUMMY','TUNGAMAJE','UTAKO',
  'WASA','WUMBA','WUSE','WUSE 2','WUSE ZONE 1 - 6','WUYE','ZUBA','ZUMA VILLAGE'
];

// Address keyword → zone overrides (checked before AI zone is used)
const KEYWORD_OVERRIDES = [
  // ── Asokoro area ──
  { keywords: ['guzape'], zone: 'ASOKORO EXTENSION' },
  { keywords: ['asokoro extension'], zone: 'ASOKORO EXTENSION' },
  { keywords: ['naf valley', 'nafvalley', 'airforce base asokoro', 'mogadishu cantonment', 'navy gate'], zone: 'ASOKORO' },
  // ── Mararaba — Nasarawa state but TCD delivers here ──
  { keywords: ['mararaba', 'maraba'], zone: 'MARARABA' },
  // ── Nyanya area ──
  { keywords: ['new nyanya', 'new-nyanya'], zone: 'ADO/ NEW NYANYA' },
  { keywords: ['nyanya barracks', 'mopol 21 nyanya', 'mopol'], zone: 'NYANYA' },
  // ── Karu / Karshi / Kurudu ──
  { keywords: ['kurudu', 'kuradu', 'police housing estate kurudu', 'police house estate kurudu'], zone: 'KURADU' },
  { keywords: ['karshi', 'karshi bye pass', 'karshi bypass', 'apo karshi'], zone: 'KARU' },
  { keywords: ['karu site', 'karu lga', 'city college mararaba', 'new karu'], zone: 'NEW KARU' },
  // ── CBD area ──
  { keywords: ['federal secretariat', 'head of service', 'area 10', 'ship house', 'central area', 'central business district', 'national hospital'], zone: 'CBD' },
  { keywords: ['national assembly'], zone: 'NATIONAL ASSEMBLY' },
  // ── Wuse ──
  { keywords: ['wuse 2'], zone: 'WUSE 2' },
  { keywords: ['wuse zone'], zone: 'WUSE ZONE 1 - 6' },
  // ── Other FCT zones ──
  { keywords: ['life camp'], zone: 'LIFE CAMP' },
  { keywords: ['katampe extension'], zone: 'KATAMPE EXTENSION' },
  { keywords: ['kubwa'], zone: 'KUBWA' },
  { keywords: ['lugbe'], zone: 'LUGBE' },
  { keywords: ['lokogoma'], zone: 'LOKOGOMA' },
  { keywords: ['apo mechanic', 'apo mech'], zone: 'APO MECH' },
  { keywords: ['kugbo mechanic', 'kugbo'], zone: 'KARU' },
  { keywords: ['wumba', 'apo resettlement', 'apo resettl'], zone: 'APO RESETTL' },
  { keywords: ['games village', 'games viii', 'games vii'], zone: 'GAMES VII' },
  { keywords: ['galadimawa'], zone: 'GALADIMAWA' },
  { keywords: ['galadima'], zone: 'GALADIMA' },
  { keywords: ['dawaki'], zone: 'DAWAKI' },
  { keywords: ['dei-dei', 'dei dei'], zone: 'DEI-DEI' },
  { keywords: ['durumi'], zone: 'DURUMI' },
  { keywords: ['gudu'], zone: 'GUDU' },
  { keywords: ['gwagwalada'], zone: 'GWAGWALADA' },
  { keywords: ['gwarimpa'], zone: 'GWARIMPA' },
  { keywords: ['kabusa garden'], zone: 'KABUSA GARDEN' },
  { keywords: ['kabusa village'], zone: 'KABUSA VILLAGE' },
  { keywords: ['kabusa'], zone: 'KABUSA' },
  { keywords: ['kado'], zone: 'KADO' },
  { keywords: ['karimo'], zone: 'KARIMO' },
  { keywords: ['karsana'], zone: 'KARSANA' },
  { keywords: ['sunny vale', 'sunnyvale'], zone: 'SUNNY VALE' },
  { keywords: ['tungamaje', 'tunga maje'], zone: 'TUNGAMAJE' },
  { keywords: ['utako'], zone: 'UTAKO' },
  { keywords: ['wuye'], zone: 'WUYE' },
  { keywords: ['zuba'], zone: 'ZUBA' },
  { keywords: ['mpape'], zone: 'MPAPE' },
  { keywords: ['orozo'], zone: 'OROZO' },
  { keywords: ['masaka'], zone: 'MASAKA' },
  { keywords: ['mabushi'], zone: 'MABUSHI' },
  { keywords: ['jabi'], zone: 'JABI' },
  { keywords: ['jahi'], zone: 'JAHI' },
  { keywords: ['wasa'], zone: 'WASA' },
  { keywords: ['citec'], zone: 'CITEC' },
  { keywords: ['dakwa'], zone: 'DAKWA' },
  { keywords: ['jikowyi', 'jikwoyi'], zone: 'JIKOWYI' },
];

// These are outside Abuja — flag with warning
// Note: Mararaba borders Abuja but TCD delivers there — NOT in this list
const OUTSIDE_ABUJA_KEYWORDS = [
  'nasarawa state', 'nassarawa state', 'keffi', 'kaduna',
  'nasarawa local government', 'nasarawa lga', 'udege',
  'lagos', 'surulere', 'ikeja', 'lekki', 'victoria island',
  'port harcourt', 'ibadan', 'enugu', 'benin city', 'onitsha'
];

const OUTSIDE_ABUJA_ZONES = ['KEFFI', 'SULEJA', 'MADALA', 'KWALI'];

function applyKeywordOverrides(address, aiZone) {
  const lower = address.toLowerCase();
  for (const rule of KEYWORD_OVERRIDES) {
    if (rule.keywords.some(kw => lower.includes(kw))) {
      return rule.zone;
    }
  }
  return aiZone;
}

function checkOutsideAbuja(address, zone) {
  const lower = address.toLowerCase();
  // Mararaba is always inside — don't flag it even if Nasarawa is mentioned nearby
  if (zone === 'MARARABA') return false;
  if (OUTSIDE_ABUJA_KEYWORDS.some(kw => lower.includes(kw))) return true;
  if (OUTSIDE_ABUJA_ZONES.includes(zone)) return true;
  return false;
}

const PROMPT = `You are an order parser for TCD, a delivery company in Abuja, Nigeria.

You will receive ONE customer order. Extract the details and return ONLY valid JSON. No markdown, no explanation.
If the text contains multiple customers, parse ONLY the FIRST complete customer order you find.

ZONE LIST — pick the single best match from ONLY these zones:
${ZONES.join(', ')}

ZONE RULES (follow exactly):
- "Guzape", "Asokoro extension" → ASOKORO EXTENSION
- "NAF Valley", "Nafvalley Airforce", "Mogadishu Cantonment", "Navy Gate" → ASOKORO
- "Mararaba", "Maraba" → MARARABA (TCD delivers here, do NOT mark outside Abuja)
- "New Nyanya" → ADO/ NEW NYANYA
- "Nyanya barracks", "Mopol" → NYANYA
- "Kurudu", "Kuradu", "Police housing estate kurudu" → KURADU (this is in Abuja, NOT Karu)
- "Karshi", "Karshi bypass" → KARU
- "New Karu", "Karu site" → NEW KARU
- "CBD", "Central Area", "Federal Secretariat", "Area 10", "National Hospital" → CBD
- "Kugbo", "Apo mechanic" → APO MECH
- "Wumba", "Apo resettlement" → APO RESETTL
- Nasarawa state (NOT Mararaba), Keffi → KEFFI — mark is_outside_abuja: true
- order_number: ALWAYS use the # number at the very TOP of the message. NEVER use CRM reference numbers like "Daggo Group-CRM-ORD-..." or "CSS-2026-..." — those are partner internal IDs.
- product: ALWAYS include quantity in the product field. e.g. "2x Ovella Capsule", "3 Bottles of Baozem Tea", "1 Pack Tummy Trimmer". Never strip the quantity — it is critical for delivery.
- partner_name: the store/brand/agent who submitted the order. Usually appears at the TOP of message as a short code e.g. "VRW-HQ", "KUMBO", "FAT FLUSHER", "A+ BRAIN". Can also appear at the BOTTOM as a standalone name ONLY if the order has NO labeled fields (Customer:, Phone:, etc). NEVER put partner names into notes. If no clear partner found, leave empty.
- customer_phone1: extract and normalize the primary phone number. Remove ALL commas, spaces, punctuation. Normalize to Nigerian format: "+2348141708312" → "08141708312", "2348141708312" (no +) → "08141708312", "234-814-170-8312" → "08141708312". Always start with 0 for local format. e.g. ",,,08124638493" → "08124638493".
- customer_phone2: second phone number if present, same cleaning rules.
- closer_name: the sales agent who closed the sale. If a standalone first name appears at the BOTTOM of a labeled order (one that uses Customer:, Phone:, Address:, Product: fields), treat it as closer_name NOT partner_name. Example: order ends with "Loveth" on its own line after all details → closer_name="Loveth", partner_name="". Also extract if explicitly labeled "Closer name:" or "Closer:". Do NOT duplicate the same name in both fields.
- amount: extract the numeric value only (no ₦ symbol, no commas). Look for ₦, N, or plain numbers near product lines. If "PAID" appears with no amount visible, set payment_method to "T" and amount to 0.
- notes: ONLY delivery instructions e.g. "deliver by 2pm", "call before delivery", "available today". Never put partner names or closer names into notes. "PAID" is NOT a note — it means payment_method = "T".
- is_outside_abuja: true ONLY for Nasarawa state (not Mararaba), Kaduna, Lagos. Mararaba = false.
- If address contains an email address or URL, ignore it and use the physical delivery address instead.
- If address contains an email address, ignore it and use the actual delivery address instead.

Return this exact JSON:
{
  "order_number": "",
  "partner_name": "",
  "customer_name": "",
  "customer_phone1": "",
  "customer_phone2": "",
  "address": "",
  "zone": "",
  "product": "",
  "amount": 0,
  "closer_name": "",
  "closer_phone": "",
  "notes": "",
  "is_outside_abuja": false
}`;

async function parseOrder(rawText) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent(`${PROMPT}\n\nRAW ORDER:\n${rawText}`);
    const text = result.response.text().trim();

    // Try multiple extraction strategies
    let parsed = null;

    // Strategy 1: strip markdown fences
    try {
      const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {}

    // Strategy 2: extract first { ... } block
    if (!parsed) {
      try {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
      } catch {}
    }

    if (!parsed) {
      console.error('Parse error — raw response:', text.slice(0, 200));
      return { success: false, error: 'Could not extract JSON from AI response' };
    }

    // Safety net: if order_number is a CRM reference, extract #N from raw text
    if (parsed.order_number && parsed.order_number.toString().length > 6) {
      const match = rawText.match(/^#(\d+)/m);
      if (match) parsed.order_number = match[1];
    }

    // Apply keyword overrides for zone precision
    if (parsed.address) {
      parsed.zone = applyKeywordOverrides(parsed.address, parsed.zone);
      parsed.is_outside_abuja = checkOutsideAbuja(parsed.address, parsed.zone);
    }

    return { success: true, data: parsed };
  } catch (err) {
    console.error('Parse error:', err.message);
    const isApiDown = err.message?.includes('fetch') || err.message?.includes('network') ||
                      err.message?.includes('503') || err.message?.includes('429') ||
                      err.message?.includes('quota');
    return {
      success: false,
      error: isApiDown
        ? 'AI_DOWN'
        : err.message
    };
  }
}

module.exports = { parseOrder };