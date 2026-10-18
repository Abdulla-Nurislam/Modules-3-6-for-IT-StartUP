// ============================================================================
// Profile Program — Децентрализованный on-chain профиль с использованием PDA
// ============================================================================
//
// Архитектура:
// - Каждый пользователь может создать один профиль
// - PDA seed: ["profile", user.key()] — детерминистический адрес
// - Только владелец может обновлять свой профиль
// - Профиль хранится полностью on-chain
// ============================================================================

use anchor_lang::prelude::*;

declare_id!("2RAyCS5nhX6osbmoqKeXoyXC9kxY57fvE4mRQxS3ZAdP");

// Максимальные длины строк в байтах UTF-8 (соответствуют #[max_len(...)] при расчёте INIT_SPACE)
const MAX_NAME_LEN: usize = 50;
const MAX_BIO_LEN: usize = 200;
const MAX_AVATAR_URL_LEN: usize = 200;

#[program]
pub mod profile_program {
    use super::*;

    /// Создание нового профиля
    /// PDA автоматически выводится из seeds ["profile", authority]
    pub fn create_profile(
        ctx: Context<CreateProfile>,
        name: String,
        bio: String,
        avatar_url: String,
    ) -> Result<()> {
        // Валидация длин строк
        require!(name.len() <= MAX_NAME_LEN, ErrorCode::NameTooLong);
        require!(bio.len() <= MAX_BIO_LEN, ErrorCode::BioTooLong);
        require!(
            avatar_url.len() <= MAX_AVATAR_URL_LEN,
            ErrorCode::AvatarUrlTooLong
        );
        require!(!name.is_empty(), ErrorCode::NameEmpty);

        let profile = &mut ctx.accounts.profile;
        let clock = Clock::get()?;

        profile.authority = ctx.accounts.authority.key();
        profile.name = name;
        profile.bio = bio;
        profile.avatar_url = avatar_url;
        profile.created_at = clock.unix_timestamp;
        profile.updated_at = clock.unix_timestamp;
        profile.bump = ctx.bumps.profile;

        msg!("✅ Profile created for {}", profile.authority);
        msg!("   Name: {}", profile.name);
        msg!("   Bio: {}", profile.bio);

        Ok(())
    }

    /// Обновление профиля (только owner может обновлять)
    pub fn update_profile(
        ctx: Context<UpdateProfile>,
        name: Option<String>,
        bio: Option<String>,
        avatar_url: Option<String>,
    ) -> Result<()> {
        let profile = &mut ctx.accounts.profile;
        let clock = Clock::get()?;

        // Обновляем только переданные поля (Option pattern)
        if let Some(new_name) = name {
            require!(new_name.len() <= MAX_NAME_LEN, ErrorCode::NameTooLong);
            require!(!new_name.is_empty(), ErrorCode::NameEmpty);
            profile.name = new_name;
        }

        if let Some(new_bio) = bio {
            require!(new_bio.len() <= MAX_BIO_LEN, ErrorCode::BioTooLong);
            profile.bio = new_bio;
        }

        if let Some(new_avatar_url) = avatar_url {
            require!(
                new_avatar_url.len() <= MAX_AVATAR_URL_LEN,
                ErrorCode::AvatarUrlTooLong
            );
            profile.avatar_url = new_avatar_url;
        }

        profile.updated_at = clock.unix_timestamp;

        msg!("✅ Profile updated for {}", profile.authority);
        msg!("   Name: {}", profile.name);
        msg!("   Updated at: {}", profile.updated_at);

        Ok(())
    }

    /// Удаление профиля (закрытие аккаунта, возврат rent)
    pub fn delete_profile(_ctx: Context<DeleteProfile>) -> Result<()> {
        msg!("✅ Profile deleted, rent returned to authority");
        Ok(())
    }
}

// ============================================================================
// Account Structure — On-chain Profile Data
// ============================================================================

#[account]
#[derive(InitSpace)]
pub struct UserProfile {
    /// Владелец профиля
    pub authority: Pubkey,

    /// Имя пользователя (макс. 50 байт UTF-8)
    #[max_len(50)]
    pub name: String,

    /// Биография (макс. 200 байт UTF-8)
    #[max_len(200)]
    pub bio: String,

    /// URL аватара (макс. 200 байт UTF-8)
    #[max_len(200)]
    pub avatar_url: String,

    /// Timestamp создания (Unix)
    pub created_at: i64,

    /// Timestamp последнего обновления (Unix)
    pub updated_at: i64,

    /// Bump для PDA
    pub bump: u8,
}

// ============================================================================
// Instruction Contexts
// ============================================================================

/// Контекст для создания профиля
#[derive(Accounts)]
pub struct CreateProfile<'info> {
    /// PDA профиля — уникальный для каждого пользователя
    /// seeds: ["profile", authority.key()] обеспечивает 1 профиль на wallet
    #[account(
        init,
        payer = authority,
        space = 8 + UserProfile::INIT_SPACE,
        seeds = [b"profile", authority.key().as_ref()],
        bump,
    )]
    pub profile: Account<'info, UserProfile>,

    /// Пользователь (создатель профиля и payer)
    #[account(mut)]
    pub authority: Signer<'info>,

    /// System Program для создания аккаунта
    pub system_program: Program<'info, System>,
}

/// Контекст для обновления профиля
#[derive(Accounts)]
pub struct UpdateProfile<'info> {
    /// PDA профиля — проверяем seeds и authority
    #[account(
        mut,
        seeds = [b"profile", authority.key().as_ref()],
        bump = profile.bump,
        has_one = authority @ ErrorCode::Unauthorized,
    )]
    pub profile: Account<'info, UserProfile>,

    /// Только владелец может обновлять
    pub authority: Signer<'info>,
}

/// Контекст для удаления профиля
#[derive(Accounts)]
pub struct DeleteProfile<'info> {
    /// PDA профиля — закрываем и возвращаем rent authority
    #[account(
        mut,
        seeds = [b"profile", authority.key().as_ref()],
        bump = profile.bump,
        has_one = authority @ ErrorCode::Unauthorized,
        close = authority,
    )]
    pub profile: Account<'info, UserProfile>,

    /// Владелец — получит rent обратно
    #[account(mut)]
    pub authority: Signer<'info>,
}

// ============================================================================
// Custom Errors
// ============================================================================

#[error_code]
pub enum ErrorCode {
    #[msg("Name exceeds maximum length of 50 characters")]
    NameTooLong,
    #[msg("Bio exceeds maximum length of 200 characters")]
    BioTooLong,
    #[msg("Avatar URL exceeds maximum length of 200 characters")]
    AvatarUrlTooLong,
    #[msg("Name cannot be empty")]
    NameEmpty,
    #[msg("Unauthorized: only the profile owner can modify this profile")]
    Unauthorized,
}
