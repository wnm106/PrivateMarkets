'use client';

import { useMemo, useState } from 'react';
import type { Holding, Vehicle } from '../lib/data';
import { ATTR } from '../lib/data';
import { onIssuer, onPosition, onSecurity, recordPath } from '../lib/binds';
import { collateralHow, countHow, diversityHow } from '../lib/how';
import { fmtBps, fmtDay, fmtNum, fmtPct, fmtUsd, fmtYears, words } from '../lib/format';
import { byIndustry, byMaturityYear, byObligor, byRating, type Bucket } from '../lib/view';
import { Bound, BoundOr, Derived, Empty, RecordLink } from './common';

export const COLLATERAL_TAB = {
  label: 'Collateral',
  purpose: 'What the open CLO holds: every loan with its rating, spread, price and flags, and how the book splits by industry, rating, maturity and obligor.',
};

const SHOWN = 200;

function BucketTable({ v, title, rows, note, diversity }: { v: Vehicle; title: string; rows: Bucket[]; note?: string; diversity?: boolean }) {
  const units = new Map(v.diversity.industries.map((i) => [i.industry, i]));
  return (
    <div>
      <h3 className="x-subhead">{title}</h3>
      <div className="x-frame x-short">
        <table className="da-grid x-table">
          <thead>
            <tr>
              <th className="x-name">{title}</th>
              <th className="num">Holdings</th>
              <th className="num">Par</th>
              <th className="num">Share</th>
              {diversity && <th className="num" title="Moody's industry diversity score">Diversity</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => {
              const how = () => countHow(`${v.name} · ${b.label}`, fmtUsd(b.par), `Funded par of the holdings in ${b.label}, added up${b.pct != null ? `; the share is that over ${title === 'Obligor' ? 'performing' : 'collateral'} par` : ''}.`,
                b.holdings.slice(0, 12).map((h) => ({ label: h.name, value: fmtUsd(h.par), bind: onPosition(h, ATTR.par, 'Funded par') })));
              const d = units.get(b.key);
              return (
                <tr key={b.key}>
                  <td className="x-name">{b.label}</td>
                  <td className="num"><Derived name={`${b.label} holdings`} how={how}>{b.count}</Derived></td>
                  <td className="num"><Derived name={`${b.label} par`} how={how}>{fmtUsd(b.par)}</Derived></td>
                  <td className="num"><Derived name={`${b.label} share`} how={how}>{fmtPct(b.pct, 1)}</Derived></td>
                  {diversity && <td className="num">{d ? <Derived name={`${b.label} diversity`} how={() => diversityHow(v)}>{fmtNum(d.score, 2)}</Derived> : <span className="x-nil">—</span>}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {note && <p className="x-note">{note}</p>}
    </div>
  );
}

function Flags({ h }: { h: Holding }) {
  const flags: Array<{ text: string; code: string; on: 'security' | 'position'; bad?: boolean }> = [];
  if (h.defaulted) flags.push({ text: 'Defaulted', code: ATTR.defaulted, on: 'security', bad: true });
  if (h.ccc) flags.push({ text: 'CCC', code: ATTR.ccc, on: 'security', bad: true });
  if (h.covLite) flags.push({ text: 'Cov-lite', code: ATTR.covLite, on: 'security' });
  if (h.fixedRate) flags.push({ text: 'Fixed', code: ATTR.fixedRate, on: 'security' });
  if (h.discount) flags.push({ text: 'Discount', code: ATTR.discount, on: 'position' });
  if (!flags.length) return <span className="x-nil">—</span>;
  return (
    <span className="x-flags">
      {flags.map((f) => {
        const bind = f.on === 'security' ? onSecurity(h, f.code, f.text) : onPosition(h, f.code, f.text);
        return bind ? <Bound key={f.text} {...bind} value="Yes" className={`x-flag${f.bad ? ' bad' : ''}`}>{f.text}</Bound> : <span key={f.text} className="x-flag">{f.text}</span>;
      })}
    </span>
  );
}

export function CollateralTab({ v }: { v: Vehicle }) {
  const [industry, setIndustry] = useState('');
  const [flag, setFlag] = useState('');
  const [text, setText] = useState('');
  const industries = useMemo(() => [...new Set(v.holdings.map((h) => h.industry || ''))].filter(Boolean).sort(), [v]);
  const list = v.holdings.filter((h) =>
    (!industry || h.industry === industry)
    && (!flag || (flag === 'ccc' && h.ccc) || (flag === 'defaulted' && h.defaulted) || (flag === 'covlite' && h.covLite) || (flag === 'secondlien' && h.lien === 'SECOND_LIEN') || (flag === 'fixed' && h.fixedRate) || (flag === 'discount' && h.discount))
    && (!text || `${h.name} ${h.issuer} ${h.obligorGroup || ''}`.toLowerCase().includes(text.toLowerCase())));
  const c = v.collateral;
  if (!v.holdings.length) return <Empty>This CLO holds nothing on the As Of date.</Empty>;
  const filteredPar = list.reduce((s, h) => s + h.par, 0);
  return (
    <>
      <div className="x-cards">
        <div className="x-card na"><header><b>Performing par</b></header><span className="x-big"><Derived name="Performing par" how={() => collateralHow(v, 'performingPar')}>{fmtUsd(c.performingPar)}</Derived></span>
          <dl><dt>Defaulted</dt><dd><Derived name="Defaulted par" how={() => collateralHow(v, 'defaultedPar')}>{fmtUsd(c.defaultedPar)}</Derived></dd><dt>Market value</dt><dd><Derived name="Market value" how={() => collateralHow(v, 'marketValue')}>{fmtUsd(c.marketValue)}</Derived></dd><dt>Weighted price</dt><dd><Derived name="Weighted price" how={() => collateralHow(v, 'weightedPrice')}>{fmtNum(c.weightedPrice, 2)}</Derived></dd></dl></div>
        <div className="x-card na"><header><b>Obligors</b></header><span className="x-big"><Derived name="Obligors" how={() => collateralHow(v, 'obligors')}>{c.obligors}</Derived></span>
          <dl><dt>Largest obligor</dt><dd><Derived name="Largest obligor" how={() => collateralHow(v, 'largestObligorPct')}>{fmtPct(c.largestObligorPct)}</Derived></dd><dt>Diversity score</dt><dd><Derived name="Diversity score" how={() => diversityHow(v)}>{fmtNum(v.diversity.score, 1)}</Derived></dd></dl></div>
        <div className="x-card na"><header><b>Credit quality</b></header><span className="x-big"><Derived name="CCC share" how={() => collateralHow(v, 'cccPct')}>{fmtPct(c.cccPct)}</Derived></span>
          <dl><dt>Cov-lite</dt><dd><Derived name="Cov-lite share" how={() => countHow(`${v.name} · Cov-lite`, fmtPct(c.covLitePct), 'Performing par of covenant-lite loans (IS_COV_LITE) over performing par.')}>{fmtPct(c.covLitePct)}</Derived></dd>
            <dt>Second lien</dt><dd><Derived name="Second lien share" how={() => countHow(`${v.name} · Second lien`, fmtPct(c.secondLienPct), 'Performing par of second lien loans (LIEN_PRIORITY) over performing par.')}>{fmtPct(c.secondLienPct)}</Derived></dd>
            <dt>Fixed rate</dt><dd><Derived name="Fixed rate share" how={() => countHow(`${v.name} · Fixed rate`, fmtPct(c.fixedRatePct), 'Performing par of fixed rate obligations (IS_FIXED_RATE) over performing par.')}>{fmtPct(c.fixedRatePct)}</Derived></dd></dl></div>
        <div className="x-card na"><header><b>Interest collections</b></header><span className="x-big"><Derived name="Interest collections" how={() => collateralHow(v, 'interestProceeds')}>{fmtUsd(c.interestProceeds)}</Derived></span>
          <dl><dt>Principal cash</dt><dd><Derived name="Principal cash" how={() => countHow(`${v.name} · Principal cash`, fmtUsd(c.principalCash), 'Balance of the principal collection account(s).', v.accounts.filter((a) => a.type === 'PRINCIPAL').map((a) => ({ label: a.name, value: fmtUsd(a.balance), bind: { entityId: a.id, entityName: a.name, domainCode: 'CLO_ACCOUNT', code: ATTR.acctBalance, name: 'Balance' } })))}>{fmtUsd(c.principalCash)}</Derived></dd></dl></div>
      </div>

      <div className="x-section">
        <h2>Holdings</h2>
        <div className="x-toolbar">
          <label>Industry <select value={industry} onChange={(e) => setIndustry(e.target.value)}><option value="">All industries</option>{industries.map((i) => <option key={i} value={i}>{i}</option>)}</select></label>
          <label>Flag <select value={flag} onChange={(e) => setFlag(e.target.value)}>
            <option value="">Any</option><option value="ccc">CCC</option><option value="defaulted">Defaulted</option><option value="covlite">Covenant-lite</option>
            <option value="secondlien">Second lien</option><option value="fixed">Fixed rate</option><option value="discount">Discount</option>
          </select></label>
          <label>Find <input className="x-search" value={text} placeholder="Loan, obligor or group" onChange={(e) => setText(e.target.value)} /></label>
          <span className="x-mut">{list.length === v.holdings.length ? `${list.length} holdings` : `${list.length} of ${v.holdings.length} holdings, ${fmtUsd(filteredPar)}`}</span>
        </div>
        {!list.length ? <Empty>No holding matches the filters.</Empty> : (
          <div className="x-frame">
            <table className="da-grid x-table">
              <thead>
                <tr>
                  <th className="x-name">Loan and obligor</th>
                  <th>Industry</th>
                  <th className="num">Par</th>
                  <th className="num">Share</th>
                  <th className="num">Price</th>
                  <th>Moody&rsquo;s</th>
                  <th>S&amp;P</th>
                  <th className="num">Factor</th>
                  <th className="num">Spread</th>
                  <th>Maturity</th>
                  <th className="num">Life</th>
                  <th>Lien</th>
                  <th>Flags</th>
                </tr>
              </thead>
              <tbody>
                {list.slice(0, SHOWN).map((h) => (
                  <tr key={h.positionId}>
                    <td className="x-name">
                      <div className="x-namebox">
                        {h.securityId ? <RecordLink path={recordPath.security(h.securityId)}>{h.name}</RecordLink> : <RecordLink path={recordPath.position(h.positionId)}>{h.name}</RecordLink>}
                        <small>{h.issuerId ? <RecordLink path={recordPath.issuer(h.issuerId)}>{h.issuer}</RecordLink> : h.issuer}{h.obligorGroup ? <> · <BoundOr bind={onIssuer(h, ATTR.obligorGroup, 'Obligor group')} value={h.obligorGroup} shown={h.obligorGroup} /></> : null}</small>
                      </div>
                    </td>
                    <td><BoundOr bind={onIssuer(h, ATTR.industry, 'Moody’s industry')} value={h.industry} shown={h.industry || ''} /></td>
                    <td className="num"><Bound {...onPosition(h, ATTR.par, 'Funded par')} value={fmtUsd(h.par)}>{fmtUsd(h.par)}</Bound></td>
                    <td className="num"><Derived name={`${h.name} share`} how={() => countHow(`${h.name} · Share`, fmtPct(h.sharePct), 'The holding’s funded par over collateral par.', [{ label: h.name, value: fmtUsd(h.par), bind: onPosition(h, ATTR.par, 'Funded par') }, { label: 'Collateral par', value: fmtUsd(c.par) }])}>{fmtPct(h.sharePct)}</Derived></td>
                    <td className="num"><BoundOr bind={onPosition(h, ATTR.price, 'Price')} value={h.price} shown={fmtNum(h.price, 2)} /></td>
                    <td><BoundOr bind={onSecurity(h, ATTR.moodys, 'Moody’s facility rating')} value={h.ratingMoodys} shown={h.ratingMoodys || ''} /></td>
                    <td><BoundOr bind={onSecurity(h, ATTR.sp, 'S&P facility rating')} value={h.ratingSp} shown={h.ratingSp || ''} /></td>
                    <td className="num"><BoundOr bind={onSecurity(h, ATTR.factor, 'Moody’s rating factor')} value={h.factor} shown={fmtNum(h.factor)} /></td>
                    <td className="num"><BoundOr bind={onSecurity(h, ATTR.spread, 'Spread')} value={h.fixedRate ? null : h.spreadBps} shown={fmtBps(h.spreadBps)} /></td>
                    <td><BoundOr bind={onSecurity(h, ATTR.maturity, 'Maturity date')} value={h.maturity} shown={fmtDay(h.maturity)} /></td>
                    <td className="num">{h.lifeYears == null ? <span className="x-nil">—</span> : <Derived name={`${h.name} life`} how={() => countHow(`${h.name} · Remaining life`, fmtYears(h.lifeYears), 'Years from the As Of date to the loan’s maturity date. The WAL test weights this by par.', [{ label: 'Maturity date', value: fmtDay(h.maturity), bind: onSecurity(h, ATTR.maturity, 'Maturity date') ?? undefined }])}>{fmtYears(h.lifeYears)}</Derived>}</td>
                    <td><BoundOr bind={onSecurity(h, ATTR.lien, 'Lien priority')} value={h.lien} shown={words(h.lien)} /></td>
                    <td><Flags h={h} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.length > SHOWN && <p className="x-note">Showing the {SHOWN} largest of {list.length}. Narrow the filters to see the rest.</p>}
      </div>

      <div className="x-section x-cols">
        <BucketTable v={v} title="Industry" rows={byIndustry(v)} diversity note="Moody's industry of each obligor. Diversity is the industry's score in the Moody's diversity table." />
        <BucketTable v={v} title="Moody's rating" rows={byRating(v)} />
      </div>
      <div className="x-section x-cols">
        <BucketTable v={v} title="Maturity year" rows={byMaturityYear(v)} />
        <BucketTable v={v} title="Obligor" rows={byObligor(v).slice(0, 15)} note="The 15 largest obligor groups, performing par only." />
      </div>
    </>
  );
}
