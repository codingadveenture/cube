// ShufflingView: how the Cube is shuffled before a draft, and the schemes that were weighed, so the
// routine is the same every time.

export function ShufflingView() {
  return (
    <article className="about shuffling">
      <h1>Shuffling</h1>
      <p>
        The Cube is about 540 cards, far too many to shuffle as one stack. Every scheme that works splits it into piles
        small enough to riffle and does two things: the riffles mix the cards within a pile, and some exchange between
        piles spreads them across the whole Cube. Without the exchange, each pile would only ever be a shuffle of the
        same cards.
      </p>

      <h2>The routine</h2>
      <ol>
        <li>Split the Cube into eight rough stacks by eye, one per person. Last draft&rsquo;s decks are fine as stacks.</li>
        <li>
          Everyone riffles or mash-shuffles their pile four or five times, then passes the top half to the right and
          takes the half that arrives from the left. The next round goes to the left, then right again, and so on. Each
          pile stays at about 68 cards.
        </li>
        <li>
          After eight rounds, shuffle once more and count 45 cards off the top: three packs of 15. The rest goes back in
          the box.
        </li>
      </ol>
      <p>
        Each round moves half of every pile one seat along, so after eight rounds every pile holds cards from all over
        the table, and the riffles decide which ones. Riffle or mash rather than overhand: a few overhand shuffles barely
        move a card.
      </p>

      <h2>Other schemes</h2>
      <p>Ranked by how fast and how easily eight people get the whole Cube mixed. Times are rough.</p>
      <table className="shuffle-schemes">
        <thead>
          <tr>
            <th>Scheme</th>
            <th>Rounds</th>
            <th>Time</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>1. Pass halves around the table, alternating direction (the routine above)</td>
            <td className="num">8</td>
            <td className="num">5 min</td>
            <td>One motion, no dealing, nothing to remember.</td>
          </tr>
          <tr>
            <td>2. Swap halves with a partner: your neighbour, then two seats over, then opposite, then your neighbour again</td>
            <td className="num">4</td>
            <td className="num">3 min</td>
            <td>
              The same motion and the fastest mix, since the number of stacks a pile draws from doubles each round. Everyone
              has to know their partner each round.
            </td>
          </tr>
          <tr>
            <td>3. Two dealers each deal half the Cube into eight piles, stack pile on pile, everyone shuffles a pile; repeat once</td>
            <td className="num">2</td>
            <td className="num">7 min</td>
            <td>Sound, but 540 cards are dealt one by one, twice, while six people wait.</td>
          </tr>
          <tr>
            <td>4. Deal into fifteen piles, choosing the pile freely each card; shuffle each pile; build packs by taking one card from every pile</td>
            <td className="num">1</td>
            <td className="num">10 min or more</td>
            <td>The slowest: the deal is long, people are poor at choosing piles at random, and the packs take 360 single picks.</td>
          </tr>
          <tr>
            <td>5. Put half your deck in the centre, take a random pile, riffle it a few times, put half back; repeat</td>
            <td className="num">open-ended</td>
            <td className="num">10 min or more</td>
            <td>Easy motions, but the exchange is haphazard, so it mixes slowly and nobody knows when it is done.</td>
          </tr>
        </tbody>
      </table>

      <h2>Between drafts</h2>
      <p>
        Put the drafted packs back in random order rather than deck by deck, since a deck&rsquo;s cards are strongly
        related, and never leave the Cube sorted in the box.
      </p>
    </article>
  );
}
