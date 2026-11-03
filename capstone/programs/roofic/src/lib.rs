// ============================================================================
// Roofic — Capstone program
//
// Tokenized rental property on Solana:
//   * Platform admin runs a KYC allow-list, can pause, and sets fees (basis points)
//   * Owners list properties; each property gets its own share mint (Token-2022,
//     0 decimals, NON-TRANSFERABLE, mint authority = the property PDA)
//   * Approved investors buy shares with a stablecoin (USDC, or any SPL / Token-2022
//     payment mint chosen by the platform); the platform takes a sale fee out of the
//     owner's proceeds
//   * The property manager deposits rent in the same stablecoin; the platform takes a
//     rent fee; the rest is shared pro-rata with a reward-per-share accumulator (O(1))
//   * Investors claim rent at any time — even while the platform is paused
//
// Why NON-TRANSFERABLE shares: rent accounting here is keyed to the shares recorded in
// each holder's `Position`. If a share token could move between wallets outside this
// program, a holder could claim, transfer the shares and claim again. Secondary trading
// needs a TransferHook that settles rent on every transfer — documented in
// week-13-rwa-design/RWA_DESIGN.md, deliberately NOT built here.
//
// Security rules from Week 12 apply throughout: every authority is a `Signer` tied
// with `has_one`, program ids are `Program<..>`/`Interface<..>`, typed `Account<T>`
// everywhere (no hand-parsing), checked math, `transfer_checked` only.
// ============================================================================

use anchor_lang::prelude::*;
use anchor_lang::system_program::{create_account, CreateAccount};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::spl_token_2022::{extension::ExtensionType, state::Mint as Mint2022};
use anchor_spl::token_2022::{initialize_mint2, mint_to, InitializeMint2, MintTo, Token2022};
use anchor_spl::token_2022_extensions::{non_transferable_mint_initialize, NonTransferableMintInitialize};
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("EvLmbfYUs5m5YHWm4QWCeQfy63df4BBiaBiZw8Rf12mo");

/// Accumulator precision: rent per share is stored with 1e-12 resolution
pub const ACC_SCALE: u128 = 1_000_000_000_000;
pub const BPS: u64 = 10_000;
/// Hard ceiling for any platform fee: 20%
pub const MAX_FEE_BPS: u16 = 2_000;
pub const MAX_NAME_LEN: usize = 48;

#[program]
pub mod roofic {
    use super::*;

    // ---------------------------------------------------------------- platform
    pub fn initialize_platform(ctx: Context<InitializePlatform>, rent_fee_bps: u16, sale_fee_bps: u16) -> Result<()> {
        require!(rent_fee_bps <= MAX_FEE_BPS && sale_fee_bps <= MAX_FEE_BPS, RooficError::FeeTooHigh);
        assert_clean_payment_mint(&ctx.accounts.payment_mint.to_account_info())?;
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.treasury = ctx.accounts.treasury.key();
        config.payment_mint = ctx.accounts.payment_mint.key();
        config.rent_fee_bps = rent_fee_bps;
        config.sale_fee_bps = sale_fee_bps;
        config.paused = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(PauseChanged { paused });
        Ok(())
    }

    pub fn set_fees(ctx: Context<AdminOnly>, rent_fee_bps: u16, sale_fee_bps: u16) -> Result<()> {
        require!(rent_fee_bps <= MAX_FEE_BPS && sale_fee_bps <= MAX_FEE_BPS, RooficError::FeeTooHigh);
        ctx.accounts.config.rent_fee_bps = rent_fee_bps;
        ctx.accounts.config.sale_fee_bps = sale_fee_bps;
        Ok(())
    }

    /// Rotates the platform admin and/or updates the fee treasury token account
    pub fn set_admin(ctx: Context<SetAdmin>, new_admin: Pubkey) -> Result<()> {
        require!(new_admin != Pubkey::default(), RooficError::NotAdmin);
        ctx.accounts.config.admin = new_admin;
        ctx.accounts.config.treasury = ctx.accounts.treasury.key();
        Ok(())
    }

