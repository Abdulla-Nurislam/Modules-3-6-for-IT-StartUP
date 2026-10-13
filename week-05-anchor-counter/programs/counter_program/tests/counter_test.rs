// ============================================================================
// Тесты для Counter Program (LiteSVM)
// ============================================================================

use anchor_lang::{system_program, AccountDeserialize, InstructionData, ToAccountMetas};
use counter_program::{accounts, instruction, Counter};
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

fn program_id() -> anchor_lang::prelude::Pubkey {
    counter_program::id()
}

/// Находит PDA адрес для counter
fn find_counter_pda(authority: &solana_keypair::Keypair) -> (anchor_lang::prelude::Pubkey, u8) {
    anchor_lang::prelude::Pubkey::find_program_address(
        &[b"counter", authority.pubkey().as_ref()],
        &program_id(),
    )
}

fn read_counter(svm: &LiteSVM, pda: &anchor_lang::prelude::Pubkey) -> Counter {
    let account = svm.get_account(pda).expect("counter PDA must exist");
    let mut slice: &[u8] = &account.data;
    Counter::try_deserialize(&mut slice).expect("valid Counter account")
}

fn assert_custom_err(
    res: Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>,
    expected_code: u32,
) {
    let err_dbg = format!("{:?}", res.expect_err("transaction was expected to fail").err);
    let needle = format!("Custom({expected_code})");
    assert!(
        err_dbg.contains(&needle),
        "expected {needle}, got {err_dbg}"
    );
}

fn setup() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(program_id(), "../../target/deploy/counter_program.so")
        .unwrap();

    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();

    (svm, authority)
}

fn init_counter(svm: &LiteSVM, authority: &Keypair) -> Transaction {
    let (counter_pda, _bump) = find_counter_pda(authority);

    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: program_id(),
        accounts: accounts::Initialize {
            counter: counter_pda,
            authority: authority.pubkey(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::Initialize {}.data(),
    };

    Transaction::new(
        &[authority],
        Message::new(&[ix], Some(&authority.pubkey())),
        svm.latest_blockhash(),
    )
}

#[test]
fn test_initialize() {
    let (mut svm, authority) = setup();

    let tx = init_counter(&svm, &authority);
    let result = svm.send_transaction(tx);
    assert!(result.is_ok(), "Initialize failed: {:?}", result.err());

    let (counter_pda, expected_bump) = find_counter_pda(&authority);
    let account = svm.get_account(&counter_pda).unwrap();
    // Anchor discriminator (8 bytes) + count (8 bytes) + authority (32 bytes) + bump (1 byte)
    assert_eq!(account.data.len(), 8 + 8 + 32 + 1);

    let state = read_counter(&svm, &counter_pda);
    assert_eq!(state.count, 0);
    assert_eq!(state.authority, authority.pubkey());
    assert_eq!(state.bump, expected_bump);
}

#[test]
fn test_increment() {
    let (mut svm, authority) = setup();

    let tx = init_counter(&svm, &authority);
    svm.send_transaction(tx).unwrap();

    let (counter_pda, _) = find_counter_pda(&authority);

    for i in 1..=3 {
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: program_id(),
            accounts: accounts::Update {
                counter: counter_pda,
                authority: authority.pubkey(),
            }
            .to_account_metas(None),
            data: instruction::Increment {}.data(),
        };

        let tx = Transaction::new(
            &[&authority],
            Message::new(&[ix], Some(&authority.pubkey())),
            svm.latest_blockhash(),
        );
        svm.send_transaction(tx).unwrap();
        svm.expire_blockhash();

        assert_eq!(read_counter(&svm, &counter_pda).count, i);
    }
}

