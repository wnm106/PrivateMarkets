'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { goToSignIn } from '@/components/layout/UserMenu';
import { browserSessionIsActive } from '@/lib/auth-token';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { isUnauthenticatedGraphqlError } from '@/lib/safe-next-path';
import {
  HOME_MODULES,
  ROLE_LABEL,
  greeting,
  groupNeedsYou,
  headline,
  homeRole,
  pinnedPlaces,
  summarize,
  toggleModule,
  togglePin,
  visibleModules,
  type HomeModuleCode,
  type HomePlace,
  type HomeUser,
} from '@/lib/home';
import { DataHealthModule } from './DataHealthModule';
import {
  BriefView,
  FocusTiles,
  FollowingModule,
  NeedsYouBoard,
  PlacesModule,
  SetupCard,
  useBrief,
  useNeedsYou,
  type HomeFollow,
} from './HomeModules';

interface Layout {
  clientId: string | null;
  canSave: boolean;
  hiddenModules: string[] | null;
  pinnedPlaces: string[] | null;
}

const LAYOUT_FIELDS = 'clientId canSave hiddenModules pinnedPlaces';
const ME_QUERY = `query HomeMe { me { id displayName } }`;
const LAYOUT_QUERY = `query HomeLayout { homeLayout { ${LAYOUT_FIELDS} } }`;
const FOLLOWS_QUERY = `query { homeFollows { id subjectType subjectId subjectCode label delivery domainCode lastSummary lastAt } }`;

const SAVE_LAYOUT = `
  mutation SaveHomeLayout($input: SaveHomeLayoutInput!) {
    saveHomeLayout(input: $input) {
      layout { ${LAYOUT_FIELDS} }
      errors { message }
    }
  }
`;

const MODULE_LINKS: Partial<Record<HomeModuleCode, { href: string; label: string }>> = {
  'needs-you': { href: '/workflows', label: 'All workflows' },
  brief: { href: '/assistant', label: 'Assistant settings' },
  following: { href: '/assistant', label: 'Manage follows' },
  'data-health': { href: '/quality', label: 'Data quality' },
};

