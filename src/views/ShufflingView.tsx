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
        <li>Riffle your pile four or five times, pass the top half one seat to the left, take the half that arrives from the right.</li>
        <li>Second round the same, but pass the top half two seats to the left. Third round, pass it straight across the table.</li>
        <li>Riffle once more and count 45 cards off the top: three packs of 15.</li>
      </ol>
      <p>
        Three rounds, and everyone does the same thing. Each round doubles the number of piles your cards have reached:
        two, then four, then all eight, an eighth in each. No scheme can do it in fewer rounds, since a round can at most
        double the spread. Passing to the same neighbour every round, or alternating sides, moves the halves one seat at a
        time: after eight rounds a quarter of your cards are still at one seat.
      </p>

      <h2>Fewer people</h2>
      <p>
        Keep eight piles whatever the head count: nobody should riffle more than about 110 cards, and eight is the smallest
        number of piles that comes out even. Lay the piles in a row, riffle each, and move every top half the same number
        of piles along, wrapping round at the end: one pile, then two, then four. That is 24 riffles in all, twelve each
        for two people, eight each for three.
      </p>

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
            <td>1. Pass halves one seat, two seats, then across (the routine above)</td>
            <td className="num">3</td>
            <td className="num">2 min</td>
            <td>One instruction for everyone, and even after three rounds.</td>
          </tr>
          <tr>
            <td>2. Swap halves with a partner: neighbour, two seats over, opposite</td>
            <td className="num">3</td>
            <td className="num">2 min</td>
            <td>The same mix, but everyone must know their partner for each round.</td>
          </tr>
          <tr>
            <td>3. Pass halves around the table, one direction or alternating</td>
            <td className="num">8</td>
            <td className="num">5 min</td>
            <td>The halves creep one seat per round. Still uneven after eight rounds: a quarter of each pile sits at one seat.</td>
          </tr>
          <tr>
            <td>4. Two dealers each deal half the Cube into eight piles, stack pile on pile, everyone shuffles a pile; repeat once</td>
            <td className="num">2</td>
            <td className="num">7 min</td>
            <td>540 cards dealt one by one, twice, while six people wait.</td>
          </tr>
          <tr>
            <td>5. Deal into fifteen piles choosing the pile freely, shuffle each, build packs one card from every pile</td>
            <td className="num">1</td>
            <td className="num">10 min or more</td>
            <td>Long deal, uneven piles, 360 single picks for the packs.</td>
          </tr>
          <tr>
            <td>6. Half your deck to the centre, take a random pile, riffle it a few times, put half back; repeat</td>
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
