import Base
import ./Policy.bend as Policy
import ./LAWS.bend as Laws

def Laws.conservation(balance, keep):
  match balance keep:
    case 0n _:
      {==}
    case 1n+b 0n:
      {==}
    case 1n+b 1n+k:
      %Laws.conservation(b, k) : {1n+Nat.add(Policy.retained(b, k), Policy.spare(b, k)) == 1n+_ : Nat}
      {==}

def Laws.exact_surplus(keep, amount):
  match keep amount:
    case 0n 0n:
      {==}
    case 0n 1n+a:
      {==}
    case 1n+k _:
      Laws.exact_surplus(k, amount)

def Laws.inactive_cannot_spend(balance, keep, fees, authorized):
  {==}

def Laws.external_authority_cannot_spend(balance, keep, fees, active):
  match active:
    case False{}:
      {==}
    case True{}:
      {==}

def Laws.fees_and_reserve_are_kept(keep, fees, amount):
  %Equal.sym(Nat, Policy.spare(Nat.add(keep, Nat.add(fees, amount)), keep), Nat.add(fees, amount), Laws.exact_surplus(keep, Nat.add(fees, amount))) : {Policy.spare(_, fees) == amount : Nat}
  Laws.exact_surplus(fees, amount)
