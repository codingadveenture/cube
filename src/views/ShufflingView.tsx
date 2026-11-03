// ShufflingView: how the Cube is shuffled before a draft, and the schemes that were weighed.

export function ShufflingView() {
  return (
    <article className="about shuffling">
      <h1>Shuffling</h1>
      <p>
        540 cards are too many for one stack. The Cube is shuffled in eight piles: riffles mix the cards within a pile,
        and passing halves between piles spreads them across the whole Cube.
      </p>

      <h2>The routine</h2>
      <ol>
        <li>Split the Cube into eight rough stacks, one per person.</li>
        <li>Riffle your pile four or five times, pass the top half to the right, take the half from the left.</li>
        <li>Next round the same to the left, then right again. Eight rounds in all.</li>
        <li>Riffle once more and count 45 cards off the top: three packs of 15.</li>
      </ol>
      <p>Each round moves half of every pile one seat along, so after eight rounds every pile holds cards from all over the table.</p>

      <h2>Other schemes</h2>
      <p>Ranked by how fast eight people get the whole Cube mixed.</p>
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
            <td>One motion, no dealing.</td>
          </tr>
          <tr>
            <td>2. Swap halves with a partner: neighbour, two seats over, opposite, neighbour</td>
            <td className="num">4</td>
            <td className="num">3 min</td>
            <td>Fastest mix: the stacks a pile draws from double each round. Everyone must know their partner.</td>
          </tr>
          <tr>
            <td>3. Two dealers each deal half the Cube into eight piles, stack pile on pile, everyone shuffles a pile; repeat once</td>
            <td className="num">2</td>
            <td className="num">7 min</td>
            <td>540 cards dealt one by one, twice, while six people wait.</td>
          </tr>
          <tr>
            <td>4. Deal into fifteen piles choosing the pile freely, shuffle each, build packs one card from every pile</td>
            <td className="num">1</td>
            <td className="num">10 min or more</td>
            <td>Long deal, uneven piles, 360 single picks for the packs.</td>
          </tr>
          <tr>
            <td>5. Half your deck to the centre, take a random pile, riffle it a few times, put half back; repeat</td>
            <td className="num">open-ended</td>
            <td className="num">10 min or more</td>
            <td>Mixes slowly, and there is no point at which it is done.</td>
          </tr>
        </tbody>
      </table>

      <h2>Between drafts</h2>
      <p>Return the drafted packs in random order, not deck by deck, and never box the Cube sorted.</p>
    </article>
  );
}
