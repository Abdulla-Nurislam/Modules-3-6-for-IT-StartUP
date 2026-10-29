// ============================================================================
// Roofic MVP (Week 8 · Build Sprint)
// Фракционное владение арендной недвижимостью:
//   1. Владелец объекта листит объект: N долей по фиксированной цене (SOL)
//   2. Инвесторы покупают доли → SOL сразу уходит владельцу
//   3. Владелец вносит арендный доход в SOL
//   4. Каждый инвестор забирает свою часть пропорционально долям
//
// Распределение дохода — паттерн "reward per share accumulator" (как в
// MasterChef / staking-пулах): O(1) на депозит, без цикла по инвесторам.
// ============================================================================

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("4qSqEcJ7KhcFsLnURE6dHuQ8KSRkkEX56oFYiRk8zKKf");

/// Масштаб аккумулятора: rent_per_share хранится с точностью 1e-12 lamports
pub const ACC_SCALE: u128 = 1_000_000_000_000;
pub const MAX_NAME_LEN: usize = 48;
pub const MAX_LOCATION_LEN: usize = 64;

#[program]
pub mod roofic_mvp {
    use super::*;

    /// Листинг нового объекта недвижимости
    pub fn create_property(
        ctx: Context<CreateProperty>,
        id: u64,
        name: String,
        location: String,
        total_shares: u64,
        price_per_share: u64,
    ) -> Result<()> {
        require!(!name.is_empty() && name.len() <= MAX_NAME_LEN, RooficError::InvalidName);
        require!(location.len() <= MAX_LOCATION_LEN, RooficError::InvalidLocation);
        require!(total_shares > 0, RooficError::InvalidShares);
        require!(price_per_share > 0, RooficError::InvalidPrice);

        let property = &mut ctx.accounts.property;
        property.authority = ctx.accounts.authority.key();
        property.id = id;
        property.name = name;
        property.location = location;
        property.total_shares = total_shares;
        property.shares_sold = 0;
        property.price_per_share = price_per_share;
        property.acc_rent_per_share = 0;
        property.total_rent_deposited = 0;
        property.bump = ctx.bumps.property;

        emit!(PropertyCreated {
            property: property.key(),
            authority: property.authority,
            total_shares,
            price_per_share,
        });
        Ok(())
    }

    /// Покупка долей. Оплата в SOL напрямую владельцу объекта.
    pub fn buy_shares(ctx: Context<BuyShares>, shares: u64) -> Result<()> {
        require!(shares > 0, RooficError::InvalidShares);
        let property = &mut ctx.accounts.property;
        let available = property
            .total_shares
            .checked_sub(property.shares_sold)
            .ok_or(RooficError::MathOverflow)?;
        require!(shares <= available, RooficError::NotEnoughShares);

        let cost = shares
            .checked_mul(property.price_per_share)
            .ok_or(RooficError::MathOverflow)?;

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

        let position = &mut ctx.accounts.position;
        if position.owner == Pubkey::default() {
            // Первая покупка — инициализируем позицию
            position.owner = ctx.accounts.investor.key();
            position.property = property.key();
            position.bump = ctx.bumps.position;
        }

        // Фиксируем уже начисленный доход ДО изменения количества долей,
        // иначе новые доли "получили бы" аренду, внесённую до их покупки.
        position.unclaimed = position
            .unclaimed
            .checked_add(pending_rent(position, property.acc_rent_per_share)?)
            .ok_or(RooficError::MathOverflow)?;
        position.shares = position
            .shares
            .checked_add(shares)
            .ok_or(RooficError::MathOverflow)?;
        position.reward_debt = accrued(position.shares, property.acc_rent_per_share)?;

        property.shares_sold = property
            .shares_sold
            .checked_add(shares)
            .ok_or(RooficError::MathOverflow)?;

        emit!(SharesPurchased {
            property: property.key(),
            investor: position.owner,
            shares,
            cost,
        });
        Ok(())
    }

    /// Владелец вносит арендный доход; он распределяется по проданным долям
    pub fn deposit_rent(ctx: Context<DepositRent>, amount: u64) -> Result<()> {
        require!(amount > 0, RooficError::InvalidAmount);
        let property = &mut ctx.accounts.property;
        require!(property.shares_sold > 0, RooficError::NoShareholders);

        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: property.to_account_info(),
                },
            ),
            amount,
        )?;

        let delta = (amount as u128)
            .checked_mul(ACC_SCALE)
            .ok_or(RooficError::MathOverflow)?
            / property.shares_sold as u128;
        property.acc_rent_per_share = property
            .acc_rent_per_share
            .checked_add(delta)
            .ok_or(RooficError::MathOverflow)?;
        property.total_rent_deposited = property
            .total_rent_deposited
            .checked_add(amount)
            .ok_or(RooficError::MathOverflow)?;

        emit!(RentDeposited { property: property.key(), amount });
        Ok(())
    }

    /// Инвестор забирает накопленный арендный доход
    pub fn claim_rent(ctx: Context<ClaimRent>) -> Result<()> {
        let property = &mut ctx.accounts.property;
        let position = &mut ctx.accounts.position;

        let amount = position
            .unclaimed
            .checked_add(pending_rent(position, property.acc_rent_per_share)?)
            .ok_or(RooficError::MathOverflow)?;
        require!(amount > 0, RooficError::NothingToClaim);

        position.unclaimed = 0;
        position.reward_debt = accrued(position.shares, property.acc_rent_per_share)?;
        position.total_claimed = position
            .total_claimed
            .checked_add(amount)
            .ok_or(RooficError::MathOverflow)?;

        // Property — аккаунт нашей программы, поэтому lamports можно списать
        // напрямую (System Program transfer требует, чтобы from был system-owned).
        property.sub_lamports(amount)?;
        ctx.accounts.investor.add_lamports(amount)?;

        emit!(RentClaimed { property: property.key(), investor: position.owner, amount });
        Ok(())
    }
}

