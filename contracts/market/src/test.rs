#![cfg(test)]
use super::*;
use soroban_sdk::{testutils::{Address as _, Ledger}, token, Address, Env};

const D: i128 = 10_000_000; // 1 unit = 1e7 (7 decimals)

fn new_token<'a>(env: &Env, admin: &Address) -> (Address, token::StellarAssetClient<'a>) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    (sac.address(), token::StellarAssetClient::new(env, &sac.address()))
}

fn advance(env: &Env, secs: u64) {
    env.ledger().with_mut(|l| { l.timestamp += secs; });
}

fn setup<'a>() -> (Env, UmbraMarketClient<'a>, Address, token::StellarAssetClient<'a>, token::StellarAssetClient<'a>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| { l.timestamp = 1_700_000_000; });
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = new_token(&env, &admin);
    let (eurc, eurc_admin) = new_token(&env, &admin);
    let id = env.register(UmbraMarket, ());
    let c = UmbraMarketClient::new(&env, &id);
    // EURC = 1.08 USD
    c.init(&admin, &usdc, &eurc, &(108 * PRICE_SCALE / 100));
    (env, c, admin, usdc_admin, eurc_admin, usdc, eurc)
}

#[test]
fn supply_and_zero_apy() {
    let (env, c, _admin, usdc_admin, _eurc_admin, _usdc, _eurc) = setup();
    let alice = Address::generate(&env);
    usdc_admin.mint(&alice, &(1000 * D));
    c.supply(&alice, &1, &(1000 * D));
    assert_eq!(c.total_supplied(&1), 1000 * D);
    assert_eq!(c.reserve(&1), 1000 * D);
    // nothing borrowed -> APY is exactly 0
    assert_eq!(c.supply_rate_bps(&1), 0);
    assert_eq!(c.borrow_rate_bps(&1), 0);
    assert_eq!(c.utilization_bps(&1), 0);
}

#[test]
fn borrow_raises_apy_and_accrues_interest() {
    let (env, c, _admin, usdc_admin, eurc_admin, _usdc, _eurc) = setup();
    let lp = Address::generate(&env);
    let bob = Address::generate(&env);
    // LP supplies USDC liquidity; Bob supplies EURC collateral and borrows USDC
    usdc_admin.mint(&lp, &(1000 * D));
    c.supply(&lp, &1, &(1000 * D));
    eurc_admin.mint(&bob, &(1000 * D));
    c.supply(&bob, &2, &(1000 * D)); // ~1080 USD collateral
    c.borrow(&bob, &1, &(500 * D)); // 50% utilization of USDC

    assert_eq!(c.utilization_bps(&1), 5000); // 50%
    let bapr = c.borrow_rate_bps(&1);
    assert!(bapr > 0, "borrow apr should be positive once utilised");
    let sapr = c.supply_rate_bps(&1);
    assert!(sapr > 0 && sapr < bapr, "supply apr is borrowAPR*utilisation");

    // a year passes -> debt grows, LP's claim grows
    let debt0 = c.position(&bob, &1).borrowed;
    advance(&env, YEAR as u64);
    c.set_price(&(108 * PRICE_SCALE / 100)); // touch (accrual happens on interaction)
    let debt1 = c.position(&bob, &1).borrowed;
    assert!(debt1 > debt0, "interest must accrue on the debt");
    let lp_claim = c.position(&lp, &1).supplied;
    assert!(lp_claim > 1000 * D, "supplier earns the interest");
}

#[test]
fn swap_respects_reserves_and_pays_lp_fees() {
    let (env, c, _admin, usdc_admin, eurc_admin, _usdc, _eurc) = setup();
    let lp = Address::generate(&env);
    let trader = Address::generate(&env);
    // pool has only 100 EURC of liquidity
    eurc_admin.mint(&lp, &(100 * D));
    c.supply(&lp, &2, &(100 * D));
    usdc_admin.mint(&trader, &(1000 * D));

    // swap that needs more EURC than the pool holds must fail
    let too_big = c.try_swap(&trader, &1, &(1000 * D), &0);
    assert!(too_big.is_err(), "swap must revert when reserves are insufficient");

    // a swap the pool CAN honour succeeds and pays a fee to EURC... no: fee is on input (USDC)
    let lp_usdc_before = c.position(&lp, &1).supplied; // 0 (lp only supplied EURC)
    // give the USDC pool some suppliers so the fee has a home
    usdc_admin.mint(&lp, &(10 * D));
    c.supply(&lp, &1, &(10 * D));
    let usd_claim_before = c.position(&lp, &1).supplied;

    let out = c.swap(&trader, &1, &(50 * D), &0); // 50 USDC -> EURC
    assert!(out > 0 && c.reserve(&2) < 100 * D, "trader received EURC from the pool");
    // 0.30% of 50 USDC fee accrued to USDC suppliers
    let usd_claim_after = c.position(&lp, &1).supplied;
    assert!(usd_claim_after > usd_claim_before, "swap fee lifts USDC suppliers' claim");
    assert!(c.cum_fees(&1) > 0, "cumulative fees tracked");
    let _ = lp_usdc_before;
}

#[test]
fn undercollateralised_position_can_be_liquidated() {
    let (env, c, _admin, usdc_admin, eurc_admin, _usdc, _eurc) = setup();
    let lp = Address::generate(&env);
    let bob = Address::generate(&env);
    let keeper = Address::generate(&env);
    usdc_admin.mint(&lp, &(10_000 * D));
    c.supply(&lp, &1, &(10_000 * D));
    eurc_admin.mint(&bob, &(1000 * D));
    c.supply(&bob, &2, &(1000 * D)); // 1080 USD collateral
    c.borrow(&bob, &1, &(800 * D)); // near the LTV limit
    assert!(c.health(&bob) >= WAD, "starts healthy");

    // EURC crashes to 0.80 USD -> collateral 800, debt 800, health < threshold
    c.set_price(&(80 * PRICE_SCALE / 100));
    assert!(c.health(&bob) < WAD, "now underwater");

    usdc_admin.mint(&keeper, &(1000 * D));
    let bob_eurc_before = c.position(&bob, &2).supplied;
    c.liquidate(&keeper, &bob, &1, &2, &(400 * D)); // repay up to 50% of debt
    let bob_eurc_after = c.position(&bob, &2).supplied;
    assert!(bob_eurc_after < bob_eurc_before, "collateral seized from the borrower");
    assert!(c.position(&bob, &1).borrowed < 800 * D, "debt reduced by the repayment");
}

#[test]
fn cannot_borrow_beyond_ltv() {
    let (env, c, _admin, usdc_admin, eurc_admin, _usdc, _eurc) = setup();
    let lp = Address::generate(&env);
    let bob = Address::generate(&env);
    usdc_admin.mint(&lp, &(10_000 * D));
    c.supply(&lp, &1, &(10_000 * D));
    eurc_admin.mint(&bob, &(100 * D));
    c.supply(&bob, &2, &(100 * D)); // 108 USD collateral -> 86.4 USD borrowable
    let over = c.try_borrow(&bob, &1, &(100 * D)); // 100 USD > limit
    assert!(over.is_err(), "borrow beyond LTV must revert");
    c.borrow(&bob, &1, &(80 * D)); // within limit
    assert_eq!(c.position(&bob, &1).borrowed, 80 * D);
}
