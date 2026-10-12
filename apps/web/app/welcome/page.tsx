import Link from 'next/link';
import Image from 'next/image';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'tapestr.ai - One source of truth for private markets data',
  description:
    'Golden records, source precedence, full lineage and AI-assisted data management for private markets investors.',
};

/** Logo asset is 1024x256 (4:1) on a white background. */
function Logo({ height, priority = false }: { height: number; priority?: boolean }) {
  return (
    <Image
      src="/tapestrai.jpg"
      alt="tapestr.ai"
      width={height * 4}
      height={height}
      priority={priority}
      unoptimized
      style={{ height, width: 'auto' }}
    />
  );
}

const FEATURES = [
  {
    title: 'Golden records',
    body: 'Consolidate funds, issuers, securities, deals, investors and positions from every system into a single trusted record.',
    icon: <path d="M12 2 2 7l10 5 10-5-10-5ZM2 12l10 5 10-5M2 17l10 5 10-5" />,
  },
  {
    title: 'Source precedence',
    body: 'Field-level, conditional rules decide which source wins - Bloomberg, DealCloud, Allvue, manual overrides and more.',
    icon: <path d="M3 6h18M3 12h14M3 18h8" />,
  },
  {
    title: 'Complete lineage',
    body: 'Trace every attribute back to the source, file and moment it came from. Audit-ready by design.',
    icon: <path d="M6 3v12a3 3 0 0 0 3 3h9M18 14l3 4-3 4M6 3a2 2 0 1 0 0 .01" />,
  },
  {
    title: 'Bi-temporal history',
    body: 'Query the data as it is, as it was, and as it was known - restate and correct without losing history.',
    icon: <path d="M12 6v6l4 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />,
  },
  {
    title: 'Data quality & compliance',
    body: 'Configurable DQ and compliance rules surface exceptions early, with stewardship workflows to resolve them.',
    icon: <path d="M9 12l2 2 4-4M12 3l8 3v6c0 4.5-3.2 8.3-8 9-4.8-.7-8-4.5-8-9V6l8-3Z" />,
  },
  {
    title: 'AI-assisted insight',
    body: 'Ask questions in plain language, generate reports and narratives, and let the assistant explain the data.',
    icon: <path d="M12 3l1.8 4.7L18.5 9l-4.7 1.8L12 15.5l-1.8-4.7L5.5 9l4.7-1.3L12 3ZM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" />,
  },
];

const STEPS = [
  { n: '1', title: 'Connect', body: 'Bring in data from custodians, vendors, CRMs and spreadsheets through configurable import maps.' },
  { n: '2', title: 'Reconcile', body: 'Normalize, match and apply precedence rules to resolve conflicts automatically.' },
  { n: '3', title: 'Govern', body: 'Monitor quality, review exceptions and keep a full audit trail of every change.' },
  { n: '4', title: 'Deliver', body: 'Publish trusted data to dashboards, narratives and downstream systems.' },
];

const PILLARS = [
  { big: 'Field-level', small: 'lineage on every attribute' },
  { big: 'Bi-temporal', small: 'history, restatements & as-of views' },
  { big: 'Multi-tenant', small: 'client isolation with role-based access' },
  { big: 'AI-native', small: 'assistant, reports & narratives' },
];

const SOURCES = ['Bloomberg', 'DealCloud', 'Allvue', 'WSO', 'S&P Capital IQ', 'Excel / CSV'];

function LoginIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  );
}

