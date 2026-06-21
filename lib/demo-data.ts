import type { Charge, Member, Tab } from "./types";

export const demoTab: Tab = {
  id: "tab-demo",
  name: "June house tab",
  type: "recurring",
  recurrence_cron: "0 0 1 * *",
  created_at: "2026-06-01T00:00:00.000Z",
};

export const demoMembers: Member[] = [
  {
    id: "alice",
    tab_id: demoTab.id,
    display_name: "Alice",
    evm_address: "0x8EBA4688BDeF3E311b846F25870A19B900000001",
    arc_recipient_address: "0xA7c0000000000000000000000000000000000001",
    created_at: "2026-06-01T00:00:00.000Z",
  },
  {
    id: "bob",
    tab_id: demoTab.id,
    display_name: "Bob",
    evm_address: "0x8EBA4688BDeF3E311b846F25870A19B900000002",
    arc_recipient_address: "0xA7c0000000000000000000000000000000000002",
    created_at: "2026-06-01T00:00:00.000Z",
  },
  {
    id: "carla",
    tab_id: demoTab.id,
    display_name: "Carla",
    evm_address: "0x8EBA4688BDeF3E311b846F25870A19B900000003",
    arc_recipient_address: "0xA7c0000000000000000000000000000000000003",
    created_at: "2026-06-01T00:00:00.000Z",
  },
  {
    id: "dev",
    tab_id: demoTab.id,
    display_name: "Dev",
    evm_address: "0x8EBA4688BDeF3E311b846F25870A19B900000004",
    arc_recipient_address: "0xA7c0000000000000000000000000000000000004",
    created_at: "2026-06-01T00:00:00.000Z",
  },
];

export const demoCharges: Charge[] = [
  {
    id: "charge-rent",
    tab_id: demoTab.id,
    paid_by_member_id: "alice",
    amount_usdc: "120.00",
    description: "Internet and utilities",
    split_among: ["alice", "bob", "carla", "dev"],
    created_at: "2026-06-05T18:30:00.000Z",
  },
  {
    id: "charge-supplies",
    tab_id: demoTab.id,
    paid_by_member_id: "bob",
    amount_usdc: "30.00",
    description: "Kitchen restock",
    split_among: ["alice", "carla", "dev"],
    created_at: "2026-06-10T13:15:00.000Z",
  },
];
