import Base
import ./Policy.bend as Policy

law conservation:
  for +balance: Nat
  for +keep: Nat
  {Nat.add(Policy.retained(balance, keep), Policy.spare(balance, keep)) == balance : Nat}

law exact_surplus:
  for +keep: Nat
  for +amount: Nat
  {Policy.spare(Nat.add(keep, amount), keep) == amount : Nat}

law inactive_cannot_spend:
  for +balance: Nat
  for +keep: Nat
  for +fees: Nat
  for +authorized: Bool
  {Policy.limit(balance, keep, fees, False{}, authorized) == 0n : Nat}

law external_authority_cannot_spend:
  for +balance: Nat
  for +keep: Nat
  for +fees: Nat
  for +active: Bool
  {Policy.limit(balance, keep, fees, active, False{}) == 0n : Nat}

law fees_and_reserve_are_kept:
  for +keep: Nat
  for +fees: Nat
  for +amount: Nat
  {Policy.limit(Nat.add(keep, Nat.add(fees, amount)), keep, fees, True{}, True{}) == amount : Nat}
