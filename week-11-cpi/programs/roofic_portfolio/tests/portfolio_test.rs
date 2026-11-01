// ============================================================================
// LiteSVM tests for roofic_portfolio (program → program CPI)
// Run `anchor build` first — loads both roofic_shares.so and roofic_portfolio.so
// ============================================================================

use anchor_lang::{
    prelude::Pubkey, solana_program::instruction::{AccountMeta, Instruction}, system_program,
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use litesvm::LiteSVM;
use roofic_portfolio::{accounts, instruction, Portfolio};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::str::FromStr;

const SOL: u64 = 1_000_000_000;
const PRICE: u64 = SOL / 10;
const TOTAL: u64 = 20;

fn token_2022() -> Pubkey {
    Pubkey::from_str("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb").unwrap()
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
    listing: Pubkey,
    mint: Pubkey,
}

fn send(svm: &mut LiteSVM, ix: Instruction, signer: &Keypair) -> Result<(), String> {
    let tx = Transaction::new(
        &[signer],
        Message::new(&[ix], Some(&signer.pubkey())),
        svm.latest_blockhash(),
    );
    let res = svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err));
    svm.expire_blockhash();
    res
}

fn setup() -> Ctx {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(roofic_shares::id(), "../../target/deploy/roofic_shares.so").unwrap();
    svm.add_program_from_file(roofic_portfolio::id(), "../../target/deploy/roofic_portfolio.so").unwrap();
    let owner = Keypair::new();
    svm.airdrop(&owner.pubkey(), 100 * SOL).unwrap();

    let listing =
        Pubkey::find_program_address(&[b"listing", owner.pubkey().as_ref(), &1u64.to_le_bytes()], &roofic_shares::id()).0;
    let mint = Pubkey::find_program_address(&[b"share_mint", listing.as_ref()], &roofic_shares::id()).0;
    let ix = Instruction {
        program_id: roofic_shares::id(),
        accounts: roofic_shares::accounts::CreateListing {
            listing,
            mint,
            authority: owner.pubkey(),
            token_program: token_2022(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: roofic_shares::instruction::CreateListing {
            id: 1,
            name: "Almaty Loft #1".into(),
            total_shares: TOTAL,
            price_per_share: PRICE,
        }
        .data(),
    };
    send(&mut svm, ix, &owner).expect("create_listing");
    Ctx { svm, owner, listing, mint }
}

impl Ctx {
    fn user(&mut self) -> Keypair {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 100 * SOL).unwrap();
        kp
    }

    fn portfolio_pda(investor: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[b"portfolio", investor.as_ref()], &roofic_portfolio::id()).0
    }

    fn buy_ix(&self, investor: &Pubkey, shares: u64) -> Instruction {
        Instruction {
            program_id: roofic_portfolio::id(),
            accounts: accounts::BuyAndTrack {
                portfolio: Self::portfolio_pda(investor),
                listing: self.listing,
                authority: self.owner.pubkey(),
                investor: *investor,
                mint: self.mint,
                investor_ata: ata(investor, &self.mint),
                token_program: token_2022(),
                associated_token_program: ata_program(),
                system_program: system_program::ID,
                shares_program: roofic_shares::id(),
            }
            .to_account_metas(None),
            data: instruction::BuyAndTrack { shares }.data(),
        }
    }

    fn portfolio(&self, investor: &Pubkey) -> Option<Portfolio> {
        let acc = self.svm.get_account(&Self::portfolio_pda(investor))?;
        Portfolio::try_deserialize(&mut acc.data.as_slice()).ok()
    }

    fn token_balance(&self, investor: &Pubkey) -> u64 {
        match self.svm.get_account(&ata(investor, &self.mint)) {
            Some(a) => u64::from_le_bytes(a.data[64..72].try_into().unwrap()),
            None => 0,
        }
    }

    fn supply(&self) -> u64 {
        u64::from_le_bytes(self.svm.get_account(&self.mint).unwrap().data[36..44].try_into().unwrap())
    }
}

#[test]
fn buy_and_track_mints_shares_through_nested_cpi_and_records_purchase() {
    let mut ctx = setup();
    let investor = ctx.user();
    let owner_before = ctx.svm.get_balance(&ctx.owner.pubkey()).unwrap();

    let ix = ctx.buy_ix(&investor.pubkey(), 5);
    send(&mut ctx.svm, ix, &investor).expect("buy_and_track");

    assert_eq!(ctx.token_balance(&investor.pubkey()), 5, "tokens minted by roofic_shares");
    assert_eq!(ctx.supply(), 5);
    assert_eq!(ctx.svm.get_balance(&ctx.owner.pubkey()).unwrap() - owner_before, 5 * PRICE);

    let p = ctx.portfolio(&investor.pubkey()).expect("portfolio created");
    assert_eq!(p.owner, investor.pubkey());
    assert_eq!((p.purchases, p.total_shares, p.total_spent), (1, 5, 5 * PRICE));
}

#[test]
fn purchases_accumulate_in_portfolio() {
    let mut ctx = setup();
    let investor = ctx.user();
    for shares in [2, 3] {
        let ix = ctx.buy_ix(&investor.pubkey(), shares);
        send(&mut ctx.svm, ix, &investor).expect("buy_and_track");
    }
    let p = ctx.portfolio(&investor.pubkey()).unwrap();
    assert_eq!((p.purchases, p.total_shares, p.total_spent), (2, 5, 5 * PRICE));
    assert_eq!(ctx.token_balance(&investor.pubkey()), 5);
}

#[test]
fn failed_inner_cpi_reverts_everything_including_portfolio() {
    let mut ctx = setup();
    let investor = ctx.user();
    let lamports_before = ctx.svm.get_balance(&investor.pubkey()).unwrap();

    // 21 > 20 shares: roofic_shares rejects, so the outer instruction must revert atomically
    let ix = ctx.buy_ix(&investor.pubkey(), TOTAL + 1);
    assert!(send(&mut ctx.svm, ix, &investor).is_err());

    assert!(ctx.portfolio(&investor.pubkey()).is_none(), "no phantom portfolio");
    assert_eq!(ctx.token_balance(&investor.pubkey()), 0);
    assert_eq!(ctx.supply(), 0);
    // only the base fee may be charged for a failed transaction
    assert!(lamports_before - ctx.svm.get_balance(&investor.pubkey()).unwrap() <= 10_000);
}

#[test]
fn arbitrary_cpi_target_is_rejected() {
    let mut ctx = setup();
    let investor = ctx.user();

    let mut ix = ctx.buy_ix(&investor.pubkey(), 1);
    // last account is `shares_program`: swap in the System program as a "fake" shares program
    let last = ix.accounts.len() - 1;
    ix.accounts[last] = AccountMeta::new_readonly(system_program::ID, false);
    assert!(
        send(&mut ctx.svm, ix, &investor).is_err(),
        "Program<RooficShares> must reject any other program id"
    );
    assert_eq!(ctx.supply(), 0);
}

