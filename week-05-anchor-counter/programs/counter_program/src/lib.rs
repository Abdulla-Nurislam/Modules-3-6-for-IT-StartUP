// ============================================================================
// Anchor Counter Program
// Демонстрация Anchor Framework: инструкции, аккаунты, constraints
// ============================================================================

use anchor_lang::prelude::*;

declare_id!("5ACn229Xq3arXb1MgF4Ux1iXY9yRTrN7VkaALLLttnLv");

#[program]
pub mod counter_program {
    use super::*;

    /// Инициализация счётчика
    /// Создаёт аккаунт Counter с начальным значением 0
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count = 0;
        counter.authority = ctx.accounts.authority.key();
        counter.bump = ctx.bumps.counter;

        msg!("✅ Counter initialized!");
        msg!("   Authority: {}", counter.authority);
        msg!("   Count: {}", counter.count);

        Ok(())
    }

    /// Увеличить счётчик на 1
    pub fn increment(ctx: Context<Update>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count = counter
            .count
            .checked_add(1)
            .ok_or(ErrorCode::Overflow)?;

        msg!("✅ Counter incremented to {}", counter.count);
        Ok(())
    }

    /// Уменьшить счётчик на 1
    pub fn decrement(ctx: Context<Update>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        require!(counter.count > 0, ErrorCode::Underflow);

        counter.count -= 1;
        msg!("✅ Counter decremented to {}", counter.count);
        Ok(())
    }

    /// Установить конкретное значение (только authority)
    pub fn set(ctx: Context<Update>, value: u64) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count = value;

        msg!("✅ Counter set to {}", counter.count);
        Ok(())
    }

    /// Закрыть аккаунт и вернуть rent
    pub fn close(_ctx: Context<Close>) -> Result<()> {
        msg!("✅ Counter account closed, rent returned to authority");
        Ok(())
    }
}

// ============================================================================
// Account Structures
// ============================================================================

/// Данные счётчика, хранящиеся on-chain
#[account]
#[derive(InitSpace)]
pub struct Counter {
    /// Текущее значение счётчика
    pub count: u64,
    /// Владелец счётчика (кто может модифицировать)
    pub authority: Pubkey,
    /// Bump для PDA
    pub bump: u8,
}

// ============================================================================
// Instruction Accounts (Contexts)
// ============================================================================

/// Контекст для инициализации
#[derive(Accounts)]
pub struct Initialize<'info> {
    /// Аккаунт счётчика — создаётся как PDA
    /// seeds: ["counter", authority] — уникальный counter для каждого пользователя
    #[account(
        init,
        payer = authority,
        space = 8 + Counter::INIT_SPACE,
        seeds = [b"counter", authority.key().as_ref()],
        bump,
    )]
    pub counter: Account<'info, Counter>,

    /// Пользователь, создающий счётчик (и payer за rent)
    #[account(mut)]
    pub authority: Signer<'info>,

    /// System Program — необходим для создания аккаунтов
    pub system_program: Program<'info, System>,
}

/// Контекст для обновления (increment, decrement, set)
#[derive(Accounts)]
pub struct Update<'info> {
    /// Аккаунт счётчика — проверяем что authority совпадает
    #[account(
        mut,
        seeds = [b"counter", authority.key().as_ref()],
        bump = counter.bump,
        has_one = authority,
    )]
    pub counter: Account<'info, Counter>,

    /// Владелец счётчика — должен подписать транзакцию
    pub authority: Signer<'info>,
}

/// Контекст для закрытия аккаунта
#[derive(Accounts)]
pub struct Close<'info> {
    /// Аккаунт счётчика — закрываем и возвращаем rent
    #[account(
        mut,
        seeds = [b"counter", authority.key().as_ref()],
        bump = counter.bump,
        has_one = authority,
        close = authority,
    )]
    pub counter: Account<'info, Counter>,

    /// Владелец — получит rent обратно
    #[account(mut)]
    pub authority: Signer<'info>,
}

// ============================================================================
// Custom Errors
// ============================================================================
#[error_code]
pub enum ErrorCode {
    #[msg("Counter overflow")]
    Overflow,
    #[msg("Counter underflow: cannot decrement below zero")]
    Underflow,
}
