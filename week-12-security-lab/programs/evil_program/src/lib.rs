// ============================================================================
// Evil program (Week 12 security lab)
// Stands in for a program an attacker deploys. It "succeeds" on ANY instruction
// without doing anything — so a victim that CPIs into it believes a transfer
// happened when no funds moved.
// ============================================================================

use anchor_lang::prelude::*;

declare_id!("95mqtwpJwMSUiFZKczLbTi7unYqPkEjHQRkEUV53LxH9");

#[program]
pub mod evil_program {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }

    /// Catches every instruction whose data does not start with a known discriminator,
    /// e.g. a System Program `Transfer` (u32 tag 2 + u64 amount)
    pub fn fallback<'info>(
        _program_id: &Pubkey,
        _accounts: &'info [AccountInfo<'info>],
        _data: &[u8],
    ) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}

