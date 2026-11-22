'use client';

import type { RecCheck } from '@tapestrai/graphql/src/lib/fund-rec';
import type { PackReview, PackStatus } from '@tapestrai/graphql/src/lib/nav-pack';
import { millions, signedMillions } from '@/lib/fund-rec';

const STATUS_TONE: Record<PackStatus, string> = {
  Ties: 'ok', Breaks: 'breach', Open: 'near', Partial: 'near', 'Not on file': 'blocked', 'Not expected': 'na',
};

const pct = (value: number | null | undefined, digits = 1) => (value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)}%`);
const rate = (value: number | null | undefined) => (value == null || !Number.isFinite(value) ? '—' : value.toFixed(4));

/** A check's two figures, as dollars, a count or a percentage, by what the check compares. */
function checkFigure(check: RecCheck, value: number | null): string {
  if (value == null) return '—';
  if (/^(pcapOwnership|valuationCoverage|thirdParty|fxHedge)$/.test(check.id)) return pct(value, 2);
  if (Math.abs(value) < 1000 && Number.isInteger(value)) return String(value);
  return millions(value);
}

/** The administrator's NAV pack, part by part: what is on file, what it is checked against, and where each part stands. */
export function NavPackTab({ pack, checks }: { pack: PackReview; checks: RecCheck[] }) {
  const byId = new Map(checks.map((check) => [check.id, check]));
  const expected = pack.components.filter((part) => part.expected);
  const onFile = expected.filter((part) => part.onFile).length;
  return (
    <>
      <section className="da-sec">
        <div className="da-sechead">
          <h2>NAV pack</h2>
          <p>{onFile} of {expected.length} parts this fund's pack should hold are on file. Each part is checked against the statements and the others; a required part that is missing or breaks blocks certification.</p>
        </div>
        <div className="da-gridwrap">
          <table className="da-grid">
            <thead><tr><th>Part</th><th>Status</th><th>On file</th><th className="num">Checks</th><th>Owner</th></tr></thead>
            <tbody>
              {pack.components.map((part) => {
                const mine = part.checks.map((id) => byId.get(id)).filter((check): check is RecCheck => Boolean(check));
                const ties = mine.filter((check) => check.result === 'Ties').length;
                return (
                  <tr key={part.key} className={part.status === 'Breaks' ? 'flag' : ''}>
                    <td><b>{part.label}</b>{part.required && <span className="da-st bind da-gap">Required</span>}<br /><small>{part.covers}</small></td>
                    <td><span className={`da-st ${STATUS_TONE[part.status]}`}>{part.status}</span></td>
                    <td>{part.detail}</td>
                    <td className="num">{mine.length ? `${ties} of ${mine.length} tie` : '—'}</td>
                    <td>{part.owner}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="da-sec">
        <div className="da-sechead"><h2>NAV bridge</h2><p>Opening NAV to closing NAV, movement by movement, from the statements. $M.</p></div>
        <div className="da-gridwrap">
          <table className="da-grid da-roll">
            <tbody>
              <tr><td>Opening NAV</td><td className="num">{millions(pack.bridge.opening)}</td></tr>
              {pack.bridge.steps.map((step) => <tr key={step.key} className="indent"><td>{step.label}</td><td className="num">{signedMillions(step.amount)}</td></tr>)}
              <tr className="total"><td>Closing NAV, bridged</td><td className="num">{millions(pack.bridge.closing)}</td></tr>
              <tr><td>Closing NAV, reported</td><td className="num">{millions(pack.bridge.reported)}</td></tr>
              <tr className={pack.bridge.difference != null && Math.abs(pack.bridge.difference) >= 5000 ? 'flag' : ''}><td>Difference</td><td className="num">{signedMillions(pack.bridge.difference)}</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      {pack.capitalAccounts && (
        <section className="da-sec">
          <div className="da-sechead"><h2>Capital accounts</h2><p>{pack.capitalAccounts.investors} investors. Each account should roll from opening to closing, and together they should equal NAV. $M.</p></div>
          <div className="da-gridwrap">
            <table className="da-grid">
              <thead><tr><th>Investor</th><th className="num">Opening</th><th className="num">Contrib.</th><th className="num">Distrib.</th><th className="num">P&amp;L</th><th className="num">Carry</th><th className="num">Closing</th><th className="num">Off by</th><th className="num">Commitment</th><th className="num">Unfunded</th><th className="num">Own.</th><th className="num">Fee</th><th className="num">Fee recalc.</th></tr></thead>
              <tbody>
                {pack.capitalAccounts.rows.slice(0, 50).map((row) => (
                  <tr key={row.id} className={row.difference != null && Math.abs(row.difference) >= 5 ? 'flag' : ''}>
                    <td>{row.name}{row.isGp && <span className="da-st na da-gap">GP</span>}</td>
                    <td className="num">{millions(row.opening)}</td><td className="num">{millions(row.contributions)}</td><td className="num">{millions(row.distributions)}</td>
                    <td className="num">{signedMillions(row.pnl)}</td><td className="num">{signedMillions(row.carry)}</td><td className="num">{millions(row.closing)}</td>
                    <td className="num">{signedMillions(row.difference)}</td><td className="num">{millions(row.commitment)}</td><td className="num">{millions(row.unfunded)}</td>
                    <td className="num">{pct(row.ownershipPct, 2)}</td><td className="num">{millions(row.feeCharged, 3)}</td><td className="num">{millions(row.feeRecalculated, 3)}</td>
                  </tr>
                ))}
                <tr className="total">
                  <td>Total</td><td className="num">{millions(pack.capitalAccounts.totals.opening)}</td><td className="num">{millions(pack.capitalAccounts.totals.contributions)}</td>
                  <td className="num">{millions(pack.capitalAccounts.totals.distributions)}</td><td className="num">{signedMillions(pack.capitalAccounts.totals.pnl)}</td>
                  <td className="num">{signedMillions(pack.capitalAccounts.totals.carry)}</td><td className="num">{millions(pack.capitalAccounts.totals.closing)}</td>
                  <td /><td /><td /><td className="num">{pct(pack.capitalAccounts.totals.ownershipPct, 2)}</td><td /><td />
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="da-sec">
        <div className="da-sechead">
          <h2>Management fee</h2>
          <p>Charged on {pack.fees.allocation}.{pack.fees.stepDown ? ' The fee steps down in this period, so each part is charged at its own rate for its days.' : ''}{pack.fees.charged != null ? ` ${millions(pack.fees.charged, 3)}M charged to investors.` : ''}</p>
        </div>
        <div className="da-gridwrap">
          <table className="da-grid">
            <thead><tr><th>From</th><th>To</th><th className="num">Share of a year</th><th className="num">Rate</th><th>Basis</th><th className="num">Base, $M</th></tr></thead>
            <tbody>{pack.fees.segments.map((segment) => (
              <tr key={segment.from}><td>{segment.from}</td><td>{segment.to}</td><td className="num">{segment.share.toFixed(3)}</td><td className="num">{pct(segment.ratePct, 2)}</td><td>{segment.basis.replace(/_/g, ' ').toLowerCase()}</td><td className="num">{millions(segment.base)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </section>

      {pack.waterfall && (
        <section className="da-sec">
          <div className="da-sechead"><h2>Waterfall</h2><p>{pack.waterfall.basis === 'WATERFALL' ? 'Hypothetical liquidation' : 'Incentive fee on income'}, tier by tier. The GP's tiers add up to the carry recalculated. $M.</p></div>
          <div className="da-gridwrap">
            <table className="da-grid da-roll">
              <thead><tr><th>Tier</th><th className="num">Amount</th><th className="num">To limited partners</th><th className="num">To the GP</th></tr></thead>
              <tbody>
                {pack.waterfall.tiers.map((tier) => <tr key={tier.key}><td>{tier.label}</td><td className="num">{millions(tier.total)}</td><td className="num">{millions(tier.lp)}</td><td className="num">{millions(tier.gp)}</td></tr>)}
                <tr className="total"><td>GP carry</td><td /><td /><td className="num">{millions(pack.waterfall.carry)}</td></tr>
                {pack.waterfall.gpCarryOnFile != null && <tr><td>In the GP's capital account</td><td /><td /><td className="num">{millions(pack.waterfall.gpCarryOnFile)}</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {pack.valuation && (
        <section className="da-sec">
          <div className="da-sechead"><h2>Valuation support</h2><p>{pct(pack.valuation.coveragePct)} of {millions(pack.valuation.total)}M at fair value has support dated in the period ({pack.valuation.requiredPct}% required){pack.valuation.thirdPartyPct != null ? `; ${pct(pack.valuation.thirdPartyPct)} has a third-party valuation` : ''}.</p></div>
          {(pack.valuation.outside.length > 0 || pack.valuation.unsupported.length > 0) && (
            <div className="da-gridwrap">
              <table className="da-grid">
                <thead><tr><th>Position</th><th className="num">Mark, $M</th><th>Support</th></tr></thead>
                <tbody>
                  {pack.valuation.outside.slice(0, 25).map((row) => <tr key={`o-${row.id}`} className="flag"><td>{row.name}</td><td className="num">{millions(row.fairValue)}</td><td>Outside: {row.low != null && row.high != null ? `${millions(row.low)} to ${millions(row.high)}` : millions(row.concluded)} ({(row.source || 'support').replace(/_/g, ' ').toLowerCase()})</td></tr>)}
                  {pack.valuation.unsupported.slice(0, 25).map((row) => <tr key={`u-${row.id}`}><td>{row.name}</td><td className="num">{millions(row.fairValue)}</td><td>None dated in the period</td></tr>)}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {(pack.capitalActivity || pack.commitments) && (
        <section className="da-sec">
          <div className="da-sechead"><h2>Calls, distributions and commitments</h2><p>$M.</p></div>
          <div className="da-gridwrap">
            <table className="da-grid da-roll">
              <tbody>
                {pack.capitalActivity && <>
                  <tr><td>Called in the period</td><td className="num">{millions(pack.capitalActivity.calledInPeriod)}</td></tr>
                  <tr className="indent"><td>Received</td><td className="num">{millions(pack.capitalActivity.receivedInPeriod)}</td></tr>
                  <tr className="indent"><td>Calls not yet received</td><td className="num">{millions(pack.capitalActivity.callsOutstanding)}</td></tr>
                  <tr><td>Distributed in the period</td><td className="num">{millions(pack.capitalActivity.distributionsInPeriod)}</td></tr>
                  <tr className="indent"><td>Paid</td><td className="num">{millions(pack.capitalActivity.paidInPeriod)}</td></tr>
                  <tr className="indent"><td>Declared, not yet paid</td><td className="num">{millions(pack.capitalActivity.distributionsPayable)}</td></tr>
                </>}
                {pack.commitments && <>
                  <tr><td>Committed ({pack.commitments.investors} investors)</td><td className="num">{millions(pack.commitments.committed)}</td></tr>
                  <tr className="indent"><td>Contributed to date</td><td className="num">{millions(pack.commitments.contributed)}</td></tr>
                  <tr className="indent"><td>Unfunded</td><td className="num">{millions(pack.commitments.unfunded)}</td></tr>
                  <tr className="indent"><td>Calls still to come</td><td className="num">{millions(pack.commitments.pendingCalls)}</td></tr>
                </>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {pack.fx && (
        <section className="da-sec">
          <div className="da-sechead"><h2>FX translation</h2><p>Into {pack.fx.base}. Rates are units of {pack.fx.base} for one unit of the currency.{pack.fx.heldWithoutRate.length ? ` Held with no rate in the pack: ${pack.fx.heldWithoutRate.join(', ')}.` : ''}</p></div>
          {pack.fx.currencies.length > 0 && (
            <div className="da-gridwrap">
              <table className="da-grid">
                <thead><tr><th>Currency</th><th className="num">Applied</th><th className="num">Market</th><th className="num">Off by</th><th className="num">Exposure, $M</th><th className="num">Realized FX</th><th className="num">Unrealized FX</th><th className="num">Hedged</th><th className="num">Hedge value</th></tr></thead>
                <tbody>{pack.fx.currencies.map((row) => (
                  <tr key={row.currency}>
                    <td>{row.currency}</td><td className="num">{rate(row.applied)}</td><td className="num">{rate(row.market)}</td><td className="num">{pct(row.differencePct, 2)}</td>
                    <td className="num">{millions(row.exposureBase)}</td><td className="num">{signedMillions(row.realized)}</td><td className="num">{signedMillions(row.unrealized)}</td>
                    <td className="num">{pct(row.hedgedPct)}</td><td className="num">{signedMillions(row.hedgeMtm)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {pack.checks.length > 0 && (
        <section className="da-sec">
          <div className="da-sechead"><h2>Pack checks</h2><p>The checks the pack adds to the reconciliation.</p></div>
          <div className="da-gridwrap">
            <table className="da-grid">
              <thead><tr><th>Check</th><th className="num">Figure</th><th className="num">Compared with</th><th>Result</th></tr></thead>
              <tbody>{pack.checks.map((check) => (
                <tr key={check.id} className={check.result === 'Break' ? 'flag' : ''}>
                  <td>{check.label}</td><td className="num">{checkFigure(check, check.a)}</td><td className="num">{checkFigure(check, check.b)}</td>
                  <td><span className={`da-st ${check.result === 'Ties' ? 'ok' : check.result === 'Break' ? 'breach' : 'near'}`}>{check.result}</span></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
