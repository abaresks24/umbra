#![no_std]
//! Umbra Market — a real, transparent money market + oracle-priced AMM for two
//! assets (USDC = 1, EURC = 2). Liquidity is SHARED: suppliers' cash backs both
//! lending and swaps, so a supplier earns lending interest (utilization-based) AND
//! swap fees. Accounting is cash-based: the contract's real token balance is the
//! reserve, so every outflow (withdraw / borrow / swap-out / liquidation) is hard-
//! checked against actual cash — a swap can only execute if the pool truly holds
//! enough of the output asset.
//!
//! Privacy model: this layer is intentionally transparent (amounts are public) so
//! reserves, utilization and fees are verifiable on-chain. Anonymity comes from the
//! shielded pool that funds the addresses interacting here (private capital, public
//! DeFi). Interest accrues per-interaction via supply/borrow indices.
use soroban_sdk::{contract, contractclient, contractimpl, contracttype, symbol_short, token, Address, Env, Symbol};

// ----- Reflector SEP-40 price oracle (on-chain EUR/USD) -----
// The market reads EUR/USD straight from Reflector's decentralised forex feed, so
// the price is a real on-chain oracle value, not an admin push. USDC is treated as
// USD (the oracle's base). EURC is priced via lastprice(Other("EUR")).
#[contracttype]
#[derive(Clone)]
pub enum OracleAsset {
    Stellar(Address),
    Other(Symbol),
}
#[contracttype]
#[derive(Clone)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}
#[contractclient(name = "OracleClient")]
pub trait OracleInterface {
    fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData>;
    fn decimals(env: Env) -> u32;
}

// ----- fixed-point scales -----
const WAD: i128 = 1_000_000_000_000; // 1e12 — index & rate scale
const PRICE_SCALE: i128 = 10_000_000; // 1e7 — oracle price (USDC = 1.0 implicit)
const BPS: i128 = 10_000;
const YEAR: i128 = 31_536_000; // seconds

// ----- interest-rate model (kinked, Aave-style); APR in WAD -----
const KINK: i128 = 800_000_000_000; // 0.80 utilization
const SLOPE1: i128 = 40_000_000_000; // +4% APR reached at the kink
const SLOPE2: i128 = 750_000_000_000; // steep slope above the kink
// base rate is 0 -> APY is exactly 0% when nothing is borrowed.

// ----- risk parameters (WAD) -----
const LTV: i128 = 800_000_000_000; // 0.80 — borrow up to 80% of collateral value
const LIQ_THRESHOLD: i128 = 850_000_000_000; // 0.85 — below this, liquidatable
const LIQ_BONUS: i128 = 50_000_000_000; // 0.05 — 5% liquidation incentive
const CLOSE_FACTOR: i128 = 500_000_000_000; // 0.50 — at most half the debt per liquidation

// ----- swap -----
const SWAP_FEE_BPS: i128 = 30; // 0.30% taken from the input, paid to suppliers

#[contracttype]
#[derive(Clone)]
pub enum Key {
    Admin,
    Asset(u32),    // assetId -> token (SAC) address
    Price,         // EURC price in USD, scaled 1e7 (fallback if no oracle)
    Oracle,        // Reflector forex feed (SEP-40) address
    OracleDiv,     // divisor to bring the oracle's decimals down to PRICE_SCALE (1e7)
    Market(u32),   // assetId -> Market
    Supply(Address, u32), // account supply shares for an asset
    Borrow(Address, u32), // account borrow shares for an asset
}

#[contracttype]
#[derive(Clone)]
pub struct Market {
    pub supply_shares: i128, // total supply shares
    pub borrow_shares: i128, // total borrow shares
    pub supply_index: i128,  // WAD, grows with interest + swap fees
    pub borrow_index: i128,  // WAD, grows with interest
    pub last_accrual: u64,
    pub cum_fees: i128,      // cumulative swap fees credited to suppliers (asset units)
}

