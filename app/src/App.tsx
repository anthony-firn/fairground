import { useCallback, useEffect, useMemo, useState } from 'react';
import { LOCAL_PILOT } from './lib/pilot.ts';
import { Onboarding } from './components/Onboarding.tsx';
import { Aside, Sidebar } from './components/Shell.tsx';
import { Icon } from './components/ui.tsx';
import { AppContext, type AppState } from './context.ts';
import { loadOrCreateAccount } from './lib/account.ts';
import { announce } from './lib/data.ts';
import { load, onChange } from './lib/storage.ts';
import { scheduleSync } from './lib/vaultSync.ts';
import { startInbox } from './lib/dm.ts';
import { Compose } from './screens/Compose.tsx';
import { CredentialsScreen } from './screens/Credentials.tsx';
import { ListingDetail, Market, NewListing, StoreEditor, StorePage } from './screens/Market.tsx';
import { ConversationThread, Conversations } from './screens/Messages.tsx';
import { Orders } from './screens/Orders.tsx';
import { PostDetail } from './screens/PostDetail.tsx';
import { ListenScreen, MediaDetail, PhotosScreen, ShortsScreen, VideosScreen } from './screens/Media.tsx';
import { Search } from './screens/Search.tsx';
import { EpisodeEditor, ShowEditor, ShowPage } from './screens/Podcast.tsx';
import { CampaignBuilder, CampaignPage } from './screens/Campaigns.tsx';
import { WalletScreen } from './screens/Wallet.tsx';
import { Create, MediaKitScreen, SupportPageScreen } from './screens/Create.tsx';
import { Home } from './screens/Home.tsx';
import { Profile } from './screens/Profile.tsx';
import { Promote } from './screens/Promote.tsx';
import { RelayScreen } from './screens/Relay.tsx';
import { Deals, Sponsors } from './screens/Sponsorships.tsx';
import { runSurveyJobs, SurveyScreen } from './screens/Survey.tsx';
import { About, AccountScreen, FeedSettings, PersonalSettings, RelaysScreen, SupportingScreen, You } from './screens/You.tsx';

const { account, isNew } = loadOrCreateAccount();
onChange(scheduleSync);

// Coming back from Transak (buying or cashing out) lands on the wallet; the order details ride in the query string.
{
  const back = new URLSearchParams(location.search);
  if (back.get('ramp')) {
    const orderId = back.get('orderId');
    history.replaceState(null, '', `${location.pathname}#/wallet${back.get('ramp') === 'sell' && orderId ? `?orderId=${encodeURIComponent(orderId)}` : ''}`);
  }
}

function currentRoute() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, search = ''] = hash.split('?');
  return { path, query: new URLSearchParams(search) };
}

const TABS = [
  { path: '/', label: 'Home', icon: 'home' },
  { path: '/market', label: 'Market', icon: 'bag' },
  { path: '/post', label: 'Post', icon: 'plus' },
  { path: '/create', label: 'Create', icon: 'spark' },
  { path: '/you', label: 'You', icon: 'user' },
];

