// ============================================================================
// Тесты для Profile Program (LiteSVM)
// ============================================================================

use profile_program::accounts;
use profile_program::instruction;
use anchor_lang::{InstructionData, ToAccountMetas, system_program};
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

fn program_id() -> anchor_lang::prelude::Pubkey {
    profile_program::id()
}

fn find_profile_pda(authority: &solana_keypair::Keypair) -> (anchor_lang::prelude::Pubkey, u8) {
    anchor_lang::prelude::Pubkey::find_program_address(
        &[b"profile", authority.pubkey().as_ref()],
        &program_id(),
    )
}

fn setup() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(
        program_id(),
        "../../target/deploy/profile_program.so",
    )
    .unwrap();

    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();

    (svm, authority)
}

fn create_profile_tx(
    svm: &LiteSVM,
    authority: &Keypair,
    name: String,
    bio: String,
    avatar_url: String,
) -> Transaction {
    let (profile_pda, _) = find_profile_pda(authority);

    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: program_id(),
        accounts: accounts::CreateProfile {
            profile: profile_pda,
            authority: authority.pubkey(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::CreateProfile {
            name,
            bio,
            avatar_url,
        }
        .data(),
    };

    Transaction::new(
        &[authority],
        Message::new(&[ix], Some(&authority.pubkey())),
        svm.latest_blockhash(),
    )
}

#[test]
fn test_create_profile() {
    let (mut svm, authority) = setup();

    let tx = create_profile_tx(
        &svm,
        &authority,
        "Alice".to_string(),
        "Solana developer from Kazakhstan".to_string(),
        "https://example.com/alice.png".to_string(),
    );

    let result = svm.send_transaction(tx);
    assert!(result.is_ok(), "Create profile failed: {:?}", result.err());

    // Verify account exists
    let (profile_pda, _) = find_profile_pda(&authority);
    let account = svm.get_account(&profile_pda);
    assert!(account.is_some(), "Profile account should exist");

    println!("✅ Create profile test passed!");
}

#[test]
fn test_update_profile() {
    let (mut svm, authority) = setup();

    // Create profile first
    let tx = create_profile_tx(
        &svm,
        &authority,
        "Alice".to_string(),
        "Original bio".to_string(),
        "https://example.com/old.png".to_string(),
    );
    svm.send_transaction(tx).unwrap();

    // Update profile
    let (profile_pda, _) = find_profile_pda(&authority);
    let update_ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: program_id(),
        accounts: accounts::UpdateProfile {
            profile: profile_pda,
            authority: authority.pubkey(),
        }
        .to_account_metas(None),
        data: instruction::UpdateProfile {
            name: Some("Alice Updated".to_string()),
            bio: Some("Updated bio: Senior Solana Developer".to_string()),
            avatar_url: None,
        }
        .data(),
    };

    let tx = Transaction::new(
        &[&authority],
        Message::new(&[update_ix], Some(&authority.pubkey())),
        svm.latest_blockhash(),
    );

    let result = svm.send_transaction(tx);
    assert!(result.is_ok(), "Update profile failed: {:?}", result.err());

    println!("✅ Update profile test passed!");
}

#[test]
fn test_delete_profile() {
    let (mut svm, authority) = setup();

    // Create profile
    let tx = create_profile_tx(
        &svm,
        &authority,
        "Bob".to_string(),
        "To be deleted".to_string(),
        "".to_string(),
    );
    svm.send_transaction(tx).unwrap();

    // Delete profile
    let (profile_pda, _) = find_profile_pda(&authority);
    let delete_ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: program_id(),
        accounts: accounts::DeleteProfile {
            profile: profile_pda,
            authority: authority.pubkey(),
        }
        .to_account_metas(None),
        data: instruction::DeleteProfile {}.data(),
    };

    let tx = Transaction::new(
        &[&authority],
        Message::new(&[delete_ix], Some(&authority.pubkey())),
        svm.latest_blockhash(),
    );
    let result = svm.send_transaction(tx);
    assert!(result.is_ok(), "Delete profile failed: {:?}", result.err());

    // Verify account is gone
    let account = svm.get_account(&profile_pda);
    assert!(account.is_none(), "Profile should be deleted");

    println!("✅ Delete profile test passed!");
}

#[test]
fn test_name_too_long() {
    let (mut svm, authority) = setup();

    let long_name = "A".repeat(51);
    let tx = create_profile_tx(
        &svm,
        &authority,
        long_name,
        "Bio".to_string(),
        "".to_string(),
    );

    let result = svm.send_transaction(tx);
    assert!(result.is_err(), "Should fail with name too long");

    println!("✅ Name too long correctly rejected!");
}

#[test]
fn test_empty_name() {
    let (mut svm, authority) = setup();

    let tx = create_profile_tx(
        &svm,
        &authority,
        "".to_string(),
        "Bio".to_string(),
        "".to_string(),
    );

    let result = svm.send_transaction(tx);
    assert!(result.is_err(), "Should fail with empty name");

    println!("✅ Empty name correctly rejected!");
}

#[test]
fn test_unauthorized_update() {
    let (mut svm, authority) = setup();

    let attacker = Keypair::new();
    svm.airdrop(&attacker.pubkey(), 10_000_000_000).unwrap();

    // Create profile with authority
    let tx = create_profile_tx(
        &svm,
        &authority,
        "Alice".to_string(),
        "My bio".to_string(),
        "".to_string(),
    );
    svm.send_transaction(tx).unwrap();

    // Try to update with attacker
    let (profile_pda, _) = find_profile_pda(&authority);
    let update_ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: program_id(),
        accounts: accounts::UpdateProfile {
            profile: profile_pda,
            authority: attacker.pubkey(),
        }
        .to_account_metas(None),
        data: instruction::UpdateProfile {
            name: Some("Hacked".to_string()),
            bio: None,
            avatar_url: None,
        }
        .data(),
    };

    let tx = Transaction::new(
        &[&attacker],
        Message::new(&[update_ix], Some(&attacker.pubkey())),
        svm.latest_blockhash(),
    );

    let result = svm.send_transaction(tx);
    assert!(result.is_err(), "Unauthorized update should fail");

    println!("✅ Unauthorized update correctly rejected!");
}

#[test]
fn test_duplicate_profile() {
    let (mut svm, authority) = setup();

    // Create first profile
    let tx = create_profile_tx(
        &svm,
        &authority,
        "Alice".to_string(),
        "First profile".to_string(),
        "".to_string(),
    );
    svm.send_transaction(tx).unwrap();

    // Try duplicate
    let tx = create_profile_tx(
        &svm,
        &authority,
        "Alice Again".to_string(),
        "Duplicate".to_string(),
        "".to_string(),
    );
    let result = svm.send_transaction(tx);
    assert!(result.is_err(), "Duplicate profile should fail");

    println!("✅ Duplicate profile correctly rejected!");
}
