// ============================================================================
// Roofic Shares (Week 11 · CPI)
// A property's shares are a Token-2022 token (decimals = 0, 1 token = 1 share),
// so they are transferable and visible in any wallet — unlike the plain
// `Position` record from Week 8.
//
// This program is a CPI "hub". buy_shares performs three cross-program calls:
//   1. Associated Token program  → creates the investor's token account (init_if_needed)
//   2. System program            → pays the property owner (signed by the investor)
//   3. Token-2022 program        → mints shares (signed by the listing PDA via invoke_signed)
//
// The listing PDA is the mint authority, so nobody — not even the owner — can
// mint beyond `total_shares`: the cap is enforced by this program, which is the
// only thing that can sign for the PDA.
// ============================================================================

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::{mint_to, MintTo, Token2022};
use anchor_spl::token_interface::{Mint, TokenAccount};

declare_id!("DJuq8q9WhsLAbji7AbTS48tvLasnj3EoxECHsgyrQFdt");

pub const MAX_NAME_LEN: usize = 48;

#[program]
pub mod roofic_shares {
    use super::*;

    /// Lists a property and creates its share mint (PDA, authority = listing PDA).
    pub fn create_listing(
        ctx: Context<CreateListing>,
        id: u64,
        name: String,
        total_shares: u64,
        price_per_share: u64,
    ) -> Result<()> {
        require!(!name.is_empty() && name.len() <= MAX_NAME_LEN, SharesError::InvalidName);
        require!(total_shares > 0, SharesError::InvalidShares);
        require!(price_per_share > 0, SharesError::InvalidPrice);

        let listing = &mut ctx.accounts.listing;
        listing.authority = ctx.accounts.authority.key();
        listing.id = id;
        listing.mint = ctx.accounts.mint.key();
        listing.name = name;
        listing.total_shares = total_shares;
        listing.price_per_share = price_per_share;
        listing.bump = ctx.bumps.listing;

        emit!(ListingCreated {
            listing: listing.key(),
            mint: listing.mint,
            total_shares,
            price_per_share,
        });
        Ok(())
    }

    /// Pays the owner in SOL and mints `shares` share tokens to the investor.
    pub fn buy_shares(ctx: Context<BuyShares>, shares: u64) -> Result<()> {
        require!(shares > 0, SharesError::InvalidShares);

        // The mint's own supply is the single source of truth for "shares sold"
        let sold = ctx.accounts.mint.supply;
        let remaining = ctx.accounts.listing.total_shares.saturating_sub(sold);
        require!(shares <= remaining, SharesError::NotEnoughShares);

        let cost = shares
            .checked_mul(ctx.accounts.listing.price_per_share)
            .ok_or(SharesError::MathOverflow)?;

        // CPI #1 — plain `invoke`: the investor already signed the outer transaction
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.investor.to_account_info(),
                    to: ctx.accounts.authority.to_account_info(),
                },
            ),
            cost,
        )?;

        // CPI #2 — `invoke_signed`: only this program can sign for the listing PDA
        let listing = &ctx.accounts.listing;
        let id_bytes = listing.id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"listing", listing.authority.as_ref(), &id_bytes, &[listing.bump]];
        mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.investor_ata.to_account_info(),
                    authority: ctx.accounts.listing.to_account_info(),
                },
                &[seeds],
            ),
            shares,
        )?;

        emit!(SharesPurchased {
            listing: ctx.accounts.listing.key(),
            investor: ctx.accounts.investor.key(),
            shares,
            cost,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateListing<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Listing::INIT_SPACE,
        seeds = [b"listing", authority.key().as_ref(), &id.to_le_bytes()],
        bump,
    )]
    pub listing: Account<'info, Listing>,

    /// Share mint: PDA, 0 decimals, mint authority = the listing PDA, no freeze authority
    #[account(
        init,
        payer = authority,
        seeds = [b"share_mint", listing.key().as_ref()],
        bump,
        mint::decimals = 0,
        mint::authority = listing,
        mint::token_program = token_program,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyShares<'info> {
    #[account(
        seeds = [b"listing", listing.authority.as_ref(), &listing.id.to_le_bytes()],
        bump = listing.bump,
        has_one = authority @ SharesError::WrongAuthority,
        has_one = mint @ SharesError::WrongMint,
    )]
    pub listing: Account<'info, Listing>,

    /// Receives the payment; pinned to `listing.authority` by `has_one`
    #[account(mut)]
    pub authority: SystemAccount<'info>,

    #[account(mut)]
    pub investor: Signer<'info>,

    #[account(mut, mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = investor,
        associated_token::mint = mint,
        associated_token::authority = investor,
        associated_token::token_program = token_program,
    )]
    pub investor_ata: InterfaceAccount<'info, TokenAccount>,

    /// Pinned to Token-2022: the shares must be minted by the program we expect
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// State, events, errors
// ---------------------------------------------------------------------------
#[account]
#[derive(InitSpace)]
pub struct Listing {
    pub authority: Pubkey,
    pub id: u64,
    pub mint: Pubkey,
    #[max_len(MAX_NAME_LEN)]
    pub name: String,
    pub total_shares: u64,
    pub price_per_share: u64,
    pub bump: u8,
}

#[event]
pub struct ListingCreated {
    pub listing: Pubkey,
    pub mint: Pubkey,
    pub total_shares: u64,
    pub price_per_share: u64,
}

#[event]
pub struct SharesPurchased {
    pub listing: Pubkey,
    pub investor: Pubkey,
    pub shares: u64,
    pub cost: u64,
}

#[error_code]
pub enum SharesError {
    #[msg("Name must be 1-48 bytes")]
    InvalidName,
    #[msg("Share count must be greater than zero")]
    InvalidShares,
    #[msg("Price per share must be greater than zero")]
    InvalidPrice,
    #[msg("Not enough shares left in this listing")]
    NotEnoughShares,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Payment account is not the listing authority")]
    WrongAuthority,
    #[msg("Mint is not this listing's share mint")]
    WrongMint,
}

