-- Run in Supabase → SQL Editor → New Query

CREATE TABLE IF NOT EXISTS orders (
  id               SERIAL PRIMARY KEY,
  dispatcher_phone TEXT,
  dispatcher_name  TEXT,
  product          TEXT,
  customer_name    TEXT,
  customer_phone   TEXT,
  customer_email   TEXT,
  quantity         INTEGER DEFAULT 1,
  address          TEXT,
  status           TEXT DEFAULT 'new',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_insert" ON orders FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_select" ON orders FOR SELECT TO anon USING (true);
