require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// All 84 TCD delivery zones
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

const PROMPT = `You are an order parser for TCD, a delivery company in Abuja, Nigeria.

Extract order details from the raw text below and return ONLY valid JSON. No markdown, no explanation.

Delivery zones list (match the address to the CLOSEST zone):
${ZONES.join(', ')}

Rules:
- order_number: the # number at the start (just the number e.g. "3")
- partner_name: the store/brand name if visible at the top (e.g. "VRW-HQ", "KUMBO", "ELA", "Amaka2") — leave empty string if none
- customer_name: full name of the customer
- customer_phone1: first phone number, digits only, no + or country code adjustments needed
- customer_phone2: second phone number if present, else empty string
- address: the delivery address as given
- zone: pick the SINGLE best matching zone from the list above based on the address. Use "KEFFI" or "MARARABA" for Nasarawa/Keffi addresses. Use "ASOKORO" for Asokoro/NAF Valley/Guzape. Use "CBD" for Central Business District/Area 10/Central Area. Use "NYANYA" or "NEW KARU" for Nyanya/New Nyanya. Use "KARU" for Karu/Jikwoyi area.
- product: what was ordered (keep it concise)
- amount: numeric value only e.g. 57500
- closer_name: name of the closer/agent if present, else empty string
- closer_phone: closer phone if present, else empty string
- notes: any special instructions (delivery time, color preference, schedule etc), else empty string
- is_outside_abuja: true if delivery is clearly outside Abuja (Keffi, Nasarawa state, Kaduna etc), false otherwise

Return this exact JSON structure:
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
    const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });
    const result = await model.generateContent(`${PROMPT}\n\nRAW ORDER:\n${rawText}`);
    const text = result.response.text().trim();

    // Strip markdown fences if present
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean);
    return { success: true, data: parsed };
  } catch (err) {
    console.error('Parse error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { parseOrder };