fn accrued(shares: u64, acc: u128) -> Result<u128> {
    Ok((shares as u128).checked_mul(acc).ok_or(RooficError::MathOverflow)? / ACC_SCALE)
}

fn pending_rent(position: &Position, acc: u128) -> Result<u64> {
    let pending = accrued(position.shares, acc)?
        .checked_sub(position.reward_debt)
        .ok_or(RooficError::MathOverflow)?;
    u64::try_from(pending).map_err(|_| RooficError::MathOverflow.into())
}

// ============================================================================
// State
// ============================================================================

#[account]
#[derive(InitSpace)]
pub struct Property {
    pub authority: Pubkey,
    pub id: u64,
    #[max_len(48)]
    pub name: String,
    #[max_len(64)]
    pub location: String,
    pub total_shares: u64,
    pub shares_sold: u64,
    /// Цена одной доли в lamports
    pub price_per_share: u64,
    /// Накопленный доход на одну долю × ACC_SCALE
    pub acc_rent_per_share: u128,
    pub total_rent_deposited: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub property: Pubkey,
    pub shares: u64,
    /// shares × acc на момент последнего пересчёта — уже "учтённый" доход
    pub reward_debt: u128,
    /// Начисленный, но ещё не выплаченный доход
    pub unclaimed: u64,
    pub total_claimed: u64,
    pub bump: u8,
}

// ============================================================================
// Contexts
// ============================================================================

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateProperty<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Property::INIT_SPACE,
        seeds = [b"property", authority.key().as_ref(), &id.to_le_bytes()],
        bump,
    )]
    pub property: Account<'info, Property>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyShares<'info> {
    #[account(
        mut,
        has_one = authority @ RooficError::WrongAuthority,
        seeds = [b"property", property.authority.as_ref(), &property.id.to_le_bytes()],
        bump = property.bump,
    )]
    pub property: Account<'info, Property>,
    #[account(
        init_if_needed,
        payer = investor,
        space = 8 + Position::INIT_SPACE,
        seeds = [b"position", property.key().as_ref(), investor.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub investor: Signer<'info>,
    /// CHECK: получатель оплаты; совпадение с property.authority проверено через has_one
    #[account(mut)]
    pub authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositRent<'info> {
    #[account(
        mut,
        has_one = authority @ RooficError::WrongAuthority,
        seeds = [b"property", authority.key().as_ref(), &property.id.to_le_bytes()],
        bump = property.bump,
    )]
    pub property: Account<'info, Property>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimRent<'info> {
    #[account(
        mut,
        seeds = [b"property", property.authority.as_ref(), &property.id.to_le_bytes()],
        bump = property.bump,
    )]
    pub property: Account<'info, Property>,
    #[account(
        mut,
        seeds = [b"position", property.key().as_ref(), investor.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == investor.key() @ RooficError::WrongAuthority,
    )]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub investor: Signer<'info>,
}

// ============================================================================
// Events & Errors
// ============================================================================

#[event]
pub struct PropertyCreated {
    pub property: Pubkey,
    pub authority: Pubkey,
    pub total_shares: u64,
    pub price_per_share: u64,
}

#[event]
pub struct SharesPurchased {
    pub property: Pubkey,
    pub investor: Pubkey,
    pub shares: u64,
    pub cost: u64,
}

#[event]
pub struct RentDeposited {
    pub property: Pubkey,
    pub amount: u64,
}

#[event]
pub struct RentClaimed {
    pub property: Pubkey,
    pub investor: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum RooficError {
    #[msg("Name must be 1..=48 bytes")]
    InvalidName,
    #[msg("Location must be <= 64 bytes")]
    InvalidLocation,
    #[msg("Share amount must be greater than zero")]
    InvalidShares,
    #[msg("Price must be greater than zero")]
    InvalidPrice,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Not enough shares available")]
    NotEnoughShares,
    #[msg("No shares sold yet — nobody to distribute rent to")]
    NoShareholders,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Signer is not the expected authority")]
    WrongAuthority,
    #[msg("Math overflow")]
    MathOverflow,
}
