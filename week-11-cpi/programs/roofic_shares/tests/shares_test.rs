// ============================================================================
// LiteSVM tests for roofic_shares (CPI: System + Token-2022 + Associated Token)
// Run `anchor build` first — tests load target/deploy/roofic_shares.so
// ============================================================================

use anchor_lang::{
    prelude::Pubkey, solana_program::instruction::{AccountMeta, Instruction}, system_program,
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use litesvm::LiteSVM;
use roofic_shares::{accounts, instruction, Listing};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::str::FromStr;

const SOL: u64 = 1_000_000_000;
const PRICE: u64 = SOL / 10; // 0.1 SOL per share
const TOTAL: u64 = 100;

fn token_2022() -> Pubkey {
    Pubkey::from_str("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb").unwrap()
}
fn legacy_token() -> Pubkey {
    Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap()
}
fn ata_program() -> Pubkey {
    Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap()
}

fn ata(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[wallet.as_ref(), token_2022().as_ref(), mint.as_ref()],
        &ata_program(),
    )
    .0
}

struct Ctx {
    svm: LiteSVM,
    owner: Keypair,
}

fn setup() -> Ctx {
    let mut svm = LiteSVM::new(); // ships with System, Token, Token-2022 and ATA programs
    svm.add_program_from_file(roofic_shares::id(), "../../target/deploy/roofic_shares.so")
        .unwrap();
    let owner = Keypair::new();
    svm.airdrop(&owner.pubkey(), 100 * SOL).unwrap();
    Ctx { svm, owner }
}