#[contracttype]
#[derive(Clone)]
pub struct Position {
    pub supplied: i128, // current value, this asset
    pub borrowed: i128, // current value, this asset
}

fn mul_div(a: i128, b: i128, d: i128) -> i128 { a * b / d }

fn fresh_market(now: u64) -> Market {
    Market { supply_shares: 0, borrow_shares: 0, supply_index: WAD, borrow_index: WAD, last_accrual: now, cum_fees: 0 }
}

fn get_market(env: &Env, asset: u32) -> Market {
    env.storage().persistent().get(&Key::Market(asset))
        .unwrap_or_else(|| fresh_market(env.ledger().timestamp()))
}
fn put_market(env: &Env, asset: u32, m: &Market) {
    env.storage().persistent().set(&Key::Market(asset), m);
    env.storage().persistent().extend_ttl(&Key::Market(asset), 100, 600_000);
}
fn get_shares(env: &Env, key: &Key) -> i128 {
    env.storage().persistent().get(key).unwrap_or(0)
}
fn put_shares(env: &Env, key: Key, v: i128) {
    if v == 0 { env.storage().persistent().remove(&key); return; }
    env.storage().persistent().set(&key, &v);
    env.storage().persistent().extend_ttl(&key, 100, 600_000);
}

fn token_of(env: &Env, asset: u32) -> Address {
    env.storage().instance().get(&Key::Asset(asset)).expect("asset not registered")
}
// USD price of one unit (1e7 scale). USDC == USD == 1.0. EURC comes from the
// Reflector oracle (live EUR/USD), falling back to the admin-set price if the feed
// has no data or no oracle is configured.
fn price_of(env: &Env, asset: u32) -> i128 {
    if asset == 1 { return PRICE_SCALE; }
    let s = env.storage().instance();
    if let Some(oracle) = s.get::<Key, Address>(&Key::Oracle) {
        let client = OracleClient::new(env, &oracle);
        // try_ variant: if the feed errors or has no data, fall back instead of trapping
        if let Ok(Ok(Some(pd))) = client.try_lastprice(&OracleAsset::Other(Symbol::new(env, "EUR"))) {
            let div: i128 = s.get(&Key::OracleDiv).unwrap_or(10_000_000);
            let p = pd.price / div;
            if p > 0 { return p; }
        }
    }
    s.get(&Key::Price).unwrap_or(PRICE_SCALE)
}
fn usd(env: &Env, asset: u32, amount: i128) -> i128 { mul_div(amount, price_of(env, asset), PRICE_SCALE) }
// physical cash the contract holds for an asset (the real reserve)
fn cash(env: &Env, asset: u32) -> i128 {
    token::TokenClient::new(env, &token_of(env, asset)).balance(&env.current_contract_address())
}

fn shares_to_amt(shares: i128, index: i128) -> i128 { mul_div(shares, index, WAD) }
fn amt_to_shares(amt: i128, index: i128) -> i128 { mul_div(amt, WAD, index) }

fn total_supply(m: &Market) -> i128 { shares_to_amt(m.supply_shares, m.supply_index) }
fn total_borrow(m: &Market) -> i128 { shares_to_amt(m.borrow_shares, m.borrow_index) }

// borrow APR (WAD) for a utilization u (WAD)
fn borrow_apr(u: i128) -> i128 {
    if u <= KINK {
        mul_div(SLOPE1, u, KINK)
    } else {
        SLOPE1 + mul_div(SLOPE2, u - KINK, WAD - KINK)
    }
}
fn utilization(m: &Market) -> i128 {
    let ts = total_supply(m);
    if ts <= 0 { return 0; }
    mul_div(total_borrow(m), WAD, ts)
}

