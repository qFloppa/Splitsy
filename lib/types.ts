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

export type AppUser = {
  id: string;
  x_user_id: string;
  x_handle: string;
  x_name: string | null;
  x_avatar_url: string | null;
  email: string | null;
  wallet_address: string | null;
  circle_wallet_id: string | null;
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
