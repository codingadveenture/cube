import type { CardsFile } from '../types';
import { Account } from './Account';

const REPO = 'https://github.com/codingadveenture/cube';

export function AboutView({ data }: { data: CardsFile | null }) {
  return (
    <article className="about">
      <h1>About</h1>
      <p>
        Cube keeps a paper Vintage Cube of about 540 proxy cards in order. It shows what is in the Cube,
        card by card and Printing by Printing, and checks the Cube against the List from phone Scans.
      </p>
      <Account />
      <h2>Words</h2>
      <dl className="facts">
        <div>
          <dt>Cube</dt>
          <dd>The paper cube in the box.</dd>
        </div>
        <div>
          <dt>List</dt>
          <dd>The intended contents, kept on CubeCobra.</dd>
        </div>
        <div>
          <dt>In-box Printing</dt>
          <dd>The Printing that is physically in the Cube.</dd>
        </div>
        <div>
          <dt>Wanted Printing</dt>
          <dd>The Printing the Owner would like. When it differs, the card is reprinted.</dd>
        </div>
        <div>
          <dt>Scan</dt>
          <dd>A pass over the Cube with a phone scanner, ending in a diff against the List.</dd>
        </div>
      </dl>
      <h2>Data</h2>
      <ul>
        <li>
          Card data and images: <a href="https://scryfall.com/">Scryfall</a>. Images are loaded from
          Scryfall&rsquo;s servers.
        </li>
        <li>
          The List: <a href="https://cubecobra.com/cube/overview/MTGVintageCube">CubeCobra, MTGVintageCube</a>.
        </li>
        {data && (
          <li className="num">
            Card data built {data.generated_at.slice(0, 10)}, Scryfall fetched {data.source.scryfall_fetched_at.slice(0, 10)}.
          </li>
        )}
      </ul>
      <p>
        This project is not affiliated with Wizards of the Coast, CubeCobra or Scryfall. Magic: The Gathering
        is a trademark of Wizards of the Coast.
      </p>
      <h2>Licence and source</h2>
      <p>
        Free software under the GNU Affero General Public License, version 3. Source code:{' '}
        <a href={REPO}>{REPO.replace('https://', '')}</a>.
      </p>
    </article>
  );
}