impl Ctx {
    fn user(&mut self) -> Keypair {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 100 * SOL).unwrap();
        kp
    }

    fn send(&mut self, ix: Instruction, signer: &Keypair) -> Result<(), String> {
        let tx = Transaction::new(
            &[signer],
            Message::new(&[ix], Some(&signer.pubkey())),
            self.svm.latest_blockhash(),
        );
        let res = self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err));
        self.svm.expire_blockhash();
        res
    }

    fn listing_pda(&self, id: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[b"listing", self.owner.pubkey().as_ref(), &id.to_le_bytes()],
            &roofic_shares::id(),
        )
        .0
    }

    fn mint_pda(listing: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[b"share_mint", listing.as_ref()], &roofic_shares::id()).0
    }

    fn create_listing(&mut self, id: u64) -> (Pubkey, Pubkey) {
        let listing = self.listing_pda(id);
        let mint = Self::mint_pda(&listing);
        let ix = Instruction {
            program_id: roofic_shares::id(),
            accounts: accounts::CreateListing {
                listing,
                mint,
                authority: self.owner.pubkey(),
                token_program: token_2022(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::CreateListing {
                id,
                name: "Almaty Loft #1".into(),
                total_shares: TOTAL,
                price_per_share: PRICE,
            }
            .data(),
        };
        let owner = self.owner.insecure_clone();
        self.send(ix, &owner).expect("create_listing");
        (listing, mint)
    }

    fn buy_ix(&self, listing: Pubkey, mint: Pubkey, investor: &Pubkey, shares: u64) -> Instruction {
        Instruction {
            program_id: roofic_shares::id(),
            accounts: accounts::BuyShares {
                listing,
                authority: self.owner.pubkey(),
                investor: *investor,
                mint,
                investor_ata: ata(investor, &mint),
                token_program: token_2022(),
                associated_token_program: ata_program(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::BuyShares { shares }.data(),
        }
    }

    /// SPL token account layout: amount is a u64 at bytes 64..72 (same for Token-2022)
    fn token_balance(&self, token_account: &Pubkey) -> u64 {
        match self.svm.get_account(token_account) {
            Some(a) => u64::from_le_bytes(a.data[64..72].try_into().unwrap()),
            None => 0,
        }
    }

    /// Mint layout: supply is a u64 at bytes 36..44
    fn supply(&self, mint: &Pubkey) -> u64 {
        u64::from_le_bytes(self.svm.get_account(mint).unwrap().data[36..44].try_into().unwrap())
    }
}

#[test]
fn create_listing_makes_token2022_mint_owned_by_listing_pda() {
    let mut ctx = setup();
    let (listing, mint) = ctx.create_listing(1);

    let mint_acc = ctx.svm.get_account(&mint).unwrap();
    assert_eq!(mint_acc.owner, token_2022(), "mint must be a Token-2022 account");
    // COption<Pubkey> mint_authority: tag (4 bytes) + pubkey, then supply, decimals
    assert_eq!(u32::from_le_bytes(mint_acc.data[0..4].try_into().unwrap()), 1, "authority set");
    assert_eq!(&mint_acc.data[4..36], listing.as_ref(), "authority is the listing PDA");
    assert_eq!(mint_acc.data[44], 0, "0 decimals: 1 token = 1 share");
    assert_eq!(ctx.supply(&mint), 0);

    let data = ctx.svm.get_account(&listing).unwrap().data;
    let l = Listing::try_deserialize(&mut data.as_slice()).unwrap();
    assert_eq!(l.mint, mint);
    assert_eq!(l.total_shares, TOTAL);
}

#[test]
fn buy_shares_pays_owner_and_mints_tokens() {
    let mut ctx = setup();
    let (listing, mint) = ctx.create_listing(1);
    let investor = ctx.user();

    let owner_before = ctx.svm.get_balance(&ctx.owner.pubkey()).unwrap();
    let ix = ctx.buy_ix(listing, mint, &investor.pubkey(), 7);
    ctx.send(ix, &investor).expect("buy_shares");

    assert_eq!(ctx.token_balance(&ata(&investor.pubkey(), &mint)), 7);
    assert_eq!(ctx.supply(&mint), 7);
    let owner_after = ctx.svm.get_balance(&ctx.owner.pubkey()).unwrap();
    assert_eq!(owner_after - owner_before, 7 * PRICE, "owner receives exactly cost");
}

#[test]
fn second_purchase_accumulates_in_same_token_account() {
    let mut ctx = setup();
    let (listing, mint) = ctx.create_listing(1);
    let investor = ctx.user();

    for shares in [3, 4] {
        let ix = ctx.buy_ix(listing, mint, &investor.pubkey(), shares);
        ctx.send(ix, &investor).expect("buy_shares");
    }
    assert_eq!(ctx.token_balance(&ata(&investor.pubkey(), &mint)), 7);
    assert_eq!(ctx.supply(&mint), 7);
}

#[test]
fn cannot_buy_more_than_total_shares_across_buyers() {
    let mut ctx = setup();
    let (listing, mint) = ctx.create_listing(1);
    let (a, b) = (ctx.user(), ctx.user());

    let ix = ctx.buy_ix(listing, mint, &a.pubkey(), 90);
    ctx.send(ix, &a).expect("first buyer");

    let ix = ctx.buy_ix(listing, mint, &b.pubkey(), 11);
    assert!(ctx.send(ix, &b).is_err(), "only 10 shares remain");
    assert_eq!(ctx.supply(&mint), 90, "failed purchase must not mint");
    assert_eq!(ctx.token_balance(&ata(&b.pubkey(), &mint)), 0);

    let ix = ctx.buy_ix(listing, mint, &b.pubkey(), 10);
    ctx.send(ix, &b).expect("buying exactly the remainder works");
    assert_eq!(ctx.supply(&mint), TOTAL);
}

#[test]
fn payment_cannot_be_redirected_to_another_wallet() {
    let mut ctx = setup();
    let (listing, mint) = ctx.create_listing(1);
    let investor = ctx.user();
    let thief = Keypair::new();

    let mut ix = ctx.buy_ix(listing, mint, &investor.pubkey(), 1);
    // account #1 is `authority` (the payee)
    ix.accounts[1] = AccountMeta::new(thief.pubkey(), false);
    assert!(ctx.send(ix, &investor).is_err());
    assert_eq!(ctx.svm.get_balance(&thief.pubkey()).unwrap_or(0), 0);
    assert_eq!(ctx.supply(&mint), 0);
}

#[test]
fn legacy_token_program_is_rejected() {
    let mut ctx = setup();
    let (listing, mint) = ctx.create_listing(1);
    let investor = ctx.user();

    let mut ix = ctx.buy_ix(listing, mint, &investor.pubkey(), 1);
    // account #5 is `token_program`
    ix.accounts[5] = AccountMeta::new_readonly(legacy_token(), false);
    assert!(ctx.send(ix, &investor).is_err(), "shares must go through Token-2022 only");
    assert_eq!(ctx.supply(&mint), 0);
}

#[test]
fn shares_are_transferable_like_any_token() {
    let mut ctx = setup();
    let (listing, mint) = ctx.create_listing(1);
    let (alice, bob) = (ctx.user(), ctx.user());

    let ix = ctx.buy_ix(listing, mint, &alice.pubkey(), 10);
    ctx.send(ix, &alice).expect("buy");

    // Bob's token account: ATA program CreateIdempotent (instruction byte 1), paid by Alice
    let (alice_ata, bob_ata) = (ata(&alice.pubkey(), &mint), ata(&bob.pubkey(), &mint));
    let create = Instruction {
        program_id: ata_program(),
        accounts: vec![
            AccountMeta::new(alice.pubkey(), true),
            AccountMeta::new(bob_ata, false),
            AccountMeta::new_readonly(bob.pubkey(), false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(token_2022(), false),
        ],
        data: vec![1],
    };
    // Token-2022 TransferChecked: tag 12, amount u64, decimals u8
    let mut data = vec![12];
    data.extend_from_slice(&4u64.to_le_bytes());
    data.push(0);
    let transfer = Instruction {
        program_id: token_2022(),
        accounts: vec![
            AccountMeta::new(alice_ata, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(bob_ata, false),
            AccountMeta::new_readonly(alice.pubkey(), true),
        ],
        data,
    };
    let tx = Transaction::new(
        &[&alice],
        Message::new(&[create, transfer], Some(&alice.pubkey())),
        ctx.svm.latest_blockhash(),
    );
    ctx.svm.send_transaction(tx).expect("transfer");

    assert_eq!(ctx.token_balance(&alice_ata), 6);
    assert_eq!(ctx.token_balance(&bob_ata), 4);
    assert_eq!(ctx.supply(&mint), 10, "transfers never change supply");
}

