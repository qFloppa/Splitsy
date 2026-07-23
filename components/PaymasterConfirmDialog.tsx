"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, Fuel, PenLine, X } from "lucide-react";

// Shown only when a payer bridging from a non-Arc chain has no native gas token
// (ETH/AVAX/POL) for that chain. Circle Paymaster lets them pay the source-chain
// gas in USDC instead — but it costs two extra wallet signatures (a one-time
// 7702 account authorization and a USDC permit), so we surface exactly what
// they'll be asked to sign before starting, so the signature prompts are trusted.
export type PaymasterConfirmContext = {
  sourceLabel: string;
  amountLabel: string;
  nativeSymbol: string;
};

export function PaymasterConfirmDialog({
  context,
  onConfirm,
  onCancel,
}: {
  context: PaymasterConfirmContext | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog.Root
      open={Boolean(context)}
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="pay-modal-overlay" />
        <Dialog.Content aria-describedby="paymaster-confirm-sub" className="pay-modal">
          <div className="pay-modal-head">
            <span className="pay-modal-icon" aria-hidden="true">
              <Fuel size={22} />
            </span>
            <div className="min-w-0">
              <Dialog.Title className="pay-modal-title">Pay gas in USDC?</Dialog.Title>
              <Dialog.Description className="pay-modal-sub" id="paymaster-confirm-sub">
                {context
                  ? `Your wallet has no ${context.nativeSymbol} on ${context.sourceLabel} to cover gas. Circle Paymaster can cover it in USDC instead so you can bridge $${context.amountLabel} to Arc.`
                  : null}
              </Dialog.Description>
            </div>
            <Dialog.Close className="icon-button pay-modal-close" aria-label="Close">
              <X size={17} />
            </Dialog.Close>
          </div>

          <ol className="pay-steps">
            <li className="pay-step" data-state="idle">
              <span className="pay-step-icon" aria-hidden="true">
                <PenLine size={15} />
              </span>
              <span className="pay-step-body">
                <span className="pay-step-label">Two extra signatures</span>
                <span className="pay-step-hint">
                  A one-time account authorization (EIP-7702) and a USDC spending permit. Both are
                  off-chain signatures — no separate transaction and no native gas.
                </span>
              </span>
            </li>
            <li className="pay-step" data-state="idle">
              <span className="pay-step-icon" aria-hidden="true">
                <Fuel size={15} />
              </span>
              <span className="pay-step-body">
                <span className="pay-step-label">Gas deducted from your USDC</span>
                <span className="pay-step-hint">
                  The source-chain gas fee is taken from the USDC you&apos;re bridging, so you never
                  need the native token.
                </span>
              </span>
            </li>
          </ol>

          <div className="pay-modal-foot">
            <span className="pay-modal-status">
              <AlertTriangle size={15} />
              Sign twice in your wallet.
            </span>
            <div style={{ display: "flex", gap: "0.6rem" }}>
              <button className="secondary-button" onClick={onCancel} type="button">
                Cancel
              </button>
              <button className="primary-button" onClick={onConfirm} type="button">
                Use Paymaster
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
