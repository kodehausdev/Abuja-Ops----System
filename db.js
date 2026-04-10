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

  // Extract numeric part only, find max
  const nums = data
    .map(r => parseInt(r.order_number))
    .filter(n => !isNaN(n));

  return nums.length > 0 ? String(Math.max(...nums) + 1) : '1';
}

async function saveOrder(order) {
  const today = watDate();
  let orderNum = String(order.order_number || '').trim();

  // ── Auto-assign if no order number provided ──────────────────
  if (!orderNum || orderNum === 'undefined') {
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

  // ── Same customer, same number, different product = bundle → suffix ──
  if (orderNum && order.customer_phone1) {
    const { data: sameCustomer } = await supabase
      .from('orders')
      .select('order_number')
      .eq('customer_phone1', order.customer_phone1)
      .like('order_number', `${orderNum}%`)
      .eq('order_date', today);

    if (sameCustomer && sameCustomer.length > 0) {
      const suffixes = sameCustomer
        .map(r => r.order_number.replace(orderNum, ''))
        .filter(s => /^[a-z]?$/.test(s));
      const lastSuffix = suffixes.filter(s => s.length === 1).sort().pop();
      orderNum = lastSuffix
        ? `${orderNum}${String.fromCharCode(lastSuffix.charCodeAt(0) + 1)}`
        : `${orderNum}a`;
      console.log(`📝 Bundle detected — suffixed to: ${orderNum}`);
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

module.exports = { saveOrder, getOrdersByZone, updateOrderStatus };