    /// KYC allow-list: the admin records that `wallet` passed verification off-chain
    pub fn approve_investor(ctx: Context<ApproveInvestor>) -> Result<()> {
        let record = &mut ctx.accounts.investor_record;
        record.wallet = ctx.accounts.wallet.key();
        record.approved_at = Clock::get()?.unix_timestamp;
        record.bump = ctx.bumps.investor_record;
        Ok(())
    }

    pub fn revoke_investor(_ctx: Context<RevokeInvestor>) -> Result<()> {
        Ok(()) // the `close` constraint removes the record and refunds rent to the admin
    }

    // ---------------------------------------------------------------- listing
    pub fn create_property(
        ctx: Context<CreateProperty>,
        id: u64,
        name: String,
        total_shares: u64,
        price_per_share: u64,
        manager: Pubkey,
        valuation_hash: [u8; 32],
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, RooficError::Paused);
        require!(!name.is_empty() && name.len() <= MAX_NAME_LEN, RooficError::InvalidName);
        require!(total_shares > 0, RooficError::InvalidShares);
        require!(price_per_share > 0, RooficError::InvalidPrice);
        // The full sale price must fit in u64, otherwise buy_shares could never complete
        total_shares.checked_mul(price_per_share).ok_or(RooficError::MathOverflow)?;