export function App() {
  const [route, setRoute] = useState(currentRoute);
  const [onboarding, setOnboarding] = useState(() => isNew || !load<boolean>('onboarded', false));
  const [message, setMessage] = useState('');
  const [recipeVersion, setRecipeVersion] = useState(0);

  useEffect(() => {
    const onHash = () => {
      setRoute(currentRoute());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Background work while the app is open: announce this account, issue survey tokens, send scheduled answers.
  useEffect(() => {
    announce(account).catch(() => undefined);
    const stopInbox = startInbox(account);
    const run = () => runSurveyJobs(account).catch(() => undefined);
    const first = setTimeout(run, 8000);
    const every = setInterval(run, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
      stopInbox();
    };
  }, []);

  const toast = useCallback((m: string) => {
    setMessage(m);
    setTimeout(() => setMessage((current) => (current === m ? '' : current)), 3500);
  }, []);

  const state = useMemo<AppState>(() => ({
    account,
    navigate: (path) => {
      location.hash = path;
    },
    toast,
    recipeVersion,
    bumpRecipe: () => setRecipeVersion((v) => v + 1),
  }), [toast, recipeVersion]);

  const { path, query } = route;
  let screen;
  if (path === '/') screen = <Home />;
  else if (path === '/post') screen = <Compose />;
  else if (path === '/photos') screen = <PhotosScreen />;
  else if (path === '/videos') screen = <VideosScreen />;
  else if (path === '/shorts') screen = <ShortsScreen />;
  else if (path === '/listen') screen = <ListenScreen />;
  else if (path.startsWith('/media/') && /^[0-9a-f]{64}$/.test(path.slice(7))) screen = <MediaDetail key={path} id={path.slice(7)} />;
  else if (path === '/search') screen = <Search query={query} />;
  else if (path === '/market') screen = <Market />;
  else if (path === '/market/new') screen = <NewListing query={query} />;
  else if (path.startsWith('/l/')) screen = <ListingDetail key={path} address={decodeURIComponent(path.slice(3))} />;
  else if (path.startsWith('/s/')) screen = <StorePage key={path} address={decodeURIComponent(path.slice(3))} />;
  else if (path === '/create/store') screen = <StoreEditor />;
  else if (path === '/create/credentials') screen = <CredentialsScreen />;
  else if (path === '/orders') screen = <Orders />;
  else if (path === '/messages') screen = <Conversations />;
  else if (path.startsWith('/messages/') && /^[0-9a-f]{64}$/.test(path.slice(10))) screen = <ConversationThread key={path} pubkey={path.slice(10)} />;
  else if (path.startsWith('/post/') && /^[0-9a-f]{64}$/.test(path.slice(6))) screen = <PostDetail key={path} id={path.slice(6)} />;
  else if (path === '/create') screen = <Create />;
  else if (path === '/create/sponsors') screen = <Sponsors />;
  else if (path === '/create/deals') screen = <Deals />;
  else if (path === '/create/kit') screen = <MediaKitScreen />;
  else if (path === '/create/support') screen = <SupportPageScreen />;
  else if (path === '/create/survey') screen = <SurveyScreen />;
  else if (path === '/promote') screen = <Promote query={query} />;
  else if (path === '/wallet') screen = <WalletScreen key={query.toString()} query={query} />;
  else if (path === '/promote/campaign/new') screen = <CampaignBuilder />;
  else if (/^\/promote\/campaign\/[a-z0-9-]+$/.test(path)) screen = <CampaignPage key={path} slug={path.split('/')[3]} />;
  else if (path === '/podcast/new') screen = <ShowEditor />;
  else if (/^\/podcast\/edit\/[A-Za-z0-9_-]+$/.test(path)) screen = <ShowEditor key={path} slug={path.split('/')[3]} />;
  else if (/^\/show\/npub1[a-z0-9]+\/[A-Za-z0-9_-]+\/new$/.test(path)) screen = <EpisodeEditor key={path} npub={path.split('/')[2]} slug={path.split('/')[3]} />;
  else if (/^\/show\/npub1[a-z0-9]+\/[A-Za-z0-9_-]+$/.test(path)) screen = <ShowPage key={path} npub={path.split('/')[2]} slug={path.split('/')[3]} />;
  else if (path === '/relay') screen = <RelayScreen />;
  else if (path === '/you') screen = <You />;
  else if (path === '/feed') screen = <FeedSettings />;
  else if (path === '/settings') screen = <PersonalSettings />;
  else if (path === '/account') screen = <AccountScreen />;
  else if (path === '/relays') screen = <RelaysScreen />;
  else if (path === '/supporting') screen = <SupportingScreen />;
  else if (path === '/about') screen = <About />;
  else if (path.startsWith('/p/') && /^[0-9a-f]{64}$/.test(path.slice(3))) screen = <Profile key={path} pubkey={path.slice(3)} />;
  else screen = <Home />;

  const wide = ['/videos', '/market', '/photos', '/search'].includes(path) || ['/media/', '/l/', '/s/'].some((p) => path.startsWith(p));
  const tab = ['/photos', '/videos', '/shorts', '/listen'].includes(path) || path.startsWith('/media/') || path.startsWith('/show/') ? '/' : TABS.slice().reverse().find((t) => (t.path === '/' ? path === '/' : path.startsWith(t.path)))?.path
    ?? (['/feed', '/settings', '/account', '/relays', '/supporting', '/about', '/orders', '/messages', '/wallet'].includes(path) || path.startsWith('/messages/') ? '/you'
      : path.startsWith('/promote') || path.startsWith('/podcast') || path === '/relay' ? '/create'
        : path.startsWith('/l/') || path.startsWith('/s/') ? '/market' : '');

  return (
    <AppContext.Provider value={state}>
      <div className={`layout${wide ? ' wide' : ''}${path === '/shorts' ? ' shorts-layout' : ''}${path.startsWith('/media/') ? ' no-aside' : ''}`}>
      <Sidebar path={path} />
      <div className="app">
        {LOCAL_PILOT && <div role="status" style={{ padding: '10px 16px', background: '#fff3bf', color: '#533f00' }}>Local staging preview · $25 demo balance · Real transfers disabled</div>}
        <main>{screen}</main>
        <div className="tabbar">
          <nav aria-label="Main">
            {TABS.map((t) => (
              <a key={t.path} href={`#${t.path}`} aria-current={tab === t.path ? 'page' : undefined}>
                <Icon name={t.icon} />{t.label}
              </a>
            ))}
          </nav>
        </div>
        {message && <div className="toast" role="status">{message}</div>}
      </div>
      <Aside />
      </div>
      {onboarding && <Onboarding onDone={() => (setOnboarding(false), setRecipeVersion((v) => v + 1))} />}
    </AppContext.Provider>
  );
}
