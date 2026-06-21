import type { Charge, Member, NetPosition, NetTransfer, SettlementPreview } from "./types";

const USDC_SCALE = 1_000_000n;

export function parseUsdcToMicros(value: string | number): bigint {
  const normalized = String(value).trim();

  if (!/^\d+(\.\d{0,6})?$/.test(normalized)) {
    throw new Error(`Invalid USDC amount: ${normalized}`);
  }

  const [whole, fractional = ""] = normalized.split(".");
  return BigInt(whole) * USDC_SCALE + BigInt(fractional.padEnd(6, "0"));
}

export function formatUsdcFromMicros(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / USDC_SCALE;
  const fractional = absolute % USDC_SCALE;
  const cents = (fractional / 10_000n).toString().padStart(2, "0");

  return `${sign}${whole}.${cents}`;
}

export function computeNetPositions(members: Member[], charges: Charge[]): NetPosition[] {
  const memberIds = new Set(members.map((member) => member.id));
  const positions = new Map(members.map((member) => [member.id, 0n]));

  for (const charge of charges) {
    if (!memberIds.has(charge.paid_by_member_id)) {
      throw new Error(`Unknown payer: ${charge.paid_by_member_id}`);
    }

    const splitAmong = charge.split_among.filter((memberId, index, all) => {
      return all.indexOf(memberId) === index;
    });

    if (splitAmong.length === 0) {
      throw new Error(`Charge ${charge.id} has no split members`);
    }

    for (const memberId of splitAmong) {
      if (!memberIds.has(memberId)) {
        throw new Error(`Unknown split member: ${memberId}`);
      }
    }

    const amount = parseUsdcToMicros(charge.amount_usdc);
    const baseShare = amount / BigInt(splitAmong.length);
    let remainder = amount % BigInt(splitAmong.length);

    positions.set(
      charge.paid_by_member_id,
      (positions.get(charge.paid_by_member_id) ?? 0n) + amount,
    );

    for (const memberId of splitAmong) {
      const extraMicro = remainder > 0n ? 1n : 0n;
      remainder -= extraMicro;
      positions.set(memberId, (positions.get(memberId) ?? 0n) - baseShare - extraMicro);
    }
  }

  return members.map((member) => ({
    memberId: member.id,
    amountMicros: positions.get(member.id) ?? 0n,
  }));
}

export function computeNaiveTransactionCount(charges: Charge[]): number {
  return charges.reduce((count, charge) => {
    return (
      count +
      charge.split_among.filter((memberId, index, all) => {
        return memberId !== charge.paid_by_member_id && all.indexOf(memberId) === index;
      }).length
    );
  }, 0);
}

export function computeMinimumTransfers(positions: NetPosition[]): NetTransfer[] {
  const debtors = positions
    .filter((position) => position.amountMicros < 0n)
    .map((position) => ({ memberId: position.memberId, amountMicros: -position.amountMicros }));
  const creditors = positions
    .filter((position) => position.amountMicros > 0n)
    .map((position) => ({ ...position }));
  const transfers: NetTransfer[] = [];

  while (debtors.length > 0 && creditors.length > 0) {
    debtors.sort((a, b) => compareBigIntDescending(a.amountMicros, b.amountMicros));
    creditors.sort((a, b) => compareBigIntDescending(a.amountMicros, b.amountMicros));

    const debtor = debtors[0];
    const creditor = creditors[0];
    const amountMicros =
      debtor.amountMicros < creditor.amountMicros ? debtor.amountMicros : creditor.amountMicros;

    if (amountMicros <= 0n) {
      break;
    }

    transfers.push({
      fromMemberId: debtor.memberId,
      toMemberId: creditor.memberId,
      amountMicros,
    });

    debtor.amountMicros -= amountMicros;
    creditor.amountMicros -= amountMicros;

    if (debtor.amountMicros === 0n) {
      debtors.shift();
    }

    if (creditor.amountMicros === 0n) {
      creditors.shift();
    }
  }

  return transfers;
}

export function previewSettlement(members: Member[], charges: Charge[]): SettlementPreview {
  const positions = computeNetPositions(members, charges);
  const transfers = computeMinimumTransfers(positions);

  return {
    positions,
    transfers,
    naiveTransactionCount: computeNaiveTransactionCount(charges),
    nettedTransactionCount: transfers.length,
  };
}

function compareBigIntDescending(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }

  return left > right ? -1 : 1;
}