        // Share mint: a PDA created by hand because it needs the NonTransferable extension,
        // which must be initialised BEFORE `initialize_mint`.
        let property_key = ctx.accounts.property.key();
        let mint_bump = ctx.bumps.share_mint;
        let mint_seeds: &[&[u8]] = &[b"share_mint", property_key.as_ref(), &[mint_bump]];
        let len = ExtensionType::try_calculate_account_len::<Mint2022>(&[ExtensionType::NonTransferable])?;
        create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                CreateAccount {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.share_mint.to_account_info(),
                },
                &[mint_seeds],
            ),
            Rent::get()?.minimum_balance(len),
            len as u64,
            &ctx.accounts.share_token_program.key(),
        )?;
        non_transferable_mint_initialize(CpiContext::new(
            ctx.accounts.share_token_program.key(),
            NonTransferableMintInitialize {
                token_program_id: ctx.accounts.share_token_program.to_account_info(),
                mint: ctx.accounts.share_mint.to_account_info(),
            },
        ))?;
        initialize_mint2(
            CpiContext::new(
                ctx.accounts.share_token_program.key(),
                InitializeMint2 { mint: ctx.accounts.share_mint.to_account_info() },
            ),
            0,
            &property_key, // mint authority = the property PDA
            None,          // no freeze authority
        )?;

        let property = &mut ctx.accounts.property;
        property.owner = ctx.accounts.owner.key();
        property.manager = manager;
        property.id = id;
        property.share_mint = ctx.accounts.share_mint.key();
        property.vault = ctx.accounts.vault.key();
        property.name = name;
        property.total_shares = total_shares;
        property.shares_sold = 0;
        property.price_per_share = price_per_share;
        property.acc_rent_per_share = 0;
        property.total_rent_deposited = 0;
        property.total_rent_claimed = 0;
        property.valuation_hash = valuation_hash;
        property.valuation_ts = Clock::get()?.unix_timestamp;
        property.bump = ctx.bumps.property;

        emit!(PropertyCreated {
            property: property_key,
            owner: property.owner,
            total_shares,
            price_per_share,
        });
        Ok(())
    }

    // ---------------------------------------------------------------- investing
    pub fn buy_shares(ctx: Context<BuyShares>, shares: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, RooficError::Paused);
        require!(shares > 0, RooficError::InvalidShares);

        // `property.shares_sold` is the monotonic source of truth for issued shares
        // (immune to holders burning their NonTransferable receipt tokens).
        let sold = ctx.accounts.property.shares_sold;
        let remaining = ctx.accounts.property.total_shares.saturating_sub(sold);
        require!(shares <= remaining, RooficError::NotEnoughShares);

        let cost = shares.checked_mul(ctx.accounts.property.price_per_share).ok_or(RooficError::MathOverflow)?;
        let fee = bps_of(cost, ctx.accounts.config.sale_fee_bps)?;
        let to_owner = cost.checked_sub(fee).ok_or(RooficError::MathOverflow)?;
        let decimals = ctx.accounts.payment_mint.decimals;

        // Effects first
        let acc = ctx.accounts.property.acc_rent_per_share;
        let position = &mut ctx.accounts.position;
        if position.owner == Pubkey::default() {
            position.owner = ctx.accounts.investor.key();
            position.property = ctx.accounts.property.key();
            position.bump = ctx.bumps.position;
        }
        // Bank rent accrued so far BEFORE the share count changes, so new shares never
        // receive rent deposited before they were bought
        position.unclaimed = position.unclaimed.checked_add(pending(position, acc)?).ok_or(RooficError::MathOverflow)?;
        position.shares = position.shares.checked_add(shares).ok_or(RooficError::MathOverflow)?;
        position.reward_debt = accrued(position.shares, acc)?;
        ctx.accounts.property.shares_sold = sold.checked_add(shares).ok_or(RooficError::MathOverflow)?;

        // Interactions: investor pays the owner and the platform, then shares are minted
        pay(
            &ctx.accounts.payment_token_program,
            &ctx.accounts.payment_mint,
            &ctx.accounts.investor_payment,
            &ctx.accounts.owner_payment,
            ctx.accounts.investor.to_account_info(),
            to_owner,
            decimals,
            &[],
        )?;
        pay(
            &ctx.accounts.payment_token_program,
            &ctx.accounts.payment_mint,
            &ctx.accounts.investor_payment,
            &ctx.accounts.treasury,
            ctx.accounts.investor.to_account_info(),
            fee,
            decimals,
            &[],
        )?;

        let property = &ctx.accounts.property;
        let id_bytes = property.id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"property", property.owner.as_ref(), &id_bytes, &[property.bump]];
        mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.share_token_program.key(),
                MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.investor_shares.to_account_info(),
                    authority: ctx.accounts.property.to_account_info(),
                },
                &[seeds],
            ),
            shares,
        )?;

        emit!(SharesPurchased {
            property: ctx.accounts.property.key(),
            investor: ctx.accounts.investor.key(),
            shares,
            cost,
            fee,
        });
        Ok(())
    }

    // ---------------------------------------------------------------- rent
    pub fn deposit_rent(ctx: Context<DepositRent>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, RooficError::Paused);
        require!(amount > 0, RooficError::InvalidAmount);
        // Divide by `property.shares_sold` (= sum of all Position.shares) rather than
        // `share_mint.supply`, so burning share tokens can never shrink the denominator
        // and allow a remaining holder to drain the vault.
        let sold = ctx.accounts.property.shares_sold;
        require!(sold > 0, RooficError::NoShareholders);

        let fee = bps_of(amount, ctx.accounts.config.rent_fee_bps)?;
        let net = amount.checked_sub(fee).ok_or(RooficError::MathOverflow)?;
        let decimals = ctx.accounts.payment_mint.decimals;

        let property = &mut ctx.accounts.property;
        let increment = (net as u128)
            .checked_mul(ACC_SCALE)
            .ok_or(RooficError::MathOverflow)?
            / sold as u128;
        property.acc_rent_per_share = property.acc_rent_per_share.checked_add(increment).ok_or(RooficError::MathOverflow)?;
        property.total_rent_deposited = property.total_rent_deposited.checked_add(net).ok_or(RooficError::MathOverflow)?;

        pay(
            &ctx.accounts.payment_token_program,
            &ctx.accounts.payment_mint,
            &ctx.accounts.manager_payment,
            &ctx.accounts.treasury,
            ctx.accounts.manager.to_account_info(),
            fee,
            decimals,
            &[],
        )?;
        pay(
            &ctx.accounts.payment_token_program,
            &ctx.accounts.payment_mint,
            &ctx.accounts.manager_payment,
            &ctx.accounts.vault,
            ctx.accounts.manager.to_account_info(),
            net,
            decimals,
            &[],
        )?;

        emit!(RentDeposited { property: ctx.accounts.property.key(), gross: amount, fee, net });
        Ok(())
    }

    /// Deliberately NOT blocked by `paused`: investors' money must never be locked
    pub fn claim_rent(ctx: Context<ClaimRent>) -> Result<()> {
        let acc = ctx.accounts.property.acc_rent_per_share;
        let position = &mut ctx.accounts.position;
        let total = position.unclaimed.checked_add(pending(position, acc)?).ok_or(RooficError::MathOverflow)?;
        require!(total > 0, RooficError::NothingToClaim);

        position.unclaimed = 0;
        position.reward_debt = accrued(position.shares, acc)?;
        position.total_claimed = position.total_claimed.checked_add(total).ok_or(RooficError::MathOverflow)?;
        let property = &mut ctx.accounts.property;
        property.total_rent_claimed = property.total_rent_claimed.checked_add(total).ok_or(RooficError::MathOverflow)?;

        let decimals = ctx.accounts.payment_mint.decimals;
        let property = &ctx.accounts.property;
        let id_bytes = property.id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"property", property.owner.as_ref(), &id_bytes, &[property.bump]];
        pay(
            &ctx.accounts.payment_token_program,
            &ctx.accounts.payment_mint,
            &ctx.accounts.vault,
            &ctx.accounts.investor_payment,
            ctx.accounts.property.to_account_info(),
            total,
            decimals,
            &[seeds],
        )?;

        emit!(RentClaimed { property: ctx.accounts.property.key(), investor: ctx.accounts.investor.key(), amount: total });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Math & payment helpers
