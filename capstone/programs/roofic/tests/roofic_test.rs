// ============================================================================
// LiteSVM tests for the Roofic capstone program.
// Run `anchor build` first — tests load target/deploy/roofic.so
//
// Payment tokens (USDC-like mint, token accounts) are created directly in LiteSVM with
// their exact on-chain byte layout; the share mint is created by the program itself.
// The whole money cycle is run against BOTH payment programs (SPL Token and Token-2022).
// ============================================================================

use anchor_lang::{
    error::{ErrorCode, ERROR_CODE_OFFSET},
    prelude::Pubkey,
    solana_program::instruction::{AccountMeta, Instruction},
    system_program, AccountDeserialize, InstructionData, ToAccountMetas,
};
use anchor_spl::token_2022::spl_token_2022::{error::TokenError, extension::ExtensionType};
use litesvm::LiteSVM;
use roofic::{accounts, instruction, Position, Property, RooficError};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::str::FromStr;

const USDC: u64 = 1_000_000; // 6 decimals
const PRICE: u64 = 100 * USDC; // 100 USDC per share
const TOTAL_SHARES: u64 = 1_000;
const RENT_FEE_BPS: u16 = 100; // 1%
const SALE_FEE_BPS: u16 = 150; // 1.5%
const SOL: u64 = 1_000_000_000;

fn pk(s: &str) -> Pubkey {
    Pubkey::from_str(s).unwrap()
}
fn token_2022() -> Pubkey {
    pk("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
}
fn legacy_token() -> Pubkey {
    pk("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
}
fn ata_program() -> Pubkey {
    pk("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
}
fn bpf_loader_upgradeable() -> Pubkey {
    pk("BPFLoaderUpgradeab1e11111111111111111111111")
}
fn program_data_pda() -> Pubkey {
    Pubkey::find_program_address(&[roofic::id().as_ref()], &bpf_loader_upgradeable()).0
}
fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &roofic::id()).0
}
fn share_ata(wallet: &Pubkey, share_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[wallet.as_ref(), token_2022().as_ref(), share_mint.as_ref()],
        &ata_program(),
    )
    .0
}

fn framework(code: ErrorCode) -> String {
    format!("Custom({})", code as u32)
}
fn custom(code: RooficError) -> String {
    format!("Custom({})", ERROR_CODE_OFFSET + code as u32)
}

// ---- raw token state ------------------------------------------------------
fn mint_bytes(decimals: u8) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[44] = decimals;
    d[45] = 1; // is_initialized
    d
}
fn token_account_bytes(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // AccountState::Initialized
    d
}

struct World {
    svm: LiteSVM,
    payment_program: Pubkey,
    payment_mint: Pubkey,
    admin: Keypair,
    owner: Keypair,
    manager: Keypair,
    outsider: Keypair,
    alice: Keypair,
    bob: Keypair,
    config: Pubkey,
    treasury: Pubkey,
    owner_pay: Pubkey,
    manager_pay: Pubkey,
    property: Pubkey,
    share_mint: Pubkey,
    vault: Pubkey,
    pay_accounts: std::collections::HashMap<Pubkey, Pubkey>, // wallet -> its payment token account
}

