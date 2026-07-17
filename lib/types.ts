export type TabType = "recurring" | "one_time";

export type Tab = {
  id: string;
  name: string;
  type: TabType;
  recurrence_cron: string | null;
  created_at: string;
};

export type Member = {
  id: string;
  tab_id: string;
  display_name: string;
  evm_address: string;
  arc_recipient_address: string;
  created_at: string;
};

export type Charge = {
  id: string;
  tab_id: string;
  paid_by_member_id: string;
  amount_usdc: string;
  description: string;
  split_among: string[];
  created_at: string;
};

// "email" is a single merged namespace for both Google sign-in and Email-OTP:
// both verify the same email address, so a person who uses either resolves to
// one account + one wallet (refId "email:<addr>"). Deliberately unlike the
// X/Discord rule where separate providers never link.
export type IdentityProvider = "x" | "discord" | "email";

export type AppUser = {
  id: string;
  provider: IdentityProvider;
  provider_user_id: string;
  handle: string;
  name: string | null;
  avatar_url: string | null;
  wallet_address: string | null;
  circle_wallet_id: string | null;
  pin_hash: string | null;
  created_at: string;
};

export type Bill = {
  id: string;
  creator_user_id: string;
  merchant: string | null;
  currency: string;
  total_usdc: string;
  metadata: unknown;
  created_at: string;
};

export type BillDebt = {
  id: string;
  bill_id: string;
  debtor_provider: IdentityProvider;
  debtor_handle: string;
  debtor_user_id: string | null;
  amount_usdc: string;
  status: "pending" | "settling" | "paid";
  paid_tx_hash: string | null;
  paid_at: string | null;
  created_at: string;
};

export type NetPosition = {
  memberId: string;
  amountMicros: bigint;
};

export type NetTransfer = {
  fromMemberId: string;
  toMemberId: string;
  amountMicros: bigint;
};

export type SettlementPreview = {
  positions: NetPosition[];
  transfers: NetTransfer[];
  naiveTransactionCount: number;
  nettedTransactionCount: number;
};