// pure accrual: advance a market's indices to `now` (linear within dt; all interest
// to suppliers — reserve factor 0). No storage writes, so views can use it too.
fn accrued(mut m: Market, now: u64) -> Market {
    let dt = (now - m.last_accrual) as i128;
    if dt > 0 && m.borrow_shares > 0 {
        let u = utilization(&m);
        let bapr = borrow_apr(u);
        let bfac = WAD + mul_div(bapr, dt, YEAR);
        m.borrow_index = mul_div(m.borrow_index, bfac, WAD);
        let sapr = mul_div(bapr, u, WAD); // supplyAPR = borrowAPR * utilization
        let sfac = WAD + mul_div(sapr, dt, YEAR);
        m.supply_index = mul_div(m.supply_index, sfac, WAD);
    }
    m.last_accrual = now;
    m
}
// read the market with interest accrued to the current ledger time (no persist)
fn market_now(env: &Env, asset: u32) -> Market {
    accrued(get_market(env, asset), env.ledger().timestamp())
}
// accrue and persist; returns the fresh market
fn accrue(env: &Env, asset: u32) -> Market {
    let m = accrued(get_market(env, asset), env.ledger().timestamp());
    put_market(env, asset, &m);
    m
}

// account collateral (value * liquidation threshold) and total debt value, across
// both assets, using current indices.
fn account_health_values(env: &Env, who: &Address) -> (i128, i128, i128) {
    let mut coll_lt = 0i128; // sum(supplyUsd * LIQ_THRESHOLD)
    let mut coll_ltv = 0i128; // sum(supplyUsd * LTV) — borrowing power
    let mut debt = 0i128; // sum(borrowUsd)
    for asset in [1u32, 2u32] {
        let m = market_now(env, asset);
        let s = shares_to_amt(get_shares(env, &Key::Supply(who.clone(), asset)), m.supply_index);
        let b = shares_to_amt(get_shares(env, &Key::Borrow(who.clone(), asset)), m.borrow_index);
        if s > 0 {
            let v = usd(env, asset, s);
            coll_lt += mul_div(v, LIQ_THRESHOLD, WAD);
            coll_ltv += mul_div(v, LTV, WAD);
        }
        if b > 0 { debt += usd(env, asset, b); }
    }
    (coll_lt, coll_ltv, debt)
}

#[contract]
pub struct UmbraMarket;

#[contractimpl]
impl UmbraMarket {
    pub fn init(env: Env, admin: Address, usdc: Address, eurc: Address, eurc_price: i128) {
        let s = env.storage().instance();
        assert!(!s.has(&Key::Admin), "already initialised");
        s.set(&Key::Admin, &admin);
        s.set(&Key::Asset(1u32), &usdc);
        s.set(&Key::Asset(2u32), &eurc);
        s.set(&Key::Price, &eurc_price);
    }

    /// Fallback EUR/USD price (scaled 1e7), used only if the oracle has no data.
    pub fn set_price(env: Env, eurc_price: i128) {
        let admin: Address = env.storage().instance().get(&Key::Admin).expect("not init");
        admin.require_auth();
        assert!(eurc_price > 0, "bad price");
        env.storage().instance().set(&Key::Price, &eurc_price);
    }

    /// Wire the Reflector SEP-40 forex oracle. The contract then reads EUR/USD live
    /// on-chain. `div` normalises the oracle's decimals to 1e7 (Reflector forex uses
    /// 14 decimals -> div = 1e7). Passed in to avoid a cross-contract call here.
    pub fn set_oracle(env: Env, oracle: Address, div: i128) {
        let s = env.storage().instance();
        let admin: Address = s.get(&Key::Admin).expect("not init");
        admin.require_auth();
        assert!(div > 0, "bad divisor");
        s.set(&Key::Oracle, &oracle);
        s.set(&Key::OracleDiv, &div);
    }
    pub fn oracle(env: Env) -> Option<Address> { env.storage().instance().get(&Key::Oracle) }

