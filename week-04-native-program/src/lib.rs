// ============================================================================
// Первая Solana Program — Hello World + Counter (Нативная, без Anchor)
// ============================================================================
//
// Эта программа демонстрирует:
// 1. Entrypoint через process_instruction
// 2. Десериализацию instruction_data (Borsh)
// 3. Чтение и запись в Account Data
// 4. Логирование через msg!()
// 5. Проверку владельца аккаунта, флага is_writable и подписи (is_signer)
// 6. Обработку ошибок ProgramError
// ============================================================================
#![allow(unexpected_cfgs)]

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
};

// ============================================================================
// Данные аккаунта — хранятся on-chain
// ============================================================================
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Eq)]
pub struct CounterAccount {
    pub count: u64,
}

// ============================================================================
// Инструкции программы
// ============================================================================
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Eq)]
pub enum CounterInstruction {
    /// Инициализировать счётчик (count = 0)
    Initialize,
    /// Увеличить счётчик на 1
    Increment,
    /// Уменьшить счётчик на 1
    Decrement,
    /// Установить конкретное значение
    Set { value: u64 },
}

// ============================================================================
// Entrypoint — точка входа Solana программы
// ============================================================================
entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    msg!("🚀 Hello from First Solana Program!");
    msg!("Program ID: {}", program_id);

    // Десериализуем инструкцию из байтов
    let instruction = CounterInstruction::try_from_slice(instruction_data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    msg!("📨 Instruction: {:?}", instruction);

    // Роутинг инструкций
    match instruction {
        CounterInstruction::Initialize => initialize(program_id, accounts),
        CounterInstruction::Increment => increment(program_id, accounts),
        CounterInstruction::Decrement => decrement(program_id, accounts),
        CounterInstruction::Set { value } => set_value(program_id, accounts, value),
    }
}

/// Проверяет базовые инварианты безопасности нативного аккаунта:
/// 1) `owner == program_id`
/// 2) `is_writable == true`
/// 3) `data_len >= 8`
/// 4) Наличие подписи (`counter_account.is_signer` или второго аккаунта `authority.is_signer`)
fn validate_counter_account<'a, 'b>(
    program_id: &Pubkey,
    accounts: &'a [AccountInfo<'b>],
) -> Result<&'a AccountInfo<'b>, ProgramError> {
    let accounts_iter = &mut accounts.iter();
    let counter_account = next_account_info(accounts_iter)?;

    if counter_account.owner != program_id {
        msg!("❌ Counter account does not belong to this program");
        return Err(ProgramError::IncorrectProgramId);
    }

    if !counter_account.is_writable {
        msg!("❌ Counter account must be writable");
        return Err(ProgramError::InvalidArgument);
    }

    if counter_account.data_len() < 8 {
        msg!("❌ Counter account data buffer too small");
        return Err(ProgramError::AccountDataTooSmall);
    }

    if let Ok(authority) = next_account_info(accounts_iter) {
        if !authority.is_signer {
            msg!("❌ Authority account must be a signer");
            return Err(ProgramError::MissingRequiredSignature);
        }
    } else if !counter_account.is_signer {
        msg!("❌ Missing required signature on counter or authority account");
        return Err(ProgramError::MissingRequiredSignature);
    }

    Ok(counter_account)
}

// ============================================================================
// Обработчики инструкций
// ============================================================================

/// Инициализация счётчика
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let counter_account = validate_counter_account(program_id, accounts)?;

    let counter = CounterAccount { count: 0 };
    counter.serialize(&mut &mut counter_account.data.borrow_mut()[..8])?;

    msg!("✅ Counter initialized to 0");
    Ok(())
}

/// Увеличить счётчик
fn increment(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let counter_account = validate_counter_account(program_id, accounts)?;

    let mut counter = CounterAccount::try_from_slice(&counter_account.data.borrow()[..8])?;
    counter.count = counter
        .count
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    counter.serialize(&mut &mut counter_account.data.borrow_mut()[..8])?;

    msg!("✅ Counter incremented to {}", counter.count);
    Ok(())
}

/// Уменьшить счётчик
fn decrement(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let counter_account = validate_counter_account(program_id, accounts)?;

    let mut counter = CounterAccount::try_from_slice(&counter_account.data.borrow()[..8])?;

    let next = counter.count.checked_sub(1).ok_or_else(|| {
        msg!("❌ Counter is already 0, cannot decrement");
        ProgramError::InvalidArgument
    })?;

    counter.count = next;
    counter.serialize(&mut &mut counter_account.data.borrow_mut()[..8])?;

    msg!("✅ Counter decremented to {}", counter.count);
    Ok(())
}

/// Установить значение
fn set_value(program_id: &Pubkey, accounts: &[AccountInfo], value: u64) -> ProgramResult {
    let counter_account = validate_counter_account(program_id, accounts)?;

    let mut counter = CounterAccount::try_from_slice(&counter_account.data.borrow()[..8])?;
    counter.count = value;
    counter.serialize(&mut &mut counter_account.data.borrow_mut()[..8])?;

    msg!("✅ Counter set to {}", value);
    Ok(())
}