impl World {
    fn send(&mut self, ix: Instruction, signers: &[&Keypair]) -> Result<(), String> {
        let tx = Transaction::new(
            signers,
            Message::new(&[ix], Some(&signers[0].pubkey())),
            self.svm.latest_blockhash(),
        );
        let res = self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err));
        self.svm.expire_blockhash();
        res
    }

    fn ix(&self, accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
        Instruction { program_id: roofic::id(), accounts, data }
    }

    fn token_balance(&self, account: &Pubkey) -> u64 {
        match self.svm.get_account(account) {
            Some(a) => u64::from_le_bytes(a.data[64..72].try_into().unwrap()),
            None => 0,
        }
    }

    fn supply(&self) -> u64 {
        u64::from_le_bytes(self.svm.get_account(&self.share_mint).unwrap().data[36..44].try_into().unwrap())
    }

    fn property_state(&self) -> Property {
        let a = self.svm.get_account(&self.property).unwrap();
        Property::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    fn position_pda(&self, wallet: &Pubkey) -> Pubkey {
        pda(&[b"position", self.property.as_ref(), wallet.as_ref()])
    }

    fn position(&self, wallet: &Pubkey) -> Option<Position> {
        let a = self.svm.get_account(&self.position_pda(wallet))?;
        Position::try_deserialize(&mut a.data.as_slice()).ok()
    }

    fn pay_account(&self, wallet: &Pubkey) -> Pubkey {
        self.pay_accounts[wallet]
    }

    fn add_funded_wallet(&mut self, wallet: &Pubkey, usdc: u64) {
        let key = Pubkey::new_unique();
        self.svm
            .set_account(
                key,
                Account {
                    lamports: 10_000_000,
                    data: token_account_bytes(&self.payment_mint, wallet, usdc * USDC),
                    owner: self.payment_program,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        self.pay_accounts.insert(*wallet, key);
    }

    // ---- instruction builders ------------------------------------------------
    fn approve(&mut self, wallet: &Pubkey) -> Result<(), String> {
        let admin = self.admin.insecure_clone();
        let ix = self.ix(
            accounts::ApproveInvestor {
                config: self.config,
                investor_record: pda(&[b"investor", wallet.as_ref()]),
                wallet: *wallet,
                admin: admin.pubkey(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            instruction::ApproveInvestor {}.data(),
        );
        self.send(ix, &[&admin])
    }

    fn revoke(&mut self, wallet: &Pubkey, signer: &Keypair) -> Result<(), String> {
        let ix = self.ix(
            accounts::RevokeInvestor {
                config: self.config,
                investor_record: pda(&[b"investor", wallet.as_ref()]),
                admin: signer.pubkey(),
            }
            .to_account_metas(None),
            instruction::RevokeInvestor {}.data(),
        );
        self.send(ix, &[signer])
    }

    fn set_paused(&mut self, paused: bool, signer: &Keypair) -> Result<(), String> {
        let ix = self.ix(
            accounts::AdminOnly { config: self.config, admin: signer.pubkey() }.to_account_metas(None),
            instruction::SetPaused { paused }.data(),
        );
        self.send(ix, &[signer])
    }

    fn buy_metas(&self, investor: &Pubkey) -> Vec<AccountMeta> {
        accounts::BuyShares {
            config: self.config,
            investor_record: pda(&[b"investor", investor.as_ref()]),
            property: self.property,
            share_mint: self.share_mint,
            position: self.position_pda(investor),
            investor_shares: share_ata(investor, &self.share_mint),
            payment_mint: self.payment_mint,
            investor_payment: self.pay_account(investor),
            owner_payment: self.owner_pay,
            treasury: self.treasury,
            investor: *investor,
            share_token_program: token_2022(),
            payment_token_program: self.payment_program,
            associated_token_program: ata_program(),
            system_program: system_program::ID,
        }
        .to_account_metas(None)
    }

    fn buy(&mut self, who: &Keypair, shares: u64) -> Result<(), String> {
        let ix = self.ix(self.buy_metas(&who.pubkey()), instruction::BuyShares { shares }.data());
        self.send(ix, &[who])
    }

    fn deposit_rent(&mut self, manager: &Keypair, manager_pay: Pubkey, amount: u64) -> Result<(), String> {
        let ix = self.ix(
            accounts::DepositRent {
                config: self.config,
                property: self.property,
                share_mint: self.share_mint,
                vault: self.vault,
                payment_mint: self.payment_mint,
                manager_payment: manager_pay,
                treasury: self.treasury,
                manager: manager.pubkey(),
                share_token_program: token_2022(),
                payment_token_program: self.payment_program,
            }
            .to_account_metas(None),
            instruction::DepositRent { amount }.data(),
        );
        self.send(ix, &[manager])
    }

    fn claim(&mut self, who: &Keypair) -> Result<(), String> {
        let ix = self.ix(
            accounts::ClaimRent {
                config: self.config,
                property: self.property,
                position: self.position_pda(&who.pubkey()),
                vault: self.vault,
                payment_mint: self.payment_mint,
                investor_payment: self.pay_account(&who.pubkey()),
                investor: who.pubkey(),
                payment_token_program: self.payment_program,
            }
            .to_account_metas(None),
            instruction::ClaimRent {}.data(),
        );
        self.send(ix, &[who])
    }
}

fn set_upgrade_authority(svm: &mut LiteSVM, authority: &Pubkey) {
    let pd_key = program_data_pda();
    let mut pd = svm.get_account(&pd_key).expect("ProgramData account created by LiteSVM");
    // UpgradeableLoaderState::ProgramData layout: 4-byte tag (3u32) + 8-byte slot + 1-byte Option tag + 32-byte Pubkey
    pd.data[12] = 1;
    pd.data[13..45].copy_from_slice(authority.as_ref());
    svm.set_account(pd_key, pd).unwrap();
}

fn world(payment_program: Pubkey) -> World {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(roofic::id(), "../../target/deploy/roofic.so").unwrap();

    let keys: Vec<Keypair> = (0..6).map(|_| Keypair::new()).collect();
    for k in &keys {
        svm.airdrop(&k.pubkey(), 100 * SOL).unwrap();
    }
    let [admin, owner, manager, outsider, alice, bob]: [Keypair; 6] = keys.try_into().ok().unwrap();
    set_upgrade_authority(&mut svm, &admin.pubkey());

    let payment_mint = Pubkey::new_unique();
    svm.set_account(
        payment_mint,
        Account { lamports: 10_000_000, data: mint_bytes(6), owner: payment_program, executable: false, rent_epoch: 0 },
    )
    .unwrap();

    let config = pda(&[b"config"]);
    let property = pda(&[b"property", owner.pubkey().as_ref(), &1u64.to_le_bytes()]);
    let share_mint = pda(&[b"share_mint", property.as_ref()]);
    let vault = pda(&[b"vault", property.as_ref()]);

    let mut w = World {
        svm,
        payment_program,
        payment_mint,
        admin,
        owner,
        manager,
        outsider,
        alice,
        bob,
        config,
        treasury: Pubkey::default(),
        owner_pay: Pubkey::default(),
        manager_pay: Pubkey::default(),
        property,
        share_mint,
        vault,
        pay_accounts: Default::default(),
    };

    // Funded payment accounts
    let (admin_k, owner_k, manager_k, outsider_k, alice_k, bob_k) = (
        w.admin.pubkey(),
        w.owner.pubkey(),
        w.manager.pubkey(),
        w.outsider.pubkey(),
        w.alice.pubkey(),
        w.bob.pubkey(),
    );
    w.add_funded_wallet(&admin_k, 0);
    w.add_funded_wallet(&owner_k, 0);
    w.add_funded_wallet(&manager_k, 1_000_000);
    w.add_funded_wallet(&outsider_k, 1_000_000);
    w.add_funded_wallet(&alice_k, 1_000_000);
    w.add_funded_wallet(&bob_k, 1_000_000);
    w.treasury = w.pay_account(&admin_k);
    w.owner_pay = w.pay_account(&owner_k);
    w.manager_pay = w.pay_account(&manager_k);

    // initialize_platform
    let admin = w.admin.insecure_clone();
    let ix = w.ix(
        accounts::InitializePlatform {
            config: w.config,
            payment_mint: w.payment_mint,
            treasury: w.treasury,
            admin: admin.pubkey(),
            program: roofic::id(),
            program_data: program_data_pda(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        instruction::InitializePlatform { rent_fee_bps: RENT_FEE_BPS, sale_fee_bps: SALE_FEE_BPS }.data(),
    );
    w.send(ix, &[&admin]).expect("initialize_platform");

    // KYB/KYC: approve the property issuer (owner) as well as Alice and Bob; outsider stays unapproved
    w.approve(&owner_k).expect("approve owner");
    w.approve(&alice_k).expect("approve alice");
    w.approve(&bob_k).expect("approve bob");

    // create_property
    let owner = w.owner.insecure_clone();
    let ix = w.ix(
        accounts::CreateProperty {
            config: w.config,
            owner_kyc: pda(&[b"investor", owner.pubkey().as_ref()]),
            property: w.property,
            share_mint: w.share_mint,
            vault: w.vault,
            payment_mint: w.payment_mint,
            owner: owner.pubkey(),
            share_token_program: token_2022(),
            payment_token_program: w.payment_program,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        instruction::CreateProperty {
            id: 1,
            name: "Almaty Loft #1".into(),
            total_shares: TOTAL_SHARES,
            price_per_share: PRICE,
            manager: manager_k,
            valuation_hash: [7u8; 32],
        }
        .data(),
    );
    w.send(ix, &[&owner]).expect("create_property");
    w
}

fn alice(w: &World) -> Keypair {
    w.alice.insecure_clone()
}
fn bob(w: &World) -> Keypair {
    w.bob.insecure_clone()
}

// ---------------------------------------------------------------------------
// Property creation
// ---------------------------------------------------------------------------
#[test]
fn property_creation_makes_a_non_transferable_token2022_share_mint() {
    let w = world(legacy_token());
    let mint = w.svm.get_account(&w.share_mint).unwrap();
    assert_eq!(mint.owner, token_2022());
    assert_eq!(&mint.data[4..36], w.property.as_ref(), "mint authority is the property PDA");
    assert_eq!(mint.data[44], 0, "0 decimals");
    assert_eq!(u32::from_le_bytes(mint.data[46..50].try_into().unwrap()), 0, "no freeze authority");
    assert!(mint.data.len() > 82, "extension data present (NonTransferable)");

    let p = w.property_state();
    assert_eq!((p.total_shares, p.price_per_share, p.shares_sold), (TOTAL_SHARES, PRICE, 0));
    assert_eq!(p.valuation_hash, [7u8; 32]);
    assert_eq!(p.share_mint, w.share_mint);
    assert_eq!(p.vault, w.vault);
    // the vault is a payment-token account owned by the property PDA
    let vault = w.svm.get_account(&w.vault).unwrap();
    assert_eq!(&vault.data[32..64], w.property.as_ref());
}

// ---------------------------------------------------------------------------
// Platform controls
// ---------------------------------------------------------------------------
#[test]
fn only_the_admin_can_pause_and_fees_are_capped() {
    let mut w = world(legacy_token());
    let outsider = w.outsider.insecure_clone();
    let err = w.set_paused(true, &outsider).expect_err("non-admin must not pause");
    assert!(err.contains(&custom(RooficError::NotAdmin)), "got {err}");

    let admin = w.admin.insecure_clone();
    w.set_paused(true, &admin).expect("admin pauses");

    let ix = w.ix(
        accounts::AdminOnly { config: w.config, admin: admin.pubkey() }.to_account_metas(None),
        instruction::SetFees { rent_fee_bps: 2_001, sale_fee_bps: 0 }.data(),
    );
    let err = w.send(ix, &[&admin]).expect_err("fee above ceiling");
    assert!(err.contains(&custom(RooficError::FeeTooHigh)), "got {err}");
}

#[test]
fn kyc_gate_blocks_unapproved_wallets_until_approved_and_again_after_revoke() {
    let mut w = world(legacy_token());
    let outsider = w.outsider.insecure_clone();
    let outsider_k = outsider.pubkey();

    let err = w.buy(&outsider, 1).expect_err("not approved");
    assert!(err.contains(&framework(ErrorCode::AccountNotInitialized)), "got {err}");
    assert_eq!(w.supply(), 0);

    w.approve(&outsider_k).expect("approve");
    w.buy(&outsider, 1).expect("approved wallet can buy");
    assert_eq!(w.supply(), 1);

    // a non-admin cannot revoke anyone
    let err = w.revoke(&outsider_k, &outsider).expect_err("non-admin revoke");
    assert!(err.contains(&custom(RooficError::NotAdmin)), "got {err}");

    let admin = w.admin.insecure_clone();
    w.revoke(&outsider_k, &admin).expect("admin revokes");
    let err = w.buy(&outsider, 1).expect_err("revoked");
    assert!(err.contains(&framework(ErrorCode::AccountNotInitialized)), "got {err}");
}

// ---------------------------------------------------------------------------
// Buying
// ---------------------------------------------------------------------------
#[test]
fn buy_splits_payment_between_owner_and_treasury_and_mints_shares() {
    let mut w = world(legacy_token());
    let alice = alice(&w);
    let before = w.token_balance(&w.pay_account(&alice.pubkey()));

    w.buy(&alice, 10).expect("buy");

    let cost = 10 * PRICE; // 1000 USDC
    let fee = cost * SALE_FEE_BPS as u64 / 10_000; // 15 USDC
    assert_eq!(fee, 15 * USDC);
    assert_eq!(before - w.token_balance(&w.pay_account(&alice.pubkey())), cost, "investor pays exactly cost");
    assert_eq!(w.token_balance(&w.owner_pay), cost - fee, "owner receives cost minus sale fee");
    assert_eq!(w.token_balance(&w.treasury), fee, "treasury receives the sale fee");

    assert_eq!(w.token_balance(&share_ata(&alice.pubkey(), &w.share_mint)), 10);
    assert_eq!(w.supply(), 10);
    let pos = w.position(&alice.pubkey()).unwrap();
    assert_eq!(pos.shares, 10);
    assert_eq!(w.property_state().shares_sold, 10);
}

#[test]
fn cannot_oversell_the_property() {
    let mut w = world(legacy_token());
    let (alice, bob) = (alice(&w), bob(&w));
    w.buy(&alice, 990).expect("big buy");
    let err = w.buy(&bob, 11).expect_err("only 10 left");
    assert!(err.contains(&custom(RooficError::NotEnoughShares)), "got {err}");
    assert_eq!(w.supply(), 990);
    w.buy(&bob, 10).expect("exact remainder");
    assert_eq!(w.supply(), TOTAL_SHARES);
}

#[test]
fn shares_cannot_be_transferred_between_wallets() {
    let mut w = world(legacy_token());
    let (alice, bob) = (alice(&w), bob(&w));
    w.buy(&alice, 5).unwrap();
    w.buy(&bob, 1).unwrap();
    let (a_ata, b_ata) = (share_ata(&alice.pubkey(), &w.share_mint), share_ata(&bob.pubkey(), &w.share_mint));

    // Token-2022 TransferChecked: tag 12, amount u64, decimals u8
    let mut data = vec![12];
    data.extend_from_slice(&2u64.to_le_bytes());
    data.push(0);
    let ix = Instruction {
        program_id: token_2022(),
        accounts: vec![
            AccountMeta::new(a_ata, false),
            AccountMeta::new_readonly(w.share_mint, false),
            AccountMeta::new(b_ata, false),
            AccountMeta::new_readonly(alice.pubkey(), true),
        ],
        data,
    };
    let err = w.send(ix, &[&alice]).expect_err("NonTransferable must block this");
    assert!(err.contains(&format!("Custom({})", TokenError::NonTransferable as u32)), "got {err}");
    assert_eq!(w.token_balance(&a_ata), 5);
    assert_eq!(w.token_balance(&b_ata), 1);
}

// ---------------------------------------------------------------------------
// Rent
// ---------------------------------------------------------------------------
#[test]
fn rent_is_split_pro_rata_after_the_platform_fee() {
    let mut w = world(legacy_token());
    let (alice, bob, manager) = (alice(&w), bob(&w), w.manager.insecure_clone());
    w.buy(&alice, 10).unwrap();
    w.buy(&bob, 30).unwrap();
    let treasury_before = w.token_balance(&w.treasury);

    let mp = w.manager_pay;
    w.deposit_rent(&manager, mp, 100 * USDC).expect("deposit");
    assert_eq!(w.token_balance(&w.treasury) - treasury_before, USDC, "1% rent fee");
    assert_eq!(w.token_balance(&w.vault), 99 * USDC, "net rent in the vault");

    let (a_before, b_before) = (w.token_balance(&w.pay_account(&alice.pubkey())), w.token_balance(&w.pay_account(&bob.pubkey())));
    w.claim(&alice).expect("alice claims");
    w.claim(&bob).expect("bob claims");
    assert_eq!(w.token_balance(&w.pay_account(&alice.pubkey())) - a_before, 24_750_000, "10/40 of 99 USDC");
    assert_eq!(w.token_balance(&w.pay_account(&bob.pubkey())) - b_before, 74_250_000, "30/40 of 99 USDC");
    assert_eq!(w.token_balance(&w.vault), 0);

    let err = w.claim(&alice).expect_err("double claim");
    assert!(err.contains(&custom(RooficError::NothingToClaim)), "got {err}");
}

#[test]
fn late_buyer_gets_nothing_from_earlier_rent() {
    let mut w = world(legacy_token());
    let (alice, bob, manager) = (alice(&w), bob(&w), w.manager.insecure_clone());
    w.buy(&alice, 10).unwrap();
    let mp = w.manager_pay;
    w.deposit_rent(&manager, mp, 100 * USDC).unwrap();
    w.buy(&bob, 10).unwrap(); // after the deposit

    let err = w.claim(&bob).expect_err("bob arrived after the rent");
    assert!(err.contains(&custom(RooficError::NothingToClaim)), "got {err}");
    let before = w.token_balance(&w.pay_account(&alice.pubkey()));
    w.claim(&alice).unwrap();
    assert_eq!(w.token_balance(&w.pay_account(&alice.pubkey())) - before, 99 * USDC, "alice gets all of it");
}

#[test]
fn rent_accrued_before_a_second_purchase_is_kept() {
    let mut w = world(legacy_token());
    let (alice, manager) = (alice(&w), w.manager.insecure_clone());
    w.buy(&alice, 10).unwrap();
    let mp = w.manager_pay;
    w.deposit_rent(&manager, mp, 100 * USDC).unwrap();
    w.buy(&alice, 10).unwrap(); // doubles her stake AFTER the rent
    let before = w.token_balance(&w.pay_account(&alice.pubkey()));
    w.claim(&alice).unwrap();
    assert_eq!(w.token_balance(&w.pay_account(&alice.pubkey())) - before, 99 * USDC);
}

#[test]
fn only_the_property_manager_can_deposit_rent() {
    let mut w = world(legacy_token());
    let alice = alice(&w);
    w.buy(&alice, 10).unwrap();
    let owner = w.owner.insecure_clone();
    let owner_pay = w.owner_pay;
    // the owner is not the manager (and even has funds in this scenario)
    w.svm
        .set_account(
            owner_pay,
            Account {
                lamports: 10_000_000,
                data: token_account_bytes(&w.payment_mint, &owner.pubkey(), 500 * USDC),
                owner: w.payment_program,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let err = w.deposit_rent(&owner, owner_pay, 100 * USDC).expect_err("owner is not the manager");
    assert!(err.contains(&custom(RooficError::NotManager)), "got {err}");
    assert_eq!(w.token_balance(&w.vault), 0);
}

#[test]
fn nobody_can_claim_someone_elses_position() {
    let mut w = world(legacy_token());
    let (alice, bob, manager) = (alice(&w), bob(&w), w.manager.insecure_clone());
    w.buy(&alice, 10).unwrap();
    w.buy(&bob, 10).unwrap();
    let mp = w.manager_pay;
    w.deposit_rent(&manager, mp, 100 * USDC).unwrap();

    // Bob signs, but points the instruction at Alice's position
    let mut metas = accounts::ClaimRent {
        config: w.config,
        property: w.property,
        position: w.position_pda(&alice.pubkey()),
        vault: w.vault,
        payment_mint: w.payment_mint,
        investor_payment: w.pay_account(&bob.pubkey()),
        investor: bob.pubkey(),
        payment_token_program: w.payment_program,
    }
    .to_account_metas(None);
    metas[0] = AccountMeta::new_readonly(w.config, false);
    let ix = w.ix(metas, instruction::ClaimRent {}.data());
    let err = w.send(ix, &[&bob]).expect_err("position seeds include the signer");
    assert!(err.contains(&framework(ErrorCode::ConstraintSeeds)), "got {err}");
}

// ---------------------------------------------------------------------------
// Pause
// ---------------------------------------------------------------------------
#[test]
fn pause_blocks_buying_and_rent_but_never_claims() {
    let mut w = world(legacy_token());
    let (alice, bob, manager, admin) = (alice(&w), bob(&w), w.manager.insecure_clone(), w.admin.insecure_clone());
    w.buy(&alice, 10).unwrap();
    let mp = w.manager_pay;
    w.deposit_rent(&manager, mp, 100 * USDC).unwrap();

    w.set_paused(true, &admin).unwrap();
    let err = w.buy(&bob, 1).expect_err("paused");
    assert!(err.contains(&custom(RooficError::Paused)), "got {err}");
    let err = w.deposit_rent(&manager, mp, 10 * USDC).expect_err("paused");
    assert!(err.contains(&custom(RooficError::Paused)), "got {err}");

    let before = w.token_balance(&w.pay_account(&alice.pubkey()));
    w.claim(&alice).expect("claims still work while paused");
    assert_eq!(w.token_balance(&w.pay_account(&alice.pubkey())) - before, 99 * USDC);

    w.set_paused(false, &admin).unwrap();
    w.buy(&bob, 1).expect("unpaused");
}

// ---------------------------------------------------------------------------
// Money conservation, both payment programs
// ---------------------------------------------------------------------------
fn conservation_scenario(payment_program: Pubkey) {
    let mut w = world(payment_program);
    let (alice, bob, manager) = (alice(&w), bob(&w), w.manager.insecure_clone());
    let wallets = [w.alice.pubkey(), w.bob.pubkey(), w.manager.pubkey(), w.owner.pubkey(), w.admin.pubkey()];
    let total = |w: &World| -> u64 { wallets.iter().map(|k| w.token_balance(&w.pay_account(k))).sum::<u64>() + w.token_balance(&w.vault) };
    let money_before = total(&w);

    w.buy(&alice, 7).unwrap();
    w.buy(&bob, 13).unwrap();
    let mp = w.manager_pay;
    w.deposit_rent(&manager, mp, 37_500_001).unwrap(); // deliberately awkward amount
    w.deposit_rent(&manager, mp, 12_345_678).unwrap();
    w.buy(&alice, 5).unwrap();
    w.deposit_rent(&manager, mp, 9_999_999).unwrap();
    w.claim(&alice).unwrap();
    w.claim(&bob).unwrap();

    assert_eq!(total(&w), money_before, "no token is created or destroyed anywhere in the cycle");
    let p = w.property_state();
    assert!(p.total_rent_claimed <= p.total_rent_deposited, "never pay out more than was deposited");
    assert_eq!(
        w.token_balance(&w.vault),
        p.total_rent_deposited - p.total_rent_claimed,
        "vault holds exactly deposited minus claimed (rounding dust stays in the vault)"
    );
    assert!(w.token_balance(&w.vault) < 25, "dust is at most a few base units");
}

#[test]
fn money_is_conserved_with_the_spl_token_program() {
    conservation_scenario(legacy_token());
}

#[test]
fn money_is_conserved_with_the_token2022_program() {
    conservation_scenario(token_2022());
}

#[test]
fn wrong_payment_token_program_is_rejected() {
    // payment mint lives under Token-2022, but the caller passes the legacy token program
    let mut w = world(token_2022());
    let alice = alice(&w);
    let mut metas = w.buy_metas(&alice.pubkey());
    let idx = metas.iter().position(|m| m.pubkey == token_2022()).unwrap();
    // metas order: ... share_token_program (11), payment_token_program (12) ...
    let _ = idx;
    let payment_idx = 12;
    assert_eq!(metas[payment_idx].pubkey, token_2022());
    metas[payment_idx] = AccountMeta::new_readonly(legacy_token(), false);
    let ix = w.ix(metas, instruction::BuyShares { shares: 1 }.data());
    let err = w.send(ix, &[&alice]).expect_err("mint/token program mismatch");
    assert!(err.contains("Custom("), "got {err}");
    assert_eq!(w.supply(), 0);
}

// ---------------------------------------------------------------------------
// Security audit regression tests (C1, C2, C4, admin rotation, extensions)
// ---------------------------------------------------------------------------
fn burn_shares(w: &mut World, who: &Keypair, amount: u64) -> Result<(), String> {
    // Token-2022 BurnChecked: tag 15, amount u64, decimals u8
    let ata = share_ata(&who.pubkey(), &w.share_mint);
    let mut data = vec![15];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(0);
    let ix = Instruction {
        program_id: token_2022(),
        accounts: vec![
            AccountMeta::new(ata, false),
            AccountMeta::new(w.share_mint, false),
            AccountMeta::new_readonly(who.pubkey(), true),
        ],
        data,
    };
    w.send(ix, &[who])
}

#[test]
fn burning_share_tokens_cannot_steal_other_holders_rent() {
    let mut w = world(legacy_token());
    let (alice, bob, manager) = (alice(&w), bob(&w), w.manager.insecure_clone());
    w.buy(&alice, 10).unwrap();
    w.buy(&bob, 10).unwrap();

    // Alice burns her Token-2022 receipt tokens; `property.shares_sold` stays 20
    burn_shares(&mut w, &alice, 10).expect("Token-2022 BurnChecked");
    assert_eq!(w.supply(), 10);
    assert_eq!(w.property_state().shares_sold, 20);

    let mp = w.manager_pay;
    w.deposit_rent(&manager, mp, 100 * USDC).expect("deposit");

    let a_before = w.token_balance(&w.pay_account(&alice.pubkey()));
    let b_before = w.token_balance(&w.pay_account(&bob.pubkey()));
    w.claim(&alice).expect("alice claims her 10/20 share");
    w.claim(&bob).expect("bob claims his 10/20 share — vault remains solvent");

    assert_eq!(w.token_balance(&w.pay_account(&alice.pubkey())) - a_before, 49_500_000);
    assert_eq!(w.token_balance(&w.pay_account(&bob.pubkey())) - b_before, 49_500_000);
    assert_eq!(w.token_balance(&w.vault), 0);
}

#[test]
fn burning_share_tokens_cannot_oversell_beyond_total_shares() {
    let mut w = world(legacy_token());
    let (alice, bob) = (alice(&w), bob(&w));
    w.buy(&alice, 500).unwrap();
    burn_shares(&mut w, &alice, 500).unwrap();
    w.buy(&bob, 500).unwrap();

    let err = w.buy(&alice, 1).expect_err("all 1000 shares have already been sold");
    assert!(err.contains(&custom(RooficError::NotEnoughShares)), "got {err}");
    assert_eq!(w.property_state().shares_sold, TOTAL_SHARES);
}

#[test]
fn initialize_platform_rejects_non_upgrade_authority() {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(roofic::id(), "../../target/deploy/roofic.so").unwrap();

    let deployer = Keypair::new();
    let attacker = Keypair::new();
    svm.airdrop(&deployer.pubkey(), 10 * SOL).unwrap();
    svm.airdrop(&attacker.pubkey(), 10 * SOL).unwrap();
    set_upgrade_authority(&mut svm, &deployer.pubkey());

    let payment_mint = Pubkey::new_unique();
    svm.set_account(
        payment_mint,
        Account { lamports: 10_000_000, data: mint_bytes(6), owner: legacy_token(), executable: false, rent_epoch: 0 },
    )
    .unwrap();
    let treasury = Pubkey::new_unique();
    svm.set_account(
        treasury,
        Account {
            lamports: 10_000_000,
            data: token_account_bytes(&payment_mint, &attacker.pubkey(), 0),
            owner: legacy_token(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let ix = Instruction {
        program_id: roofic::id(),
        accounts: accounts::InitializePlatform {
            config: pda(&[b"config"]),
            payment_mint,
            treasury,
            admin: attacker.pubkey(),
            program: roofic::id(),
            program_data: program_data_pda(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::InitializePlatform { rent_fee_bps: 100, sale_fee_bps: 150 }.data(),
    };
    let tx = Transaction::new(&[&attacker], Message::new(&[ix], Some(&attacker.pubkey())), svm.latest_blockhash());
    let err = format!("{:?}", svm.send_transaction(tx).unwrap_err().err);
    assert!(err.contains(&custom(RooficError::NotAdmin)), "got {err}");
}

#[test]
fn unapproved_issuer_cannot_create_property() {
    let mut w = world(legacy_token());
    let outsider = w.outsider.insecure_clone();
    let prop = pda(&[b"property", outsider.pubkey().as_ref(), &99u64.to_le_bytes()]);
    let ix = w.ix(
        accounts::CreateProperty {
            config: w.config,
            owner_kyc: pda(&[b"investor", outsider.pubkey().as_ref()]),
            property: prop,
            share_mint: pda(&[b"share_mint", prop.as_ref()]),
            vault: pda(&[b"vault", prop.as_ref()]),
            payment_mint: w.payment_mint,
            owner: outsider.pubkey(),
            share_token_program: token_2022(),
            payment_token_program: w.payment_program,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        instruction::CreateProperty {
            id: 99,
            name: "Unapproved Scam Tower".into(),
            total_shares: 100,
            price_per_share: PRICE,
            manager: outsider.pubkey(),
            valuation_hash: [1u8; 32],
        }
        .data(),
    );
    let err = w.send(ix, &[&outsider]).expect_err("unapproved issuer must be blocked");
    assert!(err.contains(&framework(ErrorCode::AccountNotInitialized)), "got {err}");
}

#[test]
fn revoked_investor_can_still_claim_accrued_rent() {
    let mut w = world(legacy_token());
    let (alice, admin, manager) = (alice(&w), w.admin.insecure_clone(), w.manager.insecure_clone());
    w.buy(&alice, 10).unwrap();

    let mp = w.manager_pay;
    w.deposit_rent(&manager, mp, 100 * USDC).unwrap();

    // Admin revokes Alice's KYC: she can no longer buy, but her accrued rent is never frozen
    w.revoke(&alice.pubkey(), &admin).unwrap();
    assert!(w.buy(&alice, 1).is_err());

    let before = w.token_balance(&w.pay_account(&alice.pubkey()));
    w.claim(&alice).expect("revoked investor can still withdraw her rent");
    assert_eq!(w.token_balance(&w.pay_account(&alice.pubkey())) - before, 99 * USDC);
}

#[test]
fn admin_can_rotate_authority_and_treasury() {
    let mut w = world(legacy_token());
    let (admin, alice) = (w.admin.insecure_clone(), alice(&w));
    let new_treasury = w.pay_account(&alice.pubkey());

    let ix = w.ix(
        accounts::SetAdmin {
            config: w.config,
            treasury: new_treasury,
            admin: admin.pubkey(),
        }
        .to_account_metas(None),
        instruction::SetAdmin { new_admin: alice.pubkey() }.data(),
    );
    w.send(ix, &[&admin]).expect("admin rotates to alice");

    // Old admin is now rejected; new admin (alice) can pause
    assert!(w.set_paused(true, &admin).is_err());
    w.set_paused(true, &alice).expect("new admin pauses");
}

#[test]
fn fee_bearing_payment_mint_is_rejected_at_init() {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(roofic::id(), "../../target/deploy/roofic.so").unwrap();

    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10 * SOL).unwrap();
    set_upgrade_authority(&mut svm, &admin.pubkey());

    // Construct a Token-2022 mint carrying a TransferFeeConfig TLV extension
    // (82 base + 83 padding + 1 AccountType::Mint + 2 type + 2 len + 108 payload = 278 bytes)
    let mut mint_data = vec![0u8; 278];
    mint_data[44] = 6; // decimals
    mint_data[45] = 1; // is_initialized
    mint_data[165] = 1; // AccountType::Mint
    mint_data[166..168].copy_from_slice(&(ExtensionType::TransferFeeConfig as u16).to_le_bytes());
    mint_data[168..170].copy_from_slice(&108u16.to_le_bytes());

    let fee_mint = Pubkey::new_unique();
    svm.set_account(
        fee_mint,
        Account { lamports: 10_000_000, data: mint_data, owner: token_2022(), executable: false, rent_epoch: 0 },
    )
    .unwrap();
    let treasury = Pubkey::new_unique();
    svm.set_account(
        treasury,
        Account {
            lamports: 10_000_000,
            data: token_account_bytes(&fee_mint, &admin.pubkey(), 0),
            owner: token_2022(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let ix = Instruction {
        program_id: roofic::id(),
        accounts: accounts::InitializePlatform {
            config: pda(&[b"config"]),
            payment_mint: fee_mint,
            treasury,
            admin: admin.pubkey(),
            program: roofic::id(),
            program_data: program_data_pda(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::InitializePlatform { rent_fee_bps: 100, sale_fee_bps: 150 }.data(),
    };
    let tx = Transaction::new(&[&admin], Message::new(&[ix], Some(&admin.pubkey())), svm.latest_blockhash());
    let err = format!("{:?}", svm.send_transaction(tx).unwrap_err().err);
    assert!(err.contains(&custom(RooficError::UnsupportedPaymentMint)), "got {err}");
}



