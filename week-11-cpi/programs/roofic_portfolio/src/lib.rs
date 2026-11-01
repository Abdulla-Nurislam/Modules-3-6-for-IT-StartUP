// ============================================================================
// Roofic Portfolio (Week 11 · CPI)
// A second program that *composes* roofic_shares: `buy_and_track` calls
// roofic_shares::buy_shares via CPI and then records the purchase in the
// investor's own Portfolio PDA.
//
// Call depth for a first purchase:
//   roofic_portfolio → roofic_shares → associated_token → token_2022 / system
// i.e. 4 levels. Solana caps the call stack depth (historically at 5), so composed
// flows should stay shallow.
//
// If the inner CPI fails (sold out, wrong accounts, ...) the whole transaction
// reverts, so the Portfolio can never claim a purchase that did not happen.
// ============================================================================

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::Mint;
use roofic_shares::program::RooficShares;
use roofic_shares::Listing;

declare_id!("8XJaa7FSPhVBXX6SW6kxRCGNZBLt565VWHxKiSFZ7cT4");

#[program]
pub mod roofic_portfolio {
    use super::*;

    pub fn buy_and_track(ctx: Context<BuyAndTrack>, shares: u64) -> Result<()> {
        // Listing is owned (and therefore trusted) by roofic_shares; read the price before the CPI
        let cost = shares
            .checked_mul(ctx.accounts.listing.price_per_share)
            .ok_or(PortfolioError::MathOverflow)?;

        roofic_shares::cpi::buy_shares(
            CpiContext::new(
                ctx.accounts.shares_program.key(),
                roofic_shares::cpi::accounts::BuyShares {
                    listing: ctx.accounts.listing.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                    investor: ctx.accounts.investor.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    investor_ata: ctx.accounts.investor_ata.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                    associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
            ),
            shares,
        )?;

        let portfolio = &mut ctx.accounts.portfolio;
        if portfolio.owner == Pubkey::default() {
            portfolio.owner = ctx.accounts.investor.key();
            portfolio.bump = ctx.bumps.portfolio;
        }
        portfolio.purchases = portfolio.purchases.checked_add(1).ok_or(PortfolioError::MathOverflow)?;
        portfolio.total_shares = portfolio.total_shares.checked_add(shares).ok_or(PortfolioError::MathOverflow)?;
        portfolio.total_spent = portfolio.total_spent.checked_add(cost).ok_or(PortfolioError::MathOverflow)?;

        emit!(PurchaseTracked {
            investor: portfolio.owner,
            listing: ctx.accounts.listing.key(),
            shares,
            cost,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct BuyAndTrack<'info> {
    #[account(
        init_if_needed,
        payer = investor,
        space = 8 + Portfolio::INIT_SPACE,
        seeds = [b"portfolio", investor.key().as_ref()],
        bump,
    )]
    pub portfolio: Account<'info, Portfolio>,

    /// Owner check (roofic_shares) happens in `Account<Listing>`
    pub listing: Account<'info, Listing>,

    /// Passed straight through; roofic_shares pins it to `listing.authority`
    #[account(mut)]
    pub authority: SystemAccount<'info>,

    #[account(mut)]
    pub investor: Signer<'info>,

    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,

    /// CHECK: created by roofic_shares (init_if_needed) and validated there as the investor's ATA
    #[account(mut)]
    pub investor_ata: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// `Program<RooficShares>` checks the address — without it a caller could point the
    /// CPI at a malicious program ("arbitrary CPI" vulnerability)
    pub shares_program: Program<'info, RooficShares>,
}

#[account]
#[derive(InitSpace)]
pub struct Portfolio {
    pub owner: Pubkey,
    pub purchases: u32,
    pub total_shares: u64,
    pub total_spent: u64,
    pub bump: u8,
}

#[event]
pub struct PurchaseTracked {
    pub investor: Pubkey,
    pub listing: Pubkey,
    pub shares: u64,
    pub cost: u64,
}

#[error_code]
pub enum PortfolioError {
    #[msg("Math overflow")]
    MathOverflow,
}

