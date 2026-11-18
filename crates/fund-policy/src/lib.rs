//! Small, dependency-free signing policy. No keys, network, allocation or unsafe blocks.
#![cfg_attr(all(target_arch = "wasm32", not(test)), no_std)]
#![deny(unsafe_code)]
#![deny(unsafe_op_in_unsafe_fn)]

#[cfg(all(target_arch = "wasm32", not(test)))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { core::arch::wasm32::unreachable() }

// The only unsafe-code lint allowance names the three Wasm ABI exports.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn wallet_reserve(minimum: u64) -> u64 {
    minimum.saturating_add(300_000).max(500_000)
}

// The only unsafe-code lint allowance names the three Wasm ABI exports.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn conversion_limit(balance: u64, minimum: u64, fee_cap: u64, active: u32, authorized: u32) -> u64 {
    if active != 1 || authorized != 1 { return 0; }
    balance.saturating_sub(wallet_reserve(minimum)).saturating_sub(fee_cap)
}

// The only unsafe-code lint allowance names the three Wasm ABI exports.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn budget_allowed(balance: u64, minimum: u64, amount: u64, fees: u64, fee_cap: u64) -> u32 {
    if amount == 0 || fees > fee_cap { return 0; }
    // Subtract from available balance. Never add untrusted u64 amounts.
    let Some(after_reserve) = balance.checked_sub(wallet_reserve(minimum)) else { return 0; };
    let Some(after_amount) = after_reserve.checked_sub(amount) else { return 0; };
    u32::from(fees <= after_amount)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn boundary_and_overflow_safety() {
        assert_eq!(wallet_reserve(100_000), 500_000);
        assert_eq!(wallet_reserve(u64::MAX), u64::MAX);
        assert_eq!(conversion_limit(1_101_016,200_000,20_000,1,1),581_016);
        assert_eq!(conversion_limit(u64::MAX,u64::MAX,20_000,1,1),0);
        assert_eq!(conversion_limit(u64::MAX,0,0,2,1),0);
        assert_eq!(conversion_limit(u64::MAX,0,0,1,0),0);
        assert_eq!(budget_allowed(u64::MAX,0,u64::MAX,u64::MAX,u64::MAX),0);
        assert_eq!(budget_allowed(1_101_016,200_000,581_016,20_000,20_000),1);
        assert_eq!(budget_allowed(1_101_016,200_000,581_017,20_000,20_000),0);
    }
}
