// ============================================================================
// LiteSVM-тесты Roofic MVP
// Сначала: anchor build (тесты загружают target/deploy/roofic_mvp.so)
// ============================================================================

use anchor_lang::{
    prelude::Pubkey, solana_program::instruction::Instruction, system_program, AccountDeserialize,
    InstructionData, ToAccountMetas,
};
use litesvm::LiteSVM;
use roofic_mvp::{accounts, instruction, Position, Property};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const SOL: u64 = 1_000_000_000;
const PRICE: u64 = SOL / 10; // 0.1 SOL за долю

struct Ctx {
    svm: LiteSVM,
    owner: Keypair,
}

fn setup() -> Ctx {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(roofic_mvp::id(), "../../target/deploy/roofic_mvp.so")
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

    fn property_pda(&self, id: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[b"property", self.owner.pubkey().as_ref(), &id.to_le_bytes()],
            &roofic_mvp::id(),
        )
        .0
    }

    fn position_pda(property: &Pubkey, investor: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(
            &[b"position", property.as_ref(), investor.as_ref()],
            &roofic_mvp::id(),
        )
        .0
    }

    fn create_property(&mut self, id: u64, total_shares: u64) -> Pubkey {
        let property = self.property_pda(id);
        let ix = Instruction {
            program_id: roofic_mvp::id(),
            accounts: accounts::CreateProperty {
                property,
                authority: self.owner.pubkey(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::CreateProperty {
                id,
                name: "Almaty Loft #1".into(),
                location: "Almaty, Kazakhstan".into(),
                total_shares,
                price_per_share: PRICE,
            }
            .data(),
        };
        let owner = self.owner.insecure_clone();
        self.send(ix, &owner).unwrap();
        property
    }

    fn buy_ix(&self, property: Pubkey, investor: &Pubkey, authority: Pubkey, shares: u64) -> Instruction {
        Instruction {
            program_id: roofic_mvp::id(),
            accounts: accounts::BuyShares {
                property,
                position: Self::position_pda(&property, investor),
                investor: *investor,
                authority,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::BuyShares { shares }.data(),
        }
    }

    fn buy(&mut self, property: Pubkey, investor: &Keypair, shares: u64) -> Result<(), String> {
        let ix = self.buy_ix(property, &investor.pubkey(), self.owner.pubkey(), shares);
        self.send(ix, investor)
    }

    fn deposit(&mut self, property: Pubkey, signer: &Keypair, amount: u64) -> Result<(), String> {
        let ix = Instruction {
            program_id: roofic_mvp::id(),
            accounts: accounts::DepositRent {
                property,
                authority: signer.pubkey(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::DepositRent { amount }.data(),
        };
        self.send(ix, signer)
    }

    fn claim_ix(property: Pubkey, position: Pubkey, investor: Pubkey) -> Instruction {
        Instruction {
            program_id: roofic_mvp::id(),
            accounts: accounts::ClaimRent { property, position, investor }.to_account_metas(None),
            data: instruction::ClaimRent {}.data(),
        }
    }

    /// Возвращает, сколько lamports получил инвестор (с учётом комиссии сети)
    fn claim(&mut self, property: Pubkey, investor: &Keypair) -> Result<u64, String> {
        let before = self.balance(&investor.pubkey());
        let ix = Self::claim_ix(property, Self::position_pda(&property, &investor.pubkey()), investor.pubkey());
        self.send(ix, investor)?;
        Ok(self.balance(&investor.pubkey()) + 5_000 - before) // 5000 = fee за 1 подпись
    }

    fn balance(&self, key: &Pubkey) -> u64 {
        self.svm.get_balance(key).unwrap_or(0)
    }

    fn fetch<T: AccountDeserialize>(&self, key: &Pubkey) -> T {
        let acc = self.svm.get_account(key).expect("account exists");
        T::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }
}

// ---------------------------------------------------------------------------

#[test]
fn create_and_buy_pays_owner_and_records_position() {
    let mut c = setup();
    let property = c.create_property(1, 100);
    let alice = c.user();

    let owner_before = c.balance(&c.owner.pubkey());
    c.buy(property, &alice, 25).unwrap();

    assert_eq!(c.balance(&c.owner.pubkey()) - owner_before, 25 * PRICE, "оплата ушла владельцу");
    let p: Property = c.fetch(&property);
    assert_eq!(p.shares_sold, 25);
    let pos: Position = c.fetch(&Ctx::position_pda(&property, &alice.pubkey()));
    assert_eq!(pos.shares, 25);
    assert_eq!(pos.owner, alice.pubkey());

    // Повторная покупка — та же позиция (init_if_needed)
    c.buy(property, &alice, 5).unwrap();
    let pos: Position = c.fetch(&Ctx::position_pda(&property, &alice.pubkey()));
    assert_eq!(pos.shares, 30);
}

#[test]
fn cannot_buy_more_than_available() {
    let mut c = setup();
    let property = c.create_property(1, 10);
    let alice = c.user();
    assert!(c.buy(property, &alice, 11).is_err());
    c.buy(property, &alice, 10).unwrap();
    assert!(c.buy(property, &alice, 1).is_err(), "sold out");
}

#[test]
fn rent_is_split_pro_rata() {
    let mut c = setup();
    let property = c.create_property(7, 100);
    let (alice, bob) = (c.user(), c.user());
    c.buy(property, &alice, 30).unwrap();
    c.buy(property, &bob, 10).unwrap();

    let owner = c.owner.insecure_clone();
    c.deposit(property, &owner, 4 * SOL).unwrap();

    assert_eq!(c.claim(property, &alice).unwrap(), 3 * SOL);
    assert_eq!(c.claim(property, &bob).unwrap(), SOL);
    assert!(c.claim(property, &alice).is_err(), "повторный claim без нового дохода");
}

#[test]
fn late_buyer_does_not_receive_earlier_rent() {
    let mut c = setup();
    let property = c.create_property(1, 100);
    let (alice, bob) = (c.user(), c.user());
    let owner = c.owner.insecure_clone();

    c.buy(property, &alice, 10).unwrap();
    c.deposit(property, &owner, SOL).unwrap(); // целиком Alice
    c.buy(property, &bob, 10).unwrap();
    c.deposit(property, &owner, SOL).unwrap(); // 50/50

    assert_eq!(c.claim(property, &alice).unwrap(), SOL + SOL / 2);
    assert_eq!(c.claim(property, &bob).unwrap(), SOL / 2);
}

#[test]
fn accrued_rent_survives_additional_purchase() {
    let mut c = setup();
    let property = c.create_property(1, 100);
    let alice = c.user();
    let owner = c.owner.insecure_clone();

    c.buy(property, &alice, 10).unwrap();
    c.deposit(property, &owner, SOL).unwrap();
    c.buy(property, &alice, 10).unwrap(); // доход за первые 10 долей должен сохраниться
    let pos: Position = c.fetch(&Ctx::position_pda(&property, &alice.pubkey()));
    assert_eq!(pos.unclaimed, SOL);
    assert_eq!(c.claim(property, &alice).unwrap(), SOL);
}

#[test]
fn only_owner_can_deposit_rent() {
    let mut c = setup();
    let property = c.create_property(1, 100);
    let mallory = c.user();
    c.buy(property, &mallory, 1).unwrap();
    // PDA выводится из authority — чужой signer не проходит seeds/has_one
    assert!(c.deposit(property, &mallory, SOL).is_err());
}

#[test]
fn deposit_requires_shareholders() {
    let mut c = setup();
    let property = c.create_property(1, 100);
    let owner = c.owner.insecure_clone();
    assert!(c.deposit(property, &owner, SOL).is_err());
}

#[test]
fn cannot_claim_someone_elses_position() {
    let mut c = setup();
    let property = c.create_property(1, 100);
    let (alice, mallory) = (c.user(), c.user());
    let owner = c.owner.insecure_clone();
    c.buy(property, &alice, 10).unwrap();
    c.deposit(property, &owner, SOL).unwrap();

    let alice_position = Ctx::position_pda(&property, &alice.pubkey());
    let ix = Ctx::claim_ix(property, alice_position, mallory.pubkey());
    assert!(c.send(ix, &mallory).is_err());
    assert_eq!(c.claim(property, &alice).unwrap(), SOL, "доход Alice не тронут");
}

#[test]
fn payment_cannot_be_redirected() {
    let mut c = setup();
    let property = c.create_property(1, 100);
    let (alice, mallory) = (c.user(), c.user());
    // Подменяем получателя оплаты на свой адрес — has_one = authority должен отклонить
    let ix = c.buy_ix(property, &alice.pubkey(), mallory.pubkey(), 5);
    assert!(c.send(ix, &alice).is_err());
}