// ============================================================================
// Юнит-тесты
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_instruction_serialization() {
        let init = CounterInstruction::Initialize;
        let data = borsh::to_vec(&init).unwrap();
        let decoded = CounterInstruction::try_from_slice(&data).unwrap();
        assert_eq!(decoded, CounterInstruction::Initialize);

        let set = CounterInstruction::Set { value: 42 };
        let data = borsh::to_vec(&set).unwrap();
        let decoded = CounterInstruction::try_from_slice(&data).unwrap();
        assert_eq!(decoded, CounterInstruction::Set { value: 42 });
    }

    #[test]
    fn test_counter_account_serialization() {
        let counter = CounterAccount { count: 100 };
        let data = borsh::to_vec(&counter).unwrap();
        assert_eq!(data.len(), 8);
        let decoded = CounterAccount::try_from_slice(&data).unwrap();
        assert_eq!(decoded.count, 100);
    }

    #[test]
    fn test_process_instruction_full_lifecycle() {
        let program_id = Pubkey::new_unique();
        let counter_key = Pubkey::new_unique();
        let authority_key = Pubkey::new_unique();
        let mut lamports = 1_000_000u64;
        let mut auth_lamports = 1_000_000u64;
        let mut data = vec![0u8; 8];
        let mut auth_data = vec![];

        let accounts = vec![
            AccountInfo::new(
                &counter_key,
                false,
                true,
                &mut lamports,
                &mut data,
                &program_id,
                false,
                0,
            ),
            AccountInfo::new(
                &authority_key,
                true,
                false,
                &mut auth_lamports,
                &mut auth_data,
                &program_id,
                false,
                0,
            ),
        ];

        // 1. Initialize
        let ix = borsh::to_vec(&CounterInstruction::Initialize).unwrap();
        process_instruction(&program_id, &accounts, &ix).unwrap();
        assert_eq!(
            CounterAccount::try_from_slice(&accounts[0].data.borrow())
                .unwrap()
                .count,
            0
        );

        // 2. Increment
        let ix = borsh::to_vec(&CounterInstruction::Increment).unwrap();
        process_instruction(&program_id, &accounts, &ix).unwrap();
        assert_eq!(
            CounterAccount::try_from_slice(&accounts[0].data.borrow())
                .unwrap()
                .count,
            1
        );

        // 3. Set { value: 42 }
        let ix = borsh::to_vec(&CounterInstruction::Set { value: 42 }).unwrap();
        process_instruction(&program_id, &accounts, &ix).unwrap();
        assert_eq!(
            CounterAccount::try_from_slice(&accounts[0].data.borrow())
                .unwrap()
                .count,
            42
        );

        // 4. Decrement
        let ix = borsh::to_vec(&CounterInstruction::Decrement).unwrap();
        process_instruction(&program_id, &accounts, &ix).unwrap();
        assert_eq!(
            CounterAccount::try_from_slice(&accounts[0].data.borrow())
                .unwrap()
                .count,
            41
        );
    }

    #[test]
    fn test_security_checks_reject_invalid_accounts() {
        let program_id = Pubkey::new_unique();
        let wrong_owner = Pubkey::new_unique();
        let counter_key = Pubkey::new_unique();
        let mut lamports = 1_000_000u64;
        let mut data = vec![0u8; 8];
        let init_ix = borsh::to_vec(&CounterInstruction::Initialize).unwrap();

        // 1. Неверный owner -> IncorrectProgramId
        {
            let accounts = vec![AccountInfo::new(
                &counter_key,
                true,
                true,
                &mut lamports,
                &mut data,
                &wrong_owner,
                false,
                0,
            )];
            assert_eq!(
                process_instruction(&program_id, &accounts, &init_ix),
                Err(ProgramError::IncorrectProgramId)
            );
        }

        // 2. Read-only аккаунт (!is_writable) -> InvalidArgument
        {
            let accounts = vec![AccountInfo::new(
                &counter_key,
                true,
                false,
                &mut lamports,
                &mut data,
                &program_id,
                false,
                0,
            )];
            assert_eq!(
                process_instruction(&program_id, &accounts, &init_ix),
                Err(ProgramError::InvalidArgument)
            );
        }

        // 3. Отсутствует подпись (!is_signer) -> MissingRequiredSignature
        {
            let accounts = vec![AccountInfo::new(
                &counter_key,
                false,
                true,
                &mut lamports,
                &mut data,
                &program_id,
                false,
                0,
            )];
            assert_eq!(
                process_instruction(&program_id, &accounts, &init_ix),
                Err(ProgramError::MissingRequiredSignature)
            );
        }

        // 4. Decrement при count == 0 -> InvalidArgument
        {
            let accounts = vec![AccountInfo::new(
                &counter_key,
                true,
                true,
                &mut lamports,
                &mut data,
                &program_id,
                false,
                0,
            )];
            process_instruction(&program_id, &accounts, &init_ix).unwrap();
            let dec_ix = borsh::to_vec(&CounterInstruction::Decrement).unwrap();
            assert_eq!(
                process_instruction(&program_id, &accounts, &dec_ix),
                Err(ProgramError::InvalidArgument)
            );
        }
    }
}