    /// Supply liquidity (also counts as collateral). Pulls `amount` from `from`.
    pub fn supply(env: Env, from: Address, asset: u32, amount: i128) {
        from.require_auth();
        assert!(asset == 1 || asset == 2, "bad asset");
        assert!(amount > 0, "amount must be positive");
        let mut m = accrue(&env, asset);
        token::TokenClient::new(&env, &token_of(&env, asset)).transfer(&from, &env.current_contract_address(), &amount);
        let shares = amt_to_shares(amount, m.supply_index);
        m.supply_shares += shares;
        put_market(&env, asset, &m);
        let k = Key::Supply(from.clone(), asset);
        put_shares(&env, k.clone(), get_shares(&env, &k) + shares);
        env.events().publish((symbol_short!("supply"), asset), (from, amount));
    }

    /// Withdraw supplied liquidity. Blocked if it would leave you undercollateralised
    /// or if the pool lacks the cash.
    pub fn withdraw(env: Env, to: Address, asset: u32, amount: i128) {
        to.require_auth();
        assert!(asset == 1 || asset == 2, "bad asset");
        assert!(amount > 0, "amount must be positive");
        let mut m = accrue(&env, asset);
        let k = Key::Supply(to.clone(), asset);
        let have = shares_to_amt(get_shares(&env, &k), m.supply_index);
        assert!(have >= amount, "exceeds your supplied balance");
        assert!(cash(&env, asset) >= amount, "insufficient pool liquidity");
        let shares = amt_to_shares(amount, m.supply_index);
        m.supply_shares -= shares;
        put_market(&env, asset, &m);
        put_shares(&env, k.clone(), get_shares(&env, &k) - shares);
        // must stay healthy after removing this collateral
        let (coll_lt, _ltv, debt) = account_health_values(&env, &to);
        assert!(debt == 0 || coll_lt >= debt, "withdrawal would breach collateral");
        token::TokenClient::new(&env, &token_of(&env, asset)).transfer(&env.current_contract_address(), &to, &amount);
        env.events().publish((symbol_short!("withdraw"), asset), (to, amount));
    }

    /// Borrow `amount` of `asset` against your supplied collateral.
    pub fn borrow(env: Env, who: Address, asset: u32, amount: i128) {
        who.require_auth();
        assert!(asset == 1 || asset == 2, "bad asset");
        assert!(amount > 0, "amount must be positive");
        let mut m = accrue(&env, asset);
        assert!(cash(&env, asset) >= amount, "insufficient pool liquidity");
        let shares = amt_to_shares(amount, m.borrow_index);
        m.borrow_shares += shares;
        put_market(&env, asset, &m);
        let k = Key::Borrow(who.clone(), asset);
        put_shares(&env, k.clone(), get_shares(&env, &k) + shares);
        // borrowing power (LTV) must cover total debt after this draw
        let (_lt, coll_ltv, debt) = account_health_values(&env, &who);
        assert!(coll_ltv >= debt, "exceeds your borrow limit");
        token::TokenClient::new(&env, &token_of(&env, asset)).transfer(&env.current_contract_address(), &who, &amount);
        env.events().publish((symbol_short!("borrow"), asset), (who, amount));
    }

    /// Repay debt. Pays at most your outstanding debt; pulls tokens from `from`.
    pub fn repay(env: Env, from: Address, asset: u32, amount: i128) {
        from.require_auth();
        assert!(asset == 1 || asset == 2, "bad asset");
        assert!(amount > 0, "amount must be positive");
        let mut m = accrue(&env, asset);
        let k = Key::Borrow(from.clone(), asset);
        let debt = shares_to_amt(get_shares(&env, &k), m.borrow_index);
        let pay = if amount < debt { amount } else { debt };
        assert!(pay > 0, "nothing to repay");
        token::TokenClient::new(&env, &token_of(&env, asset)).transfer(&from, &env.current_contract_address(), &pay);
        let shares = amt_to_shares(pay, m.borrow_index);
        m.borrow_shares -= shares;
        put_market(&env, asset, &m);
        put_shares(&env, k.clone(), get_shares(&env, &k) - shares);
        env.events().publish((symbol_short!("repay"), asset), (from, pay));
    }