/** Stylised product preview shown in the hero. */
function ProductPreview() {
  const rows = [
    { f: 'Legal name', v: 'Northwind Capital Partners IV', s: 'DealCloud', c: '#0369a1' },
    { f: 'Vintage', v: '2022', s: 'Allvue', c: '#047857' },
    { f: 'Currency', v: 'USD', s: 'Bloomberg', c: '#c2410c' },
    { f: 'Committed capital', v: '$1,250,000,000', s: 'Manual override', c: '#b45309' },
    { f: 'Strategy', v: 'Senior Secured Direct Lending', s: 'WSO', c: '#6d28d9' },
  ];
  return (
    <div className="relative mx-auto max-w-5xl">
      <div className="absolute -inset-4 rounded-[2rem] bg-gradient-to-r from-brand-blue/30 via-brand-cyan/30 to-brand-blue/30 blur-2xl" aria-hidden="true" />
      <div className="relative rounded-2xl border border-line-strong bg-white shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 bg-bg border-b border-line">
          <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
          <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
          <span className="w-3 h-3 rounded-full bg-[#28c840]" />
          <span className="ml-3 text-xs text-ink-3 font-mono">app.tapestr.ai / funds / Northwind Capital Partners IV</span>
        </div>
        <div className="grid md:grid-cols-3 gap-0">
          <div className="md:col-span-2 p-6 text-left">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="text-xs uppercase tracking-widest text-ink-3">Golden record</div>
                <div className="text-xl font-semibold">Northwind Capital Partners IV</div>
              </div>
              <span className="text-xs font-semibold text-green bg-green/10 px-2.5 py-1 rounded-full">Verified</span>
            </div>
            <div className="divide-y divide-line border border-line rounded-lg">
              {rows.map((r) => (
                <div key={r.f} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="text-ink-3 w-40">{r.f}</span>
                  <span className="flex-1 font-medium">{r.v}</span>
                  <span className="flex items-center gap-1.5 text-xs text-ink-2">
                    <span className="w-2 h-2 rounded-full" style={{ background: r.c }} />
                    {r.s}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="p-6 bg-bg border-l border-line text-left">
            <div className="text-xs uppercase tracking-widest text-ink-3 mb-3">Data quality</div>
            <div className="text-4xl font-display font-semibold text-brand-blue">98.4%</div>
            <div className="mt-2 h-2 rounded-full bg-line overflow-hidden">
              <div className="h-full w-[98%] bg-gradient-to-r from-brand-blue to-brand-cyan" />
            </div>
            <div className="mt-6 text-xs uppercase tracking-widest text-ink-3 mb-2">Source conflicts</div>
            <div className="text-sm rounded-lg bg-white border border-line p-3">
              <div className="font-medium">Committed capital</div>
              <div className="text-ink-3 mt-1">Allvue and manual entry differ. Precedence rule applied.</div>
            </div>
            <div className="mt-4 text-sm rounded-lg bg-gradient-to-r from-brand-blue to-brand-cyan text-white p-3">
              Ask tapestr.ai: &ldquo;Why does this value differ from last quarter?&rdquo;
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function WelcomePage() {
  return (
    <div className="min-h-screen bg-white text-ink">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-line shadow-[0_1px_0_rgba(10,22,40,0.04)]">
        <div className="h-1 bg-gradient-to-r from-brand-navy via-brand-blue to-brand-cyan" />
        <div className="max-w-7xl mx-auto flex items-center justify-between px-6 py-3">
          <Link href="/welcome" aria-label="tapestr.ai home">
            <Logo height={64} priority />
          </Link>
          <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-ink-2">
            <a href="#platform" className="hover:text-brand-blue">Platform</a>
            <a href="#how" className="hover:text-brand-blue">How it works</a>
            <a href="#trust" className="hover:text-brand-blue">Security</a>
          </nav>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-white text-sm font-semibold bg-gradient-to-r from-brand-blue to-brand-cyan shadow-lg shadow-brand-cyan/30 hover:brightness-110"
            aria-label="Log in"
          >
            <LoginIcon />
            Log in
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden bg-[radial-gradient(ellipse_at_top,rgba(0,163,255,0.22),transparent_55%),radial-gradient(circle_at_100%_60%,rgba(30,64,175,0.14),transparent_45%),radial-gradient(circle_at_0%_80%,rgba(0,163,255,0.10),transparent_40%)]">
        <div className="max-w-7xl mx-auto px-6 pt-20 pb-24 text-center">
          <div className="inline-block text-xs font-semibold tracking-widest uppercase text-brand-blue bg-brand-blue/10 rounded-full px-4 py-1.5">
            Master Data Management for Private Markets
          </div>
          <h1 className="mt-6 font-display text-5xl md:text-7xl font-semibold tracking-tight leading-[1.05]">
            One{' '}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-brand-blue to-brand-cyan">source of truth</span>,
            <br />
            across every system.
          </h1>
          <p className="mt-6 max-w-3xl mx-auto text-xl text-ink-3 leading-relaxed">
            tapestr.ai weaves together the funds, issuers, securities, deals and positions scattered
            across your vendors and platforms into one governed, fully traceable record - so your
            team can trust every number.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/login"
              className="px-8 py-4 rounded-xl text-white text-base font-semibold bg-gradient-to-r from-brand-blue to-brand-cyan shadow-xl shadow-brand-cyan/30 hover:brightness-110"
            >
              Log in to tapestr.ai
            </Link>
            <a href="#platform" className="px-8 py-4 rounded-xl border border-line-strong bg-white text-base font-semibold hover:bg-bg">
              Explore the platform
            </a>
          </div>

          <div className="mt-20">
            <ProductPreview />
          </div>
        </div>
      </section>

      {/* Source strip */}
      <section className="border-y border-line bg-white">
        <div className="max-w-7xl mx-auto px-6 py-8 text-center">
          <div className="text-xs font-semibold uppercase tracking-widest text-ink-3 mb-4">
            Unifies the systems your team already uses
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-12 gap-y-3 text-lg font-semibold text-ink-4">
            {SOURCES.map((s) => (
              <span key={s}>{s}</span>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="platform" className="max-w-7xl mx-auto px-6 py-24 scroll-mt-20">
        <div className="text-center mb-14">
          <div className="text-xs font-semibold tracking-widest uppercase text-brand-sky mb-3">The platform</div>
          <h2 className="font-display text-4xl font-semibold">Built for data you can defend</h2>
          <p className="text-lg text-ink-3 mt-3">Everything you need to unify, govern and deliver investment data.</p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="group rounded-2xl border border-line bg-white p-8 shadow-sm hover:shadow-xl hover:-translate-y-0.5 hover:border-brand-cyan/50 transition-all"
            >
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-brand-blue to-brand-cyan text-white flex items-center justify-center mb-5 shadow-md shadow-brand-cyan/30">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {f.icon}
                </svg>
              </div>
              <h3 className="text-xl font-semibold mb-2">{f.title}</h3>
              <p className="text-base text-ink-3 leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pillars band */}
      <section id="trust" className="bg-gradient-to-br from-brand-navy via-brand-blue to-brand-sky text-white scroll-mt-20">
        <div className="max-w-7xl mx-auto px-6 py-16">
          <h2 className="font-display text-3xl font-semibold text-center mb-12">Enterprise-grade from the ground up</h2>
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4 text-center">
            {PILLARS.map((p) => (
              <div key={p.big}>
                <div className="font-display text-4xl font-semibold">{p.big}</div>
                <div className="mt-2 text-white/75">{p.small}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="bg-bg scroll-mt-20">
        <div className="max-w-7xl mx-auto px-6 py-24">
          <h2 className="font-display text-4xl font-semibold text-center mb-14">How it works</h2>
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s) => (
              <div key={s.n} className="text-center">
                <div className="mx-auto mb-5 w-14 h-14 rounded-full bg-gradient-to-br from-brand-blue to-brand-cyan text-white text-xl font-semibold flex items-center justify-center shadow-lg shadow-brand-cyan/30">
                  {s.n}
                </div>
                <h3 className="text-lg font-semibold mb-2">{s.title}</h3>
                <p className="text-ink-3 leading-relaxed">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-gradient-to-br from-brand-navy via-brand-blue to-brand-cyan text-white">
        <div className="max-w-4xl mx-auto px-6 py-20 text-center">
          <div className="inline-flex rounded-2xl bg-white px-8 py-4 shadow-2xl mb-8">
            <Logo height={56} />
          </div>
          <h2 className="font-display text-4xl font-semibold">Ready to see your data clearly?</h2>
          <p className="mt-3 text-lg text-white/80">Access is limited to authorized users.</p>
          <Link href="/login" className="inline-block mt-8 px-8 py-4 rounded-xl bg-white text-brand-blue text-base font-semibold shadow-xl hover:bg-bg">
            Log in
          </Link>
        </div>
      </section>

      <footer className="bg-white border-t border-line">
        <div className="max-w-7xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <Logo height={36} />
          <div className="text-sm text-ink-3">&copy; {new Date().getFullYear()} tapestr.ai. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
}
