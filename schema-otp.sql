-- schema-otp.sql — one-time passcodes for Email-OTP sign-in. Run once in the
-- Supabase SQL editor. A row is a pending challenge for an email address; it's
-- consumed on successful verify and expires quickly. The code is stored HASHED
-- (salted scrypt, same format as pin_hash) — never in plaintext.

create table if not exists email_otps (
  email text primary key,           -- one pending challenge per address (upsert on resend)
  code_hash text not null,          -- "<saltHex>:<hashHex>" scrypt of the 6-digit code
  expires_at timestamptz not null,  -- typically now() + 10 minutes
  attempts int not null default 0,  -- wrong-guess counter; locked out past a cap
  created_at timestamptz not null default now()
);

create index if not exists idx_email_otps_expires on email_otps (expires_at);
