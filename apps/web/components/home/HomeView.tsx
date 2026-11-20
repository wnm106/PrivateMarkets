'use client';

import { AgentsAtWork, useAgentsBoard } from '@/components/home/AgentsAtWork';
import { usePublishPageData } from '@/lib/view-context';
import { HomeComposer } from '@/components/home/HomeComposer';
import { HOME_SCOPE_KEY, UNIVERSE_QUERY, isNarrowed, narrowNeedsYou, parseScope, universeLabel, type HomeScope, type Universe } from '@/lib/home-universe';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { goToSignIn } from '@/components/layout/UserMenu';
import { browserSessionIsActive } from '@/lib/auth-token';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { isUnauthenticatedGraphqlError } from '@/lib/safe-next-path';
import {
  HOME_MODULES,
  ROLE_LABEL,
  agentLine,
  greeting,
  groupNeedsYou,
  headline,
  heroLead,
  homePageData,
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
  NeedsYouQueue,
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
  agents: { href: '/admin/agents', label: 'Agents' },
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
  // Bumped when the composer starts a run, so the agents panel shows it at once.
  const [runsStarted, setRunsStarted] = useState(0);
  // What the person follows and is responsible for, and whether the page is narrowed to it.
  const [universe, setUniverse] = useState<Universe | null>(null);
  const [scope, setScope] = useState<HomeScope>('mine');

  const role = homeRole(user);
  const allNeedsYou = useNeedsYou(me?.id || null, follows, role === 'data-ops');
  const narrowed = isNarrowed(universe, scope);
  const needsYou = useMemo(() => {
    if (!allNeedsYou) return null;
    const mine = narrowNeedsYou(allNeedsYou.items, allNeedsYou.reviews, universe?.reviewIds || [], narrowed);
    return { ...allNeedsYou, items: mine.items, reviews: mine.reviews, hiddenReviews: mine.hiddenReviews };
  }, [allNeedsYou, universe, narrowed]);

  useEffect(() => {
    try {
      setScope(parseScope(window.localStorage.getItem(HOME_SCOPE_KEY)));
    } catch {
      // Private mode: the choice just is not remembered.
    }
    let cancelled = false;
    // A person with no universe, or one this cannot be read for, sees everything, as before.
    void graphqlQuery<{ myUniverse: Universe }>(UNIVERSE_QUERY, {}, 'network-only').then((result) => {
      if (!cancelled) setUniverse(result.data?.myUniverse || null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const chooseScope = (next: HomeScope) => {
    setScope(next);
    try {
      window.localStorage.setItem(HOME_SCOPE_KEY, next);
    } catch {
      // Not remembered. The page still switches.
    }
  };
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
  const allGroups = useMemo(() => (needsYou ? groupNeedsYou(needsYou.items) : null), [needsYou]);
  const firstStep = allGroups?.[0] || null;
  const lead = useMemo(() => (allGroups ? heroLead(allGroups) : null), [allGroups]);
  const agents = useAgentsBoard(runsStarted, narrowed);

  // The assistant reads what this page says, the same way the page says it.
  usePublishPageData(
    homePageData({
      headline: lead ? `${lead.lead}${lead.start ? ` — start with ${lead.start}` : ''}.` : 'Loading',
      scope: universe?.hasAny ? (narrowed ? 'mine' : 'all') : null,
      groups: allGroups,
      hiddenReviews: narrowed ? needsYou?.hiddenReviews ?? 0 : 0,
      agents: agentLine(agents.board),
    }),
  );

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

  const shows = (code: HomeModuleCode) => modules.includes(code);

  /** One titled panel. Customize adds a way to hide it. */
  const panel = (code: HomeModuleCode, body: React.ReactNode, options: { id?: string; title?: string; aside?: React.ReactNode; className?: string } = {}) => {
    const def = HOME_MODULES.find((module) => module.code === code)!;
    const link = MODULE_LINKS[code];
    return (
      <section key={code} id={options.id} className={`hx-panel hx-panel-${code}${options.className ? ` ${options.className}` : ''}`} aria-label={options.title || def.title}>
        <div className="hx-panel-head">
          <h2>{options.title || def.title}</h2>
          <span className="hx-panel-tools">
            {options.aside}
            {link && <Link href={link.href}>{link.label}</Link>}
            {customizing && canSave && (
              <button type="button" className="home-link-button" onClick={() => setModule(code, false)}>Hide</button>
            )}
          </span>
        </div>
        {body}
      </section>
    );
  };

  const scopeSwitch = universe?.hasAny ? (
    <span className="hx-scope" role="group" aria-label="What this page shows" title={narrowed ? `Reviews and runs for ${universeLabel(universe)}, and anything assigned to you.` : 'Every review and run you can see.'}>
      <button type="button" className={`hx-scope-option${narrowed ? ' is-on' : ''}`} aria-pressed={narrowed} onClick={() => chooseScope('mine')}>
        My records
      </button>
      <button type="button" className={`hx-scope-option${narrowed ? '' : ' is-on'}`} aria-pressed={!narrowed} onClick={() => chooseScope('all')}>
        Everything
      </button>
    </span>
  ) : null;

  const railModules = (['agents', 'following', 'data-health'] as const).filter((code) => shows(code) && !(needsSetup && code === 'following'));
  const mainModules = (['needs-you', 'brief'] as const).filter((code) => shows(code) && !(needsSetup && code === 'brief'));
  const waitingCount = allGroups?.length ?? 0;

  return (
    <div className="view-fade home hx">
      <header className="hx-hero">
        <div className="hx-hero-text">
          <p className="hx-eyebrow">
            {now?.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) || ' '}
            <span aria-hidden> · </span>Your briefing
          </p>
          <h1 className="hx-title">
            {now ? greeting(now, me?.displayName) : ' '}.{' '}
            <span className="hx-title-lead">
              {lead ? (
                <>
                  {lead.lead}
                  {lead.start && (
                    <>
                      {' '}— start with <em>{lead.start}</em>
                    </>
                  )}
                  .
                </>
              ) : (
                'Getting your briefing ready…'
              )}
            </span>
          </h1>
          <p className="hx-lede">
            {summary ? headline(summary) : ''} {agents.board || agents.problem ? agentLine(agents.board) : ''}
          </p>
          <div className="hx-hero-actions">
            {firstStep && (
              <Link href={firstStep.href} className="btn btn-primary hx-cta">
                {firstStep.lane === 'decide' ? 'Start reviewing' : 'See what broke'} <span aria-hidden>→</span>
              </Link>
            )}
            {waitingCount > 1 && shows('needs-you') && (
              <a href="#needs-you" className="btn hx-cta-secondary">
                See all {waitingCount}
              </a>
            )}
            <button
              type="button"
              className={`btn btn-sm hx-customize${customizing ? ' btn-primary' : ''}`}
              onClick={() => setCustomizing((value) => !value)}
              aria-expanded={customizing}
              disabled={!layout}
            >
              {customizing ? 'Done' : 'Customize'}
            </button>
          </div>
        </div>
        {shows('needs-you') && <FocusTiles summary={summary} showExceptions={role === 'data-ops'} />}
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

      <HomeComposer summary={summary} onStarted={() => setRunsStarted((count) => count + 1)} />

      {shows('places') && (
        <section className="hx-jump" aria-label="Jump back in">
          <div className="hx-section-label">
            <h2>Jump back in</h2>
            {customizing && canSave && (
              <button type="button" className="home-link-button" onClick={() => setModule('places', false)}>Hide</button>
            )}
          </div>
          <PlacesModule places={pinned} customizing={customizing && canSave} onUnpin={(key) => setPin(key, false)} />
        </section>
      )}

      {!layout ? (
        <div className="home-empty">Loading your home page…</div>
      ) : modules.length === 0 ? (
        <div className="home-empty">
          Every section is hidden.{' '}
          <button type="button" className="home-link-button" onClick={() => setCustomizing(true)}>Customize</button> to bring some back.
        </div>
      ) : (
        <div className={`hx-grid${mainModules.length === 0 && !needsSetup ? ' is-single' : ''}${railModules.length === 0 ? ' is-single' : ''}`}>
          {(mainModules.length > 0 || needsSetup) && (
            <div className="hx-main">
              {shows('needs-you') &&
                panel(
                  'needs-you',
                  <NeedsYouQueue
                    items={needsYou?.items ?? null}
                    reviews={needsYou?.reviews}
                    hiddenReviews={narrowed ? needsYou?.hiddenReviews ?? 0 : 0}
                    onShowEverything={() => chooseScope('all')}
                  />,
                  { id: 'needs-you', aside: scopeSwitch },
                )}
              {/* An empty brief and an empty follow list are one setup checklist, where the brief would be. */}
              {needsSetup && (
                <section className="hx-panel hx-panel-setup" aria-label="Make this page yours">
                  <SetupCard hasFollows={false} briefOn={false} hasPins={layout?.pinnedPlaces != null} />
                </section>
              )}
              {mainModules.includes('brief') &&
                panel(
                  'brief',
                  briefProblem ? <div className="home-empty">{briefProblem}</div> : brief ? <BriefView brief={brief} /> : <div className="home-empty">Loading your brief…</div>,
                )}
            </div>
          )}
          {railModules.length > 0 && (
            <aside className="hx-rail" aria-label="Around you">
              {railModules.map((code) => {
                if (code === 'agents') {
                  const live = (agents.board?.running ?? 0) > 0;
                  return panel(code, <AgentsAtWork board={agents.board} problem={agents.problem} mine={narrowed} />, {
                    aside: (
                      <span className={`hx-live${live ? ' is-live' : ''}`}>
                        <span className="hx-dot" aria-hidden />
                        {live ? `${agents.board?.running} running` : agents.board?.waiting ? `${agents.board.waiting} paused for review` : 'idle'}
                      </span>
                    ),
                  });
                }
                if (code === 'following') return panel(code, <FollowingModule follows={follows} problem={followsProblem} />);
                return panel(code, <DataHealthModule />);
              })}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
