import Base

# Saturating subtraction; structurally recursive over natural numbers.
def spare(balance: Nat, keep: Nat) -> Nat:
  match balance keep:
    case 0n _:
      0n
    case 1n+b 0n:
      1n+b
    case 1n+b 1n+k:
      spare(b, k)

def retained(balance: Nat, keep: Nat) -> Nat:
  match balance keep:
    case 0n _:
      0n
    case 1n+b 0n:
      0n
    case 1n+b 1n+k:
      1n+retained(b, k)

def limit(balance: Nat, keep: Nat, fees: Nat, active: Bool, authorized: Bool) -> Nat:
  match active authorized:
    case True{} True{}:
      spare(spare(balance, keep), fees)
    case _ _:
      0n
