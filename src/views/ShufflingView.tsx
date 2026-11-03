// ShufflingView: how the Cube is shuffled before a draft, the schemes that were weighed, and why the
// house routine is what it is, so the routine is the same every time.

export function ShufflingView() {
  return (
    <article className="about shuffling">
      <h1>Shuffling</h1>
      <p>
        Nobody can riffle 540 cards, and dealing them one by one is slow. Every workable scheme has the same two
        parts: something that moves cards between piles, and riffles or mash shuffles of piles small enough to handle,
        which is where the randomness comes from. The schemes below are ranked by how fast and how easily eight people
        get the whole Cube mixed.
      </p>

      <h2>Ranked</h2>
      <table className="shuffle-schemes">
        <thead>
          <tr>
            <th>Scheme</th>
            <th>Rounds</th>
            <th>Time, 8 people</th>
            <th>Effort</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>1. Pass halves around the table, alternating direction</td>
            <td className="num">8</td>
            <td className="num">5 min</td>
            <td>One motion, no dealing, nothing to remember</td>
            <td>The house routine</td>
          </tr>
          <tr>
            <td>2. Swap halves with a partner: neighbour, two seats over, opposite, neighbour</td>
            <td className="num">4</td>
            <td className="num">3 min</td>
            <td>Same motion, but everyone must know their partner each round</td>
            <td>Fastest; use it when the table is used to it</td>
          </tr>
          <tr>
            <td>3. Two dealers deal into eight piles each, stack pile on pile, shuffle, repeat</td>
            <td className="num">2</td>
            <td className="num">7 min</td>
            <td>540 cards dealt one by one, twice, while six people wait</td>
            <td>Sound, but the dealing drags</td>
          </tr>
          <tr>
            <td>4. Deal into fifteen piles by free choice, shuffle each, build packs one card from each pile</td>
            <td className="num">1</td>
            <td className="num">10 min or more</td>
            <td>Slow deal, 360 single picks to build the packs</td>
            <td>Works, but people choose piles badly and it is the slowest</td>
          </tr>
          <tr>
            <td>5. Half your deck to the centre, take a random pile, riffle a few times, repeat</td>
            <td className="num">open-ended</td>
            <td className="num">10 min or more</td>
            <td>Easy motions, but nobody knows when it is done</td>
            <td>Mixes slowly and unevenly; retired</td>
          </tr>
        </tbody>
      </table>
      <p>
        Riffle or mash the piles: a handful of overhand shuffles barely moves a card. Dealing into piles on its own does
        not shuffle either, so every deal is followed by shuffling the piles.
      </p>

      <h2>The house routine</h2>
      <ol>
        <li>Split the Cube into eight rough stacks by eye, one per person. Last draft&rsquo;s decks are fine as stacks.</li>
        <li>
          Everyone riffles or mash-shuffles their pile four or five times, then passes the top half to the right and takes
          the half that arrives from the left. The next round goes to the left, then right again, and so on. Each pile
          stays at about 68 cards.
        </li>
        <li>
          Eight rounds, one last shuffle, and each person counts 45 cards off the top: three packs of 15. The rest goes
          back in the box.
        </li>
      </ol>
      <p>
        Each round moves half of every pile one seat along, so after eight rounds every pile holds cards from all over the
        table, and the riffles decide which. With the partner pattern instead (scheme 2) the number of stacks a pile draws
        from doubles each round, 1, 2, 4, 8, which is why four rounds are enough there.
      </p>
      <p>
        Between drafts, put the drafted packs back in random order rather than deck by deck, and never leave the Cube
        sorted in the box.
      </p>
    </article>
  );
}