    /// Oracle-priced swap between the two assets. The output can only be paid if the
    /// pool truly holds enough cash. A 0.30% fee on the input accrues to suppliers of
    /// the input asset (their supply index is bumped), so LP yield grows with volume.
    pub fn swap(env: Env, from: Address, asset_in: u32, amount_in: i128, min_out: i128) -> i128 {
        from.require_auth();
        assert!((asset_in == 1 || asset_in == 2), "bad asset");
        assert!(amount_in > 0, "amount must be positive");
        let asset_out = if asset_in == 1 { 2u32 } else { 1u32 };
        // accrue both legs so indices are current before we touch reserves
        let mut m_in = accrue(&env, asset_in);
        let _ = accrue(&env, asset_out);
        let fee = mul_div(amount_in, SWAP_FEE_BPS, BPS);
        let in_after = amount_in - fee;
        // value-conserving conversion at the oracle price
        let amount_out = mul_div(usd(&env, asset_in, in_after), PRICE_SCALE, price_of(&env, asset_out));
        assert!(amount_out >= min_out, "slippage: output below minimum");
        assert!(amount_out > 0, "amount too small");
        assert!(cash(&env, asset_out) >= amount_out, "insufficient pool liquidity for this swap");
        let me = env.current_contract_address();
        token::TokenClient::new(&env, &token_of(&env, asset_in)).transfer(&from, &me, &amount_in);
        token::TokenClient::new(&env, &token_of(&env, asset_out)).transfer(&me, &from, &amount_out);
        // distribute the fee to input-asset suppliers by bumping their index
        let ts_in = total_supply(&m_in);
        if ts_in > 0 && fee > 0 {
            m_in.supply_index += mul_div(m_in.supply_index, fee, ts_in);
            m_in.cum_fees += fee;
            put_market(&env, asset_in, &m_in);
        }
        env.events().publish((symbol_short!("swap"), asset_in), (from, amount_in, amount_out, fee));
        amount_out
    }

    /// Liquidate an unhealthy position: repay up to CLOSE_FACTOR of the user's debt in
    /// `debt_asset` and seize the equivalent collateral (+5% bonus) in `coll_asset`.
    pub fn liquidate(env: Env, liquidator: Address, user: Address, debt_asset: u32, coll_asset: u32, repay_amount: i128) {
        liquidator.require_auth();
        assert!(debt_asset == 1 || debt_asset == 2, "bad debt asset");
        assert!(coll_asset == 1 || coll_asset == 2, "bad coll asset");
        assert!(repay_amount > 0, "amount must be positive");
        let mut md = accrue(&env, debt_asset);
        let mut mc = accrue(&env, coll_asset);
        let (coll_lt, _ltv, debt_val) = account_health_values(&env, &user);
        assert!(debt_val > 0 && coll_lt < debt_val, "position is healthy");
        let dk = Key::Borrow(user.clone(), debt_asset);
        let user_debt = shares_to_amt(get_shares(&env, &dk), md.borrow_index);
        let max_repay = mul_div(user_debt, CLOSE_FACTOR, WAD);
        let pay = if repay_amount < max_repay { repay_amount } else { max_repay };
        assert!(pay > 0, "no debt in that asset");
        // seize collateral worth pay * (1 + bonus)
        let seize_val = mul_div(usd(&env, debt_asset, pay), WAD + LIQ_BONUS, WAD);
        let seize_amt = mul_div(seize_val, PRICE_SCALE, price_of(&env, coll_asset));
        let ck = Key::Supply(user.clone(), coll_asset);
        let user_coll = shares_to_amt(get_shares(&env, &ck), mc.supply_index);
        assert!(user_coll >= seize_amt, "not enough collateral to seize");
        assert!(cash(&env, coll_asset) >= seize_amt, "insufficient pool liquidity");
        let me = env.current_contract_address();
        // liquidator pays the debt
        token::TokenClient::new(&env, &token_of(&env, debt_asset)).transfer(&liquidator, &me, &pay);
        let dshares = amt_to_shares(pay, md.borrow_index);
        md.borrow_shares -= dshares;
        put_market(&env, debt_asset, &md);
        put_shares(&env, dk.clone(), get_shares(&env, &dk) - dshares);
        // seize collateral from the user, hand tokens to the liquidator
        let cshares = amt_to_shares(seize_amt, mc.supply_index);
        mc.supply_shares -= cshares;
        put_market(&env, coll_asset, &mc);
        put_shares(&env, ck.clone(), get_shares(&env, &ck) - cshares);
        token::TokenClient::new(&env, &token_of(&env, coll_asset)).transfer(&me, &liquidator, &seize_amt);
        env.events().publish((symbol_short!("liquidate"), debt_asset), (liquidator, user, pay, seize_amt));
    }

