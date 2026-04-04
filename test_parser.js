require('dotenv').config();
const { parseOrder } = require('./parser');

// Real orders from TCD — paste as-is, no formatting
const testOrders = [
  `#26
Harbe Samson Ewa
08035900830
08027933254
HALIBIZ plaza Keffi Nasarawa state Nigeria
(2 car windscreen sunshade N55,000)
Please call and schedule a delivery date with him, he isn't available today`,

  `#1
Name: Momoh Babatunde
Phone 1: +23490302453
Phone 2: +2347017772293
Address: mararaba axis
Product: GSM Land Phone & Gifts
1 pc
Price: NGN57,500`,

  `#2
Name
Stephen Longsman
Phone Number
7035323453
Alternative Phone Number
08050872448
Delivery Address
Nafvalley Airforce base Asokoro
Buy 2 Packs - N30,000`,

  `#6
VRW-HQ
Morounkeji 
Name:Emmanuella Bright
Address:Cherryfield children's home Asokoro extension guzape Abuja
Phone number: 09047807670, 08167515718
Product: 1 weight loss gummies 
Amount: 25,000
Status: paid`,

  `#8
Customer name: Kevin Nwabugwu
Customer address: NBTI, HEAD OF SERVICE, FEDERAL SECRETARIAT, ABUJA
Phone number: +2347010859786
Whatsapp number: +2347010859786
Details of products:
 - zebra sunglasses x1 · ₦24,500
Amount to receive: ₦24,500
Closer details:
Closer name: Abidemi Suleiman
Closer phone: 09130621974`,

  `#10
KUMBO🧕🏻🧕🏻🧕🏻
Order number: Daggo Group-CRM-ORD-03-054239
Customer name: Tumba Jonah
Customer address: City college mararaba
State: Federal Capital Territory
City: Karu
Phone number: 08037090261
Details of products:
 - SOOTRA TEA x1 · NGN 21,500
Amount to collect: NGN 21,500
Closer name: Hassan Firdausi Tanko
Closer phone: 08107004656`,

  `#17
Elizabeth	8130804812	7063426203	Abuja	57 SB Abubakar Avenue, NAF Valley Estate. Asokoro	Buy 1 Popcorn Machine = ₦45,000 + Free delivery`,

  `#4
Amaka2 week2 
N44,000 - 2 Packs of Botox Bee Venom Wrinkled Cream + 2 FREE Pack
Name:Eneje amaka			
Address:NNpc station opposite national hospital road fct Abuja	
Number:07064588001
Available`,
];

async function runTests() {
  console.log(`\n${'='.repeat(60)}`);
  console.log('TCD ORDER PARSER — TEST RUN');
  console.log(`Testing ${testOrders.length} real orders`);
  console.log('='.repeat(60));

  let passed = 0;
  let failed = 0;

  for (let i = 0; i < testOrders.length; i++) {
    const raw = testOrders[i];
    const firstLine = raw.split('\n')[0].trim();
    console.log(`\n[${i+1}/${testOrders.length}] Parsing: ${firstLine}`);
    console.log('-'.repeat(40));

    const result = await parseOrder(raw);

    if (result.success) {
      const d = result.data;
      console.log(`✅ SUCCESS`);
      console.log(`   Order #:   ${d.order_number}`);
      console.log(`   Partner:   ${d.partner_name || '—'}`);
      console.log(`   Customer:  ${d.customer_name}`);
      console.log(`   Phone 1:   ${d.customer_phone1}`);
      console.log(`   Phone 2:   ${d.customer_phone2 || '—'}`);
      console.log(`   Zone:      ${d.zone} ${d.is_outside_abuja ? '⚠️  OUTSIDE ABUJA' : ''}`);
      console.log(`   Product:   ${d.product}`);
      console.log(`   Amount:    ₦${d.amount?.toLocaleString()}`);
      if (d.closer_name) console.log(`   Closer:    ${d.closer_name} (${d.closer_phone})`);
      if (d.notes) console.log(`   Notes:     ${d.notes}`);
      passed++;
    } else {
      console.log(`❌ FAILED: ${result.error}`);
      failed++;
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
}

runTests().catch(console.error);
