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

  // ── Use suggested number from bulk loop if no group number ──
  if ((!orderNum || orderNum === 'undefined') && order.suggested_number) {
    orderNum = String(order.suggested_number);
    console.log(`🔢 Using suggested order number: #${orderNum}`);
  } else if (!orderNum || orderNum === 'undefined') {
    orderNum = await getNextOrderNumber(today);
    console.log(`🔢 Auto-assigned order number: #${orderNum}`);
  }

  // ── Duplicate order_number check — scoped per captain ──
  // Abdul's #5 and Anita's #5 are different orders — no conflict.
  // Only block if the SAME captain already has this number today with a different customer.
  if (orderNum) {
    const captainForCheck = order.force_captain || null;
    let dupQuery = supabase
      .from('orders')
      .select('id, customer_name')
      .eq('order_number', orderNum)
      .eq('order_date', today);
    if (captainForCheck) {
      dupQuery = dupQuery.eq('dispatcher_name', captainForCheck);
    }
    const { data: numDup } = await dupQuery.limit(1);
    if (numDup && numDup.length > 0) {
      // Same captain already has this #number → reassign to global max+1
      const nextAvailable = await getNextOrderNumber(today);
      console.log(`📝 #${orderNum} already used by ${captainForCheck || 'unassigned'} → reassigning to #${nextAvailable}`);
      orderNum = nextAvailable;
    }
  }

  // ── True duplicate: same phone + same product + same day → block ──
  if (order.customer_phone1 && order.product) {
    const normalizePhone = p => p.replace(/\s+/g,'')
      .replace(/^\+234/,'0')
      .replace(/^234(?=\d{10})/,'0');
    const incomingPhone = normalizePhone(order.customer_phone1);

    const { data: todayOrders } = await supabase
      .from('orders')
      .select('id, customer_phone1')
      .eq('order_date', today)
      .ilike('product', `%${(order.product).split(' ')[0]}%`);

    const exactDup = (todayOrders || []).find(o => {
      if (!o.customer_phone1) return false;
      return normalizePhone(o.customer_phone1) === incomingPhone;
    });

    if (exactDup) {
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
      const baseNum = sameCustomer[0].order_number.replace(/[a-z]+$/, '');
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

  // ── Captain assignment ──
  // force_captain (from Captain: prefix) takes priority over zone auto-assign
  let autoCaption = order.force_captain || null;

  if (!autoCaption && order.zone && order.zone !== 'UNASSIGNED') {
    const { data: zoneMap } = await supabase
      .from('zone_assignments')
      .select('dispatcher_name')
      .eq('zone', order.zone);

    if (zoneMap && zoneMap.length > 0) {
      const captains = zoneMap.map(r => r.dispatcher_name);
      const { data: present } = await supabase
        .from('attendance')
        .select('dispatcher_name')
        .in('dispatcher_name', captains)
        .eq('date', today)
        .eq('present', true);

      if (present && present.length > 0) {
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
        console.log(`🚴 Zone auto-assigned to ${autoCaption} for zone ${order.zone}`);
      }
    }
  }

  const updatedBy = order.force_captain ? 'Staff' : (autoCaption ? 'Bot' : null);

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
    updated_by:      updatedBy,
  }]);

  if (error) {
    console.error('❌ Supabase save error:', error.message);
    return false;
  }

  console.log(`✅ Order #${orderNum} saved — Zone: ${order.zone} — Captain: ${autoCaption || 'unassigned'}`);
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

// Called when dashboard manually assigns a dispatcher to an order
async function assignCaptain(orderId, dispatcherName) {
  const { error } = await supabase
    .from('orders')
    .update({ dispatcher_name: dispatcherName, updated_by: 'Dashboard' })
    .eq('id', orderId);
  if (error) { console.error('❌ Assign captain error:', error.message); return false; }
  console.log(`🚴 Manually assigned ${dispatcherName} to order ${orderId}`);
  return true;
}

module.exports = { saveOrder, getOrdersByZone, updateOrderStatus, getNextOrderNumberStart, assignCaptain };
