// About: who you are signed in as, Owner sign-in and Claim Owner, and what each role can do.
import { useStore } from '../store/context';
import { CopyButton } from './common';

export function Account() {
  const { auth, connection, unavailableReason, signInAsOwner, signOut, store, save } = useStore();
  let who = 'Connecting…';
  if (connection === 'unavailable') who = 'Local only: the shared data could not be started on this device.';
  else if (auth.isOwner) who = `Owner${auth.displayName ? ` (${auth.displayName})` : ''}`;
  else if (auth.provider === 'google') who = `Signed in with Google${auth.displayName ? ` as ${auth.displayName}` : ''}, not the Owner`;
  else if (auth.provider === 'anonymous') who = 'Visitor (signed in automatically, no account needed)';

  const canClaim = !!store && auth.provider === 'google' && auth.ownerLoaded && auth.owner === null;

  return (
    <section className="panel" aria-labelledby="account-head">
      <h2 id="account-head">Account</h2>
      <p>{who}</p>
      {connection === 'unavailable' && unavailableReason && <p className="status error">{unavailableReason}</p>}
      {auth.error && <p className="status error">Sign-in problem: {auth.error}</p>}
      {auth.uid && (
        <p className="uid">
          <span className="muted">User id</span> <code className="num">{auth.uid}</code> <CopyButton text={auth.uid} label="Copy" />
        </p>
      )}
      <div className="actions">
        {connection === 'ready' && auth.provider !== 'google' && (
          <button type="button" className="primary" onClick={() => void signInAsOwner()}>
            Sign in as Owner
          </button>
        )}
        {auth.provider === 'google' && (
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        )}
        {canClaim && store && (
          <button type="button" className="primary" onClick={() => void save(() => store.claimOwner(), 'You are now the Owner.')}>
            Claim Owner
          </button>
        )}
      </div>
      {canClaim && <p className="muted">Nobody is the Owner yet. Claim Owner makes this Google account the Owner, once.</p>}
      <h3>What everyone can do</h3>
      <ul>
        <li>See the Cube, the Log and every Suggestion.</li>
        <li>Send Suggestions: Art flags, Bans, Winner&rsquo;s Picks, Printings, adds and anything else.</li>
        <li>Scan piles, share them with the group, and run the diff over shared piles.</li>
        <li>Build a Print batch, calibrate a printer and generate the print sheet PDF.</li>
      </ul>
      <h3>What the Owner can do</h3>
      <ul>
        <li>Accept or reject Suggestions.</li>
        <li>Flag art directly, set the In-box Printing, and clear Art flags.</li>
        <li>Add and edit Log entries, import the log from a file, and import the baseline.</li>
        <li>Delete any shared pile.</li>
        <li>Save print settings and printer profiles for everyone, and mark a Print batch as printed.</li>
        <li>Decide on the Upstream feed, apply Updates, mark cards Out or pulled, and export the List for CubeCobra.</li>
      </ul>
    </section>
  );
}
