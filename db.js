require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

function watDate() {
  return new Date(Date.now() + 60*60*1000).toISOString().split('T')[0];
}

// ── Auto-assign next order number for today ───────────────────
async function getNextOrderNumber(today) {
  const { data } = await supabase
    .from('orders')
    .select('order_number')
    .eq('order_date', today)
    .not('order_number', 'is', null);

  if (!data || data.length === 0) return '1';
  const nums = data
    .map(r => parseInt(r.order_number))
    .filter(n => !isNaN(n));
  return nums.length > 0 ? String(Math.max(...nums) + 1) : '1';
}

// Called once before bulk loop — returns integer so caller can increment
async function getNextOrderNumberStart(today) {
  const num = await getNextOrderNumber(today);
  return parseInt(num);
}

async function saveOrder(order) {
  const today = watDate();
  let orderNum = String(order.order_number || '').trim();

  // ── Use suggested number from bulk loop (avoids race condition) ──
  if ((!orderNum || orderNum === 'undefined') && order.suggested_number) {
    orderNum = String(order.suggested_number);
    console.log(`🔢 Using suggested order number: #${orderNum}`);
  } else if (!orderNum || orderNum === 'undefined') {
    orderNum = await getNextOrderNumber(today);
    console.log(`🔢 Auto-assigned order number: #${orderNum}`);
  }

  // ── True duplicate: same phone + same product + same day → block ──
  if (order.customer_phone1 && order.product) {
    const { data: exactDup } = await supabase
      .from('orders')
      .select('id')
      .eq('customer_phone1', order.customer_phone1)
      .eq('order_date', today)
      .ilike('product', `%${(order.product).split(' ')[0]}%`)
      .limit(1);

    if (exactDup && exactDup.length > 0) {
      console.warn(`⚠️  True duplicate — same phone + product today`);
      return 'duplicate';
    }
  }

  // ── Same customer (phone) already has orders today → suffix new one ──
  if (order.customer_phone1) {
    const { data: sameCustomer } = await supabase
      .from('orders')
      .select('order_number')
      .eq('customer_phone1', order.customer_phone1)
      .eq('order_date', today);

    if (sameCustomer && sameCustomer.length > 0) {
      // Get the base order number (first one saved for this customer today)
      const baseNum = sameCustomer[0].order_number.replace(/[a-z]+$/, '');
      // Find highest suffix
      const suffixes = sameCustomer
        .map(r => r.order_number.replace(baseNum, ''))
        .filter(s => /^[a-z]*$/.test(s));
      const lastSuffix = suffixes.filter(s => s.length === 1).sort().pop();
      orderNum = lastSuffix
        ? `${baseNum}${String.fromCharCode(lastSuffix.charCodeAt(0) + 1)}`
        : `${baseNum}a`;
      console.log(`📝 Bundle detected — using ${orderNum} for same customer`);
    }
  }

  // ── Auto-assign captain based on zone + today's attendance ──
  let autoCaption = null;
  if (order.zone && order.zone !== 'UNASSIGNED') {
    const { data: zoneMap } = await supabase
      .from('zone_assignments')
      .select('dispatcher_name')
      .eq('zone', order.zone);

    if (zoneMap && zoneMap.length > 0) {
      const captains = zoneMap.map(r => r.dispatcher_name);
      // Check who's present today
      const { data: present } = await supabase
        .from('attendance')
        .select('dispatcher_name')
        .in('dispatcher_name', captains)
        .eq('date', today)
        .eq('present', true);

      if (present && present.length > 0) {
        // Pick the one with fewest orders today (load balance)
        const presentNames = present.map(p => p.dispatcher_name);
        const { data: loads } = await supabase
          .from('orders')
          .select('dispatcher_name')
          .in('dispatcher_name', presentNames)
          .eq('order_date', today);

        const countMap = {};
        presentNames.forEach(n => countMap[n] = 0);
        (loads || []).forEach(o => {
          if (o.dispatcher_name) countMap[o.dispatcher_name] = (countMap[o.dispatcher_name] || 0) + 1;
        });

        autoCaption = Object.entries(countMap).sort((a,b) => a[1] - b[1])[0]?.[0];
        console.log(`🚴 Auto-assigned to ${autoCaption} for zone ${order.zone}`);
      }
    }
  }

  // ── Save ──────────────────────────────────────────────────────
  const { error } = await supabase.from('orders').insert([{
    order_number:    orderNum,
    raw_text:        order.raw_text || '',
    partner_name:    order.partner_name || null,
    customer_name:   order.customer_name || 'Unknown',
    customer_phone1: order.customer_phone1 || null,
    customer_phone2: order.customer_phone2 || null,
    product:         order.product || '',
    amount:          Number(order.amount) || 0,
    raw_address:     order.address || '',
    zone:            order.zone || 'UNASSIGNED',
    verified:        true,
    status:          'pending',
    report:          order.notes || null,
    closer_name:     order.closer_name || null,
    closer_phone:    order.closer_phone || null,
    order_date:      today,
    dispatcher_name: autoCaption || null,
    updated_by:      autoCaption ? 'Bot' : null,
  }]);

  if (error) {
    console.error('❌ Supabase save error:', error.message);
    return false;
  }

  console.log(`✅ Order #${orderNum} saved — Zone: ${order.zone}`);
  return { success: true, orderNumber: orderNum };
}

async function getOrdersByZone(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .gte('created_at', start.toISOString())
    .order('zone').order('created_at');
  if (error) { console.error('❌ Fetch error:', error.message); return []; }
  return data || [];
}

async function updateOrderStatus(id, status, paymentMethod = null) {
  const update = { status };
  if (paymentMethod) update.payment_method = paymentMethod;
  const { error } = await supabase.from('orders').update(update).eq('id', id);
  if (error) { console.error('❌ Update error:', error.message); return false; }
  return true;
}

module.exports = { saveOrder, getOrdersByZone, updateOrderStatus, getNextOrderNumberStart };
