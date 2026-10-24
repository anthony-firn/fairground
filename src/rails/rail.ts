/** A way to pay someone directly. Fairground only reads the public record; it never holds funds. */
export interface Transfer {
  id: string;
  sender: string;
  receiver: string;
  /** Base units of the rail's asset; for USD stablecoins, micro-dollars. */
  amount: bigint;
  note: string;
  /** Unix seconds when the transfer was confirmed. */
  time: number;
}

export interface TransferQuery {
  address: string;
  /** Whether `address` received or sent the transfers. */
  role: 'receiver' | 'sender';
  /** Only transfers whose memo starts with this. */
  notePrefix: string;
  /** Unix seconds, [from, to). */
  from: number;
  to: number;
}

export interface PaymentRequest {
  to: string;
  amount: bigint;
  memo: string;
}

export interface Rail {
  id: string;
  label: string;
  isAddress(address: string): boolean;
  /** Whether the address can receive this rail's asset right now. */
  canReceive(address: string): Promise<boolean>;
  /** A confirmed transfer of this rail's asset; throws for anything else. */
  fetchTransfer(txid: string): Promise<Transfer>;
  listTransfers(query: TransferQuery): Promise<Transfer[]>;
  /** A link that opens the payer's wallet with the payment filled in. */
  paymentLink(request: PaymentRequest): string;
}