export function HomeView({ user, places }: { user: HomeUser; places: HomePlace[] }) {
  const [me, setMe] = useState<{ id: string; displayName: string | null } | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [follows, setFollows] = useState<HomeFollow[] | null>(null);
  const [followsProblem, setFollowsProblem] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [customizing, setCustomizing] = useState(false);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);

  const role = homeRole(user);
  const needsYou = useNeedsYou(me?.id || null, follows, role === 'data-ops');
  const { brief, problem: briefProblem } = useBrief();

  useEffect(() => {
    setNow(new Date());
    let cancelled = false;
    graphqlQuery<{ me: { id: string; displayName: string | null } }>(ME_QUERY, {}, 'network-only').then(async (result) => {
      if (cancelled) return;
      if (isUnauthenticatedGraphqlError(result.error)) {
        if (!browserSessionIsActive()) {
          await goToSignIn('/');
          return;
        }
        setProblem('Sign in to load your home page.');
        return;
      }
      setMe(result.data?.me || null);
    });
    graphqlQuery<{ homeLayout: Layout }>(LAYOUT_QUERY, {}, 'network-only').then((result) => {
      if (cancelled) return;
      // A layout that will not load still leaves a usable page: the role default.
      setLayout(result.data?.homeLayout || { clientId: null, canSave: false, hiddenModules: null, pinnedPlaces: null });
    });
    graphqlQuery<{ homeFollows: HomeFollow[] }>(FOLLOWS_QUERY, {}, 'network-only').then((result) => {
      if (cancelled) return;
      if (result.data?.homeFollows) setFollows(result.data.homeFollows);
      else {
        setFollows([]);
        setFollowsProblem(result.error?.message || 'What you follow could not be loaded.');
      }
    });
    // The setup card's "Pin" step links to #customize.
    const onHash = () => {
      if (window.location.hash === '#customize') setCustomizing(true);
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      cancelled = true;
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  const save = useCallback(
    async (next: Pick<Layout, 'hiddenModules' | 'pinnedPlaces'>) => {
      if (!layout) return;
      const previous = layout;
      setLayout({ ...layout, ...next });
      setSaveProblem(null);
      const result = await graphqlMutation<{ saveHomeLayout: { layout: Layout | null; errors: Array<{ message: string }> } }>(SAVE_LAYOUT, {
        input: next,
      });
      const saved = result.data?.saveHomeLayout;
      if (saved?.layout) setLayout(saved.layout);
      else {
        setLayout(previous);
        setSaveProblem(saved?.errors?.[0]?.message || result.error?.message || 'Your home page could not be saved.');
      }
    },
    [layout],
  );

  const modules = useMemo(() => visibleModules(user, layout?.hiddenModules), [user, layout?.hiddenModules]);
  const pinned = useMemo(() => pinnedPlaces(places, layout?.pinnedPlaces), [places, layout?.pinnedPlaces]);
  const unpinned = places.filter((place) => !pinned.some((pin) => pin.key === place.key));
  const canSave = layout?.canSave === true;

  const summary = useMemo(() => (needsYou ? summarize(needsYou.items, needsYou.urgentExceptionCount) : null), [needsYou]);
  const firstStep = useMemo(() => (needsYou ? groupNeedsYou(needsYou.items)[0] || null : null), [needsYou]);

  const setModule = (code: HomeModuleCode, show: boolean) =>
    save({ hiddenModules: toggleModule(user, layout?.hiddenModules, code, show), pinnedPlaces: layout?.pinnedPlaces ?? null });
  const setPin = (key: string, pin: boolean) =>
    save({ hiddenModules: layout?.hiddenModules ?? null, pinnedPlaces: togglePin(places, layout?.pinnedPlaces, key, pin) });
  const reset = () => save({ hiddenModules: null, pinnedPlaces: null });

  if (problem) {
    return (
      <div className="view-fade home">
        <header className="home-hero">
          <h1 className="home-title">Home unavailable</h1>
          <p className="home-sub">{problem}</p>
        </header>
      </div>
    );
  }

  const isDefault = layout?.hiddenModules == null && layout?.pinnedPlaces == null;
  // An empty brief and an empty follow list say the same thing twice. Show one setup card instead.
  const needsSetup =
    modules.includes('brief') &&
    modules.includes('following') &&
    !!brief &&
    !brief.enabled &&
    !brief.content &&
    follows !== null &&
    follows.length === 0 &&
    !followsProblem;

  const renderModule = (code: HomeModuleCode) => {
    if (needsSetup && code === 'following') return null;
    if (needsSetup && code === 'brief') {
      return (
        <section key="setup" className="home-panel home-module home-module-setup" aria-label="Make this page yours">
          <SetupCard hasFollows={false} briefOn={false} hasPins={layout?.pinnedPlaces != null} />
        </section>
      );
    }
    const def = HOME_MODULES.find((module) => module.code === code)!;
    const link = MODULE_LINKS[code];
    return (
      <section key={code} className={`home-panel home-module home-module-${code}`} aria-label={def.title}>
        <div className="home-section-title">
          <h2>{def.title}</h2>
          <span>
            {link && <Link href={link.href}>{link.label}</Link>}
            {customizing && canSave && (
              <>
                {link && ' · '}
                <button type="button" className="home-link-button" onClick={() => setModule(code, false)}>Hide</button>
              </>
            )}
          </span>
        </div>
        {code === 'needs-you' && <NeedsYouBoard items={needsYou?.items ?? null} />}
        {code === 'brief' &&
          (briefProblem ? <div className="home-empty">{briefProblem}</div> : brief ? <BriefView brief={brief} /> : <div className="home-empty">Loading your brief…</div>)}
        {code === 'places' && <PlacesModule places={pinned} customizing={customizing && canSave} onUnpin={(key) => setPin(key, false)} />}
        {code === 'following' && <FollowingModule follows={follows} problem={followsProblem} />}
        {code === 'data-health' && <DataHealthModule />}
      </section>
    );
  };

  return (
    <div className="view-fade home">
      <header className="home-hero home-hero-row">
        <div className="home-hero-text">
          <p className="home-date">{now?.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) || ' '}</p>
          <h1 className="home-title">{now ? greeting(now, me?.displayName) : ' '}</h1>
          <p className="home-headline">{summary ? headline(summary) : 'Checking what is waiting on you…'}</p>
          {firstStep && (
            <Link href={firstStep.href} className="btn btn-primary home-next">
              {firstStep.kind === 'review' ? 'Start reviewing' : firstStep.lane === 'decide' ? 'Open' : 'Look at'}: {firstStep.title} →
            </Link>
          )}
        </div>
        <button
          type="button"
          className={`btn btn-sm${customizing ? ' btn-primary' : ''}`}
          onClick={() => setCustomizing((value) => !value)}
          aria-expanded={customizing}
          disabled={!layout}
        >
          {customizing ? 'Done' : 'Customize'}
        </button>
      </header>

      {customizing && layout && (
        <section className="home-panel home-customize" id="customize" aria-label="Customize your home page">
          <div className="home-section-title">
            <h2>Customize your home</h2>
            <span className="home-muted">
              {isDefault ? `Showing the default for ${ROLE_LABEL[role].toLowerCase()}` : 'Your own layout'}
              {!isDefault && canSave && (
                <>
                  {' · '}
                  <button type="button" className="home-link-button" onClick={reset}>Reset to default</button>
                </>
              )}
            </span>
          </div>
          {!canSave && <p className="home-warn">Choose one client to save changes. Your home page is kept per client.</p>}
          {saveProblem && <p className="home-warn">{saveProblem}</p>}
          <div className="home-customize-grid">
            <div>
              <h3>Sections</h3>
              {HOME_MODULES.map((module) => (
                <label key={module.code} className="home-toggle">
                  <input
                    type="checkbox"
                    checked={modules.includes(module.code)}
                    disabled={!canSave}
                    onChange={(event) => setModule(module.code, event.target.checked)}
                  />
                  <span>
                    <strong>{module.title}</strong>
                    <span className="home-muted">{module.description}</span>
                  </span>
                </label>
              ))}
            </div>
            <div>
              <h3>Pin a surface</h3>
              {unpinned.length === 0 ? (
                <p className="home-muted">Everything you can open is pinned.</p>
              ) : (
                <div className="home-pin-list">
                  {unpinned.map((place) => (
                    <button key={place.key} type="button" className="btn btn-sm" disabled={!canSave} onClick={() => setPin(place.key, true)}>
                      + {place.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {modules.includes('needs-you') && <FocusTiles summary={summary} showExceptions={role === 'data-ops'} />}

      {!layout ? (
        <div className="home-empty">Loading your home page…</div>
      ) : modules.length === 0 ? (
        <div className="home-empty">
          Every section is hidden.{' '}
          <button type="button" className="home-link-button" onClick={() => setCustomizing(true)}>Customize</button> to bring some back.
        </div>
      ) : (
        <div className="home-modules">{modules.map(renderModule)}</div>
      )}
    </div>
  );
}