#[test]
fn test_decrement() {
    let (mut svm, authority) = setup();

    let tx = init_counter(&svm, &authority);
    svm.send_transaction(tx).unwrap();

    let (counter_pda, _) = find_counter_pda(&authority);

    // Increment first
    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: program_id(),
        accounts: accounts::Update {
            counter: counter_pda,
            authority: authority.pubkey(),
        }
        .to_account_metas(None),
        data: instruction::Increment {}.data(),
    };
    let tx = Transaction::new(
        &[&authority],
        Message::new(&[ix], Some(&authority.pubkey())),
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).unwrap();
    assert_eq!(read_counter(&svm, &counter_pda).count, 1);

    // Decrement
    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: program_id(),
        accounts: accounts::Update {
            counter: counter_pda,
            authority: authority.pubkey(),
        }
        .to_account_metas(None),
        data: instruction::Decrement {}.data(),
    };
    let tx = Transaction::new(
        &[&authority],
        Message::new(&[ix], Some(&authority.pubkey())),
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).unwrap();
    assert_eq!(read_counter(&svm, &counter_pda).count, 0);
}

#[test]
fn test_decrement_underflow_fails() {
    let (mut svm, authority) = setup();

    let tx = init_counter(&svm, &authority);
    svm.send_transaction(tx).unwrap();

    let (counter_pda, _) = find_counter_pda(&authority);

    // Попытка декремента при count == 0 должна вернуть ErrorCode::Underflow (6001)
    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: program_id(),
        accounts: accounts::Update {
            counter: counter_pda,
            authority: authority.pubkey(),
        }
        .to_account_metas(None),
        data: instruction::Decrement {}.data(),
    };
    let tx = Transaction::new(
        &[&authority],
        Message::new(&[ix], Some(&authority.pubkey())),
        svm.latest_blockhash(),
    );
    // ErrorCode::Underflow — 2-й вариант enum ErrorCode -> 6000 + 1 = 6001
    assert_custom_err(svm.send_transaction(tx), 6001);
}

#[test]
fn test_set_value() {
    let (mut svm, authority) = setup();

    let tx = init_counter(&svm, &authority);
    svm.send_transaction(tx).unwrap();

    let (counter_pda, _) = find_counter_pda(&authority);

    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: program_id(),
        accounts: accounts::Update {
            counter: counter_pda,
            authority: authority.pubkey(),
        }
        .to_account_metas(None),
        data: instruction::Set { value: 42 }.data(),
    };
    let tx = Transaction::new(
        &[&authority],
        Message::new(&[ix], Some(&authority.pubkey())),
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).unwrap();
    assert_eq!(read_counter(&svm, &counter_pda).count, 42);
}

#[test]
fn test_close() {
    let (mut svm, authority) = setup();

    let tx = init_counter(&svm, &authority);
    svm.send_transaction(tx).unwrap();

    let (counter_pda, _) = find_counter_pda(&authority);

    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: program_id(),
        accounts: accounts::Close {
            counter: counter_pda,
            authority: authority.pubkey(),
        }
        .to_account_metas(None),
        data: instruction::Close {}.data(),
    };
    let tx = Transaction::new(
        &[&authority],
        Message::new(&[ix], Some(&authority.pubkey())),
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).unwrap();

    let account = svm.get_account(&counter_pda);
    assert!(account.is_none(), "Account should be closed");
}

#[test]
fn test_unauthorized_update_fails() {
    let (mut svm, authority) = setup();

    let attacker = Keypair::new();
    svm.airdrop(&attacker.pubkey(), 10_000_000_000).unwrap();

    let tx = init_counter(&svm, &authority);
    svm.send_transaction(tx).unwrap();

    let (counter_pda, _) = find_counter_pda(&authority);

    // Попытка обновить чужой counter PDA подписантом attacker -> ConstraintSeeds (2006)
    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: program_id(),
        accounts: accounts::Update {
            counter: counter_pda,
            authority: attacker.pubkey(),
        }
        .to_account_metas(None),
        data: instruction::Increment {}.data(),
    };
    let tx = Transaction::new(
        &[&attacker],
        Message::new(&[ix], Some(&attacker.pubkey())),
        svm.latest_blockhash(),
    );
    assert_custom_err(svm.send_transaction(tx), 2006);
}
