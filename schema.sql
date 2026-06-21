-- Enable UUID extension if not enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create tabs table
CREATE TABLE IF NOT EXISTS tabs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('recurring', 'one_time')),
    recurrence_cron TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create members table
CREATE TABLE IF NOT EXISTS members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tab_id UUID NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    evm_address TEXT NOT NULL,
    arc_recipient_address TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tab_id, evm_address)
);

-- Create charges table
CREATE TABLE IF NOT EXISTS charges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tab_id UUID NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
    paid_by_member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    amount_usdc NUMERIC(20, 6) NOT NULL,
    description TEXT NOT NULL,
    split_among UUID[] NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create settlements table
CREATE TABLE IF NOT EXISTS settlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tab_id UUID NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'settling', 'settled', 'failed')),
    net_transfers JSONB NOT NULL DEFAULT '[]'::jsonb,
    settled_at TIMESTAMPTZ
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_members_tab_id ON members(tab_id);
CREATE INDEX IF NOT EXISTS idx_charges_tab_id ON charges(tab_id);
CREATE INDEX IF NOT EXISTS idx_settlements_tab_id ON settlements(tab_id);