    // ---------------- views (interest accrued to the current ledger time) ----------------
    pub fn get_market(env: Env, asset: u32) -> Market { market_now(&env, asset) }
    pub fn price(env: Env, asset: u32) -> i128 { price_of(&env, asset) }
    pub fn reserve(env: Env, asset: u32) -> i128 { cash(&env, asset) }
    pub fn total_supplied(env: Env, asset: u32) -> i128 { total_supply(&market_now(&env, asset)) }
    pub fn total_borrowed(env: Env, asset: u32) -> i128 { total_borrow(&market_now(&env, asset)) }
    pub fn utilization_bps(env: Env, asset: u32) -> i128 { mul_div(utilization(&market_now(&env, asset)), BPS, WAD) }
    /// current borrow APR in basis points (0 when nothing is borrowed)
    pub fn borrow_rate_bps(env: Env, asset: u32) -> i128 { mul_div(borrow_apr(utilization(&market_now(&env, asset))), BPS, WAD) }
    /// current supply APR in basis points = borrowAPR * utilization (rises with usage)
    pub fn supply_rate_bps(env: Env, asset: u32) -> i128 {
        let m = market_now(&env, asset);
        let u = utilization(&m);
        mul_div(mul_div(borrow_apr(u), u, WAD), BPS, WAD)
    }
    /// realised supplier index (WAD) — captures interest AND swap fees earned to date
    pub fn supply_index(env: Env, asset: u32) -> i128 { market_now(&env, asset).supply_index }
    pub fn cum_fees(env: Env, asset: u32) -> i128 { get_market(&env, asset).cum_fees }

    /// a user's supplied & borrowed balances for one asset (current value)
    pub fn position(env: Env, who: Address, asset: u32) -> Position {
        let m = market_now(&env, asset);
        Position {
            supplied: shares_to_amt(get_shares(&env, &Key::Supply(who.clone(), asset)), m.supply_index),
            borrowed: shares_to_amt(get_shares(&env, &Key::Borrow(who, asset)), m.borrow_index),
        }
    }
    /// health factor in WAD (>= 1e12 is safe); returns a large sentinel when no debt
    pub fn health(env: Env, who: Address) -> i128 {
        let (coll_lt, _ltv, debt) = account_health_values(&env, &who);
        if debt <= 0 { return i128::MAX; }
        mul_div(coll_lt, WAD, debt)
    }
    /// remaining USD borrow power (LTV-weighted collateral minus current debt), WAD-USD scaled
    pub fn borrow_power(env: Env, who: Address) -> i128 {
        let (_lt, coll_ltv, debt) = account_health_values(&env, &who);
        if coll_ltv > debt { coll_ltv - debt } else { 0 }
    }
}

#[cfg(test)]
mod test;