// ---------------------------------------------------------------------------
fn bps_of(amount: u64, bps: u16) -> Result<u64> {
    let v = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or(RooficError::MathOverflow)?
        / BPS as u128;
    u64::try_from(v).map_err(|_| error!(RooficError::MathOverflow))
}

fn accrued(shares: u64, acc: u128) -> Result<u128> {
    Ok((shares as u128).checked_mul(acc).ok_or(RooficError::MathOverflow)? / ACC_SCALE)
}

fn pending(position: &Position, acc: u128) -> Result<u64> {
    let gross = accrued(position.shares, acc)?;
    let owed = gross.checked_sub(position.reward_debt).ok_or(RooficError::MathOverflow)?;
    u64::try_from(owed).map_err(|_| error!(RooficError::MathOverflow))
}

/// Rejects Token-2022 payment mints that carry transfer-modifying extensions
/// (`TransferFeeConfig`, `TransferHook`, `PermanentDelegate`) which could cause
/// the vault to receive less than `net` rent and become insolvent.
fn assert_clean_payment_mint(mint_info: &AccountInfo) -> Result<()> {
    if mint_info.owner == &anchor_spl::token_2022::ID {
        let data = mint_info.try_borrow_data()?;
        let state = anchor_spl::token_2022::spl_token_2022::extension::StateWithExtensions::<Mint2022>::unpack(&data)
            .map_err(|_| error!(RooficError::UnsupportedPaymentMint))?;
        let exts = anchor_spl::token_2022::spl_token_2022::extension::BaseStateWithExtensions::get_extension_types(&state)
            .map_err(|_| error!(RooficError::UnsupportedPaymentMint))?;
        for ext in exts {
            if matches!(
                ext,
                ExtensionType::TransferFeeConfig
                    | ExtensionType::TransferFeeAmount
                    | ExtensionType::TransferHook
                    | ExtensionType::PermanentDelegate
            ) {
                return err!(RooficError::UnsupportedPaymentMint);
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn pay<'info>(
    token_program: &Interface<'info, TokenInterface>,
    mint: &InterfaceAccount<'info, Mint>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    authority: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority,
            },
            signer_seeds,
        ),
        amount,
        decimals,
    )
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
#[derive(Accounts)]
pub struct InitializePlatform<'info> {
    #[account(init, payer = admin, space = 8 + PlatformConfig::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, PlatformConfig>,
    pub payment_mint: InterfaceAccount<'info, Mint>,
    /// Platform treasury: a token account of the payment mint
    #[account(token::mint = payment_mint)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub admin: Signer<'info>,
    /// Anti-front-running check (Week 12 Finding #6): only the program's upgrade
    /// authority can perform the initial `PlatformConfig` setup.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ RooficError::NotAdmin)]
    pub program: Program<'info, crate::program::Roofic>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ RooficError::NotAdmin)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ RooficError::NotAdmin)]
    pub config: Account<'info, PlatformConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetAdmin<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ RooficError::NotAdmin)]
    pub config: Account<'info, PlatformConfig>,
    #[account(token::mint = config.payment_mint)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct ApproveInvestor<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ RooficError::NotAdmin)]
    pub config: Account<'info, PlatformConfig>,
    #[account(init, payer = admin, space = 8 + Investor::INIT_SPACE, seeds = [b"investor", wallet.key().as_ref()], bump)]
    pub investor_record: Account<'info, Investor>,
    /// CHECK: only its address is used, as the PDA seed and the recorded wallet
    pub wallet: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeInvestor<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ RooficError::NotAdmin)]
    pub config: Account<'info, PlatformConfig>,
    #[account(mut, close = admin, seeds = [b"investor", investor_record.wallet.as_ref()], bump = investor_record.bump)]
    pub investor_record: Account<'info, Investor>,
    #[account(mut)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateProperty<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, PlatformConfig>,

    /// KYB/KYC issuer gate: only wallets approved in the on-chain registry can list properties
    #[account(seeds = [b"investor", owner.key().as_ref()], bump = owner_kyc.bump)]
    pub owner_kyc: Account<'info, Investor>,

    #[account(
        init,
        payer = owner,
        space = 8 + Property::INIT_SPACE,
        seeds = [b"property", owner.key().as_ref(), &id.to_le_bytes()],
        bump,
    )]
    pub property: Account<'info, Property>,

    /// CHECK: PDA created and initialised by this instruction (Token-2022 mint with NonTransferable)
    #[account(mut, seeds = [b"share_mint", property.key().as_ref()], bump)]
    pub share_mint: UncheckedAccount<'info>,

    /// Rent vault: payment-token account owned by the property PDA
    #[account(
        init,
        payer = owner,
        seeds = [b"vault", property.key().as_ref()],
        bump,
        token::mint = payment_mint,
        token::authority = property,
        token::token_program = payment_token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(address = config.payment_mint, mint::token_program = payment_token_program)]
    pub payment_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub owner: Signer<'info>,
    pub share_token_program: Program<'info, Token2022>,
    pub payment_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyShares<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, PlatformConfig>,

    /// KYC gate: this PDA only exists for wallets the admin approved
    #[account(seeds = [b"investor", investor.key().as_ref()], bump = investor_record.bump)]
    pub investor_record: Account<'info, Investor>,

    #[account(
        mut,
        seeds = [b"property", property.owner.as_ref(), &property.id.to_le_bytes()],
        bump = property.bump,
        has_one = share_mint @ RooficError::WrongShareMint,
    )]
    pub property: Box<Account<'info, Property>>,

    #[account(mut, mint::token_program = share_token_program)]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = investor,
        space = 8 + Position::INIT_SPACE,
        seeds = [b"position", property.key().as_ref(), investor.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        init_if_needed,
        payer = investor,
        associated_token::mint = share_mint,
        associated_token::authority = investor,
        associated_token::token_program = share_token_program,
    )]
    pub investor_shares: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = config.payment_mint, mint::token_program = payment_token_program)]
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, token::mint = payment_mint, token::authority = investor, token::token_program = payment_token_program)]
    pub investor_payment: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Owner's proceeds account; pinned to the property owner
    #[account(mut, token::mint = payment_mint, token::authority = property.owner, token::token_program = payment_token_program)]
    pub owner_payment: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, address = config.treasury)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub investor: Signer<'info>,
    pub share_token_program: Program<'info, Token2022>,
    pub payment_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositRent<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, PlatformConfig>,

    #[account(
        mut,
        seeds = [b"property", property.owner.as_ref(), &property.id.to_le_bytes()],
        bump = property.bump,
        has_one = manager @ RooficError::NotManager,
        has_one = share_mint @ RooficError::WrongShareMint,
        has_one = vault @ RooficError::WrongVault,
    )]
    pub property: Account<'info, Property>,

    #[account(mint::token_program = share_token_program)]
    pub share_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, token::mint = payment_mint, token::token_program = payment_token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(address = config.payment_mint, mint::token_program = payment_token_program)]
    pub payment_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, token::mint = payment_mint, token::authority = manager, token::token_program = payment_token_program)]
    pub manager_payment: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, address = config.treasury)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,

    pub manager: Signer<'info>,
    pub share_token_program: Program<'info, Token2022>,
    pub payment_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClaimRent<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, PlatformConfig>,

    #[account(
        mut,
        seeds = [b"property", property.owner.as_ref(), &property.id.to_le_bytes()],
        bump = property.bump,
        has_one = vault @ RooficError::WrongVault,
    )]
    pub property: Account<'info, Property>,

    #[account(
        mut,
        seeds = [b"position", property.key().as_ref(), investor.key().as_ref()],
        bump = position.bump,
        has_one = property,
    )]
    pub position: Account<'info, Position>,

    #[account(mut, token::mint = payment_mint, token::token_program = payment_token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(address = config.payment_mint, mint::token_program = payment_token_program)]
    pub payment_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, token::mint = payment_mint, token::authority = investor, token::token_program = payment_token_program)]
    pub investor_payment: InterfaceAccount<'info, TokenAccount>,

    pub investor: Signer<'info>,
    pub payment_token_program: Interface<'info, TokenInterface>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
