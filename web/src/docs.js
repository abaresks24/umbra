// The /docs page: a long-form explanation of Umbra. What problem it solves, how
// the privacy actually works, the on-chain design, and how to install the Chrome
// extension. Rendered inside the SPA so it inherits the visual identity.
// Layout: a sticky left-hand contents menu next to a wide reading column.
const REL = "https://github.com/abaresks24/umbra/releases/latest/download/umbra-extension.zip";
const REPO = "https://github.com/abaresks24/umbra";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// One source of truth for the sections, so the side menu and the article stay
// in sync (and the scroll-spy can light the active entry).
export const DOC_SECTIONS = [
  { id: "what", nav: "The problem" },
  { id: "model", nav: "How privacy works" },
  { id: "zk", nav: "The zero-knowledge proof" },
  { id: "audit", nav: "Enforced auditability" },
  { id: "chain", nav: "On Stellar / Soroban" },
  { id: "flow", nav: "A payment, end to end" },
  { id: "use", nav: "Using the wallet" },
  { id: "invisible", nav: "Why payments stay private" },
  { id: "multi", nav: "Multiple assets" },
  { id: "threat", nav: "What's hidden, what's not" },
  { id: "stack", nav: "Tech stack" },
  { id: "faq", nav: "FAQ" },
  { id: "install", nav: "Install the extension" },
];

export function docsView(cfg) {
  const pool = cfg?.poolId ? esc(cfg.poolId) : "loading…";
  const assets = (cfg?.assets || []).map((a) => esc(a.symbol)).join(" · ") || "USDC · EURC";
  const menu = DOC_SECTIONS.map((s) => `<a href="#${s.id}" data-doc="${s.id}">${esc(s.nav)}</a>`).join("");

  return `<div class="screen doc">
  <header class="bar doc-bar">
    <div class="brand"><img class="brand-logo" src="/logo.png" alt="" aria-hidden="true"/>Umbra</div>
    <button class="icon-btn doc-back" id="doc-back" title="Back to wallet" aria-label="Back">←</button>
  </header>

  <div class="doc-layout">
    <aside class="doc-nav" aria-label="Table of contents">
      <p class="doc-nav-h">Contents</p>
      <nav class="doc-nav-list">${menu}</nav>
      <a class="doc-nav-dl" href="${REL}">↧ Get the extension</a>
    </aside>

    <article class="doc-body">
      <p class="doc-kicker">Documentation</p>
      <h1 class="doc-title">Privacy is a right, not a feature.</h1>
      <p class="doc-lede">Umbra is a privacy wallet for the Stellar network. Your balances, the amounts you
        move and who you pay all stay hidden on the public ledger. Yet every payment still carries a
        cryptographic proof that it is valid, plus a sealed disclosure that one designated auditor, and nobody
        else, can open. Privacy without impunity.</p>

      <section id="what">
        <h2>The problem</h2>
        <p>A public blockchain is a permanent, searchable ledger. The moment you send someone a stablecoin,
          you have also told the whole world your balance, your salary, your suppliers and your donations. For
          a person that is surveillance. For a business it quietly leaks margins, payroll and counterparties to
          anyone willing to read the explorer.</p>
        <p>The usual fix is a fully anonymous mixer, but that just swaps one problem for another. When nobody
          can ever see inside, the pool fills up with laundered and stolen money, and it gets sanctioned and
          de-listed. Neither extreme is workable. Umbra takes the middle path that users and regulators can
          both live with:</p>
        <p class="doc-pull">Confidential to the public. Accountable to an auditor.</p>
      </section>

      <section id="model">
        <h2>How privacy works: the shielded UTXO model</h2>
        <p>Umbra does not keep public account balances. It holds value in <em>notes</em>, a shielded UTXO
          model in the Tornado Nova family. A note is a little secret bundle:</p>
        <pre class="doc-code">note = { amount, assetId, owner_pubkey, blinding }</pre>
        <p>All the chain ever stores is a <em>commitment</em>, which is a Poseidon hash of that bundle,
          appended as a leaf to an on-chain Merkle tree:</p>
        <pre class="doc-code">commitment = Poseidon(amount, assetId, owner_pubkey, blinding)</pre>
        <p>The commitment gives nothing away. The <code>blinding</code> is fresh randomness, so two notes for
          the same amount look completely unrelated. To spend a note you publish its <em>nullifier</em>, a
          deterministic tag derived from the note and your spend key. The contract records spent nullifiers so
          a note can never be spent twice. And because the nullifier cannot be linked back to the commitment,
          no observer can tell <em>which</em> note was just consumed.</p>
        <ul>
          <li><strong>Commitments</strong> prove a note exists, without revealing what is inside it.</li>
          <li><strong>Nullifiers</strong> stop double spends, without revealing which note was spent.</li>
          <li><strong>View keys</strong> let a recipient find their own incoming notes by scanning the chain.
            Each output carries a memo encrypted to the recipient's view key, and only they can read it.</li>
        </ul>
      </section>

      <section id="zk">
        <h2>The zero-knowledge proof</h2>
        <p>Every transaction carries a <strong>Groth16 zk-SNARK</strong>, generated by a circuit written in
          Circom 2 over the BN254 curve. Without revealing a single secret, the proof convinces the contract
          that all of this is true at once:</p>
        <ul>
          <li>every input note really exists in the Merkle tree (a valid membership proof against a recent
            root);</li>
          <li>the spender actually owns those inputs (they know the spend key behind each
            <code>owner_pubkey</code>);</li>
          <li>inputs and outputs <strong>balance exactly</strong>, per asset. Nothing is minted or burned
            except an explicit, signed deposit or withdraw amount;</li>
          <li>the published nullifiers and output commitments are computed correctly from the secret notes.</li>
        </ul>
        <p>The hash inside the circuit is <strong>Poseidon</strong> (from circomlib). We chose it because it
          is cheap to prove in a SNARK and also exists as a native Soroban host function, so the exact same
          hash is computed identically off the chain and on it.</p>
        <p>The important part: <strong>proving runs on your own device</strong>. snarkjs executes the circuit
          WASM and proving key bundled into the app (and the extension). Your witness, meaning your amounts,
          keys and blindings, never leaves your machine. All that gets submitted to the network is the
          200-byte proof and the encrypted outputs.</p>
      </section>

      <section id="audit">
        <h2>Enforced auditability, the part that makes it deployable</h2>
        <p>An anonymous mixer is unlawful in most places for a simple reason: it has no lawful way back in.
          Umbra's distinctive feature is that <strong>disclosure to a designated auditor is enforced by the
          proof itself</strong>, not bolted on by some trusted server after the fact.</p>
        <p>For every output note, the sender encrypts the note's contents to the auditor's public key with
          <strong>Baby Jubjub ElGamal</strong>. One of the circuit's own constraints then checks that this
          ciphertext is well formed and decrypts to the very same note being committed. A transaction with a
          missing, malformed or mismatched auditor ciphertext simply <em>cannot produce a valid proof</em>, so
          the contract rejects it at verification time.</p>
        <p>The auditor, and nobody else, holds the private key that opens these ciphertexts, so they can
          reconstruct any note's amount and owner for compliance. Everyone else just sees opaque commitments.
          That is the whole line between <em>privacy</em> (hidden from the public, openable by a mandated
          party) and <em>opacity</em> (hidden from everyone, forever).</p>
      </section>

      <section id="chain">
        <h2>On Stellar / Soroban</h2>
        <p>The pool is a Soroban smart contract written in Rust. It keeps:</p>
        <ul>
          <li>an <strong>incremental Merkle tree</strong> (depth 16) of note commitments, updated by pair
            insertion, with a ring buffer of recent roots so a proof built against a slightly stale root still
            works;</li>
          <li>a <strong>nullifier set</strong> recording everything ever spent;</li>
          <li>a Groth16 <strong>verifier</strong> running on Soroban's <em>native BN254 host functions</em>.
            Pairing checks and field arithmetic happen at native speed instead of in interpreted WASM, which is
            what keeps on-chain verification affordable.</li>
        </ul>
        <p>Each successful transaction emits events: the new commitments, the nullifiers and the sealed
          auditor ciphertexts. So any wallet, and the auditor, can rebuild state just by scanning the chain.
          There is no trusted central indexer in the loop.</p>
        <p class="doc-meta">Live testnet pool: <code>${pool}</code> &middot; assets ${assets}</p>
      </section>

      <section id="flow">
        <h2>A payment, end to end</h2>
        <h3>1 · Deposit (shield)</h3>
        <p>You move public tokens into the pool from your own Stellar wallet. The deposit is
          <strong>self-custodial</strong>: you sign and pay for it yourself with <strong>Freighter</strong>,
          and the relayer never touches your funds. A new shielded note is created for your balance.</p>
        <h3>2 · Send (private transfer)</h3>
        <p>Your device builds the proof locally, encrypts the new note to the recipient's view key and to the
          auditor, then hands the proof and ciphertexts to a <strong>relayer</strong> that submits the
          transaction and pays the network fee. Since the relayer only forwards a finished proof, it learns
          nothing about amounts or parties. On the chain, observers see only an opaque state update.</p>
        <h3>3 · Withdraw (unshield)</h3>
        <p>Value comes back into the open. The proof authorizes a payout to an ordinary Stellar address and
          burns the matching shielded notes.</p>
      </section>

      <section id="use">
        <h2>Using the wallet, step by step</h2>

        <h3>Create or restore your wallet</h3>
        <p>On first launch, tap <strong>Create wallet</strong> to generate a private key (your seed), or
          <strong>I have a private key</strong> to restore one. From this one secret the app derives both your
          <em>spend key</em> (which authorizes spending) and your <em>view key</em> (which decrypts your
          incoming notes). Write the seed down. It is the only way back to your balance, and no server can
          reset it for you.</p>

        <h3>Put money in (Deposit)</h3>
        <ol class="doc-steps">
          <li>Open <strong>Deposit</strong> and choose the asset (for example USDC).</li>
          <li><strong>Connect Freighter</strong>. The deposit is signed and paid from your own Stellar
            account, so you stay in custody the whole time.</li>
          <li>If the account has no trustline for the token yet, tap <strong>Add trustline</strong> (a one
            time Stellar setup), then fund it from the linked faucet if you need to.</li>
          <li>Enter an amount and confirm in Freighter. After a few seconds the value appears as your shielded
            balance, and the deposit shows up in <em>Activity</em> with a link to the explorer.</li>
        </ol>

        <h3>Send privately</h3>
        <ol class="doc-steps">
          <li>Ask the recipient for their <strong>Umbra address</strong> (it starts with <code>shld_…</code>).
            They copy it from the chip at the top of their wallet, or from <em>Receive</em>.</li>
          <li>Open <strong>Send</strong>, paste the address, then choose the asset and amount.</li>
          <li>Your device builds the proof locally and hands it to the relayer. Neither the relayer nor the
            public chain learns the amount or who you paid. The recipient's wallet finds the note on its own
            the next time it scans.</li>
        </ol>

        <h3>Receive</h3>
        <p>Open <strong>Receive</strong> and share your <code>shld_…</code> address. There is nothing for you
          to approve. Incoming notes are encrypted to your view key, your wallet discovers them by scanning
          the chain, and your balance simply goes up.</p>

        <h3>Take money out (Withdraw)</h3>
        <ol class="doc-steps">
          <li>Open <strong>Withdraw</strong> and paste an ordinary Stellar address (it starts with
            <code>G…</code>), your own or someone else's.</li>
          <li>Choose the amount and confirm. The proof tells the pool to pay that address in the open, and
            your remaining balance stays shielded as change.</li>
        </ol>

        <h3>Merge notes (optional)</h3>
        <p>Each deposit or incoming transfer is its own note, and a single transaction can spend at most two
          of them. So if you have received a lot of small notes, the wallet offers <strong>Merge</strong> next
          to a token in your holdings to combine them into one. Handy right before sending a large amount.</p>
      </section>

      <section id="invisible">
        <h2>Why payments stay private</h2>
        <p>The easiest way to see it is to compare a normal stablecoin payment with an Umbra one.</p>
        <p><strong>On a public ledger</strong>, a transfer writes a line anyone can read: <em>address A sent
          250 USDC to address B at 14:32</em>. Tie an address to a real person just once, through an exchange
          withdrawal or a posted donation address, and their whole history unfolds.</p>
        <p><strong>On Umbra</strong>, the same payment publishes only a new <em>commitment</em> (an opaque
          hash), a <em>nullifier</em> (an unlinkable spend tag) and some ciphertexts. From those, an observer
          cannot recover the amount, cannot tell which earlier note was spent, and cannot connect the sender
          to the recipient. Three properties work together to make that hold:</p>
        <ul>
          <li><strong>Hiding commitments.</strong> Each note's on-chain fingerprint is randomized by a secret
            blinding factor, so equal amounts look different and nothing about the contents leaks.</li>
          <li><strong>Unlinkable nullifiers.</strong> The tag that prevents double spending is built so it
            cannot be matched back to the commitment it retires. Spending hides <em>which</em> coin moved.</li>
          <li><strong>Local zero-knowledge proofs.</strong> Validity is proven on your device. The network
            checks the proof without ever seeing the secrets, and the relayer only forwards a finished proof,
            so it pays the fee without learning a thing.</li>
        </ul>
        <p>There are two deliberate exceptions. A deposit or a withdrawal has to move value across the
          boundary between the open ledger and the shielded pool, so that crossing is visible. And the
          <strong>auditor</strong> can always decrypt. See <a href="#threat">What's hidden, what's not</a>.</p>
      </section>

      <section id="multi">
        <h2>Multiple assets</h2>
        <p>Notes carry an <code>assetId</code>, and the circuit enforces balance <em>per asset</em>, so one
          shielded pool can hold several tokens (for example USDC and EURC) without ever mixing their value.
          The wallet's home shows your <strong>total portfolio value</strong>, which you can read in either
          token with the toggle, and the per-token holdings are listed right underneath.</p>
      </section>

      <section id="threat">
        <h2>What's hidden, what's not</h2>
        <p>A privacy claim only means something if its edges are spelled out.</p>
        <h3>Hidden from the public</h3>
        <ul>
          <li>Note amounts and which asset they hold.</li>
          <li>Account balances. There are no public balances to read in the first place.</li>
          <li>The link between the sender and recipient of a private transfer.</li>
          <li>Which existing note a given transaction spends.</li>
        </ul>
        <h3>Visible by design</h3>
        <ul>
          <li>That <em>some</em> shielded transaction happened, and when.</li>
          <li>The public side of a deposit or withdraw, where a value crosses the pool boundary in the open.
            That is inherent to bridging public and private balances.</li>
          <li>Everything, to the mandated <strong>auditor</strong>, who can decrypt note contents.</li>
        </ul>
        <p class="doc-note"><strong>Status.</strong> Umbra is a hackathon project on Stellar
          <strong>testnet</strong>. The circuits use a development trusted setup and the contracts are not
          audited, so please don't use it with funds you can't afford to lose.</p>
      </section>

      <section id="stack">
        <h2>Tech stack</h2>
        <ul>
          <li><strong>Circuits:</strong> Circom 2 + Groth16 (snarkjs), BN254, Poseidon (circomlib),
            Baby Jubjub ElGamal for auditor disclosure.</li>
          <li><strong>Contract:</strong> Rust / Soroban, native BN254 host functions, an incremental Merkle
            tree, a nullifier set and a ring buffer of recent roots.</li>
          <li><strong>Client:</strong> a Vite SPA with in-browser proving, <code>@stellar/stellar-sdk</code>,
            Freighter for self-custodial deposits, and a serverless relayer for private transfers and
            withdrawals.</li>
          <li><strong>Extension:</strong> a Manifest V3 popup with the same client-side proving, run single
            threaded to stay inside the extension content security policy.</li>
        </ul>
        <p>Source: <a href="${REPO}" target="_blank" rel="noopener">${REPO.replace("https://", "")}</a></p>
      </section>

      <section id="faq">
        <h2>FAQ</h2>
        <h3>Does the relayer custody my money?</h3>
        <p>No. You sign deposits yourself in Freighter, and private transfers and withdrawals are authorized by
          a proof you generate locally. The relayer only broadcasts the transaction and pays the gas. It can't
          move your funds or learn their amounts.</p>
        <h3>Who is the auditor?</h3>
        <p>A party whose public key is fixed in the pool configuration. In a real deployment this would be a
          regulator, a compliance team, or a key split across several parties. Disclosure to them is enforced
          cryptographically by the circuit, not by trusting a server.</p>
        <h3>Is my balance stored anywhere?</h3>
        <p>Only as opaque commitments on the chain. Your wallet rebuilds your balance by scanning events and
          decrypting the notes addressed to your view key, so the same seed phrase recovers your balance on any
          device, with no account on any server.</p>
        <h3>Why is the first proof a little slow?</h3>
        <p>Proving happens on your device over a proving key that is a few megabytes. The extension proves
          single threaded to satisfy its security policy, trading a few seconds of speed for never shipping any
          remote code.</p>
      </section>

      <section id="install" class="doc-install">
        <h2>Install the Chrome extension</h2>
        <p>The extension is the full wallet in a browser popup. It isn't on the Chrome Web Store yet, so you
          load it once in Developer mode. It takes about 30 seconds.</p>
        <ol class="doc-steps">
          <li><strong>Download</strong> the package:
            <a class="btn primary sm dl" href="${REL}">Download umbra-extension.zip ↧</a></li>
          <li><strong>Unzip it.</strong> Double-click the downloaded file. Keep the resulting folder somewhere
            stable (for example <code>Documents/umbra-extension</code>). Chrome reads it in place, so don't
            delete or move it afterwards.</li>
          <li>Open <code>chrome://extensions</code> in your browser.</li>
          <li>Turn on <strong>Developer mode</strong> with the toggle at the top right.</li>
          <li>Click <strong>Load unpacked</strong> and select the unzipped folder.</li>
          <li>Click the puzzle icon 🧩 in the toolbar and <strong>pin</strong> Umbra. Click it to open the
            wallet.</li>
        </ol>
        <p class="doc-note"><strong>A note on deposits in the extension.</strong> Freighter can't be reached
          from inside an extension popup, so the <em>Deposit</em> button opens the web app to sign with
          Freighter, and your new balance then appears in the popup on its own. Everything else (send,
          withdraw, receive and balances) runs right in the popup.</p>
      </section>

      <footer class="doc-foot">
        <span>Umbra · privacy on Stellar</span>
        <button class="link sm" id="doc-back-2">↑ Back to the wallet</button>
      </footer>
    </article>
  </div>
</div>`;
}