#[account]
#[derive(InitSpace)]
pub struct PlatformConfig {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub payment_mint: Pubkey,
    pub rent_fee_bps: u16,
    pub sale_fee_bps: u16,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Investor {
    pub wallet: Pubkey,
    pub approved_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Property {
    pub owner: Pubkey,
    pub manager: Pubkey,
    pub id: u64,
    pub share_mint: Pubkey,
    pub vault: Pubkey,
    #[max_len(MAX_NAME_LEN)]
    pub name: String,
    pub total_shares: u64,
    pub shares_sold: u64,
    pub price_per_share: u64,
    pub acc_rent_per_share: u128,
    /// Net rent (after platform fee) ever moved into the vault
    pub total_rent_deposited: u64,
    pub total_rent_claimed: u64,
    /// SHA-256 of the appraiser's report; the report itself stays off-chain
    pub valuation_hash: [u8; 32],
    pub valuation_ts: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub property: Pubkey,
    pub shares: u64,
    pub reward_debt: u128,
    pub unclaimed: u64,
    pub total_claimed: u64,
    pub bump: u8,
}

// ---------------------------------------------------------------------------
// Events & errors
// ---------------------------------------------------------------------------
#[event]
pub struct PauseChanged {
    pub paused: bool,
}

#[event]
pub struct PropertyCreated {
    pub property: Pubkey,
    pub owner: Pubkey,
    pub total_shares: u64,
    pub price_per_share: u64,
}

#[event]
pub struct SharesPurchased {
    pub property: Pubkey,
    pub investor: Pubkey,
    pub shares: u64,
    pub cost: u64,
    pub fee: u64,
}

#[event]
pub struct RentDeposited {
    pub property: Pubkey,
    pub gross: u64,
    pub fee: u64,
    pub net: u64,
}

#[event]
pub struct RentClaimed {
    pub property: Pubkey,
    pub investor: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum RooficError {
    #[msg("Platform is paused")]
    Paused,
    #[msg("Signer is not the platform admin")]
    NotAdmin,
    #[msg("Signer is not this property's manager")]
    NotManager,
    #[msg("Fee exceeds the 20% ceiling")]
    FeeTooHigh,
    #[msg("Name must be 1-48 bytes")]
    InvalidName,
    #[msg("Share count must be greater than zero")]
    InvalidShares,
    #[msg("Price per share must be greater than zero")]
    InvalidPrice,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Not enough shares left in this property")]
    NotEnoughShares,
    #[msg("Nobody holds shares yet")]
    NoShareholders,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Share mint does not belong to this property")]
    WrongShareMint,
    #[msg("Vault does not belong to this property")]
    WrongVault,
    #[msg("Payment mint must not have TransferFee, TransferHook, or PermanentDelegate extensions")]
    UnsupportedPaymentMint,
}

